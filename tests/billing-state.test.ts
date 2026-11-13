import assert from "node:assert/strict";
import test from "node:test";
import {
  anyAcrossPages,
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
