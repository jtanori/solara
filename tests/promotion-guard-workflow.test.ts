import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/promotion-guard.yml", "utf8");

test("the guard runs on pull requests into main and checks out the head commit", () => {
  assert.match(workflow, /on:\n  pull_request:\n    branches: \[main\]/);
  // Checking out the merge ref would hide the very gap being decided about.
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /fetch-depth: 0/);
});

test("the guard passes the exact event SHAs and the repository identity", () => {
  assert.match(workflow, /HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
  assert.match(workflow, /HEAD_REPO: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/);
  assert.match(workflow, /run: npx tsx scripts\/promotion-guard\.ts/);
});
