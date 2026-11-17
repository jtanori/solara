import { z } from "zod";
import { readControlJson } from "@/lib/control-json";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { readings, subscriptions, users } from "@/db/schema";
import { LifecycleLeaseLost, withAccountLifecycleLock } from "@/lib/account-lifecycle-lock";
import { currentUser } from "@/lib/auth";
import { appOrigin, billingIsConfigured, getStripe, priceIdFor, type BillingCurrency } from "@/lib/billing";
import { getLocale } from "@/lib/i18n-server";
import { log, requestMeta } from "@/lib/log";
import { AUTH_RATE_LIMITS, consumeBudgets, keyFor, rateLimitedResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
class CheckoutChartGone extends Error {}

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
  /** Tests inject a dedicated coordination pool through this seam. */
  lifecycleLock?: typeof withAccountLifecycleLock;
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
  let data: { currency?: BillingCurrency; readingId?: string };
  try { data = z.strictObject({ currency: z.enum(["mxn", "usd"]).optional(), readingId: z.string().uuid().optional() }).parse(await readControlJson(request)); }
  catch { return NextResponse.json({ error: locale === "es" ? "Solicitud no válida." : "Invalid request." }, { status: 400 }); }
  const readingId = data.readingId;
  if (readingId) {
    const [chart] = await db.select({ id: readings.id }).from(readings).where(and(eq(readings.id, readingId), eq(readings.userId, user.id))).limit(1);
    if (!chart) return NextResponse.json({ error: "Reading not found." }, { status: 404 });
  }
  const currency: BillingCurrency = data.currency ?? "mxn";
  const priceId = priceIdFor(currency);
  if (!priceId) return NextResponse.json({ error: locale === "es" ? "Esta moneda no está disponible." : "This currency is not available." }, { status: 400 });
  const [existing] = await db.select({ id: subscriptions.stripeSubscriptionId }).from(subscriptions).where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]))).limit(1);
  if (existing) return NextResponse.json({ error: locale === "es" ? "Ya tienes una suscripción. Adminístrala desde tu cuenta." : "You already have a subscription. Manage it from your account." }, { status: 409 });
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (!price.active || price.currency !== currency || !price.recurring || price.unit_amount == null) return NextResponse.json({ error: "Configured price is unavailable." }, { status: 503 });
    /*
     * ONE lease scope for the whole decision, not just for linking a customer.
     *
     * An earlier version held the lock only while creating and linking the
     * customer, then released it and went on to list sessions, create a session,
     * and return an existing session's URL. Deletion takes the same lease, so it
     * could hold it, finish listing/expiring sessions, and then this request
     * could create a session - or hand back one it found - that deletion had
     * already decided was gone.
     *
     * Everything below runs while deletion is excluded for this user: the user
     * re-read, customer create/link, provider subscription and open-session
     * lookups, session create, and the decision to return a URL. This applies to
     * BOTH paths - a user who already has a customer id re-checks survival and
     * creates its session under the same lease, which the previous version did
     * not do at all.
     *
     * Cost: lease queries are short autocommit statements on the app pool. The
     * optional compatibility advisory lock uses the separate coordination pool,
     * so it cannot starve those queries. A slow provider therefore does not pin
     * an app-pool transaction for the whole check. The Stripe client has
     * per-request timeouts.
     */
    const withLock = deps.lifecycleLock ?? withAccountLifecycleLock;
    const outcome = await withLock(user.id, async (clientDb, lease) => {
      /*
       * Re-read under the lease. `currentUser()` was read before this request did
       * any I/O; the row may have been deleted while this request waited, and the
       * customer id may have changed since the snapshot.
       */
      const [survivor] = await clientDb
        .select({ id: users.id, stripeCustomerId: users.stripeCustomerId })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
      if (!survivor) return { kind: "gone" as const, orphanCustomer: null };
      if (readingId) {
        const [chart] = await clientDb.select({ id: readings.id }).from(readings).where(and(eq(readings.id, readingId), eq(readings.userId, user.id))).limit(1);
        if (!chart) return { kind: "chart-gone" as const };
      }

      /*
       * Stop the heartbeat and fence the lease immediately before a result is
       * returned. A URL that leaves this handler must be backed by a lease that
       * is still valid, and the user row must still exist. The lease row is
       * locked first so deletion and checkout share one lock order.
       */
      const assertStillOwner = async () => {
        await lease.stopHeartbeat();
        await clientDb.transaction(async tx => {
          await tx.execute(sql`select set_config('lock_timeout', '5s', true)`);
          await lease.assertHeld(tx);
          const [still] = await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, user.id))
            .for("update");
          if (!still) throw new LifecycleLeaseLost();
          if (readingId) {
            const [chart] = await tx.select({ id: readings.id }).from(readings)
              .where(and(eq(readings.id, readingId), eq(readings.userId, user.id))).for("key share");
            if (!chart) throw new CheckoutChartGone();
          }
        });
      };

      /*
       * Stop before creating Stripe-side state if the lease heartbeat already
       * failed. A final fence cannot undo a customer or session created after
       * takeover; this narrows the window to the in-flight call itself.
       */
      const assertNotLost = () => {
        if (lease.isLost()) throw new LifecycleLeaseLost();
      };

      let customer = survivor.stripeCustomerId;
      if (!customer) {
        assertNotLost();
        const created = await stripe.customers.create(
          { email: user.email, metadata: { solara_user_id: user.id } },
          { idempotencyKey: `solara-customer-${user.id}` },
        );
        if (lease.isLost()) {
          await stripe.customers.del(created.id).catch(() => undefined);
          throw new LifecycleLeaseLost();
        }
        const written = await clientDb
          .update(users)
          .set({ stripeCustomerId: created.id })
          .where(eq(users.id, user.id))
          .returning({ id: users.id });

        if (written.length === 0) {
          // Cannot happen while the lease is held, but a silent orphan would be
          // worse than a redundant guard.
          return { kind: "gone" as const, orphanCustomer: created.id };
        }
        customer = created.id;
      }

      // Query Stripe too: a completed checkout may not have reached our webhook yet.
      const providerSubscriptions = await stripe.subscriptions.list({ customer, status: "all", limit: 100 });
      if (providerSubscriptions.data.some(subscription => ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(subscription.status))) {
        await assertStillOwner();
        return { kind: "already-subscribed" as const };
      }

      const openSessions = await stripe.checkout.sessions.list({ customer, status: "open", limit: 100 });
      const openSession = openSessions.data.find(candidate => candidate.mode === "subscription" && candidate.currency === currency && candidate.url);
      // Handing back an existing URL is part of the decision: the session must
      // not be payable for an account that no longer exists, so it is returned
      // only after the final lease/user fence.
      if (openSession?.url) {
        await assertStillOwner();
        // Do not mint a second payable checkout or silently redirect to a
        // different chart. #143's separate pagination fix remains a release gate.
        if ((openSession.metadata?.solara_reading_id ?? null) !== (readingId ?? null)) return { kind: "context-conflict" as const };
        return { kind: "url" as const, url: openSession.url };
      }

      assertNotLost();
      const origin = appOrigin(request);
      const session = await stripe.checkout.sessions.create({
        mode: "subscription", customer,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: { metadata: { solara_user_id: user.id, solara_product: "premium" } },
        metadata: { solara_user_id: user.id, ...(readingId ? { solara_reading_id: readingId } : {}) },
        locale: locale === "es" ? "es" : "en",
        success_url: `${origin}/dashboard?billing=success${readingId ? `&reading=${readingId}` : ""}`,
        cancel_url: `${origin}/pricing?billing=cancelled${readingId ? `&reading=${readingId}` : ""}`,
        allow_promotion_codes: true,
      }, { idempotencyKey: `solara-checkout-${user.id}-${currency}-${readingId ?? "general"}-${Math.floor(Date.now() / 900000)}` });
      if (!session.url) throw new Error("Checkout URL missing");

      try {
        await assertStillOwner();
      } catch (error) {
        // The session was created moments before the lease was lost. Expire it
        // so a deleted account cannot be handed a payable URL.
        await stripe.checkout.sessions.expire(session.id).catch(() => undefined);
        throw error;
      }

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
    if (outcome.kind === "chart-gone") return NextResponse.json({ error: "Reading not found." }, { status: 404 });
    if (outcome.kind === "context-conflict") return NextResponse.json({ error: locale === "es"
      ? "Ya hay un pago abierto con otro contexto. Vuelve a esa carta o espera a que venza el pago abierto. No creamos un segundo pago."
      : "An open checkout has a different chart context. Return to that chart or wait for the open checkout to expire. We did not create a second checkout.", code: "checkout_context_conflict" }, { status: 409 });
    if (outcome.kind === "already-subscribed") {
      return NextResponse.json({ error: locale === "es" ? "Ya tienes una suscripción. Adminístrala desde tu cuenta." : "You already have a subscription. Manage it from your account." }, { status: 409 });
    }
    return NextResponse.json({ url: outcome.url });
  } catch (error) {
    if (error instanceof CheckoutChartGone) return NextResponse.json({ error: "Reading not found." }, { status: 404 });
    if (error instanceof LifecycleLeaseLost) {
      log.error("billing.checkout_lease_lost", { ...requestMeta(request), userId: user.id });
    } else {
      log.error("billing.checkout_failed", { ...requestMeta(request), userId: user.id, error });
    }
    return NextResponse.json({ error: locale === "es" ? "No pudimos abrir el pago. Inténtalo de nuevo." : "Could not open checkout. Please try again." }, { status: 503 });
  }
}
