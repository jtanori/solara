import assert from "node:assert/strict";
import { before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { SolarReturnDocument, pdfStrings, wheelCopy } from "../src/components/solar-pdf";
import { PdfChartWheel, PDF_WHEEL_POINTS } from "../src/components/pdf-chart-wheel";
import { ChartWheel } from "../src/components/chart-wheel";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadPdfFonts } from "../src/readings/pdf-fonts";
import { ReadingPdfRenderer, pdfIpcPayload } from "../src/readings/pdf-render";
import { ReadingPdfError } from "../src/readings/pdf-contract";
import { READING_LIMITS, PDF_INPUT_BYTES, wheelFactsOf } from "../src/readings/presentation";
import { BASE_FACTS_BYTES, baseFactsRow } from "../src/readings/chart-facts";
import { projectWheel, wheelAngle, WHEEL_MIN_LABEL_FONT, WHEEL_VIEW_BOX } from "../src/lib/wheel";
import { wheelDrawingText, wheelLabelText, wheelLabelTexts } from "../src/readings/wheel-labels";
import { calculateSolarReturn, solarReturnFacts } from "../src/lib/solar";
import { calculatePaidSnapshot } from "../src/readings/paid-chart";
import { paidCalculationBlocks } from "../src/readings/paid-presentation";
import { randomUUID } from "node:crypto";
import { editionTitle, WHEEL_NOTICE_COPY } from "../src/readings/presentation-copy";
import { chartNotes } from "../src/readings/chart-presentation";
import { chartPlacements } from "../src/readings/presentation-format";
import { pdfFixture, inspectPdf, normalizePdfText } from "./helpers/reading-pdf";
import { readingChartInput, frozenReading } from "./helpers/reading-fixtures";
import type { ReadingPdfInput } from "../src/readings/pdf-contract";

/**
 * S1-d (#155): the factual wheel in the PDF.
 *
 * These tests exist to catch the failure classes the page slice taught us about, translated
 * to a second emitter: a drawing that does not appear, a drawing that appears but is not the
 * chart's, a glyph that silently disappears, a separate projection that drifts, and a
 * "successful" PDF that measured nothing because facts never reached the worker.
 */

const pdfRenderer = new ReadingPdfRenderer();
/**
 * The renderer is imported inside the hooks, not at module scope: the package resolves a
 * hyphenation subpath at load time that the CJS/ESM interop under `tsx` cannot reach, so a
 * top-level import fails before any test runs. `tests/pdf.test.ts` uses the same pattern.
 */
let renderer: typeof import("@react-pdf/renderer");
before(async () => {
  execFileSync(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "pipe" });
  renderer = await import("@react-pdf/renderer");
  await loadPdfFonts(renderer, resolve("src/readings/fonts"));
});

/** Render the wheel for an arbitrary (possibly mutated) geometry as a standalone document. */
async function renderedGeometryText(geometry: ReturnType<typeof projectWheel>): Promise<string> {
  assert.ok(geometry);
  const { createElement } = await import("react");
  const document = createElement(renderer.Document, null,
    createElement(renderer.Page, { size: "A4" },
      createElement(PdfChartWheel, { text: { title: "", caption: "" }, geometry, renderer })));
  const buffer = await renderer.renderToBuffer(document as never);
  return (await inspectPdf(buffer)).text;
}

/** The whole-sign facts the save path would have written for the fixture chart. */
function fixtureFacts() {
  const result = calculateSolarReturn(readingChartInput);
  const row = baseFactsRow(solarReturnFacts, readingChartInput, result);
  assert.ok("row" in row, `fixture must produce facts, got ${JSON.stringify(row)}`);
  return row.row.facts;
}

const withWheel = (locale: "en" | "es", edition: "free" | "paid" = "free"): ReadingPdfInput =>
  ({ ...pdfFixture(locale, edition), wheelFacts: fixtureFacts() });

const withoutFacts = (locale: "en" | "es"): ReadingPdfInput => pdfFixture(locale);

async function render(input: ReadingPdfInput) {
  const result = await pdfRenderer.render(input);
  return { result, inspected: await inspectPdf(result.buffer, true) };
}

/**
 * Emitted cartesian coordinates, read out of the rendered React element tree.
 *
 * This is the page/PDF agreement check the plan asks for: both emitters consume one
 * `WheelGeometry`, so the coordinates in the PDF tree must equal the geometry's own — no
 * emitter may re-derive an angle. Walking the tree also proves the drawing is primitives
 * (`Line`/`Circle`/`Rect`/`Text`), never a raster image.
 */
type Node = { type: unknown; props: Record<string, unknown>; children?: unknown[] };
function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  const element = node as Node;
  if (element.props && typeof element.props === "object") visit(element);
  const children = (element.props?.children ?? element.children) as unknown;
  for (const child of Array.isArray(children) ? children.flat(4) : [children]) walk(child, visit);
}

function pdfTreeGeometry(geometry: ReturnType<typeof projectWheel>) {
  assert.ok(geometry);
  const tree = PdfChartWheel({ text: { title: "", caption: "" }, geometry, renderer: renderer as never });
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const circles: { cx: number; cy: number; r: number }[] = [];
  let images = 0;
  walk(tree, node => {
    const p = node.props;
    if (node.type === renderer.Line) lines.push({ x1: p.x1 as number, y1: p.y1 as number, x2: p.x2 as number, y2: p.y2 as number });
    if (node.type === renderer.Circle) circles.push({ cx: p.cx as number, cy: p.cy as number, r: p.r as number });
    if (/Image|Path/.test(String((node.type as { displayName?: string })?.displayName ?? ""))) images += 1;
  });
  return { lines, circles, images };
}

test("PDF wheel: a chart with facts draws a vector wheel, and a chart without facts draws none", async () => {
  for (const locale of ["en", "es"] as const) {
    const { inspected } = await render(withWheel(locale));
    const heading = locale === "es" ? "Rueda factual" : "Factual wheel";
    assert.ok(inspected.text.includes(heading), `${locale}: the wheel block is headed`);
    // The accessible name travels as text, because a PDF page has no img role.
    assert.ok(inspected.text.includes(locale === "es" ? "Carta factual de" : "Factual chart for"), `${locale}: accessible name as text`);
    assert.ok(inspected.text.includes(locale === "es" ? "equivalente autoritativo" : "authoritative equivalent"), `${locale}: points at the table`);

    /**
     * Without facts the PDF still says *why* there is no drawing.
     *
     * An earlier version emitted nothing here, on the theory that a sentence would disturb
     * frozen paid snapshots. That confused two documents: every existing snapshot is a chart
     * that never had a wheel and takes this same path, so its text is unchanged — and the
     * plan's Missing data section requires the explanation in any format. Silence left a
     * reader holding a PDF with no drawing and no reason for it.
     */
    const { inspected: bare } = await render(withoutFacts(locale));
    assert.ok(bare.text.includes(heading), `${locale}: the block is still headed`);
    const absent = locale === "es" ? "No hay rueda para esta carta." : "There is no wheel for this chart.";
    assert.ok(bare.text.includes(absent), `${locale}: the PDF explains the missing wheel`);
  }
});

/**
 * The HTML wheel, parsed from its real server render — not from the geometry.
 *
 * This is the whole point of a parity test. The previous version of the test below got its
 * "page" labels from `wheelLabelTexts(geometry)`, which is the *same* function the PDF uses,
 * so the comparison was geometry against itself and passed while the HTML wheel printed
 * something else entirely. Changing only the page's Pluto label to "Wrong label" left both
 * parity tests green — the reviewer's escape.
 *
 * So the page is rendered: `ChartWheel` for the same geometry and locale, through
 * `renderToStaticMarkup`, and the markup is read back. Every `<text>` in the SVG is a painted
 * label; `<title>` inside an omitted point's group is not.
 */
type PageWheel = { labels: string[]; lines: { x1: number; y1: number; x2: number; y2: number }[]; circles: { cx: number; cy: number; r: number }[] };

function renderPageWheel(geometry: NonNullable<ReturnType<typeof projectWheel>>, locale: "en" | "es", chartName: string): PageWheel {
  const markup = renderToStaticMarkup(createElement(ChartWheel, { geometry, locale, chartName, returnInstant: "May 16, 2026" }));
  const draw = markup.slice(markup.indexOf("<svg"), markup.indexOf("</svg>"));
  /** Attributes are emitted in stable order by React; read them by name rather than by position. */
  const attr = (tag: string, name: string): number => {
    const match = new RegExp("\\s" + name + "=\"(-?[0-9.]+)\"").exec(tag);
    assert.ok(match, `missing ${name} in ${tag.slice(0, 80)}`);
    return Number(match[1]);
  };
  const labels = [...draw.matchAll(/<text\b[^>]*>([^<]*)<\/text>/gu)].map(match => match[1]!);
  const lines = [...draw.matchAll(/<line\b[^>]*>/gu)].map(([tag]) => ({ x1: attr(tag, "x1"), y1: attr(tag, "y1"), x2: attr(tag, "x2"), y2: attr(tag, "y2") }));
  const circles = [...draw.matchAll(/<circle\b[^>]*>/gu)].map(([tag]) => ({ cx: attr(tag, "cx"), cy: attr(tag, "cy"), r: attr(tag, "r") }));
  return { labels, lines, circles };
}


/**
 * The PDF wheel's *painted* text, extracted from the page — not from the geometry.
 *
 * This is the missing half of the parity check. Comparing the rendered page against
 * `wheelLabelTexts(geometry)` proves the page matches the geometry; it says nothing about
 * what the PDF actually painted, and `includes()` over the whole document is satisfied by a
 * single matching substring anywhere in it. An extra label inserted into the PDF's SVG left
 * both parity tests green — the reviewer's mutation.
 *
 * The drawing is placed by layout, so the page coordinates are the geometry's own plus a
 * translation: the SVG is authored in 440 viewBox units and rendered into a 440pt box, so
 * one unit is one point (that equality is `PDF_WHEEL_POINTS`, asserted separately). The
 * translation is *measured* from labels whose position the geometry dictates exactly — sign
 * names (centred in their band) and placed point labels — and the spread of those residuals
 * is asserted, so a scale or rotation could not be silently absorbed into an offset.
 *
 * Then the drawing's square is cut out of the page and every item inside it is returned.
 * Anything a future emitter paints inside that square shows up here, whether or not the
 * geometry knows about it.
 */
function pdfWheelRegion(
  geometry: NonNullable<ReturnType<typeof projectWheel>>,
  inspected: { pages: { text: string; items: { text: string; x: number; y: number; width: number; size: number }[] }[] },
  locale: "en" | "es",
) {
  const centre = geometry.viewBox / 2;
  const deg = Math.PI / 180;
  const polar = (angle: number, radius: number) => ({
    x: centre + radius * Math.cos(angle * deg),
    y: centre + radius * Math.sin(angle * deg),
  });
  /**
   * The drawing's page, identified by something only the *drawing* paints.
   *
   * Counting sign and point labels is not enough on a paid edition: its aspect tables list
   * body names as rows, so pages 5 and 6 carry 41 and 21 "drawing" labels and a
   * majority-of-labels rule matched three pages — the drawing's, plus two tables. Picking the
   * first match happened to be right and was luck, not identification.
   *
   * A **house number** is the discriminator. It exists only inside the drawing: the paid
   * tables print "House 12 · Placidus" as part of a longer cell, never a bare numeral, and the
   * page component emits it as its own `<text>`. So the page is the one carrying both the
   * bare house numbers and the sign names, and the assertion below requires that page to be
   * unique rather than taking whichever came first.
   */
  const houseNumbers = geometry.houses.map(house => String(house.number));
  const candidates = inspected.pages.filter(candidate =>
    candidate.items.some(item => item.text === geometry.signs[0]!.label)
    && candidate.items.filter(item => houseNumbers.includes(item.text)).length >= houseNumbers.length / 2);
  assert.equal(candidates.length, 1,
    `${locale}: exactly one page carries the drawing (house numbers plus sign names); found ${candidates.length}`);
  const page = candidates[0]!;

  /**
   * The mapping's *form*, derived from the two emitters rather than assumed.
   *
   * x is a pure translation: both emitters centre the text on the same point, and the
   * measured residual is identical to within 1e-3 of a point for every label.
   *
   * y is **affine in the font size**, not constant. SVG's `dominantBaseline="middle"` centres
   * the glyph box, while React-PDF positions the *baseline*; the difference is a fraction of
   * the em, so it scales with `fontSize`. Fitting the samples gives
   * `dy = 130.24 + 0.357 * size` with a worst residual of 0.0004pt, so the two constants are
   * a property of the emitters and not of this fixture.
   *
   * The first version of this helper asserted a *single* constant offset — "every label maps
   * by the same y offset, spread < 1.5pt". That passed only because the fixture's labels
   * happen to span 7–10pt, a range whose documented 1.07pt spread sits under the threshold. It
   * was true by accident: a 12pt label would have broken it while the drawing was perfectly
   * correct. Deriving the slope instead makes the check exact and independent of which sizes
   * the fixture happens to place.
   */
  const dx: number[] = [];
  const samples: { size: number; dy: number }[] = [];
  for (const sign of geometry.signs) {
    const expected = polar(sign.labelAngle, (geometry.radii.signRing + geometry.radii.outer) / 2);
    const item = page.items.find(candidate => candidate.text === sign.label);
    assert.ok(item, `${locale}: sign ${sign.label} is painted`);
    dx.push(item.x + item.width / 2 - expected.x);
    samples.push({ size: item.size, dy: item.y - expected.y });
  }
  for (const point of geometry.points) {
    if (point.band === null) continue;
    const item = page.items.find(candidate => candidate.text === wheelLabelText(point.label));
    assert.ok(item, `${locale}: placed label ${point.label} is painted`);
    dx.push(item.x + item.width / 2 - point.labelPosition.x);
    samples.push({ size: item.size, dy: item.y - point.labelPosition.y });
  }

  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  assert.ok(spread(dx) < 0.5, `${locale}: x is a pure translation (spread ${spread(dx).toFixed(3)}pt)`);
  const offsetX = dx.reduce((sum, value) => sum + value, 0) / dx.length;

  // Least-squares fit of dy against size, then the residual bound that makes it a model
  // rather than a coincidence. Sizes must actually vary or the slope is not identified.
  assert.ok(new Set(samples.map(sample => sample.size)).size >= 3,
    `${locale}: the fixture sets labels at several sizes, so the baseline model is identified`);
  const n = samples.length;
  const sumSize = samples.reduce((sum, sample) => sum + sample.size, 0);
  const sumDy = samples.reduce((sum, sample) => sum + sample.dy, 0);
  const sumSizeSq = samples.reduce((sum, sample) => sum + sample.size ** 2, 0);
  const sumSizeDy = samples.reduce((sum, sample) => sum + sample.size * sample.dy, 0);
  const slope = (n * sumSizeDy - sumSize * sumDy) / (n * sumSizeSq - sumSize ** 2);
  const intercept = (sumDy - slope * sumSize) / n;
  const residuals = samples.map(sample => sample.dy - (intercept + slope * sample.size));
  assert.ok(Math.max(...residuals.map(Math.abs)) < 0.01,
    `${locale}: labels map by dy = ${intercept.toFixed(2)} + ${slope.toFixed(3)}*size (worst residual ${Math.max(...residuals.map(Math.abs)).toFixed(4)}pt)`);
  // The slope is the emitters' baseline-vs-glyph-box difference. Pinning it means a *scaled*
  // or *rotated* drawing cannot pass by having its distortion absorbed into the fit.
  assert.ok(slope > 0.2 && slope < 0.5, `${locale}: the baseline offset is a fraction of the em (${slope.toFixed(3)})`);

  const offsetY = intercept + slope * 9;
  const left = offsetX;
  const top = offsetY;
  const size = geometry.viewBox;
  const inside = page.items.filter(item => item.text.trim().length > 0
    && item.x + item.width > left && item.x < left + size
    && item.y > top && item.y < top + size);
  return { page, pageIndex: inspected.pages.indexOf(page), labels: inside.map(item => item.text.trim()), left, top, size, offsetX, offsetY };
}

/** Rounded to the precision both emitters write, so float noise is not a parity failure. */
const keyed = (values: number[]) => values.map(value => value.toFixed(3)).join(",");

/**
 * Two different absences, two different sentences — in both languages.
 *
 * "There is no wheel for this chart" is true of everything that lacks a wheel and therefore
 * explains nothing. A reader needs to know *why*: were the saved positions missing (a
 * remedy exists — save the chart again), or did the chart simply have no usable Ascendant
 * because it is high-latitude (the positions are real, the horizon is what was withheld)?
 * The page has always drawn that distinction from `WHEEL_NOTICE_COPY`; the PDF drew neither,
 * then drew one generic line. It now draws the same notice, chosen by the same rule.
 */
test("PDF wheel: a missing wheel says why, and the two reasons are distinguishable in EN and ES", async () => {
  const facts = fixtureFacts();
  for (const locale of ["en", "es"] as const) {
    /** No facts at all: the saved positions are absent or unverifiable. */
    const { inspected: noFacts } = await render(withoutFacts(locale));
    const missingPositions = WHEEL_NOTICE_COPY.facts_unavailable[locale];
    assert.ok(noFacts.text.includes(missingPositions), `${locale}: absence is attributed to the saved positions`);

    /**
     * Facts present, no Ascendant: a high-latitude chart whose horizon was withheld.
     * `projectWheel` refuses to approximate it, so the geometry is null while the facts are
     * not — exactly the state that must not be described as "positions unavailable".
     */
    const highLatitude = { ...facts, angles: { ...facts.angles, ascendant: null } };
    assert.equal(projectWheel(highLatitude, locale), null, `${locale}: no geometry without an Ascendant`);
    const { inspected: withheld } = await render({ ...pdfFixture(locale), wheelFacts: highLatitude });
    const noHorizon = WHEEL_NOTICE_COPY.ascendant_unavailable[locale];
    assert.ok(withheld.text.includes(noHorizon), `${locale}: absence is attributed to the withheld Ascendant`);

    /**
     * The two are not interchangeable: each document carries its own reason and *not* the
     * other's. Without this, a single generic notice would satisfy both assertions above.
     */
    assert.equal(noFacts.text.includes(noHorizon), false, `${locale}: the missing-positions case does not blame latitude`);
    assert.equal(withheld.text.includes(missingPositions), false, `${locale}: the high-latitude case does not claim the data is missing`);

    // Both still state the fact of the absence itself, so the reader is not left inferring it.
    assert.ok(noFacts.text.includes(locale === "es" ? "No hay rueda para esta carta." : "There is no wheel for this chart."));
    assert.ok(withheld.text.includes(locale === "es" ? "No hay rueda para esta carta." : "There is no wheel for this chart."));
    // And neither draws a substitute.
    assert.equal(noFacts.pages.some(page => page.items.some(item => item.text === "Aries")), false,
      `${locale}: no drawing in the missing-positions case`);
    assert.equal(withheld.pages.some(page => page.items.some(item => item.text === "Aries")), false,
      `${locale}: no drawing in the high-latitude case`);
  }
});

test("PDF wheel: the painted labels are the page's own, rendered from the same component", async () => {
  for (const locale of ["en", "es"] as const) {
    const facts = fixtureFacts();
    const geometry = projectWheel(facts, locale);
    assert.ok(geometry);
    const page = renderPageWheel(geometry, locale, withWheel(locale).chart.name);
    assert.ok(page.labels.length >= 20, `${locale}: the page paints its labels (${page.labels.length})`);

    const { inspected } = await render(withWheel(locale));
    const region = pdfWheelRegion(geometry, inspected, locale);
    assert.ok(region.labels.length >= 20, `${locale}: the PDF paints labels inside the drawing (${region.labels.length})`);

    /**
     * Two rendered multisets, compared to each other.
     *
     * Left: the `<text>` nodes of the page's own SVG. Right: every text item the PDF paints
     * inside the drawing's square, located by measured coordinates. Neither side consults
     * `wheelLabelTexts` for its expectation — that function asks the *geometry*, and both
     * emitters could drift from it together without either surface changing.
     *
     * A label painted by one surface and not the other is a failure in either direction,
     * which is what makes an extra PDF-only label (or a missing one) fail rather than pass.
     */
    const sorted = (values: string[]) => [...values].map(value => value.trim()).filter(Boolean).sort();
    assert.deepEqual(sorted(region.labels), sorted(page.labels),
      `${locale}: the PDF paints exactly the labels the page paints`);

    /**
     * Nothing outside the drawing is swept into the region.
     *
     * The heading sits directly above it and the summary rows above that, so a box drawn too
     * tall or too wide would pull them in and the multiset comparison would fail for the
     * wrong reason. Only text that exists *nowhere* in the drawing is used: a placement label
     * like "Sun" is also a wheel label, so including it would test nothing.
     */
    const wheelText = new Set([...geometry.signs.map(sign => sign.label), ...wheelLabelTexts(geometry), ...geometry.houses.map(house => String(house.number))]);
    const outside = [
      locale === "es" ? "Rueda factual" : "Factual wheel",
      ...chartPlacements(withWheel(locale).chart, locale).map(entry => entry.label).filter(label => !wheelText.has(label)),
    ];
    assert.ok(outside.length > 1, `${locale}: there is neighbouring text to exclude`);
    for (const text of outside) {
      assert.equal(region.labels.includes(text), false, `${locale}: the region excludes the neighbouring ${JSON.stringify(text.slice(0, 24))}`);
    }
  }
});

/**
 * The same region check on a **paid** document.
 *
 * The free fixture puts the wheel on a page of its own, so an extractor that simply took
 * every item on that page would pass there while being wrong. A paid edition is the hard
 * case: the wheel shares its page with the heading, the accessible name and a summary above
 * it, and the page continues with tables below. This asserts the region is exactly the
 * drawing in that geometry — the same equality as the free fixture, on the document where a
 * loose box would sweep in neighbouring text.
 */
test("PDF wheel: the paid drawing's painted labels are exactly the page's, on a shared page", async () => {
  const locale = "en" as const;
  const snapshot = calculatePaidSnapshot(randomUUID(), readingChartInput);
  const chart = { ...snapshot.chart, calculation: paidCalculationBlocks(snapshot, locale) };
  const { inspected } = await render({ chart, content: pdfFixture(locale, "paid").content, wheelFacts: snapshot.facts });
  const geometry = projectWheel(snapshot.facts, locale);
  assert.ok(geometry);
  const region = pdfWheelRegion(geometry, inspected, locale);
  /**
   * The page really is shared — and by what, exactly.
   *
   * The wheel lands on the page after the paid cover, which also carries the running header.
   * (An earlier version of this assertion looked for "Saved chart summary", which is on the
   * *cover*: the check was wrong about the layout, not the layout about the check.) Below the
   * drawing the document continues with the calculation tables, so this document is the case
   * where a loose region would sweep in a neighbouring page's worth of text.
   */
  assert.ok(region.page.items.some(item => item.text === "YOUR SOLAR RETURN"),
    "the wheel page also carries the document's running header");
  const tablePages = inspected.pages.flatMap((candidate, index) => candidate.text.includes("Return placements · Placidus") ? [index] : []);
  assert.ok(tablePages.length > 0, "the paid document has calculation tables");
  assert.equal(tablePages.includes(region.pageIndex), false,
    "the calculation tables are on a different page from the drawing");
  const pageWheel = renderPageWheel(geometry, locale, chart.name);
  const sorted = (values: string[]) => [...values].map(value => value.trim()).filter(Boolean).sort();
  assert.deepEqual(sorted(region.labels), sorted(pageWheel.labels),
    "on a shared page the region still contains exactly the drawing's labels");
});

test("PDF wheel: the page's line and circle primitives are the PDF's, coordinate for coordinate", async () => {
  const locale = "en" as const;
  const geometry = projectWheel(fixtureFacts(), locale);
  assert.ok(geometry);
  const page = renderPageWheel(geometry, locale, "Synthetic Reading");
  const drawn = pdfTreeGeometry(geometry);

  /**
   * Both emitters are normalised to the same tuple set and compared as multisets.
   *
   * The page draws in SVG units, the PDF in points, but both author the *same* geometry
   * units — `PDF_WHEEL_POINTS` exists precisely to keep that 1:1. So the tuples must match
   * exactly. Segments are keyed with their endpoints sorted: a chord drawn backwards is the
   * same chord, and neither emitter is required to pick the same direction.
   */
  const segmentKeys = (lines: { x1: number; y1: number; x2: number; y2: number }[]) => lines.map(({ x1, y1, x2, y2 }) =>
    [[x1, y1], [x2, y2]].map(([x, y]) => keyed([x, y])).sort().join("|")).sort();
  assert.ok(page.lines.length > 40, `the page draws its primitives (${page.lines.length} lines)`);
  assert.deepEqual(segmentKeys(drawn.lines), segmentKeys(page.lines), "every line the page draws, the PDF draws in the same place");

  const circleKeys = (circles: { cx: number; cy: number; r: number }[]) => circles.map(({ cx, cy, r }) => keyed([cx, cy, r])).sort();
  assert.deepEqual(circleKeys(drawn.circles), circleKeys(page.circles), "every circle the page draws, the PDF draws in the same place");
});

test("PDF wheel: the emitted coordinates are the geometry's own, and the drawing is primitives", async () => {
  const geometry = projectWheel(fixtureFacts(), "en");
  assert.ok(geometry);
  const drawn = pdfTreeGeometry(geometry);
  assert.equal(drawn.images, 0, "no raster/path image stands in for the drawing");

  // Circles: outer, sign ring, house ring, aspect ring, plus one anchor per point.
  const rings = drawn.circles.filter(circle => circle.r > 10).map(circle => circle.r).sort((a, b) => a - b);
  assert.deepEqual(rings, [geometry.radii.aspectRing, geometry.radii.houseRing, geometry.radii.outer, geometry.radii.signRing].sort((a, b) => a - b));

  const centre = geometry.viewBox / 2;
  const deg = Math.PI / 180;
  const polar = (angle: number, radius: number) => ({
    x: centre + radius * Math.cos(angle * deg),
    y: centre + radius * Math.sin(angle * deg),
  });
  /** Segments are compared as unordered endpoints: a chord drawn backwards is the same chord. */
  const segment = (x1: number, y1: number, x2: number, y2: number) => {
    const ends = [[x1, y1], [x2, y2]].map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).sort();
    return ends.join("|");
  };
  const drawnSegments = new Map<string, number>();
  for (const line of drawn.lines) {
    const key = segment(line.x1, line.y1, line.x2, line.y2);
    drawnSegments.set(key, (drawnSegments.get(key) ?? 0) + 1);
  }

  /**
   * Whole segments, not just their starts.
   *
   * The first version of this test compared only `x1`/`y1` and counted anchors without
   * checking their positions. Moving a chord's *second* endpoint by 3 units therefore passed
   * both this test and the label test — a visibly wrong chord in a "verified" PDF. Comparing
   * complete segments as a multiset catches a moved end, a swapped pairing, and a dropped
   * chord alike; counting anchors by radius catches a moved anchor.
   */
  const expectSegment = (a: { x: number; y: number }, b: { x: number; y: number }, what: string) => {
    const key = segment(a.x, a.y, b.x, b.y);
    const remaining = drawnSegments.get(key) ?? 0;
    assert.ok(remaining > 0, `${what}: segment drawn exactly where the geometry puts it`);
    drawnSegments.set(key, remaining - 1);
  };

  for (const house of geometry.houses) {
    expectSegment(polar(house.angle, geometry.radii.aspectRing), polar(house.angle, geometry.radii.signRing), `house ${house.number} cusp`);
  }
  for (const sign of geometry.signs) {
    expectSegment(polar(sign.startAngle, geometry.radii.signRing), polar(sign.startAngle, geometry.radii.outer), `sign ${sign.index} boundary`);
  }
  for (const [index, chord] of geometry.chords.entries()) {
    const from = geometry.points.find(point => point.id === chord.a);
    const to = geometry.points.find(point => point.id === chord.b);
    assert.ok(from && to, `chord ${index} endpoints exist`);
    expectSegment(polar(from.angle, geometry.radii.aspectRing), polar(to.angle, geometry.radii.aspectRing), `chord ${chord.a}|${chord.b}`);
  }
  for (const point of geometry.points) {
    assert.ok(drawn.circles.some(circle => circle.r <= 10 && Math.abs(circle.cx - point.anchor.x) < 1e-9 && Math.abs(circle.cy - point.anchor.y) < 1e-9),
      `${point.id}: anchor drawn at the geometry's own position, not merely counted`);
    if (point.leader) {
      expectSegment(point.leader.from, point.leader.to, `${point.id} leader`);
    }
  }

  // Nothing left over: every drawn segment came from the geometry, and the tick count matches.
  const leftover = [...drawnSegments.entries()].filter(([, count]) => count > 0);
  const expectedLeftover = geometry.ticks.length;
  assert.equal(leftover.reduce((sum, [, count]) => sum + count, 0), expectedLeftover,
    `only the ${expectedLeftover} ticks remain unaccounted for; a stray segment means the PDF drew something the geometry did not`);
});

test("PDF wheel: labels are drawn at the geometry's own type size, never re-derived", async () => {
  const geometry = projectWheel(fixtureFacts(), "en");
  assert.ok(geometry);
  const tree = PdfChartWheel({ text: { title: "", caption: "" }, geometry, renderer: renderer as never });
  const sizes: number[] = [];
  walk(tree, node => {
    if (node.type !== renderer.Text) return;
    const size = (node.props.style as { fontSize?: number } | undefined)?.fontSize;
    if (typeof size === "number") sizes.push(size);
  });
  for (const point of geometry.points) {
    if (point.band === null) continue;
    const expected = geometry.labelFontSize[point.id] ?? WHEEL_MIN_LABEL_FONT;
    assert.ok(sizes.includes(expected), `${point.id}: drawn at the geometry's ${expected}`);
  }
  // The floor is respected: an omitted label is omitted, never shrunk below the floor.
  for (const size of geometry.points.filter(p => p.band !== null).map(p => geometry.labelFontSize[p.id] ?? WHEEL_MIN_LABEL_FONT)) {
    assert.ok(size >= WHEEL_MIN_LABEL_FONT, `${size} >= floor`);
  }
});

test("PDF wheel: the glyph set contains every wheel string and the wheel block cannot be paginated", async () => {
  const facts = fixtureFacts();
  const geometry = projectWheel(facts, "en");
  assert.ok(geometry);
  const input = withWheel("en");
  const drawn = wheelDrawingText(geometry);
  const wheel = wheelCopy({ chart: input.chart, content: input.content, geometry, hasFacts: true });
  assert.ok(drawn.length > 20, `the drawing carries sign, house and point text (${drawn.length})`);
  const strings = pdfStrings({ chart: input.chart, content: input.content, geometry, hasFacts: true, renderer });
  for (const text of drawn) assert.ok(strings.includes(text), `glyph set contains ${JSON.stringify(text)}`);
  // The words around the drawing are in the set too — heading, accessible name, caption and
  // every omission notice. They are built by the same `wheelCopy` object the layout renders,
  // so a copy change cannot reach one without the other. Before this, only the drawing's own
  // characters were gated and the surrounding templates could introduce an unsupported glyph
  // while the gate still said yes.
  for (const text of [wheel.heading, wheel.title, wheel.caption, ...wheel.notices]) {
    assert.ok(strings.includes(text), `glyph set contains the wheel copy ${JSON.stringify(text.slice(0, 32))}`);
  }

  // Without a wheel the set carries the *explanation* instead of the drawing: the chart's own
  // labels are absent, and the sentence a reader needs is present and gated.
  const bare = pdfStrings({ chart: input.chart, content: input.content, geometry: null, hasFacts: false, renderer });
  // Only *drawing-only* text must disappear. A sign name like "Taurus" also appears in the
  // document's own prose ("Sun Taurus"), so asserting its absence would test the fixture, not
  // the wheel. House numbers and placed labels are the clean signal: they exist nowhere else.
  /**
   * The clean signal is the *truncated* label form the drawing prints.
   *
   * Point labels are truncated to `WHEEL_MAX_LABEL_CHARS` for the drawing, so a placed label
   * at the limit ("Sagittarius") proves the set is drawing-aware without colliding with the
   * prose: the document's own summary prints the untruncated word, and `Ascendant` is an
   * ordinary row there. House numbers are unique to the drawing. Neither can appear by
   * accident in a chart that draws nothing.
   */
  const drawingOnly = [
    ...geometry.points.filter(point => point.band !== null).map(point => wheelLabelText(point.label)).filter(label => label.length >= 10),
    ...geometry.houses.map(house => String(house.number)),
  ];  assert.ok(drawingOnly.length > 5, "enough drawing-only text to be meaningful");
  for (const text of drawingOnly) assert.equal(bare.includes(text), false, `absent wheel omits ${JSON.stringify(text)}`);
  const bareCopy = wheelCopy({ chart: input.chart, content: input.content, geometry: null, hasFacts: false });
  assert.ok(bareCopy.absent, "an absent wheel still has copy");
  assert.ok(bare.includes(bareCopy.absent!), "the absent-wheel sentence is gated too");

  // The unbreakable-block guarantee is a property of the `Svg` primitive: React-PDF lists it
  // in NON_WRAP_TYPES, so the type refuses a `wrap` prop and no caller can opt in to splitting.
  const tree = PdfChartWheel({ text: { title: "", caption: "" }, geometry, renderer: renderer as never });
  const svgs: Record<string, unknown>[] = [];
  walk(tree, node => { if (node.type === renderer.Svg) svgs.push(node.props); });
  assert.equal(svgs.length, 1, "exactly one Svg");
  const [svgProps] = svgs;
  assert.equal("wrap" in svgProps, false, "the emitter does not pass a wrap prop it cannot honour");
  assert.equal(svgProps.viewBox, `0 0 ${WHEEL_VIEW_BOX} ${WHEEL_VIEW_BOX}`);
  assert.equal(svgProps.width, PDF_WHEEL_POINTS);
  assert.equal(svgProps.height, PDF_WHEEL_POINTS);
});

test("PDF wheel: page count grows by a measured, bounded amount when the wheel is added", async () => {
  for (const locale of ["en", "es"] as const) {
    const bare = await pdfRenderer.render(withoutFacts(locale));
    const wheeled = await pdfRenderer.render(withWheel(locale));
    const delta = wheeled.pages - bare.pages;
    // 340pt of drawing cannot fit an existing page without pushing content;
    // the wheel is one unbreakable block, so growth is 0 or 1 pages, never more.
    assert.ok(delta >= 0 && delta <= 1, `${locale}: page delta ${delta} is 0 or 1 (bare ${bare.pages}, wheeled ${wheeled.pages})`);
    console.log(`  ${locale}: ${bare.pages} -> ${wheeled.pages} pages (+${delta})`);
  }
});

/**
 * A paid edition draws *its own* pinned Placidus facts, not the whole-sign ones.
 *
 * The previous version of this test injected `fixtureFacts()` (whole-sign) into a paid
 * document and ended its Placidus assertion in `|| true` — a placeholder that asserted
 * nothing. The existing snapshots are charts with no facts at all, so their stability proves
 * no-wheel compatibility and says nothing about a real paid edition gaining a wheel.
 *
 * This builds genuinely Placidus facts through the same calculator the paid route uses and
 * asserts the document names the system and draws twelve cusps from it.
 */
test("PDF wheel: facts ride to the worker inside the one shared bound", async () => {
  // The behavioural bound is what the plan asks for: a payload carrying max-size facts is
  // admitted by both sides, and one byte over is rejected by both.
  const facts = fixtureFacts();
  const pad = (count: number) => ({
    ...facts,
    bodies: [...facts.bodies, ...Array.from({ length: count }, (_, i) => ({ ...facts.bodies[0], body: `Padding${i}`, sign: 0, degree: 0 }))],
  }) as typeof facts;
  const big = JSON.stringify({ chart: pdfFixture("en").chart, content: pdfFixture("en").content, wheelFacts: pad(9000) });
  assert.ok(Buffer.byteLength(big) > PDF_INPUT_BYTES, `the padded payload really exceeds the shared bound (${Buffer.byteLength(big)} > ${PDF_INPUT_BYTES})`);
  console.log(`  real wheeled payload: ${Buffer.byteLength(JSON.stringify({ chart: pdfFixture("en").chart, content: pdfFixture("en").content, wheelFacts: facts }))} bytes of ${PDF_INPUT_BYTES}`);
  // And the parent rejects it before spending a worker: the bound is enforced, not decorative.
  await assert.rejects(pdfRenderer.render({ ...pdfFixture("en"), wheelFacts: pad(9000) }),
    (error: unknown) => error instanceof ReadingPdfError && error.code === "pdf_input_limit");
  assert.ok(PDF_INPUT_BYTES > READING_LIMITS.documentBytes + READING_LIMITS.chartBytes, "the shared bound accounts for facts");
  assert.equal(READING_LIMITS.baseFactsBytes, BASE_FACTS_BYTES, "presentation and chart-facts agree on the facts bound");
  // The legitimate maximum still fits: the bound is not the reason a real save is rejected.
  const real = JSON.stringify({ chart: pdfFixture("en").chart, content: pdfFixture("en").content, wheelFacts: facts });
  assert.ok(Buffer.byteLength(real) <= PDF_INPUT_BYTES, `a real wheeled payload fits (${Buffer.byteLength(real)} bytes)`);
});

test("PDF wheel: a legacy chart's chartNotes still renders without a wheel or facts", async () => {
  const input = pdfFixture("en");
  const content = chartNotes(input.chart, { sun: "SUN_NOTE", moon: "MOON_NOTE", ascendant: "ASC_NOTE", house: "HOUSE_NOTE" }, "en", true);
  const result = await pdfRenderer.render({ ...input, content });
  const inspected = await inspectPdf(result.buffer);
  // The block is headed and explains itself, exactly as the page does for the same chart.
  assert.ok(inspected.text.includes("Factual wheel"), "the block is present and headed");
  // `pdfFixture` carries no calculation blocks, so the short sentence is the correct one:
  // promising a table the document does not carry would be the worse failure.
  assert.ok(inspected.text.includes("There is no wheel for this chart."), "the absence is explained");
  assert.equal(inspected.text.includes("authoritative reference"), false,
    "no pointer to a table this document does not render");
  assert.ok(inspected.text.includes("SUN_NOTE"), "existing legacy content is untouched");
});

/**
 * The bound is enforced by *both* sides, and a one-sided change must fail here.
 *
 * The parent admits input (`pdf-render.ts`) and the child re-checks it (`pdf-worker.ts`).
 * A desync — parent loosened, child unchanged — is invisible to a test that only asks the
 * parent to reject, because the child is the one that then refuses the payload and the
 * render fails with a *different* code. So the assertion is on the failure code, not on
 * "something threw": the honest limit is `pdf_input_limit` from the parent's guard.
 *
 * `git diff`-level enforcement is not possible in a unit test, so this reads both modules'
 * source and asserts neither re-spells the sum. That is the same guard the plan describes.
 */
test("PDF wheel: parent and child spell the input bound the same way", async () => {
  const { readFileSync } = await import("node:fs");
  const render = readFileSync(resolve("src/readings/pdf-render.ts"), "utf8");
  const worker = readFileSync(resolve("src/readings/pdf-worker.ts"), "utf8");
  for (const [name, source] of [["pdf-render", render], ["pdf-worker", worker]] as const) {
    assert.ok(source.includes("PDF_INPUT_BYTES"), `${name} imports the shared bound`);
    // No module may reconstruct the sum from its parts: that is how two bounds drift.
    assert.equal(/documentBytes\s*\+\s*READING_LIMITS\.chartBytes/.test(source), false, `${name} does not re-spell the sum`);
    assert.equal(/READING_LIMITS\.documentBytes\s*\+/.test(source), false, `${name} does not add limits locally`);
  }
  // And the serializer sends one object — the normalized payload — so what the parent
  // measures is what the child reads. `chart.baseFacts` is dropped and promoted to
  // `wheelFacts`, so the facts cross the boundary once rather than twice.
  assert.ok(render.includes("JSON.stringify(pdfIpcPayload(input))"), "the parent serializes the normalized payload");
  const payload = pdfIpcPayload(withWheel("en"));
  assert.equal("baseFacts" in payload.chart, false, "the stored facts do not cross twice");
  assert.ok(payload.wheelFacts, "the facts still cross, once");
});

/**
 * The two defects the raster caught and text extraction could not.
 *
 * Both were "passing" by every assertion above: the strings were in the content stream, the
 * glyph set was complete, the coordinates were right. They were invisible on the page. These
 * tests encode what the eye caught, so the class cannot come back silently.
 *
 * They are geometric rather than pixel-diffing on purpose: a snapshot would fail for every
 * future intentional change, while these fail only when the specific invariant breaks.
 */
/**
 * No opaque halo is painted behind the labels, and that is a deliberate difference from the
 * page — so it is asserted rather than left to drift back.
 *
 * The page punches a halo with `paintOrder="stroke"`: the halo *is* the glyph outline, so it
 * can only cover what the glyph covers. React-PDF has neither `paintOrder` nor outline
 * strokes, leaving an opaque rectangle sized from geometry. Every placed label sits on the
 * sign band, so such a rectangle covered a zodiac name (Gemini and Taurus in this fixture)
 * with the page colour — the glyphs stayed in the content stream, so nothing failed, but a
 * reader lost two sign names. The raster is what showed it.
 *
 * If a future change reintroduces a background box, this fails and the author has to say why
 * covering a sign name is acceptable.
 */
test("PDF wheel: labels are painted without an opaque background box", () => {
  const geometry = projectWheel(fixtureFacts(), "en")!;
  const tree = PdfChartWheel({ text: { title: "", caption: "" }, geometry, renderer: renderer as never }) as unknown as { props: { children: unknown } };
  const rects: unknown[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const element = node as { type?: unknown; props?: { children?: unknown } };
    if (element.type === "RECT" || element.type === renderer.Rect) rects.push(element);
    if (element.props) walk(element.props.children);
  };
  walk(tree.props.children);
  assert.deepEqual(rects, [], "the wheel paints no filled rectangles");
  // And the labels themselves are still there: absence of a halo must not mean absence of text.
  assert.ok(geometry.points.filter(point => point.band !== null).length > 5, "labels are still placed");
});

/**
 * The wheel's text sits on the page, not above it.
 *
 * The accessible name and the caption were once `<Text>` children of the `Svg` at
 * `y = -14` and `y = viewBox + 12` — outside the drawing's viewport, so `Svg` clipped them.
 * Extraction still reported them, which is why they survived three rounds of tests. A glyph
 * that is claimed but not painted is a worse defect than a missing one: the document looks
 * unfinished and nothing fails.
 */
test("PDF wheel: the title and caption are painted inside the page body", async () => {
  for (const locale of ["en", "es"] as const) {
    const { inspected } = await render(withWheel(locale));
    const page = inspected.pages.find(candidate =>
      candidate.items.some(item => item.text === (locale === "es" ? "Rueda factual" : "Factual wheel")));
    assert.ok(page, `${locale}: the wheel has a page`);

    // Both strings must be present as painted text, not merely in the glyph set. Matching is
    // done on the page's items joined in content order: a caption wraps across several text
    // runs, so a phrase regex against any single run finds nothing even when the words are on
    // the sheet — which is how the first version of this test "failed" on a correct PDF.
    const joined = normalizePdfText(page.items.map(item => item.text).join(" "));
    const titleCopy = locale === "es" ? "Carta factual de Synthetic Reading" : "Factual chart for Synthetic Reading";
    const captionCopy = locale === "es"
      ? "Las tablas numéricas de este PDF son el equivalente autoritativo de este dibujo."
      : "The numerical tables in this PDF are the authoritative equivalent of this drawing.";
    assert.ok(joined.includes(titleCopy), `${locale}: the accessible name is painted`);
    assert.ok(joined.includes(captionCopy), `${locale}: the table pointer is painted`);

    // Geometry, not just presence: a leaked SVG viewBox transform keeps the string and moves
    // the glyphs. While the drawing was 340pt wide over a 440-unit viewBox, this title was
    // painted at 6.95pt instead of 9pt and the caption at 6.18pt instead of 8pt.
    const decorated = [
      { pattern: new RegExp(`^${titleCopy.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"), size: 9, what: "title" },
      { pattern: /retorno solar, casas de|chart for the solar return/u, size: 8, what: "caption" },
    ];
    for (const { pattern, size, what } of decorated) {
      const found = page.items.find(item => pattern.test(item.text));
      assert.ok(found, `${locale}: the ${what} is found for measurement`);
      assert.ok(Math.abs(found.size - size) < 0.6,
        `${locale}: the ${what} is drawn at ${found.size.toFixed(2)}pt, not ${size}pt`);
      assert.ok(found.y > 60 && found.y < 800, `${locale}: the ${what} sits inside the body (y=${found.y.toFixed(1)})`);
      assert.ok(found.x >= 40 && found.x < 555, `${locale}: the ${what} sits inside the margins (x=${found.x.toFixed(1)})`);
    }
  }
});

/**
 * The font the gate validates must be the font the drawing uses.
 *
 * This is the blocker from review, and no existing test could see it: the SVG text nodes set
 * no `fontFamily`, so React-PDF drew them in Helvetica/WinAnsi while the gate checked Noto
 * Sans. The faces agree on ASCII and diverge exactly where it matters — "ı" (dotless i) is
 * in Noto and absent from WinAnsi, so a chart that *passed* the gate rendered "Plut1".
 *
 * The assertion uses that character rather than a font name, because a `fontFamily` that
 * React-PDF silently ignored would satisfy a source check and still substitute.
 */
test("PDF wheel: the drawing renders in the font the glyph gate validates", async () => {
  const geometry = projectWheel(fixtureFacts(), "en")!;
  // Force a Noto-only character into a label the way a future projector could.
  const mutated = { ...geometry, points: geometry.points.map(point => (point.id === "Pluto" ? { ...point, label: "Plutı" } : point)) };
  const text = await renderedGeometryText(mutated);
  assert.ok(text.includes("Plutı"), `the dotless i survives the worker, got ${JSON.stringify(text.slice(0, 80))}`);
  assert.equal(text.includes("Plut1"), false, "no WinAnsi substitution");
});

test("PDF wheel: the drawing embeds no standard Type1 bold face", async () => {
  const { buffer } = await pdfRenderer.render(withWheel("en"));
  const raw = buffer.toString("latin1");
  // Bold point labels used to be drawn in Helvetica-Bold. The embedded Noto bold face must be
  // used instead: a Type1 face would mean the drawing is not the font the gate checked.
  assert.ok(/NotoSans-Bold/.test(raw), "the bold face is the embedded Noto");
  assert.equal(/Helvetica-Bold/.test(raw), false, "the drawing does not fall back to Helvetica-Bold");
});

/**
 * A production-shaped document: a wheel *and* the calculation blocks the save path stores.
 *
 * The earlier fixtures had one or the other, which is how a caption promising "this same
 * page" shipped while the calculation loop starts a new `Page` and puts the tables overleaf.
 */
function withCalculation(locale: "en" | "es" = "en"): ReadingPdfInput {
  const input = withWheel(locale);
  const calculation = frozenReading(locale).sections
    .flatMap(section => section.blocks)
    .filter(block => block.kind === "aspectTable");
  assert.ok(calculation.length > 0, "the fixture carries an aspect table to place");
  return { ...input, chart: { ...input.chart, calculation } as ReadingPdfInput["chart"] };
}

test("PDF wheel: the table pointer names the document, not the wheel's own page", async () => {
  for (const locale of ["en", "es"] as const) {
    const { inspected } = await render(withCalculation(locale));
    const pointer = locale === "es"
      ? "Las tablas numéricas de este PDF son el equivalente autoritativo de este dibujo."
      : "The numerical tables in this PDF are the authoritative equivalent of this drawing.";
    const wheelPage = inspected.pages.findIndex(page => page.items.some(item => item.text === (locale === "es" ? "Rueda factual" : "Factual wheel")));
    const pointerPage = inspected.pages.findIndex(page => normalizePdfText(page.text).includes(pointer));
    assert.ok(wheelPage >= 0, `${locale}: the wheel has a page`);
    assert.equal(pointerPage, wheelPage, `${locale}: the pointer travels with the drawing`);

    /**
     * The fact that made "this same page" wrong, measured rather than assumed.
     *
     * The calculation loop emits a `Page` per table, so the wheel ends its page and the table
     * opens the next one. This is the shape a real saved chart has — the earlier fixtures
     * carried a wheel *or* a table, never both, which is how the false wording survived.
     */
    const tablePage = inspected.pages.findIndex(page => /Example aspects|Aspectos de ejemplo/u.test(page.text));
    assert.ok(tablePage > wheelPage,
      `${locale}: the calculation table starts after the wheel page (wheel ${wheelPage + 1}, table ${tablePage + 1})`);
  }
});

/**
 * Both ends enforce the bound, exercised as a child rather than inferred from source.
 *
 * The parent's guard is not the only one: the worker re-checks the byte length it receives,
 * so a compromised or out-of-date parent cannot push an oversized render through. A test that
 * only asks the parent to reject cannot see that second guard at all — and the earlier version
 * of this check asserted only that the constant *appears* in both files.
 *
 * The child is started exactly as the bootstrap does, given an over-bound payload, and must
 * answer with `pdf_input_limit` before any layout work begins.
 */
test("PDF wheel: the worker itself rejects an over-bound payload", async () => {
  const { fork } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const bootstrap = resolve(".pdf/bootstrap.mjs");
  assert.ok(existsSync(bootstrap), "the packaged worker exists (built in before())");

  const child = fork(bootstrap, [], {
    cwd: resolve(".pdf"), env: { NODE_ENV: "production", TZ: "UTC", LANG: "C.UTF-8" },
    execArgv: ["--no-warnings"], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
  });
  try {
    const oversized = "x".repeat(PDF_INPUT_BYTES + 1024);
    const outcome = await new Promise<string>((settle, fail) => {
      const timer = setTimeout(() => fail(new Error("worker did not answer in time")), 20_000);
      child.once("message", (message: { kind?: string; code?: string }) => {
        clearTimeout(timer);
        settle(message.code ?? message.kind ?? "unknown");
      });
      child.once("error", fail);
      child.send({ kind: "render", input: oversized });
    });
    assert.equal(outcome, "pdf_input_limit", "the child refuses before layout");
  } finally {
    child.kill();
  }
});

/**
 * A route-shaped payload carries the facts once.
 *
 * `chart.baseFacts` (the stored row) and `wheelFacts` (the value the handler forwards) are the
 * same facts on a real request. Serializing both defeats the single-bound rationale and
 * doubles the accounting, so the IPC payload normalizes them into one field.
 */
test("PDF wheel: a route-shaped payload serializes the facts exactly once", () => {
  const facts = fixtureFacts();
  const routeShaped: ReadingPdfInput = { ...withWheel("en"), chart: { ...pdfFixture("en").chart, baseFacts: facts }, wheelFacts: facts };
  const payload = pdfIpcPayload(routeShaped);
  const serialized = JSON.stringify(payload);
  assert.equal("baseFacts" in payload.chart, false, "the stored copy is dropped");
  assert.ok(payload.wheelFacts, "one copy remains");
  // The facts' own marker appears once, not twice.
  const marker = JSON.stringify(facts);
  assert.equal(serialized.split(marker).length - 1, 1, "exactly one copy of the facts is on the wire");
  // Document content is untouched: the calculation blocks are not a fact cache.
  assert.deepEqual(payload.chart.calculation, routeShaped.chart.calculation, "calculation blocks still cross");
});

/**
 * Adding the wheel to a **real paid edition** changes the wheel and nothing else.
 *
 * Two things were wrong with the previous version, both caught in review. It started from
 * `pdfFixture(locale, "paid")`, a *frozen free-tier-shaped* document: a whole-sign summary,
 * no `chart.calculation`, then freshly cast Placidus facts bolted on. So the wheel said
 * Placidus while the summary and the (absent) calculation pages said nothing of the kind, and
 * no comparison could have caught a paid calculation block being lost or reordered — there
 * were none. It also skipped the cover and dropped the entire wheel page, which carries
 * non-wheel copy that could vanish unnoticed.
 *
 * This builds the presentation the way `loadPaidPresentation` does: `calculatePaidSnapshot`
 * for the pinned facts, `paidCalculationBlocks` for the table pages, paired with the stored
 * paid document. Then it removes *only* the wheel region — the block between the "Factual
 * wheel" heading and the next section — and asserts everything else is identical in order,
 * cover included.
 */
test("PDF wheel: a pinned paid edition keeps its summary, tables and metadata when the wheel is added", async () => {
  for (const locale of ["en", "es"] as const) {
    const snapshot = calculatePaidSnapshot(randomUUID(), readingChartInput);
    assert.equal(snapshot.facts.houseSystem, "placidus");
    assert.equal(snapshot.chart.result.houseSystem, "Placidus");
    const chart = { ...snapshot.chart, calculation: paidCalculationBlocks(snapshot, locale) };
    // The pinned Placidus facts and the blocks the paid route renders — a paid presentation,
    // not a free document wearing Placidus labels.
    assert.ok(chart.calculation.some(block => block.kind === "aspectTable"), `${locale}: calculation pages exist`);
    assert.ok(chart.calculation.some(block => "title" in block && (block.title ?? "").includes("Placidus")), `${locale}: the tables name the system`);
    const input: ReadingPdfInput = { chart, content: pdfFixture(locale, "paid").content };

    // One render at a time: the renderer admits a single slot by design.
    const bare = await render(input);
    const wheeled = await render({ ...input, wheelFacts: snapshot.facts });
    assert.equal(wheeled.inspected.pages.length, bare.inspected.pages.length + 1,
      `${locale}: the wheel adds exactly one page (${bare.inspected.pages.length} -> ${wheeled.inspected.pages.length})`);

    /**
     * Without the facts the document explains itself — and the calculation pages are still
     * there, which is what makes this a paid edition rather than a bare chart.
     */
    assert.ok(bare.inspected.text.includes(locale === "es" ? "No hay rueda para esta carta." : "There is no wheel for this chart."));
    assert.ok(bare.inspected.text.includes(paidCalculationBlocks(snapshot, locale)[0]!.kind === "keyValue" ? "Placidus" : "Placidus"),
      `${locale}: the bare paid edition still prints its Placidus tables`);

    /**
     * The wheel says Placidus, and says it in its own words.
     *
     * A `Placidus` substring over the whole document proves nothing: the paid calculation
     * tables print "Return placements · Placidus" themselves, so the wheel could be wrong
     * and the assertion would still pass — which is how a +18 shift of every Placidus anchor
     * survived. The house system is read from the wheel's *caption*, inside its own block.
     */
    const geometry = projectWheel(snapshot.facts, locale);
    assert.ok(geometry);
    assert.equal(geometry.houseSystem, "placidus");
    const wheeledCopy = wheelCopy({ chart, content: input.content, geometry, hasFacts: true });
    assert.ok(wheeledCopy.caption.includes("Placidus"), `${locale}: the wheel's caption names the system`);
    const block = wheeled.inspected.pages.map(page => page.text).join(" ");
    const heading = locale === "es" ? "Rueda factual" : "Factual wheel";
    const trailer = locale === "es" ? "Cálculo preliminar" : "Prototype calculation";
    const at = block.indexOf(heading);
    const end = block.indexOf(trailer, at);
    assert.ok(at >= 0 && end > at, `${locale}: the wheel block is locatable`);
    assert.ok(block.slice(at, end).includes("Placidus"), `${locale}: the wheel block itself names Placidus`);

    /**
     * The PDF paints the snapshot's own projection — compared against the **emitted tree**.
     *
     * `anchorOf` searched `projectWheel(snapshot.facts)` itself, so it verified the geometry
     * against itself and could not see the emitter at all: shifting every Placidus anchor in
     * `pdf-chart-wheel.tsx` by +18 on x left both paid tests green. `pdfTreeGeometry` reads
     * the primitives the emitter actually built, which is the only thing that can catch it.
     *
     * Every anchor is matched to a point by its expected position on the outer ring, and the
     * *set* of matched points must be all fourteen — so a point that moved matches nothing and
     * the leftover itself fails. Then each cusp line, chord and leader is required at the
     * geometry's coordinates, and any leftover primitive is a failure.
     */
    const drawn = pdfTreeGeometry(geometry);
    const centre = geometry.viewBox / 2;
    const deg = Math.PI / 180;
    const polar = (angle: number, radius: number) => ({
      x: centre + radius * Math.cos(angle * deg),
      y: centre + radius * Math.sin(angle * deg),
    });
    const keyedPoint = ({ x, y }: { x: number; y: number }) => `${x.toFixed(3)},${y.toFixed(3)}`;
    const drawnAnchors = new Set(drawn.circles.filter(circle => circle.r <= 10).map(circle => keyedPoint({ x: circle.cx, y: circle.cy })));
    assert.equal(drawnAnchors.size, geometry.points.length,
      `${locale}: the wheel paints exactly one anchor per projected point (${drawnAnchors.size} of ${geometry.points.length})`);
    for (const point of geometry.points) {
      // `point.anchor` is the geometry's own emitted coordinate — computed from the
      // *unrounded* angle, which a recomputation from `point.angle` would miss at 3 dp. The
      // expectation therefore comes from the snapshot's projection and the assertion is
      // against the emitter's output, which is the comparison that was missing.
      const expected = keyedPoint(point.anchor);
      assert.ok(drawnAnchors.has(expected),
        `${locale}: ${point.id} is painted where the snapshot's projection puts it`);
    }
    const segmentKey = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      [keyedPoint(a), keyedPoint(b)].sort().join("|");
    const drawnSegments = new Map<string, number>();
    for (const line of drawn.lines) {
      const key = [keyedPoint({ x: line.x1, y: line.y1 }), keyedPoint({ x: line.x2, y: line.y2 })].sort().join("|");
      drawnSegments.set(key, (drawnSegments.get(key) ?? 0) + 1);
    }
    const expectSegment = (a: { x: number; y: number }, b: { x: number; y: number }, what: string) => {
      const key = segmentKey(a, b);
      const remaining = drawnSegments.get(key) ?? 0;
      assert.ok(remaining > 0, `${locale}: ${what} is painted at the snapshot's coordinates`);
      drawnSegments.set(key, remaining - 1);
    };
    for (const house of geometry.houses) {
      expectSegment(polar(house.angle, geometry.radii.aspectRing), polar(house.angle, geometry.radii.signRing), `house ${house.number} cusp`);
    }
    for (const chord of geometry.chords) {
      const from = geometry.points.find(candidate => candidate.id === chord.a)!;
      const to = geometry.points.find(candidate => candidate.id === chord.b)!;
      expectSegment(polar(from.angle, geometry.radii.aspectRing), polar(to.angle, geometry.radii.aspectRing), `chord ${chord.a}|${chord.b}`);
    }
    for (const point of geometry.points) {
      if (point.leader) expectSegment(point.leader.from, point.leader.to, `${point.id} leader`);
    }
    // Sign boundaries are drawn by both emitters from the ring index, not from a tick.
    for (const sign of geometry.signs) {
      expectSegment(polar(sign.startAngle, geometry.radii.signRing), polar(sign.startAngle, geometry.radii.outer), `sign ${sign.index} boundary`);
    }
    const leftovers = [...drawnSegments.entries()].filter(([, count]) => count > 0).reduce((sum, [, count]) => sum + count, 0);
    assert.equal(leftovers, geometry.ticks.length,
      `${locale}: only the ${geometry.ticks.length} ticks are unaccounted for — a stray primitive means the PDF drew something the snapshot does not project`);

    /**
     * Everything outside the wheel region is identical and in order.
     *
     * The region runs from the "Factual wheel" heading to the disclaimer that follows it,
     * and is removed from *both* documents before comparing: the wheeled one holds the
     * drawing there, the bare one its absence sentence and reason. Excising the region — the
     * whole document read as one ordered sequence, rather than dropping an entire page —
     * compares the cover, the summary and every table, so copy outside the wheel cannot
     * disappear unnoticed. Page boundaries are not compared because the wheel legitimately
     * adds one.
     */
    const strip = (inspected: Awaited<ReturnType<typeof render>>["inspected"]) => {
      const flat = inspected.pages.map(page => page.text).join(" ");
      const at = flat.indexOf(heading);
      assert.ok(at >= 0, `${locale}: the wheel block is present`);
      const tail = flat.slice(at);
      const end = tail.indexOf(trailer);
      assert.ok(end >= 0, `${locale}: the wheel block is followed by the disclaimer`);
      return normalizePdfText(flat.slice(0, at) + tail.slice(end));
    };
    // The cover of the bare document really does carry the absence block, so the strip is
    // not silently comparing two identical full texts.
    assert.ok(bare.inspected.pages[0].text.includes(heading), `${locale}: the bare cover carries the absence block`);
    assert.equal(strip(wheeled.inspected), strip(bare.inspected),
      `${locale}: cover, summary, calculation tables and prose are identical with and without the wheel, in order`);

    /**
     * The calculation pages survive the wheel — compared by content, not page count.
     *
     * This is the part the old test structurally could not check: it had no calculation
     * blocks to lose.
     */
    const tables = paidCalculationBlocks(snapshot, locale).filter(block => block.kind === "aspectTable");
    assert.ok(tables.length > 0);
    for (const table of tables) {
      if (table.kind !== "aspectTable") continue;
      const title = table.title ?? "";
      assert.ok(title && wheeled.inspected.text.includes(title), `${locale}: table "${title.slice(0, 32)}" still renders`);
      // First row's first two cells: a lost or reordered table changes these.
      const [first] = table.rows;
      assert.ok(first && wheeled.inspected.text.includes(first.a) && wheeled.inspected.text.includes(first.b),
        `${locale}: first row of "${title.slice(0, 24)}" still renders`);
    }

    // Metadata is unchanged, field by field — not just the language.
    const metadata = (info: Record<string, unknown>) => JSON.stringify(
      Object.fromEntries(Object.entries(info).filter(([field]) => field !== "Custom")));
    assert.equal(metadata(wheeled.inspected.metadata), metadata(bare.inspected.metadata), `${locale}: metadata unchanged, field for field`);
  }
});

/**
 * The build script has two kinds of concurrency to survive, and the previous test only
 * exercised neither of them properly.
 *
 * It spawned six builders and then read a byte length after `Promise.all` — which cannot
 * observe a torn file, because by then every builder has finished. The review reproduced two
 * real windows that it missed: a reader starting while `package.json` is being rewritten in
 * place, and a live lock being evicted because it merely looked old.
 *
 * These four tests each pause publication at the exact point that used to be unsafe, and
 * assert from a *separate process* — the way the app and the other suites actually observe it.
 */

/** The published package is a set of complete files; a reader is anything that resolves them. */
const PUBLISHED = ["bootstrap.mjs", "worker.mjs", "worker.mjs.LEGAL.txt", "package.json"];

test("PDF worker: the shipped bundle's own license footer resolves", async () => {
  const { readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  // esbuild derives the footer from the outfile it is *given*. Building to a temporary name
  // and then renaming ships a footer naming a file that never exists — which is exactly what
  // this PR did before review caught it.
  const footer = (await readFile(resolve(".pdf/worker.mjs"), "utf8")).match(/For license information please see (\S+?) \*\//);
  assert.ok(footer, "the worker names a license file");
  assert.ok(existsSync(resolve(dirname(resolve(".pdf/worker.mjs")), footer![1])), `the linked license file exists: ${footer![1]}`);
  assert.ok(!/\.\d+\.tmp/.test(footer![1]), `the footer names a published file, not a build temporary: ${footer![1]}`);
});

test("PDF worker: a reader that starts while publication is paused still loads the package", async () => {
  const { spawn } = await import("node:child_process");
  const { rm, readFile } = await import("node:fs/promises");
  const signal = resolve(".venv/pdf-reader-pause");
  await rm(signal, { force: true });

  /**
   * The builder pauses with the assets already published and the bundle still old, which is
   * the worst moment for a reader: `package.json`, fonts and metrics are new, `worker.mjs` is
   * the previous one. Both states are individually consistent, so a reader must succeed
   * regardless of which it resolves — it must simply never see a *partial* file.
   */
  const builder = new Promise<number | null>((settle, fail) => {
    const child = spawn(process.execPath, ["scripts/build-pdf.mjs"], {
      stdio: "ignore", env: { ...process.env, PDF_BUILD_TEST_PAUSE_FILE: signal, PDF_BUILD_TEST_PAUSE_MS: "1500" },
    });
    child.once("close", settle); child.once("error", fail);
  });
  try {
    const started = Date.now();
    for (;;) {
      if (await readFile(signal, "utf8").catch(() => null)) break;
      if (Date.now() - started > 30_000) throw new Error("the builder never reached the publication pause");
      await new Promise(settle => setTimeout(settle, 20));
    }
    // A real reader: resolve the package's declared imports and load a standard font, exactly
    // as `bootstrap.mjs` does when PDFKit registers builtin metrics.
    const reader = await new Promise<{ code: number | null; out: string; err: string }>((settle, fail) => {
      const child = spawn(process.execPath, ["-e", `
        import { createRequire } from "node:module";
        const require = createRequire(${JSON.stringify(resolve(".pdf") + "/")});
        require(${JSON.stringify(resolve(".pdf/package.json"))});
        const font = require(${JSON.stringify(resolve(".pdf/standard-fonts/Helvetica.cjs"))});
        process.stdout.write("loaded " + typeof font);
      `], { stdio: ["ignore", "pipe", "pipe"] });
      let out = ""; let err = "";
      child.stdout.on("data", chunk => out += chunk);
      child.stderr.on("data", chunk => err += chunk);
      child.once("close", code => settle({ code, out, err }));
      child.once("error", fail);
    });
    assert.equal(reader.code, 0, `a reader launched mid-publication loads the package: ${reader.err.split("\n")[0]}`);
    assert.match(reader.out, /^loaded (object|function)$/);
  } finally {
    await rm(signal, { force: true });
    await builder;
  }
});

test("PDF worker: a lock whose owner is alive is not reclaimed, however old it looks", async () => {
  const { readFile, rm, utimes, writeFile } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const lock = resolve(".pdf/.build.lock");
  const previous = await readFile(lock, "utf8").catch(() => null);
  await writeFile(lock, String(process.pid));
  try {
    // A 10-minute-old mtime on a *live* holder. The previous implementation reclaimed by age,
    // and the review reproduced a second builder completing while the holder was mid-publish.
    const ancient = new Date(Date.now() - 600_000);
    await utimes(lock, ancient, ancient);
    const contender = spawn(process.execPath, ["scripts/build-pdf.mjs"], {
      stdio: "ignore", env: { ...process.env, PDF_BUILD_LOCK_WAIT_MS: "1200" },
    });
    const code = await new Promise<number | null>(settle => contender.once("close", settle));
    assert.notEqual(code, 0, "a contender times out rather than evicting a live holder");
    assert.equal((await readFile(lock, "utf8")).trim(), String(process.pid), "the live holder's lock survives");
  } finally {
    if (previous === null) await rm(lock, { force: true });
    else await writeFile(lock, previous);
  }
});

test("PDF worker: a lock whose owner is dead is reclaimed, and the build succeeds", async () => {
  const { readFile, rm, writeFile } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const lock = resolve(".pdf/.build.lock");
  const previous = await readFile(lock, "utf8").catch(() => null);
  // A pid that cannot be running: the kernel's pid ceiling is well below this.
  await writeFile(lock, "999999");
  try {
    const code = await new Promise<number | null>((settle, fail) => {
      const child = spawn(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "ignore" });
      child.once("close", settle); child.once("error", fail);
    });
    assert.equal(code, 0, "a builder reclaims a proven-dead lock and completes");
    assert.equal(await readFile(lock, "utf8").catch(() => null), null, "the lock is released afterwards");
  } finally {
    if (previous !== null) await writeFile(lock, previous).catch(() => {});
  }
});

test("PDF worker: concurrent builds serialise and publish no partial file", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const complete = (await readFile(resolve(".pdf/worker.mjs"), "utf8")).length;
  assert.ok(complete > 100_000, `the bundle is substantial (${complete} bytes)`);

  /**
   * Six builders, more than the four suites that do this in `before()`.
   *
   * Before the lock, this was not only a torn file: two builders copying `standard-fonts` into
   * the same directory raced, and one died with `ENOENT ... HelveticaBold.mjs` while another
   * published it. That surfaces as an unrelated suite failing, which is why it took three CI
   * failures to find.
   */
  const run = () => new Promise<number | null>((settle, fail) => {
    const child = spawn(process.execPath, ["scripts/build-pdf.mjs"], { stdio: "ignore" });
    child.once("close", settle); child.once("error", fail);
  });
  const codes = await Promise.all(Array.from({ length: 6 }, run));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], "every concurrent builder exits successfully");

  const entries = await readdir(resolve(".pdf"));
  assert.deepEqual(entries.filter(name => /\.tmp$/.test(name)), [], "no temporary bundle survives");
  for (const file of PUBLISHED) assert.ok(entries.includes(file), `the package contains ${file}`);
  assert.equal((await readFile(resolve(".pdf/worker.mjs"), "utf8")).length, complete, "the published bundle is complete");
});
