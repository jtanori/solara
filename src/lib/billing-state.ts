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

/**
 * The exact Stripe calls the account-deletion gate makes, as one function.
 *
 * The page-walk helpers above are tested directly, but that only proves the
 * helper walks pages — not that the route passes it the right `starting_after`,
 * the right `status`, or expires the right sessions. This function is that
 * wiring, lifted out of the route so a fake Stripe can drive it end to end.
 *
 * `stripe` is structurally typed to just the three calls used, so a test can
 * pass a stub without casting a whole `Stripe` object.
 */
export type DeletionBillingStripe = {
  subscriptions: {
    list(params: { customer: string; status: "all"; limit: number; starting_after?: string }): Promise<BillingPage<{ id: string; status: string }>>;
  };
  checkout: {
    sessions: {
      list(params: { customer: string; status: "open"; limit: number; starting_after?: string }): Promise<BillingPage<{ id: string; mode: string }>>;
      expire(id: string): Promise<unknown>;
    };
  };
};

export type DeletionBillingResult =
  | { state: "clear"; expiredSessionIds: string[] }
  | { state: "ongoing" }
  /** A Stripe call threw, including "the list would not end". */
  | { state: "unverifiable"; error: unknown };

/**
 * Is a subscription live for this customer, and are there open checkouts?
 *
 * Both lists are walked to the end: a live subscription on page 2 is a
 * subscription the gate would otherwise never see, and the account would be
 * deleted with a paying customer still attached. Open subscription sessions on
 * any page are expired, since a completed checkout would otherwise bill an
 * account that no longer exists.
 *
 * Any failure — network, auth, or a list that never ends — returns
 * `unverifiable`, which the caller's gate turns into a blocked deletion. That
 * is fail-closed on purpose: a deletion must never proceed on a partial answer.
 */
export async function assessDeletionBilling(
  stripe: DeletionBillingStripe,
  customerId: string,
): Promise<DeletionBillingResult> {
  const hasOngoing = () => anyAcrossPages(
    async startingAfter => stripe.subscriptions.list({
      customer: customerId, status: "all", limit: 100, starting_after: startingAfter,
    }),
    subscription => isOngoingStatus(subscription.status),
  );

  try {
    if (await hasOngoing()) return { state: "ongoing" };

    const sessions = await collectAcrossPages(
      async startingAfter => stripe.checkout.sessions.list({
        customer: customerId, status: "open", limit: 100, starting_after: startingAfter,
      }),
      session => session.mode === "subscription",
    );

    // Expire every open subscription checkout before re-checking: a session that
    // completes between the two checks is exactly the "billed with no account"
    // case, so it is closed first and then looked for again.
    const expiredSessionIds: string[] = [];
    for (const session of sessions) {
      await stripe.checkout.sessions.expire(session.id);
      expiredSessionIds.push(session.id);
    }

    if (await hasOngoing()) return { state: "ongoing" };
    return { state: "clear", expiredSessionIds };
  } catch (error) {
    return { state: "unverifiable", error };
  }
}

/**
 * Cancel whatever billing is live for a customer that no longer has an account.
 *
 * This is the remedy for the checkout/deletion race (#144). The race produces a
 * Stripe customer with a subscription that resolves to no user, so nothing in
 * the product can see it — `findOwner` returns null and the webhook only records
 * `webhook:unmapped`. Deleting the customer cancels its subscriptions, which is
 * the only action that actually stops the charge.
 *
 * Deletion cannot simply refuse when it finds an orphan: by definition the
 * account is the thing being deleted. So it cleans up instead, and a failure
 * here surfaces as `warnings` rather than failing the whole deletion — the
 * account is already gone, and refusing to finish would leave the user unable
 * to delete at all.
 */
export type DeletionCleanupStripe = {
  customers: { del(id: string): Promise<unknown> };
  subscriptions: {
    list(params: { customer: string; status: "all"; limit: number; starting_after?: string }): Promise<BillingPage<{ id: string; status: string }>>;
  };
};

export type StripeCleanupOutcome =
  | { cancelled: true }
  | { cancelled: false; reason: string };

/**
 * Best-effort cancel. Returns an outcome instead of throwing so the caller can
 * log it and finish the deletion: an orphaned customer is a support problem,
 * a half-deleted account is a worse one.
 */
export async function cancelBillingForDeletedAccount(
  stripe: DeletionCleanupStripe,
  customerId: string,
): Promise<StripeCleanupOutcome> {
  try {
    const live = await collectAcrossPages(
      async startingAfter => stripe.subscriptions.list({
        customer: customerId, status: "all", limit: 100, starting_after: startingAfter,
      }),
      subscription => isOngoingStatus(subscription.status),
    );
    if (live.length === 0) return { cancelled: false, reason: "no_live_subscription" };

    // Deleting the customer cancels active subscriptions immediately rather
    // than waiting for the checkout session to be paid.
    await stripe.customers.del(customerId);
    return { cancelled: true };
  } catch (error) {
    return { cancelled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
