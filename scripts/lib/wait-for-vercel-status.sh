#!/usr/bin/env bash

# Wait for the Vercel commit status attached to a specific merge SHA.
# Sourced by scripts/deploy.sh; kept separate so the polling can be tested with a fake gh.
WAIT_FOR_VERCEL_STATUS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

wait_for_vercel_status() {
  local repo="$1"
  local sha="$2"
  local context="${3:-Vercel}"
  local attempts="${4:-60}"
  local interval="${5:-5}"
  local last_state=""
  local state=""
  local url=""

  for ((i = 1; i <= attempts; i++)); do
    local row
    row=$(gh api "repos/$repo/commits/$sha/status" 2>/dev/null \
      | node "$WAIT_FOR_VERCEL_STATUS_DIR/vercel-status.mjs" "$context" 2>/dev/null || true)
    IFS=$'\t' read -r state url <<< "$row"

    if [[ "$state" == "success" ]]; then
      echo "Vercel deployment ready for $sha${url:+ ($url)}"
      return 0
    fi
    if [[ "$state" == "failure" || "$state" == "error" ]]; then
      echo "ERROR: Vercel status for $sha is $state${url:+ ($url)}" >&2
      return 1
    fi

    if [[ "$state" != "$last_state" ]]; then
      echo "Vercel status for $sha: ${state:-not reported yet}"
      last_state="$state"
    fi
    sleep "$interval"
  done

  echo "ERROR: timed out waiting for a $context status on $sha (last state: ${last_state:-none})" >&2
  return 1
}
