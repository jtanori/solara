import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LOCALE, localeFromCookieHeader, resolveLocale } from "../src/lib/i18n";

/*
 * #223: Spanish is the default locale; English is selected only by the cookie the
 * language switcher writes. These are pure tests — no Next request scope, no
 * database import — because `getLocale()` is a one-line wrapper around
 * `resolveLocale`. The places handler's own fallback lives in `places.test.ts`,
 * which already carries the database import.
 */

test("the product default is Spanish", () => {
  assert.equal(DEFAULT_LOCALE, "es");
});

test("an absent, empty or unrecognised cookie resolves to Spanish", () => {
  for (const raw of [undefined, null, "", "fr", "EN", "Es", "es-MX", "en-US"]) {
    assert.equal(resolveLocale(raw), "es", `${String(raw)} must fall back to the default`);
  }
});

test("only the exact values the switcher writes are trusted", () => {
  assert.equal(resolveLocale("es"), "es");
  assert.equal(resolveLocale("en"), "en");
});

test("the cookie header parser picks solara_locale and ignores everything else", () => {
  assert.equal(localeFromCookieHeader("solara_locale=en"), "en");
  assert.equal(localeFromCookieHeader("a=1; solara_locale=en; b=2"), "en");
  assert.equal(localeFromCookieHeader("solara_locale=es"), "es");
  assert.equal(localeFromCookieHeader("other=en"), "es", "an unrelated cookie is not a locale choice");
  assert.equal(localeFromCookieHeader("solara_locale"), "es", "a valueless cookie is not a choice");
  assert.equal(localeFromCookieHeader("solara_locale="), "es");
  assert.equal(localeFromCookieHeader(null), "es");
  assert.equal(localeFromCookieHeader(undefined), "es");
});

test("the first solara_locale wins when the header repeats it", () => {
  assert.equal(localeFromCookieHeader("solara_locale=en; solara_locale=es"), "en");
});
