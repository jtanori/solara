export type Locale = "en" | "es";
export const localeName = (locale: Locale) => locale === "es" ? "Español" : "English";

const translatedSigns: Record<string, string> = {
  Aries: "Aries", Taurus: "Tauro", Gemini: "Géminis", Cancer: "Cáncer", Leo: "Leo", Virgo: "Virgo", Libra: "Libra", Scorpio: "Escorpio", Sagittarius: "Sagitario", Capricorn: "Capricornio", Aquarius: "Acuario", Pisces: "Piscis",
};
export function signName(sign: string, locale: Locale) { return locale === "es" ? translatedSigns[sign] ?? sign : sign; }

/**
 * Point names for the factual wheel (issue #153). Keyed by the stable point id, never
 * by a stored placement: `castChart` keeps both lunar nodes with `body: "Moon"`, so a
 * label derived from the body renders the True Node as a second Luna.
 *
 * English needs its own map because the ids are compact (`TrueNode`) while the printed
 * label is not (`True Node`). Like `signName`, this falls back to the input and imports
 * nothing — this module is used by ~80 modules, many client-side.
 */
const translatedPoints: Record<string, string> = {
  Sun: "Sun", Moon: "Moon", Mercury: "Mercury", Venus: "Venus", Mars: "Mars", Jupiter: "Jupiter",
  Saturn: "Saturn", Uranus: "Uranus", Neptune: "Neptune", Pluto: "Pluto",
  Ascendant: "Ascendant", Midheaven: "Midheaven", TrueNode: "True Node", SouthNode: "South Node",
};
const translatedPointsEs: Record<string, string> = {
  Sun: "Sol", Moon: "Luna", Mercury: "Mercurio", Venus: "Venus", Mars: "Marte", Jupiter: "Júpiter",
  Saturn: "Saturno", Uranus: "Urano", Neptune: "Neptuno", Pluto: "Plutón",
  Ascendant: "Ascendente", Midheaven: "Medio Cielo", TrueNode: "Nodo Norte", SouthNode: "Nodo Sur",
};
export function pointName(point: string, locale: Locale) {
  return locale === "es" ? translatedPointsEs[point] ?? point : translatedPoints[point] ?? point;
}

export function localizeWarning(warning: string, locale: Locale) {
  if (locale === "en") return warning;
  if (warning.includes("occurs twice")) return warning.includes("later") ? "Tu hora de nacimiento ocurrió dos veces por un cambio de horario. Se usó la segunda ocurrencia." : "Tu hora de nacimiento ocurrió dos veces por un cambio de horario. Se usó la primera ocurrencia.";
  if (warning.includes("high latitudes")) return "El ascendente y las casas se omiten en latitudes altas hasta verificar el cálculo de forma independiente.";
  if (warning.includes("Prototype calculation")) return "Cálculo preliminar: verifica el resultado y las reglas históricas de zona horaria antes de usarlo como carta profesional.";
  return warning;
}

export function localizeError(message: string, locale: Locale) {
  if (locale === "en") return message;
  if (message.includes("does not exist")) return "Esa hora local no existe en la zona horaria elegida. Revisa el cambio de horario de verano.";
  if (message.includes("birth date and a return year")) return "Elige una fecha de nacimiento válida y un año de revolución posterior al nacimiento.";
  if (message.includes("birth details, locations")) return "Revisa la fecha, las ubicaciones, las zonas horarias y el año.";
  if (message.includes("could not find a solar return")) return "No encontramos una revolución solar para ese año. Revisa tus datos.";
  if (message.includes("Unable to save")) return "No pudimos guardar tu carta. Inténtalo de nuevo.";
  return message;
}
