import { NextResponse } from "next/server";
import { db } from "@/db";
import { readings, readingDocuments } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { calculateSolarReturn, calculateSolarReturnChart } from "@/lib/solar";
import { chartDigest } from "@/lib/chart";
import { log, requestMeta } from "@/lib/log";
import { getLocale } from "@/lib/i18n-server";
import { generationEnabled } from "@/readings/config";
import { generateReadingDocument } from "@/readings/generate";
import { DbSectionCache } from "@/readings/db-cache";
import type { ChartInput, ChartResult } from "@/lib/types";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Please sign in to save your chart." }, { status: 401 });
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

    // Reading document generation (#103). Behind READINGS_GENERATION_ENABLED
    // (default off) and after the save, so the chart is never at risk: the
    // pipeline itself never throws, and this guard is belt-and-braces. The
    // consent gate (#105) slots in here before any flag flip.
    if (generationEnabled()) {
      try {
        const locale = await getLocale();
        const { facts } = calculateSolarReturnChart(input);
        const document = await generateReadingDocument({
          readingId: saved.id,
          locale,
          tier: "free",
          digest: chartDigest(facts),
          cache: new DbSectionCache(),
        });
        await db.insert(readingDocuments).values({
          readingId: saved.id,
          locale,
          contentVersion: document.contentVersion,
          chartVersion: document.chartVersion,
          tier: document.tier,
          document,
        }).onConflictDoNothing(); // freeze: an existing row for this key always wins
        return NextResponse.json({ id: saved.id, documentId: document.id });
      } catch (error) {
        log.error("readings.generation_failed", { ...requestMeta(request), readingId: saved.id, userId: user.id, error });
      }
    }

    return NextResponse.json({ id: saved.id });
  } catch (error) {
    log.error("readings.save_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json({ error: "Unable to save your chart. Please try again." }, { status: 500 });
  }
}
