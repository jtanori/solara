import assert from "node:assert/strict";
import test from "node:test";
import { fixtureGuard, realProviderGuard } from "../scripts/lib/free-path-guard";

const loopback = { DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/app_db" };

test("fixture mode accepts a disposable loopback database", () => {
  assert.deepEqual(fixtureGuard(loopback), { ok: true });
  assert.deepEqual(fixtureGuard({ ...loopback, DATABASE_URL: "postgresql://u:p@localhost:5432/db" }), { ok: true });
});

test("fixture mode refuses a hosted database", () => {
  const decision = fixtureGuard({ ...loopback, DATABASE_URL: "postgresql://u:p@ep-cool-123.neon.tech/db" });
  assert.equal(decision.ok, false);
  assert.match(decision.ok === false ? decision.reason : "", /loopback/);
});

test("fixture mode refuses Vercel and production", () => {
  assert.equal(fixtureGuard({ ...loopback, VERCEL: "1" }).ok, false);
  assert.equal(fixtureGuard({ ...loopback, VERCEL_ENV: "preview" }).ok, false);
  assert.equal(fixtureGuard({ ...loopback, NODE_ENV: "production" }).ok, false);
  assert.equal(fixtureGuard({}).ok, false);
});

test("real-provider mode requires authorization, a cap, and no CI", () => {
  const base = { ...loopback };
  assert.deepEqual(
    realProviderGuard(base, { authorized: true, maxSpendMxn: 30, cases: 6, ceilingMxn: 5 }),
    { ok: true },
  );
  assert.equal(realProviderGuard(base, { authorized: false, maxSpendMxn: 30, cases: 6, ceilingMxn: 5 }).ok, false);
  assert.equal(realProviderGuard(base, { authorized: true, maxSpendMxn: 0, cases: 6, ceilingMxn: 5 }).ok, false);
  assert.equal(realProviderGuard(base, { authorized: true, maxSpendMxn: 29, cases: 6, ceilingMxn: 5 }).ok, false);
  assert.equal(realProviderGuard({ ...base, CI: "true" }, { authorized: true, maxSpendMxn: 30, cases: 6, ceilingMxn: 5 }).ok, false);
  assert.equal(
    realProviderGuard({ ...base, DATABASE_URL: "postgresql://u:p@ep-cool-123.neon.tech/db" }, {
      authorized: true, maxSpendMxn: 30, cases: 6, ceilingMxn: 5,
    }).ok,
    false,
  );
});
