import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The resolver lives in a `.mjs` and this is a `.ts`, so importing it would fail
// `typecheck` with TS7016 (allowJs: false). Every case therefore drives the
// script as a subprocess and asserts on the artefact it writes — which is the
// contract `next.config.ts` actually consumes, so nothing can drift between
// writer and reader. See docs/plan-build-identity-164.md §5.
const SCRIPT = join(process.cwd(), "scripts", "build-stamp.mjs");

type Stamp = {
  commit: string;
  tree: string;
  release: string;
  env: string;
  builtAt: string;
};

/**
 * Runs the script in a throwaway directory with exactly the given environment.
 * A child env keeps cases isolated: nothing a previous case set can leak in.
 */
function stampWith(env: Record<string, string>): { stamp: Stamp; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "build-stamp-"));
  try {
    // This repo's ProcessEnv declares NODE_ENV required (verified with a
    // minimal `{ PATH: "x" }` repro), and the child needs PATH to find `git`.
    // NODE_ENV is set to production so the child cannot pick up a dev-only path.
    const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "production", ...env };
    if (process.env.PATH) childEnv.PATH = process.env.PATH;
    execFileSync(process.execPath, [SCRIPT], { cwd: dir, env: childEnv, stdio: "pipe" });
    return { stamp: JSON.parse(readFileSync(join(dir, ".build-stamp.json"), "utf8")) as Stamp, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("staging is identified by branch: preview + ref=staging reports staging", () => {
  const { stamp } = stampWith({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging" });
  assert.equal(stamp.env, "staging");
});

test("a feature preview is not staging", () => {
  const feature = stampWith({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature/x" });
  assert.equal(feature.stamp.env, "preview");

  const arena = stampWith({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "arena/0cabd00f-solara" });
  assert.equal(arena.stamp.env, "preview", "only the exact staging branch maps to staging");
});

test("an explicit APP_DEPLOY_ENV wins over the branch, so a custom environment needs no code change", () => {
  const { stamp } = stampWith({
    APP_DEPLOY_ENV: "production",
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "staging",
  });
  assert.equal(stamp.env, "production");
});

test("production is unaffected by the branch ref", () => {
  assert.equal(stampWith({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }).stamp.env, "production");
  assert.equal(stampWith({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "staging" }).stamp.env, "production");
});

test("no Vercel context reports local", () => {
  assert.equal(stampWith({}).stamp.env, "local");
});

test("resolution order per field: APP_COMMIT_SHA beats VERCEL_GIT_COMMIT_SHA", () => {
  const explicit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const vercel = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  assert.equal(stampWith({ APP_COMMIT_SHA: explicit, VERCEL_GIT_COMMIT_SHA: vercel }).stamp.commit, explicit);
  assert.equal(stampWith({ VERCEL_GIT_COMMIT_SHA: vercel }).stamp.commit, vercel);
});

test("release shape is <env>-<7>-<epoch>, and an explicit APP_RELEASE_ID wins", () => {
  const generated = stampWith({ VERCEL_ENV: "preview", APP_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567" });
  assert.match(generated.stamp.release, /^preview-0123456-\d+$/, generated.stamp.release);

  const explicit = stampWith({ APP_RELEASE_ID: "custom-123", VERCEL_ENV: "preview" });
  assert.equal(explicit.stamp.release, "custom-123");
});

test("no git and no Vercel turns every field into a determinate unknown, not a throw", () => {
  // Exit code 0 is the assertion for "did not throw": an uncaught error would
  // surface as a non-zero status from the child.
  const { stamp } = stampWith({});
  assert.equal(stamp.commit, "unknown");
  assert.equal(stamp.tree, "unknown");
  assert.equal(stamp.env, "local");
  assert.equal(stamp.release, "local-unknown-" + stamp.release.split("-").pop());
});

test("the stamp is byte-stable for identical inputs", () => {
  const first = stampWith({ APP_COMMIT_SHA: "abcdef1234567890", VERCEL_ENV: "preview" }).stamp;
  const second = stampWith({ APP_COMMIT_SHA: "abcdef1234567890", VERCEL_ENV: "preview" }).stamp;
  // `builtAt` is the run clock and `release` embeds its epoch, so two child
  // builds can legitimately differ across a second boundary. Freeze both before
  // comparing; the release shape has its own test.
  const stable = (stamp: typeof first) =>
    JSON.stringify(stamp).replace(/"builtAt":"[^"]*"/, "").replace(/"release":"[^"]*"/, "");
  assert.deepEqual(Object.keys(first), Object.keys(second), "key order is fixed, not incidental");
  assert.equal(first.commit, second.commit);
  assert.equal(first.env, second.env);
  assert.equal(stable(first), stable(second));
  assert.match(first.builtAt, /^\d{4}-\d{2}-\d{2}T/);
});
