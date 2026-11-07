import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { stripeEvents, subscriptions, users } from "@/db/schema";
import { subscriptionIdFrom } from "@/lib/stripe-events";
import { isPremiumPrice } from "@/lib/billing";

export async function processStripeEvent(event:Stripe.Event,stripe:Stripe) {
  const id=subscriptionIdFrom(event);
  await db.transaction(async tx=>{
    const [claimed]=await tx.insert(stripeEvents).values({id:event.id,type:event.type}).onConflictDoNothing().returning({id:stripeEvents.id});
    if(!claimed||!id)return;
    // Stripe does not guarantee event order: serialize per subscription and fetch its latest state.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
    const subscription=await stripe.subscriptions.retrieve(id);
    const customerId=typeof subscription.customer==="string"?subscription.customer:subscription.customer.id;
    const metadataId=subscription.metadata.solara_user_id;
    let owner=metadataId&&/^[0-9a-f-]{36}$/i.test(metadataId)?(await tx.select({id:users.id,customerId:users.stripeCustomerId}).from(users).where(eq(users.id,metadataId)).limit(1))[0]:undefined;
    if(!owner)owner=(await tx.select({id:users.id,customerId:users.stripeCustomerId}).from(users).where(eq(users.stripeCustomerId,customerId)).limit(1))[0];
    if(!owner)return;
    if(owner.customerId&&owner.customerId!==customerId)throw new Error("Stripe customer mismatch");
    if(!owner.customerId)await tx.update(users).set({stripeCustomerId:customerId}).where(eq(users.id,owner.id));
    const item=subscription.items.data[0];if(!item)throw new Error("Subscription has no price item");
    const values={stripeSubscriptionId:subscription.id,userId:owner.id,stripeCustomerId:customerId,stripePriceId:item.price.id,status:subscription.status,currency:item.price.currency,grantsAccess:subscription.metadata.solara_product==="premium" && isPremiumPrice(item.price.id),currentPeriodEnd:item.current_period_end?new Date(item.current_period_end*1000):null,cancelAtPeriodEnd:subscription.cancel_at_period_end,updatedAt:new Date()};
    await tx.insert(subscriptions).values(values).onConflictDoUpdate({target:subscriptions.stripeSubscriptionId,set:values});
  });
}
