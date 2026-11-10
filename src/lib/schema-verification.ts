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
] as const;

export const REQUIRED_INDEXES = [
  "rate_limits_expires_idx",
  "email_tokens_user_idx",
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
];

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
