import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";

const migration = (name: string) => readFileSync(
  path.resolve(process.cwd(), "drizzle", `${name}.sql`),
  "utf8",
);

async function apply(client: Client, name: string) {
  for (const statement of migration(name).split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await client.query(trimmed);
  }
}

async function tempDatabase() {
  const base = new URL(process.env.DATABASE_URL ?? "");
  const host = base.hostname.replace(/^\[|\]$/g, "");
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "Migration tests require a loopback database");

  const name = `solara_migration_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);

  const isolated = new URL(base);
  isolated.pathname = `/${name}`;
  const client = new Client({ connectionString: isolated.toString() });
  await client.connect();

  return {
    client,
    async cleanup() {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

test("0002 never certifies a legacy address without proof", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const database = await tempDatabase();
  try {
    await apply(database.client, "0000_initial");
    await apply(database.client, "0001_rate_limits");
    const inserted = await database.client.query<{ id: string }>(
      "insert into users (name, email, password_hash) values ('Legacy', 'legacy@example.test', 'pending:no-credentials') returning id",
    );
    const userId = inserted.rows[0].id;
    await database.client.query(
      "insert into sessions (token_hash, user_id, expires_at) values ('legacy-session', $1, now() + interval '1 day')",
      [userId],
    );

    await apply(database.client, "0002_email_verification");

    const user = await database.client.query<{ email_verified_at: Date | null }>(
      "select email_verified_at from users where id = $1",
      [userId],
    );
    assert.equal(user.rows[0].email_verified_at, null);

    const sessions = await database.client.query<{ count: string }>(
      "select count(*)::text as count from sessions where user_id = $1",
      [userId],
    );
    assert.equal(sessions.rows[0].count, "0");
  } finally {
    await database.cleanup();
  }
});

test("a fresh database receives the claim and rate-limit schema", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1",
}, async () => {
  const database = await tempDatabase();
  try {
    await apply(database.client, "0000_initial");
    await apply(database.client, "0001_rate_limits");
    await apply(database.client, "0002_email_verification");

    const objects = await database.client.query<{
      email_verified_at: string | null;
      rate_limits: string | null;
      email_tokens: string | null;
    }>(`
      select
        (select column_name from information_schema.columns where table_schema='public' and table_name='users' and column_name='email_verified_at') as email_verified_at,
        to_regclass('public.rate_limits')::text as rate_limits,
        to_regclass('public.email_tokens')::text as email_tokens
    `);
    assert.equal(objects.rows[0].email_verified_at, "email_verified_at");
    assert.equal(objects.rows[0].rate_limits, "rate_limits");
    assert.equal(objects.rows[0].email_tokens, "email_tokens");
  } finally {
    await database.cleanup();
  }
});
