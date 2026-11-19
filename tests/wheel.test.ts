/**
 * Wheel geometry — the acceptance suite for issue #153 (slice 1-b).
 *
 * Every constant here was measured from real output of the facts engine before it
 * was written down (`docs/plan-solar-wheel-geometry-s1b.md` §10): guessed fixtures
 * produced dead tests in S1-a, so the first whole-sign fixture asserts the chart's
 * own Ascendant (88.9078°), and the Placidus fixture's narrow (20.0659°) and wide
 * (41.4201°) sectors are the engine's, not invented.
 *
 * The suite is DB-free: `src/lib/wheel.ts` is pure, so this file needs nothing but
 * `npx tsx --test tests/wheel.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { BODIES, SIGN_NAMES, normalize } from "../src/lib/astro";
import { wholeSignCusps, type Aspect, type ChartFacts } from "../src/lib/chart";
import { pointName, signName, type Locale } from "../src/lib/i18n";
import { calculateSolarReturn, calculateSolarReturnChart, solarReturnFacts } from "../src/lib/solar";
// The one import a test may make and the module may not (D4): the stored contract is
// server-only (canonical hashing needs `node:crypto`), so `wheel.ts` declares the
// literal locally and this file is the tie between the two declarations.
import { BASE_FACTS_VERSION } from "../src/readings/chart-facts";
import {
  WHEEL_MAX_CHORDS, WHEEL_MAX_ELEMENTS, WHEEL_MAX_LABEL_CHARS, WHEEL_MAX_LABEL_NUDGE_DEG,
  WHEEL_MIN_LABEL_SEPARATION_DEG, WHEEL_RADII, WHEEL_VIEW_BOX,
  longitudeAt, projectWheel, wheelAngle, wheelPoint, type FactsVersion, type WheelGeometry,
} from "../src/lib/wheel";
import { readingChartInput } from "./helpers/reading-fixtures";

// ------------------------------------------------------------------ fixtures

const LOCALES: Locale[] = ["en", "es"];

/** F1: the synthetic reading, whole-sign — 22 aspects, both nodes, 40 cross-aspects. */
const baseResult = calculateSolarReturn(readingChartInput);
const facts = solarReturnFacts(readingChartInput, baseResult);
/** F3/F4: the same chart cast in Placidus; sectors run 20.0659° … 41.4201°. */
const placidusFacts = calculateSolarReturnChart(readingChartInput, "placidus").facts;
/** F2: |latitude| >= 66 — `castChart` refuses the angle, so there is no wheel. */
const polarInput = {
  ...readingChartInput,
  returnPlace: { name: "Tromsø, Norway", latitude: 69.6, longitude: 18.9, timezone: "Europe/Oslo" },
};
const polarFacts = solarReturnFacts(polarInput, calculateSolarReturn(polarInput));
/** F5: southern hemisphere *and* east longitude in one chart (Sydney). */
const southInput = {
  ...readingChartInput,
  birthPlace: { name: "Sydney, Australia", latitude: -33.8688, longitude: 151.2093, timezone: "Australia/Sydney" },
  returnPlace: { name: "Sydney, Australia", latitude: -33.8688, longitude: 151.2093, timezone: "Australia/Sydney" },
};
const southFacts = solarReturnFacts(southInput, calculateSolarReturn(southInput));

const clone = (value: ChartFacts): ChartFacts => structuredClone(value);
const wheel = (value: ChartFacts | null | undefined, locale: Locale = "en") => {
  const geometry = projectWheel(value, locale);
  assert.ok(geometry, "expected a geometry for this fixture");
  return geometry;
};
const point = (geometry: WheelGeometry, id: string) => {
  const found = geometry.points.find(item => item.id === id);
  assert.ok(found, `expected a projected point ${id}`);
  return found;
};
/** The geometry rounds at emission, so an expectation restates that rounding. */
const r3 = (value: number) => Math.round(value * 1000) / 1000;
/**
 * Coordinates are emitted rounded to 3 dp, and a *label* position is computed from
 * the unrounded label angle (round at emission only), so recomputing it from the
 * emitted angle can differ by one unit in the last place. Two thousandths is the
 * bound that admits that and nothing else.
 */
const near = (actual: { x: number; y: number }, expected: { x: number; y: number }, label: string) => {
  assert.ok(Math.abs(actual.x - expected.x) <= 0.002 && Math.abs(actual.y - expected.y) <= 0.002,
    `${label}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
};
const aspect = (a: string, b: string, orb: number, type: Aspect["type"] = "trine"): Aspect =>
  ({ a, b, type, angle: 120, orb, applying: null, cross: false });
/** Deterministic shuffle (LCG): the same seed gives the same order on every machine. */
function shuffled<T>(items: T[], seed: number): T[] {
  const copy = items.slice();
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}
/** F9: ten bodies and both nodes inside an arc of ~4°, so labels genuinely collide. */
const clusteredFacts = (() => {
  const clustered = clone(facts);
  const ascendant = clustered.angles.ascendant!.longitude;
  clustered.bodies.forEach((body, index) => { body.longitude = normalize(ascendant + 2 + index * 0.3); });
  clustered.nodes.trueNode.longitude = normalize(ascendant + 1);
  clustered.nodes.southNode.longitude = normalize(ascendant + 2);
  return clustered;
})();
/** F6: 32 resolvable aspects, so the 24-chord cap binds (F1 alone has 22). */
const crowdedFacts = (() => {
  const crowded = clone(facts);
  for (let index = 0; index < 10; index += 1) crowded.aspects.push(aspect("Sun", "Moon", 5 + index * 0.1));
  return crowded;
})();
/** F8: clone with extra cross-aspects. F1 already carries the engine's 40. */
const crossAspectFacts = (() => {
  const crossed = clone(facts);
  crossed.crossAspects.push({ ...aspect("Mars", "natal-Venus", 1.5), cross: true });
  return crossed;
})();
const allFixtures: [string, ChartFacts][] = [
  ["whole-sign", facts], ["placidus", placidusFacts], ["southern/eastern", southFacts],
  ["cluster", clusteredFacts], ["crowded", crowdedFacts], ["cross-aspects", crossAspectFacts],
];

// ---------------------------------------------------------------- projection

test("wheel: anchors the ascendant left and the axes at the four cardinals", () => {
  const anchor = facts.angles.ascendant!.longitude; // 88.9078
  assert.equal(anchor, 88.9078);
  // The four cardinal consequences, asserted numerically and never by inspection.
  assert.equal(wheelAngle(anchor, anchor), 180);                    // Ascendant, 9 o'clock
  assert.ok(Math.abs(wheelAngle(normalize(anchor + 90), anchor) - 90) < 1e-9);   // IC, 6 o'clock
  assert.ok(Math.abs(wheelAngle(normalize(anchor + 180), anchor)) < 1e-9);       // Descendant, 3 o'clock
  assert.ok(Math.abs(wheelAngle(normalize(anchor + 270), anchor) - 270) < 1e-9); // MC, 12 o'clock
  // Longitude advances counter-clockwise on screen: +10° of longitude is −10° of angle.
  const before = wheelAngle(100, anchor);
  const after = wheelAngle(110, anchor);
  assert.ok(Math.abs(normalize(before - after) - 10) < 1e-9, "longitude advances counter-clockwise");
  // The involution: the strongest single orientation check, and the reason neither
  // helper rounds. Tolerance is 1e-9, far below any rounding of a real position.
  for (const longitude of [0, 1e-7, 30, 88.9078, 119.99999042980204, 200.125, 359.9999]) {
    for (const reference of [0, 88.9078, 271.3]) {
      const roundTrip = longitudeAt(wheelAngle(longitude, reference), reference);
      const delta = Math.abs(normalize(roundTrip - longitude + 180) - 180);
      assert.ok(delta <= 1e-9, `involution for ${longitude} @ ${reference}: ${delta}`);
    }
  }
  // And the geometry itself: the Ascendant's anchor is exactly the left point of the
  // outer ring, with the whole horizontal midline left free for it.
  const geometry = wheel(facts);
  assert.equal(geometry.anchorLongitude, anchor);
  const ascendant = point(geometry, "Ascendant");
  assert.equal(ascendant.angle, 180);
  assert.deepEqual(ascendant.anchor, { x: 220 - WHEEL_RADII.outer, y: 220 });
  assert.equal(point(geometry, "Midheaven").angle, r3(wheelAngle(335.0802, anchor)));
  assert.equal(point(geometry, "TrueNode").angle, r3(wheelAngle(335.39, anchor)));
  // MC is at the top-left of this chart, not at 270: the wheel is oriented by the
  // Ascendant, and the Midheaven's own longitude is what places it.
  assert.ok(Math.abs(point(geometry, "Midheaven").anchor.x - (220 + WHEEL_RADII.outer * Math.cos(293.828 * Math.PI / 180))) < 0.002);
});

test("wheel: projects whole-sign cusps 30 degrees apart", () => {
  const geometry = wheel(facts);
  assert.equal(geometry.houseSystem, "whole-sign");
  assert.equal(geometry.houses.length, 12);
  // The stored cusps are the ones projected (facts, not a recomputation)…
  assert.deepEqual(geometry.houses.map(house => house.cuspLongitude), facts.houses);
  // …and `wholeSignCusps` independently states the 30° spacing they must exhibit.
  assert.deepEqual(wholeSignCusps(facts.angles.ascendant!.longitude), facts.houses);
  for (const [index, house] of geometry.houses.entries()) {
    const next = geometry.houses[(index + 1) % 12]!;
    assert.equal(house.number, index + 1);
    assert.ok(Math.abs(normalize(house.angle - next.angle) - 30) < 1e-3, `house ${house.number} spans 30°`);
    // Whole-sign sectors are uniform, so the label sits exactly halfway along.
    assert.ok(Math.abs(normalize(house.angle - house.midAngle) - 15) < 1e-3, `house ${house.number} mid-angle`);
    assert.equal(house.angle, r3(wheelAngle(house.cuspLongitude, geometry.anchorLongitude)));
  }
});

test("wheel: keeps Placidus cusps at their own longitudes", () => {
  const geometry = wheel(placidusFacts);
  assert.equal(geometry.houseSystem, "placidus");
  assert.equal(geometry.houses.length, 12);
  // Stored, unequal cusps reach the screen unchanged. A uniform A + 30i projection
  // would put house 2 at 118.9078; the engine says 108.9737.
  assert.deepEqual(geometry.houses.map(house => house.cuspLongitude), placidusFacts.houses);
  assert.equal(placidusFacts.houses[1], 108.9737);
  assert.notEqual(geometry.houses[1]!.angle, normalize(geometry.houses[0]!.angle - 30));
  for (const house of geometry.houses) {
    assert.equal(house.angle, r3(wheelAngle(house.cuspLongitude, geometry.anchorLongitude)));
  }
  const spans = geometry.houses.map((house, index) => normalize(house.angle - geometry.houses[(index + 1) % 12]!.angle));
  assert.ok(spans.some(span => span < 30 - 1e-6), "a narrow Placidus sector exists");
  assert.ok(spans.some(span => span > 30 + 1e-6), "a wide Placidus sector exists");
  // Placidus and whole-sign disagree about cusps while agreeing about the Ascendant:
  // the wheel is oriented by the latter only.
  assert.equal(geometry.anchorLongitude, wheel(facts).anchorLongitude);
});

test("wheel: places house numbers at the sector mid-angle", () => {
  const geometry = wheel(placidusFacts);
  // Measured spans: house 1 = 20.0659° (narrow), house 5 = 41.4201° (wide).
  const spans = geometry.houses.map(house => {
    const index = geometry.houses.indexOf(house);
    return normalize(house.angle - geometry.houses[(index + 1) % 12]!.angle);
  });
  const narrow = spans.reduce((best, span, index) => (span < spans[best]! ? index : best), 0);
  const wide = spans.reduce((best, span, index) => (span > spans[best]! ? index : best), 0);
  assert.ok(spans[narrow]! < 21 && spans[wide]! > 41);
  for (const index of [narrow, wide]) {
    const house = geometry.houses[index]!;
    const next = geometry.houses[(index + 1) % 12]!;
    const span = normalize(house.angle - next.angle);
    // Walking from the cusp in the direction the sector actually runs lands the
    // number exactly halfway — true for 20° and for 41°, so the formula is not the
    // uniform-sector shortcut that only happens to work for whole-sign charts.
    assert.ok(Math.abs(normalize(house.angle - house.midAngle) - span / 2) < 1e-3, `sector ${house.number}`);
    assert.ok(Math.abs(normalize(house.midAngle - next.angle) - span / 2) < 1e-3, `sector ${house.number} (other half)`);
  }
});

test("wheel: omits the house ring when a cusp delta is degenerate", () => {
  for (const degenerate of [
    { label: "zero delta", apply: (value: ChartFacts) => { value.houses[5] = value.houses[4]!; } },
    { label: "half-circle delta", apply: (value: ChartFacts) => { value.houses[5] = normalize(value.houses[4]! + 180); } },
    { label: "wrapped past half-circle", apply: (value: ChartFacts) => { value.houses[2] = normalize(value.houses[1]! + 200); } },
  ]) {
    const broken = clone(facts);
    degenerate.apply(broken);
    const geometry = wheel(broken);
    // No ring at all: a partial ring draws a sector the data does not support, and
    // an omitted ring is visibly honest where a wrong one is authoritative.
    assert.deepEqual(geometry.houses, [], degenerate.label);
    assert.ok(geometry.omissions.includes("houses_omitted"), degenerate.label);
    // The rest of the wheel is unaffected: points and signs still plot.
    assert.equal(geometry.points.length, 14);
    assert.equal(geometry.signs.length, 12);
  }
  // A legal, badly unequal Placidus ring is not degenerate: only 0 and >= 180 are.
  assert.equal(wheel(placidusFacts).houses.length, 12);
});

test("wheel: does not mirror the wheel in the southern hemisphere or east longitude", () => {
  const geometry = wheel(southFacts);
  // Sydney: the Ascendant is 30.8328° in a different hemisphere and hemisphere of
  // longitude, and it still anchors at exactly 9 o'clock with longitude advancing
  // counter-clockwise. Orientation depends on longitude alone.
  assert.equal(southFacts.angles.ascendant!.longitude, 30.8328);
  const ascendant = point(geometry, "Ascendant");
  assert.equal(ascendant.angle, 180);
  assert.deepEqual(ascendant.anchor, { x: 220 - WHEEL_RADII.outer, y: 220 });
  // House 1 runs backwards from the Ascendant on screen, as it does in F1: the ring
  // is not rotated or mirrored, only projected.
  assert.ok(Math.abs(normalize(geometry.houses[0]!.angle - geometry.houses[1]!.angle) - 30) < 1e-3);
  assert.equal(geometry.houses[0]!.angle, r3(wheelAngle(southFacts.houses[0]!, geometry.anchorLongitude)));
  // Same rule, independently of sign: re-anchoring the Sydney chart on the F1
  // Ascendant reproduces the F1 Ascendant anchor exactly.
  const realigned = wheel({ ...clone(southFacts), angles: { ...southFacts.angles, ascendant: facts.angles.ascendant } });
  assert.deepEqual(point(realigned, "Ascendant").anchor, point(wheel(facts), "Ascendant").anchor);
  // And every screen angle is a pure function of longitude: no latitude term exists.
  for (const id of ["Sun", "Moon", "Midheaven"]) {
    const southern = point(geometry, id);
    assert.equal(southern.angle, r3(wheelAngle(southern.longitude, geometry.anchorLongitude)));
  }
});

test("wheel: returns null without an ascendant and never substitutes zero Aries", () => {
  // F2: a real chart at 69.6° latitude. `castChart` refuses the angle; the wheel is
  // omitted, never approximated.
  assert.equal(polarFacts.angles.ascendant, null);
  assert.equal(projectWheel(polarFacts, "en"), null);
  for (const locale of LOCALES) assert.equal(projectWheel(polarFacts, locale), null, locale);

  // A null Ascendant, whichever way it is null, is the same answer.
  const noAscendant = clone(facts);
  noAscendant.angles.ascendant = null;
  assert.equal(projectWheel(noAscendant, "en"), null);

  // A cusp list that is not exactly twelve is refused, not padded.
  for (const houses of [[], facts.houses.slice(0, 11), [...facts.houses, 45], Array(11).fill(0)]) {
    const broken = clone(facts);
    broken.houses = houses;
    assert.equal(projectWheel(broken, "en"), null, `houses.length ${houses.length}`);
  }

  // Absent facts are an answer, not a throw (this is what makes
  // `facts_unavailable`/`ascendant_unavailable` exist as shared notice vocabulary
  // even though `projectWheel` itself returns null instead of emitting them).
  assert.equal(projectWheel(null, "en"), null);
  assert.equal(projectWheel(undefined, "es"), null);
});

// ------------------------------------------------------------------- chords

test("wheel: never draws cross-aspects as chords", () => {
  assert.ok(facts.crossAspects.length > 0, "the fixture carries real cross-aspects");
  const geometry = wheel(facts);
  // Only the return chart's own aspects become chords.
  assert.ok(geometry.chords.length > 0);
  for (const chord of geometry.chords) {
    assert.ok(!chord.a.startsWith("natal-") && !chord.b.startsWith("natal-"), `natal endpoint in ${chord.a}/${chord.b}`);
    assert.ok(facts.aspects.some(candidate => candidate.a === chord.a && candidate.b === chord.b && candidate.type === chord.type));
  }
  assert.ok(geometry.omissions.includes("cross_aspects_not_plotted"));
  // Drawing them would have inflated the total; the reported total is the return
  // chart's own resolvable aspects.
  assert.equal(geometry.aspectTotal, facts.aspects.length);
  assert.ok(geometry.aspectTotal < geometry.aspectTotal + facts.crossAspects.length);
  // More cross-aspects change nothing about the chords.
  const grown = wheel(crossAspectFacts);
  assert.deepEqual(grown.chords, geometry.chords);
  assert.equal(grown.aspectTotal, geometry.aspectTotal);
  // And an aspect naming a natal endpoint inside `aspects` is dropped, not drawn.
  const misfiled = clone(facts);
  misfiled.aspects.push({ ...aspect("Mars", "natal-Venus", 0.1), cross: true });
  assert.deepEqual(wheel(misfiled).chords, geometry.chords);
});

test("wheel: keeps the 24 tightest aspects and reports the true total", () => {
  const geometry = wheel(crowdedFacts);
  assert.equal(geometry.aspectTotal, crowdedFacts.aspects.length);
  assert.equal(geometry.aspectTotal, 32);
  assert.equal(geometry.chords.length, WHEEL_MAX_CHORDS);
  assert.ok(geometry.omissions.includes("aspects_truncated"));
  // The tightest by orb, in ascending order — the cap drops the loosest, not the last
  // written. Two appended aspects (orb 5.0 and 6.0) survive on their own merit; the
  // rest are cut.
  const orbs = geometry.chords.map(chord => chord.orb);
  assert.deepEqual(orbs, orbs.slice().sort((a, b) => a - b));
  const keepable = crowdedFacts.aspects.map(item => item.orb).sort((a, b) => a - b)[WHEEL_MAX_CHORDS - 1]!;
  assert.equal(orbs.at(-1), keepable);
  for (const cut of crowdedFacts.aspects.filter(item => item.orb > keepable)) {
    assert.ok(!geometry.chords.some(chord => chord.a === cut.a && chord.b === cut.b && chord.orb === cut.orb));
  }
  // Exact 24 is not a truncation.
  const exact = clone(crowdedFacts);
  while (exact.aspects.length > WHEEL_MAX_CHORDS) exact.aspects.pop();
  assert.equal(exact.aspects.length, WHEEL_MAX_CHORDS);
  const exactWheel = wheel(exact);
  assert.equal(exactWheel.chords.length, WHEEL_MAX_CHORDS);
  assert.ok(!exactWheel.omissions.includes("aspects_truncated"));
});

test("wheel: drops an aspect whose endpoint is not in the facts", () => {
  const geometry = wheel(facts);
  const referenced = new Set(geometry.points.map(item => item.id));
  for (const chord of geometry.chords) {
    assert.ok(referenced.has(chord.a) && referenced.has(chord.b), `chord ${chord.a}/${chord.b} must resolve`);
  }
  // F7: a point the wheel does not project. Nothing is fabricated for it — no
  // position, no anchor, no chord — and the total excludes it.
  const absent = clone(facts);
  absent.aspects.push(aspect("Sun", "PartOfFortune", 0.0001));
  const projected = wheel(absent);
  assert.deepEqual(projected.chords, geometry.chords);
  assert.equal(projected.aspectTotal, geometry.aspectTotal);
  assert.ok(!projected.points.some(item => item.id === "PartOfFortune"));
  // A drop in the middle of the list does not shift the cap: still the tightest 24.
  const crowdedAbsent = clone(crowdedFacts);
  crowdedAbsent.aspects.push(aspect("Pluto", "PartOfFortune", 0));
  const crowdedWheel = wheel(crowdedAbsent);
  assert.equal(crowdedWheel.aspectTotal, crowdedFacts.aspects.length);
  assert.deepEqual(crowdedWheel.chords, wheel(crowdedFacts).chords);
  // A self-aspect cannot produce a zero-length chord, and does not count.
  const selfAspect = clone(facts);
  selfAspect.aspects.push(aspect("Sun", "Sun", 0));
  const selfWheel = wheel(selfAspect);
  assert.deepEqual(selfWheel.chords, geometry.chords);
  assert.equal(selfWheel.aspectTotal, geometry.aspectTotal);
});

// ------------------------------------------------------------- collision

test("wheel: never moves an anchor during collision handling", () => {
  const geometry = wheel(clusteredFacts);
  // F9 puts ten bodies and both nodes inside ~4°, so labels must collide.
  assert.ok(geometry.unlabelled.length > 0, "the fixture must actually crowd labels");
  assert.ok(geometry.omissions.includes("labels_omitted"));
  for (const item of geometry.points) {
    // The anchor is the projection of the true position and nothing else — the
    // mutant this test exists to kill recomputes it from `labelAngle`.
    assert.deepEqual(item.anchor, wheelPoint(wheelAngle(item.longitude, geometry.anchorLongitude), WHEEL_RADII.outer));
    assert.equal(item.angle, r3(wheelAngle(item.longitude, geometry.anchorLongitude)));
    // Nudges stay bounded, and only labels move.
    const nudge = Math.abs(normalize(item.labelAngle - item.angle + 180) - 180);
    assert.ok(nudge <= WHEEL_MAX_LABEL_NUDGE_DEG, `${item.id} nudged ${nudge}°`);
    if (item.band === null) {
      // A dropped label is recorded, has no band, and keeps a radial stub so its
      // position is still visible even when its name is not.
      assert.ok(geometry.unlabelled.includes(item.id));
      assert.ok(item.leader, `${item.id} keeps a leader stub`);
      assert.ok(Math.abs(item.leader.to.x) <= WHEEL_VIEW_BOX && Math.abs(item.leader.to.y) <= WHEEL_VIEW_BOX);
    } else {
      assert.ok(!geometry.unlabelled.includes(item.id));
      const radius = item.band === "A" ? WHEEL_RADII.labelBandA : WHEEL_RADII.labelBandB;
      near(item.labelPosition, wheelPoint(item.labelAngle, radius), item.id);
      // A leader appears exactly when the label moved far enough to need one.
      const separation = Math.abs(normalize(item.labelAngle - item.angle + 180) - 180);
      assert.equal(item.leader !== null, separation > 0.5, `${item.id} leader rule`);
    }
  }
  // The property that makes the whole guarantee: an anchor is the true position, so
  // it must sit exactly on the outer ring. A leader or a band changes; the ring point
  // does not, and a displaced one would still look like a valid chart.
  for (const item of geometry.points) {
    const dx = item.anchor.x - WHEEL_VIEW_BOX / 2;
    const dy = item.anchor.y - WHEEL_VIEW_BOX / 2;
    assert.ok(Math.abs(Math.hypot(dx, dy) - WHEEL_RADII.outer) <= 0.002, `${item.id} is on the outer ring`);
  }
  // Direct evidence that the label moved and the anchor did not: every nudged label's
  // anchor is a *different* point from the one its own label angle would produce, so a
  // mutant that recomputed the anchor from `labelAngle` fails here by name.
  const nudged = geometry.points.filter(item =>
    Math.abs(normalize(item.labelAngle - item.angle + 180) - 180) > 0.5);
  assert.ok(nudged.length > 0, "the fixture must actually nudge labels");
  for (const item of nudged) {
    assert.notDeepEqual(item.anchor, wheelPoint(item.labelAngle, WHEEL_RADII.outer),
      `${item.id}: the anchor must not follow the label`);
  }
  // Relaxing the crowd changes which labels fit, never where anything is drawn: the
  // uncrowded chart labels all fourteen, and the crowded one records its drops.
  const relaxed = clone(clusteredFacts);
  const spread = relaxed.bodies.map(body => body.longitude);
  relaxed.bodies.forEach((body, index) => { body.longitude = normalize(spread[0]! + index * 34); });
  const relaxedWheel = wheel(relaxed);
  assert.equal(relaxedWheel.unlabelled.length, 0, "the relaxed fixture must free the crowd");
  // Same fourteen points either way: crowding changes bands and nudges, never the
  // population of what is plotted.
  assert.deepEqual(relaxedWheel.points.map(item => item.id).slice().sort(),
    geometry.points.map(item => item.id).slice().sort());
});

test("wheel: keeps placed labels at least the minimum separation apart", () => {
  for (const [name, fixture] of allFixtures) {
    const geometry = wheel(fixture);
    for (const band of ["A", "B"] as const) {
      const placed = geometry.points.filter(item => item.band === band);
      for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
          const separation = Math.abs(normalize(placed[i]!.labelAngle - placed[j]!.labelAngle + 180) - 180);
          assert.ok(separation >= WHEEL_MIN_LABEL_SEPARATION_DEG - 1e-9, `${name}: ${placed[i]!.id}/${placed[j]!.id} in band ${band}`);
        }
      }
    }
    // Deterministic candidate order: 0, −1, +1, −2, +2, … so a tie resolves towards
    // the label that moves least, and never "whichever was tried first".
    assert.equal(geometry.points.length, 14, name);
  }
});

test("wheel: is deep-equal across repeated and shuffled input", () => {
  for (const locale of LOCALES) {
    const first = wheel(facts, locale);
    assert.deepEqual(wheel(facts, locale), first, `${locale}: repeated call`);
    // The emission order is stated, not inherited: points run by (angle, then id in
    // code-unit order) and chords by (orb, a, b, type). Assembly order — Sun first,
    // nodes last — is deliberately *not* the output order, so dropping the sort
    // changes the written sequence even when the set is identical.
    const ids = first.points.map(item => item.id);
    assert.deepEqual(ids, first.points.slice()
      .sort((a, b) => a.angle - b.angle || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(item => item.id), `${locale}: points are emitted in (angle, id) order`);
    assert.notDeepEqual(ids, [...BODIES, "Ascendant", "Midheaven", "TrueNode", "SouthNode"].filter(id => ids.includes(id)),
      `${locale}: assembly order must not reach the output`);
    const keys = first.chords.map(chord => [chord.orb, chord.a, chord.b, chord.type] as const);
    assert.deepEqual(keys, keys.slice().sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
      || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0) || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0)),
    `${locale}: chords are emitted in (orb, a, b, type) order`);
    // Array order that carries no meaning cannot reach the output: points are sorted
    // by (angle, id) and chords by (orb, a, b) with code-unit comparison.
    for (const seed of [1, 7, 42, 1234]) {
      const shuffledFacts = clone(facts);
      shuffledFacts.bodies = shuffled(shuffledFacts.bodies, seed);
      shuffledFacts.aspects = shuffled(shuffledFacts.aspects, seed + 1);
      shuffledFacts.crossAspects = shuffled(shuffledFacts.crossAspects, seed + 2);
      assert.deepEqual(wheel(shuffledFacts, locale), first, `${locale}: seed ${seed}`);
    }
  }
  // Ties are broken by (a, b), not by insertion order: two aspects with the same orb
  // and the same pair must order identically however they are written.
  const tied = (first: Aspect, second: Aspect) => {
    const value = clone(facts);
    value.aspects = [first, second];
    return wheel(value).chords;
  };
  const a = aspect("Sun", "Moon", 2.5);
  const b = aspect("Mars", "Venus", 2.5);
  assert.deepEqual(tied(a, b), tied(b, a));
  assert.deepEqual(tied(a, b).map(chord => `${chord.a}/${chord.b}`), ["Mars/Venus", "Sun/Moon"]);
  // Same pair, same orb, different type: still total and stable.
  const c = aspect("Saturn", "Pluto", 2.5, "square");
  const d = aspect("Saturn", "Pluto", 2.5, "sextile");
  assert.deepEqual(tied(c, d), tied(d, c));
});

// ------------------------------------------------------------------- labels

test("wheel: keeps every label short, Latin and inside the viewBox", () => {
  const allowed = /^[\p{Script=Latin}\p{Nd}° ]+$/u;
  for (const [name, fixture] of allFixtures) {
    for (const locale of LOCALES) {
      const geometry = wheel(fixture, locale);
      const margin = 6;
      const inside = (label: string, value: { x: number; y: number }) => {
        assert.ok(value.x >= margin && value.x <= WHEEL_VIEW_BOX - margin, `${name}/${locale}: ${label} x=${value.x}`);
        assert.ok(value.y >= margin && value.y <= WHEEL_VIEW_BOX - margin, `${name}/${locale}: ${label} y=${value.y}`);
      };
      for (const item of geometry.points) {
        assert.ok([...item.label].length <= WHEEL_MAX_LABEL_CHARS, `${item.id}: "${item.label}" too long`);
        assert.ok(allowed.test(item.label), `${item.id}: "${item.label}" has a character outside the Latin set`);
        inside(item.id, item.anchor);
        inside(item.id, item.labelPosition);
        if (item.leader) { inside(item.id, item.leader.from); inside(item.id, item.leader.to); }
      }
      for (const sign of geometry.signs) {
        assert.ok([...sign.label].length <= WHEEL_MAX_LABEL_CHARS, `${sign.label} too long`);
        assert.ok(allowed.test(sign.label), `${sign.label} has a character outside the Latin set`);
        // Sign boundaries and the label inside the ring keep their own margin.
        inside(sign.label, wheelPoint(sign.startAngle, WHEEL_RADII.signRing));
        inside(sign.label, wheelPoint(sign.labelAngle, WHEEL_RADII.signRing - 16));
      }
      for (const house of geometry.houses) {
        assert.ok(allowed.test(String(house.number)));
        inside(`house ${house.number}`, wheelPoint(house.angle, WHEEL_RADII.houseRing));
        inside(`house ${house.number}`, wheelPoint(house.midAngle, WHEEL_RADII.houseRing - 16));
      }
      // Every label the wheel can produce is guarded at placement, so nothing is
      // silently truncated: an over-long or non-Latin label is dropped instead.
      for (const item of geometry.points) {
        assert.equal(item.band === null || allowed.test(item.label), true);
      }
    }
  }
  // Spanish diacritics are legal, not a defect: the guard is Unicode-aware Latin.
  assert.ok(allowed.test("Géminis") && allowed.test("Júpiter") && allowed.test("Plutón") && allowed.test("Medio Cielo"));
  assert.ok(!allowed.test("Luna☉") && !allowed.test("Moon-"));

  // Today every label happens to fit, so the output assertions above cannot tell a
  // live guard from a missing one. The guard is therefore re-implemented here from the
  // plan's words — Latin letters including diacritics, decimal digits, `°` and space,
  // bounded by `WHEEL_MAX_LABEL_CHARS` — and fed labels that break it one way at a
  // time. Deleting the restriction in `wheel.ts` (the `wheel-label-unbounded` mutant,
  // or replacing it with an ASCII class) cannot make these fail, so the same test also
  // asserts the guard is present in the source and is consulted before placement.
  const guard = (label: string) => [...label].length > 0
    && [...label].length <= WHEEL_MAX_LABEL_CHARS
    && [...label].every(character => /\p{Script=Latin}|\p{Nd}|°| /u.test(character));
  assert.equal(guard("Medio Cielo"), true);
  assert.equal(guard("x".repeat(WHEEL_MAX_LABEL_CHARS)), true);
  assert.equal(guard("x".repeat(WHEEL_MAX_LABEL_CHARS + 1)), false, "over-long labels are refused");
  assert.equal(guard(""), false, "an empty label is refused");
  assert.equal(guard("Luna☉"), false, "a glyph outside the subset is refused");
  assert.equal(guard("Moon (node)"), false, "punctuation is refused");
  assert.equal(guard("Nodo_Norte"), false, "underscore is refused");
  const source = readFileSync(resolve("src/lib/wheel.ts"), "utf8");
  assert.ok(/p\{Script=Latin\}/.test(source), "the charset guard must be Unicode-aware Latin, never an ASCII class");
  assert.ok(!/\/\^\[A-Za-z/.test(source), "no ASCII-class label guard may stand in for the Unicode one");
  assert.ok(source.includes("characters.length <= WHEEL_MAX_LABEL_CHARS"), "the bound must be the shared constant");
  assert.ok(source.includes("if (validLabel(label))"), "the guard must be consulted before a label is placed");
});

test("wheel: labels a node as a node, not as the Moon", () => {
  // `castChart` stores both nodes with `body: "Moon"`; a label derived from the body
  // renders two Lunas with no type error to catch it.
  assert.equal(facts.nodes.trueNode.body, "Moon");
  assert.equal(facts.nodes.southNode.body, "Moon");
  const english = wheel(facts, "en");
  const spanish = wheel(facts, "es");
  for (const [locale, geometry, label] of [["en", english, "True Node"], ["es", spanish, "Nodo Norte"]] as const) {
    const node = point(geometry, "TrueNode");
    assert.equal(node.label, label, locale);
    assert.notEqual(node.label, "Moon");
    assert.notEqual(node.label, "Luna");
    assert.equal(node.kind, "node");
    assert.equal(node.longitude, facts.nodes.trueNode.longitude);
  }
  assert.equal(point(spanish, "SouthNode").label, "Nodo Sur");
  assert.equal(point(spanish, "Midheaven").label, "Medio Cielo");
  assert.equal(point(spanish, "Pluto").label, "Plutón");
  // Both sections of the vocabulary come from one place, keyed by id.
  for (const body of BODIES) {
    assert.equal(point(wheel(facts), body).label, pointName(body, "en"));
    assert.equal(point(wheel(facts, "es"), body).label, pointName(body, "es"));
    assert.equal(point(wheel(facts), body).kind, "body");
  }
  assert.equal(point(wheel(facts), "Ascendant").kind, "angle");
  assert.equal(point(wheel(facts), "Midheaven").kind, "angle");
  // `pointName` mirrors `signName`: it falls back to the input and imports nothing.
  assert.equal(pointName("PartOfFortune", "es"), "PartOfFortune");
  assert.equal(signName("Géminis", "es"), "Géminis");
});

test("wheel: emits coordinates at three decimal places", () => {
  const threeDecimals = (value: number, label: string) => {
    assert.equal(Math.round(value * 1000) / 1000, value, `${label} = ${value}`);
    assert.ok(!Object.is(value, -0), `${label} must not be -0`);
  };
  for (const [name, fixture] of allFixtures) {
    const geometry = wheel(fixture);
    for (const item of geometry.points) {
      threeDecimals(item.angle, `${name}/${item.id} angle`);
      threeDecimals(item.labelAngle, `${name}/${item.id} labelAngle`);
      threeDecimals(item.anchor.x, `${name}/${item.id} anchor.x`);
      threeDecimals(item.anchor.y, `${name}/${item.id} anchor.y`);
      threeDecimals(item.labelPosition.x, `${name}/${item.id} labelPosition.x`);
      threeDecimals(item.labelPosition.y, `${name}/${item.id} labelPosition.y`);
      if (item.leader) {
        threeDecimals(item.leader.from.x, `${name}/${item.id} leader.from.x`);
        threeDecimals(item.leader.to.y, `${name}/${item.id} leader.to.y`);
      }
    }
    for (const sign of geometry.signs) {
      threeDecimals(sign.startAngle, `${name}/${sign.label} startAngle`);
      threeDecimals(sign.endAngle, `${name}/${sign.label} endAngle`);
      threeDecimals(sign.labelAngle, `${name}/${sign.label} labelAngle`);
    }
    for (const house of geometry.houses) {
      threeDecimals(house.angle, `${name}/house ${house.number} angle`);
      threeDecimals(house.midAngle, `${name}/house ${house.number} midAngle`);
    }
    // Bit-stable serialization is the point: page and PDF must produce equal bytes.
    assert.equal(JSON.stringify(wheel(fixture)), JSON.stringify(wheel(fixture)));
  }
});

// ---------------------------------------------------------------- omissions

test("wheel: returns an empty-but-valid geometry when houses are omitted", () => {
  const geometry = wheel(facts);
  assert.deepEqual(geometry.omissions, ["natal_not_plotted", "cross_aspects_not_plotted"]);
  // Real saved facts always carry the natal chart (it is what the return activates),
  // and that is exactly why the omission exists.
  assert.equal(facts.natal.bodies.length, 10);
  // A crafted chart with no natal positions drops the notice rather than claiming the
  // omission unconditionally.
  const bare = clone(facts);
  bare.natal = { bodies: [], angles: { ascendant: null, midheaven: null }, houses: [] };
  assert.deepEqual(wheel(bare).omissions, ["cross_aspects_not_plotted"]);
  const lonely = clone(bare);
  lonely.crossAspects = [];
  assert.deepEqual(wheel(lonely).omissions, []);
  // Omissions are emitted in the union's declared order, so snapshots are stable.
  assert.deepEqual(wheel(clusteredFacts).omissions,
    ["natal_not_plotted", "cross_aspects_not_plotted", "labels_omitted"]);
  assert.deepEqual(wheel(crowdedFacts).omissions,
    ["natal_not_plotted", "cross_aspects_not_plotted", "aspects_truncated"]);
  const degenerate = clone(facts);
  degenerate.houses[3] = degenerate.houses[2]!;
  assert.deepEqual(wheel(degenerate).omissions,
    ["houses_omitted", "natal_not_plotted", "cross_aspects_not_plotted"]);
  // A drawn-ring chart still carries everything else it promised.
  assert.equal(geometry.factsVersion, "base-facts/1");
  assert.equal(geometry.viewBox, WHEEL_VIEW_BOX);
  assert.deepEqual(geometry.radii, WHEEL_RADII);
  assert.equal(geometry.signs.length, 12);
  assert.equal(geometry.points.length, 14);
  assert.deepEqual(geometry.signs.map(sign => sign.index), Array.from({ length: 12 }, (_, index) => index));
  assert.deepEqual(geometry.signs.map(sign => sign.label), SIGN_NAMES.map(name => signName(name, "en")));
});

test("wheel: stays inside the element budget", () => {
  for (const [name, fixture] of allFixtures) {
    const geometry = wheel(fixture);
    const labelled = geometry.points.filter(item => item.band !== null).length;
    const leaders = geometry.points.filter(item => item.leader !== null).length;
    // The count is the written rule, so a future ring cannot slip in unnoticed.
    assert.equal(geometry.elementCount,
      1 + geometry.signs.length * 2 + geometry.houses.length * 2 + geometry.signs.length * 4 +
      geometry.points.length + labelled + leaders + geometry.chords.length, name);
    assert.ok(geometry.elementCount <= WHEEL_MAX_ELEMENTS, `${name}: ${geometry.elementCount}`);
  }
  // The plan's largest fixture: 14 points, 24 chords, 12 signs, 12 houses, ticks and
  // leaders. Measured at 156 elements — the plan's own arithmetic sketch says 163,
  // and the difference is only how many leaders happen to clear 0.5° on this chart;
  // both are well inside the ceiling, which is what the budget is for.
  const largest = [...allFixtures].sort((a, b) => wheel(b[1]).elementCount - wheel(a[1]).elementCount)[0]!;
  const size = wheel(largest[1]).elementCount;
  assert.equal(size, 156, `largest fixture is ${largest[0]}`);
  assert.ok(size <= WHEEL_MAX_ELEMENTS);
  assert.ok(WHEEL_MAX_ELEMENTS - size >= 100, "the headroom the PDF time budget relies on is real");
});

// ------------------------------------------------------------------ purity

test("wheel: source has no clock, randomness, I/O or Node-only import", () => {
  const source = readFileSync(resolve("src/lib/wheel.ts"), "utf8");
  // The guard is about what executes, so comments — which name these very forbidden
  // imports to explain the rule — are stripped first.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of [
    "Date.now", "new Date", "Math.random", "randomUUID", "readFile", "writeFile",
    "process.env", "node:", "server-only", "@/readings", "@/db", "drizzle",
    "localeCompare", "fetch(", "require(",
  ]) {
    assert.ok(!code.includes(forbidden), `src/lib/wheel.ts must not contain ${forbidden}`);
  }
  // Positive: exactly the three allowed imports, and nothing else.
  const imports = code.split("\n").filter(line => line.trim().startsWith("import "));
  assert.equal(imports.length, 3, imports.join(" | "));
  assert.ok(imports[0]!.includes('"@/lib/astro"'));
  assert.ok(imports[1]!.includes('import type') && imports[1]!.includes('"@/lib/chart"'));
  assert.ok(imports[2]!.includes('"@/lib/i18n"'));
  assert.ok(source.includes("WHEEL_MAX_ELEMENTS") && source.includes("WHEEL_MAX_CHORDS"));
});

test("wheel: factsVersion matches the stored contract", () => {
  // D4: the module declares the literal locally so it stays client-safe, and this
  // test is the tie between the two declarations — at compile time (the literals must
  // be mutually assignable, so changing either one fails `tsc`) and at run time.
  type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const sameLiteral: Same<FactsVersion, typeof BASE_FACTS_VERSION> = true;
  const declared: FactsVersion = BASE_FACTS_VERSION;
  assert.ok(sameLiteral);
  assert.equal(declared, "base-facts/1");
  assert.equal(BASE_FACTS_VERSION, "base-facts/1");
  assert.equal(wheel(facts).factsVersion, BASE_FACTS_VERSION);
  assert.equal(wheel(placidusFacts).factsVersion, BASE_FACTS_VERSION);
});

// -------------------------------------------------------------- PDF glyphs

test("wheel: every label in both locales passes the PDF glyph gate", async () => {
  const renderer = await import("@react-pdf/renderer");
  const { loadPdfFonts, pdfGlyphsSupported } = await import("../src/readings/pdf-fonts");
  await loadPdfFonts(renderer, resolve("src/readings/fonts"));
  const strings: string[] = [];
  for (const [, fixture] of allFixtures) {
    for (const locale of LOCALES) {
      const geometry = wheel(fixture, locale);
      // Exactly what S1-d will hand the renderer: point labels, sign labels, house
      // numbers. An accented Spanish label outside the subset fails *every* Spanish
      // PDF at `409 pdf_glyphs`, three slices from now, with no other test noticing.
      strings.push(...geometry.points.map(item => item.label));
      strings.push(...geometry.signs.map(sign => sign.label));
      strings.push(...geometry.houses.map(house => String(house.number)));
    }
  }
  assert.ok(strings.includes("Géminis") && strings.includes("Medio Cielo") && strings.includes("Nodo Norte"));
  assert.ok(pdfGlyphsSupported(strings, renderer), "the wheel vocabulary must be renderable by the PDF subset");
  // Negative control: the gate is live, not trivially true. A glyph outside the Latin
  // subset is rejected, so a future i18n edit that adds one fails here first.
  assert.equal(pdfGlyphsSupported(["☉"], renderer), false);
});
