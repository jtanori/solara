import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { emailTokens, users } from "../src/db/schema";
import {
  consumeEmailToken,
  createEmailVerificationToken,
  emailVerificationUrl,
  hashEmailToken,
} from "../src/lib/email-verification";
import type { EmailTokenPurpose } from "../src/lib/types";

async function makeUser() {
  const suffix = randomBytes(6).toString("hex");
  const [user] = await db.insert(users).values({
    name: "Verification test",
    email: `verify-${suffix}@example.test`,
    passwordHash: "not-a-login",
  }).returning({ id: users.id });
  return user.id;
}

test("verification URLs contain the token and locale", () => {
  const url = emailVerificationUrl("abc123", "es", "https://solara-stg.vercel.app");
  assert.equal(
    url,
    "https://solara-stg.vercel.app/api/auth/verify?token=abc123&lang=es",
  );
});

test("a valid token verifies the user once and is stored hashed", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Email token tests require a loopback database");

  const userId = await makeUser();
  try {
    const created = await createEmailVerificationToken(userId, "email_verification", { cooldownSeconds: 0 });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const [stored] = await db
      .select({ tokenHash: emailTokens.tokenHash })
      .from(emailTokens)
      .where(eq(emailTokens.userId, userId))
      .limit(1);
    assert.equal(stored.tokenHash, hashEmailToken(created.token));
    assert.notEqual(stored.tokenHash, created.token);

    const verified = await consumeEmailToken(created.token);
    assert.deepEqual(verified, { status: "verified", userId });

    const [user] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    assert.ok(user.emailVerifiedAt);

    const reused = await consumeEmailToken(created.token);
    assert.deepEqual(reused, { status: "used" });
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("expired and wrong-purpose tokens fail", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Email token tests require a loopback database");

  const userId = await makeUser();
  try {
    const expired = await createEmailVerificationToken(userId, "email_verification", {
      cooldownSeconds: 0,
      ttlHours: 0,
    });
    assert.equal(expired.status, "created");
    if (expired.status !== "created") return;
    assert.deepEqual(await consumeEmailToken(expired.token), { status: "expired" });

    const wrongPurpose = await createEmailVerificationToken(userId, "email_verification", { cooldownSeconds: 0 });
    assert.equal(wrongPurpose.status, "created");
    if (wrongPurpose.status !== "created") return;
    assert.deepEqual(
      await consumeEmailToken(wrongPurpose.token, "password_reset" as EmailTokenPurpose),
      { status: "invalid" },
    );
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("resend cooldown prevents immediate token churn", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Email token tests require a loopback database");

  const userId = await makeUser();
  try {
    const first = await createEmailVerificationToken(userId);
    assert.equal(first.status, "created");
    const second = await createEmailVerificationToken(userId);
    assert.equal(second.status, "cooldown");
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});
