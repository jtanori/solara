import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { inArray } from "drizzle-orm";
import { db } from "../src/db";
import { rateLimits } from "../src/db/schema";
import { handlePlaces, resolvePlacesLanguage } from "../src/lib/places";
import { clearPlacesCacheForTests } from "../src/lib/places-cache";
import { keyFor } from "../src/lib/rate-limit";

function request(query: string, ip: string, origin = "same-origin", requestId?: string): Request {
  return new Request(`https://solara.example/api/places?q=${encodeURIComponent(query)}&lang=en`, {
    headers: {
      "x-forwarded-for": ip,
      ...(requestId ? { "x-request-id": requestId } : {}),
      ...(origin === "same-origin" ? { "Sec-Fetch-Site": "same-origin" } : { Origin: origin }),
    },
  });
}

function fakeFetch() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return Response.json({
      results: [{
        name: "Mexicali",
        admin1: "Baja California",
        country: "Mexico",
        latitude: 32.6393,
        longitude: -115.4747,
        timezone: "America/Tijuana",
      }],
    });
  }) as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function budgetKey() {
  return keyFor("places:budget", new Date().toISOString().slice(0, 13));
}

async function cleanup(keys: string[]) {
  await db.delete(rateLimits).where(inArray(rateLimits.key, keys));
}

test("cross-origin places requests are rejected before upstream work", async () => {
  const response = await handlePlaces(request("Mexicali", "192.0.2.111", "https://evil.example"), {
    env: { APP_URL: "https://solara.example" },
    fetch: fakeFetch().fetchImpl,
  });
  assert.equal(response.status, 403);
});

test("places caches identical queries and rate-limits per IP", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Places tests require a loopback database");

  clearPlacesCacheForTests();
  const ip = "192.0.2.112";
  const keys = [keyFor("places:ip", ip), budgetKey()];
  await cleanup(keys);
  const upstream = fakeFetch();
  const deps = {
    env: { APP_URL: "https://solara.example", PLACES_HOURLY_BUDGET: "1000" },
    fetch: upstream.fetchImpl,
  };

  try {
    const first = await handlePlaces(request("Mexicali", ip), deps);
    const second = await handlePlaces(request("Mexicali", ip), deps);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(upstream.calls(), 1);
  } finally {
    await cleanup(keys);
  }
});

test("the 31st places request in a minute returns 429", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Places tests require a loopback database");

  clearPlacesCacheForTests();
  const ip = "192.0.2.113";
  const keys = [keyFor("places:ip", ip), budgetKey()];
  await cleanup(keys);
  const upstream = fakeFetch();
  const deps = {
    env: { APP_URL: "https://solara.example", PLACES_HOURLY_BUDGET: "1000" },
    fetch: upstream.fetchImpl,
  };

  try {
    for (let index = 0; index < 30; index++) {
      const response = await handlePlaces(request("Mexicali", ip), deps);
      assert.equal(response.status, 200);
    }
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let limited: Response;
    try {
      limited = await handlePlaces(request("Mexicali", ip, "same-origin", "places-test-id"), deps);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
    assert.match(warnings.join("\n"), /places-test-id/);
  } finally {
    await cleanup(keys);
  }
});

test("the hourly upstream budget fails closed", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Places tests require a loopback database");

  clearPlacesCacheForTests();
  const ip = "192.0.2.114";
  const keys = [keyFor("places:ip", ip), budgetKey()];
  await cleanup(keys);
  const upstream = fakeFetch();
  const deps = {
    env: { APP_URL: "https://solara.example", PLACES_HOURLY_BUDGET: "1" },
    fetch: upstream.fetchImpl,
  };

  try {
    assert.equal((await handlePlaces(request("Mexicali", ip), deps)).status, 200);
    assert.equal((await handlePlaces(request("Tijuana", ip), deps)).status, 503);
    assert.equal(upstream.calls(), 1);
  } finally {
    await cleanup(keys);
  }
});

test("places failures never log the key or query", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Places tests require a loopback database");

  clearPlacesCacheForTests();
  const ip = "192.0.2.115";
  const keys = [keyFor("places:ip", ip), budgetKey()];
  await cleanup(keys);
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  const deps = {
    env: { APP_URL: "https://solara.example", PLACES_HOURLY_BUDGET: "1000", OPEN_METEO_API_KEY: "super-secret-key" },
    fetch: (async () => { throw new Error("upstream failed with super-secret-key"); }) as typeof fetch,
  };

  try {
    const response = await handlePlaces(request("Mexicali", ip), deps);
    assert.equal(response.status, 503);
  } finally {
    console.error = original;
    await cleanup(keys);
  }
  const output = logs.join("\n");
  assert.doesNotMatch(output, /super-secret-key/);
  assert.doesNotMatch(output, /Mexicali/);
  assert.match(output, /places\.fetch_failed/);
});

test("places: the upstream language follows an explicit lang, then the cookie, then Spanish", () => {
  // Pure resolution only: this asserts which upstream language is chosen, without
  // spending a rate-limit slot or touching the network/database (#223).
  const language = (url: string, cookie?: string) =>
    resolvePlacesLanguage(new Request(url, { headers: cookie ? { cookie } : {} }), new URL(url).searchParams);
  const base = "https://solara.example/api/places?q=Mexicali";

  // The client always sends the UI locale, and it wins over a stale cookie.
  assert.equal(language(`${base}&lang=en`, "solara_locale=es"), "en");
  assert.equal(language(`${base}&lang=es`, "solara_locale=en"), "es");

  // No explicit param: the visitor's cookie decides.
  assert.equal(language(base, "solara_locale=en"), "en");

  // No param and no cookie is Spanish now, not the previous silent English.
  assert.equal(language(base), "es");
  assert.equal(language(base, "other=1"), "es");

  // A junk lang is not a locale choice; the cookie still is.
  assert.equal(language(`${base}&lang=fr`, "solara_locale=en"), "en");
  assert.equal(language(`${base}&lang=fr`), "es");
});
