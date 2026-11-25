#!/usr/bin/env tsx
// deploy-record.ts — record a production merge automatically (#249).
//
// `scripts/deploy.sh` records a deploy only when someone runs it. Every promotion merged through
// the GitHub UI lost its record. This CLI is the workflow's body: it verifies that production is
// actually serving the merge commit, then writes the durable record — a release and one PR comment.
//
// `docs/deploys.md` is frozen as of #249; this is the record now.
//
// Usage:
//   npx tsx scripts/deploy-record.ts --sha <40-hex> [--repo owner/repo] [--app-url https://…]
//                                    [--pr <n>] [--probe-json <file>] [--dry-run]
//
// Exit 0 when the record was written (even if the deployment is unverified — it is recorded as
// such), 1 when a write failed, 2 on usage errors.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  commentBody,
  decideRecord,
  releaseBody,
  releaseTag,
  recordRow,
  SCRIPT_MARKER,
  shortSha,
  WORKFLOW_MARKER,
  type Probe,
  type ReadyBody,
  type VerceState,
  type VersionBody,
} from "./lib/deploy-record";

type Options = {
  sha: string;
  repo: string;
  appUrl: string;
  pr: number | null;
  probeJson: string;
  dryRun: boolean;
};

function fail(message: string): never {
  console.error(`ERROR ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const value = (flag: string): string => {
    const index = argv.indexOf(flag);
    return index === -1 ? "" : (argv[index + 1] ?? "");
  };
  const sha = value("--sha").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail("--sha must be a full 40-character commit sha");
  const prText = value("--pr").trim();
  if (prText !== "" && !/^[0-9]+$/.test(prText)) fail("--pr must be numeric");
  return {
    sha,
    repo: value("--repo").trim() || process.env.GITHUB_REPOSITORY || "jtanori/solara",
    appUrl: (value("--app-url").trim() || "https://www.thanatos.mx").replace(/\/+$/, ""),
    pr: prText === "" ? null : Number(prText),
    probeJson: value("--probe-json").trim(),
    dryRun: argv.includes("--dry-run"),
  };
}

type Result = { status: number; stdout: string; stderr: string };

function run(command: string, args: string[]): Result {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function gh(args: string[]): Result {
  return run("gh", args);
}

function deployLogRow(record: Record<string, string>): string {
  const result = run("node", ["scripts/lib/deploy-log.mjs", JSON.stringify(record)]);
  if (result.status !== 0) fail(`could not render the deploy row: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
}

function deployLogHeader(): string {
  const result = run("node", ["scripts/lib/deploy-log.mjs", "--header"]);
  if (result.status !== 0) fail(`could not render the deploy header: ${result.stderr.trim()}`);
  return result.stdout.trimEnd();
}

function resolvePr(repo: string, sha: string): number | null {
  const result = gh(["api", `repos/${repo}/commits/${sha}/pulls`, "--jq", ".[0].number // empty"]);
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return /^[0-9]+$/.test(value) ? Number(value) : null;
}

function findComment(repo: string, pr: number, marker: string): number | null {
  const result = gh([
    "api",
    `repos/${repo}/issues/${pr}/comments`,
    "--paginate",
    "--jq",
    `.[] | select(.body | contains("${marker}")) | .id`,
  ]);
  if (result.status !== 0) return null;
  const value = result.stdout.trim().split("\n")[0] ?? "";
  return /^[0-9]+$/.test(value) ? Number(value) : null;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function probeVercel(repo: string, sha: string): Promise<{ state: VerceState; timedOut: boolean }> {
  let last: VerceState = "pending";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = gh([
      "api",
      `repos/${repo}/commits/${sha}/status`,
      "--jq",
      '[.statuses[] | select(.context == "Vercel")][0].state // "pending"',
    ]);
    if (result.status === 0) {
      const state = result.stdout.trim();
      if (state === "success") return { state: "success", timedOut: false };
      if (state === "failure" || state === "error") return { state, timedOut: false };
      last = "pending";
    }
    await sleep(5_000);
  }
  return { state: last, timedOut: true };
}

async function probeVersion(appUrl: string, sha: string): Promise<{ version: VersionBody | null; timedOut: boolean }> {
  let last: VersionBody | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const body = await getJson(`${appUrl}/api/version`);
    if (body) {
      last = { commit: String(body.commit ?? ""), env: String(body.env ?? "") };
      if (last.commit === sha && last.env === "production") return { version: last, timedOut: false };
    }
    await sleep(5_000);
  }
  return { version: last, timedOut: true };
}

async function probeReady(appUrl: string): Promise<ReadyBody | null> {
  let last: ReadyBody | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const body = await getJson(`${appUrl}/api/ready`);
    if (body) {
      last = { ok: body.ok === true, migrations: String(body.migrations ?? "unknown") };
      if (last.ok) return last;
    }
    await sleep(5_000);
  }
  return last;
}

async function probe(options: Options): Promise<Probe> {
  if (options.probeJson) {
    return JSON.parse(readFileSync(options.probeJson, "utf8")) as Probe;
  }
  const vercel = await probeVercel(options.repo, options.sha);
  if (vercel.state !== "success") {
    return { vercel: vercel.state, version: null, ready: null, timedOut: vercel.timedOut ? "vercel" : null };
  }
  const version = await probeVersion(options.appUrl, options.sha);
  const ready = version.version?.commit === options.sha ? await probeReady(options.appUrl) : null;
  return {
    vercel: "success",
    version: version.version,
    ready,
    timedOut: version.timedOut ? "version" : null,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pr = options.pr ?? resolvePr(options.repo, options.sha);

  if (pr !== null && findComment(options.repo, pr, SCRIPT_MARKER) !== null) {
    console.log(`already recorded by scripts/deploy.sh on PR #${pr}; nothing to do`);
    return;
  }

  const probeResult = await probe(options);
  const decision = decideRecord(options.sha, probeResult);
  const timestamp = `${new Date().toISOString().slice(0, 16)}Z`;
  const record = recordRow({ sha: options.sha, pr, timestamp, decision });
  const row = deployLogRow(record);
  const header = deployLogHeader();
  const tag = decision.releaseEligible ? releaseTag(options.sha) : null;
  const body = commentBody({ header, row, decision, tag });

  if (options.dryRun) {
    console.log(JSON.stringify({ sha: options.sha, pr, decision, tag, body }, null, 2));
    return;
  }

  let createdTag: string | null = null;
  if (decision.releaseEligible && tag) {
    const exists = gh(["release", "view", tag, "--repo", options.repo]).status === 0;
    if (exists) {
      createdTag = tag;
      console.log(`release ${tag} already exists`);
    } else {
      const notes = releaseBody({ sha: options.sha, pr, timestamp, decision });
      const created = gh([
        "release",
        "create",
        tag,
        "--repo",
        options.repo,
        "--target",
        options.sha,
        "--title",
        tag,
        "--notes",
        notes,
      ]);
      if (created.status !== 0) {
        console.error(`ERROR could not create release ${tag}: ${created.stderr.trim()}`);
        process.exit(1);
      }
      createdTag = tag;
      console.log(`release ${tag} created`);
    }
  }

  if (pr !== null) {
    const existing = findComment(options.repo, pr, WORKFLOW_MARKER);
    const comment = commentBody({ header, row, decision, tag: createdTag });
    const written = existing !== null
      ? gh(["api", "-X", "PATCH", `repos/${options.repo}/issues/comments/${existing}`, "-f", `body=${comment}`])
      : gh(["api", "-X", "POST", `repos/${options.repo}/issues/${pr}/comments`, "-f", `body=${comment}`]);
    if (written.status !== 0) {
      console.error(`ERROR could not write the deploy record on PR #${pr}: ${written.stderr.trim()}`);
      process.exit(1);
    }
    console.log(`deploy record ${existing !== null ? "updated" : "posted"} on PR #${pr}`);
  } else {
    console.log("no associated pull request; release recorded without a PR comment");
  }

  if (!decision.ok) {
    console.log(`::warning::deploy record for ${shortSha(options.sha)} is ${decision.result} — the deploy is unaffected`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(
      summary,
      `### Deploy record\n\n${header}\n${row}\n\n${decision.result} (migrations: ${decision.migrations})\n`,
    );
  }
  console.log(`recorded ${shortSha(options.sha)}: ${decision.result} (migrations: ${decision.migrations})`);
}

main().catch(error => {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
