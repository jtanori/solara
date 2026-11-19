/**
 * Browser QA for the factual wheel (issue #154, slice 1-c).
 *
 * The acceptance box the plan states in prose — "the container must not overflow at the
 * half-width/200%-density viewport the browser tests already emulate" — is measured here
 * against the stylesheet the app actually ships, not against a screenshot or an
 * assumption. Everything is a number: the wheel's own box, its column, the viewport.
 *
 * The page is rendered through the real `ReadingPageView` as a server component and
 * served statically; the app's own `globals.css` rules are pinned into the document, so
 * the cascade (including the mobile breakpoint) is the one a reader gets.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Browser, BrowserContext } from "playwright-core";
import { ReadingPageView } from "../src/components/reading-page-view";
import { calculateSolarReturn, solarReturnFacts } from "../src/lib/solar";
import { baseCalculationBlocks } from "../src/readings/base-presentation";
import { chartNotes } from "../src/readings/chart-presentation";
import type { ReadingChart, ReadingPresentation } from "../src/readings/presentation";
import { launchReadingTestBrowser } from "./helpers/browser";
import { readingChartInput } from "./helpers/reading-fixtures";

const EVIDENCE = ".venv/wheel-evidence";
const result = calculateSolarReturn(readingChartInput);
const facts = solarReturnFacts(readingChartInput, result);
const chart: ReadingChart = {
  id: "11111111-2222-4333-8444-555555555555", year: 2026, name: "Synthetic Reading",
  returnPlace: "New York, United States", timezone: "America/New_York", result,
  baseFacts: facts, calculation: baseCalculationBlocks(facts, "en"),
};
const view: ReadingPresentation = {
  chart, content: chartNotes(chart, { sun: "SUN_NOTE", moon: "", ascendant: "", house: "" }, "en", false),
  generation: null, availability: "chart_only",
};
/** The rules a reader actually receives: every selector and breakpoint in globals.css. */
const stylesheet = readFileSync("src/app/globals.css", "utf8").split("\n")
  .filter(line => ["@media", "."].some(prefix => line.trim().startsWith(prefix))).join("\n");
const markup = renderToStaticMarkup(createElement(ReadingPageView, { view, locale: "en", selector: { kind: "chart" } }));
const servedDocument = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}${stylesheet}</style></head>
<body><div class="app-wrap">${markup}</div></body></html>`;

let browser: Browser; let context: BrowserContext; let origin: string; let server: ReturnType<typeof createServer>;
before(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  server = createServer((request, response) => {
    if (request.url === "/wheel.css") { response.setHeader("Content-Type", "text/css"); response.end(stylesheet); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(servedDocument);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await launchReadingTestBrowser();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
});
after(async () => { await context?.close(); await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

const measured: Record<string, unknown>[] = [];

for (const [label, width, density] of [["desktop", 1280, 1], ["half-width-200pct", 640, 2], ["narrow-200pct", 390, 2]] as const) {
  test(`browser wheel: fits its column and the viewport at ${width}px / ${density}x`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: density });
    try {
      await page.goto(origin);
      const size = await page.evaluate(() => {
        const wheel = document.querySelector("svg.chart-wheel") as SVGSVGElement | null;
        if (!wheel) return null;
        const rect = wheel.getBoundingClientRect();
        const column = wheel.closest(".chart-header")!.getBoundingClientRect();
        return {
          width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom,
          columnWidth: column.width, columnRight: column.right,
          viewportWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          overflowsSelf: wheel.scrollWidth > Math.ceil(rect.width) + 1,
          anchors: document.querySelectorAll("[data-anchor=\"true\"]").length,
          labelledBy: wheel.getAttribute("aria-labelledby"),
          title: wheel.querySelector("title")?.textContent ?? null,
          description: wheel.querySelector("desc")?.textContent ?? null,
        };
      });
      assert.ok(size, "the wheel must render");
      // Square, visible, and bounded by its own column and by the viewport.
      assert.ok(size.width > 0 && size.height > 0, `${label}: visible`);
      assert.ok(Math.abs(size.width / size.height - 1) < 0.02, `${label}: square (${size.width}×${size.height})`);
      assert.equal(size.overflowsSelf, false, `${label}: nothing drawn outside the box`);
      assert.ok(size.width <= size.columnWidth + 1, `${label}: ${size.width}px wheel inside a ${size.columnWidth}px column`);
      assert.ok(size.right <= size.columnRight + 1, `${label}: inside the column's right edge`);
      assert.ok(size.right <= size.viewportWidth + 1, `${label}: on screen`);
      // All fourteen positions are drawn, and the accessible name is present.
      assert.equal(size.anchors, 14, `${label}: fourteen plotted positions`);
      assert.equal(size.labelledBy, "chart-wheel-title chart-wheel-description");
      assert.match(size.title!, /^Factual chart for Synthetic Reading$/);
      assert.match(size.description!, /authoritative equivalent/);
      // Evidence for the PR, not an assertion: the rendered page at this viewport.
      await page.screenshot({ path: `${EVIDENCE}/reading-${label}.png`, fullPage: true });
      await page.locator("svg.chart-wheel").screenshot({ path: `${EVIDENCE}/wheel-only-${label}.png` });
      measured.push({ viewport: `${width}x${density}`, ...size });
    } finally { await page.close(); }
  });
}

test("browser wheel: the narrow layout reflows instead of clipping the wheel", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, deviceScaleFactor: 2 });
  try {
    await page.goto(origin);
    const layout = await page.evaluate(() => {
      const header = document.querySelector(".chart-header") as HTMLElement;
      const wheel = document.querySelector("svg.chart-wheel") as SVGSVGElement;
      return { columns: getComputedStyle(header).gridTemplateColumns, wheelWidth: wheel.getBoundingClientRect().width,
        wheelTop: wheel.getBoundingClientRect().top, copyTop: header.firstElementChild!.getBoundingClientRect().top };
    });
    // The two-column header collapses to one on a phone, and the wheel drops below the
    // copy rather than squeezing beside it.
    assert.equal(layout.columns.split(" ").length, 1, "single column at 390px");
    assert.ok(layout.wheelTop >= layout.copyTop, "the wheel stacks under the chart copy");
    assert.equal(layout.wheelWidth, 280, "the narrow rule sizes the wheel");
    writeFileSync(`${EVIDENCE}/measurements.json`, JSON.stringify(measured, null, 2));
  } finally { await page.close(); }
});
