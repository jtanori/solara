import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReadiness,
  classifyMigrations,
  evaluateReadiness,
  READINESS_DEADLINE_MS,
  READINESS_WARM_TARGET_MS,
  type AppliedMigration,
  type ReadinessSnapshot,
} from "../src/lib/readiness";
import { EXPECTED_MIGRATIONS } from "../src/lib/migration-manifest";

const appliedMigrations: AppliedMigration[] = EXPECTED_MIGRATIONS.map(entry => ({ hash: entry.hash, createdAt: entry.when }));
const newestWhen = Math.max(...EXPECTED_MIGRATIONS.map(entry => entry.when));

function snapshot(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    dbOk: true,
    missingTables: [],
    missingColumns: [],
    missingIndexes: [],
    appliedMigrations,
    authOk: true,
    ...overrides,
  };
}

test("ready when database, schema, migrations and auth are healthy", () => {
  assert.deepEqual(buildReadiness(snapshot()), {
    ok: true,
    db: "ok",
    schema: { missing: [], missingColumns: [], missingIndexes: [] },
    migrations: { state: "exact" },
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

test("behind: a missing expected migration is fatal", () => {
  const result = buildReadiness(snapshot({ appliedMigrations: appliedMigrations.slice(1) }));
  assert.equal(result.ok, false);
  assert.equal(result.migrations.state, "behind");
});

test("ahead: every extra hash is newer than the newest expected migration", () => {
  const result = buildReadiness(snapshot({
    appliedMigrations: [...appliedMigrations, { hash: "future", createdAt: newestWhen + 1 }],
  }));
  assert.equal(result.ok, true, "a forward-compatible rollout is ready");
  assert.equal(result.migrations.state, "ahead");
});

test("diverged: an extra hash at the newest expected timestamp is not ahead", () => {
  const result = buildReadiness(snapshot({
    appliedMigrations: [...appliedMigrations, { hash: "equal", createdAt: newestWhen }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.migrations.state, "diverged");
});

test("diverged: an older extra hash is not ahead", () => {
  const result = buildReadiness(snapshot({
    appliedMigrations: [...appliedMigrations, { hash: "older", createdAt: newestWhen - 1 }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.migrations.state, "diverged");
});

test("diverged: an extra hash with no parseable timestamp fails closed", () => {
  for (const createdAt of [null, Number.NaN]) {
    const result = buildReadiness(snapshot({
      appliedMigrations: [...appliedMigrations, { hash: "unknown", createdAt }],
    }));
    assert.equal(result.ok, false);
    assert.equal(result.migrations.state, "diverged", String(createdAt));
  }
});

test("diverged: missing expected and extra applied at the same time", () => {
  const result = buildReadiness(snapshot({
    appliedMigrations: [...appliedMigrations.slice(1), { hash: "future", createdAt: newestWhen + 1 }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.migrations.state, "diverged");
});

test("diverged: an empty expected manifest is never exact", () => {
  const result = buildReadiness(snapshot({ appliedMigrations: [] }), []);
  assert.equal(result.ok, false);
  assert.equal(result.migrations.state, "diverged");
  assert.equal(classifyMigrations([], []), "diverged");
});

test("not ready when the auth probe fails", () => {
  const result = buildReadiness(snapshot({ authOk: false }));
  assert.equal(result.ok, false);
  assert.equal(result.auth, "degraded");
});

test("readiness allows a bounded cold connection and keeps a warm target", () => {
  assert.equal(READINESS_WARM_TARGET_MS, 300);
  assert.equal(READINESS_DEADLINE_MS, 3_000);
});

test("readiness deadline rejects a hung probe without waiting for it", async () => {
  const started = Date.now();
  await assert.rejects(
    evaluateReadiness(() => new Promise<ReadinessSnapshot>(() => {}), EXPECTED_MIGRATIONS, 50),
    /readiness_timeout/,
  );
  assert.ok(Date.now() - started < 1_000, "deadline should reject without waiting for the probe");
});

test("not ready when the database is unreachable", () => {
  const result = buildReadiness(snapshot({ dbOk: false }));
  assert.equal(result.ok, false);
  assert.equal(result.db, "error");
  assert.equal(result.auth, "degraded");
  assert.equal(result.migrations.state, "diverged", "unreachable means the state is unknown");
});
