import assert from "node:assert/strict";
import test from "node:test";
import { policyProblems, type PolicyRuleset } from "../scripts/lib/branch-policy";

/*
 * ADR 014's invariants, pinned. A ruleset is hosted state, so a regression (squash re-enabled on
 * main, strict re-enabled on main, linear history removed from staging) cannot fail in git. This
 * fixture is the shape `gh api repos/<owner>/<repo>/rulesets/<id>` returns, trimmed to what the
 * policy reads.
 */

function valid(): PolicyRuleset[] {
  return [
    {
      name: "protect-main",
      enforcement: "active",
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: "verify" }, { context: "promotion-guard" }],
          },
        },
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["merge"],
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
      ],
    },
    {
      name: "protect-staging",
      enforcement: "active",
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [{ context: "verify" }],
          },
        },
        {
          type: "pull_request",
          parameters: {
            allowed_merge_methods: ["squash"],
            required_approving_review_count: 0,
            required_review_thread_resolution: true,
          },
        },
        { type: "required_linear_history" },
      ],
    },
  ];
}

function mainOf(rulesets: PolicyRuleset[]): PolicyRuleset {
  const main = rulesets.find(ruleset => ruleset.name === "protect-main");
  assert.ok(main);
  return main;
}

function stagingOf(rulesets: PolicyRuleset[]): PolicyRuleset {
  const staging = rulesets.find(ruleset => ruleset.name === "protect-staging");
  assert.ok(staging);
  return staging;
}

function statusOf(ruleset: PolicyRuleset): Record<string, unknown> {
  const rule = ruleset.rules.find(candidate => candidate.type === "required_status_checks");
  assert.ok(rule?.parameters);
  return rule.parameters;
}

function pullOf(ruleset: PolicyRuleset): Record<string, unknown> {
  const rule = ruleset.rules.find(candidate => candidate.type === "pull_request");
  assert.ok(rule?.parameters);
  return rule.parameters;
}

test("the documented policy passes", () => {
  assert.deepEqual(policyProblems(valid()), []);
});

test("strict checks on main are drift", () => {
  const rulesets = valid();
  statusOf(mainOf(rulesets)).strict_required_status_checks_policy = true;
  assert.match(policyProblems(rulesets).join("\n"), /protect-main: strict_required_status_checks_policy must be false/);
});

test("squash allowed on main is drift", () => {
  const rulesets = valid();
  pullOf(mainOf(rulesets)).allowed_merge_methods = ["merge", "squash"];
  assert.match(policyProblems(rulesets).join("\n"), /protect-main: allowed_merge_methods must be exactly \["merge"\]/);
});

test("a missing promotion-guard check is drift", () => {
  const rulesets = valid();
  statusOf(mainOf(rulesets)).required_status_checks = [{ context: "verify" }];
  assert.match(policyProblems(rulesets).join("\n"), /protect-main: required check "promotion-guard" is missing/);
});

test("linear history removed from staging is drift", () => {
  const rulesets = valid();
  const staging = stagingOf(rulesets);
  staging.rules = staging.rules.filter(rule => rule.type !== "required_linear_history");
  assert.match(policyProblems(rulesets).join("\n"), /protect-staging: required_linear_history is missing/);
});

test("merge commits allowed on staging are drift", () => {
  const rulesets = valid();
  pullOf(stagingOf(rulesets)).allowed_merge_methods = ["squash", "merge"];
  assert.match(policyProblems(rulesets).join("\n"), /protect-staging: allowed_merge_methods must be exactly \["squash"\]/);
});

test("an approval count is drift on either branch", () => {
  const rulesets = valid();
  pullOf(mainOf(rulesets)).required_approving_review_count = 1;
  pullOf(stagingOf(rulesets)).required_approving_review_count = 1;
  const problems = policyProblems(rulesets).join("\n");
  assert.match(problems, /protect-main: required_approving_review_count must be 0/);
  assert.match(problems, /protect-staging: required_approving_review_count must be 0/);
});

test("an inactive or missing ruleset is drift", () => {
  const rulesets = valid();
  mainOf(rulesets).enforcement = "disabled";
  assert.match(policyProblems(rulesets).join("\n"), /protect-main: enforcement is "disabled"/);
  assert.match(policyProblems(valid().filter(ruleset => ruleset.name !== "protect-staging")).join("\n"),
    /protect-staging ruleset is missing/);
});
