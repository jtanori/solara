#!/usr/bin/env tsx
// db-run.ts — run a scripted Drizzle operation against ONE named environment, safely.
//
// Why: `drizzle-kit migrate` only reads DATABASE_URL, so migrations were always run by
// exporting the URL into a shell for the right database. That is one typo away from
// migrating production while intending staging (see #52, #75, #90). This runner takes a
// required --env flag, resolves the URL from that environment's file, prints only the
// target identity, and refuses to continue unless the environment is stated explicitly.
//
// Usage:
//   npx tsx scripts/db-run.ts --env staging migrate
//   npx tsx scripts/db-run.ts --env production migrate
//   npx tsx scripts/db-run.ts --env staging status        # what would run, no DDL
//   npx tsx scripts/db-run.ts --env staging status --json
//   npx tsx scripts/db-run.ts --env staging verify         # schema + journal assertions
//   npx tsx scripts/db-run.ts --env local migrate          # .env, loopback only
//
// Options:
//   --env <staging|production|local>   required
//   --dry-run                          for `migrate`: print the plan and exit
//   --json                             machine-readable output (status/verify)
//   --allow-incomplete                 for `verify`: report drift without failing (pre-migration checks)
//   --yes                              skip the production confirmation prompt
//
// Environment resolution (in order, first match wins):
//   1. an already-exported DATABASE_URL_DIRECT / DATABASE_URL in the shell
//   2. .env.<staging|production> in the repo root (gitignored)
//   3. .env for `local`
// Never prints a credential: only `user@host/database`.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { Client } from "pg";

type Target = "staging" | "production" | "local";
type Command = "migrate" | "status" | "verify";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// ------------------------------------------------------------------ arguments
function parseArgs(argv: string[]) {
  const opts = { env: "", command: "", dryRun: false, json: false, allowMigrated: false, yes: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env") opts.env = argv[++i] ?? "";
    else if (a.startsWith("--env=")) opts.env = a.slice(6);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--allow-incomplete" || a === "--allow-migrated") opts.allowMigrated = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    else rest.push(a);
  }
  opts.command = rest[0] ?? "";
  return opts;
}

function usage() {
  console.log(`Usage: npx tsx scripts/db-run.ts --env <staging|production|local> <migrate|status|verify> [options]

  migrate   apply pending migrations to the selected environment (requires DATABASE_URL_DIRECT)
  status    list pending / applied migrations without changing anything
  verify    assert the expected relations and migration journal exist

Options: --dry-run  --json  --allow-incomplete  --yes`);
}

function fail(msg: string): never {
  console.error(`ERROR ${msg}`);
  process.exit(1);
}

// ------------------------------------------------------------------ env files
function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // strip trailing " # comment" on unquoted values
    if (!/^["']/.test(raw.slice(eq + 1).trim())) value = value.replace(/\s+#.*$/, "");
    out[key] = value;
  }
  return out;
}

function resolveUrl(env: Target): { url: string; source: string } {
  const exported = process.env.DATABASE_URL_DIRECT?.trim() || process.env.DATABASE_URL?.trim();
  if (exported) {
    const source = process.env.DATABASE_URL_DIRECT ? "shell DATABASE_URL_DIRECT" : "shell DATABASE_URL";
    return { url: exported, source };
  }
  const file = env === "local" ? ".env" : `.env.${env}`;
  const abs = path.resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    fail(`no exported DATABASE_URL(_DIRECT) and ${file} not found in ${process.cwd()}
       create ${file} (copy .env.${env === "local" ? "example" : env + ".example"}) or export DATABASE_URL_DIRECT`);
  }
  const parsed = parseEnvFile(abs);
  const url = (parsed.DATABASE_URL_DIRECT || parsed.DATABASE_URL || "").trim();
  if (!url) fail(`${file} has neither DATABASE_URL_DIRECT nor DATABASE_URL`);
  return { url, source: `${file}:${parsed.DATABASE_URL_DIRECT ? "DATABASE_URL_DIRECT" : "DATABASE_URL"}` };
}

// ------------------------------------------------------------------ identity
function describe(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    database: u.pathname.replace(/^\//, "") || "",
    user: decodeURIComponent(u.username || ""),
    pooled: u.hostname.includes("-pooler."),
    sslmode: u.searchParams.get("sslmode") ?? "(unset)",
  };
}

function assertEnvironment(env: Target, url: string) {
  const id = describe(url);
  // errors = the target is wrong, refuse to continue. warnings = advisory, never fail.
  const errors: string[] = [];
  const warnings: string[] = [];

  if (env === "local") {
    if (!LOOPBACK.has(id.host)) errors.push(`local target must be loopback, got host "${id.host}"`);
  } else {
    if (LOOPBACK.has(id.host)) errors.push(`${env} target points at loopback "${id.host}"`);
    if (id.host.includes("localhost")) errors.push(`${env} target is localhost`);
    if (id.pooled) errors.push(`${env} target is a pooled (-pooler) host; migrations need the direct endpoint`);
  }

  if (id.sslmode === "(unset)") {
    warnings.push("sslmode is not set — add ?sslmode=verify-full for hosted databases");
  } else if (id.sslmode === "require" || id.sslmode === "prefer") {
    warnings.push(`sslmode=${id.sslmode} is currently treated as verify-full but changes meaning in pg 9 — prefer ?sslmode=verify-full`);
  }

  return { id, errors, warnings };
}

// ------------------------------------------------------------------ journal
type JournalEntry = { idx: number; tag: string; when: number };

function loadJournal(): JournalEntry[] {
  const file = path.resolve(process.cwd(), "drizzle/meta/_journal.json");
  if (!existsSync(file)) fail(`drizzle/meta/_journal.json not found in ${process.cwd()}`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { entries?: JournalEntry[] };
  const entries = parsed.entries ?? [];
  if (!entries.length) fail("journal has no entries");
  return entries;
}

// EXACTLY what drizzle-orm's migrator records:
//   crypto.createHash("sha256").update(query).digest("hex")   // query = the .sql file
// (node_modules/drizzle-orm/migrator.js). Anything else — including idx or tag — makes every
// migration look permanently pending.
function journalHash(_entry: JournalEntry, sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const { host, database } = describe(url);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const hint =
      e.code === "ENOTFOUND" || e.code === "EAI_AGAIN"
        ? " — host does not resolve; check the endpoint id in the secret"
        : /timeout|ETIMEDOUT|ECONNREFUSED/i.test(e.message ?? "")
          ? " — nothing listening; if the Neon project has IP Allow enabled, add the runner's egress IP or disable it"
          : /password|authentication/i.test(e.message ?? "")
            ? " — authentication failed; the role/password in the secret is wrong"
            : "";
    throw new Error(`cannot connect to ${host}/${database}: ${e.code ?? ""} ${e.message ?? err}${hint}`.replace(/\s+/g, " "));
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function readApplied(client: Client): Promise<{ exists: boolean; hashes: string[] }> {
  const reg = await client.query<{ reg: string | null }>("select to_regclass('drizzle.__drizzle_migrations') as reg");
  if (!reg.rows[0]?.reg) return { exists: false, hashes: [] };
  const rows = await client.query<{ hash: string }>("select hash from drizzle.__drizzle_migrations order by id");
  return { exists: true, hashes: rows.rows.map(r => r.hash) };
}

type Resolved = { url: string; source: string; id: ReturnType<typeof describe>; errors: string[]; warnings: string[] };

function resolveAndCheck(env: Target): Resolved {
  const { url, source } = resolveUrl(env);
  const { id, errors, warnings } = assertEnvironment(env, url);
  return { url, source, id, errors, warnings };
}

function printTarget(r: Resolved, env: Target) {
  console.log(`env      ${env}   (from ${r.source})`);
  console.log(`target   ${r.id.user}@${r.id.host}/${r.id.database}${r.id.pooled ? "  [POOLED]" : "  [direct]"}`);
  console.log(`sslmode  ${r.id.sslmode}`);
  for (const w of r.warnings) console.log(`WARN ${w}`);
  for (const e of r.errors) console.error(`ERROR ${e}`);
}

async function pending(r: Resolved) {
  const entries = loadJournal();
  return withClient(r.url, async client => {
    const applied = await readApplied(client);
    const pendingEntries = entries.filter(e => !applied.hashes.includes(journalHash(e, readFileSync(path.resolve(process.cwd(), `drizzle/${e.tag}.sql`), "utf8"))));
    return { applied, entries, pending: pendingEntries };
  });
}

// ------------------------------------------------------------------ commands
async function cmdStatus(env: Target, json: boolean) {
  const r = resolveAndCheck(env);
  const { id, source, warnings, errors } = r;
  if (!json) printTarget(r, env);
  const { applied, entries, pending: pend } = await pending(r);
  const out = {
    env,
    source,
    target: `${id.user}@${id.host}/${id.database}`,
    pooled: id.pooled,
    sslmode: id.sslmode,
    warnings,
    errors,
    journalEntries: entries.length,
    journalPresent: applied.exists,
    appliedHashes: applied.hashes.length,
    pending: pend.map(e => e.tag),
  };
  if (json) { console.log(JSON.stringify(out, null, 2)); return errors.length ? 1 : 0; }

  console.log(`journal  ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
  console.log(`applied  ${applied.exists ? `${applied.hashes.length} row(s)` : "no drizzle.__drizzle_migrations table"}`);
  console.log(`pending  ${pend.length ? pend.map(e => e.tag).join(", ") : "none — database is up to date"}`);
  return errors.length ? 1 : 0;
}

async function cmdVerify(env: Target, json: boolean, allowEmpty: boolean) {
  const REQUIRED = [
    "public.users", "public.sessions", "public.readings", "public.knowledge",
    "public.subscriptions", "public.stripe_events", "public.audit_logs",
  ];
  const r = resolveAndCheck(env);
  const { url, source, id, warnings, errors } = r;
  if (!json) printTarget(r, env);
  const entries = loadJournal();

  return withClient(url, async client => {
    const reg = await client.query<Record<string, string | null>>(
      `select ${REQUIRED.map((r, i) => `to_regclass($${i + 1}) as t${i}`).join(", ")}`, REQUIRED);
    const missing = REQUIRED.filter((r, i) => !reg.rows[0]?.[`t${i}`]);
    const applied = await readApplied(client);
    const pendingTags = entries.filter(e => !applied.hashes.includes(journalHash(e, readFileSync(path.resolve(process.cwd(), `drizzle/${e.tag}.sql`), "utf8")))).map(e => e.tag);

    const ok = missing.length === 0 && pendingTags.length === 0 && errors.length === 0;
    const out = {
      env, source,
      target: `${id.user}@${id.host}/${id.database}`,
      warnings, errors, required: REQUIRED, missing, pending: pendingTags, ok,
    };

    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`tables   ${REQUIRED.length - missing.length}/${REQUIRED.length} present${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
      console.log(`pending  ${pendingTags.length ? pendingTags.join(", ") : "none"}`);
      console.log(ok ? "OK       schema and journal are up to date" : "FAIL     environment is not ready");
    }
    if (!ok && allowEmpty) { console.error("NOTE --allow-incomplete set: reporting but not failing"); return 0; }
    return ok ? 0 : 1;
  });
}

async function cmdMigrate(env: Target, dryRun: boolean, yes: boolean) {
  const r = resolveAndCheck(env);
  const { id, source } = r;
  printTarget(r, env);
  if (r.errors.length) fail(`refusing to migrate: ${r.errors.join("; ")}`);

  const state = await pending(r);
  console.log(`pending  ${state.pending.length ? state.pending.map(e => e.tag).join(", ") : "none"}`);

  if (!state.pending.length) { console.log("nothing to do — database is already up to date"); return 0; }
  if (dryRun) { console.log("dry run — not applying"); return 0; }

  if (env === "production" && !yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(r => rl.question(`Apply ${state.pending.length} migration(s) to PRODUCTION (${id.host})? type "production" to continue: `, r));
    rl.close();
    if (answer.trim() !== "production") { console.error("aborted."); return 1; }
  }

  // Delegate the actual DDL to drizzle-kit, with DATABASE_URL pointed at this environment only.
  const { spawnSync } = await import("node:child_process");
  console.log("running drizzle-kit migrate…");
  const res = spawnSync("npx", ["drizzle-kit", "migrate"], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: r.url },
  });
  // Keep the full output: it is uploaded as an artifact when a run fails, so the next
  // failure is diagnosable instead of "exit code 1".
  const log = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  appendFileSync("migrate.log", `$ npx drizzle-kit migrate (DATABASE_URL -> ${id.host}/${id.database})\n${log}\n`);
  process.stdout.write(log);
  console.log(`exit code ${res.status}`);
  if (res.status !== 0) fail(`drizzle-kit migrate exited ${res.status} — see migrate.log`);

  const after = await pending(r);
  console.log(`applied  ${after.applied.hashes.length} row(s) in drizzle.__drizzle_migrations`);
  console.log(`pending  ${after.pending.length ? after.pending.map(e => e.tag).join(", ") : "none"}`);
  if (after.pending.length) fail("migrations were reported applied but the journal still shows pending entries");
  return 0;
}

// ------------------------------------------------------------------ main
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.env) fail("--env is required (staging | production | local). There is no default: this tool will not guess a database.");
  if (!["staging", "production", "local"].includes(opts.env)) fail(`--env must be staging, production or local (got "${opts.env}")`);
  const env = opts.env as Target;
  if (!opts.command) { usage(); process.exit(2); }

  switch (opts.command) {
    case "migrate": process.exit(await cmdMigrate(env, opts.dryRun, opts.yes)); break;
    case "status": process.exit(await cmdStatus(env, opts.json)); break;
    case "verify": process.exit(await cmdVerify(env, opts.json, opts.allowMigrated)); break;
    default: usage(); process.exit(2);
  }
}

main().catch(err => fail(err instanceof Error ? err.message : String(err)));
