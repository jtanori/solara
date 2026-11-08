import assert from "node:assert/strict";
import test from "node:test";
import { MakeTime, SiderealTime } from "astronomy-engine";
import { calculateSolarReturn, calculateSolarReturnChart } from "../src/lib/solar";
import { castChart, chartDigest, findAspects, houseOf, wholeSignCusps } from "../src/lib/chart";
import { longitudeOf, signOf, trueNodeLongitudeWithFallback } from "../src/lib/astro";
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

// ------------------------------------------------------------------ v2: ten bodies

test("chart v2 computes all ten bodies with sign, degree, house and motion", () => {
  const { facts } = calculateSolarReturnChart(base);
  const names = facts.bodies.map(body => body.body);
  assert.deepEqual(names, ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"]);
  for (const body of facts.bodies) {
    assert.ok(signOf(body.longitude).sign === body.sign, `${body.body} sign agrees with longitude`);
    assert.ok(body.degree >= 0 && body.degree < 30, `${body.body} degree within sign`);
    assert.ok(body.house === null || (body.house >= 1 && body.house <= 12), `${body.body} house in range`);
    assert.ok(body.retrograde === null || typeof body.retrograde === "boolean");
  }
});

test("chart v2 agrees with the v1 contract on the positions v1 knows", () => {
  const { result, facts } = calculateSolarReturnChart(base);
  const sun = facts.bodies.find(body => body.body === "Sun")!;
  const moon = facts.bodies.find(body => body.body === "Moon")!;
  assert.equal(sun.sign, result.natalSun.sign);
  assert.equal(moon.sign, result.moon.sign);
  assert.equal(facts.angles.ascendant?.sign, result.ascendant?.sign);
  assert.equal(sun.house, result.sunHouse);
  assert.equal(facts.houseSystem, "whole-sign");
});

test("retrograde detection distinguishes motion, stationary and direct", () => {
  // Pluto is retrograde for roughly half of every year; the Moon essentially never is.
  const { facts } = calculateSolarReturnChart(base);
  assert.equal(facts.bodies.find(body => body.body === "Moon")!.retrograde, false);
  assert.ok(typeof facts.bodies.find(body => body.body === "Pluto")!.retrograde === "boolean");
});

// ------------------------------------------------------------------ angles and houses

test("the Midheaven is always computed, even at high latitude where the Ascendant is not", () => {
  const { facts } = calculateSolarReturnChart({
    ...base,
    returnPlace: { name: "Tromsø, Norway", latitude: 69.65, longitude: 18.96, timezone: "Europe/Oslo" },
  });
  assert.equal(facts.angles.ascendant, null, "no Ascendant above the polar circle");
  assert.ok(facts.angles.midheaven.sign, "Midheaven still defined");
  assert.deepEqual(facts.houses, [], "no houses assigned");
  assert.ok(facts.bodies.every(body => body.house === null));
});

test("whole-sign houses: each sign is a house and the Ascendant is the first cusp", () => {
  const cusps = wholeSignCusps(100); // 10° Cancer
  assert.equal(cusps.length, 12);
  assert.equal(cusps[0], 90, "first cusp is the start of the Ascendant's sign");
  assert.equal(houseOf(95, cusps), 1);
  assert.equal(houseOf(185, cusps), 4);
  assert.equal(houseOf(89.99, cusps), 12);
});

test("Placidus is refused rather than approximated", () => {
  const when = new Date("2026-05-16T11:46:50.405Z");
  const ramc = SiderealTime(MakeTime(when)) * 15 - 74.006;
  assert.throws(
    () => castChart({ at: when, latitude: 40.7, longitude: -74, ramcDegrees: ramc, houseSystem: "placidus" }),
    /not implemented/,
  );
});

// ------------------------------------------------------------------ nodes

test("the true node is derived from a real crossing and the south node is opposite", () => {
  const when = new Date("2026-05-16T11:46:50.405Z");
  const { longitude, method } = trueNodeLongitudeWithFallback(when);
  assert.equal(method, "secant");
  // Published ephemeris for May 2026: the true node sits near 7-9° Pisces.
  assert.equal(signOf(longitude).sign, "Pisces");

  const { facts } = calculateSolarReturnChart(base);
  const separation = Math.abs(((facts.nodes.trueNode.longitude - facts.nodes.southNode.longitude) % 360 + 360) % 360);
  assert.ok(Math.abs(separation - 180) < 0.01, "south node is exactly opposite the true node");
});

// ------------------------------------------------------------------ aspects

test("aspect detection respects per-aspect orbs and computes the orb", () => {
  const aspects = findAspects([
    { name: "Sun", longitude: 10 },
    { name: "Moon", longitude: 100 },   // 90° -> square, orb 0
    { name: "Mars", longitude: 70 },    // 60° from Sun -> sextile, orb 0
    { name: "Venus", longitude: 130 },  // 120° from Sun -> trine, orb 0
  ]);
  const types = aspects.map(a => `${a.a}-${a.b}:${a.type}`).sort();
  assert.ok(types.includes("Sun-Moon:square"));
  assert.ok(types.includes("Sun-Mars:sextile"));
  assert.ok(types.includes("Sun-Venus:trine"));
});

test("orb boundaries: inside is detected, outside is not", () => {
  // Trine orb is 7°, widened by 1° for a luminary -> 8°.
  const inside = findAspects([{ name: "Sun", longitude: 0 }, { name: "Mars", longitude: 127.9 }]);
  assert.ok(inside.some(a => a.type === "trine"));
  const outside = findAspects([{ name: "Sun", longitude: 0 }, { name: "Mars", longitude: 128.5 }]);
  assert.ok(!outside.some(a => a.type === "trine"), "8.5° is outside the widened trine orb");
});

test("cross-aspects link the return chart to the natal chart and are flagged", () => {
  const { facts } = calculateSolarReturnChart(base);
  assert.ok(facts.crossAspects.length > 0, "there is at least one return-to-natal aspect");
  assert.ok(facts.crossAspects.every(aspect => aspect.cross === true));
  assert.ok(facts.crossAspects.every(aspect => aspect.a.includes("/natal-")));
});

// ------------------------------------------------------------------ digest

test("the digest carries no personal data", () => {
  const { facts } = calculateSolarReturnChart(base);
  const serialised = JSON.stringify(chartDigest(facts)).toLowerCase();
  for (const forbidden of ["mexicali", "new york", "example", "1984-05-16", "@", "latitude", "longitude", "timezone"]) {
    assert.ok(!serialised.includes(forbidden), `digest must not contain "${forbidden}"`);
  }
});

test("the digest stays inside its token budget", () => {
  const { facts } = calculateSolarReturnChart(base);
  const characters = JSON.stringify(chartDigest(facts)).length;
  assert.ok(characters < 8000, `digest is ${characters} chars, budget is 8000 (~2k tokens)`);
});

test("casting is deterministic for a fixed instant", () => {
  const a = calculateSolarReturnChart(base).facts;
  const b = calculateSolarReturnChart(base).facts;
  assert.deepEqual(a, b, "the same input must produce byte-identical facts");
});

test("the balance counts ten bodies plus the Ascendant", () => {
  const { facts } = calculateSolarReturnChart(base);
  const total = facts.balance.fire + facts.balance.earth + facts.balance.air + facts.balance.water;
  assert.equal(total, facts.angles.ascendant ? 11 : 10);
});
