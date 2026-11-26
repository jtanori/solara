# Pilot evidence and presentation fixtures (#225)

**Status:** plan of record for Part A / package A5. Reviewed by the operator; no provider call,
hosted database or migration is authorized by this document.

## Purpose

Use the genuine pilot reports already on disk as engineering evidence without spending on a
provider: an inventory tool, structural fixtures for page/PDF layout, partial/failure states, a
cost/latency baseline, and a frozen pilot configuration. None of this is editorial approval or B.1
qualification.

## What exists

Eight pilots under `.venv/genuine-sampling/` (local, gitignored), all `source: "provider"`,
`es`, one case (`baseline`):

| Pilot | Profile | Sections | Result |
|---|---|---|---|
| `core-es-go2` | core | 9/9 | complete; 0.516 MXN; p95 13.8 s |
| `rich-es-go3` | rich | 11/11 | complete; 0.752 MXN; p95 13.1 s |
| `rich-es-go2` | rich | 10/11 | partial (`guidance` failed); 0.495 measured + 0.418 uncertain; p95 15.0 s |
| five others | core/rich | 0/9 or 0/11 | failed; receipts only |

All are **1/6 cases** (Spanish only), so they cannot pass the editorial gate. Their `contentVersion`
cannot be compared from a shell without the pilot environment, so the inventory reports the gate as
`unknown` rather than guessing. They are still the only genuine output and drive layout, PDF,
partial/failure states and cost/latency work.

## Deliverables

- **A1** `scripts/pilot-evidence.ts` + `scripts/lib/pilot-evidence.ts`: validate, recompute hashes and
  metrics, list blockers, and report the editorial gate per locale (`pass`/`fail`/`unknown`) using
  the same `approvalIssues` the approval path uses; emit the structural fixture. No prose in the
  output.
- **A2** `scripts/render-pilot.ts` + `scripts/lib/pilot-render.ts`: report path → saved-edition page
  HTML and PDF locally; committed `tests/fixtures/readings/pilot-structures-v1.json` with block kinds
  and character counts only.
- **A2b** `scripts/pilot-seed.ts`: import a report into a disposable local database as a free/paid
  edition, so later end-to-end work needs no provider call. Dumps live under `.venv/fixtures/`.
- **A3** partial/failure states: the 10/11 report and synthetic failed/indeterminate states render
  honest notices; no regeneration, canonical promotion or allowance reset.
- **A4** `docs/operations/pilot-evidence-2026-11.md`: aggregate cost/latency baseline from the
  receipts, explicitly two samples and not qualification.
- **A7** `.env.pilot.example` verification and this record.

## Rules

- Reports, dumps and rendered files stay under `.venv/` and are never committed.
- The committed fixture contains section keys, block kinds, character counts and statuses only.
- The content version is computed only when the pilot environment is complete (`READINGS_PROVIDER`,
  processor profile and both models); `--content-version` overrides; otherwise it is `unknown` and
  the gate can never be `pass`.
- The processor name and `policyVersion` remain `TBD-105`; #105 must sign the disclosure before a B.1
  run.

## Exit criteria

- The inventory exits 0 on the eight pilots and reports `gate: fail` for every one: one case instead
  of six, Spanish only, and `content_version_unknown` without the pilot environment.
- A corrupt report fails cleanly, mutation-covered.
- The page and PDF render the core, rich and partial structures; the partial page shows its notice.
- `typecheck`, `lint`, targeted tests and `build` pass.
