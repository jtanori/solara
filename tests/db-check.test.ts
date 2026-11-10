import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createTempDatabase } from "./temp-database";

function run(command: string, args: string[], databaseUrl: string) {
  const env = { ...process.env, DATABASE_URL: databaseUrl, DATABASE_URL_DIRECT: "" };
  return spawnSync(path.resolve(command), args, { encoding: "utf8", env });
}

function migrate(databaseUrl: string) {
  const result = run("node_modules/.bin/drizzle-kit", ["migrate"], databaseUrl);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function check(databaseUrl: string) {
  return run("node_modules/.bin/tsx", ["scripts/db-run.ts", "--env", "local", "verify", "--json"], databaseUrl);
}

test("db:check detects pending, unexpected and missing schema drift", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const database = await createTempDatabase();
  try {
    migrate(database.url);

    const clean = check(database.url);
    assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
    assert.equal(JSON.parse(clean.stdout).ok, true);

    const last = await database.client.query<{ id: number; hash: string; created_at: string }>(
      "select id, hash, created_at from drizzle.__drizzle_migrations order by id desc limit 1",
    );
    const row = last.rows[0];
    assert.ok(row);

    await database.client.query("delete from drizzle.__drizzle_migrations where id = $1", [row.id]);
    const pending = check(database.url);
    assert.equal(pending.status, 1);
    assert.equal(JSON.parse(pending.stdout).pending.length, 1);

    await database.client.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
      [row.hash, row.created_at],
    );
    await database.client.query(
      "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
      ["unexpected-migration-hash", Date.now()],
    );
    const unexpected = check(database.url);
    assert.equal(unexpected.status, 1);
    assert.deepEqual(JSON.parse(unexpected.stdout).unexpected, ["unexpected-migration-hash"]);

    await database.client.query("delete from drizzle.__drizzle_migrations where hash = $1", ["unexpected-migration-hash"]);
    await database.client.query("drop index public.rate_limits_expires_idx");
    const missingIndex = check(database.url);
    assert.equal(missingIndex.status, 1);
    assert.deepEqual(JSON.parse(missingIndex.stdout).missingIndexes, ["rate_limits_expires_idx"]);

    await database.client.query("alter table public.users drop column email_verified_at");
    const missingColumn = check(database.url);
    assert.equal(missingColumn.status, 1);
    assert.deepEqual(JSON.parse(missingColumn.stdout).missingColumns, ["users.email_verified_at"]);
  } finally {
    await database.cleanup();
  }
});
