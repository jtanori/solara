import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

/*
 * #236: `gh workflow run --ref <ref> -f sha=<sha>` executes the workflow FILE at <ref> but
 * checks out <sha>, and GitHub does not relate the two. A dispatch from a stale branch
 * therefore runs an old gate against new code: on 2026-11-24 a production migrate executed
 * main@71d7c8d's migrate.yml against 74d5683 and died on a missing PROD_DB_ENDPOINT that
 * staging's file already injected.
 *
 * The workflow cannot detect its own staleness — a check in the file is absent when the file
 * is the stale one — so the dispatch side must refuse. These tests drive db-remote.ts with a
 * fake `gh` whose contents differ per ref, which is the incident's shape.
 */

const REF_HEAD = "a".repeat(40); // commit the dispatch ref resolved to (the stale one)
const TARGET = "b".repeat(40); // commit being migrated
const SAME_BLOB = "3".repeat(40);
const OTHER_BLOB = "4".repeat(40);

function fakeGh(opts: { refBlob: string; targetBlob: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), "solara-parity-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const body = Buffer.from("      mode:\n      dry_run:\n").toString("base64");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
case "$*" in
  *"/commits/main"*) printf '%s\\n' "${REF_HEAD}" ;;
  *"/commits/"*) printf '%s\\n' "${TARGET}" ;;
  *"contents/.github/workflows/migrate.yml?ref=${REF_HEAD}"*)
    if [ -n "\${FAKE_CONTENTS_FAIL:-}" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    printf '{"sha":"%s","content":"%s"}\\n' "${opts.refBlob}" "${body}" ;;
  *"contents/.github/workflows/migrate.yml?ref=${TARGET}"*)
    printf '{"sha":"%s","content":"%s"}\\n' "${opts.targetBlob}" "${body}" ;;
  *) printf '\\n' ;;
esac
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  return dir;
}

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync(
    path.resolve("node_modules/.bin/tsx"),
    ["scripts/db-remote.ts", "--check", "--env", "staging", "--branch", "main", "--sha", TARGET, "--dry-run", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`, ...env },
    },
  );
}

test("a dispatch whose ref carries a different migrate.yml is refused before it runs", () => {
  const dir = fakeGh({ refBlob: OTHER_BLOB, targetBlob: SAME_BLOB });
  try {
    const result = run(dir);
    assert.equal(result.status, 1, `expected refusal, got ${result.status}\n${result.stdout}`);
    assert.match(result.stderr, /refusing to dispatch/);
    assert.match(result.stderr, new RegExp(OTHER_BLOB.slice(0, 7)));
    assert.match(result.stderr, new RegExp(SAME_BLOB.slice(0, 7)));
    assert.doesNotMatch(result.stdout, /would run:/, "nothing may be dispatched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an identical migrate.yml on a different commit is allowed", () => {
  // The commits differ on purpose: the invariant is about the executing FILE, not ancestry.
  const dir = fakeGh({ refBlob: SAME_BLOB, targetBlob: SAME_BLOB });
  try {
    const result = run(dir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /"parity": "match"/);
    assert.match(result.stdout, new RegExp(`-f sha=${TARGET}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable workflow fails closed instead of assuming the ref is fine", () => {
  const dir = fakeGh({ refBlob: SAME_BLOB, targetBlob: SAME_BLOB });
  try {
    const result = run(dir, { FAKE_CONTENTS_FAIL: "1" });
    assert.equal(result.status, 1, `expected refusal, got ${result.status}\n${result.stdout}`);
    assert.match(result.stderr, /cannot read \.github\/workflows\/migrate\.yml/);
    assert.doesNotMatch(result.stdout, /would run:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
