import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LockedSectionCard, ReadingBlockView, ReadingContentView, ReadingSectionView } from "../src/components/reading-sections";
import { ReadingPageView } from "../src/components/reading-page-view";
import { readStoredDocument } from "../src/readings/stored-document";
import { chartNotes } from "../src/readings/chart-presentation";
import { readingPreviews, PREVIEW_COPY, NOTICE_COPY } from "../src/readings/presentation-copy";
import type { DisplaySection, ReadingChart, ReadingPresentation } from "../src/readings/presentation";
import type { ReadingBlock } from "../src/readings/types";
import { calculateSolarReturn } from "../src/lib/solar";
import { documentIdentity, frozenReading, readingChartInput } from "./helpers/reading-fixtures";

const h = React.createElement;
const render = (element: React.ReactElement) => renderToStaticMarkup(element);
function section(overrides: Partial<DisplaySection> = {}): DisplaySection {
  return { key: "overview", tier: "free", title: "The Year in One Breath", subtitle: "Saved subtitle", blocks: [{ kind: "prose", text: "Sun in Leo, third house." }], status: "generated", notices: [], ...overrides };
}
function saved(locale: "en" | "es" = "en", edition: Parameters<typeof frozenReading>[1] = "free") {
  const raw = frozenReading(locale, edition);
  const decoded = readStoredDocument(JSON.stringify(raw), documentIdentity(raw), { allowPaid: true });
  assert.ok(decoded.ok);
  return decoded.value;
}
const chart: ReadingChart = { id: frozenReading().readingId!, year: 2026, name: "Synthetic Reading", returnPlace: "New York", timezone: "America/New_York", result: calculateSolarReturn(readingChartInput) };

test("HTML: every real block kind renders semantic content, no invented vocabulary", () => {
  const cases: [ReadingBlock, string][] = [
    [{ kind: "prose", text: "A saved paragraph." }, "A saved paragraph."],
    [{ kind: "callout", title: "Practice", text: "Twenty minutes a week." }, "<aside"],
    [{ kind: "list", title: "Practices", items: ["Mind: three lines", "Body: a weekly ritual"] }, "<li>Body: a weekly ritual</li>"],
    [{ kind: "keyValue", title: "Your chart", entries: [{ key: "Sun", value: "Leo 12°" }] }, "<dd"],
    [{ kind: "aspectTable", title: "Tightest", rows: [{ a: "Sun", b: "Moon", type: "square", orb: 1.2 }] }, "1.2°"],
  ];
  for (const [block, expected] of cases) assert.ok(render(h(ReadingBlockView, { block, locale: "en" })).includes(expected), block.kind);
  const table = render(h(ReadingBlockView, { block: cases[4][0], locale: "es" }));
  for (const value of ["display:table-caption", "<caption", 'scope="col"', "Cuerpo", "Con", "Aspecto", "Orbe"]) assert.ok(table.includes(value));
  for (const kind of ["paragraph", "heading", "bullets", "highlight"]) assert.equal(render(h(ReadingBlockView, { block: { kind, text: "never" } as unknown as ReadingBlock, locale: "en" })), "");
});

test("HTML: saved titles, optional subtitle absence, questions, order and statuses survive", () => {
  const html = render(h(ReadingSectionView, { locale: "es", section: section({ subtitle: undefined, closingQuestion: "¿Qué práctica cuidarás?", status: "overridden" }) }));
  for (const text of ["The Year in One Breath", "¿Qué práctica cuidarás?", 'data-status="overridden"', 'aria-labelledby="reading-section-overview"']) assert.ok(html.includes(text));
  assert.equal(html.includes("De qué va este año"), false, "no current-copy subtitle substitution");
  const content = saved("es");
  const document = render(h(ReadingContentView, { content }));
  assert.ok(document.includes('lang="es"'));
  assert.ok(document.includes('data-content-version="synthetic-reading-v1"'));
  assert.ok(document.indexOf(content.sections[0].title) < document.indexOf(content.sections[1].title));
  assert.ok(document.includes("¿Dónde quieres invertir tu energía?"));
});

test("HTML: decoder omits unknown payload, retains valid siblings and discloses incompatibility", () => {
  const raw = frozenReading();
  raw.sections[0].blocks.splice(1, 0, { kind: "paragraph", text: "UNKNOWN_PAYLOAD_SENTINEL" } as unknown as ReadingBlock);
  const decoded = readStoredDocument(JSON.stringify(raw), documentIdentity(raw)); assert.ok(decoded.ok);
  const html = render(h(ReadingContentView, { content: decoded.value }));
  assert.equal(html.includes("UNKNOWN_PAYLOAD_SENTINEL"), false);
  assert.ok(html.includes("Make time for a quiet moment each week."));
  assert.ok(html.includes("this viewer does not support"));
});

test("HTML: failed content and internals never render; safe facts and truthful notice do", () => {
  const raw = frozenReading("en", "partial-sun");
  raw.sections[1].failureReason = "PRIVATE_FAILURE_SENTINEL";
  raw.sections[1].blocks = [{ kind: "prose", text: "the words will catch up PRIVATE_PROSE_SENTINEL" }];
  const decoded = readStoredDocument(JSON.stringify(raw), documentIdentity(raw)); assert.ok(decoded.ok);
  const html = render(h(ReadingContentView, { content: decoded.value }));
  assert.ok(html.includes("This section was not completed."));
  assert.ok(html.includes("Saved chart facts"));
  for (const text of ["PRIVATE_", "will catch up", "fixture-only", "accounting", "failureReason"]) assert.equal(html.includes(text), false, text);
});

test("HTML: malicious markup is plain escaped text, not links/scripts", () => {
  const html = render(h(ReadingSectionView, { locale: "en", section: section({ title: '<img src=x onerror="alert(1)">', blocks: [{ kind: "prose", text: '<script>alert(1)</script> https://example.invalid/private' }] }) }));
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(html.includes("&lt;img"));
  assert.equal(html.includes("<script"), false); assert.equal(html.includes("<img"), false); assert.equal(html.includes('href="https:'), false);
});

for (const locale of ["en", "es"] as const) test(`HTML: nine truthful static previews in ${locale}, no immediate unlock purchase`, () => {
  const content = saved(locale); const html = render(h(ReadingContentView, { content }));
  assert.equal((html.match(/data-locked=/g) ?? []).length, 9);
  assert.equal((html.match(/data-availability="planned"/g) ?? []).length, 2);
  assert.ok(html.includes(PREVIEW_COPY.notice[locale]));
  assert.equal((html.match(/href="\/pricing"/g) ?? []).length, 1);
  assert.equal(/blur|Unlock|Desbloquear/.test(html), false);
  const preview = render(h(LockedSectionCard, { locked: readingPreviews(locale).find(entry => entry.key === "transits")!, locale }));
  assert.ok(preview.includes(PREVIEW_COPY.planned[locale]));
});

test("page: PDF identity stays pinned across UI locale/plan, explicit chart edition remains separate", () => {
  const content = saved("es");
  const view: ReadingPresentation = { chart, content, generation: null, availability: "ready" };
  const html = render(h(ReadingPageView, { view, locale: "en", selector: { kind: "auto" } }));
  assert.ok(html.includes(`/api/readings/${chart.id}/pdf?document=${content.id}`));
  assert.ok(html.includes(`/reading/${chart.id}?edition=chart`));
  assert.ok(html.includes("The saved interpretation is in Español."));
  assert.ok(html.includes("Decorative wheel, not a plot"));
  for (const leak of ["birthDate", "birthPlace", "-115.4747", "32.6393", "fixture-only", "Download full PDF", "YOUR PREMIUM READING"]) assert.equal(html.includes(leak), false, leak);
  const notes = chartNotes(chart, { sun: "SUN_NOTE", moon: "MOON_NOTE", ascendant: "ASC_NOTE", house: "HOUSE_NOTE" }, "en", true);
  const legacy = render(h(ReadingPageView, { view: { ...view, content: notes, availability: "chart_only" }, locale: "en", selector: { kind: "chart" } }));
  for (const included of ["SUN_NOTE", "MOON_NOTE", "ASC_NOTE", "HOUSE_NOTE", "not a generated interpretation", "pdf?edition=chart"]) assert.ok(legacy.includes(included), included);
  assert.equal(legacy.includes("Generated Premium"), false);
  assert.equal(html.includes("SUN_NOTE"), false);
});

for (const locale of ["en", "es"] as const) {
  test(`page: explicit chart edition omits AI controls and keeps canonical navigation in ${locale}`, () => {
    // Match the intentional snapshot-independent explicit-chart result. Even an
    // apparently unused chart must not mount the supplied client controls here.
    const view: ReadingPresentation = { chart, content: chartNotes(chart, { sun: "ILLUSTRATIVE_NOTE", moon: "", ascendant: "", house: "" }, locale, false), generation: null, availability: "chart_only" };
    const controls = h("section", { "aria-label": "AI consent" }, h("button", {}, "GENERATION_CONTROLS_SENTINEL"));
    const html = render(h(ReadingPageView, { view, locale, selector: { kind: "chart" }, controls }));
    assert.equal(html.includes("GENERATION_CONTROLS_SENTINEL"), false, "explicit chart edition must not mount AI controls");
    assert.equal(html.includes('aria-label="AI consent"'), false);
    assert.ok(html.includes(`href="/reading/${chart.id}"`), "the canonical page remains reachable without generation");
    assert.ok(html.includes(`href="/api/readings/${chart.id}/pdf?edition=chart"`));
    assert.ok(html.includes("ILLUSTRATIVE_NOTE"));
    const canonical = render(h(ReadingPageView, { view, locale, selector: { kind: "auto" }, controls }));
    assert.ok(canonical.includes("GENERATION_CONTROLS_SENTINEL"), "ordinary unused-chart controls are not removed globally");
  });

  test(`HTML: complete legacy reading keeps the question notice without partial labels in ${locale}`, () => {
    const raw = frozenReading(locale);
    for (const section of raw.sections) delete section.closingQuestion;
    const decoded = readStoredDocument(JSON.stringify(raw), documentIdentity(raw), { legacy: true });
    assert.ok(decoded.ok);
    const html = render(h(ReadingPageView, { view: { chart, content: decoded.value, generation: null, availability: "ready" }, locale, selector: { kind: "auto" } }));
    assert.ok(html.includes(NOTICE_COPY.legacy_question_missing[locale]));
    assert.equal(html.includes(NOTICE_COPY.partial[locale]), false, "legacy-only notice must not produce the partial banner");
    assert.equal(html.includes(locale === "es" ? "Interpretación parcial guardada" : "Saved partial interpretation"), false);
  });
}

for (const locale of ["en", "es"] as const) test(`HTML: all eleven synthetic paid sections render in ${locale}, without a production paid selector`, () => {
  const content = saved(locale, "paid"); const html = render(h(ReadingContentView, { content }));
  assert.equal((html.match(/data-section=/g) ?? []).length, 11);
  assert.equal((html.match(/data-locked=/g) ?? []).length, 0);
  assert.ok(html.includes('data-section="planetaryYear"')); assert.ok(html.includes('data-section="transits"'));
});
