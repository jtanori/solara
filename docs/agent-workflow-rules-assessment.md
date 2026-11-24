# Assessment — external "Agent Workflow Rules" against this repository

> **Note (2026-11-10):** `BACKLOG.md` was removed from the repository in favour of an on-demand,
> gitignored snapshot — see **ADR 009** and #132. References to it below describe the state at the
> time of writing.

Source: an external rules document supplied by the operator on 2026-11-08. This compares each
section against what this repository actually has, and records adoption.

Legend: **FIT** adopt as-is · **ADAPT** adopt with local changes · **NA** does not apply ·
**REJECT** contradicts an existing decision.

## 0. Summary

| Area | Verdict |
|---|---|
| Backlog and planning | **FIT** — already ADR 002 and AGENTS.md §6 |
| Task checklist before substantive work | **ADAPT** — contradicts momentum on small fixes; adopted with a size threshold |
| PR review checklist (SEC-01…SEC-07) | **FIT, and the most valuable part** — adopted into `docs/CODE_REVIEW.md` |
| Review output mechanics (COMMENT event, inline, suggestions) | **FIT** — adopted; §4 of `docs/CODE_REVIEW.md` |
| Partial-review protocol | **FIT** — adopted |
| "Don't claim unperformed verification" | **FIT, urgent** — adopted into AGENTS.md §5 and §8 |
| Verification budget / full-suite authorisation | **ADAPT** — adopted with a scoping rule |
| Git hygiene (atomic commits, no force-push, no config changes) | **FIT** — already practice; now explicit |
| `main` is production, PRs go to the integration base | **FIT** — already ADR 001 |
| References to `docs/plans/`, `WORK_PLAN.md`, certificates | **REJECT** — refer to a different project's layout |

## 1. Backlog and planning

**Status: FIT, already in place — nothing to change.**

The external rules state that GitHub Issues are authoritative, that milestones are work slices,
that `BACKLOG.md` is a link index without automatic synchronisation, and that `docs/plans/` plus
`WORK_PLAN.md` and certificates are historical context rather than status.

This repository already does exactly that: ADR 002 ("Offline `BACKLOG.md` is an index, not a source
of truth"), AGENTS.md §6, and the index's own footer ("This index is intentionally minimal… All
lifecycle state lives in GitHub").

**Divergence:** `docs/plans/` does not exist here. Planning documents live at `docs/plan-*.md`
(e.g. `docs/plan-readings-engine-epic.md`) and audits at `docs/audit/`. The rules' path references
are from another project; the *principle* — planning docs are context, not lifecycle — is already
honoured. No file rename needed.

## 2. Implementation and coordination

**Status: ADAPT.**

- *"Present a concrete task checklist and wait for explicit operator confirmation before
  substantive work."* Adopted **with a threshold**: substantive means a new feature, a schema or
  migration change, a security/privacy boundary, or anything touching `.github/`. A typo, a failing
  assertion, or a direct operator request to fix now are explicitly excepted — the external text
  says as much ("a trivial directly requested correction is an exception"), but the single word
  *substantive* needs defining or it will be read as "everything".
- *"Coordinate before intervening on work owned by another agent… do not modify a branch with an
  open PR without operator coordination."* Adopted verbatim — this session produced a concrete
  failure of it: an external review's fixes were applied in another workspace and never reached
  the PR branch, leaving the PR unchanged while appearing reviewed.
- *"If GitHub access is unavailable, report the limitation and retain findings."* Adopted. Observed
  in practice this session (token 403s on labels, logs, artifacts) and the reporting behaviour was
  correct.

## 3. PR review checklist

**Status: FIT — the most valuable section. Adopted in full as `docs/CODE_REVIEW.md` §3.**

Every item maps onto a real failure from this repository:

| Item | The defect it would have caught |
|---|---|
| SEC-04 Evidence | #97 and #112 merged with no review artifact anywhere |
| SEC-05 APIs and imports exist in this version | `EclipticLongitude` returning **heliocentric** longitude — the name suggested otherwise and nothing verified the API's actual contract |
| SEC-07 Tests fail if the code is broken | the retrograde test computed an expected value and never compared it; it passed under a deliberate mutation of the logic it claimed to test |
| SEC-03 Read `.github/` diffs in full | the migrate workflow's own guard reported "in sync" from the job's exit code rather than the schema |
| SEC-01 One path, including failure steps | a post-migration check that exited 1 *after* `drizzle-kit` had already succeeded |

**Note on SEC-07:** reading a test is not enough to satisfy it. This repo's procedure is now
mutation — break the code, watch the test fail, record the result in the PR body
(`docs/CODE_REVIEW.md` §5).

## 4. Review output

**Status: FIT — adopted verbatim.** This is the section that directly contradicts observed practice:
"Never use a PR issue comment as a substitute" for a review. Through #95–#113 there were **0
`POST /pulls/{n}/reviews` calls**; the one review of #113 arrived as chat text and its substance was
posted as an issue comment — which the external rules explicitly forbid as a substitute.

Adopted: `COMMENT` event only; one inline comment per finding; severity tag; suggestion block last
in the body; multiline ranges via `start_line`/`line` with `side: RIGHT`; 2–4 sentence summary in
the body; `⚠️ Partial review` when incomplete; report endpoint failure rather than silently
substituting.

## 5. Verification and git hygiene

**Status: FIT with one ADAPT.**

- *"Do not claim a test, build or CI run passed without running or observing it."* **Adopted, and
  this is the single most important rule in the document for this repository.** It is also the rule
  most often broken here — by me — in a specific way: a check that *looked* like verification while
  verifying nothing. Now written into AGENTS.md §5 and §8.
- *"Prefer scoped tests; full-suite runs and expensive project-wide checks require operator
  approval."* **ADAPT.** Adopted as: scope the tests and linters you run to touched paths; say what
  a full-suite run costs and why it is needed; never report an unrun check. Standing authorisation
  is per-session only.
- *"Atomic commits, no amend, no force-push, no git config changes."* FIT — already practice.
- *"`main` is production; use the designated integration base."* FIT — ADR 001, PRs target `staging`.

## 6. What is rejected

| Item | Why |
|---|---|
| `docs/plans/` paths, `WORK_PLAN.md`, "certificates" | Different project's artefacts. This repo has `docs/plan-*.md`, `docs/audit/`, and ADRs. Adopting the paths would create empty bureaucracy. |
| Implied "review is a separate agent's job" | There is one human and one AI. The review *event* still has to be posted; who produces it is secondary. |
| Treating the checklist as blocking on its own | Approvals are structurally 0 (ADR 004). The enforceable gate is `verify` + thread resolution; the checklist matters because it produces threads. |

## 7. Gaps in the external rules, found against this repository

Things this repository needs that the pasted document does not cover:

1. **Migration and deployment review.** Nothing in the document addresses a PR that changes
   `drizzle/`. Here that means: a green `migrate staging pr-<n>` rehearsal before any production
   migration, and the production gate in `.github/workflows/migrate.yml`. Reviewing the SQL is a
   blocker-severity act, not a Medium.
2. **Secrets and environment boundaries.** `SEC-02` touches boundaries generally, but not the
   specific rule this repo lives by: a database URL lives only in a GitHub Environment secret, and
   the model-facing payload is PII-free.
3. **Agent-authored claims about agent work.** The external rules say not to claim unperformed
   verification, but give no mechanism. This repo now requires the mutation result and the reviewed
   SHA to be *in the PR body*, where they are falsifiable.
4. **Sole-maintainer mechanics.** "Do not approve" is easy; the document does not explain what
   replaces an approval. Here: inline threads rather than approvals are what the protection rule
   actually enforces.

## 8. Applied in this change

- `docs/CODE_REVIEW.md` — new: the checklist, severity levels, review mechanics, mutation
  procedure, verification budget.
- `AGENTS.md` §5 — "a review exists only if it is on the PR", the SEC-07 mutation rule, Vercel and
  GitGuardian recorded as advisory rather than required, and an explicit ban on claiming an unrun
  check.
- `AGENTS.md` §8 — two checklist items: the review must be posted to the PR; mutation results go in
  the PR body.

Not done, and deliberately: no new workflow that *pretends* to review. A bot posting a checklist
comment is an issue comment, which the external rules correctly call a non-substitute.
