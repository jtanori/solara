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

test("a promotion is accepted on content, not ancestry, because staging forbids merge commits", () => {
  assert.match(script, /promotion-ancestry\.ts --head "\$HEAD_SHA" --base "\$BASE_SHA"/);
  assert.match(script, /if \[\[ "\$BASE_BRANCH" == "main" && "\$VERDICT" == "conflict-free" \]\]/);
  assert.match(script, /ANCESTRY_VERDICT" == "content-contained"/);
  assert.match(script, /ALLOW_PROMOTION=1/);
  assert.match(script, /if \[\[ "\$ALLOW_PROMOTION" -ne 1 \]\]/, "the refusal is the fallthrough, not the default");
  // The old remedy is impossible under `required_linear_history`; leaving it would send the
  // operator to a command that cannot land.
  assert.doesNotMatch(script, /Only a merge into \$HEAD_REF makes that succeed/);
  assert.match(script, /Re-land those changes on \$HEAD_REF/);
});


test("page-health failures share the rollback and deploy-record path", () => {
  // The gate sets a failure kind instead of exiting inside the success branch, so a
  // rendered-page failure reaches the same decide_rollback/record_deploy path.
  assert.match(script, /DEPLOY_FAILURE="readiness"/);
  assert.match(script, /DEPLOY_FAILURE="page"/);
  assert.match(script, /DEPLOY_FAILURE="auth"/);
  assert.match(script, /FAILED \$DEPLOY_FAILURE/);
  assert.match(script, /deploy_page_class/, "the page probe is classified, not just measured");
  assert.match(script, /deploy_page_ok/, "rollback verification still uses the boolean check");
  assert.match(script, /record_deploy .* "FAILED \$DEPLOY_FAILURE"/);
  assert.match(script, /not executed \(auth\/config\)/, "auth failures record without an automatic rollback");
  assert.match(script, /rollback did not restore readiness and page rendering/);
});

test("the page probe is classified on every attempt and stops on auth", () => {
  // Protection can be enabled mid-rollout. Classifying inside the loop and
  // breaking on "auth" keeps a late 401/403 out of the rollback decision (#212).
  const loop = script.slice(
    script.indexOf('PAGE_STATE=""'),
    script.indexOf('case "$PAGE_STATE" in'),
  );
  assert.match(loop, /for i in \{1\.\.12\}/);
  assert.match(loop, /PAGE_STATE="\$\(deploy_page_class "\$PAGE_CODE" "\$PAGE_TMP"\)"/);
  assert.match(loop, /\[\[ "\$PAGE_STATE" == "ok" \|\| "\$PAGE_STATE" == "auth" \]\] && break/);
  assert.doesNotMatch(loop, /deploy_page_ok/, "the loop must not retry past an auth block");
});
