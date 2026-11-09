import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { canManageUsers, currentUser } from "@/lib/auth";
import type { Role } from "@/lib/types";

export async function PATCH(request: Request) {
  const actor = await currentUser();
  if (!actor || !canManageUsers(actor.role)) return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  const data = await request.json().catch(() => null) as { userId?: string; role?: Role } | null;
  if (!data?.userId || !/^[0-9a-f-]{36}$/i.test(data.userId) || !data.role || !["owner", "admin", "editor", "user"].includes(data.role)) return NextResponse.json({ error: "Invalid role change." }, { status: 400 });
  const [target] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, data.userId)).limit(1);
  if (!target || target.id === actor.id) return NextResponse.json({ error: "You cannot change your own role." }, { status: 400 });
  if (actor.role === "admin" && (target.role === "owner" || target.role === "admin" || data.role === "owner" || data.role === "admin")) {
    return NextResponse.json({ error: "Only an owner can manage owner or admin roles." }, { status: 403 });
  }
  await db.transaction(async (tx) => {
    await tx.update(users).set({ role: data.role }).where(eq(users.id, target.id));
    await tx.insert(auditLogs).values({ actorId: actor.id, action: `role:${target.role}->${data.role}`, target: target.id });
  });
  return NextResponse.json({ ok: true });
}
