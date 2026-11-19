/**
 * Pure wheel geometry — the projection from saved chart facts to bounded,
 * deterministic drawing instructions (issue #153, slice 1-b of Solar Return
 * completion; design authority `docs/plan-solar-wheel-facts.md`).
 *
 * One module exists because two emitters must agree: the reading page renders this
 * into `<svg>` (S1-c) and the PDF renders the identical structure into `<Svg>`
 * (S1-d). Anything either emitter would have to recompute — an angle, a radius, a
 * collision decision — belongs here instead, or the two renderings drift.
 *
 * Three rules shape everything below:
 *
 * 1. **Pure.** No clock, no randomness, no I/O, no `node:*`, no `server-only`, no
 *    database, and no `@/readings/*` import. In particular `factsVersion` is a
 *    locally declared literal: `@/readings/chart-facts` reaches `node:crypto` for
 *    canonical hashing, which would make this module unusable in a client
 *    component. A test asserts the two values are equal, so the copy cannot drift.
 * 2. **Orientation is a numeric invariant, not a visual one.** SVG is y-down, so
 *    `0°` is 3 o'clock and `90°` is 6 o'clock; the Ascendant is anchored left
 *    (`180`) and ecliptic longitude advances counter-clockwise on screen. The
 *    inverse projection exists so tests can prove the involution exactly.
 * 3. **Round at emission only.** `wheelAngle` and `longitudeAt` return unrounded
 *    values; coordinates are rounded to 3 dp as they enter the geometry, so page
 *    and PDF bytes are stable. Rounding inside the angle helpers would collapse
 *    the inversion test and hide a mirrored wheel behind a precision failure.
 */
import { BODIES, DEG, SIGN_NAMES, normalize } from "@/lib/astro";
import type { AspectType, ChartFacts } from "@/lib/chart";
import { pointName, signName, type Locale } from "@/lib/i18n";

/** Square view box; the wheel is centred at (220, 220). */
export const WHEEL_VIEW_BOX = 440;
export const WHEEL_RADII = {
  outer: 152, signRing: 128, houseRing: 114, aspectRing: 94,
  labelBandA: 170, labelBandB: 194,
} as const;
export const WHEEL_MIN_LABEL_SEPARATION_DEG = 9;
export const WHEEL_MAX_LABEL_NUDGE_DEG = 14;
export const WHEEL_MAX_CHORDS = 24;
export const WHEEL_MAX_LABEL_CHARS = 12;
export const WHEEL_MAX_ELEMENTS = 260;
/**
 * The smallest type a label may be set at and still be read. A label that would need to
 * be smaller than this to clear its neighbours is dropped instead of shrunk: an
 * unreadable glyph is not a label, and the numerical table is the authoritative
 * equivalent. Shared with the PDF so both emitters make the same decision.
 */
export const WHEEL_MIN_LABEL_FONT = 7;

/**
 * The facts contract this geometry understands, declared locally on purpose (see
 * rule 1 above). `tests/wheel.test.ts` asserts equality with `BASE_FACTS_VERSION`.
 */
export type FactsVersion = "base-facts/1";
const FACTS_VERSION: FactsVersion = "base-facts/1";

/**
 * Why part of a wheel is absent or was not drawn. Shared vocabulary: the page and
 * PDF render notices from the same list.
 *
 * `facts_unavailable` and `ascendant_unavailable` describe states in which
 * `projectWheel` returns `null` rather than a geometry, so it can never emit them —
 * a null geometry has no `omissions` array. They stay in the union because the
 * notice list is shared with S1-c/S1-d, where the caller knows why it has no wheel.
 * Do not invent a placeholder geometry to make them reachable: that is the
 * "0° Aries" failure wearing a different costume.
 */
export type WheelOmission =
  | "facts_unavailable"
  | "ascendant_unavailable"
  | "houses_omitted"
  | "natal_not_plotted"
  | "cross_aspects_not_plotted"
  | "aspects_truncated"
  | "labels_omitted";

export type WheelPoint = {
  /** Stable machine id: `"Sun"`, `"Ascendant"`, `"TrueNode"`, … */
  id: string;
  /**
   * Localized display label. Derived from `id`, never from `placement.body`:
   * `castChart` stores both nodes with `body: "Moon"`, so labelling from the body
   * would render the True Node as a second Luna with no type error to catch it.
   */
  label: string;
  kind: "body" | "angle" | "node";
  longitude: number;
  /** Exact projected screen angle, 0-360, rounded to 3 dp at emission. */
  angle: number;
  /** True position on the outer ring. Collision handling never moves this. */
  anchor: { x: number; y: number };
  /** Where the label sits when `band !== null`; the stub end when it is null. */
  labelPosition: { x: number; y: number };
  labelAngle: number;
  /** `null` = no label drawn (crowded out, or the label failed the charset guard). */
  band: "A" | "B" | null;
  /** Radial leader from the anchor to the label; for a dropped label, an 8-unit stub. */
  leader: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
};

export type WheelGeometry = {
  factsVersion: FactsVersion;
  houseSystem: "whole-sign" | "placidus";
  viewBox: number;
  radii: typeof WHEEL_RADII;
  anchorLongitude: number;
  signs: { index: number; label: string; startAngle: number; endAngle: number; labelAngle: number }[];
  /**
   * Minor ticks, four per sign, at fixed offsets from each *projected* sign boundary.
   *
   * Emitted rather than derived by each emitter: the signs rotate with the chart's own
   * Ascendant, so ticks at fixed screen angles would sit at a different offset from the
   * sign edges on every chart while still reading as degree markings. `full` marks the
   * real sign boundary, which is the only full-length line.
   */
  ticks: { index: number; angle: number; full: boolean }[];
  /**
   * The type size each placed label is set at, in view-box units. Emitted so both
   * emitters draw the same label at the same size — the PDF cannot re-derive it from text
   * metrics and get the same answer — and a label that is absent from this map is one the
   * geometry chose not to place.
   */
  labelFontSize: Record<string, number>;
  houses: { number: number; cuspLongitude: number; angle: number; midAngle: number }[];
  points: WheelPoint[];
  chords: { a: string; b: string; type: AspectType; orb: number }[];
  /** Resolvable aspects before the `WHEEL_MAX_CHORDS` cap — the true total. */
  aspectTotal: number;
  unlabelled: string[];
  omissions: WheelOmission[];
  elementCount: number;
};

const PRECISION = 1000;
/** Three decimals at emission. `-0` is collapsed so byte comparison is stable. */
function round3(value: number): number {
  const rounded = Math.round(value * PRECISION) / PRECISION;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Ecliptic longitude → screen angle. `180 + A − λ` puts the Ascendant at 9 o'clock
 * and makes longitude advance counter-clockwise on screen (SVG's y axis points
 * down, so increasing angle runs clockwise). Unrounded: see rule 3.
 */
export function wheelAngle(longitude: number, anchorLongitude: number): number {
  return normalize(180 + anchorLongitude - normalize(longitude));
}

/** Exact inverse of `wheelAngle`; the round-trip is the strongest orientation test. */
export function longitudeAt(angle: number, anchorLongitude: number): number {
  return normalize(180 + anchorLongitude - normalize(angle));
}

/** Polar → cartesian, y-down, rounded to 3 dp. */
export function wheelPoint(angle: number, radius: number, viewBox: number = WHEEL_VIEW_BOX): { x: number; y: number } {
  const centre = viewBox / 2;
  const radians = angle * DEG;
  return {
    x: round3(centre + radius * Math.cos(radians)),
    y: round3(centre + radius * Math.sin(radians)),
  };
}

/** Shortest circular distance in degrees, so a 0/360 wrap is never a large gap. */
function circularSeparation(a: number, b: number): number {
  const difference = Math.abs(normalize(a) - normalize(b)) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/** Code-unit comparison: `localeCompare` varies with ICU and would break snapshots. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Label guard, checked before a label is placed (not merely asserted in tests).
 *
 * Latin letters including diacritics, decimal digits, `°` and space — a Unicode
 * property, never an ASCII class: Spanish carries `é`, `ú`, `ó` (`Géminis`,
 * `Júpiter`, `Plutón`), and an ASCII regex would drop every label of a Spanish
 * wheel. A label that fails here is dropped with the same honesty as a crowded-out
 * one, so a future i18n edit degrades a label instead of shipping a glyph the PDF
 * subset lacks (which fails that whole PDF at `409 pdf_glyphs`).
 */
const LABEL_PATTERN = /^[\p{Script=Latin}\p{Nd}° ]+$/u;
function validLabel(label: string): boolean {
  const characters = [...label];
  return characters.length > 0 && characters.length <= WHEEL_MAX_LABEL_CHARS && LABEL_PATTERN.test(label);
}

/** Candidate label offsets, in this fixed order: 0, −1, +1, −2, +2, … ±14. */
const LABEL_NUDGES: number[] = [0];
for (let step = 1; step <= WHEEL_MAX_LABEL_NUDGE_DEG; step += 1) LABEL_NUDGES.push(-step, step);

/** Tolerance for calling a cusp sector degenerate; far below any real sector. */
const DEGENERATE_EPSILON = 1e-9;
/** Radial leader stub for a label that could not be placed (D8). */
const DROPPED_LABEL_STUB = 8;
const LEADER_THRESHOLD_DEG = 0.5;

/**
 * A label's drawn box, in view-box units, including its halo — the rectangle a reader
 * actually sees, not the arc its centre sits on.
 *
 * `band` is kept so the rule "labels in one band keep a minimum angular separation" can
 * still be enforced on top of the box test; the box test itself is deliberately blind to
 * band, because labels in *different* bands are drawn at different radii and can still
 * collide (an inner-ring label reaching outwards over an outer-ring one).
 */
type PlacedLabel = {
  angle: number;
  band: "A" | "B";
  centreX: number;
  centreY: number;
  halfWidth: number;
  halfHeight: number;
};

/**
 * Design type size for a label with room, the advance of one character, and the line box,
 * all as fractions of the type size. Each is deliberately at or above what the shipped
 * faces measure (an uppercase initial measures up to 0.70 em per character and a Latin
 * line box up to 1.28 em, before the halo): a label judged to fit when it does not is the
 * bug this whole rule exists to prevent, while one set slightly small is merely quiet.
 * The PDF uses the same constants, so page and PDF agree without either re-deriving them.
 */
export const LABEL_FONT_MAX = 10;
export const LABEL_ADVANCE = 0.72;
export const LABEL_LINE_HEIGHT = 1.35;
/**
 * Halo half-width in view-box units: the emitters stroke a 2.4-wide outline behind the
 * glyphs so a label stays readable over a chord, which extends the painted box by 1.2 on
 * every side; 0.3 more keeps two haloes from merely touching.
 */
const LABEL_HALO = 1.5;
/** Size steps tried below `LABEL_FONT_MAX`; 0.25 is far finer than the eye resolves here. */
const LABEL_FONT_STEP = 0.25;

/** The painted box of a label centred at `angle` on a ring of `radius`. */
function labelBox(angle: number, characters: number, fontSize: number, radius: number): Omit<PlacedLabel, "angle" | "band"> {
  const centre = wheelPoint(angle, radius);
  return {
    centreX: centre.x,
    centreY: centre.y,
    halfWidth: (characters * LABEL_ADVANCE * fontSize) / 2 + LABEL_HALO,
    halfHeight: (LABEL_LINE_HEIGHT * fontSize) / 2 + LABEL_HALO,
  };
}

/** Whether two painted label boxes touch. Touching counts as a collision. */
function boxesIntersect(a: PlacedLabel, b: PlacedLabel): boolean {
  return Math.abs(a.centreX - b.centreX) < a.halfWidth + b.halfWidth
    && Math.abs(a.centreY - b.centreY) < a.halfHeight + b.halfHeight;
}

/**
 * Where this label may be placed in `band`, or `null` when nothing readable fits.
 *
 * The test is pairwise against **every label already emitted, whichever band it is in**:
 * bands sit at different radii, so equal angular separation is not equal distance, and a
 * per-band check lets an A label overlap a B one. Within a band the older angular-minimum
 * floor still applies, which keeps neighbours far enough apart that their leader stubs
 * read as separate lines.
 *
 * Candidate order is fixed — nudge 0, −1, +1, … then size descending — so the choice is
 * deterministic and a tie resolves towards the label that moves least.
 */
function placeLabel(angle: number, characters: number, radius: number, band: "A" | "B", placed: PlacedLabel[]): { angle: number; fontSize: number; box: PlacedLabel } | null {
  for (const nudge of LABEL_NUDGES) {
    const candidate = normalize(angle + nudge);
    for (let fontSize = LABEL_FONT_MAX; fontSize >= WHEEL_MIN_LABEL_FONT; fontSize -= LABEL_FONT_STEP) {
      const box: PlacedLabel = { angle: candidate, band, ...labelBox(candidate, characters, fontSize, radius) };
      const collides = placed.some(other => boxesIntersect(box, other));
      const crowded = placed.some(other => other.band === band
        && circularSeparation(candidate, other.angle) < WHEEL_MIN_LABEL_SEPARATION_DEG);
      if (!collides && !crowded) return { angle: candidate, fontSize, box };
    }
  }
  return null;
}

type ProjectedPoint = { id: string; kind: WheelPoint["kind"]; longitude: number; angle: number };

/** The 14 plotted points, in assembly order, before the deterministic sort. */
function projectPoints(facts: ChartFacts, anchorLongitude: number): ProjectedPoint[] {
  const projected: ProjectedPoint[] = [];
  const add = (id: string, kind: WheelPoint["kind"], longitude: number) =>
    projected.push({ id, kind, longitude, angle: wheelAngle(longitude, anchorLongitude) });
  for (const body of BODIES) {
    const placement = facts.bodies.find(item => item.body === body);
    if (placement) add(body, "body", placement.longitude);
  }
  // `projectWheel` has already refused a null Ascendant, so this never invents one.
  const ascendant = facts.angles.ascendant;
  if (ascendant) add("Ascendant", "angle", ascendant.longitude);
  add("Midheaven", "angle", facts.angles.midheaven.longitude);
  add("TrueNode", "node", facts.nodes.trueNode.longitude);
  add("SouthNode", "node", facts.nodes.southNode.longitude);
  // Total order: angle, then id. Insertion order can therefore never reach the
  // output, which is what makes repeated and shuffled calls deep-equal.
  return projected.sort((a, b) => a.angle - b.angle || compareIds(a.id, b.id));
}

/**
 * Project saved facts into drawing instructions, or `null` when there is nothing
 * honest to draw.
 *
 * `null` is returned — never a geometry with a substitute — when the facts are
 * absent, the Ascendant is null (|latitude| >= 66 refuses to approximate it), or
 * the cusp list is not exactly twelve. The wheel is omitted, never invented.
 */
export function projectWheel(facts: ChartFacts | null | undefined, locale: Locale): WheelGeometry | null {
  if (!facts) return null;
  const ascendant = facts.angles.ascendant;
  if (!ascendant) return null;
  if (facts.houses.length !== 12) return null;

  const anchorLongitude = normalize(ascendant.longitude);
  const projected = projectPoints(facts, anchorLongitude);

  const points: WheelPoint[] = [];
  const unlabelled: string[] = [];
  const labelFontSize: Record<string, number> = {};
  /** Every label emitted so far, in either band: the collision test is across both. */
  const placed: PlacedLabel[] = [];
  for (const item of projected) {
    const label = pointName(item.id, locale);
    const anchor = wheelPoint(item.angle, WHEEL_RADII.outer);
    let band: "A" | "B" | null = null;
    let labelAngle = item.angle;
    let fontSize = 0;
    const characters = [...label].length;
    if (validLabel(label)) {
      // A label is only ever placed where it fits at a readable size; band A is tried
      // first, then band B, then the label is dropped and recorded. Anchors never move.
      const inBandA = placeLabel(item.angle, characters, WHEEL_RADII.labelBandA, "A", placed);
      if (inBandA !== null) {
        band = "A";
        labelAngle = inBandA.angle;
        fontSize = inBandA.fontSize;
        placed.push(inBandA.box);
      } else {
        const inBandB = placeLabel(item.angle, characters, WHEEL_RADII.labelBandB, "B", placed);
        if (inBandB !== null) {
          band = "B";
          labelAngle = inBandB.angle;
          fontSize = inBandB.fontSize;
          placed.push(inBandB.box);
        }
      }
    }
    if (band === null) unlabelled.push(item.id);
    if (band !== null) labelFontSize[item.id] = round3(fontSize);
    const radius = band === "A" ? WHEEL_RADII.labelBandA
      : band === "B" ? WHEEL_RADII.labelBandB
      : WHEEL_RADII.outer + DROPPED_LABEL_STUB;
    const labelPosition = wheelPoint(labelAngle, radius);
    // A dropped label still gets a radial stub, so the position is visible even
    // when its name is not; a placed label gets a leader only when it was nudged
    // far enough that the connection is not obvious.
    const leader = band === null || circularSeparation(labelAngle, item.angle) > LEADER_THRESHOLD_DEG
      ? { from: { ...anchor }, to: { ...labelPosition } }
      : null;
    points.push({
      id: item.id,
      label,
      kind: item.kind,
      longitude: item.longitude,
      angle: round3(item.angle),
      anchor,
      labelPosition,
      labelAngle: round3(labelAngle),
      band,
      leader,
    });
  }

  // Signs come from the ring index, never from a stored placement: a stored sign
  // can disagree with its longitude at a sign boundary (`castChart` takes the sign
  // before rounding the longitude), and a per-point sign field would make that
  // disagreement reachable again.
  const signs = SIGN_NAMES.map((name, index) => ({
    index,
    label: signName(name, locale),
    startAngle: round3(wheelAngle(index * 30, anchorLongitude)),
    endAngle: round3(wheelAngle(normalize((index + 1) * 30), anchorLongitude)),
    labelAngle: round3(wheelAngle(normalize(index * 30 + 15), anchorLongitude)),
  }));

  // Cusps are projected from the stored facts, never recomputed: both house
  // systems keep exactly one source of truth. The mid-angle is derived from the
  // sector the stored cusps actually span, so unequal Placidus sectors land
  // correctly as well as uniform whole-sign ones.
  const cuspAngles = facts.houses.map(cusp => wheelAngle(cusp, anchorLongitude));
  const deltas = cuspAngles.map((angle, index) => normalize(angle - cuspAngles[(index + 1) % 12]!));
  // A sector of 0 or 180 degrees (within float noise: stored cusps are 4-dp values
  // and the projection adds no rounding, so an identical cusp is exact and a
  // half-circle apart one is within an ulp) is not a sector. Neither is one that
  // wraps past half the circle.
  const degenerate = deltas.some(delta => delta <= DEGENERATE_EPSILON || delta >= 180 - DEGENERATE_EPSILON);
  const houses = degenerate ? [] : facts.houses.map((cuspLongitude, index) => ({
    number: index + 1,
    cuspLongitude,
    angle: round3(cuspAngles[index]!),
    midAngle: round3(normalize(cuspAngles[index]! - deltas[index]! / 2)),
  }));

  const omissions: WheelOmission[] = [];
  if (degenerate) omissions.push("houses_omitted");
  const natal = facts.natal;
  if (natal.bodies.length > 0 || natal.houses.length > 0 ||
      natal.angles.ascendant !== null || natal.angles.midheaven !== null) omissions.push("natal_not_plotted");
  if (facts.crossAspects.length > 0) omissions.push("cross_aspects_not_plotted");

  // Chords come only from the return chart's own aspects. A cross-aspect links a
  // return point to a natal one; drawn inside a single return ring it would assert
  // a relationship between two return positions that does not exist. An aspect
  // naming a point this wheel does not project is dropped rather than drawn to a
  // fabricated position.
  const known = new Set(projected.map(point => point.id));
  const resolvable = facts.aspects.filter(aspect =>
    aspect.a !== aspect.b && known.has(aspect.a) && known.has(aspect.b));
  const chords = resolvable
    .slice()
    // Total order: orb, then the pair, then the type. Without the last term two
    // aspects sharing pair and orb would keep insertion order, and the chord list
    // would depend on how the facts happened to be written.
    .sort((a, b) => a.orb - b.orb || compareIds(a.a, b.a) || compareIds(a.b, b.b) || compareIds(a.type, b.type))
    .slice(0, WHEEL_MAX_CHORDS)
    .map(aspect => ({ a: aspect.a, b: aspect.b, type: aspect.type, orb: aspect.orb }));
  if (resolvable.length > WHEEL_MAX_CHORDS) omissions.push("aspects_truncated");
  if (unlabelled.length > 0) omissions.push("labels_omitted");

  const labelled = points.filter(point => point.band !== null).length;
  const leaders = points.filter(point => point.leader !== null).length;
  const elementCount = 1                        // zodiac ring
    + signs.length * 2                          // boundaries + labels
    + houses.length * 2                         // cusp lines + numbers (0 when omitted)
    + signs.length * 4                          // minor ticks
    + points.length                             // anchor dots
    + labelled                                  // label glyph groups
    + leaders                                   // leader lines
    + chords.length;

  return {
    factsVersion: FACTS_VERSION,
    houseSystem: facts.houseSystem,
    viewBox: WHEEL_VIEW_BOX,
    radii: { ...WHEEL_RADII },
    anchorLongitude,
    signs,
    // Four minor ticks per sign, measured from that sign's own projected boundary. The
    // boundary itself is the only full-length line, so the ring cannot read as a scale
    // that disagrees with the plotted zodiac.
    labelFontSize,
    ticks: signs.flatMap(sign => Array.from({ length: 4 }, (_, offset) => ({
      index: sign.index * 4 + offset,
      // Offsets are degrees along the zodiac (7.5° = a quarter of a sign), then projected
      // like everything else — so a tick sits at a fixed distance from its own boundary.
      angle: round3(wheelAngle(sign.index * 30 + offset * 7.5, anchorLongitude)),
      full: offset === 0,
    }))),
    houses,
    points,
    chords,
    aspectTotal: resolvable.length,
    unlabelled,
    omissions,
    elementCount,
  };
}
