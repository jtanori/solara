import { readFileSync } from "node:fs";
import type { SectionResult } from "../../src/readings/document";
import type { PaidProfile } from "../../src/readings/paid-contract";
import type { ReadingBlock } from "../../src/readings/types";

/**
 * #225: the committed structural fixture carries no prose, only block kinds and lengths. Both the
 * render test and the partial-state test need the same filler at those lengths, so the shape and
 * the builder live here once instead of being copied into each test.
 */

export type PilotStructureSection = {
  key: string;
  status: string;
  blocks: { kind: string; chars: number }[];
  closingQuestionChars: number;
};

export type PilotStructureCase = {
  pilot: string;
  profile: PaidProfile;
  locale: "en" | "es";
  caseId: string;
  sections: PilotStructureSection[];
};

export type PilotStructure = { version: string; cases: PilotStructureCase[] };

export function loadPilotStructures(): PilotStructure {
  return JSON.parse(readFileSync("tests/fixtures/readings/pilot-structures-v1.json", "utf8")) as PilotStructure;
}

/** Filler at a recorded length; never pilot prose. */
export function filler(chars: number): string {
  const base = "palabra de prueba ";
  return base.repeat(Math.max(1, Math.ceil(Math.max(1, chars) / base.length))).slice(0, Math.max(1, chars));
}

export function blockAt(kind: string, chars: number): ReadingBlock {
  const text = filler(chars);
  switch (kind) {
    case "callout": return { kind: "callout", text };
    case "list": return { kind: "list", items: [text] };
    case "keyValue": return { kind: "keyValue", entries: [{ key: "clave", value: text }] };
    case "aspectTable": return { kind: "aspectTable", rows: [{ a: "Sol", b: "Luna", type: "trígono", orb: 1.2 }] };
    default: return { kind: "prose", text };
  }
}

export function resultsFor(row: PilotStructureCase): SectionResult[] {
  return row.sections.map(section => section.status === "failed"
    ? { key: section.key as SectionResult["key"], status: "failed", failureReason: "pilot_section_failed", costMxn: 0 } as SectionResult
    : {
        key: section.key as SectionResult["key"],
        status: "generated",
        fromCache: false,
        model: "pilot-fixture",
        usage: { inputTokens: 0, outputTokens: 0 },
        costMxn: 0,
        latencyMs: 0,
        output: {
          blocks: section.blocks.map(entry => blockAt(entry.kind, entry.chars)),
          ...(section.closingQuestionChars > 0 ? { closingQuestion: filler(Math.max(10, section.closingQuestionChars)).slice(0, 500) } : {}),
        },
      } as SectionResult);
}
