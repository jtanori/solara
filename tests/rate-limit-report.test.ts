import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { inArray } from "drizzle-orm";
import { db } from "../src/db";
import { rateLimits } from "../src/db/schema";
import { listRateLimitReport } from "../src/lib/rate-limit-report";

test("the operator report shows triggered rows before untriggered NULL timestamps", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Rate-limit report tests require a loopback database");

  const suffix = randomBytes(6).toString("hex");
  const keys = Array.from({ length: 56 }, (_, index) => `report:${suffix}:${index}`);
  const triggered = `report:${suffix}:triggered`;

  try {
    await db.insert(rateLimits).values(
      Array.from({ length: 55 }, (_, index) => ({
        key: keys[index],
        count: 1,
        failureCount: 0,
        expiresAt: new Date(Date.now() + 60_000),
      })),
    );
    await db.insert(rateLimits).values({
      key: triggered,
      count: 1,
      failureCount: 1,
      expiresAt: new Date(Date.now() + 60_000),
      lastTriggeredAt: new Date(),
    });

    const rows = await listRateLimitReport(50);
    assert.equal(rows[0]?.key, triggered);
  } finally {
    await db.delete(rateLimits).where(inArray(rateLimits.key, [...keys, triggered]));
  }
});
