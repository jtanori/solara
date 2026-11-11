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

test("the runbooks do not describe behaviour deploy.sh does not have", () => {
  // A runbook that promises an allowance the script refuses is worse than a missing runbook: the
  // operator follows it, the deploy aborts, and the docs are then the thing they stop trusting.
  const script = readFileSync("scripts/deploy.sh", "utf8");
  const bootstrap = readFileSync("docs/operations/production-bootstrap-2026-11-10.md", "utf8");
  const checklist = readFileSync("docs/operations/production-deploy-checklist.md", "utf8");
  const promotion = readFileSync("docs/operations/promotion-2026-11-10.md", "utf8");

  // 1. Never cite a helper that does not exist.
  for (const doc of [bootstrap, checklist, promotion]) {
    for (const [, fn] of doc.matchAll(/\b(decide_[a-z_]+)\b/g)) {
      assert.ok(
        new RegExp(`^${fn}\\(\\)`, "m").test(readFileSync("scripts/lib/deploy-policy.sh", "utf8")),
        `${fn} is referenced by a runbook but is not implemented in deploy-policy.sh`,
      );
    }
  }

  // 2. No documented "squash is allowed" route: the base-freshness gate exits unconditionally, and
  //    the staging ruleset's strict required checks keep the PR BEHIND regardless.
  for (const doc of [bootstrap, checklist, promotion]) {
    assert.ok(
      !/squash/i.test(doc) || !/(ancestry is satisfied|allows? (the|this) promotion|allowed, with a warning)/i.test(doc),
      "a runbook must not claim a squash satisfies the ancestry gate",
    );
  }

  // 3. The gate itself still has no override path on the promotion branch.
  const gate = script.slice(script.indexOf("== Gate: base freshness =="), script.indexOf("== Gate: preview readiness"));
  assert.match(gate, /ERROR: refusing to deploy a \$VERDICT stale PR/);
  assert.ok(!/--force|ALLOW_STALE|SKIP_FRESH/i.test(gate), "there is no override flag for base freshness");
});

test("no runbook ships a fenced command with an unfilled placeholder", () => {
  // A fenced "command" containing `...` or a bare `<...>` is not runnable. In a runbook that changes
  // a branch ruleset, the operator's fallback is to fill it in by guesswork — against the rule that
  // enforces ancestry. Prose may use placeholders; fenced commands must be exact or absent.
  const docs = [
    "docs/operations/production-bootstrap-2026-11-10.md",
    "docs/operations/production-deploy-checklist.md",
    "docs/operations/promotion-2026-11-10.md",
  ];
  // `<that-pr-number>` / `<back-merge-pr>` style args are fine: they name ONE value the operator
  // supplies, and the surrounding text says which. A bare ellipsis is a hole in the command itself.
  const offenders: string[] = [];
  for (const doc of docs) {
    const text = readFileSync(doc, "utf8");
    for (const [index, block] of [...text.matchAll(/```bash\n([\s\S]*?)```/g)].entries()) {
      const body = block[1];
      // Ignore comments: they legitimately carry abbreviated forms like origin/main...origin/staging
      // (a git range), which is not a placeholder.
      const commands = body
        .split("\n")
        .filter(line => line.trim() && !line.trim().startsWith("#"))
        .join("\n")
        .replace(/origin\/main\.\.\.origin\/staging/g, "")
        .replace(/\$BASE_SHA\.\.\.\$HEAD_SHA/g, "");
      if (/(^|\s)\.\.\.(\s|$)/.test(commands)) {
        offenders.push(`${doc} block ${index + 1}: ${commands.split("\n")[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a fenced command must be runnable, not a sketch");
});

test("a runbook that shows expected output does not promise the wrong shape", () => {
  // `gh` pretty-prints JSON to a TTY and compacts it when piped (verified with `script -qec`). A doc
  // that shows the compact form as *the* output is wrong for anyone reading it in a terminal, which
  // is how runbooks are read. Either present the value abstractly, or say outright that both forms
  // mean the same thing.
  const bootstrap = readFileSync("docs/operations/production-bootstrap-2026-11-10.md", "utf8");
  // Scan EVERY fence, not just bash: the output of a --jq command is usually shown in a separate
  // json block, and a check that only reads the command's own fence misses it entirely.
  const commands = [...bootstrap.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]);
  const hasJqApi = commands.some(
    body => body.split("\n").some(line => !line.trim().startsWith("#") && line.includes("gh api")) && body.includes("--jq"),
  );
  const fences = [...bootstrap.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]);
  const showsCompactArray = fences.some(body => /^\s*\[".*"\]\s*$/m.test(body.split("\n").find(l => l.trim().startsWith('["')) ?? ""));
  if (hasJqApi && showsCompactArray) {
    assert.match(
      bootstrap,
      /pretty-print|one rule per line|both forms|when piped/i,
      "a --jq command with an exact JSON array as expected output must say that gh pretty-prints to a TTY and compacts when piped",
    );
  }

  // And no runbook may tell the operator to paste a JSON array back into a shell.
  const jsonBlocks = [...bootstrap.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1]);
  for (const json of jsonBlocks) {
    if (!json.trim().startsWith("[")) continue;
    assert.ok(
      /do not paste|glob pattern|no matches found/i.test(bootstrap),
      "an expected JSON array must warn that an unquoted [...] is a shell glob",
    );
  }
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
