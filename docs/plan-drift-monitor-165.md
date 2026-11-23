# Plan: drift monitor for live commit, migration state and in-flight runs (#165)

**Status:** proposed — revision 2. **Issue:** #165 (`8a` in `plan-deployment-alignment.md`).
**Depends on:** #164 (merged `31feb44`), #166 (merged `57745c6`), **#167 (merged `12d08b3`)**.
**Supersedes nothing.** Extends `docs/setup/11-actions-deploys.md` §8, which already carries the
alert contract and the fixtures.

> **Revision 2 exists because #167 merged while revision 1 was under review.** Revision 1 deferred
> the migration half of #165 to #167 on a circularity argument (§3 of the old text). That argument
> was correct *at the time* and is now void: `12d08b3` put `migrations` on `/api/ready` without
> needing a single database credential. All three deliverables of #165 now ship here. §3 records
> the reversal in full rather than quietly dropping it, because the old reasoning is quoted in the
> issue and a future reader will otherwise re-derive the wrong conclusion.

## 1. Why this exists

`/api/version` answers *what is serving*. `/api/ready` answers *what state the schema is in*.
Nothing asks either one on a schedule, so a merge that never became live — or a schema that drifted
— is discovered by a human noticing. That is the gap.

It is also load-bearing for a decision already made: **ADR 012 removes the numeric cap on `ahead`
and states that the bound is time.** This monitor is the only thing enforcing that bound. `#167`
(PR #209) says so in its own risk section and names #165 as the owner. Without this, ADR 012's
tolerance has no compensating control, which is why #165 is a hard prerequisite for #173's approval
gate rather than a follow-up.

## 2. Verified baseline

Every row was read from the repository or the live project during this revision. The two rows
marked **changed** are the ones that invalidate revision 1.

| Fact | Evidence |
| --- | --- |
| `/api/version` returns `{ok, commit, tree, release, env, builtAt}` and **omits `migrations` by design** | `src/app/api/version/handler.ts`; it never touches PostgreSQL |
| **changed:** `/api/ready` public payload is `{ok, db, auth, commit, migrations}` | `src/app/api/ready/handler.ts` @ `12d08b3`; `migrations: MigrationState` |
| `MigrationState` = `exact \| ahead \| behind \| diverged` | `src/lib/readiness.ts:8` |
| **`ahead` is *ready*** — `ok` requires `migrationState === "exact" \|\| "ahead"` | `src/lib/readiness.ts:178` |
| A **thrown probe** returns `db: "error"` **and** `migrations: "diverged"` | `src/app/api/ready/handler.ts` catch path |
| `/api/ready` returns **200 or 503**, both with a JSON body | same handler; `status: result.ok ? 200 : 503` |
| Staging is SSO-protected | project `ssoProtection.deploymentType = "all_except_custom_domains"` |
| No workflow uses `schedule:` or creates an issue | `.github/workflows/` — `ci.yml`, `migrate.yml` only |
| `migrate.yml` permissions are `contents/actions/pull-requests: read` | `.github/workflows/migrate.yml:48` |
| `migrate.yml` downloads another run's artifact with `actions: read` | `migrate.yml:153` (`gh run download`) |
| A job with `environment:` creates a **GitHub Deployment** (`task=deploy`) | `repos/.../deployments` — e.g. `7899060165 env=staging task=deploy` |
| Environment **branch policies are not yet enforced** (`deployment_branch_policy: null`) but are *documented* | `gh api .../environments`; `11-actions-deploys.md` §2 |
| Documented policies: `staging`→branch **`staging`**, `production`→branch **`main`** | `11-actions-deploys.md:47-49`; `plan-deployment-alignment.md:215` |
| A scheduled workflow runs on the **default branch** (`main`) | GitHub behaviour; landmine 1 |
| `.github/workflows/` on `main` contains only `ci.yml`, `migrate.yml` | `gh api .../contents/.github/workflows?ref=main` |
| Canonical domains already used throughout the docs | `solara-stg.vercel.app` (21 refs), `solara-production.vercel.app` (16 refs) |
| **`#167` is CLOSED** (merged `12d08b3`) | `gh issue view 167` → `state: CLOSED` |
| **`#164` is CLOSED** and still reachable from `staging` | `gh issue view 164` → `closedAt 2026-11-23T03:37:17Z` |
| Production `main` (`4490ced`) predates #164 | `4490ced` is `origin/main`; #164 landed on staging only |

## 3. What changed since revision 1, and the reversal

Revision 1 argued that #165 scope item 3 (*"alerts when `migrations` is not `exact`"*) could not be
built because:

1. `migrations` was absent from `/api/version`;
2. `migrations` was absent from `/api/ready`'s public payload;
3. **#167 `Depends on: #166, #165`**, making the item circular.

At `12d08b3` premises 1 and 2 are **false**: #167 chose `/api/ready`, not `/api/version`, and that
choice is what breaks the circle — `/api/ready` already talks to PostgreSQL, so exposing the ADR 012
state string there costs the monitor **zero credentials**, whereas the rejected `migrate.yml
mode=verify` route needed `DATABASE_URL_STAGING_READONLY`. Premise 3 is moot because #167 is closed.

**Reversal:** the migration half ships in #165, reading `/api/ready`. Nothing is deferred to #167 —
deferring to a closed issue would leave ADR 012's time bound owned by nobody, which is precisely the
failure #167's risk section anticipates.

**The rejection of the `mode=verify` route stands and is now vindicated.** It was rejected for
widening the credential surface; #167 produced a better source that needs none. Recorded so the
route is not resurrected.

### One deliberate deviation from the review's literal text

The review asks for *"`migrations !== "exact"` past the 20-minute horizon"*. Implemented literally
that is wrong in two directions, both verified in `src/lib/readiness.ts`:

- **`ahead` is a normal, ready state.** `ok` is true for `exact || ahead` (line 178), so the schema
  is *usable*; ADR 012's time bound exists precisely because `ahead` is legitimately transient
  during a deploy window. So `ahead` gets the **20-minute horizon** — quiet, then alert. That is
  the time bound ADR 012 asks for.
- **`behind` and `diverged` are fatal, not transient.** They already make readiness return **503**.
  Making them wait 20 minutes would delay an alert for a state the application itself reports as
  broken. They alert **on first observation**, no horizon.

So: `ahead` → time-bounded; `behind`/`diverged` → immediate. This alerts strictly sooner than the
literal rule and never later, and it is the reading `readiness.ts:178` supports.

## 4. Decisions

| # | Decision | Why |
| --- | --- | --- |
| **D1** | **All three halves ship in #165**: commit drift, migration state, run awareness | #167 closed the circularity (§3). Deferring now would orphan ADR 012's time bound |
| **D2** | One **issue per environment**, matched by exact title, **`!pull_request`**, and a **trusted author** (`github-actions[bot]` or repo owner) | The repository is public; title-only matching lets any user spoof the body's state block and silence the alert (§F7) |
| **D3** | **Two state stores, reconciled**: a short-lived per-environment artifact for the *pre-alert* clock, the issue HTML comment for the *post-alert* one | Revised from "issue body only". A clock that must run *before* anything is opened has nowhere to live in an issue (§F2). Artifacts alone expire, so the issue body covers multi-week alerts — each store covers the other's gap |
| **D4** | **No alert while a `queued` or `in_progress` run** exists for that environment | Designed states. Alerting trains the operator to ignore alerts |
| **D5** | A `waiting` run is **quiet until the 60-minute approval horizon**, then alerts **once**, keyed by `(runId, runAttempt, environment)` | Suppressing every `waiting` lets a release wait forever |
| **D6** | The approval clock starts from the **`created_at` of the `waiting` status on that run's `production-migrations` GitHub Deployment**, else the persisted first observation. **Never** job `started_at`, run `created_at`, or deployment `created_at` | A job blocked on approval never starts, so `started_at` may not exist; creation is not the transition into `waiting` |
| **D7** | Three constants, named once: **cadence 15 min**, **stale/migration horizon 20 min**, **approval horizon 60 min** | Different legitimate durations; one shared threshold either pages on a normal deploy or never fires |
| **D8** | The bounded error is **`cadence + horizon`** (35 min / 75 min) | First observation lags the true transition by up to one cadence. Naming it stops the horizon being read as exact |
| **D9** | Network/API failure **fails open for the run, closed for the clock**: exit 0, log `degraded`, **re-upload the prior state unchanged**, never write an observation it could not verify | Paging on the monitor's own outage is worse than brief blindness; a fabricated baseline corrupts the horizon permanently |
| **D10** | The monitor **never writes to the repository, never deploys, never migrates, never creates GitHub Deployments** | Read-only plus issue writes. Deployments are the record ADR 012 and #174 rely on (§F3) |
| **D11** | `ahead` is **time-bounded**; `behind`/`diverged` alert **immediately**; a **`db: "error"` probe failure is `unknown`, not `diverged`** | §3 deviation, plus the catch path's `diverged` is a *probe* verdict — a DB outage must not page as "schema diverged" |
| **D12** | Classification is a **total order, first match wins**, and **no `exact` short-circuit before the checks that guard it** | `head === live` alone would close an issue while the schema is broken or the endpoint answers from the wrong environment (§F5b) |

## 5. Workflow shape

**One job, one matrix leg per environment, on a dedicated `monitoring` environment.**

```yaml
permissions:
  contents: read      # checkout
  actions: read       # previous run's state artifact, run lookup
  deployments: read   # the production-migrations deployment status (§D6)
  issues: write       # the alert

concurrency:
  group: drift-monitor-${{ matrix.target }}
  cancel-in-progress: false

jobs:
  monitor:
    environment: monitoring          # NOT staging, NOT production — see below
    strategy:
      fail-fast: false               # a staging failure must not skip production
      matrix:
        target: [staging, production]
```

### Why `monitoring` and not the deployment environments

Revision 1 planned `environment: staging` and `environment: production`, one job each, on the
reasoning that an environment key is what makes an environment secret readable. That reasoning was
right about secrets and wrong about environments, for two independently fatal reasons:

1. **Branch-policy collision.** Scheduled runs execute on `main` (landmine 1). `11-actions-deploys.md`
   §2 documents `staging` as **branch `staging`** and `production` as **branch `main`**. So
   `monitor-production` happens to be legal, but `monitor-staging` on `main` is exactly what a
   staging branch policy exists to reject — the job would die before its first step the moment the
   policy is enforced. It is `null` today (§2), which makes this a latent trap rather than a
   present failure: the monitor would work in testing and break when the policy is turned on.
2. **GitHub Deployment pollution.** Verified: a job with `environment:` creates a Deployment with
   `task=deploy` (§2, `deployments` rows). At 96 ticks/day × 2 jobs that is **~192 fabricated
   `success` Deployments per day** — marking `main`'s SHA as active in staging and as successfully
   deployed in production every 15 minutes, *including while a real production deploy is waiting on
   `production-migrations`*. That corrupts the record ADR 012 and #174 (8b) read, and violates D10.

**Fix:** a dedicated `monitoring` environment — branch policy `main`, **no required reviewer**, and
**one secret only**: `VERCEL_AUTOMATION_BYPASS_SECRET`. Never `DATABASE_URL*`, never `VERCEL_TOKEN`.
The row is added to `11-actions-deploys.md` §2 in the implementation PR.

**Correction to the review on this point.** F3 says `staging` is restricted to branch `staging` *and*
proposes a single `monitoring` environment for both targets. The first half is right and confirmed;
the second is right for secrets but the review's stated rationale ("one project-level bypass token")
is only half the reason — the decisive one is that **`production`'s documented policy is already
branch `main`**, so the two-target problem is specific to staging. A single `monitoring` environment
also collapses the matrix to **one secret read**, which is simpler than revision 1's two jobs.

If staging and production ever split into separate Vercel projects, the matrix gains
`VERCEL_AUTOMATION_BYPASS_SECRET_STAGING` / `_PRODUCTION` rather than repository-scoping anything.

## 6. Contract

### What the monitor reads

```text
GET https://solara-stg.vercel.app/api/version         GET https://solara-production.vercel.app/api/version
  -> 200 {ok, commit, tree, release, env, builtAt}      identity: which build is serving

GET https://solara-stg.vercel.app/api/ready           GET https://solara-production.vercel.app/api/ready
  -> 200 | 503 {ok, db, auth, commit, migrations}       schema: exact | ahead | behind | diverged
```

Both hosts, both endpoints, the same header:

```text
x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET
```

- **A 503 with a JSON body is a successful read, not a failure.** It is how readiness reports
  `behind`, `diverged`, or `db: "error"`; the body is the payload. Only a non-JSON body is a failure.
- **Domains are defaults, overridable** by `--staging-url` / `--production-url` so `--dry-run` can be
  pointed at a preview without editing the workflow. The values above are already the documented
  canonical hosts (§2).
- **No database credential is used anywhere in this workflow.** That is the whole point of taking
  `migrations` from `/api/ready`.
- **Pre-promotion production is expected to be absent.** `4490ced` predates #164, so
  `/api/version` 404s and `/api/ready` has no `commit`/`migrations`. An absent field is `unknown` for
  that check — never drift. The commit check degrades the same way. This window closes when
  promotion lands; the monitor must be correct *during* it, not only after.

### What is compared

| Environment | Expected `env` | Branch head | Live identity | Schema |
| --- | --- | --- | --- | --- |
| `staging` | `staging` | `repos/{repo}/commits/staging` | `/api/version.commit` | `/api/ready.migrations` |
| `production` | `production` | `repos/{repo}/commits/main` | `/api/version.commit` | same |

### Runs consulted (F5a)

`/repos/{repo}/actions/runs` has **no `environment=` filter**, so the query is by `workflow_id` and
the results are filtered in code. Only workflows that *deploy or migrate* count:

| Environment | Workflows |
| --- | --- |
| `staging` | `deploy-staging.yml`, `migrate.yml` (env `staging`) |
| `production` | `deploy-production.yml`, `migrate.yml` (env `production`) |

**`ci.yml` and `drift-monitor.yml` are excluded by name.** Without this the monitor sees *itself*
`in_progress` on `head_branch: main` on every tick and suppresses every alert forever — a
permanently blind monitor that reports healthy. A `404` for a workflow that does not exist yet
(`#171`/`#173` have not created `deploy-*.yml`) is **`[]`, never `unknown`**; "the mechanism does not
exist" is a different fact from "the query failed".

### The approval clock source (D6, spelled out)

`resolveApprovalWaitStart` tries, in order:

1. **`created_at` of the `waiting` deployment status.** Query
   `/deployments?sha={head_sha}&environment=production-migrations` → the run's deployment ID →
   `/deployments/{id}/statuses` → the status whose `state === "waiting"`. That timestamp is the
   transition into `waiting`, which is exactly the interval the 60-minute horizon bounds.
2. **The persisted first observation**, keyed `(runId, runAttempt, environment)`.

Explicitly **rejected** as sources, each for a different reason, each with a unit test: `job.started_at`
(a job blocked on approval may never start), run `created_at` (a run waits on other jobs first), and
deployment `created_at` (creation is not the transition into `waiting`).

### Alert payload

```markdown
<!-- drift-monitor:{"environment":"staging","kind":"stale-commit","liveCommit":"def5678",
"headCommit":"abc1234","migrations":"exact","runId":null,"runAttempt":null,
"firstObserved":"2026-11-23T04:10:00Z","alertedAt":"2026-11-23T04:44:12Z"} -->

Environment: **staging**
Branch head: `abc1234` `docs: something #1234`
Live commit: `def5678` (behind head)
Schema: `exact`
In-flight runs: none
Diverged for: 34 minutes (first observed 04:10Z, alerted 04:44Z)

Last checked: 2026-11-23T04:44:12Z
```

The comment is the durable state; the visible text is for humans and may be edited freely. Commit
headlines are wrapped in backticks and their `#`/`@` tokens neutralised, so a crafted commit message
cannot `@mention` a user or forge a `#42` cross-reference into the issue (F7). The bypass secret is
never logged and never enters the body (landmine 8).

### Exit behaviour

| Situation | Exit | Effect |
| --- | --- | --- |
| Healthy | 0 | Close the issue if open; clear state |
| Drift past horizon | 0 | Open or update the one issue |
| In-flight / young wait / young `ahead` | 0 | Persist the clock; **never** close an open issue while a run is in flight |
| **401 / 403 / SSO HTML / SSO redirect** | **1** | **Hard failure** — a missing or rotated bypass secret must not be silently green |
| Transient 5xx or network error | 0 | `degraded`; re-upload prior state unchanged (D9) |
| Malformed JSON body | 0 | `unknown`; an HTML login page is not a schema verdict |
| Bug in the monitor | non-zero | A red run means "the monitor is broken", never "production drifted" |

Revision 1 had every row exit 0, which made a rotated secret invisible forever (F8). The split is:
**`unknown` (cannot tell) is 0; `rejected` (told it may not look) is 1.** `11-actions-deploys.md:53`
already says a 401/403 during verification is a hard failure, never a skip.

## 7. State

### Why two stores (F2)

Revision 1 stored state **only** inside an open alert issue, and claimed "nothing is cached between
ticks except the issue body". That is a permanent amnesia bug:

```text
t=0m   healthy, no issue open. Drift appears. age 0 < 20m horizon -> no alert (correct).
       Nothing is open, so there is nowhere to record t0.
t=15m  previousState is null again. firstObserved := now. age 0. No alert.
       ... forever. Neither horizon can ever expire.
```

Any state the monitor needs **before** it is allowed to alert cannot live in the thing the alert
creates. Revision 1's own rejection of artifacts ("they expire and are per-run") was right about
*durability* and wrong about *necessity* — so revision 2 uses both, and they cover each other's gaps:

| Store | Carries | Lifetime | Why it is the right one |
| --- | --- | --- | --- |
| `drift-state-<env>.json` artifact | the **pre-alert clock**: `{environment, kind, liveCommit, headCommit, migrations, runId, runAttempt, firstObserved, alerted:false}` | `retention-days: 5` | ~480× the tick interval; readable with `actions: read`; commits nothing to `main`; no external dependency |
| `<!-- drift-monitor:... -->` in the issue | the **post-alert record** and `alertedAt` | until the issue closes | survives artifact expiry, so a multi-week open alert keeps its real age |

**Read at tick start:** `gh run list --workflow drift-monitor.yml --status completed` → newest
successful run → its `drift-state-<env>.json` artifact. Matches `migrate.yml:153`'s existing
`actions: read` pattern. Missing artifact (first run, expiry, or a failed predecessor) = **first
observation**, not an error.

**Reconcile:** if the issue comment exists, its `firstObserved` wins for the post-alert clock (it is
older and never expires); the artifact is re-seeded from it. If only the artifact exists, it seeds a
new issue. On `degraded`/`rejected` ticks the prior artifact is **re-uploaded unchanged** (D9), so an
in-progress clock is never reset by an outage.

**Validate on read:** `state.environment` must equal the leg's target, and a `firstObserved` in the
future is **clamped to now** (F7). A rejected or clamped read is logged, never trusted.

## 8. Algorithm

### `classifyDrift` — a total order (F5b)

First match wins. The order is the design; every clause exists because an earlier draft tested it
out of turn.

```text
(a) unreachable / malformed JSON / commit === "unknown"
        -> unknown                (never drift; exit 0, or 1 if rejected per §6)
(b) ready present && db === "error"
        -> unknown                (a probe failure reports migrations:"diverged"; it is not drift)
(c) version.env !== expectedEnv
        -> env-mismatch           (guarded before exact; otherwise the wrong environment reads as healthy)
(d) deploy/migrate run queued | in_progress
        -> pending
(e) deploy/migrate run waiting
         < 60m -> awaiting-approval ; >= 60m -> overdue-approval
(f) head !== live
         < 20m -> observing-commit ; >= 20m -> stale-commit
(g) migrations present && !== "exact"
         behind|diverged -> stale-migrations        (immediate, §3)
         ahead < 20m     -> observing-migrations ; ahead >= 20m -> stale-migrations
(h) otherwise -> exact
```

`exact` is the **last** resort, not the first success. `head === live` alone is not health: the schema
can be `behind` after manual DDL, and the endpoint can answer from the wrong environment.

The **20-minute clock is per subject**, not per environment: `firstObserved` is reset when
`liveCommit` advances (a fresh deploy is a fresh observation, not stale by inheritance) and when the
`migrations` state changes. Without `liveCommit` in state, `sha0`'s clock would false-alert on a
two-minute-old `sha2`.

### `decideAlert` — reconciled (F5d)

| `previousIssue` | Observation vs previous | Action |
| --- | --- | --- |
| none | any, past horizon | **open** |
| none | any, before horizon | **none** (persist clock) |
| open | `(kind, liveCommit, headCommit, migrations, runId, runAttempt)` unchanged | **none** (idempotent) |
| open | any of those fields changed | **update** — otherwise a `stale-commit` → `overdue-approval` transition leaves stale text |
| open | now `exact` and nothing in flight | **close** |
| open | in flight | **none** — *never close while a run is in flight* |

Revision 1 said both "second identical tick → `none`" and "repeated ticks update one issue", which
cannot both hold. This table is the resolution: `none` when nothing changed, `update` when anything
in the tuple did.

## 9. Fixtures and tests

### `tests/drift-monitor.test.ts` — pure functions, no network

| Test | Asserts |
| --- | --- |
| exact | `head === live`, `migrations: "exact"` → `exact`, no alert |
| stale commit under 20m | differs 5m ago → `observing-commit`, quiet |
| stale commit past 20m | differs 25m ago → `stale-commit`, alert |
| **multi-tick progression** | healthy (`previousIssue: null`) at t0/t+15/t+20 → clock persists across ticks and eventually alerts (**kills the F2 amnesia bug**) |
| live advance resets clock | `stale-commit` at `sha0`, then `live = sha1` → `observing-commit`, not stale |
| queued run suppresses | differs, `queued` → `pending` |
| in-progress run suppresses | differs, `in_progress` → `pending` |
| **in-flight preserves an open issue** | `previousIssue` open + `in_progress` → action `!== "close"` (**mutation 9**) |
| young waiting is quiet | `waiting` 10m → `awaiting-approval`, no alert |
| overdue waiting alerts once | `waiting` 90m, no issue → `overdue-approval`, open |
| **attempt superseded (young)** | `run_attempt: 2` at 5m **and** expired `run_attempt: 1` at 90m → `awaiting-approval`, quiet |
| **attempt superseded (overdue)** | `run_attempt: 2` at 90m, `run_attempt: 1` already alerted → `overdue-approval`, alerts |
| approval start rejects wrong sources | `job.started_at`, run `created_at`, deployment `created_at` each rejected as a clock source |
| **`ahead` young vs old** | `ahead` 5m → quiet; `ahead` 25m → `stale-migrations` |
| **`behind`/`diverged` are immediate** | either at 1m → `stale-migrations`, alerts (§3 deviation) |
| **`db: "error"` is not drift** | `db: "error"`, `migrations: "diverged"` → `unknown` |
| **`head === live` does not hide schema drift** | equal commits + `behind` → `stale-migrations` |
| env mismatch | `version.env: "production"` on the staging leg → `env-mismatch` |
| malformed body is not drift | HTML login page → `unknown`, no write |
| 503 JSON is a read | `{ok:false, migrations:"behind"}` at 503 → `stale-migrations` |
| pre-promotion production | 404 `/api/version`, no `migrations` → `unknown`, not drift |
| duplicate overdue ticks | identical tuple twice → `none`, then a changed field → `update` |
| cross-env isolation | staging's state never suppresses or closes production's |
| untrusted issue | issue with the right title from another author → ignored |
| future `firstObserved` | `2099-…` → clamped to now |
| commit headline escaping | `fix @someone #42` → no mention, no cross-ref |

### `tests/drift-monitor-workflow.test.ts` — the YAML is asserted, not trusted

| Test | Asserts |
| --- | --- |
| schedule | `cron:` present, 15-minute cadence |
| **single `monitoring` environment** | `environment: monitoring`; **no** `staging`/`production` environment (**kills the Deployment-pollution and branch-policy bug**) |
| matrix | `target: [staging, production]`, `fail-fast: false` |
| **permissions** | exactly `{contents: read, actions: read, deployments: read, issues: write}`; **no** `contents: write`, `deployments: write`, `pull-requests: write`, `packages: write`, `id-token: write` |
| concurrency | `cancel-in-progress: false`, group includes the target |
| secrets | only `VERCEL_AUTOMATION_BYPASS_SECRET`; no `DATABASE_URL` |
| artifact | `retention-days: 5`, name contains the target |
| dispatchable | `workflow_dispatch:` with a `dry_run` input (post-promotion only, §11) |

## 10. Mutations (SEC-07)

| Mutation | Must fail |
| --- | --- |
| alert on `in_progress` | "in-progress run suppresses" |
| close an open issue while a run is in flight | "in-flight preserves an open issue" |
| suppress every `waiting` | "overdue waiting alerts once" |
| reset `firstObserved` every tick | "multi-tick progression" |
| store the clock only in the issue | "multi-tick progression" |
| treat an unreachable endpoint as drift | "unreachable endpoint is not drift" |
| treat an HTML body as a mismatch | "malformed body is not drift" |
| key state by environment only, not attempt | "attempt superseded (overdue)" |
| bind a job to `environment: staging` | "single monitoring environment" |
| add `contents: write` | "permissions" |
| drop `actions: read` | "permissions" |
| exclude nothing from the run query | "in-progress run suppresses" (the monitor sees itself) |
| return `exact` before the schema check | "`head === live` does not hide schema drift" |
| treat `diverged` from a probe failure as drift | "`db: error` is not drift" |
| alert on young `ahead` | "`ahead` young vs old" |
| wait 20m on `behind` | "`behind`/`diverged` are immediate" |
| drop the trusted-author filter | "untrusted issue" |
| skip `firstObserved` clamping | "future `firstObserved`" |

## 11. Verification gates

```bash
npm run typecheck
npm run lint
npx tsx --test tests/drift-monitor.test.ts tests/drift-monitor-workflow.test.ts
```

**Before merge — a local dry run of the real entrypoint, not a workflow dispatch (F4):**

```bash
npx tsx scripts/drift-monitor.ts --env staging --dry-run --fixture tests/fixtures/ready-behind.json
```

`workflow_dispatch` **cannot** be used before merge: `drift-monitor.yml` is not on `main` (verified:
`main` has only `ci.yml`, `migrate.yml`), and GitHub returns **HTTP 404** for dispatching a workflow
that does not exist on the default branch, even with `--ref <branch>`. Revision 1 made this a
pre-merge gate and a DoD box, which was unsatisfiable. `--dry-run` prints the classification and the
would-be action and writes nothing.

**After promotion to `main` (operator):**

```bash
gh workflow run drift-monitor.yml --ref main -f dry_run=true
```

Live acceptance: healthy tick → no issue; `ahead` older than 20 minutes → `stale-migrations` within
one cadence; close the issue by hand → it reopens once, not every tick.

## 12. Rollout and compatibility

- **No migration, no schema change, no deploy-path change.** One workflow, one script, one lib.
- This is the repository's **first scheduled workflow**, and a schedule runs from `main` (landmine 1).
- **One environment row is added** to `11-actions-deploys.md` §2: `monitoring`, branch `main`, no
  reviewer, one secret.
- **Permissions are explicit and complete** (D5/F6). An explicit `permissions:` map sets every
  omitted scope to `none`; omitting `actions: read` or `deployments: read` yields
  `403 Resource not accessible by integration` on exactly the endpoints this design depends on.
- **Cost:** 96 runs/day × 2 legs; each reads four URLs and the Actions API. **It consumes no
  deployments** — relevant on Hobby's 100/day allowance. It creates **no GitHub Deployments** (§5).
- **`.vercelignore` and `tests/deployment-inputs.test.ts`** gain `scripts/drift-monitor.ts`, matching
  `scripts/check-migration-safety.ts`; the script is CI-only and must not enter the deployment input.
- Rollback: revert, close any open drift issue.

## 13. Tracker and PR

1. **#165** `status:ready` → `in-review` when the implementation PR opens.
2. **Nothing is deferred to #167** — it is closed and its risk section counts on #165 (§3).
3. Implementation PR title `ci: drift monitor for live commit, migration state and in-flight runs
   (#165)`, labels `type:ci`, `area:ci`, and **`deploy:required`** — it adds `src/lib/`,
   `scripts/`, and `.github/workflows/`, which `PR_WORKFLOW.md` §2.1 classifies as deploy:required.
   (Revision 1 said `deploy:skip`; that was wrong for a PR touching those paths.)
4. Note for **#174** (`8b`): same workflow, add the Deployments check. **Do not build a second monitor.**

## 14. Landmines

1. **A scheduled workflow runs from the default branch (`main`).** Merging to `staging` does not
   start it, and it cannot be dispatched until it is on `main` (§11).
2. **Staging is SSO-protected.** Without the header the endpoint returns **HTML**. Treat it as
   `unknown` — but a 401/403 or an SSO redirect is `rejected`, which exits **1** (§6).
3. **`/api/version`'s `env` is `staging`, not `preview`.** Verified live. Never re-derive it.
4. **Deleting the HTML comment loses `alertedAt`** and silently restarts the post-alert clock. The
   parser tolerates a missing block as a first observation.
5. **`started_at` does not exist for a job blocked on approval.** Corrected twice in the issue.
6. **Two overlapping ticks race on state.** Hence per-target `concurrency` with
   `cancel-in-progress: false`.
7. **Production has no Actions runs** while it deploys via `deploy.sh`. Absence of signal is not a
   clean bill of health.
8. **The endpoint is unauthenticated.** Never log the bypass secret or headers into a body.
9. **An environment-bound job creates a GitHub Deployment** — verified, `task=deploy`. Two jobs × 96
   ticks = ~192/day of fabricated `success` records (§5).
10. **`ahead` is `ok`.** `readiness.ts:178` accepts `exact || ahead`; only the *time* bound makes it
    a problem (ADR 012).
11. **A thrown readiness probe reports `migrations: "diverged"` with `db: "error"`.** Checking
    `migrations` before `db` turns a database outage into a schema alert.
12. **`/api/runs` has no environment filter and sees the monitor itself.** Filter by workflow (§6).

## 15. Definition of done

- [ ] `scripts/drift-monitor.ts` + `src/lib/drift-monitor.ts` + `.github/workflows/drift-monitor.yml`;
      the three constants documented in `docs/setup/11-actions-deploys.md` §8, and the `monitoring`
      environment row in §2.
- [ ] Commit drift detected **within one tick of the horizon** (`cadence + horizon`), and a healthy
      environment produces no issue.
- [ ] `migrations !== "exact"` alerts: `ahead` past 20 min, `behind`/`diverged` immediately.
- [ ] A queued/in-progress run, a young waiting run, or a young `ahead` suppresses the alert; an
      overdue wait does not.
- [ ] Alert is idempotent: repeated ticks update one issue. *(#165 acceptance, verbatim)*
- [ ] Threshold documented in `docs/setup/11-actions-deploys.md`. *(#165 acceptance, verbatim)*
- [ ] The pre-alert clock survives a healthy start and a `degraded` tick (F2 regression test).
- [ ] No job binds to `staging` or `production`; permissions are exactly the four scopes; `--dry-run`
      output pasted into the PR Evidence.
- [ ] No new database credential; no deployment consumed; no GitHub Deployment created.
