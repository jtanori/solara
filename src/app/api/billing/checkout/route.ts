import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { subscriptions, users } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { appOrigin, billingIsConfigured, getStripe, priceIdFor, type BillingCurrency } from "@/lib/billing";
import { getLocale } from "@/lib/i18n-server";
import { log, requestMeta } from "@/lib/log";
import { AUTH_RATE_LIMITS, consumeBudgets, keyFor, rateLimitedResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Test seams. Production passes nothing; the race test injects a Stripe stub and
 * a `currentUser` snapshot so it can drive *this* handler rather than a copy of
 * its logic — the mistake that let the audit-row bug survive a green suite.
 */
export type CheckoutDeps = {
  stripe?: ReturnType<typeof getStripe>;
  currentUser?: typeof currentUser;
  /** `getLocale()` reads Next's request-scoped cookies, so tests supply one. */
  locale?: "en" | "es";
};

export async function POST(request: Request) {
  return startCheckout(request);
}

export async function startCheckout(request: Request, deps: CheckoutDeps = {}) {
  const user = await (deps.currentUser ?? currentUser)();
  if (!user) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
  const locale = deps.locale ?? await getLocale();
  if (!user.emailVerifiedAt) {
    return NextResponse.json({
      error: locale === "es"
        ? "Verifica tu correo antes de iniciar el pago."
        : "Verify your email before starting checkout.",
      code: "email_not_verified",
    }, { status: 403 });
  }
  const stripe = deps.stripe ?? getStripe();
  if (!stripe || !billingIsConfigured()) return NextResponse.json({ error: locale === "es" ? "Los pagos aún no están configurados." : "Payments are not configured yet." }, { status: 503 });

  /*
   * Every request below hits the Stripe API at least twice (price lookup,
   * subscription list). Limited per account (auth amendment §S7) so a loop
   * cannot burn the API budget; the 409 guard already prevents duplicate
   * subscriptions, so this is about cost and noise, not correctness.
   */
  const budget = await consumeBudgets([
    { key: keyFor("billing:checkout:user", user.id), policy: AUTH_RATE_LIMITS.billingCheckoutUser, kind: "billing_checkout_user" },
  ], requestMeta(request));
  if (!budget.allowed) {
    return rateLimitedResponse(locale, budget.retryAfterSeconds, {
      en: "Too many checkout attempts. Please wait a moment.",
      es: "Demasiados intentos de pago. Espera un momento.",
    });
  }
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
      /*
       * `currentUser()` was read before this request started doing I/O, so the
       * account may have been deleted in between (#144). `db.update` on a
       * missing row affects zero rows and does *not* throw, so the old code
       * created a Stripe customer and a subscription checkout for a user that
       * no longer existed — and Stripe kept billing them.
       *
       * Check survival first, then write the link back and require it to have
       * landed. If either fails the account is gone; stop before touching Stripe.
       */
      const [survivor] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id)).limit(1);
      if (!survivor) {
        return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
      }
      const customer = await stripe.customers.create({ email: user.email, metadata: { solara_user_id: user.id } }, { idempotencyKey: `solara-customer-${user.id}` });
      customerId = customer.id;
      const linked = await db
        .update(users)
        .set({ stripeCustomerId: customerId })
        .where(eq(users.id, user.id))
        .returning({ id: users.id });
      if (linked.length === 0) {
        // The account vanished between the select and the update. The customer
        // now exists with nothing pointing at it, so remove it rather than
        // leave a billable orphan behind.
        await stripe.customers.del(customerId).catch(() => undefined);
        log.error("billing.checkout_user_vanished", { ...requestMeta(request), userId: user.id, customerId });
        return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
      }
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
    // Last look before handing back a payable URL: a deletion that landed while
    // the session was being created would otherwise leave a checkout that bills
    // an account nobody owns (#144).
    const [stillThere] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id)).limit(1);
    if (!stillThere) {
      await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
      log.error("billing.checkout_expired_after_deletion", { ...requestMeta(request), userId: user.id, sessionId: session.id });
      return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
    }
    return NextResponse.json({ url: session.url });
  } catch (error) {
    log.error("billing.checkout_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json({ error: locale === "es" ? "No pudimos abrir el pago. Inténtalo de nuevo." : "Could not open checkout. Please try again." }, { status: 503 });
  }
}
