import type { ChartFacts } from "@/lib/chart";
import type { ReadingChart, ReadingContent } from "@/readings/presentation";

/**
 * This is the entire worker input. No user, consent, raw document or run object.
 *
 * `wheelFacts` is the already-verified facts the page projected its wheel from
 * (`wheelFactsOf`), not a second lookup: the PDF re-projects the same facts with the same
 * `projectWheel` call, so page and PDF cannot disagree about what was saved. It is optional
 * because a legacy chart and a high-latitude chart legitimately have no wheel, and a PDF
 * built without facts renders no drawing rather than a fabricated one.
 *
 * These are derived positions — the same privacy class as `chart.calculation`, never birth
 * data, name or place. `READING_LIMITS.baseFactsBytes` bounds them, and `PDF_INPUT_BYTES`
 * already accounts for that in both the parent and the child.
 */
export type ReadingPdfInput = { chart: ReadingChart; content: ReadingContent; wheelFacts?: ChartFacts };
export type PdfFailureCode = "pdf_unavailable" | "pdf_capacity" | "pdf_timeout" | "pdf_aborted" | "pdf_input_limit" | "pdf_output_limit" | "pdf_page_limit" | "pdf_glyphs" | "pdf_memory_limit";
export class ReadingPdfError extends Error {
  constructor(readonly code: PdfFailureCode) { super(code); this.name = "ReadingPdfError"; }
}
export const PDF_FAILURE_CODES: readonly PdfFailureCode[] = ["pdf_unavailable", "pdf_capacity", "pdf_timeout", "pdf_aborted", "pdf_input_limit", "pdf_output_limit", "pdf_page_limit", "pdf_glyphs", "pdf_memory_limit"];
export const PDF_WORKER_HEAP_MB = 160;
export const PDF_WORKER_RSS_BYTES = 256 * 1024 * 1024;
export const PDF_IPC_CHUNK_BYTES = 64 * 1024;
// A4 body height is ~702 pt. Leave 300 pt for an opening inline table, or
// a 20-line row fragment below the repeated table title/header. Character
// bounds alone do not constrain height when valid text contains newlines.
export const PDF_FIXED_LAYOUT_LIMITS = { sectionHeadingPt: 400, tableTitleLines: 20 } as const;
export type PdfWorkerMessage = { kind: "chunk"; bytes: Uint8Array } | { kind: "done"; pages: number; peakRss: number } | { kind: "error"; code: PdfFailureCode };
