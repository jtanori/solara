# Drift monitor (#165) — configuration runbook

Everything that must be configured, in order, for `.github/workflows/drift-monitor.yml` to run
correctly. Verified against the repository and the GitHub API on **2026-11-19**.

Companion documents: [`11-actions-deploys.md`](../setup/11-actions-deploys.md) §2/§2.1 (the secret's
theory), [`bypass-secret-howto.md`](../setup/bypass-secret-howto.md) (the secret walkthrough),
[`plan-drift-monitor-165.md`](../plan-drift-monitor-165.md) (the design).

---

## 0. Current state — what is actually configured today

Checked live; do not assume any of this from memory.

| Item | State | Evidence |
| --- | --- | --- |
| `monitoring` GitHub Environment | **MISSING** | `GET /repos/jtanori/solara/environments/monitoring` → `404` |
| Ability of the automation token to create it | **NO — `403`** | `PUT /repos/jtanori/solara/environments/staging` → `Resource not accessible by integration` |
| `staging` / `production` Environments | exist, **no** protection rules, **no** branch policy | `deployment_branch_policy: null`, `protection_rules: 0` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` in any environment | **unverified — cannot read** | environment *secrets* return `403` to this token |
| Workflow on `main` | **absent** | `GET .../contents/.github/workflows/drift-monitor.yml?ref=main` → `404` |
| Default branch | `main` ✓ | the restore step's `branch=main` query is correct |
| `.github/workflows/drift-monitor.yml` on the PR branch | present, at `3d9c2e9` | — |
| PR #222 | `MERGEABLE`, base `staging`, 5/5 checks green | `mergeStateStatus: CLEAN` |
| Repository issues | enabled, repo is **public** | — |
| Open `drift-monitor` issue | none (`#165` is the tracking issue) | — |

Two consequences worth stating plainly:

- **Nothing is scheduled yet.** A `schedule:` trigger only fires from the default branch, so the
  monitor is inert until this lands on `main`. Merging to `staging` does not start it.
- **The environment must exist before promotion**, not after. A scheduled run that cannot resolve
  `environment: monitoring` fails every 15 minutes.

---

## 1. Create the `monitoring` environment

Required. The workflow binds to it (`drift-monitor.yml:54`).

> **This step needs a human with repository admin.** The automation token in this workspace gets
> `403 Resource not accessible by integration` on `PUT /environments/...`, so it cannot create the
> environment or write its secrets. Run the commands below with an admin `gh` session, or do it in
> the UI (Settings → Environments → New environment → `monitoring`).

**UI path** (equivalent, no API): repository → Settings → **Environments** → *New environment* →
`monitoring` → leave *Required reviewers* empty → optionally add the branch policy below → *Save*.

**API path:**

```bash
gh api --method PUT repos/jtanori/solara/environments/monitoring
```

- **No required reviewers.** A reviewer gate would make every 15-minute run wait for a human.
- **No protection rules at all.** Protection rules govern *deployments* to that environment; this
  job creates none it reads back.

### Branch policy — a decision you should make consciously

`11-actions-deploys.md` §2 documents `monitoring` as *branch `main`*. It is **not enforceable the way
`staging`/`production` are**, because scheduled workflows run on `main` but the `workflow_dispatch`
dry run is executed from whatever ref you name. If you set *Deployment branches: Selected → `main`*
and then dispatch with `--ref <branch>`, GitHub rejects the run before any step executes.

Two coherent choices:

| Choice | Policy | Cost |
| --- | --- | --- |
| **A — documented, strict** (recommended) | Selected → `main` only | pre-promotion dry runs must be done **locally** (`npx tsx scripts/drift-monitor.ts --env … --dry-run`), or from `main` after promotion; Step 5b becomes post-promotion only |
| **B — permissive** | All branches | `workflow_dispatch` works from any branch, including before promotion; slightly weaker, and diverges from the documented row |

Whatever you choose, update the `monitoring` row in `11-actions-deploys.md` §2 if you pick B, so the
doc and the setting agree.

```bash
# Choice A
gh api --method PUT repos/jtanori/solara/environments/monitoring \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'

gh api --method POST repos/jtanori/solara/environments/monitoring/deployment-branch-policies \
  -f name=main -f type=branch
```

Verify:

```bash
gh api repos/jtanori/solara/environments/monitoring \
  --jq '"rules=\(.protection_rules|length) policy=\(.deployment_branch_policy|tostring)"'
gh api repos/jtanori/solara/environments/monitoring/deployment-branch-policies \
  --jq '.branch_policies[] | "\(.name) (\(.type))"'
```

---

## 2. Supply `VERCEL_AUTOMATION_BYPASS_SECRET`

Required — but **only if Deployment Protection is on**, which you must confirm rather than assume.
Follow [`bypass-secret-howto.md`](../setup/bypass-secret-howto.md) Steps 1–4. Summary:

Same admin requirement as Step 1 (`403` for the automation token on both secret writes and reads).

```bash
read -rsp 'bypass secret: ' BYPASS; echo

# the monitor — this is the only secret this environment gets
gh secret set VERCEL_AUTOMATION_BYPASS_SECRET -R jtanori/solara -e monitoring -b "$BYPASS"

# deploy.sh needs its own copies
for env in staging production; do
  gh secret set VERCEL_AUTOMATION_BYPASS_SECRET -R jtanori/solara -e "$env" -b "$BYPASS"
done

unset BYPASS
```

Verify names only (GitHub never returns values):

```bash
for env in monitoring staging production; do
  printf '%s: ' "$env"
  gh api "repos/jtanori/solara/environments/$env/secrets" --jq '[.secrets[].name] | join(", ")'
done
```

**Do not** put it in Vercel's environment variables — no application code reads it.

**Independent of the secret:** if protection is *off*, the workflow still works; the header is simply
ignored. If protection is *on* and the secret is missing or stale, every tick exits `1` with
`rejected:`. There is no silent middle ground, by design.

---

## 3. Repository-level Actions settings

These are not in the workflow and cannot be set from it. Both require **admin**; this token gets
`403` reading them, so verify in the UI.

1. **Actions enabled for the repository** — Settings → Actions → General → *Allow all actions and
   reusable workflows*. A restricted allow-list that excludes `actions/checkout`,
   `actions/setup-node` or `actions/upload-artifact` breaks the run at the first step.
2. **Workflow permissions** — Settings → Actions → General → *Workflow permissions*.
   The workflow declares its own `permissions:` map (`contents: read`, `actions: read`,
   `deployments: read`, `issues: write`), and an explicit map **overrides** the repository default
   for that job — so the "read repository contents" default does not need changing. The one hard
   ceiling that does apply is *pull requests from forks*, which are forced to read-only; it is
   irrelevant here because the monitor runs on `schedule` and `workflow_dispatch` only.

   **This is the first workflow in the repository to request `issues: write`** — no other workflow
   declares it. If it were somehow downgraded, the failure is loud, not silent: verified by injecting
   a `403` on the alert write, which classifies `stale-commit` and **exits `1`** rather than `0`. So
   a missing scope cannot produce a false "all healthy" result.
3. **Fork pull-request approval** — irrelevant here (no fork PRs run this).

There is **nothing else** to configure in the repository: no webhook, no app installation, no
environment reviewer, no branch protection change. The workflow uses the ambient `GITHUB_TOKEN`.

---

## 4. Vercel side

Set once, in the Vercel project that owns the domains:

| Item | Action |
| --- | --- |
| Deployment Protection | confirm on/off (Project → Settings → Deployment Protection) |
| Protection Bypass for Automation | generate, copy once — Step 2 above |
| Environment variables | **nothing to add** for the monitor |
| Deployments consumed | **none.** The monitor issues no deploy, no `--prod`, no Vercel API call |

Cost note: Hobby allows 100 deployments/day. The monitor consumes **zero** Vercel deployments. It
does create ~192 GitHub *Deployments* per day under `monitoring` — accepted, because no gate reads
them (plan §12, landmine 9).

If staging and production are **separate Vercel projects**, bypass secrets are per project: you need
`_STAGING` / `_PRODUCTION` variants and a workflow change. Confirm the project before Step 2.

---

## 5. Verification

### 5a. Before merge — locally, no writes

```bash
VERCEL_AUTOMATION_BYPASS_SECRET="$BYPASS" \
  npx tsx scripts/drift-monitor.ts --env staging --dry-run
```

Expect a **reported** `kind` (`exact`, `observing-commit`, `behind`, …) and
`dry-run: would none; no write performed`, exit `0`.

`kind=unknown` with exit `0` is **not** success — it means the host was unreachable and the tick was
degraded. Check the URL before the secret.

### 5b. After merge to `staging` — nothing runs

Correct and expected. `schedule:` only fires from `main`.

### 5c. After promotion to `main` — the real test

```bash
gh workflow run drift-monitor.yml --ref main -f dry_run=true
gh run watch "$(gh run list --workflow=drift-monitor.yml -L 1 --json databaseId --jq '.[0].databaseId')"
```

Both matrix legs must log a reported `kind`, with no `rejected:` line and exit `0`. `dry_run=true`
means no issue is created and no artifact uploaded.

Then let one real tick run (≤15 min) and confirm:

```bash
gh run list --workflow=drift-monitor.yml -L 5
gh issue list --search 'drift-monitor in:title' --state all
```

On a healthy system: **no new issue**, and one `drift-state-<target>` artifact per leg.

### 5d. Proof it cannot deploy — the cost check

```bash
gh run list --workflow=drift-monitor.yml -L 1 --json databaseId --jq '.[0].databaseId' \
  | xargs -I{} gh api repos/jtanori/solara/actions/runs/{}/jobs \
      --jq '.jobs[].steps[] | "\(.conclusion)\t\(.name)"'
```

Expect: checkout, setup-node, `npm ci`, restore state, run monitor, write artifact, upload artifact.
**No** `vercel` step, no `deploy.sh`, no `migrate.yml` dispatch.

---

## 6. Promotion to `main`

Required: the workflow is inert until it is on the default branch.

Rules in force (`protect-main`, ruleset `26759381`): required check `verify` with
**strict** up-to-date policy, `required_approving_review_count: 0`, review-thread resolution
required, no force-push, no deletion. Repo merge methods: squash ✓, merge ✓, rebase ✗.

1. Merge #222 to `staging`:
   ```bash
   gh pr merge 222 --squash
   ```
   Squash is the only permutation allowed by `protect-staging`'s linear-history rule.
2. Open the promotion PR `staging` → `main` and merge with a **merge commit** (ADR 004 preserves
   ancestry for promotions; rebase is disabled repo-wide):
   ```bash
   gh pr create --base main --head staging \
     --title "chore: promote staging to main (#165 drift monitor)" \
     --label type:ci --label area:ci --label deploy:required
   gh pr merge <N> --merge
   ```
3. Wait for `verify` on the promotion PR, then confirm the workflow landed and is scheduled:
   ```bash
   gh api repos/jtanori/solara/contents/.github/workflows/drift-monitor.yml?ref=main --jq '.name'
   gh workflow list --all | grep drift-monitor
   ```
4. Run Step 5c.

---

## 7. Deferred / not required for this change

Listed so they are not mistaken for blockers:

- **Staging QA, promotion recording, the back-merge PR** — deferred by decision.
- **Branch policy on `staging`/`production`** — documented in §2 but **not enforced**
  (`deployment_branch_policy: null`). Pre-existing, unrelated to this PR; tightening it would change
  how every existing workflow deploys, so it is deliberately out of scope.
- **#174 (8b) Deployments check** — the plan assigns it to the *same* workflow later. Do not build a
  second monitor. When it lands it must query `/deployments?environment=staging` /
  `?environment=production` and **never** unfiltered `/deployments`, which now includes the
  monitor's own `monitoring` entries.
- **#162 spike** — untouched.
- **`DATABASE_URL` for `monitoring`** — must **never** be added. The monitor holds no database
  credential; it reads `/api/ready` over HTTPS.

---

## 8. Quick reference

```bash
# state
gh api repos/jtanori/solara/environments --jq '.environments[].name'
gh api repos/jtanori/solara/environments/monitoring --jq '.deployment_branch_policy'

# create + secret
gh api --method PUT repos/jtanori/solara/environments/monitoring
gh secret set VERCEL_AUTOMATION_BYPASS_SECRET -R jtanori/solara -e monitoring -b "$BYPASS"

# verify locally
VERCEL_AUTOMATION_BYPASS_SECRET="$BYPASS" npx tsx scripts/drift-monitor.ts --env staging --dry-run

# after promotion
gh workflow run drift-monitor.yml --ref main -f dry_run=true
gh run list --workflow=drift-monitor.yml -L 5
gh issue list --search 'drift-monitor in:title' --state all
```
