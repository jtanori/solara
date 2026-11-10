import { NextResponse } from "next/server";
import { db } from "@/db";
import { readings } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { calculateSolarReturn } from "@/lib/solar";
import { log, requestMeta } from "@/lib/log";
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
    return NextResponse.json({ id: saved.id });
  } catch (error) {
    log.error("readings.save_failed", { ...requestMeta(request), userId: user.id, error });
    return NextResponse.json({ error: "Unable to save your chart. Please try again." }, { status: 500 });
  }
}
