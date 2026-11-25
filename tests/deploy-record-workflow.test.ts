import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/deploy-record.yml", "utf8");

test("the recorder runs on merges to main and can backfill a commit", () => {
  assert.match(workflow, /on:\n  push:\n    branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /sha:/);
  assert.match(workflow, /github\.event\.inputs\.sha \|\| github\.sha/, "a dispatch can name an older commit");
});

test("it has exactly the permissions the record needs", () => {
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
});

test("it is bookkeeping, not a second deploy gate", () => {
  assert.doesNotMatch(workflow, /^ {2}environment:/m, "no environment gate on the record job");
  assert.match(workflow, /timeout-minutes: 25/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("it records the current branch's tooling against the exact merge SHA", () => {
  // The recorded SHA is data. A backfill predates this workflow, so checking that commit out would
  // run old tooling (or none at all).
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.inputs\.sha/);
  assert.match(workflow, /run: npx tsx scripts\/deploy-record\.ts --sha "\$SHA" --repo "\$REPO" --app-url "\$APP_URL"/);
  assert.match(workflow, /APP_URL: https:\/\/www\.thanatos\.mx/);
});
