import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { auditLogs, emailTokens, rateLimits, sessions, users } from "../src/db/schema";
import { createSession } from "../src/lib/auth";
import { handleResetConfirm, handleResetRequest } from "../src/lib/auth-service";
import {
  createEmailVerificationToken,
  createPasswordResetToken,
  passwordResetUrl,
  resetPasswordWithToken,
} from "../src/lib/email-verification";
import { hashPassword, verifyPassword } from "../src/lib/passwords";
import { keyFor } from "../src/lib/rate-limit";
import type { MailMessage, MailTransport } from "../src/lib/mail";

function fakeMail() {
  const sent: MailMessage[] = [];
  const transport: MailTransport = {
    name: "outbox",
    send: async (message) => { sent.push(message); },
  };
  return { transport, sent };
}

async function makeUser(verified = true) {
  const suffix = randomBytes(6).toString("hex");
  const password = "current-password-12";
  const [user] = await db.insert(users).values({
    name: "Reset test",
    email: `reset-${suffix}@example.test`,
    passwordHash: await hashPassword(password),
    emailVerifiedAt: verified ? new Date() : null,
  }).returning({ id: users.id, email: users.email, name: users.name });
  return { ...user, password };
}

test("reset URLs keep the token in the fragment", () => {
  const url = passwordResetUrl("abc123", "en", "https://solara.example");
  assert.equal(url, "https://solara.example/reset-password?lang=en#token=abc123");
  assert.doesNotMatch(url, /\?token=/);
});

test("reset request responses are identical for known, unknown, and unverified addresses", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Password reset tests require a loopback database");

  const verified = await makeUser(true);
  const unverified = await makeUser(false);
  const unknown = `unknown-${randomBytes(6).toString("hex")}@example.test`;
  const ip = "192.0.2.101";
  const keys = [
    keyFor("reset-request:ip", ip),
    keyFor("reset-request:email", verified.email),
    keyFor("reset-request:email", unverified.email),
    keyFor("reset-request:email", unknown),
  ];
  const lookup = async (email: string) => {
    if (email === verified.email) return { ...verified, emailVerifiedAt: new Date() };
    if (email === unverified.email) return { ...unverified, emailVerifiedAt: null };
    return null;
  };

  try {
    const responses = [];
    const mails = [];
    for (const email of [verified.email, unknown, unverified.email]) {
      const mail = fakeMail();
      const outcome = await handleResetRequest(
        new Request("https://solara.example/api/auth/reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify({ email }),
        }),
        { locale: "en", mail: () => mail.transport, lookupUser: lookup },
      );
      for (const task of outcome.tasks) await task();
      responses.push({ status: outcome.response.status, body: await outcome.response.json() });
      mails.push(mail.sent);
    }

    assert.deepEqual(responses[0], responses[1]);
    assert.deepEqual(responses[0], responses[2]);
    assert.equal(mails[0].length, 1);
    assert.equal(mails[1].length, 0);
    assert.equal(mails[2].length, 0);
    assert.match(mails[0][0].text, /#token=/);
  } finally {
    await db.delete(rateLimits).where(inArray(rateLimits.key, keys));
    await db.delete(users).where(inArray(users.id, [verified.id, unverified.id]));
  }
});

test("a reset token updates the password, revokes sessions, and writes an audit entry", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Password reset tests require a loopback database");

  const user = await makeUser(true);
  try {
    await createSession(user.id);
    const token = await createPasswordResetToken(user.id);
    assert.equal(token.status, "created");
    if (token.status !== "created") return;

    const newPassword = "brand-new-password-12";
    const result = await resetPasswordWithToken(token.token, await hashPassword(newPassword));
    assert.deepEqual(result, { status: "reset", userId: user.id });

    const [stored] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    assert.equal(await verifyPassword(newPassword, stored.passwordHash), true);
    assert.equal((await db.select().from(sessions).where(eq(sessions.userId, user.id))).length, 0);
    assert.equal(
      (await db.select().from(emailTokens).where(and(
        eq(emailTokens.userId, user.id),
        eq(emailTokens.purpose, "password_reset"),
        isNull(emailTokens.usedAt),
      ))).length,
      0,
    );
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.actorId, user.id), eq(auditLogs.action, "password:reset")));
    assert.equal(audits.length, 1);

    assert.deepEqual(await resetPasswordWithToken(token.token, await hashPassword("another-password-12")), { status: "used" });
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("expired and wrong-purpose reset tokens fail", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Password reset tests require a loopback database");

  const user = await makeUser(true);
  try {
    const reset = await createPasswordResetToken(user.id);
    assert.equal(reset.status, "created");
    if (reset.status !== "created") return;
    await db.update(emailTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(emailTokens.tokenHash, reset.tokenHash));
    assert.deepEqual(await resetPasswordWithToken(reset.token, await hashPassword("another-password-12")), { status: "expired" });

    const wrongPurpose = await createEmailVerificationToken(user.id, "email_verification", { cooldownSeconds: 0 });
    assert.equal(wrongPurpose.status, "created");
    if (wrongPurpose.status !== "created") return;
    assert.deepEqual(await resetPasswordWithToken(wrongPurpose.token, await hashPassword("another-password-12")), { status: "invalid" });
  } finally {
    await db.delete(users).where(eq(users.id, user.id));
  }
});

test("invalid reset tokens are rejected before password hashing", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Password reset tests require a loopback database");

  let hashes = 0;
  const ip = "192.0.2.102";
  try {
    const response = await handleResetConfirm(new Request("https://solara.example/api/auth/reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ token: "a".repeat(43), password: "another-password-12" }),
    }), "en", { hashPassword: async () => { hashes++; return "unused:hash"; } });
    assert.equal(response.status, 400);
    assert.equal(hashes, 0);
  } finally {
    await db.delete(rateLimits).where(inArray(rateLimits.key, [keyFor("reset-confirm:ip", ip)]));
  }
});
