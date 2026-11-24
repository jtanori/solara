# Backlog review — what's ahead (2026-11-10)

> **Note (2026-11-10):** `BACKLOG.md` was removed from the repository in favour of an on-demand,
> gitignored snapshot — see **ADR 009** and #132. References to it below describe the state at the
> time of writing.

Snapshot taken against `staging@750a272` (= this session branch), `main@4490ced`, and the live
GitHub issue tracker. Numbers below were queried, not remembered.

> `BACKLOG.md` is stale (last updated 2026-11-10, but before #126/#127/#130 landed and without
> #128/#129/#130). Treat GitHub as the source of truth, as ADR 002 says.

---

## 1. Where the repo actually stands

**Test/CI health: good.** `Continuous integration` is green on both `staging` and `main` tips.

**The work has moved faster than the paperwork.** Since the last promotion we merged 16 commits
touching 196 files (+19,657 / −254) — auth hardening (#118), Placidus + chart v2 (#121/#122), the
readiness/drift/ADR block (#126), password reset + logging + places + pool (#125), base-freshness
gating (#124), and the whole readings pipeline (#127). All of that is on `staging` only.

**56 open issues**, distributed as:

| Bucket | Count | Notes |
|---|---|---|
| M3 — Launch readiness | 36 | where nearly all p0/p1 work lives |
| M1 — Foundation | 15 | mostly p2 polish |
| M2 — Billing | 1 | #10, blocked on Stripe test keys |
| **Unmilestoned** | **4** | #117, #119, #128, #129 |
| `priority:p0` | 4 | #53, #54, #55, #105 |
| `priority:p1` | 32 | the real backlog |
| `status:blocked` | 9 | #10, #55, #59, #64, #65, #70, #71, #75, #76 |

**Issue state has drifted badly.** This is the single biggest process problem in the backlog:

- Merged to `staging` but still showing `status:ready`: #53, #54, #56, #57, #60, #64, #70, #72,
  #78, #84, #87, #88?, #103, #119 (13-ish). Several are labelled `status:blocked` while their code
  is on `staging` and green: **#55, #64, #70**.
- Closed but still referenced as open: #52 (closed, but #79, #73, #71, #59, #65 all still "blocked on
  #52"); #101/#102/#117 (closed, yet #99 and #100 still list them as open children).
- #122 is listed as an open PR in `BACKLOG.md` but was merged as `da4c36b`.
- ADR numbering in issues is out of date: #72 asks for "ADR 006" and #78 for "ADR 007/008", but the
  docs landed as 006 = identity, 007 = auth hardening, 008 = migrations. The docs are right; the
  issue text is stale.

---

## 2. Five things I need from you (they block planning, not coding)

1. **Promotion (`staging → main`) — do it before more work lands.** There is no open promotion PR
   and `main` is 196 files behind. The longer this waits the more the exact-SHA rehearsal in #119
   costs, and `deploy.sh`'s freshness gate (#124) will start refusing merges. **This is the highest
   value half-day in the backlog** because it also closes ~13 issues for free on promotion.
2. **Production database is still unprovisioned.** #52's own resolution says so: prod will throw
   `42P01` on first auth, exactly like staging did. Gated on #75/#76, which are gated on protected
   environments — and I confirmed **both `staging` and `production` GitHub Environments still have
   `protection_rules: 0`**. That toggle is yours; no agent can flip it.
3. **Real LLM provider — there is no issue for it.** `src/readings/provider.ts` only registers
   `fixture` in `PROVIDERS`; no SDK is in `package.json`; and no open issue body mentions a provider
   adapter or SDK. The pipeline is dark (`READINGS_GENERATION_ENABLED` defaults false) and will
   produce synthetic text forever until someone files this. It sits on the critical path to #107.
   Which vendor + budget assumption is a decision, not a task.
4. **"One free reading per user, ever"** — decided in the epic plan §9b/§9c, but it appears in **no
   open issue body** (I searched all 56). #104 covers rendering/teasers; #107 covers entitlement.
   The enforcement rule has no owner. Either fold it into #104 or file it.
5. **Dependabot triage.** 13 open PRs, 2 red: TypeScript 7.0.2 (#34) and ESLint 10 (#30) both fail
   `verify`. The rest are green but unmerged and will conflict with each other
   (tailwind ×2, react, eslint-config-next). Needs a batch decision, not drip-feed merges.

---

## 3. Suggested order of work

### Track 0 — hygiene, half a day, unblocks everything else
- Promotion PR `staging → main` with the exact-SHA rehearsal (#119).
- Close/relabel everything already merged: #53–#57, #60, #64, #70, #72, #78, #84, #87, #103, #119.
- Re-scope or close #100 (child of #99) — #127 already delivered `types.ts`/`document.ts`/`schemas.ts`
  and the new tables. Decide "done" vs "residual scope" explicitly instead of leaving it `in-progress`.
- Unblock #76 (its blocker #70 is merged), close #117 (fixed in #121), close #71's dependency on #52.
- Refresh `BACKLOG.md` in the same PR.

### Track 1 — production is safe to exist (launch gate, per #79)
Order matters here: #75 before #76, #76 before any prod migration.

| Order | Issue | Why now | Effort (from issue) |
|---|---|---|---|
| 1 | #75 migrate pipeline (plan/approval/lock/post-verify) | needs *your* environment protection rules first | 0.5 d |
| 2 | #76 deploy.sh fail-closed | blocker #70 merged | 0.5–1 d |
| 3 | #77 error tracking + alerts | zero observability; #52 arrived as a user screenshot | 0.5 d |
| 4 | #74 journal integrity in CI | 3 h, no dependencies | 3 h |
| 5 | #59 least-privilege DB roles | now unblocked (#52 closed) | 0.5 d |
| 6 | #62 backup/restore drill (one, recorded) | data recoverability is an M3 gate | 0.5 d |

### Track 2 — finish the reading (the product)
Critical path from #99 becomes **#105 → real provider → #104 → #107 → #106**.

- **#105 consent capture (p0)** — hard gate: nothing may generate without it.
- **Real provider adapter** — the missing issue from item 3 above.
- **#104 free tier + locked teasers** — plus the "one free reading" rule from item 4.
- **#107 paid generation on entitlement** — depends on #10 being verifiable (Stripe test keys).
- **#106 renderer page + PDF** — p2; PDF is in scope at launch per decision 5, so it is not optional.
- **#108 cost guards** — largely implemented inside #127; needs a "what remains" pass, not a rebuild.
- **#109 eval harness / astrologer review** — the quality gate; needs a corpus and a human astrologer.
- **#110 profections + transits** — gates `planetaryYear`/`transits`, which the registry already
  marks `requiresFacts`. Paid tier is 7 live sections today, not 9.

### Track 3 — launch hygiene, parallelisable, no dependencies
#58 staff MFA (or a recorded risk acceptance), #82 PII retention/erasure, #85 legal pages + SEO,
#88 supply chain, #89 CODEOWNERS/approvals, #90 secret inventory, #81 storage decision,
#61 secret scan, #66/#67/#68/#69 (session + re-auth cluster), #86 error boundaries.

### Explicitly not now
#83 realtime (no consumer yet), #110 is above but its dependents are paid-only, #111 astrologer
tooling (p3, after #109), #92 e2e/perf budgets, #93 `users.plan` dead state, #63 env single-source.

---

## 4. Risks I'd flag now

- **Stale `status:blocked` on merged work** is the worst failure mode in this repo: #70 sat blocked
  while merged, which is exactly what kept #76 blocked. Relabel discipline beats new tooling.
- **Two red dependency PRs left open** will silently rot; TS 7 and ESLint 10 are majors that will
  need a dedicated pass anyway.
- **Readings has 3 landed-but-undeclared follow-ups now** (#128 repair-branch test, #129
  invalid-usage is invisible to the spend ledger). #129 is the more serious one: a provider that
  always misreports usage forces the full dispatch set with the ledger reading `0 / 0`, so the
  ceiling has nothing to gate. Both are cheap and touch the same code — **one small PR closes both.**
  I'd do that before anything else on Track 2, since it is a bounded correctness fix on fresh code.

---

## 5. If you want me to start now

Cheapest first PR that is unambiguously mine to do: **#128 + #129 together** (same accounting path,
both explicitly say "land in one PR", mutations + tests required). Then the Track 0 hygiene PR.

Say the word on any of items 1–5 above and I'll queue accordingly.

---

### How this was verified

`gh issue list --state open --json …` (56 issues, milestone/priority/status tallies);
`gh api repos/jtanori/solara/compare/main...staging` (ahead 16 / behind 5, diverged);
`gh pr list --state open` (13 dependabot, 0 promotion); `gh pr checks 34`, `gh pr checks 30`;
`gh api repos/jtanori/solara/environments` (`protection_rules: 0` on both);
`git diff --stat origin/main origin/staging` (196 files);
grep over `src/readings/provider.ts` (`PROVIDERS` = `{ fixture }`) and all open issue bodies for
provider/free-reading language (no matches). Note the local clone is shallow — ancestry claims from
plain `git log` are unreliable here, which is why the compare API was used.
