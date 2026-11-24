/**
 * Drift monitor (#165) — pure classification, state and alert decisions.
 *
 * `scripts/drift-monitor.ts` owns every network call and every write; this module
 * owns every decision, so the whole state machine is testable without a network.
 * The design lives in `docs/plan-drift-monitor-165.md`; section numbers below
 * refer to it.
 *
 * Two rules shape the code:
 *
 * 1. **`unknown` is not drift.** An HTML login page, a 5xx or a `commit` of
 *    `"unknown"` means "cannot tell", never "the deploy failed". Conflating them
 *    pages an operator for the monitor's own outage.
 * 2. **`rejected` is not `unknown`.** A 401/403 means the monitor was told it may
 *    not look — a missing or rotated bypass secret. That is a hard failure (exit
 *    1), because a quiet `unknown` would keep it silently blind forever (§6).
 */

export const CADENCE_MS = 15 * 60_000;
export const STALE_HORIZON_MS = 20 * 60_000;
export const APPROVAL_HORIZON_MS = 60 * 60_000;

export type Target = "staging" | "production";
export type MigrationState = "exact" | "ahead" | "behind" | "diverged";

/** Every state `classifyDrift` can return. */
export type DriftKind =
  | "unknown"
  | "env-mismatch"
  | "pending"
  | "awaiting-approval"
  | "overdue-approval"
  | "observing-commit"
  | "stale-commit"
  | "observing-migrations"
  | "stale-migrations"
  | "exact";

/** Kinds that may open or rewrite an operator-facing issue (§8). */
export const ALERTABLE_KINDS: readonly DriftKind[] = [
  "env-mismatch",
  "overdue-approval",
  "stale-commit",
  "stale-migrations",
];

/** Kinds that mean a run exists but is expected to be transient (§8 d/e). */
export const IN_FLIGHT_KINDS: readonly DriftKind[] = [
  "pending",
  "awaiting-approval",
  "overdue-approval",
];

export function isAlertable(kind: DriftKind): boolean {
  return ALERTABLE_KINDS.includes(kind);
}

/** Whether a leg is currently watching something finish. */
export function isInFlight(kind: DriftKind): boolean {
  return IN_FLIGHT_KINDS.includes(kind);
}

/** A deploy or migrate run that could hold the alert back (§6 "Runs consulted"). */
export type InFlightRun = {
  runId: number;
  runAttempt: number;
  state: "queued" | "in_progress" | "waiting";
  /** Milliseconds since the transition into `waiting`, when one is known. */
  waitingForMs?: number;
  /**
   * When the run entered `waiting`, resolved per D6. Absent means the fallback
   * (the monitor's persisted first observation) applies.
   */
  waitingSince?: number;
};

/** The two endpoint reads, already reduced to what the decision needs. */
export type EndpointRead =
  | { status: "ok"; version: VersionBody; ready: ReadyBody | null }
  | { status: "unknown"; reason: "unreachable" | "malformed" | "absent" }
  | { status: "rejected"; reason: "unauthorized" | "forbidden" | "sso" };

export type VersionBody = {
  ok?: boolean;
  commit?: string;
  tree?: string;
  release?: string;
  env?: string;
  builtAt?: string;
};

export type ReadyBody = {
  ok?: boolean;
  db?: string;
  auth?: string;
  commit?: string;
  migrations?: string;
};

export type ClassifyInput = {
  target: Target;
  headCommit: string | null;
  read: EndpointRead;
  runs: InFlightRun[];
  /** Persisted clock for this subject, if one survived the previous tick. */
  firstObserved?: number;
  /** The live commit that clock belongs to (plan §8: the clock is per subject). */
  clockLiveCommit?: string | null;
  /** The migration state that clock belongs to. */
  clockMigrations?: MigrationState | null;
  /**
   * The kind that clock was recorded for. Without it a clock started by one
   * check is aged by another: an `awaiting-approval` clock that is 25 minutes
   * old makes a commit pushed ten seconds ago read as `stale-commit` (R2-2).
   */
  clockKind?: DriftKind | null;
  now: number;
};

export type Classification = {
  kind: DriftKind;
  /**
   * The clock for the *current* subject. Kept even when the kind is quiet so the
   * next tick can age it (§7).
   */
  firstObserved: number | null;
  liveCommit: string | null;
  headCommit: string | null;
  migrations: MigrationState | null;
  runId: number | null;
  runAttempt: number | null;
};

const MIGRATION_STATES: readonly MigrationState[] = ["exact", "ahead", "behind", "diverged"];

export function isMigrationState(value: unknown): value is MigrationState {
  return typeof value === "string" && MIGRATION_STATES.includes(value as MigrationState);
}

/**
 * Parse a response body, rejecting anything that is not a JSON object. The SSO
 * login page is HTML; treating it as an empty object would make every field
 * `undefined` and read as a mismatch rather than as "cannot tell".
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The Vercel authentication challenge, as served when a deployment is protected
 * and the bypass header is missing or stale. Deliberately narrow: matching any
 * HTML would classify every transient 503 page as an auth failure.
 */
const VERCEL_SSO_PATTERN = /vercel\.com\/sso|_vercel_sso|<title>[^<]*(?:Log ?in|Sign ?in)[^<]*vercel/i;

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reduce an HTTP response to an `EndpointRead`. Status-code policy is here so the
 * CLI never has to remember that a 503 is a successful readiness read (§6).
 */
export function readEndpoint(input: {
  status: number;
  body: string;
  kind: "version" | "ready";
}): EndpointRead {
  const { status, body, kind } = input;

  // 404 on production before promotion (or before #164 landed) is "this surface
  // does not exist yet", which is `unknown` — never drift (§6).
  if (status === 404) return { status: "unknown", reason: "absent" };
  if (status === 401) return { status: "rejected", reason: "unauthorized" };
  if (status === 403) return { status: "rejected", reason: "forbidden" };
  // Vercel answers an unbypassed deployment with a redirect to its SSO endpoint.
  if (status >= 300 && status < 400) return { status: "rejected", reason: "sso" };
  // A 5xx is never "the monitor was told it may not look" — it is the host
  // failing. `/api/version` has no 503 payload, so a 5xx there is unreachable
  // outright; `/api/ready` uses 503 *with a JSON body* to report a schema
  // verdict, which the parser below accepts.
  if (status >= 500 && !(kind === "ready" && status === 503)) {
    return { status: "unknown", reason: "unreachable" };
  }

  const json = parseJsonObject(body);
  if (json === null) {
    // A body that is not JSON is only an auth failure if it is *the* Vercel
    // challenge. Anything else (a plain-text 503, a truncated body, a 429) is a
    // transient fault: exit 1 there would turn every Vercel hiccup into a red
    // run, and the operator would learn to ignore it.
    if (VERCEL_SSO_PATTERN.test(body)) return { status: "rejected", reason: "sso" };
    return { status: "unknown", reason: status >= 500 || status === 429 ? "unreachable" : "malformed" };
  }
  if (status !== 200 && !(kind === "ready" && status === 503)) {
    return { status: "unknown", reason: "unreachable" };
  }

  if (kind === "version") {
    const version: VersionBody = {
      ok: typeof json.ok === "boolean" ? json.ok : undefined,
      commit: stringField(json, "commit"),
      tree: stringField(json, "tree"),
      release: stringField(json, "release"),
      env: stringField(json, "env"),
      builtAt: stringField(json, "builtAt"),
    };
    return { status: "ok", version, ready: null };
  }

  const ready: ReadyBody = {
    ok: typeof json.ok === "boolean" ? json.ok : undefined,
    db: stringField(json, "db"),
    auth: stringField(json, "auth"),
    commit: stringField(json, "commit"),
    migrations: stringField(json, "migrations"),
  };
  return { status: "ok", version: {}, ready };
}

/**
 * The clock is *per subject*, not per environment (§8). A clock carried from the
 * previous tick applies only while the thing it was started for is unchanged —
 * otherwise a deploy that went live two minutes ago would inherit the age of the
 * one before it and read as stale.
 */
/** The kinds whose clock belongs to the commit check. */
const COMMIT_CLOCK_KINDS: readonly DriftKind[] = ["observing-commit", "stale-commit"];
/** The kinds whose clock belongs to the schema check. */
const MIGRATION_CLOCK_KINDS: readonly DriftKind[] = ["observing-migrations", "stale-migrations"];

/**
 * Whether a carried clock belongs to the check asking about it.
 *
 * Two conditions, both necessary:
 *
 * - a **positive** subject match. The old form returned the prior clock
 *   whenever `clockLiveCommit` was null, so an unattributed clock aged any
 *   subject at all (R2-2.2).
 * - a **kind-family** match. An approval wait 25 minutes long must not make a
 *   commit pushed ten seconds ago look stale (R2-2.1).
 */
function clockApplies(input: {
  prior: number | null;
  clockKind?: DriftKind | null;
  clockLiveCommit?: string | null;
  clockMigrations?: MigrationState | null;
  liveCommit?: string | null;
  migrations?: MigrationState | null;
  families: readonly DriftKind[];
  requireCommit?: boolean;
  requireMigrations?: boolean;
}): number | null {
  const { prior, clockKind, clockLiveCommit, clockMigrations, liveCommit, migrations } = input;
  if (prior === null) return null;
  if (clockKind != null && !input.families.includes(clockKind)) return null;
  if (input.requireCommit) {
    if (typeof clockLiveCommit !== "string" || clockLiveCommit !== liveCommit) return null;
  }
  if (input.requireMigrations) {
    if (typeof clockMigrations !== "string" || clockMigrations !== migrations) return null;
  }
  return prior;
}

/**
 * The run that has been waiting longest.
 *
 * run_id increases monotonically, so comparing ids would pick the *newest* run
 * and hide an already-overdue one behind it. Order by wait duration, and break
 * ties on the smallest id so the choice is deterministic.
 */
function oldestWaitingRun(runs: InFlightRun[]): InFlightRun | null {
  let oldest: InFlightRun | null = null;
  for (const run of runs) {
    if (oldest === null) {
      oldest = run;
      continue;
    }
    const a = run.waitingForMs ?? -1;
    const b = oldest.waitingForMs ?? -1;
    if (a > b || (a === b && run.runId < oldest.runId)) oldest = run;
  }
  return oldest;
}

/**
 * The total order from §8. First match wins, deliberately: `exact` is the *last*
 * resort, never an early short-circuit, because equal commits can still hide a
 * `behind` schema or a deployment answering from the wrong environment.
 */
export function classifyDrift(input: ClassifyInput): Classification {
  const { target, headCommit, read, runs, now } = input;
  const prior = input.firstObserved ?? null;
  const keep = (kind: DriftKind, extra: Partial<Classification> = {}): Classification => ({
    kind,
    firstObserved: prior,
    liveCommit: null,
    headCommit,
    migrations: null,
    runId: null,
    runAttempt: null,
    ...extra,
  });

  // (a) cannot tell
  if (read.status === "unknown") return keep("unknown", { firstObserved: prior });
  // (a') told it may not look — same classification, but the CLI exits 1
  if (read.status === "rejected") return keep("unknown", { firstObserved: prior });

  const version = read.version;
  const ready = read.ready;
  const liveCommit = version.commit && version.commit !== "unknown" ? version.commit : null;
  const migrations = ready && isMigrationState(ready.migrations) ? ready.migrations : null;

  // A `commit` of "unknown" is the build-stamp sentinel for "could not resolve",
  // which is not an identity we can compare.
  if (version.commit === "unknown") {
    return keep("unknown", { liveCommit: null, migrations });
  }

  // A missing commit on either side is "cannot tell", not health. Without this
  // a GitHub API blip (headCommit null) falls through every clause to `exact`
  // and CLOSES a live drift issue.
  if (headCommit === null || liveCommit === null) {
    return keep("unknown", { liveCommit, migrations });
  }

  // (b) a probe failure reports migrations:"diverged" alongside db:"error".
  // Checking migrations first would page a database outage as schema drift.
  if (ready && ready.db === "error") {
    return keep("unknown", { liveCommit, migrations: null });
  }

  const base = { liveCommit, migrations };

  // (c) the endpoint answering from the wrong environment is not health
  if (version.env && version.env !== target) {
    const clock = clockApplies({ prior, clockKind: input.clockKind, families: ["env-mismatch"] });
    return { kind: "env-mismatch", firstObserved: clock ?? now, headCommit, ...base, runId: null, runAttempt: null };
  }

  // (d) designed states — no alert, no clock
  const inFlight = runs.filter(run => run.state === "queued" || run.state === "in_progress");
  if (inFlight.length > 0) {
    const run = oldestWaitingRun(inFlight);
    return {
      kind: "pending",
      firstObserved: null,
      headCommit,
      ...base,
      runId: run?.runId ?? null,
      runAttempt: run?.runAttempt ?? null,
    };
  }

  // (e) approval wait
  const waiting = runs.filter(run => run.state === "waiting");
  if (waiting.length > 0) {
    const run = oldestWaitingRun(waiting);
    const waited = run?.waitingForMs;
    const overdue = typeof waited === "number" && waited >= APPROVAL_HORIZON_MS;
    // The wait start is persisted on BOTH states. Writing null while young
    // means the next tick has no clock to age, so the horizon never expires.
    const waitStart = run?.waitingSince ?? (typeof waited === "number" ? now - waited : now);
    return {
      kind: overdue ? "overdue-approval" : "awaiting-approval",
      firstObserved: waitStart,
      headCommit,
      ...base,
      runId: run?.runId ?? null,
      runAttempt: run?.runAttempt ?? null,
    };
  }

  // (f) commit drift, with its own 20-minute clock, reset when live advances
  if (headCommit !== null && liveCommit !== null && headCommit !== liveCommit) {
    // Commit drift ages against the live commit only. A schema transition must
    // not reset a commit clock: the deploy is no fresher because a migration ran.
    const clock = clockApplies({
      prior,
      clockKind: input.clockKind,
      clockLiveCommit: input.clockLiveCommit,
      liveCommit,
      families: COMMIT_CLOCK_KINDS,
      requireCommit: true,
    });
    const kind = clock !== null && now - clock >= STALE_HORIZON_MS ? "stale-commit" : "observing-commit";
    const started = clock ?? now;
    return { kind, firstObserved: started, headCommit, ...base, runId: null, runAttempt: null };
  }

  // (g) schema drift. `ahead` is time-bounded (ADR 012); `behind`/`diverged`
  // already make readiness answer 503, so waiting would delay a real alarm.
  if (migrations !== null && migrations !== "exact") {
    if (migrations !== "ahead") {
      // `behind`/`diverged` alert immediately; the clock only decides how long
      // the issue has been open, so it must belong to the schema check.
      const clock = clockApplies({
        prior,
        clockKind: input.clockKind,
        clockMigrations: input.clockMigrations,
        migrations,
        families: MIGRATION_CLOCK_KINDS,
        requireMigrations: true,
      });
      return { kind: "stale-migrations", firstObserved: clock ?? now, headCommit, ...base, runId: null, runAttempt: null };
    }
    // ...and the migration clock ages against the migration state only, so an
    // unrelated deploy does not restart a stuck-schema timer.
    const clock = clockApplies({
      prior,
      clockKind: input.clockKind,
      clockMigrations: input.clockMigrations,
      migrations,
      families: MIGRATION_CLOCK_KINDS,
      requireMigrations: true,
    });
    const kind = clock !== null && now - clock >= STALE_HORIZON_MS ? "stale-migrations" : "observing-migrations";
    return { kind, firstObserved: clock ?? now, headCommit, ...base, runId: null, runAttempt: null };
  }

  // (h) healthy
  return { kind: "exact", firstObserved: null, headCommit, ...base, runId: null, runAttempt: null };
}

function startClock(
  _kind: DriftKind,
  prior: number | null,
  now: number,
  extra: Omit<Classification, "kind" | "firstObserved" | "runId" | "runAttempt">,
): Classification {
  return { kind: _kind, firstObserved: prior ?? now, runId: null, runAttempt: null, ...extra };
}

/** The tuple `decideAlert` compares to decide update-vs-none (§8). */
export type ObservationKey = {
  kind: DriftKind;
  liveCommit: string | null;
  headCommit: string | null;
  migrations: MigrationState | null;
  runId: number | null;
  runAttempt: number | null;
};

export function observationKey(classification: Classification): ObservationKey {
  return {
    kind: classification.kind,
    liveCommit: classification.liveCommit,
    headCommit: classification.headCommit,
    migrations: classification.migrations,
    runId: classification.runId,
    runAttempt: classification.runAttempt,
  };
}

export function sameObservation(a: ObservationKey | null, b: ObservationKey): boolean {
  if (a === null) return false;
  return (
    a.kind === b.kind &&
    a.liveCommit === b.liveCommit &&
    a.headCommit === b.headCommit &&
    a.migrations === b.migrations &&
    a.runId === b.runId &&
    a.runAttempt === b.runAttempt
  );
}

/**
 * Which stored clock applies to the *current* subject (M5).
 *
 * Comparing raw timestamps alone is not enough: an issue opened for `sha0` at
 * 04:00 is older than an artifact written for `sha1` at 05:02, so "oldest wins"
 * would keep re-selecting a clock that belongs to a subject the current tick
 * does not have. `clockApplies` then rejects it, the clock resets to now, and
 * the new subject can never age past the horizon — the issue freezes forever.
 *
 * So: prefer a store whose recorded subject matches this tick, and only then
 * take the older of the matching candidates.
 */
export function reconcileState(input: {
  artifact: MonitorState | null;
  issue: MonitorState | null;
  liveCommit: string | null;
  migrations: MigrationState | null;
}): MonitorState | null {
  const { artifact, issue, liveCommit, migrations } = input;

  /**
   * Each candidate is matched by *its own* kind family, not by both fields. A
   * schema clock must not be invalidated because a deploy moved, and a commit
   * clock must not be invalidated because a migration ran — coupling them
   * re-creates the cross-subject reset this function exists to prevent.
   */
  const matches = (state: MonitorState | null): boolean => {
    if (state === null) return false;
    // A clock with no timestamp is not a clock. Comparing `Date.parse(null)`
    // yields NaN, which silently makes every comparison false.
    if (state.firstObserved === null) return false;
    if (Number.isNaN(Date.parse(state.firstObserved))) return false;

    if (COMMIT_CLOCK_KINDS.includes(state.kind)) {
      return state.liveCommit !== null && state.liveCommit === liveCommit;
    }
    if (MIGRATION_CLOCK_KINDS.includes(state.kind)) {
      return state.migrations !== null && state.migrations === migrations;
    }
    if (state.kind === "env-mismatch") return true;
    // Approval and transient clocks are not reconciled against a subject here;
    // they are keyed by (runId, runAttempt) by the caller.
    return true;
  };

  const candidates = [artifact, issue].filter(matches) as MonitorState[];
  if (candidates.length === 0) return null;

  return candidates.reduce((oldest, candidate) => {
    const oldestAt = Date.parse(oldest.firstObserved as string);
    const candidateAt = Date.parse(candidate.firstObserved as string);
    return candidateAt < oldestAt ? candidate : oldest;
  });
}

export type AlertAction = "none" | "open" | "update" | "close";

export type DecideInput = {
  classification: Classification;
  /** Whether an alert issue is currently open for this environment. */
  issueOpen: boolean;
  /** The observation recorded on the open issue, when it is parseable. */
  previousObservation: ObservationKey | null;
};

/**
 * §8's reconciled table. The invariants that matter:
 *
 * - an `unknown` tick never writes (D9): it must not close an alert it cannot
 *   justify closing, and it must not open one either;
 * - a transitional state never closes an alert — a deploy in progress looks
 *   exactly like "healthy" if you only compare commits;
 * - identical overdue observations do not rewrite the issue every 15 minutes.
 */
export function decideAlert(input: DecideInput): AlertAction {
  const { classification, issueOpen, previousObservation } = input;
  const kind = classification.kind;

  if (kind === "unknown") return "none";

  if (kind === "exact") {
    // Never close while a run is in flight — but `exact` implies none was found.
    return issueOpen ? "close" : "none";
  }

  // One gate, not two: `pending` and `awaiting-approval` are absent from
  // ALERTABLE_KINDS, so this covers them and an *overdue* approval — the alert
  // this monitor exists for — still falls through to open/update.
  if (!isAlertable(kind)) return "none";

  if (!issueOpen) return "open";
  return sameObservation(previousObservation, observationKey(classification)) ? "none" : "update";
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** The durable record: written into the issue body, read back on the next tick. */
export type MonitorState = {
  environment: Target;
  kind: DriftKind;
  liveCommit: string | null;
  headCommit: string | null;
  migrations: MigrationState | null;
  runId: number | null;
  runAttempt: number | null;
  firstObserved: string | null;
  alertedAt: string | null;
};

export const STATE_PREFIX = "<!-- drift-monitor:";
export const STATE_SUFFIX = " -->";
const STATE_PATTERN = /<!--\s*drift-monitor:([\s\S]*?)-->/;

export function renderStateComment(state: MonitorState): string {
  const payload = {
    environment: state.environment,
    kind: state.kind,
    liveCommit: state.liveCommit,
    headCommit: state.headCommit,
    migrations: state.migrations,
    runId: state.runId,
    runAttempt: state.runAttempt,
    firstObserved: state.firstObserved,
    alertedAt: state.alertedAt,
  };
  return `${STATE_PREFIX}${JSON.stringify(payload)}${STATE_SUFFIX}`;
}

export function parseStateComment(body: string): MonitorState | null {
  const match = STATE_PATTERN.exec(body);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(match[1].trim());
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const asString = (key: string): string | null => {
    const value = parsed[key];
    return typeof value === "string" ? value : null;
  };
  const asNumber = (key: string): number | null => {
    const value = parsed[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const environment = asString("environment");
  const kind = asString("kind");
  const migrations = asString("migrations");
  if (environment !== "staging" && environment !== "production") return null;
  if (kind === null) return null;
  return {
    environment,
    kind: kind as DriftKind,
    liveCommit: asString("liveCommit"),
    headCommit: asString("headCommit"),
    migrations: isMigrationState(migrations) ? migrations : null,
    runId: asNumber("runId"),
    runAttempt: asNumber("runAttempt"),
    firstObserved: asString("firstObserved"),
    alertedAt: asString("alertedAt"),
  };
}

/**
 * Reject state that could not have been written by this monitor, and clamp a
 * clock that claims to be in the future (F7). The repository is public: without
 * these two checks anyone could silence the alert by editing the issue.
 */
export function validateState(
  state: MonitorState | null,
  target: Target,
  now: number,
): { state: MonitorState | null; adjusted: boolean } {
  if (state === null) return { state: null, adjusted: false };
  if (state.environment !== target) return { state: null, adjusted: true };
  if (state.firstObserved === null) return { state, adjusted: false };
  const parsed = Date.parse(state.firstObserved);
  if (Number.isNaN(parsed)) return { state: null, adjusted: true };
  if (parsed > now) {
    return { state: { ...state, firstObserved: new Date(now).toISOString() }, adjusted: true };
  }
  return { state, adjusted: false };
}

/** Only the monitor's own identity may own the state block (F7). */
export function isTrustedAuthor(input: {
  login?: string | null;
  type?: string | null;
  association?: string | null;
}): boolean {
  const login = (input.login ?? "").toLowerCase();
  if (login === "github-actions[bot]" || login === "github-actions") return true;
  // `association` is the API's own statement of the author's relationship to the
  // repository, which cannot be forged by a commenter.
  return input.association === "OWNER" || input.association === "MEMBER";
}

export function isMonitorIssue(issue: {
  title?: string;
  pull_request?: unknown;
  user?: { login?: string | null; type?: string | null } | null;
  author_association?: string | null;
}): boolean {
  if (issue.pull_request !== undefined && issue.pull_request !== null) return false;
  const login = (issue.user?.login ?? "").toLowerCase();
  // The monitor creates its issues with GITHUB_TOKEN, which is
  // `github-actions[bot]` — and a bot's `author_association` is NONE. Checking
  // the association before the bot identity would reject the monitor's own
  // issue and open a duplicate on every tick.
  if (login === "github-actions[bot]" || login === "github-actions") return true;
  return isTrustedAuthor({
    login: issue.user?.login ?? null,
    type: issue.user?.type ?? null,
    association: issue.author_association ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Neutralise `#`/`@` in a commit headline before it reaches a public issue: a
 * crafted commit message must not be able to ping a user or forge a cross-
 * reference (F7). Backticks keep it readable as code.
 */
export function escapeCommitHeadline(headline: string): string {
  const flattened = headline.replace(/\s+/g, " ").trim().slice(0, 120);
  const neutralised = flattened.replace(/#(?=\d)/g, "＃").replace(/@(?=[A-Za-z0-9_-])/g, "＠");
  return `\`${neutralised.replace(/`/g, "'")}\``;
}

export function describeKind(kind: DriftKind): string {
  switch (kind) {
    case "stale-commit":
      return "the branch head is not what is serving";
    case "stale-migrations":
      return "the live schema does not match the expected migrations";
    case "env-mismatch":
      return "the endpoint answered from a different environment";
    case "overdue-approval":
      return "a run has been waiting for approval past the horizon";
    case "unknown":
      return "the monitor could not determine the state";
    default:
      return kind;
  }
}

export type AlertRenderInput = {
  state: MonitorState;
  headline?: string | null;
  inFlight: string;
  now: number;
};

export function renderAlertBody(input: AlertRenderInput): string {
  const { state, headline, inFlight, now } = input;
  const first = state.firstObserved === null ? null : Date.parse(state.firstObserved);
  // Age is measured against the current tick. Using `alertedAt` freezes the
  // number the moment the issue is first written, so a wait that keeps growing
  // reports the same duration forever.
  const age = first === null ? null : Math.max(0, Math.round((now - first) / 60_000));
  const lines = [
    renderStateComment(state),
    "",
    `Environment: **${state.environment}**`,
    `Signal: \`${state.kind}\` — ${describeKind(state.kind)}`,
    state.headCommit === null ? "Branch head: unknown" : `Branch head: \`${state.headCommit.slice(0, 7)}\`${headline ? ` ${escapeCommitHeadline(headline)}` : ""}`,
    state.liveCommit === null ? "Live commit: unknown" : `Live commit: \`${state.liveCommit.slice(0, 7)}\`${state.headCommit && state.liveCommit !== state.headCommit ? " (behind head)" : ""}`,
    `Schema: \`${state.migrations ?? "unknown"}\``,
    `In-flight runs: ${inFlight}${state.runId === null ? "" : ` (run #${state.runId}, attempt ${state.runAttempt ?? "?"})`}`,
    age === null
      ? "Diverged for: unknown"
      : `Diverged for: ${age} minutes (first observed ${new Date(first as number).toISOString()})`,
    "",
    `Last checked: ${new Date(now).toISOString()}`,
  ];
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Approval clock                                                              */
/* -------------------------------------------------------------------------- */

export type DeploymentStatus = { state?: string; created_at?: string };

/**
 * D6. The clock starts at the deployment status that transitioned into
 * `waiting` — that is the interval the 60-minute horizon bounds.
 *
 * The rejected alternatives are rejected *here*, not by convention: a job
 * blocked on approval may never start (`started_at` is absent), a run waits on
 * other jobs first (`created_at` is early), and a deployment's creation is not
 * the transition into `waiting`.
 */
export function resolveApprovalWaitStart(input: {
  statuses: DeploymentStatus[];
  now: number;
}): number | null {
  for (const status of input.statuses) {
    if (status.state !== "waiting") continue;
    const at = status.created_at === undefined ? Number.NaN : Date.parse(status.created_at);
    if (Number.isNaN(at)) continue;
    if (at > input.now) continue;
    return at;
  }
  return null;
}

/** The fallback clock for a waiting run, keyed by `(runId, runAttempt, environment)`. */
export function approvalFallbackClock(input: {
  state: MonitorState | null;
  runId: number;
  runAttempt: number;
  now: number;
}): number {
  const { state, runId, runAttempt, now } = input;
  if (state !== null && state.runId === runId && state.runAttempt === runAttempt && state.firstObserved !== null) {
    const parsed = Date.parse(state.firstObserved);
    if (!Number.isNaN(parsed) && parsed <= now) return parsed;
  }
  return now;
}

export function waitingFor(run: InFlightRun, now: number, fallback: number): number {
  const start = run.waitingSince ?? fallback;
  return Math.max(0, now - start);
}

/* -------------------------------------------------------------------------- */
/* Workflow filtering                                                          */
/* -------------------------------------------------------------------------- */

/** Workflows that may legitimately hold an alert back, per environment (§6). */
export const MONITORED_WORKFLOWS: Record<Target, readonly string[]> = {
  staging: ["deploy-staging.yml", "migrate.yml"],
  production: ["deploy-production.yml", "migrate.yml"],
};

/** Never consulted, even though they run on `main` (§6). */
export const EXCLUDED_WORKFLOWS: readonly string[] = ["ci.yml", "drift-monitor.yml"];

export function workflowFileName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * Whether a workflow run is in scope for a target. `migrate.yml` serves both
 * environments, so it is attributed separately by `attributeRunToTarget`.
 */
export function isMonitoredWorkflow(path: string, target: Target): boolean {
  const name = workflowFileName(path);
  if (EXCLUDED_WORKFLOWS.includes(name)) return false;
  return MONITORED_WORKFLOWS[target].includes(name);
}

/**
 * Which environment a run belongs to.
 *
 * `migrate.yml` is dispatched per environment (`-f env=staging|production`) and
 * its jobs bind `environment: ${{ inputs.env }}`. The runs API does not expose
 * dispatch inputs, so the environment is attributed from what the run *did*: the
 * environments it is waiting on, or the environments of the deployments it
 * created. Unknown attribution means "do not suppress" — suppressing on a guess
 * would hide a real drift behind an unrelated run.
 */
export function attributeRunToTarget(input: {
  pendingEnvironments: string[];
  deploymentEnvironments: string[];
  target: Target;
}): boolean {
  const { pendingEnvironments, deploymentEnvironments, target } = input;
  const accepted = [target, `${target}-migrations`, `${target}-diagnostics`];
  return [...pendingEnvironments, ...deploymentEnvironments].some(name => accepted.includes(name));
}

/** A run's API state mapped onto the states the classifier understands. */
export function normalizeRunState(status: string): InFlightRun["state"] | null {
  if (status === "queued" || status === "in_progress") return status;
  if (status === "waiting") return "waiting";
  return null;
}
