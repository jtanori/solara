import type { ChartDigest } from "@/lib/chart";
import { signName, type Locale } from "@/lib/i18n";
import type { SectionKey } from "@/readings/types";
import type { SectionOutput } from "@/readings/schemas";

/**
 * The provider adapter (`docs/plan-readings-engine-epic.md` §4.4, §9b) — the
 * single seam between the pipeline and any language model. The model is
 * configuration passed in; nothing here imports an SDK. The fixture provider
 * proves the whole machinery deterministically (corpus tests run against it);
 * a real adapter is a later, config-selected drop-in.
 */

export type ProviderUsage = { inputTokens: number; outputTokens: number };

export type CompletionRequest = {
  section: SectionKey;
  locale: Locale;
  /** Fully assembled prompt (wrapper + brief + digest + schema). */
  prompt: string;
  digest: ChartDigest;
  jsonSchema: Record<string, unknown>;
  /** Chosen by configuration in generate.ts; the provider answers with this model. */
  model: string;
  maxOutputTokens: number;
};

export type Completion = {
  /** Raw model output — untrusted, validated by the caller. */
  output: unknown;
  usage: ProviderUsage;
  model: string;
  latencyMs: number;
};

export interface ReadingProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<Completion>;
}

export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// ------------------------------------------------------------------ fixture

const ASPECT_ES: Record<string, string> = {
  conjunction: "conjunción",
  sextile: "sextil",
  square: "cuadratura",
  trine: "trígono",
  opposition: "oposición",
};

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function house(locale: Locale, n: number | null): string {
  if (n === null) return locale === "es" ? "una casa sin asignar (carta polar)" : "an unassigned house (polar chart)";
  return locale === "es" ? `la casa ${n}` : `the ${ordinal(n)} house`;
}

function aspectType(type: string, locale: Locale): string {
  return locale === "es" ? ASPECT_ES[type] ?? type : type;
}

/** A body line like "Sun in Leo, 12.3°, 5th house, retrograde". */
function bodyLine(digest: ChartDigest, body: string, locale: Locale): string {
  const found = digest.bodies.find(b => b.body === body);
  if (!found) return `${body}`;
  const sign = signName(found.sign, locale);
  const retro = found.retrograde ? (locale === "es" ? ", retrógrado" : ", retrograde") : "";
  return locale === "es"
    ? `${body} en ${sign} a ${found.degree}° en ${house(locale, found.house)}${retro}`
    : `${body} in ${sign} at ${found.degree}° in ${house(locale, found.house)}${retro}`;
}

function tightest(digest: ChartDigest): ChartDigest["crossAspects"][number] | undefined {
  return digest.crossAspects.slice().sort((a, b) => a.orb - b.orb)[0];
}

/**
 * Deterministic, schema-valid section content built straight from the digest —
 * the fixture "model". It is deliberately chart-grounded: every sentence cites
 * real facts, so downstream grounding checks would not starve.
 */
function fixtureSection(section: SectionKey, locale: Locale, digest: ChartDigest): SectionOutput {
  const es = locale === "es";
  const sun = `${signName(digest.sun.sign, locale)} ${digest.sun.degree}°`;
  const moon = `${signName(digest.moon.sign, locale)} ${digest.moon.degree}°`;
  const asc = digest.ascendant ? signName(digest.ascendant, locale) : es ? "sin Ascendente definido" : "no defined Ascendant";
  const tight = tightest(digest);

  switch (section) {
    case "overview":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `Tu revolución solar coloca el Sol en ${sun}, en ${house("es", digest.sun.house)}: ahí se concentra la vitalidad del año. El Ascendente de la revolución es ${asc}, el lente con el que entras al año.`
            : `Your solar return places the Sun in ${sun}, in ${house("en", digest.sun.house)}: that is where the year's vitality gathers. The return Ascendant is ${asc}, the lens you walk into the year wearing.` },
          { kind: "prose", text: tight ? (es
            ? `El hilo más tensión del año es ${tight.a} en ${aspectType(tight.type, "es")} con tu ${tight.b} natal (órbita ${tight.orb}°): una conversación entre quien eres y en quién te conviertes.`
            : `The year's tightest thread is ${tight.a} in ${aspectType(tight.type, "en")} to your natal ${tight.b} (orb ${tight.orb}°): a conversation between who you are and who you are becoming.`)
            : (es ? "No hay aspectos cruzados destacables este año: el año habla en tono menor." : "No notable cross-aspects this year: the year speaks in a lower key.") },
          { kind: "callout", text: es ? `El año en una línea: crecer en ${house("es", digest.sun.house)} con la energía de ${signName(digest.sun.sign, "es")}.` : `The year in one line: grow in ${house("en", digest.sun.house)} with ${signName(digest.sun.sign, "en")} energy.` },
        ],
        closingQuestion: es
          ? `Con el Sol de tu año en ${house("es", digest.sun.house)}, ¿qué construirías ahí si este año te acompañara?`
          : `With your year's Sun in ${house("en", digest.sun.house)}, what would you build there if this year had your back?`,
      };
    case "sun":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `El Sol de tu revolución está en ${sun} y cae en ${house("es", digest.sun.house)}: la nota dominante del año suena en ese territorio.`
            : `Your return Sun sits in ${sun} and falls in ${house("en", digest.sun.house)}: the year's keynote sounds in that territory.` },
          { kind: "prose", text: es
            ? `Brillar este año significa encarnar lo mejor de ${signName(digest.sun.sign, "es")} exactamente ahí: una práctica pequeña y repetible en ${house("es", digest.sun.house)} basta.`
            : `Shining this year means embodying ${signName(digest.sun.sign, "en")} right there: one small, repeatable practice in ${house("en", digest.sun.house)} is enough.` },
          { kind: "callout", text: es ? `Práctica: dedica veinte minutos por semana a ${house("es", digest.sun.house)}.` : `Practice: give twenty minutes a week to ${house("en", digest.sun.house)}.` },
        ],
        closingQuestion: es
          ? `Y el clima emocional que acompaña a ese Sol, ¿cómo será? Sigue a la Luna para verlo.`
          : `And the emotional weather under that Sun? The Moon section has it.`,
      };
    case "moon":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `La Luna de la revolución está en ${moon}, en ${house("es", digest.moon.house)}: ese es el clima emocional del año y la habitación donde se despliega.`
            : `The return Moon is in ${moon}, in ${house("en", digest.moon.house)}: that is the year's emotional weather, and the room where it plays out.` },
          { kind: "prose", text: es
            ? `Tu Luna en ${signName(digest.moon.sign, "es")} pide ritmo y cuidado concretos: descanso con horario, no promesas vagas.`
            : `Your Moon in ${signName(digest.moon.sign, "en")} asks for concrete rhythm and care: rest with a schedule, not vague promises.` },
        ],
      };
    case "ascendant":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `El Ascendente de la revolución es ${asc}: la actitud con la que el año te encuentra al primer contacto.`
            : `The return Ascendant is ${asc}: the attitude the year meets you with at first contact.` },
          { kind: "callout", text: es ? `Cuidado con el lente: ${signName(digest.ascendant ?? digest.sun.sign, "es")} puede confundir velocidad con dirección.` : `A caveat on the lens: ${signName(digest.ascendant ?? digest.sun.sign, "en")} can mistake speed for direction.` },
        ],
      };
    case "aspects": {
      const rows = digest.crossAspects.slice(0, 8).map(a => ({ a: a.a, b: a.b, type: a.type, orb: a.orb }));
      return {
        blocks: [
          { kind: "prose", text: es
            ? `La geometría del año: los aspectos más exactos entre tu revolución y tu carta natal marcan los diálogos recurrentes del año.`
            : `The year's geometry: the tightest aspects between your return and your natal chart mark the year's recurring dialogues.` },
          { kind: "aspectTable", title: es ? "Aspectos cruzados más exactos" : "Tightest cross-aspects", rows: rows.length ? rows : [{ a: "—", b: "—", type: "conjunction", orb: 0 }] },
          { kind: "prose", text: es ? `Lee la tabla como una conversación: cada órbita menor es un diálogo más frecuente.` : `Read the table as a conversation: the smaller the orb, the more often the dialogue repeats.` },
        ],
      };
    }
    case "houses": {
      const byHouse = new Map<number, string[]>();
      for (const b of digest.bodies) {
        if (b.house === null) continue;
        const list = byHouse.get(b.house) ?? [];
        list.push(b.body);
        byHouse.set(b.house, list);
      }
      const entries = [...byHouse.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)
        .map(([h, bodies]) => ({ key: es ? `Casa ${h}` : `House ${h}`, value: bodies.join(", ") }));
      return {
        blocks: [
          { kind: "prose", text: es ? `El mapa del año: estas casas de la revolución concentran los planetas.` : `The year's map: these return houses hold the planets.` },
          { kind: "keyValue", title: es ? "Casas pobladas" : "Crowded houses", entries: entries.length ? entries : [{ key: "—", value: "—" }] },
          { kind: "prose", text: es ? `La casa del Sol (${digest.sun.house ?? "—"}) es el ancla; las casas con más cuerpos, los puntos calientes.` : `The Sun's house (${digest.sun.house ?? "—"}) is the anchor; the most crowded houses are the hotspots.` },
        ],
      };
    }
    case "planets": {
      const entries = digest.bodies.map(b => ({
        key: `${b.body} — ${signName(b.sign, locale)} ${b.degree}°${b.retrograde ? " ℞" : ""}`,
        value: es ? `${house("es", b.house)}` : `${house("en", b.house)}`,
      }));
      return {
        blocks: [
          { kind: "prose", text: es ? `El reparto del año: cada planeta en su signo y casa de revolución.` : `The year's cast: every planet in its return sign and house.` },
          { kind: "keyValue", title: es ? "El reparto" : "The cast", entries },
          { kind: "prose", text: tight ? (es ? `Protagonista: ${tight.a}, en ${aspectType(tight.type, "es")} con tu ${tight.b} natal (órbita ${tight.orb}°).` : `Standout: ${tight.a}, in ${aspectType(tight.type, "en")} to your natal ${tight.b} (orb ${tight.orb}°).`) : (es ? "Sin protagonistas marcados por aspecto." : "No aspect-driven standouts.") },
        ],
      };
    }
    case "nodes":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `El Nodo Verdadero de la revolución está en ${signName(digest.nodes.north, "es")}: la dirección de crecimiento del año, y el eje que recorre con ${signName(digest.nodes.south, "es")}.`
            : `The return's true node is in ${signName(digest.nodes.north, "en")}: the year's direction of growth, on the axis it shares with ${signName(digest.nodes.south, "en")}.` },
          { kind: "callout", text: es ? `Reto concreto: haz una cosa esta temporada que ${signName(digest.nodes.north, "es")} haría y ${signName(digest.nodes.south, "es")} evitaría.` : `Concrete challenge: do one thing this season that ${signName(digest.nodes.north, "en")} would do and ${signName(digest.nodes.south, "en")} would avoid.` },
        ],
      };
    case "planetaryYear":
    case "transits":
      // Gated behind digest facts that land with #110; unreachable through the
      // registry, but kept schema-valid in case of direct dispatch.
      return {
        blocks: [
          { kind: "prose", text: es ? "Esta sección dependerá de hechos astronómicos que aún no calcula el motor." : "This section depends on engine facts that are not computed yet." },
        ],
      };
    case "guidance":
      return {
        blocks: [
          { kind: "prose", text: es
            ? `La tarea del año en una frase: crecer en ${house("es", digest.sun.house)} con la música de ${signName(digest.sun.sign, "es")}, cuidando a tu Luna en ${signName(digest.moon.sign, "es")}.`
            : `The year's assignment in one line: grow in ${house("en", digest.sun.house)} to the music of ${signName(digest.sun.sign, "en")}, while caring for your Moon in ${signName(digest.moon.sign, "en")}.` },
          { kind: "list", title: es ? "Tres prácticas" : "Three practices", items: es ? [
            `Mente: escribe tres líneas cada domingo sobre ${house("es", digest.sun.house)}.`,
            `Cuerpo u hogar: un ritual semanal que honre a tu Luna en ${signName(digest.moon.sign, "es")}.`,
            `Relaciones o trabajo: una conversación pendiente en ${house("es", digest.sun.house)}, antes de que el año avance.`,
          ] : [
            `Mind: write three lines every Sunday about ${house("en", digest.sun.house)}.`,
            `Body or home: a weekly ritual that honors your Moon in ${signName(digest.moon.sign, "en")}.`,
            `Relationships or work: one pending conversation in ${house("en", digest.sun.house)}, before the year moves on.`,
          ] },
          { kind: "prose", text: es ? `Cierra con honestidad: este año pedirá soltar algo. Lo que quede hace espacio.` : `Close with honesty: this year will ask you to give something up. What remains makes room.` },
        ],
      };
  }
}

export function createFixtureProvider(): ReadingProvider {
  return {
    name: "fixture",
    async complete(request: CompletionRequest): Promise<Completion> {
      const output = fixtureSection(request.section, request.locale, request.digest);
      const outputJson = JSON.stringify(output);
      const usage = {
        // The prompt already embeds the digest and schema — it IS the input.
        inputTokens: approxTokens(request.prompt),
        outputTokens: Math.min(approxTokens(outputJson), request.maxOutputTokens),
      };
      return {
        output,
        usage,
        model: request.model,
        latencyMs: 40 + Math.floor(usage.outputTokens / 8),
      };
    },
  };
}

export const PROVIDERS: Record<string, () => ReadingProvider> = {
  fixture: createFixtureProvider,
};
