#!/usr/bin/env bash
# Apply milestone + labels to the database/auth/pipeline issue set.
# Run once, after reviewing. Safe to re-run (labels are additive).
set -uo pipefail
M="M3 - Launch readiness"

apply() { # issue labels...  (milestone from $M or MS_M1)
  local n="$1"; shift
  local ms="$M"; case " 60 61 65 66 67 68 69 71 " in *" $n "*) ms="M1 - Foundation";; esac
  case " 62 63 " in *" $n "*) ms="Final - Platform validation";; esac
  local args=()
  for l in "$@"; do args+=(--add-label "$l"); done
  if gh issue edit "$n" --repo jtanori/solara --milestone "$ms" "${args[@]}" >/dev/null 2>&1; then
    echo "OK   #$n ($ms)"
  else
    echo "FAIL #$n (check token scope / label names)"
  fi
}

apply 52 type:bug area:db area:infra area:auth priority:p0 status:ready
apply 53 type:security area:auth priority:p0 status:ready
apply 54 type:feature area:auth priority:p0 status:ready
apply 55 type:feature area:auth priority:p0 status:blocked
apply 56 type:security area:auth priority:p1 status:ready
apply 57 type:security area:ui priority:p1 status:ready
apply 58 type:security area:auth priority:p1 status:ready
apply 59 type:security area:db priority:p1 status:blocked
apply 60 type:bug area:db priority:p1 status:ready   # M1
apply 61 type:security area:docs priority:p2 status:ready   # M1
apply 62 type:chore area:infra priority:p1 status:ready
apply 63 type:chore area:infra priority:p1 status:ready
apply 64 type:bug area:infra priority:p1 status:blocked
apply 65 type:chore area:db priority:p2 status:blocked   # M1
apply 66 type:chore area:db priority:p2 status:ready   # M1
apply 67 type:feature area:auth priority:p2 status:ready   # M1
apply 68 type:feature area:auth priority:p2 status:ready   # M1
apply 69 type:security area:auth priority:p2 status:ready   # M1
apply 70 type:feature area:infra priority:p1 status:blocked
apply 71 type:docs area:docs priority:p2 status:blocked   # M1
apply 72 type:docs area:docs priority:p1 status:ready
apply 73 type:chore area:infra priority:p1 status:ready
apply 74 type:ci area:infra priority:p1 status:ready
apply 75 type:ci area:infra priority:p1 status:blocked
apply 76 type:bug area:infra priority:p1 status:blocked
apply 77 type:feature area:infra priority:p1 status:ready
apply 78 type:docs area:infra priority:p1 status:ready