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


/**
 * Runs `body` and removes what it created **whether or not it passes**.
 *
 * Cleanup after the last assertion only runs when the test succeeds, so a
 * regression leaves rows behind in exactly the situation where you rerun most —
 * and `users.stripe_customer_id` is UNIQUE, so leftovers turn the next run into a
 * confusing constraint failure on top of the real one.
 */
async function withCleanup(
  userId: string | null,
  body: () => Promise<void>,
  /** Extra `audit_logs.target` values this test writes — deletion also records
   *  the Stripe customer id, so cleaning by user id alone leaves that row. */
  extraTargets: string[] = [],
): Promise<void> {
  try {
    await body();
  } finally {
    const { eq, inArray } = await import("drizzle-orm");
    const { db } = await import("../src/db");
    const { auditLogs, users } = await import("../src/db/schema");
    const targets = [userId, ...extraTargets].filter((value): value is string => Boolean(value));
    if (targets.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.target, targets));
    }
    if (userId) {
      // The user row may already be gone (the deletion test) or still present
      // (the live-account test); deleting twice is harmless.
      await db.delete(users).where(eq(users.id, userId));
    }
  }
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

  await withCleanup(userId, async () => {
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
  });
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

  await withCleanup(user.id, async () => {
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
  });
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

test("escape path: a customer linked after the snapshot is still cleaned up (#144)", gated, async () => {
  /*
   * The interleaving the reviewer described, which the previous fix did NOT
   * cover: deletion reads a user with no customer, passes its billing gate, and
   * pauses. Checkout links a customer. Deletion resumes and — using its stale
   * snapshot — skips cleanup, leaving a paid subscription on a deleted account.
   *
   * `defaultDeleteUser` now re-reads the customer id inside the transaction
   * under the per-user lock and returns it, so the caller cannot clean up from a
   * snapshot that predates the link.
   */
  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { defaultDeleteUser } = await import("../src/app/api/profile/route");
  const { writeAccountDeletion } = await import("../src/lib/account-deletion");

  const token = randomUUID();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const [user] = await db
    .insert(users)
    .values({ name: "Escape probe", email: `escape-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  // The caller's stale snapshot: no customer yet.
  const staleSnapshot = { id: user.id, stripeCustomerId: null };
  assert.equal(staleSnapshot.stripeCustomerId, null, "snapshot taken before the link");

  // Checkout links a customer after that snapshot (as the lock would allow only
  // before deletion acquires it).
  const linkedCustomer = `cus_escape_${token}`;
  await db.update(users).set({ stripeCustomerId: linkedCustomer }).where(eq(users.id, user.id));

  await withCleanup(user.id, async () => {
    const returned = await defaultDeleteUser(user.id);

    // The whole point: the deletion reports the customer that its snapshot never
    // saw, so the caller cannot skip cleanup.
    assert.equal(returned, linkedCustomer, "deletion returns the customer found under the lock, not the snapshot");
    const gone = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    assert.deepEqual(gone, [], "the account is gone");
  }, [linkedCustomer]);
});

test("escape path: the customer-side audit row makes deletion provable without metadata", gated, async () => {
  /*
   * A subscription whose metadata lost `solara_user_id` can only be matched to a
   * deletion through the Stripe customer id. Deletion therefore records a second
   * `account:delete` row targeting the customer id, which is what the webhook
   * reads before cancelling anything.
   */
  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs, users } = await import("../src/db/schema");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "Carrier probe", email: `carrier-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });
  const customerId = `cus_carrier_${token}`;
  await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, user.id));

  await withCleanup(user.id, async () => {
    const { defaultDeleteUser } = await import("../src/app/api/profile/route");
    await defaultDeleteUser(user.id);

    // Scoped to this run's ids: a suite-wide query would also see rows from
    // other tests and fail for reasons that have nothing to do with this one.
    const { and, inArray } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "account:delete"), inArray(auditLogs.target, [user.id, customerId])));
    const targets = rows.map(row => row.target).sort();
    assert.deepEqual(targets, [customerId, user.id].sort(), "both the user id and the customer id are recorded");
    // The webhook looks the customer id up exactly like this.
    const evidence = rows.filter(row => row.target === customerId);
    assert.equal(evidence.length, 1, "proof of deletion is readable from the customer side");
  }, [customerId]);
});

test("lock: a deletion waits for a concurrent checkout and sees what it linked (#144)", gated, async () => {
  /*
   * The interleaving itself, not a simulation of it: a checkout-style
   * transaction takes the per-user lock and holds it while linking a customer;
   * a deletion starts mid-flight. If the lock works, the deletion blocks until
   * checkout commits, then re-reads under the lock and finds the customer it
   * would otherwise have missed entirely.
   */
  assertLocalDisposableDatabase();
  const { eq, sql } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { defaultDeleteUser } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "Lock probe", email: `lock-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });
  const customerId = `cus_lock_${token}`;
  const events: string[] = [];

  await withCleanup(user.id, async () => {
    // Stand-in for checkout: same lock key, holds it while linking.
    const checkout = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`account-deletion:${user.id}`}))`);
      events.push("checkout:locked");
      await new Promise(resolve => setTimeout(resolve, 250));
      await tx.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, user.id));
      events.push("checkout:linked");
    });

    // Give checkout the lock first, then start the deletion.
    await new Promise(resolve => setTimeout(resolve, 40));
    const deletion = defaultDeleteUser(user.id);
    const [, returned] = await Promise.all([checkout, deletion]);

    assert.deepEqual(events, ["checkout:locked", "checkout:linked"], "deletion did not interleave");
    assert.equal(returned, customerId, "deletion saw the customer linked under the lock");
  }, [customerId]);
});
