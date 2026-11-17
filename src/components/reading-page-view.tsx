import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft, Download, LockKeyhole } from "lucide-react";
import { AstroWheel } from "@/components/astro-wheel";
import { ReadingContentView } from "@/components/reading-sections";
import { localeName, type Locale } from "@/lib/i18n";
import { readingEditionQuery, type ReadingPresentation } from "@/readings/presentation";
import { AVAILABILITY_COPY, editionTitle } from "@/readings/presentation-copy";
import { chartDetails, chartDisclaimer, chartPlacements, returnDate } from "@/readings/presentation-format";

/** Server-only markup. Only small control props cross a client boundary. */
export function ReadingPageView({ view, locale, controls, deleteControl }: { view: ReadingPresentation; locale: Locale; controls?: ReactNode; deleteControl?: ReactNode }) {
  const { chart, content, availability } = view;
  const es = locale === "es";
  const saved = content.kind === "saved-reading";
  const symbols = ["☉", "☽", "↗", "⌂"];
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
    </div><AstroWheel className="chart-wheel" label={es ? "Rueda decorativa, no representa esta carta" : "Decorative wheel, not a plot of this chart"} /></div>
    <div className="notice" style={{ marginTop: 25 }}>{es ? "Este cálculo es preliminar y una invitación a reflexionar, no una carta verificada profesionalmente. La rueda es decorativa y no representa tus posiciones." : "This is a preliminary calculation and a starting point for reflection—not a professionally verified chart. The wheel is decorative, not a plot of your placements."}</div>
    <div className="placement-grid">{chartPlacements(chart, locale).map((card, i) => <div className="placement-card" key={card.label}><span className="symbol" aria-hidden="true">{symbols[i]}</span><span className="tiny-label" style={{ marginTop: 14 }}>{card.label}</span><h2 style={{ fontSize: 24 }}>{card.value}</h2><p>{card.detail}</p></div>)}</div>
    <div className="chart-body"><div className="dashboard-main" style={{ minWidth: 0 }}>
      {availability !== "ready" && availability !== "chart_only" && <p className="notice" role="status">{AVAILABILITY_COPY[availability][locale]}</p>}
      {saved && content.locale !== locale && <p className="notice">{es ? `La interpretación guardada está en ${localeName(content.locale)}. Cambiar el idioma de la interfaz no la traduce ni vuelve a generarla.` : `The saved interpretation is in ${localeName(content.locale)}. Changing the interface language does not translate or regenerate it.`}</p>}
      {controls}
      <ReadingContentView content={content} />
      {!saved && <p className="small muted">{es ? "Una suscripción puede incluir notas ilustrativas adicionales; no concede una interpretación completa generada con IA." : "A subscription may include additional illustrative notes; it does not grant a full AI-generated interpretation."} <Link href="/pricing" className="plain-link">{es ? "Funciones actuales" : "Current features"}</Link></p>}
    </div><section className="panel" style={{ minWidth: 0 }} aria-labelledby="chart-details-title">
      <h2 id="chart-details-title">{es ? "Tu momento en el tiempo." : "Your moment in time."}</h2>
      <dl className="detail-list">{chartDetails(chart, locale).map(entry => <div className="detail-row" key={entry.key} style={{ gap: 16 }}><dt>{entry.key}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{entry.value}</dd></div>)}</dl>
      <p className="small muted" style={{ marginTop: 18 }}>{chartDisclaimer(chart, locale)}</p>
      {deleteControl}
    </section></div>
  </div></main>;
}
