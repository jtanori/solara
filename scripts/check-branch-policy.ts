#!/usr/bin/env tsx
// check-branch-policy.ts — read-only assertion of the branch-policy invariants (ADR 014).
//
// Rulesets are hosted state: git cannot show that someone re-enabled squash on `main` or turned
// strict back on. Run this before a promotion and paste the output in the PR:
//
//   npx tsx scripts/check-branch-policy.ts
//   GH_REPO=owner/repo npx tsx scripts/check-branch-policy.ts
//
// Exit 0 = no drift, 1 = drift (printed), 2 = could not read the rulesets.

import { execFileSync } from "node:child_process";
import { policyProblems, type PolicyRuleset } from "./lib/branch-policy";

const repo = process.env.GH_REPO ?? "jtanori/solara";

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

type RuleSetSummary = { id: number; name: string };

let summaries: RuleSetSummary[];
try {
  summaries = JSON.parse(gh(["api", `repos/${repo}/rulesets`, "--paginate"])) as RuleSetSummary[];
} catch (err) {
  console.error(`ERROR could not list rulesets for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}

const rulesets: PolicyRuleset[] = [];
for (const name of ["protect-main", "protect-staging"]) {
  const summary = summaries.find(candidate => candidate.name === name);
  if (!summary) continue;
  try {
    rulesets.push(JSON.parse(gh(["api", `repos/${repo}/rulesets/${summary.id}`])) as PolicyRuleset);
  } catch (err) {
    console.error(`ERROR could not read ruleset ${name} (${summary.id}): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

const problems = policyProblems(rulesets);
if (problems.length === 0) {
  console.log(`branch policy ok: ${repo} (protect-main, protect-staging)`);
  process.exit(0);
}

console.error(`branch policy drift in ${repo}:`);
for (const problem of problems) console.error(`  - ${problem}`);
process.exit(1);
