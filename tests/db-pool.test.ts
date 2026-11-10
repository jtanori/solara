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
});

test("the pool attaches an error listener", () => {
  const pool = createDatabasePool("postgresql://postgres:postgres@localhost:5432/app", {});
  try {
    assert.ok(pool.listenerCount("error") > 0);
  } finally {
    void pool.end();
  }
});
