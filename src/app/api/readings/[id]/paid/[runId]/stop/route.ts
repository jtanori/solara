import { handlePaidStop } from "@/readings/paid-http";
export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  return handlePaidStop(request, id, runId);
}
