import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { coordinationPoolConfig, createDatabasePool, databasePoolConfig } from "../src/db";
import { FINAL_DELETE_STATEMENT_TIMEOUT_MS } from "../src/app/api/profile/route";

test("hosted database URLs use explicit TLS verification and bounded pool settings", () => {
  const config = databasePoolConfig(
    "postgresql://user:pass@db.example.com/app?sslmode=require",
    { DB_POOL_MAX: "4" },
  );
  assert.equal(config.max, 4);
  assert.equal(config.idleTimeoutMillis, 30_000);
  assert.equal(config.connectionTimeoutMillis, 10_000);
  assert.equal(config.query_timeout, 15_000);
  assert.equal(config.application_name, "solara-app");
  assert.equal(config.options, undefined);
  assert.match(String(config.connectionString), /sslmode=verify-full/);
});

test("all hosted TLS modes are normalized to verify-full", () => {
  for (const mode of ["no-verify", "verify-ca", "allow", "prefer", "require"]) {
    const config = databasePoolConfig(`postgresql://user:pass@db.example.com/app?sslmode=${mode}`, {});
    assert.match(String(config.connectionString), /sslmode=verify-full/, mode);
    assert.doesNotMatch(String(config.connectionString), new RegExp(`sslmode=${mode}`));
  }

  const absent = databasePoolConfig("postgresql://user:pass@db.example.com/app", {});
  assert.match(String(absent.connectionString), /sslmode=verify-full/);

  const sslTrue = databasePoolConfig("postgresql://user:pass@db.example.com/app?ssl=true", {});
  assert.match(String(sslTrue.connectionString), /sslmode=verify-full/);
  assert.doesNotMatch(String(sslTrue.connectionString), /[?&]ssl=/);
});

test("local loopback URLs keep their connection form", () => {
  const config = databasePoolConfig("postgresql://postgres:postgres@localhost:5432/app", {});
  assert.equal(config.max, 5);
  assert.doesNotMatch(String(config.connectionString), /sslmode=/);
});

test("hosted TLS cannot be disabled", () => {
  assert.throws(
    () => databasePoolConfig("postgresql://user:pass@db.example.com/app?sslmode=disable", {}),
    /must not disable TLS/,
  );
  assert.throws(
    () => databasePoolConfig("postgresql://user:pass@db.example.com/app?ssl=false", {}),
    /must not disable TLS/,
  );
  assert.throws(
    () => databasePoolConfig("postgresql://user:pass@db.example.com/app?ssl=0", {}),
    /must not disable TLS/,
  );
});

test("the pool attaches an error listener", async () => {
  const pool = createDatabasePool("postgresql://postgres:postgres@localhost:5432/app", {});
  try {
    assert.ok(pool.listenerCount("error") > 0);
  } finally {
    await pool.end();
  }
});

test("the coordination pool is small, named, and bounded", () => {
  const defaults = coordinationPoolConfig("postgresql://user:pass@db.example.com/app", {});
  assert.equal(defaults.max, 3);
  assert.equal(defaults.application_name, "solara-coordination");
  assert.equal(defaults.idleTimeoutMillis, 30_000);
  assert.equal(defaults.connectionTimeoutMillis, 10_000);
  assert.equal(defaults.query_timeout, 15_000);
  assert.equal(defaults.allowExitOnIdle, true);
  assert.match(String(defaults.connectionString), /sslmode=verify-full/);

  assert.equal(coordinationPoolConfig("postgresql://user:pass@db.example.com/app", { DB_COORDINATION_POOL_MAX: "4" }).max, 4);
  assert.equal(coordinationPoolConfig("postgresql://user:pass@db.example.com/app", { DB_COORDINATION_POOL_MAX: "99" }).max, 10);
  assert.equal(coordinationPoolConfig("postgresql://user:pass@db.example.com/app", { DB_COORDINATION_POOL_MAX: "0" }).max, 3);
  assert.equal(coordinationPoolConfig("postgresql://user:pass@db.example.com/app", { DB_COORDINATION_POOL_MAX: "nope" }).max, 3);
});

test("the final deletion timeout stays below the app-pool query timeout", () => {
  const config = databasePoolConfig("postgresql://postgres:postgres@localhost:5432/app", {});
  assert.ok(FINAL_DELETE_STATEMENT_TIMEOUT_MS < Number(config.query_timeout));
});
