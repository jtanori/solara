# Bounded genuine sampling (S2-a, #103)

> Plan for the bounded, explicitly invoked, default-off path that runs the
> existing synthetic corpus through the **real** interpretation pipeline and
> writes genuine evidence for the existing evaluation tooling.
>
> This document is the design gate. It does not authorize a provider call, a
> budget, an activation, a deployment or an editorial approval. Execution needs
> a separate, explicit authorization from the operator.

## 1. Purpose

The evaluation CLI (`scripts/evaluate-paid-readings.ts`) is offline: it can
produce a synthetic report and diff/compare reports, but it cannot call a
provider. `paid-core-v1` and `paid-rich-v1` are implemented, dispatched by a
database worker, and bound to an editorial approval gate. What is missing is a
way to obtain **genuine** provider output, with honest receipts, for the
existing evaluation and review tooling (#109).

This slice adds only that path:

- explicit, one-shot CLI; no route, worker, test, build or deploy can trigger it;
- reuses the production prompt, schema, payload minimization, permit/receipt,
  repair and unknown-exposure rules;
- writes an evidence file that is schema-identical to a synthetic report but
  unmistakably `source: "provider"`;
- never writes an approval, never consumes a user allowance, never touches a
  hosted database.

## 2. Non-goals

- No activation of `READINGS_GENERATION_ENABLED` or
  `READINGS_PAID_GENERATION_ENABLED`.
- No production database, migration or `paid_reading_*` table access.
- No user allowance, subscription, consent or entitlement mutation.
- No paid route, worker, cron, `after()` or background promise.
- No editorial sign-off. `validateEditorialApproval` remains the only approval
  gate and still rejects synthetic sources.
- No second provider implementation and no new dependency.

## 3. Authorization and envelope

Decided by the operator on 2026-11-22 (recorded on #103 and #109):

| Item | Value |
| --- | --- |
| Launch order | es-first; one reading is generated in exactly one locale |
| Pilot scope | one complete sample per profile: `paid-core-v1` (9 sections) and `paid-rich-v1` (11) |
| Sample case | one corpus case per run, chosen explicitly |
| Locale | `es` for the pilot; `--locale en` is allowed for a later authorized parity run |
| Hard cap | 10 MXN per invocation; the pilot total is two explicit invocations (≤20 MXN) |
| Coverage without spend | the full six-case corpus × both locales runs under fake transport in tests |
| Editorial qualification | #109, separately authorized; amended sample is 3 es + 1 en parity per profile |

The CLI hard cap is **per invocation**. The 20 MXN pilot total is the sum of the
two explicitly authorized profile runs; a third invocation or a new pilot id is
a new authorization. There is deliberately no hidden cross-process aggregate
state: every spend is an explicit, capped invocation.

The CLI must refuse to start unless **all** of these are present:

- `--pilot <id>` — a non-empty operator-chosen pilot identifier;
- `--authorize-pilot` — an explicit acknowledgement, not implied by env;
- `--max-spend-mxn <n>` — a positive cap, never above the 20 MXN hard cap;
- `--cases <id,...>` — explicit corpus cases, never "everything by default";
- `READINGS_PROVIDER=chat-completions`;
- `READINGS_PROCESSOR_PROFILE`, `READINGS_API_BASE_URL`, `READINGS_API_KEY`;
- `READINGS_CHEAP_MODEL`, `READINGS_STRONG_MODEL`, `READINGS_MODEL_PRICES`;
- `READINGS_PAID_PROFILE` matching `--profile` (or `--profile` defaulting to it).

It also refuses when `VERCEL` is set or `NODE_ENV=production`, and refuses an
unknown profile, an unknown case, a non-integer cap or a cap that would not
cover one admitted attempt.

The shipped price table prices only `fixture-1`; a real pilot therefore requires
the operator's processor profile, model IDs, aliases and price table. That is the
same non-secret configuration the worker already requires.

## 4. Architecture

```
scripts/sample-genuine-readings.ts     CLI: flags, env guard, refusal codes
        │
        ▼
src/readings/sampling.ts               ledger + orchestration
        │
        ├── scripts/lib/paid-evaluation-corpus.ts   corpus facts/hashes
        ├── src/readings/generate.ts                assembleSectionPrompt
        ├── src/readings/schemas.ts                 schema + validation
        ├── src/readings/execution.ts               dispatchAttempt
        └── src/readings/paid-policy.ts             paidGenerationConfig
```

The orchestrator is a pure function of injected dependencies
(`config: PaidGenerationConfig`, `corpus`, `provider`, `options`). Tests can run
it without environment variables or network. The CLI is the only place that
reads `process.env`.

The section loop mirrors `executePaidRun` (not `generateReadingDocument`,
which is gated by the app kill switch):

1. primary `dispatchAttempt` with the section schema validator;
2. one repair attempt only when the primary output is schema-invalid;
3. stop the sample on any halt, provider error, unknown settlement, budget
   breach or unusable repair;
4. never redispatch a slot that already has a settled receipt.

## 5. Ledger and crash semantics

The pilot uses a **file ledger**, not the database. This keeps the pilot out of
hosted state and out of the paid tables.

Output directory (default `.venv/genuine-sampling/<pilot>`):

| File | Content |
| --- | --- |
| `run.json` | pilot id, format version, profile, locale, cases, cap, contentVersion, configHash, startedAt |
| `ledger.jsonl` | append-only records: `run`, `permit`, `receipt` |
| `report.json` | `paid-evaluation/2` report, replaced atomically after each settled sample |
| `lock/` | exclusive directory with the writer pid; a stale lock is removed by the operator after verifying no process is running |

A `permit` record carries `{id, caseId, locale, section, phase, model,
reservedMicros}`. A `receipt` record carries `{id, basis, costMicros, model,
usage, latencyMs, code, outcome}`. Both are written with `fsync`.

Crash rules:

- **A permit without a receipt is unresolved exposure.** The next run refuses
  with `sampling_exposure_unresolved`; it never replays the slot.
- **An `unknown` receipt is uncertain exposure.** The next run refuses with
  `sampling_unknown_exposure`; no retry, no refund.
- **A `not_dispatched` receipt** is safe by construction but still stops the
  run; the operator inspects before deciding.
- **Completed samples are never regenerated.** `report.json` is the skip list.
- **A settled sample is reconstructed** from its valid checkpoints if the
  process died after the last receipt but before the report write.
- **A partially settled sample resumes only the missing slots.** Every settled
  slot keeps its original receipt and output; the per-section state machine
  (`complete` / `resumable` / `blocked`) decides before the first dispatch.
- **A sample with a terminal receipt is sealed.** Any `invalid` + repair,
  `unknown`/`not_dispatched` receipt, or repair without a primary means no
  sequence of calls can complete the sample. The next run refuses
  `sampling_sample_incomplete` before any call, even if `report.json` was
  deleted. The pilot directory is archival evidence: start a new `--pilot` id
  to retry; never delete individual ledger lines.
- **A budget halt is an authorization boundary, not a resume.** `run.json` binds
  the cap, so a run that stops on `sampling_budget_exhausted` cannot be retried
  with a larger cap in the same directory (`sampling_run_mismatch`), and a
  same-cap retry is refused as an incomplete sample. Start a new `--pilot` id;
  this is a new authorization and cannot double-spend.
- **A schema-invalid primary + invalid repair** records a failed section, stops
  the run (bounded spend) and writes the sample as evidence. It is explicitly
  not approvable and is sealed under the previous rule.
- A corrupt or unmatched `run.json` refuses rather than starting a second
  configuration in the same directory.

## 6. Money

- `costMicros` comes from `dispatchAttempt`/`costMicros`, never from prose.
- Every permit reserves the configured full input cap plus
  `MAX_OUTPUT_TOKENS_PER_SECTION`, exactly as production.
- Measured receipts are charged at measured cost; `unknown` receipts are charged
  at the reserved quote; unresolved permits are charged at the reserved quote.
- Before every permit: `exposure + reserved <= cap`; otherwise
  `sampling_budget_exhausted` and no send. The cap is per invocation.
- After every settlement: `dispatchAttempt` compares the cumulative exposure with
  the cap; a breach stops the run.
- `paidGenerationConfig` already rejects any configuration whose per-run worst
  case (all primaries + all repairs) exceeds 10 MXN. The pilot cap is separate
  and stricter.
- No refund, clamp or re-price. Real spend is reported separately from
  reservations.

## 7. Evidence

The report is a strict `paidEvaluationSchema` object:

- `source: "provider"`;
- `processor: config.profile.name`;
- `models: config.settings.models`;
- `configHash: config.fingerprint`;
- `contentVersion: config.contentVersion`;
- `corpusHash`, `schemaHash`, `promptHashes`, `facts` from the frozen corpus;
- one `EvaluationSample` per settled case/locale, in manifest order, with all
  expected sections (failed sections included);
- every attempt receipt, including repair and failure states.

It is validated with `paidEvaluationSchema.parse` before every atomic write.
`evaluationHash` is printed for the operator and matches the review tooling.

The existing `readings:evaluate --report <report.json>` then produces the review
packet, metrics and per-sample mechanical blockers. The CLI prints
`approval: "NOT APPROVED"` and writes no approval record.

## 8. Privacy

- The corpus digest is the existing `paidDigest` / `outboundDigest`; it carries
  derived positions, aspects, profection and transit facts only.
- The name, email, birth date/time, place and coordinates never enter a prompt,
  a ledger record or the report. `paidEvaluationSchema` re-applies
  `outboundDigest` on `facts`.
- The ledger stores provider prose and receipts, not the raw prompt or request
  body. Prompt identity is already bound by `promptHashes`.
- The CLI prints only counts, codes, cap, exposure and the report hash. It never
  prints the key, base URL, processor profile JSON or chart input.

## 9. Failure codes

Stable, non-secret codes (the CLI maps them to a non-zero exit):

| Code | Meaning |
| --- | --- |
| `sampling_authorization_missing` | a required flag/env is absent |
| `sampling_configuration_unavailable` | `paidGenerationConfig()` rejected the configuration |
| `sampling_profile_mismatch` | `--profile` and `READINGS_PAID_PROFILE` disagree |
| `sampling_case_unknown` | `--cases` names a case not in the frozen corpus |
| `sampling_cap_invalid` | non-positive, fractional or above the 10 MXN per-invocation hard cap |
| `sampling_run_mismatch` | existing `run.json` does not match the requested run (including the cap) |
| `sampling_ledger_invalid` | unparsable or schema-invalid ledger line |
| `sampling_exposure_unresolved` | a permit has no receipt |
| `sampling_unknown_exposure` | an `unknown` receipt is present |
| `sampling_budget_exhausted` | the next permit would exceed the per-invocation cap |
| `sampling_sample_incomplete` | a section failed, a repair was unusable, or the sample is sealed |
| `sampling_locked` | another live process holds the pilot lock |
| `sampling_output_exists` | a report already exists for a different corpus/config hash |
| `sampling_output_invalid` | `report.json` is unparsable or schema-invalid |

## 10. Tests and mutations

Fake transport only; zero provider calls.

Tests:

1. refusal without `--authorize-pilot`, cap, pilot, cases or configuration;
2. cap below the first quote → no send, `sampling_budget_exhausted`;
3. provider throws after send → `unknown` receipt, run stops;
4. resume over an unresolved permit refuses and does not call the provider;
5. resume over an `unknown` receipt refuses;
6. resume skips a completed sample and only calls the missing one;
7. one-locale run never emits the other locale;
8. report identity: `source: "provider"`, processor/models/config/content hash,
   `paidEvaluationSchema` parses;
9. no chart input in any outbound prompt, digest, ledger line or report byte
   (sentinel corpus); `facts` deep-equals the frozen safe digest;
10. invalid primary + invalid repair → failed section, run stops, sample is
    mechanically incomplete, no approval;
11. synthetic report cannot be relabelled as provider (the existing
    `validateEditorialApproval` rejects it);
12. the three recovery rows: complete ledger reconstructs without calls, a
    mid-sample crash resumes only the missing slots, an invalid or
    `not_dispatched` receipt refuses before any call;
13. the full six-case corpus runs in both `es` and `en` under fake transport,
    with no mechanical blockers;
14. a lock owned by a live pid (including an `EPERM` pid) is honoured;
15. the documented refusal table: unknown case, corrupt ledger, corrupt report,
    report identity mismatch, and the `--max-spend-mxn 20` refusal;
16. budget exhaustion and schema failure remain distinct codes.

Named mutations for the PR:

- `sampling-authorize-bypass` — remove the `--authorize-pilot` check; the refusal
  test must fail.
- `sampling-cap-bypass` — drop the `exposure + reserved` guard; the cap test must
  fail.
- `sampling-unresolved-replay` — turn the unresolved-permit throw into
  `continue`; the unresolved test must fail.
- `sampling-budget-mismatch` — map `cost_ceiling*` to
  `sampling_sample_incomplete`; the cap test must fail.
- `sampling-terminal-replay` — remove the `sampleState === "blocked"` guard; the
  terminal-receipt recovery test must fail.
- `sampling-locale-leak` — hardcode a locale or iterate both; the locale and
  six-case tests must fail.
- `sampling-pii` — serialise the corpus cases (including their inputs) into the
  prompt; the sentinel test must fail.
- `sampling-lock-eperm` — restore `catch { return false; }`; the live-pid lock
  test must fail on a non-root runner.
- `sampling-cap-20` — raise the hard cap back to 20 MXN; the parser test must
  fail.

## 11. Operator procedure

1. Use an isolated shell, never Vercel, never production.
2. Set the provider/processor/model/price variables for the intended profile.
3. Run one sample at a time:

   ```bash
   npm run readings:sample -- \
     --pilot pilot-2026-11-es \
     --profile paid-core-v1 \
     --locale es \
     --cases baseline \
     --max-spend-mxn 10 \
     --authorize-pilot
   ```

4. Inspect `run.json`, `report.json` and the printed exposure.
5. If the command reports `sampling_sample_incomplete`, the pilot directory is
   sealed archival evidence: start a new `--pilot` id to retry. Never delete
   individual ledger lines or the report to force a retry.
   If it reports `sampling_budget_exhausted`, do not raise the cap in place:
   `run.json` binds the cap, so the directory refuses a different cap with
   `sampling_run_mismatch`, and a same-cap retry is an incomplete sample. Start
   a new `--pilot` id with a fresh authorization.
6. Optionally produce the review packet:

   ```bash
   npm run readings:evaluate -- --report .venv/genuine-sampling/pilot-2026-11-es/report.json
   ```

7. Repeat for `paid-rich-v1` only after the core sample is understood. Each
   invocation has its own 10 MXN cap; the two-sample pilot total is ≤20 MXN.
8. Keep both generation flags off throughout. Send the report to #109 review;
   the CLI does not approve it.

## 12. Acceptance checklist

- [ ] No provider call from a test, build, CI job or deploy.
- [ ] CLI refuses without explicit authorization and a cap; `--max-spend-mxn 20`
      is refused.
- [ ] The ledger halts on unresolved and unknown exposure and never replays
      either.
- [ ] All three recovery rows are covered: complete reconstruct, partial
      resume, terminal refuse.
- [ ] Budget exhaustion and schema failure keep distinct codes.
- [ ] A budget-exhausted run is sealed; a larger cap in the same directory is
      refused and a new pilot id is required.
- [ ] Budget accounting uses reservations and receipts, never prose estimates.
- [ ] Report parses against `paidEvaluationSchema` and is `source: "provider"`.
- [ ] No chart input, key, base URL or raw prompt in prompts, ledger, report or
      console.
- [ ] One locale per run; both locales and all six cases covered by the fake
      suite.
- [ ] A live lock owned by another user is not evicted.
- [ ] Tests pass with `RUN_INTEGRATION_TESTS` unset (no database needed).
- [ ] `typecheck`, `lint` and the named mutation runs recorded in the PR.
- [ ] `deploy:skip`: no route, worker, migration or runtime import.
