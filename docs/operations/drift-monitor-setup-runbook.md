# Drift monitor (#165) — configuration runbook

Everything that must be configured, in order, for `.github/workflows/drift-monitor.yml` to run
correctly. Verified against the repository and the GitHub API on **2026-11-19**.

Companion documents: [`11-actions-deploys.md`](../setup/11-actions-deploys.md) §2/§2.1 (the secret's
theory), [`bypass-secret-howto.md`](../setup/bypass-secret-howto.md) (the secret walkthrough),
[`plan-drift-monitor-165.md`](../plan-drift-monitor-165.md) (the design).

---

## 0. Current state — what is actually configured today

> **Status: configuration done, verification PENDING promotion.** The environment exists and the
> secret is set by the operator, but nothing that requires the default branch can be exercised yet —
> `workflow_dispatch` returns `HTTP 404` until the workflow is on `main`. The pending items and their
> exit criteria are listed in §5e; the PR carries the same table.

Checked live; do not assume any of this from memory.

| Item | State | Evidence |
| --- | --- | --- |
| `monitoring` GitHub Environment | **EXISTS**, no reviewer, **no branch policy** | `200`; `protection_rules: 0`; `deployment_branch_policy: null` |
| Ability of the automation token to read/write env secrets | **NO — `403`** | `GET .../environments/{monitoring,staging,production}/secrets` → `403`; set by the operator, unverified |
| `staging` / `production` Environments | exist, **no** protection rules, **no** branch policy | `deployment_branch_policy: null`, `protection_rules: 0` |
| Workflow on `main` | **absent** | `GET .../contents/.github/workflows/drift-monitor.yml?ref=main` → `404` |
| Default branch | `main` ✓ | the restore step's `branch=main` query is correct |
| `.github/workflows/drift-monitor.yml` on the PR branch | present | committed on the feature branch |
| PR #222 | `MERGEABLE`, base `staging`, 5/5 checks green | `mergeStateStatus: CLEAN` at merge |
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

**Verified fact that simplifies this:** a `workflow_dispatch` on this workflow returns
`HTTP 404 Not Found` until the file exists on the **default branch** — the workflow is not registered
with the Actions API at all (`gh api .../actions/workflows` lists only `ci`, `migrate` and Dependabot).
So before promotion *no* dispatch is possible from *any* ref, and the branch-policy question has no
practical effect until after the workflow lands on `main`.

After promotion it does matter: with a *Selected → `main`* policy, dispatching with `--ref <branch>`
is rejected before any step executes. With no policy (all branches), it works from any branch.

Two coherent choices:

| Choice | Policy | Cost |
| --- | --- | --- |
| **A — documented, strict** | Selected → `main` only | post-promotion dry runs must use `--ref main`; a dispatch from a feature branch is refused |
| **B — permissive** | All branches (`deployment_branch_policy: null`) | `workflow_dispatch` works from any ref after promotion; slightly weaker, and diverges from the documented `main` row |

The environment currently has **no branch policy** (`deployment_branch_policy: null`), i.e. choice B.
That is functional. Either leave it and update the §2 row, or apply choice A below.

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

1. **Actions enabled / allow-list — no action needed, and here is the proof.** The workflow uses only
   `actions/checkout@v4`, `actions/setup-node@v4` and `actions/upload-artifact@v4`. All three already
   run successfully in this repository: `ci.yml` uses checkout and setup-node on every PR (and passes
   on this branch), and `migrate.yml` uses all three, succeeding on 2026-11-18. A restricted
   allow-list that excluded any of them would already have broken those workflows. **Nothing to
   change**; this row exists so you can skip it with confidence rather than guess.
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

### 5b. After merge to `staging` — nothing runs, and nothing *can* be run

Correct and expected. `schedule:` only fires from `main`, and `workflow_dispatch` returns
`HTTP 404` because the workflow is not on the default branch. There is no pre-promotion dispatch to
try; do not read the 404 as a configuration fault.

The only pre-promotion check is 5a run from a machine that can reach the hosts.

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

### 5e. Verification status at merge time

Split by what is actually checkable. Do not mark an item verified from documentation alone.

**Confirmed:**

| Item | Evidence |
| --- | --- |
| `monitoring` environment exists, no reviewer gate | `gh api .../environments/monitoring` → `200`, `protection_rules: 0` |
| `staging` / `production` environments exist | both present |
| Default branch is `main` | the restore step's `branch=main` query is correct |
| CI allow-list needs no change | the only actions used already run in `ci.yml` and `migrate.yml` |
| Both domains belong to one Vercel project | operator-confirmed → one secret serves both legs |
| Missing `issues: write` fails loudly | injected `403` on the alert write → exits `1` |
| 97 targeted tests, tsc 0, eslint 0 | green at the merge commit |

**Pending — requires the workflow on `main`:**

| Item | Why blocked | Confirm with |
| --- | --- | --- |
| `workflow_dispatch` works | `HTTP 404` until the file is on the default branch | §5c |
| Both legs report a real `kind` | needs a dispatch or the first tick | §5c |
| The bypass secret resolves | environment secrets are unreadable via API (`403`); unproven until a run reads one | no `degraded: unauthorized`/`forbidden` in the log |
| Authentication was needed at all | staging assumed SSO-protected, unconfirmed here | either way exit `0`; the header is ignored when protection is off |
| The clock persists between ticks | needs two real runs ≥15 min apart | run 2 restores `drift-state-<target>` instead of re-initialising |
| No Vercel deployment consumed | only a real run proves it | §5d |

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
