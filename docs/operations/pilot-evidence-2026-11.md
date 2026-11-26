# Pilot evidence baseline — 2026-11

**Source:** `npm run readings:pilot-evidence` over `.venv/genuine-sampling/` on 2026-11-25.
**Scope:** aggregate receipts only. No prose, no birth inputs, no keys.
**Not qualification.** This is two complete samples and one partial, one case each, Spanish only,
with a stale `contentVersion`. It cannot support editorial approval or B.1.

## Inventory

| Pilot | Profile | Sections | Measured MXN | Uncertain MXN | p95 ms | Failed | Report hash |
|---|---|---|---|---|---|---|---|
| `core-es-go2` | `paid-core-v1` | 9/9 | 0.516237 | 0.000000 | 13 766 | 0 | `9029411b54a8…` |
| `rich-es-go3` | `paid-rich-v1` | 11/11 | 0.751650 | 0.000000 | 13 146 | 0 | `13a16f447bb3…` |
| `rich-es-go2` | `paid-rich-v1` | 10/11 | 0.494760 | 0.417600 | 15 013 | 1 | `db075fa81978…` |
| `core-es-go` | `paid-core-v1` | 0/9 | 0.000000 | 0.084000 | 823 | 1 | `573f93c5c78c…` |
| `core-es` | `paid-core-v1` | 0/9 | 0.000000 | 0.032000 | 858 | 1 | `ec877c19f0c7…` |
| `core-es-ds` | `paid-core-v1` | 0/9 | 0.000000 | 0.032000 | 900 | 1 | `9bb35d8063b7…` |
| `rich-es` | `paid-rich-v1` | 0/11 | 0.000000 | 0.032000 | 1 107 | 1 | `877f3f7945ce…` |
| `rich-es-ds` | `paid-rich-v1` | 0/11 | 0.000000 | 0.032000 | 749 | 1 | `f8cb34eefe1a…` |

The five 0/N pilots carry only receipts; they have no layout value and can be deleted after this
baseline is recorded.

## What the complete samples show

- **core:** 9 sections, 0.516 MXN measured, no repairs, no failed attempts, p95 13.8 s.
- **rich:** 11 sections, 0.752 MXN measured, no repairs, no failed attempts, p95 13.1 s.
- **partial:** `guidance` failed; 0.495 MXN measured plus **0.418 MXN uncertain** (a reserved or
  unknown attempt), p95 15.0 s. The mechanical blockers are `incomplete_report`,
  `invalid_section_schema`, `missing_receipt`, `uncertain_exposure`.

P95 sits at or near the 15 s per-attempt transport bound. That is an operational risk for B.1: a
slower provider day turns the tail into timeouts, which are recorded as uncertain exposure.

## What this is used for

- A2 structural fixtures: page/PDF layout at the recorded block kinds and lengths.
- A3 partial state: the 10/11 report is the only genuine partial.
- A4: this baseline; two samples, not a rate card.

## Limits

- One case (`baseline`) per report; approval requires six.
- `contentVersion` is stale against the current code, so none is approvable.
- Spanish only; English generation is B.2.
- The pilot processor is `TBD-105`; the disclosure is not signed.
- Reports and rendered files stay under `.venv/` (gitignored). The committed structural fixture has
  lengths only.
