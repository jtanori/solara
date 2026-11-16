export const REQUIRED_TABLES = [
  "public.users",
  "public.sessions",
  "public.readings",
  "public.knowledge",
  "public.subscriptions",
  "public.stripe_events",
  "public.audit_logs",
  "public.rate_limits",
  "public.email_tokens",
  "public.reading_documents",
  "public.generation_cache",
  "public.deleted_customers",
  "public.account_lifecycle_leases",
  "public.reading_generation_consents",
  "public.reading_generation_runs",
  "public.reading_generation_attempts",
] as const;

export const REQUIRED_INDEXES = [
  "rate_limits_expires_idx",
  "email_tokens_user_idx",
  "reading_documents_reading_locale_version_key",
  "account_lifecycle_leases_expires_idx",
  "reading_runs_lifetime_user_key",
  "reading_runs_reading_idx",
  "reading_runs_document_idx",
  "reading_attempts_slot_key",
  "reading_attempts_outstanding_key",
] as const;

export type RequiredColumn = {
  table: string;
  column: string;
  nullable?: boolean;
  dataType?: string;
  defaultValue?: string | null;
};

export type ColumnRow = {
  table_name: string;
  column_name: string;
  is_nullable: string;
  data_type: string;
  column_default: string | null;
};

export const REQUIRED_COLUMNS: RequiredColumn[] = [
  { table: "users", column: "email_verified_at", nullable: true, dataType: "timestamp with time zone", defaultValue: null },
  { table: "rate_limits", column: "key" },
  { table: "rate_limits", column: "window_start" },
  { table: "rate_limits", column: "count" },
  { table: "rate_limits", column: "failure_count" },
  { table: "rate_limits", column: "blocked_until" },
  { table: "rate_limits", column: "last_triggered_at" },
  { table: "rate_limits", column: "expires_at" },
  { table: "email_tokens", column: "token_hash" },
  { table: "email_tokens", column: "user_id" },
  { table: "email_tokens", column: "purpose" },
  { table: "email_tokens", column: "expires_at" },
  { table: "email_tokens", column: "used_at" },
  { table: "email_tokens", column: "created_at" },
  { table: "account_lifecycle_leases", column: "user_id", nullable: false, dataType: "uuid" },
  { table: "account_lifecycle_leases", column: "owner", nullable: false, dataType: "uuid" },
  { table: "account_lifecycle_leases", column: "expires_at", nullable: false, dataType: "timestamp with time zone" },
  { table: "account_lifecycle_leases", column: "created_at", nullable: false, dataType: "timestamp with time zone" },
  { table: "account_lifecycle_leases", column: "updated_at", nullable: false, dataType: "timestamp with time zone" },
];

// Include every column used by the consent/attempt boundary, not just table presence.
for (const [table, names] of Object.entries({
  reading_generation_consents: ["user_id", "receipt_id", "revision", "processor_id", "policy_version", "policy_hash", "locale", "granted_at", "withdrawn_at"],
  reading_generation_runs: ["id", "user_id", "kind", "reading_id", "document_id", "locale", "status", "owner", "deadline", "consumed_at", "consent_revision", "policy_hash", "config_hash", "content_version", "settings", "ceiling_micros", "failure_code", "created_at", "finished_at"],
  reading_generation_attempts: ["id", "run_id", "owner", "section", "phase", "state", "requested_model", "reported_model", "reserved_micros", "cost_micros", "usage", "latency_ms", "code", "created_at", "settled_at"],
})) {
  for (const column of names) REQUIRED_COLUMNS.push({ table, column });
}

/** Shared by hosted readiness and the migration CLI; no second hard-coded list. */
export const REQUIRED_COLUMN_TABLES = [...new Set(REQUIRED_COLUMNS.map(spec => spec.table))];

export function findMissingColumns(rows: ColumnRow[]): string[] {
  const byName = new Map(rows.map(row => [`${row.table_name}.${row.column_name}`, row]));
  return REQUIRED_COLUMNS.filter(spec => {
    const row = byName.get(`${spec.table}.${spec.column}`);
    if (!row) return true;
    if (spec.nullable !== undefined && row.is_nullable !== (spec.nullable ? "YES" : "NO")) return true;
    if (spec.dataType && row.data_type !== spec.dataType) return true;
    if (spec.defaultValue !== undefined && row.column_default !== spec.defaultValue) return true;
    return false;
  }).map(spec => `${spec.table}.${spec.column}`);
}
