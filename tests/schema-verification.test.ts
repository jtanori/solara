import assert from "node:assert/strict";
import test from "node:test";
import {
  findMissingColumns,
  REQUIRED_COLUMNS,
  type ColumnRow,
} from "../src/lib/schema-verification";

function rows(): ColumnRow[] {
  return REQUIRED_COLUMNS.map(spec => ({
    table_name: spec.table,
    column_name: spec.column,
    is_nullable: spec.nullable === false ? "NO" : "YES",
    data_type: spec.dataType ?? "text",
    column_default: spec.defaultValue === undefined ? null : spec.defaultValue,
  }));
}

test("accepts the expected columns", () => {
  assert.deepEqual(findMissingColumns(rows()), []);
});

test("rejects a verification default that would auto-verify new users", () => {
  const columns = rows();
  const target = columns.find(row => row.table_name === "users" && row.column_name === "email_verified_at");
  assert.ok(target);
  target.column_default = "now()";
  assert.deepEqual(findMissingColumns(columns), ["users.email_verified_at"]);
});

test("rejects the wrong verification nullability", () => {
  const columns = rows();
  const target = columns.find(row => row.table_name === "users" && row.column_name === "email_verified_at");
  assert.ok(target);
  target.is_nullable = "NO";
  assert.deepEqual(findMissingColumns(columns), ["users.email_verified_at"]);
});
