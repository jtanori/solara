import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPaidProfile, PAID_PROFILE } from "../src/readings/paid-contract";
import { paidEvaluationSchema, evaluationHash, evaluationMetrics, evaluationSampleChecks, evaluationSampleHash, comparePaidEvaluations, editorialReviewTemplate } from "../src/readings/evaluation";
import { blockText } from "../src/readings/presentation";
import { syntheticPaidEvaluation } from "../tests/helpers/paid-evaluation";
import { boundedJson, loadPaidEvaluationCorpus } from "./lib/paid-evaluation-corpus";

/** Offline report preparation/diff only. It cannot create a live provider or an approval. */
async function main() {
  const args = process.argv.slice(2); const values: Record<string, string> = {}; let synthetic = false;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--synthetic" && !synthetic) synthetic = true;
    else if (["--profile", "--report", "--output", "--compare"].includes(arg) && !values[arg] && args[0] && !args[0].startsWith("--")) values[arg] = args.shift()!;
    else throw Error("invalid_arguments");
  }
  if (synthetic === Boolean(values["--report"])) throw Error("choose_synthetic_or_report");
  const profile = values["--profile"] ?? PAID_PROFILE; if (!isPaidProfile(profile)) throw Error("invalid_profile");
  const report = synthetic ? await syntheticPaidEvaluation(profile) : paidEvaluationSchema.parse(boundedJson(values["--report"]));
  const corpus = loadPaidEvaluationCorpus(report.profile);
  if (report.corpusHash !== corpus.corpusHash) throw Error("corpus_changed");
  const output = resolve(values["--output"] ?? `.venv/paid-evaluation/${report.profile}`); mkdirSync(output, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
  save("report.json", report);
  const metrics = evaluationMetrics(report); save("metrics.json", metrics);
  save("review-en.template.json", editorialReviewTemplate(report, "en")); save("review-es.template.json", editorialReviewTemplate(report, "es"));
  if (values["--compare"]) save("diff.json", comparePaidEvaluations(paidEvaluationSchema.parse(boundedJson(values["--compare"])), report));
  const packet = ["# Paid reading evaluation — NOT APPROVED", "", `Source: **${report.source}**. Synthetic costs/latencies are engineering fixtures, not provider qualification or editorial approval.`,
    `Profile: ${report.profile} · contentVersion: ${report.contentVersion} · config: ${report.configHash}`, `Report SHA-256: ${evaluationHash(report)}`,
    "", "## Bilingual full-report rubric", "```json", JSON.stringify(corpus.manifest, null, 2), "```", "## Cost/latency/repair summary", "```json", JSON.stringify(metrics, null, 2), "```",
    "## Frozen derived facts by corpus case (no raw birth inputs)", "```json", JSON.stringify(report.facts, null, 2), "```"];
  for (const sample of report.samples) {
    const issues = evaluationSampleChecks(sample, report.profile, corpus.facts[sample.caseId], report.models);
    packet.push(`## ${sample.caseId} · ${sample.locale}`, `Sample SHA-256: ${evaluationSampleHash(sample)}`, `Mechanical blockers: ${issues.join(", ") || "none (editorial review is still required)"}`);
    for (const section of sample.sections) packet.push(`### ${section.title} · ${section.status}`, ...section.blocks.flatMap(blockText), section.closingQuestion ?? "");
  }
  writeFileSync(join(output, "review-packet.md"), packet.join("\n\n") + "\n");
  console.log(JSON.stringify({ source: report.source, profile: report.profile, reports: report.samples.length, reportHash: evaluationHash(report), metrics, approval: "NOT APPROVED" }, null, 2));
}
void main().catch(() => { console.error("Paid evaluation failed. Use --synthetic [--profile paid-core-v1|paid-rich-v1] or --report <bounded report.json>, with optional --output and --compare. No approval was recorded."); process.exitCode = 1; });
