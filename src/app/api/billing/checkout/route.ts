import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { subscriptions, users } from "@/db/schema";
import { currentUser, sameOrigin } from "@/lib/auth";
import { appOrigin, billingIsConfigured, getStripe, priceIdFor, type BillingCurrency } from "@/lib/billing";
import { getLocale } from "@/lib/i18n-server";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  const locale = await getLocale();
  const stripe = getStripe();
  if (!stripe || !billingIsConfigured()) return NextResponse.json({ error: locale === "es" ? "Los pagos aún no están configurados." : "Payments are not configured yet." }, { status: 503 });
  const data = await request.json().catch(() => ({})) as { currency?: string };
  const currency: BillingCurrency = data.currency === "usd" ? "usd" : "mxn";
  const priceId = priceIdFor(currency);
  if (!priceId) return NextResponse.json({ error: locale === "es" ? "Esta moneda no está disponible." : "This currency is not available." }, { status: 400 });
  const [existing] = await db.select({ id: subscriptions.stripeSubscriptionId }).from(subscriptions).where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]))).limit(1);
  if (existing) return NextResponse.json({ error: locale === "es" ? "Ya tienes una suscripción. Adminístrala desde tu cuenta." : "You already have a subscription. Manage it from your account." }, { status: 409 });
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (!price.active || price.currency !== currency || !price.recurring || price.unit_amount == null) return NextResponse.json({ error: "Configured price is unavailable." }, { status: 503 });
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { solara_user_id: user.id } }, { idempotencyKey: `solara-customer-${user.id}` });
      customerId = customer.id;
      await db.update(users).set({ stripeCustomerId: customerId }).where(eq(users.id, user.id));
    }
    // Query Stripe too: a completed checkout may not have reached our webhook yet.
    const providerSubscriptions = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    if (providerSubscriptions.data.some(subscription => ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(subscription.status))) {
      return NextResponse.json({ error: locale === "es" ? "Ya tienes una suscripción. Adminístrala desde tu cuenta." : "You already have a subscription. Manage it from your account." }, { status: 409 });
    }
    const openSessions = await stripe.checkout.sessions.list({ customer: customerId, status: "open", limit: 100 });
    const openSession = openSessions.data.find(session => session.mode === "subscription" && session.currency === currency && session.url);
    if (openSession?.url) return NextResponse.json({ url: openSession.url });
    const origin = appOrigin(request);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", customer: customerId,
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { solara_user_id: user.id, solara_product: "premium" } },
      metadata: { solara_user_id: user.id },
      locale: locale === "es" ? "es" : "en",
      success_url: `${origin}/dashboard?billing=success`,
      cancel_url: `${origin}/pricing?billing=cancelled`,
      allow_promotion_codes: true,
    }, { idempotencyKey: `solara-checkout-${user.id}-${currency}-${Math.floor(Date.now() / 900000)}` });
    if (!session.url) throw new Error("Checkout URL missing");
    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Stripe checkout failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: locale === "es" ? "No pudimos abrir el pago. Inténtalo de nuevo." : "Could not open checkout. Please try again." }, { status: 503 });
  }
}
