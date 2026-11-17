import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChartDigest } from "@/lib/chart";
import { localeName, type Locale } from "@/lib/i18n";
import { log } from "@/lib/log";
import { generationEnabled, MAX_OUTPUT_TOKENS_PER_SECTION, providerName } from "@/readings/config";
import { availableSections, sectionDefinition, sectionsForTier } from "@/readings/registry";
import { computeContentVersion } from "@/readings/content-version";
import { PROVIDERS, type ReadingProvider } from "@/readings/provider";
import { costMicros, dispatchAttempt, type GenerationExecution, type AttemptResult } from "@/readings/execution";
import { outboundDigest } from "@/readings/outbound-digest";
import { sectionJsonSchema, validateSectionOutput, type SectionOutput } from "@/readings/schemas";
import { buildReadingDocument, type SectionResult } from "@/readings/document";
import type { ProviderUsage } from "@/readings/provider";
import type { ReadingDocument, SectionKey, SectionTier } from "@/readings/types";

/** Sections are pure orchestration; every primary/repair goes through execution.ts.
 * Missing usage/transport exceptions halt BOTH tiers and retain exposure (#129).
 * The production service supplies a durable context; there is no default bypass.
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

/** Insert-only section store. The live service uses per-run memory only; legacy DB cache is not wired to it. */
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
  } catch {
    log.error("readings.provider_unconfigured", { provider: name });
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
  provider?: ReadingProvider;
  execution: GenerationExecution;
  contentVersion?: string;
};

export async function generateReadingDocument(args: GenerateDocumentArgs): Promise<ReadingDocument> {
  const results: SectionResult[] = [];
  const wanted = sectionsForTier(args.tier).filter(key => availableSections(args.digest).includes(key));
  let contentVersion = "unavailable";
  let halt: string | undefined;
  let measuredMicros = 0;
  let uncertainMicros = 0;
  let settled = true;
  try { contentVersion = args.contentVersion ?? computeContentVersion(); }
  catch { log.warn("readings.content_version_unavailable"); }

  try {
    const execution = args.execution;
    const provider = args.provider ?? resolveProvider();
    let safeDigest: ChartDigest | undefined;
    try { safeDigest = outboundDigest(args.digest); } catch { /* classified below, never log the rejected data */ }
    for (const key of wanted) {
      const fail = (failureReason: string, costMxn = 0) => results.push({ key, status: "failed", failureReason, costMxn });
      if (!generationEnabled()) { fail("generation_disabled"); continue; }
      if (!execution) { fail("generation_unauthorized"); continue; }
      if (contentVersion === "unavailable") { fail("content_version_unavailable"); continue; }
      if (!safeDigest) { fail("digest_invalid"); continue; }
      const model = execution.settings.models[sectionDefinition(key).modelTier];
      if (costMicros(execution.settings.prices, model, { inputTokens: 0, outputTokens: 0 }) === null) { fail("pricing_unavailable"); continue; }
      if (halt) { fail(`generation_halted: ${halt}`); continue; }
      const cacheKey: SectionCacheKey = { digestHash: digestHashOf(args.digest), section: key, locale: args.locale, contentVersion };
      let cached: CachedSection | null = null;
      try { cached = await args.cache.get(cacheKey); }
      catch { log.warn("readings.cache_read_failed", { section: key }); }
      if (cached && validateSectionOutput(key, cached.output).ok) {
        results.push({ key, status: "generated", fromCache: true, ...cached, costMxn: 0 });
        continue;
      }
      if (!provider) { fail("provider_unavailable"); continue; }
      const schema = sectionJsonSchema(key);
      let prompt: string;
      try { prompt = assemblePrompt(key, args.locale, JSON.stringify(safeDigest, null, 1), JSON.stringify(schema)); }
      catch { fail("prompt_unavailable"); continue; }
      const request = { section: key, locale: args.locale, prompt, digest: safeDigest, jsonSchema: schema, model, maxOutputTokens: MAX_OUTPUT_TOKENS_PER_SECTION };
      let sectionMicros = 0;
      let latencyMs = 0;
      const usage: ProviderUsage = { inputTokens: 0, outputTokens: 0 };
      const account = (attempt: AttemptResult) => {
        sectionMicros += attempt.measuredMicros + attempt.uncertainMicros;
        measuredMicros += attempt.measuredMicros;
        uncertainMicros += attempt.uncertainMicros;
        if (attempt.halt) halt = attempt.halt;
        if (attempt.ledgerFailed) settled = false;
        if (attempt.completion) {
          usage.inputTokens += attempt.completion.usage.inputTokens;
          usage.outputTokens += attempt.completion.usage.outputTokens;
          latencyMs += attempt.completion.latencyMs;
        }
      };
      const primary = await dispatchAttempt(execution, provider, request, "primary");
      account(primary);
      if (!primary.completion) { fail(primary.failure ?? "provider_error", sectionMicros / 1_000_000); continue; }
      let completion = primary.completion;
      let validation = validateSectionOutput(key, completion.output);
      if (!validation.ok) {
        const originalFailure = `invalid_output: ${validation.error.split("\n")[0]}`;
        const repairPrompt = `${prompt}\n\nYour previous response was rejected:\n${validation.error}\n\nRespond again with a single corrected JSON object that satisfies the schema. Output JSON only.`;
        const repaired = await dispatchAttempt(execution, provider, { ...request, prompt: repairPrompt }, "repair");
        account(repaired);
        // #128: an unusable repair NEVER rescues output and NEVER replaces the
        // primary invalid_output reason; both attempts' exposure remains counted.
        if (repaired.completion) {
          const revalidated = validateSectionOutput(key, repaired.completion.output);
          if (revalidated.ok) { validation = revalidated; completion = repaired.completion; }
        }
        if (!validation.ok) {
          fail(repaired.failure === "cost_ceiling" ? "cost_ceiling: repair not admitted" : originalFailure, sectionMicros / 1_000_000);
          continue;
        }
      }
      const frozen: CachedSection = { output: validation.value, model: completion.model, usage, costMxn: sectionMicros / 1_000_000, latencyMs };
      try { await args.cache.put(cacheKey, frozen); }
      catch { log.warn("readings.cache_write_failed", { section: key }); }
      results.push({ key, status: "generated", fromCache: false, ...frozen });
    }
  } catch {
    settled = false;
    halt = "generation_internal_error";
    log.error("readings.generation_internal_error");
    for (const key of wanted) if (!results.some(result => result.key === key)) results.push({ key, status: "failed", failureReason: halt });
  }
  return {
    ...buildReadingDocument({ readingId: args.readingId, documentId: args.documentId, locale: args.locale, tier: args.tier, digest: args.digest, contentVersion, results }),
    accounting: { measuredMxn: measuredMicros / 1_000_000, uncertainMxn: uncertainMicros / 1_000_000, settled, halt: halt ?? null },
  };
}
