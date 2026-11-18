import { sql } from "drizzle-orm";
import type { GenerationSettings } from "@/readings/execution";
import { bigint, check, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ChartInput, ChartResult, Role } from "@/lib/types";
import type { ChartFacts } from "@/lib/chart";
import type { PaidSnapshot } from "@/readings/paid-chart";
import type { PaidStatus } from "@/readings/paid-contract";
import type { ReadingDocument, SectionKey } from "@/readings/types";
import type { ProviderUsage } from "@/readings/provider";
import type { SectionOutput } from "@/readings/schemas";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<Role>().notNull().default("user"),
  // Legacy display field only; paid access is derived from verified subscriptions.
  plan: text("plan").$type<"free" | "paid">().notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id").unique(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const readings = pgTable("readings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  input: jsonb("input").$type<ChartInput>().notNull(),
  result: jsonb("result").$type<ChartResult>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The full deterministic calculation behind a saved chart (#152) — what the factual
 * wheel and numerical table are drawn from, since `readings.result` only carries the
 * four-place summary the original UI needed.
 *
 * Insert-only and versioned like `reading_documents`: there is no UPDATE path, and a
 * future contract is a new `factsVersion` row rather than a rewrite, so the original
 * `result` and every already-delivered page/PDF stay exactly as saved. Nothing
 * backfills these rows and no read path recomputes them; a chart saved before this
 * table simply has none, and says so.
 *
 * The unique index leads with `reading_id`, so it also serves per-chart lookups and no
 * second index is needed (the reasoning already recorded for
 * `reading_documents_reading_locale_version_key`). Facts are meaningless without their
 * chart, so deletion cascades.
 */
export const readingChartFacts = pgTable("reading_chart_facts", {
  id: uuid("id").defaultRandom().primaryKey(),
  readingId: uuid("reading_id").notNull().references(() => readings.id, { onDelete: "cascade" }),
  factsVersion: text("facts_version").notNull(),
  calculationPolicy: text("calculation_policy").notNull(),
  houseSystem: text("house_system").notNull(),
  chartVersion: text("chart_version").notNull(),
  facts: jsonb("facts").$type<ChartFacts>().notNull(),
  factsHash: text("facts_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("reading_chart_facts_reading_version_key").on(table.readingId, table.factsVersion),
  // Same structural bound the read path enforces, so an oversized row cannot exist.
  check("chart_facts_size_check", sql`octet_length(${table.facts}::text) <= 65536`),
]);

// ------------------------------------------------------------------ readings engine (#103)

/**
 * Frozen, locale-versioned reading documents (epic §2, §4.5). Regeneration is
 * explicit and produces a NEW row (unique on reading+locale+contentVersion);
 * there is no update path — immutability is structural.
 */
export const readingDocuments = pgTable("reading_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  readingId: uuid("reading_id").notNull().references(() => readings.id, { onDelete: "cascade" }),
  locale: text("locale").$type<"en" | "es">().notNull(),
  contentVersion: text("content_version").notNull(),
  chartVersion: text("chart_version").notNull(),
  tier: text("tier").$type<"free" | "paid">().notNull(),
  document: jsonb("document").$type<ReadingDocument>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  // (readingId) alone needs no index: it is the leading column of the unique
  // index below, which serves those lookups.
  uniqueIndex("reading_documents_reading_locale_version_key").on(table.readingId, table.locale, table.contentVersion),
]);

/**
 * The generation cache (epic §4.2): one row per (digest, section, locale,
 * contentVersion). Insert-only — first write wins, contentVersion bumps create
 * new rows and preserve old ones. Also the per-section cost/latency ledger.
 */
export const generationCache = pgTable("generation_cache", {
  digestHash: text("digest_hash").notNull(),
  section: text("section").notNull(),
  locale: text("locale").$type<"en" | "es">().notNull(),
  contentVersion: text("content_version").notNull(),
  model: text("model").notNull(),
  usage: jsonb("usage").$type<ProviderUsage>().notNull(),
  costMxn: doublePrecision("cost_mxn").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  output: jsonb("output").$type<SectionOutput>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.digestHash, table.section, table.locale, table.contentVersion] }),
]);

// ------------------------------------------------------------------ generation safety (#105/#108/#129)
export const readingGenerationConsents = pgTable("reading_generation_consents", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  receiptId: uuid("receipt_id").notNull().defaultRandom(),
  revision: integer("revision").notNull().default(0),
  processorId: text("processor_id"),
  policyVersion: text("policy_version"),
  policyHash: text("policy_hash"),
  locale: text("locale").$type<"en" | "es">().notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
}, table => [
  check("reading_consents_revision_check", sql`${table.revision} >= 0`),
  check("reading_consents_locale_check", sql`${table.locale} in ('en', 'es')`),
  check("reading_consents_grant_check", sql`${table.grantedAt} is null or (${table.policyHash} is not null and ${table.processorId} is not null and ${table.policyVersion} is not null)`),
]);

export const readingGenerationRuns = pgTable("reading_generation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("lifetime_free"),
  readingId: uuid("reading_id").references(() => readings.id, { onDelete: "set null" }),
  documentId: uuid("document_id").references(() => readingDocuments.id, { onDelete: "set null" }),
  locale: text("locale").$type<"en" | "es">().notNull(),
  status: text("status").$type<"reserved" | "running" | "completed" | "partial" | "failed" | "indeterminate" | "legacy">().notNull(),
  owner: uuid("owner"),
  deadline: timestamp("deadline", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  consentRevision: integer("consent_revision"),
  policyHash: text("policy_hash"),
  configHash: text("config_hash"),
  contentVersion: text("content_version").notNull(),
  settings: jsonb("settings").$type<GenerationSettings>(),
  ceilingMicros: integer("ceiling_micros").notNull().default(5_000_000),
  failureCode: text("failure_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, table => [
  uniqueIndex("reading_runs_lifetime_user_key").on(table.userId).where(sql`${table.kind} = 'lifetime_free'`),
  index("reading_runs_reading_idx").on(table.readingId),
  index("reading_runs_document_idx").on(table.documentId),
  check("reading_runs_kind_check", sql`${table.kind} = 'lifetime_free'`),
  check("reading_runs_locale_check", sql`${table.locale} in ('en', 'es')`),
  check("reading_runs_ceiling_check", sql`${table.ceilingMicros} = 5000000`),
  check("reading_runs_status_check", sql`${table.status} in ('reserved','running','completed','partial','failed','indeterminate','legacy')`),
  check("reading_runs_consumed_check", sql`${table.status} = 'reserved' or ${table.consumedAt} is not null`),
]);

export const readingGenerationAttempts = pgTable("reading_generation_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => readingGenerationRuns.id, { onDelete: "cascade" }),
  owner: uuid("owner").notNull(),
  section: text("section").$type<"overview" | "sun">().notNull(),
  phase: text("phase").$type<"primary" | "repair">().notNull(),
  state: text("state").$type<"reserved" | "measured" | "unknown" | "not_dispatched">().notNull().default("reserved"),
  requestedModel: text("requested_model").notNull(),
  reportedModel: text("reported_model"),
  reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
  costMicros: bigint("cost_micros", { mode: "number" }),
  usage: jsonb("usage").$type<ProviderUsage>(),
  latencyMs: integer("latency_ms"),
  code: text("code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, table => [
  uniqueIndex("reading_attempts_slot_key").on(table.runId, table.section, table.phase),
  uniqueIndex("reading_attempts_outstanding_key").on(table.runId).where(sql`${table.state} = 'reserved'`),
  check("reading_attempts_section_check", sql`${table.section} in ('overview','sun')`),
  check("reading_attempts_phase_check", sql`${table.phase} in ('primary','repair')`),
  check("reading_attempts_state_check", sql`${table.state} in ('reserved','measured','unknown','not_dispatched')`),
  check("reading_attempts_money_check", sql`${table.reservedMicros} between 0 and 5000000 and (${table.costMicros} is null or ${table.costMicros} between 0 and 9007199254740991)`),
  check("reading_attempts_settlement_check", sql`(${table.state} = 'reserved' and ${table.costMicros} is null and ${table.settledAt} is null) or (${table.state} <> 'reserved' and ${table.costMicros} is not null and ${table.settledAt} is not null)`),
]);

export const knowledge = pgTable("knowledge", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  stripeSubscriptionId: text("stripe_subscription_id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull(),
  status: text("status").notNull(),
  currency: text("currency").notNull(),
  grantsAccess: boolean("grants_access").notNull().default(false),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("subscriptions_user_idx").on(table.userId)]);

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
 * The Stripe customer a deleted account owned, recorded at deletion time.
 *
 * Why a row and not two `audit_logs` rows: a deletion writes
 * `account:delete` with `target` = the deleted user and a second row with
 * `target` = the Stripe customer id. Read separately, two such rows do not
 * prove they belong to the *same* deletion — two independent deletions, or a
 * customer id reused for another account, produce rows that look identical. The
 * webhook then cannot tell "this customer belonged to that deleted user" from
 * "this customer was deleted at some point and so was that user".
 *
 * This table states the association explicitly, in one row.
 *
 * Deliberately not a foreign key to `users`: the user is gone. `userId` is the
 * id that was deleted, kept as text for exactly that reason.
 */
export const deletedCustomers = pgTable("deleted_customers", {
  /** One row per customer: a customer belongs to at most one account. */
  stripeCustomerId: text("stripe_customer_id").primaryKey(),
  /** The user id that owned this customer and was deleted. */
  userId: uuid("user_id").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
});

/*
 * Per-user account lifecycle lease.
 *
 * Deliberately no foreign key to `users`: a lease row can outlive the user it
 * guarded, and deletion itself runs under the lease. The row is taken over
 * atomically once `expires_at` passes and removed by its owner on release.
 */
export const accountLifecycleLeases = pgTable("account_lifecycle_leases", {
  userId: uuid("user_id").primaryKey(),
  owner: uuid("owner").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("account_lifecycle_leases_expires_idx").on(table.expiresAt)]);

export const emailTokens = pgTable("email_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [index("email_tokens_user_idx").on(table.userId)]);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  count: integer("count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  blockedUntil: timestamp("blocked_until", { withTimezone: true }),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, table => [index("rate_limits_expires_idx").on(table.expiresAt)]);

// ------------------------------------------------------------------ paid editions (#107 / paid #108)
// Separate from the lifetime-free identity and its immutable document slot.
export const paidReadingControl = pgTable("paid_reading_control", {
  id: text("id").primaryKey().default("paid"),
  enabled: boolean("enabled").notNull().default(false),
  revision: integer("revision").notNull().default(0),
  workerHeartbeatAt: timestamp("worker_heartbeat_at", { withTimezone: true }),
  workerConfigHash: text("worker_config_hash"),
}, table => [check("paid_control_singleton_check", sql`${table.id} = 'paid' and ${table.revision} >= 0`)]);

export const paidReadingApprovals = pgTable("paid_reading_approvals", {
  profile: text("profile").notNull(), contentVersion: text("content_version").notNull(),
  locale: text("locale").$type<"en" | "es">().notNull(), configHash: text("config_hash").notNull(),
  sampleCount: integer("sample_count").notNull(), reviewer: text("reviewer").notNull(), evidence: text("evidence").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, table => [
  primaryKey({ columns: [table.profile, table.contentVersion, table.locale, table.configHash] }),
  check("paid_approvals_evidence_check", sql`${table.sampleCount} >= 6 and length(${table.reviewer}) between 1 and 200 and length(${table.evidence}) between 1 and 2000 and ${table.locale} in ('en','es')`),
]);

export const paidReadingRuns = pgTable("paid_reading_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  readingId: uuid("reading_id").references(() => readings.id, { onDelete: "set null" }),
  intentId: uuid("intent_id").notNull(), period: text("period").notNull(), allowancePolicy: text("allowance_policy").notNull(),
  locale: text("locale").$type<"en" | "es">().notNull(), profile: text("profile").notNull(),
  expectedSections: jsonb("expected_sections").$type<SectionKey[]>().notNull(),
  contentVersion: text("content_version").notNull(), configHash: text("config_hash").notNull(),
  settings: jsonb("settings").$type<GenerationSettings>().notNull(),
  policyHash: text("policy_hash").notNull(), consentRevision: integer("consent_revision").notNull(), consentReceiptId: uuid("consent_receipt_id").notNull(),
  entitlementId: text("entitlement_id").notNull(), entitlementUntil: timestamp("entitlement_until", { withTimezone: true }).notNull(),
  controlRevision: integer("control_revision").notNull(), ceilingMicros: integer("ceiling_micros").notNull().default(10_000_000),
  status: text("status").$type<PaidStatus>().notNull().default("queued"),
  completedSections: integer("completed_sections").notNull().default(0),
  owner: uuid("owner"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  deadline: timestamp("deadline", { withTimezone: true }), queueExpiresAt: timestamp("queue_expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }), stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
  failureCode: text("failure_code"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, table => [
  uniqueIndex("paid_runs_intent_key").on(table.userId, table.intentId),
  uniqueIndex("paid_runs_active_user_key").on(table.userId).where(sql`${table.status} in ('queued','preparing','generating')`),
  index("paid_runs_queue_idx").on(table.createdAt, table.id).where(sql`${table.status} in ('queued','preparing','generating')`),
  index("paid_runs_reading_idx").on(table.readingId, table.createdAt, table.id),
  index("paid_runs_attention_idx").on(table.userId).where(sql`${table.status} = 'attention'`),
  check("paid_runs_contract_check", sql`${table.profile} in ('paid-core-v1','paid-rich-v1') and ${table.allowancePolicy} = 'one-per-account-utc-month-v1' and ${table.ceilingMicros} = 10000000 and ${table.locale} in ('en','es') and ${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  check("paid_runs_manifest_check", sql`(${table.profile} = 'paid-core-v1' and ${table.expectedSections} = '["overview","sun","moon","ascendant","aspects","houses","planets","nodes","guidance"]'::jsonb) or (${table.profile} = 'paid-rich-v1' and ${table.expectedSections} = '["overview","sun","moon","ascendant","aspects","houses","planets","nodes","planetaryYear","transits","guidance"]'::jsonb)`),
  check("paid_runs_state_check", sql`${table.completedSections} between 0 and jsonb_array_length(${table.expectedSections}) and ${table.status} in ('queued','preparing','generating','completed','partial','failed','stopped','attention') and (${table.status} not in ('completed','partial') or ${table.consumedAt} is not null)`),
]);

export const paidReadingAllowances = pgTable("paid_reading_allowances", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  period: text("period").notNull(), runId: uuid("run_id").notNull().references(() => paidReadingRuns.id, { onDelete: "cascade" }),
  reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, table => [primaryKey({ columns: [table.userId, table.period] }), uniqueIndex("paid_allowances_run_key").on(table.runId)]);

export const paidReadingSnapshots = pgTable("paid_reading_snapshots", {
  runId: uuid("run_id").primaryKey().references(() => paidReadingRuns.id, { onDelete: "cascade" }),
  readingId: uuid("reading_id").notNull().references(() => readings.id, { onDelete: "cascade" }),
  hash: text("hash").notNull(), snapshot: jsonb("snapshot").$type<PaidSnapshot>().notNull(),
}, table => [index("paid_snapshots_reading_idx").on(table.readingId), check("paid_snapshots_size_check", sql`octet_length(${table.snapshot}::text) <= 131072`)]);

export const paidReadingAttempts = pgTable("paid_reading_attempts", {
  id: uuid("id").primaryKey().defaultRandom(), runId: uuid("run_id").notNull().references(() => paidReadingRuns.id, { onDelete: "cascade" }),
  owner: uuid("owner").notNull(), section: text("section").$type<SectionKey>().notNull(), phase: text("phase").$type<"primary" | "repair">().notNull(),
  state: text("state").$type<"reserved" | "measured" | "unknown" | "not_dispatched">().notNull().default("reserved"),
  requestedModel: text("requested_model").notNull(), reportedModel: text("reported_model"),
  reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(), costMicros: bigint("cost_micros", { mode: "number" }),
  usage: jsonb("usage").$type<ProviderUsage>(), latencyMs: integer("latency_ms"), code: text("code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), settledAt: timestamp("settled_at", { withTimezone: true }),
}, table => [
  uniqueIndex("paid_attempts_slot_key").on(table.runId, table.section, table.phase),
  uniqueIndex("paid_attempts_outstanding_key").on(table.runId).where(sql`${table.state} = 'reserved'`),
  check("paid_attempts_section_check", sql`${table.section} in ('overview','sun','moon','ascendant','aspects','houses','planets','nodes','planetaryYear','transits','guidance') and ${table.phase} in ('primary','repair')`),
  check("paid_attempts_state_check", sql`${table.state} in ('reserved','measured','unknown','not_dispatched')`),
  check("paid_attempts_money_check", sql`${table.reservedMicros} between 1 and 10000000 and (${table.costMicros} is null or ${table.costMicros} between 0 and 9007199254740991)`),
  check("paid_attempts_settlement_check", sql`(${table.state} = 'reserved' and ${table.costMicros} is null and ${table.settledAt} is null) or (${table.state} <> 'reserved' and ${table.costMicros} is not null and ${table.settledAt} is not null)`),
]);

/** Only validated prose, transactionally coupled to receipts; removed at terminal finalization. */
export const paidReadingCheckpoints = pgTable("paid_reading_checkpoints", {
  attemptId: uuid("attempt_id").primaryKey().references(() => paidReadingAttempts.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => paidReadingRuns.id, { onDelete: "cascade" }),
  readingId: uuid("reading_id").notNull().references(() => readings.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"valid" | "invalid">().notNull(), output: jsonb("output").$type<SectionOutput>(),
}, table => [index("paid_checkpoints_run_idx").on(table.runId), index("paid_checkpoints_reading_idx").on(table.readingId),
  check("paid_checkpoints_output_check", sql`(${table.kind} = 'valid' and ${table.output} is not null and octet_length(${table.output}::text) <= 131072) or (${table.kind} = 'invalid' and ${table.output} is null)`),
]);

export const paidReadingEditions = pgTable("paid_reading_editions", {
  id: uuid("id").primaryKey().defaultRandom(), runId: uuid("run_id").notNull().references(() => paidReadingRuns.id, { onDelete: "cascade" }),
  readingId: uuid("reading_id").notNull().references(() => readings.id, { onDelete: "cascade" }),
  locale: text("locale").$type<"en" | "es">().notNull(), profile: text("profile").notNull(), expectedSections: jsonb("expected_sections").$type<SectionKey[]>().notNull(),
  contentVersion: text("content_version").notNull(), chartVersion: text("chart_version").notNull(),
  snapshotHash: text("snapshot_hash").notNull(), snapshot: jsonb("snapshot").$type<PaidSnapshot>().notNull(),
  document: jsonb("document").$type<ReadingDocument>().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex("paid_editions_run_key").on(table.runId), index("paid_editions_reading_idx").on(table.readingId),
  check("paid_editions_size_check", sql`octet_length(${table.document}::text) <= 524288 and octet_length(${table.snapshot}::text) <= 131072`),
]);
