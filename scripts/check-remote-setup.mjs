#!/usr/bin/env node
// check-remote-setup — verifies local + remote (#1/#2) setup and reports missing pieces.
// Usage:
//   node scripts/check-remote-setup.mjs [--env <local|staging|production>] [--json] [--strict]
//   --env staging     → checks only secrets/config relevant to that env (.env.staging if present, else remote Preview/staging)
//   --env production   → checks only prod (.env.production, Production/main, live Stripe)
//   --env local        → checks only local (.env, dev DB, localhost)
//   No --env           → checks all (old behavior, backward compat).
// - Never prints secret values, only OK/WARN/ERROR + guidance.
// - Local: checks .env templates, git branches, dependencies, CI, dependabot.
// - Remote: if `gh` is authenticated, checks GitHub repo settings + branch protection + rulesets + branches.
//          if `vercel` is logged in, checks `vercel env ls` + project link.
//          if `neonctl` exists, hints Neon checks.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const raw = process.argv.slice(2);
let envFilter = null; // "local"|"staging"|"production" or null
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === "--env" && raw[i + 1]) envFilter = raw[++i];
  else if (raw[i].startsWith("--env=")) envFilter = raw[i].split("=")[1];
}
if (envFilter && !["local", "staging", "production"].includes(envFilter)) {
  console.error("ERROR --env must be local, staging, or production");
  process.exit(2);
}
const jsonOut = raw.includes("--json");
const strict = raw.includes("--strict");
let errors = 0, warnings = 0;
const rows = [];

function shouldRun(area, check) {
  if (!envFilter) return true;
  // Filter by env
  if (envFilter === "local") {
    // only local .env, local DB, local branch checks, not staging/prod remote
    if (area === "vercel" && check.includes("DATABASE_URL") && !check.includes("local")) return false;
    if (check.includes("staging") || check.includes("production") || check.includes("staging.example") || check.includes("production.example")) return false;
    if (area === "github" && check.includes("protect-staging")) return false;
    // keep local file checks
    return true;
  }
  if (envFilter === "staging") {
    if (area === "local" && check === ".env.production.example") return false;
    if (area === "local" && check === ".env.production missing") return false;
    if (check.includes("production") && !check.includes("staging")) return false;
    if (area === "github" && check.includes("protect-main") && !check.includes("protect-staging")) {
      // keep both? but staging filter should focus on staging
      // we keep staging protection check, skip main
      return false;
    }
    if (check.includes("main") && !check.includes("staging")) return false;
    return true;
  }
  if (envFilter === "production") {
    if (area === "local" && check === ".env.staging.example") return false;
    if (area === "local" && check === ".env.staging missing") return false;
    if (check.includes("staging") && !check.includes("production")) return false;
    if (area === "github" && check.includes("protect-staging")) return false;
    if (check.includes("Preview") || check.includes("staging") ) {
      // keep only prod-related
      if (!check.includes("production") && !check.includes("main")) return false;
    }
    return true;
  }
  return true;
}

function report(level, area, check, message, fix) {
  if (!shouldRun(area, check)) return;
  if (level === "ERROR") errors++;
  if (level === "WARN") warnings++;
  rows.push({ level, area, check, message, fix });
  if (!jsonOut) {
    const icon = level === "OK" ? "OK" : level;
    console.log(`${icon.padEnd(5)} [${area}] ${check}: ${message}${fix ? ` → ${fix}` : ""}`);
  }
}

function tryExec(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: "utf8", stdio: "pipe", timeout: 5000, ...opts }).trim(); }
  catch (e) { return null; }
}

function fileExists(p) { return existsSync(p); }
function fileContains(p, needle) { try { return readFileSync(p, "utf8").includes(needle); } catch { return false; } }

function loadEnvFileKeys(env) {
  const file = env === "local" ? ".env" : `.env.${env}`;
  if (!existsSync(file)) return null;
  const txt = readFileSync(file, "utf8");
  const keys = new Set();
  for (const line of txt.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    keys.add(t.slice(0, eq).trim());
  }
  return { file, keys, content: txt };
}

let envKeys = null;
let envContent = null;
let envFileLabel = null;
if (envFilter) {
  const loaded = loadEnvFileKeys(envFilter);
  if (loaded) {
    envKeys = loaded.keys;
    envContent = loaded.content;
    envFileLabel = loaded.file;
    if (!jsonOut) console.log(`Filtered to --env ${envFilter} (${envFileLabel}, ${envKeys.size} keys) — only checks for secrets set in that file + relevant remote.\n`);
  } else {
    if (!jsonOut) console.log(`Note: --env ${envFilter} requested but ${envFilter === "local" ? ".env" : `.env.${envFilter}`} not found — checking remote ${envFilter} config only.\n`);
    // still filter remote checks
  }
} else if (!jsonOut) {
  console.log("Solara remote + local setup verification — values never printed.\n");
}

// helper: when --env is set, only validate template keys that are actually set in the local file
function shouldCheckTemplateKey(key) {
  if (!envFilter || !envKeys) return true;
  return envKeys.has(key);
}

console.log(jsonOut ? "" : envFilter ? "" : "Solara remote + local setup verification — values never printed.\n");

// --- LOCAL ---
if (!envFilter || envFilter === "local" || envFilter === "staging" || envFilter === "production") {
  // .env.example always relevant
  report(fileExists(".env.example") ? "OK" : "WARN", "local", ".env.example", fileExists(".env.example") ? "present" : "missing", fileExists(".env.example") ? null : "copy from docs");
}
if (!envFilter || envFilter === "staging") {
  report(fileExists(".env.staging.example") ? "OK" : "ERROR", "local", ".env.staging.example", fileExists(".env.staging.example") ? "present" : "missing — staging env template", "see docs/setup/env-templates.md");
  if (fileExists(".env.staging.example")) {
    const txt = readFileSync(".env.staging.example", "utf8");
    for (const k of ["DATABASE_URL", "APP_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID_MXN"]) {
      if (!shouldCheckTemplateKey(k)) continue;
      report(txt.includes(k + "=") ? "OK" : "WARN", "local", `.env.staging.example has ${k}`, txt.includes(k + "=") ? "has placeholder" : "missing key", null);
    }
  }
}
if (!envFilter || envFilter === "production") {
  report(fileExists(".env.production.example") ? "OK" : "ERROR", "local", ".env.production.example", fileExists(".env.production.example") ? "present" : "missing — prod env template", "see docs/setup/env-templates.md");
  if (fileExists(".env.production.example")) {
    const txt = readFileSync(".env.production.example", "utf8");
    for (const k of ["DATABASE_URL", "APP_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID_MXN"]) {
      if (!shouldCheckTemplateKey(k)) continue;
      report(txt.includes(k + "=") ? "OK" : "WARN", "local", `.env.production.example has ${k}`, txt.includes(k + "=") ? "has placeholder" : "missing key", null);
      if (k === "STRIPE_SECRET_KEY" && txt.includes("sk_test")) report("WARN", "local", `.env.production.example key prefix`, "production template contains sk_test placeholder — should be sk_live", null);
    }
  }
}
if (!envFilter) {
  report(fileExists(".gitignore") && fileContains(".gitignore", ".env.*") ? "OK" : "WARN", "local", ".gitignore env", "ignores .env, .env.* (templates allowed)", null);
  report(fileExists("AGENTS.md") ? "OK" : "WARN", "local", "AGENTS.md", fileExists("AGENTS.md") ? "present (#3)" : "missing — blocked until #1/#2", "gh issue 3: docs: add AGENTS.md");
  report(fileExists("docs/decisions.md") ? "OK" : "ERROR", "local", "docs/decisions.md", fileExists("docs/decisions.md") ? "present (ADRs 001-005)" : "missing", null);
  report(fileExists("BACKLOG.md") ? "OK" : "WARN", "local", "BACKLOG.md", fileExists("BACKLOG.md") ? "present" : "missing", null);
  report(fileExists("docs/setup/00-manual-setup-ui.md") ? "OK" : "WARN", "local", "00-manual-setup-ui.md", fileExists("docs/setup/00-manual-setup-ui.md") ? "present" : "missing manual UI guide", null);
}

// local real .env files — when filtered, only check the requested file
const profilesToCheck = envFilter ? [envFilter] : ["local", "staging", "production"];
for (const profile of profilesToCheck) {
  const file = profile === "local" ? ".env" : `.env.${profile}`;
  if (!shouldRun("local", `${file} exists`) && !shouldRun("local", `${file} missing`)) continue;
  if (fileExists(file)) {
    report("OK", "local", `${file} exists`, `found locally (gitignored, never commit)${envFilter ? ` — checking ${envKeys ? envKeys.size : 0} keys from this file` : ""}`, `verify with node scripts/check-setup.mjs --env ${profile} --strict`);
    // when --env, validate file contents via check-setup logic style: ensure DATABASE_URL host etc for that env
    if (envFilter && envKeys) {
      const txt = readFileSync(file, "utf8");
      // quick sanity: if file contains STRIPE_SECRET_KEY, warn if prefix mismatches env
      if (txt.includes("STRIPE_SECRET_KEY")) {
        const isTest = txt.includes("sk_test");
        const isLive = txt.includes("sk_live");
        if (profile === "staging" && isLive) report("ERROR", "local", `${file} Stripe prefix`, "staging should use sk_test, not sk_live", null);
        if (profile === "production" && isTest) report("ERROR", "local", `${file} Stripe prefix`, "production must use sk_live, not sk_test", null);
      }
      // DATABASE_URL TLS hint
      if (profile !== "local" && txt.includes("DATABASE_URL") && !txt.includes("sslmode")) report("WARN", "local", `${file} DATABASE_URL TLS`, "hosted env should have ?sslmode=require", null);
    }
  } else {
    report(profile === "local" ? "WARN" : envFilter ? "WARN" : "OK", "local", `${file} missing`, profile === "local" ? "create .env for local dev" : envFilter ? `${file} not found locally — create from ${file}.example or check Vercel` : `optional locally — real values live in Vercel for ${profile}`, null);
  }
}

// deps (only when not filtered or when checking all)
if (!envFilter) {
  report(fileExists("package.json") ? "OK" : "ERROR", "local", "package.json", fileExists("package.json") ? "present" : "missing", null);
  report(fileExists("package-lock.json") ? "OK" : "WARN", "local", "package-lock.json", fileExists("package-lock.json") ? "present" : "missing lockfile", null);
  report(fileExists(".github/workflows/ci.yml") ? "OK" : "ERROR", "local", "CI workflow", fileExists(".github/workflows/ci.yml") ? "present (verify job)" : "missing", null);
  report(fileExists(".github/dependabot.yml") ? "OK" : "WARN", "local", "dependabot.yml", fileExists(".github/dependabot.yml") ? "present (target-branch: staging)" : "missing", "added in #20 → target-branch: staging");
  if (fileExists(".github/dependabot.yml")) {
    const yml = readFileSync(".github/dependabot.yml", "utf8");
    report(yml.includes("target-branch: staging") ? "OK" : "WARN", "local", "dependabot target-branch", yml.includes("target-branch: staging") ? "staging" : "not staging", null);
  }
  report(fileExists("scripts/check-setup.mjs") ? "OK" : "ERROR", "local", "check-setup.mjs", fileExists("scripts/check-setup.mjs") ? "present" : "missing", null);
  report(fileExists("scripts/verify-gating-production.ts") ? "OK" : "WARN", "local", "verify-gating-production.ts", fileExists("scripts/verify-gating-production.ts") ? "present (#15)" : "missing", null);
}

// --- REMOTE: GitHub ---
const ghRepo = tryExec("gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}' 2>/dev/null");
if (ghRepo) {
  try {
    const s = JSON.parse(ghRepo);
    report(s.allow_squash_merge === true && s.allow_merge_commit === false && s.allow_rebase_merge === false && s.delete_branch_on_merge === true ? "OK" : "WARN",
      "github", "repo merge settings", `squash:${s.allow_squash_merge} merge:${s.allow_merge_commit} rebase:${s.allow_rebase_merge} auto-delete:${s.delete_branch_on_merge}`, s.delete_branch_on_merge ? null : "Settings → General → Pull Requests → squash-only + auto-delete");
  } catch { report("WARN", "github", "repo settings", "could not parse", null); }
} else {
  report("WARN", "github", "repo settings", "gh not authenticated — run gh auth login to check", "gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'");
}

const rules = tryExec("gh api repos/jtanori/solara/rulesets --jq 'map(.name)' 2>/dev/null");
if (rules) {
  try {
    const names = JSON.parse(rules);
    report(names.includes("protect-main") && names.includes("protect-staging") ? "OK" : "WARN", "github", "rulesets", names.length ? names.join(", ") : "none", names.length ? null : "Settings → Rules → New ruleset for staging + main");
  } catch { report("WARN", "github", "rulesets", "parse error", null); }
} else {
  report("WARN", "github", "rulesets", "gh not authenticated or no rulesets", "gh api repos/jtanori/solara/rulesets");
}

for (const branch of (envFilter === "staging" ? ["staging"] : envFilter === "production" ? ["main"] : ["staging", "main"])) {
  const ghBranch = branch === "main" ? "main" : "staging";
  const prot = tryExec(`gh api repos/jtanori/solara/branches/${ghBranch} --jq '{protected}' 2>/dev/null`);
  if (prot) {
    try { const p = JSON.parse(prot); report(p.protected ? "OK" : "WARN", "github", `branch ${ghBranch} protected`, p.protected ? "protected" : "not protected", p.protected ? null : `Settings → Branches → Add rule for ${ghBranch}`); }
    catch { report("WARN", "github", `branch ${ghBranch}`, "parse error", null); }
  } else {
    report("WARN", "github", `branch ${ghBranch}`, "could not check (gh not auth or branch missing)", null);
  }
}

const branches = tryExec("gh api repos/jtanori/solara/branches --paginate --jq '.[].name' 2>/dev/null");
if (branches) {
  const list = branches.split("\n");
  if (!envFilter || envFilter === "staging") report(list.includes("staging") ? "OK" : "ERROR", "github", "branch staging exists", list.includes("staging") ? "exists" : "missing", "git push origin HEAD:staging or create via GitHub");
  if (!envFilter || envFilter === "production" || envFilter === "staging") report(list.includes("main") ? "OK" : "ERROR", "github", "branch main exists", list.includes("main") ? "exists" : "missing", null);
}

// --- REMOTE: Vercel ---
const vercelProject = tryExec("vercel ls --yes 2>&1 | head -5");
const hasVercel = !!tryExec("which vercel 2>/dev/null");
if (!envFilter || envFilter === "staging" || envFilter === "production") {
  if (vercelProject && vercelProject.includes("solara")) {
    report("OK", "vercel", "project linked", "found via vercel ls", null);
    const envs = tryExec("vercel env ls 2>&1");
    if (envs) {
      if (!envFilter || envFilter === "staging") {
        report(envs.includes("DATABASE_URL") ? "OK" : "WARN", "vercel", "env staging DATABASE_URL", envs.includes("DATABASE_URL") ? "present (Preview/staging)" : "missing — configure via Vercel dashboard: solara → Settings → Environment Variables (Preview/staging)", null);
        report(envs.includes("APP_URL") ? "OK" : "WARN", "vercel", "env staging APP_URL", envs.includes("APP_URL") ? "present" : "missing", null);
      }
      if (!envFilter || envFilter === "production") {
        report(envs.includes("DATABASE_URL") ? "OK" : "WARN", "vercel", "env prod DATABASE_URL", envs.includes("DATABASE_URL") ? "present (Production/main)" : "missing", null);
      }
      report(envs.includes("STRIPE_SECRET_KEY") ? "OK" : "WARN", "vercel", "env Stripe", envs.includes("STRIPE_SECRET_KEY") ? "present" : "missing staging/prod keys", null);
    }
  } else {
    report(hasVercel ? "WARN" : "OK", "vercel", "CLI/project", hasVercel ? "vercel logged in but no project — run vercel link" : "vercel CLI not installed — optional, use UI: vercel.com/dashboard → solara → Settings → Environment Variables", null);
  }
}

// --- REMOTE: Neon ---
const neonExists = !!tryExec("which neonctl 2>/dev/null") || !!tryExec("which neon 2>/dev/null");
if (neonExists) {
  report("OK", "neon", "CLI installed", "neonctl found", "neonctl projects create / connection-string --pooled");
} else if (!envFilter || envFilter !== "local") {
  report("WARN", "neon", "CLI", "neonctl not installed — optional, use UI: console.neon.tech", "npm i -g neonctl + neonctl auth");
}

// --- Summary ---
if (jsonOut) console.log(JSON.stringify({ env: envFilter || "all", errors, warnings, rows }, null, 2));
else {
  console.log(`\nSummary (${envFilter ? `--env ${envFilter}` : "all envs"}): ${errors} ERROR, ${warnings} WARN`);
  if (errors) console.log("→ Fix ERROR items first (blocking).");
  if (warnings) console.log("→ WARN items are manual UI steps or optional CLI installs.");
  if (envFilter) console.log(`Tip: run without --env to check all envs, or with --env ${envFilter} to filter.`);
  else console.log("For manual steps see docs/setup/00-manual-setup-ui.md and docs/setup/env-templates.md");
  console.log("Run node scripts/check-setup.mjs --env <staging|production> --strict with real env to validate values.");
}
process.exitCode = errors || (strict && warnings) ? 1 : 0;
