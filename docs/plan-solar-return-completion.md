# Solar Return — completion contract and delivery plan

**Product direction recorded 2026-11-11; not evidence of completion or permission
to activate/deploy.** [ADR 011](decisions.md#adr-011--solar-return-first-and-a-shared-four-product-offer)
records the operator's decisions. GitHub Issues remain the execution tracker;
this document defines the product outcome, not a second backlog.

## Scope and sequence

Finish **Solar Return first**, then **payments**, then **Free/Premium**. Discuss
Lunar Return, Natal Chart and Synastry after Solar Return is complete; all four
remain required before production, with payments before the three additions.
Their detailed design and implementation sequence are not settled here.

Auth/mail acceptance testing waits until the other critical features are complete.
This changes development order, not the need for working signup/recovery before
public launch or the regression checks required when changing code. User-system
additions await the operator's selection from the capability inventory; they are
not automatically inserted ahead of Solar Return.

The agreed eventual offer is one lifetime Free introduction usable on **any one
of the four products**, not one free report for each product; one Premium
subscription with a **larger bounded shared generation allowance**; and known
birth times for all chart subjects. The exact Premium quantity and product-specific
Free sections are decided in the tier phase, after payments. Existing Solar-only
Free and one-per-UTC-month paid limits remain the implemented baseline until then.
Do not loosen their accounting or change them incidentally during this work.

## Starting point

At `ec5e17ecb5d7e6cbb019a86d64594230e54992c8`, deterministic Solar calculation,
explicit Free generation, immutable paid core/rich editions, durable paid execution,
page/PDF selection and offline evaluation tooling exist. They should be completed,
not rebuilt. Live generation remains off and genuine provider/editorial/runtime
qualification is not established by synthetic tests.

The reading-page wheel is decorative. Paid editions already freeze detailed
calculation snapshots, but the base saved chart contains only a smaller result;
it is not a full-wheel snapshot. The current evaluation CLI prepares synthetic or
imported evidence; it does not itself run a genuine provider pilot.

## Required Solar Return experience

1. Enter a name/label, birth date, **known birth time**, birth location/time zone,
   selected return year and return location. Keep explicit DST-fold handling and
   reject invalid inputs. No invented noon/midnight or unknown-time mode.
2. Calculate the exact solar return deterministically and save it privately.
   Chart creation alone never calls an LLM or spends a generation allowance.
3. Show a **factual chart visualization** and readable numerical facts, identifying
   the return instant, location, house system and any unsupported calculations.
4. Explicitly choose the interpretation/language and accept the current named-
   processor disclosure before generation. The LLM interprets minimized derived
   facts; it does not calculate positions, choose entitlements or fill missing data.
5. Deliver the existing Solar scope: overview, Sun, Moon, Ascendant, aspects,
   houses, planets, nodes and guidance; the rich profile also includes annual
   profections and transits at the saved return instant. These are not a forecast
   calendar. Preserve core/rich manifests and the existing Whole-sign/Placidus
   authorization boundary; never silently enlarge old editions.
6. Show honest progress, partial/failure states and saved edition history. Paid
   accepted work survives browser closure. Do not promise a retry/refund that the
   current allowance/unknown-spend rules do not support.
7. Reopen the same saved interpretation and download a matching PDF. Viewing,
   refreshing, changing interface language, downloading or navigating never
   generates, translates, spends, or changes an old edition.

## Factual chart visualization — part of Solar completion

- **Source of truth:** the selected saved chart/edition's versioned deterministic
  facts. Paid views use their existing pinned snapshots, not the mutable base
  chart or the current engine. Extend the deterministic Whole-sign save/display
  contract where needed to support full wheels for newly saved base charts.
- **Content:** zodiac/sign-degree ring, calculated body/node positions, Ascendant
  and Midheaven when available, house cusps, and supported aspects from the saved
  calculation. Label the house system and distinguish natal facts from return
  facts. Do not draw cross-aspect lines as if both endpoints were return bodies.
- **Geometry:** longitude drives anchor positions; orientation is explicit and
  tested. Label collision handling may move labels with leader lines, never the
  actual position anchors. Aspect endpoints refer to the correct saved bodies.
- **Consistency:** page and PDF consume the same bounded geometry/fact projection.
  The numerical table and accessible labels remain usable on mobile and without
  interpreting glyphs or color. No network-loaded fonts/images in the PDF worker.
- **Missing/legacy data:** plot only what is actually saved and label omissions;
  show an unavailable/limited visualization rather than fabricated houses or
  planets. No GET-time recasting, silent backfill, rehashing or rewriting old
  documents/snapshots. Any necessary persistence change is additive/versioned.
- **Boundaries:** retain the decorative asset only where clearly ornamental.
  Remove the reading-page decorative disclaimer only for a genuinely factual
  view, not by relabeling the existing SVG. This work does not authorize unpaid
  Placidus computation or new LLM/provider work during rendering.
- **Reuse:** use chart-oriented geometry rather than hardcoded Solar decoration,
  without implementing the other three products or a speculative two-chart UI.

## Delivery slices

1. **Saved facts and visualization:** establish the explicit new/legacy projection
   contract, then implement the factual wheel and numerical/accessibility fallback
   for page and PDF. Preserve existing edition identity and privacy boundaries.
2. **Genuine LLM evidence path:** provide a bounded, explicitly invoked way to run
   the synthetic-input corpus through the real interpretation/validation path and
   export genuine evidence to the existing evaluation tooling. Reuse pricing,
   payload minimization, permit/receipt, repair and exposure protections; do not
   add an unmetered provider shortcut or fabricate an approval. Execution needs
   separate provider/budget authorization and an isolated evaluation environment.
3. **Content qualification:** review genuine English/Spanish reports, fix prompts
   or presentation based on actual output, and collect cost/latency/repair evidence.
   Keep the existing six-complete-reports-per-locale rule for each offered paid
   profile/configuration, plus Free-path qualification. Synthetic fixtures and
   approval for a different profile/configuration are not substitutes. Existing
   tooling can support review; a new editorial queue/CMS is not a prerequisite.
4. **Solar journey acceptance:** exercise save → explicit consent/generation →
   progress → saved report → matching PDF with controlled verified test accounts
   and synthetic subscription entitlements. Do not require real checkout first,
   and do not bypass production authorization to make the demo work. Confirm the
   eventual worker/PDF runtime as part of separately authorized release work.

Each code slice gets focused correctness/ownership/cost tests and applicable
mutation checks, then the authorized restored-tree regression gates. Wheel tests
must catch wrong longitude/orientation, swapped edition facts, and incorrect
aspect endpoints—not only assert that an SVG renders. Keep the larger hosted auth
and real Stripe lifecycle campaigns in their agreed later phases.

## Slice → issue map

Issues are created from this map; each links back to its detail section rather
than duplicating a backlog. Detailed design for slice 1 is in
[Saved chart facts and the factual wheel](plan-solar-wheel-facts.md), including
the verified baseline, the pinned projection invariant, per-issue acceptance
criteria, verification commands and named mutation targets.

**Slice 1 — saved facts and visualization** (four linear issues, detail doc above):

1. `S1-a` persist versioned whole-sign chart facts at save time — additive
   insert-only `reading_chart_facts` table and migration `0009`, coherence-gated
   write, legacy rows unchanged, no backfill or GET-time recast.
2. `S1-b` pure wheel geometry projection — `src/lib/wheel.ts`: anchored
   orientation, whole-sign **and** Placidus cusps, bounded chords, deterministic
   label collision handling that moves labels and never anchors, explicit omissions.
3. `S1-c` factual wheel and numerical facts on the reading page — server SVG plus
   bilingual bounded fact blocks reusing the existing `chart.calculation` path,
   edition-aware house-system labelling, honest legacy/high-latitude notices.
4. `S1-d` factual wheel in the PDF — the same geometry through verified
   `@react-pdf` SVG primitives, Latin-only glyph-checked labels, synchronized
   parent/child input bounds, manually reviewed snapshot regeneration.

**Slice 2 — genuine LLM evidence path** (plan in detail before implementing; it
must not become an unmetered provider shortcut):

5. `S2-a` bounded genuine sampling command — an explicitly invoked, default-off
   path that runs the existing synthetic-input corpus through the real
   interpretation/validation pipeline and writes genuine evidence for the existing
   evaluation tooling. Reuses pricing, payload minimization, permits/receipts,
   repair and unknown-exposure protections; states its own attempt/budget ceiling,
   persistence and crash semantics, and refuses to run without explicit
   configuration. Preparation only: **execution needs separate provider and budget
   authorization** in an isolated evaluation environment, and is never triggered by
   a test, a build or a deploy.
6. `S2-b` evidence export/identity — genuine outputs carry the exact
   profile/content version/model/config identity the existing approval gate
   requires, are distinguishable from synthetic fixtures, and cannot be relabelled
   as provider-produced. No approval is fabricated and no separate-human or
   independent-account gate is introduced.

**Slice 3 — content qualification** (depends on slice 2 actually having run):

7. `S3-a` bilingual content review — review genuine en/es reports against the
   saved facts, fix prompts/presentation where the real output is wrong,
   unsupported or unsafe, and record what was changed and why. Existing tooling can
   support this; no new editorial CMS or review queue is a prerequisite.
8. `S3-b` cost/latency/repair evidence and the six-complete-reports rule — real
   usage, cost, latency and repair evidence per locale for each offered paid
   profile/configuration, plus Free-path qualification. Synthetic fixtures, stale
   signatures, or approval of a different profile/configuration are not
   substitutes. Activation remains separately authorized.

**Slice 4 — Solar journey acceptance** (depends on slices 1–3):

9. `S4-a` end-to-end journey with controlled accounts — save → explicit
   consent/Generate → progress → saved interpretation → matching PDF, using
   controlled verified test accounts and synthetic subscription entitlements. Real
   checkout is **not** a prerequisite here and production authorization is not
   bypassed to make a demo work.
10. `S4-b` runtime/release readiness reconciliation — confirm the eventual
    worker/PDF runtime against the recorded hosted gates as part of separately
    authorized release work (#81, #83), and state plainly what remains
    unqualified. Synthetic green is not readiness; the operator is told explicitly
    when genuine generation is ready to test.

Slices 2–4 get their own detail documents when slice 1 has landed, because slice 1
changes the facts/projection contracts they build on; specifying them against
today's code would plan work that is about to move.

**Completion means genuine usable Solar output, not just a fake-provider green
suite.** Tell the operator when the actual generation journey is ready to test;
state what remains unqualified. Solar feature completion is not approval to
launch the whole four-product platform.

## Deferred boundaries

- Complete ordinary Stripe lifecycle integration after Solar; then implement the
  chosen Free/Premium offer with an explicit versioned allowance transition.
- Checkout pagination (#143) is the **first post-production follow-up**, not a
  current purchase-acceptance gate. The defect is not fixed by this deferral.
- Do not introduce unrelated account conveniences, large admin/editorial systems,
  or low-risk scale work ahead of the core product. Fix materially high-risk
  security, privacy, money or calculation defects when encountered.
- No hosted migration, real provider/Stripe calls, control/environment changes,
  deployment or production promotion is authorized merely by this plan.
