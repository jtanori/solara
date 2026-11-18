import { z } from "zod";
import { BODIES, SIGN_NAMES } from "@/lib/astro";
import type { ChartFacts } from "@/lib/chart";
import type { ChartInput, ChartResult } from "@/lib/types";
import { canonicalHash } from "@/readings/canonical-hash";

/**
 * The saved base-chart facts contract (issue #152, slice 1a of Solar Return
 * completion — `docs/plan-solar-wheel-facts.md`).
 *
 * A saved chart keeps its original small `ChartResult` forever, and additionally
 * gets one immutable, versioned row of the full deterministic calculation the
 * factual wheel and numerical table are drawn from. Three rules shape everything
 * here:
 *
 * 1. **Insert-only.** Nothing updates or backfills these rows, and no read path
 *    recomputes them. A future contract is a new `factsVersion`, not a rewrite.
 * 2. **Coherent or absent.** Facts that disagree with the summary beside them are
 *    worse than no facts, so any disagreement means the row is not written (on
 *    save) or not rendered (on read) — never partially trusted.
 * 3. **No raw birth data.** `ChartFacts` carries derived positions only. Rejection
 *    details are stable codes: calculation errors can embed coordinates, so their
 *    text is never recorded or returned.
 */

export const BASE_FACTS_VERSION = "base-facts/1";
export const BASE_CALCULATION_POLICY = "whole-sign-return-v1";
export const BASE_FACTS_BYTES = 64 * 1024;
/**
 * Save-side bound on the same payload, and the reason it is not the same number.
 *
 * `JSON.stringify` writes no separator spacing, while Postgres re-serializes `jsonb`
 * with `", "` and `": "`, so the stored form of a payload is always somewhat larger
 * than the form measured in this module. The stored bound is enforced twice — by the
 * `chart_facts_size_check` constraint and by the read-path guard — and both measure
 * `octet_length(facts::text)`. Rejecting at half that bound therefore guarantees a row
 * this code accepts can never trip the constraint, which would turn a perfectly
 * saveable chart into a 500.
 *
 * The margin is far larger than the expansion needs: over the 3168-chart sweep the
 * largest payload was 11.5 KiB compact, so this leaves roughly 2.8x headroom against
 * the largest chart anyone can currently save.
 */
export const BASE_FACTS_SAVE_BYTES = BASE_FACTS_BYTES / 2;
/**
 * `ChartResult` keeps unrounded longitudes and a two-term obliquity, while
 * `castChart` rounds recorded longitudes to 4 decimals and adds the third
 * obliquity term. Agreement is therefore tolerance-based, not exact — but tight
 * enough that a genuinely different calculation cannot pass.
 *
 * Measured over 3168 charts (12 birth places x 12 return places x 6 years x 4
 * birth times, both hemispheres, |latitude| up to 69.6): the largest Ascendant
 * delta was 4.999e-5 degrees and the largest Moon delta 4.98e-5, i.e. the 4-decimal
 * rounding and nothing else. This bound is twice that, so rounding passes and a
 * different instant does not.
 */
export const BASE_FACTS_TOLERANCE_DEGREES = 0.0001;
/**
 * The return is the instant the Sun reaches its natal longitude, found by search,
 * so the return Sun is near-identical to the natal Sun rather than bit-identical.
 * The same 3168-chart sweep measured a largest delta of 4.94e-5 degrees; this bound
 * is 40x that, while still catching a chart cast for the wrong moment (the Sun moves
 * about 0.04 degrees per hour, so anything beyond roughly three minutes fails).
 */
export const RETURN_SUN_TOLERANCE_DEGREES = 0.002;
export const BASE_FACTS_HOUSE_SYSTEM = "whole-sign" as const;

const position = z.object({
  sign: z.enum(SIGN_NAMES),
  longitude: z.number().min(0).max(360),
  degree: z.number().min(0).max(30),
});
const house = z.number().int().min(1).max(12).nullable();
const body = position.extend({ body: z.enum(BODIES), house, retrograde: z.boolean().nullable() });
const angle = position.extend({ point: z.enum(["Ascendant", "Midheaven"]) });
const point = z.enum([...BODIES, "Ascendant", "Midheaven", "TrueNode", "SouthNode"]);
const aspect = z.object({
  a: point,
  b: z.string().regex(/^(?:natal-)?(?:Sun|Moon|Mercury|Venus|Mars|Jupiter|Saturn|Uranus|Neptune|Pluto|Ascendant|Midheaven|TrueNode|SouthNode)$/),
  type: z.enum(["conjunction", "opposition", "trine", "square", "sextile"]),
  angle: z.number().min(0).max(180),
  orb: z.number().min(0).max(30),
  applying: z.boolean().nullable(),
  cross: z.boolean(),
});
const count = z.number().int().min(0).max(20);
const cuspList = z.array(z.number().min(0).max(360));

/**
 * Whole-sign counterpart of the paid Placidus snapshot schema. Unlike the paid
 * variant the Ascendant is nullable and the cusp list may be empty, because
 * `castChart` refuses to approximate an angle at |latitude| >= 66 and the wheel
 * must then be omitted rather than invented.
 */
export const baseFactsSchema = z.object({
  chartVersion: z.literal("chart/2"),
  at: z.iso.datetime({ offset: true }),
  houseSystem: z.literal(BASE_FACTS_HOUSE_SYSTEM),
  placidusValidated: z.literal(true),
  notice: z.string().max(512).nullable(),
  bodies: z.array(body).length(10),
  angles: z.object({ ascendant: angle.nullable(), midheaven: angle }),
  nodes: z.object({ trueNode: body, southNode: body }),
  houses: cuspList.refine(value => value.length === 12 || value.length === 0, "cusps are all twelve or none"),
  aspects: z.array(aspect).max(150),
  crossAspects: z.array(aspect).max(150),
  natal: z.object({
    bodies: z.array(body).length(10),
    angles: z.object({ ascendant: angle.nullable(), midheaven: angle.nullable() }),
    houses: cuspList.max(12),
  }),
  balance: z.object({ fire: count, earth: count, air: count, water: count, cardinal: count, fixed: count, mutable: count }),
  warnings: z.array(z.string().max(512)).max(20),
});

export type BaseFactsRow = {
  factsVersion: typeof BASE_FACTS_VERSION;
  calculationPolicy: typeof BASE_CALCULATION_POLICY;
  houseSystem: typeof BASE_FACTS_HOUSE_SYSTEM;
  chartVersion: "chart/2";
  facts: ChartFacts;
  factsHash: string;
};

/** Why facts were not written, or not rendered. Stable codes only — never error text. */
export type BaseFactsRejection =
  /** A chart saved before this contract existed. Normal, and never worth a warning log. */
  | "absent"
  /**
   * The row could not be read at all — an instance that has not run migration 0009 has
   * no `reading_chart_facts` table, or the database refused the query. Distinct from
   * `absent` because it is worth a warning, and from the codes below because nothing is
   * known about the stored data. Either way the viewer loses the wheel, never the chart.
   */
  | "unavailable"
  | "calculation_failed"
  | "incoherent"
  | "oversize"
  | "invalid"
  | "hash_mismatch";

function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "");
}

/** Shortest angular distance, so a wrap at 0/360 cannot look like a large error. */
export function angularDelta(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/**
 * The saved summary fields the coherence gate cross-checks. Narrowed from
 * `ChartResult` so the very same gate can verify stored facts against the display
 * chart (`ReadingChart.result`, whose `houseSystem` is a display string) without a
 * cast that would hide a real mismatch.
 */
export type ChartSummary = Pick<ChartResult, "exactUtc" | "natalSun" | "moon" | "ascendant" | "sunHouse">;

/**
 * Every way the saved summary and the saved facts could disagree. Returns a stable
 * code, or null when they describe the same chart. Shared by the save gate and the
 * read gate so the two can never drift apart.
 */
export function factsCoherenceRejection(result: ChartSummary, facts: ChartFacts): BaseFactsRejection | null {
  if (facts.chartVersion !== "chart/2" || facts.houseSystem !== BASE_FACTS_HOUSE_SYSTEM) return "incoherent";
  if (facts.at !== result.exactUtc) return "incoherent";
  if (new Set(facts.bodies.map(item => item.body)).size !== 10) return "incoherent";
  if (new Set(facts.natal.bodies.map(item => item.body)).size !== 10) return "incoherent";
  if (facts.angles.midheaven.point !== "Midheaven") return "incoherent";
  if ((facts.angles.ascendant === null) !== (result.ascendant === null)) return "incoherent";
  if (facts.angles.ascendant && result.ascendant) {
    if (facts.angles.ascendant.point !== "Ascendant") return "incoherent";
    if (angularDelta(facts.angles.ascendant.longitude, result.ascendant.longitude) > BASE_FACTS_TOLERANCE_DEGREES) return "incoherent";
  }
  // Houses exist exactly when the Ascendant does; a wheel needs both or neither.
  if ((facts.houses.length === 12) !== (facts.angles.ascendant !== null)) return "incoherent";
  if (facts.houses.length === 12 && facts.angles.ascendant) {
    // Whole-sign cusps are a pure function of the Ascendant: house one starts at the
    // sign the Ascendant is in and each following cusp is exactly 30 degrees further.
    // The wheel is oriented from the Ascendant while the house ring is drawn from these
    // cusps, so cusps that disagree with it would produce a wheel contradicting the
    // table beside it. Restated here independently of `wholeSignCusps` rather than
    // imported: this module stays free of the ephemeris that function lives beside, and
    // an independent statement of the invariant is what makes it a check at all. Were
    // the convention ever to change, this gate rejects the row — facts go missing, the
    // chart still renders, and nothing wrong is drawn.
    const ascendant = facts.angles.ascendant.longitude;
    if (angularDelta(facts.houses[0]!, Math.floor(ascendant / 30) * 30) > BASE_FACTS_TOLERANCE_DEGREES) return "incoherent";
    if (facts.houses.some((cusp, index) => angularDelta(cusp, (facts.houses[0]! + index * 30) % 360) > BASE_FACTS_TOLERANCE_DEGREES)) return "incoherent";
  }
  const sun = facts.bodies.find(item => item.body === "Sun");
  const moon = facts.bodies.find(item => item.body === "Moon");
  if (!sun || !moon) return "incoherent";
  if ((sun.house === null) !== (result.sunHouse === null)) return "incoherent";
  if (sun.house !== null && result.sunHouse !== null && sun.house !== result.sunHouse) return "incoherent";
  if (angularDelta(moon.longitude, result.moon.longitude) > BASE_FACTS_TOLERANCE_DEGREES) return "incoherent";
  if (angularDelta(sun.longitude, result.natalSun.longitude) > RETURN_SUN_TOLERANCE_DEGREES) return "incoherent";
  return null;
}

/**
 * Build the immutable row for a freshly calculated chart, or explain why there is
 * none. Pure: no database, no clock, no environment. A rejection here must never
 * fail the save — the chart is still worth keeping, and inventing facts to fill the
 * gap is not an option.
 */
export function baseFactsRow(
  calculate: (input: ChartInput, result: ChartResult) => ChartFacts,
  input: ChartInput,
  result: ChartResult,
): { row: BaseFactsRow } | { rejection: BaseFactsRejection } {
  let facts: ChartFacts;
  try {
    facts = calculate(input, result);
  } catch {
    // Calculation errors can embed birth coordinates. Record the code, never the text.
    return { rejection: "calculation_failed" };
  }
  // Validate our own output before persisting it — a schema that cannot read back what
  // the engine produced would make every later read silently facts-free — and then
  // persist exactly what was validated.
  //
  // `castChart` carries fields this contract does not declare: each angle also has a
  // redundant `index` (the sign's position, which `sign` already names). Storing the
  // parsed form keeps the immutable row minimal, and guarantees it reads back
  // byte-identically, so the hash verified on read is the hash of the bytes that were
  // written. The consequence is deliberate: anything the wheel or the numerical table
  // later needs must be declared in `baseFactsSchema` first, because an insert-only row
  // can never be amended — a new field means a new `factsVersion`.
  const parsed = baseFactsSchema.safeParse(facts);
  if (!parsed.success) return { rejection: "invalid" };
  const stored = parsed.data as ChartFacts;
  const rejection = factsCoherenceRejection(result, stored);
  if (rejection) return { rejection };
  if (serializedSize(stored) > BASE_FACTS_SAVE_BYTES) return { rejection: "oversize" };
  return {
    row: {
      factsVersion: BASE_FACTS_VERSION,
      calculationPolicy: BASE_CALCULATION_POLICY,
      houseSystem: BASE_FACTS_HOUSE_SYSTEM,
      chartVersion: stored.chartVersion,
      facts: stored,
      factsHash: canonicalHash(stored),
    },
  };
}

/**
 * Read stored facts for display. Anything wrong — oversized, malformed, tampered,
 * or no longer coherent with the summary — is reported as a rejection so the caller
 * can render an honest "full positions were not saved" notice instead of failing the
 * page or drawing a wheel that contradicts the numbers beside it.
 */
export function readBaseFacts(
  value: unknown,
  result: ChartSummary,
): { facts: ChartFacts } | { rejection: BaseFactsRejection } {
  if (value === null || value === undefined) return { rejection: "absent" };
  if (serializedSize(value) > BASE_FACTS_BYTES) return { rejection: "oversize" };
  const parsed = baseFactsSchema.safeParse(value);
  if (!parsed.success) return { rejection: "invalid" };
  const facts = parsed.data as ChartFacts;
  const coherence = factsCoherenceRejection(result, facts);
  if (coherence) return { rejection: coherence };
  return { facts };
}

/**
 * Verify a stored row's own metadata and hash before its facts are used. The
 * SELECT applies an `octet_length` guard that yields `null` instead of an oversized
 * payload, so a row that exists but carries `null` facts can only mean "too large to
 * transfer" — reported as `oversize`, not as a hash mismatch.
 */
export function baseFactsRowRejection(row: {
  factsVersion: string; calculationPolicy: string; houseSystem: string;
  chartVersion: string; factsHash: string; facts: unknown;
}): BaseFactsRejection | null {
  if (row.factsVersion !== BASE_FACTS_VERSION || row.calculationPolicy !== BASE_CALCULATION_POLICY ||
      row.houseSystem !== BASE_FACTS_HOUSE_SYSTEM || row.chartVersion !== "chart/2") return "invalid";
  if (row.facts === null || row.facts === undefined) return "oversize";
  if (canonicalHash(row.facts) !== row.factsHash) return "hash_mismatch";
  return null;
}
