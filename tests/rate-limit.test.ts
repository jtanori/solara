import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { inArray } from "drizzle-orm";
import { db } from "../src/db";
import { rateLimits } from "../src/db/schema";
import {
  AUTH_FAILURE_BACKOFF,
  clearAuthFailures,
  clientIp,
  consumeRateLimit,
  getRateLimitState,
  keyFor,
  recordAuthFailure,
} from "../src/lib/rate-limit";

test("clientIp prefers the first forwarded address", () => {
  const request = new Request("http://localhost/api/auth", {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
  });
  assert.equal(clientIp(request), "203.0.113.7");
  assert.equal(
    clientIp(new Request("http://localhost/api/auth", { headers: { "x-real-ip": "198.51.100.4" } })),
    "198.51.100.4",
  );
  assert.equal(clientIp(new Request("http://localhost/api/auth")), "unknown");
});

test("rate limiter blocks after the configured limit and resets independently", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Rate-limit tests require a loopback database");

  const suffix = randomBytes(6).toString("hex");
  const keyA = keyFor("test:rate", `a-${suffix}`);
  const keyB = keyFor("test:rate", `b-${suffix}`);
  const keys = [keyA, keyB];
  const policy = { limit: 2, windowSeconds: 60 };

  try {
    const first = await consumeRateLimit(keyA, policy, "test");
    const second = await consumeRateLimit(keyA, policy, "test");
    const third = await consumeRateLimit(keyA, policy, "test");
    const other = await consumeRateLimit(keyB, policy, "test");

    assert.equal(first.allowed, true);
    assert.equal(first.remaining, 1);
    assert.equal(second.allowed, true);
    assert.equal(second.remaining, 0);
    assert.equal(third.allowed, false);
    assert.ok(third.retryAfterSeconds >= 1);
    assert.equal(other.allowed, true, "a different key must keep its own window");

    const state = await getRateLimitState(keyA);
    assert.equal(state?.count, 3);
    assert.ok(state?.blockedUntil);
  } finally {
    await db.delete(rateLimits).where(inArray(rateLimits.key, keys));
  }
});

test("failed-login backoff blocks the pair and clears on success", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Rate-limit tests require a loopback database");

  const suffix = randomBytes(6).toString("hex");
  const key = keyFor("test:pair", suffix);
  const config = { ...AUTH_FAILURE_BACKOFF, threshold: 2, baseDelaySeconds: 1, maxDelaySeconds: 4, windowSeconds: 60 };

  try {
    const first = await recordAuthFailure(key, config);
    assert.equal(first.failureCount, 1);
    assert.equal(first.blockedUntil, null);

    const second = await recordAuthFailure(key, config);
    assert.equal(second.failureCount, 2);
    assert.ok(second.blockedUntil);
    assert.ok(second.blockedUntil.getTime() > Date.now());

    const state = await getRateLimitState(key);
    assert.equal(state?.failureCount, 2);
    assert.ok(state?.blockedUntil);

    await clearAuthFailures(key);
    const cleared = await getRateLimitState(key);
    assert.equal(cleared?.failureCount, 0);
    assert.equal(cleared?.blockedUntil, null);
  } finally {
    await db.delete(rateLimits).where(inArray(rateLimits.key, [key]));
  }
});
