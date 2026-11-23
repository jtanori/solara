/**
 * Destructive-DDL gate (#166).
 *
 * Pure detection and decision logic for `scripts/check-migration-safety.ts`.
 * The CI wrapper supplies the changed files (from the Pull Request API) and the
 * labels (read at run time, never from the event payload).
 */

export const BREAKING_LABEL = "migration:breaking-approved";

export type MigrationStatus = string;
export type MigrationInput = { filename: string; status: MigrationStatus; content: string | null };
export type Violation = { file: string; kind: string; detail: string };
export type Decision = {
  status: "skip" | "pass" | "override" | "blocked" | "hotfix";
  violations: Violation[];
};

/** Comments and quoted values cannot make a migration destructive. */
export function stripSql(sql: string): string {
  let out = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 1;
      out += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      out += quote === "'" ? "''" : '""';
      continue;
    }
    out += char;
  }
  return out;
}

export function splitStatements(sql: string): string[] {
  return stripSql(sql).split(";").map(statement => statement.trim()).filter(Boolean);
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === delimiter && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

export function findViolations(filename: string, sql: string): Violation[] {
  const violations: Violation[] = [];
  const add = (kind: string, detail: string) => violations.push({ file: filename, kind, detail });

  for (const statement of splitStatements(sql)) {
    if (/\bDROP\b/i.test(statement)) add("drop", "DROP is destructive");
    if (/\bRENAME\b/i.test(statement)) add("rename", "RENAME is destructive");
    if (/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)) {
      add("alter_column_type", "changing a column type rewrites and locks the table");
    }
    if (/\bSET\s+NOT\s+NULL\b/i.test(statement)) {
      add("set_not_null", "SET NOT NULL scans and locks the table");
    }
    for (const segment of splitTopLevel(statement, ",")) {
      if (!/\bADD\s+COLUMN\b/i.test(segment)) continue;
      if (/\bNOT\s+NULL\b/i.test(segment) && !/\bDEFAULT\b/i.test(segment)) {
        add("add_not_null", "ADD COLUMN NOT NULL requires a DEFAULT");
      }
    }
  }
  return violations;
}

export function decide(files: MigrationInput[], labels: string[], headRef: string): Decision {
  const migrations = files.filter(file => file.filename.startsWith("drizzle/") && file.filename.endsWith(".sql"));
  if (migrations.length === 0) return { status: "skip", violations: [] };

  const violations: Violation[] = [];
  for (const file of migrations) {
    if (file.status === "modified" || file.status === "removed" || file.status === "renamed") {
      violations.push({ file: file.filename, kind: "migration_rewritten", detail: "applied migrations are append-only; add a new migration instead" });
      continue;
    }
    if (file.content !== null) violations.push(...findViolations(file.filename, file.content));
  }

  // A hotfix may not change schema at all. No label overrides this.
  if (headRef.startsWith("hotfix/")) return { status: "hotfix", violations };
  if (violations.length === 0) return { status: "pass", violations };
  if (labels.includes(BREAKING_LABEL)) return { status: "override", violations };
  return { status: "blocked", violations };
}
