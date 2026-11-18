#!/usr/bin/env python3
"""One-shot tracker reconciliation tool (operator-run) — GitHub Issues stay authoritative.

Applies the housekeeping plan agreed for the Solar-first direction: adds `phase:*` scheduling
labels, records the current disposition and evidence boundary on each open issue (original text
preserved in a collapsed section), and closes only the issues whose implementation/decision
acceptance is evidenced by merged PRs at the audited staging commit.

It edits issue titles/bodies/labels, posts issue comments and closes issues. It never merges or
closes a PR, switches or renames a branch, dispatches a workflow, changes a secret/env/ruleset,
deploys, promotes, or calls a provider/Stripe/mail service.

Usage (from any checkout, with `gh` authenticated as an account holding Issues: write):
    python3 tracker-reconciliation.py             # read-only preflight, writes nothing
    APPLY=1 python3 tracker-reconciliation.py     # apply, with per-issue readback verification

Safe to re-run: an identical update is skipped, a changed issue scope stops the run, and a
closure whose body digest no longer matches the audited snapshot is refused. Delete this file
after applying; it is a tool, not a backlog, and must not become a second source of truth.
"""
import hashlib, json, os, shlex, subprocess

REPO = 'jtanori/solara'
BASE = 'ec5e17ecb5d7e6cbb019a86d64594230e54992c8'          # staging audited for this plan
MARK = '<!-- solara-housekeeping-2026-11 -->'
APPLY = os.environ.get('APPLY') == '1'
CI = 'https://github.com/jtanori/solara/actions/runs/44242502628'

COMMON = ('Current sequence: Solar Return -> payments -> Free/Premium. Auth/mail acceptance testing follows the other '
 'critical features and still precedes public signup. All four products (Solar, Lunar, Natal, Synastry) remain '
 'pre-production scope; the other three are discussed after Solar. #143 is the first post-production follow-up. '
 'A phase label is scheduling only: not verification, not risk acceptance, not activation, and not permission to spend '
 'or deploy. Material security/privacy/money risks take precedence over the phase. This reconciliation was a read-only '
 'audit at ' + BASE + '; it ran no new application tests, migrations, provider/Stripe calls or hosted checks.')

PHASES = {
 'phase:solar':            ('D4C5F9', 'Solar Return completion — current product focus'),
 'phase:payments':         ('BFDADC', 'Payments work, after Solar Return and before tier expansion'),
 'phase:launch-validation':('FBCA04', 'Later pre-launch qualification — not verified and not waived'),
 'phase:post-production':  ('C2E0C6', 'Deferred follow-up; #143 is first after production'),
 'phase:scope-decision':   ('FEF2C0', 'Optional account/product scope awaiting an operator decision'),
 'phase:maintenance':      ('C5DEF5', 'Separate maintenance queue; material security risk takes precedence'),
}

SOLAR99 = """## Current direction — operator confirmed

**Complete Solar Return first, then payments, then Free/Premium.** Auth/mail acceptance testing follows the other critical features and still precedes public signup. Lunar Return, Natal Chart and Synastry are discussed after Solar is complete; all four remain pre-production scope. This supersedes the old execution order and any implicit-generation assumption. It does not authorize live provider/Stripe spending, hosted migration, activation or deployment.

### Baseline, not work to rebuild

PRs #148, #149 and #151 (staging `ec5e17ecb5d7e6cbb019a86d64594230e54992c8`) implement explicit consented generation, lifetime-Free accounting, immutable page/PDF documents, separate paid core/rich editions, durable paid execution, annual profections and return-instant transits, and exact-version editorial tooling. Synthetic/fake-provider evidence is not genuine output qualification or production readiness.

### Remaining Solar outcome

- Known birth time, correct input/time-zone resolution, exact deterministic return calculation and a private save.
- A **factual** wheel plus accessible numerical table derived from the selected saved chart/edition, consistent on page and PDF. Today's wheel is decorative. Paid snapshots carry full facts; newly saved base charts need an explicit additive/versioned Whole-sign facts contract. No GET-time recasting, backfill, rehashing, snapshot rewriting or unauthorized Placidus. Label house system, natal-vs-return context and omissions; keep longitude anchors/orientation correct; move colliding labels with leaders, not anchors; never draw natal-return cross-aspects as return-only chords.
- A **bounded genuine-provider** sampling/export path into evaluation, reusing the existing interpretation, validation, permit/receipt and unknown-exposure safeguards. The current evaluation CLI only prepares synthetic/imported evidence.
- Genuine English/Spanish content review and real cost/latency/repair evidence: six complete reviewed reports per locale for each offered paid profile/configuration, pinned to exact profile/content/model/config. No fabricated approval and no separate-human/identity gate.
- A complete save -> explicit consent/Generate -> progress -> immutable report -> matching PDF journey, exercised with controlled verified accounts/synthetic entitlements before real checkout.

### Contracts to preserve

1. Saving, payment success/webhooks, GETs, language switching, navigation and downloads never generate; only an explicit verified entitled-owner Generate does. Paid-first never spends Free.
2. Facts are deterministic; the model receives minimized derived facts, not raw identity/birth input. Derived facts and prose remain privacy-sensitive, not anonymous.
3. Paid Placidus facts/prose are separate immutable editions, never merged over Free Whole-sign prose or substituted with latest facts; the frozen manifest defines completeness.
4. Consent, ownership, permits, receipts, failed/unknown exposure, whole-ledger admission, worker halt, no blind redispatch, current-entitlement checks and publication fences stay as merged. Expired entitlement may settle, never dispatch again.
5. Implemented limits remain policy until the tier phase: one lifetime Solar introduction and one paid edition/account/UTC month. The agreed future offer is one lifetime introduction usable on any one of the four products plus one Premium subscription with a larger bounded shared allowance; exact quantities and per-product Free sections are tier-phase decisions, not Solar blockers.

### Child disposition

#100, #106, #108, #110: implemented baseline — closed on that evidence, not to be rebuilt. #103: pipeline implemented; bounded genuine-provider sampling still to plan. #105: consent implemented; named-processor/disclosure qualification open with #82/#85. #109: tooling implemented; genuine sample production and editorial review open. #107: explicit paid generation implemented; real checkout-to-generation acceptance with #10 after Solar. #111: later editorial convenience, not a Solar prerequisite, and no CMS. #143: first post-production task by explicit decision — deferred, not fixed.

### Plan each slice before coding

Every remaining Solar issue must state: verified baseline; user outcome; in/out of scope; concrete data/API/state contracts and the existing code it reuses; old/new data compatibility; ownership/privacy/cost/failure behavior; dependencies and unresolved decisions; measurable acceptance including negative cases; exact scoped and full verification commands; named mutation guards; rollout/rollback and authorization boundaries. Prefer coherent reviewable vertical slices and justify anything materially over ~400 changed lines. Keep preparation separate from separately authorized live execution, and say explicitly when genuine generation is ready to test — synthetic green is not readiness."""

# number -> (phase, status|None to preserve, title|None, note)
UPDATES = {
 10: ('phase:payments','blocked',None,'After Solar completion. Subscription fixtures already exist, so #9 is not an outstanding dependency. Remaining: an explicitly authorized Stripe TEST-mode Checkout, signed webhook plus sync, return to the saved chart, explicit Generate, portal, renewal, cancellation/expiry and failed-payment journey, with local and staging setup documented. No live keys, real customers or money. #143 is deferred separately and is not a prerequisite.'),
 53:('phase:launch-validation','blocked',None,'Rate limiting, backoff and bounded asynchronous hashing are implemented (PR #118 cb791c08e and later fixes), so the original unlimited-login design must not be rebuilt. Open only for the hosted/load acceptance, deferred with auth until critical product features are complete. No fresh staging load test is claimed here.'),
 54:('phase:launch-validation','blocked',None,'Mailbox claim/verification and the mail transport are implemented. Current contract is an explicit fragment-token POST claim — not GET redemption and not login before verification. Hosted delivery and real signup acceptance remain pending with #131 in the later auth phase.'),
 55:('phase:launch-validation','awaiting-promotion',None,'Password reset and session revocation are implemented (PR #125 541d5c817). Real hosted email plus a two-session acceptance check remain pending with #131. Merged code is not acceptance evidence; do not close on the merge alone.'),
 56:('phase:launch-validation','awaiting-promotion',None,'Central strict same-origin enforcement exists (PR #118 and current proxy/request-security tests). Remaining hosted same-origin acceptance belongs to the deferred auth/security validation phase; no new hosted proof was produced by this audit.'),
 57:('phase:launch-validation','blocked',None,'Security headers and nonce CSP are implemented and CSP is still report-only by default. Remaining: real observation, an enforcement decision and integrated hosted acceptance, including browser/PDF compatibility. The historical "no headers" description is obsolete; do not flip enforcement during housekeeping.'),
 58:('phase:launch-validation','needs-info',None,'Staff MFA is not implemented. Deferring auth acceptance testing is not a decision to waive staff protection: record the risk decision and the chosen mechanism here before the later auth phase, so it is not silently dropped.'),
 59:('phase:launch-validation','blocked',None,'Least-privilege separation of application and migration roles needs real hosted role/credential work and is coupled to #60 pools and #63/#90 secret ownership. It cannot be closed from local code. Coordinate the connection-string normalization already merged so roles are not re-derived from stale audit text.'),
 60:('phase:launch-validation','awaiting-promotion',None,'Explicit bounded app/coordination pools, error listeners and hosted verify-full TLS normalization are implemented (PRs #125/#142, tests/db-pool.test.ts, docs/setup/01-foundation-and-deployment.md). Reconcile the remaining hosted acceptance — credentials, roles with #59, and pool behaviour against real Neon — before promotion.'),
 61:('phase:launch-validation','needs-triage',None,'Re-verify each of the three connection-string hygiene items against current code before implementing: TLS/parameter normalization already landed with the pool work (#60), so part of this issue may be stale. Keep the safe-URL helper and secret-scan items only if they are genuinely still absent.'),
 62:('phase:launch-validation','blocked',None,'A recorded backup configuration, retention and one real restore drill require hosted access and an explicit operator authorization. No drill was performed or witnessed by this audit; a written runbook alone does not satisfy it.'),
 63:('phase:launch-validation','needs-info',None,'Single source of truth for DATABASE_URL plus an explicit preview-database policy is an operator/hosting decision (where the secret lives, what preview builds may touch). Record the decision here; implementation follows. Coupled to #59/#90.'),
 64:('phase:launch-validation','awaiting-promotion',None,'Drift, schema and journal verification is implemented (PR #126 14f56dcc0 plus later readiness/deploy fixes, and the exact-SHA rehearsal gate from #120). This is promotion acceptance, not missing implementation. No new hosted check or production promotion was run.'),
 65:('phase:post-production','needs-triage',None,'The schema has changed substantially since this audit (readings, paid editions, permits, receipts, evaluation and audit tables). Re-derive the index list from the current schema and actual query patterns before implementing, rather than executing the historical single-index claim.'),
 66:('phase:post-production','needs-triage',None,'Scope is scheduled expired-session cleanup only. User-facing revoke-all/session listing belongs to #68; share the revocation primitives if that work is selected instead of building two endpoints. Expired sessions already fail authentication, and claim/reset already revoke sessions, so this is hygiene, not an open access hole.'),
 67:('phase:scope-decision','needs-info',None,'Direct signed-in password change is optional scope awaiting an operator selection; it was recommended, not selected. Password reset already provides rotation/recovery and revokes sessions, so the historical claim that account deletion is the only route is obsolete. Do not schedule it ahead of Solar.'),
 68:('phase:scope-decision','needs-info',None,'Owns the explicit user-facing revoke-all and optional session-list feature if selected; #66 owns expired-session cleanup. Existing claim/reset revocation is not a device-management UI. Not approved merely by approving the Solar-first direction — needs an explicit selection.'),
 69:('phase:scope-decision','needs-info',None,'Password-confirmed account deletion is implemented and hardened (PRs #139 c87c3ddea / #142 3eac8c919), so the original unconfirmed-deletion allegation is obsolete. What remains is a decision on staff-role/action reauthentication and idle-session expiry. Do not rebuild deletion or close the unresolved remainder.'),
 70:('phase:launch-validation','awaiting-promotion',None,'Liveness/readiness split with schema, migration and auth checks is implemented (PRs #126/#130 and later manifest updates). Promotion acceptance remains. No new hosted health/readiness or production verification was performed.'),
 71:('phase:launch-validation','needs-triage',None,'Migration/readiness instructions already exist in AGENTS.md and docs/setup. Reconcile the remaining checklist against them — especially which items need actual environment evidence — during launch qualification. Do not fabricate production evidence to close a documentation task.'),
 74:('phase:launch-validation','needs-triage',None,'Journal/schema parity and immutable-applied-migration protection partly landed with the drift checks (#64), the exact-SHA rehearsal gate (#120) and the manifest work in #133/#142. Re-scope to what is genuinely still missing before implementing, and keep it complementary to #64 rather than duplicating it.'),
 75:('phase:launch-validation','blocked',None,'Migration orchestration and hosted acceptance remain open. docs/PR_WORKFLOW.md section 0 is binding: no separate-human, independent-GitHub-identity or required-approval-count gate. Explicit operator authorization, exact-SHA evidence and a SHA-pinned COMMENT review/verdict still apply. This audit changed no environment, ruleset or secret.'),
 76:('phase:launch-validation','blocked',None,'Most fail-closed deploy behaviour is merged, including PR #133 d7d7634b3 — but that PR explicitly left this issue open because the live staging rollback drill was never run. Keep it blocked on that real evidence rather than treating the merge as completion. #136/#146 remain distinct follow-ups.'),
 77:('phase:launch-validation','needs-info',None,'Error tracking and alerting for auth failures/readiness needs an external-service decision (vendor, credentials, alert routing) before implementation. The #52 discovery-by-user motivation stands. No service was selected, provisioned or activated here.'),
 79:('phase:launch-validation','needs-triage','tracking: focused launch qualification after critical product delivery','Re-scoped as the later focused launch-qualification umbrella, not a rule that every historical audit convenience must land before core delivery. Sequence: Solar Return -> payments -> Free/Premium; the other three required products are discussed after Solar; auth/mail acceptance follows the critical features and precedes public signup; #143 is first post-production. Preserve material ownership/privacy, money, calculation, runtime/backup and security qualification. Superseded: the week-by-week schedule, the closed #52 prerequisite, the all-children-must-close rule, and any separate-identity/CODEOWNERS approval gate (docs/PR_WORKFLOW.md section 0, ADR 004). #72/#78 decisions are implemented; #76/#119/#131 still need real external evidence. Nothing missing is marked passed.'),
 81:('phase:solar','blocked','readings: qualify isolated on-demand PDF delivery and factual-chart parity','Storage decision is settled: private on-demand rendering from immutable saved source, isolated, credential-stripped, network-denied, local fonts and bounded CPU/memory/output limits (PRs #149/#151, docs/setup/04-pdf.md). No public bucket or upload feature is required, and ADR 008 is already migrations policy — do not reuse its number. Remaining: factual-wheel page/PDF parity under Solar, plus honest resource/packaging qualification in the eventual hosted runtime. A green local browser/PDF run is not hosted runtime evidence.'),
 82:('phase:launch-validation','needs-info',None,'Retention, export and erasure policy for birth data needs operator/legal decisions (periods, export format, erasure vs. immutable-document retention) before implementation. Interacts with #105 consent wording, saved immutable reports and chart-deletion accounting: erasure must not silently rewrite or re-sign frozen documents. Derived facts and generated prose are personal data, not anonymous output.'),
 83:('phase:payments','needs-triage','billing: qualify bounded subscription state updates','Bounded billing refresh and reading-status polling already exist, and paid generation is durable rather than browser-driven. Keep the real delayed-webhook subscription-UI acceptance with #10 after Solar. No speculative SSE/WebSocket service or PDF artifact queue is required absent measured need. ADR 009 is already the backlog-policy decision; do not reuse its number.'),
 84:('phase:launch-validation','awaiting-promotion',None,'Same-origin checks, per-IP 429 with Retry-After, bounded caching/concurrency, hourly budget and redacted failure handling are implemented (PR #125, tests/places.test.ts), so the historical unguarded-proxy description is obsolete. Reconcile residual release acceptance rather than rebuilding it.'),
 85:('phase:launch-validation','needs-info',None,'Legal pages, sign-up consent copy and SEO metadata need actual content and jurisdiction decisions from the operator; the implementation is straightforward once they exist. Must stay consistent with #82 retention/erasure and #105 named-processor consent — one coherent set of claims, not three contradictory texts.'),
 86:('phase:launch-validation','ready',None,'App-router error boundaries, not-found and loading states are a concrete self-contained UI task. Verify the current src/app tree before implementing (routes changed with readings/PDF work) and keep the Solar page/PDF journey behaviour unchanged except for better failure states.'),
 87:('phase:launch-validation','awaiting-promotion',None,'Structured redacted logging, request IDs and source-level no-console enforcement exist (PR #125 and later hardening). Remaining is release/privacy verification, including that birth data and provider bodies are not logged. This audit is not a fresh exhaustive logging review and makes no legal classification of the data — see #82.'),
 88:('phase:maintenance','needs-triage',None,'Dependency PRs were triaged, not merged: #24/#25/#123 need fresh staging plus runner/artifact compatibility; #26/#28/#32/#34 have failing verify; #35 verify was still in progress at triage; #30/#31/#33 are green but unreviewed; #28/#33 are one coordinated Tailwind pair. Security remediation and the private Picomatch .3 backport came from reviewed #151; its retirement is #150. Preserve dependency-security tests, exact lockfile provenance and audit guards — never weaken them to make an upgrade green. Major upgrades plus the unimplemented SBOM/pinning/alert controls stay separately planned. No fresh audit or upstream-version check is claimed.'),
 89:('phase:scope-decision','needs-info','governance: optional ownership routing and branch hygiene for a solo maintainer','The historical approval requirements are superseded by docs/PR_WORKFLOW.md section 0 and ADR 004: required approvals stay zero for the actual solo-maintainer team, and a SHA-pinned COMMENT review plus verdict with resolved conversation threads is the process. CODEOWNERS, if ever selected, is routing only — never required-code-owner review — and there is no separate identity or extra human gate. Optional routing/branch hygiene can be scoped later; never delete or rename active Arena branches. Node/runtime pinning belongs to #88. No ruleset was changed by this audit.'),
 90:('phase:launch-validation','blocked',None,'Secret inventory, target assignment and rotation policy need real hosted access and an operator decision on where each secret lives and how rotation is proven. Nothing was read, changed or rotated here, and no claim is made about which secrets currently exist.'),
 91:('phase:launch-validation','ready',None,'Typed env validation at boot is a concrete self-contained task. Re-check current env usage first (readings generation, PDF, billing and places added variables since the audit) so the module covers real configuration instead of the historical list, and keep dotenv explicitly off for tests.'),
 92:('phase:solar','needs-info',None,'The merged code already has real-app synthetic browser/page/PDF regression coverage (24 cases at the SHA recorded by PR #151), so the historical "no browser tests" premise is stale. Decide here whether a generic coverage-floor program is wanted at all; it is not automatically a Solar prerequisite. The Solar-focused save -> explicit generation -> saved report/PDF journey tests are planned under #99; genuine LLM acceptance is #103/#109 and hosted PDF evidence is #81.'),
 93:('phase:maintenance','needs-info','db: decide retirement of the unused legacy users.plan column','currentUser() derives plan from verified subscriptions (src/lib/auth.ts) and PDF delivery delegates to saved-edition/ownership policy, so the historical direct-column entitlement allegation is stale. What genuinely remains is an explicit decision plus test for keeping or additively retiring users.plan, which still exists in src/db/schema.ts. Do not drop the column or rewrite applied migrations as housekeeping; saved paid editions must stay readable after expiry.'),
 94:('phase:launch-validation','ready',None,'Incident-response runbook, kill switches and status communication. The generation kill switch and worker halt already exist and are tested, so re-scope around them: document the actual switches, who may operate them and how users are informed. The #52 timeline motivation stands; no new external status service is authorized.'),
 99:('phase:solar','in-progress','epic: complete Solar Return — factual chart, genuine LLM output and saved reports', SOLAR99),
 103:('phase:solar','blocked','readings: finish genuine-provider sampling and pipeline acceptance','The prompt/schema/provider/freeze pipeline is implemented (PRs #127/#139/#148/#151) and digest/privacy/budget/schema/corpus coverage exists. What remains is a bounded genuine-provider sampling and export path into evaluation that reuses the existing payload minimization, permit/receipt, repair and unknown-exposure protections — the current evaluation CLI does NOT call a provider. Plan first: isolated pilot authorization and budget, persistence/crash semantics, evidence format and fake-transport tests. Never bypass production approval or present provider-labelled fixtures that were not really produced by the provider.'),
 105:('phase:solar','needs-info',None,'Versioned named-processor consent, explicit grant/withdrawal and outbound minimization are implemented (PRs #148/#151). Remaining: actual processor/endpoint/retention/disclosure qualification, coordinated with #82/#85, before any authorized live use. Superseded wording: derived facts and account-linked prose may be personal data — the original "computed prose, not personal data / anonymous" framing must not become a contract. Withdrawal does not erase saved documents or restore consumed allowance.'),
 107:('phase:payments','blocked','billing: qualify explicit paid generation after verified checkout','Explicit entitled-owner paid intents, the durable worker and separate immutable Placidus editions are implemented (#151), so "generate automatically on entitlement" and "merge paid prose into Free" are superseded: generation requires an explicit authorized action and paid editions stay separate. Remaining: real test-mode checkout -> verified subscription -> return to the selected chart -> explicit consent/Generate acceptance, with #10 after Solar. Webhooks and GETs never dispatch; checkout success alone is not entitlement; paid-first must not consume Free; cancellation/expiry keep read access; no duplicate generation.'),
 109:('phase:solar','blocked','readings: qualify genuine bilingual reports and exact-version editorial approval','Corpus, diffs, review templates and the exact-version approval gate are implemented (#151, scripts/evaluate-paid-readings.ts, scripts/approve-paid-reading-evaluation.ts, scripts/lib/paid-evaluation-corpus.ts). Remaining acceptance is genuine complete reports with real usage/cost/latency/repair evidence and bilingual editorial review — six complete reviewed reports per locale for each offered paid profile/configuration, pinned to the exact profile/content/model/config. Depends on the genuine sampling path in #103. Synthetic labels, stale signatures, a different profile/config, author self-review or a separate human/account gate cannot substitute. Activation stays separately authorized.'),
 111:('phase:post-production','needs-info',None,'Deferred editorial convenience, not a Solar prerequisite: existing evidence packets and tooling can support content review. If resumed, plan an audited new revision/edition or an explicit override layer — never mutate a frozen document, and the historical overwrite-oriented wording is not permission to rewrite immutable history. No CMS or review-queue platform is required.'),
 119:('phase:launch-validation','blocked',None,'Exact-SHA, mode=migrate, dry_run=false and artifact checks are implemented by PR #120 dd1111270, but that PR explicitly recorded its real workflow acceptance matrix as unverified — an artifact alone does not prove DDL ran. Keep blocked pending an authorized rehearsal with recorded evidence. No workflow dispatch is part of housekeeping.'),
 131:('phase:launch-validation','blocked',None,'Auth/mail configuration and acceptance testing are deferred until the other critical features are complete, but still before public signup. The body reports a historical environment inspection, not a fresh read: do not treat its claims about which mail variables exist as current, and do not change secrets or redeploy during housekeeping. Use explicit operator authorization and the existing secret-safe procedures later.'),
 134:('phase:maintenance','needs-info',None,'Kept as separately scoped workflow improvement. Detailed issue planning does not authorize unrelated workflow edits, new required reviewers/identities or repeated review loops. Preserve the existing evidence-based COMMENT/verdict process and do not bundle this into Solar product implementation.'),
 135:('phase:post-production','ready',None,'Concrete test-hygiene fix: DB-touching tests should fail loudly rather than skip silently when DATABASE_URL is unset, without breaking the documented disposable-loopback workflow. Keep the existing full-validation command shape and RUN_INTEGRATION_TESTS gating intact.'),
 136:('phase:post-production','ready',None,'Concrete deploy-script improvement: add a real dry-run so gates can be rehearsed before committing, and make a missing --yes prompt fail loudly at EOF instead of silently proceeding. Must not weaken the exact-SHA, fail-closed schema-verdict behaviour from #120/#133 or the retry fix in #146.'),
 138:('phase:post-production','needs-triage',None,'Still needs triage: decide the authoritative build-identity source (response header/endpoint vs. append-only docs/deploys.md) and reconcile it with the readiness endpoints from #70 and the exact-SHA rehearsal evidence, so there is one answer to "what is staging running?" rather than a fourth place to guess from.'),
 143:('phase:post-production','ready',None,'Explicit operator decision: FIRST POST-PRODUCTION TASK. Keep open as a consciously deferred checkout pagination defect — not fixed, and not a current pre-purchase gate. The superseded local wording about a repository-wide missing has_more handling is obsolete: anyAcrossPages/collectAcrossPages already exist in the billing state and deletion paths. When resumed, reuse those helpers in a separate checkout change with page-two plus ambiguity/failure tests.'),
 145:('phase:post-production','ready',None,'Follow-up test-robustness item recorded from the PR #142 review (a surviving mutation, non-blocking). Keep it separate from the merged #142 work rather than bundling workflow or lease-pool changes into product slices; add the symmetric lease-pool assertion for the production default wiring and re-run the named mutation to show it now fails.'),
 146:('phase:post-production','ready',None,'Concrete deploy fix: retry the schema-verdict artifact download after the run completes so a completed green verify is not misread as a failed hosted schema check. Keep the fail-closed behaviour when the artifact is genuinely absent, and coordinate with #136 (dry-run) and #76 (live rollback drill) — an actual staging db-remote --check end-to-end run is still required before #76 can close.'),
 150:('phase:maintenance','blocked',None,'PR #151 is merged as ec5e17ecb5d7e6cbb019a86d64594230e54992c8, and the exact-head re-review https://github.com/jtanori/solara/pull/151#pullrequestreview-5950825671 resolved all five threads with a MERGEABLE verdict at a8c653f8bcd4889e9a34135d7080b4656deb8c08 — the sentence in this issue saying that fixed-head thread remains unresolved is historical and superseded. The private .3 backport is still in place with its documented bounded-grammar limits. Keep open pending a VERIFIED upstream replacement; no new registry/advisory/npm-audit check or retirement is claimed by this housekeeping.'),
}

# number -> (body sha256 at audit time, closure note)
CLOSE = {
 72:('8f36c7c629ef68623fa5d50517ca4655e39b10516810de90a40e8463b098f03d',
     'Completed by PR #126 (14f56dcc0d4a459b4be7814b16e340c3d86f40ed): ADR 006 accepted, linked from AGENTS.md and from the auth issues. This closes the identity-decision record only — not auth implementation/testing (#53-#58) and not staff MFA.'),
 78:('9685cf4153ef4cb2a9538ccd88ebf81c75bbfac7924b50f7249b4ca1e92e3055',
     'Completed by PR #126 (14f56dcc0d4a459b4be7814b16e340c3d86f40ed) as **ADR 008**, not the ADR 007 number this issue proposed; migration, deployment, verification and rollback policy is recorded and linked. docs/PR_WORKFLOW.md section 0 supersedes any separate-human/identity approval requirement. Hosted execution and remaining pipeline acceptance stay open in #75/#76/#119.'),
 100:('d2ea8a61311a92beb8a0d906d6b30f3da7da1333c8fe4cbc5a79fdf1f4e575a1',
     'Implementation complete and merged: typed chart/reading documents, blocks and registry (PR #112 c938569ae, PR #127 750a272f2) plus the reviewed generation/presentation work in #148/#149/#151, current at ec5e17ecb5d7e6cbb019a86d64594230e54992c8. tests/chart.test.ts and tests/readings-pipeline.test.ts cover the bounded derived digest, privacy and schema contracts. Genuine-provider output remains #99/#103/#109; derived facts are not claimed anonymous.'),
 106:('ba04c470a51e6d7755d753d9e52365753fb2811ead59973914a20680e02b84fb',
     'Renderer scope completed by PR #149 (e79671a6658b82a1867afdb30cbcaae4b6481bed, whose body closes this issue) and extended by PR #151 (ec5e17ecb5d7e6cbb019a86d64594230e54992c8): the supported block kinds, saved Free/paid editions, bilingual page rendering and pinned PDF fixtures with browser checks all exist. Factual-wheel expansion is remaining #99 work and hosted PDF qualification is #81 — this closure does not make the current decorative wheel factual.'),
 108:('6fe76df050d520f428407841fbe655a197575d130c8ac4178d08a5408d4c0e7d',
     'Cost guards, per-reading budget ceiling and kill switch completed by PR #148 (13a886085aaa901b964e323fe3d2187650be8881) and PR #151 (ec5e17ecb5d7e6cbb019a86d64594230e54992c8): durable permits/receipts, bounded paid allowance, fail-closed pricing/usage validation, retained failed/unknown exposure and dispatch/worker controls, with mutation witnesses in docs/reading-generation-review-fixes.md. Current limits are unchanged. The agreed larger shared allowance is future tier work after payments and is not a reset of this ledger.'),
 110:('56ccf6965728d6ad302374632eaba66092662e479c2d81d9652a0cfa504c1526',
     'Completed by reviewed PR #151 (ec5e17ecb5d7e6cbb019a86d64594230e54992c8): natal-Ascendant traditional annual profections plus transits at the frozen Solar-return instant, with fixture and hand-calculation assertions in tests/annual-facts.test.ts and immutable rich editions. Genuine interpretation quality remains #109. This is not a year-long forecast calendar and not live activation.'),
 128:('9b63315c1133ee6fcbc83b6f4254d86a010c54eef0bef542f764b021dd3f781d',
     'Completed by PR #148 (13a886085aaa901b964e323fe3d2187650be8881). tests/readings-pipeline.test.ts rejects an invalid-usage repair while preserving the original failure reason and the exact primary receipt/measured spend. Refreshed mutation witnesses 128-accept-unusable-repair, 128-drop-primary-receipt and 128-replace-original-reason are recorded in docs/reading-generation-review-fixes.md at 3ffde7fefd339dc55bc5c178363a320ff57f51e6, and these tests remain in the later whole-suite baseline.'),
 129:('c4db3f2d8b5a0f117ffd8b3c54dd4b1d3d66c83ee24b23a5d9ee07862b541d11',
     'Completed by PR #148 and strengthened by PR #151 (13a886085aaa901b964e323fe3d2187650be8881; ec5e17ecb5d7e6cbb019a86d64594230e54992c8). Both tiers halt after the first invalid usage and retain nonzero worst-case exposure; real-adapter fake-HTTP regressions plus the 129-disable-run-halt and 129-zero-unknown-exposure mutation witnesses are in docs/reading-generation-review-fixes.md. The paid worker and transactional admission also inspect the whole attempt ledger. No real-provider qualification is claimed.'),
 132:('af744ffc025a5a3d4042aa524feeb0815afe2a45703a288ae5b4b034ebddaab1',
     'Completed by PR #133 (d7d7634b3670fe5c547bca512cec00e62f9fecd1) using the option accepted in this issue: BACKLOG.md deleted, an ignored on-demand snapshot generator with tests added, references updated and ADR 009 superseding ADR 002. GitHub remains the only execution tracker; do not reintroduce a hand-maintained committed backlog.'),
}
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

def get_issue(n):
    v = api('GET', f'repos/{REPO}/issues/{n}')
    if 'pull_request' in v:
        raise SystemExit(f'#{n} is a PR, not an issue — refusing to close/edit it here')
    return v

def labels_of(v):
    return [x['name'] for x in v['labels']]

def verify(n, payload):
    actual = get_issue(n)
    for key, expected in payload.items():
        got = sorted(labels_of(actual)) if key == 'labels' else actual.get(key)
        want = sorted(expected) if key == 'labels' else expected
        if got != want:
            raise SystemExit(f'Readback mismatch on #{n} ({key}): got {got!r} want {want!r} — stopping')

def main():
    head = api('GET', f'repos/{REPO}/commits/staging')['sha']
    if head != BASE:
        raise SystemExit(f'staging moved to {head}; re-audit before applying. Nothing written.')
    if set(UPDATES) & set(CLOSE):
        raise SystemExit('An issue is both updated and closed; fix the plan.')
    for n, (digest, _) in CLOSE.items():
        v = get_issue(n)
        if v['state'] == 'open' and hashlib.sha256((v['body'] or '').encode()).hexdigest() != digest:
            raise SystemExit(f'#{n} scope changed since the audit; re-audit before closing. Nothing written.')
    print(f'Plan: keep {len(UPDATES)} issues open with phase/status labels and scope notes; '
          f'close {len(CLOSE)} on implementation/decision evidence; create {len(PHASES)} phase labels.')
    if not APPLY:
        for n in sorted(UPDATES):
            print(f'  OPEN  #{n:<4} {UPDATES[n][0]:<24} {UPDATES[n][1] or "preserve status"}')
        for n in sorted(CLOSE):
            print(f'  CLOSE #{n}')
        print('Read-only preflight complete. Re-run with APPLY=1 to write. No PR is merged or closed.')
        return
    phase_ok = True
    for label, (color, description) in PHASES.items():
        try:
            gh('label', 'create', label, '--repo', REPO, '--color', color, '--description', description, '--force')
        except SystemExit:
            phase_ok = False
            print(f'label {label} could not be created; continuing with status labels only')
    for n in sorted(UPDATES, key=lambda x: (x != 99, x)):
        phase, status, title, note = UPDATES[n]
        cur = get_issue(n)
        if cur['state'] != 'open':
            print(f'SKIP #{n}: already closed; never reopened automatically'); continue
        old = cur['body'] or ''
        keep = [x for x in labels_of(cur) if not x.startswith(('status:', 'phase:'))]
        if status:
            keep.append(status)
        else:
            keep += [x for x in labels_of(cur) if x.startswith('status:')]
        if phase_ok:
            keep.append(phase)
        if n == 89:
            keep = [x for x in keep if not x.startswith('priority:')] + ['priority:p3']
        if n == 150:
            keep += ['type:deps', 'area:infra', 'priority:p2']
        keep = list(dict.fromkeys(keep))
        new_title = title or cur['title']
        if MARK in old:
            if note in old and sorted(keep) == sorted(labels_of(cur)) and new_title == cur['title']:
                print(f'SKIP #{n}: identical housekeeping note already applied'); continue
            raise SystemExit(f'#{n} was housekept and then changed; inspect manually instead of overwriting')
        body = (f'{MARK}\n## Current disposition — operator-approved housekeeping\n\n{note}\n\n'
                f'**Scheduling and evidence boundary:** {COMMON}\n\n'
                f'<details>\n<summary>Original request — historical where superseded above</summary>\n\n{old}\n\n</details>\n')
        if len(body) > 60000:
            raise SystemExit(f'#{n} body would exceed the API limit; split the update manually')
        payload = {'title': new_title, 'body': body, 'labels': keep}
        api('PATCH', f'repos/{REPO}/issues/{n}', payload)
        verify(n, payload)
        print(f'VERIFIED #{n}: {phase if phase_ok else "(no phase label)"}, {status or "status preserved"}')
    for n in sorted(CLOSE):
        digest, note = CLOSE[n]
        cur = get_issue(n)
        if cur['state'] != 'open':
            print(f'SKIP #{n}: already closed'); continue
        if hashlib.sha256((cur['body'] or '').encode()).hexdigest() != digest:
            raise SystemExit(f'#{n} changed during housekeeping; stopping before closure')
        comment = (f'{MARK}\n## Implementation/decision acceptance reconciled\n\n{note}\n\n'
                   f'Historical regression baseline: {CI} . This housekeeping ran no new tests, genuine-provider/Stripe '
                   f'calls, hosted qualification or deployment. Remaining product/release acceptance stays open in '
                   f'#99, #10, #81, #103, #105, #109, #131 and the focused launch tracker #79.')
        seen, page = False, 1
        while True:
            batch = api('GET', f'repos/{REPO}/issues/{n}/comments?per_page=100&page={page}')
            seen = seen or any(c['body'] == comment for c in batch)
            if len(batch) < 100:
                break
            page += 1
        if not seen:
            posted = api('POST', f'repos/{REPO}/issues/{n}/comments', {'body': comment})
            if posted['body'] != comment or api('GET', f"repos/{REPO}/issues/comments/{posted['id']}")['body'] != comment:
                raise SystemExit(f'Comment readback failed on #{n}; not closing without its evidence')
        payload = {'state': 'closed', 'state_reason': 'completed',
                   'labels': [x for x in labels_of(cur) if not x.startswith(('status:', 'phase:'))]}
        api('PATCH', f'repos/{REPO}/issues/{n}', payload)
        verify(n, payload)
        print(f'VERIFIED CLOSED #{n}')
    left = api('GET', f'repos/{REPO}/issues?state=open&per_page=100')
    left = [x['number'] for x in left if 'pull_request' not in x]
    print(f'Open issues now: {len(left)} -> {sorted(left)}')
    print('Issue housekeeping verified. No PR merge/close, branch switch, workflow dispatch, secret/env/ruleset change, deployment or provider call.')

if __name__ == '__main__':
    main()
