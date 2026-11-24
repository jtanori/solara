import type { ReactElement } from "react";
import type { Locale } from "@/lib/i18n";
import { WHEEL_MIN_LABEL_FONT, type WheelGeometry } from "@/lib/wheel";
import { wheelLabelText } from "@/readings/wheel-labels";
import { houseSystemLabel } from "@/readings/base-presentation";

/**
 * The factual wheel (issue #154, slice 1-c).
 *
 * A server component that draws `WheelGeometry` and nothing else: every angle, radius,
 * collision decision and omission already came from the pure projection in
 * `@/lib/wheel`, so this file may position nodes but may not compute a position. That
 * division is what lets the PDF (S1-d) render the same geometry from the same call.
 *
 * Accessibility: `role="img"` plus `<title>`/`<desc>` means assistive technology gets one
 * labelled image instead of walking ~150 drawing nodes, and the numerical table beside it
 * is the authoritative equivalent — stated in the description itself, so a screen-reader
 * user is told where the real numbers are.
 *
 * The geometry is rendered with a fixed 440-unit view box and `preserveAspectRatio`, and
 * the CSS class caps its width, so the wheel cannot overflow its container at the
 * half-width/200%-density viewport the browser tests emulate.
 */

export type ChartWheelProps = {
  geometry: WheelGeometry;
  locale: Locale;
  /** Chart and instant, so the title names this chart rather than "a wheel". */
  chartName: string;
  returnInstant: string;
  className?: string;
};

const DEG = Math.PI / 180;

/** A point on a concentric ring, at the geometry's own scale. Never a position of its own. */
function labelPoint(geometry: WheelGeometry, angle: number, radius: number) {
  const centre = geometry.viewBox / 2;
  return { x: centre + radius * Math.cos(angle * DEG), y: centre + radius * Math.sin(angle * DEG) };
}

export function ChartWheel({ geometry, locale, chartName, returnInstant, className = "chart-wheel" }: ChartWheelProps): ReactElement {
  const es = locale === "es";
  const titleId = "chart-wheel-title";
  const descriptionId = "chart-wheel-description";
  const centre = geometry.viewBox / 2;
  const { radii } = geometry;
  const system = houseSystemLabel(geometry.houseSystem, locale);
  const description = es
    ? `Carta de ${chartName} para el retorno del ${returnInstant}, casas de ${system}. La tabla numérica junto a esta rueda es el equivalente autoritativo de este dibujo.`
    : `${chartName} chart for the return of ${returnInstant}, ${system} houses. The numerical table beside this wheel is the authoritative equivalent of this drawing.`;

  return <svg className={className} viewBox={`0 0 ${geometry.viewBox} ${geometry.viewBox}`}
    role="img" aria-labelledby={`${titleId} ${descriptionId}`} preserveAspectRatio="xMidYMid meet"
    data-wheel-system={geometry.houseSystem} data-wheel-points={geometry.points.length}
    data-wheel-chords={geometry.chords.length} data-wheel-omissions={geometry.omissions.join(" ")}>
    <title id={titleId}>{es ? `Carta factual de ${chartName}` : `Factual chart for ${chartName}`}</title>
    <desc id={descriptionId}>{description}</desc>

    {/* Zodiac ring: one boundary per sign plus the twelve labels. */}
    <circle cx={centre} cy={centre} r={radii.outer} fill="#fbfaf5" stroke="#8f897d" strokeWidth="0.9" />
    <circle cx={centre} cy={centre} r={radii.signRing} fill="none" stroke="#aaa598" strokeWidth="0.7" />
    {geometry.signs.map(sign => {
      // Inside the sign band, between the sign ring and the outer edge — not further in,
      // where the house numbers live and would print through the sign names.
      const label = labelPoint(geometry, sign.labelAngle, (radii.signRing + radii.outer) / 2);
      return <g key={`sign-${sign.index}`}>
        <line x1={centre + radii.signRing * Math.cos(sign.startAngle * DEG)} y1={centre + radii.signRing * Math.sin(sign.startAngle * DEG)}
          x2={centre + radii.outer * Math.cos(sign.startAngle * DEG)} y2={centre + radii.outer * Math.sin(sign.startAngle * DEG)}
          stroke="#b3aa9d" strokeWidth="0.7" />
        <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" fontSize="9"
          fill="#6f665c" fontFamily="Georgia, serif">{sign.label}</text>
      </g>;
    })}

    {/* Ticks at fixed offsets from each projected sign boundary: four per sign, only the
        boundary itself full-length. The positions come from the geometry, so the page and
        the PDF cannot drift apart on where a degree mark sits. */}
    {geometry.ticks.map(tick => {
      const inner = tick.full ? radii.signRing : radii.signRing + (radii.outer - radii.signRing) * 0.5;
      return <line key={`tick-${tick.index}`}
        x1={centre + inner * Math.cos(tick.angle * DEG)} y1={centre + inner * Math.sin(tick.angle * DEG)}
        x2={centre + radii.outer * Math.cos(tick.angle * DEG)} y2={centre + radii.outer * Math.sin(tick.angle * DEG)}
        stroke="#c2b9ac" strokeWidth="0.5" />;
    })}

    {/* House ring. Omitted entirely — with a notice — when a cusp sector is degenerate. */}
    {geometry.houses.length > 0 && <>
      <circle cx={centre} cy={centre} r={radii.houseRing} fill="none" stroke="#b9b3a7" strokeWidth="0.6" />
      {geometry.houses.map(house => <g key={`house-${house.number}`}>
        <line x1={centre + radii.aspectRing * Math.cos(house.angle * DEG)} y1={centre + radii.aspectRing * Math.sin(house.angle * DEG)}
          x2={centre + radii.signRing * Math.cos(house.angle * DEG)} y2={centre + radii.signRing * Math.sin(house.angle * DEG)}
          stroke="#a8a195" strokeWidth="0.8" />
        <text x={centre + ((radii.aspectRing + radii.houseRing) / 2) * Math.cos(house.midAngle * DEG)}
          y={centre + ((radii.aspectRing + radii.houseRing) / 2) * Math.sin(house.midAngle * DEG)}
          textAnchor="middle" dominantBaseline="middle" fontSize="8.5" fill="#7d7469">{house.number}</text>
      </g>)}
    </>}
    <circle cx={centre} cy={centre} r={radii.aspectRing} fill="none" stroke="#c7c0b4" strokeWidth="0.6" />

    {/* Chords: return-chart aspects only. Cross-aspects never appear here. */}
    {geometry.chords.map((chord, index) => {
      const from = geometry.points.find(point => point.id === chord.a);
      const to = geometry.points.find(point => point.id === chord.b);
      if (!from || !to) return null;
      const inner = (point: { angle: number }) => ({
        x: centre + radii.aspectRing * Math.cos(point.angle * DEG),
        y: centre + radii.aspectRing * Math.sin(point.angle * DEG),
      });
      const a = inner(from); const b = inner(to);
      const strong = chord.type === "conjunction" || chord.type === "opposition";
      return <line key={`chord-${index}`} data-chord={`${chord.a}|${chord.b}`} data-chord-type={chord.type}
        x1={a.x} y1={a.y} x2={b.x} y2={b.y}
        stroke={index % 2 === 0 ? "#a86658" : "#7a9290"} strokeWidth={strong ? 0.9 : 0.6}
        opacity={strong ? 0.85 : 0.6} />;
    })}

    {/* Leaders, then anchors: the anchor never moves, only the label does. */}
    {geometry.points.map(point => point.leader && <line key={`leader-${point.id}`}
      x1={point.leader.from.x} y1={point.leader.from.y} x2={point.leader.to.x} y2={point.leader.to.y}
      stroke="#bda999" strokeWidth="0.5" />)}
    {geometry.points.map(point => <g key={`point-${point.id}`} data-point={point.id} data-band={point.band ?? "none"}>
      <circle cx={point.anchor.x} cy={point.anchor.y} r="2.4" fill="#947d6f" data-anchor="true" />
      {point.band === null
        ? <title>{es ? `${point.label}: etiqueta omitida por espacio` : `${point.label}: label omitted for space`}</title>
        : <text x={point.labelPosition.x} y={point.labelPosition.y} textAnchor="middle" dominantBaseline="middle"
          fontSize={geometry.labelFontSize[point.id] ?? WHEEL_MIN_LABEL_FONT} fontWeight="600" fill="#3c342f"
          stroke="#fbfaf5" strokeWidth="2.4" paintOrder="stroke">{wheelLabelText(point.label)}</text>}
    </g>)}
  </svg>;
}
