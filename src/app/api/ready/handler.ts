import { readAppIdentity } from "@/lib/build-identity";
import type { Readiness } from "@/lib/readiness";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * What an unauthenticated caller is allowed to see (auth amendment §S4, decision
 * 1: dev-only detail).
 *
 * `{ ok, db, auth }` is exactly enough for an uptime monitor to tell "database
 * down" from "migration missing" from "healthy" — `ok` false with `db: "ok"`
 * means the schema or migrations are the problem, `db: "error"` means the
 * database is unreachable. Table names, column names, index names and migration
 * counts are a map of what is broken, which is what an attacker wants during an
 * incident and what a human debugging a deploy gets from the function logs,
 * because `readiness.ts` already logs the full snapshot on its internal path.
 *
 * The status code is unchanged (200/503): monitors key off it, and hiding it
 * would break them to hide nothing.
 */
export type PublicReadiness = {
  ok: boolean;
  db: Readiness["db"];
  auth: Readiness["auth"];
  /**
   * Which build refused. Without it a 503 says "something is wrong" but not
   * *which deployment* is wrong, which is the first question during an incident.
   * A commit SHA of a public repository discloses nothing that is not already
   * public — see the denylist test, which still forbids hosts, secrets and
   * migration tags.
   */
  commit: string;
};

export function publicReadiness(readiness: Readiness, commit: string): PublicReadiness {
  return { ok: readiness.ok, db: readiness.db, auth: readiness.auth, commit };
}

/**
 * Detail is development-only. `NODE_ENV` is read per call rather than captured at
 * module load so a test can flip it.
 */
export function detailIsPublic(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development";
}

export function createReadyHandler(
  readiness: () => Promise<Readiness>,
  env: () => Record<string, string | undefined> = () => process.env,
  identity: () => string = () => readAppIdentity().commit,
) {
  return async function GET() {
    const showDetail = detailIsPublic(env());
    // Resolved before the probe: a thrown probe must still name its build, and
    // the catch path has no other way to learn it.
    const commit = identity();
    try {
      const result = await readiness();
      return Response.json(showDetail ? { ...result, commit } : publicReadiness(result, commit), {
        status: result.ok ? 200 : 503,
        headers: NO_STORE,
      });
    } catch {
      const failure: Readiness = {
        ok: false,
        db: "error",
        schema: { missing: [], missingColumns: [], missingIndexes: [] },
        migrations: { pending: 0, unexpected: 0 },
        auth: "degraded",
      };
      return Response.json(
        showDetail ? { ...failure, commit } : publicReadiness(failure, commit),
        { status: 503, headers: NO_STORE },
      );
    }
  };
}
