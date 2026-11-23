import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDatabaseEnvironment,
  DatabaseUrlGuardError,
  databaseEndpoint,
  type DatabaseGuardOptions,
} from "../src/db/url-guard";

/*
 * #168 — one pure guard, no database connection. Every row of the M5 table has a
 * failing and a passing case; the build placeholder, TLS folding and migration
 * pooler rule are separate cases. A mutation run is recorded in the PR body.
 */

const prod = "postgresql://user:pass@ep-prod-pooler.us-east-2.aws.neon.tech/app?sslmode=verify-full";
const prodDirect = "postgresql://user:pass@ep-prod.us-east-2.aws.neon.tech/app?sslmode=verify-full";
const staging = "postgresql://user:pass@ep-stage-pooler.us-east-2.aws.neon.tech/app?sslmode=verify-full";
const preview = "postgresql://user:pass@ep-pr-123-pooler.us-east-2.aws.neon.tech/app?sslmode=verify-full";
const local = "postgresql://postgres:postgres@localhost:5432/app";

const env = { PROD_DB_ENDPOINT: "ep-prod", STAGING_DB_ENDPOINT: "ep-stage" };

function codeOf(run: () => void): string {
  try {
    run();
    return "no-error";
  } catch (error) {
    return error instanceof DatabaseUrlGuardError ? error.code : "other";
  }
}

function messageOf(run: () => void): string {
  try {
    run();
    return "no-error";
  } catch (error) {
    return error instanceof Error ? error.message : "other";
  }
}

function check(url: string, options: Partial<DatabaseGuardOptions>): string {
  return codeOf(() => assertDatabaseEnvironment(url, { deployEnv: "local", env, ...options }));
}

test("endpoint derivation strips only the pooler suffix", () => {
  assert.equal(databaseEndpoint(prod), "ep-prod");
  assert.equal(databaseEndpoint(prodDirect), "ep-prod");
  assert.equal(databaseEndpoint(staging), "ep-stage");
  assert.equal(databaseEndpoint("postgresql://u:p@db.example.com/app"), "db");
});

test("production must use PROD_DB_ENDPOINT", () => {
  assert.equal(check(prod, { deployEnv: "production" }), "no-error");
  assert.equal(check(staging, { deployEnv: "production" }), "database_url_endpoint_mismatch");
  assert.equal(check(prod, { deployEnv: "production", env: {} }), "database_url_endpoint_unset");
});

test("staging must use STAGING_DB_ENDPOINT", () => {
  assert.equal(check(staging, { deployEnv: "staging" }), "no-error");
  assert.equal(check(prod, { deployEnv: "staging" }), "database_url_endpoint_mismatch");
});

test("preview is strict: neither production nor staging", () => {
  assert.equal(check(preview, { deployEnv: "preview" }), "no-error");
  assert.equal(check(prod, { deployEnv: "preview" }), "database_url_preview_unapproved");
  assert.equal(check(staging, { deployEnv: "preview" }), "database_url_preview_unapproved");
  assert.equal(check(preview, { deployEnv: "preview", env: {} }), "database_url_endpoint_unset");
  // A second database on the same staging compute shares the endpoint and is rejected.
  assert.equal(
    check("postgresql://user:pass@ep-stage-pooler.us-east-2.aws.neon.tech/other?sslmode=verify-full", { deployEnv: "preview" }),
    "database_url_preview_unapproved",
  );
});

test("preview quarantine: a loopback URL is allowed", () => {
  assert.equal(check(local, { deployEnv: "preview" }), "no-error");
});

test("the documented preview staging exception is explicit and opt-in", () => {
  assert.equal(check(staging, { deployEnv: "preview", env: { ...env, ALLOW_PREVIEW_ON_STAGING: "1" } }), "no-error");
  assert.equal(check(preview, { deployEnv: "preview", env: { ...env, ALLOW_PREVIEW_ON_STAGING: "1" } }), "database_url_preview_unapproved");
});

test("local must use loopback; hosted environments must not", () => {
  assert.equal(check(local, { deployEnv: "local" }), "no-error");
  assert.equal(check(prod, { deployEnv: "local" }), "database_url_local_not_loopback");
  assert.equal(check(local, { deployEnv: "production" }), "database_url_hosted_loopback");
  assert.equal(check(local, { deployEnv: "staging" }), "database_url_hosted_loopback");
});

test("an unknown or empty deploy environment fails closed", () => {
  assert.equal(check(prod, { deployEnv: "" }), "database_url_environment");
  assert.equal(check(prod, { deployEnv: "qa" }), "database_url_environment");
});

test("migrations reject a pooled host", () => {
  assert.equal(check(prod, { deployEnv: "production", forMigration: true }), "database_url_pooler_migration");
  assert.equal(check(prodDirect, { deployEnv: "production", forMigration: true }), "no-error");
});

test("TLS is folded in, without the URL in the message", () => {
  const disabled = "postgresql://user:pass@ep-prod-pooler.us-east-2.aws.neon.tech/app?sslmode=disable";
  assert.equal(check(disabled, { deployEnv: "production" }), "database_url_tls");
  const message = messageOf(() => assertDatabaseEnvironment(disabled, { deployEnv: "production", env }));
  assert.equal(message.includes("ep-"), false);
  assert.equal(message.includes("postgres"), false);
  assert.equal(message.includes("user:pass"), false);
});

test("error messages never echo the URL or host", () => {
  for (const options of [
    { deployEnv: "production" },
    { deployEnv: "staging" },
    { deployEnv: "preview" },
    { deployEnv: "production", env: {} },
  ]) {
    const message = messageOf(() => assertDatabaseEnvironment(staging, { env, ...options }));
    assert.equal(message.includes("ep-"), false, JSON.stringify(options));
    assert.equal(message.includes("postgres"), false, JSON.stringify(options));
    assert.equal(message.includes("user:pass"), false, JSON.stringify(options));
  }
});

test("a loopback placeholder is allowed only in the build phase", () => {
  assert.equal(check(local, { deployEnv: "production", phase: "build" }), "no-error");
  assert.equal(check(local, { deployEnv: "production", phase: "runtime" }), "database_url_hosted_loopback");
});

test("an invalid URL fails closed with a stable code", () => {
  assert.equal(check("not-a-url", { deployEnv: "local" }), "database_url_invalid");
  assert.equal(check("mysql://user:pass@db.example.com/app", { deployEnv: "local" }), "database_url_invalid");
});
