import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * #244: the active runbooks described a merge-commit back-merge plus a temporary ruleset change.
 * `protect-staging` forbids the merge commit and has no bypass actors, so the documented remedy
 * could never run. ADR 014 retires it; these assertions keep the dead procedure from returning.
 */

const ACTIVE_RUNBOOKS = [
  "docs/operations/production-bootstrap-2026-11-10.md",
  "docs/operations/promotion-2026-11-10.md",
  "docs/operations/NEXT-STEPS-operator.md",
  "docs/operations/production-deploy-checklist.md",
  "docs/promotion-pr-body.md",
];

test("no active runbook prescribes a main → staging back-merge", () => {
  for (const file of ACTIVE_RUNBOOKS) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /git merge --no-ff origin\/main/, `${file} still ships the back-merge command`);
    assert.doesNotMatch(text, /uncheck \*\*Require linear history\*\*/, `${file} still ships the ruleset toggle`);
  }
});

test("the promotion model has one written source of truth", () => {
  const decisions = readFileSync("docs/decisions.md", "utf8");
  assert.match(decisions, /Operating model in force/);
  assert.match(decisions, /## ADR 014/);
  assert.match(decisions, /promotion-guard/);

  const agents = readFileSync("AGENTS.md", "utf8");
  assert.match(agents, /promotion-guard/);
  assert.match(agents, /check-branch-policy/);
});
