import assert from "node:assert/strict";
import { before, test } from "node:test";
import { execFileSync, fork } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { ReadingPdfRenderer } from "../src/readings/pdf-render";
import { PDF_IPC_CHUNK_BYTES, ReadingPdfError } from "../src/readings/pdf-contract";
import { READING_LIMITS, blockText } from "../src/readings/presentation";
import { NOTICE_COPY, PREVIEW_COPY, readingPreviews } from "../src/readings/presentation-copy";
import { chartNotes } from "../src/readings/chart-presentation";
import { readingBlockSchema } from "../src/readings/schemas";
import { readStoredDocument } from "../src/readings/stored-document";
import type { ReadingBlock } from "../src/readings/types";
import { documentIdentity, frozenReading } from "./helpers/reading-fixtures";
import { inspectPdf, normalizePdfText, pdfFixture } from "./helpers/reading-pdf";

const renderer = new ReadingPdfRenderer();
const snapshotFile = resolve("tests/fixtures/readings/pdf-snapshots.json");
type Snapshot = { text: string; pages: number; visual: (string | null)[] };
const snapshots: Record<string, Snapshot> = process.env.UPDATE_READING_PDF_SNAPSHOTS === "1" ? {} : JSON.parse(readFileSync(snapshotFile, "utf8"));
before(() => { execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "pipe" }); mkdirSync(".venv/pdf-evidence", { recursive: true }); });

for (const locale of ["en", "es"] as const) for (const edition of ["free", "partial-overview", "partial-sun", "paid"] as const) {
  test(`PDF: frozen ${edition}-${locale}, semantic order, glyphs, metadata and fixed-DPI layout`, async () => {
    const input = pdfFixture(locale, edition); const raw = frozenReading(locale, edition);
    const result = await renderer.render(input); assert.equal(result.buffer.subarray(0, 5).toString(), "%PDF-");
    const inspected = await inspectPdf(result.buffer, true);
    assert.equal(result.pages, inspected.pages.length);
    assert.equal(inspected.metadata.Language, locale); assert.equal(inspected.metadata.CreationDate, "D:20260101120000Z");
    assert.ok(inspected.metadata.Title.includes(edition.startsWith("partial") ? (locale === "es" ? "parcial" : "partial") : (locale === "es" ? "guardada" : "Saved")));
    let cursor = 0;
    // Expectations come from frozen source, not just the common projection.
    for (const section of raw.sections) {
      const titleAt = inspected.text.indexOf(section.title, cursor); assert.ok(titleAt >= cursor, section.title); cursor = titleAt + section.title.length;
      if (section.status !== "failed") {
        const first = section.blocks[0];
        if (first?.kind === "prose") {
          const headingPage = inspected.pages.find(page => page.text.includes(section.title));
          assert.ok(headingPage?.text.includes(normalizePdfText(first.text)), "a frozen section heading stays with its opening prose, not only its subtitle");
        }
        for (const text of section.blocks.flatMap(blockText)) {
          const expected = normalizePdfText(text); const at = inspected.text.indexOf(expected, cursor);
          assert.ok(at >= cursor, `${section.key}: ${expected}`); cursor = at + expected.length;
        }
        if (section.closingQuestion) { const at = inspected.text.indexOf(section.closingQuestion, cursor); assert.ok(at >= cursor, section.closingQuestion); cursor = at + section.closingQuestion.length; }
      } else assert.ok(inspected.text.includes(NOTICE_COPY.section_failed[locale]));
    }
    if (edition === "free") {
      for (const preview of readingPreviews(locale)) {
        assert.ok(inspected.text.includes(preview.title)); assert.ok(inspected.text.includes(preview.teaser));
      }
      assert.ok(inspected.text.includes(PREVIEW_COPY.notice[locale]));
      assert.equal((inspected.text.match(new RegExp(PREVIEW_COPY.planned[locale], "g")) ?? []).length, 2);
      assert.ok(inspected.text.includes("1.2°"));
    }
    for (const forbidden of ["PRIVATE_", "FAILED_PRIVATE", "fixture-only", "accounting", "will catch up", "\uFFFD"]) assert.equal(inspected.text.includes(forbidden), false, forbidden);
    inspected.pages.forEach((page, i) => {
      assert.ok(page.allText.includes(`${i + 1} / ${result.pages}`), "visible page number");
      assert.ok(page.text.length > 40, "no empty/near-empty continuation explosion");
      assert.ok(page.items.filter(item => item.text.trim()).every(item => item.x >= 46 && item.x + item.width <= 550 && item.y >= 25 && item.y <= 823), "no off-page text");
      writeFileSync(`.venv/pdf-evidence/${edition}-${locale}-${i + 1}.png`, page.image!);
    });
    const key = `${edition}-${locale}`;
    const actual = { text: inspected.text, pages: result.pages, visual: inspected.pages.map(page => page.visual) };
    if (process.env.UPDATE_READING_PDF_SNAPSHOTS === "1") { snapshots[key] = actual; writeFileSync(snapshotFile, JSON.stringify(snapshots, null, 2) + "\n"); }
    else assert.deepEqual(actual, snapshots[key], "review text/layout diffs rather than silently updating a saved snapshot");
  });
}

test("PDF: repeated rendering stays semantically/visually stable, long legacy notes stay illustrative", async () => {
  const input = pdfFixture("es"); const a = await inspectPdf((await renderer.render(input)).buffer, true); const b = await inspectPdf((await renderer.render(input)).buffer, true);
  assert.equal(a.text, b.text); assert.deepEqual(a.pages.map(page => page.visual), b.pages.map(page => page.visual));
  const notes = { sun: "á é í ó ú ü ñ ¿ ¡ 25.1° — ’ “ ”\n" + "Nota ilustrativa larga. ".repeat(150), moon: "LEGACY_MOON", ascendant: "LEGACY_ASC", house: "LEGACY_HOUSE" };
  for (const extended of [false, true]) {
    const content = chartNotes(input.chart, notes, "es", extended);
    const pdf = await inspectPdf((await renderer.render({ ...input, content })).buffer);
    assert.ok(pdf.text.includes("no son una interpretación generada"));
    assert.ok(pdf.text.includes("á é í ó ú ü ñ ¿ ¡ 25.1° — ’ “ ”"));
    assert.equal(pdf.text.includes("LEGACY_MOON"), extended); assert.equal(pdf.text.includes("LEGACY_ASC"), extended); assert.equal(pdf.text.includes("LEGACY_HOUSE"), extended);
    assert.equal(pdf.text.includes("PREMIUM"), false);
  }
});

test("PDF: long prose, list/keyValue values and a 100-row table split safely with repeated headers", async () => {
  const input = pdfFixture();
  const cells = "LONGROW_" + "abcdefghijklmnop".repeat(180) + "_ENDROW";
  input.content.sections[0].blocks = [
    { kind: "prose", text: "LONGPROSE " + "A measured paragraph. ".repeat(180) + " ENDPROSE" },
    { kind: "list", items: ["LONGITEM " + "A wrapping list item. ".repeat(180) + " ENDITEM"] },
    { kind: "keyValue", entries: [{ key: "KEY_START " + "key ".repeat(300) + "KEY_END", value: "VALUE_START " + "value ".repeat(550) + "VALUE_END" }] },
    { kind: "aspectTable", title: "Long aspects table", rows: Array.from({ length: 100 }, (_, i) => ({ a: i === 25 ? cells : `ROW_${String(i).padStart(3, "0")}`, b: "Moon", type: "square", orb: i / 10 })) },
  ];
  const result = await renderer.render(input); const pdf = await inspectPdf(result.buffer, true);
  assert.ok(result.pages > 5 && result.pages <= READING_LIMITS.pdfPages);
  for (const text of ["LONGPROSE", "ENDPROSE", "LONGITEM", "ENDITEM", "KEY_START", "KEY_END", "VALUE_START", "VALUE_END", "LONGROW_", "_ENDROW", "What practice will you nurture this year?"]) assert.ok(pdf.text.includes(text), text);
  let cursor = 0;
  for (let i = 0; i < 100; i++) if (i !== 25) { const at = pdf.text.indexOf(`ROW_${String(i).padStart(3, "0")}`, cursor); assert.ok(at >= cursor, `row ${i}`); cursor = at; }
  const tablePages = pdf.pages.filter(page => page.text.includes("Long aspects table"));
  assert.ok(tablePages.length >= 4);
  for (const page of tablePages) { assert.ok(page.text.includes("Body With Aspect Orb")); assert.ok(page.items.every(item => !item.text.trim() || item.x + item.width < 551), "long unbroken text fits"); }
  const firstColumn = tablePages.flatMap(page => page.items.filter(item => item.x < 49 && item.y > 130 && item.y < 782).map(item => item.text)).join("").replace(/\s/g, "");
  assert.ok(firstColumn.includes(cells), "all long-row characters survive, no hyphens/truncation");
  tablePages.forEach((page, i) => writeFileSync(`.venv/pdf-evidence/long-table-${i}.png`, page.image!));
});

test("PDF: unsupported glyphs and oversized input fail closed before success/fork", async () => {
  const glyph = pdfFixture(); glyph.chart.name = "未対応";
  await assert.rejects(renderer.render(glyph), (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_glyphs");
  let forked = false;
  const preflight = new ReadingPdfRenderer({ spawn: () => { forked = true; throw Error("must not fork"); } });
  const input = pdfFixture(); input.content.sections[0].blocks = [{ kind: "prose", text: "x".repeat(READING_LIMITS.freeText + 1) }];
  await assert.rejects(preflight.render(input), (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_input_limit"); assert.equal(forked, false);
});

test("PDF: output/memory/deadline caps terminate real workers, then the slot is reusable", async () => {
  for (const [limits, code] of [[{ outputBytes: 100 }, "pdf_output_limit"], [{ rssBytes: 1024 }, "pdf_memory_limit"], [{ deadlineMs: 1 }, "pdf_timeout"]] as const) {
    let pid: number | undefined;
    const worker = new ReadingPdfRenderer({ limits, spawn: (path, options) => { const child = fork(path, [], options); pid = child.pid; return child; } });
    await assert.rejects(worker.render(pdfFixture()), (error: unknown) => error instanceof ReadingPdfError && error.code === code);
    assert.ok(pid); assert.throws(() => process.kill(pid!, 0), /ESRCH/, "actual child is gone before rejection");
    await assert.rejects(worker.render(pdfFixture()), (error: unknown) => error instanceof ReadingPdfError && error.code === code, "slot not leaked");
  }
});

test("PDF: abort and concurrent saturation have no queue and no early slot release", async () => {
  const child = new EventEmitter() as ChildProcess;
  const signals: unknown[] = [];
  child.kill = signal => { signals.push(signal); return true; }; child.send = (() => true) as ChildProcess["send"];
  const abort = new AbortController(); const worker = new ReadingPdfRenderer({ spawn: () => child });
  const active = worker.render(pdfFixture(), abort.signal); const rejected = assert.rejects(active, (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_aborted");
  abort.abort();
  const saturated = worker.render(pdfFixture());
  // Close even a mistakenly admitted second render so a cap/early-release
  // mutant produces an assertion failure rather than hanging the test runner.
  child.emit("close", null); await rejected;
  await assert.rejects(saturated, (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_capacity");
  assert.deepEqual(signals, ["SIGKILL"], "abort kills the actual child, not just its promise");
  const realAbort = new AbortController(); let pid: number | undefined;
  const realWorker = new ReadingPdfRenderer({ spawn: (path, options) => { const process = fork(path, [], options); pid = process.pid; return process; } });
  const pending = realWorker.render(pdfFixture(), realAbort.signal); const realRejected = assert.rejects(pending, (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_aborted");
  realAbort.abort(); await realRejected; assert.throws(() => process.kill(pid!, 0), /ESRCH/);
  await realWorker.render(pdfFixture());
});

test("PDF: bootstrap blocks network/files/child creation and inherits no application secrets", async () => {
  const folder = mkdtempSync(resolve(".venv/pdf-probe-"));
  const old = process.env.PDF_TEST_SECRET; process.env.PDF_TEST_SECRET = "NEVER_INHERIT";
  try {
    cpSync("src/readings/pdf-bootstrap.mjs", `${folder}/bootstrap.mjs`);
    writeFileSync(`${folder}/worker.mjs`, `import fs from 'node:fs'; import http from 'node:http'; import {spawnSync} from 'node:child_process';
process.once('message', async()=> { let network=0,files=0,children=0; try{await fetch('https://example.invalid/font')}catch{network++}try{http.get('http://127.0.0.1:5438')}catch{network++}try{fs.readFileSync('/etc/passwd')}catch{files++}try{spawnSync(process.execPath,['-v'])}catch{children++}
process.send({kind:'chunk',bytes:Buffer.from(JSON.stringify({network,files,children,secret:process.env.PDF_TEST_SECRET,db:process.env.DATABASE_URL}))});process.send({kind:'done',pages:1,peakRss:process.resourceUsage().maxRSS*1024},()=>process.exit(0));});`);
    const result = await new ReadingPdfRenderer({ directory: folder }).render(pdfFixture());
    assert.deepEqual(JSON.parse(result.buffer.toString()), { network: 2, files: 1, children: 1 });
  } finally { if (old === undefined) delete process.env.PDF_TEST_SECRET; else process.env.PDF_TEST_SECRET = old; rmSync(folder, { recursive: true, force: true }); }
});

test("PDF: page-count ceiling rejects a valid-shaped but excessive table report", async () => {
  const input = pdfFixture();
  input.content.sections[0].blocks = Array.from({ length: 9 }, (_, index) => ({ kind: "aspectTable" as const, title: `Excessive table ${index}`, rows: Array.from({ length: 100 }, () => ({ a: "Sun", b: "Moon", type: "square", orb: 1 })) }));
  await assert.rejects(renderer.render(input), (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_page_limit");
});


test("PDF: leading long tables keep section headings with data; all long cells and Spanish titles survive", async () => {
  const input = pdfFixture("es");
  const lead = input.content.sections[0];
  lead.title = "SECCIÓN_INICIO " + "Atención y reflexión. ".repeat(8) + " FIN_TÍTULO";
  const values = ["CELDA_A_" + "ábcdefñ".repeat(350) + "_FIN_A", "CELDA_B_" + "pregunta".repeat(120) + "_FIN_B", "CELDA_C_" + "práctica".repeat(100) + "_FIN_C"];
  const tableTitle = "TABLA_INICIO " + "Posiciones y vínculos. ".repeat(7) + " FIN_TABLA";
  lead.blocks = [{ kind: "aspectTable", title: tableTitle, rows: Array.from({ length: 35 }, (_, i) => ({ a: i === 1 ? values[0] : `FILA_${String(i).padStart(2, "0")}`, b: i === 1 ? values[1] : "Luna", type: i === 1 ? values[2] : "cuadratura", orb: 25.1 })) }];
  assert.ok(readingBlockSchema.safeParse(lead.blocks[0]).success);
  const result = await renderer.render(input); const pdf = await inspectPdf(result.buffer, true);
  const tables = pdf.pages.filter(page => page.text.includes("TABLA_INICIO"));
  writeFileSync(".venv/pdf-evidence/leading-table-es-items.json", JSON.stringify(tables.map(page => page.items), null, 2));
  assert.ok(tables.length > 2);
  const firstHeading = pdf.pages.find(page => page.text.includes("SECCIÓN_INICIO"));
  assert.ok(firstHeading?.text.includes("FILA_00"), "no heading-only page before a leading table");
  for (const page of tables) {
    assert.ok(page.text.includes(normalizePdfText(lead.title)) && page.text.includes(normalizePdfText(tableTitle)));
    assert.ok(page.text.includes("Cuerpo Con Aspecto Orbe"));
    assert.ok(page.items.every(item => !item.text.trim() || item.x + item.width <= 550));
    assert.equal(page.items.some(item => item.text.trim() && item.y > 778 && item.y < 796), false, "no table/footer overlap");
  }
  for (const [column, expected] of values.entries()) {
    const x = 48 + column * (499.28 * 0.28);
    const text = tables.flatMap(page => page.items.filter(item => Math.abs(item.x - x) < 1 && item.y > page.items.find(item => item.text === "Cuerpo")!.y + 10 && item.y < 778).map(item => item.text)).join("").replace(/\s/g, "");
    assert.ok(text.includes(expected), `all characters survive in column ${column}`);
  }
  assert.ok(pdf.text.includes("25.1°")); assert.ok(pdf.text.includes(lead.closingQuestion!));
  tables.forEach((page, i) => writeFileSync(`.venv/pdf-evidence/leading-table-es-${i + 1}.png`, page.image!));
});

test("PDF: over-page callouts, twenty list items, long names/versions and high-latitude omissions stay readable", async () => {
  const input = pdfFixture("es");
  input.chart.name = "Ángela María ".repeat(14).trim(); input.chart.returnPlace = "Ubicación ilustrativa ".repeat(15).trim();
  input.chart.result.ascendant = null; input.chart.result.sunHouse = null;
  if (input.content.kind === "saved-reading") input.content.contentVersion = "versión_larga_".repeat(9);
  input.content.sections[0].blocks = [
    { kind: "callout", title: "Una práctica larga", text: "COMIENZO_AVISO " + "¿Qué cuidarás?\n".repeat(180) + " FINAL_AVISO" },
    { kind: "list", title: "Veinte pasos", items: Array.from({ length: 20 }, (_, i) => `PASO_${i} ` + "atención al presente ".repeat(12) + ` FIN_${i}`) },
    { kind: "prose", text: '<script>alert("plain text")</script> https://example.invalid/not-a-link' },
  ];
  input.content.sections[0].blocks.forEach(block => assert.ok(readingBlockSchema.safeParse(block).success));
  const result = await renderer.render(input); const pdf = await inspectPdf(result.buffer, true);
  assert.ok(result.pages < 25);
  assert.ok(pdf.text.includes(normalizePdfText(input.chart.name))); assert.ok(pdf.text.includes(normalizePdfText(input.chart.returnPlace)));
  assert.ok(pdf.text.includes("No disponible · Latitud alta")); assert.ok(pdf.text.includes("COMIENZO_AVISO")); assert.ok(pdf.text.includes("FINAL_AVISO"));
  assert.equal((pdf.text.match(/¿Qué cuidarás\?/g) ?? []).length, 180);
  let cursor = 0;
  for (let i = 0; i < 20; i++) { const at = pdf.text.indexOf(`PASO_${i} `, cursor); assert.ok(at >= cursor); cursor = pdf.text.indexOf(`FIN_${i}`, at); assert.ok(cursor > at); }
  assert.ok(pdf.text.includes('<script>alert("plain text")</script>')); assert.ok(pdf.text.includes("https://example.invalid/not-a-link"));
  assert.ok(pdf.pages.every(page => page.annotations.length === 0), "URL-looking prose never becomes a PDF link/action");
  for (const page of pdf.pages) {
    assert.ok(page.text.length > 40); assert.ok(page.items.every(item => !item.text.trim() || item.x + item.width <= 550));
  }
  pdf.pages.forEach((page, i) => writeFileSync(`.venv/pdf-evidence/long-callout-es-${i + 1}.png`, page.image!));
});

test("PDF: the frozen paid fixtures also cover the nine current-capability topics in both locales", async () => {
  for (const locale of ["en", "es"] as const) {
    const input = pdfFixture(locale, "paid");
    input.content.sections = input.content.sections.filter(section => !["planetaryYear", "transits"].includes(section.key));
    assert.equal(input.content.sections.length, 9);
    const pdf = await inspectPdf((await renderer.render(input)).buffer);
    for (const section of input.content.sections) assert.ok(pdf.text.includes(section.title));
    for (const omitted of frozenReading(locale, "paid").sections.filter(section => ["planetaryYear", "transits"].includes(section.key))) assert.equal(pdf.text.includes(omitted.title), false);
  }
});

test("PDF: broken IPC and synchronous send errors kill the child and do not leak the render slot", async () => {
  for (const mode of ["send-throws", "oversize-chunk", "bad-message"] as const) {
    let kills = 0;
    const worker = new ReadingPdfRenderer({ spawn: () => {
      const child = new EventEmitter() as ChildProcess;
      child.kill = () => { kills++; queueMicrotask(() => child.emit("close", null)); return true; };
      child.send = (() => {
        if (mode === "send-throws") throw Error("PRIVATE_IPC_ERROR");
        queueMicrotask(() => child.emit("message", mode === "oversize-chunk" ? { kind: "chunk", bytes: new Uint8Array(PDF_IPC_CHUNK_BYTES + 1) } : { kind: "invalid" }));
        return true;
      }) as ChildProcess["send"];
      return child;
    } });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(worker.render(pdfFixture()), (error: unknown) => error instanceof ReadingPdfError && error.code === (mode === "oversize-chunk" ? "pdf_output_limit" : "pdf_unavailable"));
    assert.equal(kills, 2);
  }
});


test("PDF: unknown payload is absent while supported siblings, questions and compatibility notices remain", async () => {
  const raw = frozenReading();
  raw.sections[0].blocks.splice(1, 0, { kind: "future", text: "UNKNOWN_PRIVATE_SENTINEL" } as unknown as ReadingBlock);
  const decoded = readStoredDocument(JSON.stringify(raw), documentIdentity(raw)); assert.ok(decoded.ok);
  const input = pdfFixture(); input.content = decoded.value;
  const pdf = await inspectPdf((await renderer.render(input)).buffer);
  for (const required of ["Make time for a quiet moment each week.", raw.sections[0].closingQuestion!, NOTICE_COPY.unsupported_blocks.en]) assert.ok(pdf.text.includes(required));
  for (const forbidden of ["UNKNOWN_PRIVATE_SENTINEL", "fixture-only", "accounting", "models"]) assert.equal(pdf.text.includes(forbidden), false);
});


test("PDF: parent RSS monitoring interrupts a worker whose own JavaScript never yields", async () => {
  const folder = mkdtempSync(resolve(".venv/pdf-busy-probe-")); let pid: number | undefined;
  try {
    cpSync("src/readings/pdf-bootstrap.mjs", `${folder}/bootstrap.mjs`);
    writeFileSync(`${folder}/worker.mjs`, "process.once('message', () => { for (;;) {} });");
    const worker = new ReadingPdfRenderer({ directory: folder, limits: { rssBytes: 1024, deadlineMs: 2000 }, spawn: (path, options) => { const child = fork(path, [], options); pid = child.pid; return child; } });
    await assert.rejects(worker.render(pdfFixture()), (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_memory_limit");
    assert.ok(pid); assert.throws(() => process.kill(pid!, 0), /ESRCH/);
  } finally { if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already terminated is the expected outcome. */ } } rmSync(folder, { recursive: true, force: true }); }
});

test("PDF/HTML: actual canonical reads stay frozen when mutable editorial notes change", { skip: process.env.RUN_INTEGRATION_TESTS !== "1" }, async () => {
  const [{ syntheticReadingAccount, readingLedgerSnapshot }, { loadReadingPresentation }, { getReadingNotes }, { createTempDatabase }, { drizzle }, { contentKey }, { pool, coordinationPool }, React, { renderToStaticMarkup }, { ReadingContentView }] = await Promise.all([
    import("./helpers/reading-account"), import("../src/readings/reading-view"), import("../src/lib/reading-content"), import("./temp-database"), import("drizzle-orm/node-postgres"), import("../src/lib/content"), import("../src/db"), import("react"), import("react-dom/server"), import("../src/components/reading-sections"),
  ]);
  const owner = await syntheticReadingAccount(); const temporary = await createTempDatabase();
  try {
    await temporary.client.query("create table knowledge (key text primary key, body text not null)");
    const key = contentKey("sun", owner.chart.result.natalSun.sign, "en");
    await temporary.client.query("insert into knowledge values ($1,$2)", [key, "MUTABLE_NOTE_BEFORE"]);
    const notesDb = drizzle(temporary.client);
    const options = { notes: (chart: Parameters<typeof getReadingNotes>[0], locale: "en" | "es") => getReadingNotes(chart, locale, notesDb) };
    const before = await readingLedgerSnapshot(owner.viewer.id); let firstHtml = ""; let firstText = "";
    for (const text of ["MUTABLE_NOTE_BEFORE", "MUTABLE_NOTE_AFTER"]) {
      await temporary.client.query("update knowledge set body = $1 where key = $2", [text, key]);
      const view = await loadReadingPresentation(owner.viewer, owner.chart.id, "en", { kind: "document", id: owner.document.id }, options);
      const html = renderToStaticMarkup(React.createElement(ReadingContentView, { content: view.content }));
      const pdf = await inspectPdf((await renderer.render({ chart: view.chart, content: view.content })).buffer);
      assert.equal(html.includes("MUTABLE_NOTE"), false); assert.equal(pdf.text.includes("MUTABLE_NOTE"), false);
      assert.ok(html.includes(owner.document.sections[0].closingQuestion!)); assert.ok(pdf.text.includes(owner.document.sections[0].closingQuestion!));
      if (firstHtml) { assert.equal(html, firstHtml); assert.equal(pdf.text, firstText); }
      firstHtml = html; firstText = pdf.text;
    }
    const chart = await loadReadingPresentation(owner.viewer, owner.chart.id, "en", { kind: "chart" }, options);
    assert.ok(JSON.stringify(chart.content).includes("MUTABLE_NOTE_AFTER"), "the note really changed in its independent edition");
    assert.equal(await readingLedgerSnapshot(owner.viewer.id), before);
  } finally { await temporary.cleanup(); await owner.cleanup(); await Promise.all([pool.end(), coordinationPool.end()]); }
});
