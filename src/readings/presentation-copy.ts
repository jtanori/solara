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
