import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// #76 requires a durable, shared deploy record and a release marker per production merge. The
// functions live in scripts/deploy.sh, so the test extracts them verbatim and runs them with a stub
// `gh` on PATH — that exercises the real code path (which API endpoint, POST vs PATCH, tag format)
// instead of asserting that certain strings appear in the file.

function extract(fn: string): string {
  const script = readFileSync("scripts/deploy.sh", "utf8");
  const start = script.indexOf(`${fn}() {`);
  assert.ok(start > 0, `${fn} exists in scripts/deploy.sh`);
  const end = script.indexOf("\n}\n", start);
  assert.ok(end > start, `${fn} is terminated`);
  return script.slice(start, end + 3);
}

const RECORD_VARS = `
SCRIPT_DIR="scripts"
DEPLOY_LOG="${"${DEPLOY_LOG:-docs/deploys.md}"}"
DEPLOY_LOG_HEADER='| when | env | sha | pr | migrations | result | rollback |
| --- | --- | --- | --- | --- | --- | --- |'
DEPLOY_RECORD_COMMENT_MARKER="<!-- deploy-record -->"
`;

function harness(env: Record<string, string>, args: string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deployrec-"));
  try {
    const ghLog = path.join(dir, "gh.calls");
    writeFileSync(ghLog, "");
    const gh = path.join(dir, "gh");
    // Records every invocation, then answers by endpoint. Existing-comment lookup is controlled by
    // STUB_EXISTING_COMMENT so a retry can be distinguished from a first post.
    writeFileSync(gh, `#!/bin/bash
printf '%s\\n' "$*" >> "${ghLog}"
case "$*" in
  *"/comments --paginate"*) [[ -n "\${STUB_EXISTING_COMMENT:-}" ]] && echo "\${STUB_EXISTING_COMMENT}" ;;
  *"-X POST"*"/releases"*) [[ -n "\${STUB_RELEASE_FAIL:-}" ]] && exit 1 ;;
  *"-X POST"*"/comments"*) [[ -n "\${STUB_COMMENT_FAIL:-}" ]] && exit 1 ;;
  *) true ;;
esac
exit 0
`);
    chmodSync(gh, 0o755);
    const script = `set -uo pipefail
${RECORD_VARS}
${extract("deploy_record_comment_id")}
${extract("record_deploy")}
record_deploy "$1" "$2" "$3" "$4" "$5" "$6"
echo "RC=$?"
`;
    const result = spawnSync("bash", ["-c", script, "bash", ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env, DEPLOY_LOG: path.join(dir, "deploys.md") },
    });
    const calls = readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const row = (env: string) => [env, "abcdef0123456789", "133", "skipped", "ok", "—"];

test("a staging record is published to the PR as a shared comment, with no release", () => {
  const { stdout, calls } = harness({}, row("staging"));
  assert.match(stdout, /Deploy record posted to PR #133/);
  assert.match(stdout, /RC=0/, "publishing succeeded");
  // The durable copy is the comment: a local file alone would not answer "what is deployed?".
  const post = calls.find(call => call.includes("-X POST") && call.includes("/issues/133/comments"));
  assert.ok(post, `a PR comment is posted (calls: ${JSON.stringify(calls)})`);
  assert.ok(!calls.some(call => call.includes("/releases")), "staging does not create a release marker");
});

test("a production record creates the release marker #76 requires, tagged per env and SHA", () => {
  const { stdout, calls } = harness({}, row("production"));
  assert.match(stdout, /Release marker created: deploy\/production\/\d{8}-\d{4}-abcdef0/);
  const release = calls.find(call => call.includes("-X POST") && call.includes("/releases"));
  assert.ok(release, "a release is created");
  assert.match(release!, /tag_name=deploy\/production\/\d{8}-\d{4}-abcdef0/, "the tag encodes env, time and short SHA");
  assert.match(release!, /target_commitish=abcdef0123456789/, "the release points at the deployed SHA");
});

test("a retried deploy rewrites the existing comment instead of stacking a second row", () => {
  const { stdout, calls } = harness({ STUB_EXISTING_COMMENT: "555" }, row("staging"));
  assert.match(stdout, /Deploy record updated on PR #133 \(comment 555\)/);
  assert.ok(calls.some(call => call.includes("-X PATCH") && call.includes("/comments/555")), "PATCH on the known comment");
  assert.ok(!calls.some(call => call.includes("-X POST") && call.includes("/comments")), "no duplicate POST");
});

test("when the record cannot be published, the failure is reported rather than swallowed", () => {
  const { stdout, stderr } = harness({ STUB_COMMENT_FAIL: "1" }, row("staging"));
  assert.match(stdout, /RC=1/, "the caller is told publishing failed");
  assert.match(stderr, /could not publish the deploy record/);
  assert.match(stderr, /Record it on the PR by hand/, "the operator is given the row to paste");
});

test("a failed release marker is reported, and the row still points at the right SHA", () => {
  const { stdout, stderr } = harness({ STUB_RELEASE_FAIL: "1" }, row("production"));
  assert.match(stdout, /RC=1/);
  assert.match(stderr, /could not create the release marker deploy\/production\//);
});
