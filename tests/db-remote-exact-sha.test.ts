import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sha = "0123456789abcdef0123456789abcdef01234567";

function fakeGh() {
  const dir = mkdtempSync(path.join(tmpdir(), "solara-db-remote-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const workflow = Buffer.from("      mode:\n      dry_run:\n").toString("base64");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
case "$*" in
  *"/commits/${sha}"*) printf '%s\\n' "${sha}" ;;
  *"/contents/.github/workflows/migrate.yml"*) printf '%s\\n' "${workflow}" ;;
  *) printf '\\n' ;;
esac
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  return dir;
}

function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(path.resolve("node_modules/.bin/tsx"), ["scripts/db-remote.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
}

test("db-remote --check accepts an exact SHA and dispatches that SHA", () => {
  const dir = fakeGh();
  try {
    const result = run(
      ["--check", "--env", "staging", "--branch", "staging", "--sha", sha, "--dry-run", "--json"],
      { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}` },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`"sha": "${sha}"`));
    assert.match(result.stdout, new RegExp(`-f sha=${sha}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db-remote rejects --sha without --check", () => {
  const result = run(["--pr", "1", "--sha", sha]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--sha is only valid with --check/);
});

test("db-remote rejects an abbreviated --sha", () => {
  const result = run(["--check", "--env", "staging", "--branch", "staging", "--sha", "abc"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected a full 40-character sha/);
});
