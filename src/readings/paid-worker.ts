import { dispatchAttempt, GenerationBlocked } from "@/readings/execution";
import { assembleSectionPrompt } from "@/readings/generate";
import { MAX_OUTPUT_TOKENS_PER_SECTION, generationLocales } from "@/readings/config";
import { sectionJsonSchema, validateSectionOutput } from "@/readings/schemas";
import { PAID_HEARTBEAT_MS, PAID_RUN_MS } from "@/readings/paid-contract";
import { calculatePaidSnapshot, paidDigest } from "@/readings/paid-chart";
import { paidGenerationConfig, paidGenerationEnabled, paidModel, type PaidGenerationConfig } from "@/readings/paid-policy";
import { PaidReadingStore, paidRecoveryHalt, type PaidRun } from "@/readings/paid-store";
import { log } from "@/lib/log";
import type { Locale } from "@/lib/i18n";

export type PaidWorkerDeps = { store?: PaidReadingStore; config?: () => PaidGenerationConfig | null; enabled?: () => boolean; locales?: () => Set<Locale> };
const failureCode = (error: unknown) => error instanceof GenerationBlocked ? error.code : "paid_worker_unavailable";

/** Trusted executor, not an HTTP handler. Its lifetime is independent of a browser. */
export async function workOnePaidReading(deps: PaidWorkerDeps = {}) {
  const store = deps.store ?? new PaidReadingStore();
  const enabled = deps.enabled ?? paidGenerationEnabled;
  const getConfig = deps.config ?? paidGenerationConfig;
  await store.reapExpired();
  const config = getConfig();
  if (!enabled() || !config) return null;
  await store.announceWorker(config);
  const current = () => {
    const latest = getConfig();
    return enabled() && latest?.fingerprint === config.fingerprint && latest.contentVersion === config.contentVersion;
  };
  const run = await store.claimNext(config, current);
  if (!run) return null;
  // #224: a durable run admitted before the locale allowlist narrowed must not produce
  // prose. Admission refuses new intents; this fences runs that were already queued.
  if (!(deps.locales ?? generationLocales)().has(run.locale)) {
    log.warn("readings.locale_not_qualified", { userId: run.userId, runId: run.id });
    try { await store.fail(run, "locale_not_qualified"); }
    catch { /* the lease/account lifecycle owns recovery; nothing was dispatched */ }
    return null;
  }
  return executePaidRun(run, store, config, current);
}

/** Exported for crash-boundary tests; callers still need a durable claimed lease. */
export async function executePaidRun(run: PaidRun, store: PaidReadingStore, config: PaidGenerationConfig, current: () => boolean) {
  const controller = new AbortController();
  let stopCode = "paid_deadline";
  let heartbeat: Promise<void> | null = null;
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(PAID_RUN_MS, (run.deadline?.getTime() ?? 0) - Date.now())));
  const interval = setInterval(() => {
    if (heartbeat || controller.signal.aborted) return;
    heartbeat = (async () => {
      await store.heartbeat(run, config, current);
      await store.announceWorker(config);
    })().catch(error => { stopCode = failureCode(error); controller.abort(); }).finally(() => { heartbeat = null; });
  }, PAID_HEARTBEAT_MS);
  try {
    const preparation = await store.preparation(run, config, current);
    const snapshot = preparation.snapshot ?? await store.saveSnapshot(run, calculatePaidSnapshot(run.readingId!, preparation.input, config.editionProfile), config, current);
    const digest = paidDigest(snapshot);
    const execution = store.execution(run, config, controller.signal, current);
    for (const key of run.expectedSections) {
      if (controller.signal.aborted) throw new GenerationBlocked(stopCode);
      // Each outcome and receipt were committed together. Never redispatch a
      // slot simply because this process has no in-memory result for it.
      const outcomes = await store.outcomes(run);
      const halt = paidRecoveryHalt(outcomes);
      if (halt) throw new GenerationBlocked(halt);
      const rows = outcomes.filter(row => row.attempt.section === key);
      if (rows.some(row => row.checkpoint?.kind === "valid")) continue;
      const schema = sectionJsonSchema(key, "paid");
      const prompt = assembleSectionPrompt(key, run.locale, JSON.stringify(digest, null, 1), JSON.stringify(schema), "paid");
      const request = { section: key, locale: run.locale, prompt, digest, jsonSchema: schema, model: paidModel(config, key), maxOutputTokens: MAX_OUTPUT_TOKENS_PER_SECTION };
      const validate = (output: unknown) => validateSectionOutput(key, output, "paid");
      const primary = rows.find(row => row.attempt.phase === "primary");
      let needsRepair = primary?.checkpoint?.kind === "invalid";
      if (!primary) {
        const result = await dispatchAttempt(execution, config.provider, request, "primary", validate);
        if (result.halt) throw new GenerationBlocked(result.halt);
        needsRepair = Boolean(result.completion && !validate(result.completion.output).ok);
      }
      if (needsRepair && !rows.some(row => row.attempt.phase === "repair")) {
        const result = await dispatchAttempt(execution, config.provider, { ...request,
          prompt: `${prompt}\n\nThe previous response failed the section schema. Return a corrected JSON object satisfying the schema. No commentary outside the JSON.` }, "repair", validate);
        if (result.halt) throw new GenerationBlocked(result.halt);
      }
    }
    return await store.finish(run, config, current);
  } catch (error) {
    const code = failureCode(error);
    // A measured provider failure or subscription expiry may leave usable
    // recorded sections. Unknown/reserved work, withdrawal, stop, disablement
    // and expired leases still fail the durable publication fences.
    if (["paid_entitlement_required", "provider_error", "paid_attempt_halted", "cost_ceiling", "accounting_unavailable", "paid_uncertain_attempt"].includes(code)) {
      try { return await store.finish(run, config, current); }
      catch (finishError) { stopCode = failureCode(finishError); }
    } else stopCode = code;
    try { return await store.fail(run, stopCode); }
    catch {
      // Account deletion or an unavailable database cannot be 'fixed' by replay.
      // The queue/attempt marker remains the recovery authority, not this promise.
      log.warn("readings.paid_worker_unavailable", { userId: run.userId, runId: run.id, code: stopCode });
      return null;
    }
  } finally {
    clearTimeout(timeout); clearInterval(interval); controller.abort();
    if (heartbeat) await heartbeat;
  }
}
