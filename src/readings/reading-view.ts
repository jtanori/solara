import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingDocuments as documents, readingGenerationRuns as runs } from "@/db/schema";
import { getReadingNotes } from "@/lib/reading-content";
import { log } from "@/lib/log";
import type { Locale } from "@/lib/i18n";
import { generationView } from "@/readings/generation-view";
import { chartNotes, isReadingId, readChart } from "@/readings/chart-presentation";
import { readStoredDocument } from "@/readings/stored-document";
import { READING_LIMITS, ReadingViewError, type ReadingAvailability, type ReadingPresentation, type ReadingSelector } from "@/readings/presentation";

// Same testable server boundary as lib/passwords.ts. Client imports must be type-only.
if (typeof window !== "undefined") throw new Error("reading-view is server-only");

const chartColumns = {
  id: readings.id, year: readings.year,
  // Extract display fields, never transfer birth input or coordinates to the view.
  name: sql<string>`case when length(${readings.input}->>'name') <= 200 then ${readings.input}->>'name' end`,
  returnPlace: sql<string>`case when length(${readings.input}->'returnPlace'->>'name') <= 400 then ${readings.input}->'returnPlace'->>'name' end`,
  timezone: sql<string>`case when length(${readings.input}->'returnPlace'->>'timezone') <= 100 then ${readings.input}->'returnPlace'->>'timezone' end`,
  result: sql<unknown>`case when octet_length(${readings.result}::text) <= ${READING_LIMITS.chartBytes} then ${readings.result} else null end`,
};

/** SELECT-only repository. No provider, consent, lifecycle lease, or live-cache dependency. */
export class ReadingViewStore {
  constructor(private readonly database: Pick<typeof db, "select"> = db) {}

  async chart(userId: string, readingId: string) {
    return (await this.database.select(chartColumns).from(readings)
      .where(and(eq(readings.id, readingId), eq(readings.userId, userId))).limit(1)).at(0) ?? null;
  }

  async snapshot(userId: string, readingId: string) {
    return (await this.database.select({
      chart: chartColumns,
      run: {
        id: runs.id, readingId: runs.readingId, documentId: runs.documentId, locale: runs.locale,
        status: runs.status, consumedAt: runs.consumedAt, owner: runs.owner, contentVersion: runs.contentVersion,
        expired: sql<boolean>`${runs.deadline} is null or ${runs.deadline} <= clock_timestamp()`,
      },
      document: {
        id: documents.id, readingId: documents.readingId, locale: documents.locale,
        contentVersion: documents.contentVersion, chartVersion: documents.chartVersion, tier: documents.tier,
        serialized: sql<string | null>`case when octet_length(${documents.document}::text) <= ${READING_LIMITS.documentBytes} then ${documents.document}::text else null end`,
      },
      runReadingOwned: sql<boolean>`exists (select 1 from readings original where original.id = ${runs.readingId} and original.user_id = ${userId})`,
      hasHistory: sql<boolean>`exists (select 1 from reading_documents historical where historical.reading_id = ${readings.id})`,
    }).from(readings)
      .leftJoin(runs, and(eq(runs.userId, readings.userId), eq(runs.kind, "lifetime_free")))
      .leftJoin(documents, and(eq(documents.id, runs.documentId), eq(documents.readingId, readings.id), eq(runs.readingId, readings.id)))
      .where(and(eq(readings.id, readingId), eq(readings.userId, userId))).limit(1)).at(0) ?? null;
  }

  /** Last check before sending an expensive PDF; not a promise to recall delivered bytes. */
  async stillOwned(userId: string, readingId: string, documentId?: string): Promise<boolean> {
    if (!documentId) return Boolean(await this.chart(userId, readingId));
    const rows = await this.database.select({ id: documents.id }).from(readings)
      .innerJoin(runs, and(eq(runs.userId, readings.userId), eq(runs.readingId, readings.id), eq(runs.kind, "lifetime_free")))
      .innerJoin(documents, and(eq(documents.id, runs.documentId), eq(documents.readingId, readings.id)))
      .where(and(eq(readings.id, readingId), eq(readings.userId, userId), eq(documents.id, documentId))).limit(1);
    return rows.length === 1;
  }
}

export type ReadingViewer = { id: string; emailVerifiedAt: Date | null; plan: "free" | "paid" };
export type ReadingViewDeps = { store?: ReadingViewStore; notes?: typeof getReadingNotes };

export async function loadReadingPresentation(
  user: ReadingViewer | null, readingId: string, locale: Locale,
  selector: ReadingSelector = { kind: "auto" }, deps: ReadingViewDeps = {},
): Promise<ReadingPresentation> {
  if (!user?.emailVerifiedAt) throw new ReadingViewError("unauthorized");
  if (!isReadingId(readingId)) throw new ReadingViewError("not_found");
  if (selector.kind === "document" && !isReadingId(selector.id)) throw new ReadingViewError("invalid_selection");
  const store = deps.store ?? new ReadingViewStore();
  let snapshot: Awaited<ReturnType<ReadingViewStore["snapshot"]>> = null;
  let chartRow: Awaited<ReturnType<ReadingViewStore["chart"]>> = null;
  let availability: ReadingAvailability = "chart_only";
  try {
    // Explicit notes/PDF access is independent of generation tables. The page
    // must use this selector to omit AI controls, never infer an unused offer.
    if (selector.kind === "chart") chartRow = await store.chart(user.id, readingId);
    else {
      try {
        snapshot = await store.snapshot(user.id, readingId);
        chartRow = snapshot?.chart ?? null;
      } catch {
        // Missing safety tables do not mean an unused offer. Preserve independent chart reads.
        log.warn("readings.view_unavailable", { userId: user.id, code: "document_store_unavailable" });
        if (selector.kind === "document") throw new ReadingViewError("service_unavailable");
        chartRow = await store.chart(user.id, readingId);
        availability = "service_unavailable";
      }
    }
  } catch (error) {
    if (error instanceof ReadingViewError) throw error;
    log.warn("readings.view_unavailable", { userId: user.id, code: "chart_store_unavailable" });
    throw new ReadingViewError("service_unavailable");
  }
  if (!chartRow) throw new ReadingViewError("not_found");
  const chart = readChart(chartRow);
  const run = snapshot?.run?.id ? snapshot.run : null;
  let generation = snapshot ? generationView(run) : null;
  const document = snapshot?.document?.id ? snapshot.document : null;

  if (selector.kind === "document" && (run?.readingId !== chart.id || run.documentId !== selector.id || !document)) {
    throw new ReadingViewError("not_found");
  }
  if (run?.readingId && !snapshot?.runReadingOwned) {
    // A corrupt cross-owner pointer must not become a link or expose that ID.
    generation = null;
    availability = "document_unavailable";
  } else if (run?.readingId && run.readingId !== chart.id) {
    availability = "other_chart";
  } else if (run?.documentId) {
    const coherent = document && run.consumedAt && ["completed", "partial", "legacy"].includes(run.status) &&
      run.locale === document.locale && run.contentVersion === document.contentVersion && document.tier === "free";
    const decoded = coherent && document.serialized !== null
      ? readStoredDocument(document.serialized, document, { legacy: run.status === "legacy" }) : null;
    if (decoded?.ok) return { chart, content: decoded.value, generation, availability: "ready" };
    if (selector.kind === "document") throw new ReadingViewError("document_unavailable");
    availability = "document_unavailable";
    if (generation) generation = { ...generation, documentId: null };
  } else if (snapshot?.hasHistory) {
    availability = "history_unavailable";
  }
  let notes: Awaited<ReturnType<typeof getReadingNotes>> | null = null;
  try { notes = await (deps.notes ?? getReadingNotes)(chart.result, locale); }
  catch { log.warn("readings.view_unavailable", { userId: user.id, code: "notes_unavailable" }); }
  return { chart, content: chartNotes(chart, notes, locale, user.plan === "paid"), generation, availability };
}
