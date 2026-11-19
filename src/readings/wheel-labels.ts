/**
 * The wheel's label *text*, decided once for both emitters (issue #155, slice 1-d).
 *
 * `@/lib/wheel` owns every angle, radius and collision decision, so the page and the PDF
 * already agree on where a label goes. What it does not own is the characters that label
 * contains: the page draws `point.label` and the PDF has to submit the same strings to
 * `pdfGlyphsSupported` before it may render at all. If each emitter chose independently,
 * a glyph the PDF font lacks would either produce a PDF of boxes or — worse — be silently
 * dropped from the glyph check because the PDF had quietly chosen a narrower string.
 *
 * So the truncation lives here, and `tests/readings-wheel-pdf.test.ts` asserts the page's
 * emitted text equals the PDF's extracted text for the same chart and locale. That is a
 * real equality check rather than a shared-constant check: the page component is the other
 * side of it, and only a rendered comparison can catch one emitter drifting.
 *
 * Pure: no `node:*`, no I/O, no React. The device-simulation test needs it and the worker
 * bundle includes it.
 */
import { WHEEL_MAX_LABEL_CHARS, type WheelGeometry } from "@/lib/wheel";
import type { Locale } from "@/lib/i18n";
import { WHEEL_NOTICE_COPY, type WheelNoticeCode } from "@/readings/presentation-copy";

/** A point label as both emitters print it: truncated to the geometry's own limit. */
export function wheelLabelText(label: string): string {
  return label.slice(0, WHEEL_MAX_LABEL_CHARS);
}

/** Every label the geometry actually placed, in drawing order. Omitted labels are absent. */
export function wheelLabelTexts(geometry: WheelGeometry): string[] {
  return geometry.points.filter(point => point.band !== null).map(point => wheelLabelText(point.label));
}

/**
 * Sign names around the rim, house numbers inside, and the placed point labels — the
 * complete visible text of the drawing.
 *
 * The PDF submits this list to the glyph check. Feeding it *all* point labels instead would
 * reject a chart over characters it never draws (an omitted label is a `<title>` on the
 * page and nothing in the PDF), and feeding it fewer would let a real label through
 * unchecked.
 */
export function wheelDrawingText(geometry: WheelGeometry): string[] {
  return [
    ...geometry.signs.map(sign => sign.label),
    ...geometry.houses.map(house => String(house.number)),
    ...wheelLabelTexts(geometry),
  ];
}

/**
 * The wheel's accessible name parts, identical on both surfaces so a reader who sees the
 * page and then the PDF is not told two different things about the same drawing.
 *
 * The PDF has no `role="img"`/`aria-labelledby`: a PDF page is already a sequence of text
 * for assistive technology, so the title and description are emitted as visible text under
 * the drawing instead. Same words, different mechanism.
 *
 * The table pointer says "the numerical tables **in this PDF**", not "on this same page".
 * The page can promise "below" because it is one scrollable surface; the PDF cannot. Its
 * calculation blocks start a new `Page`, so a document with facts ends the wheel page and
 * begins the tables overleaf — measured on a production-shaped input, and asserted by
 * `tests/readings-wheel-pdf.test.ts`. Pointing at the wrong page is worse than pointing at
 * the document.
 */
export function wheelAccessibleName(chartName: string, houseSystem: string, locale: Locale): { title: string; description: string; tableNote: string } {
  return locale === "es"
    ? {
        title: `Carta factual de ${chartName}`,
        description: `Carta de ${chartName} del retorno solar, casas de ${houseSystem}.`,
        tableNote: "Las tablas numéricas de este PDF son el equivalente autoritativo de este dibujo.",
      }
    : {
        title: `Factual chart for ${chartName}`,
        description: `${chartName} chart for the solar return, ${houseSystem} houses.`,
        tableNote: "The numerical tables in this PDF are the authoritative equivalent of this drawing.",
      };
}

/**
 * The notices under the drawing, in the same words the page uses.
 *
 * This reads `WHEEL_NOTICE_COPY` directly rather than restating the strings. A local copy is
 * how the two surfaces drift: the page gains a code, the PDF keeps printing the old sentence,
 * and nothing fails because each side only ever checks itself. Both surfaces now index one
 * table, so a copy change reaches both or neither.
 *
 * A code with no PDF copy is a code the drawing cannot carry, and is skipped rather than
 * printed as a key.
 */
export function wheelOmissionText(omissions: readonly string[], locale: Locale): string[] {
  return omissions
    .filter((code): code is WheelNoticeCode => code in WHEEL_NOTICE_COPY)
    .map(code => WHEEL_NOTICE_COPY[code][locale]);
}

/**
 * The explanation for a chart with **no wheel**, identical to the page's sentence.
 *
 * The first version of this slice emitted nothing here, on the theory that adding a line
 * would disturb frozen paid snapshots. That was wrong twice over: the frozen snapshots are
 * of charts that never had a wheel and take the same path, and the plan's Missing data
 * section requires the explanation whatever the format. Silence leaves a reader holding a
 * PDF with no drawing and no reason for it.
 *
 * `hasTable` mirrors the page exactly: it only promises a table when the document actually
 * carries calculation blocks. A legacy chart with none gets the short sentence rather than a
 * pointer to a table that was never rendered.
 */
export function wheelAbsentText(hasTable: boolean, locale: Locale): string {
  if (locale === "es") {
    return hasTable
      ? "No hay rueda para esta carta. La tabla numérica de este PDF es la referencia autoritativa."
      : "No hay rueda para esta carta.";
  }
  return hasTable
    ? "There is no wheel for this chart. The numerical table in this PDF is the authoritative reference."
    : "There is no wheel for this chart.";
}
