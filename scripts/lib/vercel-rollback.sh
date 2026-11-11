#!/usr/bin/env bash

# Vercel rollback helpers for scripts/deploy.sh. Sourced so the HTTP work stays testable and
# the deploy script keeps one responsibility per gate.
#
# VERCEL_API_BASE is overridable purely so tests can point at a local stub; production never sets it.

VERCEL_API_BASE="${VERCEL_API_BASE:-https://api.vercel.com}"

# Resolve a deployment identifier from a GitHub commit status target URL.
# Vercel emits both shapes: ".../solara/dpl_ABC123" and ".../solara/ABC123" (the short id used in
# inspector URLs). Take the last path segment and normalise to the dpl_ form the API expects.
vercel_deployment_id_from_url() {
  local url="$1"
  local segment
  segment=$(printf '%s' "$url" | sed -n 's#/*$##; s#^.*/\([A-Za-z0-9_]*\)$#\1#p')
  [[ -z "$segment" ]] && return 0
  case "$segment" in
    dpl_*) printf '%s' "$segment"; return 0 ;;
  esac
  # The third path segment is the deployment id. Do NOT require a digit or a particular length:
  # real ids are base62 and contain no digits at all (e.g. aVrhDtYTxMXZpWmWQxZGSVdAhMXT).
  # Reject only the segments that are actually slugs repeated from the same URL.
  local team project
  case "$url" in
    https://vercel.com/*)
      local path="${url#https://vercel.com/}"; path="${path%%\?*}"; path="${path%/}"
      team="${path%%/*}"; path="${path#*/}"; project="${path%%/*}"
      [[ "$segment" == "$team" || "$segment" == "$project" ]] && return 0
      ;;
  esac
  printf 'dpl_%s' "$segment"
}

# The deployment currently serving production. Needed because a rollback target is not derivable
# from the failing deployment alone.
#
# Production only, on purpose. This repository has ONE Vercel project ("solara"): `staging` is a
# preview alias and `main` is the production branch. Vercel's rollback endpoint only moves a
# production alias, so there is nothing for it to restore after a failed staging deploy — and
# calling it for staging would repoint production at an older build (#76 review finding). Staging
# recovery is a different action: re-run the deploy of the last good commit.
vercel_current_production_deployment() {
  local project="$1"
  local team="$2"
  local query="limit=1&target=production"
  [[ -n "$team" ]] && query="$query&teamId=$team"
  curl -fsS --max-time 20 \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    "$VERCEL_API_BASE/v6/deployments?projectId=$project&$query" 2>/dev/null \
    | node -e '
      let raw = "";
      process.stdin.on("data", chunk => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const payload = JSON.parse(raw);
          const first = (payload.deployments || [])[0];
          if (!first) return;
          process.stdout.write(`${first.uid || ""}\t${first.url || ""}\t${first.created || ""}\n`);
        } catch {}
      });
    '
}

# Readiness probe shared by every gate in deploy.sh, so the bypass header is applied in exactly one
# place. Prints the HTTP status code; body lands in $2.
deploy_ready_curl() {
  local url="$1"
  local out="$2"
  if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
    curl -sS --max-time 5 -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" -o "$out" -w '%{http_code}' "$url"
  else
    curl -sS --max-time 5 -o "$out" -w '%{http_code}' "$url"
  fi
}

# True when a readiness response is an actual success, not merely HTTP 200.
deploy_ready_ok() {
  local code="$1"
  local body="$2"
  [[ "$code" == "200" ]] && grep -q '"ok":true' "$body"
}

# Instant Rollback. The endpoint path below is the only part of this file that has NOT been
# exercised against the live Vercel API (it needs a real VERCEL_TOKEN); #76's acceptance requires
# exercising it once live, which is what confirms it. Every failure path prints manual recovery
# steps rather than pretending the rollback happened.
#
# Production only: it moves the production alias to `deployment`. See the note on
# vercel_current_production_deployment for why a staging failure must not call it.
vercel_promote_deployment() {
  local project="$1"
  local deployment="$2"
  local team="$3"
  local query=""
  [[ -n "$team" ]] && query="?teamId=$team"
  curl -fsS --max-time 30 -X POST \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    -H "Content-Type: application/json" \
    "$VERCEL_API_BASE/v1/projects/$project/rollback/$deployment$query" >/dev/null
}

# Human-readable recovery that is always printed when rollback cannot be automated. The two
# environments recover by different actions, so the steps differ rather than being generic.
print_manual_rollback() {
  local project="$1"
  local previous="$2"
  local previous_url="$3"
  local env="${4:-production}"
  if [[ "$env" == "staging" ]]; then
    echo "  Restore staging manually (there is no staging alias to roll back automatically):" >&2
    echo "    ./scripts/deploy.sh --pr <last-known-good PR> --env staging" >&2
    echo "    or: Vercel → Project '$project' → Deployments → filter branch 'staging'${previous:+ → promote $previous}" >&2
    return 0
  fi
  echo "  Roll back manually:" >&2
  if [[ -n "$previous" ]]; then
    echo "    Vercel → Project '$project' → Deployments → find $previous${previous_url:+ ($previous_url)} → Promote to Production" >&2
    echo "    or: npx vercel rollback $previous_url" >&2
  else
    echo "    Vercel → Project '$project' → Deployments → select the last known-good → Promote to Production" >&2
  fi
}
