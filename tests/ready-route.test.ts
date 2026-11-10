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
