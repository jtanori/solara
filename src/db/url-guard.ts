import { isLoopbackHost, normalizeDatabaseUrl } from "../lib/database-url";

/**
 * One guard for the database environment (#168).
 *
 * The app boot, `db-run` and `drizzle.config.ts` all call this module. It is a
 * pure identity check: parse the URL, fold in the existing TLS rules, derive the
 * Neon endpoint, and compare it with the environment's expected endpoint.
 * It never connects to a database, logs a URL or reads a credential.
 */

export type GuardDeployEnv = "local" | "staging" | "production" | "preview";
export type GuardPhase = "build" | "runtime";

export type DatabaseGuardOptions = {
  /** Resolved by the caller (#164's identity for the app; --env in db-run). */
  deployEnv: string;
  /** Environment map; defaults to process.env for the production callers. */
  env?: Record<string, string | undefined>;
  /** Migrations must never use the pooled Neon host. */
  forMigration?: boolean;
  /** A loopback placeholder is allowed only while Next builds. */
  phase?: GuardPhase;
};

export type DatabaseGuardCode =
  | "database_url_invalid"
  | "database_url_tls"
  | "database_url_environment"
  | "database_url_local_not_loopback"
  | "database_url_hosted_loopback"
  | "database_url_pooler_migration"
  | "database_url_endpoint_unset"
  | "database_url_endpoint_mismatch"
  | "database_url_preview_unapproved";

export class DatabaseUrlGuardError extends Error {
  constructor(readonly code: DatabaseGuardCode, message: string) {
    super(message);
    this.name = "DatabaseUrlGuardError";
  }
}

export const DATABASE_GUARD_ENVIRONMENTS: readonly GuardDeployEnv[] = ["local", "staging", "production", "preview"];

/** First hostname label, with a trailing -pooler removed. */
export function databaseEndpoint(rawUrl: string): string {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  const first = hostname.split(".")[0] ?? "";
  return first.endsWith("-pooler") ? first.slice(0, -7) : first;
}

function parse(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DatabaseUrlGuardError("database_url_invalid", "DATABASE_URL is not a valid URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseUrlGuardError("database_url_invalid", "DATABASE_URL must use the postgres protocol");
  }
  return url;
}

function expectedEndpoint(
  deployEnv: GuardDeployEnv,
  env: Record<string, string | undefined>,
): { variable: "PROD_DB_ENDPOINT" | "STAGING_DB_ENDPOINT"; value: string } {
  const variable = deployEnv === "production" ? "PROD_DB_ENDPOINT" : "STAGING_DB_ENDPOINT";
  const value = env[variable]?.trim().toLowerCase() ?? "";
  if (!value) {
    throw new DatabaseUrlGuardError(
      "database_url_endpoint_unset",
      `${variable} is required for ${deployEnv} DATABASE_URL`,
    );
  }
  return { variable, value };
}

function assertPreviewIsolation(
  endpoint: string,
  env: Record<string, string | undefined>,
): void {
  if (env.ALLOW_PREVIEW_ON_STAGING === "1") {
    const staging = expectedEndpoint("staging", env);
    if (endpoint !== staging.value) {
      throw new DatabaseUrlGuardError(
        "database_url_preview_unapproved",
        "preview DATABASE_URL must use the staging endpoint when ALLOW_PREVIEW_ON_STAGING=1",
      );
    }
    return;
  }

  // Strict previews: both endpoints must be known so "neither" is provable.
  const production = expectedEndpoint("production", env);
  const staging = expectedEndpoint("staging", env);
  if (endpoint === production.value || endpoint === staging.value) {
    throw new DatabaseUrlGuardError(
      "database_url_preview_unapproved",
      "preview DATABASE_URL must use an isolated endpoint, not the staging or production endpoint",
    );
  }
}

export function assertDatabaseEnvironment(rawUrl: string, options: DatabaseGuardOptions): void {
  const env = options.env ?? process.env;
  const phase = options.phase ?? "runtime";
  const url = parse(rawUrl);

  // Fold in the existing TLS policy instead of duplicating it. The thrown message
  // is fixed text and contains no URL or host.
  try {
    normalizeDatabaseUrl(rawUrl);
  } catch {
    throw new DatabaseUrlGuardError(
      "database_url_tls",
      "DATABASE_URL must not disable TLS; hosted databases require sslmode=verify-full",
    );
  }

  const deployEnv = options.deployEnv?.trim().toLowerCase();
  if (!deployEnv || !DATABASE_GUARD_ENVIRONMENTS.includes(deployEnv as GuardDeployEnv)) {
    throw new DatabaseUrlGuardError(
      "database_url_environment",
      "APP_DEPLOY_ENV must be local, staging, production or preview",
    );
  }
  const environment = deployEnv as GuardDeployEnv;
  const endpoint = databaseEndpoint(rawUrl);
  const loopback = isLoopbackHost(url.hostname);
  const pooled = url.hostname.toLowerCase().includes("-pooler.");

  if (options.forMigration && pooled) {
    throw new DatabaseUrlGuardError(
      "database_url_pooler_migration",
      "migration DATABASE_URL must use the direct endpoint, not a -pooler host",
    );
  }

  // The build must be able to evaluate a non-routable placeholder. This is the
  // only bypass, it is explicit, and runtime callers never pass "build".
  if (phase === "build" && loopback) return;

  if (environment === "local") {
    if (!loopback) {
      throw new DatabaseUrlGuardError(
        "database_url_local_not_loopback",
        "local DATABASE_URL must use a loopback host",
      );
    }
    return;
  }

  if (environment === "preview") {
    // A preview with no hosted database is the quarantine state.
    if (loopback) return;
    assertPreviewIsolation(endpoint, env);
    return;
  }

  if (loopback) {
    throw new DatabaseUrlGuardError(
      "database_url_hosted_loopback",
      `${environment} DATABASE_URL must not use a loopback host`,
    );
  }

  const expected = expectedEndpoint(environment, env);
  if (endpoint !== expected.value) {
    throw new DatabaseUrlGuardError(
      "database_url_endpoint_mismatch",
      `${environment} DATABASE_URL must use the endpoint in ${expected.variable}`,
    );
  }
}
