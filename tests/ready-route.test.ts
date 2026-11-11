import assert from "node:assert/strict";
import test from "node:test";
import { createReadyHandler } from "../src/app/api/ready/handler";
import { buildReadiness, evaluateReadiness, type ReadinessSnapshot } from "../src/lib/readiness";
import { EXPECTED_MIGRATIONS } from "../src/lib/migration-manifest";

const healthy = buildReadiness({
  dbOk: true,
  missingTables: [],
  missingColumns: [],
  missingIndexes: [],
  appliedHashes: EXPECTED_MIGRATIONS.map(entry => entry.hash),
  authOk: true,
});

test("ready route returns 200 and no-store for a healthy result", async () => {
  const GET = createReadyHandler(async () => healthy);
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).ok, true);
});

test("ready route turns a thrown probe into 503", async () => {
  const GET = createReadyHandler(async () => {
    throw new Error("probe failed");
  });
  const response = await GET();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).db, "error");
});

test("ready route returns 503 when the readiness deadline expires", async () => {
  const GET = createReadyHandler(() => evaluateReadiness(
    () => new Promise<ReadinessSnapshot>(() => {}),
    EXPECTED_MIGRATIONS,
    50,
  ));
  const started = Date.now();
  const response = await GET();
  assert.equal(response.status, 503);
  assert.ok(Date.now() - started < 1_000, "route should not wait for a hung probe");
});

// ------------------------------------------------------------------ S4: detail exposure

const unhealthy = buildReadiness({
  dbOk: true,
  missingTables: ["public.secret_internal_table"],
  missingColumns: ["users.email_verified_at"],
  missingIndexes: ["rate_limits_expires_idx"],
  appliedHashes: [],
  authOk: false,
});

test("ready route hides schema detail outside development and keeps the status code", async () => {
  const GET = createReadyHandler(async () => unhealthy, () => ({ NODE_ENV: "production" }));
  const response = await GET();
  assert.equal(response.status, 503, "a monitor still sees the failure");

  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["auth", "db", "ok"], "only the coarse fields");
  assert.equal(body.ok, false);
  assert.equal(body.db, "ok");
  assert.equal(body.auth, "degraded");

  const serialized = JSON.stringify(body);
  for (const leak of ["secret_internal_table", "email_verified_at", "rate_limits_expires_idx", "pending", "unexpected"]) {
    assert.equal(serialized.includes(leak), false, `${leak} must not reach an unauthenticated caller`);
  }
});

test("ready route keeps full detail in development", async () => {
  const GET = createReadyHandler(async () => unhealthy, () => ({ NODE_ENV: "development" }));
  const body = await (await GET()).json();
  assert.deepEqual(body.schema.missing, ["public.secret_internal_table"]);
  assert.deepEqual(body.schema.missingColumns, ["users.email_verified_at"]);
  assert.deepEqual(body.schema.missingIndexes, ["rate_limits_expires_idx"]);
  assert.ok(body.migrations);
});

test("ready route strips detail from the thrown-probe path too", async () => {
  const GET = createReadyHandler(async () => { throw new Error("probe failed"); }, () => ({ NODE_ENV: "production" }));
  const response = await GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, db: "error", auth: "degraded" });
});

test("ready route: an unset NODE_ENV is treated as non-development", async () => {
  const GET = createReadyHandler(async () => healthy, () => ({}));
  const body = await (await GET()).json();
  assert.deepEqual(Object.keys(body).sort(), ["auth", "db", "ok"]);
});
