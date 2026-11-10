import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const script = readFileSync(path.resolve("scripts/deploy.sh"), "utf8");

test("deploy gate verifies the reviewed SHA, not the branch tip", () => {
  assert.match(script, /db-remote\.ts --check --env "\$WORKFLOW_ENV" --branch "\$HEAD_REF" --sha "\$HEAD_SHA"/);
  assert.match(script, /headRefOid/);
  assert.match(script, /--match-head-commit "\$HEAD_SHA"/);
});

test("deploy waits for Vercel status on the exact merge SHA", () => {
  assert.match(script, /wait_for_vercel_status/);
  assert.match(script, /mergeCommit/);
  assert.match(script, /VERCEL_STATUS_CONTEXT/);
});

test("deploy readiness sends the Vercel bypass and fails closed", () => {
  // The bypass header lives in the shared helper so it is applied in exactly one place; the deploy
  // script must route every readiness probe through it.
  const helper = readFileSync(path.resolve("scripts/lib/vercel-rollback.sh"), "utf8");
  assert.match(helper, /x-vercel-protection-bypass/);
  assert.match(helper, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.match(script, /ready_curl\(\) \{ deploy_ready_curl/, "readiness goes through the helper");
  assert.match(script, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.match(script, /\/api\/ready/);
  assert.match(script, /HTTP \$READY_CODE|last HTTP \$READY_CODE/);
  assert.match(script, /exit 1/);
});

test("post-merge readiness does not downgrade failures to a warning", () => {
  assert.doesNotMatch(script, /WARN: .*api\/health/);
  assert.match(script, /did not become ready/);
});

