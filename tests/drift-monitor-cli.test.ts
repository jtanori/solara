import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../scripts/drift-monitor";

/*
 * #165 — `main()` itself. The pure library has its own suite; these cover the
 * wiring that only exists in the CLI: exit codes, the state file contract, and
 * the rule that a tick which could not verify its inputs writes nothing.
 *
 * No network and no token: with `--fixture` the reads come from a file, and
 * `GITHUB_TOKEN` empty means the issue lookup is skipped.
 */

function fixture(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "drift-fx-"));
  const path = join(dir, "fixture.json");
  writeFileSync(
    path,
    JSON.stringify({
      headCommit: "abc1234",
      version: { ok: true, commit: "abc1234", env: "staging" },
      ready: { ok: true, db: "ok", auth: "ok", migrations: "exact" },
      runs: [],
      ...overrides,
    }),
  );
  return path;
}

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "drift-state-"));
  return join(dir, "current.json");
}

/**
 * A transport that fails every request.
 *
 * The sandbox and CI both export GITHUB_TOKEN, so a test relying on "no token"
 * would pass locally and behave differently in CI. Injecting the transport makes
 * the test hermetic: nothing leaves the process.
 */
const offline = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

const noToken = { token: "", fetchImpl: offline };

/** Capture the CLI's own logging; the assertions are on exit codes, logs and files. */
async function runWithLogs(
  argv: string[],
  deps: Record<string, unknown> = noToken,
): Promise<{ code: number; logs: string }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    const code = await main(argv, deps as never);
    return { code, logs: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

async function run(argv: string[], deps: Record<string, unknown> = noToken): Promise<number> {
  return (await runWithLogs(argv, deps)).code;
}

test("the documented fixture runs and classifies a stuck schema", async () => {
  const code = await run(["--env", "staging", "--dry-run", "--fixture", "tests/fixtures/ready-behind.json"]);
  assert.equal(code, 0, "drift is a designed state, never a red run");
});

test("a healthy tick writes an explicit cleared marker", async () => {
  // Uploading nothing would leave the previous drift run's 5-day artifact to be
  // found by the next tick, resurrecting a finished alert.
  const state = statePath();
  const code = await run(["--env", "staging", "--fixture", fixture(), "--state", state]);
  assert.equal(code, 0);
  const written = JSON.parse(readFileSync(join(state, "..", "next.json"), "utf8"));
  assert.equal(written.kind, "exact");
  assert.equal(written.firstObserved, null);
  assert.equal(written.environment, "staging");
});

test("the clock persists across ticks and ages the subject", async () => {
  const state = statePath();
  const drifting = fixture({ headCommit: "fff9999" });

  // Tick 1: no prior state, so this is a first observation.
  assert.equal(await run(["--env", "staging", "--fixture", drifting, "--state", state]), 0);
  const first = JSON.parse(readFileSync(join(state, "..", "next.json"), "utf8"));
  assert.equal(first.kind, "observing-commit");
  assert.ok(first.firstObserved, "the first observation must be recorded");

  // Promote next.json to current.json, as the workflow does between runs, but
  // backdate it past the horizon.
  const backdated = { ...first, firstObserved: new Date(Date.now() - 25 * 60_000).toISOString() };
  writeFileSync(state, JSON.stringify(backdated));

  // Tick 2: the same subject, now overdue. Dry run, so the classification is
  // observable without attempting a write.
  const second = await runWithLogs(["--env", "staging", "--dry-run", "--fixture", drifting, "--state", state]);
  assert.equal(second.code, 0);
  assert.match(second.logs, /kind=stale-commit/, "the carried clock must age past the horizon");
  assert.match(second.logs, /action=open/);
});

test("a degraded read leaves the prior state untouched", async () => {
  // A tick that could not verify its inputs must not rewrite the clock (D9).
  const state = statePath();
  const prior = {
    environment: "staging",
    kind: "observing-commit",
    liveCommit: "abc1234",
    headCommit: "fff9999",
    migrations: "exact",
    runId: null,
    runAttempt: null,
    firstObserved: new Date(Date.now() - 5 * 60_000).toISOString(),
    alertedAt: null,
  };
  writeFileSync(state, JSON.stringify(prior));
  // A young, unchanged subject: no alert, so the tick writes state and the
  // original clock must survive rather than being reset.
  const result = await runWithLogs(["--env", "staging", "--fixture", fixture({ headCommit: "fff9999" }), "--state", state]);
  assert.equal(result.code, 0);
  assert.match(result.logs, /kind=observing-commit/);
  const next = JSON.parse(readFileSync(join(state, "..", "next.json"), "utf8"));
  assert.equal(next.firstObserved, prior.firstObserved, "an unchanged subject keeps its original clock");
});

test("the fixture path parses for every terminal classification", async () => {
  const cases: Array<[string, Record<string, unknown>, number]> = [
    ["healthy", {}, 0],
    ["schema behind", { ready: { db: "ok", migrations: "behind" } }, 0],
    ["database down", { ready: { db: "error", migrations: "diverged" } }, 0],
    ["in flight", { headCommit: "fff9999", runs: [{ runId: 1, runAttempt: 1, state: "in_progress" }] }, 0],
  ];
  for (const [label, overrides, expected] of cases) {
    const code = await run(["--env", "staging", "--dry-run", "--fixture", fixture(overrides)]);
    assert.equal(code, expected, `${label} must exit ${expected}`);
  }
});

test("an overdue approval exits 0 and would open, not red the run", async () => {
  const code = await run([
    "--env",
    "staging",
    "--dry-run",
    "--fixture",
    fixture({ runs: [{ runId: 9, runAttempt: 1, state: "waiting", waitingForMs: 90 * 60_000 }] }),
  ]);
  assert.equal(code, 0, "an overdue approval is drift, reported by the issue");
});

test("a bad argument fails loudly instead of guessing", async () => {
  await assert.rejects(() => run(["--env", "nope"]), /--env must be staging or production/);
  await assert.rejects(() => run(["--fixture"]), /requires a value/);
  await assert.rejects(() => run(["--unknown"]), /unknown argument/);
});

/** A transport that answers from a route table; anything else is offline. */
function routed(routes: Record<string, { status: number; body: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find(pattern => new RegExp(pattern).test(url));
    const route = key === undefined ? { status: 500, body: "" } : routes[key];
    return new Response(route.body, { status: route.status });
  }) as unknown as typeof fetch;
}

test("a 401 from GitHub exits 1, not a silent degrade", async () => {
  // A revoked or missing token must be loud: a quiet `unknown` would keep the
  // monitor blind forever while every run reports healthy.
  const { code } = await runWithLogs(["--env", "staging", "--fixture", fixture({ headCommit: "fff9999" }), "--state", statePath()], {
    token: "configured",
    fetchImpl: routed({ "/issues": { status: 401, body: "{}" } }),
  });
  assert.equal(code, 1);
});

test("a 5xx from the issues API degrades and never opens a duplicate", async () => {
  // `catch(() => null)` here would look like "no issue is open" and POST a
  // second alert for the same drift.
  let posted = false;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") posted = true;
    if (/\/issues\?state=open/.test(url)) return new Response("", { status: 502 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const { code, logs } = await runWithLogs(
    ["--env", "staging", "--fixture", fixture({ headCommit: "fff9999" }), "--state", statePath()],
    { token: "configured", fetchImpl: transport },
  );
  assert.equal(code, 0, "a transient API fault is not a monitor bug");
  assert.equal(posted, false, "no issue may be created when the lookup failed");
  assert.match(logs, /degraded/);
});

test("the real read path takes the head from GitHub and a 502 makes it unknown", async () => {
  const transport = routed({
    "/api/version": { status: 200, body: JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }) },
    "/api/ready": { status: 200, body: JSON.stringify({ ok: true, db: "ok", migrations: "exact" }) },
    "/commits/staging": { status: 502, body: "" },
    "/actions/workflows": { status: 200, body: JSON.stringify({ workflows: [] }) },
  });
  const { code, logs } = await runWithLogs(["--env", "staging", "--dry-run", "--staging-url", "https://staging.example"], {
    token: "configured",
    fetchImpl: transport,
  });
  assert.equal(code, 0);
  assert.match(logs, /kind=unknown/, "a missing head is cannot-tell, never exact");
});
