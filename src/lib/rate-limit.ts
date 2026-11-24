import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import type { DbTransaction } from "@/lib/account-lock";
import { log } from "@/lib/log";
import {
  AUTH_FAILURE_BACKOFF,
  AUTH_RATE_LIMITS,
  ACCOUNT_FAILURE_BACKOFF,
  type FailureBackoff,
  type RateLimitContext,
  type RateLimitPolicy,
  type RateLimitResult,
} from "@/lib/rate-limit-policies";

/**
 * Re-exported so every existing import from "@/lib/rate-limit" keeps working;
 * the tables themselves live in `rate-limit-policies.ts` (no db import).
 */
export {
  AUTH_FAILURE_BACKOFF,
  AUTH_RATE_LIMITS,
  ACCOUNT_FAILURE_BACKOFF,
};
export type { FailureBackoff, RateLimitContext, RateLimitPolicy, RateLimitResult };
export { rateLimitedResponse } from "@/lib/rate-limit-response";

export function hashRateLimitKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip")?.trim()
    || request.headers.get("cf-connecting-ip")?.trim()
    || "unknown";
}

export function keyFor(kind: string, value: string): string {
  return `${kind}:${hashRateLimitKey(value)}`;
}

function logLimit(kind: string, result: RateLimitResult, context: RateLimitContext = {}): void {
  log.warn("rate_limit", {
    ...context,
    kind,
    retryAfterSeconds: result.retryAfterSeconds,
    resetAt: result.resetAt.toISOString(),
    blockedUntil: result.blockedUntil?.toISOString() ?? null,
  });
}

async function consumeRateLimitIn(
  tx: DbTransaction,
  key: string,
  policy: RateLimitPolicy,
): Promise<RateLimitResult> {
  const now = new Date();

  await tx.insert(rateLimits).values({
    key,
    windowStart: now,
    count: 0,
    failureCount: 0,
    expiresAt: now,
  }).onConflictDoNothing();

  const [row] = await tx.select().from(rateLimits).where(eq(rateLimits.key, key)).for("update");
  if (!row) throw new Error("Rate limit row unavailable.");

  const expired = row.expiresAt.getTime() <= now.getTime();
  const count = expired ? 1 : row.count + 1;
  const failureCount = expired ? 0 : row.failureCount;
  const blockedUntil = expired ? null : row.blockedUntil;
  const expiresAt = expired
    ? new Date(now.getTime() + policy.windowSeconds * 1000)
    : row.expiresAt;
  const blocked = blockedUntil !== null && blockedUntil.getTime() > now.getTime();
  const overLimit = count > policy.limit;
  const triggered = blocked || overLimit;
  const nextBlockedUntil = blockedUntil ?? (overLimit ? expiresAt : null);

  await tx.update(rateLimits).set({
    windowStart: expired ? now : row.windowStart,
    count,
    failureCount,
    blockedUntil: nextBlockedUntil,
    expiresAt,
    lastTriggeredAt: triggered ? now : row.lastTriggeredAt,
  }).where(eq(rateLimits.key, key));

  const retryUntil = nextBlockedUntil ?? expiresAt;
  return {
    allowed: !triggered,
    remaining: Math.max(0, policy.limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((retryUntil.getTime() - now.getTime()) / 1000)),
    resetAt: expiresAt,
    blockedUntil: nextBlockedUntil,
  };
}

export async function consumeRateLimitTx(
  tx: DbTransaction,
  key: string,
  policy: RateLimitPolicy,
  kind: string,
  context: RateLimitContext = {},
): Promise<RateLimitResult> {
  const result = await consumeRateLimitIn(tx, key, policy);
  if (!result.allowed) logLimit(kind, result, context);
  return result;
}

export async function consumeRateLimit(
  key: string,
  policy: RateLimitPolicy,
  kind: string,
  context: RateLimitContext = {},
): Promise<RateLimitResult> {
  return db.transaction((tx) => consumeRateLimitTx(tx, key, policy, kind, context));
}

export async function recordAuthFailure(
  key: string,
  config: FailureBackoff = AUTH_FAILURE_BACKOFF,
  context: RateLimitContext = {},
): Promise<{ failureCount: number; blockedUntil: Date | null }> {
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    await tx.insert(rateLimits).values({
      key,
      windowStart: now,
      count: 0,
      failureCount: 0,
      expiresAt: now,
    }).onConflictDoNothing();

    const [row] = await tx.select().from(rateLimits).where(eq(rateLimits.key, key)).for("update");
    if (!row) throw new Error("Rate limit row unavailable.");

    const expired = row.expiresAt.getTime() <= now.getTime();
    const failureCount = (expired ? 0 : row.failureCount) + 1;
    let blockedUntil = expired ? null : row.blockedUntil;

    if (failureCount >= config.threshold) {
      const delay = Math.min(
        config.baseDelaySeconds * 2 ** (failureCount - config.threshold),
        config.maxDelaySeconds,
      );
      blockedUntil = new Date(now.getTime() + delay * 1000);
    }

    const expiresAt = new Date(Math.max(
      (expired ? now : row.expiresAt).getTime(),
      now.getTime() + config.windowSeconds * 1000,
    ));

    await tx.update(rateLimits).set({
      windowStart: expired ? now : row.windowStart,
      count: expired ? 0 : row.count,
      failureCount,
      blockedUntil,
      expiresAt,
      lastTriggeredAt: failureCount >= config.threshold ? now : row.lastTriggeredAt,
    }).where(eq(rateLimits.key, key));

    return { failureCount, blockedUntil };
  });

  if (result.blockedUntil) {
    log.warn("auth.failure_backoff", {
      ...context,
      failureCount: result.failureCount,
      blockedUntil: result.blockedUntil.toISOString(),
    });
  }
  return result;
}

export async function clearAuthFailures(key: string): Promise<void> {
  await db.update(rateLimits)
    .set({ failureCount: 0, blockedUntil: null })
    .where(eq(rateLimits.key, key));
}

export async function getRateLimitState(key: string): Promise<{
  count: number;
  failureCount: number;
  blockedUntil: Date | null;
  lastTriggeredAt: Date | null;
  expiresAt: Date;
} | null> {
  const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if (!row) return null;
  return {
    count: row.count,
    failureCount: row.failureCount,
    blockedUntil: row.blockedUntil,
    lastTriggeredAt: row.lastTriggeredAt,
    expiresAt: row.expiresAt,
  };
}

export async function getRateLimitStateTx(
  tx: DbTransaction,
  key: string,
): Promise<{
  count: number;
  failureCount: number;
  blockedUntil: Date | null;
  lastTriggeredAt: Date | null;
  expiresAt: Date;
} | null> {
  const [row] = await tx.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if (!row) return null;
  return {
    count: row.count,
    failureCount: row.failureCount,
    blockedUntil: row.blockedUntil,
    lastTriggeredAt: row.lastTriggeredAt,
    expiresAt: row.expiresAt,
  };
}

export async function recordAuthFailureTx(
  tx: DbTransaction,
  key: string,
  config: FailureBackoff = ACCOUNT_FAILURE_BACKOFF,
  context: RateLimitContext = {},
): Promise<{ failureCount: number; blockedUntil: Date | null }> {
  const now = new Date();
  await tx.insert(rateLimits).values({
    key,
    windowStart: now,
    count: 0,
    failureCount: 0,
    expiresAt: now,
  }).onConflictDoNothing();

  const [row] = await tx.select().from(rateLimits).where(eq(rateLimits.key, key)).for("update");
  if (!row) throw new Error("Rate limit row unavailable.");

  const expired = row.expiresAt.getTime() <= now.getTime();
  const failureCount = (expired ? 0 : row.failureCount) + 1;
  let blockedUntil = expired ? null : row.blockedUntil;

  if (failureCount >= config.threshold) {
    const delay = Math.min(
      config.baseDelaySeconds * 2 ** (failureCount - config.threshold),
      config.maxDelaySeconds,
    );
    blockedUntil = new Date(now.getTime() + delay * 1000);
  }

  const expiresAt = new Date(Math.max(
    (expired ? now : row.expiresAt).getTime(),
    now.getTime() + config.windowSeconds * 1000,
  ));

  await tx.update(rateLimits).set({
    windowStart: expired ? now : row.windowStart,
    count: expired ? 0 : row.count,
    failureCount,
    blockedUntil,
    expiresAt,
    lastTriggeredAt: failureCount >= config.threshold ? now : row.lastTriggeredAt,
  }).where(eq(rateLimits.key, key));

  if (blockedUntil) {
    log.warn("auth.account_failure_backoff", {
      ...context,
      failureCount,
      blockedUntil: blockedUntil.toISOString(),
    });
  }

  return { failureCount, blockedUntil };
}

export async function clearAuthFailuresTx(tx: DbTransaction, key: string): Promise<void> {
  await tx.update(rateLimits)
    .set({ failureCount: 0, blockedUntil: null })
    .where(eq(rateLimits.key, key));
}

// ------------------------------------------------------------------ budgets

/**
 * Consume a list of budgets, cheapest first, short-circuiting on the first
 * refusal (auth amendment §S2, §S7).
 *
 * Two details matter and are easy to get wrong:
 *
 *  - **Every budget is consumed before any work starts.** Checking a limit and
 *    then doing the work means the request that trips the limit still pays for
 *    itself; a caller who loops past the cap is refused *before* dispatching.
 *  - **Keying.** Callers pass the per-user key first because a leaked session
 *    is the more likely abuse (one account, many requests) and because no
 *    identity is needed to derive it. The IP budget is a second, coarser net
 *    for the case where many accounts share one origin.
 *
 * A budget whose key is the empty string is skipped: an unauthenticated request
 * has no user key, and hashing "" would make every anonymous caller share one
 * bucket, which is worse than not counting them at all.
 */
export type Budget = {
  key: string;
  policy: RateLimitPolicy;
  /** Log label, e.g. "readings_create_user". */
  kind: string;
};

export type BudgetDecision =
  | { allowed: true; retryAfterSeconds: 0 }
  | { allowed: false; retryAfterSeconds: number; kind: string };

export async function consumeBudgets(
  budgets: Budget[],
  context: RateLimitContext = {},
): Promise<BudgetDecision> {
  for (const budget of budgets) {
    if (!budget.key) continue;
    const result = await consumeRateLimit(budget.key, budget.policy, budget.kind, context);
    if (!result.allowed) {
      return { allowed: false, retryAfterSeconds: result.retryAfterSeconds, kind: budget.kind };
    }
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

