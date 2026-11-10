# CODE_REVIEW.md — review standard and mechanics

Supplement to [`AGENTS.md`](../AGENTS.md) §5 and ADR 004. `AGENTS.md` says *that* reviews are
COMMENT-only; this file says *how* a review is produced, recorded and enforced.

> **Why this file exists.** Through PRs #95–#113 this repository had 0 recorded reviews, 0 inline
> comments and 0 review threads. Two PRs shipped real defects (#97: five of them; #112: every
> planet placed heliocentrically, up to 175° wrong). A review that happens in a chat window and is
> never posted did not happen, and nothing here can enforce a conversation that was never held.

---

## 1. The rule that matters most

**A review exists only if it is on the PR.** Concretely, one of:

```bash
# a COMMENT-event review with a summary
gh api -X POST repos/:owner/:repo/pulls/<n>/reviews -f event=COMMENT --body-file review.md

# inline findings anchored to diff lines (preferred) — see §4
gh api -X POST repos/:owner/:repo/pulls/<n>/reviews --input review.json
```

Prose pasted into a chat, a file in another workspace, or an unposted local note is **not a
review**. It cannot be resolved, cannot be audited, and does not satisfy conversation resolution.

Consequences that follow from this, all of which have already bitten this repo:

- Findings get fixed **on the PR branch, as commits**, so CI runs on them.
- The reviewed commit SHA is named in the review body. Without it, a review is unfalsifiable.
- "I applied the fixes elsewhere" is not a state. Either the commit is on the branch or it is not.

## 2. Sole-maintainer reality

| | |
|---|---|
| Approvals required | **0** (ADR 004). The author cannot approve their own PR — GitHub blocks it. |
| Review event | `COMMENT` only. Never `APPROVE`, never `REQUEST_CHANGES` from the author. |
| Enforcement that is real | `required_review_thread_resolution: true` → open inline threads block the merge |
| Enforcement that is not | anything relying on a review that was never posted |

So the merge gate is: **`verify` green + branch up to date + every inline thread resolved.** If no
threads are opened, there is nothing to resolve, and the gate passes on CI alone. That is the gap
this document exists to close: opening threads is what makes the gate mean anything.

An AI-assisted review posted through the maintainer's account is acceptable. It must be labelled
as such — `AI-assisted review of <sha>` — and never described as independent.

## 3. Checklist

Report each finding by severity: **Blocker** (do not merge), **High** (merge only with explicit
justification), **Medium** (follow-up). State explicitly which items were not verified; never
imply an unperformed check passed.

### Blockers

- [ ] **SEC-01 One path.** Trace a path end to end, including its failure steps.
- [ ] **SEC-02 Boundaries.** Auth, tenancy, input validation, untrusted-input handling — unchanged,
      or changed deliberately and stated.
- [ ] **SEC-03 CI.** Read every `.github/` diff in full. No skipped tests, lowered thresholds, or
      moved triggers.
- [ ] **SEC-04 Evidence.** A test, CI run or screenshot proves the change ran.
- [ ] **SEC-05 APIs and imports.** Every symbol exists in the version this repo actually runs.
- [ ] **Migration.** Any `drizzle/` diff is reviewed at Blocker severity: additive or justified, the staging migration rehearsal is planned/green, `scripts/db-run.ts`'s required manifest covers new tables, and the promotion path is stated (db-remote rehearsal → `deploy.sh --skip-migrate`).

### High

- [ ] **Shape.** One sentence describes the change and matches the title.
- [ ] **Blast radius.** Nothing outside the stated scope moved.
- [ ] **Deletions.** No live callers; removals are intentional.
- [ ] **Config and permissions.** New env vars, scopes and timeouts are named in the description
      and are wanted.
- [ ] **Plan adherence.** The diff matches the linked issue and any approved plan document;
      deviations are listed and justified in the PR body, not discovered by the reviewer.
- [ ] **Spend accounting.** Any metered resource (LLM tokens, external API quota) fails closed:
      unpriced usage is never dispatched, ceilings are checked before *and* after dispatch, and
      failed-attempt spend is recorded (not dropped) in the run's accounting.

### Medium

- [ ] **SEC-06 Duplication.** A new helper, client or type does not already exist under another name.
- [ ] **SEC-07 Test quality.** The tests would fail if the code were broken. *See §5 — this is the
      item that caught a real defect here, and it needs mutation, not reading.*
- [ ] **Performance.** No N+1 queries, unbounded loops or missing pagination on production paths.
- [ ] **Coherence.** Naming and module boundaries follow the repo; no orphan files; the diff
      tells one story (title, body and changes agree).
- [ ] **Code quality.** No silent `catch` blocks, no dead code; comments explain why; error
      paths are handled, not wished away.
- [ ] **Config completeness.** Every new env var appears in `.env.example` and the
      staging/production examples, and is named in the PR body.

## 4. Mechanics

Inline, anchored to the smallest relevant changed range on the **head commit**:

```json
{
  "event": "COMMENT",
  "body": "Summary in 2–4 sentences. Reference inline threads by file:line.",
  "comments": [
    {
      "path": "src/lib/astro.ts",
      "start_line": 41, "start_side": "RIGHT",
      "line": 44,     "side": "RIGHT",
      "body": "**Blocker (SEC-05)** — `EclipticLongitude` is heliocentric; every planet is placed from the Sun's centre.\n\n```suggestion\n  return normalize(Ecliptic(GeoVector(Body[body], time, true)).elon);\n```"
    }
  ]
}
```

Rules:

- One inline comment per finding. Severity tag, one-sentence problem, then the fix.
- A drop-in fix ends the comment body with a `suggestion` block — it must be the last content, and
  it must replace the anchored lines exactly (indentation included).
- Multiline ranges use `start_line`/`line` with `side: RIGHT` and `start_side: RIGHT`.
- Architectural or cross-file advice goes in prose, not a suggestion.
- The review body carries a 2–4 sentence summary plus anything unanchorable.
- **Never** approve, request changes, push, or merge as part of a review.
- If the review cannot be completed (missing context, unrun tests, oversized diff): still post a
  `COMMENT` review, first line `⚠️ Partial review`, stating what was and was not verified.
- If the review endpoint fails, say so. **Never** substitute an issue comment.

## 5. Test quality needs mutation, not reading

SEC-07 is the highest-yield item in this repo because every serious defect of the last two days
was a check that reported confidently about something it did not check:

- an "in sync" verdict derived from the job's exit code rather than the schema;
- a retrograde test that computed the expected value and never compared it;
- a chart that was internally consistent and 47° wrong against reality.

Procedure: **break the code deliberately and watch the test fail.** If it still passes, the test is
decoration. Record the mutation in the PR body — "flipping `motion < 0` → `motion > 0` makes test
10 fail" is the evidence that a test earns its place.

## 6. Local verification budget

Prefer scoped checks for the files you touched:

```bash
npx tsx --test tests/<file>.test.ts          # scoped suite
npm run typecheck                            # tsc --noEmit
npx eslint <paths> --max-warnings=0
```

A full-suite run, `npm run build`, or a project-wide typecheck is expensive. Before running one,
say why, give the exact command, and wait for authorisation. Standing authorisation is valid only
when explicitly granted for the session. A check you did not run is not a check you may report.

## 7. Recording the outcome

- The review body names the **reviewed SHA**.
- Accepted findings become commits on the PR branch; each commit message says which finding it closes.
- The response to a review is posted on the PR, not only in chat — including when a finding is
  disputed, and why.
- Unresolved threads stay unresolved and block the merge. That is the point of the mechanism.

## 8. Verdict and deploy classification

After the inline review, post exactly one verdict comment on the PR:

```
Verdict: MERGEABLE | CHANGES REQUESTED @ <head sha>
Verified: <what was re-executed>
Not verified: <what was not, and why>
Deploy: deploy:required | deploy:skip — <one-line reason>
```

- The verdict names the reviewed SHA and states what was **not** verified (§3
  doctrine). It is procedural, never a ruleset gate — a missing verdict cannot
  deadlock a merge (`docs/PR_WORKFLOW.md` §0, the catch-22 rule). In practice it
  is required by the operator's standing rule: **the operator does not merge
  without a posted verdict comment naming the reviewed SHA** (waived only in
  writing on the PR).
- **Deploy classification** — the reviewer has the final call and corrects the
  label if the author got it wrong:
  - `deploy:required` — touches `src/`, `drizzle/`, `next.config.ts`,
    `package*.json`, `.github/workflows/` → staging QA and, where applicable,
    migration rehearsal after merge.
  - `deploy:skip` — docs/chore only → no staging QA, no rehearsal.
- If the review or verdict endpoint fails (403, permissions), follow
  `docs/PR_WORKFLOW.md` §6: retry once, then escalate to the operator with the
  exact command and the prepared payload. Never substitute an issue comment for
  a review; never claim a post that was not posted.
