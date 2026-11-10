import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid chart." }, { status: 400 });
  await db.delete(readings).where(and(eq(readings.id, id), eq(readings.userId, user.id)));
  return NextResponse.json({ ok: true });
}
