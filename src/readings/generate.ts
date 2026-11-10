import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChartDigest } from "@/lib/chart";
import { localeName, type Locale } from "@/lib/i18n";
import {
  costMxn,
  generationEnabled,
  MAX_OUTPUT_TOKENS_PER_SECTION,
  modelForTier,
  providerName,
  TIER_CEILING_MXN,
} from "@/readings/config";
import { availableSections, sectionDefinition, sectionsForTier } from "@/readings/registry";
import { computeContentVersion } from "@/readings/content-version";
import { approxTokens, PROVIDERS, type ProviderUsage, type ReadingProvider } from "@/readings/provider";
import { sectionJsonSchema, validateSectionOutput, type SectionOutput } from "@/readings/schemas";
import { buildReadingDocument, type SectionResult } from "@/readings/document";
import type { ReadingDocument, SectionKey, SectionTier } from "@/readings/types";

/**
 * The generation pipeline (`docs/plan-readings-engine-epic.md` §4).
 *
 * Order of operations per section, invariants in comments:
 *   cache hit  → reuse the frozen row (regeneration is explicit, §4.5)
 *   ceiling    → projected worst-case spend checked BEFORE dispatch (§4.6, fails closed)
 *   dispatch   → provider adapter; model chosen by configuration (§4.4)
 *   validate   → strict schema; ONE repair attempt; then status "failed"
 *   fallback   → static chart-grounded blocks, never an error page (§4.7)
 *   freeze     → insert-only cache put; no update path exists anywhere
 *
 * The whole function NEVER throws: a chart must always get its document.
 */

const PROMPTS_DIR = path.join(process.cwd(), "src", "readings", "prompts");

// ------------------------------------------------------------------ cache

export type SectionCacheKey = {
  digestHash: string;
  section: SectionKey;
  locale: Locale;
  contentVersion: string;
};

export type CachedSection = {
  output: SectionOutput;
  model: string;
  usage: ProviderUsage;
  costMxn: number;
  latencyMs: number;
};

/** Insert-only store for frozen sections. Production: DB; tests: memory. */
export interface SectionCache {
  get(key: SectionCacheKey): Promise<CachedSection | null>;
  put(key: SectionCacheKey, value: CachedSection): Promise<void>;
}

export class MemorySectionCache implements SectionCache {
  private readonly store = new Map<string, CachedSection>();

  static keyOf(key: SectionCacheKey): string {
    return JSON.stringify({ digestHash: key.digestHash, section: key.section, locale: key.locale, contentVersion: key.contentVersion });
  }

  async get(key: SectionCacheKey): Promise<CachedSection | null> {
    return this.store.get(MemorySectionCache.keyOf(key)) ?? null;
  }

  async put(key: SectionCacheKey, value: CachedSection): Promise<void> {
    // Freeze semantics: first write wins. A second generation of the same key
    // is a bug (or a concurrent race) — either way, keep the frozen original.
    const keyText = MemorySectionCache.keyOf(key);
    if (!this.store.has(keyText)) this.store.set(keyText, value);
  }

  get size(): number {
    return this.store.size;
  }

  /** Test observability: the frozen rows with their full cache keys. */
  snapshot(): Array<{ key: SectionCacheKey; value: CachedSection }> {
    return [...this.store.entries()].map(([keyText, value]) => ({
      key: JSON.parse(keyText) as SectionCacheKey,
      value,
    }));
  }
}

export function digestHashOf(digest: ChartDigest): string {
  return createHash("sha256").update(JSON.stringify(digest)).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------ prompt

const promptFileCache = new Map<string, string>();

function readPromptFile(file: string): string {
  let text = promptFileCache.get(file);
  if (text === undefined) {
    text = readFileSync(path.join(PROMPTS_DIR, file), "utf8");
    promptFileCache.set(file, text);
  }
  return text;
}

function assemblePrompt(section: SectionKey, locale: Locale, digestJson: string, jsonSchema: string): string {
  return readPromptFile("_wrapper.md")
    .replaceAll("{{localeName}}", localeName(locale))
    .replaceAll("{{sectionBrief}}", readPromptFile(`${section}.${locale}.md`).trim())
    .replaceAll("{{digestJson}}", digestJson)
    .replaceAll("{{jsonSchema}}", jsonSchema);
}

// ------------------------------------------------------------------ provider

function resolveProvider(): ReadingProvider | null {
  const name = providerName();
  const factory = name ? PROVIDERS[name] : undefined;
  return factory ? factory() : null;
}

// ------------------------------------------------------------------ pipeline

export type GenerateDocumentArgs = {
  readingId: string;
  documentId?: string;
  locale: Locale;
  tier: SectionTier;
  digest: ChartDigest;
  cache: SectionCache;
  /** Defaults to the config-selected provider; tests inject fixtures/spies here. */
  provider?: ReadingProvider;
};

export async function generateReadingDocument(args: GenerateDocumentArgs): Promise<ReadingDocument> {
  const results: SectionResult[] = [];
  const wanted = sectionsForTier(args.tier).filter(key => availableSections(args.digest).includes(key));

  let contentVersion = "unavailable";
  try {
    contentVersion = computeContentVersion();
  } catch {
    // No prompts ⇒ no version ⇒ nothing cacheable or generatable. Fails closed.
  }

  try {
    if (contentVersion === "unavailable") {
      for (const key of wanted) results.push({ key, status: "failed", failureReason: "content_version_unavailable" });
    } else {
      const digestHash = digestHashOf(args.digest);
      const enabled = generationEnabled();
      const provider = args.provider ?? resolveProvider();
      let spent = 0; // MXN spent by THIS run (cache hits add nothing)

      for (const key of wanted) {
        if (!enabled) {
          results.push({ key, status: "failed", failureReason: "generation_disabled" });
          continue;
        }

        const cacheKey: SectionCacheKey = { digestHash, section: key, locale: args.locale, contentVersion };

        let cached: CachedSection | null = null;
        try {
          cached = await args.cache.get(cacheKey);
        } catch {
          cached = null; // an unreadable cache means regenerate, never crash
        }
        if (cached) {
          results.push({
            key, status: "generated", fromCache: true, output: cached.output,
            model: cached.model, usage: cached.usage, costMxn: 0, latencyMs: cached.latencyMs,
          });
          continue;
        }

        if (!provider) {
          results.push({ key, status: "failed", failureReason: "provider_unavailable" });
          continue;
        }

        const model = modelForTier(sectionDefinition(key).modelTier);
        const digestJson = JSON.stringify(args.digest, null, 1);
        const schema = sectionJsonSchema(key);
        const prompt = assemblePrompt(key, args.locale, digestJson, JSON.stringify(schema));

        // Ceiling, pre-dispatch, worst case: primary attempt + one repair at
        // max output. If even that projection breaches the tier ceiling, the
        // section is not dispatched at all (§4.6 fails closed).
        const projectedOnce = costMxn(model, { inputTokens: approxTokens(prompt), outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION });
        if (spent + 2 * projectedOnce > TIER_CEILING_MXN[args.tier]) {
          results.push({
            key, status: "failed",
            failureReason: `cost_ceiling: projected ${(2 * projectedOnce).toFixed(6)} MXN would exceed the ${args.tier} ceiling of ${TIER_CEILING_MXN[args.tier]} MXN`,
          });
          continue;
        }

        let completion;
        try {
          completion = await provider.complete({
            section: key, locale: args.locale, prompt, digest: args.digest,
            jsonSchema: schema, model, maxOutputTokens: MAX_OUTPUT_TOKENS_PER_SECTION,
          });
        } catch (error) {
          results.push({ key, status: "failed", failureReason: `provider_error: ${errorMessage(error)}` });
          continue;
        }

        let validation = validateSectionOutput(key, completion.output);
        if (!validation.ok) {
          // Exactly one repair attempt (§4.3): same request, plus the rejection.
          try {
            const repaired = await provider.complete({
              section: key, locale: args.locale,
              prompt: `${prompt}\n\nYour previous response was rejected:\n${validation.error}\n\nRespond again with a single corrected JSON object that satisfies the schema. Output JSON only.`,
              digest: args.digest, jsonSchema: schema, model, maxOutputTokens: MAX_OUTPUT_TOKENS_PER_SECTION,
            });
            const revalidated = validateSectionOutput(key, repaired.output);
            if (revalidated.ok) {
              completion = repaired;
              validation = revalidated;
            }
          } catch {
            // repair threw: the original validation failure stands
          }
        }

        if (!validation.ok) {
          results.push({ key, status: "failed", failureReason: `invalid_output: ${validation.error.split("\n")[0]}` });
          continue;
        }

        const sectionCost = costMxn(completion.model, completion.usage);
        if (spent + sectionCost > TIER_CEILING_MXN[args.tier]) {
          // Projection passed but actual spend breaches: discard, never publish
          // out-of-policy content (the words are paid for; the ceiling is not).
          results.push({ key, status: "failed", failureReason: "cost_ceiling_exceeded_after_dispatch" });
          continue;
        }
        spent += sectionCost;

        const frozen: CachedSection = {
          output: validation.value,
          model: completion.model,
          usage: completion.usage,
          costMxn: sectionCost,
          latencyMs: completion.latencyMs,
        };
        try {
          await args.cache.put(cacheKey, frozen);
        } catch {
          // freeze insert failed: keep the section, it just won't be cached
        }

        results.push({
          key, status: "generated", fromCache: false, output: validation.value,
          model: completion.model, usage: completion.usage, costMxn: sectionCost, latencyMs: completion.latencyMs,
        });
      }
    }
  } catch (error) {
    // Belt and braces: the per-section work above is individually guarded, but
    // a document must exist no matter what.
    const done = new Set(results.map(result => result.key));
    for (const key of wanted) {
      if (!done.has(key)) results.push({ key, status: "failed", failureReason: `internal_error: ${errorMessage(error)}` });
    }
  }

  return buildReadingDocument({
    readingId: args.readingId,
    documentId: args.documentId,
    locale: args.locale,
    tier: args.tier,
    digest: args.digest,
    contentVersion,
    results,
  });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
