import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { pool, coordinationPool } from "../src/db";
import { paidSections, type PaidProfile } from "../src/readings/paid-contract";
import { NOTICE_COPY } from "../src/readings/presentation-copy";
import type { ReadingBlock } from "../src/readings/types";
import type { SectionResult } from "../src/readings/document";
import { loadChartCorpus } from "../scripts/lib/chart-corpus";
import { renderEdition } from "../scripts/lib/pilot-render";

/*
 * #225 / A2: the committed pilot structures drive the real page and PDF path at realistic lengths.
 * The fixture contains kinds and lengths only; this test manufactures filler prose at those lengths
 * so no pilot prose is committed. The report itself is rendered by the local harness, not here.
 */

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" };
const OUT = ".venv/pilot-render/tests";

type Structure = {
  version: string;
  cases: {
    pilot: string;
    profile: PaidProfile;
    locale: "en" | "es";
    caseId: string;
    sections: { key: string; status: string; blocks: { kind: string; chars: number }[]; closingQuestionChars: number }[];
  }[];
};

before(() => {
  if (enabled) execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "pipe" });
});
after(async () => {
  if (enabled) await Promise.all([pool.end(), coordinationPool.end()]);
});

function filler(chars: number): string {
  const base = "palabra de prueba ";
  return base.repeat(Math.max(1, Math.ceil(Math.max(1, chars) / base.length))).slice(0, Math.max(1, chars));
}

function block(kind: string, chars: number): ReadingBlock {
  const text = filler(chars);
  switch (kind) {
    case "callout": return { kind: "callout", text };
    case "list": return { kind: "list", items: [text] };
    case "keyValue": return { kind: "keyValue", entries: [{ key: "clave", value: text }] };
    case "aspectTable": return { kind: "aspectTable", rows: [{ a: "Sol", b: "Luna", type: "trígono", orb: 1.2 }] };
    default: return { kind: "prose", text };
  }
}

function resultsFor(row: Structure["cases"][number]): SectionResult[] {
  return row.sections.map(section => {
    if (section.status === "failed") {
      return { key: section.key as SectionResult["key"], status: "failed", failureReason: "pilot_section_failed", costMxn: 0 } as SectionResult;
    }
    return {
      key: section.key as SectionResult["key"],
      status: "generated",
      fromCache: false,
      model: "pilot-fixture",
      usage: { inputTokens: 0, outputTokens: 0 },
      costMxn: 0,
      latencyMs: 0,
      output: {
        blocks: section.blocks.map(entry => block(entry.kind, entry.chars)),
        ...(section.closingQuestionChars > 0 ? { closingQuestion: filler(Math.max(10, section.closingQuestionChars)).slice(0, 500) } : {}),
      },
    } as SectionResult;
  });
}

const structure = JSON.parse(readFileSync("tests/fixtures/readings/pilot-structures-v1.json", "utf8")) as Structure;

for (const row of structure.cases) {
  test(`pilot structure renders ${row.pilot}`, gated, async t => {
    const input = loadChartCorpus().find(entry => entry.id === row.caseId)?.input;
    assert.ok(input, `corpus input for ${row.caseId}`);
    const uiLocale = row.locale === "es" ? "en" : "es";
    const result = await renderEdition({
      input,
      locale: row.locale,
      profile: row.profile,
      results: resultsFor(row),
      contentVersion: "pilot-structure/1",
      uiLocale,
      outDir: OUT,
      basename: `structure-${row.pilot}`,
      pdfDeadlineMs: 30_000,
    });

    assert.equal(result.view.content.kind, "saved-reading");
    if (result.view.content.kind !== "saved-reading") return;
    assert.deepEqual(result.view.content.sections.map(section => section.key), paidSections(row.profile));
    assert.equal(result.view.content.tier, "paid");
    assert.equal(result.partial, row.sections.some(section => section.status === "failed"));
    assert.equal(result.wheelSystem, "placidus");
    assert.match(result.html, /data-wheel-system="placidus"/);
    for (const section of result.view.content.sections) {
      assert.ok(result.html.includes(section.title), `${section.key} title present`);
    }
    assert.ok(result.htmlBytes > 10_000, "a realistic page, not an empty shell");

    if (result.partial) {
      assert.ok(result.view.content.notices.includes("partial"), "the presentation is marked partial");
      assert.ok(result.html.includes(NOTICE_COPY.section_failed[row.locale]), "the failed section carries its honest notice");
    }

    if (result.pdfError) {
      if (process.env.CI) assert.fail(`PDF render failed in CI: ${result.pdfError}`);
      t.skip(`PDF unrunnable on this machine: ${result.pdfError} (CI is authoritative)`);
      return;
    }
    assert.equal(result.pdf?.subarray(0, 4).toString(), "%PDF");
    assert.ok(result.pdfBytes > 1_000);
  });
}
