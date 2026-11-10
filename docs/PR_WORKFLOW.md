# PR_WORKFLOW.md — the four-phase PR lifecycle

How work moves from "an agent claims it is done" to "landed on `main`" in this
repository's team: **one developer (the operator) plus multiple AI agents**
(coding agents, review agents) working through the same GitHub identity.

Supplements [`AGENTS.md`](../AGENTS.md) §5/§8. The review phase's depth standard
is [`docs/CODE_REVIEW.md`](CODE_REVIEW.md); this file covers the other three
phases plus the rules that keep the whole lifecycle satisfiable.

> **Why this file exists.** Every gate in this workflow must be satisfiable by
> the team that actually exists. A team of one human and N agents sharing one
> GitHub account structurally *cannot* satisfy "another approver" — GitHub
> blocks the author from approving their own PRs, and every agent here posts as
> the author's account. ADR 004 already encodes that (0 approvals, COMMENT-only
> reviews). This file extends the same logic to the full lifecycle.

---

## 0. Trust model (read before adding any gate)

| Layer | Actor | Provides |
|---|---|---|
| Machine | CI `verify` | No identity, no judgment: migrate, typecheck, lint, tests, audit, build, smoke. |
| Procedure | review agent | Not trust — **falsifiable evidence**: SHA-pinned reviews, mutation re-runs, commands re-executed rather than believed. |
| Human | the operator | Sole merge + deploy authority; manual fallback for every GitHub operation. |

**The catch-22 rule (standing):** no verification may be introduced whose only
satisfier is "another human" or "an independent GitHub identity". Concretely,
this repo will never require: approval counts, second reviewers, APPROVE
events, or a bot check that depends on GitHub API availability being a merge
gate. `pr-lint` (§2.4) is advisory and fails open for exactly this reason.

Known corollary for future work: **CODEOWNERS (#89), if adopted, is
routing/documentation only** — required-review CODEOWNERS would be a structural
catch-22 here and must not be configured.

---

## 1. Phase 1 — Pre-PR quality gate

An agent may not file a PR until every item below is met. Each item names the
*evidence* that satisfies it; evidence is pasted into the PR body, so a
reviewer can re-derive it rather than trust it.

1. **Plan adherence.** The diff matches the linked issue and any approved plan
   document. Every deviation is listed with a reason. *Evidence: a "Deviations
   from plan" section in the PR body ("none" counts).*
2. **Coherence.** One PR tells one story: conventional title
   `<type>(<scope>): summary (#issue)`, naming follows repo conventions, no
   orphan/scratch files, module boundaries respected. *Evidence: a self-review
   pass — the author reads their own full diff file-by-file before filing.*
3. **Code quality.** Strict types; every error path handled; no silent
   `catch` blocks (log with context); no dead code or unused exports; comments
   explain *why*, not *what*; non-obvious choices marked with rationale.
4. **Security** (CODE_REVIEW SEC-01/02 depth). Authz on new routes; input
   validation on every new untrusted input; untrusted data treated as data
   (injection posture); no secrets/PII in diff, logs, or model payloads; rate
   limits on new endpoints. *Evidence: named in the PR body's Risk section.*
5. **Performance.** No N+1 or unbounded loops on production paths; indexes for
   new query patterns; bundle impact for client code; **cost/latency ceilings
   for metered resources (LLM spend, API quotas) fail closed** — unpriced usage
   is never dispatched, and failed-attempt spend is recorded, not dropped.
6. **DRY** (SEC-06). Reuse before create; no copy-paste over ~10 lines; a new
   helper/type/client must not duplicate an existing one under another name.
7. **Test quality** (SEC-07). New behavior is covered; tests assert outcomes,
   not implementation; **mutation runs** for defect guards and for
   spend/ceiling/accounting logic. *Evidence: the mutations table in the PR
   body — mutation → test that fails → result.*
8. **Migrations and data.** Additive by default; `scripts/db-run.ts` required
   manifest updated for new tables; the staging migration rehearsal plan is
   stated; promotion implications noted (db-remote rehearsal →
   `deploy.sh --skip-migrate`).
9. **Config/env/docs.** Every new env var appears in `.env.example`,
   `.env.staging.example`, `.env.production.example` and is named in the PR
   body; `AGENTS.md` map updated if directories are added; user-facing docs
   updated.
10. **Dependencies.** New dependencies justified in the PR body, pinned,
    `npm audit` clean; lockfile changes only via the package manager.
11. **Freshness and overlap** (§5 below). Base fetched; if behind, the update
    procedure was run and full gates re-run on the merged tree; open PRs were
    checked for file overlap and any overlap is coordinated.
12. **Gates.** `npm ci`, `npx next typegen`, `npm exec tsc -- --noEmit`,
    `npx eslint src tests --max-warnings=0`, the full test suite, `npm run
    build` — output pasted. **Never claim a check that was not run.**
13. **Size and shape.** Prefer under ~400 changed lines; larger PRs are split
    into vertical slices or the size is explicitly justified in the body.
    Refactoring is never mixed with behavior change in one PR.

### 1.1 Size threshold (what skips the heavyweight path)

Substantive work — a new feature, a schema or migration change, a
security/privacy boundary, anything touching `.github/` — follows this file in
full. A typo fix, a failing assertion, or a direct operator request to "fix it
now" may skip items 7, 10 and 13 with a one-line note in the PR body; items 3,
4, 8 and 12 are never skippable.

---

## 2. Phase 2 — Filing the PR

1. Branch from `staging` as `<type>/<issue>-<slug>` (a fixed Arena session
   branch is the documented exception); PR targets `staging`; merge method is
   squash.
2. The PR body uses `.github/pull_request_template.md` in full: Summary,
   Linked issue (`Closes #X` on its own line), Branching, Evidence, Test plan,
   **Pre-PR attestation**, **Deploy classification**, **Deviations from plan**,
   **Mutations table**.
3. Labels: one `type:*`, one or more `area:*`, and exactly one deploy
   classification label (below).
4. `pr-lint` (advisory CI job) checks the paperwork — conventional title,
   `type:*` label, deploy label, Linked-issue/Evidence sections — and **fails
   open** if the GitHub API is unavailable. Dependabot PRs are exempt. It is
   deliberately *not* a required check: a paperwork bug must never be able to
   block a merge (§0).

### 2.1 Deploy classification

| Label | Means | Typical paths |
|---|---|---|
| `deploy:required` | Affects runtime or build: staging QA + migration rehearsal (if `drizzle/` touched) + build-pipeline attention after merge | `src/`, `drizzle/`, `next.config.ts`, `package*.json`, `.github/workflows/` |
| `deploy:skip` | Documentation/chore only: no staging QA, no migration rehearsal | `docs/`, `BACKLOG.md`, comments, `.md` files |

The author proposes the label at filing; **the reviewer's verdict confirms or
corrects it** — the final call is the review's. Vercel previews build on every
PR regardless; the classification governs post-merge attention (§4).

---

## 3. Phase 3 — Review

The review standard, mechanics, severity levels and mutation procedure are
[`docs/CODE_REVIEW.md`](CODE_REVIEW.md) — including its §8 verdict protocol
(verdict comment, deploy classification, 403 escalation). Summary of the flow:

1. Review agent posts a `COMMENT`-event review with inline findings anchored to
   the head SHA, re-executing claimed evidence where feasible.
2. Accepted findings become commits on the PR branch; each commit message says
   which finding it closes; the response is posted on the PR.
3. Review agent posts exactly one verdict comment:
   `Verdict: MERGEABLE | CHANGES REQUESTED @ <sha>` + what was and was not
   verified + `Deploy: deploy:required|deploy:skip — reason`.
4. **Operator's standing rule (the human's own discipline; agents may hold the
   operator to it): the operator does not merge a PR without a posted verdict
   comment naming the reviewed SHA.** If the review agent is unreachable, the
   operator either runs the review-posting command locally or explicitly
   waives the rule in writing on the PR.

---

## 4. Phase 4 — Post-merge checklist

Run by the coding agent unless marked *(operator)*:

1. Confirm the squash merge landed; capture the new `staging` SHA.
2. Confirm CI `verify` is green on the `staging` push.
3. Confirm the Vercel preview deployment is `READY` and aliased to
   `solara-stg.vercel.app` (via the Vercel connector — vercel.app is not
   reachable from the sandbox).
4. Confirm linked issues auto-closed; **file follow-up issues for every
   deferred Medium finding** (CODE_REVIEW.md severity semantics: Medium =
   follow-up — make that literal).
5. Confirm the branch auto-deleted (`delete_branch_on_merge`); sync local
   `staging`, prune, note the new SHA.
6. If `drizzle/` was touched: the staging migration rehearsal must be green,
   and production promotion runs the db-remote rehearsal first, then
   `deploy.sh --skip-migrate`.
7. If `deploy:required`: staging QA smoke on the touched surfaces (sign-in,
   map, PDF gate, Stripe test webhook, password reset, `/api/health`).
8. Update `BACKLOG.md` if issues were opened or closed (rides the next PR —
   the index is allowed to lag).
9. Promotion *(operator)*: when the operator calls for it, `deploy.sh` runs on
   explicit request only; post-promotion, verify `/api/health` and close the
   promotion-blocking issues.
10. Feedback loop: if the review exposed a systemic gap, update this file (and
    CODE_REVIEW.md) in the next PR — these docs are the contract and must stay
    current.

---

## 5. Parallel work, freshness, and branch updates

Agents work in parallel on different issues; the conflicts to manage are base
drift and file overlap.

**Before filing, and whenever the base moves while a PR is open:**

```bash
git fetch origin staging
git merge-base HEAD origin/staging   # != origin/staging tip ⇒ you are behind
git merge origin/staging             # merge, resolve, then RE-RUN FULL GATES
git push
```

- **Merge, never rebase-and-force-push**, once the branch is pushed — other
  consumers (CI runs, review anchors, the operator) reference its commits.
- Full gates must be re-run **on the merged tree**; a green result on the
  pre-merge tree says nothing about the combination.
- Branch protection requires the branch to be up to date before merge anyway.

**Overlap detection:** before starting work and again before filing, list open
PRs and their files (`gh pr list`, `gh pr diff <n> --name-only`). If another
open PR touches the same files, do not silently race it: shape edits to merge
cleanly where possible, and record the coordination (PR number, who merges
first) in the PR body. Modifying *another agent's open branch* requires
operator coordination first.

---

## 6. GitHub 403s and operator escalation

Token or permission failures on PR operations (observed in practice: transient
403s on labels, logs, artifacts, review posts):

1. **Retry once** after a short delay — most are transient.
2. If it persists: **stop.** Report to the operator with (a) the exact failing
   operation, (b) the exact `gh` command(s) or API call to run locally, and
   (c) the prepared payload (review body, comment text) so nothing is lost.
3. **Never substitute**: no issue comment in place of a review, no claim that
   something was posted when it was not, no silent skip. A failed post is
   reported as a failed post.

The operator running the command locally is always a valid completion path —
that is the escape valve that keeps every gate in this workflow satisfiable.
