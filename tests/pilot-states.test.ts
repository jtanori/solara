import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, coordinationPool } from "../src/db";
import { readingDocuments } from "../src/db/schema";
import { ReadingPageView } from "../src/components/reading-page-view";
import type { PaidProfile } from "../src/readings/paid-contract";
import { NOTICE_COPY } from "../src/readings/presentation-copy";
import type { ReadingBlock } from "../src/readings/types";
import type { ChartInput } from "../src/lib/types";
import { randomUUID } from "node:crypto";
import { paidDigest, calculatePaidSnapshot } from "../src/readings/paid-chart";
import { buildReadingDocument, persistableDocument } from "../src/readings/document";
import { paidSections } from "../src/readings/paid-contract";
import type { SectionResult } from "../src/readings/document";
import { loadReadingPresentation } from "../src/readings/reading-view";
import { syntheticPaidEdition } from "./helpers/paid-edition";
import { readingLedgerSnapshot, syntheticReadingAccount } from "./helpers/reading-account";
import { loadChartCorpus } from "../scripts/lib/chart-corpus";

/*
 * #225 / A3: the 10/11 pilot structure and an all-failed synthetic state render the honest
 * partial notice, never a regeneration promise, a canonical promotion or an allowance reset.
 */

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" };
after(async () => {
  if (enabled) await Promise.all([pool.end(), coordinationPool.end()]);
});

type Structure = {
  cases: {
    pilot: string;
    profile: PaidProfile;
    locale: "en" | "es";
    caseId: string;
    sections: { key: string; status: string; blocks: { kind: string; chars: number }[]; closingQuestionChars: number }[];
  }[];
};

const structure = JSON.parse(readFileSync("tests/fixtures/readings/pilot-structures-v1.json", "utf8")) as Structure;
const states = JSON.parse(readFileSync("tests/fixtures/readings/pilot-states-v1.json", "utf8")) as {
  partial: { pilot: string; profile: PaidProfile; failedSection: string; notices: string[] };
  failed: { notices: string[] };
  indeterminate: { notices: string[] };
};

function text(chars: number): string {
  const base = "palabra de prueba ";
  return base.repeat(Math.max(1, Math.ceil(Math.max(1, chars) / base.length))).slice(0, Math.max(1, chars));
}

function block(kind: string, chars: number): ReadingBlock {
  const value = text(chars);
  switch (kind) {
    case "callout": return { kind: "callout", text: value };
    case "list": return { kind: "list", items: [value] };
    case "keyValue": return { kind: "keyValue", entries: [{ key: "clave", value }] };
    case "aspectTable": return { kind: "aspectTable", rows: [{ a: "Sol", b: "Luna", type: "trígono", orb: 1.2 }] };
    default: return { kind: "prose", text: value };
  }
}

function resultsFor(row: Structure["cases"][number]): SectionResult[] {
  return row.sections.map(section => section.status === "failed"
    ? { key: section.key as SectionResult["key"], status: "failed", failureReason: "pilot_section_failed", costMxn: 0 } as SectionResult
    : {
        key: section.key as SectionResult["key"], status: "generated", fromCache: false, model: "pilot-fixture",
        usage: { inputTokens: 0, outputTokens: 0 }, costMxn: 0, latencyMs: 0,
        output: {
          blocks: section.blocks.map(entry => block(entry.kind, entry.chars)),
          ...(section.closingQuestionChars > 0 ? { closingQuestion: text(Math.max(10, section.closingQuestionChars)).slice(0, 500) } : {}),
        },
      } as SectionResult);
}

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

test("an all-failed document is not publishable, so the page never shows a fake edition", async () => {
  const input = loadChartCorpus()[0].input;
  const snapshot = calculatePaidSnapshot(randomUUID(), input, "paid-core-v1");
  const results = paidSections("paid-core-v1").map(key => ({
    key, status: "failed" as const, failureReason: "pilot_section_failed", costMxn: 0,
  })) as SectionResult[];
  const document = buildReadingDocument({
    readingId: randomUUID(), locale: "es", tier: "paid", digest: paidDigest(snapshot), contentVersion: "pilot-structure/1", results,
  });
  assert.equal(persistableDocument(document), false, "a run with no generated section cannot become a saved edition");
  assert.deepEqual(states.failed.notices, ["partial", "section_failed"]);
  assert.deepEqual(states.failed.notices, states.indeterminate.notices);
});
