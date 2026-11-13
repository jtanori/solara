import assert from "node:assert/strict";

/*
 * `isPremiumPriceId` reads the configured prices from the environment at call
 * time, so this file must pin them rather than inherit whatever the suite set
 * earlier. Learned the hard way: the cleanup tests failed on their own fixtures
 * because another file had set a different price id first.
 */
process.env.STRIPE_PRICE_ID_MXN ??= "price_test_mxn";
import test from "node:test";
import { assessBillingGate } from "../src/lib/account-deletion";
import {
  anyAcrossPages,
  assessDeletionBilling,
  cancelBillingForDeletedAccount,
  collectAcrossPages,
  hasOngoingSubscription,
  isOngoingStatus,
  MAX_BILLING_PAGES,
  ONGOING_SUBSCRIPTION_STATUSES,
} from "../src/lib/billing-state";

/*
 * The deletion gate decides "is money moving?" from these lists. Reading only
 * the first page answered that question wrong for any customer with more than
 * one page of records: a live subscription on page 2 was invisible, so the
 * account was deleted with a paying customer still attached to it.
 *
 * These tests fake the paginated list itself, not Stripe, so the page walk is
 * the thing under test.
 */

type Row = { id: string; status?: string };

/** Serves `rows` in pages of `size`, honouring the `starting_after` cursor. */
function paged(rows: Row[], size: number) {
  const calls: Array<string | undefined> = [];
  const fetchPage = async (startingAfter: string | undefined) => {
    calls.push(startingAfter);
    const start = startingAfter ? rows.findIndex(row => row.id === startingAfter) + 1 : 0;
    const data = rows.slice(start, start + size);
    return { data, has_more: start + size < rows.length };
  };
  return { calls, fetchPage };
}

test("billing pages: a record on a later page is found (this is the bug that was live)", async () => {
  // 250 subs with the only live one at index 240 — page 3 at 100 per page.
  const rows: Row[] = Array.from({ length: 250 }, (_, index) => ({
    id: `sub_${index}`,
    status: index === 240 ? "active" : "canceled",
  }));
  const { calls, fetchPage } = paged(rows, 100);

  const found = await anyAcrossPages(fetchPage, subscription => isOngoingStatus(subscription.status!));

  assert.equal(found, true, "a live subscription on page 3 must still block deletion");
  assert.equal(calls.length, 3, "walked three pages; a first-page-only read would see only 1");
});

test("billing pages: all-clear is only reported after the last page", async () => {
  const rows: Row[] = Array.from({ length: 250 }, (_, index) => ({ id: `sub_${index}`, status: "canceled" }));
  const { calls, fetchPage } = paged(rows, 100);

  const found = await anyAcrossPages(fetchPage, subscription => isOngoingStatus(subscription.status!));

  assert.equal(found, false);
  assert.equal(calls.length, 3, "cannot conclude 'clear' from page 1 alone");
});

test("billing pages: stops at the first match instead of paying for the rest", async () => {
  const rows: Row[] = Array.from({ length: 300 }, (_, index) => ({
    id: `sub_${index}`,
    status: index === 5 ? "past_due" : "canceled",
  }));
  const { calls, fetchPage } = paged(rows, 100);

  assert.equal(await anyAcrossPages(fetchPage, subscription => isOngoingStatus(subscription.status!)), true);
  assert.equal(calls.length, 1, "the match was on page 1, so no further pages are fetched");
});

test("billing pages: open subscription checkouts are collected from every page", async () => {
  // Only the last page holds a subscription-mode session; earlier pages are
  // one-off payments, which must not be expired.
  const rows: Row[] = Array.from({ length: 220 }, (_, index) => ({ id: `cs_${index}` }));
  const { calls, fetchPage } = paged(rows, 100);

  const sessions = await collectAcrossPages(fetchPage, session => session.id === "cs_215");

  assert.deepEqual(sessions.map(session => session.id), ["cs_215"]);
  assert.equal(calls.length, 3);
});

test("billing pages: a list that never ends fails closed instead of guessing", async () => {
  // has_more forever — the cap must throw, and the route turns a throw into
  // `unverifiable`, which blocks the deletion.
  let n = 0;
  const fetchPage = async () => ({ data: [{ id: `sub_${n++}`, status: "canceled" }], has_more: true });

  // Nothing ever matches, so the walk can only end by running out of pages.
  await assert.rejects(
    anyAcrossPages(fetchPage, () => false),
    /exceeded 10 pages|refusing to guess/,
  );

  assert.equal(n, MAX_BILLING_PAGES, "stopped at the cap rather than looping forever");
});

test("billing pages: an empty page claiming more data fails closed", async () => {
  const fetchPage = async () => ({ data: [], has_more: true });
  await assert.rejects(anyAcrossPages(fetchPage, () => true), /has_more with an empty page/);
});

test("billing statuses: the ongoing set and the predicate agree", () => {
  for (const status of ONGOING_SUBSCRIPTION_STATUSES) {
    assert.equal(isOngoingStatus(status), true, `${status} blocks deletion`);
  }
  for (const status of ["canceled", "incomplete_expired", "ended"]) {
    assert.equal(isOngoingStatus(status), false, `${status} does not block deletion`);
  }
  assert.equal(hasOngoingSubscription([{ status: "canceled" }, { status: "active" }]), true);
  assert.equal(hasOngoingSubscription([]), false);
});

// ---------------------------------------------------------------- route wiring

/*
 * The pagination tests above prove the helper walks pages. They cannot see the
 * route's wiring: the customer id it passes, the `status` filters, whether
 * `starting_after` is forwarded, or which sessions it expires. These drive
 * `assessDeletionBilling` — the function the route now calls — with a fake
 * Stripe, so a bad parameter is a failing test rather than a production bug.
 */

function fakeStripe(options: {
  subscriptions?: Array<{ id: string; status: string }>;
  sessions?: Array<{ id: string; mode: string }>;
  pageSize?: number;
  throwOnSubscriptions?: boolean;
}) {
  const subRows = options.subscriptions ?? [];
  const sessionRows = options.sessions ?? [];
  const size = options.pageSize ?? 100;
  const calls = {
    subscriptionParams: [] as Array<Record<string, unknown>>,
    sessionParams: [] as Array<Record<string, unknown>>,
    expired: [] as string[],
  };

  const page = <T extends { id: string }>(rows: T[], after: string | undefined) => {
    const start = after ? rows.findIndex(row => row.id === after) + 1 : 0;
    return { data: rows.slice(start, start + size), has_more: start + size < rows.length };
  };

  const stripe = {
    subscriptions: {
      list: async (params: Record<string, unknown>) => {
        calls.subscriptionParams.push(params);
        if (options.throwOnSubscriptions) throw new Error("stripe unreachable");
        return page(subRows, params.starting_after as string | undefined);
      },
    },
    checkout: {
      sessions: {
        list: async (params: Record<string, unknown>) => {
          calls.sessionParams.push(params);
          return page(sessionRows, params.starting_after as string | undefined);
        },
        expire: async (id: string) => {
          calls.expired.push(id);
          return { id, status: "expired" };
        },
      },
    },
  };
  return { calls, stripe };
}

test("wiring: passes the customer id and status filters Stripe expects", async () => {
  const { calls, stripe } = fakeStripe({});
  await assessDeletionBilling(stripe as never, "cus_abc");

  // Two subscription reads by design: one before expiring open sessions, one
  // after, so a session that completes mid-sweep is still caught.
  assert.equal(calls.subscriptionParams.length, 2);
  for (const params of calls.subscriptionParams) {
    assert.equal(params.customer, "cus_abc");
    assert.equal(params.status, "all", "cancelled subs must be visible too");
    assert.equal(params.limit, 100);
    // Neither read may start from a cursor, or Stripe returns the wrong window.
    assert.equal(params.starting_after, undefined);
  }
  assert.equal(calls.subscriptionParams[0].customer, "cus_abc");
});

test("wiring: a cancelled subscription on the first page still reaches page 2", async () => {
  // 150 subs, all cancelled except the last: this is the case the old code
  // answered wrong, expressed through the route's own wiring.
  const subscriptions = Array.from({ length: 150 }, (_, index) => ({
    id: `sub_${index}`,
    status: index === 149 ? "active" : "canceled",
  }));
  const { calls, stripe } = fakeStripe({ subscriptions });

  const result = await assessDeletionBilling(stripe as never, "cus_abc");

  assert.deepEqual(result, { state: "ongoing" });
  assert.equal(calls.subscriptionParams.length, 2, "walked to page 2");
  assert.equal(calls.subscriptionParams[1].starting_after, "sub_99", "cursor is the last id of page 1");
});

test("wiring: every open subscription checkout on every page is reported, and NONE is expired here", async () => {
  /*
   * This used to assert that `assessDeletionBilling` expired the sessions itself.
   * It no longer does, and that is the fix for the review's third finding: this
   * function runs under a deadline, so anything it did after that deadline would
   * run with the deletion lock released — and could expire a session a *newer*
   * checkout had just created. It reports the ids; the caller expires them while
   * it still holds the lock.
   *
   * Page 1 is one-off payments (never candidates). Page 2 holds the subscription
   * session that must be reported.
   */
  const sessions = [
    ...Array.from({ length: 100 }, (_, index) => ({ id: `cs_pay_${index}`, mode: "payment" })),
    { id: "cs_sub_late", mode: "subscription" },
  ];
  const { calls, stripe } = fakeStripe({ sessions });

  const result = await assessDeletionBilling(stripe as never, "cus_abc");

  assert.deepEqual(result, { state: "clear", openSessionIds: ["cs_sub_late"] });
  assert.deepEqual(calls.expired, [], "the read-only assessment expires nothing");
  assert.equal(calls.sessionParams[0].status, "open");
  assert.equal(calls.sessionParams[1].starting_after, "cs_pay_99");
});

test("wiring: a Stripe failure is reported as unverifiable, never as clear", async () => {
  const { stripe } = fakeStripe({ throwOnSubscriptions: true });

  const result = await assessDeletionBilling(stripe as never, "cus_abc");

  assert.equal(result.state, "unverifiable");
});

test("wiring: unverifiable blocks the deletion at the gate", async () => {
  const { stripe } = fakeStripe({ throwOnSubscriptions: true });
  const result = await assessDeletionBilling(stripe as never, "cus_abc");

  assert.equal(result.state, "unverifiable");
  // The route feeds this straight into assessBillingGate; unverifiable must block.
  assert.equal(assessBillingGate("unverifiable").kind, "blocked");
});

// ------------------------------------------------- deleting-account cleanup (#144)

test("cleanup: cancels the subscription, NOT the customer — customer-wide deletion hits other products", async () => {
  /*
   * Deleting the Stripe customer was the original implementation, and it was the
   * defect the review found: `customers.del` cancels EVERY subscription on that
   * customer, including another product's on a shared Stripe account. The action
   * has to be per-subscription, and only for subscriptions we can attribute.
   */
  const cancelled: string[] = [];
  const customerDeletes: string[] = [];
  const stripe = {
    customers: {
      del: async (id: string) => { customerDeletes.push(id); return {}; },
      retrieve: async () => ({ metadataUserId: "user-deleted" }),
    },
    subscriptions: {
      list: async () => ({
        data: [{ id: "sub_ours", status: "active", priceId: "price_test_mxn", metadataUserId: "user-deleted" }],
        has_more: false,
      }),
      cancel: async (id: string) => { cancelled.push(id); return {}; },
    },
  };

  const outcome = await cancelBillingForDeletedAccount(stripe as never, "cus_orphan", "user-deleted");

  assert.deepEqual(cancelled, ["sub_ours"], "the attributed subscription is cancelled");
  assert.deepEqual(customerDeletes, [], "the customer is never deleted");
  assert.equal(outcome.cancelled, true);
});

test("cleanup: a live subscription on a later page is still found and cancelled", async () => {
  const rows = [
    ...Array.from({ length: 100 }, (_, index) => ({
      id: `sub_${index}`, status: "canceled", priceId: "price_test_mxn", metadataUserId: "user-deleted",
    })),
    { id: "sub_late", status: "trialing", priceId: "price_test_mxn", metadataUserId: "user-deleted" },
  ];
  const cancelled: string[] = [];
  const stripe = {
    customers: { retrieve: async () => ({ metadataUserId: "user-deleted" }) },
    subscriptions: {
      list: async (params: { starting_after?: string }) => {
        const start = params.starting_after ? rows.findIndex(row => row.id === params.starting_after) + 1 : 0;
        return { data: rows.slice(start, start + 100), has_more: start + 100 < rows.length };
      },
      cancel: async (id: string) => { cancelled.push(id); return {}; },
    },
  };

  const outcome = await cancelBillingForDeletedAccount(stripe as never, "cus_orphan", "user-deleted");
  assert.deepEqual(cancelled, ["sub_late"]);
  assert.equal(outcome.cancelled, true);
});

test("cleanup: nothing live leaves Stripe untouched", async () => {
  const cancelled: string[] = [];
  const stripe = {
    customers: { retrieve: async () => ({ metadataUserId: "user-deleted" }) },
    subscriptions: {
      list: async () => ({ data: [{ id: "sub_1", status: "canceled", priceId: "price_test_mxn", metadataUserId: "user-deleted" }], has_more: false }),
      cancel: async (id: string) => { cancelled.push(id); return {}; },
    },
  };

  const outcome = await cancelBillingForDeletedAccount(stripe as never, "cus_idle", "user-deleted");

  assert.equal(outcome.cancelled, false);
  assert.equal((outcome as { reason: string }).reason, "no_live_subscription");
  assert.deepEqual(cancelled, []);
});

test("cleanup: an UNRELATED subscription appearing between the gate and cleanup is not cancelled", async () => {
  /*
   * The exact scenario in the review: the deletion gate sees nothing, then another
   * product creates a subscription on the same customer before this cleanup runs.
   * It must be reported as unattributed, never cancelled — and never taken down
   * with `customers.del`.
   */
  const cancelled: string[] = [];
  const customerDeletes: string[] = [];
  const stripe = {
    customers: {
      del: async (id: string) => { customerDeletes.push(id); return {}; },
      retrieve: async () => ({ metadataUserId: "someone-else" }),
    },
    subscriptions: {
      list: async () => ({
        data: [
          { id: "sub_other_product", status: "active", priceId: "price_other_product", metadataUserId: null },
          { id: "sub_other_user", status: "active", priceId: "price_test_mxn", metadataUserId: "someone-else" },
        ],
        has_more: false,
      }),
      cancel: async (id: string) => { cancelled.push(id); return {}; },
    },
  };

  const outcome = await cancelBillingForDeletedAccount(stripe as never, "cus_shared", "user-deleted");

  assert.deepEqual(cancelled, [], "nothing unattributable is cancelled");
  assert.deepEqual(customerDeletes, [], "the shared customer survives for the other product");
  assert.deepEqual((outcome as { unattributed: string[] }).unattributed, ["sub_other_product", "sub_other_user"]);
  assert.equal(outcome.cancelled, false);
});

test("cleanup: a Stripe failure is reported, not thrown — the account is already gone", async () => {
  const stripe = {
    customers: { retrieve: async () => ({ metadataUserId: "user-deleted" }) },
    subscriptions: {
      list: async () => ({ data: [{ id: "sub_1", status: "active", priceId: "price_test_mxn", metadataUserId: "user-deleted" }], has_more: false }),
      cancel: async () => { throw new Error("stripe down"); },
    },
  };

  const outcome = await cancelBillingForDeletedAccount(stripe as never, "cus_orphan", "user-deleted");

  // Must not throw: throwing here would turn a completed deletion into a 500
  // and tell the user their account still exists.
  assert.equal(outcome.cancelled, false);
  assert.match((outcome as { reason: string }).reason, /stripe down/);
});

test("cleanup: an already-cancelled subscription counts as done, not as a failure", async () => {
  const stripe = {
    customers: { retrieve: async () => ({ metadataUserId: "user-deleted" }) },
    subscriptions: {
      list: async () => ({ data: [{ id: "sub_1", status: "active", priceId: "price_test_mxn", metadataUserId: "user-deleted" }], has_more: false }),
      cancel: async () => { throw Object.assign(new Error("This subscription has already been canceled."), { statusCode: 400 }); },
    },
  };

  const outcome = await cancelBillingForDeletedAccount(stripe as never, "cus_orphan", "user-deleted");
  assert.deepEqual((outcome as { cancelledIds: string[] }).cancelledIds, ["sub_1"]);
});

test("assessment: expires NOTHING, even when it finds open subscription checkouts", async () => {
  /*
   * The review's third finding, at the layer where it can actually be decided.
   *
   * `assessDeletionBilling` runs under a deadline. Anything it *does* after that
   * deadline runs with the deletion lock released, so a slow list call could
   * finish and expire a session a newer checkout had just created. The fix is
   * that this function has no side effects at all: it reports the ids, and the
   * caller expires them while it still holds the lock.
   *
   * This test would pass vacuously if the stub had no `expire`, so the stub
   * asserts: if the assessment ever reaches for it, the test fails.
   */
  let expireCalls = 0;
  const stripe = {
    subscriptions: { list: async () => ({ data: [], has_more: false }) },
    checkout: {
      sessions: {
        list: async () => ({
          data: [
            { id: "cs_open_a", mode: "subscription" },
            { id: "cs_open_b", mode: "subscription" },
            { id: "cs_one_off", mode: "payment" },
          ],
          has_more: false,
        }),
        expire: async () => { expireCalls++; return {}; },
      },
    },
  };

  const result = await assessDeletionBilling(stripe as never, "cus_abc");

  assert.deepEqual(result, { state: "clear", openSessionIds: ["cs_open_a", "cs_open_b"] });
  assert.equal(expireCalls, 0, "the deadline-bounded assessment must not mutate anything");
});
