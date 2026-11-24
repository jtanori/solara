#!/usr/bin/env tsx
// promotion-ancestry.ts — can a promotion proceed when the base is not an ancestor? (#240)
//
// After a merge-commit promotion, `main` carries a commit `staging` does not have, and
// `deploy.sh` used to require a merge-commit back-merge to restore ancestry (#232). That is no
// longer possible: `protect-staging` requires linear history and has no bypass actors, so a
// merge commit cannot land on `staging`.
//
// The gate's real question is not ancestry but content: does the head already contain
// everything `main` has? Ancestry is the strictest proof; a three-way merge that changes
// nothing is the equivalent one. The merge is computed into a throwaway index
// (`GIT_INDEX_FILE`), so nothing touches the working tree or the real index, and it works on
// git 2.37 — `merge-tree --write-tree` needs 2.38.
//
// Output (one token on stdout, exit 0):
//   ancestor           base is an ancestor of head
//   content-contained  merging base into head is conflict-free and produces head's tree
//   needs-back-merge   the merge would add content from base
//   conflicted         the merge conflicts (or git could not compute it)
// Exit 2 on bad arguments.
//
// Usage: npx tsx scripts/promotion-ancestry.ts --head <sha> --base <sha>

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GIT_FAILURE = 2;

function git(args: string[], env?: Record<string, string>): { status: number; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: (e.stdout ?? "").toString(),
    };
  }
}

function fail(message: string): never {
  console.error(`ERROR ${message}`);
  process.exit(GIT_FAILURE);
}

function rev(flag: string, argv: string[]): string {
  const index = argv.indexOf(flag);
  const value = index === -1 ? "" : (argv[index + 1] ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    fail(`${flag} must be a full 40-character commit sha (got "${value}") — the gate compares exact commits`);
  }
  return value;
}

const argv = process.argv.slice(2);
const head = rev("--head", argv);
const base = rev("--base", argv);

const ancestor = git(["merge-base", "--is-ancestor", base, head]);
if (ancestor.status === 0) {
  console.log("ancestor");
  process.exit(0);
}
if (ancestor.status !== 1) {
  fail(`git merge-base --is-ancestor exited ${ancestor.status} — are both commits present? (shallow clone?)`);
}

const mergeBase = git(["merge-base", head, base]);
if (mergeBase.status !== 0) {
  // Unrelated histories cannot be promoted on content; the caller refuses, as it would on conflict.
  console.log("conflicted");
  process.exit(0);
}

function mergeVerdict(ancestorSha: string): "content-contained" | "needs-back-merge" | "conflicted" {
  const scratch = mkdtempSync(path.join(tmpdir(), "solara-ancestry-"));
  const indexFile = path.join(scratch, "index");
  try {
    const merged = git(["read-tree", "-m", ancestorSha, head, base], { GIT_INDEX_FILE: indexFile });
    if (merged.status !== 0) return "conflicted";
    // Unmerged entries make write-tree fail: that is the conflict signal on every git version.
    const tree = git(["write-tree"], { GIT_INDEX_FILE: indexFile });
    if (tree.status !== 0) return "conflicted";
    const headTree = git(["rev-parse", `${head}^{tree}`]);
    if (headTree.status !== 0) fail(`git rev-parse ${head}^{tree} failed — is ${head} a commit?`);
    return tree.stdout.trim() === headTree.stdout.trim() ? "content-contained" : "needs-back-merge";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(mergeVerdict(mergeBase.stdout.trim()));
