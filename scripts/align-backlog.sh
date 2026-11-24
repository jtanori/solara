#!/usr/bin/env bash
# align-backlog.sh — reconcile the Solara issue tracker with the state of the repo.
#
# Dry-run by default. --apply performs the changes. Every action is guarded by a
# check, so re-running after a partial failure is safe and idempotent.
#
# Usage:
#   scripts/align-backlog.sh                          # dry-run
#   scripts/align-backlog.sh --apply                  # everything
#   scripts/align-backlog.sh --apply --only=close     # one phase
#     phases: preflight | close | labels | milestones | new-issues | report
#
# Requires: gh (authenticated), jq, bash 4+.
#
# v4 changes over v3:
#   1. NEW_ISSUES deduplicated by explicit `key`; paraphrased duplicates of
#      existing issues (#135, #136, #76, #134, #63+#91) are REMOVED and expressed
#      as REASSIGN/REPRIORITIZE on the existing numbers instead. Filing 24 issues
#      while closing 15 would have left the tracker worse than it started.
#   2. label_exists() hardened: the gh label list | grep -Fxq pipeline returned
#      false negatives intermittently, which would have made preflight issue
#      `gh label create --force` against existing labels (silently rewriting
#      their colour and description). Now a single jq read with a retry, and
#      --force is gone.
#   3. Verification-friendly output: one machine-readable line per planned action
#      (PLAN|phase|action|key), so the counts can be asserted instead of grepped.
#   4. Milestones are only created when the whole plan is applied, never by a
#      --only phase that does not need them.
#   5. Backlog shape reflects a product-first order: S0 cleanup, then S1 product
#      (build + demo locally), then S2 deployment, then hardening.

set -euo pipefail

REPO="${SOLARA_REPO:-jtanori/solara}"
APPLY=0
ONLY=""
RETRIES=3

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --only=*) ONLY="${arg#--only=}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Plan data
# ---------------------------------------------------------------------------

# Close: work already on staging, or artifact already exists.
# 15 entries = 12 merged + 3 artifact-exist.  Each was verified against the
# merged PR before being listed.
CLOSE_LIST=(
  "53|merged via #118 (auth rate-limit + non-blocking scrypt)"
  "54|merged via #118 (email transport + verification)"
  "55|merged via #125 (password reset)"
  "56|merged via #118 (CSRF/same-origin)"
  "60|merged via #125 (explicit pool + TLS)"
  "64|merged via #126 (migration drift check)"
  "70|merged via #126 (health/ready split)"
  "84|merged via #125 (harden /api/places)"
  "87|merged via #125 (PII redaction + structured logs)"
  "103|merged via #127 (generation pipeline)"
  "119|merged via #120 (exact-SHA migrate)"
  "132|merged via #133 (replace BACKLOG.md)"
  "71|artifact exists — AGENTS.md §105 states the readiness/schema contract AND .github/pull_request_template.md line 23 carries the /api/health + /api/ready smoke check"
  "72|artifact exists — ADR 006 is recorded in docs/decisions.md (its header cites Issue: #72)"
  "78|artifact exists — ADR 007 is recorded in docs/decisions.md (its header cites Issue: #78)"
)

# Milestones: product-first ordering.
MILESTONES=(
  "S0 - Backlog cleanup|Make the tracker honest. Exit: every open issue reflects real remaining work; no status:todo issue has merged code; no duplicate issues."
  "S1 - Product: a real reading, locally|Build and demo the product loop on localhost. Exit: a real LLM produces 11 sections, /reading/[id] renders them, free sections lock, Stripe test checkout unlocks paid sections, a demo reading is recorded."
  "S2 - First deployment|Ship the thing built in S1. Exit: migrations 0001-0003 applied to hosted DBs, first promotion, rollback drill recorded, docs/deploys.md has >=2 rows."
  "S3 - Hardening|Security, compliance and operational maturity once the product ships. Exit: MFA, backup drill, error tracking, legal pages, retention policy, CODEOWNERS."
  "S4 - Content completion|Full paid reading experience with astrologer review. Exit: paid generation, eval harness, review gate, profections/transits, override tooling."
)

# Reassign existing issues. Product work (S1) first; deploy work (S2) second.
REASSIGN=(
  # --- S1: product, built locally ---
  "135|S1 - Product: a real reading, locally"      # test suite must be trustworthy while building
  "136|S1 - Product: a real reading, locally"      # --dry-run: needed before S2, not now
  "63|S1 - Product: a real reading, locally"       # DATABASE_URL single source, needed locally too
  "91|S1 - Product: a real reading, locally"       # typed env at boot
  "134|S1 - Product: a real reading, locally"      # review discipline while developing
  "138|S1 - Product: a real reading, locally"      # know which build you are looking at
  "100|S1 - Product: a real reading, locally"      # domain model, in progress
  "106|S1 - Product: a real reading, locally"      # renderer  <-- the actual work
  "104|S1 - Product: a real reading, locally"      # free teasers
  "107|S1 - Product: a real reading, locally"      # paid sections on entitlement
  "108|S1 - Product: a real reading, locally"      # cost caps before any real provider call
  "105|S1 - Product: a real reading, locally"      # AI consent before real generation
  "109|S1 - Product: a real reading, locally"      # quality gate before showing anyone
  "131|S1 - Product: a real reading, locally"      # mail: needed for verified signup in the demo
  "10|S1 - Product: a real reading, locally"       # Stripe lifecycle, validated locally
  "86|S1 - Product: a real reading, locally"       # error boundaries: demo-facing
  # --- S2: first deployment ---
  "76|S2 - First deployment"
  "62|S2 - First deployment"
  # --- S3: hardening ---
  "58|S3 - Hardening"
  "59|S3 - Hardening"
  "57|S3 - Hardening"
  "74|S3 - Hardening"
  "75|S3 - Hardening"
  "77|S3 - Hardening"
  "82|S3 - Hardening"
  "85|S3 - Hardening"
  "88|S3 - Hardening"
  "89|S3 - Hardening"
  "90|S3 - Hardening"
  "94|S3 - Hardening"
  "66|S3 - Hardening"
  "67|S3 - Hardening"
  "68|S3 - Hardening"
  "69|S3 - Hardening"
  "65|S3 - Hardening"
  "83|S3 - Hardening"
  "61|S3 - Hardening"
  "93|S3 - Hardening"
  "79|S3 - Hardening"
  "92|S3 - Hardening"
  # --- S4: content ---
  "110|S4 - Content completion"
  "111|S4 - Content completion"
  "128|S4 - Content completion"
  "129|S4 - Content completion"
  "81|S4 - Content completion"
  "99|S4 - Content completion"
)

# Priority overrides (canonical priority:pX labels; one per issue).
REPRIORITIZE=(
  "135|priority:p0"
  "136|priority:p1"
  "76|priority:p0"
  "131|priority:p0"
  "10|priority:p0"
  "106|priority:p0"
  "104|priority:p0"
  "107|priority:p1"
  "108|priority:p0"
  "105|priority:p1"
  "109|priority:p1"
  "62|priority:p1"
  "138|priority:p2"
  "63|priority:p1"
  "91|priority:p2"
  "134|priority:p1"
)

# New issues: ONLY genuinely new work. Nothing here duplicates an existing
# issue; paraphrases of #135/#136/#76/#134/#63/#91 are expressed above.
# Format: key|title|milestone|priority|body
NEW_ISSUES=(
  "NEW-01|chore: add post-merge issue-close step to AGENTS.md and PR checklist|S0 - Backlog cleanup|priority:p1|GitHub only auto-closes \`Closes #N\` when a PR targets the default branch (main). Our PRs target staging, so auto-close never fires and 14 issues stayed open after their work merged. Add to AGENTS.md: after merging a PR into staging, close every issue named in its Closes/Fixes lines. Root cause: docs/audit/open-issues-by-milestone-2026-11-11.md."
  "NEW-02|ci: GitHub Action to close linked issues on merge to staging|S0 - Backlog cleanup|priority:p2|Backstop for NEW-01. Parse the PR body for Closes/Fixes #N and close those issues when the PR merges into staging. Optional if the manual step holds; file only if it is forgotten once."
  "NEW-03|chore: rename package.json and the GitHub repo from nextjs-postgresql-template to solara|S0 - Backlog cleanup|priority:p3|The scaffolding name was never changed. package.json:2. Repo rename needs coordination with the Vercel project, any bookmarks, and local remotes."
  "NEW-04|readings: implement a real LLM provider adapter|S1 - Product: a real reading, locally|priority:p0|src/readings/provider.ts exports exactly one entry in PROVIDERS: the fixture. \`READINGS_PROVIDER=openai\` resolves to undefined, so resolveProvider() returns null and every section fails. The fixture is chart-grounded and reads like real prose, which makes it easy to mistake for a working pipeline when evaluating output quality. Implement the adapter behind the existing ReadingProvider seam: SDK call, JSON-schema enforcement, usage mapping (inputTokens/outputTokens), timeout, and one retry. Must satisfy validUsage() — NaN or negative token counts disable both spend ceilings. Depends on #108 for cost caps before any real spend."
  "NEW-05|ops: generate a demo reading and record a 2-minute walkthrough|S1 - Product: a real reading, locally|priority:p1|The deliverable that proves the product works: a full reading for a well-known birth date, rendered as page and PDF, plus a screen recording of birth data -> chart -> free sections -> paywall -> Stripe test checkout -> paid sections -> PDF download. This is what you show a person. Precedes any deployment work."
  "NEW-06|test: e2e smoke for sign-up -> reading -> paywall, runnable against localhost|S1 - Product: a real reading, locally|priority:p1|Replaces the vague 'e2e smoke journey' in #92 with a specific product path: sign up, verify (outbox), create a reading, generate sections, see free sections, hit the paywall, subscribe via Stripe test mode, see paid sections. Must run against a local server so it can gate the S1 exit."
  "NEW-07|ci: move staging migrations into ci.yml and retire the staging dispatch|S2 - First deployment|priority:p0|Deploy simplification 1. Add a migration step to the verify job that runs against the hosted staging DB when a PR touches drizzle/. Removes the separate migrate.yml dispatch from deploy.sh. Prerequisite for NEW-08 and NEW-09 — both assume migrations already run in CI."
  "NEW-08|deploy: simplify the staging path to CI-gate + merge + post-merge probe|S2 - First deployment|priority:p0|Deploy simplification 2. Reduce staging to: gh pr checks --watch, gh pr merge --squash, post-merge /api/ready, record to docs/deploys.md. Removes the base-freshness gate (branch protection covers it), the hosted schema check (CI migrated), and the migrate.yml dispatch. KEEPS the preview-readiness probe: CI checks a localhost build (ci.yml:78-82), not the deployed preview, and that gate caught a broken preview on #133. Depends on NEW-07."
  "NEW-09|deploy: simplify the promotion path to staging-as-rehearsal|S2 - First deployment|priority:p0|Deploy simplification 3. Replace the 6-clause production gate with: staging /api/ready green, migrate production, merge with --no-ff, wait for Vercel, probe production /api/ready, roll back on failure, record + tag. Removes the rehearsal-PR and artifact-matching clauses. GATED ON NEW-07: until migrations demonstrably run on staging via CI, removing the rehearsal requirement lets production be first again — the exact failure ADR 008 guards against. Do not start before NEW-07 has merged a real drizzle/ change through CI."
  "NEW-10|test: automate HAZARD A and HAZARD B compatibility checks|S2 - First deployment|priority:p1|Deploy simplification 4. tests/hazard-compat.test.ts: (A) no migration adds a NOT NULL column without a DEFAULT; (B) readiness.ts references no table or column that a migration drops. Replaces the manual expand/contract analysis in docs/operations/promotion-2026-11-10.md with a check that runs in CI."
  "NEW-11|ci: weekly automatic promotion workflow|S3 - Hardening|priority:p1|Deploy simplification 5. .github/workflows/promote.yml every Friday: if staging is ahead of main, run the promotion. Requires NEW-09 live first, otherwise it automates a path nobody has exercised."
  "NEW-12|chore: archive migrate.yml and update ADR 008 and the promotion runbook|S3 - Hardening|priority:p2|After NEW-07..NEW-09 are proven: disable migrate.yml (keep history), update ADR 008 for CI-driven migrations and staging-as-rehearsal, replace the promotion runbook with the automated flow. Documentation cleanup, not a safety change."
  "NEW-13|readings: run the pipeline against a real provider and review output quality|S1 - Product: a real reading, locally|priority:p0|Blocked by NEW-04. Set READINGS_PROVIDER to the real adapter with a key, enable READINGS_GENERATION_ENABLED, generate one reading with your own birth data, and read all 11 sections. The question this answers is whether the product concept works — it cannot be answered against the fixture, whose prose is chart-grounded by construction."
  "NEW-14|security: audit and document map tile provider licensing|S3 - Hardening|priority:p2|NEXT_PUBLIC_MAP_TILE_URL is configurable and its licensing is unreviewed (README 'Launch limitations'). Document the provider's terms in docs/setup/03-geocoding-and-maps.md."
  "NEW-15|readings: content review workflow with at least one astrologer before the paid tier|S4 - Content completion|priority:p0|The product sells astrological readings. A domain expert must validate output quality before money changes hands. Ties to #109 (eval harness) and #111 (override tooling). Run it on a sample of real readings before enabling paid generation in production."
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
# Machine-readable plan line, plus a human line. Assertions grep the PLAN| lines.
plan() { printf 'PLAN|%s|%s|%s\n' "$1" "$2" "${3:-}"; }
would() { if [[ "$APPLY" -eq 1 ]]; then printf '  DO:    %s\n' "$*"; else printf '  would: %s\n' "$*"; fi; }
skip() { printf '  skip:  %s\n' "$*"; }
phase_enabled() { [[ -z "$ONLY" || "$ONLY" == "$1" ]]; }

# GitHub label listing: one jq read, verified non-empty, with retries.
# The earlier `gh label list | grep -Fxq` form returned false negatives
# intermittently, which would have made preflight rewrite existing labels.
labels_json() {
  local attempt=0 out=""
  while [[ $attempt -lt $RETRIES ]]; do
    out="$(gh label list --repo "$REPO" --limit 200 --json name 2>/dev/null || true)"
    if [[ -n "$out" ]] && printf '%s' "$out" | jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
      printf '%s' "$out"; return 0
    fi
    attempt=$((attempt+1)); sleep 1
  done
  return 1
}

label_exists() {
  local name="$1" json
  json="$(labels_json)" || { say "  WARN: could not read labels; assuming '$name' exists to avoid a destructive write"; return 0; }
  printf '%s' "$json" | jq -e --arg n "$name" 'any(.[]; .name == $n)' >/dev/null
}

issue_is_open() {
  local n="$1" state
  state="$(gh issue view "$n" --repo "$REPO" --json state -q .state 2>/dev/null || echo MISSING)"
  [[ "$state" == "OPEN" ]]
}

# One bulk read of every open issue's labels, cached for the run.
# The per-issue form made 60+ gh calls and treated a transient failure as
# "label absent" — which turned a read error into a WRITE (add a priority the
# issue already had, or skip removing one it still carries). One call, verified
# non-empty, and a failed read aborts instead of guessing.
LABEL_CACHE=""
load_label_cache() {
  [[ -n "$LABEL_CACHE" ]] && return 0
  local attempt=0 out=""
  while [[ $attempt -lt $RETRIES ]]; do
    out="$(gh issue list --repo "$REPO" --state all --limit 500 --json number,labels 2>/dev/null || true)"
    if [[ -n "$out" ]] && printf '%s' "$out" | jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
      LABEL_CACHE="$out"; return 0
    fi
    attempt=$((attempt+1)); sleep 1
  done
  say "FATAL: could not read issue labels after $RETRIES attempts — refusing to guess (a failed read looks like an absent label)."
  exit 1
}

issue_has_label() {
  local n="$1" label="$2"
  load_label_cache
  printf '%s' "$LABEL_CACHE" \
    | jq -e --argjson n "$n" --arg l "$label" \
      'any(.[]; (.number == $n) and (any(.labels[]; .name == $l)))' >/dev/null
}

# Labels for one issue, from the cache — used by the bulk phases.
issue_labels() {
  local n="$1"
  load_label_cache
  printf '%s' "$LABEL_CACHE" | jq -r --argjson n "$n" '.[] | select(.number == $n) | .labels[].name' 2>/dev/null
}

MILESTONE_CACHE=""
load_milestone_cache() {
  [[ -n "$MILESTONE_CACHE" ]] && return 0
  local attempt=0 out=""
  while [[ $attempt -lt $RETRIES ]]; do
    out="$(gh issue list --repo "$REPO" --state open --limit 500 --json number,milestone 2>/dev/null || true)"
    if [[ -n "$out" ]] && printf '%s' "$out" | jq -e 'type=="array" and length>0' >/dev/null 2>&1; then
      MILESTONE_CACHE="$out"; return 0
    fi
    attempt=$((attempt+1)); sleep 1
  done
  say "FATAL: could not read issue milestones after $RETRIES attempts."
  exit 1
}

issue_current_milestone() {
  local n="$1"
  load_milestone_cache
  printf '%s' "$MILESTONE_CACHE" | jq -r --argjson n "$n" \
    '.[] | select(.number == $n) | (.milestone.title // "")' 2>/dev/null | head -n1
}

milestone_exists() {
  local title="$1"
  gh api "repos/$REPO/milestones?state=all&per_page=100" \
    --jq ".[] | select(.title == \"$title\") | .number" 2>/dev/null | grep -q .
}

# Dedupe by key: an existing issue whose title contains the key, or matches exactly.
issue_number_for_key() {
  local key="$1" title="$2"
  gh issue list --repo "$REPO" --state all --limit 300 --json number,title 2>/dev/null \
    | jq -r --arg k "$key" --arg t "$title" \
      '.[] | select((.title == $t) or (.title | contains($k))) | .number' \
    | head -n1
}

# ---------------------------------------------------------------------------
# Phase 1 — preflight
# ---------------------------------------------------------------------------

preflight() {
  step "Phase 1 — preflight"
  command -v gh >/dev/null || { say "FATAL: gh not installed"; exit 1; }
  command -v jq >/dev/null || { say "FATAL: jq not installed"; exit 1; }
  gh auth status >/dev/null 2>&1 || { say "FATAL: gh not authenticated"; exit 1; }
  gh repo view "$REPO" >/dev/null 2>&1 || { say "FATAL: cannot access $REPO"; exit 1; }

  say "repo: $REPO"
  say "mode: $([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY-RUN)"
  say "only: ${ONLY:-<all phases>}"

  # Canonical priority labels must already exist: abort rather than invent a
  # parallel taxonomy (the v3 bug).
  local bad=0
  for label in priority:p0 priority:p1 priority:p2 priority:p3; do
    if label_exists "$label"; then say "assert ok: $label"; else say "FATAL: missing label '$label'"; bad=1; fi
  done
  [[ $bad -eq 1 ]] && { say "Aborting — create the missing labels and re-run."; exit 1; }

  # New status labels. status:merged is deliberately not introduced: if the code
  # merged, close the issue. status:needs-triage is left alone.
  for label in status:todo status:in-progress status:blocked status:awaiting-promotion; do
    if label_exists "$label"; then
      say "label exists: $label"
    else
      plan preflight "create-label" "$label"
      would "gh label create '$label'"
      if [[ "$APPLY" -eq 1 ]]; then gh label create "$label" --repo "$REPO" >/dev/null; fi
    fi
  done

  for entry in "${MILESTONES[@]}"; do
    local title="${entry%%|*}" desc="${entry#*|}"
    if milestone_exists "$title"; then say "milestone exists: $title"
    else
      plan preflight "create-milestone" "$title"
      would "create milestone '$title'"
      if [[ "$APPLY" -eq 1 ]]; then
        gh api --method POST "repos/$REPO/milestones" -f title="$title" -f description="$desc" -f state=open >/dev/null
      fi
    fi
  done
}

# ---------------------------------------------------------------------------
# Phase 2 — close
# ---------------------------------------------------------------------------

close_issues() {
  phase_enabled close || return 0
  step "Phase 2 — close (${#CLOSE_LIST[@]} issues)"
  local entry n reason comment
  for entry in "${CLOSE_LIST[@]}"; do
    n="${entry%%|*}"; reason="${entry#*|}"
    if issue_is_open "$n"; then
      plan close "close" "#$n"
      would "comment + close #$n"
      if [[ "$APPLY" -eq 1 ]]; then
        comment="Closing as part of backlog alignment (scripts/align-backlog.sh).

Reason: $reason.

Reference: docs/audit/open-issues-by-milestone-2026-11-11.md"
        gh issue comment "$n" --repo "$REPO" --body "$comment" >/dev/null
        gh issue close "$n" --repo "$REPO" --reason completed >/dev/null
      fi
    else
      skip "#$n (already closed or missing)"
    fi
  done
}

# ---------------------------------------------------------------------------
# Phase 3 — labels
# ---------------------------------------------------------------------------

relabel() {
  phase_enabled labels || return 0
  step "Phase 3 — labels"
  local n count=0
  for n in $(gh issue list --repo "$REPO" --state open --label "status:ready" --limit 200 --json number -q '.[].number' 2>/dev/null || true); do
    plan labels "ready-to-todo" "#$n"
    would "gh issue edit #$n: -status:ready +status:todo"
    if [[ "$APPLY" -eq 1 ]]; then
      gh issue edit "$n" --repo "$REPO" --remove-label "status:ready" --add-label "status:todo" >/dev/null
    fi
    count=$((count+1))
  done
  say "  ($count issues relabelled status:ready -> status:todo)"

  local entry num new_pri old
  for entry in "${REPRIORITIZE[@]}"; do
    num="${entry%%|*}"; new_pri="${entry#*|}"
    if ! issue_is_open "$num"; then skip "reprioritize #$num (not open)"; continue; fi
    for old in priority:p0 priority:p1 priority:p2 priority:p3; do
      if [[ "$old" != "$new_pri" ]] && issue_has_label "$num" "$old"; then
        plan labels "remove-priority" "#$num:$old"
        would "gh issue edit #$num: -$old"
        if [[ "$APPLY" -eq 1 ]]; then gh issue edit "$num" --repo "$REPO" --remove-label "$old" >/dev/null; fi
      fi
    done
    if issue_has_label "$num" "$new_pri"; then
      skip "#$num already $new_pri"
    else
      plan labels "add-priority" "#$num:$new_pri"
      would "gh issue edit #$num: +$new_pri"
      if [[ "$APPLY" -eq 1 ]]; then gh issue edit "$num" --repo "$REPO" --add-label "$new_pri" >/dev/null; fi
    fi
  done
}

# ---------------------------------------------------------------------------
# Phase 4 — milestones
# ---------------------------------------------------------------------------

move_milestones() {
  phase_enabled milestones || return 0
  step "Phase 4 — milestones"
  local entry n target current
  for entry in "${REASSIGN[@]}"; do
    n="${entry%%|*}"; target="${entry#*|}"
    if ! issue_is_open "$n"; then skip "move #$n (not open)"; continue; fi
    current="$(issue_current_milestone "$n")"
    if [[ "$current" == "$target" ]]; then skip "#$n already in '$target'"; continue; fi
    plan milestones "move" "#$n:$target"
    would "gh issue edit #$n --milestone '$target'  (was: '${current:-<none>}')"
    if [[ "$APPLY" -eq 1 ]]; then gh issue edit "$n" --repo "$REPO" --milestone "$target" >/dev/null; fi
  done
}

# ---------------------------------------------------------------------------
# Phase 5 — new issues
# ---------------------------------------------------------------------------

file_new_issues() {
  phase_enabled new-issues || return 0
  step "Phase 5 — new issues (${#NEW_ISSUES[@]})"
  local entry key title milestone priority body existing
  for entry in "${NEW_ISSUES[@]}"; do
    IFS='|' read -r key title milestone priority body <<<"$entry"
    existing="$(issue_number_for_key "$key" "$title")"
    if [[ -n "$existing" ]]; then skip "$key '$title' (already #$existing)"; continue; fi
    plan new-issues "create" "$key"
    would "gh issue create $key: '$title' [$milestone]"
    if [[ "$APPLY" -eq 1 ]]; then
      gh issue create --repo "$REPO" --title "$title" --milestone "$milestone" \
        --label "$priority" --label "status:todo" --body "$body" >/dev/null
    fi
  done
}

# ---------------------------------------------------------------------------
# Phase 6 — report
# ---------------------------------------------------------------------------

report() {
  step "Phase 6 — report"
  say "open issues: $(gh issue list --repo "$REPO" --state open --limit 500 --json number -q 'length' 2>/dev/null)"
  say "by milestone:"
  gh api "repos/$REPO/milestones?state=open&per_page=100" --jq '.[] | "  \(.title): \(.open_issues) open, \(.closed_issues) closed"' 2>/dev/null
  say "by priority:"
  local p
  for p in priority:p0 priority:p1 priority:p2 priority:p3; do
    printf '  %-12s %s\n' "$p" "$(gh issue list --repo "$REPO" --state open --label "$p" --limit 500 --json number -q 'length' 2>/dev/null)"
  done
  say "status:ready remaining (target 0): $(gh issue list --repo "$REPO" --state open --label 'status:ready' --limit 500 --json number -q 'length' 2>/dev/null)"
  say "status:todo now: $(gh issue list --repo "$REPO" --state open --label 'status:todo' --limit 500 --json number -q 'length' 2>/dev/null)"
}

# ---------------------------------------------------------------------------

preflight
close_issues
relabel
move_milestones
file_new_issues
report

if [[ "$APPLY" -eq 0 ]]; then
  say ""
  say "Dry run. Re-run with --apply to perform these changes."
fi
