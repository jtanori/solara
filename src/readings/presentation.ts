import type { Locale } from "@/lib/i18n";
import type { ChartResult } from "@/lib/types";
import type { GenerationView } from "@/readings/generation-view";
import type { ReadingBlock, SectionKey, SectionStatus, SectionTier } from "@/readings/types";

/** Display contracts only: no DB rows, provider metadata, facts blobs or raw error messages. */
export const READING_PRESENTATION_VERSION = "reading-view/1";
export const READING_LIMITS = {
  documentBytes: 512 * 1024,
  chartBytes: 16 * 1024,
  freeText: 32_768,
  paidText: 131_072,
  pdfBytes: 8 * 1024 * 1024,
  pdfPages: 40,
  paidPdfPages: 80,
  pdfDeadlineMs: 15_000,
} as const;

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
  result: ChartResult;
};
export type ReadingPresentation = {
  chart: ReadingChart;
  content: ReadingContent;
  generation: GenerationView | null;
  availability: ReadingAvailability;
};

export type ReadingSelector = { kind: "auto" } | { kind: "chart" } | { kind: "document"; id: string };
export type ReadingViewCode = "unauthorized" | "not_found" | "invalid_selection" | "invalid_chart" | "document_unavailable" | "service_unavailable";
export class ReadingViewError extends Error {
  constructor(readonly code: ReadingViewCode) { super(code); this.name = "ReadingViewError"; }
}

export function readingEditionQuery(content: ReadingContent): string {
  return content.kind === "saved-reading" ? `document=${encodeURIComponent(content.id)}` : "edition=chart";
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
