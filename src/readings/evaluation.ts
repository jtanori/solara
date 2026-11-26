import { z } from "zod";
import type { ChartDigest } from "@/lib/chart";
import type { Locale } from "@/lib/i18n";
import { paidSections, PAID_PROFILES, PAID_CEILING_MICROS, type PaidProfile } from "@/readings/paid-contract";
import { canonicalHash } from "@/readings/policy";
import { outboundDigest } from "@/readings/outbound-digest";
import { readingBlockSchema, validateSectionOutput } from "@/readings/schemas";
import { SECTION_KEYS } from "@/readings/types";
import { blockText } from "@/readings/presentation";
import { MAX_OUTPUT_TOKENS_PER_SECTION, SECTION_MODEL_TIER } from "@/readings/config";
import { costMicros, validateAttemptSettlement, type GenerationSettings } from "@/readings/execution";

export const PAID_CORPUS_VERSION = "paid-corpus/1";
// v2 binds the locale-independent json-utf16-v1 hashes. Old report signatures
// are not silently reinterpreted as new editorial approval.
export const PAID_EVALUATION_VERSION = "paid-evaluation/2";
export const PAID_EDITORIAL_REVIEW_VERSION = "paid-editorial-review/2";
export const PAID_EDITORIAL_MINIMUM = 6;
export const EDITORIAL_CRITERIA = ["specificity", "factualAgreement", "crossSectionConsistency", "language", "completeness", "noUpsell", "honestLimitations"] as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const model = z.string().regex(/^[a-zA-Z0-9._:/-]{1,128}$/);
export const evaluationAttemptSchema = z.strictObject({ section: z.enum(SECTION_KEYS), phase: z.enum(["primary", "repair"]),
  state: z.enum(["reserved", "unknown", "measured", "not_dispatched"]), model, reportedModel: model.nullable(), reservedMicros: bounded, costMicros: bounded.nullable(),
  inputTokens: bounded.nullable(), outputTokens: bounded.nullable(), latencyMs: bounded,
  code: z.string().regex(/^[a-z0-9_-]{1,100}$/), outcome: z.enum(["valid", "invalid"]).nullable() });
const evaluationSectionSchema = z.strictObject({ key: z.enum(SECTION_KEYS), title: z.string().min(1).max(200),
  status: z.enum(["generated", "failed"]), blocks: z.array(readingBlockSchema).max(30), closingQuestion: z.string().max(500).optional() });
const sampleSchema = z.strictObject({ caseId: z.string().regex(/^[a-z0-9-]{1,80}$/), locale: z.enum(["en", "es"]), factsHash: hash,
  sections: z.array(evaluationSectionSchema).max(11), attempts: z.array(evaluationAttemptSchema).max(22) });
export const paidEvaluationSchema = z.strictObject({ version: z.literal(PAID_EVALUATION_VERSION), corpusVersion: z.literal(PAID_CORPUS_VERSION), corpusHash: hash,
  source: z.enum(["synthetic", "provider"]), profile: z.enum(PAID_PROFILES), contentVersion: z.string().min(1).max(128), configHash: hash,
  processor: z.string().min(1).max(100), models: z.strictObject({ cheap: model, strong: model }),
  schemaHash: hash, promptHashes: z.record(z.string().max(80), hash),
  facts: z.record(z.string().regex(/^[a-z0-9-]{1,80}$/), z.unknown().transform(value => outboundDigest(value as ChartDigest))),
  samples: z.array(sampleSchema).min(1).max(48) });
export type EvaluationAttempt = z.infer<typeof evaluationAttemptSchema>;
export type EvaluationSample = z.infer<typeof sampleSchema>;
export type PaidEvaluationReport = z.infer<typeof paidEvaluationSchema>;
export type EvaluationFacts = Record<string, ChartDigest>;
export type EditorialReview = z.infer<typeof editorialReviewSchema>;
const criterionScores = z.strictObject({ specificity: z.literal(2), factualAgreement: z.literal(2), crossSectionConsistency: z.literal(2), language: z.literal(2),
  completeness: z.literal(2), noUpsell: z.literal(2), honestLimitations: z.literal(2) });
export const editorialReviewSchema = z.strictObject({ version: z.literal(PAID_EDITORIAL_REVIEW_VERSION), locale: z.enum(["en", "es"]), reportHash: hash,
  reviewer: z.string().trim().min(1).max(200), evidence: z.string().trim().min(1).max(1800), attestation: z.literal("I reviewed the complete provider-generated reports against the frozen facts and bilingual rubric"),
  samples: z.array(z.strictObject({ caseId: z.string().max(80), sampleHash: hash, scores: criterionScores, notes: z.string().trim().min(1).max(2000) })).min(PAID_EDITORIAL_MINIMUM).max(24) });

export function evaluationHash(report: PaidEvaluationReport) { return canonicalHash(paidEvaluationSchema.parse(report)); }
export function evaluationSampleHash(sample: EvaluationSample) { return canonicalHash(sampleSchema.parse(sample)); }

/** Mechanical failures are blockers, not substitutes for astrological/editorial judgment. */
export function evaluationSampleChecks(sample: EvaluationSample, profile: PaidProfile, facts: ChartDigest, models: PaidEvaluationReport["models"]): string[] {
  const issues = new Set<string>(); const expected = paidSections(profile);
  if (sample.factsHash !== canonicalHash(outboundDigest(facts))) issues.add("facts_changed");
  if (JSON.stringify(sample.sections.map(section => section.key)) !== JSON.stringify(expected)) issues.add("manifest_mismatch");
  for (const section of sample.sections) {
    if (section.status !== "generated") issues.add("incomplete_report");
    if (!validateSectionOutput(section.key, { blocks: section.blocks, ...(section.closingQuestion !== undefined ? { closingQuestion: section.closingQuestion } : {}) }, "paid").ok) issues.add("invalid_section_schema");
    const text = [...section.blocks.flatMap(blockText), section.closingQuestion ?? ""].join(" ");
    if (/\b(upgrade|unlock|buy premium|purchase|desbloquea|compra premium|comprar|suscr[ií]bete)\b/iu.test(text)) issues.add("paid_upsell");
    // Intentionally conservative sentinels, not a claim to understand all prose.
    if (/\b(guaranteed|definitely will|garantizado|sin duda ocurrir[aá])\b/iu.test(text)) issues.add("deterministic_claim");
  }
  const slots = new Set<string>(); let exposure = 0;
  for (const attempt of sample.attempts) {
    const slot = `${attempt.section}/${attempt.phase}`;
    if (slots.has(slot) || !expected.includes(attempt.section)) issues.add("invalid_attempt_slot"); slots.add(slot);
    if (attempt.state === "unknown" || attempt.state === "reserved") issues.add("uncertain_exposure");
    if (attempt.model !== models[SECTION_MODEL_TIER[attempt.section]]) issues.add("model_mismatch");
    if (attempt.state === "measured" && (attempt.costMicros === null || attempt.reportedModel === null || attempt.inputTokens === null || attempt.outputTokens === null)) issues.add("missing_usage");
    if (attempt.outputTokens !== null && attempt.outputTokens > MAX_OUTPUT_TOKENS_PER_SECTION) issues.add("output_bound");
    if (attempt.phase === "repair" && !sample.attempts.some(primary => primary.section === attempt.section && primary.phase === "primary" && primary.state === "measured" && primary.code === "measured" && primary.outcome === "invalid")) issues.add("invalid_repair");
    exposure += attempt.costMicros ?? attempt.reservedMicros;
  }
  if (!Number.isSafeInteger(exposure) || exposure > PAID_CEILING_MICROS) issues.add("cost_ceiling");
  if (expected.some(key => !sample.attempts.some(a => a.section === key && a.state === "measured" && a.code === "measured" && a.outcome === "valid"))) issues.add("missing_receipt");
  return [...issues].sort();
}
export function evaluationMetrics(report: PaidEvaluationReport) {
  return Object.fromEntries((["en", "es"] as const).map(locale => {
    const samples = report.samples.filter(sample => sample.locale === locale); const attempts = samples.flatMap(sample => sample.attempts);
    const latencies = attempts.map(attempt => attempt.latencyMs).sort((a, b) => a - b);
    const expected = paidSections(report.profile);
    const failedReports = samples.filter(sample => JSON.stringify(sample.sections.map(section => section.key)) !== JSON.stringify(expected) || sample.sections.some(section => section.status === "failed")).length;
    return [locale, { reports: samples.length, sections: samples.reduce((sum, sample) => sum + sample.sections.length, 0),
      failedSections: samples.reduce((sum, sample) => sum + sample.sections.filter(section => section.status === "failed").length, 0),
      failedReports, reportFailureRate: samples.length ? failedReports / samples.length : null,
      attempts: attempts.length, repairs: attempts.filter(a => a.phase === "repair").length,
      failedAttempts: attempts.filter(a => a.outcome === "invalid" || (a.state !== "reserved" && a.code !== "measured")).length,
      exposureMicros: attempts.reduce((sum, a) => sum + (a.costMicros ?? a.reservedMicros), 0),
      measuredMicros: attempts.filter(a => a.state === "measured").reduce((sum, a) => sum + (a.costMicros ?? 0), 0),
      uncertainMicros: attempts.filter(a => a.state === "unknown" || a.state === "reserved").reduce((sum, a) => sum + (a.costMicros ?? a.reservedMicros), 0),
      attemptLatencyP95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
      summedAttemptLatencyMaxMs: samples.length ? Math.max(...samples.map(s => s.attempts.reduce((sum, a) => sum + a.latencyMs, 0))) : null }];
  }));
}

/** Exact-data diff, not a semantic-quality verdict. Editors compare these deltas. */
export function comparePaidEvaluations(previous: PaidEvaluationReport, next: PaidEvaluationReport) {
  const changes: string[] = [];
  for (const key of ["profile", "contentVersion", "configHash", "corpusHash", "schemaHash", "models", "promptHashes", "processor", "source"] as const) if (canonicalHash(previous[key]) !== canonicalHash(next[key])) changes.push(key);
  const samples = next.samples.map(sample => {
    const before = previous.samples.find(row => row.caseId === sample.caseId && row.locale === sample.locale);
    const sectionChanges = sample.sections.filter(section => canonicalHash(before?.sections.find(s => s.key === section.key) ?? null) !== canonicalHash(section)).map(section => section.key);
    const text = (section: EvaluationSample["sections"][number] | undefined) => section ? [section.title, ...section.blocks.flatMap(blockText), section.closingQuestion ?? ""].filter(Boolean).join("\n\n") : null;
    return { caseId: sample.caseId, locale: sample.locale, added: !before,
      factsChanged: !before || before.factsHash !== sample.factsHash || canonicalHash(previous.facts[sample.caseId] ?? null) !== canonicalHash(next.facts[sample.caseId] ?? null),
      sectionChanges, removedSections: before?.sections.filter(section => !sample.sections.some(next => next.key === section.key)).map(section => section.key) ?? [],
      // Human-readable before/after for semantic review; never an LLM grading itself.
      sectionDiffs: sectionChanges.map(key => ({ key, before: text(before?.sections.find(section => section.key === key)), after: text(sample.sections.find(section => section.key === key)) })),
      attemptsChanged: canonicalHash(before?.attempts ?? null) !== canonicalHash(sample.attempts) };
  });
  return { changes, samples, removed: previous.samples.filter(old => !next.samples.some(next => next.caseId === old.caseId && next.locale === old.locale)).map(old => `${old.caseId}/${old.locale}`),
    previousMetrics: evaluationMetrics(previous), nextMetrics: evaluationMetrics(next) };
}

/**
 * Report-side acceptance, extracted so the pilot inventory and the approval path cannot disagree.
 *
 * Every field is optional except the ones that are pure corpus data, so a caller that cannot see
 * today's generation configuration (the inventory without a pilot env) still gets the checks that
 * do not depend on it. `validateEditorialApproval` supplies all of them, which keeps the approval
 * gate and the inventory on one implementation.
 *
 * Codes are returned in the order `validateEditorialApproval` has always thrown them, so the first
 * entry is the error that surfaces.
 */
export type ApprovalContext = {
  locale: Locale;
  profile: PaidProfile;
  facts: EvaluationFacts;
  corpusHash: string;
  schemaHash: string;
  promptHashes: Record<string, string>;
  contentVersion?: string;
  configHash?: string;
  models?: PaidEvaluationReport["models"];
  processor?: string;
  settings?: GenerationSettings;
  inputTokenLimits?: Record<string, number>;
  servedModels?: Record<string, string[]>;
  review?: EditorialReview;
};

export function approvalIssues(report: PaidEvaluationReport, current: ApprovalContext): string[] {
  const issues: string[] = [];
  if (report.source !== "provider" || Object.values(report.models).some(model => /fixture|synthetic/i.test(model)) ||
    /fixture|synthetic/i.test(report.processor)) issues.push("synthetic_is_not_editorial_approval");

  const boundFields = ["profile", "contentVersion", "configHash", "corpusHash", "schemaHash"] as const;
  const bindingChanged = boundFields.some(key => {
    const expected = current[key];
    return expected !== undefined && report[key] !== expected;
  }) ||
    (current.models !== undefined && canonicalHash(report.models) !== canonicalHash(current.models)) ||
    (current.processor !== undefined && report.processor !== current.processor) ||
    canonicalHash(report.promptHashes) !== canonicalHash(current.promptHashes) ||
    canonicalHash(report.facts) !== canonicalHash(current.facts) ||
    (current.review !== undefined && current.review.reportHash !== evaluationHash(report));
  if (bindingChanged) issues.push("approval_binding_changed");

  const cases = Object.keys(current.facts);
  const selected = report.samples.filter(sample => sample.locale === current.locale);
  const review = current.review;
  if (cases.length < PAID_EDITORIAL_MINIMUM || selected.length !== cases.length ||
    new Set(selected.map(sample => sample.caseId)).size !== cases.length ||
    (review !== undefined && (review.samples.length !== cases.length ||
      new Set(review.samples.map(sample => sample.caseId)).size !== cases.length))) issues.push("approval_corpus_incomplete");

  for (const caseId of cases) {
    const sample = selected.find(row => row.caseId === caseId);
    const signed = review?.samples.find(row => row.caseId === caseId);
    if (!sample || (review !== undefined && (!signed || signed.sampleHash !== evaluationSampleHash(sample))) ||
      evaluationSampleChecks(sample, report.profile, current.facts[caseId], report.models).length) {
      issues.push("approval_sample_invalid");
      continue;
    }
    // Receipts can only be judged against today's prices and served-model policy; a caller that
    // lacks them reports "unknown" rather than "pass" (see gateVerdicts in the pilot inventory).
    if (current.settings === undefined || current.inputTokenLimits === undefined || current.servedModels === undefined) continue;
    for (const attempt of sample.attempts) {
      if (attempt.state === "reserved" || attempt.costMicros === null) { issues.push("approval_receipt_invalid"); break; }
      const inputLimit = current.inputTokenLimits[attempt.model];
      const quote = costMicros(current.settings.prices, attempt.model, { inputTokens: inputLimit, outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION });
      if (quote === null || attempt.reservedMicros !== quote || (attempt.inputTokens !== null && attempt.inputTokens > inputLimit)) {
        issues.push("approval_receipt_invalid");
        break;
      }
      try {
        validateAttemptSettlement({ basis: attempt.state, costMicros: attempt.costMicros, model: attempt.reportedModel,
          usage: attempt.inputTokens === null || attempt.outputTokens === null ? null : { inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens }, latencyMs: attempt.latencyMs, code: attempt.code },
        quote, current.settings, attempt.model, (requested, served) => current.servedModels?.[requested]?.includes(served) === true);
      } catch { issues.push("approval_receipt_invalid"); break; }
    }
  }
  return issues;
}

/** No independent-human/identity gate. Explicit complete-report sign-off is still
 * required, and synthetic/schema fixtures can never qualify as provider approval.
 */
export function validateEditorialApproval(reportValue: unknown, reviewValue: unknown, current: {
  profile: PaidProfile; contentVersion: string; configHash: string; corpusHash: string; facts: EvaluationFacts; schemaHash: string; promptHashes: Record<string, string>; models: PaidEvaluationReport["models"]; processor: string;
  settings: GenerationSettings; inputTokenLimits: Record<string, number>; servedModels: Record<string, string[]>;
}) {
  const report = paidEvaluationSchema.parse(reportValue); const review = editorialReviewSchema.parse(reviewValue);
  const issues = approvalIssues(report, { ...current, locale: review.locale, review });
  if (issues.length > 0) throw new Error(issues[0]);
  return { profile: report.profile, contentVersion: report.contentVersion, locale: review.locale, configHash: report.configHash,
    sampleCount: Object.keys(current.facts).length, reviewer: review.reviewer, evidence: `report-sha256:${evaluationHash(report)}\n${review.evidence}` };
}

export function editorialReviewTemplate(report: PaidEvaluationReport, locale: Locale) {
  // Deliberately invalid until a real editor fills it in; no prechecked scores.
  return { version: PAID_EDITORIAL_REVIEW_VERSION, locale, reportHash: evaluationHash(report), reviewer: "", evidence: "", attestation: "",
    samples: report.samples.filter(sample => sample.locale === locale).map(sample => ({ caseId: sample.caseId, sampleHash: evaluationSampleHash(sample),
      scores: Object.fromEntries(EDITORIAL_CRITERIA.map(key => [key, null])), notes: "" })) };
}
