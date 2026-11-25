/**
 * The branch-policy invariants from ADR 014, as a pure function over the ruleset JSON that
 * `GET /repos/{owner}/{repo}/rulesets/{id}` returns. The CLI (`scripts/check-branch-policy.ts`)
 * fetches and prints; this module is the part a test can pin without a network.
 *
 * The point is drift detection, not documentation: a ruleset change is hosted state, so nothing in
 * git can fail when someone re-enables squash on `main` or turns strict back on. The promotion
 * checklist runs the CLI and records its output in the PR.
 */

export type PolicyRule = { type: string; parameters?: Record<string, unknown> };

export type PolicyRuleset = { name: string; enforcement?: string; rules: PolicyRule[] };

type StatusCheckParameters = {
  strict_required_status_checks_policy?: boolean;
  required_status_checks?: { context?: string }[];
};

type PullRequestParameters = {
  allowed_merge_methods?: string[];
  required_approving_review_count?: number;
  required_review_thread_resolution?: boolean;
};

function rule(ruleset: PolicyRuleset, type: string): PolicyRule | undefined {
  return ruleset.rules.find(candidate => candidate.type === type);
}

function statusParameters(ruleset: PolicyRuleset): StatusCheckParameters {
  return (rule(ruleset, "required_status_checks")?.parameters ?? {}) as StatusCheckParameters;
}

function pullRequestParameters(ruleset: PolicyRuleset): PullRequestParameters {
  return (rule(ruleset, "pull_request")?.parameters ?? {}) as PullRequestParameters;
}

function contexts(ruleset: PolicyRuleset): string[] {
  return (statusParameters(ruleset).required_status_checks ?? []).map(check => check.context ?? "");
}

function sameMethods(actual: string[] | undefined, expected: string[]): boolean {
  if (!actual) return false;
  return [...actual].sort().join(",") === [...expected].sort().join(",");
}

/** Returns one readable problem per invariant that does not hold. Empty means the policy is intact. */
export function policyProblems(rulesets: PolicyRuleset[]): string[] {
  const problems: string[] = [];
  const main = rulesets.find(ruleset => ruleset.name === "protect-main");
  const staging = rulesets.find(ruleset => ruleset.name === "protect-staging");

  if (!main) problems.push("protect-main ruleset is missing");
  if (!staging) problems.push("protect-staging ruleset is missing");

  for (const [name, ruleset] of [["protect-main", main], ["protect-staging", staging]] as const) {
    if (!ruleset) continue;
    if (ruleset.enforcement !== "active") {
      problems.push(`${name}: enforcement is "${ruleset.enforcement ?? "unset"}", expected "active"`);
    }
    for (const required of ["deletion", "non_fast_forward"]) {
      if (!rule(ruleset, required)) problems.push(`${name}: rule "${required}" is missing`);
    }
    if (pullRequestParameters(ruleset).required_approving_review_count !== 0) {
      problems.push(`${name}: required_approving_review_count must be 0 (PR_WORKFLOW §0)`);
    }
  }

  if (main) {
    if (statusParameters(main).strict_required_status_checks_policy !== false) {
      problems.push("protect-main: strict_required_status_checks_policy must be false (ADR 014)");
    }
    for (const context of ["verify", "promotion-guard"]) {
      if (!contexts(main).includes(context)) problems.push(`protect-main: required check "${context}" is missing`);
    }
    if (!sameMethods(pullRequestParameters(main).allowed_merge_methods, ["merge"])) {
      problems.push("protect-main: allowed_merge_methods must be exactly [\"merge\"]");
    }
    if (pullRequestParameters(main).required_review_thread_resolution !== true) {
      problems.push("protect-main: required_review_thread_resolution must be true");
    }
  }

  if (staging) {
    if (statusParameters(staging).strict_required_status_checks_policy !== true) {
      problems.push("protect-staging: strict_required_status_checks_policy must be true");
    }
    if (!contexts(staging).includes("verify")) problems.push("protect-staging: required check \"verify\" is missing");
    if (!sameMethods(pullRequestParameters(staging).allowed_merge_methods, ["squash"])) {
      problems.push("protect-staging: allowed_merge_methods must be exactly [\"squash\"]");
    }
    if (!rule(staging, "required_linear_history")) {
      problems.push("protect-staging: required_linear_history is missing");
    }
  }

  return problems;
}
