import { NextResponse } from "next/server";
import { getStripe } from "@/lib/billing";
import { verifyStripeEvent } from "@/lib/stripe-events";
import { processStripeEvent } from "@/lib/stripe-sync";
import { log, requestMeta } from "@/lib/log";

export const runtime="nodejs";
export async function POST(request:Request){
  const stripe=getStripe();const secret=process.env.STRIPE_WEBHOOK_SECRET;
  if(!stripe||!secret)return NextResponse.json({error:"Webhook is not configured."},{status:503});
  const signature=request.headers.get("stripe-signature");if(!signature)return NextResponse.json({error:"Missing Stripe signature."},{status:400});
  let event;
  try{event=verifyStripeEvent(await request.text(),signature,secret);}catch{return NextResponse.json({error:"Invalid Stripe signature."},{status:400});}
  try{
    /*
     * Every outcome is handled (200). Retrying cannot change an unmapped,
     * mismatched or invalid event — each already commits a `webhook:*` audit row
     * and its event id — and a 500 loop only delays the day someone notices.
     * Only a throw (Stripe unreachable, 5xx) falls through to the retry path.
     */
    const outcome=await processStripeEvent(event,stripe);
    const detail={ ...requestMeta(request), eventId:event.id, type:event.type, outcome:outcome.status };
    if(outcome.status==="unmapped"||outcome.status==="mismatch"||outcome.status==="invalid"){
      log.warn("billing.webhook_unapplied", { ...detail, subscriptionId:outcome.subscriptionId });
    } else if(outcome.status==="applied"){
      log.info("billing.webhook_applied", { ...detail, userId:outcome.userId, grantsAccess:outcome.grantsAccess });
    }
    return NextResponse.json({received:true,outcome:outcome.status});
  }
  catch(error){log.error("billing.webhook_failed", { ...requestMeta(request), error });return NextResponse.json({error:"Webhook processing failed."},{status:500});}
}
