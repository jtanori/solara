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

test("finalization is generation-aware and cannot delete a newer token", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

  const userId = await makeUser();
  try {
    const older = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    const newer = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    assert.equal(older.status, "created");
    assert.equal(newer.status, "created");
    if (older.status !== "created" || newer.status !== "created") return;

    assert.equal(await finalizeEmailVerificationToken(older.tokenHash, userId, "account_claim"), false);
    const beforeNewerFinalize = await db.select({ tokenHash: emailTokens.tokenHash }).from(emailTokens).where(eq(emailTokens.userId, userId));
    assert.deepEqual(beforeNewerFinalize.map(row => row.tokenHash).sort(), [older.tokenHash, newer.tokenHash].sort());

    assert.equal(await finalizeEmailVerificationToken(newer.tokenHash, userId, "account_claim"), true);
    assert.equal(await finalizeEmailVerificationToken(older.tokenHash, userId, "account_claim"), false);

    const remaining = await db.select({ tokenHash: emailTokens.tokenHash }).from(emailTokens).where(eq(emailTokens.userId, userId));
    assert.deepEqual(remaining.map(row => row.tokenHash), [newer.tokenHash]);
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("a verified account cannot be claimed again or receive a new claim link", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

  const userId = await makeUser();
  try {
    const first = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    const second = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    assert.equal(first.status, "created");
    assert.equal(second.status, "created");
    if (first.status !== "created" || second.status !== "created") return;

    const password = await hashPassword("claimed-password-12");
    assert.deepEqual(await claimAccountWithToken(first.token, password), { status: "claimed", userId });

    const liveToken = randomBytes(32).toString("base64url");
    await db.insert(emailTokens).values({
      tokenHash: hashEmailToken(liveToken),
      userId,
      purpose: "account_claim",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const before = await db
      .select({ passwordHash: users.passwordHash, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    assert.deepEqual(await claimAccountWithToken(liveToken, await hashPassword("different-password-12")), { status: "already_verified" });
    const after = await db
      .select({ passwordHash: users.passwordHash, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    assert.equal(after[0].passwordHash, before[0].passwordHash);
    assert.deepEqual(after[0].emailVerifiedAt, before[0].emailVerifiedAt);
    assert.equal((await createEmailVerificationToken(userId, "account_claim")).status, "already_verified");
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});

test("claim and finalization use user-then-token locks without deadlocking", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Claim tests require a loopback database");

  const userId = await makeUser();
  try {
    const older = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    const newer = await createEmailVerificationToken(userId, "account_claim", { cooldownSeconds: 0 });
    assert.equal(older.status, "created");
    assert.equal(newer.status, "created");
    if (older.status !== "created" || newer.status !== "created") return;

    let releaseFinalize!: () => void;
    const release = new Promise<void>((resolve) => { releaseFinalize = resolve; });
    let finalizeLocked!: () => void;
    const locked = new Promise<void>((resolve) => { finalizeLocked = resolve; });
    let claimReady!: () => void;
    const claimReached = new Promise<void>((resolve) => { claimReady = resolve; });

    const finalizePromise = finalizeEmailVerificationToken(newer.tokenHash, userId, "account_claim", {
      afterLocks: async () => {
        finalizeLocked();
        await release;
      },
    });
    await locked;

    const claimPromise = claimAccountWithToken(
      older.token,
      await hashPassword("claimed-password-12"),
      "account_claim",
      { beforeUserLock: async () => { claimReady(); } },
    );
    await claimReached;
    releaseFinalize();

    const [finalizeResult, claimResult] = await Promise.allSettled([finalizePromise, claimPromise]);
    assert.equal(finalizeResult.status, "fulfilled");
    if (finalizeResult.status === "fulfilled") assert.equal(finalizeResult.value, true);
    assert.equal(claimResult.status, "fulfilled");
    if (claimResult.status === "fulfilled") {
      assert.ok(["invalid", "used"].includes(claimResult.value.status));
    }
  } finally {
    await db.delete(users).where(eq(users.id, userId));
  }
});
