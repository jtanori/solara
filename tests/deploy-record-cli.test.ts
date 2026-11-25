import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

/*
 * #249: the record is written by a workflow, not by remembering `deploy.sh`. These tests run the
 * real CLI with `--probe-json` (no network) and a stub `gh` on PATH, so they assert what the record
 * actually writes: POST vs PATCH, the deterministic release tag, and that an unverified deployment
 * is never recorded as `ok`.
 */

const TSX = path.resolve("node_modules/.bin/tsx");
const SCRIPT = path.resolve("scripts/deploy-record.ts");
const SHA = "abcdef0123456789abcdef0123456789abcdef01";
const TAG = "deploy/production/abcdef0";

const STUB = `#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [[ "$*" == *"/commits/"*"/pulls"* ]]; then printf '%s' "\${STUB_PR-248}"; exit 0; fi
if [[ "$*" == *"/comments"*"--paginate"* ]]; then
  if [[ "$*" == *"deploy-record-workflow"* ]]; then printf '%s' "\${STUB_WF_COMMENT:-}";
  else printf '%s' "\${STUB_SCRIPT_COMMENT:-}"; fi
  exit 0
fi
if [[ "$1" == "release" && "$2" == "view" ]]; then
  if [[ -n "\${STUB_RELEASE_EXISTS:-}" ]]; then echo release; exit 0; fi
  exit 1
fi
exit 0
`;

type Probe = Record<string, unknown>;

function run(probe: Probe, args: string[] = [], env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deployrec-cli-"));
  try {
    const log = path.join(dir, "gh.log");
    writeFileSync(log, "");
    const gh = path.join(dir, "gh");
    writeFileSync(gh, STUB);
    chmodSync(gh, 0o755);
    const probeFile = path.join(dir, "probe.json");
    writeFileSync(probeFile, JSON.stringify(probe));
    const result = spawnSync(
      TSX,
      [SCRIPT, "--sha", SHA, "--repo", "owner/repo", "--probe-json", probeFile, ...args],
      { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log, ...env } },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const okProbe: Probe = {
  vercel: "success",
  version: { commit: SHA, env: "production" },
  ready: { ok: true, migrations: "exact" },
};

test("a verified deployment creates the release and one record comment", () => {
  const { status, stdout, calls } = run(okProbe, ["--pr", "248"]);
  assert.equal(status, 0, stdout);
  assert.match(calls, new RegExp(`release create ${TAG}`));
  assert.match(calls, new RegExp(`--target ${SHA}`));
  assert.match(calls, /-X POST repos\/owner\/repo\/issues\/248\/comments/);
  assert.match(calls, /Verified by/);
  assert.match(calls, /Migrations: exact/);
});

test("a rerun updates the comment and never duplicates the release", () => {
  const { status, stdout, calls } = run(okProbe, ["--pr", "248"], {
    STUB_WF_COMMENT: "55",
    STUB_RELEASE_EXISTS: "1",
  });
  assert.equal(status, 0, stdout);
  assert.match(calls, /-X PATCH repos\/owner\/repo\/issues\/comments\/55/);
  assert.doesNotMatch(calls, /release create/);
  assert.match(stdout, /already exists/);
});

test("a scripted deploy's record is never overwritten", () => {
  const { status, stdout, calls } = run(okProbe, ["--pr", "248"], { STUB_SCRIPT_COMMENT: "77" });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /already recorded by scripts\/deploy\.sh/);
  assert.doesNotMatch(calls, /-X POST|-X PATCH|release create/);
});

test("an unverified deployment creates an honest release marker, not an ok one", () => {
  const { status, calls } = run(
    { vercel: "success", version: { commit: "0".repeat(40), env: "production" }, ready: { ok: true, migrations: "exact" } },
    ["--pr", "248"],
  );
  assert.equal(status, 0);
  assert.match(calls, new RegExp(`release create ${TAG}`));
  assert.match(calls, /FAILED unverified \(version 0000000\)/);
  assert.doesNotMatch(calls, /Verified by/);
});

test("a deployment Vercel never built creates no release", () => {
  const { status, calls } = run({ vercel: "failure", version: null, ready: null }, ["--pr", "248"]);
  assert.equal(status, 0);
  assert.doesNotMatch(calls, /release create/);
  assert.match(calls, /FAILED not deployed \(Vercel failure\)/);
});

test("a dry run writes nothing", () => {
  const { status, stdout, calls } = run(okProbe, ["--pr", "248", "--dry-run"]);
  assert.equal(status, 0, stdout);
  assert.doesNotMatch(calls, /-X POST|-X PATCH|release create/);
  assert.match(stdout, /"result": "ok"/);
});

test("a merge without an associated PR still gets a release", () => {
  const { status, stdout, calls } = run(okProbe, [], { STUB_PR: "" });
  assert.equal(status, 0);
  assert.match(stdout, /no associated pull request/);
  assert.match(calls, new RegExp(`release create ${TAG}`));
  assert.doesNotMatch(calls, /issues\/.*\/comments/);
});
