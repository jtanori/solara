#!/usr/bin/env bash
set -euo pipefail

# Manual deploy — merges a PR to its target (staging → Preview solara-stg, main → Production solara-production)
# and, if drizzle migrations changed, runs them via GitHub Actions *before* merge (no local DATABASE_URL needed).
#
# Usage:
#   ./scripts/deploy.sh --pr 43 --env staging          # env optional — inferred from PR base
#   ./scripts/deploy.sh --pr 44 --env production --yes
#   ./scripts/deploy.sh --pr 43 --skip-migrate
#
# Prereqs: gh auth login, GitHub Environments 'staging'/'production' with secret DATABASE_URL (Neon DIRECT, no -pooler, with ?sslmode=verify-full&channel_binding=require)
# Merge policy (see ADR 004): feature → staging uses --squash (linear), promotion staging→main uses --merge (preserve ancestry).
# Repo needs allow_squash_merge:true + allow_merge_commit:true (Settings → General → Pull Requests).

PR=""
ENV=""
SKIP_MIGRATE=false
YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR="$2"; shift 2;;
    --pr=*) PR="${1#*=}"; shift;;
    --env) ENV="$2"; shift 2;;
    --env=*) ENV="${1#*=}"; shift;;
    --skip-migrate) SKIP_MIGRATE=true; shift;;
    --yes|-y) YES=true; shift;;
    -h|--help) sed -n '1,130p' "$0"; exit 0;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

if [[ -z "$PR" ]]; then echo "ERROR: --pr <number> required" >&2; exit 2; fi
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then echo "ERROR: --pr must be numeric, got '$PR'" >&2; exit 2; fi

echo "== deploy PR #$PR =="

BASE=$(gh pr view "$PR" --repo jtanori/solara --json baseRefName --jq .baseRefName)
HEAD_SHA=$(gh pr view "$PR" --repo jtanori/solara --json headRefOid --jq .headRefOid)
HEAD_REF=$(gh pr view "$PR" --repo jtanori/solara --json headRefName --jq .headRefName)
echo "PR base: $BASE head: $HEAD_SHA ($HEAD_REF)"

if [[ -z "$ENV" ]]; then
  case "$BASE" in
    staging) ENV="staging" ;;
    main) ENV="production" ;;
    *) echo "ERROR: cannot infer --env from base '$BASE', pass --env staging|production" >&2; exit 2;;
  esac
fi
if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then echo "ERROR: --env must be staging or production" >&2; exit 2; fi

# Validate env matches PR base — prevents prod DB migration on staging PR (blocker 2)
if [[ "$BASE" == "staging" && "$ENV" != "staging" ]]; then
  echo "ERROR: PR #$PR targets staging but --env $ENV requested — aborting (mismatch)" >&2; exit 1
fi
if [[ "$BASE" == "main" && "$ENV" != "production" ]]; then
  echo "ERROR: PR #$PR targets main but --env $ENV requested — use --env production" >&2; exit 1
fi
# (Production promotion no longer blocked — ADR 004: staging→main uses --merge to preserve ancestry)

if [[ "$ENV" == "staging" ]]; then WORKFLOW_ENV="staging"; BASE_BRANCH="staging"; APP_URL="https://solara-stg.vercel.app"
else WORKFLOW_ENV="production"; BASE_BRANCH="main"; APP_URL="https://solara-production.vercel.app"; fi

echo "== Gate: base freshness =="
# The PR head must contain the current base tip. A moved base means the merge is either
# conflicted (obvious) or clean-but-untested (insidious: CI verified each side, never the
# combination — GitHub signals this as mergeStateStatus BEHIND, and it must not ride to a
# squash unreviewed). Trial-merge in memory with `git merge-tree --write-tree`: nothing
# touches the working tree or index; exit 0 = clean, 1 = conflicts, >1 = fatal git error.
# Deliberately no override flag: the rulesets (strict required status checks, no bypass
# actors) reject merging a BEHIND PR anyway, and a bypass here would only dispatch
# migrations before a merge GitHub then refuses.
if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  echo "ERROR: shallow clone — merge-base and the trial merge need full history; use a full clone or 'git fetch --unshallow' first" >&2
  exit 1
fi
# Explicit refspecs, not bare branch names: `git fetch origin <branch>` only writes FETCH_HEAD,
# so narrow-refspec checkouts either crash on origin/$BASE_BRANCH or silently use a stale
# tracking ref. refs/pull/$PR/head also resolves forked or deleted head branches.
git fetch origin "+refs/heads/$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" "refs/pull/$PR/head" --quiet
if ! git cat-file -e "$HEAD_SHA" 2>/dev/null; then
  echo "ERROR: PR head $HEAD_SHA not found after fetching refs/pull/$PR/head — is the branch pushed?" >&2; exit 1
fi
BASE_SHA=$(git rev-parse "origin/$BASE_BRANCH")
ANC_RC=0
git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA" || ANC_RC=$?
if [[ "$ANC_RC" -eq 0 ]]; then
  echo "Base fresh: $HEAD_REF contains $BASE_BRANCH@${BASE_SHA:0:7}"
elif [[ "$ANC_RC" -eq 1 ]]; then
  BEHIND=$(git rev-list --count "$HEAD_SHA..$BASE_SHA")
  echo "WARN: $BASE_BRANCH moved $BEHIND commit(s) since $HEAD_REF last merged it in:"
  git log -n 5 --oneline --no-decorate "$HEAD_SHA..$BASE_SHA" | sed 's/^/    /'
  if [[ "$BEHIND" -gt 5 ]]; then echo "    ... and $((BEHIND - 5)) more"; fi
  MERGE_RC=0
  MERGE_OUT=$(git merge-tree --write-tree --name-only --no-messages "$HEAD_SHA" "$BASE_SHA" 2>&1) || MERGE_RC=$?
  if [[ "$MERGE_RC" -eq 0 ]]; then
    VERDICT="conflict-free"
    DETAIL="the combined tree has NOT been tested by CI (each side was)"
  elif [[ "$MERGE_RC" -eq 1 ]]; then
    VERDICT="CONFLICTED"
    DETAIL="merging would conflict in these files:"
  else
    echo "ERROR: trial merge failed (git merge-tree exit $MERGE_RC): $MERGE_OUT" >&2
    exit 1
  fi
  echo "Trial merge (in memory, nothing touched): $VERDICT — $DETAIL"
  if [[ "$VERDICT" == "CONFLICTED" ]]; then
    printf '%s
' "$MERGE_OUT" | sed -n '2,11s/^/    /p'
  fi
  echo "Recovery: git fetch origin && git switch $HEAD_REF && git merge origin/$BASE_BRANCH && git push"
  echo "          then wait for the verify job on the new head and re-run this script."
  echo "ERROR: refusing to deploy a $VERDICT stale PR — update the branch first." >&2
  exit 1
else
  echo "ERROR: git merge-base --is-ancestor failed (exit $ANC_RC) — are both refs valid commits? fetch full history and retry" >&2
  exit 1
fi

echo "== Gate: CI checks =="
gh pr checks "$PR" --repo jtanori/solara --watch 2>&1 | tail -20 || true
MSTS=$(gh pr view "$PR" --repo jtanori/solara --json mergeStateStatus,mergeable --jq '"\(.mergeStateStatus) \(.mergeable)"')
echo "Post-check: $MSTS"
if [[ "$MSTS" != *"CLEAN"* ]]; then
  echo "ERROR: PR #$PR is $MSTS, not CLEAN — fix CI first" >&2; exit 1
fi

echo "== Detect migrations =="
git fetch origin "+refs/heads/$BASE_BRANCH:refs/remotes/origin/$BASE_BRANCH" --quiet
BASE_SHA=$(git rev-parse "origin/$BASE_BRANCH")
echo "Head $HEAD_SHA vs base origin/$BASE_BRANCH $BASE_SHA"
NEEDS_MIGRATE=false
if ! git diff --name-only "$BASE_SHA...$HEAD_SHA" >/dev/null 2>&1; then
  echo "ERROR: could not diff $HEAD_SHA against $BASE_SHA — are both refs fetched?" >&2; exit 1
fi
if git diff --name-only "$BASE_SHA...$HEAD_SHA" | grep -qE '^drizzle/'; then
  NEEDS_MIGRATE=true
  echo "Migrations changed:"
  git diff --name-only "$BASE_SHA...$HEAD_SHA" | grep -E '^drizzle/' || true
else
  echo "No drizzle/ changes — migrations not needed."
fi
if [[ "$NEEDS_MIGRATE" == true && "$SKIP_MIGRATE" == true ]]; then NEEDS_MIGRATE=false; echo "WARN: --skip-migrate set"; fi

if [[ "$NEEDS_MIGRATE" == true ]]; then
  echo ""
  echo ">> PR touches drizzle — will run .github/workflows/migrate.yml via GitHub Environment '$WORKFLOW_ENV' BEFORE merge."
  echo ">> Checkout SHA $HEAD_SHA (PR head, not base branch) so new drizzle/*.sql is included."
  if [[ "$YES" != true ]]; then read -rp "Trigger migrate workflow for $WORKFLOW_ENV (pr #$PR, sha $HEAD_SHA)? [y/N] " ans; if [[ "$ans" != "y" && "$ans" != "Y" ]]; then echo "Aborted."; exit 1; fi; fi
  if ! git cat-file -e "$HEAD_SHA:.github/workflows/migrate.yml" 2>/dev/null; then
    echo "ERROR: .github/workflows/migrate.yml not found on PR head $HEAD_SHA — push it first" >&2; exit 1
  fi
  echo "Triggering workflow (ref=$HEAD_REF sha=$HEAD_SHA)..."
  BEFORE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run migrate.yml --repo jtanori/solara --ref "$HEAD_REF" -f env="$WORKFLOW_ENV" -f pr="$PR" -f sha="$HEAD_SHA" || { echo "ERROR: could not trigger migrate.yml" >&2; exit 1; }
  echo "Workflow dispatched. Waiting for run (run-name: migrate $WORKFLOW_ENV pr-$PR $HEAD_SHA)..."
  sleep 5
  # Poll for run with matching sha/env/pr and createdAt after dispatch — avoids picking stale run.
  # Use shell interpolation into jq (gh's --jq does not support --arg); PR numeric and SHA hex are safe.
  RUN_ID=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    RUN_ID=$(gh run list --workflow=migrate.yml --repo jtanori/solara --limit 20 --json databaseId,displayTitle,createdAt --jq "[.[] | select(.displayTitle | contains(\"$HEAD_SHA\") and contains(\"$WORKFLOW_ENV\") and contains(\"$PR\")) | select(.createdAt > \"$BEFORE\") | .databaseId] | first // empty")
    if [[ -n "$RUN_ID" ]]; then break; fi
    sleep 3
  done
  if [[ -z "$RUN_ID" ]]; then
    RUN_ID=$(gh run list --workflow=migrate.yml --repo jtanori/solara --limit 10 --json databaseId,displayTitle --jq "[.[] | select(.displayTitle | contains(\"$HEAD_SHA\")) | .databaseId] | first // empty")
  fi
  if [[ -z "$RUN_ID" ]]; then echo "ERROR: no migrate run found for sha $HEAD_SHA" >&2; exit 1; fi
  echo "Watching run $RUN_ID..."
  gh run watch "$RUN_ID" --repo jtanori/solara 2>&1 | tail -30
  CONCLUSION=$(gh run view "$RUN_ID" --repo jtanori/solara --json conclusion --jq .conclusion)
  if [[ "$CONCLUSION" != "success" ]]; then echo "ERROR: migrate workflow $RUN_ID $CONCLUSION — gh run view $RUN_ID --log" >&2; exit 1; fi
  echo "✅ Migrations complete for $WORKFLOW_ENV (run $RUN_ID, sha $HEAD_SHA)"
else echo "Skipping remote migrate step."; fi

echo ""
echo "== Merge PR #$PR → $BASE_BRANCH ($ENV) =="
# Merge policy: squash for feature→staging, merge commit for staging→main (ADR 004 — preserve ancestry)
if [[ "$BASE" == "main" ]]; then
  MERGE_ARGS="--merge"
  MERGE_LABEL="merge (preserve ancestry — see ADR 004)"
  # Guard: repo must allow merge commits for promotions
  SETTINGS=$(gh api repos/jtanori/solara --jq '{allow_merge_commit}' 2>/dev/null || echo '{"allow_merge_commit":false}')
  if [[ "$SETTINGS" == *'"allow_merge_commit":false'* || "$SETTINGS" == *'"allow_merge_commit": false'* ]]; then
    echo "ERROR: Repo is squash-only (allow_merge_commit:false) but staging→main requires merge commits (ADR 004)." >&2
    echo "Fix: Settings → General → Pull Requests → check 'Allow merge commits' (keep squash + auto-delete)." >&2
    echo "Verify: gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'" >&2
    exit 1
  fi
else
  MERGE_ARGS="--squash"
  MERGE_LABEL="squash (one commit per feature)"
fi
echo "Policy: $MERGE_LABEL — see AGENTS.md & ADR 004."
if [[ "$YES" != true ]]; then read -rp "Merge PR #$PR to $BASE_BRANCH ($MERGE_LABEL)? [y/N] " ans; if [[ "$ans" != "y" && "$ans" != "Y" ]]; then echo "Aborted."; exit 1; fi; fi
gh pr merge "$PR" $MERGE_ARGS --repo jtanori/solara
echo "Merged PR #$PR → $BASE_BRANCH ($MERGE_LABEL)"
echo "Waiting 30s for Vercel $APP_URL ..."
sleep 30
if curl -fsS "$APP_URL/api/health" | grep -q '"ok":true'; then echo "✅ $APP_URL/api/health → {\"ok\":true}"; else echo "WARN: $APP_URL/api/health not yet ok — check Vercel Deployments"; curl -i "$APP_URL/api/health" 2>&1 | head -20 || true; fi
echo "Done. Verify sign-in, map, PDF gate, staging Stripe test webhook before promoting."
