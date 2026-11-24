import { assertDatabaseEnvironment, DatabaseUrlGuardError } from "./url-guard";

/**
 * One boot resolution shared by `src/db/index.ts` and `/api/ready` (#212).
 *
 * The deploy environment and phase are literal `process.env.APP_*` member
 * expressions, so `next.config.ts` inlines the build identity here exactly as it
 * does at the pool module (#164). Keeping one function is the point: readiness
 * previously proved only that *its own* pool could connect, so it returned
 * `ok:true` while every page crashed because the boot guard would have thrown.
 */
export function assertBootDatabase(rawUrl: string | undefined = process.env.DATABASE_URL): void {
  if (!rawUrl) {
    throw new Error("DATABASE_URL is required");
  }
  assertDatabaseEnvironment(rawUrl, {
    deployEnv: process.env.APP_DEPLOY_ENV?.trim() || "local",
    phase: process.env.NEXT_PHASE === "phase-production-build" ? "build" : "runtime",
  });
}

/**
 * Non-throwing form for readiness. Returns a stable code, never a message, URL or
 * host, so the public response path cannot leak configuration.
 */
export function bootGuardFailure(rawUrl: string | undefined = process.env.DATABASE_URL): string | null {
  try {
    assertBootDatabase(rawUrl);
    return null;
  } catch (error) {
    return error instanceof DatabaseUrlGuardError ? error.code : "database_boot_failed";
  }
}
