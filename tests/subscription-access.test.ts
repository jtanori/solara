import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../src/db";
import { subscriptions, users } from "../src/db/schema";
import { hasPremiumAccess } from "../src/lib/auth";

// Full access matrix for #9 — requires a disposable local DB
test(
  "subscription fixtures: active/trialing grant Premium, past_due/expired/canceled do not",
  { skip: process.env.RUN_BILLING_INTEGRATION_TESTS !== "1" },
  async () => {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
    assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Billing tests must run against a local disposable database");
    const suffix = randomBytes(4).toString("hex");
    const makeUser = async (email: string) => {
      const [user] = await db.insert(users).values({ name: "Fixture", email, passwordHash: "not-a-login" }).returning({ id: users.id });
      return user.id;
    };
    const now = Date.now();
    const future = new Date(now + 30 * 24 * 60 * 60 * 1000);
    const past = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const cases: Array<{ status: string; grantsAccess: boolean; periodEnd: Date; expect: boolean; label: string }> = [
      { status: "active", grantsAccess: true, periodEnd: future, expect: true, label: "active grants" },
      { status: "trialing", grantsAccess: true, periodEnd: future, expect: true, label: "trialing grants" },
      { status: "past_due", grantsAccess: false, periodEnd: future, expect: false, label: "past_due denies" },
      { status: "past_due", grantsAccess: true, periodEnd: future, expect: false, label: "past_due denies even if grantsAccess true" },
      { status: "active", grantsAccess: true, periodEnd: past, expect: false, label: "expired denies (periodEnd in past)" },
      { status: "canceled", grantsAccess: false, periodEnd: future, expect: false, label: "canceled denies" },
      { status: "canceled", grantsAccess: false, periodEnd: past, expect: false, label: "canceled+expired denies" },
    ];
    const createdUserIds: string[] = [];
    const createdSubIds: string[] = [];
    try {
      for (const c of cases) {
        const email = `sub-access-${c.label.replace(/\s+/g, "-")}-${suffix}@example.test`;
        const userId = await makeUser(email);
        createdUserIds.push(userId);
        const subId = `sub_${c.label.replace(/\s+/g, "_")}_${suffix}_${Math.random().toString(36).slice(2, 6)}`;
        createdSubIds.push(subId);
        await db.insert(subscriptions).values({
          stripeSubscriptionId: subId,
          userId,
          stripeCustomerId: `cus_${subId}`,
          stripePriceId: "price_mxn_premium_local",
          status: c.status,
          currency: "mxn",
          grantsAccess: c.grantsAccess,
          currentPeriodEnd: c.periodEnd,
        });
        assert.equal(await hasPremiumAccess(userId), c.expect, `${c.label}: status=${c.status} grantsAccess=${c.grantsAccess} periodEnd=${c.periodEnd.toISOString()}`);
      }
      // also verify the 9 seeded fixture accounts when they exist (optional — seed may not have run in this DB)
      // we don't fail if they are missing, but if present they must match matrix
      const expectedFixtures: Record<string, boolean> = {
        "active-premium@solara.local": true,
        "trialing-premium@solara.local": true,
        "pastdue-premium@solara.local": false,
        "expired-premium@solara.local": false,
        "canceled-premium@solara.local": false,
      };
      for (const [email, expect] of Object.entries(expectedFixtures)) {
        const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
        if (row) {
          assert.equal(await hasPremiumAccess(row.id), expect, `seeded fixture ${email} should ${expect ? "grant" : "deny"} Premium`);
        }
      }
    } finally {
      if (createdSubIds.length) await db.delete(subscriptions).where(inArray(subscriptions.stripeSubscriptionId, createdSubIds));
      for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id));
      // Intentionally do not end the shared Pool here; let the process exit handle it.
      // (Node's test runner may isolate files in separate processes, so cross-file Pool sharing is not the failure mode it once appeared to be.)
    }
  },
);

test("orphan user without subscription does not have Premium", { skip: process.env.RUN_BILLING_INTEGRATION_TESTS !== "1" }, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Billing tests must run against a local disposable database");
  const suffix = randomBytes(4).toString("hex");
  const email = `no-sub-${suffix}@example.test`;
  const [user] = await db.insert(users).values({ name: "No Sub", email, passwordHash: "x" }).returning({ id: users.id });
  try {
    assert.equal(await hasPremiumAccess(user.id), false);
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});
