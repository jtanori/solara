#!/usr/bin/env bash
# land-audit-docs.sh — land the audit/plan documentation onto `staging` safely.
#
# Why this exists: bringing files across with `git checkout <sha> -- docs/ scripts/` replaces entire
# directories and drags in unrelated history. This script names every file explicitly, then *proves*
# the result before it lets you push.
#
# Usage:
#   bash scripts/land-audit-docs.sh --dry-run          # show what would happen, change nothing
#   bash scripts/land-audit-docs.sh --yes              # do it: branch, commit, push, open PR
#   bash scripts/land-audit-docs.sh --yes --no-push    # commit locally only
#
# Options:
#   --branch <name>   target branch name           (default: docs/db-auth-audit)
#   --from <ref>      commit/branch to copy files from
#                     (default: origin/arena/8f0da984-solara, else 87b01ac)
#   --base <branch>   integration branch           (default: staging)
#   --yes             skip the confirmation prompt
#   --no-push         stop after the local commit
#   --no-pr           push but do not open a PR
#   --dry-run         preflight + plan only
#
# Safety rules enforced here:
#   * refuses to run on top of the base branch or any protected branch
#   * refuses a dirty working tree
#   * only ever stages the 12 known files
#   * aborts if the staged diff touches anything outside that list
#   * aborts if the staged diff deletes more than 1 line (only BACKLOG.md's stale header line)
set -uo pipefail

REPO="jtanori/solara"
BASE="staging"
BRANCH="docs/db-auth-audit"
FROM=""
YES=0
PUSH=1
PR=1
DRY=0

# ---- the only files this operation is allowed to touch -----------------------
FILES=(
  BACKLOG.md
  docs/audit-database-integration.md
  docs/audit/deep-audit-2026-11.md
  docs/audit/epic-79-addendum.md
  docs/audit/portable-audit-prompt.md
  docs/auth-neon-assessment.md
  docs/operations/local-sync-and-issue-triage.md
  docs/plan-issue-52-database-provisioning.md
  docs/plan-neon-auth-migration.md
  scripts/epic79-addendum.sh
  scripts/fix-milestone-routing.sh
  scripts/label-issues.sh
)
EXPECTED_FILES=12
MAX_DELETED_LINES=1   # BACKLOG.md's "Last updated" header line is replaced

PR_TITLE="docs: database + deep audits, fix plans, Neon Auth decision, ops runbook, 42 issues indexed"
PR_BODY="Docs and helper scripts only — 11 new files plus the BACKLOG index. No src/, drizzle/, .github/, package.json or existing-script changes, so no migration is required."

# ---- output helpers ----------------------------------------------------------
if [[ -t 1 ]]; then C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_OFF=""; fi
ok()   { printf '%s  ok%s   %s\n'   "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s  warn%s %s\n'   "$C_YEL" "$C_OFF" "$*"; }
die()  { printf '%s  FAIL%s %s\n'   "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
step() { printf '\n%s== %s%s\n' "$C_DIM" "$*" "$C_OFF"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }

# ---- args --------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --from)   FROM="$2";   shift 2 ;;
    --base)   BASE="$2";   shift 2 ;;
    --yes|-y) YES=1;       shift ;;
    --no-push) PUSH=0; PR=0; shift ;;
    --no-pr)  PR=0;        shift ;;
    --dry-run) DRY=1;      shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ---- preflight ---------------------------------------------------------------
step "preflight"

git rev-parse --git-dir >/dev/null 2>&1 || die "not a git repository"
groot=$(git rev-parse --show-toplevel 2>/dev/null) || die "cannot determine repo root"
cd "$groot" || die "cannot cd to $groot"
ok "repo: $groot"

current=$(git branch --show-current)
[[ -n "$current" ]] || die "detached HEAD — check out a normal branch first"
ok "current branch: $current"

if [[ "$current" == "$BASE" || "$current" == "main" || "$current" == "$BRANCH" ]]; then
  die "refusing to run while on '$current' — switch to any other branch first (e.g. 'git switch main')"
fi

if [[ -n "$(git status --porcelain)" ]]; then
  printf '\n%s\n' "Working tree is not clean:"
  git status --short | sed 's/^/    /'
  die "commit, stash or discard these first — this script starts from a clean tree"
fi
ok "working tree clean"

if [[ "$(git rev-parse --is-shallow-repository)" == "true" ]]; then
  warn "shallow clone: history is truncated, so 'merge-base' and ancestry checks are unreliable"
  warn "  (run 'git fetch --unshallow' once for full history; not required by this script)"
fi

for f in gh; do
  command -v "$f" >/dev/null 2>&1 || { [[ $PR -eq 1 ]] && die "'$f' not found (needed to open the PR; use --no-pr)"; }
done

step "fetch"
git fetch origin "$BASE" --quiet || die "git fetch origin $BASE failed"
git fetch origin "refs/heads/*:refs/remotes/origin/*" --quiet 2>/dev/null || true
ok "origin/$BASE at $(git rev-parse --short "origin/$BASE")"

# the local base branch must match the remote before we branch off it
if git show-ref --verify --quiet "refs/heads/$BASE"; then
  local_sha=$(git rev-parse "$BASE")
  remote_sha=$(git rev-parse "origin/$BASE")
  if [[ "$local_sha" != "$remote_sha" ]]; then
    warn "local $BASE ($(git rev-parse --short "$local_sha")) != origin/$BASE ($(git rev-parse --short "$remote_sha"))"
    if [[ $DRY -eq 1 ]]; then
      dim "    dry-run: would fast-forward local $BASE to origin/$BASE"
    else
      git switch --quiet "$BASE" || die "cannot switch to $BASE"
      git merge --ff-only "origin/$BASE" --quiet || die "local $BASE has diverged from origin — resolve manually"
      git switch --quiet "$current"
      ok "fast-forwarded local $BASE to origin/$BASE"
    fi
  fi
fi

# content parity between base and main — informational, because this repo promotes by merge
if git show-ref --verify --quiet refs/remotes/origin/main; then
  if [[ "$(git rev-parse "origin/$BASE^{tree}")" == "$(git rev-parse 'origin/main^{tree}')" ]]; then
    ok "origin/$BASE and origin/main have identical content trees"
  else
    warn "origin/$BASE and origin/main differ in content — normal during a promotion window"
  fi
fi

step "source"
if [[ -z "$FROM" ]]; then
  if git show-ref --verify --quiet refs/remotes/origin/arena/8f0da984-solara; then
    FROM="origin/arena/8f0da984-solara"
  else
    FROM="87b01ac"
  fi
fi
git rev-parse --verify --quiet "${FROM}^{commit}" >/dev/null || die "source ref '$FROM' not found (fetch it or pass --from <sha>)"
src_sha=$(git rev-parse --short "${FROM}^{commit}")
ok "copying from $FROM ($src_sha)"

missing=0
for f in "${FILES[@]}"; do
  if ! git cat-file -e "${FROM}:${f}" 2>/dev/null; then
    warn "missing in $FROM: $f"; missing=1
  fi
done
[[ $missing -eq 0 ]] || die "source ref does not contain every required file"
ok "all ${#FILES[@]} files exist in the source"

step "verify the source files are what we expect"
# guard against copying something that differs from the base in an unexpected way
for f in scripts/label-issues.sh scripts/fix-milestone-routing.sh scripts/epic79-addendum.sh; do
  if git cat-file -e "origin/$BASE:$f" 2>/dev/null; then
    warn "$f already exists on origin/$BASE and will be overwritten"
  fi
done
for f in src/db/schema.ts drizzle/0000_initial.sql .github/workflows/migrate.yml scripts/deploy.sh; do
  a=$(git rev-parse "${FROM}:${f}" 2>/dev/null || echo MISSING)
  b=$(git rev-parse "origin/${BASE}:${f}" 2>/dev/null || echo MISSING)
  [[ "$a" == "$b" ]] || warn "$f differs between $FROM and origin/$BASE — this script does NOT touch it"
done

step "plan"
dim "  branch : $BRANCH   (from origin/$BASE)"
dim "  files  : $EXPECTED_FILES (11 new + BACKLOG.md modified)"
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  die "branch '$BRANCH' already exists locally — delete it ('git branch -D $BRANCH') or use --branch <other>"
fi
if [[ $PUSH -eq 1 ]] && git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  die "branch '$BRANCH' already exists on origin — use --branch <other>"
fi
ok "no conflicting local or remote branch"

if [[ $DRY -eq 1 ]]; then
  step "dry run complete — nothing was created"
  dim "  re-run with --yes to perform the operation"
  exit 0
fi

if [[ $YES -ne 1 ]]; then
  printf '\nCreate %s from origin/%s, commit %d files, push' "$BRANCH" "$BASE" "$EXPECTED_FILES"
  [[ $PR -eq 1 ]] && printf ', open a PR to %s' "$BASE"
  printf '? [y/N] '
  read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted."; exit 1; }
fi

# ---- act ---------------------------------------------------------------------
step "create branch"
git switch --quiet -c "$BRANCH" "origin/$BASE" || die "cannot create $BRANCH from origin/$BASE"
ok "on $BRANCH ($(git rev-parse --short HEAD))"

step "stage files"
git checkout "$FROM" -- "${FILES[@]}" || die "copying files from $FROM failed"
git add -- "${FILES[@]}" || die "git add failed"
ok "staged ${#FILES[@]} files"

step "gate: staged diff must match the expected shape"
mapfile -t changed < <(git diff --cached --name-only)
unexpected=()
for f in "${changed[@]}"; do
  keep=0
  for allowed in "${FILES[@]}"; do [[ "$f" == "$allowed" ]] && keep=1; done
  [[ $keep -eq 1 ]] || unexpected+=("$f")
done
if [[ ${#unexpected[@]} -gt 0 ]]; then
  printf '%s\n' "${unexpected[@]}" | sed 's/^/    /' >&2
  die "staged diff contains files outside the allowlist (above) — aborting, nothing was committed"
fi
ok "no files outside the allowlist"

added=$(git diff --cached --numstat | awk '{a+=$1} END{print a+0}')
deleted=$(git diff --cached --numstat | awk '{d+=$2} END{print d+0}')
if [[ "$deleted" -gt "$MAX_DELETED_LINES" ]]; then
  git diff --cached --numstat | awk '$2>0 {printf "    %s (deleted %s)\n", $3, $2}' >&2
  die "$deleted lines deleted (limit $MAX_DELETED_LINES) — this looks like a directory replace, not a file copy"
fi
changed_outside=0
for f in $(git diff --cached --name-only); do
  case "$f" in
    src/*|drizzle/*|.github/*|package.json|package-lock.json|scripts/deploy.sh|scripts/check-setup.mjs|scripts/check-remote-setup.mjs)
      changed_outside=1 ;;
  esac
done
[[ $changed_outside -eq 0 ]] || die "a protected path is staged (src/, drizzle/, .github/, package.json or an existing script)"
ok "+$added / -$deleted lines, ${#changed[@]} files, no protected paths"

step "commit"
git -c user.name="$(git config user.name || echo "${USER:-agent}")" \
    -c user.email="$(git config user.email || echo "${USER:-agent}@localhost")" \
    commit --quiet -m "$PR_TITLE" || die "commit failed"
ok "commit $(git rev-parse --short HEAD)"

step "post-commit verification"
final_del=$(git diff --numstat "origin/$BASE"..HEAD | awk '{d+=$2} END{print d+0}')
final_files=$(git diff --name-only "origin/$BASE"..HEAD | wc -l | tr -d ' ')
[[ "$final_files" -eq "$EXPECTED_FILES" ]] || die "expected $EXPECTED_FILES changed files vs origin/$BASE, got $final_files"
[[ "$final_del" -le "$MAX_DELETED_LINES" ]] || die "unexpected deletions in final diff"
ok "$final_files files, -$final_del lines vs origin/$BASE"
git --no-pager diff --stat "origin/$BASE"..HEAD | sed 's/^/    /'

if [[ $PUSH -eq 0 ]]; then
  step "done locally (--no-push)"
  dim "  review:  git show --stat HEAD"
  dim "  push:    git push -u origin $BRANCH"
  exit 0
fi

step "push"
git push -u origin "$BRANCH" || die "push failed"
ok "pushed $BRANCH"

if [[ $PR -eq 1 ]]; then
  step "pull request"
  existing=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    ok "PR already open: #$existing"
    pr_url=$(gh pr view "$existing" --repo "$REPO" --json url --jq .url)
  else
    pr_url=$(gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" \
      --title "$PR_TITLE" --body "$PR_BODY") || die "gh pr create failed"
    ok "PR opened"
  fi
  printf '\n%s\n' "$pr_url"
  cat <<EOF

Next:
  gh pr checks $(basename "$pr_url") --repo $REPO --watch
  ./scripts/deploy.sh --pr <num> --env staging      # docs-only: migration step will be skipped
EOF
else
  step "done (--no-pr)"
  dim "  open a PR manually against $BASE"
fi
