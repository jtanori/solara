import { readFileSync } from "node:fs";
import path from "node:path";
import { generationEnabled, MAX_OUTPUT_TOKENS_PER_SECTION, SECTION_MODEL_TIER } from "@/readings/config";
import { costMicros } from "@/readings/execution";
import { CANONICAL_HASH_SCHEME, canonicalHash, liveGenerationConfig, RICH_PAYLOAD_POLICY_REVISION, type LiveGenerationConfig } from "@/readings/policy";
import { contentVersionFromSources } from "@/readings/content-version";
import { PAID_SECTION_TITLES, PAID_SECTION_SUBTITLES } from "@/readings/copy";
import { sectionJsonSchema } from "@/readings/schemas";
import { PAID_PROFILE, PAID_RICH_PROFILE, PAID_ALLOWANCE_POLICY, PAID_CEILING_MICROS, PAID_EXECUTOR, isPaidProfile, paidSections, paidPromptFile, type PaidProfile } from "@/readings/paid-contract";
import { paidCalculationPolicy } from "@/readings/paid-chart";
import type { SectionKey } from "@/readings/types";
import type { Locale } from "@/lib/i18n";

export type PaidGenerationConfig = LiveGenerationConfig & { quotes: Record<string, number>; contentVersion: string; editionProfile: PaidProfile; sections: readonly SectionKey[] };
export function paidGenerationEnabled(): boolean {
  return generationEnabled() && process.env.READINGS_PAID_GENERATION_ENABLED === "true" && process.env.READINGS_PAID_EXECUTOR === PAID_EXECUTOR;
}

/** Invalid strong/paid configuration is isolated from the valid free path. */
export function paidGenerationConfig(fetchImpl?: typeof fetch): PaidGenerationConfig | null {
  const base = liveGenerationConfig(fetchImpl);
  const editionProfile = process.env.READINGS_PAID_PROFILE ?? PAID_PROFILE;
  if (!base || !isPaidProfile(editionProfile) || !process.env.READINGS_STRONG_MODEL || !base.settings.prices ||
    (editionProfile === PAID_RICH_PROFILE && base.profile.payloadPolicy !== RICH_PAYLOAD_POLICY_REVISION)) return null;
  const sections = paidSections(editionProfile);
  const quotes: Record<string, number> = {};
  for (const requested of new Set(Object.values(base.settings.models))) {
    if (requested === "fixture-1" || !Object.hasOwn(base.profile.inputTokenLimits, requested) || !Object.hasOwn(base.profile.servedModels, requested)) return null;
    const aliases = base.profile.servedModels[requested];
    const price = Object.hasOwn(base.settings.prices, requested) ? base.settings.prices[requested] : null;
    if (!price || price.inputMxnPerMillion <= 0 || price.outputMxnPerMillion <= 0 || !aliases?.length) return null;
    for (const alias of aliases) {
      const served = Object.hasOwn(base.settings.prices, alias) ? base.settings.prices[alias] : null;
      if (!served || served.inputMxnPerMillion !== price.inputMxnPerMillion || served.outputMxnPerMillion !== price.outputMxnPerMillion) return null;
    }
    const quote = costMicros(base.settings.prices, requested, { inputTokens: base.profile.inputTokenLimits[requested], outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION });
    if (quote === null || quote < 1 || quote > PAID_CEILING_MICROS) return null;
    quotes[requested] = quote;
  }
  // All expected primaries plus their one possible repair must fit at admission.
  const worstCase = sections.reduce((sum, key) => sum + 2 * quotes[base.settings.models[SECTION_MODEL_TIER[key]]], 0);
  if (!Number.isSafeInteger(worstCase) || worstCase > PAID_CEILING_MICROS) return null;
  try {
    // Version the paid identity without re-signing old approvals/runs. Do not
    // reuse the free path's insertion-sensitive fingerprint as a paid input.
    const fingerprint = canonicalHash({ hashScheme: CANONICAL_HASH_SCHEME,
      base: { profile: base.profile, settings: base.settings, payload: base.profile.payloadPolicy }, profile: editionProfile, sections,
      calculation: paidCalculationPolicy(editionProfile), allowance: PAID_ALLOWANCE_POLICY, quotes, ceiling: PAID_CEILING_MICROS });
    return { ...base, fingerprint, quotes, editionProfile, sections, contentVersion: paidContentVersion(fingerprint, editionProfile) };
  } catch { return null; }
}

/** Paid sources and schemas are versioned separately; free contentVersion is unchanged. */
export function paidContentVersion(configHash: string, profile: PaidProfile = PAID_PROFILE): string {
  const root = path.join(process.cwd(), "src", "readings", "prompts");
  const sections = paidSections(profile);
  const files: Record<string, string> = {};
  for (const file of ["_wrapper.md", "paid/_contract.md", ...sections.flatMap(key =>
    (["en", "es"] as const).map(locale => paidPromptFile(key, locale)))]) {
    files[file] = readFileSync(path.join(root, file), "utf8");
  }
  const schemas = Object.fromEntries(sections.map(key => [key, sectionJsonSchema(key, "paid")]));
  return contentVersionFromSources(files, schemas, JSON.stringify({ revision: "paid-editorial/2", hashScheme: CANONICAL_HASH_SCHEME, configHash,
    profile, sections, copy: sections.map(key => [PAID_SECTION_TITLES[key], PAID_SECTION_SUBTITLES[key]]), models: SECTION_MODEL_TIER, calculation: paidCalculationPolicy(profile) }));
}
export function paidOfferHash(config: PaidGenerationConfig, revision: number, period: string, locale: Locale): string {
  return canonicalHash({ profile: config.editionProfile, contentVersion: config.contentVersion, config: config.fingerprint, revision, period, locale });
}
export function paidModel(config: Pick<PaidGenerationConfig, "settings">, key: SectionKey): string {
  return config.settings.models[SECTION_MODEL_TIER[key]];
}
