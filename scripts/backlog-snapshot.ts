#!/usr/bin/env tsx

/**
 * Offline backlog snapshot (supersedes BACKLOG.md, see ADR 009 and #132).
 *
 * `BACKLOG.md` was a hand-maintained mirror of the GitHub tracker. It drifted: measured on
 * 2026-11-10 it had 11 rows with wrong labels, two open issues missing entirely, and six rows for
 * already-closed issues. Declaring it "an index, not a source of truth" (ADR 002) did not stop that,
 * because nothing forced a refresh.
 *
 * So the file is gone and this generator replaces it. The output is `.gitignore`d, which makes a
 * stale snapshot *impossible to have in the repo* rather than merely discouraged: you generate it
 * before a flight, you read it offline, and it never becomes something a reader mistakes for current.
 *
 * The header is deliberately honest about provenance — timestamp, repo, and the exact query — so a
 * reader can judge freshness instead of assuming it.
 *
 * Usage:
 *   npm run backlog:snapshot            # writes docs/backlog-snapshot.md
 *   npm run backlog:snapshot -- --print # writes to stdout
 *   npm run backlog:snapshot -- --input fixture.json   # offline render from captured `gh` output
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type GhLabel = { name: string };
export type GhMilestone = { title: string } | null;
export type GhIssue = {
  number: number;
  title: string;
  labels: GhLabel[];
  milestone: GhMilestone;
};

export type SnapshotOptions = {
  issues: GhIssue[];
  repo: string;
  generatedAt: string;
  sha?: string;
};

// Anchored to the script location, not the caller's cwd, so running this from a subdirectory
// cannot scatter snapshots around the tree.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT_PATH = path.join(REPO_ROOT, "docs/backlog-snapshot.md");
export const GH_COMMAND =
  "gh issue list --state open --limit 1000 --json number,title,labels,milestone";

const PRIORITY_ORDER = ["priority:p0", "priority:p1", "priority:p2", "priority:p3"];

function labelNames(issue: GhIssue): string[] {
  return (issue.labels ?? []).map(label => label.name).sort();
}

function priorityOf(issue: GhIssue): number {
  const names = labelNames(issue);
  const index = PRIORITY_ORDER.findIndex(p => names.includes(p));
  return index === -1 ? PRIORITY_ORDER.length : index;
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/** Group by milestone, then priority, then issue number — stable output for diffing. */
export function buildSnapshot(options: SnapshotOptions): string {
  const { issues, repo, generatedAt, sha } = options;
  const lines: string[] = [];

  lines.push("# Backlog snapshot");
  lines.push("");
  lines.push("> **Generated file — do not commit, do not edit.** It is `.gitignore`d on purpose:");
  lines.push("> a stale copy must never sit in the repository (ADR 009, #132).");
  lines.push(">");
  lines.push(`> Repository: \`${repo}\``);
  lines.push(`> Generated: **${generatedAt}**${sha ? ` at \`${sha.slice(0, 7)}\`` : ""}`);
  lines.push(`> Source: \`${GH_COMMAND}\``);
  lines.push(">");
  lines.push("> Judge freshness from the timestamp above. GitHub Issues are authoritative; this is a");
  lines.push("> point-in-time rendering and is not checked by CI.");
  lines.push("");

  if (!issues.length) {
    lines.push("**No open issues.** (If you expected some, the query or the token scope is wrong.)");
    lines.push("");
    return lines.join("\n");
  }

  const byMilestone = new Map<string, GhIssue[]>();
  for (const issue of issues) {
    const key = issue.milestone?.title ?? "No milestone";
    const bucket = byMilestone.get(key) ?? [];
    bucket.push(issue);
    byMilestone.set(key, bucket);
  }

  const milestones = [...byMilestone.keys()].sort((a, b) => {
    if (a === "No milestone") return 1;
    if (b === "No milestone") return -1;
    return a.localeCompare(b);
  });

  lines.push(`${issues.length} open issues across ${milestones.length} milestone(s).`);
  lines.push("");

  for (const milestone of milestones) {
    const bucket = byMilestone.get(milestone)!;
    bucket.sort((a, b) => {
      const byPriority = priorityOf(a) - priorityOf(b);
      return byPriority !== 0 ? byPriority : a.number - b.number;
    });

    lines.push(`## ${milestone} (${bucket.length})`);
    lines.push("");
    lines.push("| # | Title | Priority | Status | Labels |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const issue of bucket) {
      const names = labelNames(issue);
      const priority = names.find(name => name.startsWith("priority:")) ?? "—";
      const status = names.find(name => name.startsWith("status:")) ?? "—";
      const rest = names
        .filter(name => !name.startsWith("priority:") && !name.startsWith("status:"))
        .join(" ");
      lines.push(
        `| [#${issue.number}](https://github.com/${repo}/issues/${issue.number}) | ${cell(issue.title)} | ${cell(priority)} | ${cell(status)} | ${cell(rest) || "—"} |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("Regenerate with `npm run backlog:snapshot`. Do not add this file to git.");
  lines.push("");
  return lines.join("\n");
}

/**
 * Reject anything that is not a usable issue row.
 *
 * A malformed row used to render as a normal-looking table line with blank columns — an incomplete
 * snapshot that reads as complete, which is worse than an error because nobody knows to distrust it.
 * An *empty* list stays valid: an empty tracker is a real state, and the snapshot says so explicitly.
 * A missing title or number is not a state; it is a broken payload.
 */
export function validateIssues(parsed: unknown): GhIssue[] {
  if (!Array.isArray(parsed)) {
    throw new Error("gh issue list returned unexpected output (not an array)");
  }
  return parsed.map((row, index) => {
    const at = `issue #${index + 1} of ${parsed.length}`;
    if (typeof row !== "object" || row === null) throw new Error(`${at} is not an object: ${JSON.stringify(row)}`);
    const issue = row as Record<string, unknown>;
    if (!Number.isInteger(issue.number) || (issue.number as number) <= 0) {
      throw new Error(`${at} has no valid "number": ${JSON.stringify(issue.number)}`);
    }
    if (typeof issue.title !== "string" || !issue.title.trim()) {
      throw new Error(`issue #${issue.number} has no usable "title": ${JSON.stringify(issue.title)}`);
    }
    if (!Array.isArray(issue.labels)) {
      throw new Error(`issue #${issue.number} has no "labels" array: ${JSON.stringify(issue.labels)}`);
    }
    for (const label of issue.labels) {
      if (typeof label !== "object" || label === null || typeof (label as { name?: unknown }).name !== "string") {
        throw new Error(`issue #${issue.number} has a label without a name: ${JSON.stringify(label)}`);
      }
    }
    const milestone = issue.milestone;
    if (milestone !== null && milestone !== undefined) {
      if (typeof milestone !== "object" || typeof (milestone as { title?: unknown }).title !== "string") {
        throw new Error(`issue #${issue.number} has an unusable "milestone": ${JSON.stringify(milestone)}`);
      }
    }
    return {
      number: issue.number as number,
      title: issue.title,
      labels: (issue.labels as GhLabel[]).map(label => ({ name: label.name })),
      milestone: (milestone as GhMilestone) ?? null,
    };
  });
}

function readGhIssues(): { issues: GhIssue[]; repo: string } {
  let repo: string;
  try {
    repo = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "gh is not available or not authenticated. Run `gh auth status`, or use --input <file> with captured JSON.",
    );
  }

  let raw: string;
  try {
    raw = execFileSync("gh", [
      "issue", "list", "--state", "open", "--limit", "1000",
      "--json", "number,title,labels,milestone",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`gh issue list failed: ${detail}`);
  }

  return { issues: validateIssues(JSON.parse(raw)), repo };
}

function main() {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes("--print");
  const inputIndex = argv.indexOf("--input");

  let issues: GhIssue[];
  let repo: string;

  if (inputIndex !== -1 && argv[inputIndex + 1]) {
    // Offline render from captured output — also how the test suite exercises this.
    const payload = JSON.parse(readFileSync(path.resolve(argv[inputIndex + 1]), "utf8")) as
      | { issues: GhIssue[]; repo?: string }
      | GhIssue[];
    // Same validation as the live path: a captured payload is exactly as untrusted as `gh`.
    issues = validateIssues(Array.isArray(payload) ? payload : payload.issues);
    repo = Array.isArray(payload) ? "jtanori/solara" : payload.repo ?? "jtanori/solara";
  } else {
    ({ issues, repo } = readGhIssues());
  }

  const sha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return undefined;
    }
  })();

  const snapshot = buildSnapshot({
    issues,
    repo,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    sha,
  });

  if (printOnly) {
    process.stdout.write(snapshot);
    return;
  }

  writeFileSync(OUTPUT_PATH, snapshot);
  console.log(`wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${issues.length} open issues, not tracked by git)`);
}

// Guard so importing this module in tests does not execute main().
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("backlog-snapshot.ts")) {
  try {
    main();
  } catch (error) {
    // Fail loudly. A snapshot that silently rendered an empty table would be worse than none.
    console.error(`backlog:snapshot failed — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
