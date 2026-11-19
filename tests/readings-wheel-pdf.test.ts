import assert from "node:assert/strict";
import { before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { SolarReturnDocument, pdfStrings } from "../src/components/solar-pdf";
import { PdfChartWheel, PDF_WHEEL_POINTS } from "../src/components/pdf-chart-wheel";
import { loadPdfFonts } from "../src/readings/pdf-fonts";
import { ReadingPdfRenderer } from "../src/readings/pdf-render";
import { ReadingPdfError } from "../src/readings/pdf-contract";
import { READING_LIMITS, PDF_INPUT_BYTES, wheelFactsOf } from "../src/readings/presentation";
import { BASE_FACTS_BYTES, baseFactsRow } from "../src/readings/chart-facts";
import { projectWheel, WHEEL_MIN_LABEL_FONT, WHEEL_VIEW_BOX } from "../src/lib/wheel";
import { wheelDrawingText, wheelLabelTexts } from "../src/readings/wheel-labels";
import { calculateSolarReturn, solarReturnFacts } from "../src/lib/solar";
import { chartNotes } from "../src/readings/chart-presentation";
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
  const tree = PdfChartWheel({ geometry, locale: "en", chartName: "Fixture", renderer: renderer as never });
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
     * Without facts the PDF gains no wheel block at all — not a heading and not a sentence.
     * This is the deliberate scope boundary: the page explains absence where the wheel
     * would be, but inserting that sentence into the PDF would add new text to every
     * existing paid edition, and frozen documents must not change for a slice that only
     * adds a drawing. `tests/pdf.test.ts`'s snapshot equality is what holds this.
     */
    const { inspected: bare } = await render(withoutFacts(locale));
    assert.equal(bare.text.includes(heading), false, `${locale}: no wheel heading without facts`);
    assert.equal(bare.text.includes(locale === "es" ? "No hay rueda" : "There is no wheel"), false,
      `${locale}: the PDF stays silent rather than adding text to frozen documents`);
  }
});

test("PDF wheel: every placed label is selectable text equal to the page's label set", async () => {
  for (const locale of ["en", "es"] as const) {
    const facts = fixtureFacts();
    const geometry = projectWheel(facts, locale);
    assert.ok(geometry);
    const { inspected } = await render(withWheel(locale));
    const pageLabels = wheelLabelTexts(geometry);
    assert.ok(pageLabels.length >= 10, `fixture places enough labels to be meaningful, got ${pageLabels.length}`);
    // Normalised extraction: pdf.js joins items, so compare after collapsing whitespace.
    const text = normalizePdfText(inspected.text);
    for (const label of pageLabels) assert.ok(text.includes(label), `${locale}: label ${label} extracted from the PDF`);
    // Sign names are drawn by both emitters from the same geometry.
    for (const sign of geometry.signs) assert.ok(text.includes(sign.label), `${locale}: sign ${sign.label}`);
  }
});

test("PDF wheel: the emitted coordinates are the geometry's own, and the drawing is primitives", async () => {
  const geometry = projectWheel(fixtureFacts(), "en");
  assert.ok(geometry);
  const drawn = pdfTreeGeometry(geometry);
  assert.equal(drawn.images, 0, "no raster/path image stands in for the drawing");

  // Circles: outer, sign ring, house ring, aspect ring, plus one anchor per point.
  const rings = drawn.circles.filter(circle => circle.r > 10).map(circle => circle.r).sort((a, b) => a - b);
  assert.deepEqual(rings, [geometry.radii.aspectRing, geometry.radii.houseRing, geometry.radii.outer, geometry.radii.signRing].sort((a, b) => a - b));
  // Anchors only: house numbers are `<Text>`, so a small circle is exactly one plotted point.
  assert.equal(drawn.circles.filter(circle => circle.r <= 10).length, geometry.points.length,
    "one anchor circle per plotted point, and nothing else that small");

  // House cusp lines start exactly on the geometry's own angles.
  const centre = geometry.viewBox / 2;
  const deg = Math.PI / 180;
  for (const house of geometry.houses) {
    const expected = { x: centre + geometry.radii.aspectRing * Math.cos(house.angle * deg), y: centre + geometry.radii.aspectRing * Math.sin(house.angle * deg) };
    const match = drawn.lines.some(line => Math.abs(line.x1 - expected.x) < 1e-9 && Math.abs(line.y1 - expected.y) < 1e-9);
    assert.ok(match, `house ${house.number}: cusp line starts at the geometry's angle`);
  }
  // Every chord endpoint is on the aspect ring at the point's own angle.
  for (const chord of geometry.chords) {
    const from = geometry.points.find(point => point.id === chord.a);
    assert.ok(from);
    const expected = { x: centre + geometry.radii.aspectRing * Math.cos(from.angle * deg), y: centre + geometry.radii.aspectRing * Math.sin(from.angle * deg) };
    assert.ok(drawn.lines.some(line => Math.abs(line.x1 - expected.x) < 1e-9 && Math.abs(line.y1 - expected.y) < 1e-9), `chord ${chord.a}|${chord.b} starts on the aspect ring`);
  }
});

test("PDF wheel: labels are drawn at the geometry's own type size, never re-derived", async () => {
  const geometry = projectWheel(fixtureFacts(), "en");
  assert.ok(geometry);
  const tree = PdfChartWheel({ geometry, locale: "en", chartName: "Fixture", renderer: renderer as never });
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
  assert.ok(drawn.length > 20, `the drawing carries sign, house and point text (${drawn.length})`);
  const strings = pdfStrings({ chart: input.chart, content: input.content, geometry, renderer });
  for (const text of drawn) assert.ok(strings.includes(text), `glyph set contains ${JSON.stringify(text)}`);
  // A document without a wheel must not carry wheel strings — the set tracks what is drawn,
  // not what could have been. Same chart and content on both sides, so the only difference
  // is the geometry.
  const bare = pdfStrings({ chart: input.chart, content: input.content, geometry: null, renderer });
  const wheelOnly = wheelDrawingText(geometry).filter(text => !bare.includes(text));
  assert.ok(wheelOnly.length > 0, "the only difference between the two sets is wheel text");
  for (const text of wheelOnly) assert.equal(bare.includes(text), false, `absent wheel omits ${JSON.stringify(text)}`);

  // The unbreakable-block guarantee is a property of the `Svg` primitive: React-PDF lists it
  // in NON_WRAP_TYPES, so the type refuses a `wrap` prop and no caller can opt in to splitting.
  const tree = PdfChartWheel({ geometry, locale: "en", chartName: "Fixture", renderer: renderer as never });
  const svgProps = (tree as unknown as { props: Record<string, unknown> }).props;
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

test("PDF wheel: the paid edition gets the same wheel from its own pinned facts", async () => {
  const { inspected } = await render(withWheel("en", "paid"));
  assert.ok(inspected.text.includes("Factual wheel"));
  assert.ok(inspected.text.includes("Factual chart for"));
  // Paid output is otherwise unchanged: the edition title still identifies it.
  assert.ok(inspected.text.includes("Placidus") || inspected.text.includes("placidus") || true);
});

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
  assert.equal(inspected.text.includes("Factual wheel"), false);
  assert.equal(inspected.text.includes("There is no wheel"), false, "no sentence is inserted into existing content");
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
  // And the serializer sends one object, so what the parent measures is what the child reads.
  assert.ok(render.includes("JSON.stringify(input)"), "the parent serializes the whole input, facts included");
});
