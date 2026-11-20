import React from "react";
import type { WheelGeometry } from "@/lib/wheel";
import { WHEEL_MIN_LABEL_FONT, WHEEL_VIEW_BOX } from "@/lib/wheel";
import { PDF_FONT } from "@/readings/pdf-fonts";
import type { Locale } from "@/lib/i18n";
import { houseSystemLabel } from "@/readings/base-presentation";
import { wheelAccessibleName, wheelLabelText } from "@/readings/wheel-labels";

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
 *   token, so its box is `WHEEL_VIEW_BOX` units wide.
 * - Labels are painted with **no background halo**, unlike the page. The page punches one
 *   with `paintOrder="stroke"`, where the halo is the glyph outline and can only ever cover
 *   what the glyph covers. React-PDF has neither `paintOrder` nor glyph-outline strokes, so
 *   the only equivalent is an opaque rectangle behind the label — and that rectangle is
 *   sized from geometry, not from the glyphs, so it covers whatever lies beside them. Every
 *   placed label sits on the sign band, so every such rectangle covered a zodiac name
 *   (Gemini, Taurus in the fixture). Given the choice between a label occasionally crossing
 *   a chord and a zodiac name silently disappearing, the page's copy is the one that has to
 *   stay readable: the wheel's purpose is to show where things are. This is a real
 *   fidelity gap against the page emitter, recorded here rather than papered over.
 * - There is no `role="img"`: a PDF page is already text for assistive technology. The
 *   accessible *name* and the table pointer are emitted as visible document text around the
 *   drawing (`PdfWheelNotes`), so the same words reach a reader who only has the PDF.
 * - Rust/inset radii, chord colours and tick geometry are copied verbatim from the page
 *   component; `tests/readings-wheel-pdf.test.ts` compares the emitted coordinate sets of
 *   both emitters from one fixture, so a divergence fails a test rather than shipping.
 */

type SvgRenderer = Pick<typeof import("@react-pdf/renderer"), "Svg" | "G" | "Circle" | "Line" | "Text">;
type DocumentText = Pick<typeof import("@react-pdf/renderer"), "Text">["Text"];

/**
 * The drawing's box, in points. It equals the geometry's `viewBox` on purpose: the SVG is
 * authored in geometry units, so a 1:1 box makes one geometry unit one point and the label
 * font sizes arrive at their designed size (9pt, matching body copy) instead of being scaled
 * down — at 340pt the same labels came out at 6.95pt, smaller than the text around them.
 * 440pt fills A4's 499pt text column and leaves the block well inside the page body.
 */
export const PDF_WHEEL_POINTS = WHEEL_VIEW_BOX;
const DEG = Math.PI / 180;

function polar(angle: number, radius: number, centre: number) {
  return { x: centre + radius * Math.cos(angle * DEG), y: centre + radius * Math.sin(angle * DEG) };
}

export function PdfChartWheel({ text, geometry, renderer }: {
  /** The title and caption, from the document's single `WheelCopy`. */
  text: { title: string; caption: string };
  geometry: WheelGeometry;
  renderer: SvgRenderer & { Text: DocumentText };
}): React.ReactElement {
  const { Svg, G, Circle, Line, Text } = renderer;
  const centre = geometry.viewBox / 2;
  const { radii } = geometry;
  const point = (id: string) => geometry.points.find(candidate => candidate.id === id);

  return (
    <>
      {/* The wheel's words, as ordinary document text around the drawing.
       *
       * Inside the `Svg` they were clipped away: the strings reached the content stream (every
       * glyph assertion passed, text extraction found them) while the painted page showed
       * nothing, because an `Svg` clips to its own viewport. Text extraction cannot see missing
       * pixels; the emitted raster can. As siblings they sit outside the clip, wrap at the real
       * page width instead of the 440-unit square, and stay inside the same unbreakable `View`,
       * so the words and the wheel they describe can never be split by a page break.
       *
       * They arrive as `text` rather than being recomputed here so that the layout and the
       * glyph gate read one object: see `wheelCopy`. */}
      <Text style={{ fontSize: 9, color: "#3c342f", marginBottom: 6 }}>{text.title}</Text>
      <Svg
      width={PDF_WHEEL_POINTS}
      height={PDF_WHEEL_POINTS}
      viewBox={`0 0 ${WHEEL_VIEW_BOX} ${WHEEL_VIEW_BOX}`}
      /* No `wrap` prop, and none would do anything: `Svg` is one of React-PDF's
         NON_WRAP_TYPES, so this element is never paginated.
       *
       * That protects the *drawing* and nothing else. The heading, this title, and the
       * caption are ordinary `Text` siblings, and without `wrap={false}` on the enclosing
       * View in `solar-pdf.tsx` a tight page will break between them — the words on one
       * page, the wheel they describe on the next. The unbreakable-block guarantee comes
       * from that wrapper, which is why removing it fails the title/caption co-location
       * test. An earlier version of this comment claimed the primitive made the wrapper's
       * prop redundant; that was wrong, and measured wrong. */
      style={{ marginBottom: 10 }}
    >
      <Circle cx={centre} cy={centre} r={radii.outer} fill="#FBF7F2" stroke="#8f897d" strokeWidth={0.9} />
      <Circle cx={centre} cy={centre} r={radii.signRing} fill="none" stroke="#aaa598" strokeWidth={0.7} />
      {geometry.signs.map(sign => {
        const label = polar(sign.labelAngle, (radii.signRing + radii.outer) / 2, centre);
        const start = polar(sign.startAngle, radii.signRing, centre);
        const end = polar(sign.startAngle, radii.outer, centre);
        return (
          <G key={`sign-${sign.index}`}>
            <Line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="#b3aa9d" strokeWidth={0.7} />
            <Text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle"
              style={{ fontSize: 9, fontFamily: PDF_FONT, fontWeight: 400 }} fill="#6f665c">{sign.label}</Text>
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
                <Text x={mid.x} y={mid.y} textAnchor="middle" dominantBaseline="middle"
                  style={{ fontSize: 8.5, fontFamily: PDF_FONT, fontWeight: 400 }} fill="#7d7469">{String(house.number)}</Text>
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
      {geometry.points.map(candidate => (
          <G key={`point-${candidate.id}`}>
            <Circle cx={candidate.anchor.x} cy={candidate.anchor.y} r={2.4} fill="#947d6f" />
            {candidate.band !== null && (
              <Text
                x={candidate.labelPosition.x}
                y={candidate.labelPosition.y}
                textAnchor="middle"
                dominantBaseline="middle"
                style={{ fontSize: geometry.labelFontSize[candidate.id] ?? WHEEL_MIN_LABEL_FONT, fontFamily: PDF_FONT, fontWeight: 700 }}
                fill="#3c342f"
              >{wheelLabelText(candidate.label)}</Text>
            )}
          </G>
      ))}
      </Svg>
      <Text style={{ fontSize: 8, color: "#65564a", marginTop: 6, marginBottom: 10 }}>{text.caption}</Text>
    </>
  );
}
