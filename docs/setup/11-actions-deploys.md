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

- holds a **schema-neutral freeze** (no `drizzle/` merge into that environment) until the step is
  done, so a Vercel Git deploy cannot bypass the new migration order;
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
| `staging` | `DATABASE_URL` (direct, staging), `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `staging` |
| `production` | `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET` | branch `main` |
| `production-migrations` | `DATABASE_URL` (direct, production), `DATABASE_URL_STAGING_READONLY` | branch `main`, required reviewer = operator, **Prevent self-review OFF** |

Notes:

- Secrets must be **environment-scoped**, not repository-scoped. A repository-scoped
  `DATABASE_URL` would make every workflow able to reach production.
- The read-only staging credential exists so the production rehearsal gate can read
  `drizzle.__drizzle_migrations` without write access.
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
- The drift monitor treats `status: waiting` as healthy until the approval horizon, then alerts.
- If a newer promotion is merged in the meantime, approving the older run must not deploy stale
  code: the migrate job re-asserts that `github.sha` still equals the branch head and refuses
  otherwise. **A stale-run refusal is benign** — it appears as a red run with "superseded by
  <SHA>" and is not an outage.

### First production deploy through Actions

Before issue 1 ships, `/api/version` does not exist. During the cutover, or on any run where the
endpoint is unreachable or reports `commit: "unknown"`, migration detection **fails closed**: it
treats the release as carrying migrations and routes through the approval gate even when nothing is
pending. This is designed behaviour — an unknown live state deserves human eyes — not a
malfunction.

### Schema-free hotfixes

A direct `hotfix/*` merge or push to `main` is not a merge of `staging`, so it cannot satisfy the
promotion-shape assertion. The default remains: **all changes reach `main` through `staging`.** If an
emergency genuinely requires a direct fix:

- dispatch `deploy-production.yml` with `hotfix=true` against the `hotfix/*` ref (operator only);
- the workflow asserts the diff against the **live commit** touches **no `drizzle/` file** and no
  schema-bearing path, and it fails otherwise;
- it still requires `production-migrations` approval, still verifies the candidate and the live
  identity, and still creates a GitHub Deployment;
- it records in the incident/deployment summary that it bypassed the promotion shape, and why.

This path replaces the promotion-shape assertion for that run. It never permits a schema change — a
hotfix that needs schema is reverted and promoted normally.

## 5. Failure handling

| Failed stage | Database | Live site | Action |
| --- | --- | --- | --- |
| build | untouched | previous build | fix the build; re-run |
| migrate | pending batch rolls back as one transaction (`lock_timeout` aborts before commit); a batch that already committed stays | previous build | inspect the run log; the migrate job is idempotent, re-run it |
| candidate verify | migrated | previous build | candidate was never promoted; fix and re-run |
| post-promote verify | migrated | previous build re-promoted | deployment failed, schema stayed; fix forward |

Auto-revert is an **alias move only**. It never reverses a migration. If migration succeeded and
deployment failed, the schema stays: fix forward, or roll back application code only once
compatibility is established.

Every failure opens or updates a single incident issue with the SHA, the stage reached, and whether
the rollback succeeded. On the first Actions deploy there is no previous deployment to revert to;
the revert step skips and the incident still opens.

## 6. Break-glass

`migrate.yml` survives as break-glass only — verify plus an emergency forward-fix. It is **not** the
deploy path, and it is never run by exporting a production URL into a local shell. The workflow holds
the environment secret; the operator dispatches it.

**Dispatch interface** (`workflow_dispatch`):

| Input | Values | Notes |
| --- | --- | --- |
| `env` | `staging` \| `production` | selects the target |
| `mode` | `verify` \| `migrate` | `verify` is read-only |
| `sha` | full 40-char commit | must resolve to a commit on an authorized protected ref |
| `dry_run` | `true` \| `false` | `false` only for an emergency forward-fix |

Gates for a **write** dispatch (`mode=migrate`, `dry_run=false`):

- the ref is an **authorized protected branch** (`main` for production, `staging` for staging) and
  `sha` equals that branch's reviewed head (or a recorded ancestor) — no arbitrary ref, no fork;
- the job runs under the **`production-migrations`** environment (approval, Prevent self-review
  OFF). The production database credential now lives there, not in `production`, so the workflow
  must request that environment for this path;
- the **staging hash rehearsal** passes: every pending production hash already exists in staging's
  `drizzle.__drizzle_migrations`, read with the read-only staging credential;
- it shares the migration **concurrency group** with `deploy-production.yml`'s migrate job
  (`cancel-in-progress: false`), so a break-glass run and a release run cannot apply schema
  concurrently.

Diagnostics (`mode=verify`) are read-only, need no write approval, and still use the environment
secret. Their output names hashes and tables — never a URL, host, or credential.

Both modes refuse a target they cannot prove. Neither is safe to run from an agent session.

## 7. Rollback drill (acceptance for #76)

Not optional, and not exercised by any test in the repository. Two distinct cases — a candidate
rejection never reaches the alias, so it cannot also test the alias move.

**(a) Candidate rejection.**

1. Deploy a build that fails `/api/ready` behind an environment flag.
2. Confirm the candidate verification blocks promotion and the alias does not move — production never
   serves it.
3. Record the run link in #76 under "candidate rejection".

**(b) Post-alias failure.**

1. Record the current alias target **deployment ID** and commit first.
2. Force the failure after promotion. Confirm the alias returns to the recorded deployment ID,
   `/api/version` reports the previous `commit`, and readiness afterwards is `ahead` or `exact` —
   never `unexpected`-fatal.
3. Record the run link in #76 under "post-alias failure", separately from (a).

## 8. Monitoring

Two horizons, because two different things can stall:

| Signal | Age measured from | Alert |
| --- | --- | --- |
| Branch head ≠ live commit, or `migrations` ≠ `exact` | first observation of the mismatch | after the short threshold, once, deduplicated |
| Approval wait (`status: waiting`) | the run **entering** `waiting` (deployment/job `started_at`, not "first seen by the monitor") | after the approval horizon, once, deduplicated |

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
cutover PR and the tracker issue (#178). The `production-migrations` gate is **not in force** until
every box for production is checked.

- [ ] **Same-operator release.** The operator who merged can approve the `production-migrations` job
      with Prevent self-review OFF; no second identity was needed.
- [ ] **Waiting/denial is not a merge gate.** A `waiting` run and a `denied` run appear as neither a
      required status check nor a required deployment; a subsequent merge is unaffected.
- [ ] **Required checks are non-API-dependent.** The promotion tree-equality signal is advisory; the
      fail-closed identity/run assertion runs post-merge.
- [ ] **Schema-neutral freeze** held during the overlap (no `drizzle/` merge).
- [ ] **Alias ownership proved.** The stable domain resolves to the **Actions-created deployment ID**,
      not merely a matching SHA.
- [ ] **One deployer.** The first post-flip merge produced exactly one deployment, created by the
      workflow.
- [ ] **Rollback drill (a) and (b)** recorded separately with run links (#76).
- [ ] **`docs/deploys.md` frozen at cutover** with the date and the cutover run link; historical rows
      unchanged.
