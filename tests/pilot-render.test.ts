import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test, { after, before } from "node:test";
import { coordinationPool, pool } from "../src/db";
import { paidSections } from "../src/readings/paid-contract";
import { NOTICE_COPY } from "../src/readings/presentation-copy";
import { loadChartCorpus } from "../scripts/lib/chart-corpus";
import { renderEdition } from "../scripts/lib/pilot-render";
import { loadPilotStructures, resultsFor } from "./helpers/pilot-structure";

/*
 * #225 / A2: the committed pilot structures drive the real page and PDF path at realistic lengths.
 * The fixture contains kinds and lengths only; filler prose is manufactured here so no pilot prose
 * is committed. The report itself is rendered by the local harness, not here.
 *
 * The PDF runs at the production deadline (READING_LIMITS.pdfDeadlineMs): a render that only works
 * with twice the bound would be green here and a 503 in production.
 */

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";
const gated = { skip: enabled ? false : "requires RUN_INTEGRATION_TESTS=1 and disposable local PostgreSQL" };
const OUT = ".venv/pilot-render/tests";

before(() => {
  if (enabled) execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "pipe" });
});
after(async () => {
  if (enabled) await Promise.all([pool.end(), coordinationPool.end()]);
});

for (const row of loadPilotStructures().cases) {
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
