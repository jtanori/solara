import Stripe from "stripe";

export function verifyStripeEvent(payload:string, signature:string, secret:string) {
  return Stripe.webhooks.constructEvent(payload,signature,secret);
}
export function subscriptionIdFrom(event:Stripe.Event):string|null {
  if(event.type==="checkout.session.completed"){
    const subscription=(event.data.object as Stripe.Checkout.Session).subscription;
    return typeof subscription==="string"?subscription:subscription?.id??null;
  }
  if(event.type==="customer.subscription.created"||event.type==="customer.subscription.updated"||event.type==="customer.subscription.deleted")return (event.data.object as Stripe.Subscription).id;
  if(event.type==="invoice.paid"||event.type==="invoice.payment_failed"||event.type==="invoice.payment_succeeded"){
    const invoice=event.data.object as Stripe.Invoice;
    const legacy=(invoice as unknown as {subscription?:string|{id:string}|null}).subscription;
    const subscription=invoice.parent?.subscription_details?.subscription??legacy;
    return typeof subscription==="string"?subscription:subscription?.id??null;
  }
  return null;
}
