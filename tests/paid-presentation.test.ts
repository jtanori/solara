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
