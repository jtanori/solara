import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReadingGenerationControls } from "@/components/reading-generation-controls";
import { ReadingPageView } from "@/components/reading-page-view";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { DeleteReading } from "@/components/delete-reading";
import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import { isReadingId, readingSelector } from "@/readings/chart-presentation";
import { loadReadingPresentation } from "@/readings/reading-view";
import { ReadingViewError, type ReadingPresentation } from "@/readings/presentation";

export const dynamic = "force-dynamic";
export default async function ReadingPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!isReadingId(id)) notFound();
  const [user, locale, query] = await Promise.all([currentUser(), getLocale(), searchParams]);
  if (!user?.emailVerifiedAt) redirect(`/account?next=${encodeURIComponent(`/reading/${id}`)}`);
  const es = locale === "es";
  let view: ReadingPresentation | null = null;
  let errorCode: string | null = null;
  try {
    const urlParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) value.forEach(item => urlParams.append(key, item));
      else if (value !== undefined) urlParams.append(key, value);
    }
    view = await loadReadingPresentation(user, id, locale, readingSelector(urlParams));
  } catch (error) {
    if (error instanceof ReadingViewError && error.code === "not_found") notFound();
    errorCode = error instanceof ReadingViewError ? error.code : "service_unavailable";
  }
  return <><SiteHeader />{view ? <ReadingPageView view={view} locale={locale}
    controls={<ReadingGenerationControls key={`${id}-${locale}`} readingId={id} locale={locale}
      initialGeneration={view.generation} displayedDocumentId={view.content.kind === "saved-reading" ? view.content.id : null}
      allowGeneration={view.availability === "chart_only" || view.availability === "ready"}
      refreshOnPublication={!query.document && query.edition !== "chart"} />}
    deleteControl={<DeleteReading id={id} locale={locale} />}
  /> : <main className="app-page"><section className="panel app-wrap" role="status">
    <h1>{errorCode === "invalid_selection" ? (es ? "Selección de lectura no válida" : "Invalid reading selection") : (es ? "Lectura no disponible" : "Reading unavailable")}</h1>
    <p>{es ? "No se pudo mostrar esta edición. No se ha solicitado otra interpretación." : "This edition could not be displayed. No replacement interpretation has been requested."}</p>
    {errorCode !== "invalid_chart" && <p><Link className="plain-link" href={`/reading/${id}?edition=chart`}>{es ? "Ver carta y notas ilustrativas" : "View chart and illustrative notes"}</Link></p>}
    <Link className="plain-link" href="/dashboard">{es ? "Volver a mis cartas" : "Back to my charts"}</Link>
  </section></main>}<SiteFooter /></>;
}
