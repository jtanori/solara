#!/usr/bin/env node
/**
 * pr-lint — advisory paperwork check for pull requests.
 *
 * Checks the mechanical invariants of the PR lifecycle (docs/PR_WORKFLOW.md §2):
 *   - title follows Conventional Commits (type(scope): summary)
 *   - a type:* label is present
 *   - a deploy classification label is present (deploy:required / deploy:skip)
 *   - the body has the Linked issue and Evidence sections
 *
 * This job is deliberately ADVISORY: it is not a required status check, and it
 * FAILS OPEN when the GitHub API is unavailable — a paperwork bug or an API
 * hiccup must never be able to block a merge (the catch-22 rule, PR_WORKFLOW
 * §0). Dependabot PRs are exempt upstream via the workflow's `if:`.
 */
import process from "node:process";

const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.REPO;
const TOKEN = process.env.GITHUB_TOKEN;
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

if (!PR_NUMBER || !REPO || !TOKEN) {
  console.log("pr-lint: no pull-request context (skipped)");
  process.exit(0);
}

const TITLE_PATTERN = /^(feat|fix|chore|docs|refactor|test|ci|perf|build|revert|style)(\([^)]+\))?!?: .+/;

async function main() {
  let pull;
  try {
    const response = await fetch(`${API}/repos/${REPO}/pulls/${PR_NUMBER}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok) {
      // Fail open: an unreachable API must not turn this advisory check red.
      console.log(`pr-lint: GitHub API responded ${response.status} — failing open`);
      process.exit(0);
    }
    pull = await response.json();
  } catch (error) {
    console.log(`pr-lint: GitHub API unreachable — failing open (${error instanceof Error ? error.message : String(error)})`);
    process.exit(0);
  }

  const problems = [];

  const title = pull.title ?? "";
  if (!TITLE_PATTERN.test(title)) {
    problems.push(`title "${title}" does not follow Conventional Commits: <type>(<scope>): summary (#issue)`);
  }

  const labels = (pull.labels ?? []).map(label => label.name);
  if (!labels.some(label => label.startsWith("type:"))) {
    problems.push("no type:* label (e.g. type:feature, type:fix, type:chore)");
  }
  if (!labels.includes("deploy:required") && !labels.includes("deploy:skip")) {
    problems.push("no deploy classification label: deploy:required (runtime/build) or deploy:skip (docs/chore only) — see docs/PR_WORKFLOW.md §2.1");
  }

  const body = pull.body ?? "";
  for (const section of ["## Linked issue", "## Evidence"]) {
    if (!body.includes(section)) {
      problems.push(`PR body is missing the "${section}" section`);
    }
  }

  if (problems.length > 0) {
    console.error("pr-lint problems (advisory — does not block merge):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("pr-lint: ok (title, labels, body sections)");
}

main();
