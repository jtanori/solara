import React from "react";
import type { WheelGeometry } from "@/lib/wheel";
import { WHEEL_MIN_LABEL_FONT, WHEEL_VIEW_BOX } from "@/lib/wheel";
import { houseSystemLabel } from "@/readings/base-presentation";
import type { Locale } from "@/lib/i18n";
import { wheelAccessibleName, wheelLabelText, wheelOmissionText } from "@/readings/wheel-labels";

/**
 * The factual wheel in the PDF (issue #155, slice 1-d).
 *
 * A second *emitter*, not a second projection. Every angle, radius, label position, font
 * size and collision decision arrives in `WheelGeometry` from `@/lib/wheel`, exactly as the
 * page receives it; this file positions nodes and computes nothing. The one thing it
 * derives locally is a polar point from an angle the geometry already emitted, which is the
 * same arithmetic the page does — a chord endpoint has to be found from the point's own
 * angle on the aspect ring.
 *
 * Deliberate differences from the page, each with a reason:
 *
 * - SVG `Text` here is laid out by React-PDF's own engine, which honours `textAnchor` and
 *   `dominantBaseline` but reflows text it thinks is too wide. A label is a single short
 *   token, so its box is `WHEEL_VIEW_BOX` units wide and the halo/`paintOrder` trick the
 *   page uses to punch a background behind each label is replaced by an explicit filled
 *   `Rect` behind the text. PDF has no `paintOrder`, so a stroked glyph would paint the
 *   stroke on top of the fill and thicken the letters.
 * - There is no `role="img"`: a PDF page is already text for assistive technology. The
 *   accessible *name* is emitted as visible text instead (`wheelAccessibleName`), so the
 *   same words reach a reader who only has the PDF.
 * - Rust/inset radii, chord colours and tick geometry are copied verbatim from the page
 *   component; `tests/readings-wheel-pdf.test.ts` compares the emitted coordinate sets of
 *   both emitters from one fixture, so a divergence fails a test rather than shipping.
 */

type SvgRenderer = Pick<typeof import("@react-pdf/renderer"), "Svg" | "G" | "Circle" | "Line" | "Rect" | "Text">;

/** The page draws the wheel at 360pt wide; 340 keeps it inside A4's 499pt body with margins. */
export const PDF_WHEEL_POINTS = 340;
const DEG = Math.PI / 180;

function polar(angle: number, radius: number, centre: number) {
  return { x: centre + radius * Math.cos(angle * DEG), y: centre + radius * Math.sin(angle * DEG) };
}

/**
 * Conservative label box for the halo rectangle: the geometry's own type size is in
 * view-box units, and 0.62 em per character is the widest the embedded Noto Sans advance
 * measured at (0.683 em/char in the browser suite). Used only to size a background, never
 * to decide placement — placement is already final.
 */
function haloBox(point: { labelPosition: { x: number; y: number }; label: string }, fontSize: number) {
  const width = wheelLabelText(point.label).length * fontSize * 0.7 + 1.6;
  const height = fontSize * 1.35;
  return {
    x: point.labelPosition.x - width / 2,
    y: point.labelPosition.y - height / 2,
    width,
    height,
  };
}

export function PdfChartWheel({ geometry, locale, chartName, renderer }: {
  geometry: WheelGeometry;
  locale: Locale;
  chartName: string;
  renderer: SvgRenderer;
}): React.ReactElement {
  const { Svg, G, Circle, Line, Rect, Text } = renderer;
  const centre = geometry.viewBox / 2;
  const { radii } = geometry;
  const system = houseSystemLabel(geometry.houseSystem, locale);
  const { title, description, tableNote } = wheelAccessibleName(chartName, system, locale);
  const omissions = wheelOmissionText(geometry.omissions, locale);
  const point = (id: string) => geometry.points.find(candidate => candidate.id === id);

  return (
    <Svg
      width={PDF_WHEEL_POINTS}
      height={PDF_WHEEL_POINTS}
      viewBox={`0 0 ${WHEEL_VIEW_BOX} ${WHEEL_VIEW_BOX}`}
      /* No `wrap` prop: `Svg` is one of React-PDF's NON_WRAP_TYPES, so it is never
         paginated whatever the caller does. The unbreakable-block guarantee is a property
         of the primitive, not of this call — which is stronger than a prop, and is why a
         mutation that "removes wrap={false}" cannot reintroduce a split wheel here. */
      style={{ marginBottom: 10 }}
    >
      {/* Accessible name as text. A PDF has no img role; the words still reach a reader. */}
      <Text x={0} y={-14} style={{ fontSize: 9 }}>{title}</Text>

      <Circle cx={centre} cy={centre} r={radii.outer} fill="#FBF7F2" stroke="#8f897d" strokeWidth={0.9} />
      <Circle cx={centre} cy={centre} r={radii.signRing} fill="none" stroke="#aaa598" strokeWidth={0.7} />
      {geometry.signs.map(sign => {
        const label = polar(sign.labelAngle, (radii.signRing + radii.outer) / 2, centre);
        const start = polar(sign.startAngle, radii.signRing, centre);
        const end = polar(sign.startAngle, radii.outer, centre);
        return (
          <G key={`sign-${sign.index}`}>
            <Line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#b3aa9d" strokeWidth={0.7} />
            <Text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 9 }} fill="#6f665c">{sign.label}</Text>
          </G>
        );
      })}

      {geometry.ticks.map(tick => {
        const inner = tick.full ? radii.signRing : radii.signRing + (radii.outer - radii.signRing) * 0.5;
        const from = polar(tick.angle, inner, centre);
        const to = polar(tick.angle, radii.outer, centre);
        return <Line key={`tick-${tick.index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#c2b9ac" strokeWidth={0.5} />;
      })}

      {geometry.houses.length > 0 && (
        <G>
          <Circle cx={centre} cy={centre} r={radii.houseRing} fill="none" stroke="#b9b3a7" strokeWidth={0.6} />
          {geometry.houses.map(house => {
            const from = polar(house.angle, radii.aspectRing, centre);
            const to = polar(house.angle, radii.signRing, centre);
            const mid = polar(house.midAngle, (radii.aspectRing + radii.houseRing) / 2, centre);
            return (
              <G key={`house-${house.number}`}>
                <Line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#a8a195" strokeWidth={0.8} />
                <Text x={mid.x} y={mid.y} textAnchor="middle" dominantBaseline="middle" style={{ fontSize: 8.5 }} fill="#7d7469">{String(house.number)}</Text>
              </G>
            );
          })}
        </G>
      )}
      <Circle cx={centre} cy={centre} r={radii.aspectRing} fill="none" stroke="#c7c0b4" strokeWidth={0.6} />

      {/* Return-chart aspects only: a cross-aspect has no chord on either surface. */}
      {geometry.chords.map((chord, index) => {
        const from = point(chord.a);
        const to = point(chord.b);
        if (!from || !to) return null;
        const a = polar(from.angle, radii.aspectRing, centre);
        const b = polar(to.angle, radii.aspectRing, centre);
        const strong = chord.type === "conjunction" || chord.type === "opposition";
        return (
          <Line key={`chord-${index}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={index % 2 === 0 ? "#a86658" : "#7a9290"} strokeWidth={strong ? 0.9 : 0.6}
            strokeOpacity={strong ? 0.85 : 0.6} />
        );
      })}

      {geometry.points.map(candidate => candidate.leader && (
        <Line key={`leader-${candidate.id}`}
          x1={candidate.leader.from.x} y1={candidate.leader.from.y}
          x2={candidate.leader.to.x} y2={candidate.leader.to.y}
          stroke="#bda999" strokeWidth={0.5} />
      ))}
      {geometry.points.map(candidate => {
        const box = candidate.band === null ? null : haloBox(candidate, geometry.labelFontSize[candidate.id] ?? WHEEL_MIN_LABEL_FONT);
        return (
          <G key={`point-${candidate.id}`}>
            <Circle cx={candidate.anchor.x} cy={candidate.anchor.y} r={2.4} fill="#947d6f" />
            {box && <Rect x={box.x} y={box.y} width={box.width} height={box.height} fill="#FBF7F2" />}
            {candidate.band !== null && (
              <Text
                x={candidate.labelPosition.x}
                y={candidate.labelPosition.y}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ fontSize: geometry.labelFontSize[candidate.id] ?? WHEEL_MIN_LABEL_FONT, fontWeight: 700 }}
                fill="#3c342f"
              >{wheelLabelText(candidate.label)}</Text>
            )}
          </G>
        );
      })}

      {/* Name, omissions and the pointer to the table, as text under the drawing. */}
      <Text x={0} y={WHEEL_VIEW_BOX + 12} style={{ fontSize: 8 }} fill="#65564a">{`${description} ${tableNote}`}</Text>
    </Svg>
  );
}
