import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  classifySchemaVerdict,
  classifySchemaVerdictText,
  verdictExitCode,
} from "../src/lib/schema-verdict";

/*
 * #236: migrate.yml read only `ok` from verify.json. A guard or connection failure therefore
 * looked exactly like schema drift, and in verify mode it produced a GREEN run that said
 * "OUT OF SYNC" — the incident's misleading symptom. "Could not inspect" is not information.
 */

test("a matching schema and journal is in-sync", () => {
  const verdict = classifySchemaVerdict({ ok: true, errors: [], pending: [] });
  assert.equal(verdict.state, "in-sync");
  assert.equal(verdictExitCode(verdict.state), 0);
});

test("drift is its own state, not a failure by itself", () => {
  const verdict = classifySchemaVerdict({ ok: false, errors: [], pending: ["0009_x"], missing: [] });
  assert.equal(verdict.state, "drift");
  assert.equal(verdictExitCode(verdict.state), 0);
});

test("a guard or connection error is uninspectable, never drift", () => {
  // db-run folds errors into ok:false; errors[] must win, or a config error reads as drift.
  const verdict = classifySchemaVerdict({
    ok: false,
    errors: ["database_url_endpoint_unset: PROD_DB_ENDPOINT is not set"],
  });
  assert.equal(verdict.state, "uninspectable");
  assert.equal(verdictExitCode(verdict.state), 2);
  assert.match(verdict.reason, /database_url_endpoint_unset/);
});

test("a verdict without a boolean ok is uninspectable", () => {
  for (const raw of [{}, { ok: "true" }, { ok: null }, null, [], "ok"]) {
    assert.equal(classifySchemaVerdict(raw).state, "uninspectable", `raw=${JSON.stringify(raw)}`);
  }
});

test("unparsable JSON is uninspectable", () => {
  assert.equal(classifySchemaVerdictText("not json").state, "uninspectable");
  assert.equal(classifySchemaVerdictText("").state, "uninspectable");
});

test("the CLI exits 2 for an uninspectable verdict and 0 for drift", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "solara-verdict-"));
  const run = (name: string, body: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, body);
    return spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/schema-verdict.ts", file], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
  };
  try {
    const drift = run("drift.json", JSON.stringify({ ok: false, errors: [] }));
    assert.equal(drift.status, 0, drift.stderr);
    assert.match(drift.stdout, /schema_verdict=drift/);

    const broken = run("broken.json", JSON.stringify({ ok: false, errors: ["connection refused"] }));
    assert.equal(broken.status, 2, broken.stderr);
    assert.match(broken.stdout, /schema_verdict=uninspectable/);
    assert.match(broken.stderr, /inspection failed: connection refused/);

    const missing = spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/schema-verdict.ts", path.join(dir, "absent.json")], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(missing.status, 2);
    assert.match(missing.stdout, /schema_verdict=uninspectable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
