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
  isMonitorIssue,
  isMonitoredWorkflow,
  normalizeRunState,
  parseStateComment,
  readEndpoint,
  renderAlertBody,
  resolveApprovalWaitStart,
  validateState,
  waitingFor,
  type DeploymentStatus,
  type EndpointRead,
  type InFlightRun,
  type MonitorState,
  type Target,
  type VersionBody,
  type ReadyBody,
} from "../src/lib/drift-monitor";

const REPO = process.env.GITHUB_REPOSITORY ?? "jtanori/solara";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";

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

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status} for ${path.split("?")[0]}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
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

async function fetchProbe(url: string, path: string, kind: "version" | "ready"): Promise<EndpointRead> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${url}${path}`, {
      // Sent unconditionally: harmless on a host exempt from SSO, mandatory on a
      // gated one. A conditional header would create a silently unauthenticated
      // path (plan §6).
      headers: BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {},
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

async function fetchHeadCommit(branch: string): Promise<string | null> {
  try {
    const commit = await github<{ sha?: string }>(`/repos/${REPO}/commits/${branch}`);
    return commit.sha ?? null;
  } catch {
    return null;
  }
}

/**
 * Which deploy/migration runs are in flight for this target. `ci.yml` and this
 * workflow are excluded by name: without that the monitor sees *itself*
 * `in_progress` on `main` every tick and suppresses every alert forever.
 */
async function fetchInFlightRuns(target: Target, now: number): Promise<InFlightRun[]> {
  let workflows: Array<{ id: number; path: string }>;
  try {
    const response = await github<{ workflows: Array<{ id: number; path: string }> }>(
      `/repos/${REPO}/actions/workflows?per_page=100`,
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
      const batches = await Promise.all(
        ["queued", "in_progress", "waiting"].map(status =>
          github<{ workflow_runs: RunRecord[] }>(
            `/repos/${REPO}/actions/workflows/${workflow.id}/runs?status=${status}&per_page=50`,
          ).catch(() => ({ workflow_runs: [] as RunRecord[] })),
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
        const attributed = await attributeMigrate(record, target);
        if (!attributed) continue;
      }

      const pending = await pendingEnvironments(record.id).catch(() => [] as string[]);
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
        const start = await resolveWaitingStart(record, target, now).catch(() => null);
        inFlight.waitingSince = start ?? undefined;
        inFlight.waitingForMs = waitingFor(inFlight, now, start ?? now);
        if (start === null) {
          log(`run ${record.id}: waiting with no deployment-status timestamp; the persisted clock applies (D6)`);
        }
      }
      runs.push(inFlight);
    }
  }
  return runs;
}

async function pendingEnvironments(runId: number): Promise<string[]> {
  const response = await github<Array<{ environment?: { name?: string } }>>(
    `/repos/${REPO}/actions/runs/${runId}/pending_deployments`,
  );
  return response.map(entry => entry.environment?.name ?? "").filter(Boolean);
}

async function attributeMigrate(record: RunRecord, target: Target): Promise<boolean> {
  const pending = await pendingEnvironments(record.id).catch(() => [] as string[]);
  if (pending.length > 0) return attributeRunToTarget({ pendingEnvironments: pending, deploymentEnvironments: [], target });
  // No pending deployments (the gate may have been released already): fall back
  // to the environments of the deployments this run created.
  const deployments = await github<Array<{ environment?: string }>>(
    `/repos/${REPO}/actions/runs/${record.id}/deployments`,
  ).catch(() => [] as Array<{ environment?: string }>);
  const names = deployments.map(entry => entry.environment ?? "").filter(Boolean);
  return attributeRunToTarget({ pendingEnvironments: [], deploymentEnvironments: names, target });
}

/** D6: the `waiting` deployment status, else the persisted fallback clock. */
async function resolveWaitingStart(record: RunRecord, target: Target, now: number): Promise<number | null> {
  if (!record.head_sha) return null;
  try {
    const deployments = await github<Array<{ id: number; environment?: string }>>(
      `/repos/${REPO}/deployments?sha=${record.head_sha}&environment=${target}-migrations&per_page=10`,
    );
    for (const deployment of deployments) {
      const statuses = await github<DeploymentStatus[]>(`/repos/${REPO}/deployments/${deployment.id}/statuses?per_page=100`);
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

async function findIssue(target: Target): Promise<Issue | null> {
  const issues = await github<Issue[]>(`/repos/${REPO}/issues?state=open&per_page=100`, {});
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

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const target = args.env;
  const now = Date.now();
  const url = (target === "staging" ? args.stagingUrl : args.productionUrl) ?? DEFAULT_URLS[target];

  // --- reads -----------------------------------------------------------------
  let read: EndpointRead;
  let headCommit: string | null;
  let runs: InFlightRun[] = [];

  if (args.fixture !== null) {
    const fixture = JSON.parse(readFileSync(args.fixture, "utf8")) as {
      headCommit?: string | null;
      version?: VersionBody;
      ready?: ReadyBody;
      runs?: InFlightRun[];
    };
    read = { status: "ok", version: fixture.version ?? {}, ready: fixture.ready ?? {} };
    headCommit = fixture.headCommit ?? null;
    runs = fixture.runs ?? [];
  } else {
    const versionRead = await fetchProbe(url, "/api/version", "version");
    if (versionRead.status !== "ok") {
      read = versionRead;
    } else {
      const readyRead = await fetchProbe(url, "/api/ready", "ready");
      if (readyRead.status !== "ok") {
        read = readyRead;
      } else {
        read = { status: "ok", version: versionRead.version, ready: readyRead.ready };
      }
    }
    headCommit = await fetchHeadCommit(target === "production" ? "main" : "staging");
    runs = await fetchInFlightRuns(target, now);
  }

  const rejected = read.status === "rejected";

  // --- previous state --------------------------------------------------------
  // Two stores, reconciled (plan §7). The artifact carries the *pre-alert* clock
  // — the one that must run before anything is opened, so it cannot live in the
  // issue. The issue comment carries the *post-alert* record, which outlives the
  // 5-day artifact retention. The older clock wins: it is the honest one.
  const artifactState = validateState(readArtifactState(args.state), target, now).state;
  const issue = args.dryRun || TOKEN === "" ? null : await findIssue(target).catch(() => null);
  const issueState = issue?.body ? validateState(parseStateComment(issue.body), target, now).state : null;

  const previous = pickOlderClock(artifactState, issueState);

  const classification = classifyDrift({
    target,
    headCommit,
    read,
    runs,
    firstObserved: previous?.firstObserved ? Date.parse(previous.firstObserved) : undefined,
    // The clock is per subject: it only applies while what it was started for is
    // unchanged (§8). Without these two the age of a previous deploy would be
    // inherited by the next one.
    clockLiveCommit: previous?.liveCommit ?? undefined,
    clockMigrations: previous?.migrations ?? undefined,
    now,
  });

  const action = decideAlert({
    classification,
    issueOpen: issue !== null,
    previousObservation: previous ? stateToObservation(previous) : null,
  });

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
  if (read.status === "unknown" || read.status === "rejected") {
    log(`degraded: ${read.reason} — state left untouched; the prior artifact is re-uploaded`);
    return read.status === "rejected" ? 1 : 0;
  }

  if (action === "open" || action === "update") {
    const alerted: MonitorState = { ...state, alertedAt: new Date(now).toISOString() };
    const body = renderAlertBody({ state: alerted, headline: null, inFlight: runs.length === 0 ? "none" : `${runs.length}`, now });
    if (issue === null) {
      await github(`/repos/${REPO}/issues`, {
        method: "POST",
        body: JSON.stringify({ title: ISSUE_TITLE[target], body }),
        headers: { "Content-Type": "application/json" },
      });
      log(`opened alert issue for ${target}`);
    } else {
      await github(`/repos/${REPO}/issues/${issue.number}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
        headers: { "Content-Type": "application/json" },
      });
      log(`updated alert issue #${issue.number}`);
    }
    if (args.state !== null) writeArtifactState(nextStatePath(args.state), alerted);
    return 0;
  }

  if (action === "close" && issue !== null) {
    await github(`/repos/${REPO}/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({
        state: "closed",
        body: `${renderAlertBody({ state, headline: null, inFlight: "none", now })}\n\n_Closed by the drift monitor at ${new Date(now).toISOString()}: the state matched._`,
      }),
      headers: { "Content-Type": "application/json" },
    });
    log(`closed alert issue #${issue.number}`);
  }

  if (args.state !== null) writeArtifactState(nextStatePath(args.state), state);
  return 0;
}

/** The artifact the workflow uploads: a sibling of the restored file. */
function nextStatePath(current: string): string {
  return join(dirname(current), "next.json");
}

/**
 * The older of the two clocks. The artifact is deleted after 5 days, so an alert
 * open for three weeks has its real age only in the issue; the issue may be
 * edited by hand, so the artifact can be fresher. Taking the older one keeps the
 * age monotonic in both directions instead of silently restarting it.
 */
function pickOlderClock(a: MonitorState | null, b: MonitorState | null): MonitorState | null {
  if (a === null) return b;
  if (b === null) return a;
  const at = a.firstObserved === null ? Number.POSITIVE_INFINITY : Date.parse(a.firstObserved);
  const bt = b.firstObserved === null ? Number.POSITIVE_INFINITY : Date.parse(b.firstObserved);
  return at <= bt ? a : b;
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
