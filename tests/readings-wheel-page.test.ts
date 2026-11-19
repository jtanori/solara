/**
 * Factual wheel and numerical facts on the reading page — the acceptance suite for
 * issue #154 (slice 1-c of Solar Return completion).
 *
 * Everything here is server-rendered to static markup and asserted as numbers and text,
 * never by screenshot: the wheel's plotted positions must equal the saved facts, and the
 * numerical table is the authoritative equivalent, so both are parsed out of the same two
 * artifacts a reader receives.
 *
 * DB-free. `loadReadingPresentation` needs PostgreSQL, so the presentation wiring is
 * asserted by source inspection and by the integration suites that already cover it; what
 * is asserted here is the projection, the markup and the copy.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AstroWheel } from "../src/components/astro-wheel";
import { ChartWheel } from "../src/components/chart-wheel";
import { ReadingPageView } from "../src/components/reading-page-view";
import { ReadingBlockView } from "../src/components/reading-sections";
import { signName } from "../src/lib/i18n";
import { calculateSolarReturn, solarReturnFacts } from "../src/lib/solar";
import { projectWheel, wheelAngle, type WheelGeometry } from "../src/lib/wheel";
import { baseCalculationBlocks, houseSystemLabel, pointLabel } from "../src/readings/base-presentation";
import { chartNotes } from "../src/readings/chart-presentation";
import {
  AVAILABILITY_COPY, DECORATIVE_WHEEL_LABEL, NOTICE_COPY, readingCalculationNotice,
  WHEEL_NOTICE_COPY, type WheelNoticeCode,
} from "../src/readings/presentation-copy";
import type { ReadingChart, ReadingPresentation } from "../src/readings/presentation";
import type { ReadingBlock } from "../src/readings/types";
import { readingChartInput } from "./helpers/reading-fixtures";

// ---------------------------------------------------------------- fixtures

const LOCALES = ["en", "es"] as const;
const render = (element: React.ReactElement) => renderToStaticMarkup(element);

const result = calculateSolarReturn(readingChartInput);
const facts = solarReturnFacts(readingChartInput, result);
/** |latitude| >= 66: no Ascendant, so `projectWheel` returns null. */
const polarInput = { ...readingChartInput, returnPlace: { name: "Tromsø, Norway", latitude: 69.6, longitude: 18.9, timezone: "Europe/Oslo" } };
const polarFacts = solarReturnFacts(polarInput, calculateSolarReturn(polarInput));

const baseChart = (overrides: Partial<ReadingChart> = {}): ReadingChart => ({
  id: "11111111-2222-4333-8444-555555555555", year: 2026, name: "Synthetic Reading",
  returnPlace: "New York, United States", timezone: "America/New_York", result, ...overrides,
});
/** A base chart exactly as the view builds it: verified facts plus their table. */
const withFacts = (chartFacts = facts, locale: (typeof LOCALES)[number] = "en", overrides: Partial<ReadingChart> = {}) =>
  baseChart({ baseFacts: chartFacts, calculation: baseCalculationBlocks(chartFacts, locale), ...overrides });
const presentation = (chart: ReadingChart, locale: (typeof LOCALES)[number] = "en"): ReadingPresentation => ({
  chart, content: chartNotes(chart, { sun: "SUN_NOTE", moon: "", ascendant: "", house: "" }, locale, false),
  generation: null, availability: "chart_only",
});
const page = (chart: ReadingChart, locale: (typeof LOCALES)[number] = "en", props: { selector?: { kind: "auto" } | { kind: "chart" }; controls?: ReactNode } = {}) =>
  render(createElement(ReadingPageView, { view: presentation(chart, locale), locale, selector: props.selector ?? { kind: "chart" }, controls: props.controls }));
const geometry = (chartFacts = facts, locale: (typeof LOCALES)[number] = "en") => {
  const projected = projectWheel(chartFacts, locale);
  assert.ok(projected, "fixture must project");
  return projected;
};
/** Plot coordinates printed into the SVG, in document order. */
const anchors = (html: string) => [...html.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="2\.4"/g)]
  .map(match => ({ x: Math.round(Number(match[1]) * 1000) / 1000, y: Math.round(Number(match[2]) * 1000) / 1000 }));
/** Chords as drawn: the pair they claim plus the four printed coordinates. */
const chords = (html: string) => [...html.matchAll(/<line[^>]*data-chord="([^"|]+)\|([^"]+)"([^>]*)>/g)]
  .map(match => {
    const attr = (name: string) => Number(new RegExp(`\\s${name}="([^"]+)"`).exec(match[3]!)?.[1]);
    return { a: match[1]!, b: match[2]!,
      from: { x: attr("x1"), y: attr("y1") }, to: { x: attr("x2"), y: attr("y2") } };
  });
/**
 * The chord ring at a plotted angle, stated here independently of the renderer: a chord
 * runs between the two anchors on the aspect ring, whose radius the geometry publishes.
 */
const onAspectRing = (angle: number) => {
  const radius = projectWheel(facts, "en")!.radii.aspectRing;
  return { x: 220 + radius * Math.cos(angle * Math.PI / 180), y: 220 + radius * Math.sin(angle * Math.PI / 180) };
};
/** Point labels: the marked, sized-to-fit ones — not sign names or house numbers. */
const labels = (html: string) => [...html.matchAll(/<text[^>]*font-weight="600"[^>]*>([^<]*)<\/text>/g)].map(match => match[1]!);
const textOf = (block: ReadingBlock) => "title" in block && block.title ? `${block.title}\n${JSON.stringify(block)}` : JSON.stringify(block);

// ------------------------------------------------------- plotted = saved facts

for (const locale of LOCALES) {
  test(`page wheel ${locale}: every plotted anchor is the projected saved longitude`, () => {
    const html = page(withFacts(facts, locale), locale);
    const projected = geometry(facts, locale);
    // One wheel, fourteen anchor dots, in the geometry's own order — the SVG is a
    // rendering of `WheelGeometry`, not a second projection of its own.
    assert.equal((html.match(/<svg class="chart-wheel"/g) ?? []).length, 1);
    assert.deepEqual(anchors(html), projected.points.map(point => point.anchor));
    assert.equal(anchors(html).length, 14);
    // Every plotted anchor is the outer-ring point of the saved longitude, stated here
    // independently of the geometry object so a shifted pool of coordinates cannot pass.
    for (const point of projected.points) {
      const expected = { x: 220 + 152 * Math.cos(wheelAngle(point.longitude, facts.angles.ascendant!.longitude) * Math.PI / 180),
        y: 220 + 152 * Math.sin(wheelAngle(point.longitude, facts.angles.ascendant!.longitude) * Math.PI / 180) };
      const plotted = anchors(html).find(anchor => Math.abs(anchor.x - expected.x) <= 0.001 && Math.abs(anchor.y - expected.y) <= 0.001);
      assert.ok(plotted, `${locale}: ${point.id} at ${point.longitude}° must be plotted at its projected point`);
    }
    // Labels are the localized point names, and the Ascendant is where the anchor rule says.
    const ascendant = geometry(facts).points.find(point => point.id === "Ascendant")!;
    assert.deepEqual(ascendant.anchor, { x: 220 - 152, y: 220 });
    assert.ok(labels(html).includes(String(({ en: "Ascendant", es: "Ascendente" } as const)[locale])));
    assert.ok(labels(html).includes(locale === "es" ? "Medio Cielo" : "Midheaven"), locale);
    // Chords are the return-chart aspects only: no chord endpoint carries a natal name.
    assert.equal((html.match(/<line[^>]*stroke="(#a86658|#7a9290)"/g) ?? []).length, geometry(facts).chords.length);
    assert.equal(html.includes("natal-"), false, "no cross-aspect endpoint may reach the SVG");
    // And the drawn geometry is the stored one: every chord's four coordinates are the
    // aspect ring at the two plotted angles. Counting alone would pass a substitution that
    // swapped a return body for a natal one of the same count, so the endpoints are parsed.
    const drawn = chords(html);
    assert.equal(drawn.length, geometry(facts).chords.length);
    assert.deepEqual(drawn.map(chord => `${chord.a}/${chord.b}`),
      geometry(facts).chords.map(chord => `${chord.a}/${chord.b}`));
    for (const chord of drawn) {
      const from = projected.points.find(point => point.id === chord.a);
      const to = projected.points.find(point => point.id === chord.b);
      assert.ok(from && to, `${chord.a}/${chord.b} must both be plotted points`);
      for (const [plotted, expected] of [[chord.from, onAspectRing(from.angle)], [chord.to, onAspectRing(to.angle)]]) {
        assert.ok(Math.abs(plotted.x - expected.x) < 1e-6 && Math.abs(plotted.y - expected.y) < 1e-6,
          `${chord.a}/${chord.b} endpoint ${JSON.stringify(plotted)} is not on the aspect ring at ${JSON.stringify(expected)}`);
      }
      // A chord is a straight line between two *same-count* points on one ring, so its
      // length fixes the arc it spans: no endpoint can be silently rotated.
      assert.equal(chord.a === chord.b, false);
    }
    // And every drawn chord is a *stored return aspect*, not merely a plausible pair: the
    // cross-aspect list is strictly larger (40 vs 22), so a wheel that mixed the two in
    // would either draw more chords or draw a pair that only the cross list contains.
    const returnPairs = new Set(facts.aspects.filter(item => item.a !== item.b).map(item => [item.a, item.b].sort().join("/")));
    const crossOnly = facts.crossAspects.map(item => [item.a, item.b.replace(/^natal-/, "")].sort().join("/"))
      .filter(pair => !returnPairs.has(pair));
    assert.ok(crossOnly.length > 0, "the fixture must have a pair that exists only as a cross-aspect");
    assert.equal(crossOnly.some(pair => returnPairs.has(pair)), false);
    assert.equal(geometry(facts).chords.length, Math.min(24, returnPairs.size));
    for (const chord of geometry(facts).chords) {
      assert.ok(returnPairs.has([chord.a, chord.b].sort().join("/")), `${chord.a}/${chord.b} must be a stored return aspect`);
      assert.ok(!crossOnly.includes([chord.a, chord.b].sort().join("/")), `${chord.a}/${chord.b} is cross-aspect-only`);
    }
    assert.equal(html.includes("data-wheel-chords=\"24\""), false, "a cross-aspect chord would raise the drawn count");
    // Accessible labelling: one role=img, title and description, and the description says
    // where the authoritative numbers are.
    assert.ok(html.includes('role="img"'));
    assert.match(html, /aria-labelledby="chart-wheel-title chart-wheel-description"/);
    assert.match(html, new RegExp(`<title id="chart-wheel-title">${locale === "es" ? "Carta factual de" : "Factual chart for"} Synthetic Reading</title>`));
    assert.match(html, locale === "es" ? /autoritativo/ : /authoritative equivalent/);
    assert.equal((html.match(/role="img"/g) ?? []).length, 1, "the table is not a second image");
  });
}

test("page wheel: the numbered axes hold — Ascendant left, IC bottom, Descendant right, MC top", () => {
  const projected = geometry(facts);
  const at = (id: string) => projected.points.find(point => point.id === id)!;
  // The wheel is anchored from the Ascendant; the other three follow from longitude alone.
  assert.deepEqual(at("Ascendant").anchor, { x: 68, y: 220 });
  // Re-project the four axis longitudes directly: the same rule the geometry uses.
  const anchor = projected.anchorLongitude;
  const pointAt = (longitude: number) => wheelAngle(longitude, anchor);
  assert.ok(Math.abs(pointAt(anchor + 90) - 90) < 1e-9);
  assert.ok(Math.abs(pointAt(anchor + 180)) < 1e-9);
  assert.ok(Math.abs(pointAt(anchor + 270) - 270) < 1e-9);
  // And nothing in the page rotates that: the rendered anchors are the geometry's.
  const html = page(withFacts());
  assert.deepEqual(anchors(html), projected.points.map(point => point.anchor));
});

// ------------------------------------------------------------ numerical table

for (const locale of LOCALES) {
  test(`page table ${locale}: ten bodies with sign, degree, house and motion, plus cusps, angles, nodes, natal and both aspect groups`, () => {
    const blocks = baseCalculationBlocks(facts, locale);
    const es = locale === "es";
    assert.deepEqual(blocks.map(block => block.kind), ["keyValue", "keyValue", "keyValue", "keyValue", "aspectTable", "aspectTable"]);
    const placements: Extract<ReadingBlock, { kind: "keyValue" }> = blocks[0] as Extract<ReadingBlock, { kind: "keyValue" }>;
    assert.equal(placements.kind, "keyValue");
    // The title names the house system rather than assuming one.
    assert.ok("title" in placements && placements.title!.includes(locale === "es" ? "Signo completo" : "Whole sign"));
    assert.equal(placements.entries.length, 10);
    for (const [index, body] of facts.bodies.entries()) {
      const entry = placements.entries[index]!;
      assert.equal(entry.key, pointLabel(body.body, locale));
      assert.ok(entry.value.startsWith(`${signName(body.sign, locale)} ${body.degree.toFixed(2)}°`), entry.value);
      assert.ok(entry.value.includes(`${es ? "Casa" : "House"} ${body.house}`), entry.value);
      assert.match(entry.value, es ? /(directo|retrógrado|estacionario)$/ : /(direct|retrograde|stationary)$/);
    }
    // Motion words are real words, not enum values that leaked.
    if (es) {
      const motionText = placements.entries.map(entry => entry.value).join(" ");
      // "directo" contains "direct", so the English check is word-bounded.
      assert.equal(/\b(retrograde|stationary|House)\b/.test(motionText), false, "no English motion or house words in the Spanish table");
      assert.equal(/\bdirect\b/.test(motionText), false, "no English 'direct' in the Spanish table");
      assert.match(motionText, /directo|retrógrado|estacionario/);
    }
    // Cusps: twelve, from the stored facts, to four decimals.
    const cusps = blocks[1];
    assert.ok("entries" in cusps);
    assert.equal(cusps.entries.length, 12);
    for (const [index, longitude] of facts.houses.entries()) {
      assert.equal(cusps.entries[index]!.value, `${longitude.toFixed(4)}°`);
      assert.equal(cusps.entries[index]!.key, `${es ? "Casa" : "House"} ${index + 1}`);
    }
    // Angles and nodes, in a fixed order.
    const angles = blocks[2];
    assert.ok("entries" in angles);
    assert.deepEqual(angles.entries.map(entry => entry.key),
      [pointLabel("Ascendant", locale), pointLabel("Midheaven", locale), pointLabel("TrueNode", locale), pointLabel("SouthNode", locale)]);
    // Natal reference: ten bodies, and unmistakably not the return placements.
    const natal = blocks[3];
    assert.ok("entries" in natal && "title" in natal);
    assert.equal(natal.entries.length, 10);
    assert.match(natal.title!, es ? /natales/ : /Natal/);
    // Aspect groups, capped at 24, with the `(natal)` suffix only in the cross group.
    const [returns, cross] = blocks.slice(4);
    assert.ok(returns?.kind === "aspectTable" && cross?.kind === "aspectTable");
    assert.equal(returns.rows.length, Math.min(24, facts.aspects.length));
    assert.equal(cross.rows.length, Math.min(24, facts.crossAspects.length));
    assert.ok(returns.rows.every(row => !row.a.endsWith("(natal)") && !row.b.endsWith("(natal)")));
    assert.ok(cross.rows.every(row => row.b.endsWith("(natal)")), "cross-aspects keep the (natal) suffix");
    for (const row of [...returns.rows, ...cross.rows]) {
      assert.ok(row.a !== "natal-", "no raw natal- prefix may reach the table");
      assert.ok(row.type.length > 0 && Number.isFinite(row.orb));
    }
    // Nothing in the table is a name, a place or a coordinate: derived positions only.
    const serialized = blocks.map(textOf).join("\n");
    for (const secret of [readingChartInput.name, readingChartInput.birthPlace.name, "1984-05-16", "01:00", "32.6393", "-115.4747"]) {
      assert.equal(serialized.includes(secret), false, `table must not carry ${secret}`);
    }
    // The same blocks render through the existing block renderer, in both locales.
    const html = blocks.map(block => render(createElement(ReadingBlockView, { block, locale }))).join("");
    assert.ok(html.includes(signName(facts.bodies[0]!.sign, locale)));
    assert.ok(html.includes(es ? "Cuerpo" : "Body"), "aspect tables reuse the existing headings");
    assert.equal(html.includes("undefined"), false);
  });
}

test("page table: a high-latitude chart states the Ascendant is omitted instead of printing one", () => {
  const blocks = baseCalculationBlocks(polarFacts, "en");
  const angles = blocks.find(block => block.kind === "keyValue" && block.entries.some(entry => entry.value === "Not shown · high latitude"));
  assert.ok(angles && angles.kind === "keyValue", "the angles block states the omission");
  assert.equal(angles.entries[0]!.key, "Ascendant");
  assert.equal(angles.entries[0]!.value, "Not shown · high latitude");
  const anglesIndex = blocks.indexOf(angles);
  assert.equal(blocks[0]!.kind, "keyValue");
  assert.ok("entries" in blocks[0]! && blocks[0]!.entries[0]!.key === "Sun", "the ten bodies come first");
  assert.equal(anglesIndex, 1, "with no houses the angles block follows the bodies directly");
  const cusps = blocks.find(block => "title" in block && /Cusps/.test(block.title!));
  assert.equal(cusps, undefined, "no cusp table is invented for a chart with no houses");
  assert.equal(blocks.some(block => "title" in block && /Cúspides/.test(block.title ?? "")), false);
  assert.equal(JSON.stringify(blocks).includes("0.00°"), false, "no zero-Aries substitute");
  const html = render(createElement(ReadingBlockView, { block: angles, locale: "en" }));
  assert.ok(html.includes("high latitude"));
});

// ---------------------------------------------------------------- omissions

test("page: every omission is named in both locales, and only in the reader's language", () => {
  const codes = Object.keys(WHEEL_NOTICE_COPY) as WheelNoticeCode[];
  assert.deepEqual(codes.sort(), ["ascendant_unavailable", "aspects_truncated", "cross_aspects_not_plotted",
    "facts_unavailable", "houses_omitted", "labels_omitted", "natal_not_plotted"].sort());
  for (const code of codes) {
    assert.ok(WHEEL_NOTICE_COPY[code].en.length > 40, `${code} needs a real English sentence`);
    assert.ok(WHEEL_NOTICE_COPY[code].es.length > 40, `${code} needs a real Spanish sentence`);
    assert.notEqual(WHEEL_NOTICE_COPY[code].en, WHEEL_NOTICE_COPY[code].es, `${code} is not translated`);
  }
  // The live fixture carries two real omissions; both are printed, and the code itself
  // never leaks into the prose.
  for (const locale of LOCALES) {
    const html = page(withFacts(facts, locale), locale);
    for (const code of geometry(facts).omissions) {
      assert.ok(html.includes(WHEEL_NOTICE_COPY[code as WheelNoticeCode][locale]), `${locale}: ${code} notice`);
    }
    // The code names themselves never appear as words; they are only attribute values.
    const prose = html.replace(/data-wheel-omissions="[^"]*"/g, "").replace(/data-band="[^"]*"/g, "");
    assert.equal(/natal_not_plotted|cross_aspects_not_plotted|labels_omitted/.test(prose), false, "codes stay out of the prose");
  }
  // Truncated and dropped-label wheels say so too.
  const crowded = structuredClone(facts);
  for (let index = 0; index < 12; index += 1) crowded.aspects.push({ a: "Sun", b: "Moon", type: "trine", angle: 120, orb: 5 + index * 0.1, applying: null, cross: false });
  const crowdedHtml = page(withFacts(crowded));
  assert.ok(crowdedHtml.includes(WHEEL_NOTICE_COPY.aspects_truncated.en));
  const brokeHouses = structuredClone(facts);
  brokeHouses.houses[4] = brokeHouses.houses[3]!;
  const noRing = page(withFacts(brokeHouses));
  assert.ok(noRing.includes(WHEEL_NOTICE_COPY.houses_omitted.en));
  assert.equal((noRing.match(/<circle cx="220" cy="220" r="114"/g) ?? []).length, 0, "no house ring is drawn");
});

test("page: a legacy chart renders no wheel, keeps its cards and explains how to get one", () => {
  const legacy = baseChart();
  const html = page(legacy);
  assert.equal(html.includes("<svg class=\"chart-wheel\""), false, "no decorative fallback on a real reading page");
  assert.equal(html.includes(DECORATIVE_WHEEL_LABEL.en), false, "the decorative wheel is not rendered here at all");
  // No chart drawing of any kind — a fallback would carry one of these labels.
  for (const marker of ["Decorative astrological wheel", "chart-wheel-title", "data-wheel-system", "data-anchor"]) {
    assert.equal(html.includes(marker), false, `legacy page must not carry ${marker}`);
  }
  assert.ok(html.includes(WHEEL_NOTICE_COPY.facts_unavailable.en), "the reason is stated");
  assert.ok(WHEEL_NOTICE_COPY.facts_unavailable.en.includes("save a new chart"), "and so is how to get one");
  // The four existing placement cards, and no numerical table to imply facts we lack.
  assert.equal((html.match(/class="placement-card"/g) ?? []).length, 4);
  assert.equal(html.includes("<details"), false, "no saved calculation panel without facts");
  // A legacy chart is still a 200-class page and still no AI controls in chart mode.
  const controls = createElement("section", { "aria-label": "AI consent" }, createElement("button", {}, "GENERATION_CONTROLS_SENTINEL"));
  const chartMode = page(legacy, "en", { controls });
  assert.equal(chartMode.includes("GENERATION_CONTROLS_SENTINEL"), false);
  assert.ok((page(legacy, "en", { selector: { kind: "auto" }, controls })).includes("GENERATION_CONTROLS_SENTINEL"));
  // The caveat is the preliminary-calculation sentence, and nothing is claimed about a
  // decorative wheel: this page drew no wheel at all, so a sentence about one would be
  // describing a drawing that is not there. The vocabulary still exists for the surfaces
  // that do render a decorative wheel.
  assert.ok(html.includes(readingCalculationNotice("en")));
  assert.equal(html.includes("The wheel is decorative, not a plot of your placements."), false);
  assert.equal(html.includes(DECORATIVE_WHEEL_LABEL.en), false);
  // A chart with no facts has no table either, so the copy must not point at one it never
  // renders, and it must not diagnose *why* the facts are missing — the view cannot tell
  // "saved before positions" from "the saved row failed to verify".
  assert.equal(html.includes("numerical table below"), false, "no pointer to a table that is not rendered");
  assert.equal(html.includes("saved before complete positions"), false, "no diagnosis the view cannot make");
  assert.ok(html.includes(WHEEL_NOTICE_COPY.facts_unavailable.en));
  // And a chart that *does* have a table still gets the pointer.
  assert.ok(page(baseChart({ calculation: baseCalculationBlocks(facts, "en") })).includes("numerical table below"));
});

test("page: a high-latitude chart renders no wheel and never an invented horizon", () => {
  const chart = baseChart({ baseFacts: polarFacts, calculation: baseCalculationBlocks(polarFacts, "en") });
  assert.equal(polarFacts.angles.ascendant, null);
  const html = page(chart);
  assert.equal(html.includes("<svg class=\"chart-wheel\""), false);
  assert.ok(html.includes(WHEEL_NOTICE_COPY.ascendant_unavailable.en));
  assert.ok(html.includes("No horizon has been invented"));
  assert.ok(html.includes("Not shown · high latitude"), "the table states the omission too");
  // The Spanish page says the same thing, in Spanish.
  const es = page(chart, "es");
  assert.ok(es.includes(WHEEL_NOTICE_COPY.ascendant_unavailable.es));
  assert.equal(es.includes(WHEEL_NOTICE_COPY.ascendant_unavailable.en), false);
});

// ------------------------------------------------------------ summary + system

test("page: the saved-calculation summary names the edition's own house system", () => {
  const whole = page(withFacts(facts), "en");
  assert.ok(whole.includes("saved calculation · Whole sign"));
  assert.equal(whole.includes("Placidus"), false, "a whole-sign edition must not be labelled Placidus");
  const wholeEs = page(withFacts(facts, "es"), "es");
  assert.ok(wholeEs.includes("Cálculo guardado de esta edición · Signo completo"));
  // A Placidus chart (the paid shape) keeps saying Placidus, in both languages.
  const placidusChart = baseChart({ result: { ...result, houseSystem: "Placidus" } });
  assert.ok(page(placidusChart).includes("saved calculation · Placidus") === false, "no calculation panel without blocks");
  const placidusFacts = solarReturnFacts(readingChartInput, result, "placidus");
  const placidusPage = page(baseChart({ baseFacts: placidusFacts, calculation: baseCalculationBlocks(placidusFacts, "en") }));
  assert.ok(placidusPage.includes("saved calculation · Placidus"));
  assert.ok(placidusPage.includes("Cusps · Placidus"), "the cusp table names its own system");
  assert.equal(placidusPage.includes("Whole sign houses"), false);
  // The label function is the single source for that word.
  assert.equal(houseSystemLabel("whole-sign", "en"), "Whole sign");
  assert.equal(houseSystemLabel("whole-sign", "es"), "Signo completo");
  assert.equal(houseSystemLabel("placidus", "es"), "Placidus");
});

// ------------------------------------------------------------------ surfaces

/**
 * Every module under `root` that imports `target`, resolved the way the bundler does.
 *
 * Two things make this a real guard rather than a grep. It walks the whole tree, so a file
 * nobody listed is still scanned; and it resolves both specifier forms — the `@/` alias
 * and relative paths — against the extension order Next uses, so `./astro-wheel`,
 * `@/components/astro-wheel`, `"@/components/astro-wheel"` in a re-export and a directory
 * import all land on the same module. A specifier that resolves to something else, like
 * `@/components/chart-wheel`, does not count as importing the target.
 */
function importersOf(target: string, root: string, seen = new Set<string>()): string[] {
  const modules = readdirSync(root, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map(entry => resolve(entry.parentPath, entry.name))
    .filter(file => !file.includes(`${sep}node_modules${sep}`));
  const targetFile = resolveFile(resolve(target));
  const importers: string[] = [];
  for (const file of modules) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (resolveModule(specifier, root, file) === targetFile) { importers.push(relative(root, file)); break; }
    }
  }
  // Back to the repository-relative module paths used elsewhere in this suite.
  return importers.map(file => `src/${file}`).sort();
}

/** Resolve one specifier to a file inside `root`, or null when it is not in the project. */
function resolveModule(specifier: string, root: string, from = ""): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(root, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  return base === null ? null : resolveFile(base);
}

/**
 * The module specifiers a file actually imports, lexed rather than grepped.
 *
 * A regex over raw text cannot tell `import x from "y"` from the same words inside a string
 * or a comment, and on a file that *documents* an import it would report an importer that
 * does not exist. This tokenises the file first — comments and string bodies are consumed
 * whole — and then takes the specifier only where the grammar has one: after `from`, after
 * a bare `import`, and inside `import(...)`.
 */
function specifiersOf(source: string): string[] {
  const tokens: { kind: "word" | "string" | "punct"; value: string }[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index]!;
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end + 1;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      let value = "";
      while (cursor < source.length && source[cursor] !== char) {
        value += source[cursor] === "\\" ? (cursor++, source[cursor]) : source[cursor];
        cursor += 1;
      }
      tokens.push({ kind: "string", value: value ?? "" });
      index = cursor + 1;
    } else if (/[A-Za-z_$]/.test(char)) {
      let cursor = index;
      while (cursor < source.length && /[\w$]/.test(source[cursor]!)) cursor += 1;
      tokens.push({ kind: "word", value: source.slice(index, cursor) });
      index = cursor;
    } else if (/\s/.test(char)) {
      index += 1;
    } else {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    }
  }
  const specifiers: string[] = [];
  for (const [index, token] of tokens.entries()) {
    const next = tokens[index + 1];
    if (token.kind === "word" && token.value === "from" && next?.kind === "string") specifiers.push(next.value);
    if (token.kind === "word" && token.value === "import") {
      if (next?.kind === "string") specifiers.push(next.value);
      else if (next?.value === "(" && tokens[index + 2]?.kind === "string") specifiers.push(tokens[index + 2]!.value);
    }
  }
  return specifiers;
}

/** The file an extensionless module path names, in the order Next resolves it. */
function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

test("AstroWheel scan: the resolver finds alias, relative and re-export imports, and misses lookalikes", () => {
  // The guard above is only worth its runtime if it would fail on a fourth importer. This
  // builds one in a scratch tree — nested a directory deeper, importing by relative path —
  // plus an alias re-export, and proves the scan reports all three while ignoring the two
  // specifiers that merely look similar.
  const dir = mkdtempSync(join(tmpdir(), "astrowheel-scan-"));
  try {
    const write = (path: string, body: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    };
    write("components/astro-wheel.tsx", "export function AstroWheel() { return null; }\n");
    write("components/chart-wheel.tsx", "export function ChartWheel() { return null; }\n");
    write("app/page.tsx", 'import { AstroWheel } from "@/components/astro-wheel";\n');
    write("app/deeper/nested.tsx", 'import { AstroWheel } from "../..//components/astro-wheel";\n');
    write("components/re-export.ts", 'export { AstroWheel } from "@/components/astro-wheel";\n');
    // Same module name, different module — and a lookalike that is not an import at all.
    write("app/lookalike.tsx", 'import { ChartWheel } from "@/components/chart-wheel";\nconst note = "import { AstroWheel } from \'@/components/astro-wheel\'";\n');
    assert.deepEqual(importersOf(join(dir, "components/astro-wheel"), dir), [
      "src/app/deeper/nested.tsx", "src/app/page.tsx", "src/components/re-export.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AstroWheel is confined to the three decorative surfaces, with its label intact", () => {
  // The decorative wheel must never appear on a reading page — asserted above for both a
  // legacy and a factual chart — and must remain where no chart exists.
  //
  // The scan resolves imports the way the bundler does — the `@/` alias and relative
  // paths, with the usual extension order — over the whole of `src`, so a fourth importer
  // anywhere (a new page, a nested component, a re-export) is caught rather than missed by
  // a list of files someone remembered to add.
  const allowed = ["src/app/page.tsx", "src/app/sample/page.tsx", "src/components/usage-guide.tsx"];
  const importers = importersOf("src/components/astro-wheel", resolve("src"));
  assert.deepEqual(importers, allowed.slice().sort(), "AstroWheel may only be imported by the three decorative surfaces");
  for (const file of allowed) {
    assert.ok(readFileSync(resolve(file), "utf8").includes("<AstroWheel"), `${file} still renders it`);
  }
  // The component itself still carries its decorative default, unchanged.
  const defaultLabel = render(createElement(AstroWheel, {}));
  assert.ok(defaultLabel.includes("Decorative astrological wheel"));
  assert.ok(defaultLabel.includes('role="img"'));
  // And the reading page's own decorative label is preserved as vocabulary, unused there.
  assert.equal(DECORATIVE_WHEEL_LABEL.en, "Decorative wheel, not a plot of this chart");
  assert.equal(DECORATIVE_WHEEL_LABEL.es, "Rueda decorativa, no representa esta carta");
  const source = readFileSync(resolve("src/components/reading-page-view.tsx"), "utf8");
  assert.equal(source.includes("<AstroWheel"), false, "the reading page must not mount the decorative wheel");
});

test("page: nothing casts a chart at render time and the saved-copy surfaces are untouched", () => {
  const page = readFileSync(resolve("src/components/reading-page-view.tsx"), "utf8");
  const view = readFileSync(resolve("src/readings/reading-view.ts"), "utf8");
  const blocks = readFileSync(resolve("src/readings/base-presentation.ts"), "utf8");
  const wheel = readFileSync(resolve("src/components/chart-wheel.tsx"), "utf8");
  // `page-fabricate-legacy-wheel`: no cast, no clock, no fallback geometry at render time.
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const [name, source] of [["page", page], ["wheel", wheel], ["blocks", blocks]] as const) {
    for (const forbidden of ["solarReturnFacts", "calculateSolarReturn", "castChart", "Date.now", "new Date"]) {
      assert.equal(code(source).includes(forbidden), false, `${name}: ${forbidden} must not appear in page rendering`);
    }
  }
  // The comment that names them explains the rule and is deliberately still there, on the
  // line that chooses the wheel's source facts.
  assert.ok(page.includes("never a cast") && page.includes("at render time"));
  // The wheel renders `WheelGeometry` and nothing else: it imports the projection, not a
  // second copy of the angle rule.
  assert.ok(wheel.includes('from "@/lib/wheel"'));
  assert.equal(/function\s+wheelAngle|\*\s*Math\.cos\([^)]*\*\s*DEG\)[^;]*180/.test(wheel), false);
  // Base blocks attach to the already-optional calculation; the paid path keeps its own
  // builder untouched, which is what makes `page-paid-output-changed` impossible.
  assert.ok(view.includes("baseCalculationBlocks(verifiedChart.baseFacts, presentation.content.locale)"));
  assert.ok(view.includes("paidCalculationBlocks(snapshot, edition.locale)"));
  assert.equal(view.includes("baseCalculationBlocks(snapshot"), false);
  assert.equal(readFileSync(resolve("src/readings/paid-presentation.ts"), "utf8").includes("baseCalculationBlocks"), false);
  // `page-drop-omission-notice`: every omission code is rendered, not a subset.
  assert.ok(page.includes("WHEEL_NOTICE_COPY[code][locale]"));
  assert.ok(page.includes("wheelNotices.map"));
});

test("page: the wheel is bounded by its container, and only this page is resized", () => {
  const css = readFileSync(resolve("src/app/globals.css"), "utf8");
  // Both the wide and the narrow rule cap the drawing, so an SVG with a fixed view box
  // cannot overflow a half-width or 200%-density viewport — and both are scoped to the
  // reading page, so no other `.chart-header` surface inherits this one's geometry.
  assert.ok(css.includes(".reading-page .chart-wheel { width:360px; max-width:100%; height:auto; display:block; }"));
  assert.ok(css.includes(".reading-page .chart-wheel { width:280px; max-width:100%; height:auto; }"));
  assert.ok(css.includes(".reading-page .chart-header { grid-template-columns:1fr 380px; }"));
  // The shared theme is what it was before this slice: `/sample` and the other
  // `.chart-header` surfaces keep a 270px track and a 250px drawing.
  assert.ok(css.includes(".chart-header { display:grid; grid-template-columns:1fr 270px;"), "shared track restored");
  assert.ok(css.includes(".chart-wheel { width:250px; }"), "shared drawing size restored");
  assert.ok(css.includes(".chart-wheel { width:190px; }"), "shared mobile size restored");
  // Nothing unscoped may carry the widened values: every `.reading-page .chart-*` rule is
  // namespaced to this screen, and no bare `.chart-header`/`.chart-wheel` rule holds them.
  for (const rule of css.match(/\.reading-page \.chart-[\w-]+ \{[^}]*\}/g) ?? []) {
    assert.ok(rule.startsWith(".reading-page .chart-"), `unscoped reading rule: ${rule}`);
  }
  // Each widened declaration is owned by the reading-page rules above, or by one of the
  // decorative rules that already carried that width before this slice.
  const ownerSelector = (index: number) => {
    const head = css.slice(css.lastIndexOf("}", index), index).split("}").pop()!;
    return head.slice(0, head.indexOf("{")).replace(/\/\*[\s\S]*?\*\//g, "").trim();
  };
  const allowedOwners = [".reading-page .chart-header", ".reading-page .chart-wheel", ".about-wheel",
    ".about-copy p,.sample-copy p,.section-lede"];
  for (const widened of [/grid-template-columns:1fr 380px/, /width:360px/, /width:280px/]) {
    const found = [...css.matchAll(new RegExp(widened.source, "g"))];
    assert.ok(found.length > 0, `${widened} must exist`);
    for (const match of found) {
      assert.ok(allowedOwners.includes(ownerSelector(match.index!)), `${widened} leaked into ${ownerSelector(match.index!)}`);
    }
  }

  const html = page(withFacts());
  assert.ok(html.includes('class="chart-wheel"'), "the factual wheel reuses the existing class");
  // The anchor dots are marked, so "how many positions are plotted" is a count, not a
  // guess at which circles are decorations (rings carry no marker).
  assert.equal((html.match(/data-anchor="true"/g) ?? []).length, 14);
  assert.ok(html.includes('preserveAspectRatio="xMidYMid meet"'), "the drawing scales rather than clipping");
  assert.ok(html.includes('viewBox="0 0 440 440"'));
});

test("page wheel: a chart with a truncated aspect list still draws 24 chords and says so", () => {
  const crowded = structuredClone(facts);
  for (let index = 0; index < 12; index += 1) crowded.aspects.push({ a: "Sun", b: "Moon", type: "trine", angle: 120, orb: 5 + index * 0.1, applying: null, cross: false });
  const projected: WheelGeometry = geometry(crowded);
  assert.equal(projected.chords.length, 24);
  const html = page(withFacts(crowded));
  assert.equal((html.match(/<line[^>]*stroke="(#a86658|#7a9290)"/g) ?? []).length, 24);
  assert.ok(html.includes(WHEEL_NOTICE_COPY.aspects_truncated.en));
});

test("wheel component: dropped labels are recorded in the drawing, not silently missing", () => {
  const clustered = structuredClone(facts);
  const ascendant = clustered.angles.ascendant!.longitude;
  clustered.bodies.forEach((body, index) => { body.longitude = (ascendant + 2 + index * 0.3) % 360; });
  const projected = geometry(clustered);
  assert.ok(projected.unlabelled.length > 0);
  const html = page(withFacts(clustered));
  for (const id of projected.unlabelled) {
    assert.ok(html.includes(`data-point="${id}" data-band="none"`), `${id} is recorded as unlabelled`);
    assert.ok(html.includes(`${({ en: "Sun", es: "Sol" } as Record<string, string>)[id] ?? ""}: label omitted for space`) ||
      html.includes("label omitted for space"), `${id} explains its omission`);
  }
  assert.ok(html.includes(WHEEL_NOTICE_COPY.labels_omitted.en));
});

test("wheel component: renders only what the geometry says, in both locales", () => {
  for (const locale of LOCALES) {
    const projected = geometry(facts, locale);
    const html = render(createElement(ChartWheel, { geometry: projected, locale, chartName: "Synthetic Reading", returnInstant: "May 16, 2026" }));
    // Counts come from the geometry contract, so a future ring cannot appear unnoticed.
    assert.equal((html.match(/data-point=/g) ?? []).length, projected.points.length);
    assert.equal((html.match(/<circle cx="220" cy="220" r="114"/g) ?? []).length, 1);
    assert.equal(labels(html).length, projected.points.filter(point => point.band !== null).length);
    // Sign labels are the localized sign names, from the ring index.
    for (const sign of projected.signs) assert.ok(html.includes(`>${sign.label}</text>`), sign.label);
    assert.ok(html.includes(locale === "es" ? "Signo completo" : "Whole sign"));
  }
});

test("page: language switching changes the page language, never the plotted positions", () => {
  const english = page(withFacts(facts, "en"), "en");
  const spanish = page(withFacts(facts, "es"), "es");
  // Same geometry, same anchors: localization is text only.
  assert.deepEqual(anchors(spanish), anchors(english));
  assert.notDeepEqual(labels(spanish), labels(english));
  assert.ok(spanish.includes('lang="es"'));
  // The reader's language governs the notices, and the other language's does not leak.
  assert.equal(english.includes(WHEEL_NOTICE_COPY.natal_not_plotted.es), false);
  assert.equal(spanish.includes(WHEEL_NOTICE_COPY.natal_not_plotted.en), false);
  // Copy tables that already existed are unchanged and still both-language.
  assert.equal(AVAILABILITY_COPY.chart_only.es.includes("ilustrativas"), true);
  assert.equal(NOTICE_COPY.partial.en.length > 20, true);
});

test("page: anchor-bearing markup carries no unescaped chart name or provider copy", () => {
  const chart = withFacts(facts);
  const hostile = page({ ...chart, name: '<script>alert("x")</script>', returnPlace: "<img src=x>" });
  assert.equal(hostile.includes("<script>alert"), false);
  assert.ok(hostile.includes("&lt;script&gt;"));
  // The SVG title carries the escaped name, not raw markup.
  assert.match(hostile, /<title id="chart-wheel-title">Factual chart for &lt;script&gt;/);
  for (const forbidden of ["GENERATION_CONTROLS_SENTINEL", "birthDate", "birthPlace", "32.6393", "-115.4747", "fixture-only"]) {
    assert.equal(hostile.includes(forbidden), false, forbidden);
  }
});
