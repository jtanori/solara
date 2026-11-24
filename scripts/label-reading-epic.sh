#!/usr/bin/env bash
# label-reading-epic.sh — apply labels + milestone to the reading-epic issues (#99–#111).
#
# The automation token used to file these issues is create-only: it cannot label or
# set milestones (403 Resource not accessible by integration). Run this with your own
# `gh auth login` session.
#
# Usage:
#   ./scripts/label-reading-epic.sh --dry-run    # print what would change
#   ./scripts/label-reading-epic.sh              # apply
#   ./scripts/label-reading-epic.sh --verify     # check only, no writes
#
# Idempotent: re-running is safe; labels are added (never removed), milestone is set.

set -euo pipefail

REPO="${SOLARA_REPO:-jtanori/solara}"
MILESTONE_NUMBER=3   # M3 - Launch readiness
DRY_RUN=false
VERIFY_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verify) VERIFY_ONLY=true ;;
    -h|--help) sed -n '1,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "ERROR gh not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR gh not authenticated" >&2; exit 1; }

# issue:labels (space separated)
DATA=$(cat <<'EOF'
99:type:feature area:astro area:content priority:p1 status:ready
100:type:feature area:backend area:astro priority:p1 status:ready
101:type:feature area:astro area:backend priority:p1 status:ready
102:type:test area:astro priority:p0 status:ready
103:type:feature area:backend area:content priority:p1 status:ready
104:type:feature area:content area:ui priority:p1 status:ready
105:type:security area:auth area:docs priority:p0 status:ready
106:type:feature area:ui area:backend priority:p2 status:ready
107:type:feature area:billing area:backend priority:p1 status:ready
108:type:feature area:infra area:backend priority:p1 status:ready
109:type:test area:content area:astro priority:p1 status:ready
110:type:feature area:astro priority:p2 status:ready
111:type:feature area:content area:ui priority:p3 status:ready
EOF
)

failures=0

if [[ "$VERIFY_ONLY" == false ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    num="${line%%:*}"
    rest="${line#*:}"
    read -r -a labels <<< "$rest"

    if [[ "$DRY_RUN" == true ]]; then
      echo "#$num -> gh issue edit $num --milestone 'M3 - Launch readiness'" \
           "$(printf -- '--add-label %q ' "${labels[@]}")"
      continue
    fi

    if gh issue edit "$num" --repo "$REPO" \
         --milestone "M3 - Launch readiness" \
         $(printf -- '--add-label %s ' "${labels[@]}") >/dev/null 2>&1; then
      echo "ok      #$num  +${#labels[@]} labels, milestone M3"
    else
      echo "FAILED  #$num" >&2
      failures=$((failures + 1))
    fi
  done <<< "$DATA"
fi

if [[ "$DRY_RUN" == true ]]; then echo "(dry run — nothing changed)"; exit 0; fi

echo ""
echo "== verification =="
missing=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  num="${line%%:*}"
  json=$(gh api "repos/$REPO/issues/$num" --jq '{m:(.milestone.title // "none"), l:(.labels|map(.name)|join(","))}' 2>/dev/null) || { echo "#$num unreadable" >&2; missing=$((missing+1)); continue; }
  ms=$(printf '%s' "$json" | sed -nE 's/.*"m":"([^"]*)".*/\1/p')
  lb=$(printf '%s' "$json" | sed -nE 's/.*"l":"([^"]*)".*/\1/p')
  if [[ "$ms" == M3* && "$lb" == *priority:* && "$lb" == *status:* ]]; then
    printf 'ok      #%-4s %s\n' "$num" "$ms"
  else
    printf 'MISSING #%-4s milestone=%s labels=%s\n' "$num" "$ms" "$lb"
    missing=$((missing+1))
  fi
done <<< "$DATA"

echo ""
if [[ "$missing" -gt 0 || "$failures" -gt 0 ]]; then
  echo "INCOMPLETE: $missing issue(s) missing metadata, $failures write failure(s)" >&2
  exit 1
fi
echo "OK — all 13 issues carry a milestone, a priority and a status label"
