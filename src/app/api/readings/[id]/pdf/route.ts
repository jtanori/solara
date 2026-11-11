import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import { getReadingNotes } from "@/lib/reading-content";
import { SolarReturnDocument } from "@/components/solar-pdf";
import { log, requestMeta } from "@/lib/log";
import { AUTH_RATE_LIMITS, consumeBudgets, keyFor, rateLimitedResponse } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  const user=await currentUser(); if(!user) return new Response("Unauthorized",{status:401});
  // PDF rendering is CPU-heavy (auth amendment §S2). Limited per account, before
  // any work: the route reads a chart, renders three pages and serialises a PDF.
  const budget=await consumeBudgets([
    {key:keyFor("readings:pdf:user",user.id),policy:AUTH_RATE_LIMITS.readingPdfUser,kind:"reading_pdf_user"},
  ],requestMeta(request));
  if(!budget.allowed) return rateLimitedResponse(await getLocale(),budget.retryAfterSeconds,{en:"You have downloaded several PDFs recently. Please try again shortly.",es:"Has descargado varios PDF recientemente. Inténtalo de nuevo en un momento."});
  const {id}=await params; if(!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found",{status:404});
  const [chart]=await db.select().from(readings).where(and(eq(readings.id,id),eq(readings.userId,user.id))).limit(1);
  if(!chart) return new Response("Not found",{status:404});
  try {
    const locale=await getLocale(); const notes=await getReadingNotes(chart.result,locale);
    const renderer=await import("@react-pdf/renderer");
    const buffer=await renderer.renderToBuffer(SolarReturnDocument({input:chart.input,result:chart.result,notes,locale,premium:user.plan==="paid",renderer}));
    return new Response(new Uint8Array(buffer),{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="solara-${chart.year}-${locale}.pdf"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  } catch(error) { log.error("readings.pdf_failed", { ...requestMeta(request), userId: user.id, error }); return new Response("Unable to generate PDF",{status:500}); }
}
