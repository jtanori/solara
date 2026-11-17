import { handleGeneration } from "@/readings/http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleGeneration(request, (await params).id);
}
