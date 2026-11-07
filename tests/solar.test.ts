import assert from "node:assert/strict";
import test from "node:test";
import { calculateSolarReturn } from "../src/lib/solar";
import type { ChartInput } from "../src/lib/types";

const base: ChartInput = {
  name: "Example",
  birthDate: "1984-05-16",
  birthTime: "01:00",
  birthPlace: { name: "Mexicali, Mexico", latitude: 32.6393, longitude: -115.4747, timezone: "America/Tijuana" },
  returnPlace: { name: "New York, United States", latitude: 40.7128, longitude: -74.006, timezone: "America/New_York" },
  year: 2026,
  timeChoice: "earlier",
};

test("returns a stable example moment and whole-sign placements", () => {
  const result = calculateSolarReturn(base);
  // Regression fixture, not an independent professional ephemeris validation.
  assert.ok(Math.abs(Date.parse(result.exactUtc) - Date.parse("2026-05-16T11:46:50.405Z")) < 2000);
  assert.equal(result.natalSun.sign, "Taurus");
  assert.equal(result.moon.sign, "Taurus");
  assert.equal(result.ascendant?.sign, "Gemini");
  assert.equal(result.sunHouse, 12);
  assert.equal(result.houseSystem, "Whole sign");
});

test("the return instant is independent of the chosen return location", () => {
  const newYork = calculateSolarReturn(base);
  const london = calculateSolarReturn({ ...base, returnPlace: { name: "London, United Kingdom", latitude: 51.5072, longitude: -0.1276, timezone: "Europe/London" } });
  assert.equal(newYork.exactUtc, london.exactUtc);
  assert.notEqual(newYork.localTime, london.localTime);
  assert.notEqual(newYork.ascendant?.longitude, london.ascendant?.longitude);
});

test("rejects a nonexistent daylight-saving birth time", () => {
  assert.throws(() => calculateSolarReturn({ ...base, birthDate: "2000-04-02", birthTime: "02:30", birthPlace: { ...base.returnPlace } }), /does not exist/);
});

test("honors both occurrences of an ambiguous birth time", () => {
  const input = { ...base, birthDate: "2000-10-29", birthTime: "01:30", birthPlace: { ...base.returnPlace } };
  const earlier = calculateSolarReturn({ ...input, timeChoice: "earlier" });
  const later = calculateSolarReturn({ ...input, timeChoice: "later" });
  assert.notEqual(earlier.exactUtc, later.exactUtc);
  assert.ok(earlier.warnings.some(warning => warning.includes("earlier")));
  assert.ok(later.warnings.some(warning => warning.includes("later")));
});

test("omits the Ascendant and houses at high latitudes", () => {
  const result = calculateSolarReturn({ ...base, returnPlace: { name: "Tromsø, Norway", latitude: 69.65, longitude: 18.96, timezone: "Europe/Oslo" } });
  assert.equal(result.ascendant, null);
  assert.equal(result.sunHouse, null);
  assert.ok(result.warnings.some(warning => warning.includes("high latitudes")));
});
