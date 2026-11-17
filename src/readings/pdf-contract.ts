import type { ReadingChart, ReadingContent } from "@/readings/presentation";

/** This is the entire worker input. No user, consent, raw document or run object. */
export type ReadingPdfInput = { chart: ReadingChart; content: ReadingContent };
export type PdfFailureCode = "pdf_unavailable" | "pdf_capacity" | "pdf_timeout" | "pdf_aborted" | "pdf_input_limit" | "pdf_output_limit" | "pdf_page_limit" | "pdf_glyphs" | "pdf_memory_limit";
export class ReadingPdfError extends Error {
  constructor(readonly code: PdfFailureCode) { super(code); this.name = "ReadingPdfError"; }
}
export const PDF_FAILURE_CODES: readonly PdfFailureCode[] = ["pdf_unavailable", "pdf_capacity", "pdf_timeout", "pdf_aborted", "pdf_input_limit", "pdf_output_limit", "pdf_page_limit", "pdf_glyphs", "pdf_memory_limit"];
export const PDF_WORKER_HEAP_MB = 160;
export const PDF_WORKER_RSS_BYTES = 256 * 1024 * 1024;
export const PDF_IPC_CHUNK_BYTES = 64 * 1024;
export type PdfWorkerMessage = { kind: "chunk"; bytes: Uint8Array } | { kind: "done"; pages: number; peakRss: number } | { kind: "error"; code: PdfFailureCode };
