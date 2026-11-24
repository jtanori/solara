import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/*
 * #240: `deploy.sh` refused a promotion unless `main` was an ancestor of the head. After a
 * merge-commit promotion that is never true, and the back-merge that used to fix it can no
 * longer land on staging (required linear history, no bypass actors). The gate therefore
 * decides on content: a trial merge that adds nothing to the head passes.
 *
 * These are real repositories, not source-shape assertions: the four verdicts differ only in
 * commit topology, which is exactly what the helper reads.
 */

const TSX = path.resolve("node_modules/.bin/tsx");
const SCRIPT = path.resolve("scripts/promotion-ancestry.ts");

type Repo = { dir: string; git: (...args: string[]) => string; commit: (name: string, edits: Record<string, string>) => string };

function repo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), "solara-ancestry-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  let n = 0;
  const commit = (name: string, edits: Record<string, string>) => {
    for (const [file, body] of Object.entries(edits)) writeFileSync(path.join(dir, file), body);
    git("add", "-A");
    git("commit", "-q", "-m", `${name} ${++n}`);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

function verdict(dir: string, head: string, base: string) {
  return spawnSync(TSX, [SCRIPT, "--head", head, "--base", base], { cwd: dir, encoding: "utf8" });
}

test("an ancestor base passes without a trial merge", () => {
  const r = repo();
  try {
    const base = r.commit("base", { "a.txt": "0\n" });
    const head = r.commit("head", { "b.txt": "1\n" });
    const result = verdict(r.dir, head, base);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "ancestor");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a promotion whose content already landed under different SHAs is content-contained", () => {
  const r = repo();
  try {
    const base = r.commit("root", { "a.txt": "0\n" });
    // main: the same change with different SHAs (merge/squash equivalence).
    const main = r.commit("main change", { "a.txt": "1\n" });
    // staging starts from the same root and carries the same content plus its own work.
    r.git("switch", "-q", "-c", "staging", base);
    const head = r.commit("staging equivalent", { "a.txt": "1\n", "staging.txt": "s\n" });

    const isAncestor = spawnSync("git", ["merge-base", "--is-ancestor", main, head], { cwd: r.dir });
    assert.equal(isAncestor.status, 1, "the premise is that main is NOT an ancestor of the head");
    const result = verdict(r.dir, head, main);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "content-contained");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a promotion that would import new content needs a back-merge", () => {
  const r = repo();
  try {
    const base = r.commit("root", { "a.txt": "0\n" });
    const main = r.commit("main fix", { "a.txt": "1\n", "hotfix.txt": "only on main\n" });
    r.git("switch", "-q", "-c", "staging", base);
    const head = r.commit("staging work", { "a.txt": "1\n", "staging.txt": "s\n" });

    const result = verdict(r.dir, head, main);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "needs-back-merge");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a conflicting promotion is reported as conflicted, not as stale content", () => {
  const r = repo();
  try {
    const base = r.commit("root", { "a.txt": "0\n" });
    const main = r.commit("main edit", { "a.txt": "main\n" });
    r.git("switch", "-q", "-c", "staging", base);
    const head = r.commit("staging edit", { "a.txt": "staging\n" });

    const result = verdict(r.dir, head, main);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "conflicted");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("an invalid or abbreviated revision is a usage error, not a verdict", () => {
  const r = repo();
  try {
    const head = r.commit("root", { "a.txt": "0\n" });
    const result = verdict(r.dir, head, "abc1234");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /full 40-character commit sha/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
