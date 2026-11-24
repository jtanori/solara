import { randomUUID } from "node:crypto";
import { GenerationStore, type GenerationView } from "@/readings/generation-store";
import { generationEnabled, generationLocales } from "@/readings/config";
import { GenerationBlocked } from "@/readings/execution";
import { GENERATION_DISPATCH_MS, hash, liveGenerationConfig, type LiveGenerationConfig } from "@/readings/policy";
import { computeContentVersion } from "@/readings/content-version";
import { generateReadingDocument, MemorySectionCache } from "@/readings/generate";
import { calculateSolarReturnChart } from "@/lib/solar";
import { chartDigest } from "@/lib/chart";
import { log } from "@/lib/log";
import type { Locale } from "@/lib/i18n";

export type GenerationServiceDeps = {
  store?: GenerationStore;
  config?: () => LiveGenerationConfig | null;
  enabled?: () => boolean;
  locales?: () => Set<Locale>;
};

/** The only production entry point for provider work. No paid tier/client digest input. */
export async function generateFreeReading(
  userId: string, readingId: string, locale: Locale, requestSignal?: AbortSignal, deps: GenerationServiceDeps = {},
): Promise<GenerationView> {
  const store = deps.store ?? new GenerationStore();
  const enabled = deps.enabled ?? generationEnabled;
  const getConfig = deps.config ?? liveGenerationConfig;
  // This is a read/no-op for an existing result even after withdrawal/disablement.
  const existing = await store.status(userId, readingId);
  if (existing.status !== "unused" || (existing.readingId && existing.readingId !== readingId)) return existing;
  if (!enabled()) throw new GenerationBlocked("generation_disabled");
  const config = getConfig();
  if (!config) throw new GenerationBlocked("generation_unavailable");
  // #224: unqualified locales fail closed BEFORE a permit is claimed, so the lifetime offer
  // survives a refused request. The distinction stays in the log; the client copy is generic.
  if (!(deps.locales ?? generationLocales)().has(locale)) {
    log.warn("readings.locale_not_qualified", { userId, readingId });
    throw new GenerationBlocked("generation_unavailable");
  }
  if (requestSignal?.aborted) throw new GenerationBlocked("generation_cancelled");
  const contentVersion = hash({ sources: computeContentVersion(), config: config.fingerprint }).slice(0, 16);
  const claimed = await store.claim(userId, readingId, locale, config, contentVersion);
  if (claimed.kind === "existing") return claimed.view;
  const { run } = claimed;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, GENERATION_DISPATCH_MS);
  requestSignal?.addEventListener("abort", cancel, { once: true });
  if (requestSignal?.aborted) controller.abort();
  const current = () => enabled() && getConfig()?.fingerprint === config.fingerprint;
  let document: Awaited<ReturnType<typeof generateReadingDocument>> | null = null;
  let outcome: GenerationView;
  try {
    const execution = store.execution(run, config, controller.signal, current);
    document = await generateReadingDocument({
      readingId: run.readingId!, documentId: randomUUID(), locale: run.locale, tier: "free",
      digest: chartDigest(calculateSolarReturnChart(claimed.input).facts),
      // Deliberately NOT DbSectionCache: shared rows lack deletion provenance.
      cache: new MemorySectionCache(), provider: config.provider, execution, contentVersion,
    });
    outcome = await store.finish(run, document, () => current() && !controller.signal.aborted);
  } catch {
    log.error("readings.run_failed", { userId, runId: run.id });
    // Attempt reservations survive. Never start a new run or retry HTTP here.
    try { outcome = await store.finish(run, null, () => false); }
    catch { throw new GenerationBlocked("generation_indeterminate"); }
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", cancel);
    controller.abort();
  }
  // Releasing a wholly pre-permit claim is not a successful generation. Throw
  // outside the catch so the fallback finalizer cannot swallow this HTTP error.
  if (outcome.status === "unused") {
    throw new GenerationBlocked(document?.accounting?.halt ?? document?.sections.find(section => section.failureReason)?.failureReason ?? "generation_unavailable");
  }
  return outcome;
}
