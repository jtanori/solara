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
    /*
     * Scoped to this run's ids: a blanket delete on `audit_logs` would also
     * remove rows other tests in this process are asserting on.
     *
     * The association row has to go too. A successful deletion writes
     * `deleted_customers` keyed by the customer id, so cleaning only the user and
     * the audit rows left one behind per passing test.
     */
    const { accountLifecycleLeases, deletedCustomers } = await import("../src/db/schema");
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, user.id));
    await db.delete(auditLogs).where(inArray(auditLogs.target, [user.id, customerId]));
    await db.delete(deletedCustomers).where(eq(deletedCustomers.stripeCustomerId, customerId));
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
  extra: Record<string, unknown> = {},
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
    ...extra,
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

test("gate: work that outlives the deadline has NO side effects — expiry happens under the lock (B3)", gated, async () => {
  /*
   * The review's third finding. A deadline races promises; it does not stop work.
   * The assessment used to expire checkout sessions itself, so a slow list could
   * finish *after* the route returned `unverifiable`, after the transaction
   * committed and the lock was released — and expire a session a newer checkout
   * had just created.
   *
   * Two things must hold, and this test asserts both:
   *   1. the assessment itself expires nothing (it is read-only), and
   *   2. once the deadline fires, the guarded client issues no further request.
   */
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { PROVIDER_BILLING_DEADLINE_MS } = await import("../src/app/api/profile/route");

  const calls: string[] = [];
  /*
   * A list that resolves slowly, page after page, and an expire the test can
   * observe. If the assessment expired as it went, `expired` would be non-empty
   * even though the deadline had fired.
   */
  const slowStripe = {
    subscriptions: {
      list: async () => {
        calls.push("subscriptions.list");
        // Slower than the deadline on the first page, so the route gives up.
        await new Promise(resolve => setTimeout(resolve, PROVIDER_BILLING_DEADLINE_MS + 1_000));
        return { data: [], has_more: false };
      },
    },
    checkout: {
      sessions: {
        list: async () => {
          calls.push("sessions.list");
          return { data: [{ id: "cs_after_deadline", mode: "subscription" }], has_more: false };
        },
        expire: async (id: string) => { calls.push(`sessions.expire:${id}`); return { id }; },
      },
    },
  };

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, slowStripe);
    assert.equal(response.status, 503, "the stalled check fails closed");

    // Let the abandoned promise finish if it is going to.
    await new Promise(resolve => setTimeout(resolve, 1_500));

    assert.deepEqual(
      calls.filter(call => call.startsWith("sessions.expire")),
      [],
      "nothing was expired after the deadline, so a newer checkout cannot be raced",
    );
    assert.ok(
      !calls.includes("sessions.list"),
      "once the deadline fires the guarded client issues no further request",
    );

    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "the account survives a failed gate");
  });
});

test("gate: open sessions are expired ONLY on the path that deletes, while holding the lock (B3)", gated, async () => {
  /*
   * The other half: expiry must still happen, or a session created before the
   * deletion becomes a paying checkout for a deleted account. It happens inside
   * `defaultDeleteUser`, after the gate passes, still under the advisory lock.
   */
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  assertLocalDisposableDatabase();
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs, users } = await import("../src/db/schema");
  const { defaultDeleteUser } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      name: "Expiry probe",
      email: `expiry-${token}@example.test`,
      passwordHash: "not-a-login",
      emailVerifiedAt: new Date(),
      stripeCustomerId: `cus_expiry_${token}`,
    })
    .returning({ id: users.id });

  try {
    const expired: string[] = [];
    const result = await defaultDeleteUser(user.id, async () => ({
      state: "clear",
      openSessionIds: ["cs_open_1", "cs_open_2"],
      expireSessions: async ids => { expired.push(...ids); },
    }));

    assert.equal(result.kind, "deleted");
    assert.deepEqual(expired, ["cs_open_1", "cs_open_2"], "the open sessions were expired by the deleting path");
  } finally {
    /*
     * Three keys, because one deletion writes three kinds of row: `target` = the
     * user, `target` = the customer id, and a `deleted_customers` association.
     * Cleaning by user id alone left all of them behind — measured, not assumed.
     */
    const { inArray } = await import("drizzle-orm");
    const { deletedCustomers } = await import("../src/db/schema");
    await db.delete(auditLogs).where(inArray(auditLogs.target, [user.id, `cus_expiry_${token}`]));
    await db.delete(deletedCustomers).where(eq(deletedCustomers.stripeCustomerId, `cus_expiry_${token}`));
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: a customer linked while deletion waits is assessed under the lock", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs, deletedCustomers, users } = await import("../src/db/schema");
  const { withAccountLifecycleLock } = await import("../src/lib/account-lifecycle-lock");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const linkedCustomer = `cus_linked_${token}`;
  const [user] = await db
    .insert(users)
    .values({ name: "Link probe", email: `link-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  let releaseLock!: () => void;
  const lockGate = new Promise<void>(resolve => { releaseLock = resolve; });
  let lockStarted!: () => void;
  const started = new Promise<void>(resolve => { lockStarted = resolve; });

  try {
    const holder = withAccountLifecycleLock(user.id, async () => {
      lockStarted();
      await lockGate;
    }, { waitMs: 2_000 });

    await started;
    const deletion = deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: {
        subscriptions: {
          list: async (params: { customer: string }) => ({
            data: params.customer === linkedCustomer ? [{ id: `sub_linked_${token}`, status: "active" }] : [],
            has_more: false,
          }),
        },
        checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => ({}) } },
      } as never,
      currentUser: (async () => ({
        id: user.id, email: `link-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: null,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });

    await new Promise(resolve => setTimeout(resolve, 100));
    await db.update(users).set({ stripeCustomerId: linkedCustomer }).where(eq(users.id, user.id));
    releaseLock();
    await holder;

    const response = await deletion;
    assert.equal(response.status, 409, "the customer linked under the lock is assessed");
    assert.match(await response.text(), /subscription_ongoing/);
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    assert.equal(survivors.length, 1, "the account survives");
  } finally {
    releaseLock();
    await db.delete(auditLogs).where(inArray(auditLogs.target, [user.id, linkedCustomer]));
    await db.delete(deletedCustomers).where(eq(deletedCustomers.stripeCustomerId, linkedCustomer));
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: owner role is re-read inside the final FOR UPDATE transaction", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const customerId = `cus_role_${token}`;
  const [user] = await db
    .insert(users)
    .values({ name: "Role probe", email: `role-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date(), stripeCustomerId: customerId })
    .returning({ id: users.id });

  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  let first = true;

  try {
    const deletion = deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: {
        subscriptions: {
          list: async () => {
            if (first) { first = false; providerStarted(); await providerGate; }
            return { data: [], has_more: false };
          },
        },
        checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => ({}) } },
      } as never,
      currentUser: (async () => ({
        id: user.id, email: `role-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: customerId,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });

    await started;
    await db.update(users).set({ role: "owner" }).where(eq(users.id, user.id));
    releaseProvider();
    const response = await deletion;

    assert.equal(response.status, 400, "the owner role change is seen under the row lock");
    assert.match(await response.text(), /owner_account/);
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    assert.equal(survivors.length, 1, "the owner account was not deleted");
  } finally {
    releaseProvider();
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: a customer id change between assessment and delete fails closed", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const customerA = `cus_a_${token}`;
  const customerB = `cus_b_${token}`;
  const [user] = await db
    .insert(users)
    .values({ name: "Customer change probe", email: `change-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date(), stripeCustomerId: customerA })
    .returning({ id: users.id });

  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  let first = true;

  try {
    const deletion = deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: {
        subscriptions: {
          list: async () => {
            if (first) { first = false; providerStarted(); await providerGate; }
            return { data: [], has_more: false };
          },
        },
        checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => ({}) } },
      } as never,
      currentUser: (async () => ({
        id: user.id, email: `change-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: customerA,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });

    await started;
    await db.update(users).set({ stripeCustomerId: customerB }).where(eq(users.id, user.id));
    releaseProvider();
    const response = await deletion;

    assert.equal(response.status, 503, "a customer change fails closed");
    assert.match(await response.text(), /billing_unverifiable/);
    const survivors = await db.select({ id: users.id, stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.id, user.id));
    assert.equal(survivors.length, 1, "the account survives");
    assert.equal(survivors[0]?.stripeCustomerId, customerB);
  } finally {
    releaseProvider();
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: an expiry failure blocks the deletion instead of deleting a payable account", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { auditLogs, users } = await import("../src/db/schema");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const customerId = `cus_expire_fail_${token}`;
  const [user] = await db
    .insert(users)
    .values({ name: "Expiry failure probe", email: `expire-fail-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date(), stripeCustomerId: customerId })
    .returning({ id: users.id });

  try {
    const response = await deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: {
        subscriptions: { list: async () => ({ data: [], has_more: false }) },
        checkout: {
          sessions: {
            list: async () => ({ data: [{ id: "cs_expire_fail", mode: "subscription" }], has_more: false }),
            expire: async () => { throw Object.assign(new Error("stripe unavailable"), { statusCode: 503 }); },
          },
        },
      } as never,
      currentUser: (async () => ({
        id: user.id, email: `expire-fail-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: customerId,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });

    assert.equal(response.status, 503, "an unexpired open session fails closed");
    assert.match(await response.text(), /billing_unverifiable/);
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    assert.equal(survivors.length, 1, "the account survives");
    const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.target, user.id));
    assert.equal(audits.length, 0, "no deletion audit was written");
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: a user who vanished while waiting returns 401, not a false deletion", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { withAccountLifecycleLock } = await import("../src/lib/account-lifecycle-lock");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "Gone probe", email: `gone-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  let releaseLock!: () => void;
  const lockGate = new Promise<void>(resolve => { releaseLock = resolve; });
  let lockStarted!: () => void;
  const started = new Promise<void>(resolve => { lockStarted = resolve; });

  try {
    const holder = withAccountLifecycleLock(user.id, async () => {
      lockStarted();
      await lockGate;
    }, { waitMs: 2_000 });

    await started;
    const deletion = deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: { subscriptions: { list: async () => ({ data: [], has_more: false }) }, checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } } } as never,
      currentUser: (async () => ({
        id: user.id, email: `gone-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: null,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });

    await new Promise(resolve => setTimeout(resolve, 100));
    await db.delete(users).where(eq(users.id, user.id));
    releaseLock();
    await holder;

    const response = await deletion;
    assert.equal(response.status, 401, "a vanished user is refused");
  } finally {
    releaseLock();
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: the final transaction re-checks the database subscription row", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { subscriptions, users } = await import("../src/db/schema");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const customerId = `cus_final_${token}`;
  const [user] = await db
    .insert(users)
    .values({ name: "Final check probe", email: `final-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date(), stripeCustomerId: customerId })
    .returning({ id: users.id });

  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  let first = true;

  try {
    const deletion = deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: {
        subscriptions: {
          list: async () => {
            if (first) { first = false; providerStarted(); await providerGate; }
            return { data: [], has_more: false };
          },
        },
        checkout: { sessions: { list: async () => ({ data: [], has_more: false }), expire: async () => ({}) } },
      } as never,
      currentUser: (async () => ({
        id: user.id, email: `final-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: customerId,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });

    await started;
    await db.insert(subscriptions).values({
      userId: user.id,
      stripeSubscriptionId: `sub_final_${token}`,
      stripeCustomerId: customerId,
      stripePriceId: "price_test_mxn",
      status: "active",
      currency: "mxn",
    });
    releaseProvider();
    const response = await deletion;

    assert.equal(response.status, 409, "the final database re-check blocks the deletion");
    assert.match(await response.text(), /subscription_ongoing/);
  } finally {
    releaseProvider();
    await db.delete(subscriptions).where(eq(subscriptions.userId, user.id));
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: the final FOR UPDATE timeout fails closed instead of hanging", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { Pool } = await import("pg");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "Final lock probe", email: `final-lock-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  const holder = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    application_name: `solara-final-lock-test-${token}`,
    allowExitOnIdle: true,
  });
  const client = await holder.connect();

  try {
    await client.query("begin");
    await client.query("select 1 from users where id = $1 for update", [user.id]);

    const started = Date.now();
    const response = await deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: { subscriptions: { list: async () => ({ data: [], has_more: false }) }, checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } } } as never,
      currentUser: (async () => ({
        id: user.id, email: `final-lock-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: null,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });
    const elapsed = Date.now() - started;

    assert.equal(response.status, 503, "a held row lock is retryable");
    assert.ok(elapsed < 15_000, `gave up after ${elapsed}ms instead of hanging`);
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id));
    assert.equal(survivors.length, 1, "nothing was deleted");
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await holder.end();
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: an unavailable coordination pool returns 503 without touching the account", gated, async () => {
  assertLocalDisposableDatabase();
  const { randomUUID } = await import("node:crypto");
  const { CoordinationPoolUnavailable } = await import("../src/lib/account-lifecycle-lock");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const response = await deleteAccount(new Request("http://localhost/api/profile", {
    method: "DELETE",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ password: "correct horse" }),
  }), {
    stripe: { subscriptions: { list: async () => ({ data: [], has_more: false }) }, checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } } } as never,
    currentUser: (async () => ({
      id: randomUUID(), email: "pool@example.test", role: "user" as const,
      emailVerifiedAt: new Date(), stripeCustomerId: null,
    })) as never,
    locale: "en",
    verify: (async () => true) as never,
    passwordHashFor: async () => "stored-hash",
    lifecycleLock: (async () => { throw new CoordinationPoolUnavailable(); }) as never,
  });

  assert.equal(response.status, 503);
  assert.match(await response.text(), /service is busy|servicio está ocupado/i);
});

test("gate: FOR UPDATE serialises a concurrent role change before the delete", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");
  const { Pool } = await import("pg");
  const { deleteAccount } = await import("../src/app/api/profile/route");

  const token = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ name: "FOR UPDATE probe", email: `for-update-${token}@example.test`, passwordHash: "not-a-login", emailVerifiedAt: new Date() })
    .returning({ id: users.id });

  const holder = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    application_name: `solara-row-lock-test-${token}`,
    allowExitOnIdle: true,
  });
  const client = await holder.connect();

  try {
    await client.query("begin");
    await client.query("update users set role = 'owner' where id = $1", [user.id]);

    const deletion = deleteAccount(new Request("http://localhost/api/profile", {
      method: "DELETE",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ password: "correct horse" }),
    }), {
      stripe: { subscriptions: { list: async () => ({ data: [], has_more: false }) }, checkout: { sessions: { list: async () => ({ data: [], has_more: false }) } } } as never,
      currentUser: (async () => ({
        id: user.id, email: `for-update-${token}@example.test`, role: "user" as const,
        emailVerifiedAt: new Date(), stripeCustomerId: null,
      })) as never,
      locale: "en",
      verify: (async () => true) as never,
      passwordHashFor: async () => "stored-hash",
    });

    await new Promise(resolve => setTimeout(resolve, 200));
    await client.query("commit");

    const response = await deletion;
    assert.equal(response.status, 400, "the committed owner role is seen after the row lock wait");
    assert.match(await response.text(), /owner_account/);
    const survivors = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, user.id));
    assert.equal(survivors.length, 1, "the owner account was not deleted");
    assert.equal(survivors[0]?.role, "owner");
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await holder.end();
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("gate: too many open sessions fails closed before expiring anything", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { accountLifecycleLeases, auditLogs, users } = await import("../src/db/schema");
  const expired: string[] = [];

  const stripe = {
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({
          data: ["cs_cap_1", "cs_cap_2", "cs_cap_3"].map(id => ({ id, mode: "subscription" })),
          has_more: false,
        }),
        expire: async (id: string) => { expired.push(id); return { id }; },
      },
    },
  };

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, stripe, undefined, { maxExpirySessions: 2 });
    assert.equal(response.status, 503, "the cap fails closed");
    assert.match(await response.text(), /billing_unverifiable/);
    assert.deepEqual(expired, [], "nothing was expired before the cap was enforced");
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "the account survives");
    const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.target, context.userId));
    assert.equal(audits.length, 0, "no deletion audit was written");
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, context.userId));
  });
});

test("gate: expiry deadline waits for the in-flight call before releasing the lease", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { accountLifecycleLeases, auditLogs, users } = await import("../src/db/schema");
  let settled = false;

  const stripe = {
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({ data: [{ id: "cs_deadline", mode: "subscription" }], has_more: false }),
        expire: async () => {
          await new Promise(resolve => setTimeout(resolve, 150));
          settled = true;
          return {};
        },
      },
    },
  };

  await withProbeUser(async context => {
    const started = Date.now();
    const response = await callDeleteAccount(context, stripe, undefined, { expiryDeadlineMs: 40 });
    const elapsed = Date.now() - started;

    assert.equal(response.status, 503, "the deadline fails closed");
    assert.equal(settled, true, "the route waited for the in-flight expiry to settle");
    assert.ok(elapsed >= 130, `returned after ${elapsed}ms; a 40ms deadline must not release a running expiry`);
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "the account survives");
    const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.target, context.userId));
    assert.equal(audits.length, 0, "no deletion audit was written");
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, context.userId));
  });
});

test("gate: checkout_session_not_open with an expired session is settled, not fatal", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { accountLifecycleLeases, users } = await import("../src/db/schema");

  const stripe = {
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({ data: [{ id: "cs_not_open_expired", mode: "subscription" }], has_more: false }),
        expire: async () => {
          throw Object.assign(new Error("not open"), { code: "checkout_session_not_open" });
        },
        retrieve: async () => ({ status: "expired" }),
      },
    },
  };

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, stripe);
    assert.equal(response.status, 200, "an expired session needs no further action");
    const gone = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.deepEqual(gone, [], "the account was deleted");
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, context.userId));
  });
});

test("gate: checkout_session_not_open with a complete or open session fails closed", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { accountLifecycleLeases, auditLogs, users } = await import("../src/db/schema");

  for (const status of ["complete", "open"] as const) {
    const stripe = {
      subscriptions: { list: async () => ({ data: [], has_more: false }) },
      checkout: {
        sessions: {
          list: async () => ({ data: [{ id: `cs_not_open_${status}`, mode: "subscription" }], has_more: false }),
          expire: async () => {
            throw Object.assign(new Error("not open"), { code: "checkout_session_not_open" });
          },
          retrieve: async () => ({ status }),
        },
      },
    };

    await withProbeUser(async context => {
      const response = await callDeleteAccount(context, stripe);
      assert.equal(response.status, 503, `a ${status} session is still payable`);
      assert.match(await response.text(), /billing_unverifiable/);
      const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
      assert.equal(survivors.length, 1, "the account survives");
      const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.target, context.userId));
      assert.equal(audits.length, 0, "no deletion audit was written");
      await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, context.userId));
    });
  }
});

test("gate: a lease that expires during the provider check blocks the delete", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { accountLifecycleLeases, auditLogs, users } = await import("../src/db/schema");
  const { withAccountLifecycleLock } = await import("../src/lib/account-lifecycle-lock");

  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  let providerStarted!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  const expired: string[] = [];

  const stripe = {
    subscriptions: {
      list: async () => {
        providerStarted();
        await providerGate;
        return { data: [], has_more: false };
      },
    },
    checkout: {
      sessions: {
        list: async () => ({ data: [{ id: "cs_expired_lease", mode: "subscription" }], has_more: false }),
        expire: async (id: string) => { expired.push(id); return { id }; },
      },
    },
  };

  const lifecycleLock: typeof withAccountLifecycleLock = (userId, fn, deps) =>
    withAccountLifecycleLock(userId, fn, {
      ...deps,
      ttlMs: 100,
      heartbeatMs: 10_000,
      advisoryCompat: false,
    });

  await withProbeUser(async context => {
    const deletion = callDeleteAccount(context, stripe, undefined, { lifecycleLock });
    await started;
    await new Promise(resolve => setTimeout(resolve, 180));
    releaseProvider();

    const response = await deletion;
    assert.equal(response.status, 503, "the expired lease fails closed");
    assert.deepEqual(expired, [], "no Stripe write is made after the lease is lost");
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "nothing was deleted");
    const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.target, context.userId));
    assert.equal(audits.length, 0, "no deletion audit was written");
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, context.userId));
  });
});

test("gate: a lease lost during expiry stops before the next session", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { accountLifecycleLeases, auditLogs, users } = await import("../src/db/schema");
  const { withAccountLifecycleLock } = await import("../src/lib/account-lifecycle-lock");

  const expired: string[] = [];
  const stripe = {
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({
          data: [
            { id: "cs_first_expiry", mode: "subscription" },
            { id: "cs_second_expiry", mode: "subscription" },
          ],
          has_more: false,
        }),
        expire: async (id: string) => {
          expired.push(id);
          await new Promise(resolve => setTimeout(resolve, 1_200));
          return { id };
        },
      },
    },
  };

  const lifecycleLock: typeof withAccountLifecycleLock = (userId, fn, deps) =>
    withAccountLifecycleLock(userId, fn, {
      ...deps,
      ttlMs: 1_000,
      heartbeatMs: 10_000,
      advisoryCompat: false,
    });

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, stripe, undefined, { lifecycleLock });
    assert.equal(response.status, 503, "the expired lease fails closed");
    assert.deepEqual(expired, ["cs_first_expiry"], "no second session is expired after takeover");
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "nothing was deleted");
    const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.target, context.userId));
    assert.equal(audits.length, 0, "no deletion audit was written");
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, context.userId));
  });
});

test("gate: a bare 404 from expire is unverifiable, not gone", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { accountLifecycleLeases, auditLogs, users } = await import("../src/db/schema");

  const stripe = {
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({ data: [{ id: "cs_bare_404", mode: "subscription" }], has_more: false }),
        expire: async () => {
          throw Object.assign(new Error("Not Found"), { statusCode: 404 });
        },
      },
    },
  };

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, stripe);
    assert.equal(response.status, 503, "an unidentified 404 fails closed");
    assert.match(await response.text(), /billing_unverifiable/);
    const survivors = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.equal(survivors.length, 1, "nothing was deleted");
    const audits = await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.target, context.userId));
    assert.equal(audits.length, 0, "no deletion audit was written");
    await db.delete(accountLifecycleLeases).where(eq(accountLifecycleLeases.userId, context.userId));
  });
});

test("gate: resource_missing from expire is settled", gated, async () => {
  assertLocalDisposableDatabase();
  process.env.STRIPE_SECRET_KEY ??= "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_test_placeholder";
  process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../src/db");
  const { users } = await import("../src/db/schema");

  const stripe = {
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({ data: [{ id: "cs_resource_missing", mode: "subscription" }], has_more: false }),
        expire: async () => {
          throw Object.assign(new Error("No such checkout session"), { statusCode: 404, code: "resource_missing" });
        },
      },
    },
  };

  await withProbeUser(async context => {
    const response = await callDeleteAccount(context, stripe);
    assert.equal(response.status, 200, "Stripe's resource-missing response settles the session");
    const gone = await db.select({ id: users.id }).from(users).where(eq(users.id, context.userId));
    assert.deepEqual(gone, [], "the account was deleted");
  });
});
