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
2. `GET /api/version` → `{ ok, commit, tree, release, env, builtAt }`, `force-dynamic`,
   `Cache-Control: no-store`. **No `migrations`** — §4.
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
| **D8** | `env` is derived: explicit `APP_DEPLOY_ENV` → (`VERCEL_ENV === "preview"` **and** `VERCEL_GIT_COMMIT_REF === "<the staging branch>"` → `staging`) → `VERCEL_ENV` → `local` | `VERCEL_ENV` is only `production`, `preview` or `development`, and the staging deployment is a *preview* deployment, so Vercel reports `preview` for it. The branch ref is the only field that distinguishes staging from a feature preview, and Vercel records it per deployment. Costs no control-plane change; the explicit variable still wins, so a future custom environment is a variable change and not a code change. Decided in [decision-staging-environment.md](decision-staging-environment.md) |

### Why a stamp file rather than `git` inside `next.config.ts`

`next.config.ts` is evaluated on every `next build`, `next dev` and `next start`. Shelling out to
`git` there would run on machines that are not repositories (a Docker context, a Vercel build with
`.git` removed) and inside `next start` on a production server where the answer is meaningless. The
stamp is produced once, at the only moment the answer is knowable, and read cheaply afterwards.

### Verified: Vercel reports `preview` for the staging deployment

Read from the Vercel API for deployment `dpl_Cb6vgmbzBKobR1Xajtw5mq8jJ5rc` (the merge of #161,
served at `solara-stg.vercel.app`): `"target": null`, and the deployment's OIDC claim is
`"environment": "preview"`. Staging is a preview deployment bound to the `staging` branch and
served from a branch-linked domain (`list_project_domains` → `git_branch: "staging"`), not a
Vercel *Production* deployment. `VERCEL_ENV` there is `preview`.

So `VERCEL_ENV` alone cannot identify staging, and the value has to come from somewhere else. Two
sources are available, and they are the same source seen twice: the explicit `APP_DEPLOY_ENV`
variable, and the branch Vercel records on the deployment (`VERCEL_GIT_COMMIT_REF`, which is
available at build *and* runtime, and which this project exposes without opt-in via
`autoExposeSystemEnvs`). Branch-scoped `APP_DEPLOY_ENV=staging` is a control-plane change nothing in
the repository can make; the branch ref costs nothing.

**Decided:** see [decision-staging-environment.md](decision-staging-environment.md). `env` resolves
`APP_DEPLOY_ENV` → (`VERCEL_ENV === "preview"` **and** `VERCEL_GIT_COMMIT_REF === "staging"` →
`staging`) → `VERCEL_ENV` → `local`. The explicit variable stays first so a paid custom environment
can replace the mapping later with no code change, and #171's Actions deploy — which knows it is
deploying staging — should pass the variable explicitly rather than rely on the mapping. The second
project option was rejected because it makes the name `production` true of two different things,
which every guard that reads it — #168's DB-endpoint rows above all — would then have to
disambiguate.

Runtime availability of `VERCEL_GIT_COMMIT_REF` is not only a documentation reading: both live
deployments' **runtime** env lists contain it, so the mapping is observable in the deployed function
today. `security-headers.ts` also reads `VERCEL_ENV === "production"`, but only to add HSTS — it is
not an argument against the mapping and is not load-bearing for this decision.

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
| `env` | `APP_DEPLOY_ENV` → (preview + staging branch → `"staging"`) → `VERCEL_ENV` → `"local"` |
| `release` | `APP_RELEASE_ID` → `<env>-<commit[0:7]>-<builtAt epoch seconds>` (D6); depends on the two fields above, so it is resolved after them |
| `builtAt` | `new Date().toISOString()` at stamp time |

**The order above has exactly one implementation: `scripts/build-stamp.mjs`.** Nothing else resolves
a field. `readBuildIdentity()` in `src/lib/build-identity.ts` is a *stamp parser* — it reads
`.build-stamp.json`, validates the shape, and returns the values verbatim; it never consults
`process.env` to fill a gap, and it never re-derives `env` or `release`. A missing or malformed stamp
yields `"unknown"` fields (and `env:"local"`), which fail closed downstream (#173). That behaviour is
a test, not a comment.

Why the split falls there rather than in a shared module:

- The two sides run in **different processes at different times** — the stamp write is a Node 22
  script under `npm run prebuild`, the read is Next config evaluation and route code. Any shared
  runtime would have to be importable by both.
- They cannot share a source file here. `.mjs` is not in the TypeScript program, a `.mjs` script
  cannot import a `.ts` module without a loader, and the deployment-inputs typecheck fixture runs
  with `allowJs: false`. That last point was checked rather than assumed: a `.ts` consumer importing
  a `.mjs` under `allowJs: false` and `strict` fails with
  `TS7016: Could not find a declaration file for module './shared.mjs'`. So a shared resolver in
  `src/` would be unavailable to the script at deploy time, and a re-export shim would be a second
  name over the same bytes — precisely the defect being closed.
- Duplication instead would be worse than either: two implementations of one order is the exact
  shape that has already shipped three times in this repository, and a test that exercises one side
  cannot see the other disagree.

Consequently `release` (`<env>-<commit[0:7]>-<builtAt epoch>`, D6) is also computed at stamp time
and merely *overridable*: an explicit `APP_RELEASE_ID` is applied **twice** — the script prefers it
when writing, and `next.config.ts` prefers it when reading — so a stamp override and an env override
can never disagree about which one won. The explicit value is idempotent under both.

The cost of this choice is stated rather than hidden: `readBuildIdentity()` is not independently
unit-testable for *resolution*, because it has no resolution logic. Coverage comes from two places
instead (§8): the resolver is driven through `execFile` — the test runs the script under a
constructed environment and reads the stamp it writes — and the parser is tested against synthetic
stamps.

**Why `execFile` and not an import, which is the obvious way to test a resolver:** the constraint
that forbids a shared module forbids the import too. `tsconfig.json` includes `**/*.ts` with
`allowJs: false`, and `tests/` is not excluded, so a test file that `import`s `scripts/build-stamp.mjs`
is itself a `.ts` consumer of a `.mjs` and fails the same way — `TS7016` on the test's own import,
which would fail `typecheck` for the reason the design exists. Both of the reviewer-audited options
were considered:

- **`execFile`-only tests** — chosen. The test spawns `node scripts/build-stamp.mjs` with a
  constructed `env` and asserts on the written stamp. It tests the real artefact through the real
  entry point, so there is nothing to drift, and it adds no file.
- **A types-only `build-stamp.d.mts`** — viable and verified (a `.ts` importing a `.mjs` with a
  sibling `.d.mts` typechecks clean under this config). Rejected because it is a second description
  of the resolver's surface, which must be edited whenever the resolver changes — the same
  two-places shape this section exists to close, just moved from the implementation to the types.
  Verified as available if a future need makes direct-call tests more attractive than the subprocess
  cost.

The subprocess cost is real and bounded: each case pays one `node` start plus a `git` shell-out,
which the byte-stability and case-matrix tests amortise by running the script a handful of times, not
per assertion.

## 6. Algorithm

`scripts/build-stamp.mjs` (new, ~80 lines, no dependencies) — **the only resolver**, and the source
of every value in the stamp:

1. Resolve `commit`, `tree`, `env` per §5, then `release` per D6. `git` is invoked with
   `execFileSync("git", [...], { encoding: "utf8" })` and every call is wrapped in a try: a
   non-repository checkout yields `"unknown"`, not a failed build.
2. Write `.build-stamp.json` with a fixed key order, so two builds of the same inputs produce
   byte-identical stamps modulo `builtAt`.
3. Print one line naming what it resolved, so the build log answers the question even if the
   endpoint is unreachable later.
4. Take an injectable environment — `resolve(env, { cwd })` rather than reading `process.env`
   directly — so a single spawn can be driven to any case. This is what makes the resolver testable
   *through the process boundary*: the test sets the child's environment, not the parent's, so cases
   cannot leak into each other and no import is required (see §5 for why an import is not an
   option).

`package.json`: `"prebuild": "npm run pdf:build && node scripts/build-stamp.mjs"`. Declining to add
a second `prebuild` script key because npm runs only one; the existing PDF build must not be
replaced.

`next.config.ts`:

```ts
const stamp = readBuildIdentity(); // parses the stamp; synchronous, total, never throws
const nextConfig: NextConfig = {
  env: {
    APP_COMMIT_SHA: stamp.commit,
    APP_TREE_SHA: stamp.tree,
    APP_DEPLOY_ENV: stamp.env,
    APP_BUILT_AT: stamp.builtAt,
    // The one field with a read-time override (D6). It cannot change the stamp's
    // opinion, only supersede it, and the script applied the same precedence.
    APP_RELEASE_ID: process.env.APP_RELEASE_ID ?? stamp.release,
  },
  ...
};
```

The staging branch name is **not** a magic string: it is a single `STAGING_BRANCH` constant in
`scripts/build-stamp.mjs`, so the mapping has one definition. The test named in §8 spells `"staging"`
literally on purpose: it should fail if the constant is changed without a decision, which is the
point of a constant in one place. If a future staging branch is renamed, that constant and this plan
are the two places to change.

`src/lib/build-identity.ts` (new): `readBuildIdentity()` — the stamp **parser** described in §5, used
by `next.config.ts`, and `readAppIdentity()` — one typed accessor over the inlined `process.env.APP_*`
that routes call, so a route never string-matches a variable name.

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

Two files, because there is one resolver and one parser (§5) and each is tested where it lives.

`tests/build-stamp.test.ts` (new) — drives the script **as a subprocess** (`execFile`, one spawn per
case, env set on the child) and asserts on the `.build-stamp.json` it writes. No import of the `.mjs`;
see §5 for why that is not merely a preference:

| Test | Asserts |
| --- | --- |
| resolution order per field | `APP_COMMIT_SHA` beats `VERCEL_GIT_COMMIT_SHA` beats `git`; `APP_DEPLOY_ENV` beats `VERCEL_ENV` |
| staging is identified by branch | `VERCEL_ENV=preview` + `VERCEL_GIT_COMMIT_REF=staging` → `env:"staging"` |
| a feature preview is not staging | `VERCEL_ENV=preview` + `VERCEL_GIT_COMMIT_REF=feature/x` → `env:"preview"`; also `arena/0cabd00f-solara` → `"preview"` |
| explicit variable wins over the branch | `APP_DEPLOY_ENV=production` + `VERCEL_GIT_COMMIT_REF=staging` → `"production"`, so the future custom environment needs no code change |
| production unaffected | `VERCEL_ENV=production` → `"production"` regardless of branch ref |
| release id shape | `<env>-<7>-<epoch>` from the written stamp; and an explicit `APP_RELEASE_ID` in the child's env is copied through verbatim |
| no git, no throw | spawned with an empty env in a temp dir that is not a repository: exit code 0 and `commit:"unknown"`, not an exception. The child's exit code is the assertion, since an uncaught throw would surface as a non-zero status |
| **stamp artefact, staging** | spawn with `VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=staging`, then read the file it wrote: it parses as JSON and `env === "staging"` — the artefact `next.config.ts` consumes, not the function that produced it |
| **stamp artefact, feature branch** | same, with `VERCEL_GIT_COMMIT_REF=feature/x`, → `env === "preview"`; the two cases together are what a drift between writer and reader would break |
| stamp is byte-stable | two spawns with identical inputs and a frozen `builtAt` produce identical bytes; key order is fixed, not incidental |
| child env is isolated | a case sets `APP_DEPLOY_ENV` in the child only; a following case spawned without it resolves from `VERCEL_ENV`, proving no state crossed (this is what the subprocess boundary buys, and it is worth asserting rather than assuming) |

`tests/build-identity.test.ts` (new) — drives the parser with synthetic stamps:

| Test | Asserts |
| --- | --- |
| absent stamp | every field `"unknown"`, `env` `"local"`, no throw |
| malformed stamp | same — `JSON.parse` failure is caught, not propagated |
| stamp with partial fields | resolved fields kept, missing ones `"unknown"` — not silently empty strings |
| parser does not resolve | a stamp saying `env:"staging"` is returned verbatim even when the ambient env says `production` — the parser must not have a second opinion |
| `builtAt` is stamp time | a stamp with a past timestamp is returned verbatim; it is not `new Date()` at call time |
| release override is applied once | explicit `APP_RELEASE_ID` supersedes in the config mapping, and the stamp's own value is unchanged |

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
| **move `env` resolution out of the stamp script into the reader** — the exact split §5 forbids | the stamp-artefact tests: a spawned run under `VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=staging` writes `env:"staging"`. A reader-side resolver would leave the stamp saying something else, and no test that only imports the reader would notice |
| drop the branch step from the resolver, leaving `VERCEL_ENV` | the staging stamp-artefact test — `env` would be `"preview"` |

## 10. Verification gates

Scoped first — the full suite is expensive and CI runs it on every push.

```bash
npm ci
npx tsx --test tests/build-stamp.test.ts tests/build-identity.test.ts \
  tests/version-route.test.ts tests/ready-route.test.ts
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

For the staging mapping specifically, the check is on the hosted deployment after merge — #164
cannot prove it locally, because `VERCEL_ENV` and `VERCEL_GIT_COMMIT_REF` only exist there:

```bash
# ssoProtection.deploymentType is "all_except_custom_domains", so both *.vercel.app URLs answer a
# login wall to an anonymous curl. Probe with the automation bypass, or with `vercel curl`, which
# adds it:
vercel curl --deployment https://solara-stg.vercel.app/api/version | jq '{env, commit}'
# expect env:"staging", commit == the merge SHA

vercel curl --deployment https://<feature-preview>.vercel.app/api/version | jq '.env'
# expect "preview"
```

An anonymous `curl` returning the SSO page instead of JSON is **not** evidence that the mapping
failed — it is evidence the probe lacks the bypass. Do not record an HTML/401 body here as a wrong
`env`.

If it reports `preview`, the fallback is the explicit `APP_DEPLOY_ENV=staging` variable scoped to
the `staging` branch in Vercel's Preview environment — a control-plane change the operator makes,
named in the decision record rather than assumed.

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

1. **`env` in `next.config.ts` is inlined at build time — but only as a literal member
   expression.** A value read from `process.env` inside a route handler reports the server's
   environment, not the build's. Every identity field must come from the inlined constant; the test
   for this is the `builtAt` assertion.

   **Verified against the built output, and this cost a real bug.** Next 16.4.5 + Turbopack
   substitutes `process.env.APP_COMMIT_SHA` with the literal string, and it does **not** substitute
   an alias (`const e = process.env; e.APP_COMMIT_SHA`, or an `env = process.env` parameter). A
   parameterised reader therefore compiles, typechecks, and passes every unit test, then reports
   `"unknown"` on a real server because the alias is resolved at runtime instead. That is exactly
   what happened here: `readAppIdentity(env = process.env)` returned `"unknown"` for every field on
   `npm run start` while all 16 tests passed. The accessor now has **no** parameters, reads literal
   member expressions, and a test asserts its arity so a refactor cannot silently reintroduce the
   alias.

   Also worth recording: `next start` seeds `process.env` from the config's `env`, so a value read
   at runtime *looks* like it works in local verification. It is the hosted deploy that has no such
   seeding from the stamp, which is why the local test must assert `builtAt` is the build's rather
   than trusting that a value came back at all.
2. **`next start` re-evaluates `next.config.ts`.** Anything expensive or throwing at config
   evaluation is a production-startup risk. `readBuildIdentity()` is synchronous, total, and
   returns `"unknown"` rather than throwing — and because it only parses a file, `next start` on a
   machine that never ran `prebuild` costs one failed `open`, not a `git` subprocess.
3. **`.vercelignore` excludes `tests/` and `drizzle/meta`.** The stamp script must be on the
   allowlist by default (it is not excluded) and must not import from `tests/`.
4. **Vercel's build runs `prebuild` but not `git` reliably.** `VERCEL_GIT_COMMIT_SHA` is the
   primary source, with `git` as a local fallback — not the reverse.
5. **`publicReadiness` is a whitelist.** Adding a field to `Readiness` does not leak it; adding it
   to `PublicReadiness` does. Review the second, not the first.
6. **`VERCEL_ENV` is `preview` on staging**, not `staging` — verified from the deployment metadata
   in §3. Any code that branches on `VERCEL_ENV === "staging"` is dead code. The mapping goes
   through `VERCEL_GIT_COMMIT_REF`, and a test pins it so a Vercel behaviour change surfaces as a
   failing test rather than as a gate passing on the wrong thing.
7. **The 503 path builds its own object.** `handler.ts` constructs a failure `Readiness` literal;
   `commit` must be added there too or the failure response loses identity exactly when someone
   needs it.
8. **Two `prebuild` keys is one key.** npm silently ignores the duplicate; the PDF build would stop
   running. Append to the existing script.
9. **`tests/` is inside the `tsc` program, and `allowJs` is `false`.** So a test that `import`s
   `scripts/build-stamp.mjs` fails `typecheck` with `TS7016` — the same error that forbids a shared
   module in §5, applied to the test instead of the source. It was verified by compiling a `.ts`
   importing a `.mjs`, both with and without a sibling `.d.mts`. Drive the script through
   `execFile`; do not import it. This is the landmine most likely to be re-introduced by a
   well-meaning author who wants a unit test rather than a subprocess test.

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
