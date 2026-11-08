#!/usr/bin/env bash
# Apply milestone + labels to the database/auth/pipeline/deep-audit issue set.
# Idempotent: labels are additive, re-running is harmless.
#
# Prereqs: `gh auth login` with issue write scope on jtanori/solara.
# Note: `area:ci` does NOT exist in this repo — CI issues use `area:infra` + `type:ci`.
#
# Milestone routing (keep M3 honest — only true launch blockers):
#   M3 - Launch readiness      → must be true before public sign-up
#   M1 - Foundation            → hardening that improves but does not gate launch
#   Final - Platform validation→ operational evidence (backup drill, preview policy)
set -uo pipefail

M3="M3 - Launch readiness"
M1="M1 - Foundation"
FINAL="Final - Platform validation"

# Issues that belong to M1 even though they are p1/p2 (not launch-gating).
M1_ISSUES=" 60 61 65 66 67 68 71 83 86 91 92 "
# Issues that belong to Final - Platform validation.
FINAL_ISSUES=" 62 63 94 "
# Post-launch cleanup.
P3_ISSUES=" 93 "

apply() { # <issue> [labels...]
  local n="$1"; shift
  local ms="$M3"
  case "$M1_ISSUES"    in *" $n "*) ms="$M1"    ;; esac
  case "$FINAL_ISSUES" in *" $n "*) ms="$FINAL" ;; esac
  case "$P3_ISSUES"    in *" $n "*) ms="$M1"    ;; esac
  local args=()
  for l in "$@"; do args+=(--add-label "$l"); done
  if gh issue edit "$n" --repo jtanori/solara --milestone "$ms" "${args[@]}" >/dev/null 2>&1; then
    echo "OK   #$n  ($ms)"
  else
    echo "FAIL #$n  (token scope / label name?)"
  fi
}

# ---------------------------------------------------------------- incident + db/auth/pipeline (#52–#79)
apply 52 type:bug area:db area:infra area:auth priority:p0 status:ready
apply 53 type:security area:auth priority:p0 status:ready
apply 54 type:feature area:auth priority:p0 status:ready
apply 55 type:feature area:auth priority:p0 status:blocked
apply 56 type:security area:auth priority:p1 status:ready
apply 57 type:security area:ui priority:p1 status:ready
apply 58 type:security area:auth priority:p1 status:ready
apply 59 type:security area:db priority:p1 status:blocked
apply 60 type:bug area:db priority:p1 status:ready
apply 61 type:security area:docs priority:p2 status:ready
apply 62 type:chore area:infra priority:p1 status:ready
apply 63 type:chore area:infra priority:p1 status:ready
apply 64 type:bug area:infra priority:p1 status:blocked
apply 65 type:chore area:db priority:p2 status:blocked
apply 66 type:chore area:db priority:p2 status:ready
apply 67 type:feature area:auth priority:p2 status:ready
apply 68 type:feature area:auth priority:p2 status:ready
apply 69 type:security area:auth priority:p2 status:ready
apply 70 type:feature area:infra priority:p1 status:blocked
apply 71 type:docs area:docs priority:p2 status:blocked
apply 72 type:docs area:docs priority:p1 status:ready
apply 73 type:chore area:infra priority:p3 status:blocked
apply 74 type:ci area:infra priority:p1 status:ready
apply 75 type:ci area:infra priority:p1 status:blocked
apply 76 type:bug area:infra priority:p1 status:blocked
apply 77 type:feature area:infra priority:p1 status:ready
apply 78 type:docs area:infra priority:p1 status:ready
apply 79 type:chore area:infra priority:p1 status:ready

# ---------------------------------------------------------------- deep audit 2026-11 (#81–#94)
apply 80 type:docs area:docs priority:p2 status:in-review          # the audit/plans PR itself
apply 81 type:feature area:backend area:infra priority:p1 status:ready
apply 82 type:security area:backend area:docs priority:p1 status:ready
apply 83 type:feature area:backend priority:p2 status:ready
apply 84 type:security area:backend priority:p1 status:ready
apply 85 type:feature area:ui area:content priority:p1 status:ready
apply 86 type:bug area:ui priority:p2 status:ready
apply 87 type:security area:backend priority:p1 status:ready
apply 88 type:security area:infra priority:p1 status:ready
apply 89 type:chore area:infra priority:p1 status:ready
apply 90 type:security area:infra priority:p1 status:ready
apply 91 type:bug area:backend priority:p2 status:ready
apply 92 type:test area:infra priority:p2 status:ready
apply 93 type:refactor area:db priority:p3 status:ready
apply 94 type:docs area:infra priority:p2 status:ready

echo
echo "Done. Verify with:"
echo '  gh issue list --repo jtanori/solara --state open --limit 60 \'
echo '    --json number,title,milestone,labels \'
echo '    --jq ".[] | \"\(.number)\\t\(.milestone.title // \"NO MILESTONE\")\\t\([.labels[].name]|join(\",\"))\"" | sort -n'
