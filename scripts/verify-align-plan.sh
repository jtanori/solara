#!/usr/bin/env bash
# verify-align-plan.sh — assert the align-backlog dry-run plan before applying it.
# Run: scripts/align-backlog.sh > /tmp/plan.txt && scripts/verify-align-plan.sh /tmp/plan.txt
set -uo pipefail
PLAN="${1:-/tmp/plan.txt}"
fail=0
check() { local name="$1" expected="$2" actual="$3"; if [[ "$expected" == "$actual" ]]; then printf 'ok    %-52s %s\n' "$name" "$actual"; else printf 'FAIL  %-52s expected %s, got %s\n' "$name" "$expected" "$actual"; fail=1; fi; }

check "closes planned"                 15 "$(grep -c '^PLAN|close|close|' "$PLAN")"
check "new issues planned"             15 "$(grep -c '^PLAN|new-issues|create|' "$PLAN")"
check "milestones to create (max 5)"    5 "$(grep -c '^PLAN|preflight|create-milestone|' "$PLAN")"

# No bare p0..p3 anywhere EXCEPT as part of priority:pN. This is the check the
# previous version got wrong: \bp[0-3]\b matches inside "priority:p0".
# Count every p0..p3 occurrence, then subtract the legitimate priority:pN ones.
# The previous regex anchored on a non-alnum prefix, which silently matched
# nothing at all — it would have passed on any input, including a real defect.
total_p=$(grep -oE 'p[0-3]' "$PLAN" | wc -l | tr -d ' ')
prefixed_p=$(grep -oE 'priority:p[0-3]' "$PLAN" | wc -l | tr -d ' ')
bare=$(( total_p - prefixed_p ))
check "bare p0..p3 (must be 0)"         0 "$bare"

check "status:merged introduced"        0 "$(grep -c 'status:merged' "$PLAN")"
check "new issues duplicating #135"     0 "$(grep -c 'NEW-.*DATABASE_URL is unset' "$PLAN")"

# Every open issue must be either closed or reassigned — no orphans, no overlap.
covered=$(grep -E '^PLAN\|(close\|close|milestones\|move)' "$PLAN" | cut -d'|' -f4 | sed 's/#//;s/:.*//' | sort -n -u)
open=$(gh issue list --repo jtanori/solara --state open -L 200 --json number -q '.[].number' | sort -n -u)
check "open issues with no plan"        0 "$(comm -23 <(printf '%s\n' "$open" | sort -n -u) <(printf '%s\n' "$covered" | sort -n -u) | grep -c .)"
check "plan entries not open (stale)"   0 "$(comm -13 <(printf '%s\n' "$open" | sort -n -u) <(printf '%s\n' "$covered" | sort -n -u) | grep -c .)"

# Duplicate issue numbers inside the plan (a number closed and moved).
check "numbers both closed and moved"   0 "$(grep '^PLAN|close' "$PLAN" | cut -d'|' -f4 | sed 's/#//' | sort > /tmp/_c; grep '^PLAN|milestones' "$PLAN" | cut -d'|' -f4 | sed 's/#//;s/:.*//' | sort > /tmp/_m; comm -12 /tmp/_c /tmp/_m | grep -c .)"

exit $fail
