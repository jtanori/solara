import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ChartInput, ChartResult, Role } from "@/lib/types";
import type { ReadingDocument } from "@/readings/types";
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
