import { z } from "zod";
import { BODIES, SIGN_NAMES } from "@/lib/astro";
import { ANNUAL_FACTS_POLICY, PROFECTION_POLICY, TRANSIT_POLICY, TRANSIT_ANGLES, TRANSIT_ORBS } from "@/lib/annual-facts";
const common = { policy: z.literal(PROFECTION_POLICY), age: z.number().int().min(0).max(2100) };
export const profectionSchema = z.discriminatedUnion("status", [
  z.object({ ...common, status: z.literal("available"), natalAscendant: z.enum(SIGN_NAMES), house: z.number().int().min(1).max(12), sign: z.enum(SIGN_NAMES), ruler: z.enum(["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]) }),
  z.object({ ...common, status: z.literal("unavailable"), reason: z.literal("natal_ascendant_unavailable") }),
]);
export const transitAspectSchema = z.object({
  transit: z.enum(BODIES), natal: z.enum([...BODIES, "Ascendant", "Midheaven"]),
  type: z.enum(["conjunction", "opposition", "trine", "square", "sextile"]), angle: z.number().min(0).max(180), orb: z.number().min(0).max(3),
  phase: z.enum(["applying", "separating", "exact", "stationary"]), applying: z.boolean().nullable(), speed: z.number().min(-40).max(40),
}).refine(a => a.orb <= TRANSIT_ORBS[a.type] && Math.abs(Math.abs(a.angle - TRANSIT_ANGLES[a.type]) - a.orb) <= 0.0002 &&
  a.applying === (a.phase === "applying" ? true : a.phase === "separating" ? false : null), "transit_consistency");
export const transitsSchema = z.object({ policy: z.literal(TRANSIT_POLICY), reference: z.literal("solar-return-instant"),
  aspects: z.array(transitAspectSchema).max(120), natalAnglesOmitted: z.boolean() });
export const annualFactsSchema = z.object({ policy: z.literal(ANNUAL_FACTS_POLICY), referenceAt: z.iso.datetime({ offset: true }),
  profections: profectionSchema, transits: transitsSchema });
