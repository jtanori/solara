import { SiderealTime } from "astronomy-engine";
import { BODIES, SIGN_NAMES, longitudeOf, normalize, type BodyName } from "@/lib/astro";
import { castChart, type ChartFacts, type AspectType } from "@/lib/chart";
import { resolveBirthTime } from "@/lib/solar";
import type { ChartInput } from "@/lib/types";

export const PROFECTION_POLICY = "traditional-whole-sign-selected-year-v1";
export const TRANSIT_POLICY = "solar-return-instant-transits-v1";
export const ANNUAL_FACTS_POLICY = "annual-facts-v1";
export const TRANSIT_ORBS = { conjunction: 3, opposition: 3, trine: 3, square: 3, sextile: 2 } as const;
export const TRANSIT_ANGLES: Record<AspectType, number> = { conjunction: 0, opposition: 180, trine: 120, square: 90, sextile: 60 };
export const TRADITIONAL_RULERS = ["Mars", "Venus", "Mercury", "Moon", "Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Saturn", "Jupiter"] as const;
export const TRANSIT_ORDER: readonly BodyName[] = ["Pluto", "Neptune", "Uranus", "Saturn", "Jupiter", "Mars", "Venus", "Mercury", "Sun", "Moon"];
export const TRANSIT_EXACT_ORB = 0.001;
export const TRANSIT_STATIONARY_SPEED = 0.003;
export const TRANSIT_SAMPLE_HOURS = 6;
export const TRANSIT_DISPLAY_LIMIT = 24;
export type ZodiacSign = typeof SIGN_NAMES[number];
export type NatalPoint = BodyName | "Ascendant" | "Midheaven";
export type TransitPhase = "applying" | "separating" | "exact" | "stationary";
export type Profection = { policy: typeof PROFECTION_POLICY; age: number } & (
  | { status: "available"; natalAscendant: ZodiacSign; house: number; sign: ZodiacSign; ruler: typeof TRADITIONAL_RULERS[number] }
  | { status: "unavailable"; reason: "natal_ascendant_unavailable" }
);
export type TransitAspect = { transit: BodyName; natal: NatalPoint; type: AspectType; angle: number; orb: number; phase: TransitPhase; applying: boolean | null; speed: number };
export type AnnualFacts = {
  policy: typeof ANNUAL_FACTS_POLICY;
  referenceAt: string;
  profections: Profection;
  transits: { policy: typeof TRANSIT_POLICY; reference: "solar-return-instant"; aspects: TransitAspect[]; natalAnglesOmitted: boolean };
};

/** Birthday-adjacent solar returns must not accidentally profect to the prior age. */
export function annualProfection(birthYear: number, selectedReturnYear: number, natalAscendant: string | null): Profection {
  const age = selectedReturnYear - birthYear;
  if (!Number.isInteger(age) || age < 0 || age > 2100) throw new Error("profection_age_invalid");
  if (natalAscendant === null) return { policy: PROFECTION_POLICY, age, status: "unavailable", reason: "natal_ascendant_unavailable" };
  const ascIndex = SIGN_NAMES.indexOf(natalAscendant as ZodiacSign);
  if (ascIndex < 0) throw new Error("profection_ascendant_invalid");
  const index = (ascIndex + age % 12) % 12;
  return { policy: PROFECTION_POLICY, age, status: "available", natalAscendant: SIGN_NAMES[ascIndex], house: age % 12 + 1, sign: SIGN_NAMES[index], ruler: TRADITIONAL_RULERS[index] };
}
export function angularDistance(a: number, b: number) { const diff = normalize(a - b); return Math.min(diff, 360 - diff); }
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

/** Central ±6h differences move ONLY the transit; the natal longitude stays fixed.
 * Exact (<= .001°) takes precedence, then stationary (< .003°/day), then the
 * derivative of distance to the exact aspect. Never infer a future hit/window.
 */
export function transitMotion(before: number, at: number, after: number, natal: number, type: AspectType): Pick<TransitAspect, "phase" | "applying" | "speed"> {
  const delta = ((after - before + 540) % 360) - 180;
  const speed = delta * 24 / (2 * TRANSIT_SAMPLE_HOURS);
  const target = TRANSIT_ANGLES[type];
  const orb = Math.abs(angularDistance(at, natal) - target);
  const slope = Math.abs(angularDistance(after, natal) - target) - Math.abs(angularDistance(before, natal) - target);
  const phase: TransitPhase = orb <= TRANSIT_EXACT_ORB ? "exact" : Math.abs(speed) < TRANSIT_STATIONARY_SPEED || Math.abs(slope) < 1e-7 ? "stationary" : slope < 0 ? "applying" : "separating";
  return { phase, applying: phase === "applying" ? true : phase === "separating" ? false : null, speed: round(speed, 6) };
}

export function returnInstantTransits(at: Date, natal: ChartFacts["natal"]): AnnualFacts["transits"] {
  if (!Number.isFinite(at.getTime())) throw new Error("transit_instant_invalid");
  const targets: { name: NatalPoint; longitude: number }[] = natal.bodies.map(body => ({ name: body.body, longitude: body.longitude }));
  if (natal.angles.ascendant) targets.push({ name: "Ascendant", longitude: natal.angles.ascendant.longitude });
  if (natal.angles.midheaven) targets.push({ name: "Midheaven", longitude: natal.angles.midheaven.longitude });
  const aspects: TransitAspect[] = [];
  for (const transit of TRANSIT_ORDER) {
    const longitude = longitudeOf(transit, at);
    const before = longitudeOf(transit, new Date(at.getTime() - TRANSIT_SAMPLE_HOURS * 3_600_000));
    const after = longitudeOf(transit, new Date(at.getTime() + TRANSIT_SAMPLE_HOURS * 3_600_000));
    for (const target of targets) {
      const angle = angularDistance(longitude, target.longitude);
      // These five orb intervals never overlap. The stable list also fixes ties.
      for (const type of Object.keys(TRANSIT_ORBS) as AspectType[]) {
        const orb = Math.abs(angle - TRANSIT_ANGLES[type]);
        if (orb > TRANSIT_ORBS[type]) continue;
        aspects.push({ transit, natal: target.name, type, angle: round(angle), orb: round(orb), ...transitMotion(before, longitude, after, target.longitude, type) });
      }
    }
  }
  const targetOrder: readonly NatalPoint[] = [...BODIES, "Ascendant", "Midheaven"];
  aspects.sort((a, b) => TRANSIT_ORDER.indexOf(a.transit) - TRANSIT_ORDER.indexOf(b.transit) || a.orb - b.orb || targetOrder.indexOf(a.natal) - targetOrder.indexOf(b.natal));
  return { policy: TRANSIT_POLICY, reference: "solar-return-instant", aspects, natalAnglesOmitted: !natal.angles.ascendant || !natal.angles.midheaven };
}

/** Rich paid-only enrichment. The free/core calculation and its saved facts do not change. */
export function enrichAnnualFacts(input: ChartInput, facts: ChartFacts): { facts: ChartFacts; annual: AnnualFacts } {
  const birth = resolveBirthTime(input); const at = birth.toJSDate();
  const natal = castChart({ at, latitude: input.birthPlace.latitude, longitude: input.birthPlace.longitude,
    ramcDegrees: normalize(SiderealTime(at) * 15 + input.birthPlace.longitude), houseSystem: "whole-sign" });
  const enriched: ChartFacts = { ...facts, natal: { bodies: natal.bodies, angles: natal.angles, houses: natal.houses }, warnings: [...facts.warnings] };
  if (!natal.angles.ascendant) enriched.warnings.push("Natal Ascendant and traditional annual profection are unavailable at this birth latitude.");
  const annual: AnnualFacts = { policy: ANNUAL_FACTS_POLICY, referenceAt: facts.at,
    profections: annualProfection(birth.year, input.year, natal.angles.ascendant?.sign ?? null),
    transits: returnInstantTransits(new Date(facts.at), enriched.natal) };
  return { facts: enriched, annual };
}
