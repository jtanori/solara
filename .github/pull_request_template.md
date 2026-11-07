# Pull request

## Summary
<!-- What does this PR change and why? Link the issue. -->

## Linked issue
Closes #<!-- issue number --> — <!-- title -->

## Branching and merge policy
- [ ] This PR targets `staging` (feature → staging → main). Direct PRs to `main` are only for promoting `staging`.
- [ ] Branch name follows `<type>/<issue-number>-<slug>` (e.g. `feat/13-usage-guide-role-scope`).
- [ ] Merge method will be **squash** with auto-delete head branch (repository Settings → General → Pull Requests: `allow_squash_merge:true`, `allow_merge_commit:false`, `allow_rebase_merge:false`, `delete_branch_on_merge:true` — target, not yet enforced; verify via `gh api repos/jtanori/solara --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,delete_branch_on_merge}'`).
- [ ] Branch protection (target, not yet applied) requires PR, `verify` status check, conversation resolution, linear history, and blocking force-push/deletion. See `docs/decisions.md` ADR 001 and ADR 004.

## Evidence
- [ ] `npm ci` + `npx drizzle-kit migrate` (CI does this on a disposable DB)
- [ ] `npx next typegen`
- [ ] `npm exec tsc -- --noEmit --pretty false`
- [ ] `npx eslint src tests --max-warnings=0`
- [ ] `npx tsx --test tests/*.test.ts` (or `RUN_BILLING_INTEGRATION_TESTS=1` when touching billing)
- [ ] `npm run build` succeeds
- [ ] Smoke checks (CI `verify` job): `GET /blueprint` → 404, `GET /setup` → 404, `GET /usage-guide` → 404 outside development, and no internal-doc content leaked (`EL PROYECTO DE SOLARA` absent). For internal-doc link gating also verify homepage/dashboard/footer contain no `/blueprint`, `/setup`, `/usage-guide` links outside development.
- Paste local command output or CI run link:

## Test plan
<!-- How was this tested? What was manual QA? Which locales/browsers? -->
- [ ] Existing tests pass
- [ ] Added/updated tests for new behavior (if applicable)
- [ ] Manual QA in `development` and `production` (`NODE_ENV`) modes — note which routes and roles were checked

## Risk
<!-- What could break? Is it backward-compatible? Feature-flagged? -->
- Risk level: <!-- low / medium / high -->
- Mitigations:

## Rollout / Rollback
- Rollout: merge to `staging` → QA on staging → promotion PR `staging → main` → Vercel production deploy. Secrets are per-environment (never use prod secrets locally; previews do not access prod data).
- Rollback: revert squash commit on `staging`/`main` or promote previous `staging` commit; rolling back code does **not** automatically reverse a migration — plan compatibility and restore per `docs/setup/01-foundation-and-deployment.md`.
- Operational runbook updated: <!-- yes / no / N/A -->

## Checklist
- [ ] No secrets committed (`.env` never committed; `.env.example` contains placeholders only)
- [ ] Docs updated (`README.md`, `docs/setup/*`, `docs/decisions.md`, `BACKLOG.md` when issues change) and `BACKLOG.md` links resolve
- [ ] No mocked/seed code in `src/` (keep in `scripts/`)

---
Target branch for this PR is `staging`. The `main` branch is protected and deploys production via Vercel; see `docs/decisions.md` ADR 001 and `docs/setup/01-foundation-and-deployment.md`.
