import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

/**
 * The build's own identity, as baked into the bundle by `next.config.ts`.
 *
 * Every value is resolved exactly once, at `prebuild`, by
 * `scripts/build-stamp.mjs`. This module only *reads* the stamp it wrote and
 * returns the values verbatim — it never consults `process.env` to fill a gap
 * and never re-derives `env` or `release`. Two implementations of one resolution
 * order is the defect `docs/plan-build-identity-164.md` §5 exists to prevent,
 * and a parser cannot drift from the writer because it has no opinion to drift.
 */
export type BuildIdentity = {
  commit: string;
  tree: string;
  release: string;
  env: string;
  builtAt: string;
};

export const STAMP_FILE = ".build-stamp.json";

/** Fail closed: a value nobody can determine is the string "unknown", never absent. */
export const UNKNOWN = "unknown";

export const UNKNOWN_IDENTITY: BuildIdentity = {
  commit: UNKNOWN,
  tree: UNKNOWN,
  release: UNKNOWN,
  env: "local",
  builtAt: UNKNOWN,
};

/**
 * Total and synchronous: `next start` re-evaluates `next.config.ts`, so a missing
 * or malformed stamp must not fail a build or a boot. Unknown fields fail closed
 * downstream (#173) instead.
 */
export function readBuildIdentity(file: string = STAMP_FILE): BuildIdentity {
  return parseBuildIdentity(readStampFile(file));
}

/** Reads the raw file, or undefined for any reason it is unreadable. */
export function readStampFile(file: string = STAMP_FILE): string | undefined {
  try {
    // The path is dynamic by design (tests pass a temp file, `next.config.ts`
    // reads the build stamp). Without the hint Turbopack cannot bound the input
    // and traces the whole project into the server output (#213).
    return readFileSync(resolvePath(/* turbopackIgnore: true */ process.cwd(), file), "utf8");
  } catch {
    return undefined;
  }
}

/** Exported so the parser can be tested without touching the filesystem. */
export function parseBuildIdentity(raw: string | undefined): BuildIdentity {
  if (!raw) return UNKNOWN_IDENTITY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNKNOWN_IDENTITY;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return UNKNOWN_IDENTITY;
  }
  const source = parsed as Record<string, unknown>;
  return {
    commit: text(source.commit),
    tree: text(source.tree),
    release: text(source.release),
    // A stamp without an environment is a local artifact, not a hosted one.
    env: text(source.env, "local"),
    builtAt: text(source.builtAt),
  };
}

/**
 * The values `next.config.ts` inlines. Routes read these through
 * `process.env.APP_*`, which `env` has replaced at build time, so a route reports
 * the build's identity rather than the server's runtime environment.
 *
 * `APP_RELEASE_ID` is the one field with a read-time override (D6). It cannot
 * change the stamp's opinion, only supersede it, and the script applies the same
 * precedence when writing — the explicit value is idempotent under both.
 */
export function identityEnv(
  identity: BuildIdentity,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  return {
    APP_COMMIT_SHA: identity.commit,
    APP_TREE_SHA: identity.tree,
    APP_DEPLOY_ENV: identity.env,
    APP_BUILT_AT: identity.builtAt,
    APP_RELEASE_ID: env.APP_RELEASE_ID?.trim() || identity.release,
  };
}

/**
 * The values Next inlined from `next.config.ts` `env`.
 *
 * **Every read is a literal `process.env.APP_*` member expression, never through
 * an alias.** Next replaces those member expressions with string literals at
 * build time; a reference through a parameter or object (`const e = env; e.APP_COMMIT_SHA`)
 * is *not* replaced and silently resolves at runtime instead — which on a
 * production deploy resolves to nothing and reports `"unknown"`. That exact bug
 * was caught by running `npm run start` and curling the endpoint, with every unit
 * test passing. Do not add an `env` parameter here; there is a test asserting
 * this function reports inlined values rather than reading its argument.
 */
export function readAppIdentity(): BuildIdentity {
  return {
    commit: valueOrUnknown(process.env.APP_COMMIT_SHA),
    tree: valueOrUnknown(process.env.APP_TREE_SHA),
    release: valueOrUnknown(process.env.APP_RELEASE_ID),
    env: process.env.APP_DEPLOY_ENV?.trim() || "local",
    builtAt: valueOrUnknown(process.env.APP_BUILT_AT),
  };
}

function text(value: unknown, fallback: string = UNKNOWN): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function valueOrUnknown(value: string | undefined): string {
  return value?.trim() || UNKNOWN;
}
