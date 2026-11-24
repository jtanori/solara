import type { Locale } from "@/lib/i18n";
import type { ChartFacts } from "@/lib/chart";
import type { ChartResult } from "@/lib/types";
import type { GenerationView } from "@/readings/generation-view";
import type { ReadingBlock, SectionKey, SectionStatus, SectionTier } from "@/readings/types";

/**
 * Display contracts only: no DB rows, no provider metadata, no provider facts
 * payload, no raw error messages. Whitelisted deterministic derived data is allowed
 * and is what `ReadingChart.calculation` and `ReadingChart.baseFacts` carry.
 */
export const READING_PRESENTATION_VERSION = "reading-view/1";
export const READING_LIMITS = {
  documentBytes: 512 * 1024,
  chartBytes: 16 * 1024,
  /**
   * Upper bound on the serialized base facts a chart may carry (#152). Equal to
   * `BASE_FACTS_BYTES` in `src/readings/chart-facts.ts`; this module is imported by
   * client components and that module is server-only (`node:crypto`), so the number
   * is repeated here deliberately and `tests/readings-facts.test.ts` fails if the two
   * ever diverge.
   */
  baseFactsBytes: 64 * 1024,
  freeText: 32_768,
  paidText: 131_072,
  pdfBytes: 8 * 1024 * 1024,
  pdfPages: 40,
  paidPdfPages: 80,
  pdfDeadlineMs: 15_000,
} as const;

/**
 * Upper bound on the serialized PDF input, which is `{ chart, content }`: the frozen
 * prose document, the display chart, and any base facts that chart carries.
 *
 * The preflight check in `pdf-render.ts` and the worker-side check in `pdf-worker.ts`
 * guard the same quantity and previously spelled it out independently, so widening one
 * could silently leave the other rejecting valid input. Both now use this single value.
 */
export const PDF_INPUT_BYTES = READING_LIMITS.documentBytes + READING_LIMITS.chartBytes + READING_LIMITS.baseFactsBytes;

export type ReadingNotice = "partial" | "section_failed" | "section_unavailable" | "unsupported_blocks" | "legacy_question_missing" | "missing_sections" | "notes_unavailable";
export type ReadingAvailability = "ready" | "chart_only" | "other_chart" | "history_unavailable" | "document_unavailable" | "service_unavailable";
export type DisplaySection = {
  key: SectionKey;
  tier: SectionTier;
  title: string;
  subtitle?: string;
  status: SectionStatus;
  blocks: ReadingBlock[];
  closingQuestion?: string;
  notices: ReadingNotice[];
};
export type SectionPreview = {
  key: SectionKey;
  title: string;
  teaser: string;
  availability: "not_included" | "planned";
};
export type SavedReadingPresentation = {
  kind: "saved-reading";
  id: string;
  readingId: string;
  locale: Locale;
  contentVersion: string;
  chartVersion: string;
  generatedAt: string;
  tier: SectionTier;
  presentationVersion: string;
  sections: DisplaySection[];
  previews: SectionPreview[];
  partial: boolean;
  notices: ReadingNotice[];
};
export type ChartNotesPresentation = {
  kind: "chart-notes";
  locale: Locale;
  sections: DisplaySection[];
  notices: ReadingNotice[];
};
export type ReadingContent = SavedReadingPresentation | ChartNotesPresentation;

/** Minimum saved chart data needed by page/PDF. Never includes birth input/coordinates. */
export type ReadingChart = {
  id: string;
  year: number;
  name: string;
  returnPlace: string;
  timezone: string;
  result: Omit<ChartResult, "houseSystem"> & { houseSystem: "Whole sign" | "Placidus" };
  /** Whitelisted deterministic snapshot facts, not provider output or raw birth data. */
  calculation?: ReadingBlock[];
  /**
   * The complete deterministic calculation behind this chart (#152), read back from the
   * immutable row saved with it and verified against `result` before it is exposed.
   * Absent — never a default, never recomputed — for charts saved before the facts
   * table existed, for charts whose calculation has no Ascendant, and for any stored row
   * that fails verification. Same privacy status as `calculation`: derived positions,
   * never birth date, time, place or name.
   */
  baseFacts?: ChartFacts;
};
/**
 * The facts this presentation's wheel may be drawn from — the single accessor both emitters
 * use (page in S1-c, PDF in S1-d).
 *
 * A paid edition keeps its verified facts on the presentation (`wheelFacts`) because they
 * are not part of its hashed chart summary; a base chart keeps them on the chart itself.
 * One accessor, so no caller has to know which — and nothing else in the payload is
 * consulted, so a chart with neither renders no wheel rather than a fabricated one.
 *
 * Lives here rather than beside the page component because `SolarReturnDocument` cannot
 * import a Next component: this module is the only thing page and PDF already share, and
 * two accessors would be two answers to "which facts".
 */
export function wheelFactsOf(view: Pick<ReadingPresentation, "chart" | "wheelFacts">): ChartFacts | null {
  return view.wheelFacts ?? view.chart.baseFacts ?? null;
}

export type ReadingPresentation = {
  chart: ReadingChart;
  content: ReadingContent;
  generation: GenerationView | null;
  availability: ReadingAvailability;
  /**
   * The verified facts this presentation's wheel may be drawn from, when it differs from
   * `chart.baseFacts` — a paid edition's pinned Placidus snapshot (issue #154).
   *
   * A separate field rather than a field on `chart`, for three reasons: `snapshot.chart`
   * is an input to the snapshot hash and must not gain keys; `readChart` builds the chart
   * from a fixed schema, so extra keys would be stripped anyway; and keeping it on the
   * presentation means no PDF or page payload silently carries facts the caller did not
   * ask for. Base charts leave it undefined and use `chart.baseFacts`, as before.
   */
  wheelFacts?: ChartFacts;
};

export type ReadingSelector = { kind: "auto" } | { kind: "chart" } | { kind: "document"; id: string } | { kind: "paid"; id: string };
export type ReadingViewCode = "unauthorized" | "not_found" | "invalid_selection" | "invalid_chart" | "document_unavailable" | "service_unavailable";
export class ReadingViewError extends Error {
  constructor(readonly code: ReadingViewCode) { super(code); this.name = "ReadingViewError"; }
}

export function readingEditionQuery(content: ReadingContent): string {
  return content.kind === "saved-reading" ? `${content.tier === "paid" ? "paidEdition" : "document"}=${encodeURIComponent(content.id)}` : "edition=chart";
}

/** All text fields, in semantic order. Also used for aggregate bounds and font coverage. */
export function blockText(block: ReadingBlock): string[] {
  const title = "title" in block && block.title ? [block.title] : [];
  switch (block.kind) {
    case "prose": return [block.text];
    case "callout": return [...title, block.text];
    case "list": return [...title, ...block.items];
    case "keyValue": return [...title, ...block.entries.flatMap(entry => [entry.key, entry.value])];
    case "aspectTable": return [...title, ...block.rows.flatMap(row => [row.a, row.b, row.type, `${row.orb}°`])];
    default: return [];
  }
}
export function sectionText(section: DisplaySection): string[] {
  return [section.title, ...(section.subtitle ? [section.subtitle] : []), ...section.blocks.flatMap(blockText), ...(section.closingQuestion ? [section.closingQuestion] : [])];
}
