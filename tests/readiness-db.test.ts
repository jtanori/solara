import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";
import test from "node:test";
import { probeReadiness } from "../src/lib/readiness";
import { createTempDatabase } from "./temp-database";

test("readiness probes the real database and reports missing schema", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const database = await createTempDatabase();
  const env = { ...process.env, DATABASE_URL: database.url, DATABASE_URL_DIRECT: "" };
  const migrated = spawnSync(path.resolve("node_modules/.bin/drizzle-kit"), ["migrate"], {
    encoding: "utf8",
    env,
  });
  assert.equal(migrated.status, 0, `${migrated.stdout}\n${migrated.stderr}`);

  const pool = new Pool({ connectionString: database.url, max: 1, connectionTimeoutMillis: 250 });
  try {
    const ready = await probeReadiness(pool);
    assert.equal(ready.dbOk, true);
    assert.deepEqual(ready.missingTables, []);
    assert.deepEqual(ready.missingColumns, []);
    assert.deepEqual(ready.missingIndexes, []);
    assert.equal(ready.authOk, true);

    await database.client.query("drop table public.email_tokens");
    const missing = await probeReadiness(pool);
    assert.equal(missing.dbOk, true);
    assert.deepEqual(missing.missingTables, ["public.email_tokens"]);
  } finally {
    await pool.end();
    await database.cleanup();
  }
});
