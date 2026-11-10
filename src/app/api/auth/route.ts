import { after, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { hashToken, SESSION_COOKIE } from "@/lib/auth";
import { handleAuth } from "@/lib/auth-service";
import { getLocale } from "@/lib/i18n-server";
import { createMailTransport } from "@/lib/mail";

export async function POST(request: Request) {
  const outcome = await handleAuth(request, {
    locale: await getLocale(),
    mail: () => createMailTransport(),
  });
  for (const task of outcome.tasks) after(task);
  return outcome.response;
}

export async function DELETE() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
