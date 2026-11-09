#!/usr/bin/env node
// check-setup — verifies env file format without connecting to providers.
// Usage:
//   node scripts/check-setup.mjs [local|staging|production] [--strict]
//   node scripts/check-setup.mjs --env <local|staging|production> [--strict]
//   node scripts/check-setup.mjs --env staging --strict   # reads .env.staging, checks only keys set in that file
//   node scripts/check-setup.mjs --env production
// With --env, loads .env.<env> (or .env for local) and validates only the secrets present in that file
// (missing required keys that are not in the file are not reported as ERROR).

import fs from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
let profile = "local";
let envFilter = null;
let strict = false;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--env" && rawArgs[i + 1]) {
    envFilter = rawArgs[++i];
    profile = envFilter;
  } else if (a.startsWith("--env=")) {
    envFilter = a.split("=")[1];
    profile = envFilter;
  } else if (a === "--strict") {
    strict = true;
  } else if (["local", "staging", "production"].includes(a)) {
    profile = a;
    // if no explicit --env, envFilter stays null so we check all
  } else if (a === "--help" || a === "-h") {
    console.log(`Usage: node scripts/check-setup.mjs [local|staging|production] [--env <env>] [--strict]`);
    console.log(`  --env <local|staging|production>  Load .env.<env> (.env for local) and only check keys set in that file`);
    console.log(`  --strict                           Warns become errors`);
    process.exit(0);
  } else {
    console.error(`Usage: node scripts/check-setup.mjs <local|staging|production> [--strict]`);
    console.error(`  or: node scripts/check-setup.mjs --env <local|staging|production> [--strict]`);
    process.exit(2);
  }
}

if (!["local", "staging", "production"].includes(profile)) {
  console.error(`Usage: node scripts/check-setup.mjs <local|staging|production> [--strict]`);
  process.exit(2);
}

// Load dotenv from the targeted file if --env was requested
let keysInFile = null; // Set<string> | null => if set, only check these keys
if (envFilter) {
  const envFile = envFilter === "local" ? ".env" : `.env.${envFilter}`;
  const fullPath = path.resolve(envFile);
  if (!fs.existsSync(fullPath)) {
    console.error(`ERROR ${envFile} not found — copy from ${envFile}.example first`);
    process.exit(2);
  }
  const content = fs.readFileSync(fullPath, "utf8");
  keysInFile = new Set();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    keysInFile.add(key);
    if (!process.env[key]) process.env[key] = val;
  }
  console.log(`Loaded ${envFile} (${keysInFile.size} keys) — checking only keys set in that file.`);
} else {
  // fallback to dotenv/config for backward compat (loads .env)
  try {
    const dotenv = await import("dotenv/config");
    void dotenv;
  } catch {}
}

let errors = 0;
let warnings = 0;
function report(level, message) {
  if (keysInFile && !shouldReportForFilter(message, level)) return;
  if (level === "ERROR") errors++;
  if (level === "WARN") warnings++;
  console.log(`${level.padEnd(5)} ${message}`);
}

// When --env is used, only report checks for keys that are actually in the file
// We infer by looking at message containing key names, or by allowing all DB/APP_URL checks
// since they are core. For other keys, skip if not in file.
function shouldReportForFilter(msg, level) {
  if (!keysInFile) return true;
  // Always show DB/APP_URL and summary, even if not in file? But spec says "only for secrets set"
  // So we filter: if message mentions a specific env var, only show if that var is in file
  const knownKeys = ["DATABASE_URL", "APP_URL", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID_MXN", "STRIPE_PRICE_ID_USD", "STRIPE_PREMIUM_PRICE_IDS", "OPEN_METEO_API_KEY", "NEXT_PUBLIC_MAP_TILE_URL", "NEXT_PUBLIC_MAP_ATTRIBUTION", "MAIL_TRANSPORT", "MAIL_FROM", "MAIL_REPLY_TO", "RESEND_API_KEY", "POSTMARK_SERVER_TOKEN", "CSP_MODE", "LOCAL_SEED_PASSWORD", "ALLOW_LOCAL_SEED"];
  for (const k of knownKeys) {
    if (msg.includes(k)) return keysInFile.has(k);
  }
  // For generic messages without key, show them (e.g., DATABASE_URL format)
  // But we still want to hide if the key itself wasn't in file — check if message is about a key not in file
  // For now, show all generic DB/APP checks since they are always relevant when file is loaded
  return true;
}

function value(name) { return process.env[name]?.trim() || ""; }
console.log(`Solara configuration check: ${profile}. Values are never printed.`);
if (envFilter) console.log(`(Filtered to .env.${envFilter === "local" ? "" : envFilter} — only secrets set in that file)`);
const database = value("DATABASE_URL");
try {
  if (!database) throw new Error("missing");
  const url = new URL(database);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("invalid");
  report("OK", "DATABASE_URL is present and has a PostgreSQL URL format.");
  if (profile !== "local" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) report("WARN", "Hosted environments normally need their own reachable database, not localhost.");
  if (profile !== "local" && !url.searchParams.has("sslmode")) report("WARN", "Confirm TLS is enforced for the hosted database connection.");
} catch { report("ERROR", "DATABASE_URL is missing or is not a valid PostgreSQL URL."); }
const appUrl = value("APP_URL");
if (!appUrl) report(profile === "local" ? "WARN" : "ERROR", "APP_URL is missing; set the canonical origin for Stripe redirects.");
else {
  try {
    const url = new URL(appUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid");
    if (profile !== "local" && url.protocol !== "https:") report("ERROR", "APP_URL must use HTTPS for hosted environments.");
    else report("OK", "APP_URL has an appropriate URL format.");
    if (url.pathname !== "/" || url.search || url.hash) report("WARN", "APP_URL should be an origin only; paths and query strings are ignored.");
  } catch { report("ERROR", "APP_URL is not a valid HTTP(S) origin."); }
}
const stripeKey = value("STRIPE_SECRET_KEY");
const webhook = value("STRIPE_WEBHOOK_SECRET");
const mxn = value("STRIPE_PRICE_ID_MXN");
if (!stripeKey || !webhook || !mxn) report(profile === "local" ? "WARN" : "ERROR", "Stripe is incomplete: secret key, webhook secret, and MXN recurring price ID are required for checkout.");
if (stripeKey) {
  const expected = profile === "production" ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  if (expected.test(stripeKey)) report("OK", `STRIPE_SECRET_KEY has the expected ${profile === "production" ? "live" : "test"} mode prefix.`);
  else report("ERROR", `STRIPE_SECRET_KEY must use a ${profile === "production" ? "live" : "test"} key for this profile.`);
}
if (webhook) {
  if (webhook.startsWith("whsec_")) report("OK", "STRIPE_WEBHOOK_SECRET has the expected format.");
  else report("ERROR", "STRIPE_WEBHOOK_SECRET must be the signing secret for this endpoint.");
}
for (const name of ["STRIPE_PRICE_ID_MXN", "STRIPE_PRICE_ID_USD"]) {
  const price = value(name);
  if (price && !price.startsWith("price_")) report("ERROR", `${name} must be a Stripe Price ID.`);
  else if (price) report("OK", `${name} has the expected format.`);
}
const legacy = value("STRIPE_PREMIUM_PRICE_IDS").split(",").map(x => x.trim()).filter(Boolean);
if (legacy.some(price => !price.startsWith("price_"))) report("ERROR", "Each legacy Premium price must be a Stripe Price ID.");
if (!value("OPEN_METEO_API_KEY")) {
  if (profile === "production") report("WARN", "Production commercial geocoding requires an appropriate Open-Meteo license and customer key.");
  else report("OK", "Open-Meteo public geocoding is available for non-commercial evaluation.");
} else report("OK", "OPEN_METEO_API_KEY is present; customer geocoding will be used.");
const tiles = value("NEXT_PUBLIC_MAP_TILE_URL");
if (tiles) {
  if (!tiles.startsWith("https://") || !["{z}", "{x}", "{y}"].every(part => tiles.includes(part))) report("ERROR", "NEXT_PUBLIC_MAP_TILE_URL must be an HTTPS template containing {z}, {x}, and {y}.");
  else report("OK", "A public map-tile URL template is configured.");
  if (!value("NEXT_PUBLIC_MAP_ATTRIBUTION")) report("WARN", "Add the tile provider's required attribution as plain text.");
} else if (profile === "production") report("WARN", "Default OpenStreetMap tiles have limited capacity; choose an appropriate production provider and verify its policy.");
else report("OK", "The default OpenStreetMap tile endpoint is used for evaluation.");

const mailTransport = value("MAIL_TRANSPORT").toLowerCase();
const mailFrom = value("MAIL_FROM");
const resendKey = value("RESEND_API_KEY");
const postmarkToken = value("POSTMARK_SERVER_TOKEN");
if (!mailTransport) {
  if (profile === "local") report("OK", "MAIL_TRANSPORT is unset; local development will use the outbox transport.");
  else report("ERROR", "MAIL_TRANSPORT is required for hosted environments (resend or postmark).");
} else if (!["resend", "postmark", "outbox"].includes(mailTransport)) {
  report("ERROR", "MAIL_TRANSPORT must be resend, postmark, or outbox.");
} else if (profile !== "local" && mailTransport === "outbox") {
  report("ERROR", "MAIL_TRANSPORT=outbox is not allowed outside local development.");
} else {
  report("OK", `MAIL_TRANSPORT is set to ${mailTransport}.`);
}
if (mailTransport && mailTransport !== "outbox") {
  const address = mailFrom.replace(/^.*<|>.*$/g, "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) report("ERROR", "MAIL_FROM must contain a valid sender address.");
  else report("OK", "MAIL_FROM has an email address format.");
  if (mailTransport === "resend" && !resendKey.startsWith("re_")) report("ERROR", "RESEND_API_KEY must start with re_.");
  if (mailTransport === "postmark" && !postmarkToken) report("ERROR", "POSTMARK_SERVER_TOKEN is required for postmark.");
}
const cspMode = value("CSP_MODE").toLowerCase();
if (cspMode && !["report-only", "enforce"].includes(cspMode)) report("ERROR", "CSP_MODE must be report-only or enforce.");
else report("OK", `CSP_MODE is ${cspMode || "report-only (default)"}.`);

console.log("This is a format check only: it does not connect to providers, verify licenses, or confirm webhook delivery.");
if (errors || (strict && warnings)) process.exitCode = 1;
