import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

// #76's guards are shell decisions. Test the DECISION, not the presence of a line — a presence-only
// test passes when `if [[ "$ENV" == "production" ]]` is mutated to `"never"`, which is exactly the
// defect class docs/CODE_REVIEW.md §5 exists to catch.

const SOURCE = "set -euo pipefail; source scripts/lib/deploy-policy.sh;";

function decide(fn: string, args: string[]): string {
  const script = `${SOURCE} ${fn} ${args.map(a => `'${a}'`).join(" ")}`;
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, `bash failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("decide_skip_migrate: production refuses --skip-migrate in every combination", () => {
  assert.equal(decide("decide_skip_migrate", ["true", "true", "true", "production"]), "refuse-production",
    "even a forced skip is refused for production");
  assert.equal(decide("decide_skip_migrate", ["true", "true", "false", "production"]), "refuse-production");
  assert.equal(decide("decide_skip_migrate", ["false", "true", "true", "production"]), "skip",
    "nothing to apply is not a skip decision");
});

test("decide_skip_migrate: --skip-migrate needs --force everywhere else", () => {
  assert.equal(decide("decide_skip_migrate", ["true", "true", "false", "staging"]), "refuse-force");
  assert.equal(decide("decide_skip_migrate", ["true", "true", "true", "staging"]), "skip-forced");
});

test("decide_skip_migrate: the ordinary paths apply migrations", () => {
  assert.equal(decide("decide_skip_migrate", ["true", "false", "false", "staging"]), "apply");
  assert.equal(decide("decide_skip_migrate", ["true", "false", "false", "production"]), "apply");
  assert.equal(decide("decide_skip_migrate", ["false", "false", "false", "production"]), "skip");
});

test("decide_rollback: automatic only for production, with credentials AND a captured target", () => {
  assert.equal(decide("decide_rollback", ["production", "present", "dpl_ABC"]), "auto");
  assert.equal(decide("decide_rollback", ["production", "absent", "dpl_ABC"]), "manual-no-credentials");
  assert.equal(decide("decide_rollback", ["production", "present", ""]), "manual-no-target");
  assert.equal(decide("decide_rollback", ["production", "absent", ""]), "manual-no-credentials");
});

test("decide_rollback: a staging deploy never triggers the production rollback", () => {
  // Vercel Instant Rollback moves the production alias, and this repo has ONE project shared by
  // staging and production. Rolling back after a failed staging deploy would repoint production at
  // an older build — so staging must never qualify, whatever credentials are present.
  assert.equal(decide("decide_rollback", ["staging", "present", "dpl_ABC"]), "manual-not-production");
  assert.equal(decide("decide_rollback", ["staging", "present", ""]), "manual-not-production");
  assert.equal(decide("decide_rollback", ["staging", "absent", ""]), "manual-not-production");
});

test("deploy.sh routes each decision to a distinct, correct action", () => {
  const script = readFileSync("scripts/deploy.sh", "utf8");
  // Every decision token must have a branch, or a decision could silently fall through to "apply".
  for (const outcome of ["refuse-production", "refuse-force", "skip-forced"]) {
    assert.match(script, new RegExp(`\\n\\s*${outcome}\\)`), `${outcome} is handled`);
  }
  for (const outcome of ["manual-not-production"]) {
    assert.match(script, new RegExp(`\\n\\s*${outcome}\\)`), `${outcome} is handled`);
  }
  // Anchored at the start of the construct: a wrapper such as `case "$(other$(decide_...` must fail.
  assert.match(script, /case "\$\(decide_skip_migrate "\$NEEDS_MIGRATE" "\$SKIP_MIGRATE" "\$FORCE" "\$ENV"\)" in/,
    "the gate's case subject is exactly the tested decision, with the real inputs");
  // Promotion ancestry is enforced by the base-freshness gate's `merge-base --is-ancestor`, which
  // runs before anything else; there is no second promotion decision to keep in sync.
  assert.match(script, /git merge-base --is-ancestor "\$BASE_SHA" "\$HEAD_SHA"/,
    "promotion ancestry is still checked against the real base ref");
  assert.match(script, /ROLLBACK_DECISION=\$\(decide_rollback "\$ENV" "\$ROLLBACK_CREDS" "\$ROLLBACK_TARGET"\)/,
    "the rollback gate receives the environment, so staging can never qualify");
  assert.match(script, /if \[\[ "\$ROLLBACK_DECISION" == "auto" \]\]/,
    "the rollback branch tests the decision variable, not a re-derived condition");
});

test("#76: the preview readiness gate runs before the merge and fails closed", () => {
  const script = readFileSync("scripts/deploy.sh", "utf8");
  const previewGate = script.indexOf("== Gate: preview readiness");
  const merge = script.indexOf('gh pr merge "$PR"');
  assert.ok(previewGate > 0, "the gate exists");
  assert.ok(previewGate < merge, "the preview is probed BEFORE the merge — after it, the code is already live");
  // The gate must call the readiness helper rather than trusting the Vercel status alone.
  assert.match(script, /vercel_preview_ready "\$PREVIEW_BASE"/, "readiness is probed on the resolved preview");
  // "Could not resolve the preview" must abort, not warn.
  assert.match(script, /Cannot verify the preview, so refusing to merge/, "an unresolvable preview fails closed");
});

test("the rollback target is captured before the merge, and the record after readiness", () => {
  const script = readFileSync("scripts/deploy.sh", "utf8");
  const capture = script.indexOf('$(vercel_current_production_deployment');
  const merge = script.indexOf('gh pr merge "$PR"');
  assert.ok(merge > 0, "the merge invocation is found (a comment must not match)");
  assert.ok(capture > 0 && capture < merge, "target captured before merge");
  const successRecord = script.indexOf('record_deploy "$ENV" "$MERGE_SHA" "$PR" "${MIGRATIONS_RECORD:-none}"');
  assert.ok(successRecord > script.indexOf("/api/ready did not become ready"), "record written after the gate");
});
