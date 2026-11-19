import assert from "node:assert/strict";
import { before, test } from "node:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { SolarReturnDocument, pdfStrings, wheelCopy } from "../src/components/solar-pdf";
import { PdfChartWheel, PDF_WHEEL_POINTS } from "../src/components/pdf-chart-wheel";
import { loadPdfFonts } from "../src/readings/pdf-fonts";
import { ReadingPdfRenderer, pdfIpcPayload } from "../src/readings/pdf-render";
import { ReadingPdfError } from "../src/readings/pdf-contract";
import { READING_LIMITS, PDF_INPUT_BYTES, wheelFactsOf } from "../src/readings/presentation";
import { BASE_FACTS_BYTES, baseFactsRow } from "../src/readings/chart-facts";
import { projectWheel, WHEEL_MIN_LABEL_FONT, WHEEL_VIEW_BOX } from "../src/lib/wheel";
import { wheelDrawingText, wheelLabelText, wheelLabelTexts } from "../src/readings/wheel-labels";
import { calculateSolarReturn, solarReturnFacts } from "../src/lib/solar";
import { editionTitle } from "../src/readings/presentation-copy";
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
  const wheel = wheelCopy({ chart: input.chart, content: input.content, geometry });
  assert.ok(drawn.length > 20, `the drawing carries sign, house and point text (${drawn.length})`);
  const strings = pdfStrings({ chart: input.chart, content: input.content, geometry, renderer });
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
  const bare = pdfStrings({ chart: input.chart, content: input.content, geometry: null, renderer });
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
  const bareCopy = wheelCopy({ chart: input.chart, content: input.content, geometry: null });
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
test("PDF wheel: a paid edition draws its own pinned Placidus facts", async () => {
  const result = calculateSolarReturn(readingChartInput);
  const facts = solarReturnFacts(readingChartInput, result, "placidus");
  const geometry = projectWheel(facts, "en")!;
  assert.equal(geometry.houseSystem, "placidus", "the fixture really is Placidus");
  assert.equal(geometry.houses.length, 12, "a Placidus wheel has twelve cusps");

  const input = pdfFixture("en", "paid");
  const { inspected } = await render({ ...input, wheelFacts: facts });
  assert.ok(inspected.text.includes("Factual wheel"), "the paid edition gains the wheel");
  // The caption names the system the facts carry, not a default.
  assert.ok(inspected.text.includes("placidus") || inspected.text.includes("Placidus"),
    "the drawing identifies its own house system");
  // And the document still identifies itself as the paid edition.
  assert.ok(inspected.text.includes(editionTitle(input.content)), "paid edition identity is unchanged");
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
 * Adding the wheel changes the wheel block and nothing else.
 *
 * The reviewer's point was that frozen snapshots prove no-wheel *compatibility*, not that a
 * real paid edition kept its prose, order and metadata when a wheel was added. A with/without
 * comparison over the same document answers that directly: remove the pages the wheel occupies
 * and the remaining text must be identical, in the same order.
 *
 * The wheel adds exactly one page in this fixture (asserted in test 6), so the comparison is
 * page-aligned rather than a substring diff.
 */
test("PDF wheel: adding the wheel leaves the rest of a paid edition untouched", async () => {
  for (const locale of ["en", "es"] as const) {
    const result = calculateSolarReturn(readingChartInput);
    const facts = solarReturnFacts(readingChartInput, result, "placidus");
    const input = pdfFixture(locale, "paid");
    // One render at a time: the renderer admits a single slot by design, and `pdf_capacity`
    // here would be the guard working, not a test failure.
    const bare = await render(input);
    const wheeled = await render({ ...input, wheelFacts: facts });

    assert.equal(wheeled.inspected.metadata.Language, bare.inspected.metadata.Language, `${locale}: metadata unchanged`);

    // Drop the page that carries the *drawing*. Both documents have a wheel block — the bare
    // one carries the absent-wheel explanation instead — so the heading cannot identify it.
    // The drawing's own labels are the signal: "Aries" is drawn only by the wheel emitter.
    const isWheelPage = (page: { items: { text: string }[] }) => page.items.some(item => item.text === "Aries");
    const barePages = bare.inspected.pages.map(page => page.text);
    const wheeledPages = wheeled.inspected.pages.map(page => page.text).filter((_, index) => !isWheelPage(wheeled.inspected.pages[index]));
    assert.equal(wheeledPages.length, barePages.length, `${locale}: the drawing replaced a no-op block, adding no page of its own`);

    /**
     * Compare pages that cannot contain wheel copy, rather than trying to align whole pages.
     *
     * The cover holds the wheel block, so it necessarily differs: the bare document explains
     * the absence there and the wheeled one draws there. Everything after it is document
     * prose — sections, notices, previews — and must be identical, in the same order.
     */
    const cover = 1;
    assert.deepEqual(wheeledPages.slice(cover), barePages.slice(cover),
      `${locale}: every page after the cover is unchanged, in order`);
    const prose = (input: { content: { sections: { title: string }[] } }) => input.content.sections.map(section => section.title);
    for (const title of prose(input)) {
      assert.ok(wheeled.inspected.text.includes(title), `${locale}: section "${title.slice(0, 24)}" still renders`);
    }
  }
});
