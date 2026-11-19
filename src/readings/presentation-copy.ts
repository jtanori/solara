import type { Locale } from "@/lib/i18n";
import { LOCKED_TEASERS, PAID_SECTION_TITLES, PAID_SECTION_SUBTITLES, type LocalizedText } from "@/readings/copy";
import { sectionDefinition } from "@/readings/registry";
import { SECTION_KEYS } from "@/readings/types";
import type { ReadingAvailability, ReadingContent, ReadingNotice, SectionPreview } from "@/readings/presentation";

export const NOTICE_COPY: Record<ReadingNotice, LocalizedText> = {
  partial: { en: "This saved interpretation is incomplete. Missing sections will not be generated again automatically.", es: "Esta interpretación guardada está incompleta. Las secciones faltantes no se generarán de nuevo automáticamente." },
  section_failed: { en: "This section was not completed. It will not be generated again automatically.", es: "Esta sección no se completó. No se generará de nuevo automáticamente." },
  section_unavailable: { en: "This saved section cannot be displayed safely. Your chart remains available.", es: "Esta sección guardada no se puede mostrar de forma segura. Tu carta sigue disponible." },
  unsupported_blocks: { en: "Some saved content uses a format this viewer does not support and has been omitted.", es: "Parte del contenido guardado usa un formato que este visor no admite y se ha omitido." },
  legacy_question_missing: { en: "This older saved section does not include a closing question.", es: "Esta sección guardada anteriormente no incluye una pregunta de cierre." },
  missing_sections: { en: "An expected section is missing from this saved interpretation.", es: "Falta una sección esperada en esta interpretación guardada." },
  notes_unavailable: { en: "Some illustrative notes are unavailable. The saved chart data is shown below.", es: "Algunas notas ilustrativas no están disponibles. Los datos guardados de la carta se muestran abajo." },
};
export const AVAILABILITY_COPY: Record<ReadingAvailability, LocalizedText> = {
  ready: { en: "Your saved interpretation", es: "Tu interpretación guardada" },
  chart_only: { en: "Illustrative chart notes — not a generated interpretation. These notes may change after editorial updates.", es: "Notas ilustrativas de la carta; no son una interpretación generada. Pueden cambiar tras una actualización editorial." },
  other_chart: { en: "Your free interpretation belongs to another chart. These are this chart’s illustrative notes.", es: "Tu interpretación gratuita pertenece a otra carta. Estas son las notas ilustrativas de esta carta." },
  history_unavailable: { en: "Historical interpretation data is not selected for this chart. These are illustrative chart notes, not that saved output.", es: "Los datos históricos de interpretación no están seleccionados para esta carta. Estas son notas ilustrativas, no aquel resultado guardado." },
  document_unavailable: { en: "The saved interpretation cannot currently be displayed. These illustrative chart notes are not a replacement interpretation; no new request has been made.", es: "La interpretación guardada no se puede mostrar actualmente. Estas notas ilustrativas no son una interpretación de reemplazo; no se ha realizado ninguna nueva solicitud." },
  service_unavailable: { en: "We could not check the saved interpretation. This does not mean your free offer is unused. Your chart and illustrative notes remain available.", es: "No pudimos consultar la interpretación guardada. Esto no significa que tu oferta gratuita no se haya utilizado. Tu carta y notas ilustrativas siguen disponibles." },
};
export const PREVIEW_COPY = {
  title: { en: "Beyond this free interpretation", es: "Más allá de esta interpretación gratuita" },
  notice: { en: "These are topic previews, not generated content. Check your saved chart for the availability of separately requested full editions. A subscription or language change never generates an interpretation automatically.", es: "Estas son descripciones de temas, no contenido generado. Consulta tu carta guardada para conocer la disponibilidad de ediciones completas solicitadas por separado. Una suscripción o un cambio de idioma nunca genera una interpretación automáticamente." },
  not_included: { en: "Not included in this free interpretation", es: "No incluido en esta interpretación gratuita" },
  planned: { en: "Separate expanded edition — requires additional chart calculations", es: "Edición ampliada por separado; requiere cálculos adicionales de la carta" },
} satisfies Record<string, LocalizedText>;

/** A flag alone is not a verified offer. Generic pricing cannot promise access,
 * nor deny all availability merely because no owned chart was selected. */
export function paidPricingNotice(available: boolean, enabled: boolean, locale: Locale): string {
  if (!enabled) return locale === "es"
    ? "Las interpretaciones completas con IA aún no están disponibles; una suscripción no las desbloquea. El precio y la frecuencia dependen de la moneda elegida. Administra o cancela tu suscripción desde tu cuenta."
    : "Full AI interpretations are not available yet; a subscription does not unlock them. Price and billing frequency are shown for your chosen currency. Manage or cancel your subscription from your account.";
  if (!available) return locale === "es"
    ? "Consulta tu carta guardada para conocer la disponibilidad de ediciones completas. Una suscripción no inicia generación: se requieren disponibilidad verificada, consentimiento y una solicitud explícita. El precio y la frecuencia dependen de la moneda elegida. Administra o cancela desde tu cuenta."
    : "Check your saved chart for full-edition availability. A subscription does not start generation: verified availability, consent and an explicit request are required. Price and billing frequency are shown for your chosen currency. Manage or cancel from your account.";
  return locale === "es"
    ? "El pago no solicita una interpretación. Después de la confirmación verificada, vuelve a tu carta para dar consentimiento y solicitarla. Un cupo por mes UTC; no se acumula. Las ediciones guardadas permanecen después de cancelar."
    : "Checkout does not request an interpretation. After verified confirmation, return to your chart to consent and request it. One allowance per UTC month; no rollover. Saved editions remain after cancellation.";
}

/** Current product catalog, NOT a rewrite of the frozen document's lockedSections. */
export function readingPreviews(locale: Locale): SectionPreview[] {
  return SECTION_KEYS.filter(key => sectionDefinition(key).tier === "paid").map(key => ({
    key, title: PAID_SECTION_TITLES[key][locale],
    teaser: (sectionDefinition(key).requiresFacts ? PAID_SECTION_SUBTITLES : LOCKED_TEASERS)[key][locale],
    availability: sectionDefinition(key).requiresFacts ? "planned" : "not_included",
  }));
}
export function editionTitle(content: ReadingContent, locale: Locale = content.locale): string {
  if (content.kind === "chart-notes") return locale === "es" ? "Carta y notas ilustrativas" : "Chart and illustrative notes";
  if (content.partial) return locale === "es" ? "Interpretación parcial guardada" : "Saved partial interpretation";
  return locale === "es" ? "Interpretación guardada" : "Saved interpretation";
}
export function aspectHeadings(locale: Locale): string[] {
  return locale === "es" ? ["Cuerpo", "Con", "Aspecto", "Orbe"] : ["Body", "With", "Aspect", "Orb"];
}

/**
 * The wheel notice vocabulary (issue #154). One list the page renders from, keyed by the
 * omission codes `@/lib/wheel` emits, plus the two states in which it emits none because
 * it returns `null` instead. That shared vocabulary is the reason those two codes exist
 * at all: the caller knows why it has no wheel, and must still say so.
 */
export const WHEEL_NOTICE_COPY = {
  facts_unavailable: {
    en: "This chart was saved before complete positions were recorded, so no chart wheel is shown. Save a new chart to get one — nothing is guessed or redrawn to fill the gap.",
    es: "Esta carta se guardó antes de que se registraran las posiciones completas, así que no se muestra la rueda. Guarda una carta nueva para obtenerla: no se adivina ni se redibuja nada para llenar el hueco.",
  },
  ascendant_unavailable: {
    en: "The Ascendant and houses are omitted at high latitudes until the calculation is independently verified. No horizon has been invented, so no wheel is shown; the positions below are still the calculated ones.",
    es: "El ascendente y las casas se omiten en latitudes altas hasta verificar el cálculo de forma independiente. No se ha inventado un horizonte, así que no se muestra la rueda; las posiciones de abajo siguen siendo las calculadas.",
  },
  houses_omitted: {
    en: "The house ring was left out: a stored cusp does not bound a usable sector. The positions and aspects are unaffected.",
    es: "Se omitió el anillo de casas: una cúspide guardada no delimita un sector utilizable. Las posiciones y los aspectos no cambian.",
  },
  natal_not_plotted: {
    en: "Only the solar return is drawn. Your natal positions are listed in the table and are not plotted in the wheel — a return point and a natal point are different moments.",
    es: "Solo se dibuja la revolución solar. Tus posiciones natales aparecen en la tabla y no se trazan en la rueda: un punto de retorno y uno natal son momentos distintos.",
  },
  cross_aspects_not_plotted: {
    en: "Aspects between the return chart and your natal chart appear only in the table, marked (natal). No chord is drawn for them.",
    es: "Los aspectos entre la carta de retorno y tu carta natal aparecen solo en la tabla, marcados (natal). No se traza ninguna cuerda para ellos.",
  },
  aspects_truncated: {
    en: "More aspects were found than fit on the wheel: only the tightest 24 by orb are drawn. The table lists each group separately.",
    es: "Se encontraron más aspectos de los que caben en la rueda: solo se dibujan los 24 más estrechos por orbe. La tabla enumera cada grupo por separado.",
  },
  labels_omitted: {
    en: "Some labels are too close together to print legibly, so they were left out of the drawing. Every one of them is listed in the table.",
    es: "Algunas etiquetas están demasiado juntas para imprimirse con claridad y se omitieron del dibujo. Todas aparecen en la tabla.",
  },
} as const satisfies Record<string, LocalizedText>;

export type WheelNoticeCode = keyof typeof WHEEL_NOTICE_COPY;

/** The decorative label, kept exactly as it reads on the marketing surfaces. */
export const DECORATIVE_WHEEL_LABEL: LocalizedText = {
  en: "Decorative wheel, not a plot of this chart",
  es: "Rueda decorativa, no representa esta carta",
};

/**
 * The disclaimer that comes off a real reading page only when a real wheel is drawn
 * in its place. It is one string in each locale, split so the decorative sentence can be
 * dropped without dropping the calculation caveat that still applies.
 */
export function readingCalculationNotice(hasWheel: boolean, locale: Locale): string {
  const es = locale === "es";
  const calculation = es
    ? "Este cálculo es preliminar y una invitación a reflexionar, no una carta verificada profesionalmente."
    : "This is a preliminary calculation and a starting point for reflection—not a professionally verified chart.";
  if (hasWheel) return calculation;
  return es
    ? `${calculation} La rueda es decorativa y no representa tus posiciones.`
    : `${calculation} The wheel is decorative, not a plot of your placements.`;
}
