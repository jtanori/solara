#!/usr/bin/env bash
# run-225-sequence.sh — the #225 execution runbook.
#
# Each step prints its title and the next step, waits for confirmation, and stops the run on the
# first failure with the log tail. It never commits, merges or deploys: the last step writes a local
# database dump for reuse; opening the PR is the operator's action.
#
#   ./scripts/run-225-sequence.sh                 # interactive
#   ./scripts/run-225-sequence.sh --yes           # unattended, still stops on failure
#   ./scripts/run-225-sequence.sh --from 4        # resume from step 4 (0-8)
#   ./scripts/run-225-sequence.sh --only 2        # one step
#   ./scripts/run-225-sequence.sh --dry-run       # print the plan
#   ./scripts/run-225-sequence.sh --email user@solara.local   # include the local seed step
#
# Requires: loopback DATABASE_URL for the gated steps, node_modules, psql/pg_dump for step 8, and
# the three useful pilots under .venv/genuine-sampling/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR=".venv/225-sequence"
FIXTURE="tests/fixtures/readings/pilot-structures-v1.json"

FROM=0
ONLY=""
ASSUME_YES=0
EMAIL=""
BRANCH="chore/225-pilot-evidence"
DRY=0

# Print the header comment block only: everything from line 2 up to the first blank line.
usage() { awk 'NR > 1 { if ($0 ~ /^$/) exit; print }' "$0"; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?--from needs a step number}"; shift 2 ;;
    --only) ONLY="${2:?--only needs a step number}"; shift 2 ;;
    --email) EMAIL="${2:?--email needs an address}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

is_step() { [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 <= 8 )); }

for value in "$FROM" "$ONLY"; do
  [[ -z "$value" ]] && continue
  if ! is_step "$value"; then
    echo "step must be an integer between 0 and 8 (got '$value')" >&2
    exit 2
  fi
done
# --only names one step; a resume point after it would run nothing and still report success.
if [[ -n "$ONLY" ]] && (( 10#$ONLY < 10#$FROM )); then
  echo "--only $ONLY is before --from $FROM; nothing would run" >&2
  exit 2
fi

STEP_TITLES=(
  "Preflight"
  "A1 unit tests"
  "Inventory and structures"
  "A7 pilot configuration"
  "A2 render structures"
  "A3 partial/failure states"
  "Gates"
  "Optional local seed"
  "Local database dump"
)
STEP_FUNCS=(step0 step1 step2 step3 step4 step5 step6 step7 step8)

should_run() {
  local n="$1"
  if [[ -n "$ONLY" && "$ONLY" != "$n" ]]; then return 1; fi
  if (( 10#$n < 10#$FROM )); then return 1; fi
  return 0
}

confirm() {
  if [[ "$DRY" -eq 1 || "$ASSUME_YES" -eq 1 ]]; then return 0; fi
  local answer=""
  read -r -p "Continue? [y/N] " answer || true
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

run_step() {
  local n="$1" title="${STEP_TITLES[$1]}" fn="${STEP_FUNCS[$1]}" next="${STEP_TITLES[$(( $1 + 1 ))]:-end of sequence}"
  should_run "$n" || return 0
  printf '\n== Step %s — %s ==\n' "$n" "$title"
  printf '   Next: %s\n' "$next"
  if [[ "$DRY" -eq 1 ]]; then
    printf '   (dry run — not executed)\n'
    return 0
  fi
  if ! confirm; then
    echo "Stopped before step $n."
    exit 0
  fi
  local log="$LOG_DIR/$n.log"
  if "$fn" >"$log" 2>&1; then
    printf 'OK\n'
    tail -n 4 "$log" | sed 's/^/   /'
  else
    printf 'FAILED — %s\n' "$title"
    tail -n 30 "$log" | sed 's/^/   /'
    printf 'log: %s\n' "$log"
    exit 1
  fi
}

require_loopback() {
  if [[ -z "${DATABASE_URL:-}" ]]; then echo "DATABASE_URL is not set"; return 1; fi
  node -e 'const host = new URL(process.env.DATABASE_URL).hostname;
    if (!["localhost","127.0.0.1","::1","[::1]"].includes(host)) { console.error(`DATABASE_URL is not loopback (${host})`); process.exit(1); }
    console.log("database: loopback");'
}

step0() {
  local current
  current="$(git rev-parse --abbrev-ref HEAD)"
  echo "branch: $current"
  if [[ "$current" != "$BRANCH" ]]; then echo "expected branch $BRANCH"; return 1; fi
  test -d node_modules
  test -f "$FIXTURE"
  for pilot in pilot-2026-11-core-es-go2 pilot-2026-11-rich-es-go3 pilot-2026-11-rich-es-go2; do
    test -f ".venv/genuine-sampling/$pilot/report.json" || { echo "missing pilot $pilot"; return 1; }
  done
  require_loopback
}

step1() {
  npx tsx --test tests/pilot-evidence.test.ts
}

step2() {
  npx tsx scripts/pilot-evidence.ts --root .venv/genuine-sampling --structures "$FIXTURE"
  if ! git diff --quiet -- "$FIXTURE"; then
    echo "the committed structural fixture changed; review it and commit before continuing"
    git diff --stat -- "$FIXTURE"
    return 1
  fi
}

step3() {
  npx tsx --test tests/pilot-config.test.ts
}

step4() {
  RUN_INTEGRATION_TESTS=1 npx tsx --test tests/pilot-render.test.ts
}

step5() {
  RUN_INTEGRATION_TESTS=1 npx tsx --test tests/pilot-states.test.ts
}

step6() {
  local before
  before="$(git status --porcelain -- next-env.d.ts)"
  npx tsc --noEmit
  npm run lint
  npm run build
  npm run db:manifest:check
  npm run db:check
  # next build rewrites a generated file; restore it only if this step is what dirtied it.
  if [[ -z "$before" ]] && [[ -n "$(git status --porcelain -- next-env.d.ts)" ]]; then
    git checkout -- next-env.d.ts
    echo "restored next-env.d.ts"
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "working tree is dirty; commit or stash before this step:"
    git status --short
    return 1
  fi
}

step7() {
  if [[ -z "$EMAIL" ]]; then echo "skipped: pass --email to seed a local user"; return 0; fi
  npx tsx scripts/pilot-seed.ts --report .venv/genuine-sampling/pilot-2026-11-core-es-go2/report.json --email "$EMAIL" --mode both
}

step8() {
  command -v pg_dump >/dev/null || { echo "pg_dump is not installed"; return 1; }
  command -v psql >/dev/null || { echo "psql is not installed"; return 1; }
  require_loopback
  local stamp file sidecar count last sha
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p .venv/fixtures
  file=".venv/fixtures/pilot-seed-$stamp.sql"
  sidecar=".venv/fixtures/pilot-seed-$stamp.json"
  pg_dump "$DATABASE_URL" --no-owner --no-privileges > "$file"
  count="$(psql "$DATABASE_URL" -tAc "select count(*) from drizzle.__drizzle_migrations")"
  last="$(psql "$DATABASE_URL" -tAc "select coalesce(max(created_at)::text, '') from drizzle.__drizzle_migrations")"
  sha="$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$file")"
  node -e '
    const [dump, count, last, sha, branch, head, sidecar] = process.argv.slice(1);
    require("node:fs").writeFileSync(sidecar, JSON.stringify({
      createdAt: new Date().toISOString(), branch, head, dump, sha256: sha,
      migrations: { count: Number(count), lastCreatedAt: last || null },
    }, null, 2) + "\n");
  ' "$(basename "$file")" "$count" "$last" "$sha" "$(git rev-parse --abbrev-ref HEAD)" "$(git rev-parse HEAD)" "$sidecar"
  echo "dump: $file"
  echo "sidecar: $sidecar"
}

for n in $(seq 0 8); do
  run_step "$n"
done

printf '\nSequence complete. Logs: %s\n' "$LOG_DIR"
