## Summary

Promotes `staging` to `main`. **16 commits, 196 files, +19,657 / −254.**

Everything since the last promotion on 2026-11-07: auth hardening (#118), Placidus + chart v2
(#121, #122), the readiness/drift/ADR block (#126), password reset + request logging + `/api/places`
hardening + DB pool (#125), base-freshness gating in `deploy.sh` (#124), pooled-Neon readiness
(#130), and the readings generation pipeline (#127).

**The readings pipeline ships dark.** `READINGS_GENERATION_ENABLED` defaults to `false` and
`PROVIDERS` contains only `fixture`, so no generation, no provider spend and no consent requirement
is live after this merge. #105 remains the gate before it can be switched on.

## Linked issue

This promotion closes the following **only once their code is confirmed live on production**:

`Closes #53, #54, #55, #56, #57, #60, #64, #70, #72, #78, #84, #87, #103, #119`

Already fixed on `staging` and closing here: `#101, #102, #117`.

Deliberately **not** closed: #57 remains open pending the CSP observation window; #58 (staff MFA)
and #62 (restore drill) are launch gates not covered by this diff; #52 stays closed as previously
resolved (staging only — production provisioning is this PR's step 4).

## Branching and merge policy

- [x] `staging → main`, **merge commit** (`--merge`), per ADR 004 — squash would break ancestry.
- [x] Base-freshness gate satisfied: a prerequisite back-merge (`chore/promote-sync-main`) restored
      `main` as an ancestor of `staging`. `main` had nothing `staging` lacked — the trial merge tree
      was byte-identical to `staging`, so that back-merge changed zero files.
- [x] Head SHA is frozen and does not move after this PR opens; the staging rehearsal and the
      production migration both cite this exact SHA.

## Risk — read this part

### Migrations (four, all additive)

| Migration | Contents | Risk |
|---|---|---|
| `0000_initial` | 7 base tables | **first apply on production** |
| `0001_rate_limits` | `rate_limits` + index | low |
| `0002_email_verification` | `email_tokens` + index, nullable `users.email_verified_at`, **plus two `DELETE`s** | **high — see below** |
| `0003_readings_documents_generation_cache` | `generation_cache`, `reading_documents` + unique index | low |

No table, column or index is dropped anywhere in this diff (`git diff --diff-filter=D` is empty).

**`0002` deletes every session.** It adds `users.email_verified_at` and then deletes sessions where
that column `IS NULL` — which, at apply time, is *every* existing user. Combined with the new
`isNotNull(users.emailVerifiedAt)` in the session lookup, pre-existing accounts are logged out and
must complete email verification to return.

On **staging this already happened** and is accepted. On **production this is the first migration**,
so it is a policy decision rather than a technical one. Production accounts are prototype/test data
under ADR 005, so the likely answer is "acceptable" — but it must be a recorded choice. If it is
not acceptable, the mitigation is `UPDATE "users" SET "email_verified_at" = now();` between
migration and deploy, which is a data change needing explicit sign-off.

Full analysis and the exact sequence: **`docs/operations/promotion-2026-11-10.md`**.

### Production has never been migrated

All 11 `migrate` runs in repository history are staging. The last production attempt was the #52
incident, which was resolved by provisioning *staging only*. So step 4 of the runbook creates the
**entire schema**, not three new migrations, and production currently has **no error tracking**
(#77 is open) — a failure is found by a user report, exactly as #52 was.

### Environment prerequisites

`MAIL_TRANSPORT` + `MAIL_FROM` + (`RESEND_API_KEY` or `POSTMARK_SERVER_TOKEN`) must be set in
production before merge, or existing accounts locked out by the `DELETE` above have no self-service
recovery. Stripe keys/prices are also required. `node scripts/check-setup.mjs production --strict`
is the check.

## Rollout / Rollback

Order (from `docs/operations/production-migration-gate.md`, unchanged):

1. Back-merge `main → staging` (prerequisite; already proposed separately).
2. Freeze this PR's head SHA.
3. **Staging rehearsal** — `migrate staging pr-<this> <SHA> mode=migrate dry=false`; the run name
   and `migration-applied.json` artifact are what the production gate cites.
4. **Production migrate** — `db-remote --env production --rehearsal-pr <this>`. Gates 1–6 fail closed.
5. **Production schema check** — must print `OK production schema and drizzle journal are in sync`.
6. **Deploy** — `deploy.sh --merge`, waits on Vercel for the merge SHA, then requires
   `/api/ready -> {"ok":true}`.
7. Verify sign-up / sign-in / verify-email / reset by hand. `/api/ready` checks schema only; it
   cannot prove HAZARD A resolved.

**Rollback:** code rolls back to `4490ced` if the schema stays compatible — it will not be, because
the old build reads `users` without the verification predicate. Schema rollback is a forward fix or
a Neon point-in-time restore (ADR 008), never a down migration. Take a Neon snapshot before step 4.

## Evidence

- [x] `verify` green on `staging@750a272` and on `main@4490ced` (repo status API: both `success`)
- [x] Migration SQL, journal (`0000→0003`) and `drizzle/meta` reviewed; manifest lists all four tags
- [x] `git diff --diff-filter=D --name-only origin/main origin/staging` → empty (no deletions)
- [x] `git diff --stat origin/staging...origin/main` → empty (`main` adds nothing)
- [x] `git merge-tree --write-tree origin/staging origin/main` → tree identical to `origin/staging^{tree}`
- [x] Base-freshness replay: `merge-base --is-ancestor origin/main origin/staging` → exit 1
      (this is *why* the back-merge lands first)
- [x] `migrate.yml` at this ref contains `mode`, `dry_run`, `migration-applied.json`,
      `mode=migrate`, `dry=false` — all five marker greps from the gate procedure pass
- [x] Only new runtime dependency: `zod@4.6.7`

**Not claimed:** I did not run `tsc`/`eslint`/the test suite locally — `tsx` is not installed in
this environment (`npm run db:manifest:check` fails with `tsx: not found`). CI `verify` is the
evidence for those, and it is green on this SHA.

## Deviations

None from the migration-gate procedure. Two operational caveats are recorded in the runbook rather
than worked around: Vercel is unreachable from the preparation environment, and the GitHub
Environments intentionally remain at `protection_rules: 0` for a single-maintainer repo — per
`production-migration-gate.md` §"The constraint", turning reviewers on here is a deadlock, not an
improvement.
