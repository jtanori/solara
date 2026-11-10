# Deploys

Append-only record written by `scripts/deploy.sh` (#76). Do not edit rows by hand; the script appends
one row per deploy so "what is in production right now?" has an answer without guessing.

| when | env | sha | pr | migrations | result | rollback |
| --- | --- | --- | --- | --- | --- | --- |
