import assert from "node:assert/strict";
import test from "node:test";
import { MakeTime, SiderealTime } from "astronomy-engine";
import { calculateSolarReturn, calculateSolarReturnChart } from "../src/lib/solar";
import { castChart, chartDigest, elementAndModality, findAspects, findCrossAspects, houseOf, placidusCusps, SUPPORTED_HOUSE_SYSTEMS, wholeSignCusps } from "../src/lib/chart";
import { longitudeOf, normalize, signOf, trueNodeLongitudeWithFallback } from "../src/lib/astro";
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

test("the 66° cutoff omits the Ascendant in both engines, both hemispheres, exactly at the boundary", () => {
  // v1 (calculateSolarReturn) and v2 (castChart) each carry their own copy of the cutoff.
  // The ephemeris fixtures pin the v2 formula through castChart; this pins both copies as
  // they are actually wired — including the southern hemisphere (|latitude|, not latitude)
  // and the exact ±66° boundary (< 66, not <= 66).
  const places = [
    { name: "McMurdo Station, Antarctica", latitude: -77.85, longitude: 166.67, timezone: "Pacific/Auckland" },
    { name: "66° south", latitude: -66, longitude: 18.96, timezone: "Europe/Oslo" },
    { name: "66° north", latitude: 66, longitude: 18.96, timezone: "Europe/Oslo" },
  ];
  for (const returnPlace of places) {
    const { result, facts } = calculateSolarReturnChart({ ...base, returnPlace });
    assert.equal(result.ascendant, null, `${returnPlace.name}: v1 omits the Ascendant at |latitude| >= 66°`);
    assert.equal(result.sunHouse, null, `${returnPlace.name}: v1 assigns no sun house`);
    assert.ok(result.warnings.some(warning => warning.includes("high latitudes")), `${returnPlace.name}: v1 warns the user`);
    assert.equal(facts.angles.ascendant, null, `${returnPlace.name}: v2 omits the Ascendant`);
    assert.deepEqual(facts.houses, [], `${returnPlace.name}: v2 assigns no houses`);
    assert.ok(facts.bodies.every(body => body.house === null), `${returnPlace.name}: no body may claim a house`);
    assert.ok(facts.angles.midheaven.sign, `${returnPlace.name}: the Midheaven survives`);
  }
});

test("whole-sign houses: each sign is a house and the Ascendant is the first cusp", () => {
  const cusps = wholeSignCusps(100); // 10° Cancer
  assert.equal(cusps.length, 12);
  assert.equal(cusps[0], 90, "first cusp is the start of the Ascendant's sign");
  assert.equal(houseOf(95, cusps), 1);
  assert.equal(houseOf(185, cusps), 4);
  assert.equal(houseOf(89.99, cusps), 12);
});

test("Placidus is computed at mid-latitudes, and its cusps obey the system's invariants", () => {
  const when = new Date("2026-05-16T11:46:50.405Z");
  const ramc = SiderealTime(MakeTime(when)) * 15 - 74.006;
  const chart = castChart({ at: when, latitude: 40.7, longitude: -74, ramcDegrees: ramc, houseSystem: "placidus" });
  const angularError = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
  assert.equal(chart.houseSystem, "placidus");
  assert.ok(chart.placidusValidated, "the build claims Placidus is validated — the ephemeris suite is that claim's proof");
  assert.equal(chart.houses.length, 12);
  // Fixed cusps: 1 is the Ascendant, 10 the Midheaven.
  assert.ok(angularError(chart.houses[0], chart.angles.ascendant!.longitude) < 1e-6, "cusp 1 = Ascendant");
  assert.ok(angularError(chart.houses[9], chart.angles.midheaven.longitude) < 1e-6, "cusp 10 = Midheaven");
  // Opposite cusps are exactly 180° apart — the system's defining symmetry.
  for (let i = 0; i < 6; i++) {
    assert.ok(angularError(chart.houses[i] + 180, chart.houses[i + 6]) < 1e-6, `cusp ${i + 1} must oppose cusp ${i + 7} by exactly 180°`);
  }
  // The cusps run in cyclic order and no house spans half the zodiac or more.
  for (let i = 0; i < 12; i++) {
    const span = normalize(chart.houses[(i + 1) % 12] - chart.houses[i]);
    assert.ok(span > 0 && span < 180, `house ${i + 1} spans ${span}° — cusps out of order`);
  }
  // Every cusp is recorded at the 4 decimals all recorded longitudes carry — a cusp with
  // floating-point noise beyond that flips the house of a point placed exactly on it.
  for (let i = 0; i < 12; i++) {
    assert.ok(chart.houses[i] === Number(chart.houses[i].toFixed(4)), `cusp ${i + 1} is ${chart.houses[i]} — 4-decimal convention`);
  }
  // The angles fall in their own houses through the irregular spacing.
  assert.equal(houseOf(chart.angles.ascendant!.longitude, chart.houses), 1);
  assert.equal(houseOf(chart.angles.midheaven.longitude, chart.houses), 10);
  // And this is really Placidus, not whole-sign with a different label.
  assert.ok(
    chart.houses.some(cusp => normalize(cusp) % 30 !== 0),
    "Placidus cusps are not sign boundaries — a whole-sign fallback must not pass silently",
  );
});

test("Placidus is omitted at polar latitude by the same policy as whole-sign", () => {
  const when = new Date("1975-06-20T03:45:00.000Z");
  const ramc = SiderealTime(MakeTime(when)) * 15 + 18.96;
  const chart = castChart({ at: when, latitude: 69.65, longitude: 18.96, ramcDegrees: ramc, houseSystem: "placidus" });
  assert.equal(chart.angles.ascendant, null, "no Ascendant at |latitude| >= 66° — policy, for either system");
  assert.deepEqual(chart.houses, [], "no houses without an Ascendant");
  assert.ok(chart.bodies.every(body => body.house === null), "no body may claim a house");
  assert.ok(chart.warnings.some(warning => warning.includes("high latitude")), "the omission must be explained, not silent");
  assert.ok(chart.placidusValidated, "the omission is policy, not a missing implementation");
});

test("SUPPORTED_HOUSE_SYSTEMS pins the exported contract", () => {
  // The list is what #107's entitlement wiring will validate against; dropping a system
  // from it must fail here, not surface as a 404 when the wiring lands.
  assert.deepEqual(SUPPORTED_HOUSE_SYSTEMS, ["whole-sign", "placidus"]);
});

test("the Placidus solver refuses circumpolar cusps instead of approximating them", () => {
  // 89° latitude: any ecliptic point more than 1° from the equator is circumpolar, so the
  // iterated cusps have no semi-arc — a condition that also makes Swiss Ephemeris refuse,
  // though its exact failure region is instant-dependent and not claimed to coincide
  // (review of #122). The guard must fire rather than return a number.
  assert.throws(
    () => placidusCusps(10, 0, 0, 89, 23.4393),
    /circumpolar/,
  );
});

// ------------------------------------------------------------------ nodes

test("the true node is derived from a real crossing and the south node is opposite", () => {
  const when = new Date("2026-05-16T11:46:50.405Z");
  const { longitude, method } = trueNodeLongitudeWithFallback(when);
  assert.equal(method, "osculating");
  // Swiss Ephemeris TRUE_NODE for this instant is 335.3929° -> 5.39° Pisces.
  assert.equal(signOf(longitude).sign, "Pisces");
  const error = Math.abs((((longitude - 335.3929) % 360) + 540) % 360 - 180);
  assert.ok(error < 0.05, `true node within 0.05° of Swiss Ephemeris (got ${longitude.toFixed(4)})`);

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
  // Exactly at the limit is still in orb — the boundary is inclusive, on both the
  // unwidened (Mars/Venus, orb 7.0) and luminary-widened (Sun/Mars, orb 8.0) sides.
  const unwidenedLimit = findAspects([{ name: "Mars", longitude: 0 }, { name: "Venus", longitude: 127 }]);
  assert.ok(unwidenedLimit.some(a => a.type === "trine"), "orb 7.0 exactly is inside the unwidened trine orb");
  const widenedLimit = findAspects([{ name: "Sun", longitude: 0 }, { name: "Mars", longitude: 128 }]);
  assert.ok(widenedLimit.some(a => a.type === "trine"), "orb 8.0 exactly is inside the luminary-widened orb");
});

test("cross-aspects link the return chart to the natal chart and are flagged", () => {
  const { facts } = calculateSolarReturnChart(base);
  assert.ok(facts.crossAspects.length > 0, "there is at least one return-to-natal aspect");
  assert.ok(facts.crossAspects.every(aspect => aspect.cross === true));
  assert.ok(facts.crossAspects.every(aspect => !aspect.a.includes("natal-")), "the return side is the bare point name");
  assert.ok(facts.crossAspects.every(aspect => aspect.b.startsWith("natal-")), "the natal side is namespaced");
});

// ------------------------------------------------------------------ cross-aspects, pairwise (#117)

test("cross-aspects classify the separation of one return point against one natal point", () => {
  // Known answers: each pair is a single separation against the exact angles, with the
  // configured per-body orbs (square/trine 7°, +1 when a luminary is involved). Mars and
  // Venus carry no bonus, so the boundary cases below are unwidened.
  const ret = [{ name: "Mars", longitude: 10 }];
  const classify = (natalLongitude: number, natalName = "Venus") =>
    findCrossAspects(ret, [{ name: natalName, longitude: natalLongitude }]);

  const conj = classify(10.2);        // 0.2° apart
  assert.equal(conj.length, 1);
  assert.equal(conj[0].type, "conjunction");
  assert.ok(Math.abs(conj[0].orb - 0.2) < 1e-9);

  assert.equal(classify(70)[0].type, "sextile");     // exactly 60°
  assert.equal(classify(100)[0].type, "square");     // exactly 90°
  assert.equal(classify(130.5)[0].type, "trine");    // 120.5°, orb 0.5
  assert.equal(classify(190)[0].type, "opposition"); // exactly 180°

  assert.equal(classify(108).length, 0, "98° from a square is outside the 7° orb");
  assert.equal(classify(137.9).length, 0, "127.9° separation: trine orb 7.9° > 7° without a luminary");
  const widened = findCrossAspects(
    [{ name: "Sun", longitude: 10 }],
    [{ name: "Moon", longitude: 137.9 }],
  );
  assert.equal(widened[0]?.type, "trine", "the luminary bonus widens the trine orb");

  // The wrap-around: a natal point "behind" the return point is still 60° away.
  assert.equal(classify(310)[0].type, "sextile");
});

test("cross-aspect orbs are inclusive: a pair exactly at the limit is still in orb", () => {
  // Mars/Venus carry no luminary bonus, so the square orb is exactly 7°: separation 97°
  // gives orb 7.0 on the nose. A strict comparison would drop this pair.
  const ret = [{ name: "Mars", longitude: 10 }];
  const atLimit = findCrossAspects(ret, [{ name: "Venus", longitude: 107 }]);
  assert.equal(atLimit.length, 1, "orb 7.0 exactly is inside the square orb");
  assert.equal(atLimit[0].type, "square");
  assert.equal(atLimit[0].orb, 7);
  assert.equal(findCrossAspects(ret, [{ name: "Venus", longitude: 107.1 }]).length, 0,
    "0.1° past the limit is outside");
  // With a luminary on one side the limit moves to 7 + 1 = 8: separation 98°, orb 8.0 exactly.
  const widenedLimit = findCrossAspects(
    [{ name: "Sun", longitude: 10 }],
    [{ name: "Mars", longitude: 108 }],
  );
  assert.equal(widenedLimit.length, 1, "orb 8.0 exactly (luminary bonus) is inside");
  assert.equal(widenedLimit[0].type, "square");
  assert.equal(widenedLimit[0].orb, 8);
  assert.equal(
    findCrossAspects([{ name: "Sun", longitude: 10 }], [{ name: "Mars", longitude: 108.1 }]).length,
    0, "0.1° past the widened limit is outside",
  );
});

test("every cross-aspect is a real pair: at most one aspect per pair, and the separation backs it", () => {
  const { facts } = calculateSolarReturnChart(base);
  const seen = new Set<string>();
  for (const aspect of facts.crossAspects) {
    const key = `${aspect.a}|${aspect.b}`;
    assert.ok(!seen.has(key), `pair ${key} reported more than once — a pair has one separation, one aspect`);
    seen.add(key);
    const p = facts.bodies.find(b => b.body === aspect.a)?.longitude
      ?? (aspect.a === "Ascendant" ? facts.angles.ascendant!.longitude
        : aspect.a === "Midheaven" ? facts.angles.midheaven.longitude
        : aspect.a === "TrueNode" ? facts.nodes.trueNode.longitude : undefined);
    const n = facts.natal.bodies.find(b => `natal-${b.body}` === aspect.b)?.longitude;
    assert.ok(p !== undefined && n !== undefined, `${key} must name a real return point and natal body`);
    const separation = Math.abs((((p - n) % 360) + 540) % 360 - 180);
    const exact = { conjunction: 0, sextile: 60, square: 90, trine: 120, opposition: 180 }[aspect.type];
    assert.ok(Math.abs(aspect.angle - separation) < 1e-3,
      `${key}: reported angle ${aspect.angle} but the pair is ${separation.toFixed(4)}° apart`);
    assert.ok(Math.abs(aspect.orb - Math.abs(separation - exact)) < 1e-3,
      `${key}: reported ${aspect.type} at orb ${aspect.orb}, but the separation says ${Math.abs(separation - exact).toFixed(4)}`);
    assert.ok(aspect.orb <= 10, `${key}: orb ${aspect.orb} exceeds the widest configured orb`);
  }
});

test("the baseline reports 40 cross-aspects — not 2457 differences of differences", () => {
  // Regression anchor for #117: 13 return points × 10 natal bodies = 130 possible pairs,
  // of which 40 fall inside the configured orbs on the Swiss-Ephemeris-pinned baseline.
  // The defective implementation reported 2457. If positions move, the ephemeris suite
  // fails first; if this number moves on its own, the classification changed.
  const { facts } = calculateSolarReturnChart(base);
  assert.equal(facts.crossAspects.length, 40);
  // The example that proved the defect: return Moon and natal Neptune are 139.8135° apart,
  // outside every orb — no aspect between them may be reported.
  assert.ok(
    !facts.crossAspects.some(a => a.a === "Moon" && a.b === "natal-Neptune"),
    "return Moon vs natal Neptune is 139.8135° apart — no aspect applies",
  );
});

// ------------------------------------------------------------------ balance

test("the balance counts ten bodies plus the Ascendant", () => {
  const { facts } = calculateSolarReturnChart(base);
  const total = facts.balance.fire + facts.balance.earth + facts.balance.air + facts.balance.water;
  assert.equal(total, facts.angles.ascendant ? 11 : 10);
  const modalities = facts.balance.cardinal + facts.balance.fixed + facts.balance.mutable;
  assert.equal(modalities, total, "every counted point has exactly one modality");
});

test("element and modality counts come from the sign cycle", () => {
  assert.deepEqual(
    elementAndModality([0, 30, 60, 90]),
    { fire: 1, earth: 1, air: 1, water: 1, cardinal: 2, fixed: 1, mutable: 1 },
    "Aries fire/cardinal, Taurus earth/fixed, Gemini air/mutable, Cancer water/cardinal",
  );
  assert.deepEqual(
    elementAndModality([359.9, 0.1]),
    { fire: 1, earth: 0, air: 0, water: 1, cardinal: 1, fixed: 0, mutable: 1 },
    "the wrap-around: 359.9° is Pisces (water/mutable), 0.1° is Aries (fire/cardinal)",
  );
});

test("at polar latitude the balance counts ten bodies and no Ascendant", () => {
  const { facts } = calculateSolarReturnChart({
    ...base,
    returnPlace: { name: "Tromsø, Norway", latitude: 69.65, longitude: 18.96, timezone: "Europe/Oslo" },
  });
  assert.equal(facts.balance.fire + facts.balance.earth + facts.balance.air + facts.balance.water, 10);
  assert.equal(facts.balance.cardinal + facts.balance.fixed + facts.balance.mutable, 10);
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

test("the digest's cross-aspects are the 24 tightest pairs, in orb order", () => {
  // The digest slices the (orb-sorted) cross-aspect list to 24 and strips the natal-
  // namespace. Pin all three properties against an independently sorted copy: the
  // selection must be the 24 smallest orbs, ascending, with the natal- prefix removed.
  const { facts } = calculateSolarReturnChart(base);
  const digest = chartDigest(facts);
  assert.ok(facts.crossAspects.length > 24,
    `the baseline must have more than 24 pairs for the slice to do work (has ${facts.crossAspects.length})`);
  const expected = [...facts.crossAspects]
    .sort((x, y) => x.orb - y.orb)
    .slice(0, 24)
    .map(a => ({ a: a.a, b: a.b.replace(/^natal-/, ""), type: a.type, orb: Number(a.orb.toFixed(1)) }));
  assert.equal(digest.crossAspects.length, 24, "the digest carries exactly 24 cross-aspects");
  assert.deepEqual(digest.crossAspects, expected);
  for (let i = 1; i < digest.crossAspects.length; i++) {
    assert.ok(digest.crossAspects[i - 1].orb <= digest.crossAspects[i].orb,
      `digest cross-aspects must be orb-ascending (position ${i}: ${digest.crossAspects[i - 1].orb} > ${digest.crossAspects[i].orb})`);
  }
});

test("casting is deterministic for a fixed instant", () => {
  const a = calculateSolarReturnChart(base).facts;
  const b = calculateSolarReturnChart(base).facts;
  assert.deepEqual(a, b, "the same input must produce byte-identical facts");
});
