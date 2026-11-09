# Production migration gate (solo operation)

## The constraint

This repository has **one human maintainer**. Other actors (AI agents) authenticate with that
same account, so they cannot act as an independent reviewer — an approval from them is the
maintainer approving their own work.

That rules out the obvious control: **GitHub Environment required reviewers**. With a single
account it either requires self-approval (no risk reduction) or blocks every production
migration permanently. Both Environments therefore correctly report `rules: 0, policy: null`.
Turning reviewers on is not an improvement here; it is a deadlock.

## What replaces a second pair of eyes

Two review steps that do not depend on a second person:

1. **A human reads the diff.** `drizzle/*.sql` changes are reviewed in the promotion PR the
   same way code is. Nothing in this gate substitutes for that; it only ensures the *thing
   being reviewed* is the thing that runs.
2. **A rehearsal on staging.** Production receives no migration that staging has not already
   executed successfully against a real Neon branch.

Step 2 is mechanised, because it is the part that can be. Every clause below **fails closed**:
no DDL executes unless all of them hold.

## The gate (enforced in `.github/workflows/migrate.yml`)

The `Gate — production preconditions` step runs only for `env=production && mode=migrate &&
dry_run=false`, and immediately precedes the first statement that can change a database.

| # | Clause | Failure mode it removes |
|---|---|---|
| 1 | `rehearsal_pr` must be supplied and numeric | dispatching production with no record of what was rehearsed |
| 2 | that PR must be `OPEN` or `MERGED` | citing a rehearsal that never reached staging |
| 3 | a **successful** `migrate staging pr-<n>` run must exist | production becoming the first place a migration ever runs |
| 4 | the dispatch `sha` must equal that PR's head SHA | rehearsing one commit and shipping another |
| 5 | `sha` must be a full 40-character SHA | migrating a moving branch tip |

Additionally, outside the gate:

- `Guard the connection string` rejects a pooled (`-pooler`) host or loopback, for both
  environments, before any statement runs.
- `db-run.ts` independently rejects pooled hosts and environment/loopback mismatches.
- `scripts/db-remote.ts` refuses `--env production` for a PR whose base branch is `staging`,
  and refuses to dispatch a production `migrate` without `--rehearsal-pr`.

The `production` GitHub Environment is still a real boundary for **secret isolation**: its
`DATABASE_URL` is only reachable by a job declaring `environment: production`. Keep it that way.

## The procedure

```bash
# 1. rehearse on staging — this is the green run the gate looks for
npx tsx scripts/db-remote.ts --pr 97                       # env inferred: staging
#    → run-name: migrate staging pr-97 <sha>   (must conclude success)

# 2. promote to main (ADR 004: staging → main uses --merge)
#    production migration happens on the promotion PR's head = the staging tip

# 3. production, citing the rehearsal
npx tsx scripts/db-remote.ts --pr <promotion-pr> --env production --rehearsal-pr 97

# 4. confirm
npx tsx scripts/db-remote.ts --check --env production
```

Step 4 must report `OK production schema and drizzle journal are in sync`.

## Fresh-workflow rehearsal after both PRs merge

The first staging run using #118's older workflow cannot satisfy #120's artifact requirement. After #118 and #120 are both merged, rehearse again with the updated workflow:

1. Open the promotion PR (`staging → main`) and freeze its full head SHA.
2. Manually dispatch `migrate.yml` for `env=staging`, `pr=<promotion-pr>`, `sha=<full promotion SHA>`, `mode=migrate`, `dry_run=false`.
3. Confirm the run name contains the exact SHA and `mode=migrate dry=false`, and uploads `migration-applied.json`.
4. Supply that same promotion PR and SHA to the production gate.

The marker is necessary but not sufficient: a migrate run can report “nothing to do”. Preserve the original migration log and inspect the schema verdict; do not treat the marker alone as proof that DDL ran in that run.

## What is still not covered

- **No independent review of intent.** The gate proves a migration ran elsewhere first; it
  cannot prove the change is correct. A destructive statement that also ran on staging passes.
  Mitigation: read the `.sql`, and keep a Neon branch/snapshot before step 3.
- **A leaked credential defeats every clause.** The gate constrains the *pipeline*, not a
  shell that exports the production URL directly. That is why `DATABASE_URL` for production
  lives only in the Environment and is never written to `.env.production`, a laptop, or Vercel.
- **No rollback.** Migrations are forward-only. Recovery is a Neon branch restore or the
  documented down-migration, decided by a human.

## If a second human ever joins

Turn on required reviewers for `production` and keep this gate: they compose cleanly, and the
gate then covers the window between approval and dispatch (a rebuilt branch, a moved tag).
