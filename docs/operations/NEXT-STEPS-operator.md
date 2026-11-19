# Operator commands — S1-c QA through promotion

Everything below is copy-paste ready. Run from `/home/user/solara` (or any clone with `gh` authenticated
as `jtanori`). Verified against the repo on 2026-11-19.

**Order matters.** Step 1 gates step 2; step 6 gates step 7. Nothing here is reversible-cheap except
where noted.

---

## Step 0 — Two facts to know before you start

| Fact | Verified how | Consequence |
|---|---|---|
| `main` **diverged** from `staging`: staging is 28 ahead, **main is 5 ahead** (commits `039d9b63`, `9553ceb8`, `03467bd9`, `ade651e9`, `4490ced9`) | `gh api repos/jtanori/solara/compare/main...staging` → `status: diverged`, `ahead_by: 28`, `behind_by: 5` | Promotion needs a **back-merge PR**, not a straight merge. `scripts/deploy.sh --env production` refuses until then (base-freshness gate, #124). |
| Repo allows merge commits (`allow_merge_commit: true`) but direct `gh pr merge --merge` on #159 was rejected by branch protection (403) | `gh api repos/jtanori/solara`; PR #159 merge attempt | `staging` protection blocks non-CI'd merges. Use `deploy.sh`, which runs the preview-readiness + CI gates first, rather than raw `gh pr merge`. Branch protection is 403 to the agent, so I cannot re-check it — you can see it in Settings → Branches. |

---

## Step 1 — File the QA-checklist PR (docs-only)

The branch is pushed: `arena/0198dbc1-solara` at `e29682e`, one commit, `docs/` only.

```bash
cd /home/user/solara
gh pr create \
  --base staging \
  --head arena/0198dbc1-solara \
  --title "docs: staging QA checklist for the factual wheel and numerical facts (#154)" \
  --label type:docs \
  --label area:docs \
  --label deploy:skip \
  --body "$(cat <<'BODY'
## Summary

Adds `docs/operations/staging-qa-solar-wheel-s1c.md` — the manual QA checklist for the S1-c slice
already on `staging` as `e606216` — and points `docs/PR_WORKFLOW.md` Phase 4 item 7 at it so the
post-merge QA step stops improvising.

31 checks in eight groups, grounded in what the review actually caught rather than what the tests
already assert. Documentation only: no source, test, migration or config change.

## Linked issue

Refs #154 (closed by #159), #155 (S1-d, which the checklist explicitly excludes). No `Closes` line:
this records how to verify #154, it does not implement anything.

## Evidence

- `git diff --stat staging...arena/0198dbc1-solara` → 2 files, +287/−1, both under `docs/`.
- `npx eslint src tests --max-warnings=0` → clean (no source touched; run to prove the tree is intact).
- Every relative link in both edited files resolves (checked by script).
- The three environment facts in §0 were verified against refs, not assumed: migration `0009` is
  present at `f8f20ae`, `b6b6d01` and `e606216` (so it shipped with #152, not this slice); the
  measured sizes (360/280/250px) come from `tests/readings-wheel-browser.test.ts`.
- Two claims in an earlier draft were **wrong and corrected**: that `0009` arrived with this merge
  (it did not), and that the divergent-language case could be produced from a plain chart (it cannot
  — a chart note's content locale follows the interface). The checklist now says what is true.

## Test plan

Documentation change; no runtime behavior. The checklist itself is unexecuted by design — it is the
procedure, not its result. Running it is Step 2 below.

## Deviations from plan

None. Scope is exactly the checklist; no code, no test, no issue-body edit.
BODY
)"
```

**Note:** `deploy:skip` is correct — `docs/` only, no staging QA or migration rehearsal required by
`PR_WORKFLOW.md` §2.1. Confirm that classification survives review; it is the reviewer's call.

---

## Step 2 — Redeploy staging so it actually serves S1-c

**This is the step that is easy to miss.** The latest `staging`-environment deployment and `migrate`
run are at `b6b6d01` (2026-11-18 23:17Z), which predates the merge of #159. So `solara-stg` today is
**not** running the wheel. Running the checklist against it would QA the old build.

Merge the docs PR first (step 1), then deploy — one deploy covers both.

```bash
cd /home/user/solara
./scripts/deploy.sh --pr <DOCS_PR_NUMBER> --env staging
```

`deploy.sh` will: run the migrate workflow if `drizzle/` changed (it hasn't for the docs PR, so it
should report "No drizzle/ changes"), gate on a successful Vercel preview on the PR head, watch CI,
then squash-merge. Answer `y` at the prompt, or add `--yes` to skip it.

Then confirm staging is serving the merge:

```bash
gh api "repos/jtanori/solara/deployments?environment=staging&per_page=3" \
  --jq '.[] | "\(.ref)\t\(.sha[0:8])\t\(.created_at)"'
```

You want the top row's `sha` to be the new `staging` head, not `b6b6d01`. Also worth a direct probe:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://solara-stg.vercel.app/api/ready
```

---

## Step 3 — Run the checklist (≥30 min, no `gh` commands)

Open `docs/operations/staging-qa-solar-wheel-s1c.md` and work through it on
`https://solara-stg.vercel.app`. Create charts A–D via `/create`; use any chart saved before
2026-11-18 for E.

Record `pass` / `fail` / `n/a` per check, with the chart ID and a screenshot for anything visual.
Two checks are expected to be `n/a` and saying so is correct, not a gap:

- **19b** (divergent language) — needs a Spanish *saved edition*; generation is off on staging.
- **25–27** (paid editions) — only if a paid edition exists on staging.

---

## Step 4 — Record the QA result on the PR that shipped it

Post the result on #159 (it is closed, so this is a comment, not a review):

```bash
cd /home/user/solara
gh pr comment 159 --body "$(cat <<'BODY'
## Staging QA — S1-c (e606216)

Run against `https://solara-stg.vercel.app` at staging `e606216` (deployment `<dpl_id>`), following
`docs/operations/staging-qa-solar-wheel-s1c.md`.

| Group | Result | Notes |
|---|---|---|
| 1. Wheel renders (1–6) | | chart ID: |
| 2. Numerical table (7–10) | | |
| 3. Orientation (11–12) | | |
| 4. Absence / omissions (13–16) | | D=high-lat, E=legacy |
| 5. Language (17–20) | | 19b: |
| 6. Layout (21–24) | | |
| 7. Paid editions (25–27) | | n/a if none on staging |
| 8. No generation (28–29) | | |

Screenshots: <links or "attached">
Failures: none / <list>
BODY
)"
```

If anything failed, **stop here** — do not promote. Fix on a branch off `staging`, re-run steps 2–4.

---

## Step 5 — Close #154's bookkeeping by hand

It is already `CLOSED` (2026-11-19T07:22Z). The labels lie, though: it still carries
`status:in-review` alongside `CLOSED`. Issue writes are 403 to me, so this is yours:

```bash
gh issue edit 154 --remove-label status:in-review
gh issue edit 155 --add-label status:ready          # S1-d is the next slice; already labelled ready
```

---

## Step 6 — Prepare promotion: the back-merge PR

Required because `main` carries 5 commits `staging` does not have. **Merge, never squash** — a squash
back-merge lands the content but not main's SHAs, so `deploy.sh`'s ancestry check still fails (this is
the exact trap documented in `docs/operations/production-bootstrap-2026-11-10.md` §4.1a).

```bash
cd /home/user/solara
git fetch origin main staging
git switch -c chore/promote-back-merge-2026-11-19 origin/staging
git merge origin/main            # expect clean; trial-merge was conflict-free
git push -u origin chore/promote-back-merge-2026-11-19
```

Then confirm the ancestry the gate will test:

```bash
git merge-base --is-ancestor origin/main HEAD && echo "main IS an ancestor — gate will pass"
gh api "repos/jtanori/solara/compare/staging...main" --jq '{status, ahead_by, behind_by}'
```

**Full gates must be re-run on this merged tree** — a green run on either side alone says nothing
about the combination (`PR_WORKFLOW.md` §5). That is a ~15-minute suite; I can run it for you on
request, but it needs a disposable PostgreSQL.

Open the back-merge PR:

```bash
gh pr create --base main --head chore/promote-back-merge-2026-11-19 \
  --title "chore: back-merge main into staging before promotion" \
  --label type:chore --label area:infra --label deploy:skip \
  --body "$(cat <<'BODY'
## Summary

Restores `main` as an ancestor of `staging` so the promotion can pass the base-freshness gate (#124).
`main` carries 5 commits `staging` lacks (`039d9b63`, `9553ceb8`, `03467bd9`, `ade651e9`, `4490ced9`).

Merge commit, not squash: a squash satisfies content but not SHA ancestry, which is exactly what
`deploy.sh --env production` tests with `git merge-base --is-ancestor`.

## Linked issue

Refs #119 (require exact SHA and a real migrate run for production promotion).

## Evidence

- `gh api repos/jtanori/solara/compare/main...staging` → `status: diverged`, `ahead_by: 28`, `behind_by: 5`
- trial merge conflict-free
- after merge: `git merge-base --is-ancestor origin/main HEAD` exits 0

## Test plan

Full gates re-run on the merged tree: typecheck, lint, full suite on a disposable PostgreSQL,
`db:manifest:check`, `build`. Results pasted before filing.

## Deviations from plan

None.
BODY
)"
```

Then merge it with `--merge` (the ancestry-preserving strategy):

```bash
gh pr merge <BACK_MERGE_PR_NUMBER> --merge
```

---

## Step 7 — Promote (only after Step 4 is green and Step 6 merged)

```bash
cd /home/user/solara
./scripts/deploy.sh --pr <PROMOTION_PR_NUMBER> --env production
```

The promotion PR is `staging` → `main`. `deploy.sh` will require a production migration rehearsal
first if `drizzle/` differs — it does: `0009` is on staging and (per your earlier records) not yet
prod-rehearsed for this cycle. `--skip-migrate` is **refused** for production by design; do not try
it. This is the step that spends real money and touches production, and it is entirely your call.

---

## What I can and cannot do

| Task | Me | Why |
|---|---|---|
| Write code/docs, run full local gates, push to `arena/0198dbc1-solara` | ✅ | — |
| Open a PR from my branch | ✅ | `gh pr create` works |
| Run the staging QA | ❌ | needs a signed-in browser session on staging; I have no session and no credentials |
| Write to issues (labels, bodies, comments on issues) | ❌ | 403 `Resource not accessible by integration` |
| `gh pr comment <n>` (PR comments) | ✅ | worked on #159 |
| Merge staging-bound PRs via `gh pr merge --squash` | ⚠️ | allowed in principle; #159 needed `deploy.sh`'s gating, and branch protection 403s me |
| Promote to production / deploy | ❌ | your call, not mine |
| Read branch protection | ❌ | 403 |
