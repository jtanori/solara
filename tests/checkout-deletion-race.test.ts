import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

/*
 * The checkout/deletion interleaving (#144).
 *
 * Both routes read their user from `currentUser()` and then do I/O. Nothing
 * serialises them, so a checkout request can authenticate, be overtaken by a
 * deletion, and still create a Stripe customer plus a subscription checkout for
 * an account that no longer exists. `db.update` on a missing row affects zero
 * rows and does not throw, so the old code proceeded silently and Stripe billed
 * a customer nobody owned.
 *
 * This drives the real `startCheckout` handler with a `currentUser` snapshot
 * taken *before* the deletion — the actual shape of the race — and asserts no
 * Stripe write happens. Asserting the guard inline instead would only test the
 * test, which is the mistake that let the audit-row bug survive a green suite.
 */

function fakeStripe(calls: string[], customerId = "cus_race") {
  return {
    prices: {
      retrieve: async (id: string) => {
        calls.push(`prices.retrieve:${id}`);
        return { id, active: true, currency: "mxn", recurring: { interval: "month" }, unit_amount: 1000 };
      },
    },
    customers: {
      create: async () => {
        calls.push("customers.create");
        return { id: customerId };
      },
      del: async (id: string) => {
        calls.push(`customers.del:${id}`);
        return { id };
      },
    },
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({ data: [], has_more: false }),
        create: async () => {
          calls.push("sessions.create");
          return { id: "cs_race", url: "https://checkout.stripe.test/cs_race" };
        },
        expire: async (id: string) => {
          calls.push(`sessions.expire:${id}`);
          return { id };
        },
      },
    },
  };
}

const gated = {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1" ? "needs RUN_INTEGRATION_TESTS=1 and a local database" : false,
};

/**
 * Refuse to touch anything but a local disposable database.
 *
 * This lives above the first write, not inside a helper that runs after it. The
 * earlier version asserted the host in `stageDeletedUser`, which is called after
 * the user row is inserted — so pointing this file at a hosted database would
 * have created and deleted real rows before the check ever ran.
 */
function assertLocalDisposableDatabase() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(`checkout/deletion race tests must run against a local disposable database, got host "${host}"`);
  }
}

async function stageDeletedUser() {
  const { eq } = await import("drizzle-orm");
  const { db, pool } = await import("../src/db");
  const { auditLogs, users } = await import("../src/db/schema");
  const { writeAccountDeletion } = await import("../src/lib/account-deletion");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "Race probe", email: `race-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  // The snapshot the checkout request would have authenticated with.
  const snapshot = { id: user.id, email: `race-${token}@example.test`, role: "user" as const, emailVerifiedAt: new Date(), stripeCustomerId: null };

  // Then the deletion wins, before checkout reaches Stripe.
  await db.transaction(tx => writeAccountDeletion({
    insertAudit: async row => { await tx.insert(auditLogs).values(row); },
    deleteUser: async id => { await tx.delete(users).where(eq(users.id, id)); },
  }, user.id));

  const gone = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
  assert.deepEqual(gone, [], "precondition: the account really is deleted");

  // `pool` is not returned: it is module-level state, and ending it inside a
  // test closes it for every later test in this file.
  return { snapshot, userId: user.id };
}

test("race: a checkout for an account deleted mid-request creates no Stripe customer", gated, async () => {
  // `billingIsConfigured()` requires all three; without them the route 503s
  // before the guard under test is ever reached.
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { startCheckout } = await import("../src/app/api/billing/checkout/route");
  const { snapshot, userId } = await stageDeletedUser();

  const calls: string[] = [];
  const request = new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ currency: "mxn" }),
  });

  // Test 1 must never reach Stripe at all, so the customer id is irrelevant;
  // the default keeps the intent ("no customer is created") obvious.
  const response = await startCheckout(request, {
    stripe: fakeStripe(calls) as never,
    // The race: authenticated before the deletion, so this is a stale user.
    currentUser: (async () => snapshot) as never,
    locale: "en",
  });

  assert.equal(response.status, 401, "a deleted account is refused, not billed");
  assert.deepEqual(
    calls.filter(call => call.startsWith("customers.create") || call.startsWith("sessions.create")),
    [],
    "no Stripe customer and no checkout session for a deleted account",
  );

  // Leave no trace. The race writes an audit row by design; a test that leaves it
  // behind makes every later run — and every local database — accumulate rows.
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs } = await import("../src/db/schema");
  await db.delete(auditLogs).where(eq(auditLogs.target, userId));
});

test("race: an account that still exists does reach Stripe (the guard is not a blanket refusal)", gated, async () => {
  // `billingIsConfigured()` requires all three; without them the route 503s
  // before the guard under test is ever reached.
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { startCheckout } = await import("../src/app/api/billing/checkout/route");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "Live probe", email: `live-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  const calls: string[] = [];
  const customerId = `cus_live_${token}`;
  const request = new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ currency: "mxn" }),
  });

  const response = await startCheckout(request, {
    stripe: fakeStripe(calls, customerId) as never,
    currentUser: (async () => ({ id: user.id, email: `live-${token}@example.test`, role: "user", emailVerifiedAt: new Date(), stripeCustomerId: null })) as never,
    locale: "en",
  });

  assert.equal(response.status, 200, "a live account can still start checkout");
  assert.ok(calls.includes("customers.create"), "the customer was created");
  assert.ok(calls.includes("sessions.create"), "the session was created");

  // This user survives the test (nothing deletes it), and
  // `users.stripe_customer_id` is UNIQUE — a leftover row would make the next
  // run fail on a constraint. Remove it and anything the route attached.
  await db.delete(users).where(eq(users.id, user.id));
});

/*
 * One teardown for the module-level pool. Ending it inside a test closes the
 * shared pool for every later test in the file.
 */
after(async () => {
  if (process.env.RUN_INTEGRATION_TESTS !== "1") return;
  const { pool } = await import("../src/db");
  await pool.end();
});
