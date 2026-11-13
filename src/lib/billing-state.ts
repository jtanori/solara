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
 * the right `status`, or reports the right sessions. This function is that
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
    };
  };
};

export type DeletionBillingResult =
  /**
   * Read-only by design. `clear` lists the open subscription checkouts it found,
   * but **expires nothing**: this function is called under a deadline, and work
   * that outlives the deadline would run with the lock released. The caller
   * expires them inside its own locked transaction (see `defaultDeleteUser`).
   */
  | { state: "clear"; openSessionIds: string[] }
  | { state: "ongoing" }
  /** A Stripe call threw, including "the list would not end". */
  | { state: "unverifiable"; error: unknown };

/**
 * Is a subscription live for this customer, and are there open checkouts?
 *
 * Both lists are walked to the end: a live subscription on page 2 is a
 * subscription the gate would otherwise never see, and the account would be
 * deleted with a paying customer still attached. Open subscription sessions on
 * any page are reported, because a completed checkout would otherwise bill an
 * account that no longer exists. It expires nothing itself — see the note on the
 * return type.
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

    if (await hasOngoing()) return { state: "ongoing" };
    return { state: "clear", openSessionIds: sessions.map(session => session.id) };
  } catch (error) {
    return { state: "unverifiable", error };
  }
}

/**
 * Cancel the subscriptions that provably belong to a deleted account.
 *
 * **Not `customers.del`.** Deleting a Stripe customer cancels *every*
 * subscription on it, including other products' on a shared Stripe account, and
 * cannot tell whose they were. That is the same class of mistake as cancelling
 * on "unmapped" alone, one layer up: an irreversible, customer-wide action
 * justified by evidence that is only account-wide.
 *
 * Instead each subscription is inspected and cancelled individually, and only
 * when it is attributed to us: a price that grants Solara access, and a user id
 * (from subscription metadata or the customer's own metadata) that is an id we
 * recorded as deleted. A subscription we cannot attribute is left alone and
 * reported, because "someone else's subscription" and "ours, mid-repair" are
 * indistinguishable at 200 OK.
 *
 * Failure handling: nothing here throws. The account is already gone, and a 500
 * would tell the user it was not. Failures are returned by id so the caller logs
 * them and the webhook — which sees the same subscriptions — can finish the job.
 */
export type DeletionCleanupStripe = {
  subscriptions: {
    list(params: { customer: string; status: "all"; limit: number; starting_after?: string }): Promise<BillingPage<{ id: string; status: string; priceId: string | null; metadataUserId: string | null }>>;
    cancel(id: string): Promise<unknown>;
  };
  customers: {
    retrieve(id: string): Promise<{ metadataUserId: string | null } | null>;
  };
};

export type StripeCleanupOutcome =
  | { cancelled: true; cancelledIds: string[]; unattributed: string[] }
  | { cancelled: false; reason: string; cancelledIds: string[]; unattributed: string[] };

/**
 * @param deletedUserId every user id this deletion recorded, so attribution can
 *   accept either the subscription's metadata id or the customer's own metadata
 *   id — the same two sources the webhook reads.
 */
export async function cancelBillingForDeletedAccount(
  stripe: DeletionCleanupStripe,
  customerId: string,
  deletedUserId: string,
): Promise<StripeCleanupOutcome> {
  const cancelledIds: string[] = [];
  const unattributed: string[] = [];

  try {
    const live = await collectAcrossPages(
      async startingAfter => stripe.subscriptions.list({
        customer: customerId, status: "all", limit: 100, starting_after: startingAfter,
      }),
      subscription => isOngoingStatus(subscription.status),
    );
    if (live.length === 0) return { cancelled: false, reason: "no_live_subscription", cancelledIds, unattributed };

    // The customer's own metadata is the fallback attribution source, read once.
    const customer = await stripe.customers.retrieve(customerId).catch(() => null);

    for (const subscription of live) {
      const owned =
        (subscription.priceId !== null && isPremiumPriceId(subscription.priceId)) &&
        (subscription.metadataUserId === deletedUserId || customer?.metadataUserId === deletedUserId);

      if (!owned) {
        unattributed.push(subscription.id);
        continue;
      }

      try {
        await stripe.subscriptions.cancel(subscription.id);
        cancelledIds.push(subscription.id);
      } catch (error) {
        // Already gone is success; anything else is reported, not thrown.
        if (isAlreadyCancelled(error)) cancelledIds.push(subscription.id);
        else return {
          cancelled: false,
          reason: error instanceof Error ? error.message : String(error),
          cancelledIds,
          unattributed,
        };
      }
    }

    return cancelledIds.length > 0
      ? { cancelled: true, cancelledIds, unattributed }
      : { cancelled: false, reason: "nothing_attributed", cancelledIds, unattributed };
  } catch (error) {
    return {
      cancelled: false,
      reason: error instanceof Error ? error.message : String(error),
      cancelledIds,
      unattributed,
    };
  }
}

/** A price that grants access is the same test the gate and the webhook use. */
function isPremiumPriceId(priceId: string): boolean {
  const allowed = [
    process.env.STRIPE_PRICE_ID_MXN,
    process.env.STRIPE_PRICE_ID_USD,
    ...(process.env.STRIPE_PREMIUM_PRICE_IDS ?? "").split(","),
  ].map(value => value?.trim()).filter(Boolean);
  return allowed.includes(priceId);
}

/** Stripe reports an already-cancelled subscription as 404 or an invalid-request 400. */
function isAlreadyCancelled(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  const code = (error as { code?: string })?.code;
  const message = String((error as { message?: string })?.message ?? "");
  return status === 404 || code === "resource_missing" || (status === 400 && /already (been )?cancel/i.test(message));
}
