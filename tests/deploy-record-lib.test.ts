import assert from "node:assert/strict";
import test from "node:test";
import {
  commentBody,
  decideRecord,
  releaseBody,
  releaseTag,
  recordRow,
  shortSha,
  WORKFLOW_MARKER,
} from "../scripts/lib/deploy-record";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

test("a deployment that proves its identity is recorded as ok", () => {
  const decision = decideRecord(SHA, {
    vercel: "success",
    version: { commit: SHA, env: "production" },
    ready: { ok: true, migrations: "exact" },
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.result, "ok");
  assert.equal(decision.migrations, "exact");
  assert.equal(decision.releaseEligible, true);
});

test("a deployment serving another commit is unverified, with that commit named", () => {
  const decision = decideRecord(SHA, {
    vercel: "success",
    version: { commit: "0".repeat(40), env: "production" },
    ready: { ok: true, migrations: "exact" },
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "version");
  assert.match(decision.result, /FAILED unverified \(version 0000000\)/);
  // The merge did reach main and Vercel built it, so the marker is still created.
  assert.equal(decision.releaseEligible, true);
});

test("a staging alias can never satisfy a production record", () => {
  const decision = decideRecord(SHA, {
    vercel: "success",
    version: { commit: SHA, env: "staging" },
    ready: { ok: true, migrations: "exact" },
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "env");
  assert.match(decision.result, /env staging/);
});

test("missing version or failed readiness is unverified, never ok", () => {
  const noVersion = decideRecord(SHA, { vercel: "success", version: null, ready: null });
  assert.equal(noVersion.ok, false);
  assert.equal(noVersion.reason, "version");

  const notReady = decideRecord(SHA, {
    vercel: "success",
    version: { commit: SHA, env: "production" },
    ready: { ok: false, migrations: "behind" },
  });
  assert.equal(notReady.ok, false);
  assert.equal(notReady.reason, "readiness");
  assert.equal(notReady.migrations, "behind");
});

test("a failed or timed-out Vercel build creates no release", () => {
  for (const probe of [
    { vercel: "failure" as const, version: null, ready: null },
    { vercel: "error" as const, version: null, ready: null },
    { vercel: "timeout" as const, version: null, ready: null, timedOut: "vercel" as const },
  ]) {
    const decision = decideRecord(SHA, probe);
    assert.equal(decision.ok, false);
    assert.equal(decision.releaseEligible, false, `no release for ${probe.vercel}`);
    assert.match(decision.result, /FAILED not deployed/);
  }
});

test("the release tag is deterministic per commit", () => {
  assert.equal(releaseTag(SHA), "deploy/production/abcdef0");
  assert.equal(releaseTag(SHA), releaseTag(SHA));
  assert.equal(shortSha(SHA), "abcdef0");
});

test("the comment carries the workflow marker exactly once and states the verdict", () => {
  const ok = decideRecord(SHA, {
    vercel: "success",
    version: { commit: SHA, env: "production" },
    ready: { ok: true, migrations: "exact" },
  });
  const body = commentBody({ header: "| when |", row: "| row |", decision: ok, tag: "deploy/production/abcdef0" });
  assert.equal(body.split(WORKFLOW_MARKER).length - 1, 1);
  assert.match(body, /Verified by/);
  assert.match(body, /Release: `deploy\/production\/abcdef0`\./);

  const unverified = decideRecord(SHA, { vercel: "success", version: null, ready: null });
  const failure = commentBody({ header: "| when |", row: "| row |", decision: unverified, tag: null });
  assert.match(failure, /\*\*Unverified\.\*\*/);
  assert.match(failure, /No release:/);
});

test("the release body names the result and the commit", () => {
  const decision = decideRecord(SHA, { vercel: "success", version: null, ready: null });
  const body = releaseBody({ sha: SHA, pr: 249, timestamp: "2026-11-25T01:00Z", decision });
  assert.match(body, /Production deploy of `abcdef0` \(PR #249, 2026-11-25T01:00Z\)\./);
  assert.match(body, /Verification: FAILED unverified/);
});

test("the row renders a missing PR as an em dash, not a blank", () => {
  const decision = decideRecord(SHA, { vercel: "failure", version: null, ready: null });
  const row = recordRow({ sha: SHA, pr: null, timestamp: "2026-11-25T01:00Z", decision });
  assert.equal(row.pr, "—");
  assert.equal(row.env, "production");
  assert.equal(row.rollback, "—");
});
