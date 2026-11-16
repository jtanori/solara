import { randomUUID } from "node:crypto";
import { GenerationBlocked, generationSettings, type AttemptAdmission, type AttemptSettlement, type GenerationExecution } from "../../src/readings/execution";
import { TIER_CEILING_MXN } from "../../src/readings/config";
import type { SectionTier } from "../../src/readings/types";

/** Explicit test-only simulated ledger. Never imported by application code. */
export function memoryExecution(tier: SectionTier = "free"): GenerationExecution {
  const settings = generationSettings();
  const attempts = new Map<string, { permit: AttemptAdmission; outcome?: AttemptSettlement }>();
  const exposure = () => [...attempts.values()].reduce((sum, row) => sum + (row.outcome?.costMicros ?? row.permit.reservedMicros), 0);
  const ceilingMicros = TIER_CEILING_MXN[tier] * 1_000_000;
  return {
    kind: "simulation", settings, ceilingMicros,
    admitsModel: (_requested, reported) => Boolean(settings.prices && Object.hasOwn(settings.prices, reported)),
    async admit(permit) {
      if (exposure() + permit.reservedMicros > ceilingMicros) throw new GenerationBlocked("cost_ceiling");
      if ([...attempts.values()].some(row => row.permit.section === permit.section && row.permit.phase === permit.phase)) throw new GenerationBlocked("attempt_already_admitted");
      const id = randomUUID(); attempts.set(id, { permit }); return id;
    },
    async assertPermit(id) { if (!attempts.has(id)) throw new GenerationBlocked("permit_missing"); },
    async settle(id, outcome) {
      const row = attempts.get(id);
      if (!row) throw new GenerationBlocked("permit_missing");
      row.outcome ??= outcome;
      return exposure();
    },
  };
}
