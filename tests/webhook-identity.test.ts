import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

/*
 * The webhook's real database wiring, driven end to end (#142 review, High).
 *
 * `tests/stripe-sync-outcomes.test.ts` proves the *core* logic with a hand-built
 * ports object — including that a subscription which is not ours is never
 * cancelled. But the core reads its answer from a port, and the production
 * implementation of that port lives in `stripe-sync.ts`. A test of the core
 * cannot see `wasAccountDeleted` decide to trust a customer-level match, which is
 * exactly the defect that was reported.
 *
 * This file exists because a mutation proved the gap: reverting the production
 * `wasAccountDeleted` to a customer-only match left every webhook test green.
 *
 * Only the Stripe client is faked. The transaction, the audit rows, the price
 * check and the ownership resolution are the shipped code.
 */

/*
 * `isPremiumPrice` reads the configured price ids at call time, and the fake
 * Stripe reports whatever price this file passes. Both must be the same string,
 * so it is pinned here rather than inherited from whatever order the suite runs
 * in — the first version of this file read `process.env.STRIPE_PRICE_ID_MXN`
 * before another file had set it, and two tests failed for that reason alone.
 */
const PREMIUM_PRICE = "price_test_mxn";
process.env.STRIPE_PRICE_ID_MXN ??= PREMIUM_PRICE;

const gated = {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1" ? "needs RUN_INTEGRATION_TESTS=1 and a local database" : false,
};

function assertLocalDisposableDatabase() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(`webhook identity tests must run against a local disposable database, got host "${host}"`);
  }
}

/** A Stripe stub exposing only what `processStripeEvent` actually calls. */
function fakeStripe(options: {
  subscriptionId: string;
  customerId: string;
  priceId: string;
  status?: string;
  metadata?: Record<string, string>;
  customerUserId?: string | null;
  cancelFails?: "already-canceled" | "other" | "missing";
}) {
  const calls = { cancelled: [] as string[], retrievedCustomers: [] as string[] };

  return {
    calls,
    stripe: {
      subscriptions: {
        retrieve: async (id: string) => ({
          id,
          customer: options.customerId,
          status: options.status ?? "active",
          metadata: options.metadata ?? {},
          items: { data: [{ price: { id: options.priceId, currency: "mxn" }, current_period_end: null }] },
          cancel_at_period_end: false,
        }),
        cancel: async (id: string) => {
          calls.cancelled.push(id);
          if (options.cancelFails === "already-canceled") {
            throw Object.assign(new Error("This subscription has already been canceled."), { statusCode: 400 });
          }
          if (options.cancelFails === "missing") {
            throw Object.assign(new Error("No such subscription"), { statusCode: 404, code: "resource_missing" });
          }
          if (options.cancelFails === "other") {
            throw Object.assign(new Error("Stripe is down"), { statusCode: 500 });
          }
          return { id, status: "canceled" };
        },
      },
      customers: {
        retrieve: async (id: string) => {
          calls.retrievedCustomers.push(id);
          if (options.customerUserId === null) return { id, deleted: true };
          return { id, deleted: false, metadata: { solara_user_id: options.customerUserId ?? "" } };
        },
      },
    },
  };
}

/** Runs one subscription event through the shipped handler, cleaning up after itself. */
async function withEvent(
  setup: {
    /** Write the carrier row a deletion leaves behind, for this customer id. */
    recordDeletionFor: { userId: string; customerId: string; carrier: boolean };
    subscription: Parameters<typeof fakeStripe>[0];
  },
  body: (result: { outcome: unknown; calls: ReturnType<typeof fakeStripe>["calls"] }) => Promise<void>,
): Promise<void> {
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs, stripeEvents, subscriptions, users } = await import("../src/db/schema");
  const { processStripeEvent } = await import("../src/lib/stripe-sync");

  const eventId = `evt_${randomUUID()}`;
  const { userId, customerId, carrier } = setup.recordDeletionFor;

  // The evidence a completed deletion leaves: target = deleted user id, and when
  // a customer was linked, a second row targeting the customer id.
  await db.insert(auditLogs).values({ actorId: null, action: "account:delete", target: userId });
  if (carrier) {
    await db.insert(auditLogs).values({ actorId: null, action: "account:delete", target: customerId });
  }

  const fake = fakeStripe(setup.subscription);

  try {
    // No owner can match: there is no such user row.
    const outcome = await processStripeEvent(
      // `subscriptionIdFrom` reads `event.data.object.id`, so the event needs the
      // subscription shape even though the core re-reads it from Stripe.
      {
        id: eventId,
        type: "customer.subscription.updated",
        data: { object: { id: setup.subscription.subscriptionId } },
      } as never,
      fake.stripe as never,
    );
    await body({ outcome, calls: fake.calls });
  } finally {
    await db.delete(stripeEvents).where(eq(stripeEvents.id, eventId));
    /*
     * Three keys, not two. The webhook records `webhook:*` rows against the
     * SUBSCRIPTION id, so cleaning only the user and customer ids leaves one row
     * per event behind. Measured, not assumed: the first version of this file
     * added 4 leaked rows to the suite total.
     */
    await db.delete(auditLogs).where(
      inArray(auditLogs.target, [userId, customerId, setup.subscription.subscriptionId]),
    );
    await db.delete(subscriptions).where(eq(subscriptions.stripeSubscriptionId, setup.subscription.subscriptionId));
    await db.delete(users).where(eq(users.id, userId));
  }
}

test("wiring: a subscription WITHOUT a metadata user id is not cancelled on a customer-only match", gated, async () => {
  /*
   * The reported defect, at the layer that had it. The customer id has a deletion
   * carrier row, but the Stripe customer's own `solara_user_id` names some other
   * account — so the two identities do not correspond, and this subscription is
   * not proven to be the deleted account's.
   *
   * Reverting `wasAccountDeleted` to a customer-only match turns this test red;
   * before this file existed, that mutation left every webhook test green.
   */
  assertLocalDisposableDatabase();
  const token = randomUUID();
  const userId = randomUUID();
  const customerId = `cus_identity_${token}`;

  await withEvent({
    recordDeletionFor: { userId, customerId, carrier: true },
    subscription: {
      subscriptionId: `sub_identity_${token}`,
      customerId,
      priceId: PREMIUM_PRICE,
      metadata: {},
      // A different account owns this customer: correspondence fails.
      customerUserId: randomUUID(),
    },
  }, async ({ outcome, calls }) => {
    assert.deepEqual(calls.cancelled, [], "no cancellation without matching identities");
    assert.equal((outcome as { status: string }).status, "unmapped");
  });
});

test("wiring: a subscription is cancelled when the customer's own id is the deleted account", gated, async () => {
  /*
   * The positive control. Without it, the test above would pass for a system that
   * never cancels anything.
   */
  assertLocalDisposableDatabase();
  const token = randomUUID();
  const userId = randomUUID();
  const customerId = `cus_identity_ok_${token}`;

  await withEvent({
    recordDeletionFor: { userId, customerId, carrier: true },
    subscription: {
      subscriptionId: `sub_identity_ok_${token}`,
      customerId,
      priceId: PREMIUM_PRICE,
      metadata: {},
      customerUserId: userId,
    },
  }, async ({ outcome, calls }) => {
    assert.deepEqual(calls.cancelled, [`sub_identity_ok_${token}`], "the proven subscription is cancelled");
    assert.equal((outcome as { cancelled?: boolean }).cancelled, true);
  });
});

test("wiring: a subscription for another product is not cancelled even with a deleted customer", gated, async () => {
  /*
   * The shared-Stripe-account case. The identities correspond, but the price is
   * not one of ours, so it is not our subscription to cancel.
   */
  assertLocalDisposableDatabase();
  const token = randomUUID();
  const userId = randomUUID();
  const customerId = `cus_identity_other_${token}`;

  await withEvent({
    recordDeletionFor: { userId, customerId, carrier: true },
    subscription: {
      subscriptionId: `sub_identity_other_${token}`,
      customerId,
      priceId: "price_other_product",
      metadata: {},
      customerUserId: userId,
    },
  }, async ({ calls }) => {
    assert.deepEqual(calls.cancelled, [], "another product's subscription is not ours");
  });
});

test("wiring: retrying after Stripe says 'already canceled' is completion, not a 500 loop", gated, async () => {
  /*
   * The redelivery case at the wiring layer: the subscription is proven and ours,
   * but Stripe reports the cancellation already happened. Throwing here would make
   * the route 500 forever.
   */
  assertLocalDisposableDatabase();
  const token = randomUUID();
  const userId = randomUUID();
  const customerId = `cus_identity_retry_${token}`;

  await withEvent({
    recordDeletionFor: { userId, customerId, carrier: true },
    subscription: {
      subscriptionId: `sub_identity_retry_${token}`,
      customerId,
      priceId: PREMIUM_PRICE,
      metadata: { solara_user_id: userId },
      customerUserId: userId,
      cancelFails: "already-canceled",
    },
  }, async ({ outcome }) => {
    assert.equal((outcome as { cancelled?: boolean }).cancelled, true, "already canceled counts as done");
  });
});

after(async () => {
  if (process.env.RUN_INTEGRATION_TESTS !== "1") return;
  const { pool } = await import("../src/db");
  await pool.end();
});
