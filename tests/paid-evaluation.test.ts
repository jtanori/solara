import assert from "node:assert/strict";
import test from "node:test";
import { PAID_PROFILES, PAID_RICH_PROFILE, paidSections } from "../src/readings/paid-contract";
import { syntheticPaidEvaluation } from "./helpers/paid-evaluation";
import { comparePaidEvaluations, editorialReviewTemplate, PAID_EDITORIAL_REVIEW_VERSION, EDITORIAL_CRITERIA, evaluationHash, evaluationMetrics, evaluationSampleChecks, evaluationSampleHash, validateEditorialApproval, type PaidEvaluationReport } from "../src/readings/evaluation";

function current(report: PaidEvaluationReport) {
  const models = Object.values(report.models);
  return { ...report, settings: { models: report.models, prices: Object.fromEntries(models.flatMap(model => [model, `${model}-served`].map(id => [id, { inputMxnPerMillion: 15, outputMxnPerMillion: 60 }]))) },
    inputTokenLimits: Object.fromEntries(models.map(model => [model, 6000])), servedModels: Object.fromEntries(models.map(model => [model, [model, `${model}-served`]])) };
}
function signed(report: PaidEvaluationReport, locale: "en" | "es" = "en") {
  return { version: PAID_EDITORIAL_REVIEW_VERSION, locale, reportHash: evaluationHash(report), reviewer: "Protocol fixture only; not a real editorial approval", evidence: "Synthetic assertion of the approval interface; never recorded in the database",
    attestation: "I reviewed the complete provider-generated reports against the frozen facts and bilingual rubric",
    samples: report.samples.filter(sample => sample.locale === locale).map(sample => ({ caseId: sample.caseId, sampleHash: evaluationSampleHash(sample),
      scores: Object.fromEntries(EDITORIAL_CRITERIA.map(key => [key, 2])), notes: "Protocol fixture to exercise validation, not an editorial verdict." })) };
}
async function protocolReport() {
  // Explicit protocol test of the provider-labelled branch; this object never
  // leaves the test, enters the approval table or constitutes editorial evidence.
  const report = await syntheticPaidEvaluation(PAID_RICH_PROFILE); report.source = "provider"; report.processor = "Protocol Test Processor";
  report.models = { cheap: "protocol-cheap", strong: "protocol-strong" };
  for (const sample of report.samples) for (const attempt of sample.attempts) {
    attempt.model = attempt.section === "guidance" ? "protocol-strong" : "protocol-cheap";
    attempt.reportedModel = `${attempt.model}-served`; attempt.reservedMicros = 6000 * 15 + 2000 * 60;
  }
  return report;
}

for (const profile of PAID_PROFILES) test(`paid corpus: ${profile}, six frozen charts × two locales, full typed sections and cost/latency receipts without live transport`, async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Error("NO_NETWORK_IN_SYNTHETIC_CORPUS"); };
  try {
    const report = await syntheticPaidEvaluation(profile);
    assert.equal(report.source, "synthetic"); assert.equal(report.samples.length, 12); assert.equal(Object.keys(report.facts).length, 6);
    assert.equal(Object.keys(report.promptHashes).length, paidSections(profile).length * 2);
    for (const sample of report.samples) {
      assert.deepEqual(evaluationSampleChecks(sample, profile, report.facts[sample.caseId], report.models), [], `${sample.caseId}/${sample.locale}`);
      assert.equal(sample.sections.length, paidSections(profile).length); assert.equal(sample.attempts.length, paidSections(profile).length);
    }
    for (const locale of ["en", "es"] as const) {
      const metrics = evaluationMetrics(report)[locale]; assert.equal(metrics.reports, 6); assert.equal(metrics.sections, paidSections(profile).length * 6);
      assert.equal(metrics.uncertainMicros, 0); assert.equal(metrics.repairs, 0); assert.equal(metrics.failedAttempts, 0);
      assert.ok(metrics.measuredMicros > 0 && metrics.measuredMicros <= 60_000_000); assert.ok(metrics.attemptLatencyP95Ms !== null);
      assert.throws(() => validateEditorialApproval(report, signed(report, locale), current(report)), /synthetic_is_not_editorial_approval/);
      assert.throws(() => validateEditorialApproval(report, editorialReviewTemplate(report, locale), current(report)), "template never silently signs itself");
    }
    const es = report.samples.find(s => s.caseId === "baseline" && s.locale === "es")!; const en = report.samples.find(s => s.caseId === "baseline" && s.locale === "en")!;
    assert.notDeepEqual(es.sections[0].blocks, en.sections[0].blocks); assert.equal(es.factsHash, en.factsHash);
  } finally { globalThis.fetch = savedFetch; }
});

test("editorial approval protocol: exact-profile/config/locale/corpus/sample binding, six full reports, no independent identity requirement", async () => {
  const report = await protocolReport();
  for (const locale of ["en", "es"] as const) {
    const approval = validateEditorialApproval(report, signed(report, locale), current(report));
    assert.equal(approval.locale, locale); assert.equal(approval.sampleCount, 6); assert.ok(approval.evidence.includes(evaluationHash(report)));
  }
  for (const field of ["contentVersion", "configHash", "schemaHash", "corpusHash"] as const) {
    const changed = { ...current(report), [field]: field === "contentVersion" ? "changed" : "b".repeat(64) };
    assert.throws(() => validateEditorialApproval(report, signed(report), changed), /approval_binding_changed/);
  }
  assert.throws(() => validateEditorialApproval(report, signed(report), { ...current(report), profile: "paid-core-v1" }), /approval_binding_changed/);
  const missing = structuredClone(report); missing.samples = missing.samples.filter(sample => !(sample.caseId === "leap-day" && sample.locale === "en"));
  assert.throws(() => validateEditorialApproval(missing, { ...signed(report), reportHash: evaluationHash(missing) }, current(missing)), /approval_corpus_incomplete/);
  const duplicate = structuredClone(report); duplicate.samples[0] = duplicate.samples[2];
  assert.throws(() => validateEditorialApproval(duplicate, signed(duplicate), current(duplicate)), /approval_corpus_incomplete/);
  const review = signed(report); review.samples[0].scores.factualAgreement = 1;
  assert.throws(() => validateEditorialApproval(report, review, current(report)), "all criteria require a full editorial pass");
  const changedProse = structuredClone(report); changedProse.samples[0].sections[0].blocks = [{ kind: "prose", text: "Changed after signing." }];
  assert.throws(() => validateEditorialApproval(changedProse, signed(report), current(report)), /approval_binding_changed/);
});

test("editorial approval protocol: mechanical blockers survive a freshly re-signed artifact; a hash alone is not enough", async () => {
  const report = await protocolReport();
  const mutations = [
    (r: PaidEvaluationReport) => { r.samples[0].sections.pop(); },
    (r: PaidEvaluationReport) => { r.samples[0].sections[0].status = "failed"; },
    (r: PaidEvaluationReport) => { r.samples[0].sections[0].blocks = [{ kind: "prose", text: "Upgrade to unlock the missing answer." }]; },
    (r: PaidEvaluationReport) => { r.samples[0].factsHash = "b".repeat(64); },
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].state = "unknown"; },
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].costMicros = 10_000_001; },
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].inputTokens = null; },
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].model = "unexpected-model"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => validateEditorialApproval(changed, signed(changed), current(changed)), /approval_sample_invalid/);
  }
});

test("evaluation diff: prompt/schema/model/fact/prose and repair/failure/uncertain-spend changes are separate, never an automatic quality score", async () => {
  const original = await syntheticPaidEvaluation(PAID_RICH_PROFILE); const next = structuredClone(original);
  next.models.strong = "other-strong"; next.schemaHash = "b".repeat(64); next.promptHashes["sun.en"] = "b".repeat(64);
  const sample = next.samples[0]; sample.factsHash = "c".repeat(64); sample.sections[0].blocks = [{ kind: "prose", text: "Changed output." }]; sample.sections[1].status = "failed";
  sample.attempts[0].outcome = "invalid";
  sample.attempts.push({ ...sample.attempts[0], phase: "repair", state: "unknown", costMicros: null, code: "transport_error", outcome: null });
  const diff = comparePaidEvaluations(original, next);
  assert.deepEqual(diff.changes, ["schemaHash", "models", "promptHashes"]); assert.equal(diff.samples[0].factsChanged, true);
  assert.deepEqual(diff.samples[0].sectionChanges, ["overview", "sun"]); assert.equal(diff.samples[0].attemptsChanged, true);
  assert.equal(diff.nextMetrics.en.repairs, 1); assert.equal(diff.nextMetrics.en.failedSections, 1); assert.equal(diff.nextMetrics.en.failedReports, 1); assert.equal(diff.nextMetrics.en.failedAttempts, 2);
  assert.equal(diff.nextMetrics.en.uncertainMicros, sample.attempts[0].reservedMicros);
  assert.ok(diff.samples[0].sectionDiffs[0].before?.includes("solar return")); assert.ok(diff.samples[0].sectionDiffs[0].after?.includes("Changed output."));
  next.samples[0].sections = []; assert.equal(evaluationMetrics(next).en.failedReports, 1, "early halt with missing sections cannot count as a complete report");
});

test("editorial receipts: validate exact per-section model, aliases, usage, quote and price arithmetic rather than trusting a signed cost", async () => {
  const report = await protocolReport();
  for (const mutate of [
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].costMicros!++; },
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].reportedModel = "unapproved-served-alias"; },
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].reservedMicros--; },
    (r: PaidEvaluationReport) => { r.samples[0].attempts[0].inputTokens = 6001; },
  ]) {
    const changed = structuredClone(report); mutate(changed);
    assert.throws(() => validateEditorialApproval(changed, signed(changed), current(changed)), /approval_receipt_invalid/);
  }
  const swapped = structuredClone(report); swapped.samples[0].attempts.at(-1)!.model = swapped.models.cheap;
  assert.throws(() => validateEditorialApproval(swapped, signed(swapped), current(swapped)), /approval_sample_invalid/);
});
