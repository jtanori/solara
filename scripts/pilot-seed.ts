#!/usr/bin/env tsx
// pilot-seed.ts — import a pilot report into the local disposable database (#225).
//
// The next end-to-end phase (onboarding → payments → account) should not need a provider call.
// This writes the report's sections as a saved free document and/or a pinned paid edition for a
// seeded user, so the reading/PDF pages have genuine content locally. Nothing is committed.
//
// Usage: npx tsx scripts/pilot-seed.ts --report <report.json> --email <seeded@user> [--case baseline]
//                                      [--mode paid|free|both]
//
// Prereq: DATABASE_URL is loopback and the user exists (`npm run db:seed:local`).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import {
  paidReadingEditions,
  paidReadingRuns,
  readingDocuments,
  readingGenerationRuns,
  readingChartFacts,
  readings,
  users,
} from "../src/db/schema";
import { calculateSolarReturn, calculateSolarReturnChart, solarReturnFacts } from "../src/lib/solar";
import type { ChartInput } from "../src/lib/types";
import { baseFactsRow } from "../src/readings/chart-facts";
import { buildReadingDocument } from "../src/readings/document";
import { paidEvaluationSchema } from "../src/readings/evaluation";
import { calculatePaidSnapshot, paidDigest, paidSnapshotHash } from "../src/readings/paid-chart";
import { paidSections, type PaidProfile } from "../src/readings/paid-contract";
import { chartDigest } from "../src/lib/chart";
import { fixtureGuard } from "./lib/free-path-guard";
import { loadChartCorpus } from "./lib/chart-corpus";
import { reportSectionResults } from "./lib/pilot-render";

function fail(message: string, code = 1): never {
  console.error(`ERROR ${message}`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const value = (flag: string): string => {
  const index = argv.indexOf(flag);
  return index === -1 ? "" : (argv[index + 1] ?? "");
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("usage: pilot-seed --report <report.json> --email <user@example.test> [--case baseline] [--mode paid|free|both]");
  process.exit(0);
}

const reportPath = value("--report").trim();
const email = value("--email").trim().toLowerCase();
const caseId = value("--case").trim() || "baseline";
const mode = (value("--mode").trim() || "paid") as "paid" | "free" | "both";
if (!reportPath || !email) fail("--report and --email are required", 2);
if (!["paid", "free", "both"].includes(mode)) fail("--mode must be paid, free or both", 2);

const guard = fixtureGuard(process.env);
if (!guard.ok) fail(`refused: ${guard.reason}`, 2);

async function main(): Promise<void> {
  const report = paidEvaluationSchema.parse(JSON.parse(readFileSync(reportPath, "utf8")) as unknown);
  const sample = report.samples.find(row => row.caseId === caseId);
  if (!sample) fail(`report has no case ${caseId}`);
  const corpus = loadChartCorpus().find(entry => entry.id === sample.caseId);
  if (!corpus) fail(`corpus has no case ${sample.caseId}`);

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) fail(`user ${email} does not exist; run npm run db:seed:local first`);

  const result = calculateSolarReturn(corpus.input);
  const existing = await db.select().from(readings).where(eq(readings.userId, user.id));
  let chart = existing.find(row => (row.input as ChartInput).name === corpus.input.name);
  if (!chart) {
    const [saved] = await db.insert(readings).values({ userId: user.id, year: corpus.input.year ?? 2026, input: corpus.input, result }).returning();
    chart = saved;
    const facts = baseFactsRow(solarReturnFacts, corpus.input, result);
    if ("row" in facts) await db.insert(readingChartFacts).values({ readingId: saved.id, ...facts.row });
  }

  const results = reportSectionResults(report, sample);
  const outputs: { freeDocumentId?: string; paidEditionId?: string; readingId: string } = { readingId: chart.id };

  if (mode === "free" || mode === "both") {
    const freeResults = results.filter(entry => entry.key === "overview" || entry.key === "sun");
    const document = buildReadingDocument({
      readingId: chart.id,
      locale: sample.locale,
      tier: "free",
      digest: chartDigest(calculateSolarReturnChart(corpus.input).facts),
      contentVersion: "pilot-seed/1",
      results: freeResults,
    });
    await db.insert(readingDocuments).values({
      id: document.id, readingId: chart.id, locale: sample.locale,
      contentVersion: document.contentVersion, chartVersion: document.chartVersion, tier: "free", document,
    });
    await db.insert(readingGenerationRuns).values({
      userId: user.id, readingId: chart.id, documentId: document.id, locale: sample.locale,
      status: "completed", consumedAt: new Date(), contentVersion: document.contentVersion,
    });
    outputs.freeDocumentId = document.id;
  }

  if (mode === "paid" || mode === "both") {
    const profile = report.profile as PaidProfile;
    const sections = paidSections(profile);
    const snapshot = calculatePaidSnapshot(chart.id, corpus.input, profile);
    const snapshotHash = paidSnapshotHash(snapshot);
    const document = {
      ...buildReadingDocument({
        readingId: chart.id, locale: sample.locale, tier: "paid",
        digest: paidDigest(snapshot), contentVersion: report.contentVersion, results,
      }),
      generatedAt: new Date().toISOString(),
      lockedSections: [],
      edition: { profile, expectedSections: [...sections], snapshotHash },
    };
    const generated = document.sections.filter(section => section.status === "generated").length;
    const [run] = await db.insert(paidReadingRuns).values({
      userId: user.id, readingId: chart.id, intentId: randomUUID(),
      period: new Date().toISOString().slice(0, 7),
      allowancePolicy: "one-per-account-utc-month-v1", locale: sample.locale, profile,
      expectedSections: [...sections], contentVersion: document.contentVersion,
      configHash: report.configHash, settings: { models: report.models, prices: null },
      policyHash: "b".repeat(64), consentRevision: 1, consentReceiptId: randomUUID(),
      entitlementId: "sub_pilot_seed", entitlementUntil: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      controlRevision: 0, queueExpiresAt: new Date(),
      status: generated === sections.length ? "completed" : "partial",
      consumedAt: new Date(), finishedAt: new Date(), completedSections: generated,
    }).returning();
    await db.insert(paidReadingEditions).values({
      id: document.id, runId: run.id, readingId: chart.id, locale: sample.locale, profile,
      expectedSections: [...sections], contentVersion: document.contentVersion,
      chartVersion: document.chartVersion, snapshotHash, snapshot, document,
    });
    outputs.paidEditionId = document.id;
  }

  console.log(JSON.stringify({ email: user.email, ...outputs }, null, 2));
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
