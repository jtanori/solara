import assert from "node:assert/strict";
import test from "node:test";
import {
  accountDeletionAudit,
  assessBillingGate,
  assessDeletionGate,
  blockedResponseBody,
} from "../src/lib/account-deletion";
import { AUTH_RATE_LIMITS } from "../src/lib/rate-limit-policies";

/*
 * The deletion gate is a pure function precisely so it can be tested on a
 * machine with no database — the route around it needs Postgres, the policy
 * does not. Order is part of the contract: password before billing means a
 * stolen session cannot probe subscription state.
 *
 * The policy table is imported from `rate-limit-policies` deliberately: that
 * module carries no database import, so this file runs without DATABASE_URL.
 * Importing it from `@/lib/rate-limit` would open a pool at module load.
 */

// ------------------------------------------------------------------ deletion gate

test("deletion: an unverified account is refused before anything else", () => {
  const gate = assessDeletionGate({
    role: "user",
    emailVerified: false,
    password: { submitted: true, matches: true },
  });
  assert.equal(gate.kind, "blocked");
  assert.equal(gate.kind === "blocked" && gate.blocker.code, "email_not_verified");
  assert.equal(gate.kind === "blocked" && gate.blocker.status, 403);
});

test("deletion: an owner cannot delete, even with the right password", () => {
  const gate = assessDeletionGate({
    role: "owner",
    emailVerified: true,
    password: { submitted: true, matches: true },
  });
  assert.equal(gate.kind === "blocked" && gate.blocker.code, "owner_account");
});

test("deletion: a missing password is refused without hashing", () => {
  const gate = assessDeletionGate({
    role: "user",
    emailVerified: true,
    password: { submitted: false, matches: null },
  });
  assert.equal(gate.kind, "blocked");
  assert.equal(gate.kind === "blocked" && gate.blocker.code, "password_required");
  assert.equal(gate.kind === "blocked" && gate.blocker.status, 400);
});

test("deletion: a wrong password is refused", () => {
  const gate = assessDeletionGate({
    role: "user",
    emailVerified: true,
    password: { submitted: true, matches: false },
  });
  assert.equal(gate.kind === "blocked" && gate.blocker.code, "invalid_password");
});

test("deletion: password before verification is 'continue', so the route hashes next", () => {
  const gate = assessDeletionGate({
    role: "user",
    emailVerified: true,
    password: { submitted: true, matches: null },
  });
  assert.equal(gate.kind, "continue");
});

test("deletion: a verified non-owner with the right password passes the gate", () => {
  for (const role of ["user", "editor", "admin"] as const) {
    assert.equal(
      assessDeletionGate({ role, emailVerified: true, password: { submitted: true, matches: true } }).kind,
      "continue",
      `${role} may delete their own account`,
    );
  }
});

test("deletion: every blocker carries a localized message and a status the route can use", () => {
  const codes = new Set<string>();
  for (const facts of [
    { role: "user" as const, emailVerified: false, password: { submitted: false, matches: null } },
    { role: "owner" as const, emailVerified: true, password: { submitted: false, matches: null } },
    { role: "user" as const, emailVerified: true, password: { submitted: false, matches: null } },
    { role: "user" as const, emailVerified: true, password: { submitted: true, matches: false } },
  ]) {
    const gate = assessDeletionGate(facts);
    assert.equal(gate.kind, "blocked");
    if (gate.kind !== "blocked") continue;
    codes.add(gate.blocker.code);
    for (const locale of ["en", "es"] as const) {
      const body = blockedResponseBody(gate.blocker, locale);
      assert.ok(body.error.length > 0, `${gate.blocker.code}/${locale} has a message`);
      assert.equal(body.code, gate.blocker.code, "the client gets a stable code, not just prose");
    }
    assert.ok([400, 403, 409, 503].includes(gate.blocker.status));
  }
  assert.deepEqual([...codes].sort(), ["email_not_verified", "invalid_password", "owner_account", "password_required"]);
});

// ------------------------------------------------------------------ billing gate

test("billing: ongoing and unverifiable subscriptions block; clear passes", () => {
  assert.equal(assessBillingGate("clear").kind, "continue");

  const ongoing = assessBillingGate("ongoing");
  assert.equal(ongoing.kind === "blocked" && ongoing.blocker.code, "subscription_ongoing");
  assert.equal(ongoing.kind === "blocked" && ongoing.blocker.status, 409);

  const unverifiable = assessBillingGate("unverifiable");
  assert.equal(unverifiable.kind === "blocked" && unverifiable.blocker.code, "billing_unverifiable");
  assert.equal(unverifiable.kind === "blocked" && unverifiable.blocker.status, 503, "fail closed, not open");
});

// ------------------------------------------------------------------ audit row

test("audit: the deletion row survives the cascade (actor and target are the deleted id)", () => {
  const row = accountDeletionAudit("11111111-2222-3333-4444-555555555555");
  assert.deepEqual(row, {
    actorId: "11111111-2222-3333-4444-555555555555",
    action: "account:delete",
    target: "11111111-2222-3333-4444-555555555555",
  });
  // audit_logs.actor_id is `on delete set null`, so writing the row inside the
  // same transaction as the delete leaves actor=null and target=the id.
  assert.equal(row.target, row.actorId);
});

// ------------------------------------------------------------------ budgets

test("budgets: every metered surface has a policy, and the limits are ordered sensibly", () => {
  const policies = ["readingsCreateIp", "readingsCreateUser", "readingPdfUser", "billingCheckoutUser", "billingPortalUser"] as const;
  for (const name of policies) {
    const policy = AUTH_RATE_LIMITS[name];
    assert.ok(policy.limit > 0 && policy.windowSeconds > 0, `${name} is a real policy`);
  }

  // A per-account budget must be at or below the per-IP budget: one account
  // should not be able to consume a shared origin's whole allowance.
  assert.ok(AUTH_RATE_LIMITS.readingsCreateUser.limit <= AUTH_RATE_LIMITS.readingsCreateIp.limit);
});

test("budgets: policies are configuration, not magic numbers in routes", () => {
  // The numbers live in one table so a limit change is one edit and a test,
  // never a hunt through route files.
  assert.equal(AUTH_RATE_LIMITS.readingsCreateUser.windowSeconds, 3600);
  assert.equal(AUTH_RATE_LIMITS.billingCheckoutUser.windowSeconds, 60);
  assert.equal(AUTH_RATE_LIMITS.billingCheckoutUser.limit, AUTH_RATE_LIMITS.billingPortalUser.limit);
});
