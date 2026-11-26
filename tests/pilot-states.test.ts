import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { coordinationPool, db, pool } from "../src/db";
import { readingDocuments } from "../src/db/schema";
import { ReadingPageView } from "../src/components/reading-page-view";
import type { ChartInput } from "../src/lib/types";
import { buildReadingDocument, persistableDocument, type SectionResult } from "../src/readings/document";
import { calculatePaidSnapshot, paidDigest } from "../src/readings/paid-chart";
import { paidSections, type PaidProfile } from "../src/readings/paid-contract";
import { NOTICE_COPY } from "../src/readings/presentation-copy";
import { loadReadingPresentation } from "../src/readings/reading-view";
import { readStoredDocument } from "../src/readings/stored-document";
import { loadChartCorpus } from "../scripts/lib/chart-corpus";
import { syntheticPaidEdition } from "./helpers/paid-edition";
import { blockAt, loadPilotStructures, resultsFor } from "./helpers/pilot-structure";
import { readingLedgerSnapshot, syntheticReadingAccount } from "./helpers/reading-account";

/*
 * #225 / A3: the 10/11 pilot structure renders the honest partial state, and the document boundary
 * it depends on is asserted directly: one failed section must still be persistable and carry both
 * notices, while a run with no generated section must never become a saved edition.
 */

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" };
after(async () => {
  if (enabled) await Promise.all([pool.end(), coordinationPool.end()]);
});

type PilotStates = { partial: { pilot: string; profile: PaidProfile; failedSection: string } };

const structure = loadPilotStructures();
const states = JSON.parse(readFileSync("tests/fixtures/readings/pilot-states-v1.json", "utf8")) as PilotStates;

async function assertPartialState(profile: PaidProfile, locale: "en" | "es", input: ChartInput, results: SectionResult[], failedSection: string) {
  const owner = await syntheticReadingAccount(locale, "none", { input });
  try {
    const edition = await syntheticPaidEdition(owner, locale, true, profile, { results, allowAnySyntheticInput: true });
    const selector = { kind: "paid" as const, id: edition.document.id };
    const before = await readingLedgerSnapshot(owner.viewer.id);

    const view = await loadReadingPresentation(owner.viewer, owner.chart.id, "en", selector);
    assert.equal(view.content.kind, "saved-reading");
    if (view.content.kind !== "saved-reading") return;
    assert.equal(view.content.partial, true);
    assert.ok(view.content.notices.includes("partial"));
    assert.equal(view.generation, null, "a paid edition offers no free regeneration control");

    const failed = view.content.sections.find(section => section.key === failedSection);
    assert.ok(failed, `${failedSection} is present`);
    assert.equal(failed?.status, "failed");
    assert.ok(failed?.notices.includes("section_failed"));

    const html = renderToStaticMarkup(createElement(ReadingPageView, { view, locale: "en", selector }));
    assert.ok(html.includes(NOTICE_COPY.partial[locale]), "partial notice in the saved edition's language");
    assert.ok(html.includes(NOTICE_COPY.section_failed[locale]), "failed-section notice in the saved edition's language");

    const after = await readingLedgerSnapshot(owner.viewer.id);
    assert.equal(after, before, "rendering a partial edition does not reset the allowance or change the ledger");

    const canonical = await db.select({ id: readingDocuments.id }).from(readingDocuments).where(eq(readingDocuments.readingId, owner.chart.id));
    assert.equal(canonical.length, 0, "the partial edition is not promoted to a canonical document");

    await owner.cleanup();
  } catch (error) {
    await owner.cleanup();
    throw error;
  }
}

test("the 10/11 pilot structure renders the partial state honestly", gated, async () => {
  const row = structure.cases.find(entry => entry.pilot === states.partial.pilot);
  assert.ok(row, "the partial pilot structure exists");
  const input = loadChartCorpus().find(entry => entry.id === row.caseId)?.input;
  assert.ok(input);
  await assertPartialState(row.profile, row.locale, input, resultsFor(row), states.partial.failedSection);
});

test("one failed section is publishable and carries its notice; none is not", () => {
  const profile: PaidProfile = "paid-core-v1";
  const keys = paidSections(profile);
  const input = loadChartCorpus()[0].input;
  const snapshot = calculatePaidSnapshot(randomUUID(), input, profile);
  const build = (results: SectionResult[]) => buildReadingDocument({
    readingId: randomUUID(), locale: "es", tier: "paid", digest: paidDigest(snapshot), contentVersion: "pilot-boundary/1", results,
  });
  const failed = (key: SectionResult["key"]): SectionResult =>
    ({ key, status: "failed", failureReason: "pilot_section_failed", costMxn: 0 }) as SectionResult;
  const generated = (key: SectionResult["key"]): SectionResult => ({
    key, status: "generated", fromCache: false, model: "pilot-fixture",
    usage: { inputTokens: 0, outputTokens: 0 }, costMxn: 0, latencyMs: 0,
    output: { blocks: [blockAt("prose", 120)] },
  }) as SectionResult;

  const mixed = build(keys.map((key, index) => (index === 0 ? failed(key) : generated(key))));
  assert.equal(persistableDocument(mixed), true, "a run with one generated section is a saved edition");
  const decoded = readStoredDocument(JSON.stringify(mixed), mixed, { allowPaid: true, expectedSections: keys });
  assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.code);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.value.notices, ["partial"]);
  assert.deepEqual(decoded.value.sections.find(section => section.key === keys[0])?.notices, ["section_failed"]);

  const dead = build(keys.map(key => failed(key)));
  assert.equal(persistableDocument(dead), false, "a run with no generated section is never a saved edition");
  const rejected = readStoredDocument(JSON.stringify(dead), dead, { allowPaid: true, expectedSections: keys });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok ? "" : rejected.code, "document_unavailable", "the page never shows an empty edition");
});
