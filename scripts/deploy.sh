#!/usr/bin/env bash
set -euo pipefail

# Manual deploy — merges a PR to its target (staging → Preview solara-stg, main → Production solara-production)
# and, if drizzle migrations changed, runs them via GitHub Actions *before* merge (no local DATABASE_URL needed).
#
# Usage:
#   ./scripts/deploy.sh --pr 43 --env staging          # env optional — inferred from PR base
#   ./scripts/deploy.sh --pr 44 --env production --yes
#   ./scripts/deploy.sh --pr 43 --skip-migrate --force   # staging only; refused for production
#
# Gates, in order: base freshness (the PR head must contain the base tip) → preview readiness (the
# PR's own Vercel preview must answer /api/ready with ok:true, BEFORE merging) → CI checks →
# hosted schema → merge → Vercel status on the merge SHA → /api/ready on the environment URL.
# A failure after the merge rolls production back automatically; staging recovers manually because
# Vercel Instant Rollback only moves the production alias.
#
# Prereqs: gh auth login, GitHub Environments 'staging'/'production' with secret DATABASE_URL (Neon DIRECT, no -pooler, with ?sslmode=verify-full&channel_binding=require),
# and VERCEL_AUTOMATION_BYPASS_SECRET when the Vercel domain is protected (hard-fails on 401/403).
# Merge policy (see ADR 004): feature → staging uses --squash (linear), promotion staging→main uses --merge (preserve ancestry).
# Repo needs allow_squash_merge:true + allow_merge_commit:true (Settings → General → Pull Requests).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/wait-for-vercel-status.sh
source "$SCRIPT_DIR/lib/wait-for-vercel-status.sh"
# shellcheck source=lib/vercel-rollback.sh
source "$SCRIPT_DIR/lib/vercel-rollback.sh"
# shellcheck source=lib/deploy-policy.sh
source "$SCRIPT_DIR/lib/deploy-policy.sh"
# shellcheck source=lib/vercel-preview.sh
source "$SCRIPT_DIR/lib/vercel-preview.sh"

PR=""
ENV=""
SKIP_MIGRATE=false
FORCE=false
YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR="$2"; shift 2;;
    --pr=*) PR="${1#*=}"; shift;;
    --env) ENV="$2"; shift 2;;
    --env=*) ENV="${1#*=}"; shift;;
    --skip-migrate) SKIP_MIGRATE=true; shift;;
    --force) FORCE=true; shift;;
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
  if [[ "$BASE_BRANCH" == "main" ]]; then
    # For a promotion this gate IS the ancestry check: the head must contain main's commits, and
    # `--is-ancestor` is the only test that proves it. A back-merge does that; a squash does not,
    # which is the trap in the runbooks (bootstrap §4.1a). Say so here, where it actually fails.
    echo "" >&2
    echo "       This is a staging→main promotion, so this gate is the ancestry check." >&2
    echo "       A squash back-merge does NOT satisfy it: the content lands, main's SHAs do not." >&2
    MAIN_GAP=$(git log --format=%H --cherry-pick --left-only origin/main..."$HEAD_SHA" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "${MAIN_GAP:-1}" == "0" ]]; then
      echo "       main's content is already on $HEAD_REF under different SHAs." >&2
      echo "       Litmus: git merge-base --is-ancestor origin/main origin/$HEAD_REF" >&2
      echo "       Only a merge into $HEAD_REF makes that succeed; see bootstrap §4.1a." >&2
    else
      echo "       main carries ${MAIN_GAP:-some} change(s) $HEAD_REF does not have — back-merge them." >&2
      git log --oneline --cherry-pick --left-only origin/main..."$HEAD_SHA" 2>/dev/null | sed -n '1,10s/^/         /p' >&2
    fi
    echo "" >&2
  fi
  echo "ERROR: refusing to deploy a $VERDICT stale PR — update the branch first." >&2
  exit 1
else
  echo "ERROR: git merge-base --is-ancestor failed (exit $ANC_RC) — are both refs valid commits? fetch full history and retry" >&2
  exit 1
fi

echo "== Gate: preview readiness ($HEAD_REF) =="
# #76 acceptance criterion 1: a deliberately broken preview must block the merge. This has to run
# BEFORE `gh pr merge`; the post-merge probe cannot satisfy it, because by then the code is on the
# target branch. Fail closed: "I could not find the preview" is not "the preview is fine".
PREVIEW_STATUS_JSON=$(gh api "repos/jtanori/solara/commits/$HEAD_SHA/status" 2>/dev/null || true)
PREVIEW_STATUS_ROW=$(printf '%s' "$PREVIEW_STATUS_JSON" | node scripts/lib/vercel-status.mjs "${VERCEL_STATUS_CONTEXT:-Vercel}" 2>/dev/null || true)
PREVIEW_STATE="${PREVIEW_STATUS_ROW%%$'\t'*}"
PREVIEW_STATUS_URL="${PREVIEW_STATUS_ROW#*$'\t'}"
if [[ -z "$PREVIEW_STATUS_ROW" || "$PREVIEW_STATE" != "success" ]]; then
  echo "ERROR: no successful Vercel preview status on $HEAD_SHA (state: ${PREVIEW_STATE:-none})." >&2
  echo "       Wait for the preview build, or check the Vercel dashboard, then re-run." >&2
  exit 1
fi
PREVIEW_BASE=""
if ! PREVIEW_BASE=$(vercel_preview_url "$PREVIEW_STATUS_URL" "$HEAD_REF" "${VERCEL_TEAM_ID:-}"); then
  echo "ERROR: $PREVIEW_BASE" >&2
  echo "       Cannot verify the preview, so refusing to merge (fail closed)." >&2
  exit 1
fi
echo "Preview: $PREVIEW_BASE (from $PREVIEW_STATUS_URL)"
PREVIEW_TMP="$(mktemp)"
CLEANUP_FILES=("$PREVIEW_TMP")
cleanup() { local f; for f in "${CLEANUP_FILES[@]:-}"; do [[ -n "$f" ]] && rm -f "$f"; done; }
trap cleanup EXIT
if ! PREVIEW_CODE=$(vercel_preview_ready "$PREVIEW_BASE" "${PREVIEW_ATTEMPTS:-12}" "${PREVIEW_INTERVAL:-5}" "$PREVIEW_TMP"); then
  echo "ERROR: $PREVIEW_BASE/api/ready did not report ok:true (last HTTP ${PREVIEW_CODE:-none})." >&2
  if [[ "$PREVIEW_CODE" == "401" || "$PREVIEW_CODE" == "403" ]]; then
    echo "       The preview is behind Vercel Authentication: set VERCEL_AUTOMATION_BYPASS_SECRET." >&2
  else
    sed -n '1,20p' "$PREVIEW_TMP" >&2 || true
  fi
  echo "       A broken preview blocks the merge (#76). Fix it and push again." >&2
  exit 1
fi
echo "Preview ready: $PREVIEW_BASE/api/ready -> ok"

echo "== Gate: CI checks =="
gh pr checks "$PR" --repo jtanori/solara --watch 2>&1 | tail -20 || true
MSTS=$(gh pr view "$PR" --repo jtanori/solara --json mergeStateStatus,mergeable --jq '"\(.mergeStateStatus) \(.mergeable)"')
echo "Post-check: $MSTS"
if [[ "$MSTS" != *"CLEAN"* ]]; then
  echo "ERROR: PR #$PR is $MSTS, not CLEAN — fix CI first" >&2; exit 1
fi

# #76 release tracking: every deploy leaves one row in DEPLOY_LOG so "what is in production?" is
# answerable without guessing. A failed write is a warning, not a deploy failure — the deploy itself
# already succeeded or failed on its own gates.
DEPLOY_LOG="${DEPLOY_LOG:-docs/deploys.md}"
DEPLOY_LOG_HEADER='| when | env | sha | pr | migrations | result | rollback |
| --- | --- | --- | --- | --- | --- | --- |'

# Where the record is *published*. A row appended to the operator's local checkout answers "what is
# deployed?" for exactly one person and exactly one machine, which is not what #76 asked for. The
# durable copy is a PR comment (readable by anyone with the repo, survives a fresh clone) plus a
# GitHub Release for production merges (the release marker #76 requires).
DEPLOY_RECORD_COMMENT_MARKER="<!-- deploy-record -->"

# The id of this PR's existing deploy-record comment, if any (a retry rewrites, never stacks).
deploy_record_comment_id() {
  local pr="$1"
  gh api "repos/jtanori/solara/issues/$pr/comments" --paginate \
    --jq ".[] | select(.body | contains(\"$DEPLOY_RECORD_COMMENT_MARKER\")) | .id" 2>/dev/null \
    | head -1 || true
}

# Args: env sha pr migrations result rollback. Escapes are done by the node renderer, so the row
# stays one table line even when a value contains a pipe.
#
# Returns non-zero when the shared record could not be published. The caller decides how loud to be;
# a deploy that succeeded must not be reported as failed because GitHub was unavailable.
record_deploy() {
  local env="$1" sha="$2" pr="$3" migrations="$4" result="$5" rollback="$6"
  local json record timestamp published=0
  timestamp="$(date -u +%Y-%m-%dT%H:%MZ)"
  json=$(node -e '
    const [env, sha, pr, migrations, result, rollback, timestamp] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ env, sha, pr, migrations, result, rollback, timestamp }));
  ' "$env" "$sha" "$pr" "$migrations" "$result" "$rollback" "$timestamp" )

  if ! record=$(node "$SCRIPT_DIR/lib/deploy-log.mjs" "$json"); then
    echo "WARN: could not render the deploy record; the deploy itself is unaffected" >&2
    return 0
  fi

  # 1. Local append-only copy (kept: cheap, greppable, works offline).
  if [[ "$DEPLOY_LOG" != "-" ]]; then
    if [[ ! -f "$DEPLOY_LOG" ]]; then
      printf '# Deploys\n\nAppend-only record written by `scripts/deploy.sh` (#76).\n\n%s\n' "$DEPLOY_LOG_HEADER" > "$DEPLOY_LOG"
    fi
    printf '%s\n' "$record" >> "$DEPLOY_LOG"
    echo "Deploy record appended to $DEPLOY_LOG"
  fi

  # 2. Shared record: one comment on the PR, rewritten in place so a retry does not stack rows.
  local body existing
  body=$(printf '%s\n### Deploy record\n\n%s\n\n%s\n\nWritten by `scripts/deploy.sh`. This comment is the shared record of what %s is running (#76).\n' \
    "$DEPLOY_RECORD_COMMENT_MARKER" "$DEPLOY_LOG_HEADER" "$record" "$env")
  existing=$(deploy_record_comment_id "$pr")
  if [[ -n "$existing" ]]; then
    if gh api -X PATCH "repos/jtanori/solara/issues/comments/$existing" -f body="$body" >/dev/null 2>&1; then
      echo "Deploy record updated on PR #$pr (comment $existing)"
      published=1
    fi
  elif gh api -X POST "repos/jtanori/solara/issues/$pr/comments" -f body="$body" >/dev/null 2>&1; then
    echo "Deploy record posted to PR #$pr"
    published=1
  fi
  if [[ "$published" -eq 0 ]]; then
    echo "WARN: could not publish the deploy record to PR #$pr — the row exists only in $DEPLOY_LOG." >&2
    echo "      Record it on the PR by hand: $record" >&2
    return 1
  fi

  # 3. Release marker. #76 requires a tag/release per production merge; staging gets a record but
  # no release, so the release list stays a list of what reached production.
  if [[ "$env" == "production" ]]; then
    local tag
    tag="deploy/production/$(date -u +%Y%m%d-%H%M)-${sha:0:7}"
    if gh api -X POST "repos/jtanori/solara/releases" \
        -f tag_name="$tag" -f target_commitish="$sha" -f name="$tag" \
        -f body="Production deploy of \`${sha:0:7}\` (PR #$pr, $timestamp). Migrations: $migrations. Verification: $result." \
        >/dev/null 2>&1; then
      echo "Release marker created: $tag"
      # The comment is already posted; append the tag so the two records agree.
      local posted_id
      posted_id=$(deploy_record_comment_id "$pr")
      [[ -n "$posted_id" ]] && gh api -X PATCH "repos/jtanori/solara/issues/comments/$posted_id" \
        -f body="$(printf '%s\n\nRelease: `%s`\n' "$body" "$tag")" >/dev/null 2>&1 || true
    else
      echo "WARN: could not create the release marker $tag — record it by hand." >&2
      return 1
    fi
  fi
  return 0
}

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
case "$(decide_skip_migrate "$NEEDS_MIGRATE" "$SKIP_MIGRATE" "$FORCE" "$ENV")" in
  refuse-production)
    echo "ERROR: --skip-migrate is refused for production." >&2
    echo "       Run the migration through .github/workflows/migrate.yml with --rehearsal-pr first," >&2
    echo "       then deploy without the flag." >&2
    exit 1
    ;;
  refuse-force)
    echo "ERROR: --skip-migrate requires --force." >&2
    echo "       It skips applying drizzle/ migrations for $WORKFLOW_ENV. Re-run with --force if that" >&2
    echo "       is intended, and record the reason in the PR." >&2
    exit 1
    ;;
  skip-forced)
    NEEDS_MIGRATE=false
    echo "WARN: --skip-migrate --force: migrations will NOT be applied to $WORKFLOW_ENV. Record the reason in the PR."
    ;;
esac

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
  MIGRATIONS_RECORD="applied ($WORKFLOW_ENV)"
else
  echo "Skipping remote migrate step."
  MIGRATIONS_RECORD="skipped"
fi

echo ""
echo "== Gate: hosted schema check ($WORKFLOW_ENV) =="
# Read-only verification against the environment database before merge. This catches a
# DB that is behind the journal even when the PR itself has no drizzle/ changes. Pin the
# checkout to HEAD_SHA; HEAD_REF only selects the workflow file version.
if ! npx tsx scripts/db-remote.ts --check --env "$WORKFLOW_ENV" --branch "$HEAD_REF" --sha "$HEAD_SHA"; then
  echo "ERROR: hosted $WORKFLOW_ENV schema is not in sync with $HEAD_SHA — refusing to merge." >&2
  exit 1
fi

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
# #76 rollback target: the deployment serving production *before* this merge. Captured only when
# the credentials to act on it exist; otherwise the failure path prints manual steps.
ROLLBACK_TARGET=""
ROLLBACK_TARGET_URL=""
# Captured for production only: the target is the current *production* deployment, so capturing it
# for a staging deploy would only ever be used to repoint production by mistake.
if [[ "$ENV" == "production" && -n "${VERCEL_TOKEN:-}" && -n "${VERCEL_PROJECT_ID:-}" ]]; then
  IFS=$'\t' read -r ROLLBACK_TARGET ROLLBACK_TARGET_URL _ <<< "$(vercel_current_production_deployment "$VERCEL_PROJECT_ID" "${VERCEL_TEAM_ID:-}")"
  [[ -n "$ROLLBACK_TARGET" ]] && echo "Rollback target captured: $ROLLBACK_TARGET${ROLLBACK_TARGET_URL:+ ($ROLLBACK_TARGET_URL)}"
elif [[ "$ENV" != "production" ]]; then
  echo "NOTE: $ENV deploy — no automatic rollback (Instant Rollback only moves production)."
else
  echo "NOTE: VERCEL_TOKEN/VERCEL_PROJECT_ID unset — automatic rollback disabled, manual steps will be printed on failure."
fi

CURRENT_HEAD=$(gh pr view "$PR" --repo jtanori/solara --json headRefOid --jq .headRefOid)
if [[ "$CURRENT_HEAD" != "$HEAD_SHA" ]]; then
  echo "ERROR: PR #$PR head moved from $HEAD_SHA to $CURRENT_HEAD after review — refusing to merge." >&2
  exit 1
fi
gh pr merge "$PR" $MERGE_ARGS --repo jtanori/solara --match-head-commit "$HEAD_SHA"
echo "Merged PR #$PR → $BASE_BRANCH ($MERGE_LABEL)"

# A readiness 200 alone does not prove the new deployment is live: the previous release
# also serves /api/ready. Wait for Vercel's status on this exact merge SHA first.
MERGE_SHA=""
for i in {1..12}; do
  MERGE_SHA=$(gh pr view "$PR" --repo jtanori/solara --json mergeCommit --jq '.mergeCommit.oid // empty' 2>/dev/null || true)
  if [[ -n "$MERGE_SHA" ]]; then break; fi
  sleep 5
done
if [[ -z "$MERGE_SHA" ]]; then
  echo "ERROR: could not resolve the merge commit for PR #$PR; refusing to report a successful deploy." >&2
  exit 1
fi
echo "Merge commit: $MERGE_SHA"
if ! wait_for_vercel_status "jtanori/solara" "$MERGE_SHA" "${VERCEL_STATUS_CONTEXT:-Vercel}" 60 5; then
  echo "ERROR: the merged deployment is not confirmed live; refusing to report success." >&2
  exit 1
fi

echo "Waiting for Vercel $APP_URL /api/ready ..."

READY_TMP="$(mktemp)"
CLEANUP_FILES+=("$READY_TMP")
ready_curl() { deploy_ready_curl "$APP_URL/api/ready" "$READY_TMP"; }

# Vercel Authentication returns 401/403 before the app sees the request. Fail early with
# an actionable message instead of polling a protected endpoint until the timeout.
READY_CODE="$(ready_curl || true)"
if [[ "$READY_CODE" == "401" || "$READY_CODE" == "403" ]]; then
  echo "ERROR: $APP_URL/api/ready is blocked by Vercel Authentication (HTTP $READY_CODE)." >&2
  echo "Set VERCEL_AUTOMATION_BYPASS_SECRET for this environment and re-run." >&2
  exit 1
fi

READY=false
for i in {1..24}; do
  READY_CODE="$(ready_curl || true)"
  if deploy_ready_ok "$READY_CODE" "$READY_TMP"; then READY=true; break; fi
  sleep 5
done
ROLLBACK_RECORD="—"
if [[ "$READY" == true ]]; then
  echo "✅ $APP_URL/api/ready → {\"ok\":true}"
else
  echo "ERROR: $APP_URL/api/ready did not become ready (last HTTP $READY_CODE):" >&2
  cat "$READY_TMP" >&2 || true
  echo "" >&2
  echo "== Rollback (#76) ==" >&2
  ROLLBACK_CREDS="absent"
  if [[ -n "${VERCEL_TOKEN:-}" && -n "${VERCEL_PROJECT_ID:-}" ]]; then ROLLBACK_CREDS="present"; fi
  ROLLBACK_DECISION=$(decide_rollback "$ENV" "$ROLLBACK_CREDS" "$ROLLBACK_TARGET")
  if [[ "$ROLLBACK_DECISION" == "auto" ]]; then
    if vercel_promote_deployment "$VERCEL_PROJECT_ID" "$ROLLBACK_TARGET" "${VERCEL_TEAM_ID:-}"; then
      echo "Rolled back to $ROLLBACK_TARGET${ROLLBACK_TARGET_URL:+ ($ROLLBACK_TARGET_URL)}; re-checking readiness..." >&2
      ROLLBACK_RECORD="to $ROLLBACK_TARGET"
      RB_CODE="$(ready_curl || true)"
      for i in {1..12}; do
        RB_CODE="$(ready_curl || true)"
        deploy_ready_ok "$RB_CODE" "$READY_TMP" && break
        sleep 5
      done
      if deploy_ready_ok "$RB_CODE" "$READY_TMP"; then
        echo "Rollback verified: $APP_URL/api/ready → {\"ok\":true} on the previous deployment." >&2
      else
        echo "ERROR: rollback did not restore readiness (last HTTP $RB_CODE). Manual intervention required." >&2
        ROLLBACK_RECORD="to $ROLLBACK_TARGET (NOT verified)"
      fi
    else
      echo "ERROR: automated rollback failed." >&2
      ROLLBACK_RECORD="attempted, FAILED"
      print_manual_rollback "${VERCEL_PROJECT_ID:-solara}" "$ROLLBACK_TARGET" "$ROLLBACK_TARGET_URL" "$ENV"
    fi
  else
    case "$ROLLBACK_DECISION" in
      manual-not-production)
        echo "No automatic rollback for $ENV: Vercel Instant Rollback moves the production alias," >&2
        echo "and this project's staging and production share one project. Refusing to touch production." >&2
        ROLLBACK_RECORD="manual (staging is not auto-rollbackable), not executed" ;;
      *)
        echo "No automatic rollback available (VERCEL_TOKEN/VERCEL_PROJECT_ID unset or no target captured)." >&2
        ROLLBACK_RECORD="manual, not executed" ;;
    esac
    print_manual_rollback "${VERCEL_PROJECT_ID:-solara}" "$ROLLBACK_TARGET" "$ROLLBACK_TARGET_URL" "$ENV"
  fi
  record_deploy "$ENV" "$MERGE_SHA" "$PR" "${MIGRATIONS_RECORD:-unknown}" "FAILED readiness" "$ROLLBACK_RECORD"
  exit 1
fi

record_deploy "$ENV" "$MERGE_SHA" "$PR" "${MIGRATIONS_RECORD:-none}" "ok" "—"
echo "Done. Verify sign-in, map, PDF gate, staging Stripe test webhook before promoting."
