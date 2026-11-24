import { handleReadingDelete } from "@/readings/http";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleReadingDelete(request, (await params).id);
}
