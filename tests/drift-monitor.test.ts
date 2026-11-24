import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_HORIZON_MS,
  EXCLUDED_WORKFLOWS,
  MONITORED_WORKFLOWS,
  CADENCE_MS,
  STALE_HORIZON_MS,
  approvalFallbackClock,
  attributeRunToTarget,
  classifyDrift,
  decideAlert,
  escapeCommitHeadline,
  isAlertable,
  isMonitorIssue,
  isMonitoredWorkflow,
  isTrustedAuthor,
  parseStateComment,
  reconcileState,
  readEndpoint,
  renderAlertBody,
  renderStateComment,
  resolveApprovalWaitStart,
  validateState,
  waitingFor,
  workflowFileName,
  type Classification,
  type EndpointRead,
  type InFlightRun,
  type MonitorState,
  type Target,
} from "../src/lib/drift-monitor";

/*
 * #165 — the drift monitor's state machine.
 *
 * These are the tests the plan's §10 mutations must break. Every case is a
 * decision the monitor makes on a tick; none of them needs a network.
 */

const NOW = Date.parse("2026-11-23T04:44:12Z");
const MINUTE = 60_000;

function minutesAgo(minutes: number): number {
  return NOW - minutes * MINUTE;
}

function okRead(
  version: { commit?: string; env?: string } = {},
  ready: { db?: string; migrations?: string } = {},
): EndpointRead {
  return {
    status: "ok",
    version: { commit: "abc1234", env: "staging", ...version },
    ready: { ok: true, db: "ok", auth: "ok", migrations: "exact", ...ready },
  };
}

function classify(
  overrides: Partial<Parameters<typeof classifyDrift>[0]> & { read?: EndpointRead } = {},
): Classification {
  return classifyDrift({
    target: "staging" as Target,
    headCommit: "abc1234",
    read: okRead(),
    runs: [],
    now: NOW,
    ...overrides,
  });
}

function waiting(minutes: number, runId = 100, runAttempt = 1): InFlightRun {
  return { runId, runAttempt, state: "waiting", waitingForMs: minutes * MINUTE, waitingSince: minutesAgo(minutes) };
}

/* ---------------------------------------------------------------- fixtures */

test("exact: head equals live and the schema matches", () => {
  const result = classify();
  assert.equal(result.kind, "exact");
  assert.equal(result.firstObserved, null);
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "none");
});

test("stale commit under the horizon only observes", () => {
  const result = classify({ headCommit: "fff9999", firstObserved: minutesAgo(5) });
  assert.equal(result.kind, "observing-commit");
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "none");
});

test("stale commit past the horizon alerts", () => {
  const result = classify({ headCommit: "fff9999", firstObserved: minutesAgo(25) });
  assert.equal(result.kind, "stale-commit");
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "open");
});

test("the clock survives consecutive ticks from a healthy start", () => {
  // The F2 amnesia bug: with no issue open there is nowhere to keep t0, so
  // every tick restarts the clock and the horizon never expires.
  let clock: number | undefined;
  const kinds: string[] = [];
  for (const elapsed of [0, 15, 20, 25]) {
    const now = NOW + elapsed * MINUTE;
    const first = classifyDrift({
      target: "staging",
      headCommit: "fff9999",
      read: okRead(),
      runs: [],
      firstObserved: clock,
      now,
    });
    kinds.push(first.kind);
    clock = first.firstObserved ?? undefined;
  }
  assert.deepEqual(kinds, ["observing-commit", "observing-commit", "stale-commit", "stale-commit"]);
});

test("live advancing resets the clock instead of inheriting staleness", () => {
  const stale = classify({ headCommit: "fff9999", firstObserved: minutesAgo(30) });
  assert.equal(stale.kind, "stale-commit");
  // A fresh deploy lands: the drift subject changed, so the clock must restart.
  // The state recorded which commit the clock belonged to, and live has moved.
  const fresh = classify({
    headCommit: "fff9999",
    firstObserved: minutesAgo(30),
    clockLiveCommit: "sha0",
    read: okRead({ commit: "sha1" }),
  });
  assert.equal(fresh.kind, "observing-commit", "a newly live commit is a new subject, not a stale one");
  assert.equal(fresh.firstObserved, NOW, "the fresh subject starts its own clock");
});

test("a queued run suppresses the alert", () => {
  const result = classify({ headCommit: "fff9999", firstObserved: minutesAgo(30), runs: [{ runId: 1, runAttempt: 1, state: "queued" }] });
  assert.equal(result.kind, "pending");
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "none");
});

test("an in-progress run suppresses the alert", () => {
  const result = classify({ headCommit: "fff9999", firstObserved: minutesAgo(30), runs: [{ runId: 1, runAttempt: 1, state: "in_progress" }] });
  assert.equal(result.kind, "pending");
});

test("an in-flight run never closes an open issue", () => {
  const result = classify({ runs: [{ runId: 1, runAttempt: 1, state: "in_progress" }] });
  assert.equal(result.kind, "pending");
  assert.notEqual(decideAlert({ classification: result, issueOpen: true, previousObservation: null }), "close");
});

test("a young waiting run is quiet", () => {
  const result = classify({ firstObserved: minutesAgo(10), runs: [waiting(10)] });
  assert.equal(result.kind, "awaiting-approval");
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "none");
});

test("an overdue waiting run alerts once", () => {
  const result = classify({ runs: [waiting(90)] });
  assert.equal(result.kind, "overdue-approval");
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "open");
});

test("a superseded attempt with a young clock stays quiet", () => {
  // run_attempt 2 has been waiting 5 minutes; attempt 1 waited 90 and expired.
  // The clock must follow the newest attempt, not the oldest observation.
  const result = classify({ runs: [waiting(5, 200, 2)], firstObserved: minutesAgo(90) });
  assert.equal(result.kind, "awaiting-approval");
});

test("a superseded attempt that is itself overdue alerts", () => {
  const result = classify({ runs: [waiting(90, 200, 2)] });
  assert.equal(result.kind, "overdue-approval");
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "open");
});

test("the approval clock rejects started_at, run.created_at and deployment.created_at", () => {
  // Only a status transitioned to `waiting` names the interval being bounded.
  assert.equal(resolveApprovalWaitStart({ statuses: [{ state: "success", created_at: "2026-11-23T01:00:00Z" }], now: NOW }), null);
  assert.equal(resolveApprovalWaitStart({ statuses: [], now: NOW }), null);
  const waitingAt = resolveApprovalWaitStart({
    statuses: [
      { state: "queued", created_at: "2026-11-23T01:00:00Z" },
      { state: "waiting", created_at: "2026-11-23T04:00:00Z" },
    ],
    now: NOW,
  });
  assert.equal(waitingAt, Date.parse("2026-11-23T04:00:00Z"));
  // A clock in the future is not a clock.
  assert.equal(resolveApprovalWaitStart({ statuses: [{ state: "waiting", created_at: "2027-01-01T00:00:00Z" }], now: NOW }), null);
});

test("the approval fallback clock is keyed by run id and attempt", () => {
  const state: MonitorState = {
    environment: "staging",
    kind: "awaiting-approval",
    liveCommit: null,
    headCommit: null,
    migrations: null,
    runId: 200,
    runAttempt: 2,
    firstObserved: "2026-11-23T03:44:00Z",
    alertedAt: null,
  };
  assert.equal(approvalFallbackClock({ state, runId: 200, runAttempt: 2, now: NOW }), Date.parse("2026-11-23T03:44:00Z"));
  // A different attempt is a different subject.
  assert.equal(approvalFallbackClock({ state, runId: 200, runAttempt: 3, now: NOW }), NOW);
});

test("waitingFor is measured from the resolved start", () => {
  const run = waiting(10);
  assert.equal(waitingFor(run, NOW, minutesAgo(99)), 10 * MINUTE);
});

/* --------------------------------------------------------------- migrations */

test("ahead is quiet while young and alerts past the horizon", () => {
  const young = classify({ firstObserved: minutesAgo(5), read: okRead({}, { migrations: "ahead" }) });
  assert.equal(young.kind, "observing-migrations");
  const old = classify({ firstObserved: minutesAgo(25), read: okRead({}, { migrations: "ahead" }) });
  assert.equal(old.kind, "stale-migrations");
  assert.equal(decideAlert({ classification: old, issueOpen: false, previousObservation: null }), "open");
});

test("behind and diverged alert immediately, with no horizon", () => {
  for (const migrations of ["behind", "diverged"]) {
    const result = classify({ firstObserved: minutesAgo(1), read: okRead({}, { migrations }) });
    assert.equal(result.kind, "stale-migrations", `${migrations} already means 503; waiting would delay a real alarm`);
  }
});

test("a database error is unknown, not schema drift", () => {
  // The readiness catch path reports db:"error" together with
  // migrations:"diverged". Reading migrations first would page an outage as
  // schema drift.
  const result = classify({ read: okRead({}, { db: "error", migrations: "diverged" }) });
  assert.equal(result.kind, "unknown");
  assert.equal(decideAlert({ classification: result, issueOpen: true, previousObservation: null }), "none");
});

test("equal commits do not hide schema drift", () => {
  const result = classify({ read: okRead({}, { migrations: "behind" }) });
  assert.equal(result.headCommit, result.liveCommit);
  assert.equal(result.kind, "stale-migrations");
});

test("an endpoint answering from the wrong environment is not health", () => {
  const result = classify({ read: okRead({ env: "production" }) });
  assert.equal(result.kind, "env-mismatch");
});

test("the Vercel challenge is a rejection, not a schema verdict", () => {
  const read = readEndpoint({
    status: 200,
    body: "<!DOCTYPE html><html><head><title>Log in to Vercel</title></head></html>",
    kind: "version",
  });
  assert.deepEqual(read, { status: "rejected", reason: "sso" });
});

test("a transient fault is unknown, never a rejection", () => {
  // Exit 1 means "the monitor was told it may not look". A plain-text 503, a
  // truncated body or a 429 is the host failing; classifying those as
  // `rejected` would turn every Vercel hiccup into a red run and teach the
  // operator to ignore the alert.
  assert.deepEqual(readEndpoint({ status: 503, body: "<html>Service Unavailable</html>", kind: "ready" }), {
    status: "unknown",
    reason: "unreachable",
  });
  assert.deepEqual(readEndpoint({ status: 503, body: "upstream timeout", kind: "version" }), {
    status: "unknown",
    reason: "unreachable",
  });
  assert.deepEqual(readEndpoint({ status: 429, body: "Too Many Requests", kind: "ready" }), {
    status: "unknown",
    reason: "unreachable",
  });
  assert.deepEqual(readEndpoint({ status: 200, body: '{"ok":tr', kind: "ready" }), {
    status: "unknown",
    reason: "malformed",
  });
});

test("a 503 with a JSON body is a successful readiness read", () => {
  const read = readEndpoint({
    status: 503,
    body: JSON.stringify({ ok: false, db: "ok", auth: "ok", commit: "abc1234", migrations: "behind" }),
    kind: "ready",
  });
  assert.equal(read.status, "ok");
  const result = classify({ read: { status: "ok", version: { commit: "abc1234", env: "staging" }, ready: read.ready } });
  assert.equal(result.kind, "stale-migrations");
});

test("pre-promotion production is unknown, never drift", () => {
  const read = readEndpoint({ status: 404, body: "", kind: "version" });
  assert.deepEqual(read, { status: "unknown", reason: "absent" });
  const result = classifyDrift({ target: "production", headCommit: "abc1234", read, runs: [], now: NOW });
  assert.equal(result.kind, "unknown");
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "none");
});

test("a 5xx or an abort is unknown and keeps an open issue", () => {
  const read = readEndpoint({ status: 502, body: "bad gateway", kind: "version" });
  assert.deepEqual(read, { status: "unknown", reason: "unreachable" });
  const result = classifyDrift({ target: "staging", headCommit: "abc1234", read, runs: [], now: NOW });
  assert.equal(result.kind, "unknown");
  assert.equal(decideAlert({ classification: result, issueOpen: true, previousObservation: null }), "none");
});

test("401, 403 and an SSO redirect are rejections", () => {
  assert.deepEqual(readEndpoint({ status: 401, body: "", kind: "version" }), { status: "rejected", reason: "unauthorized" });
  assert.deepEqual(readEndpoint({ status: 403, body: "", kind: "version" }), { status: "rejected", reason: "forbidden" });
  assert.deepEqual(readEndpoint({ status: 307, body: "", kind: "version" }), { status: "rejected", reason: "sso" });
});

test("a rejected tick writes nothing", () => {
  const read: EndpointRead = { status: "rejected", reason: "forbidden" };
  const result = classifyDrift({ target: "staging", headCommit: "abc1234", read, runs: [], now: NOW });
  assert.equal(result.kind, "unknown");
  assert.equal(decideAlert({ classification: result, issueOpen: true, previousObservation: null }), "none");
});

test("an unknown commit sentinel is not a comparison", () => {
  const result = classify({ read: okRead({ commit: "unknown" }) });
  assert.equal(result.kind, "unknown");
});

/* ------------------------------------------------------------------ alerts */

test("an identical overdue observation does not rewrite the issue", () => {
  const result = classify({ runs: [waiting(90)] });
  const observation = {
    kind: result.kind,
    liveCommit: result.liveCommit,
    headCommit: result.headCommit,
    migrations: result.migrations,
    runId: result.runId,
    runAttempt: result.runAttempt,
  };
  assert.equal(decideAlert({ classification: result, issueOpen: true, previousObservation: observation }), "none");
  const changed = { ...observation, runId: 999 };
  assert.equal(decideAlert({ classification: result, issueOpen: true, previousObservation: changed }), "update");
});

test("a transitional state never rewrites or closes an alert", () => {
  const pending = classify({ headCommit: "fff9999", runs: [{ runId: 1, runAttempt: 1, state: "in_progress" }] });
  assert.equal(decideAlert({ classification: pending, issueOpen: true, previousObservation: null }), "none");
  const young = classify({ runs: [waiting(5)] });
  assert.equal(decideAlert({ classification: young, issueOpen: true, previousObservation: null }), "none");
});

test("healthy closes an open issue, and only then", () => {
  const healthy = classify();
  assert.equal(decideAlert({ classification: healthy, issueOpen: true, previousObservation: null }), "close");
  assert.equal(decideAlert({ classification: healthy, issueOpen: false, previousObservation: null }), "none");
});

test("staging state never closes or suppresses production", () => {
  const stagingIssue: MonitorState = {
    environment: "staging",
    kind: "stale-commit",
    liveCommit: "a",
    headCommit: "b",
    migrations: "exact",
    runId: null,
    runAttempt: null,
    firstObserved: "2026-11-23T03:00:00Z",
    alertedAt: null,
  };
  const validated = validateState(stagingIssue, "production", NOW);
  assert.equal(validated.state, null, "a production leg must ignore a staging state block");
  assert.equal(validated.adjusted, true);
});

/* ------------------------------------------------------------------- state */

test("state round-trips through the issue body", () => {
  const state: MonitorState = {
    environment: "staging",
    kind: "stale-commit",
    liveCommit: "def5678",
    headCommit: "abc1234",
    migrations: "exact",
    runId: null,
    runAttempt: null,
    firstObserved: "2026-11-23T04:10:00Z",
    alertedAt: "2026-11-23T04:44:12Z",
  };
  const body = `# Alert\n\n${renderStateComment(state)}\n\nSome prose.`;
  assert.deepEqual(parseStateComment(body), state);
});

test("an edited or missing state block is a first observation, not a crash", () => {
  assert.equal(parseStateComment("no state here"), null);
  assert.equal(parseStateComment("<!-- drift-monitor:{not json} -->"), null);
  const state = parseStateComment(renderStateComment({
    environment: "staging",
    kind: "exact",
    liveCommit: null,
    headCommit: null,
    migrations: null,
    runId: null,
    runAttempt: null,
    firstObserved: null,
    alertedAt: null,
  }));
  assert.equal(state?.firstObserved, null);
});

test("a future firstObserved is clamped to now", () => {
  const state: MonitorState = {
    environment: "staging",
    kind: "stale-commit",
    liveCommit: null,
    headCommit: null,
    migrations: null,
    runId: null,
    runAttempt: null,
    firstObserved: "2099-01-01T00:00:00Z",
    alertedAt: null,
  };
  const validated = validateState(state, "staging", NOW);
  assert.equal(validated.adjusted, true);
  assert.equal(validated.state?.firstObserved, new Date(NOW).toISOString());
});

test("a commit headline cannot ping or cross-reference", () => {
  const escaped = escapeCommitHeadline("fix: call @someone please, see #42");
  assert.equal(escaped.includes("@"), false);
  assert.equal(escaped.includes("#42"), false);
});

test("the rendered body carries the state and hides no secrets", () => {
  const body = renderAlertBody({
    state: {
      environment: "staging",
      kind: "stale-commit",
      liveCommit: "def5678",
      headCommit: "abc1234",
      migrations: "exact",
      runId: null,
      runAttempt: null,
      firstObserved: "2026-11-23T04:10:00Z",
      alertedAt: "2026-11-23T04:44:12Z",
    },
    headline: "docs: something #1234",
    inFlight: "none",
    now: NOW,
  });
  assert.match(body, /drift-monitor:\{/);
  assert.match(body, /Diverged for: 34 minutes/);
  assert.equal(parseStateComment(body)?.kind, "stale-commit");
});

/* ---------------------------------------------------------------- workflow */

test("the monitor and ci are never consulted, or it sees itself", () => {
  assert.equal(isMonitoredWorkflow(".github/workflows/drift-monitor.yml", "staging"), false);
  assert.equal(isMonitoredWorkflow(".github/workflows/ci.yml", "staging"), false);
  assert.equal(isMonitoredWorkflow(".github/workflows/migrate.yml", "staging"), true);
  assert.equal(workflowFileName(".github/workflows/migrate.yml"), "migrate.yml");
});

test("migrate runs are attributed by what they touch", () => {
  assert.equal(attributeRunToTarget({ pendingEnvironments: ["staging-migrations"], deploymentEnvironments: [], target: "staging" }), true);
  assert.equal(attributeRunToTarget({ pendingEnvironments: ["production-migrations"], deploymentEnvironments: [], target: "staging" }), false);
  // Unknown attribution must not suppress.
  assert.equal(attributeRunToTarget({ pendingEnvironments: [], deploymentEnvironments: [], target: "staging" }), false);
});

test("ci.yml runs are never consulted as in-flight", () => {
  // The monitor must not see itself or an unrelated test run. Without the
  // exclusion a run on main is `in_progress` on every tick and suppresses every
  // alert forever — permanently blind while reporting healthy.
  assert.equal(isMonitoredWorkflow(".github/workflows/ci.yml", "staging"), false);
  assert.equal(isMonitoredWorkflow(".github/workflows/drift-monitor.yml", "production"), false);
  assert.equal(isMonitoredWorkflow(".github/workflows/deploy-production.yml", "production"), true);
});

test("an in-progress run is not alertable on its own", () => {
  const result = classify({ headCommit: "fff9999", firstObserved: minutesAgo(60), runs: [{ runId: 1, runAttempt: 1, state: "in_progress" }] });
  assert.equal(result.kind, "pending");
  // `pending` is a designed state: even with no issue open it must not page.
  assert.equal(decideAlert({ classification: result, issueOpen: false, previousObservation: null }), "none");
});

test("a monitor issue from an untrusted author is ignored", () => {
  // The repository is public. Title matching alone would let anyone own the
  // state block and silence the alert.
  assert.equal(isMonitorIssue({ title: "drift-monitor: staging", user: { login: "drive-by" }, author_association: "NONE" }), false);
  assert.equal(isMonitorIssue({ title: "drift-monitor: staging", user: { login: "github-actions[bot]", type: "Bot" }, author_association: "NONE" }), true);
  assert.equal(isMonitorIssue({ title: "drift-monitor: staging", user: { login: "jtanori" }, author_association: "OWNER" }), true);
  // A pull request is never the issue.
  assert.equal(isMonitorIssue({ title: "drift-monitor: staging", pull_request: {}, user: { login: "jtanori" }, author_association: "OWNER" }), false);
});

test("a CI or self run can never be mistaken for a deploy, even by allowlist", () => {
  // Defence in depth: `ci.yml` is not in the per-target allowlist either, so
  // removing the exclusion list would still not let it suppress an alert.
  assert.equal(MONITORED_WORKFLOWS.staging.includes("ci.yml"), false);
  assert.equal(MONITORED_WORKFLOWS.production.includes("ci.yml"), false);
  assert.equal(MONITORED_WORKFLOWS.staging.includes("drift-monitor.yml"), false);
  assert.equal(EXCLUDED_WORKFLOWS.includes("ci.yml"), true);
});

test("an outsider's association alone is not enough to own the state", () => {
  // The helper answers on identity; the caller's NONE check is a second gate.
  // Neither may be the only one.
  assert.equal(isTrustedAuthor({ login: "drive-by", association: "NONE" }), false);
  assert.equal(isTrustedAuthor({ login: "drive-by", association: "CONTRIBUTOR" }), false);
  assert.equal(isTrustedAuthor({ login: "jtanori", association: "OWNER" }), true);
});

test("the alertable set excludes every designed state", () => {
  // `pending` and `awaiting-approval` are expected; alerting on them trains the
  // operator to ignore the issue. This pins the set itself, not just the one
  // early return that happens to consult it.
  for (const kind of ["pending", "awaiting-approval", "observing-commit", "observing-migrations", "exact", "unknown"] as const) {
    assert.equal(isAlertable(kind), false, `${kind} must not be alertable`);
  }
  for (const kind of ["stale-commit", "stale-migrations", "overdue-approval", "env-mismatch"] as const) {
    assert.equal(isAlertable(kind), true, `${kind} must be alertable`);
  }
});

/* ------------------------------------------------- M2/M3/M5 regressions */

test("a missing commit is unknown, never exact", () => {
  // A GitHub API blip leaves headCommit null. Falling through to `exact` would
  // CLOSE a live drift issue during the outage.
  const noHead = classifyDrift({ target: "staging", headCommit: null, read: okRead(), runs: [], now: NOW });
  assert.equal(noHead.kind, "unknown");
  assert.equal(decideAlert({ classification: noHead, issueOpen: true, previousObservation: null }), "none");
  const noLive = classifyDrift({
    target: "staging",
    headCommit: "abc1234",
    read: { status: "ok", version: { env: "staging" }, ready: { db: "ok", migrations: "exact" } },
    runs: [],
    now: NOW,
  });
  assert.equal(noLive.kind, "unknown");
});

test("the longest-waiting run wins over the newest run id", () => {
  // run_id increases monotonically, so comparing ids hides an overdue run
  // behind a freshly queued one.
  const result = classify({
    runs: [
      { runId: 100, runAttempt: 1, state: "waiting", waitingForMs: 90 * MINUTE, waitingSince: minutesAgo(90) },
      { runId: 101, runAttempt: 1, state: "waiting", waitingForMs: 2 * MINUTE, waitingSince: minutesAgo(2) },
    ],
  });
  assert.equal(result.kind, "overdue-approval");
  assert.equal(result.runId, 100, "the overdue run must be the one reported");
});

test("both approval states persist the wait start", () => {
  const young = classify({ runs: [waiting(10)] });
  assert.equal(young.kind, "awaiting-approval");
  // Writing null here means the next tick has no clock to age and the horizon
  // can never expire.
  assert.notEqual(young.firstObserved, null, "a young wait must carry its start");
  assert.equal(young.firstObserved, minutesAgo(10));
  const overdue = classify({ runs: [waiting(90)] });
  assert.equal(overdue.firstObserved, minutesAgo(90), "an overdue wait reports the real duration");
});

test("the approval fallback clock ages a wait across ticks", () => {
  // D6 candidate 2: no deployment-status timestamp exists, so the persisted
  // observation is the only clock. With it dead, every tick reported 0 ms.
  const start = minutesAgo(65);
  const run: InFlightRun = { runId: 7, runAttempt: 1, state: "waiting", waitingSince: start };
  assert.equal(waitingFor(run, NOW, start), 65 * MINUTE);
  const state: MonitorState = {
    environment: "staging",
    kind: "awaiting-approval",
    liveCommit: null,
    headCommit: null,
    migrations: null,
    runId: 7,
    runAttempt: 1,
    firstObserved: new Date(start).toISOString(),
    alertedAt: null,
  };
  const fallback = approvalFallbackClock({ state, runId: 7, runAttempt: 1, now: NOW });
  assert.equal(fallback, start);
  const past = classify({ runs: [{ ...run, waitingForMs: waitingFor(run, NOW, fallback) }] });
  assert.equal(past.kind, "overdue-approval", "a persisted clock past the horizon must alert");
});

test("an open issue from a previous subject does not freeze the new one", () => {
  // Issue opened for sha0 at 04:00. A deploy lands: live=sha1, head=sha2.
  // Taking the older clock unconditionally re-selects sha0's, clockApplies
  // rejects it, the clock resets each tick, and sha1 never ages.
  const issueState: MonitorState = {
    environment: "staging",
    kind: "stale-commit",
    liveCommit: "sha0",
    headCommit: "sha1",
    migrations: "exact",
    runId: null,
    runAttempt: null,
    firstObserved: "2026-11-23T04:00:00Z",
    alertedAt: null,
  };
  const artifact: MonitorState = {
    ...issueState,
    liveCommit: "sha1",
    headCommit: "sha2",
    firstObserved: new Date(NOW - 25 * MINUTE).toISOString(),
  };
  const reconciled = reconcileState({ artifact, issue: issueState, liveCommit: "sha1", migrations: "exact" });
  assert.equal(reconciled?.liveCommit, "sha1", "the clock must belong to the current subject");
  assert.equal(Date.parse(reconciled?.firstObserved as string), NOW - 25 * MINUTE);
  const result = classifyDrift({
    target: "staging",
    headCommit: "sha2",
    read: okRead({ commit: "sha1" }),
    runs: [],
    firstObserved: Date.parse(reconciled?.firstObserved as string),
    clockLiveCommit: reconciled?.liveCommit ?? undefined,
    clockMigrations: reconciled?.migrations ?? undefined,
    now: NOW,
  });
  assert.equal(result.kind, "stale-commit", "the new subject must be able to age past the horizon");
});

test("a migration transition does not reset an unchanged commit clock", () => {
  const result = classify({
    headCommit: "fff9999",
    firstObserved: minutesAgo(25),
    clockLiveCommit: "abc1234",
    clockMigrations: "ahead",
    read: okRead({}, { migrations: "exact" }),
  });
  assert.equal(result.kind, "stale-commit", "the deploy is no fresher because a migration ran");
});

test("a deploy does not reset a stuck-schema timer", () => {
  const result = classify({
    firstObserved: minutesAgo(25),
    clockLiveCommit: "old9999",
    clockMigrations: "ahead",
    read: okRead({ commit: "abc1234" }, { migrations: "ahead" }),
  });
  assert.equal(result.kind, "stale-migrations", "the schema is no fresher because a deploy landed");
});

test("the alert body reports the current age and names the run", () => {
  const body = renderAlertBody({
    state: {
      environment: "staging",
      kind: "overdue-approval",
      liveCommit: null,
      headCommit: "abc1234",
      migrations: "exact",
      runId: 42,
      runAttempt: 3,
      firstObserved: new Date(NOW - 65 * MINUTE).toISOString(),
      // A preserved alertedAt must not freeze the number.
      alertedAt: new Date(NOW - 5 * MINUTE).toISOString(),
    },
    headline: null,
    inFlight: "1",
    now: NOW,
  });
  assert.match(body, /Diverged for: 65 minutes/);
  assert.match(body, /run #42, attempt 3/);
});

test("the three constants are the documented cadence and horizons", () => {
  assert.equal(CADENCE_MS, 15 * MINUTE);
  assert.equal(STALE_HORIZON_MS, 20 * MINUTE);
  assert.equal(APPROVAL_HORIZON_MS, 60 * MINUTE);
});
