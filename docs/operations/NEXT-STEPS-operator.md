# Operator commands — current scope

Verified against the repo on 2026-11-19. Run from `/home/user/solara` with `gh` authenticated as
`jtanori`.

**Scope: core development.** QA, promotion prep and promotion are deferred by explicit decision —
see §Deferred. What remains is getting the shipped slice onto staging and keeping issues honest.

---

## Now — two items

### 1. File the QA-checklist PR (docs-only)

Branch `arena/0198dbc1-solara` is pushed at `843fc56` (2 commits, `docs/` only).

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
already on `staging` as `e606216` — plus `docs/operations/NEXT-STEPS-operator.md`, and points
`docs/PR_WORKFLOW.md` Phase 4 item 7 at the checklist so the post-merge QA step stops improvising.

31 checks in eight groups, grounded in what the review actually caught rather than what the tests
already assert. Documentation only: no source, test, migration or config change.

QA is **not run** by this PR and is deferred until the QA gate. This records the procedure now,
while the reasoning is fresh, so it is not reconstructed from memory later.

## Linked issue

Refs #154 (closed by #159), #155 (S1-d, which the checklist explicitly excludes). No `Closes` line:
this records how to verify #154, it does not implement anything.

## Evidence

- `git diff --stat staging...arena/0198dbc1-solara` → 3 files, all under `docs/`.
- `npx eslint src tests --max-warnings=0` → clean (no source touched; run to prove the tree is intact).
- Every relative link in the edited files resolves (checked by script).
- The three environment facts in checklist §0 were verified against refs, not assumed: migration
  `0009` is present at `f8f20ae`, `b6b6d01` and `e606216`, so it shipped with #152, not #159; the
  measured sizes (360/280/250px) come from `tests/readings-wheel-browser.test.ts`.
- Two claims in an earlier draft were **wrong and corrected**: that `0009` arrived with #159 (it did
  not), and that the divergent-language case could be produced from a plain chart (it cannot — a
  chart note's content locale follows the interface). The checklist now says what is true.

## Test plan

Documentation change; no runtime behavior. The checklist is deliberately unexecuted here — it is the
procedure, not its result. Running it belongs to the later QA gate.

## Deviations from plan

None. Scope is exactly the checklist and command sheet; no code, no test, no issue-body edit.
BODY
)"
```

Then merge it — squash, matching the feature-merge policy. Docs-only and `deploy:skip`, so no staging
QA or migration rehearsal is required by `PR_WORKFLOW.md` §2.1:

```bash
gh pr merge <DOCS_PR_NUMBER> --squash --subject "docs: staging QA checklist for the factual wheel and numerical facts (#154)"
```

Note: the `staging` branch's protection rejected `gh pr merge --merge` on #159 (403 to me, and the
merge-commit strategy is blocked there). Squash is what works for feature merges; `--merge` is only
for `staging → main` promotions, which are deferred.

### 2. Close #154's bookkeeping by hand

Already `CLOSED` (2026-11-19T07:22Z), but it still carries `status:in-review` next to `CLOSED`, which
makes it look in-flight on the board. Issue writes are 403 to me:

```bash
gh issue edit 154 --remove-label status:in-review
```

---

## Optional — deploy the slice to staging

Only needed when you want to *look* at this slice. It is not required to keep developing, and if the
QA gate is far off, deploying now just puts an unverified build in front of anyone using staging.

Current state: `solara-stg` serves `13a88608` (Nov 17) / `b6b6d01` (Nov 18) — **neither contains
`e606216`**, so the wheel is not on staging yet.

```bash
cd /home/user/solara
./scripts/deploy.sh --pr <DOCS_PR_NUMBER> --env staging
```

`deploy.sh` gates on a successful Vercel preview and CI, then squash-merges; it will report
"No drizzle/ changes" because `drizzle/` did not change in this PR. Verify afterwards:

```bash
gh api "repos/jtanori/solara/deployments?environment=staging&per_page=3" \
  --jq '.[] | "\(.ref)\t\(.sha[0:8])\t\(.created_at)"'
curl -sS -o /dev/null -w '%{http_code}\n' https://solara-stg.vercel.app/api/ready
```

Because `deploy.sh` merges the PR it is given, this also lands the docs PR — running it while the PR is
still open does both jobs at once.

---

## Deferred — do not run now

Recorded so the reasoning is not lost, and so the gate is explicit when it opens.

| Item | Deferred by | Unblocks when | Why it cannot be skipped later |
|---|---|---|---|
| **QA run** (checklist Steps 3–4: run it, record result on #159) | operator, 2026-11-19 | QA gate, when staging is frozen for verification | Two of the three review defects on #154 were invisible to every automated gate until the page was rendered. Tests encode the cases we thought of. |
| **Back-merge PR** (`main` → `staging`, then `--merge`) | operator, 2026-11-19 | promotion preparation | `main` is **5 commits ahead** of `staging` (`039d9b63`, `9553ceb8`, `03467bd9`, `ade651e9`, `4490ced9`), not merely an ancestry gap. `deploy.sh --env production` refuses until `main` is an ancestor. |
| **Promotion** (`deploy.sh --env production`) | operator, 2026-11-19 | after staging satisfies QA | Touches production and spends real money; production migration rehearsal required (`0009`), and `--skip-migrate` is refused for production by design. |

The full command text for both deferred items is preserved in git history at commit `843fc56`:
`git show 843fc56:docs/operations/NEXT-STEPS-operator.md`.

**One trap worth remembering when the promotion gate opens:** the back-merge must be a **merge**, not a
squash. A squash lands the content but not `main`'s SHAs, and `deploy.sh`'s production gate tests
`git merge-base --is-ancestor origin/main HEAD` — so it would still refuse. It is documented in
`docs/operations/production-bootstrap-2026-11-10.md` §4.1a. Recorded now because it is exactly the
kind of detail that gets lost between gates.

---

## What I can and cannot do

| Task | Me | Why |
|---|---|---|
| Write code/docs, run full local gates, push to `arena/0198dbc1-solara` | ✅ | — |
| Open a PR from my branch | ✅ | `gh pr create` works |
| `gh pr merge --squash` on a staging-bound PR | ✅ | works; `--merge` is blocked on `staging` |
| `gh pr comment <n>` (PR comments) | ✅ | worked on #159 |
| Write to issues (labels, bodies) | ❌ | 403 `Resource not accessible by integration` |
| Run the staging QA | ❌ | needs a signed-in browser session; no session or credentials here |
| Promote / deploy to production | ❌ | your call, and deferred by your decision |
| Read branch protection | ❌ | 403 |
