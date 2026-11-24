#!/usr/bin/env bash
# Append the deep-audit addendum to the epic #79 body (idempotent).
# Usage: run from anywhere inside the repo:  bash scripts/epic79-addendum.sh
#        or with an explicit path:            ADDENDUM=/path/to/addendum.md bash scripts/epic79-addendum.sh
set -euo pipefail
REPO="jtanori/solara"
ADDENDUM="${ADDENDUM:-docs/audit/epic-79-addendum.md}"
MARKER="## Addendum 2026-11-08"

[[ -f "$ADDENDUM" ]] || { echo "ERROR: $ADDENDUM not found (pass ADDENDUM=...)" >&2; exit 1; }

body="$(gh issue view 79 --repo "$REPO" --json body --jq .body)"
if printf '%s' "$body" | grep -q "$MARKER"; then
  echo "Addendum already present on #79 — nothing to do."
  exit 0
fi

tmp="$(mktemp)"
printf '%s\n\n---\n\n' "$body" > "$tmp"
cat "$ADDENDUM" >> "$tmp"
gh issue edit 79 --repo "$REPO" --body-file "$tmp"
rm -f "$tmp"
echo "OK: addendum appended to #79"
