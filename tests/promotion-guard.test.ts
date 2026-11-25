import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/*
 * #244: `protect-main`'s strict "up to date" setting cannot be satisfied by a merge-commit
 * promotion, and the back-merge that used to satisfy it is forbidden by `protect-staging`.
 * The required `promotion-guard` check replaces it: the head must come from `staging`, and the
 * content verdict must prove that merging `main` into the head changes nothing.
 *
 * These are real repositories; the cases differ only in topology, which is what the guard reads.
 */

const TSX = path.resolve("node_modules/.bin/tsx");
const SCRIPT = path.resolve("scripts/promotion-guard.ts");

type Repo = {
  dir: string;
  git: (...args: string[]) => string;
  commit: (name: string, edits: Record<string, string>) => string;
};

function repo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), "solara-guard-"));
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

function guard(
  dir: string,
  env: { head: string; base: string; headRef?: string; headRepo?: string },
) {
  return spawnSync(TSX, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      REPO: "jtanori/solara",
      HEAD_REPO: env.headRepo ?? "jtanori/solara",
      HEAD_REF: env.headRef ?? "staging",
      HEAD_SHA: env.head,
      BASE_SHA: env.base,
    },
  });
}

test("a staging head that already contains main passes as an ancestor", () => {
  const r = repo();
  try {
    const base = r.commit("base", { "a.txt": "0\n" });
    const head = r.commit("work", { "b.txt": "1\n" });
    const result = guard(r.dir, { head, base });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /promotion ok: ancestor/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a staging head whose content already landed under other SHAs passes", () => {
  const r = repo();
  try {
    const root = r.commit("root", { "a.txt": "0\n" });
    const base = r.commit("main change", { "a.txt": "1\n" });
    r.git("switch", "-q", "-c", "staging", root);
    const head = r.commit("staging equivalent", { "a.txt": "1\n", "staging.txt": "s\n" });

    const result = guard(r.dir, { head, base });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /content-contained/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a promotion that would import main's content is refused with the commits", () => {
  const r = repo();
  try {
    const root = r.commit("root", { "a.txt": "0\n" });
    const base = r.commit("hotfix only on main", { "a.txt": "1\n", "hotfix.txt": "x\n" });
    r.git("switch", "-q", "-c", "staging", root);
    const head = r.commit("staging work", { "a.txt": "1\n", "staging.txt": "s\n" });

    const result = guard(r.dir, { head, base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /main carries content/);
    assert.match(result.stderr, /hotfix only on main/);
    assert.match(result.stderr, /do not back-merge/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a conflicting promotion is refused with the paths", () => {
  const r = repo();
  try {
    const root = r.commit("root", { "a.txt": "0\n" });
    const base = r.commit("main edit", { "a.txt": "main\n" });
    r.git("switch", "-q", "-c", "staging", root);
    const head = r.commit("staging edit", { "a.txt": "staging\n" });

    const result = guard(r.dir, { head, base });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conflicts:/);
    assert.match(result.stderr, /a\.txt/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a feature branch cannot promote, even when it is content-contained", () => {
  const r = repo();
  try {
    const base = r.commit("base", { "a.txt": "0\n" });
    const head = r.commit("work", { "b.txt": "1\n" });
    const result = guard(r.dir, { head, base, headRef: "feat/123-thing" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must originate from `staging`/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a fork cannot promote", () => {
  const r = repo();
  try {
    const base = r.commit("base", { "a.txt": "0\n" });
    const head = r.commit("work", { "b.txt": "1\n" });
    const result = guard(r.dir, { head, base, headRepo: "someone-else/solara" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fork/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("an abbreviated or missing sha is a usage error, not a refusal", () => {
  const r = repo();
  try {
    const base = r.commit("base", { "a.txt": "0\n" });
    const result = guard(r.dir, { head: "abc1234", base });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /full 40-character commit sha/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});
