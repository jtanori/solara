import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("an unchanged young subject keeps its original clock", async () => {
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
    // Plain substring match: these keys contain `?` and `/`, which mean
    // something else to a regex and silently failed to match.
    const key = Object.keys(routes).find(pattern => url.includes(pattern));
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

test("a tick that cannot classify writes no state at all", async () => {
  // D9. `read.status` is "ok" here while the classification is `unknown`, which
  // is exactly the case the old gate missed: it rewrote next.json with a null
  // subject but the previous timestamp, and the NEXT tick then opened a false
  // stale-commit alert.
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      "ready 502",
      {},
      {
        "/api/version": { status: 200, body: JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }) },
        "/api/ready": { status: 502, body: "" },
        "/issues?state=open": { status: 200, body: "[]" },
      },
    ],
    [
      "db error",
      {},
      {
        "/api/version": { status: 200, body: JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }) },
        "/api/ready": { status: 503, body: JSON.stringify({ ok: false, db: "error", migrations: "diverged" }) },
        "/issues?state=open": { status: 200, body: "[]" },
      },
    ],
  ];
  for (const [label, , routes] of cases) {
    const state = statePath();
    const { code, logs } = await runWithLogs(["--env", "staging", "--staging-url", "https://staging.example", "--state", state], {
      token: "configured",
      fetchImpl: routed({
        ...routes,
        "/actions/workflows": { status: 200, body: JSON.stringify({ workflows: [] }) },
        // An empty issue list, so this test cannot pass merely because the
        // lookup failed for an unrelated reason.
        "/issues?state=open": { status: 200, body: "[]" },
      }),
    });
    assert.equal(code, 0, `${label} is degraded, not a red run`);
    assert.match(logs, /degraded: (unreachable|classification unknown)/, `${label} must be reported as degraded`);
    assert.equal(existsSync(join(state, "..", "next.json")), false, `${label} must not rewrite the clock`);
  }
});

test("a 401 on the head lookup exits 1", async () => {
  const { code } = await runWithLogs(["--env", "staging", "--staging-url", "https://staging.example"], {
    token: "configured",
    fetchImpl: routed({
      "/api/version": { status: 200, body: JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }) },
      "/api/ready": { status: 200, body: JSON.stringify({ ok: true, db: "ok", migrations: "exact" }) },
      "/commits/staging": { status: 401, body: "" },
    }),
  });
  assert.equal(code, 1, "a rejected token must not be silently green");
});

test("a 403 on the actions API exits 1", async () => {
  const { code } = await runWithLogs(["--env", "staging", "--staging-url", "https://staging.example"], {
    token: "configured",
    fetchImpl: routed({
      "/api/version": { status: 200, body: JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }) },
      "/api/ready": { status: 200, body: JSON.stringify({ ok: true, db: "ok", migrations: "exact" }) },
      "/commits/staging": { status: 200, body: JSON.stringify({ sha: "abc1234", commit: { message: "x" } }) },
      "/actions/workflows": { status: 403, body: "" },
    }),
  });
  assert.equal(code, 1, "an unreadable run list is a rejection, not 'nothing in flight'");
});

test("a 5xx on the run scan degrades instead of closing an alert", async () => {
  // An empty run list from a failed query looks exactly like "nothing in
  // flight", which would close an open overdue-approval issue.
  const state = statePath();
  const { code, logs } = await runWithLogs(["--env", "staging", "--staging-url", "https://staging.example", "--state", state], {
    token: "configured",
    fetchImpl: routed({
      "/api/version": { status: 200, body: JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }) },
      "/api/ready": { status: 200, body: JSON.stringify({ ok: true, db: "ok", migrations: "exact" }) },
      "/commits/staging": { status: 200, body: JSON.stringify({ sha: "abc1234", commit: { message: "x" } }) },
      "/actions/workflows": { status: 502, body: "" },
      "/issues?state=open": { status: 200, body: "[]" },
    }),
  });
  assert.equal(code, 0);
  assert.match(logs, /run scan failed/, "an unverifiable scan is reported as such, not as healthy");
  assert.equal(existsSync(join(state, "..", "next.json")), false);
});

test("a cleared artifact does not shadow the issue's approval clock", async () => {
  // The workflow writes an "unknown" stub when a tick cannot produce state. That
  // stub is non-null, so `artifactState ?? issueState` would pick it and discard
  // a 65-minute-old open approval wait — the alert would never fire.
  const state = statePath();
  writeFileSync(
    state,
    JSON.stringify({
      environment: "staging",
      kind: "unknown",
      liveCommit: null,
      headCommit: null,
      migrations: null,
      runId: null,
      runAttempt: null,
      firstObserved: null,
      alertedAt: null,
    }),
  );

  const sixtyFiveMinutesAgo = new Date(Date.now() - 65 * 60_000).toISOString();
  let patched: Record<string, unknown> | null = null;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      patched = JSON.parse(String(init.body));
      return new Response("{}", { status: 200 });
    }
    if (/\/api\/version/.test(url)) {
      return new Response(JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }), { status: 200 });
    }
    if (/\/api\/ready/.test(url)) {
      return new Response(JSON.stringify({ ok: true, db: "ok", migrations: "exact" }), { status: 200 });
    }
    if (/\/api\/ready|\/commits\//.test(url)) {
      return new Response(JSON.stringify({ sha: "abc1234", commit: { message: "x" } }), { status: 200 });
    }
    if (/\/commits\/staging/.test(url)) {
      return new Response(JSON.stringify({ sha: "abc1234", commit: { message: "x" } }), { status: 200 });
    }
    if (/\/actions\/workflows\?/.test(url)) {
      return new Response(
        JSON.stringify({ workflows: [{ id: 1, path: ".github/workflows/migrate.yml" }] }),
        { status: 200 },
      );
    }
    if (/\/actions\/workflows\/1\/runs/.test(url)) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 777, run_attempt: 1, status: "waiting", path: ".github/workflows/migrate.yml", head_sha: "abc1234" },
          ],
        }),
        { status: 200 },
      );
    }
    if (/pending_deployments/.test(url)) {
      return new Response(JSON.stringify([{ environment: { name: "staging-migrations" } }]), { status: 200 });
    }
    if (/\/deployments/.test(url)) return new Response("[]", { status: 200 });
    if (/\/issues\?state=open/.test(url)) {
      return new Response(
        JSON.stringify([
          {
            number: 9,
            title: "drift-monitor: staging",
            user: { login: "github-actions[bot]", type: "Bot" },
            author_association: "NONE",
            body: `<!-- drift-monitor:{"environment":"staging","kind":"awaiting-approval","liveCommit":"abc1234","headCommit":"abc1234","migrations":"exact","runId":777,"runAttempt":1,"firstObserved":"${sixtyFiveMinutesAgo}","alertedAt":null} -->`,
          },
        ]),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const { logs } = await runWithLogs(["--env", "staging", "--staging-url", "https://staging.example", "--state", state], {
    token: "configured",
    fetchImpl: transport,
  });
  assert.match(logs, /kind=overdue-approval/, "the open issue's 65-minute clock must still be found");
  assert.ok(patched !== null, "an overdue approval must be written");
});

test("a 5xx while closing degrades instead of crashing", async () => {
  // Closing is a write like any other: a transient fault must leave the alert
  // open and exit 0, not escape as exit 2 ("the monitor is broken").
  let closed = false;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH" && /issues\/9/.test(url)) {
      closed = true;
      return new Response("", { status: 502 });
    }
    if (/\/api\/version/.test(url)) {
      return new Response(JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }), { status: 200 });
    }
    if (/\/api\/ready/.test(url)) {
      return new Response(JSON.stringify({ ok: true, db: "ok", migrations: "exact" }), { status: 200 });
    }
    if (/\/commits\/staging/.test(url)) {
      return new Response(JSON.stringify({ sha: "abc1234", commit: { message: "x" } }), { status: 200 });
    }
    if (/\/actions\/workflows\?/.test(url)) {
      return new Response(JSON.stringify({ workflows: [] }), { status: 200 });
    }
    if (/\/issues\?state=open/.test(url)) {
      return new Response(
        JSON.stringify([
          {
            number: 9,
            title: "drift-monitor: staging",
            user: { login: "github-actions[bot]", type: "Bot" },
            author_association: "NONE",
            body: '<!-- drift-monitor:{"environment":"staging","kind":"stale-commit","liveCommit":"abc1234","headCommit":"fff9999","migrations":"exact","runId":null,"runAttempt":null,"firstObserved":"2026-01-01T00:00:00Z","alertedAt":null} -->',
          },
        ]),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const { code, logs } = await runWithLogs(["--env", "staging", "--staging-url", "https://staging.example"], {
    token: "configured",
    fetchImpl: transport,
  });
  assert.equal(code, 0, "a transient close failure is degraded, not a bug");
  assert.equal(closed, true, "the close must have been attempted");
  assert.match(logs, /could not close issue #9/, "the failure must be reported, not swallowed");
});

test("a failure listing runs for a known workflow degrades the tick", async () => {
  // Distinct from a failed workflow list: here the monitor *knows* a monitored
  // workflow exists but cannot read its runs, so an empty list is unverifiable
  // and must not be read as "nothing in flight".
  const state = statePath();
  const { code, logs } = await runWithLogs(["--env", "staging", "--staging-url", "https://staging.example", "--state", state], {
    token: "configured",
    fetchImpl: routed({
      "/api/version": { status: 200, body: JSON.stringify({ ok: true, commit: "abc1234", env: "staging" }) },
      "/api/ready": { status: 200, body: JSON.stringify({ ok: true, db: "ok", migrations: "exact" }) },
      "/commits/staging": { status: 200, body: JSON.stringify({ sha: "abc1234", commit: { message: "x" } }) },
      "/actions/workflows?": {
        status: 200,
        body: JSON.stringify({ workflows: [{ id: 3, path: ".github/workflows/migrate.yml" }] }),
      },
      "/actions/workflows/3/runs": { status: 500, body: "" },
      "/issues?state=open": { status: 200, body: "[]" },
    }),
  });
  assert.equal(code, 0);
  assert.match(logs, /run scan failed/, "the unreadable run list must be named");
  assert.equal(existsSync(join(state, "..", "next.json")), false);
});
