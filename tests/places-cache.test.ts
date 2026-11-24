import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  clearPlacesCacheForTests,
  getCachedPlaces,
  placesCacheKey,
  setCachedPlaces,
} from "../src/lib/places-cache";

/*
 * #223 review: the places cache key carries the language, but the handler only
 * reaches the cache after two rate-limit calls, so every test that could observe it
 * was database-gated and skipped. These tests import nothing from `src/db` and pin
 * the separation where the key is composed.
 */

const ENGLISH = [{ name: "Munich, Bavaria, Germany", latitude: 48.137, longitude: 11.575, timezone: "Europe/Berlin" }];
const SPANISH = [{ name: "Múnich, Baviera, Alemania", latitude: 48.137, longitude: 11.575, timezone: "Europe/Berlin" }];

test("placesCacheKey separates locales for the same query", () => {
  assert.notEqual(placesCacheKey("Munich", "en"), placesCacheKey("Munich", "es"));
  assert.equal(placesCacheKey("Munich", "en"), placesCacheKey("Munich", "en"), "same input stays stable");
});

test("an entry cached in one locale is not served in the other", () => {
  clearPlacesCacheForTests();
  try {
    setCachedPlaces(placesCacheKey("Munich", "en"), ENGLISH, 60);

    assert.deepEqual(getCachedPlaces(placesCacheKey("Munich", "en")), ENGLISH);
    assert.equal(
      getCachedPlaces(placesCacheKey("Munich", "es")),
      undefined,
      "Spanish must not be served the English names",
    );

    setCachedPlaces(placesCacheKey("Munich", "es"), SPANISH, 60);
    assert.deepEqual(getCachedPlaces(placesCacheKey("Munich", "en")), ENGLISH);
    assert.deepEqual(getCachedPlaces(placesCacheKey("Munich", "es")), SPANISH);
  } finally {
    clearPlacesCacheForTests();
  }
});

test("a different query is a different entry regardless of locale", () => {
  clearPlacesCacheForTests();
  try {
    setCachedPlaces(placesCacheKey("Munich", "en"), ENGLISH, 60);
    assert.equal(getCachedPlaces(placesCacheKey("Munchen", "en")), undefined);
  } finally {
    clearPlacesCacheForTests();
  }
});

test("the handler composes its key through placesCacheKey", () => {
  // Guards against re-inlining the key in places.ts, which would bypass the tested
  // composition entirely.
  const source = readFileSync(path.resolve("src/lib/places.ts"), "utf8");
  assert.match(source, /placesCacheKey\(name, language\)/);
  assert.doesNotMatch(source, /const cacheKey = `\$\{name\}/, "the key must not be built inline");
});
