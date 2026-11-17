import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test as nodeTest } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool, coordinationPool } from "../src/db";
import { users, readings, readingDocuments, readingGenerationRuns as runs, readingGenerationConsents as consents, readingGenerationAttempts as attempts } from "../src/db/schema";
import { calculateSolarReturn } from "../src/lib/solar";
import { contentKey } from "../src/lib/content";
import { loadReadingPresentation, ReadingViewStore, type ReadingViewer } from "../src/readings/reading-view";
import { READING_LIMITS, ReadingViewError, type ReadingSelector } from "../src/readings/presentation";
import { frozenReading, readingChartInput } from "./helpers/reading-fixtures";
import { createTempDatabase } from "./temp-database";
import type { Locale } from "../src/lib/i18n";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const test = enabled ? nodeTest : nodeTest.skip;

const createdUsers: string[] = [];
const originalFetch = globalThis.fetch;
const originalEnabled = process.env.READINGS_GENERATION_ENABLED;
let fetches = 0;
const result = calculateSolarReturn(readingChartInput);
const safeNotes = async () => ({ sun: "Illustrative Sun", moon: "Illustrative Moon", ascendant: "Illustrative Ascendant", house: "Illustrative house" });
const deps = { notes: safeNotes };
const store = new ReadingViewStore();
const verified = new Date("2026-01-01T00:00:00.000Z");

before(() => {
  if (!enabled) return;
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname), "disposable local database only");
  process.env.READINGS_GENERATION_ENABLED = "false";
  globalThis.fetch = async () => { fetches++; throw new Error("Read paths must not make provider/HTTP calls"); };
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (originalEnabled === undefined) delete process.env.READINGS_GENERATION_ENABLED; else process.env.READINGS_GENERATION_ENABLED = originalEnabled;
  try {
    assert.equal(fetches, 0, "no provider/HTTP dispatch from the reader");
    if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  } finally { await Promise.all([pool.end(), coordinationPool.end()]); }
});

async function account(locale: Locale = "en", edition: "free" | "partial-overview" | "partial-sun" | "paid" | "none" = "free") {
  const [user] = await db.insert(users).values({ name: "Synthetic viewer", email: `${randomUUID()}@example.com`, passwordHash: "unused-test-hash", emailVerifiedAt: verified }).returning({ id: users.id });
  createdUsers.push(user.id);
  const [chart] = await db.insert(readings).values({ userId: user.id, year: 2026, input: readingChartInput, result }).returning();
  const document = { ...frozenReading(locale, edition === "none" ? "free" : edition), id: randomUUID(), readingId: chart.id };
  const viewer: ReadingViewer = { id: user.id, emailVerifiedAt: verified, plan: "free" };
  if (edition !== "none") {
    await db.insert(readingDocuments).values({ id: document.id, readingId: chart.id, locale, contentVersion: document.contentVersion, chartVersion: document.chartVersion, tier: document.tier, document });
    await db.insert(runs).values({ userId: user.id, readingId: chart.id, documentId: document.id, locale, status: edition.startsWith("partial") ? "partial" : "completed", consumedAt: verified, contentVersion: document.contentVersion });
  }
  return { viewer, chart, document };
}
const code = (expected: string) => (error: unknown) => error instanceof ReadingViewError && error.code === expected;

async function state(userId: string) {
  const charts = await db.select({ id: readings.id }).from(readings).where(eq(readings.userId, userId));
  const run = await db.select().from(runs).where(eq(runs.userId, userId));
  return JSON.stringify({
    run,
    documents: charts.length ? await db.select().from(readingDocuments).where(inArray(readingDocuments.readingId, charts.map(c => c.id))) : [],
    consent: await db.select().from(consents).where(eq(consents.userId, userId)),
    attempts: run.length ? await db.select().from(attempts).where(inArray(attempts.runId, run.map(r => r.id))) : [],
  });
}

test("reader: exact canonical locale/version wins over newer rows, UI locale and subscription", async () => {
  const { viewer, chart, document } = await account("es");
  const newer = { ...frozenReading("en", "paid"), id: randomUUID(), readingId: chart.id, contentVersion: "zzzz-newer" };
  await db.insert(readingDocuments).values({ id: newer.id, readingId: chart.id, locale: newer.locale, contentVersion: newer.contentVersion, chartVersion: newer.chartVersion, tier: newer.tier, document: newer });
  const before = await state(viewer.id);
  for (const locale of ["en", "es"] as const) for (const plan of ["free", "paid"] as const) {
    const view = await loadReadingPresentation({ ...viewer, plan }, chart.id, locale, { kind: "auto" }, { notes: async () => { throw new Error("Saved documents must not load mutable notes"); } });
    assert.equal(view.availability, "ready");
    assert.equal(view.content.kind, "saved-reading");
    if (view.content.kind !== "saved-reading") throw new Error("expected saved document");
    assert.equal(view.content.id, document.id);
    assert.equal(view.content.locale, "es");
    assert.equal(view.content.tier, "free");
    assert.equal(view.content.contentVersion, document.contentVersion);
    assert.deepEqual(view.content.sections.map(s => s.key), ["overview", "sun"]);
    assert.equal(Object.hasOwn(view.chart, "input"), false);
    assert.equal(Object.hasOwn(view.chart, "userId"), false);
  }
  assert.equal(await state(viewer.id), before, "read-only across language/plan changes");
});

test("reader: unauthenticated, unverified, malformed and cross-owner reads are rejected", async () => {
  const owner = await account();
  const foreign = await account();
  await assert.rejects(loadReadingPresentation(null, owner.chart.id, "en", { kind: "auto" }, deps), code("unauthorized"));
  await assert.rejects(loadReadingPresentation({ ...owner.viewer, emailVerifiedAt: null }, owner.chart.id, "en", { kind: "auto" }, deps), code("unauthorized"));
  await assert.rejects(loadReadingPresentation(owner.viewer, "not-a-uuid", "en", { kind: "auto" }, deps), code("not_found"));
  for (const selector of [{ kind: "auto" }, { kind: "chart" }, { kind: "document", id: foreign.document.id }] as ReadingSelector[]) {
    await assert.rejects(loadReadingPresentation(owner.viewer, foreign.chart.id, "en", selector, deps), code("not_found"));
  }
  assert.equal(await store.stillOwned(owner.viewer.id, foreign.chart.id), false);
  assert.equal(await store.stillOwned(owner.viewer.id, foreign.chart.id, foreign.document.id), false);
});

test("reader: pinned document never falls back to a different owned, archived or foreign document", async () => {
  const owner = await account();
  const foreign = await account();
  const old = { ...owner.document, id: randomUUID(), contentVersion: "archived" };
  await db.insert(readingDocuments).values({ id: old.id, readingId: owner.chart.id, locale: old.locale, contentVersion: old.contentVersion, chartVersion: old.chartVersion, tier: old.tier, document: old });
  for (const id of [foreign.document.id, old.id, randomUUID()]) {
    await assert.rejects(loadReadingPresentation(owner.viewer, owner.chart.id, "en", { kind: "document", id }, deps), code("not_found"));
  }
  const view = await loadReadingPresentation(owner.viewer, owner.chart.id, "es", { kind: "document", id: owner.document.id }, deps);
  assert.equal(view.content.kind === "saved-reading" && view.content.id, owner.document.id);
  assert.equal(await store.stillOwned(owner.viewer.id, owner.chart.id, owner.document.id), true);
});

test("reader: canonical-other-chart is linked, never relabeled as the requested chart", async () => {
  const { viewer, chart, document } = await account();
  const [other] = await db.insert(readings).values({ userId: viewer.id, year: 2026, input: readingChartInput, result }).returning();
  const view = await loadReadingPresentation(viewer, other.id, "en", { kind: "auto" }, deps);
  assert.equal(view.availability, "other_chart");
  assert.equal(view.content.kind, "chart-notes");
  assert.equal(view.generation?.readingId, chart.id);
  assert.equal(JSON.stringify(view.content).includes(document.sections[0].closingQuestion!), false);
  await assert.rejects(loadReadingPresentation(viewer, other.id, "en", { kind: "document", id: document.id }, deps), code("not_found"));
});

test("reader: explicit chart edition survives publication and alone retains legacy extended notes", async () => {
  const { viewer, chart } = await account();
  const before = await state(viewer.id);
  for (const plan of ["free", "paid"] as const) {
    const view = await loadReadingPresentation({ ...viewer, plan }, chart.id, "es", { kind: "chart" }, deps);
    assert.equal(view.content.kind, "chart-notes");
    assert.equal(view.content.locale, "es");
    assert.equal(view.content.sections.length, plan === "paid" ? 4 : 1);
  }
  assert.equal(await state(viewer.id), before);
});

test("reader: adopted legacy remains readable without current provider/consent/accounting; partial content is honest", async () => {
  const { viewer, chart, document } = await account("es", "partial-sun");
  delete document.accounting;
  delete document.sections[0].closingQuestion;
  await db.update(readingDocuments).set({ document }).where(eq(readingDocuments.id, document.id));
  await db.update(runs).set({ status: "legacy" }).where(eq(runs.userId, viewer.id));
  const view = await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps);
  assert.equal(view.generation?.status, "completed", "existing status semantics preserved for legacy pointer");
  assert.equal(view.content.kind, "saved-reading");
  if (view.content.kind !== "saved-reading") throw new Error("expected saved document");
  assert.equal(view.content.partial, true, "display completeness comes from the sections");
  assert.ok(view.content.sections[0].notices.includes("legacy_question_missing"));
  assert.ok(view.content.sections[1].notices.includes("section_failed"));
});

test("reader: orphan history does not get selected or automatically adopted", async () => {
  const { viewer, chart } = await account();
  await db.delete(runs).where(eq(runs.userId, viewer.id));
  const before = await state(viewer.id);
  const view = await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps);
  assert.equal(view.availability, "history_unavailable");
  assert.equal(view.content.kind, "chart-notes");
  assert.equal(view.generation?.status, "unused", "allowance semantics still come from the existing status contract");
  assert.equal(await state(viewer.id), before);
});

test("reader: absent document preserves unused/running/failed/indeterminate/deleted run distinctions", async () => {
  const { viewer, chart } = await account("en", "none");
  assert.equal((await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps)).generation?.status, "unused");
  await db.insert(runs).values({ userId: viewer.id, readingId: chart.id, locale: "en", status: "running", owner: randomUUID(), deadline: new Date(Date.now() + 60_000), consumedAt: verified, contentVersion: "synthetic-reading-v1" });
  for (const [status, expected] of [["running", "in_progress"], ["failed", "failed"], ["indeterminate", "indeterminate"]] as const) {
    await db.update(runs).set({ status }).where(eq(runs.userId, viewer.id));
    const before = await state(viewer.id);
    const view = await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps);
    assert.equal(view.generation?.status, expected);
    assert.equal(view.content.kind, "chart-notes");
    assert.equal(await state(viewer.id), before);
  }
  await db.update(runs).set({ readingId: null }).where(eq(runs.userId, viewer.id));
  const view = await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps);
  assert.equal(view.generation?.status, "free_reading_deleted");
  assert.equal(view.generation?.readingId, null);
});

test("reader: mismatched run version/locale/status and stored identity do not select alternate content", async () => {
  const { viewer, chart, document } = await account();
  for (const patch of [{ contentVersion: "other" }, { locale: "es" as const }, { status: "running" as const }]) {
    await db.update(runs).set(patch).where(eq(runs.userId, viewer.id));
    const view = await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps);
    assert.equal(view.availability, "document_unavailable");
    assert.equal(view.content.kind, "chart-notes");
    await assert.rejects(loadReadingPresentation(viewer, chart.id, "en", { kind: "document", id: document.id }, deps), code("document_unavailable"));
    await db.update(runs).set({ contentVersion: document.contentVersion, locale: document.locale, status: "completed" }).where(eq(runs.userId, viewer.id));
  }
  await db.update(readingDocuments).set({ document: { ...document, readingId: randomUUID() } }).where(eq(readingDocuments.id, document.id));
  assert.equal((await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps)).availability, "document_unavailable");
});

test("reader: cross-owner run pointer is not exposed as another account's link/content", async () => {
  const owner = await account();
  const foreign = await account();
  await db.update(runs).set({ readingId: foreign.chart.id, documentId: foreign.document.id }).where(eq(runs.userId, owner.viewer.id));
  const view = await loadReadingPresentation(owner.viewer, owner.chart.id, "en", { kind: "auto" }, deps);
  assert.equal(view.generation, null);
  assert.equal(view.availability, "document_unavailable");
  assert.equal(JSON.stringify(view).includes(foreign.chart.id), false);
  assert.equal(JSON.stringify(view).includes(foreign.document.id), false);
});

test("reader: paid or malformed free rows are unavailable even to a paid account", async () => {
  const paid = await account("en", "paid");
  const view = await loadReadingPresentation({ ...paid.viewer, plan: "paid" }, paid.chart.id, "en", { kind: "auto" }, deps);
  assert.equal(view.availability, "document_unavailable");
  assert.equal(view.content.kind, "chart-notes");
  const free = await account();
  free.document.sections.push(frozenReading("en", "paid").sections[2]);
  await db.update(readingDocuments).set({ document: free.document }).where(eq(readingDocuments.id, free.document.id));
  assert.equal((await loadReadingPresentation(free.viewer, free.chart.id, "en", { kind: "auto" }, deps)).availability, "document_unavailable");
});

test("reader: oversized JSON is not transferred from SQL to Node", async () => {
  const { viewer, chart, document } = await account();
  Object.assign(document, { rawProviderResponse: "x".repeat(READING_LIMITS.documentBytes) });
  await db.update(readingDocuments).set({ document }).where(eq(readingDocuments.id, document.id));
  const snapshot = await store.snapshot(viewer.id, chart.id);
  assert.equal(snapshot?.document?.id, document.id);
  assert.equal(snapshot?.document?.serialized, null);
  const view = await loadReadingPresentation(viewer, chart.id, "en", { kind: "auto" }, deps);
  assert.equal(view.availability, "document_unavailable");
  assert.equal(view.content.kind, "chart-notes");
});

test("reader: withdrawal, repeated reads and disabled generation do not mutate persisted state", async () => {
  const { viewer, chart, document } = await account();
  await db.insert(consents).values({ userId: viewer.id, locale: "en", revision: 2, withdrawnAt: verified });
  const before = await state(viewer.id);
  for (let i = 0; i < 4; i++) {
    const view = await loadReadingPresentation(viewer, chart.id, i % 2 ? "es" : "en", { kind: "document", id: document.id }, deps);
    assert.equal(view.content.kind, "saved-reading");
  }
  assert.equal(await state(viewer.id), before);
  assert.equal(fetches, 0);
});

test("reader: deletion invalidates page and final PDF check, without resetting or recreating the run", async () => {
  const { viewer, chart, document } = await account();
  await db.delete(readings).where(and(eq(readings.id, chart.id), eq(readings.userId, viewer.id)));
  assert.equal(await store.stillOwned(viewer.id, chart.id, document.id), false);
  await assert.rejects(loadReadingPresentation(viewer, chart.id, "en", { kind: "document", id: document.id }, deps), code("not_found"));
  const [run] = await db.select().from(runs).where(eq(runs.userId, viewer.id));
  assert.equal(run.readingId, null);
  assert.equal(run.documentId, null);
  assert.ok(run.consumedAt);
});

test("reader: missing generation tables degrade to independent chart view, never unused", async () => {
  const temporary = await createTempDatabase();
  try {
    await temporary.client.query("create table readings (id uuid primary key, user_id uuid not null, year integer not null, input jsonb not null, result jsonb not null)");
    const id = randomUUID(); const userId = randomUUID();
    await temporary.client.query("insert into readings values ($1,$2,2026,$3,$4)", [id, userId, readingChartInput, result]);
    const localStore = new ReadingViewStore(drizzle(temporary.client));
    const viewer: ReadingViewer = { id: userId, emailVerifiedAt: verified, plan: "free" };
    const view = await loadReadingPresentation(viewer, id, "en", { kind: "auto" }, { ...deps, store: localStore });
    assert.equal(view.availability, "service_unavailable");
    assert.equal(view.generation, null);
    assert.equal(view.content.kind, "chart-notes");
    const chart = await loadReadingPresentation(viewer, id, "en", { kind: "chart" }, { ...deps, store: localStore });
    assert.equal(chart.availability, "chart_only");
    await assert.rejects(loadReadingPresentation(viewer, id, "en", { kind: "document", id: randomUUID() }, { ...deps, store: localStore }), code("service_unavailable"));
  } finally { await temporary.cleanup(); }
});

test("reader: oversized legacy editorial notes are omitted, not silently substituted", async () => {
  const { viewer, chart } = await account("en", "none");
  const key = contentKey("sun", result.natalSun.sign, "en");
  const temporary = await createTempDatabase();
  try {
    await temporary.client.query("create table knowledge (key text primary key, body text not null)");
    await temporary.client.query("insert into knowledge values ($1,$2)", [key, "x".repeat(4001)]);
    const notesDb = drizzle(temporary.client);
    const { getReadingNotes } = await import("../src/lib/reading-content");
    const view = await loadReadingPresentation(viewer, chart.id, "en", { kind: "chart" }, {
      notes: (chartResult, locale) => getReadingNotes(chartResult, locale, notesDb),
    });
    assert.equal(view.content.kind, "chart-notes");
    assert.deepEqual(view.content.sections, []);
    assert.deepEqual(view.content.notices, ["notes_unavailable"]);
  } finally { await temporary.cleanup(); }
});
