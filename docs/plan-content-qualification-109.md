# Content qualification — Spanish first (#109, #105)

Plan of record for the reading-content qualification, revision 2 (2026-11-23). It
records the campaign and its gates; it does **not** authorize provider spend,
activation, a hosted migration, a deployment or a Stripe call. Operational
mechanics stay in [genuine sampling](plan-genuine-sampling.md) and
[paid readings](setup/10-paid-readings.md).

## Decisions

| Topic | Decision |
|---|---|
| Reports per locale | Six, one per corpus case. Enforced by `PAID_EDITORIAL_MINIMUM` and the `sample_count >= 6` database check. |
| Locales | **Spanish first.** English sampling (stage B.2) is deferred to a post-production update; English UI stays available and the switcher remains visible. |
| Profiles | `paid-core-v1` and `paid-rich-v1`. |
| Provider | OpenCode Go endpoint with `deepseek-v4.1-flash` / `deepseek-v4-pro`, `READINGS_THINKING=disabled`. No GPT configuration is retained; the old GPT pilot directories are failed attempts and not evidence. |
| Processor naming | **TBD** (#105). The consent copy is not defined yet; this blocks the sampling campaign because approval binds the profile and payload identity. |
| Reviewer | The operator, who did not author the prompts/content. The schema records the reviewer and evidence but does not verify identity; there is no GitHub-identity or separate-account gate. The approval guide's “no independent-person requirement” refers to identity verification, not this campaign rule. |
| Approval database | A local disposable database. Hosted recording is a later, separate authorization. |
| Budget | Campaign authorization: 20 MXN total. Each invocation is capped at 10 MXN **and** at the remaining balance. A retry is a new pilot id with its own separate authorization, outside the 20 MXN. |

## Evidence on disk

The gitignored `.venv/genuine-sampling/` holds eight pilots. Only three matter:

| Pilot | State | Use |
|---|---|---|
| `pilot-2026-11-core-es-go2` | 9/9 sections | realistic core page/PDF structure |
| `pilot-2026-11-rich-es-go3` | 11/11 sections | realistic rich page/PDF structure |
| `pilot-2026-11-rich-es-go2` | 10/11 | honest partial/failure states |

All are one case (`baseline`), Spanish, with stale `contentVersion` values, so none
is approvable. They are still the only genuine output available and drive
presentation, PDF, cost and failure-state work without another provider call.

## Part A — preparation, zero provider calls

1. **Evidence tool** — scan the pilot directories, validate each report against
   `paidEvaluationSchema`, recompute hashes, print completeness, exposure, repairs,
   latency and an `approvable-now` flag. No network, database or prose output.
2. **Presentation/PDF structures** — a local render harness plus committed
   *structural* fixtures (section keys, block kinds, lengths) from the complete
   reports; layout tests at realistic lengths. No prose committed.
3. **Partial and failure states** — the 10/11 report drives the saved-partial UI and
   PDF: honest notice, no regeneration, no canonical promotion, no allowance reset.
4. **Cost/latency baseline** — aggregate-only doc from the receipts; explicitly not
   qualification.
5. **Free-path harness** — disposable database driver for the real free journey,
   fixture-ready today, real provider later by configuration only.
6. **Disclosure and processor qualification** (#105) — naming, retention, endpoint,
   subprocessors and the Spanish-first copy. Finalize before sampling; a
   `policyVersion`/`POLICY_REVISION` bump invalidates prior evidence.
7. **Frozen configuration** — [`.env.pilot.example`](../.env.pilot.example) and this
   document. No prompt, schema, model or price edit during the campaign. The
   example carries `policyVersion: "TBD-105"`; the sampler refuses it
   (`sampling_profile_unqualified`) until #105 replaces it.

## Part B — sampling

### B.1 Spanish (planned)

Two invocations, six cases each:

```bash
DOTENV_CONFIG_PATH=.env.pilot npm run readings:sample -- \
  --pilot qual-2026-11-core-es --profile paid-core-v1 --locale es \
  --cases baseline,fold-earlier,fold-later,southern,leap-day,polar-natal \
  --max-spend-mxn 10 --authorize-pilot

DOTENV_CONFIG_PATH=.env.pilot npm run readings:sample -- \
  --pilot qual-2026-11-rich-es --profile paid-rich-v1 --locale es \
  --cases baseline,fold-earlier,fold-later,southern,leap-day,polar-natal \
  --max-spend-mxn 10 --authorize-pilot
```

Before the rich run, edit `.env.pilot`: `READINGS_PAID_PROFILE=paid-rich-v1`.
`dotenv` override loads the file after the shell, so an exported value does not
win, and a mismatch is refused as `sampling_profile_mismatch`.

The six free-path documents come from the journey harness (#226). Fixture mode is free and
local; the real-provider mode is the same command with the pilot's provider variables exported
and two explicit flags. The harness refuses a non-loopback database, Vercel, production
`NODE_ENV`, and real mode without a cap at or above `6 × 5 MXN`:

```bash
# fixture: deterministic fake transport behind the real adapter, disposable loopback DB
npm run readings:free-path -- --locales es --out .venv/free-path/es.json

# real provider: export the pilot's READINGS_* variables first (the script does not read .env)
npm run readings:free-path -- --locales es --real-provider --authorize-real \
  --max-spend-mxn 30 --out .venv/free-path/es-real.json
```

Then evaluate, review twelve samples (six per profile) with every rubric criterion
at 2, record two local approvals, and qualify six free-path documents. Measured
pilot rates suggest roughly 8 MXN total; the authorized ceiling is 20.

### Budget ledger (authorized: 20 MXN)

`--max-spend-mxn` is **per invocation**, not cumulative. Before each run, set it
to `min(10, remaining)`; after the run subtract the printed `exposureMxn`:

| Run | Cap | Remaining before |
|---|---|---|
| `core-es` | `min(10, 20)` | 20.00 |
| `rich-es` | `min(10, remaining)` | 20.00 − core exposure |

A sealed or failed run needs a **new pilot id and a fresh authorization**; it is
not funded from this 20 MXN. Never raise the cap in an existing pilot directory
(`sampling_run_mismatch`).

B.1 does not start until the #105 copy is signed and `contentVersion`/`configHash`
are frozen.

### B.2 English (deferred)

Post-production. Until it is done, generation must fail closed for `en` even if
Spanish generation is enabled (separate issue). English UI and stored documents are
unaffected.

Enforced at runtime by `READINGS_GENERATION_LOCALES` (#224): unset means `es` only; an
empty or unrecognised value enables nothing. The free service, paid admission and the paid
worker all refuse before a permit is reserved, and the client sees the generic
"generation unavailable" shape with the locale recorded only in the log.

## Gates

1. Disclosure signed; configuration frozen.
2. Two Spanish reports complete, no mechanical blockers.
3. Operator signs twelve sample reviews.
4. Two approval rows validate and are recorded locally.
5. Free-path evidence recorded; flags still off.

Activation is a separate authorization and is not implied by an approval row.
