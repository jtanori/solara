# 11 — Actions-owned deployments, approval gates and break-glass

Operator procedure for the pipeline described in [ADR 013](../decisions.md) and
[the alignment plan](../plan-deployment-alignment.md). **Not active until milestone M5 lands.**
Until then `scripts/deploy.sh` remains the documented path.

Never paste a secret value into this file, a workflow summary, an issue, or a terminal that logs.
Secret **names** only.

---

## 1. What deploys what

| Environment | Trigger | Workflow | Deployer |
| --- | --- | --- | --- |
| Feature branch preview | PR push (Vercel Git) | — | Vercel, unchanged until Phase 4 |
| `staging` | every push | `deploy-staging.yml` | GitHub Actions |
| `main` (production) | every push | `deploy-production.yml` | GitHub Actions |

Merging is the deploy. A merge from the GitHub UI, from `gh`, or from an agent behaves identically —
that is the point. `workflow_dispatch` exists only for break-glass recovery.

Vercel's Git integration is disabled for `staging` and `main` **after** the replacement workflow has
been proven against that branch, never before. Recovery if a deploy fails after the flip is
`workflow_dispatch` on the failed workflow, not `git revert` — a revert also needs a deployer.

During the overlap, both deployers can serve the same SHA, so "the right SHA is live" proves nothing
about which one deployed it. The cutover therefore:

- holds a **`drizzle/` freeze** (no change of any kind under `drizzle/` in that environment) until
  the step is done, so a Vercel Git deploy cannot bypass the new migration order;
- proves the **Actions-created deployment ID** owns the stable alias (`vercel alias`/domains shows
  the target deployment, not just the served commit);
- proves the first post-flip merge creates **exactly one** deployment — if two appear, the flip did
  not take and the freeze stays.

Production follows the same order only at its own cutover; it stays on the legacy procedure until
then.

Feature previews may read the staging database **only** under the verified
`ALLOW_PREVIEW_ON_STAGING` exception (read-only, never migrate, never production), or use their own
preview database once #176 or its fallback lands.

## 2. Environments and secret names

| GitHub Environment | Secret names | Protection |
| --- | --- | --- |
| `staging` | `DATABASE_URL` (direct, staging), `DATABASE_URL_STAGING_READONLY`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `staging` |
| `production` | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `main` |
| `production-migrations` | `DATABASE_URL` (direct, production), `DATABASE_URL_STAGING_READONLY` | branch `main`, required reviewer = operator, **Prevent self-review OFF** |
| `production-diagnostics` | `DATABASE_URL_PRODUCTION_READONLY` | branch `main`, read-only role, no reviewer |

Notes:

- Secrets must be **environment-scoped**, not repository-scoped. A repository-scoped
  `DATABASE_URL` would make every workflow able to reach production.
- The read-only staging credential serves the production rehearsal gate and staging diagnostics; it is
  never used for a write.
- `VERCEL_AUTOMATION_BYPASS_SECRET` is required when Deployment Protection is on; a 401/403 during
  verification is a hard failure, never a skip.
- The build job must not receive any database credential. Migration detection is a `curl` against
  `/api/version` plus `git diff`.
- **Build-time database boundary.** The build needs `DATABASE_URL` to *exist* (`src/db/index.ts`
  throws at module load) and the identity guard (#168) rejects loopback on a hosted boot, so a
  missing or loopback value is not sufficient on its own. Apply these to `deploy-staging.yml` and
  `deploy-production.yml` alike:
  - supply a **build-only, non-routable placeholder** `DATABASE_URL` (loopback host, syntactically
    valid, deliberately unusable credentials) that satisfies the module load and cannot connect, or
    refactor the import so the build never evaluates it; the placeholder is test-covered and the
    runtime guard stays fail-closed;
  - prove no SQL or network connection to the database during build, no hosted database credential
    in the workspace, and no `vercel pull` env file inside the uploaded `.vercel/output` or build
    artifact;
  - inject the real runtime variables at **deploy** time, scoped to the correct environment and
    branch for the **promoted candidate**, never baked at build.
- **How production/staging runtime variables reach the promoted candidate is a prerequisite**, not
  an S1 assumption: record it in the Phase 0 inventory and confirm it before the first cutover.

## 3. Reading a deploy

```
curl -s https://<domain>/api/version | jq
{ "ok": true, "commit": "…", "tree": "…", "release": "…", "env": "production",
  "builtAt": "…", "migrations": "exact" }
```

- `commit` matches the merge SHA and `migrations` is `exact` or `ahead` → live.
- `commit` is older than the branch head → merged but not live; check the run.
- `migrations: "ahead"` is normal during the migrate→deploy window and after an alias rollback.
  `ahead` persisting beyond the alert threshold is a monitor signal.
- `migrations: "behind"` or `"diverged"` → `/api/ready` is `503`. Stop and inspect; do not retry
  blindly.

The **workflow result** is the release outcome. `/api/version` answers "what is serving now?", not
"did this release succeed?".

## 4. The approval gate

Merging a release that carries `drizzle/` changes starts `deploy-production.yml`, whose `migrate`
job waits on the `production-migrations` environment. Nothing is applied until the operator
approves.

This is a deploy gate, not a merge gate: it delays a job, never a merge. It is compatible with the
catch-22 rule in `docs/PR_WORKFLOW.md` §0 **only** through the future-scoped exception recorded
there. The configuration is load-bearing, and cutover must prove it in the running system:

- required reviewer is the operator with **Prevent self-review OFF** — the identity that merged can
  release the job, with no second human or second GitHub identity;
- a run that is `waiting`, and a run whose approval is **denied**, is **never a required status check
  and never a required deployment** for any current or later merge;
- required PR checks stay non-API-dependent; the live `/api/version`/Actions-API promotion signal is
  advisory, and the fail-closed identity/run assertions run post-merge.

A required, fail-closed, live-API-backed check is not authorized by this exception; an API outage
must never block a merge. If one is ever wanted, it needs its own §0 amendment with an outage
fallback.

While a run is waiting:

- `/api/version` on the production domain still reports the **previous** build. That is correct.
- The drift monitor treats a **young** `status: waiting` as healthy until the approval horizon, then
  alerts. The horizon is measured from the observable start defined in §8, not from first sight.
- If a newer promotion is merged in the meantime, approving the older run must not deploy stale
  code: after approval, **once the per-target migration lock is held**, and again immediately before
  the alias write, the run re-reads `main`, staging's live identity/run state and the applied hash
  set. A **confirmed supersession** refuses *benign* ("superseded by <SHA>") and is not an outage.
  An unreachable API, an unreadable `__drizzle_migrations`, or any other unverifiable read is a
  **verification failure** — fail closed, do not report it as benign.

### First production deploy through Actions

Before issue 1 ships, `/api/version` does not exist. During the cutover, or on any run where the
endpoint is unreachable or reports `commit: "unknown"`, migration detection **fails closed**: it
treats the release as carrying migrations and routes through the approval gate even when nothing is
pending. This is designed behaviour — an unknown live state deserves human eyes — not a
malfunction.

### Schema-free hotfixes

A direct `hotfix/*` merge or push to `main` is not a merge of `staging`, so it cannot satisfy the
promotion-shape assertion. The default remains: **all changes reach `main` through `staging`.**

The dispatch ref is **protected `main`**, never `hotfix/*`: both production environments are
restricted to `main` (§2), so a `hotfix/*` ref cannot obtain the credentials the path needs. If an
emergency genuinely requires a direct fix, it is **two steps**:

1. merge the reviewed, schema-free change to protected `main` through the normal merge path;
2. dispatch the reviewed `deploy-production.yml` on **`main`** for the current verified, merged
   `main` SHA — which must still be the **current `main` tip** — with `hotfix=true` (operator only).
   If `main` advanced, re-dispatch on the new tip; ancestor writes are not supported.

On that dispatch the workflow:

- asserts the diff against the **live commit** touches **no `drizzle/` file** and no schema-bearing
  path, and fails otherwise;
- still requires `production-migrations` approval, still verifies the candidate and the live
  identity, and still creates a GitHub Deployment;
- records in the incident/deployment summary that it bypassed the promotion shape, and why.

A `hotfix/*` branch may exist for review, but the deployment runs from `main`. This path replaces
the promotion-shape assertion for that run. It never permits a schema change — a hotfix that needs
schema is reverted and promoted normally.

## 5. Failure handling

| Failed stage | Database | Live site | Action |
| --- | --- | --- | --- |
| build | untouched | previous build | fix the build; re-run |
| freshness recheck — confirmed supersession | untouched (lock released before DDL) | previous build | benign "superseded by `<SHA>`" |
| freshness recheck — API unreachable or hash set unreadable | untouched | previous build | red run + **verification failure**; never benign, fix access and re-run |
| migrate | pending batch rolls back as one transaction (`lock_timeout` aborts before commit); a batch that already committed stays | previous build | inspect the run log; the migrate job is idempotent, re-run it |
| candidate verify | migrated | previous build | candidate was never promoted; fix and re-run |
| post-promote verify, **matching keyed record** | migrated | revert to the recorded prior deployment ID | fix forward or re-run |
| post-promote verify, **absent / mismatched / no prior** | migrated | **no automatic revert**; alias left as-is, page for forward fix | operator decides: forward fix, or alias move once compatibility is established |

Auto-revert is **conditional and default-deny**, and it is an **alias move only** — it never reverses
a migration. It runs only when a prior deployment ID was recorded, the release carries a compatibility
record that **matches this run**, and the release has no `no-auto-rollback` mark.

- The record is operator-written, never inferred from a green readiness state, and keyed to the run:
  `compatible: true`, `prior_deployment_id` (the actual deployment serving the alias), `candidate_sha`
  (the SHA being promoted), and `migration_hashes` (the exact applied set the release produces).
- **Before cutover**, the legacy path can write the same record in the deploy record/marker.
- **After cutover**, the workflow reads that record and compares all three values with the run's
  actual prior ID, candidate SHA, and applied hash set. A record for another prior build, another
  candidate, or another hash set does not authorize the move. Absence or mismatch is incompatible.
- The `no-auto-rollback` mark set by a `migration:breaking-approved` override overrides any record.

Readiness being green does **not** prove the previous build works against a newer schema. When the
conditions do not hold, the alias is not moved automatically: the incident opens and the operator is
paged for a forward fix. On the first Actions deploy, record the existing stable deployment as the
prior ID when one exists; only a genuinely absent alias skips the revert cleanly.

Every failure opens or updates a single incident issue with the SHA, the stage reached, the recorded
prior ID (or "none"), and whether a revert ran or was withheld.

## 6. Break-glass

`migrate.yml` survives as break-glass only — verify plus an emergency forward-fix. It is **not** the
deploy path, and it is never run by exporting a production URL into a local shell. The workflow holds
the environment secret; the operator dispatches it.

**Dispatch interface** (`workflow_dispatch`):

| Input | Values | Notes |
| --- | --- | --- |
| `env` | `staging` \| `production` | selects the target |
| `mode` | `verify` \| `migrate` | `verify` is read-only |
| `sha` | full 40-char commit | `migrate`: the current tip of the allowed protected branch. `verify`: the current tip, or a historical commit on that branch for read-only diagnostics |
| `dry_run` | `true` \| `false` | `false` only for an emergency forward-fix |

**Mode × target is the only routing authority.** Each cell has exactly one allowed ref, environment
and credential. Anything else is refused before the job starts:

| `env` | `mode` | Allowed ref | Environment | Credential | Approval |
| --- | --- | --- | --- | --- | --- |
| `staging` | `migrate` | `staging` | `staging` | `DATABASE_URL` (direct staging) | none (branch-restricted only) |
| `production` | `migrate` | `main` | `production-migrations` | `DATABASE_URL` (direct production) | **required** |
| `staging` | `verify` | `staging` | `staging` | `DATABASE_URL_STAGING_READONLY` (read-only, provisioned in `staging`) | none |
| `production` | `verify` | `main` | `production-diagnostics` | `DATABASE_URL_PRODUCTION_READONLY` | none |

- `production-diagnostics` is a **separate, least-privilege** environment: branch `main` only, a
  read-only role, no reviewer. It reads schema metadata only — migration state, table and index
  names — never application rows. Until it is provisioned, **current-tip** production diagnostics may
  run under `production-migrations` **with the same approval** — a read-only query is not a reason to
  release the production write credential without approval. Historical diagnostics may **not** use
  that fallback: they require the read-only environment/role and are refused without it.
- A **write** (`mode=migrate`) requires the ref to be the authorized protected branch (`main` for
  production, `staging` for staging) and `sha` to equal its **current head**. Ancestor writes are not
  supported: if the branch advanced, re-dispatch on the new tip. An approval for one SHA never
  authorizes another.
- The run revalidates the target ref, current tip and approved SHA **after approval and again after
  acquiring the shared lock**, immediately before rehearsal and DDL. A confirmed supersession refuses
  benign; an unreachable API or unreadable hash set is a **verification failure** that fails closed.
- A **read-only diagnostic** (`mode=verify`) may target a historical commit only when it is on the
  protected branch and the read-only credential is available. If that credential is unavailable,
  refuse the historical verification — never fall back to a write credential.
- The **staging hash rehearsal** passes under the same lock before a production write: every pending
  production hash already exists in staging's `drizzle.__drizzle_migrations`, read with the read-only
  staging credential.
- The rehearsal and the apply share the **per-target migration concurrency lock** with
  `deploy-staging.yml`/`deploy-production.yml` (`cancel-in-progress: false`), so a break-glass run and
  a release run cannot rehearse or apply schema concurrently.

**Diagnostics output contract.** `mode=verify` prints **names only**: migration hashes, table and
index names, readiness state, and counts. Never a URL, host, endpoint, user, credential, or query
text. The same contract applies to the incident summary. Fixtures cover the four dispatch cells; a
rejected ancestor write; an ancestor `verify` accepted with the read-only credential; a historical
`verify` refused when that credential is unavailable; an unapproved production write; an approval
superseded before or under the lock; a production diagnostic without the read-only environment;
rehearsal/apply racing a release run; and an unverifiable API or hash set reported as a verification
failure.

Both modes refuse a target they cannot prove. Neither is safe to run from an agent session.

## 7. Rollback drill (acceptance for #76)

Not optional, and not exercised by any test in the repository. This is the **single drill procedure**;
the plan links here. Two distinct cases — a candidate rejection never reaches the alias, so it cannot
also test the alias move.

**The compatibility record is keyed, operator-written, and never inferred from readiness.** Before
promotion the operator records:

```yaml
compatible: true
prior_deployment_id: <deployment ID serving the alias before promotion>
candidate_sha: <40-char SHA being promoted>
migration_hashes: [<exact applied set this release produces>]
```

The alias move requires **all three** to match the run's actual prior deployment, candidate SHA, and
resulting applied hash set. A `compatible: yes` for another prior build, another candidate, or a
different hash set does not authorize the move. The `no-auto-rollback` mark overrides any record.

**(a) Candidate rejection.**

1. Deploy a build that fails `/api/ready` behind an environment flag.
2. Confirm the candidate verification blocks promotion and the alias does not move — production never
   serves it.
3. Record the run link in #76 under "candidate rejection".

**(b) Post-alias failure.**

1. Record the current alias target **deployment ID** and commit, the candidate SHA, and the migration
   hashes the release is expected to apply.
2. **Compatible case.** Attach a compatibility record matching all three values, then force the
   failure after promotion. Confirm the alias returns to that exact prior deployment ID,
   `/api/version` reports the previous `commit`, readiness afterwards is `ahead` or `exact` — never
   `unexpected`-fatal — and the incident says the revert ran.
3. **Withheld cases.** Run the same post-promotion failure three times, once for each class:
   - no compatibility record;
   - a record whose prior deployment ID, candidate SHA, or hash set does not match this run;
   - a `no-auto-rollback` mark (with an otherwise matching record).

   Each must leave the alias **unmoved**, report "revert withheld" in the incident, and page the
   operator. A matching record must not rescue a marked release.
4. Record the run links in #76 under "post-alias failure — reverted" and "post-alias failure —
   withheld", separately from (a).

## 8. Monitoring

Two horizons, because two different things can stall:

| Signal | Age measured from | Alert |
| --- | --- | --- |
| Branch head ≠ live commit, or `migrations` ≠ `exact` | first observation of the mismatch | after the short threshold, once, deduplicated |
| Approval wait (`status: waiting`) | the observable **start of the approval wait** (see below) | after the approval horizon, once, deduplicated |

**The approval-wait start is not a convenience timestamp.** A job `started_at` does not exist until
the job starts — a job blocked on an environment approval may never start. A deployment's creation
time is not the transition into `waiting` either. The monitor resolves the start in this order:

1. a **verified API/event timestamp** for the transition into the approval wait — the deployment
   status `waiting` event or the environment approval-required event, if the API exposes one;
2. otherwise, the monitor persists its **first observation of `waiting`**, keyed by
   `(run_id, run_attempt, environment)`, and measures from that persisted instant. A newer attempt
   gets a new key and a fresh clock; an older attempt's record never suppresses it.

The scheduled poll cadence is the **bounded error** on the start: state the cadence, and treat the
horizon as `cadence + configured horizon`. A missing timestamp is never "very old" and never "now" —
it is first-observed, persisted, and deduplicated. Fixtures: absent timestamps, a newer run attempt,
a young wait (quiet), an overdue wait (one alert), duplicate ticks (no new issue), and an older
attempt's stale observation not suppressing a new one.

- The stale-commit / stuck-`ahead` horizon is short (for example 20 minutes): nothing legitimate holds
  it that long.
- The **approval horizon is separate and longer**, because a release may legitimately wait for the
  operator. The naive "stay quiet while any run is waiting" rule would let a release wait forever
  without paging — the plan's DoD forbids that. Alert once when the approval wait is overdue, naming
  the SHA and the waiting duration; do not suppress every `waiting` state.

- **8a** — branch head vs `/api/version.commit`, migration state, and both horizons above.
- **8b** — the same comparison against GitHub Deployments. Compare **actual live success after the
  stable-domain verification**, not "any `environment:` job succeeded": a build job can also carry an
  `environment:` key and says nothing about what is serving.

`docs/deploys.md` stays the legacy record **until cutover**; the freeze takes effect when the operator
records the cutover date and run link. After that, GitHub Deployments and workflow job summaries are
the record, and workflows never commit to `main`.

## 9. What an agent may not do

- Merge to `main` or dispatch a deploy. Operator-only.
- Run `db-run.ts`, `drizzle-kit push`, or `drizzle-kit migrate` against staging or production, or
  export a production `DATABASE_URL` into a local shell to do it by hand.
- Dispatch a break-glass write without the protected ref, exact SHA, approval and staging rehearsal
  in §6.
- Edit a committed migration. Fix forward with a new one.
- Put a hotfix into `drizzle/`. Hotfix PRs may never touch it — see
  [the journal-collision reason](../plan-deployment-alignment.md#9-migration-guardrails).

## 10. Cutover checklist (proves the §0 exception)

Run this per environment, on the running system — not by inspection. Record the evidence in the
cutover PR and the tracker issue (#178). Complete the **freeze and baseline** first; the production
approval proof comes **after** a safe baseline exists, not alongside it. The `production-migrations`
gate is **not in force** until every box for production is checked.

**Freeze first — before the baseline snapshot, held through the first post-flip proof:**

- [ ] **Freeze entered.** No change of any kind under `drizzle/` — SQL, `meta/_journal.json`,
      snapshots; added, modified or deleted — on this environment from before the baseline snapshot
      until its cutover is complete.
- [ ] **Freeze held across every overlap step**, including the first post-flip merge.

**Baseline — while the freeze is held, before either deployer is enabled:**

- [ ] **Stable verified baseline recorded.** The current stable deployment ID/alias, live commit,
      `/api/version` state and migration state are written down before any cutover step. A no-op
      merge is not a baseline.
- [ ] **Zero pending journal hashes.** Every `drizzle/meta/_journal.json` entry is present in the live
      environment's `__drizzle_migrations`. There is **no cutover-release exception**; a pending hash
      means the baseline is not neutral.
- [ ] **No schema-bearing diff live → candidate.** `git diff <live-commit> <cutover-candidate>` over
      `drizzle/` is empty; a schema-bearing commit that is not yet served is not a schema-neutral
      start.
- [ ] **Not neutral → stop.** Settle the pending migration through the **legacy path**, verify it,
      re-enter the freeze and capture a **fresh baseline** before enabling the second deployer. Do
      not retry against the old snapshot.

**Overlap and one-deployer proof:**

- [ ] **Alias ownership proved.** The stable domain resolves to the **Actions-created deployment ID**,
      not merely a matching SHA.
- [ ] **One deployer.** The first post-flip merge produced exactly one deployment, created by the
      workflow.

**Production approval proof — only after the baseline above:**

- [ ] **Same-operator release.** The operator who merged can approve the `production-migrations` job
      with Prevent self-review OFF; no second identity was needed.
- [ ] **Waiting/denial is not a merge gate.** A `waiting` run and a `denied` run appear as neither a
      required status check nor a required deployment; a subsequent merge is unaffected.
- [ ] **Required checks are non-API-dependent.** The promotion tree-equality signal is advisory; the
      fail-closed identity/run assertion runs post-merge.

**Closeout:**

- [ ] **Rollback drill (a) and (b)** recorded separately with run links (#76).
- [ ] **`docs/deploys.md` frozen at cutover** with the date and the cutover run link; historical rows
      unchanged.
