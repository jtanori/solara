import type { Locale } from "@/lib/i18n";
import type { SectionKey } from "@/readings/types";

/**
 * Localized structural copy: section titles, locked-section teasers, and the
 * graceful-fallback text shown when a section could not be generated (kill
 * switch, provider failure, ceiling). Code-based dictionaries per the repo's
 * i18n convention (src/lib/i18n.ts). Presentation polish is #104's; the words
 * here must merely be honest and stable.
 */

export type LocalizedText = Record<Locale, string>;

export const SECTION_TITLES: Record<SectionKey, LocalizedText> = {
  overview: { en: "The Year in One Breath", es: "El año en un solo aliento" },
  sun: { en: "The Sun: Your Birthday Star", es: "El Sol: tu estrella de cumpleaños" },
  moon: { en: "The Moon: Emotional Weather", es: "La Luna: el clima emocional" },
  ascendant: { en: "The Ascendant: The Year's Lens", es: "El Ascendente: el lente del año" },
  aspects: { en: "Aspects: Tensions and Gifts", es: "Aspectos: tensiones y regalos" },
  houses: { en: "Houses: Where the Year Lives", es: "Casas: dónde se vive el año" },
  planets: { en: "Planets: The Cast of the Year", es: "Planetas: el reparto del año" },
  nodes: { en: "The Nodes: Direction of Growth", es: "Los Nodos: dirección de crecimiento" },
  planetaryYear: { en: "The Planetary Year", es: "El año planetario" },
  transits: { en: "Transits: Dates That Matter", es: "Tránsitos: fechas que importan" },
  guidance: { en: "Guidance: Living the Year Well", es: "Guía: vivir bien el año" },
};

export const SECTION_SUBTITLES: Record<SectionKey, LocalizedText> = {
  overview: { en: "What this solar return year is about", es: "De qué va este año de revolución solar" },
  sun: { en: "Where your vitality concentrates", es: "Dónde se concentra tu vitalidad" },
  moon: { en: "The inner climate of the year", es: "El clima interior del año" },
  ascendant: { en: "The attitude you wear into the year", es: "La actitud con la que entras al año" },
  aspects: { en: "The geometry between who you are and who you are becoming", es: "La geometría entre quien eres y en quién te conviertes" },
  houses: { en: "The rooms of life holding the action", es: "Las habitaciones de la vida con la acción" },
  planets: { en: "Every body in its return sign and house", es: "Cada cuerpo en su signo y casa de revolución" },
  nodes: { en: "The compass needle, honestly priced", es: "La aguja de brújula, con su costo" },
  planetaryYear: { en: "The planet holding the year's chair", es: "El planeta que ocupa la silla del año" },
  transits: { en: "The calendar inside the sky", es: "El calendario dentro del cielo" },
  guidance: { en: "Synthesis and practice", es: "Síntesis y práctica" },
};

/** Teasers for locked (paid, not in this document) sections — static copy, no LLM. */
export const LOCKED_TEASERS: Record<SectionKey, LocalizedText> = {
  overview: { en: "The year's headline, written for your chart.", es: "El titular del año, escrito para tu carta." },
  sun: { en: "Your birthday star and where it shines.", es: "Tu estrella de cumpleaños y dónde brilla." },
  moon: { en: "The emotional weather you'll live in.", es: "El clima emocional en el que vivirás." },
  ascendant: { en: "The lens you wear into the year.", es: "El lente con el que entras al año." },
  aspects: { en: "The year's tightest dialogues, named.", es: "Los diálogos más exactos del año, con nombre." },
  houses: { en: "The map of where the action happens.", es: "El mapa de dónde ocurre la acción." },
  planets: { en: "The cast running this year's show.", es: "El reparto que dirige la función de este año." },
  nodes: { en: "The direction of growth — and its price.", es: "La dirección de crecimiento, y su precio." },
  planetaryYear: { en: "The one planet that rules your year.", es: "El planeta que gobierna tu año." },
  transits: { en: "The dates worth circling.", es: "Las fechas que vale la pena marcar." },
  guidance: { en: "How to walk the year, concretely.", es: "Cómo caminar el año, en concreto." },
};

export const FALLBACK_PROSE: LocalizedText = {
  en: "This section of your reading couldn't be written just now. Your chart is safe and the facts below are real — the words will catch up.",
  es: "Esta parte de tu lectura no pudo escribirse por ahora. Tu carta está a salvo y los datos de abajo son reales — las palabras alcanzarán al cielo.",
};

export const LOCKED_CTA: LocalizedText = {
  en: "Unlock the full reading",
  es: "Desbloquea la lectura completa",
};
