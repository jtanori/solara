# Deploys

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
