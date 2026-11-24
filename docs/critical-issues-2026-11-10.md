# Critical issues still waiting — 2026-11-10

Snapshot: 57 open issues, 4 × p0, 32 × p1, 9 still labelled `status:blocked`.
Config/secret issues are now tracked in **#131** (mail + secrets), so they are not repeated here.

---

## The headline

**Nothing p0 is actually waiting, and nearly everything p1 "blocked" is unblocked but mislabelled.**
Of the 9 issues labelled `status:blocked`, **7 have their blocker merged** — only #10 and #65 are
genuinely blocked. The label sweep is the highest-value cleanup in the backlog.

---

## 1. p0 — all four are shipped, none is waiting

| # | Title | Reality |
|---|---|---|
| #53 | rate-limit sign-up/sign-in | merged via #118 |
| #54 | email transport + verification | merged via #118 — **but see #131**: the code is merged and the mail configuration does not exist, so the outcome is unreachable |
| #55 | password reset | merged via #125 (still labelled `status:blocked` — wrong) |
| #105 | readings consent capture | **needs filing check**: not built, and not blocking this deploy because readings are dark |

**Action:** close #53, #54, #55 as part of the promotion. Keep #105 open — it is genuinely unbuilt and
p0 only in the sense that it must exist before the readings flag is ever turned on.

---

## 2. p1 truly blocked (2)

| # | Blocked on | Why it matters |
|---|---|---|
| #10 | Stripe test keys + CLI login | Gates #107 (paid readings) and the whole billing acceptance |
| #65 | #52 closed, so really blocked on a **decision**, not a dependency | Only one non-PK index exists in the schema |

---

## 3. p1 not started, no code — these are the real waiting list

Verified by absence of the implementing file/route:

| # | Title | Evidence it is unbuilt |
|---|---|---|
| **#77** | error tracking + alerts | `src/lib/error-report.ts` **exists but only routes errors to `log.error`** — no external sink, no alerts. This is the reason #52 reached you as a screenshot. **Highest-value unbuilt item.** |
| **#62** | backup/restore drill | No drill document or recorded result anywhere; ADR 003 makes it a launch gate |
| **#76** | `deploy.sh` fail-closed | No rollback, no release records, no tags in the script |
| **#58** | TOTP MFA for owner/admin | No totp/mfa module at all (`#79` allows a recorded risk acceptance instead) |
| **#85** | legal pages, consent, SEO | No `/privacy`, `/terms`, `robots.txt`, `sitemap`, or OG metadata anywhere in `src/` |
| **#82** | PII retention/export/erasure | No retention or export path; `audit_logs` is write-only |
| **#81** | PDF artefact + storage | No storage layer; PDFs re-render per request |
| **#88** | supply-chain controls | Only `dependabot.yml`; **no** dependency-review workflow, no SBOM |
| **#89** | CODEOWNERS + required approvals | No `.github/CODEOWNERS` |
| **#90** | secret inventory + rotation | No inventory; #131 is the first concrete entry |
| **#104/#106/#107/#109/#110** | readings tier work | No renderer, entitlement, eval harness, or profections module. Deliberately deferred behind the LLM decision |

---

## 4. p1 mostly done — needs a close or a residual-scope pass, not new work

| # | What exists | What remains |
|---|---|---|
| **#74** | `src/lib/migration-manifest.ts` + `db:manifest:check` + `db:check` all run in CI `verify` | Issue asks for **immutable applied migrations** (detect an edited, already-applied file). Not obviously covered — verify before closing |
| **#75** | `migrate.yml` already has `rehearsal_pr`, the production precondition gate, a **plan** step, artifacts, and post-verify | Issue asks for **approval + advisory lock + audit**. Plan/verify/artifacts exist; check whether the advisory lock landed |
| #60, #64, #70, #72, #78 | merged via #125/#126 | close on promotion, relabel now |
| #84, #87, #119 | merged | close on promotion |
| #117 | fixed in #121 | **close now** — it is unmilestoned and untriaged |

---

## 5. Recommended execution order

**Now (no code):**
1. Relabel: remove `status:blocked` from **#55, #59, #64, #70, #71, #75, #76** (blockers merged).
2. Close **#117**; relabel #75/#76 to `status:ready`.
3. Milestone #117, #119, #128, #129 (fixed), #131.

**This cycle (p1, unblocked, ordered by risk removed per hour):**
1. **#77 error tracking** — without it, every later failure is invisible.
2. **#62 backup/restore drill** — ADR 003 gate; a restore you have never tested is not a backup.
3. **#76 deploy.sh fail-closed** — rollback + release records.
4. **#74 / #75 residual scope** — decide "already covered" vs "remaining", then close or scope down.
5. **#58 MFA or recorded risk acceptance** — a decision, not necessarily code.
6. **#85 legal pages + consent** — needed before a real customer, and #105 depends on the same copy.

**Explicitly later:** billing (#10 → #107), readings tier chain, storage (#81), realtime (#83),
storage/observability polish (#88, #89, #90), `users.plan` removal (#93).

---

## What I verified vs assumed

- Verified by repo inspection: every "unbuilt" row (file absence), #74/#75 partial coverage (CI steps
  and migrate.yml gates read directly), and the merged-PR mapping (parsed `Closes #N` from PR bodies).
- Verified by GitHub API: 57 open, label counts, the 9 `status:blocked` set.
- **Not verified:** whether #74's immutability check and #75's advisory lock exist in `db-run.ts` /
  `migrate.yml` — I read the workflow but not every script path. Both need a directory-level check
  before being closed, which is why they are in §4 rather than marked done.
