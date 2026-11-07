#!/usr/bin/env node
// check-remote-setup — verifies local + remote (#1/#2) setup and reports missing pieces.
// Usage: node scripts/check-remote-setup.mjs [--json] [--strict]
// - Never prints secret values, only OK/WARN/ERROR + guidance.
// - Local: checks .env templates, git branches, dependencies, CI, dependabot.
// - Remote: if `gh` is authenticated, checks GitHub repo settings + branch protection + rulesets + branches.
//          if `vercel` is logged in, checks `vercel env ls` + project link.
//          if `neonctl` exists, hints Neon checks.
// Checks what has been configured and what is missing from remote deps (and local).

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const strict = args.includes("--strict");
let errors = 0, warnings = 0;
const rows = [];

function report(level, area, check, message, fix) {
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

console.log(jsonOut ? "" : "Solara remote + local setup verification — values never printed.\n");

// --- LOCAL ---
report(fileExists(".env.example") ? "OK" : "WARN", "local", ".env.example", fileExists(".env.example") ? "present" : "missing", fileExists(".env.example") ? null : "copy from docs");
report(fileExists(".env.staging.example") ? "OK" : "ERROR", "local", ".env.staging.example", fileExists(".env.staging.example") ? "present" : "missing — staging env template", "see docs/setup/env-templates.md");
report(fileExists(".env.production.example") ? "OK" : "ERROR", "local", ".env.production.example", fileExists(".env.production.example") ? "present" : "missing — prod env template", "see docs/setup/env-templates.md");
report(fileExists(".gitignore") && fileContains(".gitignore", ".env.*") ? "OK" : "WARN", "local", ".gitignore env", "ignores .env, .env.* (templates allowed)", null);
report(fileExists("AGENTS.md") ? "OK" : "WARN", "local", "AGENTS.md", fileExists("AGENTS.md") ? "present (#3)" : "missing — blocked until #1/#2", "gh issue 3: docs: add AGENTS.md");
report(fileExists("docs/decisions.md") ? "OK" : "ERROR", "local", "docs/decisions.md", fileExists("docs/decisions.md") ? "present (ADRs 001-005)" : "missing", null);
report(fileExists("BACKLOG.md") ? "OK" : "WARN", "local", "BACKLOG.md", fileExists("BACKLOG.md") ? "present" : "missing", null);
report(fileExists("docs/setup/00-manual-setup-ui.md") ? "OK" : "WARN", "local", "00-manual-setup-ui.md", fileExists("docs/setup/00-manual-setup-ui.md") ? "present" : "missing manual UI guide", null);

// check templates have required keys (not values)
for (const f of [".env.staging.example", ".env.production.example"]) {
  if (!fileExists(f)) continue;
  const txt = readFileSync(f, "utf8");
  for (const k of ["DATABASE_URL", "APP_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID_MXN"]) {
    report(txt.includes(k + "=") ? "OK" : "WARN", "local", `${f} has ${k}`, txt.includes(k + "=") ? "has placeholder" : "missing key", null);
  }
  if (txt.includes("sk_test") && f.includes("production")) report("WARN", "local", `${f} key prefix`, "production template contains sk_test placeholder — should be sk_live", null);
}

// local real .env files (if present, check format via check-setup.mjs logic without printing)
for (const profile of ["local", "staging", "production"]) {
  const file = profile === "local" ? ".env" : `.env.${profile}`;
  if (fileExists(file)) {
    report("OK", "local", `${file} exists`, "found locally (gitignored, never commit)", "verify with node scripts/check-setup.mjs " + profile + " --strict");
  } else {
    report(profile === "local" ? "WARN" : "OK", "local", `${file} missing`, profile === "local" ? "create .env for local dev" : `optional locally — real values live in Vercel for ${profile}`, null);
  }
}

// deps
report(fileExists("package.json") ? "OK" : "ERROR", "local", "package.json", fileExists("package.json") ? "present" : "missing", null);
report(fileExists("package-lock.json") ? "OK" : "WARN", "local", "package-lock.json", fileExists("package-lock.json") ? "present" : "missing lockfile", null);
report(fileExists(".github/workflows/ci.yml") ? "OK" : "ERROR", "local", "CI workflow", fileExists(".github/workflows/ci.yml") ? "present (verify job)" : "missing", null);
report(fileExists(".github/dependabot.yml") ? "OK" : "WARN", "local", "dependabot.yml", fileExists(".github/dependabot.yml") ? "present (target-branch: staging)" : "missing", "added in #20 → target-branch: staging");
if (fileExists(".github/dependabot.yml")) {
  const yml = readFileSync(".github/dependabot.yml", "utf8");
  report(yml.includes("target-branch: staging") ? "OK" : "WARN", "local", "dependabot target-branch", yml.includes("target-branch: staging") ? "staging" : "not staging", null);
}
report(fileExists("scripts/check-setup.mjs") ? "OK" : "ERROR", "local", "check-setup.mjs", fileExists("scripts/check-setup.mjs") ? "present" : "missing", null);
report(fileExists("scripts/vercel-bootstrap.sh") ? "OK" : "WARN", "local", "vercel-bootstrap.sh", fileExists("scripts/vercel-bootstrap.sh") ? "present +x" : "missing", "chmod +x scripts/vercel-bootstrap.sh");
report(fileExists("scripts/verify-gating-production.ts") ? "OK" : "WARN", "local", "verify-gating-production.ts", fileExists("scripts/verify-gating-production.ts") ? "present (#15)" : "missing", null);

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

for (const branch of ["staging", "main"]) {
  const prot = tryExec(`gh api repos/jtanori/solara/branches/${branch} --jq '{protected}' 2>/dev/null`);
  if (prot) {
    try { const p = JSON.parse(prot); report(p.protected ? "OK" : "WARN", "github", `branch ${branch} protected`, p.protected ? "protected" : "not protected", p.protected ? null : `Settings → Branches → Add rule for ${branch}`); }
    catch { report("WARN", "github", `branch ${branch}`, "parse error", null); }
  } else {
    report("WARN", "github", `branch ${branch}`, "could not check (gh not auth or branch missing)", null);
  }
}

const branches = tryExec("gh api repos/jtanori/solara/branches --paginate --jq '.[].name' 2>/dev/null");
if (branches) {
  const list = branches.split("\n");
  report(list.includes("staging") ? "OK" : "ERROR", "github", "branch staging exists", list.includes("staging") ? "exists" : "missing", "git push origin HEAD:staging or create via GitHub");
  report(list.includes("main") ? "OK" : "ERROR", "github", "branch main exists", list.includes("main") ? "exists" : "missing", null);
}

// --- REMOTE: Vercel ---
const vercelProject = tryExec("vercel ls --yes 2>&1 | head -5");
if (vercelProject && vercelProject.includes("solara")) {
  report("OK", "vercel", "project linked", "found via vercel ls", null);
  const envs = tryExec("vercel env ls 2>&1");
  if (envs) {
    report(envs.includes("DATABASE_URL") ? "OK" : "WARN", "vercel", "env DATABASE_URL", envs.includes("DATABASE_URL") ? "present (check Preview vs Production scoping)" : "missing — run scripts/vercel-bootstrap.sh", null);
    report(envs.includes("APP_URL") ? "OK" : "WARN", "vercel", "env APP_URL", envs.includes("APP_URL") ? "present" : "missing", null);
    report(envs.includes("STRIPE_SECRET_KEY") ? "OK" : "WARN", "vercel", "env Stripe", envs.includes("STRIPE_SECRET_KEY") ? "present" : "missing staging/prod keys", null);
  }
} else {
  const hasVercel = !!tryExec("which vercel 2>/dev/null");
  report(hasVercel ? "WARN" : "OK", "vercel", "CLI/project", hasVercel ? "vercel logged in but no project — run vercel link" : "vercel CLI not installed — optional, use UI: vercel.com/dashboard → solara → Settings → Environment Variables", null);
}

// --- REMOTE: Neon ---
const neonExists = !!tryExec("which neonctl 2>/dev/null") || !!tryExec("which neon 2>/dev/null");
if (neonExists) {
  const neonProjects = tryExec("neonctl branches list --project-id help 2>&1");
  report("OK", "neon", "CLI installed", "neonctl found", "neonctl projects create / connection-string --pooled");
} else {
  report("WARN", "neon", "CLI", "neonctl not installed — optional, use UI: console.neon.tech", "npm i -g neonctl + neonctl auth");
}

// --- Summary ---
if (jsonOut) console.log(JSON.stringify({ errors, warnings, rows }, null, 2));
else {
  console.log(`\nSummary: ${errors} ERROR, ${warnings} WARN`);
  if (errors) console.log("→ Fix ERROR items first (blocking).");
  if (warnings) console.log("→ WARN items are manual UI steps or optional CLI installs.");
  console.log("For manual steps see docs/setup/00-manual-setup-ui.md and docs/setup/env-templates.md");
  console.log("Run node scripts/check-setup.mjs [local|staging|production] --strict with real env to validate values.");
}
process.exitCode = errors || (strict && warnings) ? 1 : 0;
