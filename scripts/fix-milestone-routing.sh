#!/usr/bin/env bash
# Re-route the 4 issues that landed in the wrong milestone.
# (Audit severities are the source of truth; M3 must contain only launch blockers.)
#
#   #62  backup/PITR + restore drill   S1 → M3   (data recoverability blocks launch)
#   #63  env single source of truth    S2 → M1   (hygiene, not a launch gate)
#   #94  incident runbook/kill-switch  S2 → M1   (operational maturity, not a gate)
#   #69  re-auth for destructive ops   S2 → M1   (matches #67/#68 siblings)
#
# Idempotent. Requires issue write scope.
set -uo pipefail

move() { # <issue> <milestone>
  if gh issue edit "$1" --repo jtanori/solara --milestone "$2" >/dev/null 2>&1; then
    echo "OK   #$1 → $2"
  else
    echo "FAIL #$1 (token scope)"
  fi
}

move 62 "M3 - Launch readiness"
move 63 "M1 - Foundation"
move 94 "M1 - Foundation"
move 69 "M1 - Foundation"

echo
echo "Verify:"
echo '  gh api repos/jtanori/solara/milestones --jq ".[] | \"\(.title)\topen=\(.open_issues)\""'
