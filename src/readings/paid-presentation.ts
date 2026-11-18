import { signName, type Locale } from "@/lib/i18n";
import type { PaidSnapshot } from "@/readings/paid-chart";
import type { ReadingBlock } from "@/readings/types";
import { PAID_RICH_PROFILE } from "@/readings/paid-contract";
import { TRANSIT_DISPLAY_LIMIT } from "@/lib/annual-facts";

const spanish: Record<string, string> = { Sun: "Sol", Moon: "Luna", Mercury: "Mercurio", Venus: "Venus", Mars: "Marte", Jupiter: "Júpiter", Saturn: "Saturno", Uranus: "Urano", Neptune: "Neptuno", Pluto: "Plutón", Ascendant: "Ascendente", Midheaven: "Medio Cielo", TrueNode: "Nodo norte", SouthNode: "Nodo sur", conjunction: "conjunción", opposition: "oposición", trine: "trígono", square: "cuadratura", sextile: "sextil" };
function label(value: string, locale: Locale) {
  const natal = value.startsWith("natal-");
  const name = natal ? value.slice(6) : value;
  return `${locale === "es" ? spanish[name] ?? name : name}${natal ? " (natal)" : ""}`;
}

/** Same deterministic, bounded fact blocks on HTML and PDF. No raw facts dump. */
export function paidCalculationBlocks(snapshot: PaidSnapshot, locale: Locale): ReadingBlock[] {
  const facts = snapshot.facts; const es = locale === "es";
  const position = (p: { sign: string; degree: number }) => `${signName(p.sign, locale)} ${p.degree.toFixed(2)}°`;
  const bodyValue = (p: typeof facts.bodies[number]) => `${position(p)}${p.house === null ? "" : ` · ${es ? "Casa" : "House"} ${p.house}`} · ${p.retrograde === null ? (es ? "estacionario" : "stationary") : p.retrograde ? (es ? "retrógrado" : "retrograde") : (es ? "directo" : "direct")}`;
  const blocks: ReadingBlock[] = [
    { kind: "keyValue", title: es ? "Posiciones del retorno · Placidus" : "Return placements · Placidus", entries: facts.bodies.map(p => ({ key: label(p.body, locale), value: bodyValue(p) })) },
    { kind: "keyValue", title: es ? "Cúspides Placidus · longitud eclíptica" : "Placidus cusps · ecliptic longitude", entries: facts.houses.map((longitude, i) => ({ key: `${es ? "Casa" : "House"} ${i + 1}`, value: `${longitude.toFixed(4)}°` })) },
    { kind: "keyValue", title: es ? "Ángulos y nodos del retorno" : "Return angles and nodes", entries: [
      ...(facts.angles.ascendant ? [{ key: label("Ascendant", locale), value: position(facts.angles.ascendant) }] : []),
      { key: label("Midheaven", locale), value: position(facts.angles.midheaven) },
      { key: label("TrueNode", locale), value: position(facts.nodes.trueNode) }, { key: label("SouthNode", locale), value: position(facts.nodes.southNode) },
    ] },
    { kind: "keyValue", title: es ? "Posiciones natales de referencia" : "Natal reference positions", entries: facts.natal.bodies.map(p => ({ key: label(p.body, locale), value: position(p) })) },
  ];
  for (const [aspects, title] of [
    [facts.aspects, es ? "Aspectos del retorno · hasta 24 orbes más estrechos" : "Return aspects · up to 24 tightest orbs"],
    [facts.crossAspects, es ? "Aspectos retorno-natal · hasta 24 orbes más estrechos" : "Return-to-natal aspects · up to 24 tightest orbs"],
  ] as const) if (aspects.length) blocks.push({ kind: "aspectTable", title, rows: aspects.slice(0, 24).map(a => ({ a: label(a.a, locale), b: label(a.b, locale), type: label(a.type, locale), orb: a.orb })) });
  if (snapshot.profile === PAID_RICH_PROFILE) {
    const { profections, transits } = snapshot.annual;
    const omitted = es ? "No disponible; no se ha inferido" : "Unavailable; not inferred";
    blocks.push({ kind: "keyValue", title: es ? "Referencia natal · signo completo tradicional" : "Natal reference · traditional whole sign", entries: [
      { key: label("Ascendant", locale), value: facts.natal.angles.ascendant ? position(facts.natal.angles.ascendant) : omitted },
      { key: label("Midheaven", locale), value: facts.natal.angles.midheaven ? position(facts.natal.angles.midheaven) : omitted },
      { key: es ? "Edad cumplida en el año elegido" : "Age attained in the selected year", value: String(profections.age) },
      ...(profections.status === "available" ? [
        { key: es ? "Casa profectada · signo completo" : "Profected house · whole sign", value: String(profections.house) },
        { key: es ? "Signo profectado" : "Profected sign", value: signName(profections.sign, locale) },
        { key: es ? "Regente tradicional del año" : "Traditional year lord", value: label(profections.ruler, locale) },
      ] : [{ key: es ? "Profección anual" : "Annual profection", value: omitted }]),
    ] });
    blocks.push({ kind: "callout", title: es ? "Política de la instantánea de tránsitos" : "Transit snapshot policy", text: es
      ? `Referencia fija: ${snapshot.annual.referenceAt}. No es un calendario de tránsitos. Orbes: 3° para conjunción, oposición, trígono y cuadratura; 2° para sextil. Exacto hasta 0.001°; estacionario por debajo de 0.003°/día. Fase por diferencia de ±6 horas con puntos natales fijos. Orden: cuerpo lento, orbe, punto natal. Se muestran hasta ${TRANSIT_DISPLAY_LIMIT} de ${transits.aspects.length} aspectos. La profección usa signo completo; las casas del retorno siguen siendo Placidus.${transits.natalAnglesOmitted ? " Faltan ángulos natales; no se han inventado." : ""}`
      : `Fixed reference: ${snapshot.annual.referenceAt}. This is not a transit calendar. Orbs: 3° for conjunction, opposition, trine and square; 2° for sextile. Exact within 0.001°; stationary below 0.003°/day. Phase from ±6-hour differences with fixed natal points. Order: slow body, orb, natal point. Showing up to ${TRANSIT_DISPLAY_LIMIT} of ${transits.aspects.length} aspects. Profections use whole sign; return houses remain Placidus.${transits.natalAnglesOmitted ? " Natal angles are missing; none have been invented." : ""}` });
    const phases = { applying: es ? "aplicativo" : "applying", separating: es ? "separativo" : "separating", exact: es ? "exacto" : "exact", stationary: es ? "estacionario" : "stationary" };
    if (transits.aspects.length) blocks.push({ kind: "aspectTable", title: es ? "Tránsitos en el retorno solar · puntos natales fijos" : "Solar-return-instant transits · fixed natal points",
      rows: transits.aspects.slice(0, TRANSIT_DISPLAY_LIMIT).map(a => ({ a: label(a.transit, locale), b: label(`natal-${a.natal}`, locale), type: `${label(a.type, locale)} · ${phases[a.phase]}`, orb: a.orb })) });
  }
  return blocks;
}
