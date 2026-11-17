import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { readings, subscriptions, readingGenerationConsents as consents, paidReadingRuns as runs,
  paidReadingAllowances as allowances, paidReadingAttempts as attempts, paidReadingCheckpoints as checkpoints,
  paidReadingSnapshots as snapshots, paidReadingEditions as editions, paidReadingControl as controls, paidReadingApprovals as approvals } from "@/db/schema";
import { withAccountLifecycleLock } from "@/lib/account-lifecycle-lock";
import type { Locale } from "@/lib/i18n";
import { GenerationBlocked, validateAttemptSettlement, type GenerationExecution } from "@/readings/execution";
import { lockOwnedReading, withGenerationTransaction, type GenerationTransaction as Tx } from "@/readings/generation-access";
import { ACTIVE_PAID_STATES, PAID_ALLOWANCE_POLICY, PAID_CEILING_MICROS, PAID_LEASE_MS, PAID_PROFILE, isPaidProfile, paidSections, type PaidProfile, PAID_QUEUE_MS, PAID_RUN_MS, type PaidOffer, type PaidRunView, type PaidStatus } from "@/readings/paid-contract";
import { paidModel, paidOfferHash, type PaidGenerationConfig } from "@/readings/paid-policy";
import { paidDigest, paidSnapshotHash, readPaidSnapshot, type PaidSnapshot } from "@/readings/paid-chart";
import { canonicalHash } from "@/readings/policy";
import { MAX_OUTPUT_TOKENS_PER_SECTION } from "@/readings/config";
import { validateSectionOutput } from "@/readings/schemas";
import { buildReadingDocument, type SectionResult } from "@/readings/document";
import { readStoredDocument } from "@/readings/stored-document";

export type PaidRun = typeof runs.$inferSelect;
type TimedRun = PaidRun & { leaseExpired: boolean; expired: boolean; queueExpired: boolean; currentPeriod: string };
type Attempt = typeof attempts.$inferSelect;
const periodSql = sql<string>`to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM')`;
const runColumns = { ...getTableColumns(runs),
  leaseExpired: sql<boolean>`${runs.leaseExpiresAt} is null or ${runs.leaseExpiresAt} <= clock_timestamp()`,
  expired: sql<boolean>`${runs.deadline} is not null and ${runs.deadline} <= clock_timestamp()`,
  queueExpired: sql<boolean>`${runs.queueExpiresAt} <= clock_timestamp()`, currentPeriod: periodSql,
};
const exposure = (ledger: Attempt[]) => ledger.reduce((sum, row) => sum + (row.costMicros ?? row.reservedMicros), 0);
const unresolved = (ledger: Attempt[]) => ledger.some(row => row.state === "reserved" || row.state === "unknown");
const active = (run: PaidRun) => ACTIVE_PAID_STATES.includes(run.status);
function consentMatches(consent: typeof consents.$inferSelect | undefined, run: Pick<PaidRun, "policyHash" | "consentRevision" | "consentReceiptId">) {
  return Boolean(consent?.grantedAt && !consent.withdrawnAt && consent.policyHash === run.policyHash && consent.revision === run.consentRevision && consent.receiptId === run.consentReceiptId);
}
function manifestMatches(run: PaidRun) {
  return isPaidProfile(run.profile) && JSON.stringify(run.expectedSections) === JSON.stringify(paidSections(run.profile)) && run.ceilingMicros === PAID_CEILING_MICROS;
}
function publicRun(run: PaidRun, editionId: string | null = null): PaidRunView {
  if (!isPaidProfile(run.profile) || !manifestMatches(run)) throw new GenerationBlocked("paid_contract_changed");
  return { id: run.id, readingId: run.readingId, locale: run.locale, profile: run.profile, period: run.period,
    status: run.status, completedSections: run.completedSections, totalSections: run.expectedSections.length,
    allowanceConsumed: Boolean(run.consumedAt), editionId: ["completed", "partial"].includes(run.status) ? editionId : null, reason: run.failureCode };
}
export type PaidIntent = { requestId: string; locale: Locale; profile: PaidProfile; period: string; offerHash: string };

/** All durable mutations are fenced by the same user/lease protocol as deletion. */
export class PaidReadingStore {
  constructor(private readonly database = db, private readonly lifecycleLock = withAccountLifecycleLock) {}
  private scope<T>(userId: string, work: (tx: Tx) => Promise<T>) { return withGenerationTransaction(userId, work, this.lifecycleLock); }
  private async consent(tx: Tx, userId: string) { return (await tx.select().from(consents).where(eq(consents.userId, userId)).for("update"))[0]; }
  private async row(tx: Tx, userId: string, runId: string) {
    const [run] = await tx.select(runColumns).from(runs).where(and(eq(runs.id, runId), eq(runs.userId, userId))).for("update");
    if (!run) throw new GenerationBlocked("not_found");
    return run;
  }
  private async control(tx: Tx) {
    const [control] = await tx.select({ ...getTableColumns(controls), alive: sql<boolean>`${controls.workerHeartbeatAt} > clock_timestamp() - interval '20 seconds'` })
      .from(controls).where(eq(controls.id, "paid")).for("share");
    if (!control) throw new GenerationBlocked("paid_unavailable");
    return control;
  }
  private async entitlement(tx: Tx, userId: string) {
    const [entitlement] = await tx.select().from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.grantsAccess, true),
      inArray(subscriptions.status, ["active", "trialing"]), sql`${subscriptions.currentPeriodEnd} > clock_timestamp()`))
      .orderBy(desc(subscriptions.currentPeriodEnd), asc(subscriptions.stripeSubscriptionId)).limit(1);
    if (!entitlement?.currentPeriodEnd) throw new GenerationBlocked("paid_entitlement_required");
    return entitlement;
  }
  private async approval(tx: Tx, config: PaidGenerationConfig, locale: Locale) {
    const [approval] = await tx.select({ id: approvals.profile }).from(approvals).where(and(eq(approvals.profile, config.editionProfile),
      eq(approvals.contentVersion, config.contentVersion), eq(approvals.configHash, config.fingerprint), eq(approvals.locale, locale), isNull(approvals.revokedAt))).for("share");
    if (!approval) throw new GenerationBlocked("paid_editorial_approval_required");
  }
  private async ledger(tx: Tx, runId: string) { return tx.select().from(attempts).where(eq(attempts.runId, runId)).orderBy(asc(attempts.createdAt), asc(attempts.id)).for("update"); }
  private async cleanup(tx: Tx, runId: string) {
    await tx.delete(checkpoints).where(eq(checkpoints.runId, runId));
    await tx.delete(snapshots).where(eq(snapshots.runId, runId));
  }
  private async terminal(tx: Tx, run: PaidRun, status: PaidStatus, code: string) {
    const ledger = await this.ledger(tx, run.id);
    // A committed permit, not receipt cost, consumes the allowance. Zero-cost
    // not_dispatched receipts therefore cannot mint a replacement allowance.
    if (!run.consumedAt && !ledger.length) await tx.delete(allowances).where(and(eq(allowances.runId, run.id), isNull(allowances.consumedAt)));
    const [saved] = await tx.update(runs).set({ status: status === "stopped" ? status : unresolved(ledger) ? "attention" : status,
      failureCode: code, finishedAt: sql`clock_timestamp()`, leaseExpiresAt: sql`clock_timestamp()` }).where(eq(runs.id, run.id)).returning();
    await this.cleanup(tx, run.id);
    return publicRun(saved);
  }

  /** Shared disablement fences every warm worker. Changing state always bumps revision. */
  async setEnabled(enabled: boolean) {
    await this.database.update(controls).set({ enabled, revision: sql`${controls.revision} + 1` }).where(eq(controls.id, "paid"));
  }
  async announceWorker(config: PaidGenerationConfig) {
    await this.database.update(controls).set({ workerHeartbeatAt: sql`clock_timestamp()`, workerConfigHash: config.fingerprint }).where(eq(controls.id, "paid"));
  }

  async existingIntent(userId: string, readingId: string, intentId: string): Promise<PaidRunView | null> {
    await this.assertOwned(userId, readingId);
    const [existing] = await this.database.select({ run: runs, editionId: editions.id }).from(runs).leftJoin(editions, eq(editions.runId, runs.id))
      .where(and(eq(runs.userId, userId), eq(runs.intentId, intentId))).limit(1);
    if (!existing) return null;
    if (existing.run.readingId !== readingId) throw new GenerationBlocked("paid_intent_conflict");
    return publicRun(existing.run, existing.editionId);
  }
  private async assertOwned(userId: string, readingId: string) {
    const [chart] = await this.database.select({ id: readings.id }).from(readings).where(and(eq(readings.id, readingId), eq(readings.userId, userId))).limit(1);
    if (!chart) throw new GenerationBlocked("not_found");
  }

  /** SELECT only: no claim, cleanup, permit, consent, calculation, or job dispatch. */
  async offer(userId: string, readingId: string, locale: Locale, config: PaidGenerationConfig | null, enabled: boolean, cursor?: string): Promise<PaidOffer> {
    await this.assertOwned(userId, readingId);
    const [clock] = await this.database.select({ period: periodSql }).from(readings).where(eq(readings.id, readingId));
    const period = clock.period;
    const [entitlement] = await this.database.select({ id: subscriptions.stripeSubscriptionId }).from(subscriptions).where(and(eq(subscriptions.userId, userId), eq(subscriptions.grantsAccess, true),
      inArray(subscriptions.status, ["active", "trialing"]), sql`${subscriptions.currentPeriodEnd} > clock_timestamp()`)).limit(1);
    const [control] = await this.database.select({ ...getTableColumns(controls), alive: sql<boolean>`${controls.workerHeartbeatAt} > clock_timestamp() - interval '20 seconds'` }).from(controls).where(eq(controls.id, "paid"));
    const [allowance] = await this.database.select().from(allowances).where(and(eq(allowances.userId, userId), eq(allowances.period, period)));
    const [blocked] = await this.database.select({ id: runs.id }).from(runs).where(and(eq(runs.userId, userId), sql`(${runs.status} = 'attention' or exists
      (select 1 from paid_reading_attempts a where a.run_id = ${runs.id} and a.state in ('reserved','unknown')))`)).limit(1);
    const [approval] = config ? await this.database.select({ id: approvals.profile }).from(approvals).where(and(eq(approvals.profile, config.editionProfile),
      eq(approvals.contentVersion, config.contentVersion), eq(approvals.configHash, config.fingerprint), eq(approvals.locale, locale), isNull(approvals.revokedAt))).limit(1) : [];
    let before: PaidRun | undefined;
    if (cursor) {
      [before] = await this.database.select().from(runs).where(and(eq(runs.id, cursor), eq(runs.userId, userId), eq(runs.readingId, readingId))).limit(1);
      if (!before) throw new GenerationBlocked("invalid_request");
    }
    const page = await this.database.select({ run: runs, editionId: editions.id }).from(runs).leftJoin(editions, and(eq(editions.runId, runs.id), eq(editions.readingId, readingId)))
      .where(and(eq(runs.userId, userId), eq(runs.readingId, readingId), before ? sql`(${runs.createdAt}, ${runs.id}) < (${before.createdAt}, ${before.id}::uuid)` : undefined))
      .orderBy(desc(runs.createdAt), desc(runs.id)).limit(21);
    const available = Boolean(enabled && config && control?.enabled && control.alive && control.workerConfigHash === config.fingerprint && approval);
    return { profile: config?.editionProfile ?? PAID_PROFILE, sections: [...paidSections(config?.editionProfile ?? PAID_PROFILE)], houseSystem: "Placidus", locale, period,
      available, entitled: Boolean(entitlement), allowance: blocked ? "attention" : allowance ? allowance.consumedAt ? "consumed" : "reserved" : "available",
      offerHash: available && config ? paidOfferHash(config, control.revision, period, locale) : null,
      runs: page.slice(0, 20).map(({ run, editionId }) => publicRun(run, editionId)), nextCursor: page.length > 20 ? page[19].run.id : null };
  }

  async accept(userId: string, readingId: string, intent: PaidIntent, config: PaidGenerationConfig, current: () => boolean): Promise<PaidRunView> {
    return this.scope(userId, async tx => {
      await lockOwnedReading(tx, userId, readingId);
      const consent = await this.consent(tx, userId);
      const [previous] = await tx.select().from(runs).where(and(eq(runs.userId, userId), eq(runs.intentId, intent.requestId))).for("update");
      if (previous) {
        if (previous.readingId !== readingId) throw new GenerationBlocked("paid_intent_conflict");
        const [edition] = await tx.select({ id: editions.id }).from(editions).where(eq(editions.runId, previous.id));
        return publicRun(previous, edition?.id);
      }
      const control = await this.control(tx);
      if (!current() || !control.enabled || !control.alive || control.workerConfigHash !== config.fingerprint) throw new GenerationBlocked("paid_unavailable");
      await this.approval(tx, config, intent.locale);
      const entitlement = await this.entitlement(tx, userId);
      const [clock] = await tx.select({ period: periodSql }).from(readings).where(eq(readings.id, readingId));
      if (intent.profile !== config.editionProfile || intent.period !== clock.period || intent.offerHash !== paidOfferHash(config, control.revision, clock.period, intent.locale)) throw new GenerationBlocked("paid_offer_changed");
      if (!consent?.grantedAt || consent.withdrawnAt || consent.policyHash !== config.profile.policyHash) throw new GenerationBlocked("consent_required");
      const [blocked] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.userId, userId), sql`(${runs.status} in ('queued','preparing','generating','attention') or exists
        (select 1 from paid_reading_attempts a where a.run_id = ${runs.id} and a.state in ('reserved','unknown')))`)).limit(1);
      if (blocked) throw new GenerationBlocked("paid_run_blocked");
      const [used] = await tx.select().from(allowances).where(and(eq(allowances.userId, userId), eq(allowances.period, clock.period))).for("update");
      if (used) throw new GenerationBlocked("paid_allowance_used");
      const [run] = await tx.insert(runs).values({ userId, readingId, intentId: intent.requestId, period: clock.period, allowancePolicy: PAID_ALLOWANCE_POLICY,
        locale: intent.locale, profile: config.editionProfile, expectedSections: [...config.sections], settings: config.settings, contentVersion: config.contentVersion, configHash: config.fingerprint,
        policyHash: config.profile.policyHash, consentRevision: consent.revision, consentReceiptId: consent.receiptId,
        entitlementId: entitlement.stripeSubscriptionId, entitlementUntil: entitlement.currentPeriodEnd!, controlRevision: control.revision,
        queueExpiresAt: sql`clock_timestamp() + ${PAID_QUEUE_MS} * interval '1 millisecond'` }).returning();
      await tx.insert(allowances).values({ userId, period: clock.period, runId: run.id });
      return publicRun(run);
    });
  }

  /** Bounded maintenance also runs while generation is disabled. GETs never reap. */
  async reapExpired() {
    const candidates = await this.database.select({ id: runs.id, userId: runs.userId }).from(runs).where(and(inArray(runs.status, ACTIVE_PAID_STATES),
      sql`((${runs.deadline} is not null and ${runs.deadline} <= clock_timestamp()) or (${runs.deadline} is null and ${runs.queueExpiresAt} <= clock_timestamp()) or ${runs.readingId} is null)`))
      .orderBy(asc(runs.createdAt), asc(runs.id)).limit(20);
    for (const candidate of candidates) await this.scope(candidate.userId, async tx => {
      const run = await this.row(tx, candidate.userId, candidate.id);
      if (active(run) && (run.expired || (!run.deadline && run.queueExpired) || !run.readingId)) await this.terminal(tx, run, "failed", run.readingId ? "paid_deadline" : "not_found");
    });
  }

  /** Only a trusted worker calls this. A lease timeout never replays an uncertain attempt. */
  async claimNext(config: PaidGenerationConfig, current: () => boolean): Promise<PaidRun | null> {
    const candidates = await this.database.select({ id: runs.id, userId: runs.userId, readingId: runs.readingId }).from(runs)
      .where(and(inArray(runs.status, ACTIVE_PAID_STATES), sql`(${runs.owner} is null or ${runs.leaseExpiresAt} <= clock_timestamp())`))
      .orderBy(asc(runs.createdAt), asc(runs.id)).limit(20);
    for (const candidate of candidates) {
      const claimed = await this.scope(candidate.userId, async tx => {
        const chart = candidate.readingId ? (await tx.select({ id: readings.id }).from(readings).where(and(eq(readings.id, candidate.readingId), eq(readings.userId, candidate.userId))).for("update"))[0] : null;
        const consent = await this.consent(tx, candidate.userId);
        const control = await this.control(tx);
        const run = await this.row(tx, candidate.userId, candidate.id);
        if (!active(run) || (run.owner && !run.leaseExpired)) return null;
        const ledger = await this.ledger(tx, run.id);
        if (unresolved(ledger)) { await this.terminal(tx, run, "attention", "paid_uncertain_attempt"); return null; }
        let blocked: string | null = !chart || !run.readingId ? "not_found"
          : !manifestMatches(run) || run.profile !== config.editionProfile ? "paid_contract_changed"
            : run.expired || (!run.deadline && run.queueExpired) ? "paid_deadline"
              : !run.consumedAt && run.period !== run.currentPeriod ? "paid_period_changed"
                : !consentMatches(consent, run) ? "consent_required"
                  : !current() || !control.enabled || control.revision !== run.controlRevision || config.fingerprint !== run.configHash || config.contentVersion !== run.contentVersion ? "paid_disabled" : null;
        if (!blocked) {
          try { await this.entitlement(tx, run.userId); await this.approval(tx, config, run.locale); }
          catch (error) {
            if (!(error instanceof GenerationBlocked)) throw error;
            // A recovered consumed run may finalize its recorded sections after
            // expiry; preparation/permit fences still forbid further paid work.
            if (!(error.code === "paid_entitlement_required" && run.consumedAt)) blocked = error.code;
          }
        }
        if (blocked) { await this.terminal(tx, run, "failed", blocked); return null; }
        const [saved] = await tx.update(runs).set({ status: run.consumedAt ? "generating" : "preparing", owner: randomUUID(),
          leaseExpiresAt: sql`clock_timestamp() + ${PAID_LEASE_MS} * interval '1 millisecond'`, deadline: sql`coalesce(${runs.deadline}, clock_timestamp() + ${PAID_RUN_MS} * interval '1 millisecond')` })
          .where(eq(runs.id, run.id)).returning();
        return saved;
      });
      if (claimed) return claimed;
    }
    return null;
  }

  private async authorized(tx: Tx, run: PaidRun, config: PaidGenerationConfig, current: () => boolean, dispatch = true) {
    if (!run.readingId) throw new GenerationBlocked("not_found");
    const chart = await lockOwnedReading(tx, run.userId, run.readingId);
    const consent = await this.consent(tx, run.userId);
    const control = await this.control(tx);
    const saved = await this.row(tx, run.userId, run.id);
    if (!run.owner || saved.owner !== run.owner) throw new GenerationBlocked("paid_owner_lost");
    if (!active(saved) || saved.stopRequestedAt) throw new GenerationBlocked("paid_stopped");
    if (saved.leaseExpired || saved.expired) throw new GenerationBlocked("paid_deadline");
    if (!manifestMatches(saved) || saved.profile !== config.editionProfile || canonicalHash(saved.settings) !== canonicalHash(config.settings)) throw new GenerationBlocked("paid_contract_changed");
    if (!consentMatches(consent, saved)) throw new GenerationBlocked("consent_required");
    if (!current() || !control.enabled || control.revision !== saved.controlRevision || saved.configHash !== config.fingerprint || saved.contentVersion !== config.contentVersion) throw new GenerationBlocked("paid_disabled");
    await this.approval(tx, config, saved.locale);
    if (dispatch) {
      if (!saved.consumedAt && saved.period !== saved.currentPeriod) throw new GenerationBlocked("paid_period_changed");
      await this.entitlement(tx, run.userId);
    }
    return { run: saved, chart };
  }

  async preparation(run: PaidRun, config: PaidGenerationConfig, current: () => boolean) {
    return this.scope(run.userId, async tx => {
      const { chart } = await this.authorized(tx, run, config, current);
      const [saved] = await tx.select().from(snapshots).where(eq(snapshots.runId, run.id));
      return { input: chart.input, snapshot: saved ? this.validSnapshot(saved, run) : null };
    });
  }
  private validSnapshot(saved: typeof snapshots.$inferSelect, run: PaidRun) {
    const snapshot = readPaidSnapshot(saved.snapshot);
    if (snapshot.profile !== run.profile || snapshot.chart.id !== run.readingId || saved.readingId !== run.readingId || saved.hash !== paidSnapshotHash(snapshot)) throw new GenerationBlocked("snapshot_invalid");
    return snapshot;
  }
  async saveSnapshot(run: PaidRun, snapshot: PaidSnapshot, config: PaidGenerationConfig, current: () => boolean) {
    return this.scope(run.userId, async tx => {
      await this.authorized(tx, run, config, current);
      const checked = readPaidSnapshot(snapshot);
      if (checked.profile !== run.profile || checked.chart.id !== run.readingId) throw new GenerationBlocked("snapshot_invalid");
      const saved = { runId: run.id, readingId: run.readingId!, hash: paidSnapshotHash(checked), snapshot: checked };
      await tx.insert(snapshots).values(saved).onConflictDoNothing();
      const [frozen] = await tx.select().from(snapshots).where(eq(snapshots.runId, run.id));
      if (frozen.hash !== saved.hash) throw new GenerationBlocked("snapshot_conflict");
      return this.validSnapshot(frozen, run);
    });
  }
  async heartbeat(run: PaidRun, config: PaidGenerationConfig, current: () => boolean) {
    await this.scope(run.userId, async tx => {
      await this.authorized(tx, run, config, current);
      await tx.update(runs).set({ leaseExpiresAt: sql`clock_timestamp() + ${PAID_LEASE_MS} * interval '1 millisecond'` }).where(eq(runs.id, run.id));
    });
  }
  async outcomes(run: PaidRun) {
    return this.database.select({ attempt: attempts, checkpoint: checkpoints }).from(attempts)
      .leftJoin(checkpoints, eq(checkpoints.attemptId, attempts.id)).where(eq(attempts.runId, run.id));
  }

  execution(run: PaidRun, config: PaidGenerationConfig, signal: AbortSignal, current: () => boolean): GenerationExecution {
    const admitsModel = (requested: string, reported: string) => Object.hasOwn(config.profile.servedModels, requested) && config.profile.servedModels[requested].includes(reported);
    return { kind: "durable", settings: run.settings, ceilingMicros: run.ceilingMicros, signal, admitsModel,
      admit: permit => this.scope(run.userId, async tx => {
        const { run: saved } = await this.authorized(tx, run, config, current);
        if (signal.aborted) throw new GenerationBlocked("paid_stopped");
        if (!saved.expectedSections.includes(permit.section) || permit.model !== paidModel(config, permit.section) || permit.reservedMicros !== config.quotes[permit.model]) throw new GenerationBlocked("paid_permit_invalid");
        const [snapshot] = await tx.select().from(snapshots).where(eq(snapshots.runId, run.id));
        if (!snapshot) throw new GenerationBlocked("snapshot_invalid");
        this.validSnapshot(snapshot, saved);
        const ledger = await this.ledger(tx, run.id);
        if (unresolved(ledger) || ledger.length >= saved.expectedSections.length * 2) throw new GenerationBlocked("paid_uncertain_attempt");
        if (ledger.some(row => row.section === permit.section && row.phase === permit.phase)) throw new GenerationBlocked("attempt_already_admitted");
        if (permit.phase === "repair") {
          const primary = ledger.find(row => row.section === permit.section && row.phase === "primary" && row.state === "measured");
          const [checkpoint] = primary ? await tx.select().from(checkpoints).where(eq(checkpoints.attemptId, primary.id)) : [];
          if (checkpoint?.kind !== "invalid") throw new GenerationBlocked("paid_repair_not_authorized");
        }
        if (exposure(ledger) + permit.reservedMicros > saved.ceilingMicros) throw new GenerationBlocked("cost_ceiling");
        const [allowance] = await tx.update(allowances).set({ consumedAt: sql`coalesce(${allowances.consumedAt}, clock_timestamp())` })
          .where(and(eq(allowances.userId, run.userId), eq(allowances.period, saved.period), eq(allowances.runId, run.id))).returning();
        if (!allowance) throw new GenerationBlocked("paid_allowance_missing");
        const [attempt] = await tx.insert(attempts).values({ runId: run.id, owner: run.owner!, section: permit.section, phase: permit.phase, requestedModel: permit.model, reservedMicros: permit.reservedMicros }).returning();
        await tx.update(runs).set({ consumedAt: sql`coalesce(${runs.consumedAt}, clock_timestamp())`, status: "generating" }).where(eq(runs.id, run.id));
        return attempt.id;
      }),
      assertPermit: id => this.scope(run.userId, async tx => {
        await this.authorized(tx, run, config, current);
        if (signal.aborted) throw new GenerationBlocked("paid_stopped");
        const [attempt] = await tx.select().from(attempts).where(and(eq(attempts.id, id), eq(attempts.runId, run.id), eq(attempts.owner, run.owner!))).for("update");
        if (attempt?.state !== "reserved") throw new GenerationBlocked("permit_missing");
      }),
      settle: (id, receipt) => this.scope(run.userId, async tx => {
        // Late receipts are financial records, not authority to resume/publish.
        const consent = await this.consent(tx, run.userId);
        const saved = await this.row(tx, run.userId, run.id);
        const ledger = await this.ledger(tx, run.id);
        const attempt = ledger.find(row => row.id === id && row.owner === run.owner);
        if (!attempt) throw new GenerationBlocked("permit_missing");
        if (attempt.state !== "reserved") return exposure(ledger);
        if (saved.configHash !== config.fingerprint || canonicalHash(saved.settings) !== canonicalHash(config.settings)) throw new GenerationBlocked("accounting_invalid");
        validateAttemptSettlement(receipt, attempt.reservedMicros, saved.settings, attempt.requestedModel, admitsModel);
        const total = exposure(ledger.filter(row => row.id !== id)) + receipt.costMicros;
        await tx.update(attempts).set({ state: receipt.basis, costMicros: receipt.costMicros, reportedModel: receipt.model, usage: receipt.usage,
          latencyMs: Math.min(receipt.latencyMs, 2_147_483_647), code: receipt.code, settledAt: sql`clock_timestamp()` }).where(eq(attempts.id, id));
        const bounded = receipt.usage && receipt.usage.inputTokens <= config.profile.inputTokenLimits[attempt.requestedModel] && receipt.usage.outputTokens <= MAX_OUTPUT_TOKENS_PER_SECTION;
        if (receipt.outcome && receipt.basis === "measured" && receipt.code === "measured" && bounded && total <= saved.ceilingMicros &&
          active(saved) && !saved.stopRequestedAt && saved.owner === run.owner && saved.readingId && consentMatches(consent, saved)) {
          const checked = receipt.outcome.kind === "valid" ? validateSectionOutput(attempt.section, receipt.outcome.output, "paid") : null;
          if (receipt.outcome.kind === "valid" && !checked?.ok) throw new GenerationBlocked("checkpoint_invalid");
          await tx.insert(checkpoints).values({ attemptId: id, runId: run.id, readingId: saved.readingId, kind: receipt.outcome.kind, output: checked?.ok ? checked.value : null });
          if (checked?.ok) await tx.update(runs).set({ completedSections: sql`${runs.completedSections} + 1` }).where(eq(runs.id, run.id));
        }
        if (receipt.basis === "unknown" || total > saved.ceilingMicros || (receipt.basis === "measured" && !bounded)) {
          if (active(saved)) await this.terminal(tx, saved, "attention", receipt.basis === "unknown" ? "paid_uncertain_attempt" : "paid_cost_bound_exceeded");
        }
        return total;
      }),
    };
  }

  async finish(run: PaidRun, config: PaidGenerationConfig, current: () => boolean): Promise<PaidRunView> {
    return this.scope(run.userId, async tx => {
      // Idempotent publication readback; no second insert and no new authority.
      const [previous] = await tx.select().from(runs).where(and(eq(runs.id, run.id), eq(runs.userId, run.userId)));
      if (previous && !active(previous)) {
        const [edition] = await tx.select({ id: editions.id }).from(editions).where(eq(editions.runId, previous.id));
        return publicRun(previous, edition?.id);
      }
      // Finalization does not require continued subscription access: all provider
      // work was authorized while entitled. Consent/ownership/control still apply.
      const { run: saved } = await this.authorized(tx, run, config, current, false);
      const ledger = await this.ledger(tx, run.id);
      if (unresolved(ledger)) return this.terminal(tx, saved, "attention", "paid_uncertain_attempt");
      if (exposure(ledger) > saved.ceilingMicros) return this.terminal(tx, saved, "attention", "paid_cost_bound_exceeded");
      const [frozen] = await tx.select().from(snapshots).where(eq(snapshots.runId, run.id));
      if (!frozen || !saved.consumedAt) return this.terminal(tx, saved, "failed", "paid_no_output");
      const snapshot = this.validSnapshot(frozen, saved);
      const outputs = await tx.select().from(checkpoints).where(eq(checkpoints.runId, run.id));
      const results: SectionResult[] = saved.expectedSections.map(key => {
        const sectionLedger = ledger.filter(row => row.section === key);
        const costMxn = exposure(sectionLedger) / 1_000_000;
        const good = sectionLedger.map(attempt => ({ attempt, checkpoint: outputs.find(output => output.attemptId === attempt.id && output.kind === "valid") })).find(row => row.checkpoint);
        if (!good?.checkpoint?.output || !good.attempt.reportedModel) return { key, status: "failed", costMxn, failureReason: "paid_section_unavailable" };
        const checked = validateSectionOutput(key, good.checkpoint.output, "paid");
        if (!checked.ok || good.attempt.state !== "measured") throw new GenerationBlocked("checkpoint_invalid");
        return { key, status: "generated", fromCache: false, output: checked.value, model: good.attempt.reportedModel, costMxn,
          usage: sectionLedger.reduce((sum, row) => ({ inputTokens: sum.inputTokens + (row.usage?.inputTokens ?? 0), outputTokens: sum.outputTokens + (row.usage?.outputTokens ?? 0) }), { inputTokens: 0, outputTokens: 0 }),
          latencyMs: sectionLedger.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0) };
      });
      if (!results.some(result => result.status === "generated")) return this.terminal(tx, saved, "failed", "paid_no_output");
      const document = { ...buildReadingDocument({ readingId: saved.readingId!, documentId: randomUUID(), locale: saved.locale, tier: "paid", digest: paidDigest(snapshot), contentVersion: saved.contentVersion, results }),
        lockedSections: [], edition: { profile: saved.profile, expectedSections: saved.expectedSections, snapshotHash: frozen.hash },
        accounting: { measuredMxn: exposure(ledger) / 1_000_000, uncertainMxn: 0, settled: true, halt: null } };
      const decoded = readStoredDocument(JSON.stringify(document), document, { allowPaid: true, expectedSections: saved.expectedSections });
      if (!decoded.ok) return this.terminal(tx, saved, "failed", "paid_document_invalid");
      await tx.insert(editions).values({ id: document.id, runId: run.id, readingId: saved.readingId!, locale: saved.locale, profile: saved.profile, expectedSections: saved.expectedSections,
        contentVersion: saved.contentVersion, chartVersion: document.chartVersion, snapshotHash: frozen.hash, snapshot, document });
      const [published] = await tx.update(runs).set({ status: decoded.value.partial ? "partial" : "completed", completedSections: results.filter(row => row.status === "generated").length,
        finishedAt: sql`clock_timestamp()`, failureCode: decoded.value.partial ? "paid_partial" : null, leaseExpiresAt: sql`clock_timestamp()` }).where(eq(runs.id, run.id)).returning();
      await this.cleanup(tx, run.id);
      return publicRun(published, document.id);
    });
  }
  async fail(run: PaidRun, code: string) {
    return this.scope(run.userId, async tx => {
      const saved = await this.row(tx, run.userId, run.id);
      if (!active(saved) || saved.owner !== run.owner) return publicRun(saved);
      return this.terminal(tx, saved, "failed", code);
    });
  }
  async stop(userId: string, readingId: string, runId: string) {
    return this.scope(userId, async tx => {
      await lockOwnedReading(tx, userId, readingId);
      const saved = await this.row(tx, userId, runId);
      if (saved.readingId !== readingId) throw new GenerationBlocked("not_found");
      if (!active(saved)) {
        const [edition] = await tx.select({ id: editions.id }).from(editions).where(eq(editions.runId, saved.id));
        return publicRun(saved, edition?.id);
      }
      await tx.update(runs).set({ stopRequestedAt: sql`clock_timestamp()` }).where(eq(runs.id, saved.id));
      return this.terminal(tx, saved, "stopped", "paid_user_stopped");
    });
  }
}
