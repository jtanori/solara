import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Download, LockKeyhole } from "lucide-react";
import { ChartWheel } from "@/components/chart-wheel";
import { ReadingBlockView, ReadingContentView } from "@/components/reading-sections";
import { localeName, type Locale } from "@/lib/i18n";
import { projectWheel } from "@/lib/wheel";
import type { ChartFacts } from "@/lib/chart";
import { houseSystemLabel } from "@/readings/base-presentation";
import { readingEditionQuery, type ReadingPresentation, type ReadingSelector } from "@/readings/presentation";
import {
  AVAILABILITY_COPY, DECORATIVE_WHEEL_LABEL, editionTitle, readingCalculationNotice,
  WHEEL_NOTICE_COPY, type WheelNoticeCode,
} from "@/readings/presentation-copy";
import { chartDetails, chartDisclaimer, chartPlacements, returnDate } from "@/readings/presentation-format";

/**
 * The facts this presentation's wheel may be drawn from.
 *
 * A paid edition keeps its verified facts on the presentation (`wheelFacts`) because they
 * are not part of its hashed chart summary; a base chart keeps them on the chart itself.
 * One accessor, so no caller has to know which — and nothing else in the payload is
 * consulted, so a chart with neither renders no wheel rather than a fabricated one.
 */
export function wheelFactsOf(view: Pick<ReadingPresentation, "chart" | "wheelFacts">): ChartFacts | null {
  return view.wheelFacts ?? view.chart.baseFacts ?? null;
}

/** Server-only markup. Only small control props cross a client boundary. */
export function ReadingPageView({ view, locale, selector, controls, deleteControl }: { view: ReadingPresentation; locale: Locale; selector: ReadingSelector; controls?: ReactNode; deleteControl?: ReactNode }) {
  const { chart, content, availability } = view;
  const es = locale === "es";
  const saved = content.kind === "saved-reading";
  const symbols = ["☉", "☽", "↗", "⌂"];
  // Base charts carry verified whole-sign facts on the chart; a paid edition carries its
  // pinned Placidus facts on the presentation, because they are not part of its hashed
  // chart summary. Either way the wheel is one projection of saved facts — never a cast
  // at render time, which is why nothing here reaches for `solarReturnFacts`.
  const wheelFacts = wheelFactsOf(view);
  const houseSystem = wheelFacts?.houseSystem ?? (chart.result.houseSystem === "Placidus" ? "placidus" : "whole-sign");
  // The wheel is drawn in the edition's language, with the rest of the saved calculation,
  // so a chart and its table never disagree about which language they are in. Chart notes
  // have no saved locale and fall back to the interface's.
  const chartLocale = content.locale;
  const geometry = wheelFacts ? projectWheel(wheelFacts, chartLocale) : null;
  // A table pointer is only printed when there is a table to point at.
  const hasTable = (chart.calculation?.length ?? 0) > 0;
  const wheel = geometry
    // The wheel is drawn in the edition's language, so its subtree declares that language:
    // a screen reader on an English interface must not pronounce a Spanish chart name, or
    // the English instruction to the authoritative table, with English phonetics. The
    // declaration is on this cell only — the notices beside it stay in the interface's.
    ? <div className="chart-cell" lang={chartLocale}><ChartWheel geometry={geometry} locale={chartLocale} chartName={chart.name} returnInstant={returnDate(chart, chartLocale)} /></div>
    : <div className="chart-cell"><p className="small muted" style={{ maxWidth: 250 }}>{(es
      ? hasTable ? "No hay rueda para esta carta. La tabla numérica de abajo es la referencia autoritativa." : "No hay rueda para esta carta."
      : hasTable ? "There is no wheel for this chart. The numerical table below is the authoritative reference." : "There is no wheel for this chart.")}</p></div>;
  // Every omission is named; a null geometry contributes the code it can never carry
  // itself, so the reader is told why the wheel is absent rather than left to wonder.
  const wheelNotices: WheelNoticeCode[] = geometry
    ? [...geometry.omissions]
    : [wheelFacts ? "ascendant_unavailable" : "facts_unavailable"];
  return <main className="app-page reading-page"><div className="app-wrap">
    <Link href="/dashboard" className="back-link"><ArrowLeft size={15} /> {es ? "Volver a mis cartas" : "Back to my charts"}</Link>
    <div className="chart-header"><div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <div className="eyebrow">{es ? `TU REVOLUCIÓN SOLAR ${chart.year}` : `YOUR ${chart.year} SOLAR RETURN`}</div>
      <h1>{es ? <>Un nuevo capítulo<br /><em>para {chart.name}.</em></> : <>A new chapter<br /><em>for {chart.name}.</em></>}</h1>
      <p>{es ? "Tu Sol regresó a su longitud natal el" : "Your Sun returned to its birth longitude on"} <strong>{returnDate(chart, locale)}</strong> · {chart.returnPlace}.</p>
      <div className="chart-actions"><span className="pill"><LockKeyhole size={12} /> {es ? "PRIVADO PARA TI" : "PRIVATE TO YOU"}</span>
        <a className="outline-button" href={`/api/readings/${chart.id}/pdf?${readingEditionQuery(content)}`}><Download size={15} /> {es ? "Descargar PDF" : "Download PDF"}: {editionTitle(content, locale)}</a>
      </div>
      {saved && <p><Link className="plain-link" href={`/reading/${chart.id}?edition=chart`}>{es ? "Ver carta y notas ilustrativas por separado" : "View chart and illustrative notes separately"}</Link></p>}
      {!saved && <p><Link className="plain-link" href={`/reading/${chart.id}`}>{es ? "Consultar interpretación guardada" : "Check for a saved interpretation"}</Link></p>}
    </div>{wheel}</div>
    <div className="notice" style={{ marginTop: 25 }}>{readingCalculationNotice(locale)}</div>
    {wheelNotices.length > 0 && <ul className="notice" style={{ marginTop: 12, paddingLeft: 34 }} role="status">
      {wheelNotices.map(code => <li key={code}>{WHEEL_NOTICE_COPY[code][locale]}</li>)}
    </ul>}
    <div className="placement-grid">{chartPlacements(chart, locale).map((card, i) => <div className="placement-card" key={card.label}><span className="symbol" aria-hidden="true">{symbols[i]}</span><span className="tiny-label" style={{ marginTop: 14 }}>{card.label}</span><h2 style={{ fontSize: 24 }}>{card.value}</h2><p>{card.detail}</p></div>)}</div>
    <div className="chart-body"><div className="dashboard-main" style={{ minWidth: 0 }}>
      {availability !== "ready" && availability !== "chart_only" && <p className="notice" role="status">{AVAILABILITY_COPY[availability][locale]}</p>}
      {saved && content.locale !== locale && <p className="notice">{es ? `La interpretación guardada está en ${localeName(content.locale)}. Cambiar el idioma de la interfaz no la traduce ni vuelve a generarla.` : `The saved interpretation is in ${localeName(content.locale)}. Changing the interface language does not translate or regenerate it.`}</p>}
      {/* Explicit notes bypass the generation store for availability, not to
          infer a fresh offer. Use canonical navigation above for all AI controls. */}
      {selector.kind !== "chart" && controls}
      {chart.calculation && <details className="panel" lang={content.locale}>
        <summary>{content.locale === "es"
          ? `Cálculo guardado de esta edición · ${houseSystemLabel(houseSystem, content.locale)}`
          : `This edition’s saved calculation · ${houseSystemLabel(houseSystem, content.locale)}`}</summary>
        <div style={{ marginTop: 20 }}>{chart.calculation.map((block, index) => <ReadingBlockView key={index} block={block} locale={content.locale} />)}</div>
      </details>}
      <ReadingContentView content={content} />
      {!saved && <p className="small muted">{es ? "Una suscripción puede incluir notas ilustrativas adicionales. Las ediciones completas, cuando estén disponibles, requieren una solicitud explícita desde tu carta." : "A subscription may include additional illustrative notes. Full editions, when available, require an explicit request from your chart."} <Link href="/pricing" className="plain-link">{es ? "Funciones actuales" : "Current features"}</Link></p>}
    </div><section className="panel" style={{ minWidth: 0 }} aria-labelledby="chart-details-title">
      <h2 id="chart-details-title">{es ? "Tu momento en el tiempo." : "Your moment in time."}</h2>
      <dl className="detail-list">{chartDetails(chart, locale).map(entry => <div className="detail-row" key={entry.key} style={{ gap: 16 }}><dt>{entry.key}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{entry.value}</dd></div>)}</dl>
      <p className="small muted" style={{ marginTop: 18 }}>{chartDisclaimer(chart, locale)}</p>
      {deleteControl}
    </section></div>
  </div></main>;
}
