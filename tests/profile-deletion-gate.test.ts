import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

/*
 * The shipped deletion handler, driven end to end (#142 review, SEC-07).
 *
 * `tests/billing-state.test.ts` proves the page walk is correct, but it fakes
 * the list itself. That file stays green when the route stops calling
 * `assessDeletionBilling` at all — the reviewer demonstrated it: replacing the
 * route's call with a first-page-only read left it at 16 pass / 0 fail.
 *
 * That is the third instance of the same mistake in this PR (after the ordering
 * tautology and the un-driven `defaultDeleteUser`), so the fix is structural
 * rather than another helper: `deleteAccount` now takes its authenticated user,
 * locale, password hash and Stripe client as seams, and these tests drive the
 * real handler with a fake Stripe that counts pages.
 *
 * The invariant under test is the one that matters: a live subscription on any
 * page must block a deletion, and a page walk that gives up must block it too —
 * never the other way round.
 */

const gated = {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1" ? "needs RUN_INTEGRATION_TESTS=1 and a local database" : false,
};

function assertLocalDisposableDatabase() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(`deletion-gate tests must run against a local disposable database, got host "${host}"`);
  }
}

/** A Stripe stub serving `subscriptions` in pages of 100, counting the calls. */
function fakeStripe(options: { subscriptionStatuses: string[]; listThrows?: boolean }) {
  const calls: string[] = [];
  const rows = options.subscriptionStatuses.map((status, index) => ({ id: `sub_${index}`, status }));

  return {
    calls,
    stripe: {
      subscriptions: {
        list: async (params: { starting_after?: string }) => {
          calls.push(`subscriptions.list:${params.starting_after ?? "first"}`);
          if (options.listThrows) throw new Error("stripe unreachable");
          const start = params.starting_after
            ? rows.findIndex(row => row.id === params.starting_after) + 1
            : 0;
          const data = rows.slice(start, start + 100);
          return { data, has_more: start + 100 < rows.length };
        },
      },
      checkout: {
        sessions: {
          list: async () => {
            calls.push("sessions.list");
            return { data: [], has_more: false };
          },
          expire: async (id: string) => {
            calls.push(`sessions.expire:${id}`);
            return { id };
          },
        },
      },
    },
  };
}

/** Inserts a user with a linked customer id, and clears it (audit rows too) in `finally`. */
async function withProbeUser(
  body: (context: { userId: string; customerId: string; email: string }) => Promise<void>,
): Promise<void> {
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs, users } = await import("../src/db/schema");

  const token = randomUUID();
  const email = `gate-${token}@example.test`;
  const customerId = `cus_gate_${token}`;
  const [user] = await db
    .insert(users)
    .values({
      name: "Gate probe",
      email,
      passwordHash: "not-a-login",
      emailVerifiedAt: new Date(),
      stripeCustomerId: customerId,
    })
    .returning({ id: users.id });

  try {
    await body({ userId: user.id, customerId, email });
  } finally {
    // Scoped to this run's ids: a blanket delete on `audit_logs` would also
    // remove rows other tests in this process are asserting on.
    await db.delete(auditLogs).where(inArray(auditLogs.target, [user.id, customerId]));
    await db.delete(users).where(eq(users.id, user.id));
  }
}

/**
 * Drives `deleteAccount` with every side effect injected. `verify` is stubbed
 * because the password gate is covered by `tests/account-deletion.test.ts` and
 * hashing here would only add scrypt cost to the assertion.
 */
async function callDeleteAccount(
  context: { userId: string; email: string },
  stripe: unknown,
  request = new Request("http://localhost/api/profile", {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ password: "correct horse" }),
  }),
) {
  const { deleteAccount } = await import("../src/app/api/profile/route");
  return deleteAccount(request, {
    stripe: stripe as never,
    currentUser: (async () => ({
      id: context.userId,
      email: context.email,
      role: "user",
      emailVerifiedAt: new Date(),
      stripeCustomerId: null,
    })) as never,
    locale: "en",
    verify: (async () => true) as never,
    passwordHashFor: async () => "stored-hash",
  });
}

test("gate: a live subscription on page 2 blocks the deletion (409, not 500)", gated, async () => {
  /*
   * The reviewer's mutation, inverted. 250 subscriptions with the only live one
   * at index 240 means page 3 of 100-per-page. A route that reads only the first
   * page sees 100 cancelled subscriptions, concludes "clear", and deletes the
   * account of a paying customer.
   */
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");

  const statuses = Array.from({ length: 250 }, (_, index) => (index === 240 ? "active" : "canceled"));
  const fake = fakeStripe({ subscriptionStatuses: statuses });

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, fake.stripe);

    assert.equal(response.status, 409, "a live subscription blocks the deletion");
    const bodyText = await response.text();
    assert.match(bodyText, /subscription_ongoing/, "the caller is told why");

    // The page walk really happened: first page plus two cursors.
    assert.deepEqual(
      fake.calls.filter(call => call.startsWith("subscriptions.list")),
      ["subscriptions.list:first", "subscriptions.list:sub_99", "subscriptions.list:sub_199"],
      "walked to page 3 to find the live subscription",
    );

    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "the account was NOT deleted");
  });
});

test("gate: an unreachable Stripe blocks the deletion (503) instead of guessing", gated, async () => {
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");

  const fake = fakeStripe({ subscriptionStatuses: ["active"], listThrows: true });

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, fake.stripe);

    assert.equal(response.status, 503, "an unverifiable billing state fails closed");
    assert.match(await response.text(), /billing_unverifiable/);

    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "failing closed means the account survives");
  });
});

test("gate: no live subscription deletes the account and returns 200", gated, async () => {
  /*
   * The positive control. Without it, the two blocking tests above would pass
   * for a route that simply refuses every deletion.
   */
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs, users } = await import("../src/db/schema");

  const fake = fakeStripe({ subscriptionStatuses: ["canceled", "canceled"] });

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, fake.stripe);

    assert.equal(response.status, 200, "a clear account is deleted");
    const gone = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.deepEqual(gone, [], "the account is gone");

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.target, context.userId));
    assert.equal(rows.length, 1, "the deletion is recorded");
    assert.equal(rows[0].actorId, null, "ON DELETE SET NULL fired on the delete that followed the insert");
  });
});

test("gate: the database is consulted before Stripe (no Stripe call for a known live subscription)", gated, async () => {
  /*
   * Order matters for cost and for truth: the `subscriptions` row is
   * authoritative and free, while Stripe is the slower, sometimes-unreachable
   * second opinion. A live row must block without paying for a Stripe round
   * trip — and must block even if Stripe would have said "clear".
   */
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { db } = await import("../src/db");
  const { subscriptions } = await import("../src/db/schema");

  const fake = fakeStripe({ subscriptionStatuses: [] });

  await withProbeUser(async context => {
    await db.insert(subscriptions).values({
      userId: context.userId,
      stripeSubscriptionId: `sub_gate_${context.userId}`,
      stripeCustomerId: context.customerId,
      // `stripe_price_id`, `status` and `currency` are NOT NULL with no default,
      // so the row must carry them; only `grants_access` defaults.
      stripePriceId: "price_test_mxn",
      status: "active",
      currency: "mxn",
    });

    try {
      const response = await callDeleteAccount(context, fake.stripe);

      assert.equal(response.status, 409, "the database row alone blocks the deletion");
      assert.deepEqual(fake.calls, [], "Stripe was not consulted at all");
    } finally {
      const { eq } = await import("drizzle-orm");
      await db.delete(subscriptions).where(eq(subscriptions.userId, context.userId));
    }
  });
});

/* One teardown for the module-level pool, as in the other DB-gated files. */
after(async () => {
  if (process.env.RUN_INTEGRATION_TESTS !== "1") return;
  const { pool } = await import("../src/db");
  await pool.end();
});

test("gate: a provider call that never resolves blocks the deletion within the deadline (B4)", gated, async () => {
  /*
   * The review's Medium, and my error: `lock_timeout` bounds SQL lock acquisition
   * and `statement_timeout` bounds a running statement. Neither bounds an awaited
   * HTTP call, during which the transaction is idle while holding the advisory
   * lock and a pool connection. The previous test measured a *waiting peer*, not
   * the lifetime of the holder — it never proved the holder is bounded.
   *
   * This test is the holder: a Stripe stub whose promise never settles. The
   * deletion must abandon it at PROVIDER_BILLING_DEADLINE_MS, fail closed, and
   * delete nothing.
   */
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { PROVIDER_BILLING_DEADLINE_MS } = await import("../src/app/api/profile/route");

  const neverResolves = { subscriptions: { list: () => new Promise(() => undefined) } };

  await withProbeUser(async context => {
    const started = Date.now();
    const response = await callDeleteAccount(context, neverResolves);
    const elapsed = Date.now() - started;

    assert.equal(response.status, 503, "a stalled provider fails closed");
    assert.match(await response.text(), /billing_unverifiable/);
    assert.ok(
      elapsed < PROVIDER_BILLING_DEADLINE_MS + 5_000,
      `gave up after ${elapsed}ms, bounded by the ${PROVIDER_BILLING_DEADLINE_MS}ms deadline`,
    );
    assert.ok(elapsed >= PROVIDER_BILLING_DEADLINE_MS - 1_000, `waited for the deadline (${elapsed}ms)`);

    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "nothing was deleted on an unknown billing state");
  });
});
