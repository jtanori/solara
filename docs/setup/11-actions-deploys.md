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

## 3. Reading a deploy

```
curl -s https://<domain>/api/version | jq
{ "commit": "…", "tree": "…", "release": "…", "env": "production",
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

This is a deploy gate, not a merge gate: it delays a job, never a merge. It does not conflict with
the catch-22 rule in `docs/PR_WORKFLOW.md` §0, because the operator is already the sole merge
authority.

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

## 5. Failure handling

| Failed stage | Database | Live site | Action |
| --- | --- | --- | --- |
| build | untouched | previous build | fix the build; re-run |
| migrate | partially applied at worst (`lock_timeout` aborts cleanly) | previous build | inspect the run log; the migrate job is idempotent, re-run it |
| candidate verify | migrated | previous build | candidate was never promoted; fix and re-run |
| post-promote verify | migrated | previous build re-promoted | deployment failed, schema stayed; fix forward |

Auto-revert is an **alias move only**. It never reverses a migration. If migration succeeded and
deployment failed, the schema stays: fix forward, or roll back application code only once
compatibility is established.

Every failure opens or updates a single incident issue with the SHA, the stage reached, and whether
the rollback succeeded. On the first Actions deploy there is no previous deployment to revert to;
the revert step skips and the incident still opens.

## 6. Break-glass

`migrate.yml` survives as break-glass only: `verify` mode plus an emergency forward-fix, with the
same gates it has today (exact SHA, `mode=migrate`, `dry_run=false`, production rehearsal). It is
not the deploy path.

```
# read-only: what does the hosted database think it has?
npx tsx scripts/db-run.ts --env production status --json

# read-only: schema, journal and expectations in one verdict
npx tsx scripts/db-run.ts --env production verify
```

Both refuse a target they cannot prove. Neither is safe to run from an agent session; they require
the environment secret, which only the workflow holds.

## 7. Rollback drill (acceptance for #76)

Not optional, and not exercised by any test in the repository.

1. Deploy a build that fails `/api/ready` behind an environment flag.
2. Confirm the candidate verification blocks promotion — production never serves it.
3. Force the failure after promotion instead, and confirm the alias returns to the previous
   deployment and `/api/version` reports the previous `commit`.
4. Confirm readiness after rollback reports `ahead` or `exact`, never `unexpected`-fatal.
5. Record the run link in #76.

## 8. Monitoring

- **8a** — branch head vs `/api/version.commit`, migration state, and in-flight/queued/waiting
  workflow runs. Alerts only when nothing is running and the mismatch outlives the threshold.
- **8b** — the same comparison against GitHub Deployments for each environment.

`docs/deploys.md` is frozen. GitHub Deployments and workflow job summaries are the record; workflows
never commit to `main`.

## 9. What an agent may not do

- Merge to `main` or dispatch a deploy. Operator-only.
- Run `db-run.ts`, `drizzle-kit push`, or `drizzle-kit migrate` against staging or production.
- Edit a committed migration. Fix forward with a new one.
- Put a hotfix into `drizzle/`. Hotfix PRs may never touch it — see
  [the journal-collision reason](../plan-deployment-alignment.md#9-migration-guardrails).
