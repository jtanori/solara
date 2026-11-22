# Build identity and `/api/version` (issue #164)

**Implementation plan, not evidence of completion.** This is the detailed design for one issue,
recorded so it can be implemented and reviewed in one round rather than discovered during review.

Design authority is [Deployment alignment](plan-deployment-alignment.md) §5 (*Verification:
identity, not readiness*) and the [readiness policy change](decisions.md#adr-012--readiness-tolerates-schema-ahead-in-production)
(ADR 012). This document does not restate or amend either; it expands #164 into an ordered,
testable plan and records the decisions that were open when the issue was picked up.

Nothing here authorizes a hosted migration, deployment, promotion, environment or control change,
provider/Stripe call, credential setup, generation activation, or a change to Free/paid allowance
accounting.

## 1. Scope

Today every gate that asks "what is serving right now?" has no way to answer. A stable URL returns
`{"ok":true}` from a deployment three merges old. `/api/ready` answers *can this build serve?* —
which the previous build answers just as happily.

**In scope**

1. Build-time identity constants in `next.config.ts` `env`: `APP_COMMIT_SHA`, `APP_TREE_SHA`,
   `APP_DEPLOY_ENV`, `APP_BUILT_AT`, `APP_RELEASE_ID`.
2. `GET /api/version` → `{ ok, commit, tree, release, env, builtAt, migrations }`, `force-dynamic`,
   `Cache-Control: no-store`.
3. `/api/ready` gains `commit`.

**Out of scope** (named so review does not read their absence as an omission)

- **The four-state migration verdict.** That is #167. This PR must not add it — see §4.
- Observability, logging or alerting on drift (#165).
- Any workflow that consumes these fields (#171, #173).
- Per-PR preview databases (#176), retiring `deploy.sh` (#175), the promotion gate (#172).

## 2. Verified baseline

Everything below was read at `60c6deb` (staging, after PR #161) before writing this plan.

| Fact | Where |
| --- | --- |
| `/api/ready` returns `{ ok, db, auth }` publicly and the full object in development | `src/app/api/ready/handler.ts:20-36`, `:38-60` |
| The public shape is a deliberate whitelist, not a redaction pass | same, `publicReadiness` |
| `Readiness.migrations` is `{ pending, unexpected }` — **counts of what is wrong**, not a state | `src/lib/readiness.ts:9-15` |
| `ok` requires `pending === 0 && unexpected === 0` (exact equality) | `src/lib/readiness.ts` `buildReadiness` |
| The manifest carries `{ tag, hash }` only — no `when` | `src/lib/migration-manifest.ts:1-4` |
| `.vercelignore` excludes `drizzle/meta` but keeps `scripts/build-pdf.mjs` and the runtime worker | `.vercelignore` |
| `prebuild` runs `npm run pdf:build` | `package.json` |
| `next.config.ts` has no `env` block today; it sets headers and `outputFileTracingIncludes` | `next.config.ts:8` |
| `VERCEL_ENV` is already read for environment decisions | `src/lib/security-headers.ts:19` |
| No `/api/version` route exists | `src/app/api/` |
| `tests/ready-route.test.ts` asserts the public shape and the dev-only detail boundary (S4) | that file |

Two consequences matter for the plan:

- **The public payload is a whitelist.** Adding `commit` is a one-line change to `publicReadiness`,
  but the S4 test and the type both enumerate fields, so the "no new disclosure" requirement is
  enforceable by construction rather than by a redaction review.
- **`migrations` cannot be added to `/api/ready` in this PR.** The field the plan wants is a state
  string; the field the code has is a pair of counts whose *presence* is already hidden outside
  development. Emitting `{ pending, unexpected }` publicly is precisely the disclosure #164 forbids,
  and emitting a state string requires #167's classifier. §4 resolves this.

## 3. Decisions

Settled here; each would otherwise surface mid-review.

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | `/api/version` omits `migrations` until #167 lands | See §4. The alternative — emitting the counts — is a new disclosure, and synthesising a state string duplicates #167's classification in a second place |
| **D2** | `/api/ready` gains `commit` only | `commit` is an identity fact with no schema information; every deploy gate already has it |
| **D3** | Identity values are baked by `next.config.ts` `env` from a **written stamp file**, not read from `process.env` at runtime | `env` values are inlined at build time. Reading `process.env` at runtime would report the *server's* environment, which on Vercel is not the build's. The stamp makes "the values a build used" a file the build produced |
| **D4** | The stamp is `.build-stamp.json` at the repository root, written in `prebuild`, gitignored | `prebuild` already exists and is the only place that runs exactly once per build in both Actions and Vercel. `next.config.ts` is TypeScript and must read the file synchronously either way; the root keeps the path relative to `cwd`, unchanged on Vercel |
| **D5** | `APP_BUILT_AT` is the stamp's timestamp, captured in `prebuild` | Requirement: build time, not request time. Falls back to the `next.config.ts` evaluation time if the stamp is absent, and that fallback is `unknown`-marked — see D7 |
| **D6** | `APP_RELEASE_ID` is `<env>-<commit.slice(0,7)>-<builtAt epoch seconds>` by default, overridable by `APP_RELEASE_ID` in the environment | One opaque token that names a *specific artifact*, not a commit. Two builds of the same SHA are different releases, which is the distinction a rollback needs |
| **D7** | Every field is `"unknown"` rather than absent when it cannot be determined, and `env` degrades `local` | A gate that receives `commit:"unknown"` must fail closed (#173 says so explicitly). An absent field invites `undefined` comparisons that pass |
| **D8** | `env` is derived: explicit `APP_DEPLOY_ENV` → `VERCEL_ENV` → `local`, and **staging must set `APP_DEPLOY_ENV=staging` explicitly** | `VERCEL_ENV` is only `production`, `preview` or `development` — and the staging deployment is a *preview* deployment (see below), so Vercel reports `preview` for it. Without the explicit variable, staging would report `preview` and #171's gate would be comparing the wrong word |

### Why a stamp file rather than `git` inside `next.config.ts`

`next.config.ts` is evaluated on every `next build`, `next dev` and `next start`. Shelling out to
`git` there would run on machines that are not repositories (a Docker context, a Vercel build with
`.git` removed) and inside `next start` on a production server where the answer is meaningless. The
stamp is produced once, at the only moment the answer is knowable, and read cheaply afterwards.

### Verified: Vercel reports `preview` for the staging deployment

Read from the Vercel API for deployment `dpl_Cb6vgmbzBKobR1Xajtw5mq8jJ5rc` (the merge of #161,
aliased to `solara-stg.vercel.app`): `"target": null`, and the deployment's OIDC claim is
`"environment": "preview"`. Staging is a preview deployment with a custom alias, not a Vercel
*Production* deployment — `VERCEL_ENV` there is `preview`.

So `APP_DEPLOY_ENV` is not a convenience for the future Actions deployer; it is **required** for
staging to identify itself correctly. It goes in the Vercel *Preview* environment's variables,
scoped so production previews (feature branches) are not mislabelled: the same variable cannot
hold `staging` for every preview, because feature-branch previews must report `preview`.

This is why the resolution order puts `APP_DEPLOY_ENV` first and why the fallback is `local`
rather than a guess: a build that cannot tell what it is should say so.

**Open for implementation:** the scoping mechanism. Vercel's env vars support per-branch scoping
in the UI/API, but this repository has no `vercel.json` and no recorded decision about it. The
cheapest correct option is branch-scoped `APP_DEPLOY_ENV=staging` on the `staging` branch only,
which is a control-plane change and therefore outside this PR — the code must work with the
variable present *or* absent, and the test covers both.

### Why not compute the tree SHA in the verification step

#164 is explicit: `git rev-parse HEAD^{tree}` at `prebuild` reads only the commit object, which
exists in both a shallow clone and Vercel's export. Fetching anything later re-introduces the
network dependency the identity check exists to avoid.

## 4. The `migrations` field — the one conflict in this issue

The issue and plan both list `migrations` in the `/api/version` response and in `/api/ready`. The
code cannot supply it as specified, and this is the decision that most needs review.

The intended value is a **state string** `exact | ahead | behind | diverged` (plan §5, ADR 012). That
classification does not exist: `buildReadiness` computes `pending` and `unexpected` as numbers and
`ok` as exact equality. Producing the string today means either

- (a) implementing ADR 012's four states here — which is #167, a p1 bug with its own fixture
  contract, an ordering constraint against the destructive-DDL lint (4a), and a change to what
  `ok` means for every existing monitor; or
- (b) mapping `pending === 0 && unexpected === 0 ? "exact" : "not-exact"` — a second, lossier
  classifier in a new file that #167 would then have to delete.

**Resolution:** ship `/api/version` without `migrations` in this PR, and add it in #167 as a
one-line extension to the same handler. Until then the field's absence is honest; a field whose
value means "not exact" but is named `migrations: "diverged"` would not be.

- `/api/version` therefore returns `{ ok, commit, tree, release, env, builtAt }`.
- The dependency this creates is recorded on both issues: **#164 unblocks #165 immediately** (which
  needs commit tree and env, not migrations) and **#171/#173 wait for #167** for the migration half
  they already depend on.
- The acceptance box in #164 that names `migrations` is corrected by this plan rather than quietly
  failed. If the reviewer prefers (a), that is a different, larger PR and #164 should be re-scoped
  in the issue, not in a comment.

## 5. Contract

### `GET /api/version`

```json
{
  "ok": true,
  "commit": "60c6deba3cbb19cde630242bc9ad1cbdf7cebd40",
  "tree": "9c41…",
  "release": "staging-60c6deb-1795378343",
  "env": "staging",
  "builtAt": "2026-11-22T20:12:23.632Z"
}
```

- `ok` is always `true` — this endpoint reports identity, not health. A build that cannot state its
  identity is a build that should not have started; returning `ok:false` here would make it a
  second readiness endpoint with a different meaning.
- Status is always 200. There is no failure mode that is this endpoint's to report.
- `force-dynamic`; `Cache-Control: no-store`. Cached identity is worse than none: it is confidently
  wrong after a rollback.
- Field names are chosen to match plan §5 exactly so #165 and #173 can be written against them
  without translation.

### `/api/ready`

`{ ok, db, auth, commit }` publicly; the full object unchanged in development.

`commit` is added to `PublicReadiness` and to the thrown-probe failure object, so a 503 still
carries which build refused.

### The stamp file

`.build-stamp.json`, gitignored, written by `scripts/build-stamp.mjs`:

```json
{ "commit": "60c6…", "tree": "9c41…", "builtAt": "2026-11-22T20:12:23.632Z", "env": "staging" }
```

Resolution order per field, all resolved **once, at stamp time**:

| Field | Order |
| --- | --- |
| `commit` | `APP_COMMIT_SHA` → `VERCEL_GIT_COMMIT_SHA` → `git rev-parse HEAD` → `"unknown"` |
| `tree` | `git rev-parse HEAD^{tree}` → `"unknown"` |
| `env` | `APP_DEPLOY_ENV` → `VERCEL_ENV` → `"local"` |
| `builtAt` | `new Date().toISOString()` at stamp time |

`next.config.ts` reads the stamp if present and fills any `"unknown"` from `process.env` at config
evaluation, then passes the result through `env`. Reading the file is wrapped: a missing or
malformed stamp must not fail a build, it must produce `"unknown"` fields that fail closed
downstream (#173). That behaviour is a test, not a comment.

## 6. Algorithm

`scripts/build-stamp.mjs` (new, ~60 lines, no dependencies):

1. Resolve `commit`, `tree`, `env` per §5. `git` is invoked with
   `execFileSync("git", [...], { encoding: "utf8" })` and every call is wrapped in a try: a
   non-repository checkout yields `"unknown"`, not a failed build.
2. Write `.build-stamp.json` with a fixed key order, so two builds of the same inputs produce
   byte-identical stamps modulo `builtAt`.
3. Print one line naming what it resolved, so the build log answers the question even if the
   endpoint is unreachable later.

`package.json`: `"prebuild": "npm run pdf:build && node scripts/build-stamp.mjs"`. Declining to add
a second `prebuild` script key because npm runs only one; the existing PDF build must not be
replaced.

`next.config.ts`:

```ts
const identity = readBuildIdentity(); // synchronous, total, never throws
const nextConfig: NextConfig = {
  env: {
    APP_COMMIT_SHA: identity.commit,
    APP_TREE_SHA: identity.tree,
    APP_DEPLOY_ENV: identity.env,
    APP_BUILT_AT: identity.builtAt,
    APP_RELEASE_ID: identity.release,
  },
  ...
};
```

`src/lib/build-identity.ts` (new): `readBuildIdentity()` — the single reader used by both
`next.config.ts` and the routes. Routes read `process.env.APP_*`, which `env` has inlined; the
module exposes one typed accessor so a route never string-matches a variable name.

`src/app/api/version/handler.ts` + `route.ts`: mirroring the shape of the ready route, including a
factory (`createVersionHandler(env)`) so the test drives it without a server — the pattern
`createReadyHandler` already established.

## 7. Caching and process boundaries

- The endpoint must not be statically optimised. `export const dynamic = "force-dynamic"` on the
  route, and the handler sets `Cache-Control: no-store` itself rather than relying on the route
  segment config (which the PDF route also does not rely on).
- No `revalidate`. No `generateStaticParams`.
- The route must not touch the database. If it did, `/api/version` would fail during exactly the
  migrate→deploy window it exists to diagnose.

## 8. Test plan

`tests/build-identity.test.ts` (new):

| Test | Asserts |
| --- | --- |
| resolution order per field | `APP_COMMIT_SHA` beats `VERCEL_GIT_COMMIT_SHA` beats `git`; `APP_DEPLOY_ENV` beats `VERCEL_ENV` |
| absent stamp | every field `"unknown"`, `env` `"local"`, no throw |
| malformed stamp | same — `JSON.parse` failure is caught, not propagated |
| stamp with partial fields | resolved fields kept, missing ones `"unknown"` — not silently empty strings |
| `builtAt` is stamp time | a stamp with a past timestamp is returned verbatim; it is not `new Date()` at call time |
| release id shape | `<env>-<7>-<epoch>`, and an explicit `APP_RELEASE_ID` wins |

`tests/version-route.test.ts` (new):

| Test | Asserts |
| --- | --- |
| shape | exactly `[builtAt, commit, env, ok, release, tree]` — `deepEqual` on the sorted key list, so an added field fails and new disclosure is a deliberate edit |
| `ok` always true, status always 200 | including when every identity field is `"unknown"` |
| `no-store` | header present |
| no secret, host or migration tag | the serialised body is checked against a denylist: no `postgres`, no `://`, no `DATABASE_URL` value, no `drizzle/` tag, no host |
| the route does not read the database | `getReadinessPool` is not importable from the version route's module graph (source assertion, plus the absence of `pg` in its imports) |

`tests/ready-route.test.ts` (extended):

| Test | Asserts |
| --- | --- |
| public shape gains `commit` and nothing else | `deepEqual` on `{ ok, db, auth, commit }` |
| `migrations` still absent publicly | the counts never appear in a non-development body — the existing S4 boundary, re-asserted after the shape change |
| 503 carries `commit` | the thrown-probe path includes identity |

## 9. Mutations (SEC-07)

Each must be killed by a named test. Recording them here is the point: a mutation table written
after the fact tends to describe the tests that exist.

| Mutation | Must fail |
| --- | --- |
| drop `force-dynamic` from the route | the no-store / caching test |
| return `ok:false` when identity is unknown | the "always true" test |
| read `commit` from `process.env` at request time instead of the inlined value | the `builtAt`/stamp-time test |
| add `migrations: { pending, unexpected }` to the public ready payload | the S4 disclosure test |
| resolve `commit` only from `git`, dropping `APP_COMMIT_SHA` | the resolution-order test |
| let a malformed stamp throw | the malformed-stamp test |
| compute `builtAt` at request time | the stamp-time test |
| widen the public ready whitelist to the full object | the ready shape test |

## 10. Verification gates

Scoped first — the full suite is expensive and CI runs it on every push.

```bash
npm ci
npx tsx --test tests/build-identity.test.ts tests/version-route.test.ts tests/ready-route.test.ts
npm run typecheck
npm run lint
npm run build          # the identity block is a build-time construct; this is the real check
node scripts/build-stamp.mjs && cat .build-stamp.json
```

Then, with a disposable loopback database, per `AGENTS.md`:

```bash
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
```

And the endpoint itself against a local production build:

```bash
APP_DEPLOY_ENV=local npm run build && npm run start &
curl -s localhost:3000/api/version | jq
curl -s localhost:3000/api/ready   | jq
```

The last line is the acceptance box that cannot be checked by unit tests: `builtAt` must be the
build's, not the request's, and `env` must be `local`.

## 11. Rollout and compatibility

- No migration. Nothing in `drizzle/`. `deploy:required` because it changes what runs, not
  `deploy:skip`.
- `/api/ready` gains a field. Monitors key off the status code and `ok`, both unchanged; a strict
  schema assertion in a monitor would fail, and there is no such monitor in this repository.
- `/api/version` is new and unauthenticated. It discloses the commit SHA of a public repository,
  which is already public, and the deploy environment name. It discloses no host, no schema state
  and no migration tag — the tests assert that as a denylist, not as an intention.
- `.build-stamp.json` is gitignored. A checkout that never runs `prebuild` (a contributor running
  `next dev` directly) reports `"unknown"` fields and `env: "local"`, which is correct and inert.
- Rollback is a revert; no data changes.

## 12. Tracker and PR

1. **#164** `status:ready` → `in-review` when the PR opens.
2. The `migrations` deviation (§4) is recorded **on the issue** before the PR, not only in the PR
   body — it changes an acceptance box.
3. PR title `feat(infra): bake build identity and add /api/version`, labels `type:feature`,
   `deploy:required`. Body from `.github/pull_request_template.md`, naming the deviation, the
   mutation table and the two non-negotiables (no new disclosure; no database read).
4. Note for #167: it inherits `migrations` on both endpoints and must extend `PublicReadiness` and
   the version handler rather than add a third endpoint.

## 13. Landmines

1. **`env` in `next.config.ts` is inlined at build time.** A value read from `process.env` inside a
   route handler reports the server's environment, not the build's. Every identity field must come
   from the inlined constant; the test for this is the `builtAt` assertion.
2. **`next start` re-evaluates `next.config.ts`.** Anything expensive or throwing at config
   evaluation is a production-startup risk. `readBuildIdentity()` is synchronous, total, and
   returns `"unknown"` rather than throwing.
3. **`.vercelignore` excludes `tests/` and `drizzle/meta`.** The stamp script must be on the
   allowlist by default (it is not excluded) and must not import from `tests/`.
4. **Vercel's build runs `prebuild` but not `git` reliably.** `VERCEL_GIT_COMMIT_SHA` is the
   primary source, with `git` as a local fallback — not the reverse.
5. **`publicReadiness` is a whitelist.** Adding a field to `Readiness` does not leak it; adding it
   to `PublicReadiness` does. Review the second, not the first.
6. **`VERCEL_ENV` is `preview` on staging**, not `staging` — verified from the deployment metadata
   in §3. Any code that branches on `VERCEL_ENV === "staging"` is dead code. Use `APP_DEPLOY_ENV`.
7. **The 503 path builds its own object.** `handler.ts` constructs a failure `Readiness` literal;
   `commit` must be added there too or the failure response loses identity exactly when someone
   needs it.
8. **Two `prebuild` keys is one key.** npm silently ignores the duplicate; the PDF build would stop
   running. Append to the existing script.

## 14. Definition of done

- [ ] `scripts/build-stamp.mjs`, `src/lib/build-identity.ts`, `src/app/api/version/{handler,route}.ts`
      added; `next.config.ts` and `package.json` modified.
- [ ] `/api/version` returns exactly `{ ok, commit, tree, release, env, builtAt }` — six keys, no
      `migrations` (D1) — with `ok:true`, `force-dynamic`, `no-store`, on a local
      production build with `env:"local"` and a `builtAt` that equals the build's.
- [ ] `/api/ready` returns exactly `{ ok, db, auth, commit }` publicly; the dev-only detail
      boundary and the absence of migration counts are re-asserted.
- [ ] No secret, host, migration tag or count in either payload — asserted by a denylist test.
- [ ] All §8 tests pass; all §9 mutations produce a named failing test and the tree is restored.
- [ ] `typecheck`, `lint`, `npm run build`, and the full suite green locally with exact numbers
      reported.
- [ ] The `migrations` deviation (§4) is on #164, and #167 carries the follow-up note.
