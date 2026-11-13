/**
 * Billing-state policy, shared by the account-deletion gate.
 *
 * Same shape as `account-deletion.ts` and `usage-guide-access-core.ts`: the
 * decision lives here, the I/O stays in the route, so "is money moving?" is
 * testable without Stripe or a database.
 */

/** A subscription in one of these states is live enough to block a deletion. */
export const ONGOING_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
] as const;

export function isOngoingStatus(status: string): boolean {
  return (ONGOING_SUBSCRIPTION_STATUSES as readonly string[]).includes(status);
}

export function hasOngoingSubscription(subscriptions: ReadonlyArray<{ status: string }>): boolean {
  return subscriptions.some(subscription => isOngoingStatus(subscription.status));
}

/**
 * One page of a Stripe list. `stripe.x.list()` returns an `ApiListPromise<T>`
 * whose resolved value satisfies this, so the route can pass it straight in.
 */
export type BillingPage<T> = { data: T[]; has_more: boolean };

/** Fetches one page; `startingAfter` is the cursor (the last id of the previous page). */
export type FetchBillingPage<T> = (startingAfter: string | undefined) => Promise<BillingPage<T>>;

/**
 * How many pages to walk before giving up. 10 × the 100-per-page limit below is
 * 1 000 records — far past anything a single customer plausibly has, so hitting
 * the cap means something is wrong, not that the data is merely large.
 */
export const MAX_BILLING_PAGES = 10;

/**
 * Walk a list page by page until `onPage` returns true or the list is exhausted.
 *
 * Reading only the first page is a correctness bug here, not a performance
 * choice: a live subscription sitting on page 2 is a subscription the deletion
 * gate never saw, and the account would be deleted with a paying customer on it.
 *
 * Running out of pages throws rather than returning a partial answer. Callers
 * treat a throw as `unverifiable`, which blocks the deletion — the same
 * fail-closed rule the billing gate already applies to an unreachable Stripe.
 */
async function eachPage<T extends { id: string }>(
  fetchPage: FetchBillingPage<T>,
  onPage: (items: T[]) => boolean,
): Promise<void> {
  let startingAfter: string | undefined;

  for (let page = 0; page < MAX_BILLING_PAGES; page++) {
    const result = await fetchPage(startingAfter);
    if (onPage(result.data)) return;
    if (!result.has_more) return;
    const last = result.data[result.data.length - 1];
    // `has_more` with no items cannot be followed — treat it as unverifiable
    // rather than silently reporting "nothing found".
    if (!last) throw new Error("billing list reported has_more with an empty page");
    startingAfter = last.id;
  }

  throw new Error(`billing list exceeded ${MAX_BILLING_PAGES} pages; refusing to guess on a billing state`);
}

/** True if any record across every page matches. Stops at the first match. */
export async function anyAcrossPages<T extends { id: string }>(
  fetchPage: FetchBillingPage<T>,
  predicate: (item: T) => boolean,
): Promise<boolean> {
  let found = false;
  await eachPage(fetchPage, items => {
    found = items.some(predicate);
    return found;
  });
  return found;
}

/** Every matching record across every page. */
export async function collectAcrossPages<T extends { id: string }>(
  fetchPage: FetchBillingPage<T>,
  predicate: (item: T) => boolean = () => true,
): Promise<T[]> {
  const collected: T[] = [];
  await eachPage(fetchPage, items => {
    collected.push(...items.filter(predicate));
    return false;
  });
  return collected;
}
