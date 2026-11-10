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
  try{await processStripeEvent(event,stripe);return NextResponse.json({received:true});}
  catch(error){log.error("billing.webhook_failed", { ...requestMeta(request), error });return NextResponse.json({error:"Webhook processing failed."},{status:500});}
}
