import type { ChartDigest } from "@/lib/chart";
import type { SectionKey, SectionTier } from "@/readings/types";
import { SECTION_MODEL_TIER, type ModelTier } from "@/readings/config";

/**
 * The section registry (`docs/plan-readings-engine-epic.md` §2, §6) — the
 * editable surface for *structure*. A new section is a registry entry plus a
 * prompt file plus a schema: no migration, no CMS. Tiers are configuration:
 * free = `overview` + `sun` (decision 6, §9c — the conversion/cost lever,
 * cheap to change).
 */

export type SectionDefinition = {
  key: SectionKey;
  tier: SectionTier;
  modelTier: ModelTier;
  /**
   * Engine facts this section is grounded in. A section whose facts are not
   * (yet) carried by the digest is not generatable — ungrounded prose is the
   * "confidently wrong" risk (§10), so the registry refuses to dispatch it.
   * `planetaryYear` needs profections and `transits` needs transit-to-natal
   * aspects: both land with #110, which extends the digest, and these entries
   * light up without any registry change.
   */
  requiresFacts?: "profections" | "transits";
};

export const SECTION_REGISTRY: Record<SectionKey, SectionDefinition> = {
  overview: { key: "overview", tier: "free", modelTier: SECTION_MODEL_TIER.overview },
  sun: { key: "sun", tier: "free", modelTier: SECTION_MODEL_TIER.sun },
  moon: { key: "moon", tier: "paid", modelTier: SECTION_MODEL_TIER.moon },
  ascendant: { key: "ascendant", tier: "paid", modelTier: SECTION_MODEL_TIER.ascendant },
  aspects: { key: "aspects", tier: "paid", modelTier: SECTION_MODEL_TIER.aspects },
  houses: { key: "houses", tier: "paid", modelTier: SECTION_MODEL_TIER.houses },
  planets: { key: "planets", tier: "paid", modelTier: SECTION_MODEL_TIER.planets },
  nodes: { key: "nodes", tier: "paid", modelTier: SECTION_MODEL_TIER.nodes },
  planetaryYear: { key: "planetaryYear", tier: "paid", modelTier: SECTION_MODEL_TIER.planetaryYear, requiresFacts: "profections" },
  transits: { key: "transits", tier: "paid", modelTier: SECTION_MODEL_TIER.transits, requiresFacts: "transits" },
  guidance: { key: "guidance", tier: "paid", modelTier: SECTION_MODEL_TIER.guidance },
};

/** Sections whose grounding facts the digest actually carries. */
export function availableSections(digest: ChartDigest): SectionKey[] {
  const carried = digest as unknown as Record<string, unknown>;
  return (Object.keys(SECTION_REGISTRY) as SectionKey[]).filter(key => {
    const required = SECTION_REGISTRY[key].requiresFacts;
    return !required || carried[required] !== undefined;
  });
}

/**
 * Sections a document of `tier` contains: the free tier gets its free sections
 * only; the paid tier gets everything (paid readers keep the free sections).
 */
export function sectionsForTier(tier: SectionTier): SectionKey[] {
  return (Object.keys(SECTION_REGISTRY) as SectionKey[]).filter(
    key => tier === "paid" || SECTION_REGISTRY[key].tier === tier,
  );
}

export function sectionDefinition(key: SectionKey): SectionDefinition {
  return SECTION_REGISTRY[key];
}
