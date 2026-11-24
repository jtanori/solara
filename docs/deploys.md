# Deploys

> **Scheduled for freeze at cutover — not frozen yet.** This file is still the **active** legacy
> record written by `scripts/deploy.sh` until the operator confirms the M5 cutover (the Actions
> deployment owns the stable alias and Deployments-aware monitoring is live). Until that confirmation
> is recorded here, keep appending rows as before and do **not** treat GitHub Deployments as the sole
> authority.
>
> At cutover, add one final row with the cutover date and the cutover run link, and only then stop
> appending. From that moment **GitHub Deployments** (created by the `environment:` key on the deploy
> workflows) and workflow **job summaries** are the authority for what is live and how it got there.
> See [ADR 012](decisions.md#adr-012--readiness-tolerates-schema-ahead-in-production) and
> [ADR 013](decisions.md#adr-013--github-actions-is-the-only-deployer-merging-is-the-deploy), and the
> checklist in [guide 11](setup/11-actions-deploys.md#10-cutover-checklist-proves-the-0-exception).
>
> Historical rows below are immutable; the freeze adds a header and a cutover row, never rewrites
> history. Workflows never commit to `main`, so no deploy ever writes into the deployed tree.

Append-only record written by `scripts/deploy.sh` (#76). Do not edit rows by hand; the script appends
one row per deploy so "what is in production right now?" has an answer without guessing.

This file is the **local** copy. The shared record is a marker comment on the deployed PR
(`<!-- deploy-record -->`) that the script creates or rewrites in place, so it answers the question
for anyone with repository access rather than only for the machine that ran the deploy. Production
merges additionally get a release marker tagged `deploy/production/<YYYYMMDD-HHMM>-<short-sha>`.

If the script cannot publish either one it says so and exits non-zero-worthy output: a record that
only exists on the operator's laptop is the failure #76 was filed about.

| when | env | sha | pr | migrations | result | rollback |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-11T07:28Z | staging | `d7d7634` | 133 | none — `No drizzle/ changes` | merged; Vercel success on merge SHA; verify green | n/a — staging has no automatic rollback |
| 2026-11-16T18:40Z | staging | `3eac8c9` | 142 | applied (staging) | ok | — |
| 2026-11-18T23:19Z | staging | `f8f20ae` | 156 | applied (staging) | ok | — |
