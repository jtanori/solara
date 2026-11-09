import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { subscriptions, users } from "@/db/schema";
import { currentUser, SESSION_COOKIE } from "@/lib/auth";
import { getStripe } from "@/lib/billing";
import { getLocale } from "@/lib/i18n-server";

const ongoingStatuses = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"];
export async function PATCH(request:Request) {
  const user=await currentUser();if(!user)return NextResponse.json({error:"Please sign in."},{status:401});
  const data=await request.json().catch(()=>null) as {name?:string}|null;const name=data?.name?.trim();
  if(!name||name.length>100)return NextResponse.json({error:"Enter a name of up to 100 characters."},{status:400});
  await db.update(users).set({name}).where(eq(users.id,user.id));return NextResponse.json({ok:true});
}
export async function DELETE() {
  const user=await currentUser();if(!user)return NextResponse.json({error:"Please sign in."},{status:401});const es=(await getLocale())==="es";
  if(!user.emailVerifiedAt)return NextResponse.json({error:es?"Verifica tu correo antes de eliminar tu cuenta.":"Verify your email before deleting your account.",code:"email_not_verified"},{status:403});
  if(user.role==="owner")return NextResponse.json({error:es?"Transfiere la cuenta propietaria antes de eliminarla.":"Owner accounts must be transferred before deletion."},{status:400});
  const message=es?"Cancela tu suscripción en el portal de facturación y espera a que termine antes de eliminar tu cuenta.":"Cancel your subscription in the billing portal and wait for it to end before deleting your account.";
  const [ongoing]=await db.select({id:subscriptions.stripeSubscriptionId}).from(subscriptions).where(and(eq(subscriptions.userId,user.id),inArray(subscriptions.status,ongoingStatuses))).limit(1);
  if(ongoing)return NextResponse.json({error:message},{status:409});
  // Check Stripe as well, because a checkout could have completed before its webhook arrived.
  if(user.stripeCustomerId){
    const stripe=getStripe();if(!stripe)return NextResponse.json({error:es?"No pudimos verificar tu facturación. Inténtalo más tarde.":"We could not verify billing. Please try again later."},{status:503});
    try{
      const hasOngoing=async()=>{const list=await stripe.subscriptions.list({customer:user.stripeCustomerId!,status:"all",limit:100});return list.data.some(subscription=>ongoingStatuses.includes(subscription.status));};
      if(await hasOngoing())return NextResponse.json({error:message},{status:409});
      const sessions=await stripe.checkout.sessions.list({customer:user.stripeCustomerId,status:"open",limit:100});
      for(const session of sessions.data){if(session.mode==="subscription")await stripe.checkout.sessions.expire(session.id);}
      if(await hasOngoing())return NextResponse.json({error:message},{status:409});
    }catch(error){console.error("Unable to verify billing before account deletion",error instanceof Error?error.message:"unknown error");return NextResponse.json({error:es?"No pudimos verificar tu facturación. Inténtalo más tarde.":"We could not verify billing. Please try again later."},{status:503});}
  }
  await db.delete(users).where(eq(users.id,user.id));const response=NextResponse.json({ok:true});response.cookies.set(SESSION_COOKIE,"",{path:"/",maxAge:0,httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production"});return response;
}
