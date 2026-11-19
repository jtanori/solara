import { signName, type Locale } from "@/lib/i18n";
import type { ChartFacts } from "@/lib/chart";
import type { ReadingBlock } from "@/readings/types";

/**
 * The numerical facts for a base (whole-sign) chart, as the same five-block
 * vocabulary the paid calculation already uses (issue #154, slice 1-c).
 *
 * Attached to the already-optional `ReadingChart.calculation`, so the existing page and
 * PDF block renderers display it with no new block kind and no registry change. One
 * builder, one renderer, two surfaces.
 *
 * Mirrors `paidCalculationBlocks` deliberately rather than sharing code with it: the
 * paid snapshot is pinned, hash-verified output whose rendered text must not change
 * (`page-paid-output-changed`), so the paid path keeps its own function untouched. What
 * is shared is the *shape* — the block vocabulary and the label/position helpers below.
 *
 * Every entry is a derived position. Nothing here carries birth date, time, place or
 * name, and nothing is computed: the blocks are a rendering of facts that were already
 * calculated and saved.
 */

/** Body, angle, node and aspect names. Same table the paid calculation renders. */
const spanish: Record<string, string> = {
  Sun: "Sol", Moon: "Luna", Mercury: "Mercurio", Venus: "Venus", Mars: "Marte",
  Jupiter: "Júpiter", Saturn: "Saturno", Uranus: "Urano", Neptune: "Neptuno", Pluto: "Plutón",
  Ascendant: "Ascendente", Midheaven: "Medio Cielo", TrueNode: "Nodo norte", SouthNode: "Nodo sur",
  conjunction: "conjunción", opposition: "oposición", trine: "trígono", square: "cuadratura", sextile: "sextil",
};

/**
 * A point name, with the existing `(natal)` suffix convention for a cross-chart
 * endpoint. Cross-aspects appear **only** in the table: a chord between two return
 * points would assert a relationship between positions that does not exist.
 */
export function pointLabel(value: string, locale: Locale): string {
  const natal = value.startsWith("natal-");
  const name = natal ? value.slice(6) : value;
  return `${locale === "es" ? spanish[name] ?? name : name}${natal ? " (natal)" : ""}`;
}

/** House system, named the same way on the wheel notice, the table and the summary. */
export function houseSystemLabel(houseSystem: ChartFacts["houseSystem"], locale: Locale): string {
  const es = locale === "es";
  return houseSystem === "placidus" ? "Placidus" : es ? "Signo completo" : "Whole sign";
}

const POSITION_LIMIT = 24;

export function baseCalculationBlocks(facts: ChartFacts, locale: Locale): ReadingBlock[] {
  const es = locale === "es";
  const system = houseSystemLabel(facts.houseSystem, locale);
  const position = (p: { sign: string; degree: number }) => `${signName(p.sign, locale)} ${p.degree.toFixed(2)}°`;
  const bodyValue = (p: ChartFacts["bodies"][number]) => `${position(p)}${
    p.house === null ? "" : ` · ${es ? "Casa" : "House"} ${p.house}`
  } · ${p.retrograde === null ? (es ? "estacionario" : "stationary") : p.retrograde ? (es ? "retrógrado" : "retrograde") : (es ? "directo" : "direct")}`;
  const blocks: ReadingBlock[] = [
    {
      kind: "keyValue",
      title: es ? `Posiciones del retorno · ${system}` : `Return placements · ${system}`,
      entries: facts.bodies.map(p => ({ key: pointLabel(p.body, locale), value: bodyValue(p) })),
    },
  ];

  // Cusps are the stored ones, in both systems: for whole sign they are the thirty-degree
  // boundaries, for Placidus the unequal sectors the calculation actually produced. The
  // ring index is the house, so no sign is read per cusp.
  if (facts.houses.length === 12) blocks.push({
    kind: "keyValue",
    title: es ? `Cúspides · ${system} · longitud eclíptica` : `Cusps · ${system} · ecliptic longitude`,
    entries: facts.houses.map((longitude, index) => ({
      key: `${es ? "Casa" : "House"} ${index + 1}`,
      value: `${longitude.toFixed(4)}°`,
    })),
  });

  blocks.push({
    kind: "keyValue",
    title: es ? "Ángulos y nodos del retorno" : "Return angles and nodes",
    entries: [
      ...(facts.angles.ascendant
        ? [{ key: pointLabel("Ascendant", locale), value: position(facts.angles.ascendant) }]
        // At |latitude| >= 66 the calculation refuses an angle rather than approximating
        // one, so the table says so. It never prints a substitute.
        : [{ key: pointLabel("Ascendant", locale), value: es ? "No disponible · latitud alta" : "Not shown · high latitude" }]),
      { key: pointLabel("Midheaven", locale), value: position(facts.angles.midheaven) },
      { key: pointLabel("TrueNode", locale), value: position(facts.nodes.trueNode) },
      { key: pointLabel("SouthNode", locale), value: position(facts.nodes.southNode) },
    ],
  });

  // Natal bodies carry no house and no motion in this contract, and they are the natal
  // reference the return activates — labelled as such, never as return positions.
  if (facts.natal.bodies.length > 0) blocks.push({
    kind: "keyValue",
    title: es ? "Posiciones natales de referencia" : "Natal reference positions",
    entries: facts.natal.bodies.map(p => ({ key: pointLabel(p.body, locale), value: position(p) })),
  });

  // Both aspect groups, capped like the paid table. The cross group keeps the `(natal)`
  // suffix on the endpoint it applies to, which is also what stops it being mistaken for
  // a return-chart aspect.
  for (const [aspects, title] of [
    [facts.aspects, es ? `Aspectos del retorno · hasta ${POSITION_LIMIT} orbes más estrechos` : `Return aspects · up to ${POSITION_LIMIT} tightest orbs`],
    [facts.crossAspects, es ? `Aspectos retorno-natal · hasta ${POSITION_LIMIT} orbes más estrechos` : `Return-to-natal aspects · up to ${POSITION_LIMIT} tightest orbs`],
  ] as const) if (aspects.length > 0) blocks.push({
    kind: "aspectTable",
    title,
    rows: aspects.slice(0, POSITION_LIMIT).map(aspect => ({
      a: pointLabel(aspect.a, locale),
      b: pointLabel(aspect.b, locale),
      type: pointLabel(aspect.type, locale),
      orb: Number(aspect.orb.toFixed(2)),
    })),
  });

  return blocks;
}
