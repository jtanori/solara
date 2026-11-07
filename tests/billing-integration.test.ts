import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type Stripe from "stripe";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../src/db";
import { stripeEvents, users } from "../src/db/schema";
import { hasPremiumAccess } from "../src/lib/auth";
import { processStripeEvent } from "../src/lib/stripe-sync";

test("subscription sync is idempotent and uses the latest Stripe state",{skip:process.env.RUN_BILLING_INTEGRATION_TESTS!=="1"},async()=>{
  const host=new URL(process.env.DATABASE_URL ?? "").hostname;
  assert.ok(["localhost","127.0.0.1"].includes(host),"Billing integration tests must run against a local disposable database");
  const token=randomBytes(8).toString("hex"),customerId=`cus_test_${token}`,subscriptionId=`sub_test_${token}`;
  const eventIds=[`evt_test_${token}_1`,`evt_test_${token}_2`,`evt_test_${token}_3`,`evt_test_${token}_4`];
  const [user]=await db.insert(users).values({name:"Billing test",email:`billing-${token}@example.test`,passwordHash:"not-a-login",stripeCustomerId:customerId}).returning({id:users.id});
  const originalPrices=process.env.STRIPE_PREMIUM_PRICE_IDS;
  process.env.STRIPE_PREMIUM_PRICE_IDS="price_test";
  let status="active";let end=Math.floor(Date.now()/1000)+3600;let priceId="price_test";
  const stripe={subscriptions:{retrieve:async()=>({id:subscriptionId,customer:customerId,metadata:{solara_user_id:user.id,solara_product:"premium"},status,cancel_at_period_end:false,items:{data:[{price:{id:priceId,currency:"mxn"},current_period_end:end}]}})}} as unknown as Stripe;
  const makeEvent=(id:string,type:string)=>({id,type,data:{object:{id:subscriptionId}}} as unknown as Stripe.Event);
  try{
    await processStripeEvent(makeEvent(eventIds[0],"customer.subscription.created"),stripe);
    assert.equal(await hasPremiumAccess(user.id),true);
    status="canceled";
    await processStripeEvent(makeEvent(eventIds[0],"customer.subscription.created"),stripe);
    assert.equal(await hasPremiumAccess(user.id),true,"duplicate event must not be processed twice");
    await processStripeEvent(makeEvent(eventIds[1],"customer.subscription.updated"),stripe);
    assert.equal(await hasPremiumAccess(user.id),false,"latest canceled state revokes access");
    status="active";end=Math.floor(Date.now()/1000)-10;
    await processStripeEvent(makeEvent(eventIds[2],"customer.subscription.updated"),stripe);
    assert.equal(await hasPremiumAccess(user.id),false,"an expired period cannot grant access");
    end=Math.floor(Date.now()/1000)+3600;priceId="price_unrelated";
    await processStripeEvent(makeEvent(eventIds[3],"customer.subscription.updated"),stripe);
    assert.equal(await hasPremiumAccess(user.id),false,"an unrelated price cannot grant Premium");
  }finally{
    await db.delete(stripeEvents).where(inArray(stripeEvents.id,eventIds));
    await db.delete(users).where(eq(users.id,user.id));
    if(originalPrices===undefined) delete process.env.STRIPE_PREMIUM_PRICE_IDS; else process.env.STRIPE_PREMIUM_PRICE_IDS=originalPrices;
  }
});
