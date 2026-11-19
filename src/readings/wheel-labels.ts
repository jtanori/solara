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
 */
export function wheelAccessibleName(chartName: string, houseSystem: string, locale: Locale): { title: string; description: string; tableNote: string } {
  return locale === "es"
    ? {
        title: `Carta factual de ${chartName}`,
        description: `Carta de ${chartName} del retorno solar, casas de ${houseSystem}.`,
        tableNote: "La tabla numérica de esta misma página es el equivalente autoritativo de este dibujo.",
      }
    : {
        title: `Factual chart for ${chartName}`,
        description: `${chartName} chart for the solar return, ${houseSystem} houses.`,
        tableNote: "The numerical table on this same page is the authoritative equivalent of this drawing.",
      };
}

/**
 * The caption under the drawing names what is missing. Identical copy to the page's notices
 * (`WHEEL_NOTICE_COPY`), restated here only for the two codes the *drawing* can carry: a
 * null geometry never reaches the PDF, because the PDF is built from a geometry the caller
 * has already projected.
 */
export function wheelOmissionText(omissions: readonly string[], locale: Locale): string[] {
  const copy: Record<string, { en: string; es: string }> = {
    natal_not_plotted: {
      en: "Only the solar return is drawn. Your natal positions are listed in the table and are not plotted in the wheel — a return point and a natal point are different moments.",
      es: "Solo se dibuja la revolución solar. Tus posiciones natales aparecen en la tabla y no se trazan en la rueda: un punto de retorno y uno natal son momentos distintos.",
    },
    cross_aspects_not_plotted: {
      en: "Aspects between the return chart and your natal chart appear only in the table, marked (natal). No chord is drawn for them.",
      es: "Los aspectos entre la carta de retorno y tu carta natal aparecen solo en la tabla, marcados (natal). No se traza ninguna cuerda para ellos.",
    },
    houses_omitted: {
      en: "The house ring was left out: a stored cusp does not bound a usable sector. The positions and aspects are unaffected.",
      es: "Se omitió el anillo de casas: una cúspide guardada no delimita un sector utilizable. Las posiciones y los aspectos no cambian.",
    },
    aspects_truncated: {
      en: "More aspects were found than fit on the wheel: only the tightest 24 by orb are drawn. The table lists each group separately.",
      es: "Se encontraron más aspectos de los que caben en la rueda: solo se dibujan los 24 más estrechos por orbe. La tabla enumera cada grupo por separado.",
    },
    labels_omitted: {
      en: "Some labels are too close together to print legibly, so they were left out of the drawing. Every one of them is listed in the table.",
      es: "Algunas etiquetas están demasiado juntas para imprimirse de forma legible, así que se omitieron del dibujo. Todas aparecen en la tabla.",
    },
  };
  return omissions.filter(code => code in copy).map(code => copy[code][locale]);
}
