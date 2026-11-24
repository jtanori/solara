/**
 * Drift monitor (#165) — the thin, network-owning half.
 *
 * Reads two endpoints per environment, classifies with the pure logic in
 * `src/lib/drift-monitor.ts`, and writes at most one GitHub issue per
 * environment. It never deploys, never migrates, never touches the repository
 * and holds no database credential.
 *
 * Exit codes (§6):
 *   0  healthy, drift, in flight, degraded — drift is a *designed* state,
 *      reported by the issue, never by a red run
 *   1  `rejected`: a 401/403/SSO challenge. A missing or rotated bypass secret
 *      must not stay silently green.
 *   2  a bug in the monitor itself
 *
 * Usage:
 *   npx tsx scripts/drift-monitor.ts --env staging --dry-run
 *   npx tsx scripts/drift-monitor.ts --env staging --dry-run --fixture tests/fixtures/ready-behind.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  approvalFallbackClock,
  attributeRunToTarget,
  classifyDrift,
  decideAlert,
  isMigrationState,
  isMonitorIssue,
  isMonitoredWorkflow,
  normalizeRunState,
  parseStateComment,
  reconcileState,
  readEndpoint,
  renderAlertBody,
  resolveApprovalWaitStart,
  validateState,
  waitingFor,
  type DeploymentStatus,
  type EndpointRead,
  type InFlightRun,
  type MigrationState,
  type MonitorState,
  type Target,
  type VersionBody,
  type ReadyBody,
} from "../src/lib/drift-monitor";

/**
 * Everything the CLI reads from the environment, resolved once and passed down.
 *
 * Injectable so `main()` can be tested without a network or a token: the
 * sandbox and CI both export GITHUB_TOKEN, so a test that relied on it being
 * absent would behave differently in each place.
 */
type Ctx = {
  repo: string;
  token: string;
  api: string;
  bypass: string;
  fetchImpl: typeof fetch;
};

function defaultCtx(): Ctx {
  return {
    repo: process.env.GITHUB_REPOSITORY ?? "jtanori/solara",
    token: process.env.GITHUB_TOKEN ?? "",
    api: process.env.GITHUB_API_URL ?? "https://api.github.com",
    bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "",
    fetchImpl: fetch,
  };
}

const DEFAULT_URLS: Record<Target, string> = {
  staging: "https://staging.thanatos.mx",
  production: "https://www.thanatos.mx",
};

const ISSUE_TITLE: Record<Target, string> = {
  staging: "drift-monitor: staging",
  production: "drift-monitor: production",
};

type Args = {
  env: Target;
  dryRun: boolean;
  fixture: string | null;
  state: string | null;
  stagingUrl: string | null;
  productionUrl: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { env: "staging", dryRun: false, fixture: null, state: null, stagingUrl: null, productionUrl: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--env") {
      const value = next();
      if (value !== "staging" && value !== "production") throw new Error(`--env must be staging or production (got '${value}')`);
      args.env = value;
    } else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--fixture") args.fixture = next();
    else if (arg === "--state") args.state = next();
    else if (arg === "--staging-url") args.stagingUrl = next();
    else if (arg === "--production-url") args.productionUrl = next();
    else throw new Error(`unknown argument '${arg}'`);
  }
  return args;
}

function log(message: string): void {
  console.log(`drift-monitor[${new Date().toISOString()}]: ${message}`);
}

class GithubError extends Error {
  constructor(
    message: string,
    // Read by the `rejected` getter and by callers branching on 404.
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
  /** The monitor was told it may not look — exit 1, not a degraded tick. */
  get rejected(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function github<T>(ctx: Ctx, path: string, init?: RequestInit): Promise<T> {
  const response = await ctx.fetchImpl(`${ctx.api}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new GithubError(`GitHub API ${response.status} for ${path.split("?")[0]}`, response.status);
  }
  return (await response.json()) as T;
}

/** A deployment or migration run, reduced to what the classifier needs. */
type RunRecord = {
  id: number;
  run_attempt: number;
  status: string;
  path: string;
  head_sha?: string;
};

async function fetchProbe(ctx: Ctx, url: string, path: string, kind: "version" | "ready"): Promise<EndpointRead> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await ctx.fetchImpl(`${url}${path}`, {
      // Sent unconditionally: harmless on a host exempt from SSO, mandatory on a
      // gated one. A conditional header would create a silently unauthenticated
      // path (plan §6).
      headers: ctx.bypass ? { "x-vercel-protection-bypass": ctx.bypass } : {},
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await response.text();
    return readEndpoint({ status: response.status, body, kind });
  } catch {
    return { status: "unknown", reason: "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

type HeadInfo = { sha: string; headline: string | null };

async function fetchHeadCommit(ctx: Ctx, branch: string): Promise<HeadInfo | null> {
  try {
    const commit = await github<{ sha?: string; commit?: { message?: string } }>(ctx, `/repos/${ctx.repo}/commits/${branch}`);
    if (!commit.sha) return null;
    const headline = commit.commit?.message?.split("\n")[0]?.trim() ?? null;
    return { sha: commit.sha, headline };
  } catch (error) {
    // A 401/403 must reach main() so the run exits 1; a transient fault is
    // `null`, which the classifier now treats as `unknown` rather than `exact`.
    if (error instanceof GithubError && error.rejected) throw error;
    return null;
  }
}

/**
 * Which deploy/migration runs are in flight for this target. `ci.yml` and this
 * workflow are excluded by name: without that the monitor sees *itself*
 * `in_progress` on `main` every tick and suppresses every alert forever.
 */
async function fetchInFlightRuns(
  ctx: Ctx,
  target: Target,
  now: number,
  waitState: MonitorState | null,
): Promise<InFlightRun[]> {
  let workflows: Array<{ id: number; path: string }>;
  try {
    const response = await github<{ workflows: Array<{ id: number; path: string }> }>(
      ctx,
      `/repos/${ctx.repo}/actions/workflows?per_page=100`,
    );
    workflows = response.workflows ?? [];
  } catch {
    // Cannot tell which runs exist; do not suppress on a guess.
    return [];
  }

  const inScope = workflows.filter(workflow => isMonitoredWorkflow(workflow.path, target));
  const runs: InFlightRun[] = [];

  for (const workflow of inScope) {
    let records: RunRecord[];
    try {
      // `waiting` must be queried explicitly. A run held by an environment
      // approval is not `in_progress`, so omitting it would make the approval
      // half of this monitor silently unreachable.
      // Scope to the branch that actually deploys each environment: a run on a
      // feature branch is not a release, and must not suppress an alert.
      const branch = workflow.path.endsWith("deploy-production.yml")
        ? "main"
        : workflow.path.endsWith("deploy-staging.yml")
          ? "staging"
          : "main";
      const batches = await Promise.all(
        ["queued", "in_progress", "waiting"].map(status =>
          github<{ workflow_runs: RunRecord[] }>(
            ctx,
            `/repos/${ctx.repo}/actions/workflows/${workflow.id}/runs?status=${status}&branch=${branch}&per_page=50`,
          ).catch(error => {
            // Only a 404 (workflow not created yet) is an absence. Swallowing
            // every error here made the 401/403 handling below unreachable.
            if (error instanceof GithubError && (error.status === 404 || error.rejected === false)) {
              if (error.status === 404) return { workflow_runs: [] as RunRecord[] };
            }
            throw error;
          }),
        ),
      );
      const seen = new Set<number>();
      records = batches.flatMap(batch => batch.workflow_runs ?? []).filter(record => {
        if (seen.has(record.id)) return false;
        seen.add(record.id);
        return true;
      });
    } catch (error) {
      // A workflow that does not exist yet is [] (the mechanism is absent), but a
      // 401/403 is a real permission failure and must surface.
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403) throw error;
      continue;
    }

    for (const record of records) {
      // A 404 for a workflow not yet created (#171/#173) is absence, not failure.
      const state = normalizeRunState(record.status);
      if (state === null) continue;

      const isMigrate = record.path.endsWith("migrate.yml");
      if (isMigrate) {
        const attributed = await attributeMigrate(ctx, record, target);
        if (!attributed) continue;
      }

      const pending = await pendingEnvironments(ctx, record.id).catch(error => {
        // Never swallow a rejection: an unreadable pending list is not "no
        // approval is waiting", and treating it as such would hide a stuck run.
        if (error instanceof GithubError && error.rejected) throw error;
        return [] as string[];
      });
      const awaitingApproval =
        pending.length > 0 &&
        attributeRunToTarget({ pendingEnvironments: pending, deploymentEnvironments: [], target });

      const inFlight: InFlightRun = {
        runId: record.id,
        runAttempt: record.run_attempt,
        // An approval-gated run is `in_progress` until the environment decides;
        // `pending_deployments` is the authoritative statement that it is waiting.
        state: awaitingApproval ? "waiting" : state,
      };
      if (inFlight.state === "waiting") {
        const start = await resolveWaitingStart(ctx, record, target, now).catch(error => {
          if (error instanceof GithubError && error.rejected) throw error;
          return null;
        });
        // D6 candidate 2: the persisted first observation, keyed by
        // (runId, runAttempt, environment). Without this the fallback was dead
        // code and every un-timestamped wait reported 0 ms forever.
        const fallback = approvalFallbackClock({
          state: waitState,
          runId: record.id,
          runAttempt: record.run_attempt,
          now,
        });
        inFlight.waitingSince = start ?? fallback;
        inFlight.waitingForMs = waitingFor(inFlight, now, fallback);
        if (start === null) {
          log(`run ${record.id}: no deployment-status timestamp; using the persisted clock from ${new Date(fallback).toISOString()} (D6)`);
        }
      }
      runs.push(inFlight);
    }
  }
  return runs;
}

async function pendingEnvironments(ctx: Ctx, runId: number): Promise<string[]> {
  const response = await github<Array<{ environment?: { name?: string } }>>(
    ctx,
    `/repos/${ctx.repo}/actions/runs/${runId}/pending_deployments`,
  );
  return response.map(entry => entry.environment?.name ?? "").filter(Boolean);
}

async function attributeMigrate(ctx: Ctx, record: RunRecord, target: Target): Promise<boolean> {
  const pending = await pendingEnvironments(ctx, record.id).catch(error => {
    if (error instanceof GithubError && error.rejected) throw error;
    return [] as string[];
  });
  if (pending.length > 0) return attributeRunToTarget({ pendingEnvironments: pending, deploymentEnvironments: [], target });
  // No pending deployments (the gate may have been released already): fall back
  // to the environments of the deployments this run created.
  const deployments = await github<Array<{ environment?: string }>>(
    ctx,
    `/repos/${ctx.repo}/actions/runs/${record.id}/deployments`,
  ).catch(error => {
    if (error instanceof GithubError && error.rejected) throw error;
    return [] as Array<{ environment?: string }>;
  });
  const names = deployments.map(entry => entry.environment ?? "").filter(Boolean);
  return attributeRunToTarget({ pendingEnvironments: [], deploymentEnvironments: names, target });
}

/** D6: the `waiting` deployment status, else the persisted fallback clock. */
async function resolveWaitingStart(ctx: Ctx, record: RunRecord, target: Target, now: number): Promise<number | null> {
  if (!record.head_sha) return null;
  try {
    const deployments = await github<Array<{ id: number; environment?: string }>>(
      ctx,
      `/repos/${ctx.repo}/deployments?sha=${record.head_sha}&environment=${target}-migrations&per_page=10`,
    );
    for (const deployment of deployments) {
      const statuses = await github<DeploymentStatus[]>(ctx, `/repos/${ctx.repo}/deployments/${deployment.id}/statuses?per_page=100`);
      const start = resolveApprovalWaitStart({ statuses, now });
      if (start !== null) return start;
    }
  } catch {
    return null;
  }
  return null;
}

type Issue = {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  pull_request?: unknown;
  user?: { login?: string | null; type?: string | null } | null;
  author_association?: string | null;
};

async function findIssue(ctx: Ctx, target: Target): Promise<Issue | null> {
  const issues = await github<Issue[]>(ctx, `/repos/${ctx.repo}/issues?state=open&per_page=100`, {});
  // Trusted author only: the repository is public, so title matching alone lets
  // an outsider own the state block and silence the alert (F7).
  const match = issues.find(issue => issue.title === ISSUE_TITLE[target] && isMonitorIssue(issue));
  return match ?? null;
}

/** Read the artifact-backed clock; a missing or malformed file is a first observation. */
function readArtifactState(path: string | null): MonitorState | null {
  if (path === null || !existsSync(path)) return null;
  try {
    return parseStateComment(`<!-- drift-monitor:${readFileSync(path, "utf8")} -->`);
  } catch {
    return null;
  }
}

function writeArtifactState(path: string, state: MonitorState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state)}\n`, "utf8");
}

export async function main(argv: string[], deps?: Partial<Ctx>): Promise<number> {
  const ctx: Ctx = { ...defaultCtx(), ...deps };
  const args = parseArgs(argv);
  const target = args.env;
  const now = Date.now();
  const url = (target === "staging" ? args.stagingUrl : args.productionUrl) ?? DEFAULT_URLS[target];

  // --- reads -----------------------------------------------------------------
  let read: EndpointRead;
  let headline: string | null = null;
  let headCommit: string | null;
  let runs: InFlightRun[] = [];
  let fixtureRuns: InFlightRun[] | null = null;

  if (args.fixture !== null) {
    const fixture = JSON.parse(readFileSync(args.fixture, "utf8")) as {
      headCommit?: string | null;
      headline?: string | null;
      version?: VersionBody;
      ready?: ReadyBody;
      runs?: InFlightRun[];
    };
    read = { status: "ok", version: fixture.version ?? {}, ready: fixture.ready ?? {} };
    headCommit = fixture.headCommit ?? null;
    headline = fixture.headline ?? null;
    fixtureRuns = fixture.runs ?? [];
  } else {
    const versionRead = await fetchProbe(ctx, url, "/api/version", "version");
    if (versionRead.status !== "ok") {
      read = versionRead;
    } else {
      const readyRead = await fetchProbe(ctx, url, "/api/ready", "ready");
      read = readyRead.status !== "ok" ? readyRead : { status: "ok", version: versionRead.version, ready: readyRead.ready };
    }
    const head = await fetchHeadCommit(ctx, target === "production" ? "main" : "staging");
    headCommit = head?.sha ?? null;
    headline = head?.headline ?? null;
  }

  // --- previous state --------------------------------------------------------
  // Loaded BEFORE the run query, because the approval fallback clock (D6
  // candidate 2) is an input to it. Reading it afterwards left that fallback
  // permanently 0 ms.
  const artifactState = validateState(readArtifactState(args.state), target, now).state;
  let issue: Issue | null = null;
  let issueLookupFailed = false;
  if (!args.dryRun && ctx.token !== "") {
    try {
      issue = await findIssue(ctx, target);
    } catch (error) {
      // A 401/403 means the token cannot read the issues at all: a configuration
      // failure, which must exit 1 like any other `rejected` path rather than
      // escape as an unhandled rejection (that would read as a monitor bug).
      if (error instanceof GithubError && error.rejected) {
        log(`rejected: ${error.message} — the token cannot read issues`);
        return 1;
      }
      // A transient /issues failure must not look like "no issue is open": that
      // would POST a duplicate. Treat the tick as degraded instead.
      issueLookupFailed = true;
      log(`warning: issue lookup failed (${(error as Error).message}); the tick will not write`);
    }
  }
  const issueState = issue?.body ? validateState(parseStateComment(issue.body), target, now).state : null;

  if (args.fixture !== null) {
    runs = fixtureRuns ?? [];
    // A fixture with a waiting run and no explicit start still needs a clock.
    runs = runs.map(run => {
      if (run.state !== "waiting" || run.waitingSince !== undefined) {
        return { ...run, waitingForMs: waitingFor(run, now, run.waitingSince ?? now) };
      }
      const fallback = approvalFallbackClock({ state: artifactState ?? issueState, runId: run.runId, runAttempt: run.runAttempt, now });
      return { ...run, waitingSince: fallback, waitingForMs: waitingFor(run, now, fallback) };
    });
  } else {
    runs = await fetchInFlightRuns(ctx, target, now, artifactState ?? issueState);
  }

  const previous = reconcileState({
    artifact: artifactState,
    issue: issueState,
    liveCommit: read.status === "ok" ? (read.version.commit ?? null) : null,
    migrations: read.status === "ok" ? (isReadyMigration(read.ready) ? read.ready.migrations as MigrationState : null) : null,
  });

  const classification = classifyDrift({
    target,
    headCommit,
    read,
    runs,
    firstObserved: previous?.firstObserved ? Date.parse(previous.firstObserved) : undefined,
    clockLiveCommit: previous?.liveCommit ?? undefined,
    clockMigrations: previous?.migrations ?? undefined,
    now,
  });

  const action = decideAlert({
    classification,
    issueOpen: issue !== null,
    // Compare against the ISSUE, not the reconciled artifact: the issue is the
    // thing an `update` rewrites, so comparing against anything else can leave
    // its text stale.
    previousObservation: issueState ? stateToObservation(issueState) : null,
  });

  const rejected = read.status === "rejected";
  log(
    `env=${target} kind=${classification.kind} action=${action} head=${(headCommit ?? "unknown").slice(0, 7)} ` +
      `live=${(classification.liveCommit ?? "unknown").slice(0, 7)} migrations=${classification.migrations ?? "unknown"} ` +
      `runs=${runs.length}${rejected ? " REJECTED" : ""}`,
  );

  if (args.dryRun) {
    log(`dry-run: would ${action}; no write performed`);
    return rejected ? 1 : 0;
  }

  const state: MonitorState = {
    environment: target,
    kind: classification.kind,
    liveCommit: classification.liveCommit,
    headCommit: classification.headCommit,
    migrations: classification.migrations,
    runId: classification.runId,
    runAttempt: classification.runAttempt,
    firstObserved: classification.firstObserved === null ? null : new Date(classification.firstObserved).toISOString(),
    alertedAt: null,
  };

  // D9: a tick that could not verify the state must not rewrite the clock. The
  // workflow re-uploads the prior artifact unchanged in that case.
  if (read.status === "unknown" || read.status === "rejected" || issueLookupFailed) {
    log(`degraded: ${read.status === "ok" ? "issue lookup failed" : read.reason} — state left untouched; the prior artifact is re-uploaded`);
    return read.status === "rejected" ? 1 : 0;
  }

  if (action === "open" || action === "update") {
    // A write that cannot reach GitHub must not crash the tick: an unhandled
    // rejection is exit 2 ("the monitor is broken"), which reads as a code fault
    // rather than as the transient outage it is. Degrade instead, and leave the
    // prior artifact in place so the clock is not lost.
    const alerted: MonitorState = {
      ...state,
      // Preserve the first alert time: it is the one fact an update cannot
      // re-derive, and `renderAlertBody` now measures age against the tick.
      alertedAt: issueState?.alertedAt ?? new Date(now).toISOString(),
    };
    const body = renderAlertBody({
      state: alerted,
      headline,
      inFlight: runs.length === 0 ? "none" : `${runs.length}`,
      now,
    });
    try {
      if (issue === null) {
        await github(ctx, `/repos/${ctx.repo}/issues`, {
          method: "POST",
          body: JSON.stringify({ title: ISSUE_TITLE[target], body }),
          headers: { "Content-Type": "application/json" },
        });
        log(`opened alert issue for ${target}`);
      } else {
        await github(ctx, `/repos/${ctx.repo}/issues/${issue.number}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
          headers: { "Content-Type": "application/json" },
        });
        log(`updated alert issue #${issue.number}`);
      }
    } catch (error) {
      // A 401/403 means the token cannot write at all — that is a real
      // configuration failure and must be loud.
      if (error instanceof GithubError && error.rejected) return 1;
      log(`degraded: could not write the alert issue (${(error as Error).message}); prior state preserved`);
      return 0;
    }
    if (args.state !== null) writeArtifactState(nextStatePath(args.state), alerted);
    return 0;
  }

  if (action === "close" && issue !== null) {
    await github(ctx, `/repos/${ctx.repo}/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        state: "closed",
        body: `${renderAlertBody({ state, headline, inFlight: "none", now })}\n\n_Closed by the drift monitor at ${new Date(now).toISOString()}: the state matched._`,
      }),
      headers: { "Content-Type": "application/json" },
    });
    log(`closed alert issue #${issue.number}`);
  }

  if (args.state !== null) writeArtifactState(nextStatePath(args.state), state);
  return 0;
}

function isReadyMigration(ready: ReadyBody | null): ready is ReadyBody & { migrations: MigrationState } {
  return ready !== null && isMigrationState(ready.migrations);
}

/** The artifact the workflow uploads: a sibling of the restored file. */
function nextStatePath(current: string): string {
  return join(dirname(current), "next.json");
}

function stateToObservation(state: MonitorState) {
  return {
    kind: state.kind,
    liveCommit: state.liveCommit,
    headCommit: state.headCommit,
    migrations: state.migrations,
    runId: state.runId,
    runAttempt: state.runAttempt,
  };
}

/* c8 ignore start -- process wiring, exercised by the CLI dry run */
if (process.argv[1] !== undefined && process.argv[1].endsWith("drift-monitor.ts")) {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`drift-monitor: internal error — ${error instanceof Error ? error.message : String(error)}`);
      // 2, never 1: a bug in the monitor must not read as "rejected by the host".
      process.exitCode = 2;
    });
}
/* c8 ignore stop */
