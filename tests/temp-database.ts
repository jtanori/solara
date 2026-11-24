import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

export async function createTempDatabase() {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const host = base.hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "integration tests require a loopback database");

  const name = `solara_test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);

  const isolated = new URL(base);
  isolated.pathname = `/${name}`;
  const client = new Client({ connectionString: isolated.toString() });
  await client.connect();

  return {
    client,
    url: isolated.toString(),
    async cleanup() {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
