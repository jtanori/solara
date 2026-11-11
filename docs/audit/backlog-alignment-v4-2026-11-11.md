# Backlog alignment v4 — product-first reordering

**Date:** 2026-11-11 · **Base:** `staging` @ `e030672` · **Artifacts:** `scripts/align-backlog.sh`, `scripts/verify-align-plan.sh`

Dry-run verified at 149 planned actions. `scripts/verify-align-plan.sh` passes 9/9, and
two mutations (a bare `p0`, and closing an issue that is also reassigned) each turn it red.

---

## What changed from v3, and why

| # | Change | Reason |
|---|---|---|
| 1 | **14 new issues instead of 24**; paraphrases of #135, #136, #76, #134, #63+#91 removed | v3 filed new issues that *restated* existing ones. `issue_number_by_title` matches exact titles, so the run would have added ~9 duplicates while closing 15 — leaving the tracker worse than it started |
| 2 | Dedupe by explicit `key` (`NEW-0N` in the title), not by title equality | a paraphrase is still a duplicate; the key is the identity |
| 3 | `issue_has_label` / `issue_current_milestone` read from one bulk query | each was a `gh` call per check (60+ per run) and **a failed read was indistinguishable from an absent label** — so a transient error became a *write*: re-adding a priority the issue already had, or skipping a removal. Two consecutive dry runs produced different plans. Now: one call, verified non-empty, retried, and **aborts rather than guessing**. Confirmed deterministic across two full runs |
| 4 | `gh label create` no longer uses `--force` | the flaky check made preflight rewrite existing labels' colour and description |
| 5 | `PLAN|phase|action|key` lines emitted for every action | the plan is now assertable instead of grepped. v3's own verification block failed: `\bp[0-3]\b` matches inside `priority:p0` (reported 37, expected 0), and the `gh issue create` count was 24 vs the claimed 21 |
| 6 | `verify-align-plan.sh` counts `p[0-3]` total minus `priority:p[0-3]` | the first attempt at this check used an anchored regex that matched nothing at all — it would have passed on any input. Caught by mutating the plan |
| 7 | Close list uses `|` not `:` as its separator | `#130`-style reasons contain `:` and would have split wrongly |

## Milestone restructure: product first

The v3 plan put deployment first because the deploy path is the biggest *technical* risk.
That is true and it is the wrong order: you cannot demo a product that does not exist, and
the customer-facing half is unbuilt.

| Milestone | Purpose | Exit |
|---|---|---|
| **S0** Backlog cleanup | make the tracker honest | no open issue has merged code; no duplicates |
| **S1** Product: a real reading, locally | build and demo the loop on localhost | a real LLM returns 11 sections, `/reading/[id]` renders them, free sections lock, Stripe test checkout unlocks paid, demo recorded |
| **S2** First deployment | ship what S1 built | migrations 0001–0003 hosted, first promotion, rollback drill, `deploys.md` ≥2 rows |
| **S3** Hardening | security and ops once it ships | MFA, backup drill, error tracking, legal pages, retention |
| **S4** Content completion | full paid experience | paid generation, eval harness, review gate, profections/transits |

## The finding that reshapes S1

`src/readings/provider.ts` exports exactly one provider:

```js
export const PROVIDERS: Record<string, () => ReadingProvider> = {
  fixture: createFixtureProvider,
};
```

`READINGS_PROVIDER=openai` resolves to `undefined` → `resolveProvider()` returns `null` → every
section fails. The local-first plan listed this as "one config step". It is not: it needs a real
adapter (SDK call, JSON-schema enforcement, usage mapping, timeout, retry) and that is **NEW-04**,
the first thing in S1.

Worse for the plan's step 3 ("generate a reading, judge the output"): the fixture is deliberately
chart-grounded — it cites the real Sun degree, house and tightest aspect — so its prose reads like
a working product. Judging product quality against it would be judging a template.
**NEW-13** exists to keep that step honest, and is blocked on NEW-04.

## What the renderer actually needs

`src/readings/document.ts` already assembles sections **and** computes `lockedSections` for the
paid tier, with tests. `src/app/reading/[id]/page.tsx` is 25 lines that render the chart and static
`getReadingNotes()` prose — it never reads `reading_documents`. So #106 is mostly "read the frozen
document, map block kinds to JSX". The PDF route is 23 lines and produces a summary, so the full
editorial PDF is genuinely new work.

## Deployment simplification: agreed, with one gate

Changes 1–5 are sound and reduce ceremony rather than capability. One is deferred behind a
dependency rather than listed as a peer:

- **NEW-08 keeps the preview-readiness probe.** The plan wants to drop it because "CI already
  checks it", but `ci.yml:78-82` probes a **localhost** build, not the deployed preview. That gate
  caught a broken preview on #133 and removed a real failure mode.
- **NEW-09 (staging-as-rehearsal) is gated on NEW-07.** Removing the rehearsal-artifact clause before
  migrations demonstrably run on staging via CI lets production be first again — the exact failure
  ADR 008's gate exists to prevent.

## Counts

```
open now                                      61
closed by this plan                           15
reassigned to S1–S4                           46
new issues filed                              15   (NEW-01..NEW-15)
open after                                    61   (46 + 15)
  of which genuinely new work                 15
  of which previously misfiled as open        15 → closed
```

## Applying it

```bash
scripts/align-backlog.sh > /tmp/plan.txt      # dry run
scripts/verify-align-plan.sh /tmp/plan.txt    # asserts 9 invariants; exits non-zero on any failure

scripts/align-backlog.sh --apply --only=close
scripts/align-backlog.sh --apply --only=labels
scripts/align-backlog.sh --apply --only=milestones
scripts/align-backlog.sh --apply --only=new-issues

scripts/align-backlog.sh                       # re-run: every action should now be a skip
```

Milestones S1–S4 are created in the `preflight` phase, which runs for every invocation.
