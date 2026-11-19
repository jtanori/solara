/**
 * Browser QA for the factual wheel (issue #154, slice 1-c).
 *
 * The acceptance box the plan states in prose — "the container must not overflow at the
 * half-width/200%-density viewport the browser tests already emulate" — is measured here
 * against the stylesheet the app actually ships, not against a screenshot or an
 * assumption. Everything is a number: the wheel's own box, its grid track, the viewport.
 *
 * Three things make the measurement trustworthy:
 *
 * 1. The stylesheet is **compiled**, by the same PostCSS/Tailwind pipeline the app builds
 *    with, from `src/app/globals.css`. A line filter would drop `:root`, the `*` box-sizing
 *    rule and the `body` typography, and then measure a page nobody is served.
 * 2. The wheel is measured against its own **grid track**, not the `.chart-header`
 *    container: a 2-track container is always wider than its widest child, so a container
 *    check passes an overflowing wheel. The wrapper cell is what has to hold it.
 * 3. The wheel's ink is measured from its **text and paint bounds**, not from the SVG
 *    element's `scrollWidth`: an SVG view box clips nothing, so `scrollWidth` reports the
 *    element's own width however far a label hangs over the edge.
 *
 * The last test proves the checks bite: the same harness is re-run with a deliberately
 * oversized wheel, and every assertion that is supposed to fail, fails.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import type { Browser } from "playwright-core";
import { ReadingPageView } from "../src/components/reading-page-view";
import { calculateSolarReturn, solarReturnFacts } from "../src/lib/solar";
import { baseCalculationBlocks } from "../src/readings/base-presentation";
import { chartNotes } from "../src/readings/chart-presentation";
import type { ReadingChart, ReadingPresentation } from "../src/readings/presentation";
import { launchReadingTestBrowser } from "./helpers/browser";
import { readingChartInput } from "./helpers/reading-fixtures";

const EVIDENCE = ".venv/wheel-evidence";
/** The reading page's own column width, and the drawing it has to hold. */
const TRACK = 380;
const DRAWING = 360;
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
/**
 * The stylesheet a reader receives: compiled from the app's own source and pipeline. The
 * compile is asynchronous, so it happens once in `before` and both the server and the
 * measurement use its result.
 */
let compiled = "";
const compileStylesheet = async () => (await postcss([tailwindcss()])
  .process(readFileSync("src/app/globals.css", "utf8"), { from: "src/app/globals.css" })).css;
const markup = renderToStaticMarkup(createElement(ReadingPageView, { view, locale: "en", selector: { kind: "chart" } }));

/**
 * The served page. The wheel sits in its own grid cell exactly as `.chart-header` lays it
 * out — `minmax(0, 1fr) 380px` with the wheel in the second track — so the column the wheel
 * has to fit is the track it is actually given.
 */
const servedDocument = (css: string, wheelMarkup = markup, pageClass = "reading-page") => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><main class="app-page ${pageClass}"><div class="app-wrap">${wheelMarkup}</div></main></body></html>`;

/** The page as served, with the decorative `/sample` header for the out-of-scope check. */
const SAMPLE_HEADER = `<div class="chart-header"><div><h1>Sample</h1><p>copy</p></div>
<svg class="chart-wheel" viewBox="0 0 440 440" role="img" aria-label="decorative"></svg></div>`;

let browser: Browser; let origin: string; let server: ReturnType<typeof createServer>;
let servedCss = "";
before(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  compiled = await compileStylesheet();
  servedCss = compiled;
  server = createServer((request, response) => {
    if (request.url === "/wheel.css") { response.setHeader("Content-Type", "text/css"); response.end(servedCss); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(servedDocument(servedCss, request.url === "/sample" ? SAMPLE_HEADER : markup,
      request.url === "/sample" ? "sample-page" : "reading-page"));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await launchReadingTestBrowser();
});
after(async () => { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

type Measurement = {
  width: number; height: number; left: number; right: number;
  track: number; trackLeft: number; trackRight: number; trackIsColumn: boolean;
  viewportWidth: number; documentScrollWidth: number;
  inkOverflow: { at: string; dy: number }[];
  canvasInkOverflow: number;
  anchors: number; labelledBy: string | null; title: string | null; description: string | null;
  columns: string;
};

/** Measure the served page at one viewport. Nothing here reads `scrollWidth`. */
const measure = async (path: string, width: number, density: number): Promise<Measurement> => {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: density });
  try {
    await page.goto(`${origin}${path}`);
    return await page.evaluate(() => {
      const wheel = document.querySelector("svg.chart-wheel") as SVGSVGElement;
      const rect = wheel.getBoundingClientRect();
      // The wheel's *track*: the grid cell it occupies. The cell is the `.chart-header`
      // element on the reading page, whose second track is the wheel's column — measuring
      // the header's own box instead would accept an overflowing wheel.
      const cell = wheel.closest(".chart-cell") as HTMLElement;
      const grid = cell.parentElement as HTMLElement;
      const track = cell.getBoundingClientRect();
      const ink: { at: string; dy: number }[] = [];
      for (const element of Array.from(wheel.querySelectorAll("*"))) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        ink.push({ at: element.tagName.toLowerCase(),
          dy: Math.max(0, rect.top - box.top, box.bottom - rect.bottom, rect.left - box.left, box.right - rect.right) });
      }
      return {
        width: rect.width, height: rect.height, left: rect.left, right: rect.right,
        track: track.width, trackLeft: track.left, trackRight: track.right,
        trackIsColumn: getComputedStyle(grid).display === "grid",
        viewportWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        inkOverflow: ink.filter(item => item.dy > 0.5),
        canvasInkOverflow: Math.max(0, ...ink.map(item => item.dy)),
        anchors: document.querySelectorAll("[data-anchor=\"true\"]").length,
        labelledBy: wheel.getAttribute("aria-labelledby"),
        title: wheel.querySelector("title")?.textContent ?? null,
        description: wheel.querySelector("desc")?.textContent ?? null,
        columns: getComputedStyle(grid).gridTemplateColumns,
      } satisfies Measurement;
    });
  } finally { await page.close(); }
};

const measured: Record<string, unknown>[] = [];

for (const [label, width, density] of [["desktop", 1280, 1], ["half-width-200pct", 640, 2], ["narrow-200pct", 390, 2]] as const) {
  test(`browser wheel: fits its ${TRACK}px track and the viewport at ${width}px / ${density}x`, async () => {
    const size = await measure("/", width, density);
    // The drawing is sized by this page's rule, in the track this page declares.
    assert.equal(size.width, Math.min(DRAWING, width < 560 ? 280 : DRAWING), `${label}: ${size.width}px drawing`);
    assert.ok(size.width <= size.track + 1, `${label}: ${size.width}px wheel inside a ${size.track}px track`);
    assert.ok(size.right <= size.trackRight + 1, `${label}: inside the track's right edge`);
    assert.ok(size.right <= size.viewportWidth + 1, `${label}: on screen`);
    assert.ok(size.documentScrollWidth <= size.viewportWidth, `${label}: the page does not scroll sideways`);
    // Square, visible, and no ink — label glyphs, leader lines, tick marks — outside the box.
    assert.ok(Math.abs(size.width / size.height - 1) < 0.02, `${label}: square (${size.width}×${size.height})`);
    assert.deepEqual(size.inkOverflow, [], `${label}: nothing drawn outside the box`);
    // All fourteen positions are drawn, and the accessible name is present.
    assert.equal(size.anchors, 14, `${label}: fourteen plotted positions`);
    assert.equal(size.labelledBy, "chart-wheel-title chart-wheel-description");
    assert.match(size.title!, /^Factual chart for Synthetic Reading$/);
    assert.match(size.description!, /authoritative equivalent/);
    measured.push({ viewport: `${width}x${density}`, ...size });
  });
}

test(`browser wheel: the wide track is ${TRACK}px above 560px and the wheel is ${DRAWING}px`, async () => {
  for (const width of [1281, 900, 561]) {
    const size = await measure("/", width, 1);
    assert.equal(size.track, TRACK, `${width}px: the reading page's track is ${TRACK}px, got ${size.track}`);
    assert.equal(size.width, DRAWING, `${width}px: the wheel is ${DRAWING}px, got ${size.width}`);
    assert.deepEqual(size.inkOverflow, [], `${width}px: no ink outside the box`);
  }
  // Exactly on the breakpoint the column keeps its track; the wheel still fits inside it.
  const atBreakpoint = await measure("/", 560, 1);
  assert.equal(atBreakpoint.width, 280, "560px: the narrow rule sizes the wheel");
  assert.deepEqual(atBreakpoint.inkOverflow, [], "560px: no ink outside the box");
  // One pixel past it, the wide treatment applies again: the column is 380 and so is the
  // drawing's own rule — this is the width the plan's "half-width" objection is about.
  const pastBreakpoint = await measure("/", 561, 1);
  assert.equal(pastBreakpoint.width, DRAWING, "561px: the wide rule sizes the wheel");
  assert.ok(pastBreakpoint.width <= pastBreakpoint.track + 1, "561px: the widened wheel still fits its track");
});

test("browser wheel: the narrow layout reflows instead of clipping the wheel", async () => {
  const size = await measure("/", 390, 2);
  // The two-column header collapses to one on a phone, so the wheel drops below the copy
  // rather than squeezing beside it — and the drawing is the narrow size, uncropped.
  assert.equal(size.columns.split(" ").length, 1, "single column at 390px");
  assert.equal(size.width, 280, "the narrow rule sizes the wheel");
  assert.deepEqual(size.inkOverflow, []);
  writeFileSync(`${EVIDENCE}/measurements.json`, JSON.stringify(measured, null, 2));
});

test("browser wheel: /sample keeps the decorative sizes this slice did not change", async () => {
  // The reading-page sizing is scoped. The sample page is out of scope for this slice and
  // must render exactly as it did: a 270px track and a 250px decorative drawing.
  for (const [width, drawing] of [[1280, 250], [560, 190]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${origin}/sample`);
      const size = await page.evaluate(() => {
        const wheel = document.querySelector("svg.chart-wheel") as SVGSVGElement;
        const header = wheel.parentElement as HTMLElement;
        return { width: wheel.getBoundingClientRect().width, columns: getComputedStyle(header).gridTemplateColumns };
      });
      assert.equal(size.width, drawing, `sample at ${width}px: decorative drawing stays ${drawing}px`);
      // Above the phone breakpoint the decorative header keeps its 270px second track.
      // (At the phone breakpoint the single collapsed track resolves to the container's
      // width, so only the size above it is stated as a number.)
      assert.equal(width < 561 || size.columns.endsWith("270px"), true,
        `sample at ${width}px: second track is unchanged, got ${size.columns}`);
    } finally { await page.close(); }
  }
});

test("negative control: the measurements fail on a wheel that really does overflow", async () => {
  // Same harness, one hostile stylesheet: a 420px drawing in a 380px track, and a label
  // pushed outside the view box. The checks that are supposed to catch an overflow must
  // fail — otherwise the passing runs above prove nothing about the real page.
  servedCss = `${compiled}\n.reading-page .chart-wheel { width:420px; max-width:none; }\n`
    + `.reading-page .chart-wheel g[data-point] text { transform:translate(-260px,0); }\n`;
  try {
    const size = await measure("/", 1281, 1);
    assert.equal(size.width, 420, "the hostile rule applied");
    assert.ok(size.width > size.track, "control: the wheel is wider than its track");
    assert.equal(size.width <= size.track + 1, false, "control: the track assertion must fail");
    assert.ok(size.inkOverflow.length > 0, "control: ink outside the box was detected");
  } finally { servedCss = compiled; }
  // And the restored stylesheet measures clean again, so the control did not mutate the
  // page it was judging.
  const restored = await measure("/", 1281, 1);
  assert.equal(restored.width, DRAWING);
  assert.deepEqual(restored.inkOverflow, []);
});
