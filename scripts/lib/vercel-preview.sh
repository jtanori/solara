#!/usr/bin/env bash

# Preview-readiness helpers for scripts/deploy.sh (#76).
#
# #76's first acceptance criterion is that a deliberately broken preview blocks the merge. That
# means the deploy script has to reach the PR's own Vercel preview and probe /api/ready *before*
# `gh pr merge` — the post-merge probe cannot satisfy it, because by then the code is already on
# the target branch.
#
# Every function here is pure text/URL handling so it can be tested without Vercel; the one HTTP
# call is isolated in vercel_preview_url_from_api.
#
# VERCEL_API_BASE is overridable purely so tests can point at a local stub; production never sets it.

VERCEL_PREVIEW_API_BASE="${VERCEL_API_BASE:-https://api.vercel.com}"

# Parse a Vercel commit-status target URL into "<team>\t<project>\t<deployment-id>".
# Vercel emits inspector URLs: https://vercel.com/<team>/<project>/<dpl_id>
# Anything else (a dashboard link, a missing segment) yields nothing rather than a guess.
vercel_preview_from_status_url() {
  local url="$1" path team project id
  case "$url" in
    https://vercel.com/*) path="${url#https://vercel.com/}" ;;
    *) return 0 ;;
  esac
  path="${path%%\?*}"      # drop any query string
  path="${path%/}"          # drop a trailing slash
  # Exactly three segments: <team>/<project>/<deployment id>.
  [[ "$path" == */*/* ]] || return 0
  team="${path%%/*}"
  path="${path#*/}"
  project="${path%%/*}"
  id="${path#*/}"
  # The id itself must be a single segment, and must not merely repeat a slug.
  [[ -n "$team" && -n "$project" && -n "$id" && "$id" != */* ]] || return 0
  [[ "$id" == "$team" || "$id" == "$project" ]] && return 0
  printf '%s\t%s\t%s\n' "$team" "$project" "$id"
}

# The git branch alias Vercel serves for a branch: <project>-git-<slug>-<team>.vercel.app
# Slugs lowercase the ref and turn every non-alphanumeric run into a single dash.
vercel_preview_alias() {
  local project="$1"
  local team="$2"
  local ref="$3"
  local slug
  slug=$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]' | sed 's#[^a-z0-9]\{1,\}#-#g; s#^-##; s#-$##')
  [[ -z "$slug" ]] && return 0
  printf 'https://%s-git-%s-%s.vercel.app' "$project" "$slug" "$team"
}

# Canonical hostname for a deployment, when the API can be asked.
# Prints "https://<url>" and returns 0; prints nothing and returns 1 otherwise.
vercel_preview_url_from_api() {
  local deployment="$1"
  local team="${2:-}"
  [[ -n "${VERCEL_TOKEN:-}" && -n "$deployment" ]] || return 1
  local query=""
  [[ -n "$team" ]] && query="?teamId=$team"
  local url
  url=$(curl -fsS --max-time 20 \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    "$VERCEL_PREVIEW_API_BASE/v13/deployments/$deployment$query" 2>/dev/null \
    | node -e '
      let raw = "";
      process.stdin.on("data", chunk => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const payload = JSON.parse(raw);
          const url = payload?.url;
          if (typeof url === "string" && url) process.stdout.write(url);
        } catch {}
      });
    ' || true)
  [[ -n "$url" ]] || return 1
  case "$url" in
    http*) printf '%s' "$url" ;;
    *) printf 'https://%s' "$url" ;;
  esac
}

# Resolve the preview base URL for a PR head.
# Args: status_url ref team_id(optional)
# Prints the base URL (no trailing slash) and returns 0, or prints the reason it could not and
# returns 1. Callers must treat failure as "cannot verify" — never as "verified".
vercel_preview_url() {
  local status_url="$1"
  local ref="$2"
  local team_id="${3:-}"

  local team project deployment
  IFS=$'\t' read -r team project deployment <<< "$(vercel_preview_from_status_url "$status_url")"

  # Preferred: ask the API for the deployment's own hostname.
  if [[ -n "$deployment" ]]; then
    local canonical
    if canonical=$(vercel_preview_url_from_api "$deployment" "$team_id"); then
      printf '%s' "${canonical%/}"
      return 0
    fi
  fi

  # Fallback: the branch alias, which Vercel maintains for the branch the PR is on.
  if [[ -n "$project" && -n "$team" && -n "$ref" ]]; then
    local alias
    alias=$(vercel_preview_alias "$project" "$team" "$ref")
    if [[ -n "$alias" ]]; then
      printf '%s' "$alias"
      return 0
    fi
  fi

  printf 'could not resolve a preview URL (status URL: %s)' "${status_url:-none}"
  return 1
}

# Poll /api/ready on a preview until it reports ok, bounded.
# Args: base_url attempts interval out_file
# Returns 0 when ready, 1 otherwise; the last HTTP code is printed on stdout.
vercel_preview_ready() {
  local base_url="$1"
  local attempts="${2:-12}"
  local interval="${3:-5}"
  local out="$4"
  local code=""
  local i
  for ((i = 1; i <= attempts; i++)); do
    code=$(deploy_ready_curl "$base_url/api/ready" "$out" || true)
    if deploy_ready_ok "$code" "$out"; then
      printf '%s' "$code"
      return 0
    fi
    # A build that is still running answers 404/5xx briefly; a protected one answers 401/403
    # forever, so give up immediately rather than waiting out the timeout.
    if [[ "$code" == "401" || "$code" == "403" ]]; then
      printf '%s' "$code"
      return 1
    fi
    sleep "$interval"
  done
  printf '%s' "$code"
  return 1
}
