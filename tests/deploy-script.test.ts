import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const script = readFileSync(path.resolve("scripts/deploy.sh"), "utf8");

test("deploy gate verifies the reviewed ref, not the checked-out branch", () => {
  assert.match(script, /db-remote\.ts --check --env "\$WORKFLOW_ENV" --branch "\$HEAD_REF"/);
});

test("deploy readiness sends the Vercel bypass and fails closed", () => {
  assert.match(script, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.match(script, /x-vercel-protection-bypass/);
  assert.match(script, /\/api\/ready/);
  assert.match(script, /HTTP \$READY_CODE/);
  assert.match(script, /exit 1/);
});

test("post-merge readiness does not downgrade failures to a warning", () => {
  assert.doesNotMatch(script, /WARN: .*api\/health/);
  assert.match(script, /did not become ready/);
});
