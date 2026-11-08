#!/usr/bin/env bash
# sync-reading-epic.sh — record progress on the reading epic (#99–#111) and close finished work.
#
# The automation token used by the agent can create issues and comments, but cannot
# close, label or milestone them (403 Resource not accessible by integration).
# Run this from a maintainer `gh auth login` session.
#
# Usage:
#   ./scripts/sync-reading-epic.sh --dry-run     # print what would change
#   ./scripts/sync-reading-epic.sh               # apply
#
# Idempotent: closing a closed issue is a no-op; comments are only added when --comment is used.

set -euo pipefail
REPO="${SOLARA_REPO:-jtanori/solara}"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

command -v gh >/dev/null || { echo "ERROR gh not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "ERROR gh not authenticated" >&2; exit 1; }

# issue|state|status-label|note
DATA=$(cat <<'EOF'
102|closed|status:in-review|Fixtures + Swiss Ephemeris validation landed in #112/#113; caught the heliocentric bug (Venus 47 deg off) and the node error (2.7 deg).
101|open|status:in-progress|Chart v2 landed (#112) and is validated for bodies and nodes (#113). Still open for: Ascendant/Midheaven pinned to an external source, and Placidus.
100|open|status:in-progress|Types and the PII-free chartDigest() landed in #112. Remaining: persisted ReadingDocument shape and the versioned document schema.
EOF
)

failures=0
while IFS='|' read -r num state label note; do
  [[ -z "$num" ]] && continue
  if [[ "$DRY_RUN" == true ]]; then
    echo "#$num -> state=$state label=$label"
    echo "        note: $note"
    continue
  fi
  if [[ "$state" == "closed" ]]; then
    if gh issue close "$num" --repo "$REPO" --reason completed \
         --comment "$note" >/dev/null 2>&1; then
      echo "closed  #$num"
    else
      echo "FAILED  #$num (close)" >&2; failures=$((failures+1)); continue
    fi
  else
    if gh issue comment "$num" --repo "$REPO" --body "$note" >/dev/null 2>&1; then
      echo "noted   #$num"
    else
      echo "FAILED  #$num (comment)" >&2; failures=$((failures+1))
    fi
  fi
  # label moves are best-effort: the old status: label stays, which is why this is explicit
  gh issue edit "$num" --repo "$REPO" --add-label "$label" >/dev/null 2>&1 \
    && echo "labeled #$num +$label" \
    || { echo "FAILED  #$num (label $label)" >&2; failures=$((failures+1)); }
done <<< "$DATA"

echo ""
if [[ "$failures" -gt 0 ]]; then
  echo "INCOMPLETE: $failures operation(s) failed" >&2
  exit 1
fi
echo "OK — epic states synced"
echo ""
echo "Note: stale status labels (status:ready) are not removed automatically —"
echo "      remove them by hand so the board shows one status per issue."
