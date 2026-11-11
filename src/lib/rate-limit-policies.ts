/**
 * Rate-limit policy tables — configuration only, no imports of the database.
 *
 * Split out of `rate-limit.ts` so that reading a limit (a route, a test, a
 * config audit) does not drag in `@/db` and therefore does not require
 * `DATABASE_URL` to be set. `rate-limit.ts` re-exports everything here, so the
 * public surface is unchanged.
 */

export type RateLimitPolicy = {
  limit: number;
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: Date;
  blockedUntil: Date | null;
};

export type RateLimitContext = {
  requestId?: string;
  route?: string;
};

export type FailureBackoff = {
  threshold: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  windowSeconds: number;
};

export const AUTH_RATE_LIMITS = {
  signupIp: { limit: 5, windowSeconds: 60 * 60 },
  signupEmail: { limit: 3, windowSeconds: 60 * 60 },
  loginIp: { limit: 100, windowSeconds: 15 * 60 },
  loginIpFailures: { limit: 50, windowSeconds: 15 * 60 },
  claimIp: { limit: 10, windowSeconds: 60 * 60 },
  verifyRequestEmail: { limit: 3, windowSeconds: 15 * 60 },
  verifyRequestIp: { limit: 10, windowSeconds: 60 * 60 },
  resetRequestEmail: { limit: 3, windowSeconds: 60 * 60 },
  resetRequestIp: { limit: 5, windowSeconds: 60 * 60 },
  resetConfirmIp: { limit: 10, windowSeconds: 60 * 60 },
  placesIp: { limit: 30, windowSeconds: 60 },
  cspReportIp: { limit: 60, windowSeconds: 60 },
  /*
   * Metered surfaces (auth amendment §S2, §S7). These run work whose cost is
   * not just CPU: readings generation dispatches LLM calls, the PDF route
   * rasterises, and checkout/portal call Stripe. The pipeline's per-document
   * ceiling (`TIER_CEILING_MXN`) bounds ONE document; it is not a per-user cap,
   * so without these an account can loop the endpoint.
   */
  readingsCreateIp: { limit: 20, windowSeconds: 60 * 60 },
  readingsCreateUser: { limit: 10, windowSeconds: 60 * 60 },
  readingPdfUser: { limit: 20, windowSeconds: 60 * 60 },
  billingCheckoutUser: { limit: 10, windowSeconds: 60 },
  billingPortalUser: { limit: 10, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export const AUTH_FAILURE_BACKOFF: FailureBackoff = {
  threshold: 5,
  baseDelaySeconds: 30,
  maxDelaySeconds: 15 * 60,
  windowSeconds: 15 * 60,
};

export const ACCOUNT_FAILURE_BACKOFF: FailureBackoff = {
  threshold: 10,
  baseDelaySeconds: 30,
  maxDelaySeconds: 15 * 60,
  windowSeconds: 15 * 60,
};
