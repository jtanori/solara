import { handlePaidReading } from "@/readings/paid-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handlePaidReading(request, (await params).id);
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handlePaidReading(request, (await params).id);
}
