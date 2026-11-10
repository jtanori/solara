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
| 3 | a **successful, non-dry-run** `migrate staging pr-<rehearsal_pr> <full-sha> mode=migrate dry=false` run must exist | production becoming the first place a migration runs, or a verify/dry-run being mistaken for DDL |
| 4 | the dispatch `sha` must equal that PR's head SHA and appear in the staging run name | rehearsing one commit and shipping another |
| 5 | `sha` must be a full 40-character SHA | migrating a moving branch tip |
| 6 | the staging run must contain `migration-applied.json` with matching env/SHA/mode/dryRun=false | a green workflow that only ran `verify` or a dry run |

The marker is necessary but not sufficient. A `migrate` run can report “nothing to do”, so
preserve the original migration log and inspect the schema verdict. A marker by itself is not
proof that DDL ran in that run.

### Workflow token permissions

The production gate runs inside Actions with `GITHUB_TOKEN`. `migrate.yml` grants:

- `contents: read` — checkout the exact SHA,
- `actions: read` — list workflow runs and download the staging verdict artifact,
- `pull-requests: read` — the `gh pr view` checks for PR state and head SHA.

A missing `pull-requests: read` makes the gate fail with `403 Resource not accessible by
integration` before any DDL. The manual staging preflight runs with the operator's `gh` token,
not `GITHUB_TOKEN`, so its permissions are separate.

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
set -euo pipefail

# 1. open the promotion PR (staging -> main) and freeze its head ref and exact SHA
PROMO_PR=<promotion-pr>
META=$(gh pr view "$PROMO_PR" --repo jtanori/solara \
  --json headRefName,headRefOid \
  --jq '[.headRefName, .headRefOid] | @tsv')
IFS=$'\t' read -r PROMO_REF PROMO_SHA <<< "$META"

[[ -n "$PROMO_REF" ]] || { echo "ERROR: promotion PR has no head branch"; exit 1; }
[[ "$PROMO_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "ERROR: promotion SHA is not 40 lowercase hex characters: $PROMO_SHA"
  exit 1
}

# 2. confirm the selected ref contains the updated workflow definition.
#    --ref selects the workflow file version; sha selects the exact migration checkout.
#    Do not rely on the default branch: main is unsuitable until #120 is promoted there.
WF=$(mktemp)
gh api "repos/jtanori/solara/contents/.github/workflows/migrate.yml?ref=$PROMO_REF" \
  -H "Accept: application/vnd.github.raw" > "$WF"

grep -Eq '^[[:space:]]+mode:[[:space:]]*$' "$WF" || {
  echo "ERROR: workflow at $PROMO_REF has no mode input"; rm -f "$WF"; exit 1;
}
grep -Eq '^[[:space:]]+dry_run:[[:space:]]*$' "$WF" || {
  echo "ERROR: workflow at $PROMO_REF has no dry_run input"; rm -f "$WF"; exit 1;
}
for marker in \
  'mode=${{ inputs.mode }}' \
  'dry=${{ inputs.dry_run }}' \
  'migration-applied.json' \
  'mode=migrate' \
  'dry=false'
do
  grep -Fq -- "$marker" "$WF" || {
    echo "ERROR: workflow at $PROMO_REF lacks required marker: $marker"
    rm -f "$WF"
    exit 1
  }
done
rm -f "$WF"

# This is a version-presence check, not proof that the gate behaves correctly.
# The reviewed workflow and CI are the behavioral assurance.

# 3. recheck the frozen values after the preflight, immediately before dispatch.
#    If the PR head moved, stop and rehearse the new SHA instead of dispatching stale evidence.
CURRENT=$(gh pr view "$PROMO_PR" --repo jtanori/solara \
  --json headRefName,headRefOid \
  --jq '[.headRefName, .headRefOid] | @tsv')
IFS=$'\t' read -r CURRENT_REF CURRENT_SHA <<< "$CURRENT"
if [[ "$CURRENT_REF" != "$PROMO_REF" || "$CURRENT_SHA" != "$PROMO_SHA" ]]; then
  echo "ERROR: promotion PR head moved from $PROMO_REF@$PROMO_SHA to $CURRENT_REF@$CURRENT_SHA"
  echo "Freeze and rehearse the new SHA instead of dispatching a stale one."
  exit 1
fi

# 4. rehearse that promotion PR on staging with the updated workflow.
#    db-remote.ts --pr <promotion-pr> infers production, so dispatch the staging run manually.
gh workflow run migrate.yml --repo jtanori/solara \
  --ref "$PROMO_REF" \
  -f env=staging -f pr="$PROMO_PR" -f sha="$PROMO_SHA" \
  -f mode=migrate -f dry_run=false

#    Verify the run name is:
#    migrate staging pr-<promotion-pr> <PROMO_SHA> mode=migrate dry=false
#    and the schema-verdict artifact contains migration-applied.json for that env/SHA/mode.

# 5. production, citing the same promotion PR as the rehearsal
npx tsx scripts/db-remote.ts --pr "$PROMO_PR" --env production --rehearsal-pr "$PROMO_PR"

# 6. confirm the production schema and journal
npx tsx scripts/db-remote.ts --check --env production

# 7. after the deploy, require readiness (DB/schema/migrations/auth)
#    deploy.sh first waits for Vercel's status on the merge SHA; then it polls /api/ready.
#    Protected Vercel domains need VERCEL_AUTOMATION_BYPASS_SECRET.
curl -fsS -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  "https://solara-production.vercel.app/api/ready"
```

Step 6 must report `OK production schema and drizzle journal are in sync`. Step 7 must report
`/api/ready -> {"ok":true}`; a 401/403 means deployment protection blocked the check and the
deploy fails closed. See the readiness failure-mode table in
[`docs/setup/01-foundation-and-deployment.md`](../setup/01-foundation-and-deployment.md#readiness-failure-modes)
for the first action for each response.

## What is still not covered

- **No independent review of intent.** The gate proves a migration ran elsewhere first; it
  cannot prove the change is correct. A destructive statement that also ran on staging passes.
  Mitigation: read the `.sql`, and keep a Neon branch/snapshot before step 3.
- **A leaked credential defeats every clause.** The gate constrains the *pipeline*, not a
  shell that exports the production URL directly. That is why `DATABASE_URL` for production
  lives only in the Environment and is never written to `.env.production`, a laptop, or Vercel.
- **No automatic schema rollback.** Migrations are forward-only (ADR 008). Recovery is code
  rollback when schema-compatible, a forward fix, or a Neon branch restore, decided by a human.

## If a second human ever joins

Turn on required reviewers for `production` and keep this gate: they compose cleanly, and the
gate then covers the window between approval and dispatch (a rebuilt branch, a moved tag).
