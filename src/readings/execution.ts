import type { Completion, CompletionRequest, PreparedCompletion, ReadingProvider, ProviderUsage } from "@/readings/provider";
import { approxTokens, validUsage } from "@/readings/provider";
import { modelPrices, modelForTier, type ModelPrice, type ModelTier } from "@/readings/config";
import type { SectionKey } from "@/readings/types";

export type GenerationSettings = {
  models: Record<ModelTier, string>;
  prices: Record<string, ModelPrice> | null;
};

/** One immutable price/model snapshot, never an environment re-read after dispatch. */
export function generationSettings(): GenerationSettings {
  return structuredClone({ models: { cheap: modelForTier("cheap"), strong: modelForTier("strong") }, prices: modelPrices() });
}

/** Rates are MXN / million tokens, so tokens × rate is integer micro-MXN. Round UP. */
export function costMicros(prices: GenerationSettings["prices"], model: string, usage: ProviderUsage): number | null {
  const price = prices && Object.hasOwn(prices, model) ? prices[model] : null;
  if (!price || !validUsage(usage)) return null;
  const value = Math.ceil(usage.inputTokens * price.inputMxnPerMillion + usage.outputTokens * price.outputMxnPerMillion);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class GenerationBlocked extends Error {
  constructor(readonly code: string) { super(code); this.name = "GenerationBlocked"; }
}

export type AttemptAdmission = {
  section: SectionKey;
  phase: "primary" | "repair";
  model: string;
  reservedMicros: number;
};
export type AttemptSettlement = {
  basis: "measured" | "unknown" | "not_dispatched";
  costMicros: number;
  model: string | null;
  usage: ProviderUsage | null;
  latencyMs: number;
  code: string;
};

/**
 * REQUIRED capability. Production implements this with the durable run store;
 * tests explicitly supply a simulated ledger. There is no no-op/default context.
 */
export interface GenerationExecution {
  readonly kind: "durable" | "simulation";
  readonly settings: GenerationSettings;
  readonly ceilingMicros: number;
  readonly signal?: AbortSignal;
  admitsModel(requested: string, reported: string): boolean;
  admit(attempt: AttemptAdmission): Promise<string>;
  assertPermit(id: string): Promise<void>;
  /** Returns the cumulative exposure AFTER idempotent settlement. */
  settle(id: string, result: AttemptSettlement): Promise<number>;
}

export type AttemptResult = {
  completion?: Completion;
  measuredMicros: number;
  uncertainMicros: number;
  failure?: string;
  halt?: string;
  ledgerFailed?: boolean;
};

const blockedCode = (error: unknown) => error instanceof GenerationBlocked ? error.code : "generation_unavailable";

/** One boundary for primary AND repair: prepare → commit permit → send → settle. */
export async function dispatchAttempt(
  execution: GenerationExecution,
  provider: ReadingProvider,
  request: CompletionRequest,
  phase: AttemptAdmission["phase"],
): Promise<AttemptResult> {
  const empty = { measuredMicros: 0, uncertainMicros: 0 };
  let prepared: PreparedCompletion;
  let quote: number;
  let id: string;
  try {
    execution.signal?.throwIfAborted();
    if (provider.prepare) prepared = provider.prepare(request);
    else {
      if (execution.kind !== "simulation") throw new GenerationBlocked("metering_unavailable");
      // This is the fixture/simulated-provider contract, NOT a live token bound.
      prepared = {
        upperUsage: { inputTokens: approxTokens(request.prompt), outputTokens: request.maxOutputTokens },
        send: signal => provider.complete(request, signal),
      };
    }
    const priced = costMicros(execution.settings.prices, request.model, prepared.upperUsage);
    if (priced === null) throw new GenerationBlocked("pricing_unavailable");
    quote = priced;
    id = await execution.admit({ section: request.section, phase, model: request.model, reservedMicros: quote });
  } catch (error) {
    const code = blockedCode(error);
    return { ...empty, failure: code, halt: code };
  }

  let completion: Completion | undefined;
  let settlement: AttemptSettlement;
  const started = Date.now();
  try {
    // Positive local proof that send was never invoked. A committed permit still
    // consumes the offer, but its monetary reservation can be released honestly.
    await execution.assertPermit(id);
    execution.signal?.throwIfAborted();
  } catch {
    settlement = { basis: "not_dispatched", costMicros: 0, model: null, usage: null, latencyMs: 0, code: "generation_cancelled" };
    try { await execution.settle(id, settlement); }
    catch { return { ...empty, failure: "accounting_unavailable", halt: "accounting_unavailable", ledgerFailed: true }; }
    return { ...empty, failure: settlement.code, halt: settlement.code };
  }

  try {
    completion = await prepared.send(execution.signal);
    const measured = validUsage(completion.usage)
      ? costMicros(execution.settings.prices, completion.model, completion.usage) : null;
    const code = !validUsage(completion.usage) ? "usage_invalid"
      : measured === null || !execution.admitsModel(request.model, completion.model) ? "pricing_unavailable"
        : "measured";
    settlement = code === "measured"
      ? { basis: "measured", costMicros: measured!, model: completion.model, usage: completion.usage, latencyMs: Date.now() - started, code }
      : { basis: "unknown", costMicros: quote, model: null, usage: null, latencyMs: Date.now() - started, code };
  } catch {
    // The adapter might have incurred a charge. Neither a thrown error, HTTP
    // status, timeout nor abort proves zero billing. #129: stop, never continue free.
    settlement = { basis: "unknown", costMicros: quote, model: null, usage: null, latencyMs: Date.now() - started, code: "provider_error" };
  }

  const amounts = {
    measuredMicros: settlement.basis === "measured" ? settlement.costMicros : 0,
    uncertainMicros: settlement.basis === "unknown" ? settlement.costMicros : 0,
  };
  let exposure: number;
  try { exposure = await execution.settle(id, settlement); }
  catch {
    // The precommitted reservation survives even if recording the receipt fails.
    // Do not publish a partial document claiming its ledger is complete.
    return { ...amounts, failure: "accounting_unavailable", halt: "accounting_unavailable", ledgerFailed: true };
  }
  if (settlement.basis === "unknown") return { ...amounts, failure: settlement.code, halt: settlement.code };
  if (exposure > execution.ceilingMicros) {
    return { ...amounts, failure: "cost_ceiling_exceeded_after_dispatch", halt: "cost_ceiling_exceeded_after_dispatch" };
  }
  if (provider.prepare && completion && (completion.usage.inputTokens > prepared.upperUsage.inputTokens || completion.usage.outputTokens > prepared.upperUsage.outputTokens)) {
    // Retain the actual receipt; never clamp it to make the reservation look correct.
    return { ...amounts, failure: "usage_bound_exceeded", halt: "usage_bound_exceeded" };
  }
  return { ...amounts, completion };
}
