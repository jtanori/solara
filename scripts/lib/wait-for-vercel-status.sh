#!/usr/bin/env bash

# Wait for the Vercel commit status attached to a specific merge SHA.
# Sourced by scripts/deploy.sh; kept separate so the polling can be tested with a fake gh.
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
    row=$(GH_STATUS_CONTEXT="$context" gh api "repos/$repo/commits/$sha/status" \
      --jq '[.statuses[] | select(.context == env.GH_STATUS_CONTEXT)] | sort_by(.created_at) | last | [.state, .target_url] | @tsv' \
      2>/dev/null || true)
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
