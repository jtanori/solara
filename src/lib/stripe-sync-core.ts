/**
 * Webhook processing core (product amendment §P1, Step 1).
 *
 * The bug this replaces: `processStripeEvent` had three `return`s and two
 * `throw`s, and every one of them was invisible. An event that matched no user
 * was claimed, marked processed, and never applied — the customer paid and
 * nothing happened, with one log line as the only trace. A customer mismatch
 * *threw*, which produced a 500, which made Stripe retry a permanently-failing
 * event until it gave up three days later.
 *
 * So: every path returns a discriminated outcome, the caller logs it, and the
 * two states that used to vanish (`unmapped`, `mismatch`) are written to
 * `audit_logs` **inside the same transaction that claims the event** — the row
 * commits, so it is visible, and the claim commits, so Stripe stops retrying.
 *
 * Everything here is expressed as ports. The transaction, the Stripe client and
 * the audit writer are injected, which is what makes the four outcomes testable
 * without Postgres or a network.
 */

export type SubscriptionSnapshot = {
  id: string;
  customer: string;
  metadata: Record<string, string | undefined>;
  status: string;
  priceId: string;
  currency: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
};

export type StripeEventOutcome =
  /** The event id was already claimed: a replay, or a concurrent delivery. */
  | { status: "duplicate"; eventId: string; subscriptionId: string | null }
  /** A type we intentionally do not act on (no subscription attached). */
  | { status: "ignored"; eventId: string; reason: "no_subscription" }
  /** Applied to `subscriptions`. */
  | {
      status: "applied";
      eventId: string;
      subscriptionId: string;
      userId: string;
      grantsAccess: boolean;
      linkedCustomer: boolean;
    }
  /** No user matches the metadata id or the Stripe customer id. */
  | { status: "unmapped"; eventId: string; subscriptionId: string; customerId: string }
  /** The user's stored customer id disagrees with the event's. */
  | {
      status: "mismatch";
      eventId: string;
      subscriptionId: string;
      customerId: string;
      ownerId: string;
      ownerCustomerId: string;
    }
  /** A subscription we cannot interpret (no price item). */
  | { status: "invalid"; eventId: string; subscriptionId: string; reason: "no_price_item" };

export type SubscriptionValues = {
  stripeSubscriptionId: string;
  userId: string;
  stripeCustomerId: string;
  stripePriceId: string;
  status: string;
  currency: string;
  grantsAccess: boolean;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  updatedAt: Date;
};

export type SyncPorts = {
  /**
   * Insert the event id, returning false when it already existed. Runs first so
   * that a replay costs one insert and nothing else.
   */
  claimEvent: (event: { id: string; type: string }) => Promise<boolean>;
  /** Serialise per subscription: Stripe does not guarantee event order. */
  lockSubscription: (subscriptionId: string) => Promise<void>;
  /** Always re-fetch: the payload may be stale relative to a newer event. */
  retrieveSubscription: (subscriptionId: string) => Promise<SubscriptionSnapshot>;
  findOwner: (args: {
    metadataUserId: string | undefined;
    customerId: string;
  }) => Promise<{ id: string; customerId: string | null } | undefined>;
  setCustomerId: (userId: string, customerId: string) => Promise<void>;
  upsertSubscription: (values: SubscriptionValues) => Promise<void>;
  /**
   * `audit_logs` with a null actor: the actor is the Stripe system, not a user.
   * `target` is the subscription id, `action` carries the outcome.
   */
  recordAudit: (action: WebhookAuditAction, target: string) => Promise<void>;
  /** True when this price is one of the configured premium prices. */
  priceGrantsAccess: (priceId: string) => boolean;
  now?: () => Date;
};

export type WebhookAuditAction = "webhook:applied" | "webhook:unmapped" | "webhook:mismatch" | "webhook:invalid";

const UUID = /^[0-9a-f-]{36}$/i;

export async function processStripeEventWith(
  event: { id: string; type: string },
  subscriptionId: string | null,
  ports: SyncPorts,
): Promise<StripeEventOutcome> {
  const claimed = await ports.claimEvent({ id: event.id, type: event.type });
  if (!claimed) return { status: "duplicate", eventId: event.id, subscriptionId };

  // A claimed event with no subscription is intentional: types like
  // customer.created carry nothing we act on. It stays claimed so a replay is a
  // cheap no-op, and there is nothing to record.
  if (!subscriptionId) return { status: "ignored", eventId: event.id, reason: "no_subscription" };

  await ports.lockSubscription(subscriptionId);

  // A throw here is a genuine transient (Stripe unreachable, 5xx). It must reach
  // the caller as a 500 so Stripe retries — the claim rolls back with the
  // transaction, so the retry can re-claim.
  const subscription = await ports.retrieveSubscription(subscriptionId);
  const customerId = subscription.customer;

  const metadataUserId = subscription.metadata.solara_user_id;
  const owner = await ports.findOwner({
    metadataUserId: metadataUserId && UUID.test(metadataUserId) ? metadataUserId : undefined,
    customerId,
  });

  if (!owner) {
    // Used to `return` silently. Now it commits an audit row: a paying customer
    // who matches no account is exactly the case support needs to find later.
    await ports.recordAudit("webhook:unmapped", subscriptionId);
    return { status: "unmapped", eventId: event.id, subscriptionId, customerId };
  }

  if (owner.customerId && owner.customerId !== customerId) {
    // Used to `throw`, which meant an infinite retry of an event that could never
    // succeed. A mismatch is a data problem to be looked at, not a transient.
    await ports.recordAudit("webhook:mismatch", subscriptionId);
    return {
      status: "mismatch",
      eventId: event.id,
      subscriptionId,
      customerId,
      ownerId: owner.id,
      ownerCustomerId: owner.customerId,
    };
  }

  const linkedCustomer = !owner.customerId;
  if (linkedCustomer) await ports.setCustomerId(owner.id, customerId);

  if (!subscription.priceId) {
    await ports.recordAudit("webhook:invalid", subscriptionId);
    return { status: "invalid", eventId: event.id, subscriptionId, reason: "no_price_item" };
  }

  const grantsAccess = subscription.metadata.solara_product === "premium"
    && ports.priceGrantsAccess(subscription.priceId);

  await ports.upsertSubscription({
    stripeSubscriptionId: subscription.id,
    userId: owner.id,
    stripeCustomerId: customerId,
    stripePriceId: subscription.priceId,
    status: subscription.status,
    currency: subscription.currency,
    grantsAccess,
    currentPeriodEnd: subscription.currentPeriodEnd === null ? null : new Date(subscription.currentPeriodEnd * 1000),
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    updatedAt: (ports.now ?? (() => new Date()))(),
  });

  await ports.recordAudit("webhook:applied", subscriptionId);
  return { status: "applied", eventId: event.id, subscriptionId, userId: owner.id, grantsAccess, linkedCustomer };
}

/**
 * One line for the log stream. `applied` and `duplicate` are routine and log at
 * info; the three others are things a human should be able to search for.
 */
export function outcomeLogLevel(outcome: StripeEventOutcome): "info" | "warn" {
  return outcome.status === "applied" || outcome.status === "duplicate" || outcome.status === "ignored"
    ? "info"
    : "warn";
}

/** Whether the event should be reported to Stripe as handled (200) or failed (500). */
export function outcomeIsHandled(outcome: StripeEventOutcome): boolean {
  // Everything except a throw is handled: retrying an unmapped, mismatched or
  // invalid event cannot change the outcome, and `stripe_events` already has it.
  return true;
}
