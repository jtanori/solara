import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { emailTokens, sessions, users } from "../src/db/schema";
import { createSession } from "../src/lib/auth";
import {
  claimAccountWithToken,
  createEmailVerificationToken,
  discardEmailVerificationToken,
  emailVerificationUrl,
  finalizeEmailVerificationToken,
  hashEmailToken,
} from "../src/lib/email-verification";
import { hashPassword, verifyPassword } from "../src/lib/passwords";
import type { EmailTokenPurpose } from "../src/lib/types";

async function makeUser() {
  const suffix = randomBytes(6).toString("hex");
  const [user] = await db.insert(users).values({
    name: "Claim test",
    email: `claim-${suffix}@example.test`,
    passwordHash: "pending:no-credentials",
  }).returning({ id: users.id });
  return user.id;
}

test("claim URLs keep the token in the fragment", () => {
  const url = emailVerificationUrl("abc123", "es", "https://solara-stg.vercel.app");
  assert.equal(
    url,
    "https://solara-stg.vercel.app/verify-email?lang=es#token=abc123",
  );
  assert.doesNotMatch(url, /\?token=/);
});

test("a valid claim sets the password, verifies the user, and is single-use", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

  const userId = await makeUser();
  try {
    await createSession(userId);
    const created = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    assert.equal(created.status, "created");
    if (created.status !== "created") return;

    const [stored] = await db
      .select({ tokenHash: emailTokens.tokenHash })
      .from(emailTokens)
      .where(eq(emailTokens.userId, userId))
      .limit(1);
    assert.equal(stored.tokenHash, hashEmailToken(created.token));
    assert.notEqual(stored.tokenHash, created.token);

    const newPassword = "claimed-password-12";
    const claimed = await claimAccountWithToken(created.token, await hashPassword(newPassword));
    assert.deepEqual(claimed, { status: "claimed", userId });

    const [user] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    assert.ok(user.emailVerifiedAt);
    assert.equal(await verifyPassword(newPassword, user.passwordHash), true);
    assert.equal((await db.select().from(sessions).where(eq(sessions.userId, userId))).length, 0);

    const reused = await claimAccountWithToken(created.token, await hashPassword(newPassword));
    assert.deepEqual(reused, { status: "used" });
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("expired and wrong-purpose claim tokens fail", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

  const userId = await makeUser();
  try {
    const expired = await createEmailVerificationToken(userId, "account_claim", {
      cooldownSeconds: 0,
      ttlHours: 0,
    });
    assert.equal(expired.status, "created");
    if (expired.status !== "created") return;
    assert.deepEqual(
      await claimAccountWithToken(expired.token, await hashPassword("claimed-password-12")),
      { status: "expired" },
    );

    const wrongPurpose = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    assert.equal(wrongPurpose.status, "created");
    if (wrongPurpose.status !== "created") return;
    assert.deepEqual(
      await claimAccountWithToken(
        wrongPurpose.token,
        await hashPassword("claimed-password-12"),
        "email_verification" as EmailTokenPurpose,
      ),
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
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

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

test("a failed delivery keeps the previous claim link usable", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

  const userId = await makeUser();
  try {
    const first = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    assert.equal(first.status, "created");
    if (first.status !== "created") return;
    await finalizeEmailVerificationToken(first.tokenHash, userId, "account_claim");

    const second = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    assert.equal(second.status, "created");
    if (second.status !== "created") return;
    await discardEmailVerificationToken(second.tokenHash);

    const newPassword = "claimed-password-12";
    const claimed = await claimAccountWithToken(first.token, await hashPassword(newPassword));
    assert.deepEqual(claimed, { status: "claimed", userId });
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("concurrent resends create at most one new token", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

  const userId = await makeUser();
  try {
    const results = await Promise.all([
      createEmailVerificationToken(userId),
      createEmailVerificationToken(userId),
      createEmailVerificationToken(userId),
    ]);
    assert.equal(results.filter((result) => result.status === "created").length, 1);
    assert.equal(results.filter((result) => result.status === "cooldown").length, 2);
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});
