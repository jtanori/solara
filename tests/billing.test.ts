import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Stripe from "stripe";
import { subscriptionIdFrom, verifyStripeEvent } from "../src/lib/stripe-events";

function event(type:string,object:Record<string,unknown>):Stripe.Event {
  return {id:"evt_example",object:"event",type,data:{object}} as unknown as Stripe.Event;
}
test("verifies the exact signed webhook body and rejects tampering",()=>{
  const secret=randomBytes(24).toString("hex");
  const payload=JSON.stringify(event("customer.subscription.updated",{id:"sub_example"}));
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret});
  assert.equal(verifyStripeEvent(payload,signature,secret).id,"evt_example");
  assert.throws(()=>verifyStripeEvent(payload+" ",signature,secret));
});
test("extracts subscription identifiers from Checkout and invoice versions",()=>{
  assert.equal(subscriptionIdFrom(event("checkout.session.completed",{subscription:"sub_checkout"})),"sub_checkout");
  assert.equal(subscriptionIdFrom(event("customer.subscription.deleted",{id:"sub_deleted"})),"sub_deleted");
  assert.equal(subscriptionIdFrom(event("invoice.paid",{parent:{subscription_details:{subscription:"sub_new"}}})),"sub_new");
  assert.equal(subscriptionIdFrom(event("invoice.payment_failed",{subscription:"sub_legacy"})),"sub_legacy");
  assert.equal(subscriptionIdFrom(event("customer.created",{id:"cus_example"})),null);
});
