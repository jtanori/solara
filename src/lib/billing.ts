import Stripe from "stripe";

export type BillingCurrency = "mxn" | "usd";
export type PriceOption = { currency: BillingCurrency; amount: number; interval: string; intervalCount: number };

/**
 * Transport bounds for every Stripe call.
 *
 * The SDK's default timeout is 80 seconds. Two code paths hold a database
 * transaction — and therefore a pooled connection — across Stripe I/O (checkout
 * under the per-user lock, and the deletion gate), and SQL timeouts cannot bound
 * an HTTP request. An 80-second stall per call, times a few sequential calls,
 * would pin connections long enough for unrelated requests to queue behind them.
 *
 * 10s per request with one retry bounds a single call to roughly 20s. `timeout`
 * is a transport deadline: an aborted request is ambiguous (it may have reached
 * Stripe), so the callers that matter are written to be safe under that
 * ambiguity — checkout links a customer with an idempotency key, and deletion is
 * fail-closed on an unverifiable answer.
 */
export const STRIPE_TIMEOUT_MS = 10_000;
export const STRIPE_MAX_NETWORK_RETRIES = 1;

export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key
    ? new Stripe(key, { timeout: STRIPE_TIMEOUT_MS, maxNetworkRetries: STRIPE_MAX_NETWORK_RETRIES })
    : null;
}
export function priceIdFor(currency: BillingCurrency) {
  return currency === "mxn" ? process.env.STRIPE_PRICE_ID_MXN : process.env.STRIPE_PRICE_ID_USD;
}
export function billingIsConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_PRICE_ID_MXN);
}
export function isPremiumPrice(priceId: string) {
  const allowed = [process.env.STRIPE_PRICE_ID_MXN, process.env.STRIPE_PRICE_ID_USD, ...(process.env.STRIPE_PREMIUM_PRICE_IDS ?? "").split(",")]
    .map(value => value?.trim()).filter(Boolean);
  return allowed.includes(priceId);
}
export function appOrigin(request: Request) {
  const configured = process.env.APP_URL;
  if (configured) return new URL(configured).origin;
  const origin = request.headers.get("origin");
  return origin ? new URL(origin).origin : new URL(request.url).origin;
}
export async function getPriceCatalog(): Promise<PriceOption[]> {
  const stripe = getStripe();
  if (!stripe || !billingIsConfigured()) return [];
  const currencies: BillingCurrency[] = ["mxn", "usd"];
  const prices = await Promise.all(currencies.map(async currency => {
    const id = priceIdFor(currency);
    if (!id) return null;
    try {
      const price = await stripe.prices.retrieve(id);
      if (!price.active || price.currency !== currency || !price.recurring || price.unit_amount == null) return null;
      return { currency, amount: price.unit_amount, interval: price.recurring.interval, intervalCount: price.recurring.interval_count } satisfies PriceOption;
    } catch { return null; }
  }));
  return prices.filter((price): price is PriceOption => price !== null);
}
