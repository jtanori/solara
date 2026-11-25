import { readFileSync } from "node:fs";
import { calculatePaidSnapshot, paidDigest } from "../../src/readings/paid-chart";
import { paidSections, type PaidProfile } from "../../src/readings/paid-contract";
import { sectionJsonSchema } from "../../src/readings/schemas";
import { assembleSectionPrompt } from "../../src/readings/generate";
import { canonicalHash } from "../../src/readings/policy";
import { PAID_CORPUS_VERSION } from "../../src/readings/evaluation";
import { loadChartCorpus } from "./chart-corpus";

export function boundedJson(path: string): unknown {
  const content = readFileSync(path); if (content.byteLength > 8 * 1024 * 1024) throw new Error("evaluation_file_too_large");
  return JSON.parse(content.toString("utf8"));
}
export function loadPaidEvaluationCorpus(profile: PaidProfile) {
  const manifest = boundedJson("tests/fixtures/readings/paid-corpus-v1.json") as { version: string; cases: { id: string }[]; rubric: unknown };
  if (manifest.version !== PAID_CORPUS_VERSION) throw new Error("corpus_version_invalid");
  const cases = loadChartCorpus();
  if (cases.length !== manifest.cases.length) throw new Error("corpus_case_invalid");
  const facts = Object.fromEntries(cases.map(row => [row.id, paidDigest(calculatePaidSnapshot("22222222-2222-4222-8222-222222222222", row.input, profile))]));
  const schemaHash = canonicalHash(Object.fromEntries(paidSections(profile).map(key => [key, sectionJsonSchema(key, "paid")])));
  const promptHashes = Object.fromEntries(paidSections(profile).flatMap(key => (["en", "es"] as const).map(locale => [
    `${key}.${locale}`, canonicalHash(assembleSectionPrompt(key, locale, "FROZEN_DERIVED_FACTS", JSON.stringify(sectionJsonSchema(key, "paid")), "paid")),
  ])));
  return { manifest, cases, facts, corpusHash: canonicalHash({ manifest, cases }), schemaHash, promptHashes };
}
