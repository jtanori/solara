import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { buildUpstreamUrl } from "../src/lib/places-url";

test("geocoding selects the right endpoint and keeps the customer key server-side", () => {
  const key = randomBytes(20).toString("hex");
  const free = buildUpstreamUrl("Merida", "es", undefined);
  assert.equal(free.hostname, "geocoding-api.open-meteo.com");
  assert.equal(free.searchParams.get("language"), "es");
  assert.equal(free.searchParams.get("apikey"), null);

  const commercial = buildUpstreamUrl("Merida", "es", key);
  assert.equal(commercial.hostname, "customer-geocoding-api.open-meteo.com");
  assert.equal(commercial.searchParams.get("apikey"), key);
});
