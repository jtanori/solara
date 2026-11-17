import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../../src/db";
import { paidReadingRuns, paidReadingEditions } from "../../src/db/schema";
import { calculatePaidSnapshot, paidSnapshotHash, paidDigest } from "../../src/readings/paid-chart";
import { PAID_PROFILE, paidSections, PAID_ALLOWANCE_POLICY, type PaidProfile } from "../../src/readings/paid-contract";
import { buildReadingDocument, type SectionResult } from "../../src/readings/document";
import { syntheticReadingAccount } from "./reading-account";
import type { Locale } from "../../src/lib/i18n";

/** Rendering-only synthetic provenance. Never writes approval/control or enables a worker. */
export async function syntheticPaidEdition(owner: Awaited<ReturnType<typeof syntheticReadingAccount>>, locale: Locale, partial = false, profile: PaidProfile = PAID_PROFILE) {
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname), "render fixtures require a disposable loopback DB");
  assert.equal(owner.chart.input.name, "Synthetic Reading", "only the synthetic account helper's data is allowed");
  const snapshot = calculatePaidSnapshot(owner.chart.id, owner.chart.input, profile); const snapshotHash = paidSnapshotHash(snapshot);
  const sections = paidSections(profile);
  const results: SectionResult[] = sections.map((key, index) => partial && index > 1 ? { key, status: "failed", failureReason: "PRIVATE_SYNTHETIC_FAILURE" } : {
    key, status: "generated", fromCache: false, model: "fixture-only", usage: { inputTokens: 0, outputTokens: 0 }, costMxn: 0, latencyMs: 0,
    output: { blocks: [
      { kind: "prose", text: locale === "es" ? `${key}: ejemplo sintético de presentación, no una interpretación evaluada. ¿Qué práctica cultivarás?` : `${key}: synthetic presentation example, not an evaluated interpretation. What practice will you cultivate?` },
      { kind: "callout", title: locale === "es" ? "Pausa" : "Pause", text: locale === "es" ? "Respira y reflexiona sin promesas de predicción." : "Breathe and reflect without predictive promises." },
    ] },
  });
  const document = { ...buildReadingDocument({ readingId: owner.chart.id, locale, tier: "paid", digest: paidDigest(snapshot), contentVersion: "synthetic-paid-render-v1", results }),
    generatedAt: "2026-01-01T12:00:00.000Z", lockedSections: [], edition: { profile, expectedSections: [...sections], snapshotHash } };
  await db.transaction(async tx => {
    const [run] = await tx.insert(paidReadingRuns).values({ userId: owner.viewer.id, readingId: owner.chart.id, intentId: randomUUID(), period: "2026-01", allowancePolicy: PAID_ALLOWANCE_POLICY,
      locale, profile, expectedSections: [...sections], contentVersion: document.contentVersion, configHash: "a".repeat(64),
      settings: { models: { cheap: "fixture-only", strong: "fixture-only" }, prices: null }, policyHash: "b".repeat(64), consentRevision: 1, consentReceiptId: randomUUID(),
      entitlementId: "sub_render_fixture_only", entitlementUntil: new Date("2026-02-01"), controlRevision: 0, queueExpiresAt: new Date("2026-01-01"),
      status: partial ? "partial" : "completed", consumedAt: new Date("2026-01-01"), finishedAt: new Date(document.generatedAt), completedSections: partial ? 2 : sections.length }).returning();
    await tx.insert(paidReadingEditions).values({ id: document.id, runId: run.id, readingId: owner.chart.id, locale, profile,
      expectedSections: [...sections], contentVersion: document.contentVersion, chartVersion: document.chartVersion, snapshotHash, snapshot, document });
  });
  return { document, snapshot };
}
