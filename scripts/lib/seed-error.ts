import { ZodError } from "zod";

/** A seed failure whose message is written by this tool, never by a driver. */
export class SeedError extends Error {}

/**
 * Never print a driver message verbatim: a unique violation embeds the offending value and a
 * connection error can embed the URL. Classify by source so the operator still learns which
 * subsystem failed without seeing its text.
 */
export function describeSeedError(error: unknown): string {
  if (error instanceof SeedError) return error.message;
  // Report parsing fails before the database is touched; keep the issue count, not its values.
  if (error instanceof ZodError) {
    return `invalid_report (${error.issues.length} issue${error.issues.length === 1 ? "" : "s"})`;
  }
  if (error instanceof SyntaxError) return "invalid_report (invalid JSON)";
  const candidate = error as {
    code?: unknown;
    severity?: unknown;
    cause?: { code?: unknown; severity?: unknown };
  } | null;
  const code = candidate?.code ?? candidate?.cause?.code;
  if (typeof code !== "string") return "unexpected_error";
  // pg DatabaseError sets `severity`; Node system errors do not. `EPIPE`/`EPERM` are five
  // uppercase letters, so a SQLSTATE-shaped code alone would misclassify them as database errors.
  const severity = candidate?.severity ?? candidate?.cause?.severity;
  return typeof severity === "string" ? `database_error (${code})` : `system_error (${code})`;
}
