import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateMutationOrigin,
  isGuardedApiPath,
  isMutatingMethod,
} from "../src/lib/request-security";

const appUrl = "https://solara-stg.vercel.app";

function decide(overrides: Partial<Parameters<typeof evaluateMutationOrigin>[0]> = {}) {
  return evaluateMutationOrigin({
    origin: null,
    secFetchSite: null,
    appUrl,
    requestUrl: "https://solara-stg.vercel.app/api/auth",
    ...overrides,
  });
}

test("identifies mutating methods and guarded API paths", () => {
  assert.equal(isMutatingMethod("POST"), true);
  assert.equal(isMutatingMethod("put"), true);
  assert.equal(isMutatingMethod("PATCH"), true);
  assert.equal(isMutatingMethod("DELETE"), true);
  assert.equal(isMutatingMethod("GET"), false);
  assert.equal(isGuardedApiPath("/api/auth"), true);
  assert.equal(isGuardedApiPath("/api/readings/abc"), true);
  assert.equal(isGuardedApiPath("/api/readings/abc.png"), true);
  assert.equal(isGuardedApiPath("/api/billing/webhook"), false);
  assert.equal(isGuardedApiPath("/api/billing/webhook/"), false);
  assert.equal(isGuardedApiPath("/api/csp-report"), false);
  assert.equal(isGuardedApiPath("/dashboard"), false);
});

test("accepts an exact same-origin Origin", () => {
  assert.deepEqual(
    decide({ origin: "https://solara-stg.vercel.app" }),
    { allowed: true, reason: "same-origin" },
  );
});

test("accepts a configured preview origin", () => {
  assert.deepEqual(
    decide({
      origin: "https://solara-git-staging.vercel.app",
      requestUrl: "https://solara-git-staging.vercel.app/api/auth",
    }),
    { allowed: true, reason: "same-origin" },
  );
});

test("rejects a mixed-scheme origin on the same host", () => {
  assert.deepEqual(
    decide({ origin: "http://solara-stg.vercel.app" }),
    { allowed: false, reason: "foreign-origin" },
  );
});

test("rejects a different port on the same host", () => {
  assert.deepEqual(
    decide({ origin: "https://solara-stg.vercel.app:8443" }),
    { allowed: false, reason: "foreign-origin" },
  );
});

test("accepts Sec-Fetch-Site same-origin when Origin is absent", () => {
  assert.deepEqual(
    decide({ secFetchSite: "same-origin" }),
    { allowed: true, reason: "same-fetch-site" },
  );
});

test("rejects missing Origin and missing Sec-Fetch-Site", () => {
  assert.deepEqual(
    decide(),
    { allowed: false, reason: "missing-origin" },
  );
});

test("rejects a missing Origin with same-site or none", () => {
  assert.equal(decide({ secFetchSite: "same-site" }).allowed, false);
  assert.equal(decide({ secFetchSite: "none" }).allowed, false);
  assert.equal(decide({ secFetchSite: "cross-site" }).allowed, false);
});

test("rejects a foreign Origin even with a same-origin fetch hint", () => {
  assert.deepEqual(
    decide({ origin: "https://evil.example", secFetchSite: "same-origin" }),
    { allowed: false, reason: "foreign-origin" },
  );
});

test("rejects an Origin that cannot be parsed", () => {
  assert.deepEqual(
    decide({ origin: "not-a-url" }),
    { allowed: false, reason: "invalid-origin" },
  );
});
