import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

/*
 * `consumeBudgets` is the function the four metered routes call. Its contract —
 * first refusal stops the chain, empty keys are skipped, every budget is charged
 * before any work runs — needs a database, because the limiter is transactional
 * over `rate_limits`.
 *
 * Everything is imported dynamically, inside the tests: `@/lib/rate-limit`
 * imports `@/db`, which throws at module load when DATABASE_URL is unset. A
 * static import would fail this file on a machine without Postgres even though
 * every test here is skipped. Matches the loopback guard in
 * tests/rate-limit.test.ts.
 */

const loopback = (() => {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(
      new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, ""),
    );
  } catch {
    return false;
  }
})();

async function modules() {
  const [rateLimit, database, schema] = await Promise.all([
    import("../src/lib/rate-limit"),
    import("../src/db"),
    import("../src/db/schema"),
  ]);
  return { ...rateLimit, db: database.db, pool: database.pool, rateLimits: schema.rateLimits };
}

test("budgets: first refusal short-circuits and reports which budget tripped", { skip: !loopback }, async () => {
  const { consumeBudgets, keyFor, db, rateLimits } = await modules();
  const suffix = randomBytes(6).toString("hex");
  const tight = keyFor("test:budget:tight", suffix);
  const loose = keyFor("test:budget:loose", suffix);
  try {
    const budgets = [
      { key: tight, policy: { limit: 1, windowSeconds: 60 }, kind: "tight" },
      { key: loose, policy: { limit: 100, windowSeconds: 60 }, kind: "loose" },
    ];

    assert.equal((await consumeBudgets(budgets)).allowed, true);

    const second = await consumeBudgets(budgets);
    assert.equal(second.allowed, false);
    assert.equal(second.allowed === false && second.kind, "tight", "names the budget that refused");
    assert.ok(second.allowed === false && second.retryAfterSeconds >= 1);

    // The second budget must not have been charged for the refused request: the
    // chain stops at the first refusal.
    const looseOnly = await consumeBudgets([{ key: loose, policy: { limit: 100, windowSeconds: 60 }, kind: "loose" }]);
    assert.equal(looseOnly.allowed, true);
  } finally {
    const { inArray } = await import("drizzle-orm");
    await db.delete(rateLimits).where(inArray(rateLimits.key, [tight, loose]));
  }
});

test("budgets: an empty key is skipped rather than shaming every anonymous caller into one bucket", { skip: !loopback }, async () => {
  const { consumeBudgets } = await modules();
  const decision = await consumeBudgets([{ key: "", policy: { limit: 1, windowSeconds: 60 }, kind: "anonymous" }]);
  assert.equal(decision.allowed, true);
});

test("rateLimitedResponse: 429 with Retry-After, a stable code, and no caching", { skip: !loopback }, async () => {
  const { rateLimitedResponse } = await modules();

  const response = rateLimitedResponse("en", 42);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "42");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json() as { code?: string };
  assert.equal(body.code, "rate_limited", "clients get a stable code, not just prose");

  const es = rateLimitedResponse("es", 0, { en: "custom", es: "personalizado" });
  assert.equal(es.headers.get("Retry-After"), "1", "never tells a client to retry in 0 seconds");
  assert.equal(((await es.json()) as { error?: string }).error, "personalizado");
});

test.after(async () => {
  if (!loopback) return;
  const { pool } = await modules();
  await pool.end();
});
