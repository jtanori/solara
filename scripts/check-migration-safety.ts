import { readFileSync } from "node:fs";
import { BREAKING_LABEL, decide, type MigrationInput } from "../src/lib/migration-safety";

/*
 * Blocking destructive-DDL gate (#166).
 *
 * Runs inside `verify` for pull requests. The PR metadata and file list are read
 * from the GitHub API at run time; the label is never taken from the cached
 * event payload. No provider, database or deployment access.
 */

const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.REPO ?? process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

type PullFile = { filename: string; status: string };
type Pull = { head?: { ref?: string }; labels?: Array<{ name?: string }> };

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path.split("?")[0]}`);
  return response.json() as Promise<T>;
}

async function files(pr: string): Promise<PullFile[]> {
  const all: PullFile[] = [];
  for (let page = 1; ; page += 1) {
    const batch = await api<PullFile[]>(`/repos/${REPO}/pulls/${pr}/files?per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

async function main() {
  if (!PR_NUMBER || !REPO || !TOKEN) {
    console.log("migration-safety: no pull-request context (skipped)");
    return;
  }

  const pull = await api<Pull>(`/repos/${REPO}/pulls/${PR_NUMBER}`);
  const changed = await files(PR_NUMBER);
  const migrations = changed.filter(file => file.filename.startsWith("drizzle/") && file.filename.endsWith(".sql"));
  if (migrations.length === 0) {
    console.log("migration-safety: no drizzle/ migration changes");
    return;
  }

  const inputs: MigrationInput[] = migrations.map(file => ({
    filename: file.filename,
    status: file.status,
    content: file.status === "added" || file.status === "copied" ? readFileSync(file.filename, "utf8") : null,
  }));
  const labels = (pull.labels ?? []).map(label => label.name ?? "");
  const decision = decide(inputs, labels, pull.head?.ref ?? "");

  if (decision.status === "hotfix") {
    for (const violation of decision.violations) {
      console.error(`::error file=${violation.file}::${violation.kind}: ${violation.detail}`);
    }
    console.error("::error::hotfix/* branches cannot change drizzle/; no label overrides this");
    process.exitCode = 1;
    return;
  }

  if (decision.status === "blocked") {
    for (const violation of decision.violations) {
      console.error(`::error file=${violation.file}::${violation.kind}: ${violation.detail}`);
    }
    console.error(`::error::breaking migration detected; add ${BREAKING_LABEL} only after review`);
    process.exitCode = 1;
    return;
  }

  if (decision.status === "override") {
    console.log(`::warning::${BREAKING_LABEL} allows ${decision.violations.length} destructive operation(s)`);
    return;
  }

  console.log(`migration-safety: ${decision.status}`);
}

void main().catch(error => {
  console.error(`::error::migration-safety could not complete: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
