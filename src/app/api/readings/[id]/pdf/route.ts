import { handleReadingPdf } from "@/readings/pdf-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 15 seconds for the isolated render; leave room for DB reads and child teardown.
export const maxDuration = 30;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleReadingPdf(request, (await params).id);
}
export async function HEAD(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleReadingPdf(request, (await params).id);
}
