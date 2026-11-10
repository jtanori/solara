#!/usr/bin/env tsx
// db-remote.ts — drive .github/workflows/migrate.yml from a workstation.
//
// The database credentials live in GitHub Environment secrets (`staging`, `production`)
// and are never exposed to a local process — GitHub does not allow reading a secret back,
// only writing it. So the supported way to migrate from a laptop is to *dispatch the
// workflow* and read its verdict. This tool replaces `gh workflow run` + hand-rolled
// polling (which deploy.sh still does inline) with one command that:
//
//   1. resolves the PR → head SHA, base branch and environment (and refuses a mismatch)
//   2. prints the pending migrations from the LOCAL drizzle/ so you see the plan first
//   3. dispatches migrate.yml against the PR head SHA (so the PR's drizzle/ is used)
//   4. finds that exact run (run-name carries env + pr + sha), waits, and reports
//   5. re-runs the read-only `verify` job's result — a green run means schema + journal match
//
// Nothing here needs a database password. Everything it asserts comes from the workflow's
// exit code and the guard script that runs inside it.
//
// Usage:
//   tsx scripts/db-remote.ts --pr 97                    # env from PR base branch
//   tsx scripts/db-remote.ts --pr 97 --env staging
//   tsx scripts/db-remote.ts --pr 97 --dry-run          # plan only, no dispatch
//   tsx scripts/db-remote.ts --check --env staging      # is the staging DB in sync? (dispatch dry-run job)
//   tsx scripts/db-remote.ts --check --env staging --sha <full-sha> --branch <ref>
//   tsx scripts/db-remote.ts --pr 97 --json
//
// Exit codes: 0 success · 1 the run failed / out of sync · 2 bad usage

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = process.env.SOLARA_REPO ?? "jtanori/solara";
const WORKFLOW = "migrate.yml";

type Env = "staging" | "production";

function gh(args: string[], opts: { json?: boolean } = {}): string {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    const e = err as { stderr?: Buffer | string; status?: number };
    const msg = (e.stderr ?? "").toString().trim() || String(err);
    throw new Error(`gh ${args[0]} failed: ${msg}`);
  }
}

function ghApiJson<T>(args: string[], fields?: string): T {
  const full = fields ? [...args, "--json", fields] : args;
  return JSON.parse(execFileSync("gh", full, { encoding: "utf8" })) as T;
}

function usage() {
  console.log(`Usage: tsx scripts/db-remote.ts [--pr <n> | --check] [--env staging|production]
                                   [--sha <full-sha>] [--dry-run] [--skip-wait] [--timeout <sec>] [--json]

Dispatches .github/workflows/migrate.yml, which reads the DATABASE_URL secret from the
GitHub Environment for the target. No local database credential is required or read.

  --pr <n>        PR whose head SHA is checked out for the migration (normal path)
  --check         no migration: dispatch in verify-only mode against the current branch head
  --sha <sha>     exact 40-char commit to check (only with --check)

  --env <name>    staging | production (default: inferred from the PR base branch)
  --dry-run       print the plan and the exact workflow_dispatch payload, then exit
  --skip-wait     dispatch and return the run URL without waiting
  --timeout <s>   max seconds to wait for the run (default 900)
  --json          machine-readable result
  --branch <name> ref to dispatch against (default: current branch if it carries this workflow, else the env branch)

There is no second reviewer in this repository, so production is gated by the workflow
itself: an explicit --rehearsal-pr, a full commit sha, and a green "migrate staging pr-<n>"
run for that PR. All three must hold or no DDL runs.`);
}

// ------------------------------------------------------------------ arguments
type Opts = {
  pr: string; env: string; check: boolean; dryRun: boolean; skipWait: boolean;
  timeout: number; json: boolean; branch: string; sha: string; rehearsalPr: string;
};

function missingValue(flag: string): never {
  console.error(`ERROR ${flag} requires a non-empty value`);
  usage();
  process.exit(2);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]?.trim() ?? "";
  if (!value || value.startsWith("--")) missingValue(flag);
  return value;
}

function requireInlineValue(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!trimmed) missingValue(flag);
  return trimmed;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = { pr: "", env: "", check: false, dryRun: false, skipWait: false, timeout: 900, json: false, branch: "", sha: "", rehearsalPr: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pr") o.pr = argv[++i] ?? "";
    else if (a.startsWith("--pr=")) o.pr = a.slice(5);
    else if (a === "--env") o.env = argv[++i] ?? "";
    else if (a.startsWith("--env=")) o.env = a.slice(6);
    else if (a === "--check") o.check = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--skip-wait") o.skipWait = true;
    else if (a === "--timeout") o.timeout = Number(argv[++i] ?? 900);
    else if (a === "--json") o.json = true;
    else if (a === "--branch") o.branch = argv[++i] ?? "";
    else if (a === "--sha") o.sha = requireValue(argv, ++i, "--sha");
    else if (a.startsWith("--sha=")) o.sha = requireInlineValue(a.slice(6), "--sha");
    else if (a === "--rehearsal-pr") o.rehearsalPr = argv[++i] ?? "";
    else if (a.startsWith("--rehearsal-pr=")) o.rehearsalPr = a.slice(15);
    else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    else { console.error(`ERROR unknown argument "${a}"`); usage(); process.exit(2); }
  }
  return o;
}

// ------------------------------------------------------------------ local plan
type JournalEntry = { idx: number; tag: string };

function localPlan(): { entries: JournalEntry[]; tags: string[] } {
  const file = path.resolve(process.cwd(), "drizzle/meta/_journal.json");
  if (!existsSync(file)) throw new Error(`drizzle/meta/_journal.json not found in ${process.cwd()} — run from the repo root`);
  const { entries = [] } = JSON.parse(readFileSync(file, "utf8")) as { entries?: JournalEntry[] };
  return { entries, tags: entries.map(e => e.tag) };
}

function currentBranch(): string {
  // Prefer the upstream branch name: a local branch can be pushed under a different name,
  // and workflow_dispatch --ref must match a ref that actually exists on the remote.
  try {
    const up = execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (up.startsWith("origin/")) return up.slice("origin/".length);
  } catch {
    /* no upstream configured */
  }
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function fullSha(sha: string): string {
  const s = sha.trim();
  if (!/^[0-9a-f]{40}$/.test(s)) {
    throw new Error(`expected a full 40-character sha, got "${s}" — the production gate compares exact commits, so abbreviations are not accepted`);
  }
  return s;
}

function refExists(ref: string): boolean {
  try {
    gh(["api", `repos/${REPO}/commits/${ref}`, "--jq", ".sha"]);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ resolve target
type Target = { env: Env; sha: string; ref: string; pr: string; base: string };

function resolveTarget(o: Opts): Target {
  if (o.check) {
    const env = (o.env || "staging") as Env;
    if (env !== "staging" && env !== "production") throw new Error(`--env must be staging or production (got "${env}")`);
    // Prefer the branch you are on (it carries this tooling); fall back to the env's branch.
    const here = currentBranch();
    const envRef = env === "staging" ? "staging" : "main";
    const ref = o.branch || (here && refExists(here) && workflowCaps(here).mode ? here : envRef);
    const sha = o.sha
      ? fullSha(o.sha)
      : fullSha(gh(["api", `repos/${REPO}/commits/${ref}`, "--jq", ".sha"]));
    if (o.sha) {
      const resolved = fullSha(gh(["api", `repos/${REPO}/commits/${sha}`, "--jq", ".sha"]));
      if (resolved !== sha) throw new Error(`--sha ${sha} did not resolve to itself (got ${resolved})`);
    }
    return { env, sha, ref, pr: "0", base: ref };
  }

  if (o.sha) throw new Error("--sha is only valid with --check; use --pr for a PR migration");
  if (!o.pr) throw new Error("--pr <number> or --check is required");
  if (!/^[0-9]+$/.test(o.pr)) throw new Error(`--pr must be numeric (got "${o.pr}")`);

  const pr = ghApiJson<{ baseRefName: string; headRefOid: string; headRefName: string; state: string; mergedAt: string | null }>(
    ["pr", "view", o.pr, "--repo", REPO],
    "baseRefName,headRefOid,headRefName,state,mergedAt",
  );

  const inferred: Env = pr.baseRefName === "main" ? "production" : "staging";
  const env = (o.env || inferred) as Env;

  if (env !== "staging" && env !== "production") throw new Error(`--env must be staging or production (got "${env}")`);

  // the same guard deploy.sh applies: a PR can only ever migrate the environment it merges into
  if (pr.baseRefName === "staging" && env !== "staging") {
    throw new Error(`PR #${o.pr} targets staging but --env ${env} was requested — refusing (would migrate the wrong database)`);
  }
  if (pr.baseRefName === "main" && env !== "production") {
    throw new Error(`PR #${o.pr} targets main but --env ${env} was requested — use --env production`);
  }
  if (pr.mergedAt) throw new Error(`PR #${o.pr} was merged at ${pr.mergedAt}; migrations run before the merge`);
  if (pr.state !== "OPEN") throw new Error(`PR #${o.pr} is ${pr.state}; expected OPEN`);

  return { env, sha: fullSha(pr.headRefOid), ref: pr.headRefName, pr: o.pr, base: pr.baseRefName };
}

// ------------------------------------------------------------------ workflow capability probe
// `gh workflow run` dispatches the workflow file that exists on <ref>. A ref without the
// mode/dry_run inputs rejects them with HTTP 422 "Unexpected inputs provided", so probe first
// and degrade to the legacy input set instead of failing opaquely.
type Caps = { mode: boolean; dryRun: boolean };

function workflowCaps(ref: string): Caps {
  try {
    const b64 = gh(["api", `repos/${REPO}/contents/.github/workflows/${WORKFLOW}?ref=${ref}`, "--jq", ".content"]);
    const body = Buffer.from(b64.replace(/\n/g, ""), "base64").toString("utf8");
    return { mode: /^\s{6}mode:/m.test(body), dryRun: /^\s{6}dry_run:/m.test(body) };
  } catch {
    // cannot read the file (permissions/offline) — assume modern and let dispatch speak
    return { mode: true, dryRun: true };
  }
}

// ------------------------------------------------------------------ dispatch + watch
type Run = { databaseId: number; displayTitle: string; status: string; conclusion: string | null; createdAt: string; url: string };

async function dispatch(t: Target, o: Opts) {
  const before = new Date().toISOString();
  const args = [
    "workflow", "run", WORKFLOW, "--repo", REPO,
    "--ref", t.ref,
    "-f", `env=${t.env}`,
    "-f", `pr=${t.pr}`,
    "-f", `sha=${t.sha}`,
  ];
  const caps = workflowCaps(t.ref);
  if (t.env === "production" && !o.check && !o.dryRun && !o.rehearsalPr) {
    throw new Error(`production migrations require --rehearsal-pr <n>: the PR already migrated on staging.
       There is no second reviewer here, so this is what replaces one — see
       docs/operations/production-migration-gate.md`);
  }
  if (t.env === "production" && o.rehearsalPr && !/^[0-9]+$/.test(o.rehearsalPr)) {
    throw new Error(`--rehearsal-pr must be a PR number (got "${o.rehearsalPr}")`);
  }
  if ((o.check || o.dryRun) && !caps.mode) {
    throw new Error(`the workflow on "${t.ref}" has no mode/dry_run inputs — GitHub would reject them with HTTP 422.
       Push this PR branch first, or dispatch against a ref that has the updated migrate.yml.`);
  }
  if (o.check) args.push("-f", "mode=verify");
  if (o.dryRun) args.push("-f", "dry_run=true");
  if (o.rehearsalPr) args.push("-f", `rehearsal_pr=${o.rehearsalPr}`);

  if (o.dryRun) {
    console.log("would run: gh " + args.join(" "));
    return { before, runId: "" };
  }

  gh(args);
  return { before, runId: await findRun(t, before) };
}

async function findRun(t: Target, before: string): Promise<string> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = ghApiJson<Run[]>(["run", "list", "--repo", REPO, "--workflow", WORKFLOW, "--limit", "20"],
      "databaseId,displayTitle,status,conclusion,createdAt,url");
    const match = runs.find(r =>
      r.displayTitle.includes(t.sha) &&
      r.displayTitle.includes(t.env) &&
      r.createdAt >= before.slice(0, 19),
    );
    if (match) return String(match.databaseId);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`no ${WORKFLOW} run appeared for ${t.env} sha ${t.sha} — check 'gh run list --workflow=${WORKFLOW}'`);
}

// Read the schema verdict the workflow published as an artifact. The job conclusion is NOT the
// verdict: a verify run exits 0 even when the database is empty, by design.
type Verdict = {
  ok: boolean;
  missing: string[];
  missingColumns?: string[];
  missingIndexes?: string[];
  pending: string[];
  tables?: string[];
};

function readVerdict(runId: string, env: string, sha: string): Verdict | null {
  const dir = mkdtempSync(path.join(tmpdir(), "solara-verdict-"));
  try {
    execFileSync("gh", ["run", "download", runId, "--repo", REPO, "--dir", dir], { stdio: "ignore" });
    const found = (readdirSync(dir, { recursive: true }) as string[])
      .map(f => String(f))
      .find(f => f.endsWith("verify.json"));
    if (!found) return null;
    const raw = JSON.parse(readFileSync(path.join(dir, found), "utf8")) as {
      ok?: boolean;
      missing?: string[];
      missingColumns?: string[];
      missingIndexes?: string[];
      pending?: string[];
    };
    return {
      ok: raw.ok === true,
      missing: raw.missing ?? [],
      missingColumns: raw.missingColumns ?? [],
      missingIndexes: raw.missingIndexes ?? [],
      pending: raw.pending ?? [],
    };
  } catch {
    return null; // artifact unavailable (expired, or gh lacks artifact read) — degrade, do not lie
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function wait(runId: string, timeoutSec: number) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const r = ghApiJson<Run>(["run", "view", runId, "--repo", REPO], "status,conclusion,url,displayTitle");
    if (r.status !== last) { last = r.status; if (!process.stdout.isTTY) console.log(`  ${r.status}`); }
    if (r.status === "completed") return r;
    await new Promise(res => setTimeout(res, 5000));
  }
  throw new Error(`run ${runId} did not complete within ${timeoutSec}s`);
}

// ------------------------------------------------------------------ main
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const plan = localPlan();
  const t = resolveTarget(o);

  // The sha dispatched is the REF's head on GitHub; this process is whatever is on disk.
  // When they differ the tool that runs is not the tool that was committed — say so loudly,
  // because a stale checkout silently reproduces old behaviour and old bugs.
  const localHead = (() => {
    try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return ""; }
  })();
  const stale = localHead !== "" && localHead !== t.sha;

  const summary = {
    repo: REPO,
    mode: o.check ? "verify" : "migrate",
    env: t.env,
    pr: t.pr,
    base: t.base,
    ref: t.ref,
    sha: t.sha,
    credential: "GitHub Environment secret DATABASE_URL (never read locally)",
    journalTags: plan.tags,
    workflow: WORKFLOW,
    rehearsalPr: o.rehearsalPr || null,
    localHead: localHead || null,
    staleLocalCheckout: stale,
    gate: t.env === "production" ? "rehearsal + full sha + green staging run (enforced in migrate.yml)" : "none",
  };

  if (!o.json) {
    console.log(`repo      ${REPO}`);
    if (stale) {
      console.log(`local     ${localHead.slice(0, 7)}  ← STALE: not the commit being dispatched`);
      console.log(`          git fetch origin ${t.ref} && git reset --hard origin/${t.ref}`);
    }
    console.log(`mode      ${o.check ? "verify only (no DDL)" : "migrate"}`);
    console.log(`environment ${t.env}   secret: Environment DATABASE_URL (not readable locally)`);
    console.log(`checkout  ${t.sha}  (${t.ref}${t.pr !== "0" ? `, PR #${t.pr}` : ""})`);
    console.log(`journal   ${plan.tags.join(", ")}`);
    console.log("");
  }

  const { before, runId } = await dispatch(t, o);

  if (o.dryRun) {
    if (o.json) console.log(JSON.stringify({ ...summary, dispatched: false }, null, 2));
    return 0;
  }

  if (!o.json) console.log(`dispatched run ${runId} — waiting (timeout ${o.timeout}s)`);
  if (!o.json) console.log(`  https://github.com/${REPO}/actions/runs/${runId}`);

  if (o.skipWait) {
    if (o.json) console.log(JSON.stringify({ ...summary, runId, dispatched: true, waited: false }, null, 2));
    return 0;
  }

  const run = await wait(runId, o.timeout);
  const verdict = readVerdict(runId, t.env, t.sha);

  // A dry run / verify dispatch is expected to report drift without failing the pipeline.
  const expectsDrift = o.check || o.dryRun;
  const jobOk = run.conclusion === "success";
  // Where a verdict exists it decides. Where it does not, fall back to the conclusion but say so.
  const ok = verdict ? jobOk && verdict.ok : jobOk;

  if (o.json) {
    console.log(JSON.stringify({
      ...summary, runId, conclusion: run.conclusion, jobOk,
      verdict: verdict ?? "unavailable", ok, url: run.url,
    }, null, 2));
  } else {
    console.log("");
    console.log(`result    ${run.conclusion}${jobOk ? "" : `  ← gh run view ${runId} --log`}`);
    if (!verdict) {
      console.log(`verdict   unavailable (artifact schema-verdict-${t.env}-${t.sha.slice(0, 7)} not readable)`);
      console.log(jobOk ? "UNKNOWN   the job passed but the schema could not be read" : `FAIL      ${t.env} run failed`);
    } else if (verdict.ok) {
      console.log("verdict   in sync");
      console.log(`OK        ${t.env} schema and drizzle journal are in sync`);
    } else {
      console.log("verdict   OUT OF SYNC");
      if (verdict.missing.length) console.log(`missing   ${verdict.missing.join(", ")}`);
      if (verdict.missingColumns?.length) console.log(`columns   missing: ${verdict.missingColumns.join(", ")}`);
      if (verdict.missingIndexes?.length) console.log(`indexes   missing: ${verdict.missingIndexes.join(", ")}`);
      if (verdict.pending.length) console.log(`pending   ${verdict.pending.join(", ")}`);
      if (expectsDrift) {
        console.log(`EXPECTED  a ${o.check ? "verify" : "dry-run"} dispatch may find drift — no DDL was run`);
        console.log(`NEXT      migrate it: npx tsx scripts/db-remote.ts --pr <n>${t.env === "production" ? " --env production --rehearsal-pr <n>" : ""}`);
      } else {
        console.log(`FAIL      ${t.env} did not reach a consistent state after migrating`);
      }
    }
  }

  if (!verdict) return jobOk ? 1 : 1; // never report success on a missing verdict
  return ok ? 0 : 1;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
