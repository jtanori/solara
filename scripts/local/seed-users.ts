// Local-only role + subscription fixtures — see #8, #9
// Usage: ALLOW_LOCAL_SEED=true LOCAL_SEED_PASSWORD=... DATABASE_URL=... npm run db:seed:local
// For disposable CI DB (127.0.0.1 with CI=true): ALLOW_LOCAL_SEED_IN_CI=true ALLOW_LOCAL_SEED=true ...
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
// In CI the disposable Postgres is also on 127.0.0.1 — allow with explicit opt-in so #9/#15 can seed the CI DB.
if ((process.env.CI || process.env.VERCEL || process.env.VERCEL_ENV) && process.env.ALLOW_LOCAL_SEED_IN_CI !== "true") {
  fail("Refusing to seed in CI/Vercel environment (ALLOW_LOCAL_SEED is local-only; set ALLOW_LOCAL_SEED_IN_CI=true for disposable CI DB).");
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

// #9 — five subscription-state fixtures (all role=user, free plan; access via subscriptions)
const BILLING_SEEDS: Array<{
  email: string;
  name: string;
  subscription: {
    id: string; // stripeSubscriptionId
    customer: string; // stripeCustomerId
    price: string; // stripePriceId
    status: string;
    grantsAccess: boolean;
    periodEndOffsetDays: number; // relative to now
    cancelAtPeriodEnd?: boolean;
  };
}> = [
  {
    email: "active-premium@solara.local",
    name: "Active Premium",
    subscription: { id: "sub_active_premium_local", customer: "cus_active_premium_local", price: "price_mxn_premium_local", status: "active", grantsAccess: true, periodEndOffsetDays: 30 },
  },
  {
    email: "trialing-premium@solara.local",
    name: "Trialing Premium",
    subscription: { id: "sub_trialing_premium_local", customer: "cus_trialing_premium_local", price: "price_mxn_premium_local", status: "trialing", grantsAccess: true, periodEndOffsetDays: 14 },
  },
  {
    email: "pastdue-premium@solara.local",
    name: "Past Due Premium",
    subscription: { id: "sub_pastdue_premium_local", customer: "cus_pastdue_premium_local", price: "price_mxn_premium_local", status: "past_due", grantsAccess: false, periodEndOffsetDays: 30 },
  },
  {
    email: "expired-premium@solara.local",
    name: "Expired Premium",
    // active but period already ended => hasPremiumAccess must be false
    subscription: { id: "sub_expired_premium_local", customer: "cus_expired_premium_local", price: "price_mxn_premium_local", status: "active", grantsAccess: true, periodEndOffsetDays: -2 },
  },
  {
    email: "canceled-premium@solara.local",
    name: "Canceled Premium",
    subscription: { id: "sub_canceled_premium_local", customer: "cus_canceled_premium_local", price: "price_mxn_premium_local", status: "canceled", grantsAccess: false, periodEndOffsetDays: 30, cancelAtPeriodEnd: true },
  },
];

async function main() {
  // Dynamic imports after guards — avoids constructing Pool on a bad/missing URL
  // and gives the script's own error messages instead of src/db's throw.
  const { db, pool } = await import("../../src/db");
  const { users, subscriptions } = await import("../../src/db/schema");
  const { eq } = await import("drizzle-orm");

  const passwordHash = await hashPassword(password);
  const allSeeds = [...SEEDS, ...BILLING_SEEDS.map(({ email, name }) => ({ email, name, role: "user" as const }))];
  console.log(`Seeding ${allSeeds.length} local accounts (${SEEDS.length} roles + ${BILLING_SEEDS.length} billing fixtures) into ${hostname} (idempotent by email)...`);
  for (const seed of allSeeds) {
    // Upsert by unique email — idempotent across re-runs.
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, seed.email)).limit(1);
    if (existing.length) {
      await db.update(users).set({ name: seed.name, role: seed.role, passwordHash, emailVerifiedAt: new Date() }).where(eq(users.email, seed.email));
      console.log(`  updated ${seed.role} ${seed.email}`);
    } else {
      await db.insert(users).values({ email: seed.email, name: seed.name, role: seed.role, passwordHash, emailVerifiedAt: new Date() });
      console.log(`  inserted ${seed.role} ${seed.email}`);
    }
  }

  // Seed subscription fixtures — idempotent by stripeSubscriptionId
  console.log(`Seeding ${BILLING_SEEDS.length} subscription fixtures...`);
  for (const { email, subscription: s } of BILLING_SEEDS) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      console.warn(`  skip subscription ${s.id}: user ${email} not found`);
      continue;
    }
    const periodEnd = new Date(Date.now() + s.periodEndOffsetDays * 24 * 60 * 60 * 1000);
    const existingSub = await db.select({ id: subscriptions.stripeSubscriptionId }).from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, s.id)).limit(1);
    const values = {
      stripeSubscriptionId: s.id,
      userId: user.id,
      stripeCustomerId: s.customer,
      stripePriceId: s.price,
      status: s.status,
      currency: "mxn",
      grantsAccess: s.grantsAccess,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
    };
    if (existingSub.length) {
      await db.update(subscriptions).set(values).where(eq(subscriptions.stripeSubscriptionId, s.id));
      console.log(`  updated subscription ${s.status} ${s.id} -> ${email} (grantsAccess=${s.grantsAccess}, periodEnd ${s.periodEndOffsetDays > 0 ? "future" : "past"})`);
    } else {
      await db.insert(subscriptions).values(values);
      console.log(`  inserted subscription ${s.status} ${s.id} -> ${email}`);
    }
  }

  console.log("Seed complete. Passwords are hashed with scrypt; plaintext never stored in repo.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
