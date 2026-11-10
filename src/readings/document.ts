import { randomUUID } from "node:crypto";
import type { ChartDigest } from "@/lib/chart";
import type { Locale } from "@/lib/i18n";
import { availableSections, sectionDefinition } from "@/readings/registry";
import { FALLBACK_PROSE, LOCKED_TEASERS, SECTION_SUBTITLES, SECTION_TITLES } from "@/readings/copy";
import type { ProviderUsage } from "@/readings/provider";
import { SECTION_KEYS, type LockedSection, type ReadingDocument, type ReadingSection, type SectionKey, type SectionTier } from "@/readings/types";

/**
 * Document assembly (`docs/plan-readings-engine-epic.md` §2). Pure: takes the
 * per-section outcomes from the pipeline and freezes them into the persisted
 * shape, including locked-section copy and graceful fallback blocks. Assembly
 * never dispatches anything — a document is a record, not a live view.
 */

export type SectionResult =
  | {
      key: SectionKey;
      status: "generated";
      fromCache: boolean;
      output: { blocks: ReadingSection["blocks"]; closingQuestion?: string };
      model: string;
      usage: ProviderUsage;
      /** MXN spent by *this* run (cache hits carry 0). */
      costMxn: number;
      latencyMs: number;
    }
  | { key: SectionKey; status: "failed"; failureReason: string; /** MXN wasted on attempts that produced nothing. */ costMxn?: number };

/** The digest facts each section is grounded in — also the fallback content. */
function sectionFacts(digest: ChartDigest, key: SectionKey): Record<string, unknown> {
  switch (key) {
    case "overview":
      return { sun: digest.sun, ascendant: digest.ascendant, crossAspects: digest.crossAspects.slice(0, 5) };
    case "sun":
      return { sun: digest.sun };
    case "moon":
      return { moon: digest.moon };
    case "ascendant":
      return { ascendant: digest.ascendant, midheaven: digest.midheaven, sunHouse: digest.sun.house };
    case "aspects":
      return { aspects: digest.aspects.slice(0, 10), crossAspects: digest.crossAspects.slice(0, 10) };
    case "houses":
      return { bodiesByHouse: digest.bodies.reduce<Record<string, string[]>>((acc, b) => {
        if (b.house === null) return acc;
        (acc[b.house] ??= []).push(b.body);
        return acc;
      }, {}) };
    case "planets":
      return { bodies: digest.bodies };
    case "nodes":
      return { nodes: digest.nodes };
    case "planetaryYear":
      return { profections: (digest as unknown as Record<string, unknown>).profections ?? null };
    case "transits":
      return { transits: (digest as unknown as Record<string, unknown>).transits ?? null };
    case "guidance":
      return { sun: digest.sun, moon: digest.moon, nodes: digest.nodes, crossAspects: digest.crossAspects.slice(0, 5) };
  }
}

function factsToEntries(facts: Record<string, unknown>, locale: Locale): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(facts)) {
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    entries.push({ key, value: text.length > 300 ? `${text.slice(0, 297)}...` : text });
    if (entries.length >= 20) break;
  }
  if (!entries.length) entries.push({ key: locale === "es" ? "carta" : "chart", value: locale === "es" ? "disponible" : "available" });
  return entries;
}

/** Static fallback blocks so a failed section still renders chart truth. */
export function fallbackBlocks(digest: ChartDigest, key: SectionKey, locale: Locale): ReadingSection["blocks"] {
  const facts = sectionFacts(digest, key);
  return [
    { kind: "prose", text: FALLBACK_PROSE[locale] },
    { kind: "keyValue", title: locale === "es" ? "Datos de tu carta" : "Your chart's facts", entries: factsToEntries(facts, locale) },
  ];
}

export function buildReadingDocument(args: {
  readingId: string;
  documentId?: string;
  locale: Locale;
  tier: SectionTier;
  digest: ChartDigest;
  contentVersion: string;
  results: SectionResult[];
}): ReadingDocument {
  const { readingId, locale, tier, digest, contentVersion, results } = args;
  const attempted = new Set(results.map(result => result.key));
  const sections: ReadingSection[] = [];
  const models: Partial<Record<SectionKey, string>> = {};
  let costMxn = 0;
  let wastedCostMxn = 0;

  for (const key of SECTION_KEYS) {
    const result = results.find(r => r.key === key);
    if (!result) continue;
    const definition = sectionDefinition(key);
    const facts = sectionFacts(digest, key);
    if (result.status === "generated") {
      models[key] = result.model;
      costMxn += result.costMxn;
      sections.push({
        key,
        tier: definition.tier,
        title: SECTION_TITLES[key][locale],
        subtitle: SECTION_SUBTITLES[key][locale],
        blocks: result.output.blocks,
        facts,
        status: "generated",
        closingQuestion: result.output.closingQuestion,
      });
    } else {
      wastedCostMxn += result.costMxn ?? 0;
      sections.push({
        key,
        tier: definition.tier,
        title: SECTION_TITLES[key][locale],
        subtitle: SECTION_SUBTITLES[key][locale],
        blocks: fallbackBlocks(digest, key, locale),
        facts,
        status: "failed",
        failureReason: result.failureReason,
      });
    }
  }

  // Locked = paid, available for this chart, and not in the document (free tier's
  // upsell surface). Sections whose facts the engine doesn't compute yet are
  // absent entirely, not locked.
  const lockedSections: LockedSection[] = availableSections(digest)
    .filter(key => sectionDefinition(key).tier === "paid" && !attempted.has(key))
    .map(key => ({ key, title: SECTION_TITLES[key][locale], teaser: LOCKED_TEASERS[key][locale] }));

  return {
    id: args.documentId ?? randomUUID(),
    readingId,
    locale,
    chartVersion: digest.chartVersion,
    contentVersion,
    models,
    generatedAt: new Date().toISOString(),
    tier,
    sections,
    lockedSections,
    costMxn: Number(costMxn.toFixed(6)),
    wastedCostMxn: Number(wastedCostMxn.toFixed(6)),
  };
}

/**
 * A document is persisted only if it carries generated content under a real
 * contentVersion. An all-fallback document (outage, missing provider config,
 * unpersistable version) must NOT occupy the insert-only
 * (readingId, locale, contentVersion) slot — that would permanently block
 * regeneration for that reading after the outage clears.
 */
export function persistableDocument(document: ReadingDocument): boolean {
  return (
    document.contentVersion !== "unavailable" &&
    document.sections.some(section => section.status === "generated")
  );
}
