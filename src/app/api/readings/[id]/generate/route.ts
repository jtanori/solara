import { handleGeneration } from "@/readings/http";

export const maxDuration = 60;
export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleGeneration(request, (await params).id);
}
