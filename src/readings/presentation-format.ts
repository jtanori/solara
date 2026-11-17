import { DateTime } from "luxon";
import { localizeWarning, signName, type Locale } from "@/lib/i18n";
import type { ReadingChart } from "@/readings/presentation";

export function returnDate(chart: ReadingChart, locale: Locale): string {
  return DateTime.fromISO(chart.result.exactUtc, { zone: "utc" }).setZone(chart.timezone).setLocale(locale)
    .toFormat(locale === "es" ? "d 'de' LLLL 'de' yyyy, HH:mm ZZZZ" : "LLLL d, yyyy 'at' h:mm a ZZZZ");
}
export function savedDate(iso: string): string {
  return DateTime.fromISO(iso, { zone: "utc" }).toFormat("yyyy-LL-dd HH:mm 'UTC'");
}
export function chartPlacements(chart: ReadingChart, locale: Locale) {
  const es = locale === "es";
  const result = chart.result;
  return [
    { label: es ? "Sol" : "Sun", value: signName(result.natalSun.sign, locale), detail: `${result.natalSun.degree.toFixed(2)}°` },
    { label: es ? "Luna" : "Moon", value: signName(result.moon.sign, locale), detail: `${result.moon.degree.toFixed(2)}°` },
    { label: es ? "Ascendente" : "Ascendant", value: result.ascendant ? signName(result.ascendant.sign, locale) : (es ? "No disponible" : "Not shown"), detail: result.ascendant ? `${result.ascendant.degree.toFixed(2)}°` : (es ? "Latitud alta" : "High latitude") },
    { label: es ? "Casa del Sol" : "Sun house", value: result.sunHouse ? `${es ? "Casa" : "House"} ${result.sunHouse}` : (es ? "No disponible" : "Not shown"), detail: es ? "Casas de signo completo" : "Whole-sign houses" },
  ];
}
export function chartDetails(chart: ReadingChart, locale: Locale) {
  const es = locale === "es";
  return [
    { key: es ? "Año de retorno" : "Return year", value: String(chart.year) },
    { key: es ? "Lugar de retorno" : "Return location", value: chart.returnPlace },
    { key: es ? "Hora de retorno (UTC)" : "Return time (UTC)", value: savedDate(chart.result.exactUtc) },
    { key: es ? "Sistema de casas" : "House system", value: es ? "Signo completo" : chart.result.houseSystem },
  ];
}
export function chartDisclaimer(chart: ReadingChart, locale: Locale): string {
  return [...chart.result.warnings.map(warning => localizeWarning(warning, locale)), locale === "es"
    ? "La astrología es una herramienta de reflexión, no una predicción ni asesoría profesional."
    : "Astrology is a reflection tool, not a prediction or professional advice."].join(" ");
}
