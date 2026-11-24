# Delivery design — saved free readings on the page and in PDF

**Status:** approved for implementation by the operator in this session. Work uses synthetic data and disposable local databases, with generation remaining off. This design is not an implementation-completion claim, activation approval, test report, or replacement backlog. Existing hosted rollout prerequisites and separate activation authorization still apply. Execution status and issue closure remain in [GitHub Issues](https://github.com/jtanori/solara/issues).

**Source baseline:** `staging` tree at `13a886085aaa901b964e323fe3d2187650be8881` (the merged PR #148 tree). Work in this session remains on `arena/78f55298-solara`; do not switch branches or base this work on the unrelated scrypt PR.

**Scope:** [#104](https://github.com/jtanori/solara/issues/104), free sections and locked teasers, and the saved-document page/PDF renderer in [#106](https://github.com/jtanori/solara/issues/106). Exercise paid-document *rendering* with synthetic fixtures, without implementing paid generation, purchasing, storage selection, or entitlement orchestration.

## 1. Which plans already exist, and what this adds

The feature is already described, but the existing documents do not form a complete current delivery specification:

- [`plan-readings-engine-epic.md`](plan-readings-engine-epic.md) supplies the document/block design and the later `overview` + `sun` decision. Its earlier four-free-section, implicit-dispatch, shared-cache, quota, and anonymity assumptions are historical.
- [`audit/reading-features-plan-amendment.md`](audit/reading-features-plan-amendment.md) identified the missing integration. Its suggested lookup by UI locale/newest content version, raw failure display, and Premium-flag PDF behavior must **not** be implemented literally now.
- [`plan-reading-generation-safety.md`](plan-reading-generation-safety.md) and [`setup/09-reading-generation-safety.md`](setup/09-reading-generation-safety.md) remain authoritative for consent, lifetime allowance, canonical identity, publication, deletion, and activation. This design does not reopen those decisions.

This design supplies the missing owner-scoped read contract, deterministic selection, stored-JSON validation, display-state matrix, legacy compatibility, HTML/PDF parity, resource limits, test/mutation requirements, and delivery boundaries. If an implementation needs to depart from these rules, record the reason in its PR rather than silently reverting to a historical plan.

### Verified foundations versus missing work

| Area | Present in the baseline | Work in this slice |
| --- | --- | --- |
| Generation safety | Explicit consent/generate/status/delete routes; durable one-lifetime-free run; disabled-by-default generation | Preserve these boundaries; change presentation and read-only refresh, not dispatch/accounting |
| Persistence | `reading_documents`, unique `(reading_id, locale, content_version)`; canonical `reading_generation_runs.document_id`; legacy adoption in `0006` | Add a bounded, owner-scoped reader; no new schema or historical-row rewrite |
| Document vocabulary | Eleven section keys, five block kinds, statuses, closing questions, frozen locale/version | Validate persisted JSON at runtime; build a minimal display projection |
| Generation validation | Strict, bounded per-section output schemas in `schemas.ts` | Separate persisted-read validation; types and provider-output schemas alone are insufficient |
| HTML | `reading-sections.tsx` already renders the five kinds and skips unknown kinds | Integrate it, improve accessibility, remove raw failure output and misleading purchase promises |
| Reading page | Owned saved chart, illustrative `ReadingNotes`, consent controls | Display the actual selected document, honest state and correct PDF link |
| PDF | Node React-PDF, owner check, independent download quota, private/no-store success response | Render the same selected content; cover failures, budgets, pagination and both languages |
| Teasers | Hand-written en/es copy for all eleven keys; builder stores seven paid teasers for today's digest | Present all nine paid section names, honestly distinguishing unavailable/planned features |
| Tests | Pipeline, corpus, storage, safety, HTML blocks, notes-only PDF tests | Add read-contract, route/browser, PDF extraction/visual, parity and mutation coverage |

In particular, `GenerationStore.status()` returns the **account's** canonical run after checking the requested chart is owned. A completed status on a different owned chart is not a document for that chart. Also, the storage key does **not** contain tier, and `contentVersion` is a hash, not a sortable release number.

## 2. Product rules for this delivery

1. A generated free interpretation contains **only `overview` and `sun`**, including their saved closing questions. A paid subscription does not turn this document into a paid interpretation.
2. Generated prose is read from its saved document. Reading, downloading, changing UI language, subscribing, navigating, or polling must not generate, repair, translate, refresh consent, or consume/reset the lifetime offer.
3. The saved document's language is authoritative for its content, section labels, tables, questions and generated-reading PDF. The interface language controls navigation, consent/status controls and the explanation of a language mismatch.
4. Partial results remain partial. A failed section is not a successful interpretation; no message promises that missing words will arrive or invites an automatic retry.
5. Generation being disabled, consent being withdrawn, or provider configuration changing does not remove access to a valid saved document.
6. Saved charts and the existing illustrative-notes functionality remain usable. They are visibly distinguished from frozen AI output, and existing subscription-gated notes are not silently rebranded as generated Premium content.
7. Nine static paid-topic previews are an honest catalog, not proof that paid generation or every underlying calculation is available. No paid prose is generated, fetched into a free display payload, blurred, or hidden with CSS.
8. All development uses synthetic saved documents, fake providers where needed, and disposable local databases. Email delivery and real AI credentials are unnecessary.

### Explicitly outside this slice

- Paid generation, paid version/storage selection, subscription-triggered work, credits, refunds, monthly quotas, or changed lifetime semantics (#107 and remaining #108 work).
- New astronomical calculations, Placidus upgrades, profections or transits (#110).
- Provider/model/prompt selection, real-provider quality/cost evaluation and editorial enablement (#109).
- Translation or regeneration of existing documents, an archive selector, or automatic legacy adoption/repair on reads.
- A public document API, public sharing, cloud PDF storage, a new queue, or a realtime service unless the resource gate below proves the request-time PDF path unsuitable. Such a result makes the relevant #81/#83 work a prerequisite, not an implicit scope expansion.
- Email QA, unrelated workflow/billing/auth refactors, production promotion or activating generation.

## 3. Architecture: one read model, two rendering adapters

```text
verified server identity + owned reading ID + explicit edition selector
    -> bounded read-only chart/run/document lookup
    -> envelope and section validation
    -> minimal ReadingPresentation projection
         -> server-rendered HTML using the existing block components
         -> React-PDF using PDF-specific Text/View primitives

explicit consent/generate controls -> existing mutation endpoints only
status refresh/polling             -> existing GET status + router.refresh()
```

Use a small server-only loader, a pure validation/projection core, and transport-neutral view types. Proposed paths are `src/readings/reading-view.ts`, `src/readings/stored-document.ts`, and `src/readings/presentation.ts`; use existing equivalent modules if implementation discovers one. Client components import only view **types**, not database, provider, configuration or generation services.

Reuse the existing generation-status semantics rather than copying the state machine. If its private mapper needs extraction into a pure helper for the snapshot reader, keep that change behavior-preserving, retain the existing endpoint tests, and identify the overlap with the reviewed safety code. Presentation completeness is an additional result, not a new interpretation of whether the offer was consumed.

The presentation contract is a discriminated union, not `document?` plus several conflicting flags:

- `saved-reading`: document identity, saved locale, content/chart versions, saved timestamp, tier, validated ordered sections, safe display notices and static preview catalog.
- `chart-notes`: saved chart and explicitly illustrative notes, interface locale, subscription-derived permission for extended legacy notes, and a safe reason no generated document is being displayed.
- A separate availability/status descriptor distinguishes loading/service errors, in-progress work, partial content, other-chart identity and deleted history. It does not turn every absent document into `unused`.

Do not pass raw `ReadingDocument` JSON, `facts`, model mappings, costs, accounting, run settings, failure reasons, consent receipts or attempts to a client component. A server-side structural validator may inspect these; the adapters receive only the approved display fields. Unknown extra fields must not survive a spread operation into JSX, an RSC prop, a JSON response or PDF metadata.

No cross-request cache of private documents, no shared section-cache lookup, no provider preparation, and no `computeContentVersion()` or chart recalculation during a read. Return the DB connection before PDF import/layout/rendering. Rate-limit bookkeeping is permitted; “read-only” here means no generation/consent/allowance/document mutations, not that HTTP throttling cannot update its own counters.

## 4. Deterministic selection and authorization

### 4.1 Read procedure

1. Resolve the verified server user with the existing auth boundary. Validate route/query identifiers as UUIDs, rather than the PDF route's current loose 36-character pattern. No supplied `userId`, tier, locale or content version authorizes content.
2. Establish ownership of `readings.id = requestedId AND readings.user_id = currentUser.id`. Missing and foreign charts are indistinguishable. Never load arbitrary document JSON and check ownership only afterward.
3. Read the user's `lifetime_free` run and its canonical document in an ownership-constrained join. The join must require the document's reading to be the owned requested reading and the run's reading. Fetch only the needed run fields, not settings or accounting. Use one statement/snapshot or a short read-only transaction for related reads; no lifecycle lease or `FOR UPDATE` is needed.
4. If the run points to this reading and a document, select **exactly that ID**. Verify row/document identity, locale, tier and versions before rendering. A bad pointer is not permission to choose another row.
5. If the run points to another owned chart, do not display that chart's prose here. Return a safe link to the original chart and a chart-notes view for the requested chart.
6. If there is no canonical document, distinguish the generation state from saved-row existence. A bounded metadata-only existence check can identify unselected historical rows; do not enumerate/load all documents. No fallback query by UI locale, newest timestamp, lexical version, account plan, or “first parseable row.”
7. Bound the serialized JSON size in the database query before transferring it into Node; return a safe oversize marker instead of the payload. Keep the existing query timeouts and avoid N+1 queries.

For selection, compare `document.id/readingId/locale/contentVersion/chartVersion/tier` against row columns, and compare the run's document/reading/locale/contentVersion against that row. Require a coherent published canonical run (`completed`, `partial` or adopted `legacy`, with non-null consumption); a document pointer in a contradictory reserved/running/failed state is an integrity error, not a new publication path. Row `createdAt` need not equal the document's generation timestamp. Neither version must equal the currently deployed code's version: an old valid frozen reading remains readable.

`readings.result` is an older chart-summary shape, not a complete versioned `ChartDigest`. Do not manufacture a version match or recalculate it on GET. Show saved chart-summary data as such; section grounding remains the saved document's grounding. New chart formats are a separate engine concern.

### 4.2 Historical and inconsistent records

| Condition | Decision |
| --- | --- |
| `legacy` run with a valid adopted free-document pointer | Read that exact document; no consent required and no accounting migration on read |
| Several surviving documents | Canonical pointer wins; preserve all others without exposing a new archive-selection feature |
| Document row exists but no run adopts it | Show chart/illustrative notes plus a safe unavailable-history notice; do not classify real/fixture history or write a run during GET |
| Pointer missing, references another chart, or row/envelope disagree | Saved interpretation unavailable; no substitute row and no new free offer |
| Run says completed but JSON is partial/unsupported | Derive display completeness from validated content; retain the ledger status without rewriting it |
| Missing `0006` tables / database unavailable | Service-unavailable state, not “you have not used your offer”; chart-only access may use its independent owner-scoped lookup |
| Original chart deleted | Existing deleted-offer status remains; no inaccessible link, recreated reading or replacement run |
| Stored paid document | Not selected by this free-run route; production paid selection/authorization is deferred. Preserve the row and existing chart-note access |

Additional historical documents are preserved but archive browsing is explicitly deferred. That is preferable to silently selecting a different language/version or undoing the approved cutover classification.

### 4.3 Pin page-to-PDF identity

Use the same selector rules for the page and PDF:

- No selector: canonical saved reading when valid, otherwise the explicitly labeled chart-notes view/state.
- `?document=<uuid>`: the exact canonical document for this owned chart. A stale, foreign or different ID never selects a replacement. An inaccessible ID returns 404; an accessible but unrenderable selected document returns a safe unavailable response (PDF 409), not a different edition.
- `?edition=chart`: explicit saved-chart/illustrative-notes mode; never automatically switch this request to generated content.
- Reject malformed, conflicting or unsupported selectors: PDF returns 400; the page uses its safe invalid-selection/not-found UI rather than silently falling back. Do not accept a query-string tier/version/locale override.

The page's primary saved-reading download link includes its selected document ID. Its chart-notes link pins `edition=chart`. Thus publication between page load and download cannot silently change an explicitly chosen chart summary into a different report. Existing callers of the unparameterized PDF URL remain supported.

Ownership checks linearize at the server read; already delivered HTML/PDF cannot be recalled after deletion. A PDF should recheck ownership/canonical identity immediately before sending the completed buffer and discard it if deletion/replacement is observed. Do not hold a transaction through rendering or claim that this eliminates the unavoidable race after the final check. Subsequent requests must fail; nothing recreates deleted data.

## 5. Runtime validation and safe projection

Do not cast JSONB to `ReadingDocument` and assume the TypeScript annotation validated it. Keep provider-output validation strict and unchanged; the reader needs a compatible but bounded decoder.

### Envelope and tier integrity

- Accept only supported `en`/`es`, `free`/`paid`, valid identity fields, bounded nonempty version strings, valid timestamps, arrays/objects of the expected shapes, and unique known section keys.
- Production free selection requires both row and envelope tier `free`. Every present section must be `overview` or `sun` with its registry tier. A paid key anywhere in the free **sections** is an integrity failure: reject the document from the display path rather than masking the paid section in CSS or quietly laundering the document by filtering it.
- Paid fixture validation permits all eleven known keys, with each section's proper tier. That pure capability grants no production entitlement.
- Keep stored section and block order. Do not rebuild titles, subtitles, text or questions from current prompts, mutable notes or the interface language. An absent optional subtitle stays absent.
- Preserve generated/overridden/failed source status. Display degradation is an additional state, not a rewrite of the saved document.
- Validate optional metadata safely where necessary, but never require today's model/configuration or new accounting fields for legacy readability. Additive metadata can be ignored within the byte budget; malformed identity/tier/structure cannot.

### Blocks, questions and graceful degradation

- Recognize `prose`, `callout`, `list`, `keyValue`, `aspectTable`. Reuse the bounds of `readingBlockSchema` for known block values without changing the generation schema/hash merely to implement the reader.
- Unknown **block kinds** are omitted in both adapters, with valid siblings preserved. Strip the unknown payload entirely and show a generic compatibility notice; never guess that `paragraph` means `prose`.
- A malformed known block makes its section unavailable, rather than passing a partially validated object to React/PDF. A section with no usable supported blocks must not look successfully empty. Invalid envelope identity, duplicate/unknown section keys, illegal tiers or aggregate-limit violations make the whole document unavailable.
- Current generated free sections must retain their saved closing questions. A legacy adopted document missing a later-required optional field can render its otherwise valid content with an incomplete/legacy notice; do not invent a question or discard historical prose just because current generation rules are stricter. Explicitly test this compatibility case.
- Missing expected free sections are reported as missing, not synthesized from notes. At least one usable generated/overridden section is required for a meaningful saved-reading presentation; otherwise use unavailable/chart-only mode.
- Failed sections use a neutral localized explanation such as “This section was not completed. It will not be generated again automatically.” Do **not** print raw `failureReason`, `accounting.halt`, schema error strings, provider data or cost information.
- The baseline's failed fallback prose says “the words will catch up.” Do not repeat that promise. Failed content is not generated prose: the display projection may replace that system fallback explanation with truthful copy while leaving the stored row untouched. Render only validated chart-fact entries from a supported per-section facts projection (or the saved chart summary); do not dump arbitrary `facts` JSON or recalculate missing facts. If those facts are not valid, omit them and keep the chart summary available.

Plain text remains plain text. No `dangerouslySetInnerHTML`, generated Markdown/HTML execution, arbitrary links, image fetches, embedded scripts, or provider-controlled font URLs. HTML escapes strings; PDF receives text/vector primitives only. Treat any URL-looking prose as text.

## 6. Nine honest locked previews, without changing generation

The nine paid keys are `moon`, `ascendant`, `aspects`, `houses`, `planets`, `nodes`, `planetaryYear`, `transits`, and `guidance`.

The current builder intentionally persists only **seven** locks because today's digest lacks profections and transits. Do not make those sections generatable, fabricate facts, or rewrite stored documents to make the count equal nine.

Instead, construct a separate presentation catalog from `SECTION_KEYS`, registry tier/requirements, and hand-written en/es copy:

- Seven entries: “Not included in this free interpretation.” While paid AI generation is unavailable, also state that the full generated interpretation is not yet available; do not claim a subscription unlocks it immediately.
- `planetaryYear` and `transits`: “Planned — requires additional chart calculations.” No delivery date or claim that purchasing provides these today.
- Names and one-line descriptions are maintained by us, never generated or taken from a hidden paid section. Do not render arbitrary stored teaser text as a backdoor for paid prose.
- Use the saved document locale. Both adapters consume the same catalog projection and the same order. Avoid nine repetitive purchase buttons; prefer one accurately labeled plans/information link or a non-actionable availability notice. Existing subscription checkout remains separate.

The catalog is **current product UI**, not frozen generated prose. Give its copy/layout a presentation revision used by fixtures/evidence, distinct from `contentVersion`. Preserve the archived `lockedSections` values in storage; no read-time backfill. This deliberate separation satisfies the nine-name requirement without falsely claiming that all nine are computable/unlockable or silently changing saved narrative.

A later capability release can change catalog availability without funding new generation. Do not derive availability solely from the presence of a registry entry, or alter `availableSections()`'s dispatch guard for this UI work.

## 7. Display-state matrix

| State | Page | PDF | Generation action |
| --- | --- | --- | --- |
| No document, unused offer | Saved chart; clearly illustrative notes; explicit opt-in controls if available | Chart/illustrative-notes edition | Existing explicit consent + POST only |
| Generation disabled/config unavailable | Chart remains; explain generation unavailable | Chart edition, or existing saved document if valid | No new dispatch |
| In progress, no published document | Bounded read-only status refresh; chart remains | Chart edition labeled as such | No automatic repeat |
| Complete valid free document | Saved `overview`/`sun`, questions, saved language/version, nine previews | Same selected content and notices | No regeneration button |
| Partial saved document | Usable saved sections; failed/missing-section notice and safe facts | Same partial designation, sections and notices | No automatic repair |
| Failed after consumption, no document | Honest failure and used-offer message; chart remains | Chart edition, not “your interpretation” | No reset/retry |
| Indeterminate | Explain outcome cannot be confirmed; no speculative success/failure | Chart edition | Status GET only; no repeat POST |
| Run belongs to another owned chart | Link to original; do not attach its prose here | Current chart edition | No second offer |
| Original free chart deleted | Explain deletion did not reset offer; no dead link | Current owned chart edition if any | No replacement offer |
| Invalid/unsupported/oversize saved content | Safe unavailable/compatibility message; supported siblings only when decoder permits | Pinned unrenderable request fails safely; separate chart edition stays available | No rewrite/regeneration |
| Document store unavailable | Status unavailable, not unused; chart-only fallback where independently available | 503 for unavailable generated selection; explicit chart edition can still work | Disable misleading generation CTA until status can be confirmed |
| UI language differs from document | Navigation/status in UI language; visible saved-language notice and `lang` on content | Saved document language | No translation request |
| Subscription changes | Saved free content stays identical; billing/legacy-note permissions may change separately | Same saved free edition | No implicit paid/free generation |

Do not call `completed` proof of a rendered document. The server's selected presentation determines the visible output, while status controls describe the generation request.

## 8. Page integration, accessibility and refresh

- Keep the saved placements, privacy label, warnings, decorative-wheel disclosure, chart details and deletion controls. Do not relabel the wheel as a computed chart. The later [Solar completion plan](plan-solar-return-completion.md) adds a genuinely factual page/PDF visualization; retain the disclosure until that implementation exists, and never silently recast or rewrite an old edition to fill missing wheel data.
- Wire `ReadingSectionView`/`ReadingBlockView` into a saved-reading container. Use proper section headings and IDs; subtitle absence is allowed. Use semantic lists, `dl` for key/value data where appropriate, and table captions/column headers with responsive overflow.
- Preserve paragraph/newline meaning without interpreting markup. Long words/JSON-like values must wrap without breaking mobile layouts. Test reading order at narrow width, zoom, keyboard navigation and sufficient contrast; locked state cannot rely on blur/color alone.
- Put `lang={document.locale}` on the saved-reading subtree. Display a localized mismatch explanation, generation date and version information without exposing private accounting/provider metadata.
- Rename download labels according to the actual selected edition: saved free interpretation, partial interpretation, or chart/illustrative notes. A Premium account alone never produces “full generated PDF.”
- `ReadingGenerationControls` must stop saying generated-document presentation is unavailable once the selected document is actually displayed. Pass only safe presentation identity/state needed for this distinction.
- On an explicit POST result or a status GET that reveals a newly published document ID for this chart, call `router.refresh()` once for that identity. Track the last refreshed ID; do not create an infinite refresh loop if the saved JSON is unavailable.
- Poll only while a generation request is pending/in progress or after an uncertain POST transport outcome. Start around 3 seconds, back off through 6/10 seconds, respect `Retry-After`, and stop after 60 seconds or 20 status GETs, whichever comes first. Pause when hidden; abort/ignore stale requests on unmount, chart change or locale change. Resume with an explicit check, not an automatic POST.
- Stop on terminal status, unauthorized/not-found responses, or the polling budget. On 429 honor the server delay and total budget. Provide an accessible **Check status** control after stopping. Do not repeatedly refetch consent or re-grant it on a polling tick.
- Preserve dashboard consent withdrawal behavior: the same controls are also mounted without a `readingId`. A page-only refresh enhancement must not break that mode.

## 9. Legacy notes and existing PDF callers

Keep an explicit chart/illustrative-notes mode so existing charts and subscribers do not lose their current feature:

- With a valid saved document, the default main reading renders that document, not `getReadingNotes()` underneath as though it were additional generated output.
- Without a document, or with explicit `edition=chart`, retain notes with a prominent “Illustrative chart notes; not a generated interpretation” label. Retain the existing subscription-derived Moon/Ascendant/house notes where entitled, with equally clear labeling.
- A saved-reading view can link to the chart-notes edition rather than mix two content sources into one report. The page and PDF support the same explicit edition.
- `currentUser().plan` is derived from verified subscriptions; preserve that gate **only** for the legacy extended-notes mode. Never use the legacy `users.plan` column or a client flag.
- Notes are mutable editorial material. Do not claim frozen repeat-download identity for that mode; the immutable-content guarantee applies to the selected generated document. A note edit must not change that generated PDF's text.
- Validate/bound legacy notes and chart display fields too. If optional notes fail validation, omit them with an unavailable notice; do not bypass PDF limits or silently truncate generated content.

Replace `SolarReturnDocument`'s ambiguous notes/premium API with a typed `content` union (saved-reading versus chart-notes). Update the route and all current test callers together; the baseline has no other production caller. Preserve the URL and the notes-only behavior, but update assertions for intentional, honest edition labels. Do not maintain a silent “premium wins over document” compatibility overload.

Update the PDF setup guide, relevant setup-guide UI, and nearby account/reading copy that would otherwise promise a full generated reading based on subscription alone. This is a narrow correctness change, not a redesign of billing or pricing.

## 10. PDF rendering and stability

### Structure and layout

Use shared data/formatting rules with separate React-PDF primitives; do not convert HTML to an image or duplicate document-selection logic inside the PDF component.

- Cover/chart summary clearly identifies edition, saved language, date and versions where applicable.
- Render sections in saved order, preserving blocks, labels, list items, key/value pairs, aspect rows/orbs and closing questions. Show the same partial/unavailable notices and nine preview catalog entries as the page.
- Map prose to wrapping text; callouts to a labeled bounded view; lists to vector/text bullets; key/value data to wrapping paired columns; aspect tables to four columns with readable headings.
- Permit sections, long prose, list items and long table content to flow across pages. Never apply `wrap={false}` to an arbitrarily large block. Keep headings with initial content; use orphan/widow protection. Repeat table headers on continuation pages, and test both a normal row kept together and a long row that must split.
- Fixed header/footer must not overlap flowing content. Render accurate page numbers; do not force a two-/three-page count for generated documents. The old fixed count tests apply only where the legacy fixture still warrants them.
- Do not hide overflow, silently cut strings/rows, shrink text to illegibility, or insert blank continuation pages to make a snapshot pass.

### Fonts and text

Bundle licensed local fonts with explicit en/es glyph coverage and fixed versions. Include licensing and function tracing as needed; no remote font/image requests at render time. Test `á é í ó ú ü ñ ¿ ¡`, degree signs, dashes, apostrophes, punctuation, long names and long unbroken values. Use vector decoration rather than relying on unsupported astronomical/emoji glyphs. A missing glyph must be detected/handled explicitly, not silently rendered as a box; unsupported characters outside the chosen font coverage need a local fallback or a safe PDF-unavailable response.

PDF text should be selectable and have logical extraction order. Give it an appropriate language/title; do not promise PDF/UA compliance without separately verifying the toolchain. HTML remains the accessible primary format.

### Diffable evidence, not binary identity

- Freeze fixture IDs, dates, locales, content versions and presentation revision. For saved documents, derive PDF metadata dates from saved timestamps rather than download time where the renderer supports this.
- Keep small canonical projection/text snapshots in Git. Do not check in generated PDF/raster batches or private user data.
- Use a pinned dev-only PDF parser/rasterizer (for example `pdfjs-dist` with a local canvas backend if required) to check extraction, pages and visual output. Review/pin any new dependency; page-count regexes alone do not establish correctness.
- Compare normalized extracted text/order, document metadata, page structure and fixed-DPI visual samples. Normalize incidental PDF object IDs/timestamps, whitespace and font-internal differences only; do not normalize away missing questions, accents, section order, signs, degree values or rows.
- Repeated rendering of the same saved fixture must preserve the semantic output. Raw PDF bytes need not be identical. A renderer/font change may intentionally change layout, but must produce a reviewed snapshot diff rather than new prose.

## 11. Resource and HTTP boundaries

These are **proposed acceptance limits to implement and measure**, not measurements of the current application. Keep them centralized, visible to tests and documented in the implementation PR. Tightening for a measured hosting constraint is acceptable; relaxing them requires evidence and a recorded design change.

| Resource | Starting boundary |
| --- | --- |
| Stored JSON entering Node | At most 512 KiB serialized per selected document; reject oversize before transfer/render |
| Shape | At most 11 sections, 30 blocks/section; current per-block bounds (4,000-character text, 20 items/entries, 100 aspect rows) |
| Aggregate display text | At most 32,768 UTF-16 code units for a free document, 131,072 for paid renderer fixtures; enforce in addition to per-field bounds |
| Output size | At most 8 MiB PDF; enforce while collecting output, not after an unbounded buffer |
| Pages | At most 40 for the production free/notes path; paid fixture stress ceiling 80, not permission to serve paid reports |
| Concurrent layout/render | One per process, no unbounded pending queue; saturation returns 503 with a short Retry-After |
| User download quota | Preserve `readingPdfUser`: 20/hour, independent of generate/status/delete/consent quotas |
| Initial timing gate | Representative warm p95 <= 5 s and cold <= 10 s; maximum admitted render deadline <= 15 s and below the actual host deadline with response/cleanup headroom |
| Memory gate | Measure peak RSS and incremental use; target incremental <= 256 MiB and total peak RSS <= 75% of the confirmed host memory allocation at the admitted concurrency |

Measure typical and maximum admitted free en/es documents, partial/failure states, long legacy notes, and synthetic full paid documents. Record cold/warm samples, Node/font/renderer versions, hardware/allocation, output bytes/pages and peak memory. Use enough repeated samples to support p95 (at least 20 warm samples per representative case); isolated measurement processes avoid misleading shared-RSS results. Do not represent a local benchmark as hosted evidence.

A timer around `Promise.race(renderToBuffer(...))` is **not cancellation** and must not release the render slot while work continues. Preflight limits and output-stream destruction must be real. If React-PDF cannot provide a cancellable layout stage, enforce the deadline with an isolated terminable Node worker (bounded input, one active worker, no DB/provider credentials or network fetching, bounded heap plus measured native/RSS use). Verify production packaging and teardown on timeout/client abort. If this is not viable or budgets fail, the larger request-time renderer must not ship merely with a longer timeout: make the private artifact/job design under #81 plus readiness/status work under #83 a prerequisite. Do not implement an untracked background promise or a public bucket as a shortcut. Check actual hosting limits before committing to a synchronous rollout.

Response rules:

- Apply `Cache-Control: private, no-store`, private referrer policy and `nosniff` consistently on success **and errors**, including 401/400/404/409/429/503. Preserve the central security headers.
- Successful PDFs use `application/pdf`, attachment disposition and a sanitized filename derived from safe year/locale/edition, not user names, email, model IDs or arbitrary query text. Saved-reading filename and metadata use the saved locale.
- 401 for unauthenticated/unverified; 404 for absent/foreign chart or inaccessible pinned document; 400 for invalid selectors; 409 for an owned selected document that cannot be represented safely; 429 plus Retry-After for user quota; 503 for DB/render availability, timeout or capacity. No raw provider/DB/React-PDF stack is returned.
- Keep the PDF dynamic, Node-only and authenticated. No `GET`/`HEAD`/prefetch path starts generation. No long-lived DB transaction spans rendering.
- Log only stable codes, request/route identifiers permitted by repository policy, and bounded timing/size metrics. Remove the existing PDF catch's raw `error` object. No document text, input names/locations, run settings, raw failure reasons or full query URLs in logs.

The request-time PDF remains ephemeral; this plan creates no artifact storage or new retention promise. Future private artifacts need ownership checks, deletion cleanup and a key including document identity/content plus renderer/font/presentation revision. Historical ADR-number suggestions in #81/#83 must be reconciled with existing ADRs, not overwrite the current migration/backlog decisions.

## 12. Verification plan

### Fixtures

Commit small, explicitly synthetic frozen JSON fixtures with fixed IDs/timestamps/version strings, not regenerated fixtures during every render test:

- Complete free en/es, each containing both required questions.
- Partial free in both directions (overview fails / sun fails), plus legacy missing-question/optional-metadata cases.
- Full paid en/es fixtures covering all eleven sections, and current-capability paid fixtures covering nine. Mark profection/transit content synthetic; these are not astronomical/provider-quality evidence.
- Every block kind, long text, multi-page lists/tables, multiline key/value entries, long names, high-latitude omissions and unsupported-glyph behavior.
- Unknown kind surrounded by valid siblings; all-unknown section; malformed known block; duplicate/unknown key; mismatched IDs/locale/versions; illegal tier/paid sentinel; missing canonical row; oversized/deep unknown payload.

Use hand-authored expected outcomes as well as projection snapshots: a shared projection bug must not make both adapters agree on the wrong result and pass the entire suite.

### Test layers and required outcomes

| Layer | Required evidence |
| --- | --- |
| Pure read validation/projection | Known shapes; identity/version agreement; bounded JSON/aggregate text; all degradation rules; no raw internals; frozen input unchanged |
| DB selection (disposable local PG) | Two owners, several charts/versions/locales, adopted legacy, orphan rows, canonical-other-chart, corrupt pointer, deletion; exact row selected and no writes to generation/consent/documents |
| HTML components | Five kinds, saved order/questions, correct headings/semantics/lang, safe failure notices, nine truthful previews, unknown siblings, escaped malicious strings |
| PDF components | Same fixture semantics; all blocks, long pagination, repeated headers, correct locale/glyphs/metadata, no clipping/blank explosion; full paid synthetic support |
| Page/PDF handlers | Real owner-scoped loader, all auth/query/error/cache/quota paths; pinned selection; current account plan never selects paid/free prose; no raw error logs |
| Read-only safety | Spy/fake provider count zero for page, PDF, repeated GET/download, HEAD/prefetch, status polling, locale/subscription changes, withdrawal then read; offer/run/attempt/document/consent snapshots unchanged except independent rate counters |
| Client/browser behavior | Explicit generation uses the existing mutation only; successful publication appears after bounded refresh; partial/lost POST/in-progress/429/offline/stale response/hidden tab/unmount work; no duplicate POST or consent grant |
| Cross-format invariants | Same document ID, saved locale/version, section/block order, text, question, status, facts notices and catalog; cookie switches cannot select another language row |
| Resource/security | Preflight oversize rejection, bounded concurrency, output cap, deadline/abort teardown, no early slot release, 429 independence, no remote asset/network calls, no content leakage in HTML/RSC/PDF/logs |
| Full regression | Existing safety, deletion, auth, billing, migration, corpus and notes-PDF tests remain green; no provider credentials or hosted data |

Browser evidence must exercise en/es UI with both matching and mismatching saved-document locales, free and subscription-backed accounts, mobile/desktop, keyboard controls, download/open, and navigation after publication/deletion. Use synthetic verified accounts/subscription rows in a guarded disposable DB: no email transport or live Stripe/provider call is required. Synthetic status transitions/fake providers belong in test seams only, never in a production route or runtime fallback.

### Mandatory defect mutations

For each claimed guard, deliberately break the relevant implementation and show the named test failing, then restore and rerun the unmodified tests. At minimum:

1. Remove an ownership predicate / allow a document from another reading or owner.
2. Prefer UI locale, newest version, or an unpinned PDF document instead of the canonical identity.
3. Allow `moon` into free sections or dispatch a paid section in a free pipeline run; test both persisted/display leakage and the provider call list.
4. Let account `plan` or a query tier select paid/generated content.
5. Drop a question, reorder sections/rows, omit an accent/orb, or lose a PDF block while HTML still renders it.
6. Echo raw failure/accounting/model data or pass the raw document as a client prop; assert sentinels are absent from HTML/RSC/PDF/logs, not just visibly hidden.
7. Render unknown payload text or drop its valid sibling.
8. Restore automatic POST retry/consent grant in a read/poll effect, or remove the polling stop/refresh-identity guard.
9. Remove private/no-store or allow a pinned missing document to fall back to another report.
10. Remove input/output/concurrency caps or release a slot on timeout before render termination; prove the resource test catches it.
11. Claim all nine topics unlock now, or relabel legacy notes as generated Premium based only on subscription.
12. Replace frozen content with `getReadingNotes()` and mutate a note; prove saved-reading HTML/PDF content remains unchanged in the correct implementation.

Do not edit expected values to make a mutant pass. Record exact mutation, command, failure and restoration checks in the implementation evidence; existing PR #148 validation counts are not validation of this new work.

### Commands and evidence discipline

Scoped tests should be named for the new seams, for example `readings-view.test.ts`, `readings-presentation.test.ts`, `readings-pdf.test.ts`, `readings-page.test.ts`, and `readings-controls.test.ts`, alongside existing renderer/PDF/service tests. Exact final filenames belong in the implementation PR.

Before expensive checks announce their purpose and exact commands per `CODE_REVIEW.md` §6. The session's existing full-validation authorization covers the following on a disposable local database with synthetic/fake-provider data:

```bash
npx next typegen
npm run typecheck
npm run lint
RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1 npx tsx --test tests/*.test.ts
npm run build
```

Use the repository's guarded local migration/schema checks for database setup; never reuse hosted data. Recheck the unchanged migration manifest when assessing the final diff. Inspect HTTP/browser output separately: unit snapshots or SSR smoke do not substitute for actual browser/PDF layout evidence. Report skipped/unavailable checks and infrastructure limitations explicitly. No expensive validation or app tests are needed merely to author this design document, and none are claimed here.

## 13. Implementation sequence and file boundaries

These are design phases/acceptance checkpoints, not a second backlog. Use the existing issues and coherent commits/PRs; do not expose an intermediate page that claims usable saved output while its download still silently substitutes notes.

| Phase | Changes | Exit condition |
| --- | --- | --- |
| A — Contract and fixtures | Pure stored-document validator, presentation types/projector, static catalog copy, frozen fixtures and tests | All identity/tier/locale/degradation rules testable without UI/DB/provider |
| B — Owner-scoped retrieval | Server-only reader, deterministic selectors, legacy/error paths, DB tests | Canonical selection proven; zero generation/consent/document writes; no private cache |
| C — HTML and controls | `reading/[id]/page.tsx`, existing `reading-sections.tsx`, `reading-generation-controls.tsx`, safe status copy | Actual free/partial content appears; bounded read-only refresh; accessible nine previews; no automatic mutation |
| D — PDF parity and compatibility | `solar-pdf.tsx`, PDF block primitives/helper, PDF route, local fonts/tracing if needed, legacy union callers | Same pinned content; correct errors/headers/labels; en/es long-layout and resource gates pass |
| E — End-to-end hardening | Browser/route tests, extractor/visual evidence, security/resource mutations, full regression | Acceptance checklist below passes; any required #81/#83 dependency identified before shipping |
| F — Documentation and reviewed delivery | PDF/setup/nearby UI copy, evidence and plan deviations; standard PR workflow | Accurate source-of-truth issue references, reviewed SHA, rollout/rollback limits; no premature issue closure |

Reuse the section registry, block schemas, copy dictionaries, auth and rate-limit helpers. A small adapter-specific component is appropriate; a second generation engine, duplicate entitlement resolver, bespoke global state framework or new service is not.

No schema migration, applied migration edit, prompt change, tier expansion, content-version bump, shared-cache revival or provider config change is expected. Presentation revision/font changes are not prose policy changes. If implementation truly requires a generation-contract change, isolate and justify it against the safety plan and ongoing review before including it.

### Risks to resolve in these phases

- **Corrupt/historical rows:** conservative unavailable state, never automatic repair/adoption; test legacy separately from corruption.
- **Frozen language versus interface language:** visible language notice, pinned selector and cross-locale tests.
- **Seven stored locks versus nine advertised topics:** presentation catalog plus honest planned/unavailable labels, not changed dispatch eligibility.
- **Partial status discrepancy:** derive visible completeness from validated sections, not only run status.
- **PDF layout/resource/library packaging:** early long-fixture spike, local fonts, actual extraction/visual tests and the hard resource gate; no late timeout-only workaround.
- **Existing paid-note compatibility:** explicit legacy mode and terminology; no newly promised generated Premium entitlement.
- **Concurrent audit fixes:** refresh fetched staging and inspect file overlap before integration; do not rely on an audit verdict for code it did not review.

## 14. Review, rollout and issue boundaries

### PR #148 review baseline

The [post-merge verdict](https://github.com/jtanori/solara/pull/148#issuecomment-6936495944) is **MERGEABLE**, with zero blocker/high/medium findings and one low, non-blocking URL-configuration observation ([trailing empty query/fragment delimiters](https://github.com/jtanori/solara/pull/148#discussion_r4594652808)). The seven prior findings were verified repaired. The remaining observation does not block this read-only presentation work; its provider-configuration follow-up is not silently bundled into the renderer.

Keep that audit pinned to its original target: final head `15569e673802d9c87d6769044a76ecf5ee392d5c`, equivalent merged tree `13a886085aaa901b964e323fe3d2187650be8881`, with base `2c0c64b202fdbf7a9e8f7d91aadc8b950866f14e`. Do not amend what the reviewer believes was reviewed, relabel author evidence as the review verdict, or treat merged status/resolved threads as a new final-head verdict.

New findings affecting this work must be repaired in follow-up commits/PR before the affected implementation merges. Keep this slice's validation and review evidence separate. Follow the existing COMMENT-only, SHA-pinned workflow; add no independent-human/second-identity approval requirement.

### Rollout remains generation-off

Offline implementation is not blocked by email setup or hosted AI credentials. Hosted validation is still governed by the existing cutover runbook:

- Keep generation disabled; verify old/new deployment paths are off, preview databases are isolated, old dispatch is stopped/drained, and recovery/restore/representative-upgrade evidence exists.
- `0006` was still pending in the last supplied hosted verification. Refresh classification counts after drain, apply only through the approved exact-SHA process once prerequisites hold, and verify the expected 7 migrations / 16 tables / 62 columns / 9 indexes. This slice must not rewrite `0006` or conceal missing tables as an unused offer.
- Require authenticated application health/readiness and real en/es browser/PDF evidence. A deployment marked READY, a login page, or disposable CI migration does not establish hosted application readiness.
- Deploy this presentation with generation still off and synthetic data in the approved isolated environment. Do not bypass deployment protection or weaken embedding/security headers for QA.
- Roll back presentation code only to a schema-compatible reviewed build, or forward-fix. No document/ledger deletion, allowance reset, migration down-edit or pre-migration binary rollback assumption. Chart-notes mode is a graceful user fallback, not a way to hide an unresolved safety defect.

Real-provider evaluation/credentials and activation remain separate, bounded, explicitly authorized work after relevant review findings and usable output are resolved. Email QA remains deferred. Production promotion is separate. **This plan does not make live generation ready to test.**

### What completion means

- **#104:** both free sections and saved questions rendered in en/es; nine honest static topic previews; paid-output/request guards fail under mutation; all applicable page/PDF safety cases pass.
- **#106 renderer work:** all five block kinds, both adapters, free/partial views and synthetic **full paid** documents; stable semantic/visual diff evidence and resource bounds. Free-only tests are not enough to claim the entire issue complete.
- **Deferred live paid acceptance:** selecting/storing/authorizing a real paid document, purchasing/webhook orchestration and richer calculations belong to #107/#108/#110, not this delivery. If #106 is interpreted to require those live paths, keep it open and explicitly report the renderer sub-scope delivered.
- Do not close either issue or add a misleading `Closes #106` merely for this plan or a partial implementation. No issue mutations are authorized by drafting the design.

## 15. Acceptance checklist

- [ ] The owner sees the exact canonical saved free document, never another chart's or a newest/UI-locale substitute.
- [ ] Generated `overview` + `sun`, saved questions, order, statuses, locale and versions agree between page and pinned PDF.
- [ ] Free content never includes a paid section; paid requests and hidden paid payloads are absent and guarded by failing mutations.
- [ ] Nine registry-driven, hand-written previews are honest about unavailable paid generation and pending profection/transit calculations.
- [ ] No document, partial, failed, indeterminate, deleted, legacy, corrupt/unsupported and DB-unavailable states are truthful and preserve chart access where possible.
- [ ] Reads/downloads/polls/UI-language or subscription changes, including reads after withdrawal, do not mutate generation consent, allowance, attempts or documents and make zero provider calls. Explicit withdrawal retains its approved consent/audit mutation; it does not delete saved output or reset the offer.
- [ ] HTML is escaped, semantic, responsive and keyboard/screen-reader usable; no raw internal failures/metadata reach HTML/RSC/PDF/logs.
- [ ] Notes-only charts and existing subscription-gated illustrative notes remain supported with accurate labels and no frozen-content claim.
- [ ] PDF supports every block, en/es glyphs, long pagination, safe filenames, pinned identity, extraction/visual diffs and private/error headers.
- [ ] Resource limits, cleanup, concurrent saturation, actual host budget and independent PDF quota are verified; required job/storage follow-up is not waived by increasing timeouts.
- [ ] Full paid synthetic fixtures prove renderer capability without introducing a paid production endpoint or claiming engine/provider quality.
- [ ] New tests, defect mutations, full authorized regression and browser evidence are recorded for the actual implementation SHA.
- [ ] Ongoing audit fixes are incorporated where relevant, documentation is truthful, issues are not prematurely closed, and generation remains off.
