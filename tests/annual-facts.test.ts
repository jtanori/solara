import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { annualProfection, angularDistance, transitMotion, returnInstantTransits, TRANSIT_ORDER, TRANSIT_ORBS, type TransitAspect } from "../src/lib/annual-facts";
import { SIGN_NAMES } from "../src/lib/astro";
import { resolveBirthTime } from "../src/lib/solar";
import type { ChartInput } from "../src/lib/types";
import { calculatePaidSnapshot, readPaidSnapshot, paidSnapshotHash, paidDigest } from "../src/readings/paid-chart";
import { PAID_PROFILE, PAID_RICH_PROFILE, PAID_RICH_SECTIONS, PAID_CORE_SECTIONS } from "../src/readings/paid-contract";
import { availableSections } from "../src/readings/registry";
import { outboundDigest } from "../src/readings/outbound-digest";
import { readingChartInput } from "./helpers/reading-fixtures";
import { processorProfile, consentDescriptor } from "../src/readings/policy";

const id = "22222222-2222-4222-8222-222222222222";
type ReferenceCase = { id: string; input: ChartInput; birthUtc: string; referenceAt: string; natalAscendant: number | null; natalMidheaven: number; natalBodies: Record<string, number>; natalCusps: number[];
  profection: { age: number; house: number | null; sign: string | null; ruler: string | null }; transits: Pick<TransitAspect, "transit" | "natal" | "type" | "orb" | "phase">[] };
const reference = JSON.parse(readFileSync("tests/fixtures/annual-facts.json", "utf8")) as { source: string; longitudeTolerance: number; returnTimeToleranceSeconds: number; cases: ReferenceCase[] };

test("annual facts: hand-checked whole-sign wheel, age zero/12/42 and all traditional rulers", () => {
  const rulers = ["Mars", "Venus", "Mercury", "Moon", "Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Saturn", "Jupiter"];
  for (const [index, sign] of SIGN_NAMES.entries()) {
    const result = annualProfection(1984, 1984, sign); assert.equal(result.status, "available");
    if (result.status !== "available") throw Error("profection missing");
    assert.equal(result.house, 1); assert.equal(result.sign, sign); assert.equal(result.ruler, rulers[index]);
  }
  const year12 = annualProfection(1984, 1996, "Aquarius"); assert.ok(year12.status === "available"); assert.equal(year12.house, 1); assert.equal(year12.sign, "Aquarius"); assert.equal(year12.ruler, "Saturn");
  const year42 = annualProfection(1984, 2026, "Aquarius"); assert.ok(year42.status === "available"); assert.deepEqual([year42.age, year42.house, year42.sign, year42.ruler], [42, 7, "Leo", "Sun"]);
  const wrap = annualProfection(2000, 2001, "Pisces"); assert.ok(wrap.status === "available"); assert.deepEqual([wrap.house, wrap.sign, wrap.ruler], [2, "Aries", "Mars"]);
  assert.deepEqual(annualProfection(1984, 2026, null), { policy: "traditional-whole-sign-selected-year-v1", age: 42, status: "unavailable", reason: "natal_ascendant_unavailable" });
  assert.throws(() => annualProfection(2026, 2025, "Aries"));
});

test("annual facts: hand-checked applying/separating, zodiac wrap, fixed natal, exact and stationary conventions", () => {
  assert.equal(transitMotion(88, 89, 90, 0, "square").phase, "applying");
  assert.equal(transitMotion(90, 91, 92, 0, "square").phase, "separating");
  assert.equal(transitMotion(92, 91, 90, 0, "square").phase, "applying", "retrograde can apply");
  assert.equal(transitMotion(358, 359, 0, 0, "conjunction").phase, "applying", "0/360 is not a giant reversal");
  assert.equal(transitMotion(358, 359, 0, 355, "conjunction").phase, "separating", "the natal target is not moving with the transit");
  assert.equal(transitMotion(358, 359, 0, 179, "opposition").phase, "exact");
  assert.equal(transitMotion(89, 90.0005, 91, 0, "square").applying, null);
  assert.equal(transitMotion(89, 90.0011, 91.01, 0, "square").phase, "separating");
  const stationary = transitMotion(88.9999, 89, 89.0001, 0, "square"); assert.equal(stationary.phase, "stationary"); assert.equal(stationary.applying, null);
  assert.equal(transitMotion(90, 90, 90, 0, "square").phase, "exact", "exact wins over stationary");
});

for (const fixture of reference.cases) test(`annual facts: independent natal angles, return instant and transit reference — ${fixture.id}`, () => {
  assert.match(reference.source, /Swiss Ephemeris/); assert.equal(reference.cases.length, 6);
  assert.equal(resolveBirthTime(fixture.input).toUTC().toISO(), new Date(fixture.birthUtc).toISOString());
  const snapshot = calculatePaidSnapshot(id, fixture.input, PAID_RICH_PROFILE); assert.equal(snapshot.profile, PAID_RICH_PROFILE);
  if (snapshot.profile !== PAID_RICH_PROFILE) throw Error("missing rich snapshot");
  assert.ok(Math.abs(Date.parse(snapshot.annual.referenceAt) - Date.parse(fixture.referenceAt)) <= reference.returnTimeToleranceSeconds * 1000);
  assert.equal(snapshot.annual.referenceAt, snapshot.chart.result.exactUtc);
  const natal = snapshot.facts.natal;
  if (fixture.natalAscendant === null) { assert.equal(natal.angles.ascendant, null); assert.equal(snapshot.annual.profections.status, "unavailable"); }
  else { assert.ok(natal.angles.ascendant); assert.ok(angularDistance(natal.angles.ascendant.longitude, fixture.natalAscendant) <= reference.longitudeTolerance); }
  assert.ok(natal.angles.midheaven); assert.ok(angularDistance(natal.angles.midheaven.longitude, fixture.natalMidheaven) <= reference.longitudeTolerance);
  assert.deepEqual(natal.houses, fixture.natalCusps);
  for (const body of natal.bodies) assert.ok(angularDistance(body.longitude, fixture.natalBodies[body.body]) <= reference.longitudeTolerance, body.body);
  const p = snapshot.annual.profections; assert.equal(p.age, fixture.profection.age);
  if (p.status === "available") assert.deepEqual([p.house, p.sign, p.ruler], [fixture.profection.house, fixture.profection.sign, fixture.profection.ruler]);
  // Compare the same independently supplied instant. This isolates motion/orbs
  // from the separately asserted solar-return search tolerance.
  const transits = returnInstantTransits(new Date(fixture.referenceAt), natal).aspects;
  const identity = (a: Pick<TransitAspect, "transit" | "natal" | "type">) => `${a.transit}/${a.natal}/${a.type}`;
  assert.deepEqual(transits.map(identity), fixture.transits.map(identity));
  for (const [index, aspect] of transits.entries()) {
    assert.ok(Math.abs(aspect.orb - fixture.transits[index].orb) <= reference.longitudeTolerance, identity(aspect));
    assert.equal(aspect.phase, fixture.transits[index].phase, identity(aspect));
    assert.ok(aspect.orb <= TRANSIT_ORBS[aspect.type]);
    if (index) assert.ok(TRANSIT_ORDER.indexOf(aspect.transit) >= TRANSIT_ORDER.indexOf(transits[index - 1].transit));
  }
});

test("annual facts: DST fold uses the selected birth occurrence; gaps are refused, not normalized", () => {
  const earlier = reference.cases.find(row => row.id === "fold-earlier")!; const later = reference.cases.find(row => row.id === "fold-later")!;
  const a = calculatePaidSnapshot(id, earlier.input, PAID_RICH_PROFILE); const b = calculatePaidSnapshot(id, later.input, PAID_RICH_PROFILE);
  assert.notEqual(a.facts.natal.angles.ascendant?.longitude, b.facts.natal.angles.ascendant?.longitude);
  assert.throws(() => resolveBirthTime({ ...earlier.input, birthDate: "2000-04-02", birthTime: "02:30" }), /does not exist/);
});

test("annual facts: delayed worker cannot change the fixed return snapshot or age; old core facts stay nine-section", () => {
  const savedNow = Date.now;
  const core = calculatePaidSnapshot(id, readingChartInput); assert.equal(core.profile, PAID_PROFILE); assert.deepEqual(availableSections(paidDigest(core)), [...PAID_CORE_SECTIONS]);
  const first = calculatePaidSnapshot(id, readingChartInput, PAID_RICH_PROFILE);
  try {
    Date.now = () => Date.parse("2099-12-31T23:59:59Z");
    const later = calculatePaidSnapshot(id, readingChartInput, PAID_RICH_PROFILE);
    assert.equal(paidSnapshotHash(later), paidSnapshotHash(first)); assert.deepEqual(availableSections(paidDigest(later)), [...PAID_RICH_SECTIONS]);
  } finally { Date.now = savedNow; }
  assert.equal(core.facts.natal.angles.ascendant, null); assert.equal("annual" in core, false);
  assert.throws(() => readPaidSnapshot({ ...core, profile: PAID_RICH_PROFILE }), /snapshot_invalid/);
  assert.equal(first.profile, PAID_RICH_PROFILE); if (first.profile !== PAID_RICH_PROFILE) return;
  const badAge = structuredClone(first); if (badAge.annual.profections.status === "available") badAge.annual.profections.ruler = "Mars";
  assert.throws(() => readPaidSnapshot(badAge), /snapshot_invalid/);
  assert.throws(() => readPaidSnapshot({ ...first, annual: { ...first.annual, referenceAt: "2099-01-01T00:00:00.000Z" } }), /snapshot_invalid/);
  const wire = JSON.stringify(paidDigest(first));
  for (const forbidden of [readingChartInput.name, readingChartInput.birthDate, readingChartInput.birthTime, readingChartInput.birthPlace.name, readingChartInput.returnPlace.name, first.annual.referenceAt, "birthDate", "latitude", "referenceAt"]) assert.equal(wire.includes(forbidden), false, forbidden);
  const polluted = { ...paidDigest(first), birthDate: "PRIVATE", transits: { ...paidDigest(first).transits!, raw: "PRIVATE", referenceAt: "PRIVATE" } };
  assert.equal(JSON.stringify(outboundDigest(polluted)).includes("PRIVATE"), false);
});

test("annual facts: richer derived age/natal/transit fields require a different explicit consent policy", () => {
  const env = { READINGS_PROVIDER: "chat-completions", READINGS_API_BASE_URL: "https://fixture.invalid/v1", READINGS_PROCESSOR_PROFILE: JSON.stringify({ id: "fixture-provider", name: "Fixture Provider", policyVersion: "v1", inputTokenLimits: { fixture: 100 }, servedModels: { fixture: ["fixture"] } }) };
  const core = processorProfile(env)!; const rich = processorProfile({ ...env, READINGS_PAID_PROFILE: PAID_RICH_PROFILE })!;
  assert.ok(core); assert.ok(rich); assert.notEqual(core.policyHash, rich.policyHash);
  for (const locale of ["en", "es"] as const) {
    const disclosure = consentDescriptor(rich, locale).disclosure;
    assert.ok(disclosure.includes(locale === "en" ? "age attained in the selected year" : "edad cumplida en el año elegido"));
    assert.ok(disclosure.includes(locale === "en" ? "timestamps are not sent" : "No se envían marcas de tiempo"));
    assert.ok(disclosure.includes(locale === "en" ? "not necessarily anonymous" : "no son necesariamente anónimos"));
  }
});
