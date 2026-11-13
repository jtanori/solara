import type Stripe from "stripe";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, stripeEvents, subscriptions, users } from "@/db/schema";
import { subscriptionIdFrom } from "@/lib/stripe-events";
import { isPremiumPrice } from "@/lib/billing";
import { processStripeEventWith, type StripeEventOutcome, type SyncPorts } from "@/lib/stripe-sync-core";

/**
 * The database + Stripe wiring for the webhook core (`stripe-sync-core.ts`).
 *
 * The ordering that matters, all inside one transaction:
 *
 *   1. claim the event id        — a replay costs one insert, nothing else
 *   2. advisory lock on the id   — Stripe does not guarantee event order
 *   3. re-fetch from Stripe      — the payload may be stale; the API is truth
 *   4. map to a user, upsert, audit
 *
 * A *transient* failure (Stripe unreachable, 5xx) throws, which rolls the claim
 * back and returns 500 so Stripe retries. A *permanent* one (no matching user,
 * customer mismatch) commits an `audit_logs` row with a null actor and a
 * `webhook:*` action, and returns 200 — retrying it for three days cannot fix it
 * and only hides it.
 */
/**
 * Audit rows recording a deletion, keyed by the Stripe customer id.
 *
 * `audit_logs.target` holds the deleted user's id, so a subscription whose
 * metadata lost `solara_user_id` cannot be matched to it directly. Deletion
 * therefore also records `<customerId>` as a second `account:delete` target, and
 * this reads it back. Only used to *confirm* an account was deleted, never to
 * cancel on its own.
 */
async function deletedTargetsForCustomer(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  customerId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ target: auditLogs.target })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "account:delete"), eq(auditLogs.target, customerId)));
  return rows.map(row => row.target);
}

export async function processStripeEvent(event: Stripe.Event, stripe: Stripe): Promise<StripeEventOutcome> {
  const subscriptionId = subscriptionIdFrom(event);

  return db.transaction(async tx => {
      const ports: SyncPorts = {
        claimEvent: async ({ id, type }) => {
          const [claimed] = await tx
            .insert(stripeEvents)
            .values({ id, type })
            .onConflictDoNothing()
            .returning({ id: stripeEvents.id });
          return Boolean(claimed);
        },

        lockSubscription: async id => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
        },

        retrieveSubscription: async id => {
          const subscription = await stripe.subscriptions.retrieve(id);
          const item = subscription.items.data[0];
          return {
            id: subscription.id,
            customer: typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id,
            metadata: subscription.metadata as Record<string, string | undefined>,
            status: subscription.status,
            // Absent price = an item we cannot price; the core records it.
            priceId: item?.price.id ?? "",
            currency: item?.price.currency ?? "",
            currentPeriodEnd: item?.current_period_end ?? null,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
          };
        },

        findOwner: async ({ metadataUserId, customerId }) => {
          if (metadataUserId) {
            const [byMetadata] = await tx
              .select({ id: users.id, customerId: users.stripeCustomerId })
              .from(users)
              .where(eq(users.id, metadataUserId))
              .limit(1);
            if (byMetadata) return byMetadata;
          }
          const [byCustomer] = await tx
            .select({ id: users.id, customerId: users.stripeCustomerId })
            .from(users)
            .where(eq(users.stripeCustomerId, customerId))
            .limit(1);
          return byCustomer;
        },

        setCustomerId: async (userId, customerId) => {
          await tx.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, userId));
        },

        upsertSubscription: async values => {
          await tx.insert(subscriptions).values(values).onConflictDoUpdate({
            target: subscriptions.stripeSubscriptionId,
            set: values,
          });
        },

        recordAudit: async (action, target) => {
          // actorId stays null: the actor is Stripe, not a person. The row
          // survives any later deletion of the customer or the user.
          await tx.insert(auditLogs).values({ actorId: null, action, target });
        },

        priceGrantsAccess: priceId => isPremiumPrice(priceId),

        /*
         * Only cancel on durable proof of deletion. `deleteAccountWithAudit`
         * writes `account:delete` with `actor_id` = the deleted user and
         * `target` = the same id; the delete then nulls `actor_id` via
         * `ON DELETE SET NULL`, so the surviving row is identifiable by
         * `target` alone. That row is the evidence an account was deleted.
         *
         * `target` is a text column, so this compares as text — it also cannot
         * use the user id to look the user up, which is the point: the user is
         * gone.
         */
        wasAccountDeleted: async ({ metadataUserId, customerId }) => {
          // The audit row's `target` is the deleted user's id. A subscription
          // with no usable metadata id can only be matched through a customer id
          // that a deletion recorded — which is why deletion also writes the
          // parent-side carrier (see `recordDeletedCustomer`).
          const ids = [metadataUserId, ...(await deletedTargetsForCustomer(tx, customerId))].filter(
            (value): value is string => Boolean(value),
          );
          if (ids.length === 0) return false;
          const [row] = await tx
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(and(eq(auditLogs.action, "account:delete"), inArray(auditLogs.target, ids)))
            .limit(1);
          return Boolean(row);
        },

        /*
         * Cancelling is the only thing that stops the charge. A transient failure
         * throws, which rolls back the claim and makes Stripe redeliver.
         */
        cancelOrphanedSubscription: async subscriptionId => {
          await stripe.subscriptions.cancel(subscriptionId);
        },
      };

      return processStripeEventWith(event, subscriptionId, ports);
  });
}
