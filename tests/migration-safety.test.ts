import assert from "node:assert/strict";
import test from "node:test";
import { BREAKING_LABEL, decide, findViolations, splitStatements, stripSql, type MigrationInput } from "../src/lib/migration-safety";

/*
 * #166 — the blocking destructive-DDL gate. Every pattern has a failing and a
 * passing fixture, and the decision path is tested separately from the CI API
 * wrapper. A mutation run (break a regex, watch the fixture fail) is recorded in
 * the PR body.
 */

const added = (sql: string, filename = "drizzle/0010_test.sql"): MigrationInput => ({ filename, status: "added", content: sql });

test("comments and quoted values do not make a migration destructive", () => {
  const sql = [
    "-- ALTER TABLE users DROP COLUMN name;",
    "/* DROP TABLE users; */",
    "COMMENT ON TABLE users IS 'DROP COLUMN name';",
    "SELECT 'ALTER TABLE users DROP COLUMN name';",
  ].join("\n");
  assert.deepEqual(findViolations("drizzle/0010_test.sql", sql), []);
  assert.equal(stripSql("SELECT '-- not a comment'; -- DROP TABLE x").includes("DROP"), false);
  assert.deepEqual(splitStatements("SELECT 1; SELECT 2;"), ["SELECT 1", "SELECT 2"]);
});

test("DROP is flagged", () => {
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users DROP COLUMN name;").map(v => v.kind), ["drop"]);
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "DROP TABLE users;").map(v => v.kind), ["drop"]);
});

test("RENAME is flagged", () => {
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users RENAME COLUMN a TO b;").map(v => v.kind), ["rename"]);
});

test("ALTER COLUMN ... TYPE is flagged, including SET DATA TYPE", () => {
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users ALTER COLUMN age TYPE bigint;").map(v => v.kind), ["alter_column_type"]);
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users ALTER COLUMN age SET DATA TYPE bigint;").map(v => v.kind), ["alter_column_type"]);
});

test("SET NOT NULL is flagged", () => {
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users ALTER COLUMN age SET NOT NULL;").map(v => v.kind), ["set_not_null"]);
});

test("ADD COLUMN NOT NULL needs a DEFAULT, per column", () => {
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users ADD COLUMN age integer NOT NULL;").map(v => v.kind), ["add_not_null"]);
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users ADD COLUMN age integer DEFAULT 0 NOT NULL;"), []);
  assert.deepEqual(findViolations("drizzle/0010_test.sql", "ALTER TABLE users ADD COLUMN age integer;"), []);
  const mixed = findViolations("drizzle/0010_test.sql", "ALTER TABLE users ADD COLUMN a integer NOT NULL, ADD COLUMN b text DEFAULT 'x' NOT NULL;");
  assert.deepEqual(mixed.map(v => v.kind), ["add_not_null"], "only the column without a DEFAULT is flagged");
});

test("a PR with no drizzle migration is skipped", () => {
  assert.deepEqual(decide([{ filename: "src/app/page.tsx", status: "modified", content: null }], [], "feat/x"), { status: "skip", violations: [] });
});

test("a safe additive migration passes", () => {
  const decision = decide([added("ALTER TABLE users ADD COLUMN age integer DEFAULT 0 NOT NULL;")], [], "feat/x");
  assert.equal(decision.status, "pass");
  assert.deepEqual(decision.violations, []);
});

test("a breaking migration is blocked without the label", () => {
  const decision = decide([added("ALTER TABLE users DROP COLUMN name;")], [], "feat/x");
  assert.equal(decision.status, "blocked");
  assert.deepEqual(decision.violations.map(v => v.kind), ["drop"]);
});

test("the explicit breaking label overrides a reviewed migration", () => {
  const decision = decide([added("ALTER TABLE users DROP COLUMN name;")], [BREAKING_LABEL], "feat/x");
  assert.equal(decision.status, "override");
});

test("rewriting an applied migration is blocked even when the SQL is additive", () => {
  for (const status of ["modified", "removed", "renamed"]) {
    const decision = decide([{ filename: "drizzle/0001_rate_limits.sql", status, content: null }], [], "feat/x");
    assert.equal(decision.status, "blocked", status);
    assert.deepEqual(decision.violations.map(v => v.kind), ["migration_rewritten"]);
  }
});

test("a hotfix cannot change drizzle/, even with a safe migration or the label", () => {
  const safe = decide([added("ALTER TABLE users ADD COLUMN age integer DEFAULT 0 NOT NULL;")], [], "hotfix/urgent");
  assert.equal(safe.status, "hotfix");
  const labelled = decide([added("ALTER TABLE users DROP COLUMN name;")], [BREAKING_LABEL], "hotfix/urgent");
  assert.equal(labelled.status, "hotfix", "the label never overrides the hotfix ban");
});
