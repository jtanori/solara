import { NextResponse } from "next/server";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { calculateSolarReturn } from "@/lib/solar";
import { log, requestMeta } from "@/lib/log";
import { getLocale } from "@/lib/i18n-server";
import { AUTH_RATE_LIMITS, clientIp, consumeBudgets, keyFor, rateLimitedResponse } from "@/lib/rate-limit";
import type { ChartInput, ChartResult } from "@/lib/types";

export type ChartSaveDeps = {
  user?: () => Promise<{ id: string; emailVerifiedAt: Date | null } | null>;
  locale?: "en" | "es";
  budgets?: typeof consumeBudgets;
};

/** Deterministic chart creation only, even when the AI feature is enabled. */
export async function handleChartSave(request: Request, deps: ChartSaveDeps = {}) {
  const user = await (deps.user ?? currentUser)();
  if (!user?.emailVerifiedAt) return NextResponse.json({ error: "Please sign in to save your chart." }, { status: 401 });
  const locale = deps.locale ?? await getLocale();

  // Chart saving is deterministic. AI generation has its own explicit consent/allowance boundary.
  const budget = await (deps.budgets ?? consumeBudgets)([
    { key: keyFor("readings:create:user", user.id), policy: AUTH_RATE_LIMITS.readingsCreateUser, kind: "readings_create_user" },
    { key: keyFor("readings:create:ip", clientIp(request)), policy: AUTH_RATE_LIMITS.readingsCreateIp, kind: "readings_create_ip" },
  ], requestMeta(request));
  if (!budget.allowed) {
    return rateLimitedResponse(locale, budget.retryAfterSeconds, {
      en: "You have created several charts recently. Please try again in a little while.",
      es: "Has creado varias cartas recientemente. Inténtalo de nuevo en un rato.",
    });
  }

  let raw: ChartInput;
  let result: ChartResult;
  try {
    raw = await request.json() as ChartInput;
    result = calculateSolarReturn(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Please check your birth details.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const input: ChartInput = { name: raw.name.trim(), birthDate: raw.birthDate, birthTime: raw.birthTime, birthPlace: raw.birthPlace, returnPlace: raw.returnPlace, year: raw.year, timeChoice: raw.timeChoice === "later" ? "later" : "earlier" };
  try {
    const [saved] = await db.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning({ id: readings.id });
    return NextResponse.json({ id: saved.id });
  } catch {
    log.error("readings.save_failed", { ...requestMeta(request), userId: user.id, code: "database_write_failed" });
    return NextResponse.json({ error: "Unable to save your chart. Please try again." }, { status: 500 });
  }
}
