#!/usr/bin/env bash
# run-225-sequence.sh — the #225 execution runbook.
#
# Every step prints what it will do and waits for confirmation. A failing step stops the run and
# prints the log tail. Nothing is merged or deployed here; the script only verifies the local
# evidence path and the PR gates.
#
#   ./scripts/run-225-sequence.sh                 # interactive
#   ./scripts/run-225-sequence.sh --yes           # unattended, still stops on failure
#   ./scripts/run-225-sequence.sh --from 4        # resume from step 4
#   ./scripts/run-225-sequence.sh --only 2        # one step
#   ./scripts/run-225-sequence.sh --dry-run       # print the plan
#   ./scripts/run-225-sequence.sh --email user@solara.local   # include the local seed step
#
# Requires: loopback DATABASE_URL for the gated steps, node_modules, the three useful pilots under
# .venv/genuine-sampling/.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR=".venv/225-sequence"
mkdir -p "$LOG_DIR"

FROM=0
ONLY=""
ASSUME_YES=0
EMAIL=""
DRY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?}"; shift 2 ;;
    --only) ONLY="${2:?}"; shift 2 ;;
    --email) EMAIL="${2:?}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

should_run() {
  local n="$1"
  if [[ -n "$ONLY" && "$ONLY" != "$n" ]]; then return 1; fi
  if [[ "$n" -lt "$FROM" ]]; then return 1; fi
  return 0
}

confirm() {
  local prompt="$1"
  if [[ "$DRY" -eq 1 ]]; then return 0; fi
  if [[ "$ASSUME_YES" -eq 1 ]]; then return 0; fi
  local answer=""
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]]
}

run_step() {
  local n="$1" title="$2" next="$3" fn="$4"
  should_run "$n" || return 0
  printf '\n== Step %s — %s ==\n' "$n" "$title"
  printf '   Next: %s\n' "$next"
  if [[ "$DRY" -eq 1 ]]; then
    printf '   (dry run — not executed)\n'
    return 0
  fi
  if ! confirm "Continue?"; then
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

step0() {
  echo "branch: $(git rev-parse --abbrev-ref HEAD)"
  test -d node_modules
  test -f .venv/genuine-sampling/pilot-2026-11-core-es-go2/report.json
  test -f .venv/genuine-sampling/pilot-2026-11-rich-es-go3/report.json
  test -f .venv/genuine-sampling/pilot-2026-11-rich-es-go2/report.json
  node -e 'const h=new URL(process.env.DATABASE_URL||"").hostname; if(!["localhost","127.0.0.1","::1","[::1]"].includes(h)) { console.error("DATABASE_URL is not loopback"); process.exit(1); } console.log("database: loopback");'
}

step1() {
  npx tsx --test tests/pilot-evidence.test.ts
}

step2() {
  npx tsx scripts/pilot-evidence.ts --root .venv/genuine-sampling --structures tests/fixtures/readings/pilot-structures-v1.json
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
  npx tsc --noEmit
  npm run lint
  npm run build
}

step7() {
  if [[ -z "$EMAIL" ]]; then echo "skipped: pass --email to seed a local user"; return 0; fi
  npx tsx scripts/pilot-seed.ts --report .venv/genuine-sampling/pilot-2026-11-core-es-go2/report.json --email "$EMAIL" --mode both
}

run_step 0 "Preflight" "A1 evidence tool unit tests" step0
run_step 1 "A1 unit tests" "inventory the pilots and regenerate the structural fixture" step1
run_step 2 "Inventory + structures" "verify the pilot configuration" step2
run_step 3 "A7 pilot configuration" "render the core, rich and partial structures" step3
run_step 4 "A2 render structures" "verify the partial/failure state" step4
run_step 5 "A3 partial/failure states" "run typecheck, lint and build" step5
run_step 6 "Gates" "optionally seed a local user for reuse" step6
run_step 7 "Optional local seed" "commit and open the PR" step7

printf '\nSequence complete. Logs: %s\n' "$LOG_DIR"
