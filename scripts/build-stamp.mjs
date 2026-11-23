// Build identity: the values that answer "what is serving right now?".
//
// This script is the ONLY place a field is resolved. `src/lib/build-identity.ts`
// parses the stamp it writes and must never re-derive anything; see
// docs/plan-build-identity-164.md §5 for why the split falls here (a `.ts`
// consumer cannot import a `.mjs` under this repo's `allowJs: false`, so a
// shared module is not available and duplicated resolution is the defect being
// avoided).
//
// Runs under `npm run prebuild`. Node 22, no dependencies: `prebuild` runs before
// `next build` and the PDF script's esbuild is a devDependency, so relying on
// installed packages here would make the stamp depend on install order.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export const STAMP_FILE = ".build-stamp.json";

/** The branch whose preview deployments identify themselves as staging. */
export const STAGING_BRANCH = "staging";

export const UNKNOWN = "unknown";

/**
 * `APP_DEPLOY_ENV` first so an explicit setting always wins — that is what makes
 * adopting a paid custom environment later a variable change and not a code
 * change. The branch step exists because Vercel reports `VERCEL_ENV: "preview"`
 * for the staging deployment too, so the environment name alone cannot tell
 * staging from a feature preview.
 */
export function resolveEnv(env = process.env) {
  const explicit = trim(env.APP_DEPLOY_ENV);
  if (explicit) return explicit;

  const vercelEnv = trim(env.VERCEL_ENV);
  if (vercelEnv === "preview") {
    return trim(env.VERCEL_GIT_COMMIT_REF) === STAGING_BRANCH ? "staging" : "preview";
  }
  if (vercelEnv) return vercelEnv;

  return "local";
}

/**
 * `git` is a local-build fallback only: Vercel's own SHA is authoritative on
 * Vercel, and a shallow checkout may not have a usable repository at all.
 */
export function resolveCommit(env = process.env, git = gitOutput) {
  return (
    trim(env.APP_COMMIT_SHA) ||
    trim(env.VERCEL_GIT_COMMIT_SHA) ||
    git(["rev-parse", "HEAD"]) ||
    UNKNOWN
  );
}

/** The tree is what makes a promoted candidate provably identical to staging. */
export function resolveTree(git = gitOutput) {
  return git(["rev-parse", "HEAD^{tree}"]) || UNKNOWN;
}

/**
 * One opaque token naming a specific *artifact*, not a commit: two builds of the
 * same SHA are different releases, which is the distinction a rollback needs.
 */
export function resolveRelease({ envName, source, commit, builtAt }) {
  const explicit = trim(source?.APP_RELEASE_ID);
  if (explicit) return explicit;
  const short = commit === UNKNOWN ? UNKNOWN : commit.slice(0, 7);
  const epoch = Math.floor(new Date(builtAt).getTime() / 1000);
  return `${envName}-${short}-${epoch}`;
}

export function buildStamp(env = process.env, now = () => new Date().toISOString()) {
  const builtAt = now();
  const resolvedEnv = resolveEnv(env);
  const commit = resolveCommit(env);
  return {
    commit,
    tree: resolveTree(),
    release: resolveRelease({ envName: resolvedEnv, source: env, commit, builtAt }),
    env: resolvedEnv,
    builtAt,
  };
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function gitOutput(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "";
  } catch {
    // A non-repository checkout (a tarball, a shallow clone without history)
    // must yield "unknown", never a failed build.
    return "";
  }
}

function main() {
  const stamp = buildStamp();
  const target = resolvePath(process.cwd(), STAMP_FILE);
  writeFileSync(target, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  console.log(
    `build-stamp: commit=${stamp.commit} tree=${stamp.tree} env=${stamp.env} release=${stamp.release}`,
  );
}

// Only write when executed directly, so a test can import the resolvers.
if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname)) {
  main();
}
