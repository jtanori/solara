import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const SCRIPT = path.resolve("scripts/run-225-sequence.sh");

/** Dry runs define the whole plan without executing a step, so this needs no database. */
function run(...args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

test("a zero-padded --only still runs exactly that step", () => {
  const result = run("--only", "02", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /== Step 2/);
  assert.equal((result.stdout.match(/== Step /g) ?? []).length, 1, "exactly one step runs");
});

test("--only before --from is refused instead of reporting success", () => {
  const result = run("--only", "2", "--from", "5", "--dry-run");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /nothing would run/);
});

test("--only outside 0-8 is an argument error", () => {
  const result = run("--only", "9", "--dry-run");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /between 0 and 8/);
});

test("--help prints the header and stops before the code", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /run-225-sequence\.sh/);
  assert.doesNotMatch(result.stdout, /set -euo pipefail/);
});
