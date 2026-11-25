import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

/*
 * #245: the production gate requires a green `migrate staging pr-<n> <sha>` run for the promotion
 * SHA, and the pull request's SHA is `staging`, not a feature head. `deploy.sh` used to dispatch
 * production without `rehearsal_pr`, so the gate refused before the merge.
 *
 * These run the real helper with a stub `gh`, so they assert the arguments and the ordering, not
 * that certain strings appear in a 600-line script.
 */

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

const STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$1" == "workflow" && "$2" == "run" ]]; then
  [[ -n "\${STUB_RUN_FAIL:-}" ]] && { echo "dispatch failed" >&2; exit 1; }
  exit 0
fi
if [[ "$1" == "run" && "$2" == "list" ]]; then
  # The helper always passes --jq and expects a single id (or nothing).
  [[ -n "\${STUB_NO_RUN:-}" ]] || printf '123'
  exit 0
fi
if [[ "$1" == "run" && "$2" == "watch" ]]; then exit 0; fi
if [[ "$1" == "run" && "$2" == "view" ]]; then echo "\${STUB_CONCLUSION:-success}"; exit 0; fi
exit 0
`;

function dispatch(
  env: string,
  rehearsal: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; calls: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "migrate-dispatch-"));
  try {
    const log = path.join(dir, "gh.log");
    writeFileSync(log, "");
    const gh = path.join(dir, "gh");
    writeFileSync(gh, STUB);
    chmodSync(gh, 0o755);
    const script = `set -uo pipefail
HEAD_REF=staging
MIGRATE_REPO=owner/repo
MIGRATE_POLL_ATTEMPTS=1
MIGRATE_POLL_INTERVAL=0
source scripts/lib/migrate-dispatch.sh
dispatch_migrate ${env} 42 ${SHA} "${rehearsal}"
echo "RC=$?"
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log, STUB_SHA: SHA, STUB_ENV: env, ...extraEnv },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a staging dispatch passes env, pr and the exact sha", () => {
  const { stdout, calls } = dispatch("staging", "");
  assert.match(calls, new RegExp(`workflow run migrate.yml --repo owner/repo --ref staging -f env=staging -f pr=42 -f sha=${SHA}`));
  assert.doesNotMatch(calls, /rehearsal_pr/);
  assert.match(stdout, /RC=0/);
});

test("a production dispatch cites the promotion PR as the rehearsal", () => {
  const { stdout, calls } = dispatch("production", "42");
  assert.match(calls, new RegExp(`-f env=production -f pr=42 -f sha=${SHA} -f rehearsal_pr=42`));
  assert.match(stdout, /RC=0/);
});

test("a failed migrate run is returned to the caller, not swallowed", () => {
  const { stdout, stderr } = dispatch("staging", "", { STUB_CONCLUSION: "failure" });
  assert.match(stdout, /RC=1/);
  assert.match(stderr, /migrate workflow 123 failure/);
});

test("a dispatch that never starts is a failure", () => {
  const { stdout, stderr } = dispatch("staging", "", { STUB_RUN_FAIL: "1" });
  assert.match(stdout, /RC=1/);
  assert.match(stderr, /could not trigger migrate\.yml/);
});

test("a dispatch with no matching run is a failure", () => {
  const { stdout, stderr } = dispatch("staging", "", { STUB_NO_RUN: "1" });
  assert.match(stdout, /RC=1/);
  assert.match(stderr, /no migrate run found/);
});
