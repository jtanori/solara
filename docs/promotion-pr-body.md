# Promotion PR body template

Copy this into `gh pr create --body-file`. Replace the bracketed values and keep the Evidence and
Risk sections: they are what a reviewer re-derives the verdict from.

---

## Linked issue

`Closes #<issue>` — or `Refs #<issue>` for a promotion that closes nothing by itself.

## Summary

Promotes `staging` to `main`: **<N> commits, <files>, +<adds> / −<dels>.**

<One paragraph: what is in the batch, and what ships dark. Name the flags that stay off.>

## Merge policy

- [x] Head is `staging`; `promotion-guard` is green (`ancestor` or `content-contained`).
- [x] Merge commit (`--merge`), not squash — ADR 004 keeps the merge commit as the promotion record.
- [x] No back-merge exists or is needed (ADR 014). `needs-back-merge` would mean re-landing the
      missing change on `staging`, not merging `main` into it.

## Evidence

```bash
git log --oneline origin/main..origin/staging           # the commits
git diff --stat origin/main...origin/staging            # the diff
git diff --stat origin/main origin/staging -- drizzle/  # empty = no migration
npx tsx scripts/promotion-ancestry.ts \
  --head "$(git rev-parse origin/staging)" \
  --base "$(git rev-parse origin/main)"                 # ancestor | content-contained
npx tsx scripts/check-branch-policy.ts                  # no drift
gh api repos/<owner>/<repo>/rulesets/<id> --jq ...      # ruleset read-back
```

- CI on the head: `verify` green.
- Staging `/api/ready`: `ok:true`, `migrations:"exact"`, `commit:<sha>`.
- Production after the merge: `/api/version` `commit` matches the merge SHA, `env:"production"`.

## Risk

- Runtime changes: <list, or "none">
- Flags that stay off: <list>
- Migrations: <none | the exact set; a migration-bearing promotion is blocked by #245 until the
  rehearsal path is fixed>

## Rollout / Rollback

After the merge: Vercel deploys the merge SHA, then `GET /api/ready` must report `ok:true` and
`migrations:"exact"`, and `GET /api/version` must report the merge commit and `env:"production"`.
Rollback is the documented alias move or forward fix (ADR 013); there is no down migration.

## Deploy record

`deploy.sh` appends the row to `docs/deploys.md`, comments the shared record on the PR, and creates
the production release marker. If the merge was performed through the GitHub UI, record the merge
SHA, the readiness result and the release tag on this PR by hand.
