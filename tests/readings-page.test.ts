import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test as nodeTest } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, coordinationPool } from "../src/db";
import { readings, readingDocuments, readingGenerationRuns as runs, readingGenerationConsents as consents, rateLimits } from "../src/db/schema";
import { handleReadingPdf, type ReadingPdfHttpDeps } from "../src/readings/pdf-http";
import { handleGeneration } from "../src/readings/http";
import { ReadingViewStore } from "../src/readings/reading-view";
import { ReadingPdfError, type PdfFailureCode, type ReadingPdfInput } from "../src/readings/pdf-contract";
import { READING_LIMITS } from "../src/readings/presentation";
import { keyFor } from "../src/lib/rate-limit";
import { readingLedgerSnapshot, syntheticReadingAccount } from "./helpers/reading-account";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const test = enabled ? nodeTest : nodeTest.skip;

const accounts: Awaited<ReturnType<typeof syntheticReadingAccount>>[] = [];
const oldFetch = globalThis.fetch; let fetches = 0;
before(() => {
  if (!enabled) return; globalThis.fetch = async () => { fetches++; throw Error("No HTTP/provider calls from views/downloads"); }; });
after(async () => {
  globalThis.fetch = oldFetch;
  try {
    assert.equal(fetches, 0);
    for (const account of accounts) {
      await db.delete(rateLimits).where(eq(rateLimits.key, keyFor("readings:pdf:user", account.viewer.id)));
      await db.delete(rateLimits).where(eq(rateLimits.key, keyFor("readings:status:user", account.viewer.id)));
      await account.cleanup();
    }
  } finally { await Promise.all([pool.end(), coordinationPool.end()]); }
});
async function account(...args: Parameters<typeof syntheticReadingAccount>) { const value = await syntheticReadingAccount(...args); accounts.push(value); return value; }
const notes = async () => ({ sun: "MUTABLE_NOTE", moon: "MOON_NOTE", ascendant: "ASC_NOTE", house: "HOUSE_NOTE" });
const fakeRender = async (input: ReadingPdfInput) => ({ buffer: Buffer.from(JSON.stringify(input)), pages: 1, peakRss: 0, durationMs: 0 });
const request = (id: string, query = "", method = "GET") => new Request(`http://localhost/api/readings/${id}/pdf${query ? `?${query}` : ""}`, { method });
function deps(value: Awaited<ReturnType<typeof account>>): ReadingPdfHttpDeps { return { user: async () => value.viewer, locale: "en", notes, throttle: async () => null, renderer: { render: fakeRender } }; }
function privateHeaders(response: Response) {
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
}

test("PDF HTTP: authenticated selectors and tenancy fail closed with private headers", async () => {
  const owner = await account(); const foreign = await account(); let renders = 0;
  const options = { ...deps(owner), renderer: { render: async (input: ReadingPdfInput) => { renders++; return fakeRender(input); } } };
  const cases: [Request, string, ReadingPdfHttpDeps, number][] = [
    [request(owner.chart.id), owner.chart.id, { ...options, user: async () => null }, 401],
    [request(owner.chart.id), owner.chart.id, { ...options, user: async () => ({ ...owner.viewer, emailVerifiedAt: null }) }, 401],
    [request("invalid"), "invalid", options, 404],
    [request(foreign.chart.id), foreign.chart.id, options, 404],
    [request(owner.chart.id, `document=${foreign.document.id}`), owner.chart.id, options, 404],
    [request(owner.chart.id, `document=${randomUUID()}`), owner.chart.id, options, 404],
    ...["document=invalid", `document=${owner.document.id}&edition=chart`, "tier=paid", "locale=es", "edition=premium", "edition=chart&edition=chart"].map(query => [request(owner.chart.id, query), owner.chart.id, options, 400] as [Request, string, ReadingPdfHttpDeps, number]),
    [request(owner.chart.id, "", "POST"), owner.chart.id, options, 405],
  ];
  for (const [req, id, dependencies, expected] of cases) { const response = await handleReadingPdf(req, id, dependencies); assert.equal(response.status, expected, req.url); privateHeaders(response); }
  assert.equal(renders, 0);
});

test("PDF HTTP: canonical saved locale/version, frozen text and pinned filenames ignore UI/plan/notes", async () => {
  const owner = await account("es");
  const history = { ...owner.document, id: randomUUID(), contentVersion: "zz-newest", locale: "en" as const, tier: "paid" as const };
  await db.insert(readingDocuments).values({ id: history.id, readingId: owner.chart.id, locale: "en", tier: "paid", contentVersion: history.contentVersion, chartVersion: history.chartVersion, document: history });
  const before = await readingLedgerSnapshot(owner.viewer.id); let saved = "";
  for (const plan of ["free", "paid"] as const) for (const locale of ["en", "es"] as const) {
    const response = await handleReadingPdf(request(owner.chart.id, `document=${owner.document.id}`), owner.chart.id, { ...deps(owner), locale, user: async () => ({ ...owner.viewer, plan }), notes: async () => { throw Error("must not query notes"); } });
    assert.equal(response.status, 200); privateHeaders(response);
    assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="solara-2026-es-reading.pdf"');
    const text = await response.text(); if (saved) assert.equal(text, saved); saved = text;
    const value = JSON.parse(text); assert.equal(value.content.id, owner.document.id); assert.equal(value.content.locale, "es"); assert.equal(value.content.tier, "free");
    assert.equal(value.content.contentVersion, owner.document.contentVersion); assert.equal(text.includes("MUTABLE_NOTE"), false);
    for (const sentinel of ["fixture-only", "accounting", "birthDate", "failureReason"]) assert.equal(text.includes(sentinel), false);
  }
  assert.equal(await readingLedgerSnapshot(owner.viewer.id), before);
  const wrong = await handleReadingPdf(request(owner.chart.id, `document=${history.id}`), owner.chart.id, deps(owner)); assert.equal(wrong.status, 404);
});

test("PDF HTTP: explicit chart edition keeps legacy subscription notes and does not switch after publication", async () => {
  const owner = await account("en", "none");
  const read = async (paid: boolean) => handleReadingPdf(request(owner.chart.id, "edition=chart"), owner.chart.id, { ...deps(owner), user: async () => ({ ...owner.viewer, plan: paid ? "paid" : "free" }) });
  const a = await (await read(true)).text(); await owner.publish(); const b = await (await read(true)).text(); assert.equal(a, b);
  assert.ok(a.includes("MOON_NOTE")); assert.ok(a.includes('"kind":"chart-notes"'));
  const free = await read(false); assert.ok(free.headers.get("Content-Disposition")?.endsWith('-chart-notes.pdf"')); assert.equal((await free.text()).includes("MOON_NOTE"), false);
});

test("PDF HTTP: corrupt/oversize canonical content is 409 when pinned, never a different document", async () => {
  for (const change of ["identity", "paid", "oversize"] as const) {
    const owner = await account();
    const document = { ...owner.document, ...(change === "identity" ? { locale: "es" as const } : change === "paid" ? { tier: "paid" as const } : { extra: "x".repeat(READING_LIMITS.documentBytes) }) };
    await db.update(readingDocuments).set({ document }).where(eq(readingDocuments.id, owner.document.id));
    const pinned = await handleReadingPdf(request(owner.chart.id, `document=${owner.document.id}`), owner.chart.id, deps(owner)); assert.equal(pinned.status, 409); privateHeaders(pinned);
    const chart = await handleReadingPdf(request(owner.chart.id, "edition=chart"), owner.chart.id, deps(owner)); assert.equal(chart.status, 200);
  }
});

test("PDF HTTP: missing document store is 503, explicit independent chart mode still works", async () => {
  const owner = await account();
  class MissingStore extends ReadingViewStore { override async snapshot(): ReturnType<ReadingViewStore["snapshot"]> { throw Error("PRIVATE_DATABASE_SENTINEL"); } }
  for (const query of ["", `document=${owner.document.id}`]) {
    const response = await handleReadingPdf(request(owner.chart.id, query), owner.chart.id, { ...deps(owner), store: new MissingStore() });
    assert.equal(response.status, 503); privateHeaders(response); assert.equal((await response.text()).includes("PRIVATE_"), false);
  }
  assert.equal((await handleReadingPdf(request(owner.chart.id, "edition=chart"), owner.chart.id, { ...deps(owner), store: new MissingStore() })).status, 200);
});

test("PDF HTTP: deletion/replacement during render discards the bytes and never recreates content", async () => {
  for (const action of ["delete", "replace"] as const) {
    const owner = await account();
    const response = await handleReadingPdf(request(owner.chart.id), owner.chart.id, { ...deps(owner), renderer: { render: async input => {
      if (action === "delete") await db.delete(readings).where(eq(readings.id, owner.chart.id));
      else await db.update(runs).set({ documentId: null }).where(eq(runs.userId, owner.viewer.id));
      return fakeRender(input);
    } } });
    assert.equal(response.status, 404); privateHeaders(response); assert.equal(await response.text(), '{"code":"not_found"}');
  }
});

test("PDF HTTP: safe render/DB errors, private headers and no raw error logs", async () => {
  const owner = await account(); const captured: string[] = []; const warn = console.warn; console.warn = (...args) => captured.push(JSON.stringify(args));
  try {
    for (const code of ["pdf_capacity", "pdf_timeout", "pdf_memory_limit", "pdf_aborted", "pdf_input_limit", "pdf_output_limit", "pdf_page_limit", "pdf_glyphs", "unexpected"] as const) {
      const response = await handleReadingPdf(request(owner.chart.id), owner.chart.id, { ...deps(owner), renderer: { render: async () => { throw code === "unexpected" ? Error("PRIVATE_ERROR_SENTINEL") : new ReadingPdfError(code as PdfFailureCode); } } });
      assert.equal(response.status, ["pdf_input_limit", "pdf_output_limit", "pdf_page_limit", "pdf_glyphs"].includes(code) ? 409 : 503); privateHeaders(response);
      assert.equal((await response.text()).includes("PRIVATE_"), false);
    }
    assert.equal(captured.join().includes("PRIVATE_"), false);
  } finally { console.warn = warn; }
});

test("PDF HTTP: HEAD/prefetch/repeated reads after withdrawal never render HEAD or write the generation ledger", async () => {
  const owner = await account(); await db.insert(consents).values({ userId: owner.viewer.id, locale: "en", revision: 2, withdrawnAt: new Date() });
  const before = await readingLedgerSnapshot(owner.viewer.id); let renders = 0;
  const options = { ...deps(owner), renderer: { render: async (input: ReadingPdfInput) => { renders++; return fakeRender(input); } } };
  const head = await handleReadingPdf(request(owner.chart.id, "", "HEAD"), owner.chart.id, options); assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(renders, 0); privateHeaders(head);
  const prefetch = new Request(request(owner.chart.id), { headers: { purpose: "prefetch", "sec-purpose": "prefetch" } });
  for (const req of [prefetch, request(owner.chart.id), request(owner.chart.id, "edition=chart")]) assert.equal((await handleReadingPdf(req, owner.chart.id, options)).status, 200);
  assert.equal(await readingLedgerSnapshot(owner.viewer.id), before);
});

test("PDF HTTP: real 20/hour PDF quota is independent of status/generation and all 429 responses are private", async () => {
  const owner = await account(); const options = deps(owner); delete options.throttle;
  const before = await readingLedgerSnapshot(owner.viewer.id);
  for (let i = 0; i < 20; i++) assert.equal((await handleReadingPdf(request(owner.chart.id), owner.chart.id, options)).status, 200, `download ${i + 1}`);
  const limited = await handleReadingPdf(request(owner.chart.id), owner.chart.id, options); assert.equal(limited.status, 429); privateHeaders(limited); assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  const status = await handleGeneration(new Request(`http://localhost/api/readings/${owner.chart.id}/generation`), owner.chart.id, { user: async () => owner.viewer, locale: "en" }); assert.equal(status.status, 200);
  assert.equal(await readingLedgerSnapshot(owner.viewer.id), before);
});
