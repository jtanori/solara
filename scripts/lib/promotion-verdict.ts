/**
 * The promotion verdict, shared by `scripts/promotion-ancestry.ts` (CLI, used by `deploy.sh`)
 * and `scripts/promotion-guard.ts` (the required check on PRs into `main`).
 *
 * The question is not ancestry but content: does the head already contain everything the base
 * has? Ancestry is the strictest proof; a three-way merge that changes nothing is the equivalent
 * one. The merge is computed into a throwaway index (`GIT_INDEX_FILE`), so nothing touches the
 * working tree or the real index, and it works on git 2.37 — `merge-tree --write-tree` needs 2.38.
 *
 * Verdicts:
 *   ancestor           base is an ancestor of head
 *   content-contained  merging base into head is conflict-free and produces head's tree
 *   needs-back-merge   the merge would add content from base
 *   conflicted         the merge conflicts (or git could not compute it)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type Verdict = "ancestor" | "content-contained" | "needs-back-merge" | "conflicted";

export type PromotionVerdict = {
  verdict: Verdict;
  /** Paths that conflicted. Empty unless the verdict is `conflicted`. */
  conflicts: string[];
};

/** A bad revision, a shallow clone, or a git failure the caller must not read as a verdict. */
export class PromotionGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionGitError";
  }
}

type GitResult = { status: number; stdout: string };

function git(args: string[], env?: Record<string, string>): GitResult {
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

/** The gate compares exact commits, so an abbreviated or symbolic revision is a usage error. */
export function requireSha(value: string, flag: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new PromotionGitError(
      `${flag} must be a full 40-character commit sha (got "${value}") — the gate compares exact commits`,
    );
  }
  return value;
}

function unmergedPaths(indexFile: string): string[] {
  const listed = git(["ls-files", "-u"], { GIT_INDEX_FILE: indexFile });
  if (listed.status !== 0) return [];
  const paths = listed.stdout
    .split("\n")
    .map(line => line.split("\t")[1])
    .filter((p): p is string => Boolean(p));
  return [...new Set(paths)];
}

export function promotionVerdict(head: string, base: string): PromotionVerdict {
  const ancestor = git(["merge-base", "--is-ancestor", base, head]);
  if (ancestor.status === 0) return { verdict: "ancestor", conflicts: [] };
  if (ancestor.status !== 1) {
    throw new PromotionGitError(
      `git merge-base --is-ancestor exited ${ancestor.status} — are both commits present? (shallow clone?)`,
    );
  }

  const mergeBase = git(["merge-base", head, base]);
  if (mergeBase.status !== 0) {
    // Unrelated histories cannot be promoted on content; the caller refuses, as it would on conflict.
    return { verdict: "conflicted", conflicts: [] };
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "solara-ancestry-"));
  const indexFile = path.join(scratch, "index");
  try {
    const merged = git(["read-tree", "-m", mergeBase.stdout.trim(), head, base], {
      GIT_INDEX_FILE: indexFile,
    });
    if (merged.status !== 0) return { verdict: "conflicted", conflicts: unmergedPaths(indexFile) };

    // Unmerged entries make write-tree fail: that is the conflict signal on every git version.
    const tree = git(["write-tree"], { GIT_INDEX_FILE: indexFile });
    if (tree.status !== 0) return { verdict: "conflicted", conflicts: unmergedPaths(indexFile) };

    const headTree = git(["rev-parse", `${head}^{tree}`]);
    if (headTree.status !== 0) {
      throw new PromotionGitError(`git rev-parse ${head}^{tree} failed — is ${head} a commit?`);
    }
    return {
      verdict: tree.stdout.trim() === headTree.stdout.trim() ? "content-contained" : "needs-back-merge",
      conflicts: [],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Commits on `base` that `head` does not have, for an actionable refusal message. */
export function mainOnlyCommits(head: string, base: string): string[] {
  const log = git(["log", "--oneline", "--no-decorate", `${head}..${base}`]);
  if (log.status !== 0) return [];
  const lines = log.stdout.trim();
  return lines === "" ? [] : lines.split("\n");
}
