import assert from "node:assert/strict";
import test from "node:test";
import { buildReadiness, type ReadinessSnapshot } from "../src/lib/readiness";
import { EXPECTED_MIGRATIONS } from "../src/lib/migration-manifest";

const appliedHashes = EXPECTED_MIGRATIONS.map(entry => entry.hash);

function snapshot(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    dbOk: true,
    missingTables: [],
    missingColumns: [],
    missingIndexes: [],
    appliedHashes,
    authOk: true,
    ...overrides,
  };
}

test("ready when database, schema, migrations and auth are healthy", () => {
  assert.deepEqual(buildReadiness(snapshot()), {
    ok: true,
    db: "ok",
    schema: { missing: [], missingColumns: [], missingIndexes: [] },
    migrations: { pending: 0, unexpected: 0 },
    auth: "ok",
  });
});

test("not ready when a required table is missing", () => {
  const result = buildReadiness(snapshot({ missingTables: ["public.email_tokens"] }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.schema.missing, ["public.email_tokens"]);
});

test("not ready when a required column or index is missing", () => {
  const result = buildReadiness(snapshot({
    missingColumns: ["rate_limits.expires_at"],
    missingIndexes: ["rate_limits_expires_idx"],
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.schema.missingColumns, ["rate_limits.expires_at"]);
  assert.deepEqual(result.schema.missingIndexes, ["rate_limits_expires_idx"]);
});

test("not ready when a migration is pending", () => {
  const result = buildReadiness(snapshot({ appliedHashes: appliedHashes.slice(1) }));
  assert.equal(result.ok, false);
  assert.equal(result.migrations.pending, 1);
});

test("not ready when the database has an unexpected applied hash", () => {
  const result = buildReadiness(snapshot({ appliedHashes: [...appliedHashes, "unexpected"] }));
  assert.equal(result.ok, false);
  assert.equal(result.migrations.unexpected, 1);
});

test("not ready when the auth probe fails", () => {
  const result = buildReadiness(snapshot({ authOk: false }));
  assert.equal(result.ok, false);
  assert.equal(result.auth, "degraded");
});

test("not ready when the database is unreachable", () => {
  const result = buildReadiness(snapshot({ dbOk: false }));
  assert.equal(result.ok, false);
  assert.equal(result.db, "error");
  assert.equal(result.auth, "degraded");
  assert.equal(result.migrations.pending, EXPECTED_MIGRATIONS.length);
});
