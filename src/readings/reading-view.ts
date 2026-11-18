import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { readings, readingChartFacts as chartFacts, readingDocuments as documents, readingGenerationRuns as runs, paidReadingRuns as paidRuns, paidReadingEditions as paidEditions } from "@/db/schema";
import { BASE_FACTS_BYTES, BASE_FACTS_VERSION, baseFactsRowRejection, readBaseFacts, type BaseFactsRejection } from "@/readings/chart-facts";
import { isPaidProfile, paidSections } from "@/readings/paid-contract";
import { paidSnapshotHash, readPaidSnapshot, PAID_SNAPSHOT_BYTES } from "@/readings/paid-chart";
import { paidCalculationBlocks } from "@/readings/paid-presentation";
import { getReadingNotes } from "@/lib/reading-content";
import { log } from "@/lib/log";
import type { Locale } from "@/lib/i18n";
import type { ChartFacts } from "@/lib/chart";
import { generationView } from "@/readings/generation-view";
import { chartNotes, isReadingId, readChart } from "@/readings/chart-presentation";
import { readStoredDocument } from "@/readings/stored-document";
import { READING_LIMITS, ReadingViewError, type ReadingAvailability, type ReadingChart, type ReadingPresentation, type ReadingSelector } from "@/readings/presentation";

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

/**
 * The immutable facts row saved with the chart (#152), read on its own rather than
 * joined onto the chart projection.
 *
 * Deliberately a second query. A join would make the chart read depend on a table that
 * migration 0009 introduces, so an instance that has not been migrated yet would lose
 * charts it already serves — the exact guarantee `loadReadingPresentation` extends to
 * the generation tables ("missing safety tables do not mean an unused offer"). Reading
 * facts separately keeps that guarantee intact and means the chart query, its row count
 * and its ownership filter are byte-identical to before.
 *
 * Only the version this code understands is selected: a future contract is a new row
 * under a new `facts_version`, never a rewrite, so older code keeps reading the row it
 * knows and ignores the rest. `reading_chart_facts_reading_version_key` is unique, so at
 * most one row can match. As with `result` above, the payload is size-guarded in SQL: a
 * row too large to transfer arrives as `null` and is reported as oversized rather than
 * being read halfway. Ownership is restated here so the query cannot be reused to read
 * another account's facts by id alone.
 */
const factsColumns = {
  factsVersion: chartFacts.factsVersion,
  factsCalculationPolicy: chartFacts.calculationPolicy,
  factsHouseSystem: chartFacts.houseSystem,
  factsChartVersion: chartFacts.chartVersion,
  factsHash: chartFacts.factsHash,
  facts: sql<unknown>`case when octet_length(${chartFacts.facts}::text) <= ${BASE_FACTS_BYTES} then ${chartFacts.facts} else null end`,
};

/**
 * One stored row. Every field is present whenever a row is — this is a plain select,
 * not an outer join — except `facts`, which the SQL size-guard above can null out.
 */
type StoredFactsRow = {
  factsVersion: string; factsCalculationPolicy: string; factsHouseSystem: string;
  factsChartVersion: string; factsHash: string; facts: unknown;
};

/**
 * Verify a stored facts row against the chart summary and return the facts, or a stable
 * rejection code. Never throws: reading a chart must not depend on a facts row being
 * readable.
 */
function decodeStoredFacts(row: StoredFactsRow, summary: ReadingChart["result"]): ChartFacts | BaseFactsRejection {
  const metadata = baseFactsRowRejection({
    factsVersion: row.factsVersion,
    calculationPolicy: row.factsCalculationPolicy,
    houseSystem: row.factsHouseSystem,
    chartVersion: row.factsChartVersion,
    factsHash: row.factsHash,
    facts: row.facts,
  });
  if (metadata) return metadata;
  const decoded = readBaseFacts(row.facts, summary);
  return "rejection" in decoded ? decoded.rejection : decoded.facts;
}

/**
 * Attach verified facts to the display chart, or leave them absent.
 *
 * Absent and rejected are the same outcome for the viewer: the page renders from
 * `result` and reports that full positions were not saved, instead of drawing a wheel
 * that could contradict the numbers beside it. A rejected row means stored data this
 * code cannot trust, so it is logged under a stable code — without the payload, which
 * is derived personal data — and it is never a 500.
 */
/**
 * Read the stored facts without ever letting the attempt escape. An instance that has
 * not run migration 0009 has no `reading_chart_facts` table at all; that must cost the
 * viewer the wheel, not the chart they saved.
 */
async function storedFacts(store: ReadingViewStore, userId: string, readingId: string): Promise<StoredFactsRow | BaseFactsRejection> {
  try {
    return (await store.facts(userId, readingId)) ?? "absent";
  } catch {
    return "unavailable";
  }
}

function withBaseFacts(chart: ReadingChart, row: StoredFactsRow | BaseFactsRejection, userId: string): ReadingChart {
  const decoded = typeof row === "string" ? row : decodeStoredFacts(row, chart.result);
  if (typeof decoded === "string") {
    if (decoded !== "absent") log.warn("readings.facts_rejected", { userId, readingId: chart.id, code: decoded });
    return chart;
  }
  return { ...chart, baseFacts: decoded };
}

/** SELECT-only repository. No provider, consent, lifecycle lease, or live-cache dependency. */
export class ReadingViewStore {
  constructor(private readonly database: Pick<typeof db, "select"> = db) {}

  async chart(userId: string, readingId: string) {
    return (await this.database.select(chartColumns).from(readings)
      .where(and(eq(readings.id, readingId), eq(readings.userId, userId))).limit(1)).at(0) ?? null;
  }

  /**
   * The stored facts for a chart this account owns, or null when there are none.
   * Throws only if the database does; `loadReadingPresentation` treats even that as
   * "no facts", because a supplementary read must not be able to fail a chart view.
   */
  async facts(userId: string, readingId: string) {
    return (await this.database.select(factsColumns).from(chartFacts)
      .where(and(
        eq(chartFacts.readingId, readingId),
        eq(chartFacts.factsVersion, BASE_FACTS_VERSION),
        sql`exists (select 1 from readings owner where owner.id = ${chartFacts.readingId} and owner.user_id = ${userId})`,
      )).limit(1)).at(0) ?? null;
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

  async paidSnapshot(userId: string, readingId: string, editionId: string) {
    return (await this.database.select({
      run: { id: paidRuns.id, readingId: paidRuns.readingId, locale: paidRuns.locale, profile: paidRuns.profile,
        expectedSections: paidRuns.expectedSections, contentVersion: paidRuns.contentVersion, status: paidRuns.status, consumedAt: paidRuns.consumedAt },
      edition: { id: paidEditions.id, runId: paidEditions.runId, readingId: paidEditions.readingId, locale: paidEditions.locale,
        profile: paidEditions.profile, expectedSections: paidEditions.expectedSections, contentVersion: paidEditions.contentVersion,
        chartVersion: paidEditions.chartVersion, snapshotHash: paidEditions.snapshotHash,
        snapshot: sql<unknown>`case when octet_length(${paidEditions.snapshot}::text) <= ${PAID_SNAPSHOT_BYTES} then ${paidEditions.snapshot} else null end`,
        serialized: sql<string | null>`case when octet_length(${paidEditions.document}::text) <= ${READING_LIMITS.documentBytes} then ${paidEditions.document}::text else null end`,
      },
    }).from(readings)
      .innerJoin(paidRuns, and(eq(paidRuns.userId, readings.userId), eq(paidRuns.readingId, readings.id)))
      .innerJoin(paidEditions, and(eq(paidEditions.runId, paidRuns.id), eq(paidEditions.readingId, readings.id)))
      .where(and(eq(readings.id, readingId), eq(readings.userId, userId), eq(paidEditions.id, editionId))).limit(1)).at(0) ?? null;
  }

  /** Last check before sending an expensive PDF; not a promise to recall delivered bytes. */
  async stillOwned(userId: string, readingId: string, documentId?: string, paid = false): Promise<boolean> {
    if (!documentId) return Boolean(await this.chart(userId, readingId));
    if (paid) {
      const selected = await this.paidSnapshot(userId, readingId, documentId);
      return Boolean(selected && selected.run.consumedAt && ["completed", "partial"].includes(selected.run.status));
    }
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
  if ((selector.kind === "document" || selector.kind === "paid") && !isReadingId(selector.id)) throw new ReadingViewError("invalid_selection");
  const store = deps.store ?? new ReadingViewStore();
  if (selector.kind === "paid") return loadPaidPresentation(store, user.id, readingId, selector.id);
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
  const chart = withBaseFacts(readChart(chartRow), await storedFacts(store, user.id, readingId), user.id);
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
  try { notes = await (deps.notes ?? getReadingNotes)({ ...chart.result, houseSystem: "Whole sign" }, locale); }
  catch { log.warn("readings.view_unavailable", { userId: user.id, code: "notes_unavailable" }); }
  return { chart, content: chartNotes(chart, notes, locale, user.plan === "paid"), generation, availability };
}

/** Explicit paid selection never consults today's subscription, notes or chart result. */
async function loadPaidPresentation(store: ReadingViewStore, userId: string, readingId: string, editionId: string): Promise<ReadingPresentation> {
  let selected: Awaited<ReturnType<ReadingViewStore["paidSnapshot"]>>;
  try { selected = await store.paidSnapshot(userId, readingId, editionId); }
  catch { throw new ReadingViewError("service_unavailable"); }
  if (!selected) throw new ReadingViewError("not_found");
  const { run, edition } = selected;
  try {
    if (!isPaidProfile(run.profile)) throw new Error("invalid profile");
    const manifest = JSON.stringify(paidSections(run.profile));
    if (!run.consumedAt || !["completed", "partial"].includes(run.status) || edition.profile !== run.profile ||
      edition.locale !== run.locale || edition.contentVersion !== run.contentVersion || JSON.stringify(run.expectedSections) !== manifest ||
      JSON.stringify(edition.expectedSections) !== manifest || !edition.serialized) throw new Error("invalid edition");
    const snapshot = readPaidSnapshot(edition.snapshot);
    if (snapshot.chart.id !== readingId || snapshot.profile !== run.profile || snapshot.facts.chartVersion !== edition.chartVersion || paidSnapshotHash(snapshot) !== edition.snapshotHash) throw new Error("invalid snapshot");
    const document = JSON.parse(edition.serialized);
    if (document.edition?.profile !== run.profile || document.edition?.snapshotHash !== edition.snapshotHash || JSON.stringify(document.edition?.expectedSections) !== manifest) throw new Error("invalid provenance");
    const decoded = readStoredDocument(edition.serialized, { ...edition, tier: "paid" }, { allowPaid: true, expectedSections: run.expectedSections });
    if (!decoded.ok) throw new Error("invalid document");
    return { chart: { ...snapshot.chart, calculation: paidCalculationBlocks(snapshot, edition.locale) }, content: decoded.value, generation: null, availability: "ready" };
  } catch {
    throw new ReadingViewError("document_unavailable");
  }
}
