import assert from "node:assert/strict";
import test from "node:test";
import { readStoredDocument } from "../src/readings/stored-document";
import { readingPreviews, PREVIEW_COPY, NOTICE_COPY } from "../src/readings/presentation-copy";
import { READING_LIMITS, readingEditionQuery, sectionText, ReadingViewError } from "../src/readings/presentation";
import { readingSelector, readChart, chartNotes } from "../src/readings/chart-presentation";
import { generationView, type GenerationViewSource } from "../src/readings/generation-view";
import { calculateSolarReturn } from "../src/lib/solar";
import { SECTION_KEYS, type ReadingDocument } from "../src/readings/types";
import { documentIdentity, frozenReading, readingChartInput } from "./helpers/reading-fixtures";

function decode(document = frozenReading(), options: Parameters<typeof readStoredDocument>[2] = {}) {
  return readStoredDocument(JSON.stringify(document), documentIdentity(document), options);
}
function valid(document = frozenReading(), options: Parameters<typeof readStoredDocument>[2] = {}) {
  const parsed = decode(document, options);
  assert.ok(parsed.ok);
  return parsed.value;
}

for (const locale of ["en", "es"] as const) {
  test(`presentation ${locale}: frozen free content, all blocks, questions, ordering and nine static previews`, () => {
    const document = frozenReading(locale);
    const before = structuredClone(document);
    const content = valid(document);
    assert.deepEqual(content.sections.map(s => s.key), ["overview", "sun"]);
    assert.deepEqual(content.sections[0].blocks.map(b => b.kind), ["prose", "callout", "list", "keyValue", "aspectTable"]);
    for (let i = 0; i < 2; i++) {
      assert.equal(content.sections[i].closingQuestion, document.sections[i].closingQuestion);
      assert.deepEqual(content.sections[i].blocks, document.sections[i].blocks);
    }
    assert.equal(content.locale, locale);
    assert.equal(content.contentVersion, "synthetic-reading-v1");
    assert.equal(content.generatedAt, "2026-01-01T12:00:00.000Z");
    assert.equal(content.partial, false);
    assert.equal(content.previews.length, 9);
    assert.deepEqual(content.previews.filter(p => p.availability === "planned").map(p => p.key), ["planetaryYear", "transits"]);
    assert.deepEqual(content.previews.map(p => p.key), SECTION_KEYS.slice(2));
    assert.deepEqual(document, before);
    assert.equal(readingEditionQuery(content), `document=${document.id}`);
    const text = content.sections.flatMap(sectionText).join("\n");
    assert.match(text, locale === "es" ? /Tauro 25\.1°/ : /Taurus 25\.1°/);
    assert.match(text, /1\.2°/);
    assert.equal(text.includes("fixture-only"), false);
  });

  for (const failed of ["overview", "sun"] as const) {
    test(`presentation ${locale}: ${failed} failure retains sibling and safe saved facts, not stale promises/errors`, () => {
      const content = valid(frozenReading(locale, `partial-${failed}`));
      assert.equal(content.partial, true);
      assert.deepEqual(content.notices, ["partial"]);
      const section = content.sections.find(s => s.key === failed)!;
      assert.equal(section.status, "failed");
      assert.deepEqual(section.notices, ["section_failed"]);
      assert.equal(section.blocks[0].kind, "keyValue");
      assert.equal(section.closingQuestion, undefined);
      assert.equal(content.sections.find(s => s.key !== failed)!.status, "generated");
      const serialized = JSON.stringify(content);
      for (const forbidden of ["private_failure_sentinel", "words will catch up", "failureReason", '"facts"', "accounting", "models"]) assert.equal(serialized.includes(forbidden), false);
      assert.match(NOTICE_COPY.section_failed[locale], locale === "es" ? /No se generará/ : /not be generated/);
    });
  }

  test(`presentation ${locale}: pure paid renderer supports all eleven sections but default reader refuses paid`, () => {
    const document = frozenReading(locale, "paid");
    assert.equal(decode(document).ok, false);
    const content = valid(document, { allowPaid: true });
    assert.deepEqual(content.sections.map(s => s.key), [...SECTION_KEYS]);
    assert.deepEqual(content.previews, []);
    document.sections = document.sections.filter(s => !["planetaryYear", "transits"].includes(s.key));
    assert.equal(valid(document, { allowPaid: true }).sections.length, 9);
  });
}

test("presentation: metadata, archived teaser text and injected extras cannot cross the projection", () => {
  const doc = frozenReading();
  Object.assign(doc, { providerResponse: "raw_secret", account: { email: "raw_secret" } });
  doc.models.overview = "raw_secret";
  doc.accounting!.halt = "raw_secret";
  doc.lockedSections = [{ key: "moon", title: "raw_secret", teaser: "PAID_PROSE_SENTINEL" }];
  Object.assign(doc.sections[0], { failureReason: "raw_secret", privateField: "raw_secret" });
  doc.sections[0].facts = { arbitrary: "raw_secret" };
  const text = JSON.stringify(valid(doc));
  assert.equal(text.includes("raw_secret"), false);
  assert.equal(text.includes("PAID_PROSE_SENTINEL"), false);
  assert.equal(Object.hasOwn(valid(doc), "costMxn"), false);
});

test("presentation: every row/envelope identity dimension must agree, even for otherwise valid JSON", () => {
  const document = frozenReading();
  const expected = documentIdentity(document);
  const mismatches = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", readingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", locale: "es", tier: "paid", chartVersion: "chart/other", contentVersion: "other-version" };
  for (const [key, value] of Object.entries(mismatches)) {
    const result = readStoredDocument(JSON.stringify({ ...document, [key]: value }), expected, { allowPaid: true });
    assert.equal(result.ok, false, key);
  }
});

test("presentation: free tier rejects paid keys, forged section tiers, duplicate/unknown keys, and malformed headers", () => {
  const mutations = [
    (doc: ReadingDocument) => { doc.sections.push(frozenReading("en", "paid").sections[2]); },
    (doc: ReadingDocument) => { doc.sections[0].tier = "paid"; },
    (doc: ReadingDocument) => { doc.sections.push(structuredClone(doc.sections[0])); },
    (doc: ReadingDocument) => { Object.assign(doc.sections[0], { key: "future_section" }); },
    (doc: ReadingDocument) => { doc.sections[0].title = ""; },
    (doc: ReadingDocument) => { Object.assign(doc, { locale: "fr" }); },
    (doc: ReadingDocument) => { doc.generatedAt = "not-a-date"; },
  ];
  for (const mutate of mutations) { const doc = frozenReading(); mutate(doc); assert.equal(decode(doc).ok, false); }
});

test("presentation: unknown block is absent, supported siblings and questions survive; all-unknown is not empty success", () => {
  const document = frozenReading();
  document.sections[0].blocks.splice(1, 0, { kind: "future", text: "DO_NOT_RENDER" } as never);
  const content = valid(document);
  assert.equal(content.sections[0].blocks.length, 5);
  assert.deepEqual(content.sections[0].notices, ["unsupported_blocks"]);
  assert.equal(content.partial, true);
  assert.equal(JSON.stringify(content).includes("DO_NOT_RENDER"), false);
  assert.equal(content.sections[0].closingQuestion, document.sections[0].closingQuestion);
  document.sections[0].blocks = [{ kind: "future", text: "DO_NOT_RENDER" } as never];
  assert.deepEqual(valid(document).sections[0].notices, ["section_unavailable"]);
  document.sections[1].blocks = [];
  assert.equal(decode(document).ok, false);
});

test("presentation: a malformed known block invalidates its section, not a valid sibling", () => {
  const document = frozenReading();
  document.sections[0].blocks = [{ kind: "aspectTable", rows: [{ a: "Sun", b: "Moon", type: "square", orb: 31 }] }];
  const content = valid(document);
  assert.deepEqual(content.sections[0].blocks, []);
  assert.deepEqual(content.sections[0].notices, ["section_unavailable"]);
  assert.equal(content.sections[0].closingQuestion, undefined);
  assert.deepEqual(content.sections[1].blocks, document.sections[1].blocks);
});

test("presentation: absent legacy questions/subtitles are not invented; missing sections are explicit", () => {
  const document = frozenReading();
  delete document.sections[0].subtitle;
  delete document.sections[0].closingQuestion;
  assert.deepEqual(valid(document).sections[0].notices, ["section_unavailable"]);
  const legacy = valid(document, { legacy: true });
  assert.equal(legacy.sections[0].subtitle, undefined);
  assert.equal(legacy.sections[0].closingQuestion, undefined);
  assert.deepEqual(legacy.sections[0].notices, ["legacy_question_missing"]);
  assert.ok(legacy.sections[0].blocks.length);
  assert.equal(legacy.partial, false, "an informational legacy question notice does not mean incomplete content");
  assert.deepEqual(legacy.notices, []);
  document.sections = [document.sections[1]];
  assert.deepEqual(valid(document).notices, ["partial", "missing_sections"]);
});

for (const locale of ["en", "es"] as const) test(`presentation ${locale}: legacy-only notices preserve completeness but degraded sections remain partial`, () => {
  const raw = frozenReading(locale);
  for (const section of raw.sections) delete section.closingQuestion;
  const before = structuredClone(raw);
  const complete = valid(raw, { legacy: true });
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.notices, []);
  for (const section of complete.sections) {
    assert.deepEqual(section.notices, ["legacy_question_missing"]);
    assert.equal(section.closingQuestion, undefined);
    assert.ok(section.blocks.length);
  }
  assert.deepEqual(raw, before, "presentation must not rewrite or invent historical content");
  const changes: ((document: ReadingDocument) => void)[] = [
    document => { document.sections[1].status = "failed"; },
    document => { document.sections[1].blocks.push({ kind: "future", text: "UNSUPPORTED" } as never); },
    document => { document.sections[1].blocks = [{ kind: "prose", text: "" }]; },
    document => { document.sections = [document.sections[0]]; },
  ];
  for (const change of changes) {
    const degraded = structuredClone(raw); change(degraded);
    const content = valid(degraded, { legacy: true });
    assert.equal(content.partial, true, "failed, omitted, malformed or missing content must still be partial");
    assert.ok(content.notices.includes("partial"));
  }
});

test("presentation: failed facts are allowlisted, not arbitrary JSON or forged chart truth", () => {
  const document = frozenReading("en", "partial-sun");
  document.sections[1].facts = { sun: { sign: "SECRET", degree: 900, house: 99 }, key: "SECRET" };
  const content = valid(document);
  assert.deepEqual(content.sections[1].blocks, []);
  assert.equal(JSON.stringify(content).includes("SECRET"), false);
});

test("presentation: byte and aggregate text bounds are independent of per-field bounds", () => {
  const document = frozenReading();
  document.sections[0].blocks = Array.from({ length: 9 }, () => ({ kind: "prose" as const, text: "x".repeat(4000) }));
  assert.deepEqual(decode(document), { ok: false, code: "document_too_large" });
  const oversized = JSON.stringify({ ...frozenReading(), ignored: "ñ".repeat(READING_LIMITS.documentBytes / 2) });
  assert.ok(Buffer.byteLength(oversized) > READING_LIMITS.documentBytes);
  assert.deepEqual(readStoredDocument(oversized, documentIdentity(document)), { ok: false, code: "document_too_large" });
  assert.deepEqual(readStoredDocument("{", documentIdentity(document)), { ok: false, code: "invalid_document" });
});

test("presentation: catalog is honest, complete and never taken from persisted paid text", () => {
  for (const locale of ["en", "es"] as const) {
    assert.equal(readingPreviews(locale).filter(p => p.availability === "not_included").length, 7);
    assert.match(PREVIEW_COPY.notice[locale], locale === "es" ? /no las desbloquea ahora/ : /does not unlock them now/);
    assert.match(PREVIEW_COPY.planned[locale], locale === "es" ? /cálculos adicionales/ : /additional chart calculations/);
  }
});

test("selection: explicit chart/document identity, no silent query overrides or duplicate parameters", () => {
  assert.deepEqual(readingSelector(new URLSearchParams()), { kind: "auto" });
  assert.deepEqual(readingSelector(new URLSearchParams("edition=chart")), { kind: "chart" });
  const id = frozenReading().id;
  assert.deepEqual(readingSelector(new URLSearchParams(`document=${id}`)), { kind: "document", id });
  for (const query of [`document=${id}&edition=chart`, `document=${id}&document=${id}`, "edition=chart&edition=chart", "document=bad", "locale=es", "tier=paid", "version=newest", "edition=paid"]) {
    assert.throws(() => readingSelector(new URLSearchParams(query)), (error: unknown) => error instanceof ReadingViewError && error.code === "invalid_selection", query);
  }
});

test("chart projection: minimal saved fields, bounded notes and explicit legacy entitlement", () => {
  const chart = readChart({ id: frozenReading().readingId, year: 2026, name: readingChartInput.name,
    returnPlace: readingChartInput.returnPlace.name, timezone: readingChartInput.returnPlace.timezone,
    result: calculateSolarReturn(readingChartInput), rawBirthInput: "SECRET" });
  const notes = { sun: "Illustrative Sun", moon: "Extended Moon", ascendant: "Extended Ascendant", house: "Extended house" };
  assert.equal(JSON.stringify(chart).includes("SECRET"), false);
  assert.equal(chartNotes(chart, notes, "en", false).sections.length, 1);
  assert.equal(chartNotes(chart, notes, "en", true).sections.length, 4);
  assert.equal(readingEditionQuery(chartNotes(chart, notes, "en", true)), "edition=chart");
  assert.deepEqual(chartNotes(chart, { ...notes, sun: "x".repeat(4001) }, "en", false).notices, ["notes_unavailable"]);
  assert.throws(() => readChart({ ...chart, timezone: "invalid/timezone" }), ReadingViewError);
});

test("generation view extraction: preserves original status/expiry/tombstone semantics", () => {
  assert.deepEqual(generationView(), { status: "unused", readingId: null, documentId: null, locale: null });
  const run: GenerationViewSource = { readingId: frozenReading().readingId, documentId: null, locale: "es", status: "reserved", consumedAt: null, owner: frozenReading().id, expired: false };
  const cases: [Partial<GenerationViewSource>, ReturnType<typeof generationView>["status"]][] = [
    [{}, "in_progress"], [{ expired: true }, "unused"], [{ owner: null }, "unused"],
    [{ status: "running", consumedAt: new Date(), expired: true }, "indeterminate"],
    [{ status: "running", consumedAt: new Date() }, "in_progress"],
    [{ status: "completed", documentId: frozenReading().id, consumedAt: new Date() }, "completed"],
    [{ status: "partial", documentId: frozenReading().id, consumedAt: new Date() }, "partial"],
    [{ status: "legacy", documentId: frozenReading().id, consumedAt: new Date() }, "completed"],
    [{ status: "failed", consumedAt: new Date() }, "failed"],
    [{ status: "indeterminate", consumedAt: new Date() }, "indeterminate"],
    [{ readingId: null, consumedAt: new Date() }, "free_reading_deleted"],
  ];
  for (const [change, expected] of cases) {
    const view = generationView({ ...run, ...change });
    assert.equal(view.status, expected);
    assert.equal(view.locale, "es");
    assert.equal(Object.hasOwn(view, "owner"), false);
  }
});
