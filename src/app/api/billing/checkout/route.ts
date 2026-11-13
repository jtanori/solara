import { and, eq, inArray, sql } from "drizzle-orm";
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
    /*
     * ONE lock scope for the whole decision, not just for linking a customer.
     *
     * An earlier version held the lock only while creating and linking the
     * customer, then released it and went on to list sessions, create a session,
     * and return an existing session's URL. Deletion takes the same lock, so it
     * could hold it, finish listing/expiring sessions, and then this request
     * could create a session - or hand back one it found - that deletion had
     * already decided was gone. The final "is the user still there?" check was a
     * separate transaction: a check, not mutual exclusion.
     *
     * Everything below runs while deletion is excluded for this user: the user
     * re-read, customer create/link, provider subscription and open-session
     * lookups, session create, and the decision to return a URL. This applies to
     * BOTH paths - a user who already has a customer id re-checks survival and
     * creates its session under the same lock, which the previous version did
     * not do at all.
     *
     * Cost: holds the lock across Stripe I/O and a pool connection for the whole
     * scope. `lock_timeout` bounds acquisition (a stuck deletion must not pin
     * checkout); `statement_timeout` bounds SQL. Neither bounds the HTTP calls
     * themselves - a known limit, documented, not papered over.
     */
    const outcome = await db.transaction(async tx => {
      await tx.execute(sql`select set_config('lock_timeout', '5s', true)`);
      await tx.execute(sql`select set_config('statement_timeout', '60s', true)`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`account-deletion:${user.id}`}))`);

      /*
       * Deletion may have won before we got the lock. `currentUser()` was read
       * before this request did any I/O, and `db.update` on a missing row affects
       * zero rows without throwing - the silent no-op that let the original race
       * bill a deleted account.
       */
      const [survivor] = await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).limit(1);
      if (!survivor) return { kind: "gone" as const, orphanCustomer: null };

      let customer = user.stripeCustomerId;
      if (!customer) {
        const created = await stripe.customers.create(
          { email: user.email, metadata: { solara_user_id: user.id } },
          { idempotencyKey: `solara-customer-${user.id}` },
        );
        const written = await tx
          .update(users)
          .set({ stripeCustomerId: created.id })
          .where(eq(users.id, user.id))
          .returning({ id: users.id });

        if (written.length === 0) {
          // Cannot happen while the lock is held, but a silent orphan would be
          // worse than a redundant guard.
          return { kind: "gone" as const, orphanCustomer: created.id };
        }
        customer = created.id;
      }

      // Query Stripe too: a completed checkout may not have reached our webhook yet.
      const providerSubscriptions = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
      if (providerSubscriptions.data.some(subscription => ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(subscription.status))) {
        return { kind: "already-subscribed" as const };
      }

      const openSessions = await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 });
      const openSession = openSessions.data.find(candidate => candidate.mode === "subscription" && candidate.currency === currency && candidate.url);
      // Handing back an existing URL is part of the decision: the session must
      // not be payable for an account that no longer exists, so it is returned
      // from inside the lock rather than from a scope deletion can interleave.
      if (openSession?.url) return { kind: "url" as const, url: openSession.url };

      const origin = appOrigin(request);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription", customer,
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

      return { kind: "url" as const, url: session.url };
    });

    if (outcome.kind === "gone") {
      // Created moments before the row vanished: leave no orphan customer.
      if (outcome.orphanCustomer) {
        await stripe.customers.del(outcome.orphanCustomer).catch(() => undefined);
      }
      log.error("billing.checkout_user_vanished", { ...requestMeta(request), userId: user.id, customerId: outcome.orphanCustomer });
      return NextResponse.json({ error: "Please sign in first." }, { status: 401 });
    }
    if (outcome.kind === "already-subscribed") {
      return NextResponse.json({ error: locale === "es" ? "Ya tienes una suscripción. Adminístrala desde tu cuenta." : "You already have a subscription. Manage it from your account." }, { status: 409 });
    }
    return NextResponse.json({ url: outcome.url });
  } catch (error) {
    log.error("billing.checkout_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json({ error: locale === "es" ? "No pudimos abrir el pago. Inténtalo de nuevo." : "Could not open checkout. Please try again." }, { status: 503 });
  }
}
