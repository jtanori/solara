#!/usr/bin/env python3
"""Label and cross-link the slice 1 Solar issues (#152-#155) and announce them on epic #99.

The planning session could create issues but its integration token is denied issue
PATCH, issue label and issue comment writes (HTTP 403 "Resource not accessible by
integration"), so the four issues landed with correct bodies but no labels and no
numeric cross-links. This finishes that, with readback verification.

It only sets labels and posts issue comments. It never edits a body, closes or
reopens an issue, merges/closes a PR, switches a branch, dispatches a workflow, or
changes a secret, env var, ruleset, deployment or provider/Stripe/mail service.

Usage (any checkout, `gh` authenticated as an account holding Issues: write):
    python3 slice1-link.py            # read-only preflight, writes nothing
    APPLY=1 python3 slice1-link.py    # apply, verifying each write by reading it back

Safe to re-run: labels already present and comments already posted are skipped.
Delete afterwards; GitHub Issues remain the only tracker.
"""
import json, os, shlex, subprocess

REPO = 'jtanori/solara'
PLAN_SHA = '4d6dba053963b39ce18bd6602086dc351949daec'   # commit holding the slice 1 design
MARK = '<!-- solara-solar-slice1 -->'
APPLY = os.environ.get('APPLY') == '1'
PLAN = f'https://github.com/jtanori/solara/blob/{PLAN_SHA}/docs/plan-solar-wheel-facts.md'

ISSUES = {
    152: ('S1-a', 'Persist versioned whole-sign chart facts at save time — migration `0009`, insert-only `reading_chart_facts`, coherence-gated write, read/validation, legacy behaviour unchanged',
          ['type:feature', 'area:backend', 'area:db', 'priority:p1', 'status:ready', 'deploy:required', 'phase:solar'], '—'),
    153: ('S1-b', 'Pure wheel geometry projection — pinned orientation invariant, whole-sign **and** Placidus cusps, bounded chords, label-only collision handling, explicit omissions',
          ['type:feature', 'area:astro', 'area:a11y', 'priority:p1', 'status:blocked', 'deploy:skip', 'phase:solar'], '#152'),
    154: ('S1-c', 'Factual wheel and numerical facts on the reading page — server SVG, bilingual bounded fact blocks reusing `chart.calculation`, edition-aware labelling, honest legacy/high-latitude notices',
          ['type:feature', 'area:ui', 'area:a11y', 'priority:p1', 'status:blocked', 'deploy:required', 'phase:solar'], '#153'),
    155: ('S1-d', 'Factual wheel in the PDF — same geometry through verified `@react-pdf` SVG primitives, Latin-only glyph-checked labels, synchronized parent/child input bounds, manually reviewed snapshots',
          ['type:feature', 'area:ui', 'priority:p1', 'status:blocked', 'deploy:required', 'phase:solar'], '#154'),
}
ORDER = [152, 153, 154, 155]

def table(this):
    rows = []
    for n in ORDER:
        tag, scope, _, dep = ISSUES[n]
        marker = ' **(this issue)**' if n == this else ''
        rows.append(f'| #{n}{marker} | `{tag}` {scope} | {dep} |')
    return ('| Issue | Scope | Depends on |\n| --- | --- | --- |\n' + '\n'.join(rows))

def comment(n):
    tag = ISSUES[n][0]
    return f'''{MARK}
## Slice 1 dependency chain

Created as one of four linear issues for [Solar Return completion](https://github.com/jtanori/solara/issues/99) slice 1 (`{tag}`). Design detail, acceptance criteria, verification commands and named mutation targets: [`docs/plan-solar-wheel-facts.md`]({PLAN}).

{table(n)}

Each is intended to land as one reviewable PR well under 400 changed lines of production code plus tests. Only #152 is `status:ready`; #153-#155 stay `status:blocked` until their predecessor merges, so work is not started against a contract that is still moving.

Related and unchanged by this slice: #81 (hosted PDF/runtime qualification — the wheel adds vector primitives, not a new asset or dependency, but the recorded hosted gates still stand), #103 (bounded genuine-provider sampling, slice 2), #92 (Solar journey browser coverage, slice 4).

Planning only: no implementation, migration, test or build has been run for this design. No provider, Stripe, mail, hosted-migration, deployment, promotion, environment/control or allowance-accounting change is authorized by it.
'''

EPIC = f'''{MARK}
## Slice 1 is planned and filed: #152, #153, #154, #155

The first delivery slice of this epic — saved chart facts and the factual wheel — is now broken into four linear issues, each planned against the current tree at staging `ec5e17ecb5d7e6cbb019a86d64594230e54992c8`. Design detail: [`docs/plan-solar-wheel-facts.md`]({PLAN}); slice map: [`docs/plan-solar-return-completion.md`](https://github.com/jtanori/solara/blob/{PLAN_SHA}/docs/plan-solar-return-completion.md).

{table(None)}

Two findings from planning are worth recording on the epic because they constrain later slices:

- **The PDF can draw real vector geometry.** Verified against the exact packages pinned in `package-lock.json` (`@react-pdf/renderer@4.9.0` re-exports `@react-pdf/primitives@4.4.0`; `@react-pdf/layout@5.2.0` resolves SVG roots, `viewBox` and `preserveAspectRatio`; `@react-pdf/render@4.7.0` paints `Svg`/`G`/`Circle`/`Line`/`Path`/`Text`). Page and PDF can therefore share one projection module instead of two drawings kept equal by hand — which is what makes "page and PDF match" a testable property rather than a visual hope.
- **That same verification forces Latin-only wheel labels.** PDF SVG text renders through the vendored Noto Sans Latin subset, so astrological glyphs would fail the existing `pdfGlyphsSupported` check and turn every download into `409 pdf_glyphs`. Rejected alternatives, including the 0° Aries fallback and rasterization, are recorded with reasons in the plan.

Legacy charts are never recast or backfilled: the facts contract is additive and insert-only, and a chart saved before #152 states honestly that full positions were not saved. Slices 2-4 (genuine-provider evidence path, bilingual content qualification, journey acceptance) get their own detail documents once slice 1 has landed, because slice 1 moves the facts/projection contracts they build on.

No migration, test, build, provider call or deployment has been run for this plan, and none is authorized by it.
'''

def gh(*args, payload=None):
    cmd = ['gh', *args]
    r = subprocess.run(cmd, input=None if payload is None else json.dumps(payload), text=True, capture_output=True)
    if r.returncode:
        print('STOPPED (no retry):', shlex.join(cmd)); print(r.stderr.strip()); raise SystemExit(r.returncode)
    return r.stdout

def api(method, path, payload=None):
    args = ['api', '--method', method, path]
    if payload is not None:
        args += ['--input', '-']
    return json.loads(gh(*args, payload=payload))

def main():
    for n in ORDER + [99]:
        v = api('GET', f'repos/{REPO}/issues/{n}')
        if 'pull_request' in v:
            raise SystemExit(f'#{n} is a PR, not an issue')
        if v['state'] != 'open':
            raise SystemExit(f'#{n} is {v["state"]}; expected open. Re-check the plan before writing.')
    print(f'Plan: label {len(ORDER)} slice 1 issues, post {len(ORDER)} dependency-chain comments, '
          f'and announce the breakdown on epic #99.')
    if not APPLY:
        for n in ORDER:
            print(f'  #{n} {ISSUES[n][0]}: labels {", ".join(ISSUES[n][2])}')
        print('  #99: slice 1 announcement comment')
        print('Read-only preflight complete. Re-run with APPLY=1 to write.')
        return
    for n in ORDER:
        _, tag, want, _ = ISSUES[n]
        cur = api('GET', f'repos/{REPO}/issues/{n}')
        have = [x['name'] for x in cur['labels']]
        missing = [x for x in want if x not in have]
        if not missing:
            print(f'SKIP #{n} ({tag}): labels already applied')
        else:
            # Label add is POST-only, so existing labels are never removed here.
            got = api('POST', f'repos/{REPO}/issues/{n}/labels', {'labels': missing})
            names = [x['name'] for x in got]
            if not set(want) <= set(names):
                raise SystemExit(f'#{n} label readback incomplete: {names}')
            print(f'VERIFIED #{n} ({tag}): labels {", ".join(sorted(set(names)))}')
    for n in ORDER + [99]:
        body = comment(n) if n in ORDER else EPIC
        seen, page = False, 1
        while True:
            batch = api('GET', f'repos/{REPO}/issues/{n}/comments?per_page=100&page={page}')
            seen = seen or any(c['body'] == body for c in batch)
            if len(batch) < 100:
                break
            page += 1
        if seen:
            print(f'SKIP #{n}: cross-link comment already present'); continue
        posted = api('POST', f'repos/{REPO}/issues/{n}/comments', {'body': body})
        if posted['body'] != body:
            raise SystemExit(f'#{n} comment body mismatch on create')
        if api('GET', f"repos/{REPO}/issues/comments/{posted['id']}")['body'] != body:
            raise SystemExit(f'#{n} comment readback mismatch')
        print(f'VERIFIED #{n}: {posted["html_url"]}')
    print('Slice 1 issues labelled and cross-linked; epic #99 updated. No body edit, closure, PR, branch, workflow, secret or deployment change.')

if __name__ == '__main__':
    main()
