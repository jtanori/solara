import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChartDigest } from "@/lib/chart";
import { localeName, type Locale } from "@/lib/i18n";
import { log } from "@/lib/log";
import {
  costMxn,
  generationEnabled,
  MAX_OUTPUT_TOKENS_PER_SECTION,
  modelForTier,
  priceFor,
  providerName,
  TIER_CEILING_MXN,
} from "@/readings/config";
import { availableSections, sectionDefinition, sectionsForTier } from "@/readings/registry";
import { computeContentVersion } from "@/readings/content-version";
import { approxTokens, PROVIDERS, validUsage, type ProviderUsage, type ReadingProvider } from "@/readings/provider";
import { sectionJsonSchema, validateSectionOutput, type SectionOutput } from "@/readings/schemas";
import { buildReadingDocument, type SectionResult } from "@/readings/document";
import type { ReadingDocument, SectionKey, SectionTier } from "@/readings/types";

/**
 * The generation pipeline (`docs/plan-readings-engine-epic.md` §4).
 *
 * Order of operations per section, invariants in comments:
 *   pricing    → the model must be priceable BEFORE anything is dispatched
 *                (unpriced ⇒ fail closed, never a silent 0 MXN)
 *   cache hit  → reuse the frozen row (regeneration is explicit, §4.5)
 *   ceiling    → projected worst-case spend checked BEFORE dispatch (§4.6, fails closed)
 *   dispatch   → provider adapter; model chosen by configuration (§4.4)
 *   account    → EVERY attempt's cost is added to the run's spend the moment it
 *                reports usage — primary, repair, rescued or wasted alike
 *   validate   → strict schema; ONE repair attempt (ceiling re-checked against
 *                the actual, longer repair prompt); then status "failed"
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

/**
 * Marks a failed section whose spend could not be measured from the provider's
 * own report, because the report was untrustworthy (non-finite, negative, or
 * an unpriced model). Such a section's cost is a *worst-case estimate*, not a
 * receipt: `maxOutputTokens × price + prompt estimate`. It exists so that a
 * provider which never reports usage honestly cannot dispatch the whole tier
 * for free by keeping the ledger at 0/0 (#129).
 */
export type EstimatedCostResult = { failureReason: string; estimatedCostMxn: number };

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

/**
 * Resolve the configured provider. Total by contract: a misconfigured adapter
 * (a real vendor selected without its key) must degrade to the documented
 * `provider_unavailable` fallback, not throw out of `generateReadingDocument`.
 * Before this guard existed, an unconfigured real adapter threw here, the
 * per-section try/catch turned it into `internal_error` for every section, and
 * the only signal was one log line.
 */
function resolveProvider(): ReadingProvider | null {
  const name = providerName();
  const factory = name ? PROVIDERS[name] : undefined;
  if (!factory) return null;
  try {
    return factory();
  } catch (error) {
    log.error("readings.provider_unconfigured", { provider: name, error });
    return null;
  }
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
  } catch (error) {
    // No prompts ⇒ no version ⇒ nothing cacheable or generatable. Fails closed.
    log.warn("readings.content_version_unavailable", { error });
  }

  try {
    if (contentVersion === "unavailable") {
      for (const key of wanted) results.push({ key, status: "failed", failureReason: "content_version_unavailable" });
    } else {
      const digestHash = digestHashOf(args.digest);
      const enabled = generationEnabled();
      const provider = args.provider ?? resolveProvider();
      let spent = 0; // MXN spent by THIS run, every attempt counted as it reports
      /**
       * Set when an attempt reports usage that cannot be measured. The ledger is
       * then no longer trustworthy for this run: no further section is
       * dispatched, the remainder fails with a run-level reason, and the
       * estimate already booked keeps the ceiling honest (#129).
       */
      let runHalted: string | null = null;

      for (const key of wanted) {
        if (!enabled) {
          results.push({ key, status: "failed", failureReason: "generation_disabled" });
          continue;
        }

        // The run stopped being measurable: fail the rest without spending.
        // Placed before the cache read so a halt cannot be masked by cache hits
        // appearing to succeed while the ledger is untrustworthy.
        if (runHalted) {
          results.push({ key, status: "failed", failureReason: `generation_halted: ${runHalted}` });
          continue;
        }

        const cacheKey: SectionCacheKey = { digestHash, section: key, locale: args.locale, contentVersion };

        let cached: CachedSection | null = null;
        try {
          cached = await args.cache.get(cacheKey);
        } catch (error) {
          log.warn("readings.cache_read_failed", { section: key, locale: args.locale, error });
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

        // Pricing first, always: an unpriceable model is never dispatched.
        if (!priceFor(model)) {
          results.push({
            key, status: "failed",
            failureReason: `pricing_unavailable: model "${model}" has no price entry${process.env.READINGS_MODEL_PRICES ? " (READINGS_MODEL_PRICES is set — it must be valid JSON with numeric MXN-per-million prices and cover every dispatched model)" : ""}`,
          });
          continue;
        }

        let schema: Record<string, unknown>;
        let prompt: string;
        try {
          schema = sectionJsonSchema(key);
          prompt = assemblePrompt(key, args.locale, JSON.stringify(args.digest, null, 1), JSON.stringify(schema));
        } catch (error) {
          // One unreadable prompt file must not abort the remaining sections.
          results.push({ key, status: "failed", failureReason: `prompt_unavailable: ${errorMessage(error)}` });
          continue;
        }

        // Ceiling, pre-dispatch, worst case: primary attempt + one repair at
        // max output. If even that projection breaches the tier ceiling, the
        // section is not dispatched at all (§4.6 fails closed).
        const projectedOnce = costMxn(model, { inputTokens: approxTokens(prompt), outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION });
        if (spent + 2 * projectedOnce! > TIER_CEILING_MXN[args.tier]) {
          results.push({
            key, status: "failed",
            failureReason: `cost_ceiling: projected ${(2 * projectedOnce!).toFixed(6)} MXN would exceed the ${args.tier} ceiling of ${TIER_CEILING_MXN[args.tier]} MXN`,
          });
          continue;
        }

        // Attempt accounting: every completion's usage/cost/latency is counted
        // here, whether it ends up published, rescued by a repair, or wasted.
        const sectionUsage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
        let sectionLatency = 0;
        let sectionCost = 0;
        /**
         * Spend the provider's report could not establish. Kept separately from
         * `sectionCost` so an *estimated* number is never presented as a receipt.
         */
        let sectionEstimatedCost = 0;
        /**
         * Why an unmeasurable report halts the run rather than being ignored:
         * the provider's usage is the only pricing input, so a provider that
         * always misreports would otherwise dispatch the whole tier for free.
         *
         * Two *post-dispatch* cases are unmeasurable and must both halt:
         *   - invalid usage (non-finite/negative token counts)
         *   - a provider-reported model that has no price entry
         * The second is NOT the same as the pre-dispatch `pricing_unavailable`
         * case above. That one prices the model we *configured*, is identical
         * for every section, and is deterministically fixable by editing the
         * price table — it keeps the whole-table fail-closed behaviour. This one
         * is discovered only after a paid call, is the provider's own answer,
         * and would otherwise let an unpriced response dispatch the remaining
         * sections while the ledger recorded zero (#129).
         */
        /**
         * Worst-case price of one attempt: the whole output budget plus the
         * prompt we actually assembled. Conservative on purpose — an estimate
         * that can under-report is the bug being fixed.
         */
        const worstCaseCost = (promptText: string): number => {
          const estimate = costMxn(model, {
            inputTokens: approxTokens(promptText),
            outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION,
          });
          // priceFor(model) was checked above, so this is non-null; guard anyway.
          if (estimate === null) throw new Error(`unpriceable model ${model}`);
          return estimate;
        };
        const account = (completion: { model: string; usage: ProviderUsage; latencyMs: number }, promptText: string): string | null => {
          // Provider-reported usage is untrusted: NaN would poison every later
          // ceiling comparison into false, negatives would offset spend.
          if (!validUsage(completion.usage)) {
            if (!runHalted) runHalted = `usage_invalid: provider reported non-finite or negative token counts (${JSON.stringify(completion.usage)})`;
            sectionEstimatedCost += worstCaseCost(promptText);
            return `usage_invalid: provider reported non-finite or negative token counts (${JSON.stringify(completion.usage)})`;
          }
          const cost = costMxn(completion.model, completion.usage);
          if (cost === null) {
            // An unpriced model in the response is unmeasurable spend, not a free
            // call: book a worst-case estimate and stop the run. Halting is what
            // makes the missing price entry cost one call instead of the tier.
            const reason = `pricing_unavailable: provider reported unpriced model "${completion.model}"`;
            if (!runHalted) runHalted = reason;
            sectionEstimatedCost += worstCaseCost(promptText);
            return reason;
          }
          spent += cost;
          sectionCost += cost;
          sectionUsage.inputTokens += completion.usage.inputTokens;
          sectionUsage.outputTokens += completion.usage.outputTokens;
          sectionLatency += completion.latencyMs;
          return null;
        };

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

        /** Failure-path total: measured spend plus any worst-case estimate. */
        const failedSectionCost = (): number => {
          const total = sectionCost + sectionEstimatedCost;
          sectionEstimatedCost = 0;
          return total;
        };

        const primaryPricingFailure = account(completion, prompt);
        if (primaryPricingFailure) {
          // The provider answered with a model we cannot price: discard, fail closed.
          // An unmeasurable report is booked at worst case so the ledger and the
          // ceiling both see it (#129).
          results.push({ key, status: "failed", failureReason: primaryPricingFailure, costMxn: failedSectionCost() });
          continue;
        }

        let validation = validateSectionOutput(key, completion.output);
        if (!validation.ok) {
          // Exactly one repair attempt (§4.3): same request, plus the rejection.
          // The repair prompt is longer — re-check the ceiling against its
          // actual size plus everything already spent.
          const repairPrompt = `${prompt}\n\nYour previous response was rejected:\n${validation.error}\n\nRespond again with a single corrected JSON object that satisfies the schema. Output JSON only.`;
          const projectedRepair = costMxn(model, { inputTokens: approxTokens(repairPrompt), outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION })!;
          if (spent + projectedRepair > TIER_CEILING_MXN[args.tier]) {
            results.push({
              key, status: "failed",
              failureReason: `cost_ceiling: repair projected ${projectedRepair.toFixed(6)} MXN would exceed the ${args.tier} ceiling of ${TIER_CEILING_MXN[args.tier]} MXN`,
              costMxn: sectionCost,
            });
            continue;
          }
          try {
            const repaired = await provider.complete({
              section: key, locale: args.locale, prompt: repairPrompt,
              digest: args.digest, jsonSchema: schema, model, maxOutputTokens: MAX_OUTPUT_TOKENS_PER_SECTION,
            });
            const repairPricingFailure = account(repaired, repairPrompt);
            if (repairPricingFailure) {
              // Cannot price or trust the repair's usage: do not use its output.
              log.warn("readings.repair_rejected", { section: key, model: repaired.model, reason: repairPricingFailure });
            } else {
              const revalidated = validateSectionOutput(key, repaired.output);
              if (revalidated.ok) {
                completion = repaired;
                validation = revalidated;
              }
            }
          } catch (error) {
            log.warn("readings.repair_failed", { section: key, error });
            // repair threw: the original validation failure stands
          }
        }

        if (!validation.ok) {
          results.push({
            key, status: "failed",
            failureReason: `invalid_output: ${validation.error.split("\n")[0]}`,
            costMxn: failedSectionCost(),
          });
          continue;
        }

        // Post-dispatch: the run's actual spend (this section's attempts
        // included) must respect the ceiling. A provider that under-reports
        // its own usage until the receipt arrives lands here, discarded.
        if (spent > TIER_CEILING_MXN[args.tier]) {
          results.push({ key, status: "failed", failureReason: "cost_ceiling_exceeded_after_dispatch", costMxn: sectionCost });
          continue;
        }

        const frozen: CachedSection = {
          output: validation.value,
          model: completion.model,
          usage: sectionUsage,
          costMxn: sectionCost,
          latencyMs: sectionLatency,
        };
        try {
          await args.cache.put(cacheKey, frozen);
        } catch (error) {
          log.warn("readings.cache_write_failed", { section: key, locale: args.locale, error });
          // freeze insert failed: keep the section, it just won't be cached
        }

        results.push({
          key, status: "generated", fromCache: false, output: validation.value,
          model: completion.model, usage: sectionUsage, costMxn: sectionCost, latencyMs: sectionLatency,
        });
      }
    }
  } catch (error) {
    // Belt and braces: the per-section work above is individually guarded, but
    // a document must exist no matter what.
    log.error("readings.generation_internal_error", { error });
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
