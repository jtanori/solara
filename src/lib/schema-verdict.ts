/**
 * Classify the schema verdict written by `migrate.yml`'s `Confirm schema` step (#236).
 *
 * The workflow used to read only `ok` from `verify.json`. Two very different outcomes
 * collapse into `ok:false`:
 *
 *   drift          the database was inspected and does not match `drizzle/`. This is
 *                  legitimate information in verify/dry-run mode (an empty database
 *                  before a migration) and a hard failure only after a real migrate.
 *   uninspectable  the inspection itself failed — a guard or connection error, a missing
 *                  verdict, or unparsable JSON. That is never information: reporting it as
 *                  "out of sync" turns a configuration error into green "schema drift",
 *                  three steps away from the cause.
 *
 * `errors[]` is checked before `ok` on purpose. `db-run verify` already folds errors into
 * `ok`, but a verdict that reported errors must not be allowed to look like drift.
 */

export type SchemaVerdictState = "in-sync" | "drift" | "uninspectable";

export type SchemaVerdict = {
  state: SchemaVerdictState;
  /** Human-readable reason. Never includes credentials, hosts or URLs. */
  reason: string;
  /** Guard/connection errors carried by the verdict, if any. */
  errors: string[];
};

type RawVerdict = { ok?: unknown; errors?: unknown };

export function classifySchemaVerdict(raw: unknown): SchemaVerdict {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { state: "uninspectable", reason: "verdict is not a JSON object", errors: [] };
  }

  const { ok, errors } = raw as RawVerdict;
  const reported = Array.isArray(errors)
    ? errors.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];

  if (reported.length > 0) {
    return {
      state: "uninspectable",
      reason: `inspection failed: ${reported.join("; ")}`,
      errors: reported,
    };
  }
  if (ok === true) {
    return { state: "in-sync", reason: "schema and journal match", errors: [] };
  }
  if (ok === false) {
    return { state: "drift", reason: "schema does not match the drizzle journal", errors: [] };
  }
  return { state: "uninspectable", reason: "verdict has no boolean ok field", errors: [] };
}

export function classifySchemaVerdictText(text: string): SchemaVerdict {
  try {
    return classifySchemaVerdict(JSON.parse(text));
  } catch {
    return { state: "uninspectable", reason: "verdict is not valid JSON", errors: [] };
  }
}

/**
 * 2 means "could not inspect" everywhere, including verify and dry-run. The workflow maps
 * it to a red step in every mode; only `drift` is mode-dependent.
 */
export function verdictExitCode(state: SchemaVerdictState): 0 | 2 {
  return state === "uninspectable" ? 2 : 0;
}
