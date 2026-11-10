/**
 * Generation configuration (`docs/plan-readings-engine-epic.md` §4 rules, §9b mechanics).
 *
 * Everything here is configuration, not code paths sprinkled through the app:
 * the kill switch, the model-per-section mapping, the price table and the
 * per-tier cost ceilings. The ceiling is expressed in MXN on purpose — the
 * corpus test asserts cost in currency, so a provider price change is a config
 * edit plus a test failure, not a silent margin leak.
 */

export type ModelTier = "cheap" | "strong";

export type ModelPrice = {
  /** MXN per million input tokens. */
  inputMxnPerMillion: number;
  /** MXN per million output tokens. */
  outputMxnPerMillion: number;
};

/** Cost ceilings (§9b, decided 2026-11-08): free ≤ 5 MXN, paid ≤ 10 MXN. */
export const TIER_CEILING_MXN: Record<"free" | "paid", number> = {
  free: 5,
  paid: 10,
};

/** Upper bound on output tokens per dispatch, enforced before dispatch. */
export const MAX_OUTPUT_TOKENS_PER_SECTION = 2_000;

/**
 * Default price table. The fixture provider is priced mid-tier so cost
 * accounting is exercised with non-trivial numbers; real models get real
 * prices here (or via READINGS_MODEL_PRICES as JSON) when the provider
 * decision lands (§9b).
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  "fixture-1": { inputMxnPerMillion: 15, outputMxnPerMillion: 60 },
};

export function modelPrices(): Record<string, ModelPrice> {
  const raw = process.env.READINGS_MODEL_PRICES;
  if (!raw) return DEFAULT_MODEL_PRICES;
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    return { ...DEFAULT_MODEL_PRICES, ...parsed };
  } catch {
    return DEFAULT_MODEL_PRICES;
  }
}

/** Section → model tier (§9b.1). Short formulaic sections are cheap; synthesis is strong. */
export const SECTION_MODEL_TIER: Record<string, ModelTier> = {
  overview: "cheap",
  sun: "cheap",
  moon: "cheap",
  ascendant: "cheap",
  aspects: "cheap",
  houses: "cheap",
  planets: "cheap",
  nodes: "cheap",
  planetaryYear: "cheap",
  transits: "cheap",
  guidance: "strong",
};

/** Model id per tier — configuration, not an import (the adapter owns the call). */
export function modelForTier(tier: ModelTier): string {
  if (tier === "strong") return process.env.READINGS_STRONG_MODEL ?? "fixture-1";
  return process.env.READINGS_CHEAP_MODEL ?? "fixture-1";
}

/** The global kill switch: one flag disables generation, chart-only remains. */
export function generationEnabled(): boolean {
  return process.env.READINGS_GENERATION_ENABLED === "true";
}

/** Provider selection. Unset or unknown ⇒ generation cannot run (fails soft). */
export function providerName(): string | null {
  return process.env.READINGS_PROVIDER ?? null;
}

export function costMxn(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const price = modelPrices()[model];
  if (!price) return 0;
  return (
    (usage.inputTokens / 1_000_000) * price.inputMxnPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputMxnPerMillion
  );
}
