import { paidContentVersion } from "../../src/readings/paid-policy";
import { paidSections, type PaidProfile } from "../../src/readings/paid-contract";
import { createFixtureProvider } from "../../src/readings/provider";
import { dispatchAttempt, type GenerationExecution, type GenerationSettings } from "../../src/readings/execution";
import { SECTION_MODEL_TIER, MAX_OUTPUT_TOKENS_PER_SECTION, DEFAULT_MODEL_PRICES } from "../../src/readings/config";
import { assembleSectionPrompt } from "../../src/readings/generate";
import { sectionJsonSchema, validateSectionOutput } from "../../src/readings/schemas";
import { canonicalHash } from "../../src/readings/policy";
import { paidEvaluationSchema, PAID_CORPUS_VERSION, PAID_EVALUATION_VERSION, type EvaluationAttempt, type EvaluationSample } from "../../src/readings/evaluation";
import { PAID_SECTION_TITLES } from "../../src/readings/copy";
import { memoryExecution } from "./reading-execution";
import { loadPaidEvaluationCorpus } from "../../scripts/lib/paid-evaluation-corpus";

/** Explicit offline fixture runner: no database, environment switches or live-provider factory.
 *  `caseIds` narrows the run to the cases a caller actually needs; the corpus facts stay complete. */
export async function syntheticPaidEvaluation(profile: PaidProfile, caseIds?: readonly string[]) {
  const corpus = loadPaidEvaluationCorpus(profile);
  const selectedCases = caseIds ? corpus.cases.filter(entry => caseIds.includes(entry.id)) : corpus.cases;
  const settings: GenerationSettings = { models: { cheap: "fixture-1", strong: "fixture-1" }, prices: DEFAULT_MODEL_PRICES };
  const configHash = canonicalHash({ purpose: "synthetic-only", settings, profile });
  const provider = createFixtureProvider(); const samples: EvaluationSample[] = [];
  for (const entry of selectedCases) for (const locale of ["en", "es"] as const) {
    const digest = corpus.facts[entry.id]; const base = memoryExecution("paid", settings); const rows = new Map<string, EvaluationAttempt>();
    const execution: GenerationExecution = { ...base,
      admit: async permit => { const id = await base.admit(permit); rows.set(id, { section: permit.section, phase: permit.phase, state: "reserved", model: permit.model, reportedModel: null,
        reservedMicros: permit.reservedMicros, costMicros: null, inputTokens: null, outputTokens: null, latencyMs: 0, code: "reserved", outcome: null }); return id; },
      settle: async (id, receipt) => { const total = await base.settle(id, receipt); const row = rows.get(id)!;
        rows.set(id, { ...row, state: receipt.basis, reportedModel: receipt.model, costMicros: receipt.costMicros, inputTokens: receipt.usage?.inputTokens ?? null, outputTokens: receipt.usage?.outputTokens ?? null, latencyMs: receipt.latencyMs, code: receipt.code, outcome: receipt.outcome?.kind ?? null }); return total; },
    };
    const sections: EvaluationSample["sections"] = [];
    for (const section of paidSections(profile)) {
      const schema = sectionJsonSchema(section, "paid");
      const result = await dispatchAttempt(execution, provider, { section, locale, digest, jsonSchema: schema,
        prompt: assembleSectionPrompt(section, locale, JSON.stringify(digest, null, 1), JSON.stringify(schema), "paid"), model: settings.models[SECTION_MODEL_TIER[section]], maxOutputTokens: MAX_OUTPUT_TOKENS_PER_SECTION },
      "primary", output => validateSectionOutput(section, output, "paid"));
      const checked = result.completion && validateSectionOutput(section, result.completion.output, "paid");
      sections.push({ key: section, title: PAID_SECTION_TITLES[section][locale], status: checked?.ok && !result.halt ? "generated" : "failed", blocks: checked?.ok ? checked.value.blocks : [],
        ...(checked?.ok && checked.value.closingQuestion ? { closingQuestion: checked.value.closingQuestion } : {}) });
      if (result.halt) break;
    }
    samples.push({ caseId: entry.id, locale, factsHash: canonicalHash(digest), sections, attempts: [...rows.values()] });
  }
  return paidEvaluationSchema.parse({ version: PAID_EVALUATION_VERSION, corpusVersion: PAID_CORPUS_VERSION, corpusHash: corpus.corpusHash,
    source: "synthetic", profile, contentVersion: paidContentVersion(configHash, profile), configHash, processor: "Synthetic fixture provider (not editorial approval)",
    models: settings.models, schemaHash: corpus.schemaHash, promptHashes: corpus.promptHashes, facts: corpus.facts, samples });
}
