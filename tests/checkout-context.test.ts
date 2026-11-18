import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before, afterEach } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, coordinationPool } from "../src/db";
import { accountLifecycleLeases, users, readings, rateLimits, paidReadingRuns, readingGenerationRuns, subscriptions } from "../src/db/schema";
import { startCheckout, type CheckoutDeps } from "../src/app/api/billing/checkout/route";
import { keyFor } from "../src/lib/rate-limit";
import { syntheticReadingAccount } from "./helpers/reading-account";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires disposable local PostgreSQL and RUN_INTEGRATION_TESTS=1" };
const envKeys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID_MXN", "APP_URL"];
const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
type Account = Awaited<ReturnType<typeof syntheticReadingAccount>> & { user: typeof users.$inferSelect & { plan: "free" } };
const accounts: Account[] = [];
before(() => { if (enabled) Object.assign(process.env, { STRIPE_SECRET_KEY: "sk_test_context_fixture", STRIPE_WEBHOOK_SECRET: "whsec_context_fixture", STRIPE_PRICE_ID_MXN: "price_context_mxn", APP_URL: "http://localhost:3000" }); });
afterEach(async () => {
  for (const a of accounts.splice(0)) {
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, a.viewer.id));
    await db.delete(rateLimits).where(eq(rateLimits.key, keyFor("billing:checkout:user", a.viewer.id)));
    await a.cleanup();
  }
});
after(async () => { for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } await Promise.all([pool.end(), coordinationPool.end()]); });
async function account(): Promise<Account> {
  const a = await syntheticReadingAccount("en", "none");
  const [user] = await db.select().from(users).where(eq(users.id, a.viewer.id));
  const result = { ...a, user: { ...user, plan: "free" as const } }; accounts.push(result); return result;
}
function fake(options: { existingReading?: string | null; onPrice?: () => Promise<void>; onCreate?: () => Promise<void>; onList?: () => Promise<void> } = {}) {
  const calls: string[] = []; const created: { payload: Record<string, unknown>; idempotencyKey: string }[] = [];
  const stripe = {
    prices: { retrieve: async (id: string) => { calls.push("prices.retrieve"); await options.onPrice?.(); return { id, active: true, currency: "mxn", recurring: { interval: "month" }, unit_amount: 1000 }; } },
    customers: { create: async () => { calls.push("customers.create"); return { id: `cus_${randomUUID()}` }; }, del: async () => { calls.push("customers.del"); } },
    subscriptions: { list: async () => { calls.push("subscriptions.list"); return { data: [], has_more: false }; } },
    checkout: { sessions: {
      list: async () => { calls.push("sessions.list"); await options.onList?.(); return { data: options.existingReading === undefined ? [] : [{ id: "cs_existing", mode: "subscription", currency: "mxn", url: "https://checkout.stripe.test/existing", metadata: options.existingReading ? { solara_reading_id: options.existingReading } : {} }], has_more: false }; },
      create: async (payload: Record<string, unknown>, idempotency: { idempotencyKey: string }) => { calls.push("sessions.create"); created.push({ payload, ...idempotency }); await options.onCreate?.(); return { id: "cs_new", url: "https://checkout.stripe.test/new" }; },
      expire: async () => { calls.push("sessions.expire"); },
    } },
  };
  return { calls, created, stripe: stripe as unknown as CheckoutDeps["stripe"] };
}
function request(body: unknown) { return new Request("http://localhost:3000/api/billing/checkout", { method: "POST", headers: { origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
async function run(a: Awaited<ReturnType<typeof account>>, f: ReturnType<typeof fake>, body: unknown = { currency: "mxn", readingId: a.chart.id }, override?: Request) {
  return startCheckout(override ?? request(body), { stripe: f.stripe, currentUser: async () => a.user, locale: "en" });
}

test("checkout context: strict bounded controls reject invalid currency, fields, UUIDs, malformed and streamed oversize before Stripe", gated, async () => {
  for (const body of [null, [], { currency: "eur" }, { readingId: "https://other.invalid" }, { readingId: "bad" }, { currency: "mxn", locale: "es" }]) {
    const a = await account(); const f = fake(); assert.equal((await run(a, f, body)).status, 400); assert.deepEqual(f.calls, []);
  }
  for (const text of ["{", JSON.stringify({ readingId: "x".repeat(3000) })]) {
    const a = await account(); const f = fake();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
    const req = new Request("http://localhost:3000/api/billing/checkout", { method: "POST", body, headers: { "Content-Length": "2" }, duplex: "half" } as RequestInit);
    assert.equal((await run(a, f, {}, req)).status, 400); assert.deepEqual(f.calls, []);
  }
});

test("checkout context: foreign/missing chart is indistinguishable and never reaches Stripe", gated, async () => {
  const a = await account(); const other = await account(); const f = fake();
  for (const readingId of [other.chart.id, randomUUID()]) assert.equal((await run(a, f, { readingId })).status, 404);
  assert.deepEqual(f.calls, []);
});

test("checkout context: owned chart is bound to metadata, exact return URLs and idempotency, not consent/entitlement/generation", gated, async () => {
  const a = await account(); const f = fake(); const response = await run(a, f);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { url: "https://checkout.stripe.test/new" }); assert.equal(f.created.length, 1);
  const { payload, idempotencyKey } = f.created[0];
  assert.deepEqual(payload.metadata, { solara_user_id: a.viewer.id, solara_reading_id: a.chart.id });
  assert.equal(payload.success_url, `http://localhost:3000/dashboard?billing=success&reading=${a.chart.id}`);
  assert.equal(payload.cancel_url, `http://localhost:3000/pricing?billing=cancelled&reading=${a.chart.id}`);
  assert.ok(idempotencyKey.includes(`-${a.chart.id}-`));
  assert.equal((await db.select().from(subscriptions).where(eq(subscriptions.userId, a.viewer.id))).length, 0);
  assert.equal((await db.select().from(paidReadingRuns).where(eq(paidReadingRuns.userId, a.viewer.id))).length, 0);
  assert.equal((await db.select().from(readingGenerationRuns).where(eq(readingGenerationRuns.userId, a.viewer.id))).length, 0);
});

test("checkout context: matching open checkout is reused; a different or absent context conflicts instead of charging twice", gated, async () => {
  const a = await account();
  const matching = fake({ existingReading: a.chart.id }); assert.equal((await run(a, matching)).status, 200); assert.equal(matching.created.length, 0);
  for (const existingReading of [randomUUID(), null]) {
    const f = fake({ existingReading }); const res = await run(a, f); assert.equal(res.status, 409); assert.equal((await res.json()).code, "checkout_context_conflict"); assert.equal(f.created.length, 0);
  }
  const contextual = fake({ existingReading: a.chart.id }); assert.equal((await run(a, contextual, {})).status, 409); assert.equal(contextual.created.length, 0);
  const general = fake({ existingReading: null }); assert.equal((await run(a, general, {})).status, 200); assert.equal(general.created.length, 0);
});

test("checkout context: chart disappearing before the lease or at the final URL fence is not returned as a payable success", gated, async () => {
  for (const when of ["price", "create", "reuse"] as const) {
    const a = await account(); const remove = async () => { await db.delete(readings).where(eq(readings.id, a.chart.id)); };
    const f = fake(when === "price" ? { onPrice: remove } : when === "create" ? { onCreate: remove } : { existingReading: a.chart.id, onList: remove });
    const response = await run(a, f); assert.equal(response.status, 404, when); assert.equal((await response.json()).url, undefined);
    assert.equal(f.calls.includes("sessions.create"), when === "create"); assert.equal(f.calls.includes("sessions.expire"), when === "create", "newly created payable session is expired before a final-fence failure returns");
    if (when === "price") assert.deepEqual(f.calls, ["prices.retrieve"]);
  }
});
