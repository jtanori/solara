import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { afterEach } from "node:test";
import { generationLocales } from "../src/readings/config";
import { PAID_PROFILE } from "../src/readings/paid-contract";

/*
 * #224: English content qualification (sampling stage B.2) is deferred, so the runtime must
 * fail closed for `en` even once generation is switched on. These tests pin the allowlist and
 * the three enforcement points without a database: each injects a store that records whether
 * it was reached, because "refused before any permit" is the property under test.
 */

// The modules under test import `src/db`, which requires a connection string at load time.
// These tests never touch it: the injected stores are fakes, so nothing connects.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/app_db";
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function withLocales(value: string | undefined) {
  if (value === undefined) delete process.env.READINGS_GENERATION_LOCALES;
  else process.env.READINGS_GENERATION_LOCALES = value;
}

test("an unset allowlist means Spanish only, so the gate is live without a config change", () => {
  withLocales(undefined);
  assert.deepEqual([...generationLocales()], ["es"]);
});

test("the allowlist accepts the qualified locales in either case", () => {
  withLocales("es");
  assert.deepEqual([...generationLocales()], ["es"]);
  withLocales("es,en");
  assert.deepEqual([...generationLocales()].sort(), ["en", "es"]);
  withLocales(" ES , En ");
  assert.deepEqual([...generationLocales()].sort(), ["en", "es"]);
});

test("an empty or unrecognised allowlist fails closed instead of defaulting", () => {
  for (const value of ["", "   ", ",", "fr", "es,fr", "english", "es,,fr"]) {
    withLocales(value);
    assert.equal(generationLocales().size, 0, `"${value}" must enable nothing`);
  }
});

test("the free service refuses an unqualified locale before claiming the lifetime offer", async () => {
  withLocales("es");
  const { generateFreeReading } = await import("../src/readings/generation-service");
  let claims = 0;
  const store = {
    status: async () => ({ status: "unused" }),
    claim: async () => { claims++; return { kind: "existing", view: { status: "completed" } }; },
  };
  const deps = {
    store, enabled: () => true, config: () => ({ fingerprint: "synthetic" }),
    locales: () => new Set<"en" | "es">(["es"]),
  };

  await assert.rejects(
    () => generateFreeReading("user-1", "reading-1", "en", undefined, deps as never),
    /generation_unavailable/,
  );
  assert.equal(claims, 0, "a refused locale must not consume the one lifetime offer");

  const view = await generateFreeReading("user-1", "reading-1", "es", undefined, deps as never);
  assert.equal(view.status, "completed");
  assert.equal(claims, 1, "the qualified locale still proceeds");
});

test("paid admission refuses an unqualified locale before any intent or allowance exists", async () => {
  withLocales("es");
  const { handlePaidReading } = await import("../src/readings/paid-http");
  let accepted = 0;
  const store = {
    existingIntent: async () => null,
    accept: async () => { accepted++; return { id: randomUUID(), status: "queued" }; },
  };
  const request = (locale: "en" | "es") => new Request("https://app.invalid/api/readings/paid", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.invalid" },
    body: JSON.stringify({ requestId: randomUUID(), locale, profile: PAID_PROFILE, period: "2026-11", offerHash: "a".repeat(64) }),
  });
  const deps = {
    user: async () => ({ id: randomUUID(), emailVerifiedAt: new Date() }),
    locale: "es" as const,
    throttle: async () => null,
    store,
    enabled: () => true,
    config: () => ({ fingerprint: "synthetic", contentVersion: "synthetic" }),
    locales: () => new Set<"en" | "es">(["es"]),
  };

  const refused = await handlePaidReading(request("en"), randomUUID(), deps as never);
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), { code: "paid_unavailable" }, "the locale distinction stays in the log");
  assert.equal(accepted, 0, "no durable intent may exist for an unqualified locale");

  const allowed = await handlePaidReading(request("es"), randomUUID(), deps as never);
  assert.equal(allowed.status, 202);
  assert.equal(accepted, 1);
});

test("the paid worker fails an already-queued run whose locale is no longer allowed, without dispatching", async () => {
  withLocales("es");
  const { workOnePaidReading } = await import("../src/readings/paid-worker");
  const failed: string[] = [];
  let dispatches = 0;
  const store = {
    reapExpired: async () => {},
    announceWorker: async () => {},
    claimNext: async () => ({ id: randomUUID(), userId: randomUUID(), locale: "en", owner: randomUUID() }),
    fail: async (_run: unknown, code: string) => { failed.push(code); },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { dispatches++; throw new Error("must not dispatch"); };
  try {
    const result = await workOnePaidReading({
      store: store as never,
      config: () => ({ fingerprint: "synthetic" }) as never,
      enabled: () => true,
      locales: () => new Set<"en" | "es">(["es"]),
    });
    assert.equal(result, null);
    assert.deepEqual(failed, ["locale_not_qualified"]);
    assert.equal(dispatches, 0, "no provider call may happen for an unqualified run");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
