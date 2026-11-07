import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getLocale } from "@/lib/i18n-server";
import { getReadingNotes } from "@/lib/reading-content";
import { SolarReturnDocument } from "@/components/solar-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) {
  const user=await currentUser(); if(!user) return new Response("Unauthorized",{status:401});
  const {id}=await params; if(!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found",{status:404});
  const [chart]=await db.select().from(readings).where(and(eq(readings.id,id),eq(readings.userId,user.id))).limit(1);
  if(!chart) return new Response("Not found",{status:404});
  try {
    const locale=await getLocale(); const notes=await getReadingNotes(chart.result,locale);
    const renderer=await import("@react-pdf/renderer");
    const buffer=await renderer.renderToBuffer(SolarReturnDocument({input:chart.input,result:chart.result,notes,locale,premium:user.plan==="paid",renderer}));
    return new Response(new Uint8Array(buffer),{headers:{"Content-Type":"application/pdf","Content-Disposition":`attachment; filename="solara-${chart.year}-${locale}.pdf"`,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  } catch(error) { console.error("PDF generation failed",error instanceof Error?error.message:"unknown error"); return new Response("Unable to generate PDF",{status:500}); }
}
