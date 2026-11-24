import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pool, coordinationPool } from "../src/db";
import { ReadingPageView } from "../src/components/reading-page-view";
import { ReadingPdfRenderer } from "../src/readings/pdf-render";
import { handleReadingPdf } from "../src/readings/pdf-http";
import { loadReadingPresentation } from "../src/readings/reading-view";
import { projectWheel, wheelAngle } from "../src/lib/wheel";
import { PAID_PROFILES, paidSections } from "../src/readings/paid-contract";
import { blockText } from "../src/readings/presentation";
import { syntheticReadingAccount, readingLedgerSnapshot } from "./helpers/reading-account";
import { syntheticPaidEdition } from "./helpers/paid-edition";
import { inspectPdf, normalizePdfText } from "./helpers/reading-pdf";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires disposable local PostgreSQL and RUN_INTEGRATION_TESTS=1" };
before(() => { if (enabled) execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "pipe" }); });
after(async () => { await Promise.all([pool.end(), coordinationPool.end()]); });
for (const profile of PAID_PROFILES) for (const locale of ["en", "es"] as const) for (const partial of [false, true]) test(`paid presentation: real HTML/PDF ${profile}/${locale}/${partial ? "partial" : "complete"} uses one pinned immutable Placidus calculation and manifest`, gated, async () => {
  const owner = await syntheticReadingAccount("en");
  try {
    const edition = await syntheticPaidEdition(owner, locale, partial, profile); const before = await readingLedgerSnapshot(owner.viewer.id);
    const selector = { kind: "paid" as const, id: edition.document.id }; const uiLocale = locale === "en" ? "es" : "en";
    const view = await loadReadingPresentation(owner.viewer, owner.chart.id, uiLocale, selector);
    assert.equal(view.content.kind, "saved-reading"); if (view.content.kind !== "saved-reading") return;
    assert.equal(view.content.partial, partial); assert.equal(view.content.sections.length, paidSections(profile).length);
    const html = renderToStaticMarkup(createElement(ReadingPageView, { view, locale: uiLocale, selector }));
    assert.ok(html.includes(`paidEdition=${edition.document.id}`)); assert.ok(html.includes(`data-document-id="${edition.document.id}"`)); assert.ok(html.includes(`lang="${locale}"`));
    assert.equal(html.includes("data-locked"), false);
    const response = await handleReadingPdf(new Request(`http://localhost/api/readings/${owner.chart.id}/pdf?paidEdition=${edition.document.id}`), owner.chart.id, {
      user: async () => owner.viewer, locale: uiLocale, throttle: async () => null, renderer: new ReadingPdfRenderer(),
    });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.ok(response.headers.get("content-disposition")?.includes(`-${locale}-`));
    const inspected = await inspectPdf(Buffer.from(await response.arrayBuffer()), true);
    assert.equal(inspected.metadata.Language, locale); assert.ok(inspected.text.includes("Placidus"));
    assert.ok(inspected.metadata.Title.includes(partial ? (locale === "es" ? "parcial" : "partial") : (locale === "es" ? "guardada" : "Saved")));
    // The pinned Placidus facts reach the *presentation*, and the page draws its wheel from
    // them: this is the paid edition that used to fall through to "saved before complete
    // positions were recorded" because its facts were looked for on the stripped chart.
    assert.ok(view.wheelFacts, "the paid presentation carries its verified facts");
    assert.equal(view.wheelFacts!.houseSystem, "placidus");
    assert.equal(html.includes('data-wheel-system="placidus"'), true, "the paid page draws a Placidus wheel");
    // `uiLocale` is deliberately the *opposite* of the edition's language, so this is the
    // divergent case: the wheel's text is in `locale`, and the subtree that holds it must
    // say so — otherwise a screen reader reads a Spanish chart name with English phonetics.
    const cell = /<div class="chart-cell"([^>]*)>/.exec(html);
    assert.ok(cell, "the wheel sits in its own cell");
    assert.equal(/lang="([a-z]{2})"/.exec(cell![1]!)?.[1], locale, "the wheel subtree declares the edition's language");
    assert.notEqual(locale, uiLocale);
    // The UI notices beside it stay in the interface's language.
    assert.ok(html.includes(uiLocale === "es" ? "Este cálculo es preliminar" : "This is a preliminary calculation"),
      "adjacent UI copy is the interface's language");
    const pageWheel = projectWheel(view.wheelFacts!, locale);
    assert.ok(pageWheel, "the pinned snapshot projects");
    // The drawn anchors are the snapshot's longitudes, projected — not a re-cast for this
    // view. Each point is checked against the angle its own saved longitude produces.
    assert.equal(pageWheel.points.length, 14);
    const anchorLongitude = view.wheelFacts!.angles.ascendant!.longitude;
    for (const point of pageWheel.points) {
      // Every plotted anchor sits on the outer ring at its own plotted angle…
      assert.ok(Math.abs(point.anchor.x - (220 + pageWheel.radii.outer * Math.cos(point.angle * Math.PI / 180))) < 1e-2, point.id);
      assert.ok(Math.abs(point.anchor.y - (220 + pageWheel.radii.outer * Math.sin(point.angle * Math.PI / 180))) < 1e-2, point.id);
      // …and that angle is the snapshot's longitude, rotated so the Ascendant is due west.
      // The South Node is stored as the point opposite the True Node, so its plotted
      // longitude is its own stored one, exactly as the geometry derives it.
      const saved = point.kind === "body" ? view.wheelFacts!.bodies.find(body => body.body === point.id)?.longitude
        : point.kind === "angle" ? (point.id === "Ascendant" ? view.wheelFacts!.angles.ascendant?.longitude : view.wheelFacts!.angles.midheaven?.longitude)
        : point.id === "TrueNode" ? view.wheelFacts!.nodes.trueNode.longitude : view.wheelFacts!.nodes.southNode.longitude;
      if (saved === undefined || saved === null) continue;
      assert.ok(Math.abs(point.longitude - saved) < 1e-6, `${point.id}: plotted longitude ${point.longitude} is the saved ${saved}`);
      const angle = wheelAngle(saved, anchorLongitude);
      assert.ok(Math.abs(point.angle - angle) < 1e-3, `${point.id}: plotted at ${point.angle}°, saved ${saved}° → ${angle}°`);
    }
    assert.deepEqual(pageWheel.points.find(point => point.id === "Ascendant")!.anchor,
      { x: 220 - pageWheel.radii.outer, y: 220 }, "the Ascendant is drawn at its own longitude");
    // And the false notice is gone in the reader's language.
    assert.equal(html.includes(locale === "es" ? "no están disponibles" : "Complete saved positions are not available"), false);
    for (const block of view.chart.calculation ?? []) for (const text of blockText(block)) assert.ok(inspected.text.includes(normalizePdfText(text)), text);
    let cursor = 0;
    for (const section of view.content.sections) {
      const at = inspected.text.indexOf(section.title, cursor); assert.ok(at >= cursor); cursor = at + section.title.length;
      for (const text of section.blocks.flatMap(blockText)) { assert.ok(inspected.text.includes(normalizePdfText(text))); assert.ok(html.includes(text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;"))); }
    }
    assert.ok(inspected.pages.length <= 40); assert.ok(inspected.pages.every(page => page.text.length > 40));
    for (const page of inspected.pages) assert.ok(page.items.filter(item => item.text.trim()).every(item => item.x >= 46 && item.x + item.width <= 550 && item.y >= 25 && item.y <= 823), "paid fact tables and prose stay on-page");
    for (const secret of ["fixture-only", "PRIVATE_SYNTHETIC_FAILURE", "policyHash", "birthDate", "accounting"]) { assert.equal(inspected.text.includes(secret), false); assert.equal(html.includes(secret), false); }
    assert.equal(await readingLedgerSnapshot(owner.viewer.id), before, "paid viewing cannot rewrite any lifetime-free state");
  } finally { await owner.cleanup(); }
});
