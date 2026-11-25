/**
 * Guards for the free-path harness (#226). Pure so they can be tested without a database.
 *
 * The harness is allowed to write synthetic users and readings — but only to a disposable
 * loopback database. A hosted database, a Vercel runtime or NODE_ENV=production must be refused
 * before any import touches `src/db`. Real-provider mode adds its own conditions: explicit
 * authorization, a spend cap, and never in CI.
 */

export type GuardDecision = { ok: true } | { ok: false; reason: string };

export type GuardEnvironment = Record<string, string | undefined>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function databaseHost(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/** Fixture mode: disposable loopback database, never a hosted runtime. */
export function fixtureGuard(env: GuardEnvironment = process.env): GuardDecision {
  const url = env.DATABASE_URL ?? "";
  if (!url) return { ok: false, reason: "DATABASE_URL is required" };
  const host = databaseHost(url);
  if (!host) return { ok: false, reason: "DATABASE_URL is not a valid URL" };
  if (!LOOPBACK.has(host)) return { ok: false, reason: `disposable loopback database only (got ${host})` };
  if (env.VERCEL || env.VERCEL_ENV) return { ok: false, reason: "refusing to run inside Vercel" };
  if (env.NODE_ENV === "production") return { ok: false, reason: "refusing NODE_ENV=production" };
  return { ok: true };
}

/** Real-provider mode: fixture guard plus explicit authorization, a cap, and no CI. */
export function realProviderGuard(
  env: GuardEnvironment,
  options: { authorized: boolean; maxSpendMxn: number; cases: number; ceilingMxn: number },
): GuardDecision {
  const base = fixtureGuard(env);
  if (!base.ok) return base;
  if (env.CI) return { ok: false, reason: "real-provider mode never runs in CI" };
  if (!options.authorized) return { ok: false, reason: "real-provider mode requires --authorize-real" };
  if (!Number.isFinite(options.maxSpendMxn) || options.maxSpendMxn <= 0) {
    return { ok: false, reason: "real-provider mode requires --max-spend-mxn <amount>" };
  }
  const floor = options.cases * options.ceilingMxn;
  if (options.maxSpendMxn < floor) {
    return { ok: false, reason: `--max-spend-mxn ${options.maxSpendMxn} is below the ${options.cases} × ${options.ceilingMxn} MXN ceiling (${floor})` };
  }
  return { ok: true };
}
