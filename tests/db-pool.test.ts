import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { createDatabasePool, databasePoolConfig } from "../src/db";

test("hosted database URLs use explicit TLS verification and bounded pool settings", () => {
  const config = databasePoolConfig(
    "postgresql://user:pass@db.example.com/app?sslmode=require",
    { DB_POOL_MAX: "4" },
  );
  assert.equal(config.max, 4);
  assert.equal(config.idleTimeoutMillis, 30_000);
  assert.equal(config.connectionTimeoutMillis, 10_000);
  assert.equal(config.options, "-c statement_timeout=15000");
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
