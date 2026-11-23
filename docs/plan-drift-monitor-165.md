# Plan: drift monitor for live commit, migration state and in-flight runs (#165)

**Status:** proposed. **Issue:** #165 (`8a` in `plan-deployment-alignment.md`). **Depends on:** #164
(merged `31feb44`).
**Supersedes nothing.** Extends `docs/setup/11-actions-deploys.md` §8, which already carries the
alert contract and the fixtures.

## 1. Why this exists

`/api/version` now answers *what is serving*. Nothing asks it on a schedule, so a merge that never
became live is discovered by a human noticing. That is the gap.

It is also load-bearing for a decision already made: ADR 012 removes the numeric cap on `ahead` and
states that **the bound is time**. This monitor is the only thing enforcing that bound. Without it,
ADR 012's tolerance has no compensating control — which is why #165 is a hard prerequisite for
#173's approval gate, not a follow-up.

## 2. Verified baseline

Read from the repository and the live deployment, not assumed.

| Fact | Evidence |
| --- | --- |
| `/api/version` returns `{ok, commit, tree, release, env, builtAt}` | `31feb444` live: `commit` = staging tip, `tree` = `git rev-parse 31feb44^{tree}` |
| `/api/version` omits `migrations` by design | plan §4 of #164; `src/app/api/version/handler.ts` |
| `/api/ready` public payload is `{ok, db, auth, commit}` | `src/app/api/ready/handler.ts:21` |
| Staging is SSO-protected | project `ssoProtection.deploymentType = "all_except_custom_domains"` |
| No workflow uses `schedule:` or creates an issue | `.github/workflows/` — `ci.yml`, `migrate.yml` only |
| `ci.yml` runs on `pull_request` and `push: [main, staging]` | `.github/workflows/ci.yml:3-6` |
| The `staging` GitHub Environment has **no** protection rules | `gh api .../environments/staging` → `protection_rules: []` |
| A scheduled workflow runs from the **default branch** (`main`) | repository setting |
| Production still deploys via `scripts/deploy.sh`, not Actions | `docs/setup/11-actions-deploys.md:37` |

## 3. The scope conflict, and its resolution

#165's scope item 3 says *"alerts when `migrations` is not `exact`"*. **That cannot be built yet**, and
the reasons stack:

1. `migrations` is not in `/api/version` — the four-state classifier is #167.
2. `migrations` is not in `/api/ready`'s public payload — counts are development-only detail.
3. **#167 `Depends on: #166, #165`** — the classifier depends on this monitor.

So item 3 as written is circular: it waits on #167, which waits on this issue.

**Resolution: ship the commit-drift and run-awareness halves now; defer the migration half to #167
with a named trigger.** This is the same shape as #164's `migrations` decision, and for the same
reason: a field whose value would be a guess is worse than an absent field.

**The deferred piece is not dropped — it gets a different source.** When #167 lands, `migrations`
appears in both endpoints and this monitor reads it from `/api/version` as originally intended. An
alternative existed (query `migrate.yml` `mode=verify` for the applied set) and is **rejected for now**
because it needs `DATABASE_URL_STAGING_READONLY` in the scheduled job's environment, which widens the
credential surface of a job that otherwise needs nothing but a URL. If #167 slips and the time bound
is needed sooner, that is the fallback — recorded rather than silently available.

## 4. Decisions

| # | Decision | Why |
| --- | --- | --- |
| **D1** | Two halves: **commit drift** and **run awareness** ship now; **migration state** defers to #167 | §3. The circular half cannot be tested, and a speculative field is worse than none |
| **D2** | The alert is **one GitHub issue per environment**, matched by an exact title | The issue body is the only durable store available across ticks (see D3). One issue, updated in place, is also what #165's acceptance requires |
| **D3** | Monitor state lives **in the alert issue body**, parsed from an HTML comment | No new dependency, no database, no artifact-retention window. Artifacts expire and are per-run; a committed state file would make the monitor a committer to `main`, which §9 and the cutover checklist both forbid |
| **D4** | **No alert while a run is `queued` or `in_progress`** for that environment | Those are designed states. Alerting on them trains the operator to ignore the alert |
| **D5** | A `waiting` run is **quiet until the approval horizon**, then alerts **once**, deduplicated per `(run_id, run_attempt, environment)` | `11-actions-deploys.md` §8. Suppressing every `waiting` would let a release wait forever, which the plan's DoD forbids |
| **D6** | The approval-wait start is a **verified API timestamp if one exists, else the monitor's persisted first observation** keyed by `(run_id, run_attempt, environment)`. Never job `started_at`, never deployment creation time | A job blocked on approval may never start, so `started_at` may not exist; a deployment's creation is not the transition into `waiting` |
| **D7** | Two horizons, not one: **stale-commit ~20 min**, **approval-wait ~60 min** | Different legitimate durations. One shared threshold either pages on a normal approval or never fires |
| **D8** | The bounded error on the approval clock is **`cadence + horizon`**, stated in the doc | The monitor can only see `waiting` on a tick; first observation lags the true transition by up to one cadence. Naming it stops a future reader treating the horizon as exact |
| **D9** | Every network/API failure **fails open for the run, closed for the claim** — the tick exits 0 with a `degraded` note and **never** records a "first observation" it could not verify | A monitor that pages on its own outage is worse than one that is briefly blind, but a fabricated baseline would corrupt the horizon permanently |
| **D10** | The monitor **never writes to the repository, never deploys, never migrates** | It is read-only plus issue writes. Anything else makes it a second deployer |

## 5. Contract

### Workflow shape (two jobs, not one loop)

```yaml
jobs:
  monitor-staging:
    environment: staging      # required to read the environment-scoped bypass secret
  monitor-production:
    environment: production
```

Each job is one environment. See §11 and §13.9 for why one job cannot serve both.

### What the monitor reads

```text
GET https://<stable-domain>/api/version
  -> { ok, commit, tree, release, env, builtAt }
```

- `x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET` when the secret is set. Staging is
  SSO-protected; without the header the response is a login page, and **an HTML body must be treated
  as a failure, not as a mismatch** (see D9).
- The endpoint is authoritative for *what is live*. It is never assumed to reflect the branch.

### What the monitor compares

| Environment | Branch head (API) | Live commit (endpoint) | Alert when |
| --- | --- | --- | --- |
| `staging` | `repos/{repo}/commits/staging` | `/api/version.commit` | head ≠ live, past the stale horizon, and no in-flight/young-waiting run |
| `production` | `repos/{repo}/commits/main` | `/api/version.commit` of the production domain | same rule |

**Production is included from day one, deliberately.** It deploys via `scripts/deploy.sh`, not
Actions, so there are no Actions runs to consult — the run-awareness checks are simply absent for it,
not skipped silently. Including it means the monitor is useful before cutover instead of after, and
it means a staging-only monitor cannot hide a production drift.

### Alert payload (the issue body)

```markdown
<!-- drift-monitor:{"environment":"staging","firstObserved":"2026-11-23T04:10:00Z",
"runId":null,"runAttempt":null,"kind":"stale-commit"} -->

Environment: **staging**
Branch head: `abc1234` (docs: something #42)
Live commit: `def5678`
Diverged for: 34 minutes (first observed 04:10Z)
In-flight runs: none

Last checked: 2026-11-23T04:44:12Z
```

The HTML comment is the state: machine-readable, invisible in the rendered issue, and impossible to
lose by editing the visible text. The check **reuses it if present** and preserves `firstObserved`, so
the age is real rather than resetting every tick.

### Exit behaviour

| Situation | Exit | Effect |
| --- | --- | --- |
| Healthy | 0 | Close the issue if open (idempotent) |
| Drift past horizon | 0 | Open or update the one issue |
| In-flight / young wait | 0 | No change; never closes an open issue while a run is in flight |
| API or endpoint unreachable | 0 | Log `degraded`; **do not** touch `firstObserved` |
| Malformed endpoint body | 0 | Same as unreachable — an HTML login page is not a mismatch |

A non-zero exit is reserved for a **bug in the monitor itself**, so a red run means "the monitor is
broken", never "production drifted". Drift is a designed state, reported by the issue.

## 6. Algorithm

`scripts/drift-monitor.ts` (new), executed by `.github/workflows/drift-monitor.yml`. Logic in
`src/lib/drift-monitor.ts` as pure functions, following the `#166` precedent (`src/lib/migration-safety.ts`
+ `scripts/check-migration-safety.ts`): the script does I/O, the module decides.

1. **Snapshot.** Fetch the branch head for each environment, the endpoint payload, and the Actions
   runs for that environment. Every fetch is individually wrapped: one failing source produces a
   partial observation, not an aborted tick.
2. **Classify** (`classifyDrift`, pure):
   - `head === live` → `exact`.
   - Unreachable or malformed endpoint → `unknown` (**never** `drift`).
   - Different and a run is `queued`/`in_progress` → `pending`.
   - Different and a `waiting` run is younger than the approval horizon → `awaiting-approval`.
   - Different and a `waiting` run is older than the horizon → `overdue-approval`.
   - Different and nothing in flight → `stale-commit`.
3. **Decide** (`decideAlert`, pure): given the classification, the previous issue state and `now`,
   return `{ action: "none" | "open" | "update" | "close", firstObserved, horizon }`.
4. **Persist** the chosen `firstObserved` back into the state block so the age survives the tick.
5. **Act** — one issue per environment, title `drift: <environment> is not serving its branch head`.

The approval-wait start resolution (D6) is its own pure function, `resolveApprovalWaitStart`, because
it is the piece with three candidates and two rejections, and it is where a future reader will
otherwise re-introduce `started_at`.

## 7. Caching and process boundaries

- A schedule tick has a **hard wall-clock budget**; the endpoint fetch gets a 10 s timeout and the API
  calls 20 s, so a hung dependency cannot make the tick overlap the next one.
- `concurrency: drift-monitor` with `cancel-in-progress: false` in the workflow. Two overlapping ticks
  would race on `firstObserved` and could double-report.
- Nothing is cached between ticks except the issue body. That is intentional: a cache that can be stale
  is a second source of truth about drift.

## 8. Test plan

`tests/drift-monitor.test.ts` (new) — pure functions only, no network:

| Test | Asserts |
| --- | --- |
| exact | `head === live` → `exact`, no alert |
| stale commit | differs, nothing in flight → `stale-commit` |
| queued run suppresses | differs, run `queued` → `pending`, no alert |
| in-progress run suppresses | differs, run `in_progress` → `pending`, no alert |
| **young waiting is quiet** | `waiting`, observed 5 min ago, horizon 60 → `awaiting-approval`, no alert |
| **overdue waiting alerts once** | `waiting`, observed 90 min ago → `overdue-approval`, `open` |
| **duplicate ticks do not re-alert** | second tick with the same observation → `action: "none"` |
| **newer attempt gets a fresh clock** | `run_attempt` 2 with a new observation is not suppressed by attempt 1's stale record |
| **older attempt never suppresses a newer one** | stale record for attempt 1, live attempt 2 present → alert, not suppressed |
| absent timestamp is first-observed | no API timestamp → `firstObserved` = now, persisted, not `now` on the next tick |
| malformed body is not drift | HTML/login page → `unknown`, no alert, no `firstObserved` write |
| unreachable endpoint is not drift | fetch throws → `unknown`, exit 0 |
| state round-trips | a body written by the monitor parses back to the same `firstObserved` and `kind` |
| cross-environment isolation | a `staging` issue's state never suppresses a `production` alert |

`tests/drift-monitor-workflow.test.ts` — the workflow file is asserted, not trusted:

| Test | Asserts |
| --- | --- |
| schedule present | a `cron:` exists and is 15 minutes |
| one job per environment | exactly two jobs, each declaring a distinct `environment:` — required for the environment-scoped bypass secret (§13.9) |
| permissions are minimal | `issues: write` and `contents: read`, and **no** `contents: write` |
| concurrency guard | `cancel-in-progress: false` |
| no secrets beyond the bypass | only `VERCEL_AUTOMATION_BYPASS_SECRET`; no `DATABASE_URL` |
| dispatchable | `workflow_dispatch:` present, so the monitor can be exercised before promotion |

## 9. Mutations (SEC-07)

| Mutation | Must fail |
| --- | --- |
| alert on `in_progress` | "in-progress run suppresses" |
| suppress every `waiting` | "overdue waiting alerts once" |
| reset `firstObserved` every tick | "duplicate ticks do not re-alert" |
| treat an unreachable endpoint as drift | "unreachable endpoint is not drift" |
| treat a malformed body as a mismatch | "malformed body is not drift" |
| key the state by environment only, not attempt | "newer attempt gets a fresh clock" |
| add `contents: write` to the workflow | "permissions are minimal" |
| collapse both environments into one job | "one job per environment" — a single job cannot read either bypass secret, so the monitor would report healthy while blind |
| close the issue while a run is in flight | "in-progress run suppresses" |

## 10. Verification gates

```bash
npm run typecheck
npm run lint
npx tsx --test tests/drift-monitor.test.ts tests/drift-monitor-workflow.test.ts
```

Then, before merging — **the workflow must be exercised, not just tested**:

```bash
gh workflow run drift-monitor.yml -f dry_run=true   # from the branch, dispatchable
```

`workflow_dispatch` exists precisely so this is possible before promotion (see §12). A `dry_run` input
prints the classification and the would-be action and writes nothing.

Live acceptance, after this lands on `main`:

1. Healthy tick → no issue.
2. Point the monitor at a known-diverged pair in `dry_run` → `stale-commit`, no write.
3. Let a real tick run → issue appears within one cadence of the horizon.

## 11. Rollout and compatibility

- **No migration, no schema change, no deploy-path change.** Adds one workflow and one script.
- **This is the repository's first scheduled workflow.** It runs from `main`, so merging this to
  `staging` does not start it — see §12.
- **No new secret is required, but the existing one needs care.** `GITHUB_TOKEN` covers the issue
  write and the Actions read. `VERCEL_AUTOMATION_BYPASS_SECRET` already exists **per environment**
  (`staging` and `production` rows in `11-actions-deploys.md` §2), and that document is explicit that
  secrets must be environment-scoped rather than repository-scoped.

  This forces a structure decision: **a job-level `environment:` key is what makes an environment
  secret readable**, and a job may only declare one. So the workflow uses **two jobs, one per
  environment** (`monitor-staging`, `monitor-production`), each with its own `environment:` — not one
  job looping over both. That also gives per-environment isolation for free: a `staging` alert can
  never suppress a `production` one, because they do not share a job or a state file.

  The alternative — making the bypass secret repository-scoped so one job can read both — is
  **rejected**: it widens a credential to every workflow in the repository to save one job block.
- **Cost on Hobby:** one scheduled run per 15 minutes is roughly 96 runs/day. It reads two URLs and
  the Actions API; it does not build, deploy or invoke a Vercel function beyond one `/api/version`
  request per environment per tick. **It does not consume deployments** — this matters, because the
  Hobby allowance is 100 deployments/day and a monitor that triggered deployments would spend it.
- Rollback is a revert plus closing any open drift issue.

## 12. Tracker and PR

1. **#165** `status:ready` → `in-review` when the PR opens.
2. The migration-half deferral (§3) is recorded **on the issue**, because it changes an acceptance box.
3. PR title `ci: drift monitor for live commit and in-flight runs (#165)`, labels `type:ci`,
   `deploy:skip` — a workflow and a script, no runtime change.
4. Note for **#167**: it inherits the migration half. When `migrations` appears in `/api/version`, the
   monitor's `classifyDrift` gains a branch and this plan's D1 is discharged — no new workflow.
5. Note for **#174** (`8b`): same workflow, additional check against GitHub Deployments. **Do not build
   a second monitor.**

## 13. Landmines

1. **A scheduled workflow runs from the default branch (`main`).** Merging to `staging` does not start
   it. Until `main` has it, the monitor can only be run by `workflow_dispatch` — which is why that
   trigger is not optional.
2. **Staging is SSO-protected.** Without the bypass header the endpoint returns **HTML**, not JSON. A
   parser that throws on HTML turns a normal deployment into a red monitor run; one that treats HTML
   as "different from head" pages you on every tick. Treat it as `unknown`.
3. **`env:` in the endpoint is `staging`, not `preview`.** Verified live. Do not re-derive the
   environment from `VERCEL_ENV` anywhere in the monitor.
4. **The issue body is the state store.** Editing the visible text is safe; **deleting the HTML comment
   loses `firstObserved`** and silently restarts the clock. The parser must tolerate a missing block by
   treating it as a first observation, not by crashing.
5. **`started_at` does not exist for a job blocked on approval.** This is the correction that was
   already made twice in the issue. Do not reintroduce it.
6. **Two overlapping ticks race on `firstObserved`.** Hence `concurrency` with
   `cancel-in-progress: false`; a cancelled tick that had already written state could double-report.
7. **Production has no Actions runs to consult** while it deploys via `deploy.sh`. That is an absence
   of signal, not a clean bill of health — do not let a missing run list read as "nothing in flight"
   when the mechanism for runs does not exist yet.
8. **The endpoint is unauthenticated.** Anything the monitor logs from it is public information; do not
   paste headers or the bypass secret into a log line or an issue body.
9. **Environment secrets require a job-level `environment:` key, and a job gets exactly one.** Two
   environments therefore mean two jobs. A single job looping over both cannot read either bypass
   secret, and the failure mode is subtle: the request returns the SSO login page, which §13.2
   correctly classifies as `unknown` — so the monitor would be **permanently blind while reporting
   healthy**. The `dry_run` in §10 exists partly to catch exactly this before it is trusted.

## 14. Definition of done

- [ ] `scripts/drift-monitor.ts` + `src/lib/drift-monitor.ts` + `.github/workflows/drift-monitor.yml`
      added; threshold documented in `docs/setup/11-actions-deploys.md` §8.
- [ ] Mismatch detected within one tick; a healthy environment produces no issue.
- [ ] A queued/in-progress run, or a young waiting run, suppresses the alert; an overdue wait does not.
- [ ] Alert is idempotent: repeated ticks update one issue. *(#165 acceptance, verbatim)*
- [ ] Threshold documented in `docs/setup/11-actions-deploys.md`. *(#165 acceptance, verbatim)*
- [ ] `migrations` alerting is explicitly **absent** and named as #167's, in the issue and in §3.
- [ ] `dry_run` exercised from the branch and the output pasted into the PR.
- [ ] No new secret required for the shipped half; no deployment consumed.
