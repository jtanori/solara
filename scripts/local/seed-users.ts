// Local-only role seed scaffold — see #8
// Usage: ALLOW_LOCAL_SEED=true LOCAL_SEED_PASSWORD=... DATABASE_URL=... npm run db:seed:local
// Refuses non-local DATABASE_URL hostnames and exits non-zero when guards fail.
// The ALLOW_LOCAL_SEED + LOCAL_SEED_PASSWORD gate is the real safety; the hostname
// allowlist is best-effort (an SSH tunnel can appear as 127.0.0.1) and is not relied on alone.
import "dotenv/config";
import { hashPassword } from "../../src/lib/passwords";

function fail(msg: string): never {
  console.error(`ERROR ${msg}`);
  process.exit(1);
}

// fail-closed guards — run before any DB import so the user sees a clear message
// instead of a raw src/db stack trace when env is missing; Pool is only constructed after.
if (process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) {
  fail("Refusing to seed in CI/Vercel environment (ALLOW_LOCAL_SEED is local-only).");
}

const allow = process.env.ALLOW_LOCAL_SEED;
if (allow !== "true" && allow !== "1") {
  fail('Refusing to seed: set ALLOW_LOCAL_SEED=true (and never in staging/production).');
}

const password = process.env.LOCAL_SEED_PASSWORD?.trim() ?? "";
if (!password) fail("LOCAL_SEED_PASSWORD is required (min 12 chars) and must not be committed.");
if (password.length < 12) fail("LOCAL_SEED_PASSWORD must be at least 12 characters.");

const urlRaw = process.env.DATABASE_URL?.trim() ?? "";
if (!urlRaw) fail("DATABASE_URL is required.");
let hostname: string;
let normalizedHostname: string;
try {
  hostname = new URL(urlRaw).hostname;
  // new URL("[::1]") hostname is "[::1]" — strip brackets so ::1 matches
  normalizedHostname = hostname.replace(/^\[|\]$/g, "");
} catch {
  fail("DATABASE_URL is not a valid URL.");
  hostname = "";
  normalizedHostname = "";
}
// Allow only loopback targets — prevents accidental prod/staging writes.
// Best-effort: an SSH tunnel (ssh -L 5432:remote:5432) also appears as 127.0.0.1,
// so the ALLOW_LOCAL_SEED + password gate remains the authoritative check.
const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const checkHost = normalizedHostname || hostname;
if (!allowedHosts.has(checkHost) && !allowedHosts.has(hostname)) {
  fail(`Refusing non-local DATABASE_URL host "${hostname}" — seed is local-only. Use a disposable local PostgreSQL.`);
}

const SEEDS: Array<{ email: string; name: string; role: "owner" | "admin" | "editor" | "user" }> = [
  { email: "owner@solara.local", name: "Solara Owner", role: "owner" },
  { email: "admin@solara.local", name: "Solara Admin", role: "admin" },
  { email: "editor@solara.local", name: "Solara Editor", role: "editor" },
  { email: "user@solara.local", name: "Solara User", role: "user" },
];

async function main() {
  // Dynamic imports after guards — avoids constructing Pool on a bad/missing URL
  // and gives the script's own error messages instead of src/db's throw.
  const { db, pool } = await import("../../src/db");
  const { users } = await import("../../src/db/schema");
  const { eq } = await import("drizzle-orm");

  const passwordHash = hashPassword(password);
  console.log(`Seeding ${SEEDS.length} local role accounts into ${hostname} (idempotent by email)...`);
  for (const seed of SEEDS) {
    // Upsert by unique email — idempotent across re-runs.
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, seed.email)).limit(1);
    if (existing.length) {
      await db.update(users).set({ name: seed.name, role: seed.role, passwordHash }).where(eq(users.email, seed.email));
      console.log(`  updated ${seed.role} ${seed.email}`);
    } else {
      await db.insert(users).values({ email: seed.email, name: seed.name, role: seed.role, passwordHash });
      console.log(`  inserted ${seed.role} ${seed.email}`);
    }
  }
  console.log("Seed complete. Passwords are hashed with scrypt; plaintext never stored in repo.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
