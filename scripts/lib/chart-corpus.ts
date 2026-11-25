import { readFileSync } from "node:fs";
import type { ChartInput } from "../../src/lib/types";

/**
 * The six synthetic chart inputs shared by the paid evaluation and the free-path harness
 * (#226). Only the inputs live here; the paid rubric, facts and prompt hashes stay in
 * `paid-evaluation-corpus.ts`, so a free run does not compute paid material it never uses.
 */

const MANIFEST = "tests/fixtures/readings/paid-corpus-v1.json";
const INPUTS = "tests/fixtures/annual-facts.json";

export type ChartCorpusCase = { id: string; input: ChartInput };

export function loadChartCorpus(): ChartCorpusCase[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { cases: { id: string }[] };
  const reference = JSON.parse(readFileSync(INPUTS, "utf8")) as { cases: { id: string; input: ChartInput }[] };
  const cases = manifest.cases.map(entry => {
    const source = reference.cases.find(row => row.id === entry.id);
    if (!source) throw new Error(`corpus_case_missing: ${entry.id}`);
    return { id: source.id, input: source.input };
  });
  if (cases.length < 6 || new Set(cases.map(row => row.id)).size !== cases.length) {
    throw new Error("corpus_case_invalid");
  }
  return cases;
}
