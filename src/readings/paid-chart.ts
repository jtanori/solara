import { z } from "zod";
import { BODIES, SIGN_NAMES } from "@/lib/astro";
import { chartDigest, type ChartFacts } from "@/lib/chart";
import { calculateSolarReturnChart } from "@/lib/solar";
import type { ChartInput } from "@/lib/types";
import { GenerationBlocked } from "@/readings/execution";
import { outboundDigest } from "@/readings/outbound-digest";
import { PAID_PROFILE, PAID_RICH_PROFILE, type PaidProfile } from "@/readings/paid-contract";
import { annualFactsSchema } from "@/readings/annual-schema";
import { enrichAnnualFacts, annualProfection, angularDistance, TRANSIT_DISPLAY_LIMIT, type AnnualFacts } from "@/lib/annual-facts";
import { canonicalHash } from "@/readings/policy";
import { readChart } from "@/readings/chart-presentation";
import type { ReadingChart } from "@/readings/presentation";

export const PAID_CALCULATION_POLICY = "placidus-return-v1";
export const PAID_RICH_CALCULATION_POLICY = "placidus-return-annual-v1";
export function paidCalculationPolicy(profile: PaidProfile) { return profile === PAID_RICH_PROFILE ? PAID_RICH_CALCULATION_POLICY : PAID_CALCULATION_POLICY; }
export const PAID_SNAPSHOT_BYTES = 128 * 1024;
const position = z.object({ sign: z.enum(SIGN_NAMES), longitude: z.number().min(0).max(360), degree: z.number().min(0).max(30) });
const house = z.number().int().min(1).max(12).nullable();
const body = position.extend({ body: z.enum(BODIES), house, retrograde: z.boolean().nullable() });
const angle = position.extend({ point: z.enum(["Ascendant", "Midheaven"]) });
const point = z.enum([...BODIES, "Ascendant", "Midheaven", "TrueNode", "SouthNode"]);
const aspect = z.object({
  a: point, b: z.string().regex(/^(?:natal-)?(?:Sun|Moon|Mercury|Venus|Mars|Jupiter|Saturn|Uranus|Neptune|Pluto|Ascendant|Midheaven|TrueNode|SouthNode)$/),
  type: z.enum(["conjunction", "opposition", "trine", "square", "sextile"]), angle: z.number().min(0).max(180), orb: z.number().min(0).max(30), applying: z.boolean().nullable(), cross: z.boolean(),
});
const count = z.number().int().min(0).max(20);
const factsSchema = z.object({
  chartVersion: z.literal("chart/2"), at: z.iso.datetime({ offset: true }), houseSystem: z.literal("placidus"), placidusValidated: z.literal(true),
  notice: z.string().max(512).nullable(), bodies: z.array(body).length(10),
  angles: z.object({ ascendant: angle, midheaven: angle }),
  nodes: z.object({ trueNode: body, southNode: body }), houses: z.array(z.number().min(0).max(360)).length(12),
  aspects: z.array(aspect).max(150), crossAspects: z.array(aspect).max(150),
  natal: z.object({ bodies: z.array(body).length(10), angles: z.object({ ascendant: angle.nullable(), midheaven: angle.nullable() }), houses: z.array(z.number().min(0).max(360)).max(12) }),
  balance: z.object({ fire: count, earth: count, air: count, water: count, cardinal: count, fixed: count, mutable: count }),
  warnings: z.array(z.string().max(512)).max(20),
});
const snapshotSchema = z.discriminatedUnion("version", [z.object({
  version: z.literal("paid-snapshot/1"), profile: z.literal(PAID_PROFILE), calculationPolicy: z.literal(PAID_CALCULATION_POLICY),
  chart: z.unknown(), facts: factsSchema,
}), z.object({
  version: z.literal("paid-snapshot/2"), profile: z.literal(PAID_RICH_PROFILE), calculationPolicy: z.literal(PAID_RICH_CALCULATION_POLICY),
  chart: z.unknown(), facts: factsSchema, annual: annualFactsSchema,
})]);
export type PaidSnapshot = { chart: ReadingChart; facts: ChartFacts } & (
  | { version: "paid-snapshot/1"; profile: typeof PAID_PROFILE; calculationPolicy: typeof PAID_CALCULATION_POLICY }
  | { version: "paid-snapshot/2"; profile: typeof PAID_RICH_PROFILE; calculationPolicy: typeof PAID_RICH_CALCULATION_POLICY; annual: AnnualFacts }
);

/** Called only after paid entitlement and consent fences, never by chart saving. */
export function calculatePaidSnapshot(readingId: string, input: ChartInput, profile: PaidProfile = PAID_PROFILE): PaidSnapshot {
  try {
    const calculated = calculateSolarReturnChart(input, "placidus");
    const result = calculated.result;
    if (!calculated.facts.angles.ascendant || calculated.facts.houses.length !== 12 || calculated.facts.bodies.some(item => item.house === null)) throw new GenerationBlocked("placidus_unavailable");
    const rich = profile === PAID_RICH_PROFILE ? enrichAnnualFacts(input, calculated.facts) : null;
    const facts = rich?.facts ?? calculated.facts;
    const sun = facts.bodies.find(item => item.body === "Sun")!;
    const moon = facts.bodies.find(item => item.body === "Moon")!;
    return readPaidSnapshot({
      ...(rich ? { version: "paid-snapshot/2", profile: PAID_RICH_PROFILE, calculationPolicy: PAID_RICH_CALCULATION_POLICY, annual: rich.annual }
        : { version: "paid-snapshot/1", profile: PAID_PROFILE, calculationPolicy: PAID_CALCULATION_POLICY }),
      chart: {
        id: readingId, year: input.year, name: input.name, returnPlace: input.returnPlace.name, timezone: input.returnPlace.timezone,
        result: { ...result, natalSun: sun, moon, ascendant: facts.angles.ascendant, sunHouse: sun.house, houseSystem: "Placidus", warnings: [...result.warnings, ...facts.warnings] },
      }, facts,
    });
  } catch (error) {
    if (error instanceof GenerationBlocked) throw error;
    // Calculation errors can embed birth data/coordinates. Never expose their text.
    throw new GenerationBlocked(profile === PAID_RICH_PROFILE ? "paid_calculation_unavailable" : "placidus_unavailable");
  }
}

/** Runtime validation is also applied to JSONB on worker recovery and every read. */
export function readPaidSnapshot(value: unknown): PaidSnapshot {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > PAID_SNAPSHOT_BYTES) throw new GenerationBlocked("snapshot_invalid");
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new GenerationBlocked("snapshot_invalid");
  const chart = readChart(parsed.data.chart, "Placidus");
  const facts = parsed.data.facts;
  const sun = facts.bodies.find(item => item.body === "Sun");
  const moon = facts.bodies.find(item => item.body === "Moon");
  const samePosition = (a: { sign: string; degree: number; longitude: number } | null, b: { sign: string; degree: number; longitude: number } | undefined) =>
    Boolean(a && b && a.sign === b.sign && a.degree === b.degree && a.longitude === b.longitude);
  if (chart.result.exactUtc !== facts.at || chart.result.houseSystem !== "Placidus" || new Set(facts.bodies.map(item => item.body)).size !== 10 ||
    !samePosition(chart.result.natalSun, sun) || !samePosition(chart.result.moon, moon) || !samePosition(chart.result.ascendant, facts.angles.ascendant) ||
    chart.result.sunHouse !== sun?.house || facts.angles.ascendant.point !== "Ascendant" || facts.angles.midheaven.point !== "Midheaven") throw new GenerationBlocked("snapshot_invalid");
  if (new Set(facts.natal.bodies.map(body => body.body)).size !== 10) throw new GenerationBlocked("snapshot_invalid");
  const snapshot: PaidSnapshot = { ...parsed.data, chart, facts };
  if (snapshot.profile === PAID_RICH_PROFILE) {
    const annual = snapshot.annual;
    const natal = facts.natal;
    const expected = annualProfection(0, annual.profections.age, natal.angles.ascendant?.sign ?? null);
    if (annual.referenceAt !== facts.at || canonicalHash(expected) !== canonicalHash(annual.profections) ||
      (natal.angles.ascendant && (natal.angles.ascendant.point !== "Ascendant" || natal.houses.length !== 12)) ||
      (!natal.angles.ascendant && natal.houses.length !== 0) || natal.angles.midheaven?.point !== "Midheaven" ||
      annual.transits.natalAnglesOmitted !== (!natal.angles.ascendant || !natal.angles.midheaven)) throw new GenerationBlocked("snapshot_invalid");
    const pairs = new Set<string>();
    for (const a of annual.transits.aspects) {
      const source = facts.bodies.find(body => body.body === a.transit);
      const target = a.natal === "Ascendant" ? natal.angles.ascendant : a.natal === "Midheaven" ? natal.angles.midheaven : natal.bodies.find(body => body.body === a.natal);
      const pair = `${a.transit}:${a.natal}`;
      if (!source || !target || pairs.has(pair) || Math.abs(angularDistance(source.longitude, target.longitude) - a.angle) > 0.0003) throw new GenerationBlocked("snapshot_invalid");
      pairs.add(pair);
    }
  }
  paidDigest(snapshot);
  return snapshot;
}
export function paidSnapshotHash(snapshot: PaidSnapshot): string { return canonicalHash(snapshot); }
export function paidDigest(snapshot: PaidSnapshot) {
  const base = chartDigest(snapshot.facts);
  if (snapshot.profile === PAID_PROFILE) return outboundDigest(base);
  const natal = snapshot.facts.natal;
  return outboundDigest({ ...base, natal: { houseSystem: "whole-sign", ascendant: natal.angles.ascendant?.sign ?? null, midheaven: natal.angles.midheaven?.sign ?? null,
    bodies: natal.bodies.map(body => ({ body: body.body, sign: body.sign, degree: Number(body.degree.toFixed(1)), house: body.house, retrograde: body.retrograde })) },
    profections: snapshot.annual.profections,
    transits: { ...snapshot.annual.transits, aspects: snapshot.annual.transits.aspects.slice(0, TRANSIT_DISPLAY_LIMIT), total: snapshot.annual.transits.aspects.length } });
}
