# #168 — one database environment guard

**Status:** proposed. **Baseline:** `origin/staging` at `31feb44` (after #204 build
identity and #206 destructive-DDL gate). **Issue:** #168.

**Decisions confirmed (2026-11-23):** keep `DATABASE_URL` (pooled app) and
`DATABASE_URL_DIRECT` (migrations) as two distinct names; `NEXT_PHASE` is the
build signal; preview isolation is **strict**, using a per-PR Neon branch in the
staging project with its own endpoint. The local `.env.production` is out of sync
with Vercel/GitHub and will be reconciled when production is ready.

This plan expands the M5 guard table into one module, three consumers, a build
placeholder rule and a test/mutation matrix. It does not authorize a hosted
database change, deployment, or a new credential.

## 1. Problem

Vercel environment scoping is invisible to the app. A staging deployment, a
feature preview, or a local shell can be handed the production `DATABASE_URL`
and nothing in the code refuses it. The only current checks are in
`scripts/db-run.ts`, and they cover only the migration path; the app boot and
`drizzle.config.ts` have no identity check.

## 2. Verified baseline

- `src/db/index.ts` reads `DATABASE_URL` and creates both pools at module load.
  It has no environment or endpoint check.
- `src/lib/database-url.ts` owns `normalizeDatabaseUrl` (hosted TLS must be
  `verify-full`; `disable` is rejected), `isLoopbackHost`, and the pool caps.
- `scripts/db-run.ts` has a partial `assertEnvironment`: it rejects hosted
  loopback and pooled migration URLs, but its messages include the host and it
  is not shared with the app or Drizzle config.
- `drizzle.config.ts` uses `DATABASE_URL` directly.
- #164 (`31feb44`) added `readAppIdentity().env` (inlined `APP_DEPLOY_ENV`) and
  the stamp resolver: explicit `APP_DEPLOY_ENV` → (`VERCEL_ENV=preview` and
  `VERCEL_GIT_COMMIT_REF=staging` → `staging`) → `VERCEL_ENV` → `local`.
- The M5 table is authoritative: production → `PROD_DB_ENDPOINT`; staging →
  `STAGING_DB_ENDPOINT`; preview → neither, or a verified read-only staging
  exception (`ALLOW_PREVIEW_ON_STAGING=1`); local → loopback.
- The documented environment model has two Neon projects: `solara-staging` and
  `solara-prod`. #163 is the spike for a per-PR branch in the staging project
  with its own pooled URL and cleanup; #176 implements it. A branch endpoint is
  distinct from the staging endpoint, so the strict preview rule accepts it.
- Local `.env.production` currently has a pooled endpoint `ep-yyy` and a direct
  endpoint `ep-tiny-butterfly-beoceifb`; staging's pooled and direct both resolve
  to `ep-young-bird-bew3yv2x`. The production pairing must be confirmed before
  setting `PROD_DB_ENDPOINT`; the guard will (correctly) refuse it.

## 3. Scope and non-goals

**In scope**

1. `src/db/url-guard.ts`: one pure guard, three rules, typed error codes.
2. Wire it into `src/db/index.ts`, `scripts/db-run.ts` and `drizzle.config.ts`.
3. Add the non-secret configuration to SecretWeaver and the env templates.
4. Tests for every row of the table, the build placeholder, TLS folding and the
   migration pooler rule, plus named mutations.

**Out of scope**

- Provisioning or repairing the production database URL (operator).
- The readiness four-state classifier (#167), drift monitor (#165), Actions
  deploy workflows (#171/#173) and preview database provisioning (#176).
- A second TLS or URL parser.

## 4. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | One module: `src/db/url-guard.ts`; one exported `assertDatabaseEnvironment(rawUrl, options)`. | The issue requires no second copy; `db-run`'s duplicate loopback/pooler errors are removed. |
| **D2** | The guard is pure and synchronous: parse, normalize TLS, derive the endpoint, compare, throw a typed error. No connection, no log, no `process.env` read except through `options.env`. | Boot/testable without a database; the same function in all consumers. |
| **D3** | `deployEnv` is passed by each consumer, not re-derived: app → `readAppIdentity().env`; `db-run` → its required `--env` target; `drizzle.config.ts` → `APP_DEPLOY_ENV ?? "local"`. | #164's resolver is the only environment resolver; a second copy in the guard would be the defect #164 closed. |
| **D4** | Endpoint = the first hostname label with a trailing `-pooler` removed; compare exact, lower-cased, trimmed. A missing expected endpoint fails closed. | Matches the M5 definition; Neon pooled/direct share the base endpoint. |
| **D5** | `forMigration: true` rejects any `-pooler.` host. App boot uses `false`; `db-run` and `drizzle.config.ts` use `true`. | Migrations must use the direct endpoint; the app is the only pooled consumer. |
| **D6** | `drizzle.config.ts` uses `DATABASE_URL_DIRECT ?? DATABASE_URL` and `forMigration: true`. | Makes the only migration path safe even when someone invokes `drizzle-kit` directly; `db-run` remains the supported path. |
| **D7** | Preview isolation is **strict**: a preview database must be a per-PR Neon branch in the staging project (or a separate project) with its own endpoint, distinct from `STAGING_DB_ENDPOINT` and `PROD_DB_ENDPOINT`. A separate database on the staging compute is not enough because the endpoint is shared. `ALLOW_PREVIEW_ON_STAGING` stays unset; the documented exception remains available but is not the chosen policy. | Strict is the chosen state; #163 proves runtime injection and cleanup before #176. The guard compares endpoints, not database names or data lineage; the operator must not branch from production. |
| **D8** | Build phase: `phase: "build" | "runtime"`. `src/db/index.ts` passes `build` only when `process.env.NEXT_PHASE === "phase-production-build"`; both script consumers pass `runtime`. A loopback placeholder is allowed only in `build`. | #164/M5 §8 requires a non-routable loopback placeholder at build; `NEXT_PHASE` is set by Next's build and is not present under `next start`. |
| **D9** | Errors are typed codes with stable, non-secret messages that name the variable (`PROD_DB_ENDPOINT`, `STAGING_DB_ENDPOINT`, `ALLOW_PREVIEW_ON_STAGING`) but never the URL, password or host. | Acceptance requires a clear non-secret failure. |
| **D10** | TLS rules are not duplicated: call `normalizeDatabaseUrl(rawUrl)` first (it rejects hosted `sslmode=disable`/`ssl=false` and normalizes to `verify-full`). | The issue explicitly folds this in. |

## 5. Algorithm

```ts
type DeployEnv = "local" | "staging" | "production" | "preview";
type Phase = "build" | "runtime";

assertDatabaseEnvironment(rawUrl, {
  deployEnv: string;               // from the consumer (D3)
  env?: Record<string, string | undefined>;
  forMigration?: boolean;          // default false
  phase?: Phase;                   // default "runtime"
}): void
```

1. Parse `rawUrl` with `new URL`; invalid → `database_url_invalid`.
2. `normalizeDatabaseUrl(rawUrl)` (TLS folding) — let its non-secret error
   propagate; no URL is added.
3. `deployEnv` must be exactly `local|staging|production|preview`; else
   `database_url_environment`.
4. Derive `endpoint` (D4) and `pooled = hostname.includes("-pooler.")`.
5. If `forMigration` and `pooled` → `database_url_pooler_migration`.
6. If `phase === "build"`: allow a loopback host (the documented placeholder) and
   return. Hosted values still pass through the normal rules.
7. `local`: host must be loopback (`isLoopbackHost`) → else
   `database_url_local_not_loopback`.
8. `production` / `staging`: expected = `PROD_DB_ENDPOINT` / `STAGING_DB_ENDPOINT`
   (trim, lower-case); unset/empty → `database_url_endpoint_unset`; endpoint
   mismatch → `database_url_endpoint_mismatch`. A loopback host cannot match a
   provided endpoint.
9. `preview`: a loopback URL is allowed as "no hosted DB" (quarantine). Otherwise
   both expected endpoints must be set, and the derived endpoint must differ from
   both. `ALLOW_PREVIEW_ON_STAGING=1` + the staging endpoint is the documented
   transitional exception; this policy leaves the flag unset. Anything else →
   `database_url_preview_unapproved`.
10. No state is retained and nothing is logged.

## 6. Integration

### App boot — `src/db/index.ts`

```ts
import { readAppIdentity } from "@/lib/build-identity";
import { assertDatabaseEnvironment } from "@/db/url-guard";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

assertDatabaseEnvironment(databaseUrl, {
  deployEnv: readAppIdentity().env,
  phase: process.env.NEXT_PHASE === "phase-production-build" ? "build" : "runtime",
});
```

Called before either pool is created. `readAppIdentity().env` is the inlined
`APP_DEPLOY_ENV`; its `local` fallback makes a local boot with a loopback URL
pass and a local boot with a hosted URL fail.

### Migration runner — `scripts/db-run.ts`

Call the guard in `resolveAndCheck` with the required `--env` target and
`forMigration: true`, `phase: "runtime"`. Remove the loopback/pooler error
branches from `assertEnvironment`; keep its target identity and SSL warnings so
the operator still sees what is being targeted. The guard's message is the only
failure text.

### Drizzle config — `drizzle.config.ts`

```ts
const url = process.env.DATABASE_URL_DIRECT?.trim() || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL(_DIRECT) is required for Drizzle Kit");
assertDatabaseEnvironment(url, {
  deployEnv: process.env.APP_DEPLOY_ENV?.trim() || "local",
  forMigration: true,
  phase: "runtime",
});
```

`db-run` remains the supported hosted migration path (ADR 008); this keeps
`drizzle-kit` from accepting a pooled hosted URL.

## 7. Configuration

| Variable | Stages | Form | Notes |
| --- | --- | --- | --- |
| `APP_DEPLOY_ENV` | optional all | enum `local,staging,preview,production` | Derived by #164; explicit only to override. Non-secret. |
| `PROD_DB_ENDPOINT` | required production; optional local/staging | string, endpoint label | First hostname label, `-pooler` stripped. Non-secret. |
| `STAGING_DB_ENDPOINT` | required staging; optional local/production | same | Same. |
| `ALLOW_PREVIEW_ON_STAGING` | optional all | `"0"`/`"1"` | Kept unset under strict. Only the documented read-only staging exception sets it after the Phase 0 audit. |

Add all four to `secretweaver.yaml` (groups `database`/`deploy`) and to
`.env.example`, `.env.staging.example`, `.env.production.example`. Local keeps
`APP_DEPLOY_ENV=local` and needs no endpoints.

## 8. Tests and mutations

`tests/db-url-guard.test.ts` (pure, fake URLs):

1. production + matching `PROD_DB_ENDPOINT` → pass.
2. production + staging endpoint → `database_url_endpoint_mismatch`.
3. staging + matching `STAGING_DB_ENDPOINT` → pass; staging + production → fail.
4. preview + production endpoint → fail; preview + staging endpoint → fail;
   preview + a distinct branch endpoint → pass; preview loopback → pass as a
   no-hosted-DB quarantine; preview + unset expected endpoints → fail;
   `ALLOW_PREVIEW_ON_STAGING=1` + staging endpoint → pass as the documented
   exception, not the chosen policy.
5. local + loopback → pass; local + hosted → fail.
6. unknown/empty `deployEnv` → fail; unset expected endpoint → fail.
7. `forMigration` + `-pooler` → fail; direct → pass.
8. hosted `sslmode=disable` → the normalized TLS error; no URL in the message.
9. build + production + loopback → pass; runtime + production + loopback → fail.
10. endpoint derivation: `ep-x-pooler.region` → `ep-x`; no raw URL/host appears
    in any error message.

Mutations (each must fail its test):

- `guard-endpoint-full-host` — compare the full host instead of the label.
- `guard-preview-allows-prod` — drop the preview production comparison.
- `guard-preview-allows-staging` — drop the preview staging comparison; the
  strict test fails.
- `guard-pooler-migration` — skip the pooler rule.
- `guard-local-hosted` — skip the local loopback rule.
- `guard-build-at-runtime` — allow loopback in `runtime`.
- `guard-endpoint-unset` — treat an unset expected endpoint as a match.

Integration checks: `npm run typecheck`, `npm run lint`, `db-run --env local
status` against loopback, and a built app with `APP_DEPLOY_ENV=local`; no hosted
connection.

## 9. Operator steps and rollout

1. Confirm the production pooled endpoint from the remotes when production is
   ready. The local `.env.production` is out of sync (`ep-yyy` pooled vs
   `ep-tiny-butterfly-beoceifb` direct); do not set `PROD_DB_ENDPOINT=ep-yyy`.
2. Run #163 before enabling preview databases: create a per-PR branch in
   `solara-staging`, migrate it with `db-run`, inject the branch's pooled URL at
   deploy time, confirm `/api/ready`, and prove cleanup. Do not branch from
   production; use staging data or an empty/schema-only branch according to the
   preview data policy.
3. If #163 cannot prove runtime injection and cleanup, quarantine previews: no
   hosted DB credential. Do not fall back to the shared staging endpoint.
4. Set `STAGING_DB_ENDPOINT=ep-young-bird-bew3yv2x` in the staging scope and
   `PROD_DB_ENDPOINT=<confirmed>` in Production. These are non-secret.
5. Leave `ALLOW_PREVIEW_ON_STAGING` unset (strict). The flag exists only for the
   documented read-only staging exception, which is not the chosen policy.
6. Do not set `APP_DEPLOY_ENV` on the shared Preview scope; staging derives from
   the branch, production from `VERCEL_ENV`.
7. Redeploy after env changes; the app guard runs at boot and fails closed.
8. Rollback: revert the guard commit; the env vars can stay (inert).

## 10. Acceptance

- [ ] Boot with a staging URL in a production deployment fails with a clear,
      non-secret code; no URL, password or host in the message.
- [ ] The app, `db-run` and `drizzle.config.ts` all import the one guard.
- [ ] Tests cover production-in-staging, preview=production, pooler migration,
      hosted loopback, unknown env, unset endpoint and the build placeholder.
- [ ] All named mutations kill their tests.
- [ ] Local and CI loopback boots pass; `db-run --env local` passes.
- [ ] Preview: a distinct per-PR Neon branch endpoint passes; the staging or
      production endpoint fails; a separate database on the same staging compute
      fails because the endpoint is shared; `ALLOW_PREVIEW_ON_STAGING` is unset.
- [ ] #163 proves runtime injection and cleanup, or previews are quarantined.
- [ ] SecretWeaver validates the new variables; `local`/`local-pilot` remain
      green.

## 11. Open decisions before implementation

1. **Production endpoint:** confirm the real pooled Neon endpoint from the
   remotes when production is ready; the local `.env.production` is out of sync.
   This blocks hosted validation, not the guard code.
2. **#163 proof:** per-PR staging branch runtime injection and cleanup. If
   unproven, previews are quarantined; the guard code can land before the proof.
