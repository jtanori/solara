import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import type { Role } from "@/lib/types";
import { assessRoleChange, isRole } from "@/lib/role-change";

export async function PATCH(request: Request) {
  // Authorization before parsing: an anonymous caller cannot use a malformed body
  // to tell "forbidden" apart from "bad request", and no JSON is decoded for them.
  const actor = await currentUser();
  if (!actor) return NextResponse.json({ error: "Not authorized." }, { status: 403 });

  const data = await request.json().catch(() => null) as { userId?: string; role?: Role } | null;
  if (!data?.userId || !/^[0-9a-f-]{36}$/i.test(data.userId) || !isRole(data.role)) {
    return NextResponse.json({ error: "Invalid role change." }, { status: 400 });
  }

  const [target] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, data.userId)).limit(1);
  const decision = assessRoleChange({ actor: { id: actor.id, role: actor.role }, target, next: data.role });
  if (!decision.allowed) {
    const { status, error } = decision.rejection;
    const message = error === "owner_only_roles"
      ? "Only an owner can manage owner or admin roles."
      : error === "self_change"
        ? "You cannot change your own role."
        : error === "not_authorized"
          ? "Not authorized."
          : "Invalid role change.";
    return NextResponse.json({ error: message, code: error }, { status });
  }

  await db.transaction(async (tx) => {
    await tx.update(users).set({ role: data.role }).where(eq(users.id, target!.id));
    await tx.insert(auditLogs).values({ actorId: actor.id, action: decision.action, target: target!.id });
  });
  return NextResponse.json({ ok: true });
}
