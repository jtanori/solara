#!/usr/bin/env bash
# migrate-dispatch.sh — dispatch `migrate.yml` and wait for the run this call created.
#
# Sourced by scripts/deploy.sh; kept separate so the ordering and the arguments can be tested with
# a stub `gh` instead of asserting that certain strings appear in a 600-line script.
#
# #245: a promotion must rehearse on staging at the exact SHA being promoted before the production
# gate will accept it. The caller owns that order; this helper owns one dispatch and its wait.
#
# Environment (all optional):
#   MIGRATE_REPO  default jtanori/solara
#   MIGRATE_REF   default $HEAD_REF (the PR head; the workflow file and the checkout are separate)
#
# Usage: dispatch_migrate <env> <pr> <sha> [rehearsal_pr]

dispatch_migrate() {
  local env="$1"
  local pr="$2"
  local sha="$3"
  local rehearsal="${4:-}"
  local repo="${MIGRATE_REPO:-jtanori/solara}"
  local ref="${MIGRATE_REF:-$HEAD_REF}"

  local args=(-f env="$env" -f pr="$pr" -f sha="$sha")
  if [[ -n "$rehearsal" ]]; then args+=(-f rehearsal_pr="$rehearsal"); fi

  echo "Triggering migrate.yml (env=$env ref=$ref sha=$sha${rehearsal:+ rehearsal_pr=$rehearsal})..."
  local before
  before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if ! gh workflow run migrate.yml --repo "$repo" --ref "$ref" "${args[@]}"; then
    echo "ERROR: could not trigger migrate.yml for $env" >&2
    return 1
  fi

  local attempts="${MIGRATE_POLL_ATTEMPTS:-10}"
  local interval="${MIGRATE_POLL_INTERVAL:-3}"
  local run_id=""
  local _attempt
  for ((_attempt = 1; _attempt <= attempts; _attempt++)); do
    run_id=$(gh run list --workflow=migrate.yml --repo "$repo" --limit 20 \
      --json databaseId,displayTitle,createdAt \
      --jq "[.[] | select(.displayTitle | contains(\"$sha\") and contains(\"$env\") and contains(\"$pr\")) | select(.createdAt > \"$before\") | .databaseId] | first // empty" 2>/dev/null || true)
    if [[ -n "$run_id" ]]; then break; fi
    sleep "$interval"
  done
  if [[ -z "$run_id" ]]; then
    # A retry can create the run a second before `before`; fall back to the newest run for this SHA.
    run_id=$(gh run list --workflow=migrate.yml --repo "$repo" --limit 10 \
      --json databaseId,displayTitle \
      --jq "[.[] | select(.displayTitle | contains(\"$sha\")) | .databaseId] | first // empty" 2>/dev/null || true)
  fi
  if [[ -z "$run_id" ]]; then
    echo "ERROR: no migrate run found for $env pr-$pr $sha" >&2
    return 1
  fi

  echo "Watching migrate run $run_id..."
  # --exit-status is deliberately omitted: the conclusion is checked below with a clear message.
  gh run watch "$run_id" --repo "$repo" 2>&1 | tail -30 || true
  local conclusion
  conclusion=$(gh run view "$run_id" --repo "$repo" --json conclusion --jq .conclusion 2>/dev/null || true)
  if [[ "$conclusion" != "success" ]]; then
    echo "ERROR: migrate workflow $run_id ${conclusion:-unknown} — gh run view $run_id --log" >&2
    return 1
  fi
  echo "migrate $env complete (run $run_id, sha $sha${rehearsal:+, rehearsal_pr=$rehearsal})"
  return 0
}
