import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, readings, readingDocuments, auditLogs, readingGenerationConsents as consents, readingGenerationRuns as runs, readingGenerationAttempts as attempts } from "@/db/schema";
import { withAccountLifecycleLock, type LifecycleDb } from "@/lib/account-lifecycle-lock";
import { costMicros, GenerationBlocked, type GenerationExecution, type AttemptSettlement } from "@/readings/execution";
import { GENERATION_RUN_MS, type LiveGenerationConfig, type ProcessorProfile } from "@/readings/policy";
import { MAX_OUTPUT_TOKENS_PER_SECTION } from "@/readings/config";
import { persistableDocument } from "@/readings/document";
import { validUsage } from "@/readings/provider";
import type { ReadingDocument } from "@/readings/types";
import type { Locale } from "@/lib/i18n";

type Tx = Parameters<Parameters<LifecycleDb["transaction"]>[0]>[0];
type Run = typeof runs.$inferSelect;
type TimedRun = Run & { expired: boolean; dispatchExpired: boolean };
export type GenerationView = {
  status: "unused" | "in_progress" | "completed" | "partial" | "failed" | "indeterminate" | "free_reading_deleted";
  readingId: string | null;
  documentId: string | null;
  locale: Locale | null;
};
const runColumns = {
  ...getTableColumns(runs),
  expired: sql<boolean>`${runs.deadline} is null or ${runs.deadline} <= clock_timestamp()`,
  dispatchExpired: sql<boolean>`${runs.deadline} is null or ${runs.deadline} - interval '5 seconds' <= clock_timestamp()`,
};
function view(run?: TimedRun): GenerationView {
  if (!run) return { status: "unused", readingId: null, documentId: null, locale: null };
  const status = run.consumedAt && !run.readingId ? "free_reading_deleted"
    : run.documentId ? run.status === "partial" ? "partial" : "completed"
      : run.status === "reserved" ? run.expired || !run.owner ? "unused" : "in_progress"
        : run.status === "running" ? run.expired ? "indeterminate" : "in_progress"
          : run.status === "indeterminate" ? "indeterminate" : "failed";
  return { status, readingId: run.readingId, documentId: run.documentId, locale: run.locale };
}
function active(consent: typeof consents.$inferSelect | undefined, policy: string, revision?: number) {
  return consent?.grantedAt && !consent.withdrawnAt && consent.policyHash === policy && (revision === undefined || consent.revision === revision);
}
const exposure = (rows: (typeof attempts.$inferSelect)[]) => rows.reduce((sum, row) => sum + (row.costMicros ?? row.reservedMicros), 0);

export class GenerationStore {
  constructor(private readonly database = db, private readonly lifecycleLock = withAccountLifecycleLock) {}

  private async user(tx: Tx, userId: string) {
    const [user] = await tx.select({ id: users.id, verified: users.emailVerifiedAt }).from(users).where(eq(users.id, userId)).for("update");
    if (!user?.verified) throw new GenerationBlocked("unauthorized");
  }
  /** Lease → user → reading → consent → run → attempts. Never call HTTP inside. */
  private async scope<T>(userId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.lifecycleLock(userId, async (database, lease) => {
      await lease.stopHeartbeat();
      return database.transaction(async tx => {
        await tx.execute(sql`select set_config('lock_timeout', '2s', true), set_config('statement_timeout', '5s', true)`);
        await lease.assertHeld(tx);
        await this.user(tx, userId);
        return work(tx);
      });
    });
  }
  private async owned(tx: Tx, userId: string, readingId: string) {
    const [reading] = await tx.select().from(readings).where(and(eq(readings.id, readingId), eq(readings.userId, userId))).for("update");
    if (!reading) throw new GenerationBlocked("not_found");
    return reading;
  }
  private async consentRow(tx: Tx, userId: string) {
    return (await tx.select().from(consents).where(eq(consents.userId, userId)).for("update"))[0];
  }
  private async runRow(tx: Tx, userId: string) {
    return (await tx.select(runColumns).from(runs).where(eq(runs.userId, userId)).for("update"))[0];
  }

  async consent(userId: string) {
    return (await this.database.select().from(consents).where(eq(consents.userId, userId)).limit(1))[0] ?? null;
  }
  async grant(userId: string, profile: ProcessorProfile, expectedRevision: number, locale: Locale) {
    return this.database.transaction(async tx => {
      await tx.execute(sql`select set_config('lock_timeout', '2s', true), set_config('statement_timeout', '5s', true)`);
      await this.user(tx, userId);
      const previous = await this.consentRow(tx, userId);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new GenerationBlocked("consent_changed");
      const values = {
        userId, receiptId: randomUUID(), revision: expectedRevision + 1, processorId: profile.id,
        policyVersion: profile.policyVersion, policyHash: profile.policyHash, locale, grantedAt: sql`clock_timestamp()`, withdrawnAt: null,
      };
      const [saved] = await tx.insert(consents).values(values).onConflictDoUpdate({ target: consents.userId, set: values }).returning();
      await tx.insert(auditLogs).values({ actorId: userId, action: "readings:consent_grant", target: `${saved.receiptId}:${profile.id}:${profile.policyVersion}` });
      return saved;
    });
  }
  async withdraw(userId: string, locale: Locale) {
    return this.database.transaction(async tx => {
      await tx.execute(sql`select set_config('lock_timeout', '2s', true), set_config('statement_timeout', '5s', true)`);
      await this.user(tx, userId);
      const previous = await this.consentRow(tx, userId);
      if (previous?.withdrawnAt) return previous;
      const values = { userId, receiptId: previous?.receiptId ?? randomUUID(), revision: (previous?.revision ?? 0) + 1, locale, withdrawnAt: sql`clock_timestamp()` };
      const [saved] = await tx.insert(consents).values(values).onConflictDoUpdate({ target: consents.userId, set: values }).returning();
      await tx.insert(auditLogs).values({ actorId: userId, action: "readings:consent_withdraw", target: saved.receiptId });
      return saved;
    });
  }

  async status(userId: string, readingId: string): Promise<GenerationView> {
    // Check the supplied reading before revealing even this account's canonical run.
    const [owned] = await this.database.select({ id: readings.id }).from(readings).where(and(eq(readings.id, readingId), eq(readings.userId, userId))).limit(1);
    if (!owned) throw new GenerationBlocked("not_found");
    const [run] = await this.database.select(runColumns).from(runs).where(eq(runs.userId, userId)).limit(1);
    return view(run);
  }

  async claim(userId: string, readingId: string, locale: Locale, config: LiveGenerationConfig, contentVersion: string) {
    return this.scope(userId, async tx => {
      const chart = await this.owned(tx, userId, readingId);
      const consent = await this.consentRow(tx, userId);
      const previous = await this.runRow(tx, userId);
      if (previous && (previous.consumedAt || (!previous.expired && previous.owner) || (previous.readingId && previous.readingId !== readingId))) {
        return { kind: "existing" as const, view: view(previous) };
      }
      if (!active(consent, config.profile.policyHash)) throw new GenerationBlocked("consent_required");
      if (previous) {
        const markers = await tx.select({ id: attempts.id }).from(attempts).where(eq(attempts.runId, previous.id)).limit(1);
        if (markers.length) throw new GenerationBlocked("generation_indeterminate");
      }
      const values = {
        userId, readingId, locale: previous?.locale ?? locale, status: "reserved" as const,
        owner: randomUUID(), deadline: sql`clock_timestamp() + ${GENERATION_RUN_MS} * interval '1 millisecond'`,
        consentRevision: consent!.revision, policyHash: config.profile.policyHash, configHash: config.fingerprint,
        contentVersion, settings: config.settings, failureCode: null,
      };
      const [run] = previous
        ? await tx.update(runs).set(values).where(and(eq(runs.id, previous.id), sql`${runs.consumedAt} is null`)).returning()
        : await tx.insert(runs).values(values).returning();
      if (!run) throw new GenerationBlocked("generation_unavailable");
      return { kind: "claimed" as const, run, input: chart.input };
    });
  }

  execution(run: Run, config: LiveGenerationConfig, signal: AbortSignal, configurationCurrent: () => boolean): GenerationExecution {
    if (!run.owner || !run.readingId || !run.settings) throw new GenerationBlocked("generation_unavailable");
    const owner = run.owner;
    const readingId = run.readingId;
    const assertOwner = (current: TimedRun | undefined) => {
      if (!current || current.id !== run.id || current.owner !== owner) throw new GenerationBlocked("generation_owner_lost");
      return current;
    };
    const authorized = async (tx: Tx) => {
      await this.owned(tx, run.userId, readingId);
      const consent = await this.consentRow(tx, run.userId);
      const current = assertOwner(await this.runRow(tx, run.userId));
      if (current.dispatchExpired || signal.aborted) throw new GenerationBlocked("generation_deadline");
      if (!configurationCurrent() || current.configHash !== config.fingerprint) throw new GenerationBlocked("generation_disabled");
      if (!active(consent, config.profile.policyHash, run.consentRevision ?? -1)) throw new GenerationBlocked("consent_required");
      if (!["reserved", "running"].includes(current.status)) throw new GenerationBlocked("generation_indeterminate");
      return current;
    };
    const admitsModel = (requested: string, reported: string) =>
      Object.hasOwn(config.profile.servedModels, requested) && config.profile.servedModels[requested].includes(reported);
    return {
      kind: "durable", settings: run.settings, ceilingMicros: run.ceilingMicros, signal,
      admitsModel,
      admit: permit => this.scope(run.userId, async tx => {
        const current = await authorized(tx);
        if (!["overview", "sun"].includes(permit.section) || permit.model !== current.settings?.models.cheap) throw new GenerationBlocked("generation_unauthorized");
        const expected = costMicros(current.settings.prices, permit.model, { inputTokens: config.profile.inputTokenLimits[permit.model], outputTokens: MAX_OUTPUT_TOKENS_PER_SECTION });
        if (expected === null || permit.reservedMicros !== expected) throw new GenerationBlocked("pricing_unavailable");
        const ledger = await tx.select().from(attempts).where(eq(attempts.runId, run.id)).for("update");
        if (ledger.some(row => row.state === "reserved" || row.state === "unknown") || ledger.length >= 4) throw new GenerationBlocked("generation_indeterminate");
        if (exposure(ledger) + permit.reservedMicros > current.ceilingMicros) throw new GenerationBlocked("cost_ceiling");
        if (ledger.some(row => row.section === permit.section && row.phase === permit.phase)) throw new GenerationBlocked("attempt_already_admitted");
        const [saved] = await tx.insert(attempts).values({
          runId: run.id, owner, section: permit.section as "overview" | "sun", phase: permit.phase,
          requestedModel: permit.model, reservedMicros: permit.reservedMicros,
        }).returning({ id: attempts.id });
        await tx.update(runs).set({ status: "running", consumedAt: sql`coalesce(${runs.consumedAt}, clock_timestamp())` }).where(and(eq(runs.id, run.id), eq(runs.owner, owner)));
        return saved.id;
      }),
      assertPermit: id => this.scope(run.userId, async tx => {
        await authorized(tx);
        const [row] = await tx.select().from(attempts).where(and(eq(attempts.id, id), eq(attempts.runId, run.id), eq(attempts.owner, owner))).for("update");
        if (row?.state !== "reserved") throw new GenerationBlocked("permit_missing");
      }),
      settle: (id, result) => this.scope(run.userId, async tx => {
        // A receipt can settle after withdrawal/deadline/individual deletion.
        // It cannot grant another permit, publish prose, or recreate a deleted account.
        const current = assertOwner(await this.runRow(tx, run.userId));
        const ledger = await tx.select().from(attempts).where(eq(attempts.runId, run.id)).for("update");
        const row = ledger.find(row => row.id === id && row.owner === owner);
        if (!row) throw new GenerationBlocked("permit_missing");
        if (row.state !== "reserved") return exposure(ledger);
        this.validateSettlement(result, row.reservedMicros, current, row.requestedModel, admitsModel);
        const [saved] = await tx.update(attempts).set({
          state: result.basis, costMicros: result.costMicros, usage: result.usage, reportedModel: result.model,
          latencyMs: Math.min(result.latencyMs, 2_147_483_647), code: result.code, settledAt: sql`clock_timestamp()`,
        }).where(and(eq(attempts.id, id), eq(attempts.owner, owner), eq(attempts.state, "reserved"))).returning();
        if (!saved) throw new GenerationBlocked("generation_owner_lost");
        return exposure(ledger.filter(item => item.id !== id)) + saved.costMicros!;
      }),
    };
  }

  private validateSettlement(
    result: AttemptSettlement,
    reserved: number,
    run: Run,
    requestedModel: string,
    admitsModel: GenerationExecution["admitsModel"],
  ) {
    if (!Number.isSafeInteger(result.costMicros) || result.costMicros < 0 || !Number.isSafeInteger(result.latencyMs) || result.latencyMs < 0) throw new GenerationBlocked("accounting_invalid");
    if (result.basis === "unknown" && (result.costMicros !== reserved || result.model || result.usage)) throw new GenerationBlocked("accounting_invalid");
    if (result.basis === "not_dispatched" && (result.costMicros !== 0 || result.model || result.usage)) throw new GenerationBlocked("accounting_invalid");
    // Pricing alone is insufficient: the receipt must belong to this permit's
    // requested-model contract, even when a caller bypasses dispatchAttempt.
    if (result.basis === "measured" && (!run.settings || !result.model || !admitsModel(requestedModel, result.model) || !validUsage(result.usage) || costMicros(run.settings.prices, result.model, result.usage) !== result.costMicros)) throw new GenerationBlocked("accounting_invalid");
  }

  async finish(run: Run, document: ReadingDocument | null, configurationCurrent: () => boolean): Promise<GenerationView> {
    return this.scope(run.userId, async tx => {
      if (run.readingId) await tx.select({ id: readings.id }).from(readings).where(and(eq(readings.id, run.readingId), eq(readings.userId, run.userId))).for("update");
      const consent = await this.consentRow(tx, run.userId);
      const current = await this.runRow(tx, run.userId);
      if (!current || current.id !== run.id || current.owner !== run.owner) throw new GenerationBlocked("generation_owner_lost");
      if (!["reserved", "running"].includes(current.status)) return view(current);
      const ledger = await tx.select().from(attempts).where(eq(attempts.runId, run.id)).for("update");
      const measured = ledger.filter(row => row.state === "measured").reduce((sum, row) => sum + row.costMicros!, 0);
      const uncertain = ledger.filter(row => row.state === "unknown").reduce((sum, row) => sum + row.costMicros!, 0);
      const completeLedger = !ledger.some(row => row.state === "reserved") && document?.accounting?.settled === true &&
        Math.round(document.accounting.measuredMxn * 1e6) === measured && Math.round(document.accounting.uncertainMxn * 1e6) === uncertain;
      // Re-read configuration after acquiring the final fence, not before waiting for it.
      const allowed = configurationCurrent() && !current.expired && current.readingId &&
        active(consent, current.policyHash ?? "", current.consentRevision ?? -1) && completeLedger;
      const publish = allowed && document && persistableDocument(document) && document.readingId === current.readingId &&
        document.locale === current.locale && document.contentVersion === current.contentVersion && document.tier === "free";
      let documentId: string | null = null;
      if (publish) {
        const [saved] = await tx.insert(readingDocuments).values({
          id: document.id, readingId: current.readingId!, locale: document.locale, contentVersion: document.contentVersion,
          chartVersion: document.chartVersion, tier: "free", document,
        }).onConflictDoNothing().returning({ id: readingDocuments.id });
        if (!saved) throw new GenerationBlocked("publication_conflict");
        documentId = saved.id;
      }
      const consumed = current.consumedAt || documentId;
      const status = documentId ? document!.sections.every(section => section.status === "generated") ? "completed" : "partial"
        : !consumed ? "reserved" : ledger.some(row => ["reserved", "unknown"].includes(row.state)) ? "indeterminate" : "failed";
      const [saved] = await tx.update(runs).set({
        status, documentId, consumedAt: consumed ? sql`coalesce(${runs.consumedAt}, clock_timestamp())` : null,
        owner: consumed ? current.owner : null, deadline: sql`clock_timestamp()`,
        finishedAt: consumed ? sql`clock_timestamp()` : null,
        failureCode: documentId ? null : !allowed ? "publication_not_authorized" : "generation_failed",
      }).where(and(eq(runs.id, current.id), eq(runs.owner, run.owner!))).returning(runColumns);
      if (!saved) throw new GenerationBlocked("generation_owner_lost");
      return view(saved);
    });
  }

  async deleteReading(userId: string, readingId: string) {
    return this.scope(userId, async tx => {
      const [owned] = await tx.select({ id: readings.id }).from(readings).where(and(eq(readings.id, readingId), eq(readings.userId, userId))).for("update");
      if (!owned) return;
      await tx.delete(readings).where(eq(readings.id, owned.id));
      // SET NULL on run references preserves the claim, including an unused one.
      // A late worker must pass owned() again and cannot publish into a deleted chart.
    });
  }
}
