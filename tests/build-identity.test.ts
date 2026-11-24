import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  identityEnv,
  parseBuildIdentity,
  readAppIdentity,
  readBuildIdentity,
  UNKNOWN_IDENTITY,
} from "../src/lib/build-identity";

const complete = JSON.stringify({
  commit: "60c6deba3cbb19cde630242bc9ad1cbdf7cebd40",
  tree: "9c41f0c0f00d",
  release: "staging-60c6deb-1795378343",
  env: "staging",
  builtAt: "2026-11-22T20:12:23.632Z",
});

test("a complete stamp is returned verbatim", () => {
  assert.deepEqual(parseBuildIdentity(complete), {
    commit: "60c6deba3cbb19cde630242bc9ad1cbdf7cebd40",
    tree: "9c41f0c0f00d",
    release: "staging-60c6deb-1795378343",
    env: "staging",
    builtAt: "2026-11-22T20:12:23.632Z",
  });
});

test("the parser does not resolve: it has no second opinion about env", () => {
  // Ambient reality says production; the stamp says staging. The stamp wins,
  // because resolution happened once, at prebuild.
  const identity = parseBuildIdentity(complete);
  assert.equal(identity.env, "staging");
});

test("an absent stamp yields unknowns and a local env, never a throw", () => {
  assert.deepEqual(parseBuildIdentity(undefined), UNKNOWN_IDENTITY);
  assert.equal(UNKNOWN_IDENTITY.env, "local");
  assert.equal(UNKNOWN_IDENTITY.commit, "unknown");
});

test("a malformed stamp is caught, not propagated", () => {
  assert.deepEqual(parseBuildIdentity("{not json"), UNKNOWN_IDENTITY);
  assert.deepEqual(parseBuildIdentity("[]"), UNKNOWN_IDENTITY, "an array is not a stamp");
  assert.deepEqual(parseBuildIdentity("null"), UNKNOWN_IDENTITY);
  assert.deepEqual(parseBuildIdentity('"a string"'), UNKNOWN_IDENTITY);
});

test("partial fields are kept where present and unknown where missing", () => {
  const partial = parseBuildIdentity(JSON.stringify({ commit: "abc1234" }));
  assert.equal(partial.commit, "abc1234");
  assert.equal(partial.tree, "unknown", "missing fields are unknown, never empty strings");
  assert.equal(partial.release, "unknown");
  assert.equal(partial.builtAt, "unknown");
  assert.equal(partial.env, "local", "a stamp with no environment is a local artifact");
});

test("builtAt is the stamp's, not the moment of reading", () => {
  const past = "2020-01-01T00:00:00.000Z";
  const identity = parseBuildIdentity(JSON.stringify({ ...JSON.parse(complete), builtAt: past }));
  assert.equal(identity.builtAt, past);
});

test("readBuildIdentity absorbs a missing file on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "identity-"));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    assert.deepEqual(readBuildIdentity(), UNKNOWN_IDENTITY);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readBuildIdentity reads a stamp on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "identity-"));
  const previous = process.cwd();
  try {
    writeFileSync(join(dir, ".build-stamp.json"), complete);
    process.chdir(dir);
    assert.equal(readBuildIdentity().env, "staging");
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("identityEnv inlines the stamp and lets an explicit APP_RELEASE_ID supersede it", () => {
  const identity = parseBuildIdentity(complete);
  assert.deepEqual(identityEnv(identity, {}), {
    APP_COMMIT_SHA: "60c6deba3cbb19cde630242bc9ad1cbdf7cebd40",
    APP_TREE_SHA: "9c41f0c0f00d",
    APP_DEPLOY_ENV: "staging",
    APP_BUILT_AT: "2026-11-22T20:12:23.632Z",
    APP_RELEASE_ID: "staging-60c6deb-1795378343",
  });
  assert.equal(
    identityEnv(identity, { APP_RELEASE_ID: "override-1" }).APP_RELEASE_ID,
    "override-1",
  );
});

test("readAppIdentity reads process.env literally, which is what Next inlines", () => {
  // The bug this guards: an earlier version took `env = process.env` as a
  // parameter and read `env.APP_COMMIT_SHA`. Next only replaces the *literal*
  // member expression `process.env.APP_COMMIT_SHA` at build time, so the
  // parameterised version silently resolved at runtime and reported "unknown"
  // on a real server while every test here passed. Asserting the function's
  // arity keeps a future refactor from reintroducing the alias.
  assert.equal(readAppIdentity.length, 0, "must take no env parameter, or inlining is defeated");
});

test("readAppIdentity reads the inlined variables and falls back to unknown", () => {
  // It reads the module-level process.env, by design: Next only replaces literal
  // `process.env.APP_*` member expressions at build time, so taking an env
  // parameter would defeat the inlining and silently return runtime values.
  const saved = { ...process.env };
  try {
    delete process.env.APP_COMMIT_SHA;
    delete process.env.APP_TREE_SHA;
    delete process.env.APP_RELEASE_ID;
    delete process.env.APP_BUILT_AT;
    delete process.env.APP_DEPLOY_ENV;
    assert.deepEqual(readAppIdentity(), {
      commit: "unknown",
      tree: "unknown",
      release: "unknown",
      env: "local",
      builtAt: "unknown",
    });

    process.env.APP_COMMIT_SHA = "abc1234";
    process.env.APP_DEPLOY_ENV = "staging";
    const withValues = readAppIdentity();
    assert.equal(withValues.commit, "abc1234");
    assert.equal(withValues.env, "staging");
  } finally {
    for (const key of ["APP_COMMIT_SHA", "APP_TREE_SHA", "APP_RELEASE_ID", "APP_BUILT_AT", "APP_DEPLOY_ENV"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
