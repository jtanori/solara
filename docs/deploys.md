# Deploys

> **Frozen 2026-11-25 (#249).** This file is the historical ledger. New production merges are
> recorded by `.github/workflows/deploy-record.yml`:
>
> - one release per production merge, tagged `deploy/production/<short-sha>`;
> - one comment on the promotion PR (`<!-- deploy-record-workflow -->`), updated in place on a rerun;
> - the workflow job summary.
>
> The workflow verifies that production reports the merge commit (`/api/version`) and that
> `/api/ready` is green before recording `ok`; anything it cannot prove is recorded as
> `FAILED unverified`. It never writes this file, and no workflow commits to `main`.
>
> `scripts/deploy.sh` still posts its own comment (`<!-- deploy-record -->`) and release for a
> scripted deploy, but it no longer appends here by default (`DEPLOY_LOG=-`).

Historical rows below are immutable, written by `scripts/deploy.sh` (#76) between 2026-11-11 and the
freeze.

| when | env | sha | pr | migrations | result | rollback |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-11T07:28Z | staging | `d7d7634` | 133 | none — `No drizzle/ changes` | merged; Vercel success on merge SHA; verify green | n/a — staging has no automatic rollback |
| 2026-11-16T18:40Z | staging | `3eac8c9` | 142 | applied (staging) | ok | — |
| 2026-11-18T23:19Z | staging | `f8f20ae` | 156 | applied (staging) | ok | — |
