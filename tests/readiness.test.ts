import assert from "node:assert/strict";
import test from "node:test";
import { bootGuardFailure } from "../src/db/boot-guard";
import {
  buildReadiness,
  classifyMigrations,
  evaluateReadiness,
  getReadiness,
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

test("readiness fails fast when the boot guard would reject the deployment", async () => {
  const started = Date.now();
  const result = await getReadiness(() => "database_url_endpoint_unset");
  assert.equal(result.ok, false, "a deployment that cannot boot its database module is not ready");
  assert.equal(result.db, "error");
  assert.equal(result.auth, "degraded");
  assert.equal(result.migrations.state, "diverged");
  assert.ok(Date.now() - started < 1_000, "the guard must short-circuit before opening a connection");
});

test("getReadiness() uses the production boot guard when called without an override", async () => {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DEPLOY_ENV: process.env.APP_DEPLOY_ENV,
    STAGING_DB_ENDPOINT: process.env.STAGING_DB_ENDPOINT,
    NEXT_PHASE: process.env.NEXT_PHASE,
  };
  try {
    delete process.env.NEXT_PHASE;
    process.env.APP_DEPLOY_ENV = "staging";
    process.env.DATABASE_URL = "postgresql://user:pass@ep-stage-pooler.us-east-2.aws.neon.tech/app?sslmode=verify-full";
    delete process.env.STAGING_DB_ENDPOINT;

    const started = Date.now();
    const result = await getReadiness();
    assert.equal(result.ok, false, "the default path must not bypass the boot guard");
    assert.equal(result.db, "error");
    assert.equal(result.migrations.state, "diverged");
    assert.ok(Date.now() - started < 1_000, "the production default must short-circuit before connecting");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the boot guard reports the code app boot would throw, without a URL or host", () => {
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DEPLOY_ENV: process.env.APP_DEPLOY_ENV,
    STAGING_DB_ENDPOINT: process.env.STAGING_DB_ENDPOINT,
    PROD_DB_ENDPOINT: process.env.PROD_DB_ENDPOINT,
    NEXT_PHASE: process.env.NEXT_PHASE,
  };
  try {
    delete process.env.NEXT_PHASE;
    process.env.APP_DEPLOY_ENV = "staging";
    process.env.DATABASE_URL = "postgresql://user:pass@ep-stage-pooler.us-east-2.aws.neon.tech/app?sslmode=verify-full";
    delete process.env.STAGING_DB_ENDPOINT;
    assert.equal(bootGuardFailure(), "database_url_endpoint_unset");

    process.env.STAGING_DB_ENDPOINT = "ep-not-this-one";
    assert.equal(bootGuardFailure(), "database_url_endpoint_mismatch");

    process.env.STAGING_DB_ENDPOINT = "ep-stage";
    assert.equal(bootGuardFailure(), null, "a matching endpoint passes");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
