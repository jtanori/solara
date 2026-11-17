import { z } from "zod";
import { SIGN_NAMES } from "@/lib/astro";
import type { ChartDigest } from "@/lib/chart";

const sign = z.enum(SIGN_NAMES);
const body = z.enum(["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto", "TrueNode", "SouthNode", "Ascendant", "Midheaven"]);
const house = z.number().int().min(1).max(12).nullable();
const placement = z.object({ sign, degree: z.number().min(0).max(30), house });
const count = z.number().int().min(0).max(20);
const aspect = z.object({ a: body, b: body, type: z.enum(["conjunction", "opposition", "trine", "square", "sextile"]), orb: z.number().min(0).max(30) });

/** Allowlist the actual outbound shape/values. Derived facts are not guaranteed anonymous. */
const schema = z.object({
  chartVersion: z.literal("chart/2"), houseSystem: z.enum(["whole-sign", "placidus"]),
  sun: placement, moon: placement, ascendant: sign.nullable(), midheaven: sign,
  bodies: z.array(placement.extend({ body, retrograde: z.boolean().nullable() })).max(16),
  nodes: z.object({ north: sign, south: sign }),
  aspects: z.array(aspect).max(150), crossAspects: z.array(aspect).max(24),
  balance: z.object({ fire: count, earth: count, air: count, water: count, cardinal: count, fixed: count, mutable: count }),
});

export function outboundDigest(value: ChartDigest): ChartDigest {
  // Unknown keys are stripped; free-form engine warning strings are NOT forwarded.
  const safe = schema.parse(value);
  return { ...safe, warnings: value.warnings.length ? ["chart_calculation_limitations"] : [] };
}
