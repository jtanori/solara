import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { inArray } from "drizzle-orm";
import { db } from "../src/db";
import { rateLimits, users } from "../src/db/schema";
import { handleAuth, handleClaim } from "../src/lib/auth-service";
import { createSession } from "../src/lib/auth";
import { createEmailVerificationToken } from "../src/lib/email-verification";
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

function request(body: unknown, ip: string): Request {
  return new Request("https://solara-stg.vercel.app/api/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

async function makeUser(options: { verified?: boolean; password?: string } = {}) {
  const suffix = randomBytes(6).toString("hex");
  const password = options.password ?? "correct-horse-battery";
  const email = `auth-endpoint-${suffix}@example.test`;
  const [user] = await db.insert(users).values({
    name: "Auth endpoint",
    email,
    passwordHash: await hashPassword(password),
    emailVerifiedAt: options.verified === false ? null : new Date(),
  }).returning({ id: users.id, email: users.email });
  return { ...user, password };
}

async function cleanupRateLimits(keys: string[]) {
  if (keys.length) await db.delete(rateLimits).where(inArray(rateLimits.key, keys));
}

test("distributed IPs cannot bypass the per-account login budget", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Auth endpoint tests require a loopback database");

  const user = await makeUser();
  const ips = Array.from({ length: 12 }, (_, index) => `203.0.113.${index + 1}`);
  const keys = [
    keyFor("login:account", user.email),
    ...ips.flatMap((ip) => [
      keyFor("login:ip", ip),
      keyFor("login:ip-failures", ip),
    ]),
  ];

  try {
    const statuses: number[] = [];
    for (const ip of ips.slice(0, 10)) {
      const outcome = await handleAuth(
        request({ mode: "login", email: user.email, password: "wrong-password" }, ip),
        { locale: "en", mail: () => fakeMail().transport },
      );
      statuses.push(outcome.response.status);
    }
    assert.deepEqual(statuses, Array(10).fill(401));

    const blocked = await handleAuth(
      request({ mode: "login", email: user.email, password: "wrong-password" }, ips[10]),
      { locale: "en", mail: () => fakeMail().transport },
    );
    assert.equal(blocked.response.status, 429);

    const correct = await handleAuth(
      request({ mode: "login", email: user.email, password: user.password }, ips[11]),
      { locale: "en", mail: () => fakeMail().transport },
    );
    assert.equal(correct.response.status, 429);

    await db.update(rateLimits)
      .set({ blockedUntil: new Date(Date.now() - 1000) })
      .where(inArray(rateLimits.key, [keyFor("login:account", user.email)]));

    const recovered = await handleAuth(
      request({ mode: "login", email: user.email, password: user.password }, ips[11]),
      { locale: "en", mail: () => fakeMail().transport },
    );
    assert.equal(recovered.response.status, 200);
  } finally {
    await cleanupRateLimits(keys);
    await db.delete(users).where(inArray(users.id, [user.id]));
  }
});

test("concurrent wrong guesses stop at the account budget", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Auth endpoint tests require a loopback database");

  const user = await makeUser();
  const ips = Array.from({ length: 12 }, (_, index) => `198.51.100.${index + 1}`);
  const keys = [
    keyFor("login:account", user.email),
    ...ips.flatMap((ip) => [keyFor("login:ip", ip), keyFor("login:ip-failures", ip)]),
  ];

  try {
    const outcomes = await Promise.all(ips.map((ip) => handleAuth(
      request({ mode: "login", email: user.email, password: "wrong-password" }, ip),
      { locale: "en", mail: () => fakeMail().transport },
    )));
    const statuses = outcomes.map((outcome) => outcome.response.status);
    assert.equal(statuses.filter((status) => status === 401).length, 10);
    assert.equal(statuses.filter((status) => status === 429).length, 2);
  } finally {
    await cleanupRateLimits(keys);
    await db.delete(users).where(inArray(users.id, [user.id]));
  }
});

test("many successful users behind one IP are not locked out", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Auth endpoint tests require a loopback database");

  const created = [];
  for (let index = 0; index < 12; index++) {
    created.push(await makeUser());
  }
  const ip = "192.0.2.44";
  const keys = [
    keyFor("login:ip", ip),
    ...created.map((user) => keyFor("login:account", user.email)),
  ];

  try {
    for (const user of created) {
      const outcome = await handleAuth(
        request({ mode: "login", email: user.email, password: user.password }, ip),
        { locale: "en", mail: () => fakeMail().transport },
      );
      assert.equal(outcome.response.status, 200);
    }
  } finally {
    await cleanupRateLimits(keys);
    await db.delete(users).where(inArray(users.id, created.map((user) => user.id)));
  }
});

test("unverified accounts cannot sign in with a pre-claim password", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Auth endpoint tests require a loopback database");

  const user = await makeUser({ verified: false });
  const keys = [keyFor("login:account", user.email), keyFor("login:ip", "192.0.2.55")];
  try {
    const outcome = await handleAuth(
      request({ mode: "login", email: user.email, password: user.password }, "192.0.2.55"),
      { locale: "en", mail: () => fakeMail().transport },
    );
    assert.equal(outcome.response.status, 401);
    assert.equal(outcome.response.headers.get("set-cookie"), null);
  } finally {
    await cleanupRateLimits(keys);
    await db.delete(users).where(inArray(users.id, [user.id]));
  }
});

test("claim revokes old sessions and the old password cannot sign in", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Auth endpoint tests require a loopback database");

  const user = await makeUser({ verified: false });
  const token = await createEmailVerificationToken(user.id, "account_claim", { cooldownSeconds: 0 });
  assert.equal(token.status, "created");
  if (token.status !== "created") return;
  await createSession(user.id);

  const ip = "192.0.2.71";
  const keys = [
    keyFor("claim:ip", ip),
    keyFor("login:account", user.email),
    keyFor("login:ip", ip),
    keyFor("login:ip-failures", ip),
  ];

  try {
    const claimed = await handleClaim(new Request("https://solara-stg.vercel.app/api/auth/claim", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ token: token.token, password: "new-claimed-password-12" }),
    }), "en");
    assert.equal(claimed.status, 200);

    const oldPassword = await handleAuth(
      request({ mode: "login", email: user.email, password: user.password }, ip),
      { locale: "en", mail: () => fakeMail().transport },
    );
    assert.equal(oldPassword.response.status, 401);

    const newPassword = await handleAuth(
      request({ mode: "login", email: user.email, password: "new-claimed-password-12" }, ip),
      { locale: "en", mail: () => fakeMail().transport },
    );
    assert.equal(newPassword.response.status, 200);
    const [stored] = await db.select({ passwordHash: users.passwordHash }).from(users).where(inArray(users.id, [user.id]));
    assert.equal(await verifyPassword("new-claimed-password-12", stored.passwordHash), true);
  } finally {
    await cleanupRateLimits(keys);
    await db.delete(users).where(inArray(users.id, [user.id]));
  }
});

test("signup responses are indistinguishable and never create a session", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Auth endpoint tests require a loopback database");

  const existing = await makeUser();
  const newEmail = `auth-new-${randomBytes(6).toString("hex")}@example.test`;
  const ipOne = "192.0.2.61";
  const ipTwo = "192.0.2.62";
  const keys = [
    keyFor("signup:ip", ipOne),
    keyFor("signup:ip", ipTwo),
    keyFor("signup:email", existing.email),
    keyFor("signup:email", newEmail),
  ];

  try {
    const existingMail = fakeMail();
    const existingOutcome = await handleAuth(
      request({ mode: "signup", name: "Existing", email: existing.email }, ipOne),
      { locale: "en", mail: () => existingMail.transport },
    );
    const newMail = fakeMail();
    const newOutcome = await handleAuth(
      request({ mode: "signup", name: "New", email: newEmail }, ipTwo),
      { locale: "en", mail: () => newMail.transport },
    );

    assert.equal(existingOutcome.response.status, 200);
    assert.equal(newOutcome.response.status, 200);
    assert.deepEqual(await existingOutcome.response.json(), await newOutcome.response.json());
    assert.equal(existingOutcome.response.headers.get("set-cookie"), null);
    assert.equal(newOutcome.response.headers.get("set-cookie"), null);

    for (const task of existingOutcome.tasks) await task();
    for (const task of newOutcome.tasks) await task();
    assert.equal(existingMail.sent.length, 1);
    assert.equal(newMail.sent.length, 1);

    const [newUser] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt, passwordHash: users.passwordHash })
      .from(users)
      .where(inArray(users.email, [newEmail]));
    assert.ok(newUser);
    assert.equal(newUser.emailVerifiedAt, null);
    assert.equal(await verifyPassword("anything-password", newUser.passwordHash), false);
  } finally {
    await cleanupRateLimits(keys);
    await db.delete(users).where(inArray(users.email, [existing.email, newEmail]));
  }
});
