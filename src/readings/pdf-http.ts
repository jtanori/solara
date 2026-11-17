import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import type { Locale } from "@/lib/i18n";
import { log, requestMeta } from "@/lib/log";
import { AUTH_RATE_LIMITS, consumeBudgets, keyFor, rateLimitedResponse } from "@/lib/rate-limit";
import { authenticatedCacheHeaders, privateReferrerHeaders } from "@/lib/security-headers";
import { readingSelector } from "@/readings/chart-presentation";
import { ReadingViewError } from "@/readings/presentation";
import { loadReadingPresentation, ReadingViewStore, type ReadingViewer, type ReadingViewDeps } from "@/readings/reading-view";
import { ReadingPdfError } from "@/readings/pdf-contract";
import { readingPdfRenderer, type ReadingPdfRenderer } from "@/readings/pdf-render";

export type ReadingPdfHttpDeps = ReadingViewDeps & {
  user?: () => Promise<ReadingViewer | null>;
  locale?: Locale;
  throttle?: (request: Request, userId: string, locale: Locale) => Promise<Response | null>;
  renderer?: Pick<ReadingPdfRenderer, "render">;
};
function privateResponse(response: Response): Response {
  for (const { key, value } of [...authenticatedCacheHeaders, ...privateReferrerHeaders]) response.headers.set(key, value);
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}
function failure(code: string, status: number, retry = false): Response {
  return privateResponse(Response.json({ code }, { status, headers: retry ? { "Retry-After": "3" } : {} }));
}
async function throttle(request: Request, userId: string, locale: Locale) {
  const budget = await consumeBudgets([
    { key: keyFor("readings:pdf:user", userId), policy: AUTH_RATE_LIMITS.readingPdfUser, kind: "reading_pdf_user" },
  ], requestMeta(request));
  return budget.allowed ? null : rateLimitedResponse(locale, budget.retryAfterSeconds);
}

export async function handleReadingPdf(request: Request, readingId: string, deps: ReadingPdfHttpDeps = {}): Promise<Response> {
  try {
    const user = await (deps.user ?? currentUser)();
    if (!user?.emailVerifiedAt) return failure("unauthorized", 401);
    if (request.method !== "GET" && request.method !== "HEAD") return failure("method_not_allowed", 405);
    const locale = deps.locale ?? await getLocale();
    const limited = await (deps.throttle ?? throttle)(request, user.id, locale);
    if (limited) return privateResponse(limited);
    const selector = readingSelector(new URL(request.url).searchParams);
    const store = deps.store ?? new ReadingViewStore();
    const view = await loadReadingPresentation(user, readingId, locale, selector, { ...deps, store });
    if (view.availability === "service_unavailable") return failure("service_unavailable", 503, true);
    const { chart, content } = view;
    const responseHeaders = {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="solara-${chart.year}-${content.locale}-${content.kind === "saved-reading" ? content.partial ? "partial-reading" : "reading" : "chart-notes"}.pdf"`,
    };
    // HEAD authenticates/selects but does not spend CPU laying out discarded bytes.
    if (request.method === "HEAD") return privateResponse(new Response(null, { headers: responseHeaders }));
    const rendered = await (deps.renderer ?? readingPdfRenderer).render({ chart, content }, request.signal);
    // No transaction spans rendering. Recheck immediately before delivery; bytes
    // already delivered cannot be recalled after the unavoidable final-check race.
    if (!await store.stillOwned(user.id, readingId, content.kind === "saved-reading" ? content.id : undefined)) return failure("not_found", 404);
    if (request.signal.aborted) return failure("pdf_aborted", 503);
    return privateResponse(new Response(new Uint8Array(rendered.buffer), { headers: responseHeaders }));
  } catch (error) {
    if (error instanceof ReadingViewError) {
      const status = error.code === "unauthorized" ? 401 : error.code === "not_found" ? 404 : error.code === "invalid_selection" ? 400
        : error.code === "service_unavailable" ? 503 : 409;
      return failure(error.code, status, status === 503);
    }
    const code = error instanceof ReadingPdfError ? error.code : "pdf_unavailable";
    log.warn("readings.pdf_unavailable", { ...requestMeta(request), code });
    const status = ["pdf_input_limit", "pdf_output_limit", "pdf_page_limit", "pdf_glyphs"].includes(code) ? 409 : 503;
    return failure(code, status, status === 503);
  }
}
