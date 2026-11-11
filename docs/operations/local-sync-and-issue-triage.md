# Local sync + issue/milestone triage procedure

> **Note (2026-11-10):** `BACKLOG.md` was removed from the repository in favour of an on-demand,
> gitignored snapshot — see **ADR 009** and #132. References to it below describe the state at the
> time of writing.

**Purpose:** keep two things aligned — (1) your local clone / `staging` / `main` / `arena/*` branches, and
(2) the GitHub issue board. Written 2026-11-08 after the #52 incident and the 27-issue planning pass.

---

## 1. Local repository update

### 1.1 One-time: make sure every remote ref is actually fetched

This shell's clone has no fetch refspec, so `origin/staging` and the `arena/*` branches are **not** updated
by a plain `git fetch`. Set it once:

```bash
cd ~/solara
git config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git fetch --all --prune
git branch -r          # you should now see origin/main, origin/staging, origin/arena/*
```

### 1.2 Routine sync (run before starting any work)

```bash
cd ~/solara
git fetch --all --prune                    # update every remote branch, delete stale ones
git status                                 # must be clean; stash if not
git log --oneline -1 origin/staging
git log --oneline -1 origin/main
git rev-list --left-right --count origin/main...origin/staging   # main<TAB>staging ahead counts
```

Healthy output for this repo right now: `0  40` (main has nothing that staging lacks; staging is ahead —
that is expected, `staging` is the integration branch and `main` only receives promotions).

### 1.3 Get *this* session's work locally (the audit + plans + backlog)

The branch `arena/8f0da984-solara` is 4 commits ahead of `main`, **docs only**
(`BACKLOG.md` + 4 files under `docs/`), and is based on `main`, not on `staging`.

**Option A — inspect it without switching branches (safest):**

```bash
cd ~/solara
git fetch origin arena/8f0da984-solara
git diff --stat origin/main origin/arena/8f0da984-solara     # expect 5 files, ~853 insertions
git diff origin/main origin/arena/8f0da984-solara -- docs/audit-database-integration.md | less
git show origin/arena/8f0da984-solara:docs/plan-neon-auth-migration.md | less
```

**Option B — check it out in a worktree (recommended if you want to edit/read it in your editor):**

```bash
cd ~/solara
git worktree add ../solara-audit origin/arena/8f0da984-solara -b audit/db-auth-plans
cd ../solara-audit && open .    # or: code .
```

**Option C — bring the docs onto `staging` (the normal path; docs are not urgent):**

```bash
cd ~/solara
git switch staging && git pull --ff-only
git switch -c docs/db-auth-audit
git cherry-pick f10df6b accb9e6 e7bbc15 acf2a00   # in order, oldest first
git push -u origin docs/db-auth-audit
gh pr create --repo jtanori/solara --base staging --title "docs: database integration audit, fix plans, Neon Auth decision, issue index" \
  --body "Documentation only: audit findings, #52 fix plan, Neon Auth assessment/migration plan, BACKLOG index for #52-#79. No code, no schema, no behaviour change."
```

Then merge it with the normal flow (`./scripts/deploy.sh --pr <n> --env staging`), which correctly skips the
migration step because the diff does not touch `drizzle/`.

> **Automated path (recommended):** `scripts/land-audit-docs.sh` performs the port with guardrails —
> names every file explicitly, refuses a dirty tree, aborts if anything outside the allowlist is staged,
> aborts if the diff deletes more than one line (the `BACKLOG.md` header), verifies the final diff against
> `origin/staging`, then pushes and opens the PR. `--dry-run` shows the plan without touching anything.
>
> ```bash
> bash scripts/land-audit-docs.sh --dry-run        # preflight + plan only
> bash scripts/land-audit-docs.sh --yes            # branch, commit, push, open PR
> ```
>
> **If the cherry-pick conflicts on `BACKLOG.md`:** your local `staging` is stale. `git pull --ff-only`
> fails when the branch has no upstream ("There is no tracking information"), leaving you on an old
> commit whose `BACKLOG.md` predates this work. Confirm with
> `git rev-parse staging origin/staging` — they must match before cherry-picking.
>
> **Preferred alternative (no cherry-pick, one clean commit):** the four docs and three scripts are
> *new files*, so they can be brought over wholesale without touching anything `staging` already has:
>
> ```bash
> git switch staging && git merge --ff-only origin/staging
> git switch -c docs/db-auth-audit
> git checkout 254679b -- BACKLOG.md docs/ scripts/     # adds new files, keeps staging's docs/decisions.md
> git add -A && git commit -m "docs: database + deep audits, fix plans, Neon Auth decision, ops runbook, 42 issues indexed"
> git diff --stat origin/staging..HEAD                  # must list only our 12 files
> ```
>
> Note `git checkout <sha> -- dir/` never deletes files that are absent from that commit, so existing
> docs (`decisions.md`, `setup/`) are untouched.

> Do **not** merge `arena/8f0da984-solara` into `staging` directly — it is based on `main` and would carry
> unrelated history across the branching model (ADR 001/004).

### 1.4 Cleanup of stale branches (optional)

`arena/508c0d4d-solara`, `arena/59bb144d-solara`, `arena/6534a75a-solara`, `arena/7123fa2b-solara`,
`arena/7e0b46ac-solara`, `arena/cbcf92fa-solara`, `arena/promote-*` are old session branches. Delete only
after confirming they are merged:

```bash
git branch -r --merged origin/staging | grep 'origin/arena/'    # safe to delete these
gh api -X DELETE repos/jtanori/solara/git/refs/heads/arena/508c0d4d-solara   # repeat per branch
```

### 1.5 If a push is rejected (`fetch first` / non-fast-forward)

```bash
git fetch origin
git status                                  # is the remote ahead, or did you rewrite history?
git pull --rebase origin <branch>           # preferred when someone else pushed
# only if you truly intend to overwrite the remote (never on shared branches):
# git push --force-with-lease origin <branch>
```

---

## 2. Issues and milestones — update procedure

### 2.1 The current gap and how it is closed

- `M1 Foundation` (8/8 closed), `M2 Billing` (1/1), `M3 Launch readiness` (1 open + 5 closed),
  `Final` (0/1) were the existing milestones. The 26 new issues (#53–#79) have **no milestone**.
- The automation token can **create** issues but not **edit** them (`403` on labels/milestone/comments), so
  metadata has to be applied from your authenticated terminal.
- `#52` is already done — verified:
  `M3 - Launch readiness` + `type:bug area:db area:auth area:infra priority:p0 status:ready`.

### 2.2 Milestone strategy (decision)

| Milestone | Use for |
|---|---|
| `M3 - Launch readiness` | **S1 findings only** — anything that must be true before public sign-up |
| `M1 - Foundation` | S2/S3 hardening that improves the platform but does not gate launch |
| `Final - Platform validation` | cross-cutting platform-validation evidence (the #16 family). Currently empty |
| `M2 - Billing` | billing work (#9, #10) |

**Routing rule:** the *audit severity* decides, not the priority label. An `S1` finding goes to `M3`
even when its effort is small; an `S2` goes to `M1` even when its `priority:p1`. This is what keeps
`M3` honest — if everything is a launch blocker, nothing is.

**Corrections applied 2026-11-08** (a first pass routed four issues incorrectly):

| Issue | Was | Now | Why |
|---|---|---|---|
| #62 backup/PITR + restore drill | Final | **M3** | `S1` (DB-03) — unrecoverable data blocks launch |
| #63 `DATABASE_URL` single source of truth + preview policy | Final | **M1** | `S2` (DE-06/SH-03) — hygiene, mitigated by #90's inventory |
| #94 incident runbook + kill-switches | Final | **M1** | `S2` — operational maturity, not a launch gate |
| #69 re-auth for destructive actions | M3 | **M1** | `S2` — matches its siblings #67/#68 |

Apply with `bash scripts/fix-milestone-routing.sh` (idempotent).

Keep `M3` honest: it should contain only true launch blockers, otherwise the milestone stops meaning
anything. Everything else goes to `M1` (or `Final`) and the epic #79 carries the sequencing.

### 2.3 One-time / on-demand: apply labels + milestone

Two prerequisites first:

```bash
# 1. `area:ci` does not exist in this repo — create it (type:ci exists, area:ci does not)
gh label create "area:ci" --repo jtanori/solara \
  --description "CI workflows and pipelines" --color "5319E7"

# 2. confirm the milestone name is exactly as expected
gh api repos/jtanori/solara/milestones --jq '.[] | "\(.number)\t\(.title)"'
```

Then run the script (it is idempotent — labels are additive, re-running is harmless):

```bash
bash ~/issue-drafts/label-issues.sh
# or, if you copied it into the repo:  bash ~/solara/scripts/label-issues.sh
```

It prints `OK #n` / `FAIL #n` per issue. Any `FAIL` is almost always a missing label name — check with:

```bash
gh label list --repo jtanori/solara --limit 100 --json name --jq '.[].name' | sort
```

### 2.4 Verify the result

```bash
gh issue list --repo jtanori/solara --state open --limit 40 \
  --json number,title,milestone,labels \
  --jq '.[] | "\(.number)\t\(.milestone.title // "NO MILESTONE")\t\([.labels[].name] | join(","))\t\(.title)"' | sort -n
```

Expected: 27 open issues, every one with a milestone and at least `priority:*` + `status:*`.

Per-milestone totals:

```bash
gh api repos/jtanori/solara/milestones --jq '.[] | "\(.title)\topen=\(.open_issues)\tclosed=\(.closed_issues)"'
```

### 2.5 Ongoing issue hygiene (the rules this repo already follows)

| Event | Action |
|---|---|
| **Work starts** | `gh issue edit <n> --add-label status:in-progress --remove-label status:ready` |
| **PR opened** | `--add-label status:in-review`; PR body starts with `Closes #<n>` |
| **Blocked** | `--add-label status:blocked` **and** add a comment naming the blocker (a label alone is not information) |
| **Closed** | Closing PR/commit recorded in `BACKLOG.md` (move the row to *Closed (recent)*, per ADR 002) |
| **Needs a decision** | `--add-label status:needs-info`, and the question written in the issue — not in chat |

Helper aliases (add to `~/.bashrc`):

```bash
ghstart()  { gh issue edit "$1" --repo jtanori/solara --add-label status:in-progress --remove-label status:ready; }
ghreview() { gh issue edit "$1" --repo jtanori/solara --add-label status:in-review; }
ghblock()  { gh issue edit "$1" --repo jtanori/solara --add-label status:blocked --remove-label status:in-progress; }
```

### 2.6 Superseded epic

`#73` was the first-pass epic; `#79` is canonical (it adds #74–#78). Close the old one **with a reason**, so
the history stays readable:

```bash
gh issue comment 73 --repo jtanori/solara --body "Canonical epic is #79 (adds #74-#78: pipeline, deploy gate, alerting, ADR 007). Kept as the first-pass record."
gh issue close 73 --repo jtanori/solara --reason "not planned"
```

### 2.7 Environment protection (owner-only, gates #75)

`gh` cannot set required reviewers; do it in the UI, then verify:

- Settings → Environments → **production**: Required reviewers = you; Deployment branches = `main` only.
- Settings → Environments → **staging**: Deployment branches = `staging` only.

```bash
gh api repos/jtanori/solara/environments \
  --jq '.environments[] | {name, rules: (.protection_rules|length), policy: .deployment_branch_policy}'
# expect rules >= 1 and a non-null policy for both
```

---

## 3. Definition of "board is aligned"

- [ ] `git config --get-all remote.origin.fetch` returns a wildcard refspec; `git branch -r` shows `origin/staging`.
- [ ] Your local default branch fast-forwards cleanly (`git pull --ff-only`).
- [ ] The audit/plan docs are reachable locally (worktree or a docs PR on `staging`).
- [ ] All 27 open issues have a milestone + labels (`2.4` prints no `NO MILESTONE`).
- [ ] `#73` closed with a pointer to `#79`; `#79` is the only open tracking issue.
- [ ] `area:ci` label exists; `label-issues.sh` exits with only `OK` lines.
- [ ] Both environments show `rules >= 1`.
- [ ] `BACKLOG.md` matches GitHub (it is the offline index — ADR 002).
