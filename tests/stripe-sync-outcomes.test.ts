import assert from "node:assert/strict";
import test from "node:test";
import {
  outcomeIsHandled,
  outcomeLogLevel,
  processStripeEventWith,
  type StripeEventOutcome,
  type SubscriptionSnapshot,
  type SyncPorts,
  type WebhookAuditAction,
} from "../src/lib/stripe-sync-core";

/*
 * The four (five) outcomes of a Stripe webhook, against in-memory ports.
 *
 * This is the test that was missing: before this file, an event that matched no
 * user was claimed, marked processed and silently dropped — a customer pays and
 * nothing happens, forever, with one log line as the only record. Each case
 * below asserts both halves of the contract: what the caller is told, and what
 * is durably written.
 */

const PREMIUM_PRICE = "price_premium_mxn";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";

function subscription(overrides: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot {
  return {
    id: "sub_123",
    customer: "cus_123",
    metadata: { solara_user_id: USER_ID, solara_product: "premium" },
    status: "active",
    priceId: PREMIUM_PRICE,
    currency: "mxn",
    currentPeriodEnd: 1_900_000_000,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

type Calls = {
  claims: string[];
  locks: string[];
  retrieved: string[];
  audits: Array<{ action: WebhookAuditAction; target: string }>;
  upserts: Array<{ userId: string; grantsAccess: boolean; status: string }>;
  customerLinks: Array<{ userId: string; customerId: string }>;
  cancelled: string[];
};

function harness(options: {
  alreadyClaimed?: boolean;
  subscription?: SubscriptionSnapshot;
  /** undefined = the default matching owner; null = no user matches at all. */
  owner?: { id: string; customerId: string | null } | null;
  premiumPrice?: boolean;
  retrieveError?: Error;
  /** undefined = cancellation not wired (unit-test default). */
  cancel?: "ok" | "throws" | "missing";
  /** Proof of deletion. Default false: "unmapped" alone is not evidence. */
  accountDeleted?: boolean;
} = {}) {
  const calls: Calls = { claims: [], locks: [], retrieved: [], audits: [], upserts: [], customerLinks: [], cancelled: [] };
  const ports: SyncPorts = {
    claimEvent: async event => {
      calls.claims.push(event.id);
      return !options.alreadyClaimed;
    },
    lockSubscription: async id => { calls.locks.push(id); },
    retrieveSubscription: async id => {
      calls.retrieved.push(id);
      if (options.retrieveError) throw options.retrieveError;
      return options.subscription ?? subscription();
    },
    findOwner: async () => (options.owner === undefined
      ? { id: USER_ID, customerId: "cus_123" }
      : options.owner ?? undefined),
    setCustomerId: async (userId, customerId) => { calls.customerLinks.push({ userId, customerId }); },
    upsertSubscription: async values => {
      calls.upserts.push({ userId: values.userId, grantsAccess: values.grantsAccess, status: values.status });
    },
    recordAudit: async (action, target) => { calls.audits.push({ action, target }); },
    priceGrantsAccess: priceId => (options.premiumPrice ?? true) && priceId === PREMIUM_PRICE,
    ...(options.accountDeleted !== undefined
      ? { wasAccountDeleted: async () => options.accountDeleted! }
      : {}),
    ...(options.cancel
      ? {
          cancelOrphanedSubscription: async (subscriptionId: string) => {
            calls.cancelled.push(subscriptionId);
            if (options.cancel === "throws") throw new Error("stripe cancel failed");
            if (options.cancel === "missing") throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
          },
        }
      : {}),
    now: () => new Date("2026-11-11T00:00:00Z"),
  };
  return { calls, ports };
}

async function run(ports: SyncPorts, subscriptionId: string | null = "sub_123", id = "evt_1") {
  return processStripeEventWith({ id, type: "customer.subscription.updated" }, subscriptionId, ports);
}

// ------------------------------------------------------------------ applied

test("applied: a matched premium subscription is upserted, audited, and reported to Stripe as handled", async () => {
  const { calls, ports } = harness();
  const outcome = await run(ports);

  assert.equal(outcome.status, "applied");
  assert.equal(outcome.status === "applied" && outcome.userId, USER_ID);
  assert.equal(outcome.status === "applied" && outcome.grantsAccess, true);
  assert.equal(outcome.status === "applied" && outcome.linkedCustomer, false, "customer was already linked");

  assert.deepEqual(calls.locks, ["sub_123"], "locked before reading, so ordering cannot race");
  assert.deepEqual(calls.retrieved, ["sub_123"], "always re-fetched from Stripe");
  assert.deepEqual(calls.upserts, [{ userId: USER_ID, grantsAccess: true, status: "active" }]);
  assert.deepEqual(calls.audits, [{ action: "webhook:applied", target: "sub_123" }]);
  assert.equal(outcomeIsHandled(outcome), true);
});

test("applied: a first-time customer is linked to the user", async () => {
  const { calls, ports } = harness({ owner: { id: USER_ID, customerId: null } });
  const outcome = await run(ports);

  assert.equal(outcome.status, "applied");
  assert.deepEqual(calls.customerLinks, [{ userId: USER_ID, customerId: "cus_123" }]);
  assert.equal(outcome.status === "applied" && outcome.linkedCustomer, true);
});

test("applied: grantsAccess needs BOTH the premium metadata and a configured price", async () => {
  for (const [label, config] of [
    ["non-premium price", { premiumPrice: false }],
  ] as const) {
    const { calls, ports } = harness(config);
    const outcome = await run(ports);
    assert.equal(outcome.status, "applied", label);
    assert.equal(calls.upserts[0]?.grantsAccess, false, `${label}: access not granted`);
  }

  const { calls: metaCalls, ports: metaPorts } = harness({
    subscription: subscription({ metadata: { solara_user_id: USER_ID } }),
  });
  await run(metaPorts);
  assert.equal(metaCalls.upserts[0]?.grantsAccess, false, "missing solara_product metadata: access not granted");
});

// ------------------------------------------------------------------ duplicate

test("duplicate: an already-claimed event is a no-op that touches nothing", async () => {
  const { calls, ports } = harness({ alreadyClaimed: true });
  const outcome = await run(ports);

  assert.equal(outcome.status, "duplicate");
  assert.deepEqual(calls.locks, [], "no lock taken");
  assert.deepEqual(calls.retrieved, [], "no Stripe call");
  assert.deepEqual(calls.upserts, []);
  assert.deepEqual(calls.audits, [], "a replay is not an event worth recording");
  assert.equal(outcomeIsHandled(outcome), true);
});

// ------------------------------------------------------------------ ignored

test("ignored: a claimed event with no subscription is a deliberate no-op", async () => {
  const { calls, ports } = harness();
  const outcome = await run(ports, null);

  assert.equal(outcome.status, "ignored");
  assert.deepEqual(calls.retrieved, [], "no Stripe call for an event we do not act on");
  assert.deepEqual(calls.audits, []);
});

// ------------------------------------------------------------------ unmapped

test("unmapped: no matching user is RECORDED instead of silently dropped", async () => {
  const { calls, ports } = harness({ owner: null });
  const outcome = await run(ports);

  assert.equal(outcome.status, "unmapped");
  assert.equal(outcome.status === "unmapped" && outcome.customerId, "cus_123");
  assert.deepEqual(calls.audits, [{ action: "webhook:unmapped", target: "sub_123" }], "durable, not just a log line");
  assert.deepEqual(calls.upserts, [], "no subscription is invented for an unknown user");
  assert.equal(outcomeIsHandled(outcome), true, "a retry cannot find the user a second time");
  assert.equal(outcomeLogLevel(outcome), "warn");
});

test("unmapped WITHOUT proof of deletion: left alone, not cancelled", async () => {
  // An unrelated subscription on the same Stripe account also looks "unmapped".
  // Cancelling it would be an irreversible change to a paying customer.
  const { calls, ports } = harness({ owner: null, cancel: "ok", accountDeleted: false });
  const outcome = await run(ports);

  assert.deepEqual(calls.cancelled, [], "nothing is cancelled on a guess");
  assert.equal(outcome.status === "unmapped" && outcome.cancelled, false);
  assert.deepEqual(calls.audits, [{ action: "webhook:unmapped", target: "sub_123" }], "quarantined for a human");
});

test("unmapped WITH proof of deletion: cancelled", async () => {
  const { calls, ports } = harness({ owner: null, cancel: "ok", accountDeleted: true });
  const outcome = await run(ports);

  assert.deepEqual(calls.cancelled, ["sub_123"], "the subscription is cancelled");
  assert.equal(outcome.status === "unmapped" && outcome.cancelled, true);
  assert.deepEqual(calls.audits, [{ action: "webhook:unmapped_cancelled", target: "sub_123" }]);
});

test("unmapped with deletion but no cancellation port: recorded as detected, nothing cancelled", async () => {
  const { calls, ports } = harness({ owner: null, accountDeleted: true });
  const outcome = await run(ports);

  assert.deepEqual(calls.cancelled, []);
  assert.equal(outcome.status === "unmapped" && outcome.cancelled, false);
  assert.deepEqual(calls.audits, [{ action: "webhook:unmapped_deletion_detected", target: "sub_123" }]);
});

test("unmapped: a TRANSIENT cancel failure throws, so the claim rolls back and Stripe retries", async () => {
  // Swallowing this would commit the claim and return 200: Stripe never
  // redelivers and the subscription bills forever.
  const { ports } = harness({ owner: null, cancel: "throws", accountDeleted: true });

  await assert.rejects(run(ports), /stripe cancel failed/);
});

test("unmapped: a retry after a transient failure succeeds and cancels once", async () => {
  let attempt = 0;
  const cancelled: string[] = [];
  const { ports } = harness({ owner: null, accountDeleted: true });
  const flaky: SyncPorts = {
    ...ports,
    cancelOrphanedSubscription: async id => {
      attempt++;
      if (attempt === 1) throw new Error("ECONNRESET");
      cancelled.push(id);
    },
  };

  await assert.rejects(run(flaky), /ECONNRESET/);
  const outcome = await run(flaky);
  assert.equal(outcome.status, "unmapped");
  assert.deepEqual(cancelled, ["sub_123"], "the redelivery cancels it");
});

test("unmapped: an already-cancelled subscription is success, not a failure to retry", async () => {
  const { calls, ports } = harness({ owner: null, cancel: "missing", accountDeleted: true });
  const outcome = await run(ports);

  assert.equal(outcome.status === "unmapped" && outcome.cancelled, true, "nothing left to cancel");
  assert.deepEqual(calls.audits, [{ action: "webhook:unmapped_cancelled", target: "sub_123" }]);
});

test("unmapped: a metadata id that is not a uuid falls back to the customer lookup", async () => {
  const { ports } = harness({ subscription: subscription({ metadata: { solara_user_id: "not-a-uuid" } }) });
  const found: Array<string | undefined> = [];
  const spy: SyncPorts = {
    ...ports,
    findOwner: async ({ metadataUserId }) => {
      found.push(metadataUserId);
      return { id: USER_ID, customerId: "cus_123" };
    },
  };
  const outcome = await run(spy);
  assert.deepEqual(found, [undefined], "a malformed id is not passed to the database");
  assert.equal(outcome.status, "applied");
});

// ------------------------------------------------------------------ mismatch

test("mismatch: a customer disagreement is recorded and NOT retried forever", async () => {
  const { calls, ports } = harness({ owner: { id: OTHER_USER_ID, customerId: "cus_other" } });
  const outcome = await run(ports);

  assert.equal(outcome.status, "mismatch");
  assert.equal(outcome.status === "mismatch" && outcome.ownerCustomerId, "cus_other");
  assert.deepEqual(calls.audits, [{ action: "webhook:mismatch", target: "sub_123" }]);
  assert.deepEqual(calls.upserts, [], "never write a subscription onto the wrong customer");
  assert.deepEqual(calls.customerLinks, [], "never overwrite the stored customer id");
  assert.equal(outcomeIsHandled(outcome), true, "200, so Stripe stops retrying a permanent failure");
  assert.equal(outcomeLogLevel(outcome), "warn");
});

// ------------------------------------------------------------------ invalid

test("invalid: a subscription with no price item is recorded, not thrown", async () => {
  const { calls, ports } = harness({ subscription: subscription({ priceId: "" }) });
  const outcome = await run(ports);

  assert.equal(outcome.status, "invalid");
  assert.deepEqual(calls.audits, [{ action: "webhook:invalid", target: "sub_123" }]);
  assert.deepEqual(calls.upserts, []);
  assert.equal(outcomeIsHandled(outcome), true);
});

// ------------------------------------------------------------------ transient

test("transient failures still throw, so the caller answers 500 and Stripe retries", async () => {
  const { ports } = harness({ retrieveError: new Error("stripe 503") });
  await assert.rejects(() => run(ports), /stripe 503/);
});

// ------------------------------------------------------------------ logging

test("log levels separate routine from attention", () => {
  const outcomes: Array<[StripeEventOutcome, "info" | "warn"]> = [
    [{ status: "applied", eventId: "e", subscriptionId: "s", userId: USER_ID, grantsAccess: true, linkedCustomer: false }, "info"],
    [{ status: "duplicate", eventId: "e", subscriptionId: "s" }, "info"],
    [{ status: "ignored", eventId: "e", reason: "no_subscription" }, "info"],
    [{ status: "unmapped", eventId: "e", subscriptionId: "s", customerId: "c", cancelled: true }, "warn"],
    [{ status: "mismatch", eventId: "e", subscriptionId: "s", customerId: "c", ownerId: USER_ID, ownerCustomerId: "c2" }, "warn"],
    [{ status: "invalid", eventId: "e", subscriptionId: "s", reason: "no_price_item" }, "warn"],
  ];
  for (const [outcome, level] of outcomes) {
    assert.equal(outcomeLogLevel(outcome), level, outcome.status);
    assert.equal(outcomeIsHandled(outcome), true, `${outcome.status} is reported to Stripe as received`);
  }
});
