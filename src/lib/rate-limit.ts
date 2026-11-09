import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";

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

export type FailureBackoff = {
  threshold: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  windowSeconds: number;
};

export const AUTH_RATE_LIMITS = {
  signupIp: { limit: 5, windowSeconds: 60 * 60 },
  signupEmail: { limit: 3, windowSeconds: 60 * 60 },
  loginIp: { limit: 10, windowSeconds: 15 * 60 },
  loginEmail: { limit: 10, windowSeconds: 15 * 60 },
  verifyRequestEmail: { limit: 3, windowSeconds: 15 * 60 },
  verifyRequestIp: { limit: 10, windowSeconds: 60 * 60 },
  verifyTokenIp: { limit: 10, windowSeconds: 60 * 60 },
  cspReportIp: { limit: 60, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

export const AUTH_FAILURE_BACKOFF: FailureBackoff = {
  threshold: 5,
  baseDelaySeconds: 30,
  maxDelaySeconds: 15 * 60,
  windowSeconds: 15 * 60,
};

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

function logLimit(kind: string, result: RateLimitResult): void {
  console.warn("[auth-rate-limit]", JSON.stringify({
    event: "rate_limit_triggered",
    kind,
    retryAfterSeconds: result.retryAfterSeconds,
    resetAt: result.resetAt.toISOString(),
    blockedUntil: result.blockedUntil?.toISOString() ?? null,
  }));
}

export async function consumeRateLimit(
  key: string,
  policy: RateLimitPolicy,
  kind: string,
): Promise<RateLimitResult> {
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
    const count = expired ? 1 : row.count + 1;
    const failureCount = expired ? 0 : row.failureCount;
    const blockedUntil = expired ? null : row.blockedUntil;
    const expiresAt = expired
      ? new Date(now.getTime() + policy.windowSeconds * 1000)
      : row.expiresAt;
    const blocked = blockedUntil !== null && blockedUntil.getTime() > now.getTime();
    const overLimit = count > policy.limit;
    const triggered = blocked || overLimit;

    await tx.update(rateLimits).set({
      windowStart: expired ? now : row.windowStart,
      count,
      failureCount,
      blockedUntil,
      expiresAt,
      lastTriggeredAt: triggered ? now : row.lastTriggeredAt,
    }).where(eq(rateLimits.key, key));

    const retryUntil = blocked ? blockedUntil : expiresAt;
    return {
      allowed: !triggered,
      remaining: Math.max(0, policy.limit - count),
      retryAfterSeconds: Math.max(1, Math.ceil((retryUntil.getTime() - now.getTime()) / 1000)),
      resetAt: expiresAt,
      blockedUntil,
    };
  });

  if (!result.allowed) logLimit(kind, result);
  return result;
}

export async function recordAuthFailure(
  key: string,
  config: FailureBackoff = AUTH_FAILURE_BACKOFF,
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
    console.warn("[auth-rate-limit]", JSON.stringify({
      event: "failure_backoff",
      failureCount: result.failureCount,
      blockedUntil: result.blockedUntil.toISOString(),
    }));
  }
  return result;
}

export async function clearAuthFailures(key: string): Promise<void> {
  await db.update(rateLimits)
    .set({ failureCount: 0, blockedUntil: null })
    .where(eq(rateLimits.key, key));
}

export async function resetRateLimit(key: string): Promise<void> {
  await db.update(rateLimits)
    .set({ count: 0, failureCount: 0, blockedUntil: null, lastTriggeredAt: null })
    .where(eq(rateLimits.key, key));
}

export async function getRateLimitState(key: string): Promise<{
  count: number;
  failureCount: number;
  blockedUntil: Date | null;
  lastTriggeredAt: Date | null;
} | null> {
  const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, key)).limit(1);
  if (!row) return null;
  return {
    count: row.count,
    failureCount: row.failureCount,
    blockedUntil: row.blockedUntil,
    lastTriggeredAt: row.lastTriggeredAt,
  };
}
