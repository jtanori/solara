import type { Locale } from "@/lib/i18n";

/** Public status only. This module has no DB/provider/runtime configuration imports. */
export type GenerationView = {
  status: "unused" | "in_progress" | "completed" | "partial" | "failed" | "indeterminate" | "free_reading_deleted";
  readingId: string | null;
  documentId: string | null;
  locale: Locale | null;
};

export type GenerationViewSource = {
  readingId: string | null;
  documentId: string | null;
  locale: Locale;
  status: "reserved" | "running" | "completed" | "partial" | "failed" | "indeterminate" | "legacy";
  consumedAt: Date | null;
  owner: string | null;
  /** Calculated with the database clock in the same snapshot as the run. */
  expired: boolean;
};

/** Shared by the existing status endpoint and the saved-document reader. No transitions/writes. */
export function generationView(run?: GenerationViewSource | null): GenerationView {
  if (!run) return { status: "unused", readingId: null, documentId: null, locale: null };
  const status = run.consumedAt && !run.readingId ? "free_reading_deleted"
    : run.documentId ? run.status === "partial" ? "partial" : "completed"
      : run.status === "reserved" ? run.expired || !run.owner ? "unused" : "in_progress"
        : run.status === "running" ? run.expired ? "indeterminate" : "in_progress"
          : run.status === "indeterminate" ? "indeterminate" : "failed";
  return { status, readingId: run.readingId, documentId: run.documentId, locale: run.locale };
}
