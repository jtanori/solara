import { NextResponse } from "next/server";
import { db } from "@/db";
import { readingChartFacts, readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { calculateSolarReturn, solarReturnFacts } from "@/lib/solar";
import { baseFactsRow, type BaseFactsRejection, type BaseFactsRow } from "@/readings/chart-facts";
import { log, requestMeta } from "@/lib/log";
import { getLocale } from "@/lib/i18n-server";
import { AUTH_RATE_LIMITS, clientIp, consumeBudgets, keyFor, rateLimitedResponse } from "@/lib/rate-limit";
import type { ChartInput, ChartResult } from "@/lib/types";

export type ChartSaveDeps = {
  user?: () => Promise<{ id: string; emailVerifiedAt: Date | null } | null>;
  locale?: "en" | "es";
  budgets?: typeof consumeBudgets;
  /**
   * How the facts row is produced. A seam for the asymmetric-failure contract: tests
   * use it to prove that facts which cannot be produced still save the chart, which no
   * real input can currently trigger because the coherence gate is measured to hold.
   */
  factsRow?: (input: ChartInput, result: ChartResult) => { row: BaseFactsRow } | { rejection: BaseFactsRejection };
};

/** The real calculation, cast for the same Whole-sign contract the summary uses. */
function defaultBaseFactsRow(input: ChartInput, result: ChartResult) {
  return baseFactsRow(solarReturnFacts, input, result);
}

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
  // #152: the complete deterministic calculation is saved with the chart, in the same
  // transaction, so the page and PDF can later draw a factual wheel from what was
  // actually computed instead of recalculating at read time. Casting it is pure and
  // happens before the transaction to keep the write short.
  //
  // The two failure directions are deliberately asymmetric. Facts that cannot be
  // produced coherently do not block the save: the chart is still worth keeping and
  // will honestly report that its full positions were not saved. A facts row that
  // cannot be written does roll the save back, because a chart that claims to have
  // facts it does not have is worse than a retryable error.
  const facts = (deps.factsRow ?? defaultBaseFactsRow)(input, result);
  try {
    const id = await db.transaction(async transaction => {
      const [saved] = await transaction.insert(readings).values({ userId: user.id, year: input.year, input, result }).returning({ id: readings.id });
      if ("row" in facts) await transaction.insert(readingChartFacts).values({ readingId: saved.id, ...facts.row });
      return saved.id;
    });
    // Logged only once the save has committed: a rolled-back chart has no facts state.
    if ("rejection" in facts) log.warn("readings.facts_unavailable", { ...requestMeta(request), userId: user.id, readingId: id, code: facts.rejection });
    return NextResponse.json({ id });
  } catch {
    log.error("readings.save_failed", { ...requestMeta(request), userId: user.id, code: "database_write_failed" });
    return NextResponse.json({ error: "Unable to save your chart. Please try again." }, { status: 500 });
  }
}
