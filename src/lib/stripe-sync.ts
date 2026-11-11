import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
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
      };

      return processStripeEventWith(event, subscriptionId, ports);
  });
}
