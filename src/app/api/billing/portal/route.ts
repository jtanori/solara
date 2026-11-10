import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { appOrigin, getStripe } from "@/lib/billing";
import { getLocale } from "@/lib/i18n-server";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const user = await currentUser();
  const locale = await getLocale();
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const stripe = getStripe();
  if (!stripe || !user.stripeCustomerId) return NextResponse.json({ error: locale === "es" ? "No hay una cuenta de facturación disponible." : "No billing account is available." }, { status: 400 });
  try {
    const session = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${appOrigin(request)}/dashboard#plan`, locale: locale === "es" ? "es" : "en" });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Stripe portal failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: locale === "es" ? "No pudimos abrir el portal de facturación." : "Could not open the billing portal." }, { status: 503 });
  }
}
