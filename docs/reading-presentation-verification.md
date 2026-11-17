# Saved-reading page/PDF — author verification

**Implementation SHA:** `795b5b3e6acb706ae12b0720fba83256d26b7251` on `arena/78f55298-solara`.
**Fetched staging base:** `13a886085aaa901b964e323fe3d2187650be8881`; implementation is five commits ahead, zero behind that fetched base.

This is author-local implementation evidence for [the approved design](plan-free-reading-page-pdf.md), **not a PR review/verdict, hosted qualification, issue-closure decision, or generation-activation approval**. This report lands in a subsequent documentation-only checkpoint; the executable source, tests and scripts measured below are the implementation SHA above.

## Delivery and scope

| Checkpoint | Purpose |
| --- | --- |
| `8175c9e` | Approved delivery design; historical plans point to it |
| `185d6c6` | Shared bounded projection, frozen fixtures and owner-scoped canonical reader |
| `77a72ba` | Saved page/PDF integration, polling, isolated rendering and validation harnesses |
| `9de1e52` | Correct subscription wording on home/pricing/dashboard; real-app copy regression checks |
| `795b5b3` | Pre-layout rejection of newline-heavy fixed headings; no normal snapshot changes |

Delivered locally: #104's saved `overview` + `sun`, questions and nine honest static previews, plus the saved-document renderer portion of #106. Full paid en/es fixtures exercise all eleven topics and the nine-current-topic subset **only in synthetic renderer tests**. They do not grant production paid selection, storage, entitlement, purchasing or generation (#107/#108/#110).

The implementation:

- Selects the consumed, published lifetime-free canonical pointer for the verified owner. UI language, newer rows, lexical version ordering and subscription never reselect generated prose. Run/row/envelope identities, tiers and versions must agree; older coherent documents and adopted legacy remain readable.
- Bounds JSON in SQL before transfer and validates it at runtime. Failed prose/questions and private metadata are absent; allowlisted saved facts remain. Unknown block payloads disappear with a compatibility notice while supported siblings survive. Malformed known content cannot masquerade as an empty successful section.
- Shares a minimal projection between escaped semantic HTML and independent React-PDF primitives. The saved language, order, questions and versions survive locale/subscription changes. Pinned `?document=<uuid>` and explicit `?edition=chart` links prevent edition substitution.
- Keeps the mutable, subscription-gated illustrative notes visibly separate. A real DB note-edit test changes those notes but leaves canonical HTML/PDF prose and the generation ledger unchanged. Home, pricing, dashboard, setup and usage copy do not promise generated Premium content from a subscription.
- Preserves honest unused, pending, partial, failed, indeterminate, deleted, other-chart, legacy/history, invalid/oversize and unavailable states. Missing generation tables are never an unused offer. Independent chart access remains where possible.
- Adds finite GET-only status polling, native-timer-safe scheduling and once-per-document refresh. No mount/read/download/locale/navigation/subscription action grants consent or retries generation. Explicit consent/generation/withdrawal retain their existing endpoints; dashboard withdrawal without a reading ID works.
- Runs PDF layout in a credential-free, network-denied, restricted child with bounded input/output/pages/RSS/concurrency and actual SIGKILL/close-based cleanup. Owner/canonical identity is checked again after rendering. Private errors, safe filenames and the independent 20/hour download quota remain enforced.

No `drizzle/`, provider config/policy, generation schemas/prompts, content version, live dispatch implementation or `.github/` files changed. The generation-status mapper was extracted behavior-preservingly; existing service and whole-regression tests passed. The free-pipeline test additionally asserts the actual provider call keys are exactly `overview,sun`.

### Implementation refinements and limits

The approved worker fallback is used because layout is not cancellable by merely rejecting its surrounding promise. The child is trusted renderer code with defense-in-depth restrictions, not an arbitrary-code sandbox. External 50 ms Linux RSS sampling is not an OS hard memory reservation.

A final adversarial probe found that a valid 200-character title can contain enough newlines to overflow an unbreakable heading; a very tall repeated table title could consume the entire body and hit the watchdog. `795b5b3` adds conservative measured geometry caps: **400 pt for the section title/subtitle/notice group; 20 lines for a repeated table title**. Unsupported geometry returns `pdf_input_limit`/409 before layout, without truncating or rewriting the saved text; HTML remains available. This tightens PDF admission as allowed by the design, without modifying generation schemas or frozen prose. New direct tree-construction assertions prevent a timeout from being accepted as the guard. Normal multiline headings still render.

The large diff is one coherent read/validation/HTML/PDF contract, with separate design, foundation, integration and hardening commits. Much of its size is the package lock, synthetic fixtures and tests. No unrelated billing/auth/workflow refactor is bundled.

## Executed environment and commands

Disposable loopback PostgreSQL **16.2**, Node **22.22.3**, npm **10.9.8**, synthetic verified accounts/documents/subscriptions, local outbox/fake-provider seams only. The local database has seven migrations, 16/16 tables, 62/62 columns and 9/9 indexes, with no pending/unexpected hashes. This is not evidence about a hosted database.

Effective environment and commands executed at the implementation SHA:

```bash
# Already-created, migrated disposable local database; never substitute hosted data.
export DATABASE_URL=postgresql://postgres@127.0.0.1:5438/solara_reading_views
export READINGS_GENERATION_ENABLED=false APP_URL=http://localhost:3000
export NEXT_TELEMETRY_DISABLED=1 MAIL_TRANSPORT=outbox
export RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1

npm ci --no-fund
npx next typegen
npm run typecheck
npm run lint
npm run db:manifest:check
npm run db:check
npx tsx --test tests/pdf.test.ts
# Requires a committed clean checkpoint; changes and restores one guard at a time.
node scripts/verify-reading-mutations.mjs
npx tsx --test tests/*.test.ts
# Run separately, with no competing test/build workload.
npx tsx scripts/benchmark-reading-pdf.ts
npm run build
node scripts/check-pdf-package.mjs
npx tsx scripts/verify-reading-browser.ts
npm audit --omit=dev --audit-level=high
git diff --check
```

| Check | Executed result |
| --- | --- |
| Clean install | Completed; pinned dependencies installed |
| Typegen, project typecheck and lint | Passed; incidental generated `next-env.d.ts` churn restored |
| Migration manifest and local schema/journal verification | Passed; existing seven migrations, no schema changes |
| PDF suite, with its DB gate enabled | **24 passed / 0 failed / 0 skipped**; eight frozen text/page/raster baselines unchanged by the geometry guard |
| Mutation suite | **54/54 assertion kills**; exact transformations committed in the runner; originals restored byte-for-byte; clean Git tree verified |
| Unmodified scoped suite after restoration | **142 passed / 0 failed / 0 skipped**, 37.32 s; includes presentation, reader, handlers, HTML, scheduler, component browser, PDF and pipeline tests |
| Whole repository regression after restoration | **612 passed / 0 failed / 0 cancelled / 0 skipped**, 371.53 s; both integration gates enabled |
| Production build and package trace | Passed; **216 traced files / 5.8 MiB**; worker, local fonts, license, metrics and ICC assets present; no test/browser/extractor/`.env.*` files in the PDF trace |
| Authenticated production-mode browser QA | **9 cases passed**, Chromium **153.0.8010.0**; zero server fetch attempts, automatic reading POST/PUT or unhandled browser errors |
| Isolated resource benchmark | **231/231 renders**, 11 cases × (one first + 20 warm samples), no failures |
| Production dependency audit | **0 vulnerabilities** with `--omit=dev`; full install summary still reports **11 moderate** findings, so the entire development dependency graph is **not** claimed audit-clean |
| Final source/whitespace checks | Clean checkpoint and `git diff --check` passed |

The 142 scoped cases and 24 PDF cases are subsets of the 612, not additional unique tests. The earlier foundation checkpoint's 79 tests/17 mutants and earlier integration runs are historical evidence, not substituted for this final-SHA validation. No blanket `npm audit fix` or unrelated runtime upgrade was performed.

## Browser, HTTP and presentation evidence

Component browser tests use mocked Next/API boundaries; the separate real-app QA starts and tears down a built production Next server and uses actual disposable DB session/subscription rows. The latter also requires local `/api/ready` 200. No production fake-data route was introduced.

The nine real-app cases are:

1. Saved free Spanish / English UI / free account.
2. Saved free English / Spanish UI / verified active subscription.
3. Partial overview-failed Spanish / Spanish UI.
4. Partial Sun-failed English / English UI.
5. Anonymous PDF 401 and foreign-owner page/PDF 404.
6. Synthetic publication observed through GET polling followed by page refresh.
7. Explicit consent withdrawal followed by unchanged readable PDF/ledger.
8. Deletion navigation and subsequent page/PDF 404; run tombstone keeps consumption and does not reset the offer.
9. Spanish dashboard consent withdrawal with no reading ID.

For cases 1–4: 390×844 mobile, 1365×1000 desktop, keyboard-focused download activated with Enter, downloaded PDF parsed for saved language, pinned identity and private headers, and 682×500 at 2× density **200%-equivalent reflow**. Actual UI-locale navigation preserves the saved article/document ID and extracted PDF text. Authenticated HTML and Flight responses exclude raw metadata/failure/birth-data sentinels. Table caption geometry and sampled reading text contrast (4.5:1 normal / 3:1 large) pass. Plan/home copy is checked in both UI languages; the subscription dashboard is checked too.

Canceling the synthetic subscription reduces the separate notes edition from four sections to one, not the saved article/PDF. Read/download/locale/plan paths leave run/attempt/document/consent snapshots unchanged. Server fetch is blocked, billing/provider keys are disabled for this QA, and remote browser assets are blocked **without weakening CSP, app headers or browser web security**. Public UI webfonts consequently use their system fallback. This is neither a browser-toolbar zoom test nor a screen-reader, PDF/UA or complete WCAG audit.

The nine DB-backed HTTP cases additionally cover selector conflicts/duplicates/unknowns, version/locale pinning, HEAD without rendering, corrupt/oversize 409, unavailable store 503, chart-mode independence, safe error logs, final deletion/replacement checks, quota 429/Retry-After and an independently successful status GET. Reads after withdrawn consent and generation-off reads remain allowed. Delivered bytes cannot be recalled after the unavoidable race following the final ownership check.

Polling tests exercise immediate GET followed by 3/6/10 s backoff, a 60 s/20-request cap, 8 s request abort, Retry-After longer than the session, hidden/offline/unmount stops, stale-chart/locale responses, explicit restart, successful/partial/lost POST outcomes and a seeded once-per-document refresh guard. They explicitly reject automatic POST retry or consent PUT on mount.

## PDF semantic and visual evidence

Eight committed frozen fixtures (free, both partial directions and full paid, each en/es) assert text from the **raw frozen source**, not only agreement between two adapters. All five block kinds, saved section/block/row order, closing questions, orb/degree values, accents, titles/language/date metadata, visible page numbers, supported siblings, safe notices and preview catalog are covered. The current eight fixtures each render four pages; that is a fixture result, not a fixed product page count. Repeated rendering preserves normalized extracted text and 96-DPI raster hashes.

Additional cases cover 100-row tables, repeated column headers, long unbroken values in all columns, 20-line row fragments, leading-table section headings, multi-page prose/callouts/key-value/list content, long names/versions, high-latitude omissions, and nine-topic paid subsets. URL-looking/script-looking strings stay plain text with no PDF annotations/actions. Unsupported glyphs fail safely. Tests verify actual child termination, slot retention until close, reuse, malformed/oversized IPC, clean child environment, and parent RSS termination even when child JavaScript never yields.

Manual raster review sampled English/Spanish free and paid narrative pages, all four partial narrative editions, cover/preview pages, the repeated Spanish long-table header/row fragments and a long-callout continuation. Browser desktop/mobile/reflow samples and the Spanish caption/content crop were also inspected. The earlier paid-heading orphan was fixed before `77a72ba`; that reviewed layout change kept all extracted text and page counts unchanged, changing three raster pages per paid locale only. The later geometry guard changes **none** of those normal snapshots. This is sampled visual review plus automated comparisons, not an assertion that every possible document or assistive technology was manually reviewed.

Reproducibility anchors:

- `tests/fixtures/readings/pdf-snapshots.json` SHA-256: `a90465fd2b159ef98d4a35eec21d816d182fe911ef77139dab0f6f6d169ddd2f`.
- Built `.pdf/worker.mjs` SHA-256: `a1a20933681bd6350c5e4a8a75c961b69e64b6be8e0ccb6c933b5acbed8b0c79`; confirmed identical after the final clean install/build.
- React-PDF **4.9.0**, font **4.1.2**, layout **5.2.0**, PDFKit **0.20.1**, Yoga **3.2.1**. Local Noto Sans Latin regular/bold/italic **5.3.0** with SIL license and font hashes in Git.
- Pinned dev-only additions: esbuild **0.28.2** (isolated worker build), PDF.js **6.5.438** and canvas **1.1.1** (extraction/raster checks), Playwright **1.65.1** and Chromium package **153.0.0** (browser tests). They are not imported by the deployed PDF function; the worker is bundled at build time.

Generated PDFs/PNGs, Chromium libraries, detailed logs and raw timing samples remain in ignored test output rather than Git. The committed fixtures, scripts, source SHA, results and hashes here are the durable handoff.

## Resource results at `795b5b3`

Node 22.22.3, two reported Intel Xeon 2.60 GHz CPUs, 4,131,278,848 bytes reported system memory; numeric cgroup allocation unavailable. No competing test/build workload. Each render uses a new child. Warm p95 is nearest-rank over 20 samples after the first sample; **first request is not a hosted cold start** and does not establish a cold-container bound. Parent RSS is the benchmark controller's cumulative high-water mark, not measured hosted Next aggregate RSS.

| Synthetic case | First ms | Warm p95 ms | Pages | Max bytes | Child peak MiB | Parent peak MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| free-en | 637 | 719 | 4 | 24,113 | 145.8 | 156.8 |
| free-es | 638 | 728 | 4 | 24,423 | 149.2 | 156.8 |
| maximum-free-en | 1025 | 1031 | 11 | 37,447 | 164.0 | 156.8 |
| maximum-free-es | 896 | 1046 | 11 | 38,454 | 164.2 | 156.8 |
| partial-overview-en | 693 | 663 | 4 | 23,380 | 146.7 | 156.8 |
| partial-sun-es | 681 | 735 | 4 | 24,382 | 149.0 | 156.8 |
| long-notes-es | 749 | 774 | 6 | 21,667 | 157.0 | 156.8 |
| paid-en | 672 | 733 | 4 | 23,747 | 145.8 | 156.8 |
| paid-es | 703 | 728 | 4 | 24,095 | 148.2 | 156.8 |
| maximum-paid-en | 1586 | 1664 | 34 | 82,641 | 200.2 | 156.8 |
| maximum-paid-es | 1614 | 1695 | 34 | 85,175 | 200.6 | 156.8 |

All 231 renders completed. The maximum admitted-text free cases produce 11 pages; maximum paid synthetic stress produces 34 pages / 85,175 bytes. These local values meet the initial local timing/child-memory targets. They do **not** establish total deployed app+child RSS <=75% of the actual function allocation.

Enforced limits: 512 KiB document + 16 KiB chart input; 11 sections / 30 blocks; 32,768 free / 131,072 paid-fixture UTF-16 text units; fixed heading geometry above; 8 MiB output and 64 KiB IPC chunks; 40 production / 80 paid-stress pages; one active child with no queue; 15 s render deadline, route maximum 30 s; 160 MiB old-space / 256 MiB externally sampled child RSS. Output/memory/deadline/client-abort tests kill real processes and prove they are gone before rejection; a fake delayed-close seam separately proves no early slot release.

## Deliberate defect mutations

**54/54 caught by assertions at `795b5b3e6acb706ae12b0720fba83256d26b7251`.** The committed `scripts/verify-reading-mutations.mjs` contains every exact source path, old/new replacement and occurrence count. It requires a clean committed checkpoint, loopback DB and generation off; it records original hashes, applies one mutant, runs the command below, and restores original bytes in `finally`. The two real-app mutants first require a successful production build. Test expectations/snapshots are never changed for a mutant.

The runner rejects transform/import errors, interrupted children and runner timeouts as mutation evidence. After all mutants, it restored sources, rebuilt the worker, reran the unmodified 142 scoped tests, rebuilt production, reran authenticated browser QA and verified clean Git status. The final whole suite, resource benchmark and clean-install/build/browser checks followed on the same unmodified source.

Below, `node` resolves to the recorded `/usr/local/bin/node` (22.22.3). The environment is the local generation-off/integration environment above. Each row names the exact child command and an observed assertion failure; additional failures in the same command are not needed to claim another kill.

The transformation cells use literal `\n` for source newlines; `(delete)` means replacement with the empty string.

| Mutation and exact source change | Executed child command | Observed assertion failure |
| --- | --- | --- |
| **owner-scope**<br>``src/readings/reading-view.ts`` ×2<br>``.where(and(eq(readings.id, readingId), eq(readings.userId, userId))).limit(1)`` → ``.where(eq(readings.id, readingId)).limit(1)`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: unauthenticated, unverified, malformed and cross-owner reads are rejected`` |
| **pinned-identity**<br>``src/readings/reading-view.ts``<br>``if (selector.kind === "document" && (run?.readingId !== chart.id \|\| run.documentId !== selector.id \|\| !document))`` → ``if (false && selector.kind === "document" && (run?.readingId !== chart.id \|\| run.documentId !== selector.id \|\| !document))`` | ``node --import tsx --test '--test-name-pattern=authenticated selectors' tests/readings-page.test.ts`` | ``ERR_ASSERTION: PDF HTTP: authenticated selectors and tenancy fail closed with private headers`` |
| **run-locale**<br>``src/readings/reading-view.ts``<br>``run.locale === document.locale && `` → (delete) | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: mismatched run version/locale/status and stored identity do not select alternate content`` |
| **run-version**<br>``src/readings/reading-view.ts``<br>``run.contentVersion === document.contentVersion && `` → (delete) | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: mismatched run version/locale/status and stored identity do not select alternate content`` |
| **published-state**<br>``src/readings/reading-view.ts``<br>``["completed", "partial", "legacy"].includes(run.status)`` → ``true`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: mismatched run version/locale/status and stored identity do not select alternate content`` |
| **sql-byte-bound**<br>``src/readings/reading-view.ts``<br>``octet_length(${documents.document}::text) <= ${READING_LIMITS.documentBytes}`` → ``true`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: oversized JSON is not transferred from SQL to Node`` |
| **reader-network-dispatch**<br>``src/readings/reading-view.ts``<br>``const store = deps.store ?? new ReadingViewStore();`` → ``const store = deps.store ?? new ReadingViewStore(); await fetch("https://must-not-be-called.invalid");`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: unauthenticated, unverified, malformed and cross-owner reads are rejected`` |
| **free-paid-key**<br>``src/readings/stored-document.ts``<br>``(document.tier === "free" && (source.key !== "overview" && source.key !== "sun"))`` → ``false`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation: free tier rejects paid keys, forged section tiers, duplicate/unknown keys, and malformed headers`` |
| **duplicate-section**<br>``src/readings/stored-document.ts``<br>``seen.has(source.key) \|\| `` → (delete) | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation: free tier rejects paid keys, forged section tiers, duplicate/unknown keys, and malformed headers`` |
| **row-envelope-identity**<br>``src/readings/stored-document.ts``<br>``if (document[key] !== expectedIdentity.data[key])`` → ``if (false && document[key] !== expectedIdentity.data[key])`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation: every row/envelope identity dimension must agree, even for otherwise valid JSON`` |
| **closing-question**<br>``src/readings/stored-document.ts``<br>``section.closingQuestion = question.data`` → ``section.closingQuestion = undefined`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation en: frozen free content, all blocks, questions, ordering and nine static previews`` |
| **unknown-payload**<br>``src/readings/stored-document.ts``<br>``if (!knownKinds.has(kind.data.kind)) { unsupported = true; continue; }`` → ``if (!knownKinds.has(kind.data.kind)) { unsupported = true; section.blocks.push({ kind: "prose", text: "DO_NOT_RENDER" }); continue; }`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation: unknown block is absent, supported siblings and questions survive; all-unknown is not empty success`` |
| **raw-metadata**<br>``src/readings/stored-document.ts``<br>``return { ok: true, value: {\n    kind:`` → ``return { ok: true, value: {\n    ...(raw as Record<string, unknown>), kind:`` | ``node --import tsx --test '--test-name-pattern=canonical saved locale' tests/readings-page.test.ts`` | ``ERR_ASSERTION: PDF HTTP: canonical saved locale/version, frozen text and pinned filenames ignore UI/plan/notes`` |
| **decoder-byte-bound**<br>``src/readings/stored-document.ts``<br>``if (Buffer.byteLength(serialized, "utf8") > READING_LIMITS.documentBytes)`` → ``if (false && Buffer.byteLength(serialized, "utf8") > READING_LIMITS.documentBytes)`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation: byte and aggregate text bounds are independent of per-field bounds`` |
| **aggregate-text-bound**<br>``src/readings/stored-document.ts``<br>``if (textLength > (document.tier`` → ``if (false && textLength > (document.tier`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation: byte and aggregate text bounds are independent of per-field bounds`` |
| **planned-preview**<br>``src/readings/presentation-copy.ts``<br>``sectionDefinition(key).requiresFacts ? "planned" : "not_included"`` → ``false ? "planned" : "not_included"`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: presentation en: frozen free content, all blocks, questions, ordering and nine static previews`` |
| **expired-status**<br>``src/readings/generation-view.ts``<br>``run.expired \|\| !run.owner`` → ``!run.owner`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: generation view extraction: preserves original status/expiry/tombstone semantics`` |
| **ui-locale-overrides-saved**<br>``src/readings/reading-view.ts``<br>``content: decoded.value, generation, availability: "ready"`` → ``content: { ...decoded.value, locale }, generation, availability: "ready"`` | ``node --import tsx --test '--test-name-pattern=canonical saved locale' tests/readings-page.test.ts`` | ``ERR_ASSERTION: PDF HTTP: canonical saved locale/version, frozen text and pinned filenames ignore UI/plan/notes`` |
| **newest-row-substitution**<br>``src/readings/reading-view.ts``<br>``.leftJoin(documents, and(eq(documents.id, runs.documentId),`` → ``.leftJoin(documents, and(eq(documents.id, sql`(select chosen.id from reading_documents chosen where chosen.reading_id = ${readings.id} order by chosen.created_at desc limit 1)`),`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: exact canonical locale/version wins over newer rows, UI locale and subscription`` |
| **paid-provider-dispatch**<br>``src/readings/generate.ts``<br>``const wanted = sectionsForTier(args.tier)`` → ``const wanted = sectionsForTier("paid")`` | ``node --import tsx --test '--test-name-pattern=document: free tier shape' tests/readings-pipeline.test.ts`` | ``ERR_ASSERTION: document: free tier shape, ordering, models, cost accounting, locked sections`` |
| **subscription-selects-paid**<br>``src/readings/reading-view.ts``<br>``document.tier === "free";`` → ``(document.tier === "free" \|\| user.plan === "paid");``<br>``src/readings/reading-view.ts``<br>``{ legacy: run.status === "legacy" }`` → ``{ legacy: run.status === "legacy", allowPaid: user.plan === "paid" }`` | ``node --import tsx --test tests/readings-presentation.test.ts tests/readings-view.test.ts`` | ``ERR_ASSERTION: reader: paid or malformed free rows are unavailable even to a paid account`` |
| **pdf-link-unpinned**<br>``src/components/reading-page-view.tsx``<br>``pdf?${readingEditionQuery(content)}`` → ``pdf`` | ``node --import tsx --test '--test-name-pattern=PDF identity stays pinned' tests/readings-renderer.test.ts`` | ``ERR_ASSERTION: page: PDF identity stays pinned across UI locale/plan, explicit chart edition remains separate`` |
| **pdf-question-dropped**<br>``src/components/solar-pdf.tsx``<br>``if (section.closingQuestion) narrative.push`` → ``if (false && section.closingQuestion) narrative.push`` | ``node --import tsx --test '--test-name-pattern=PDF: frozen free-en' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout`` |
| **pdf-sections-reversed**<br>``src/components/solar-pdf.tsx``<br>``content.sections.forEach(renderSection)`` → ``[...content.sections].reverse().forEach(renderSection)`` | ``node --import tsx --test '--test-name-pattern=PDF: frozen free-en' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout`` |
| **pdf-rows-reversed**<br>``src/components/solar-pdf.tsx``<br>``const rows = block.rows.flatMap`` → ``const rows = [...block.rows].reverse().flatMap`` | ``node --import tsx --test '--test-name-pattern=PDF: long prose' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: long prose, list/keyValue values and a 100-row table split safely with repeated headers`` |
| **pdf-orb-dropped**<br>``src/components/solar-pdf.tsx``<br>```${row.orb}°``` → ``""`` | ``node --import tsx --test '--test-name-pattern=PDF: frozen free-en' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout`` |
| **pdf-accent-dropped**<br>``src/components/solar-pdf.tsx``<br>``pdfLines(value, width, size, renderer, bold).join("\n")`` → ``pdfLines(value.replaceAll("ñ", "n"), width, size, renderer, bold).join("\n")`` | ``node --import tsx --test '--test-name-pattern=PDF: frozen free-es' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: frozen free-es, semantic order, glyphs, metadata and fixed-DPI layout`` |
| **pdf-callout-dropped**<br>``src/components/solar-pdf.tsx``<br>``{wrap(block.text, 475, 9)}`` → ``{""}`` | ``node --import tsx --test '--test-name-pattern=PDF: frozen free-en' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: frozen free-en, semantic order, glyphs, metadata and fixed-DPI layout`` |
| **failed-private-prose**<br>``src/readings/stored-document.ts``<br>``section.blocks = failureFacts(source.key, source.facts, document.locale);`` → ``section.blocks = [{ kind: "prose", text: "PRIVATE_FAILURE_SENTINEL" }];`` | ``node --import tsx --test '--test-name-pattern=failed content and internals' tests/readings-renderer.test.ts`` | ``ERR_ASSERTION: HTML: failed content and internals never render; safe facts and truthful notice do`` |
| **raw-error-logs**<br>``src/readings/pdf-http.ts``<br>``{ ...requestMeta(request), code }`` → ``{ ...requestMeta(request), code, description: error instanceof Error ? error.message : "error" }`` | ``node --import tsx --test '--test-name-pattern=safe render/DB errors' tests/readings-page.test.ts`` | ``ERR_ASSERTION: PDF HTTP: safe render/DB errors, private headers and no raw error logs`` |
| **unknown-drops-sibling**<br>``src/readings/stored-document.ts``<br>``if (!knownKinds.has(kind.data.kind)) { unsupported = true; continue; }`` → ``if (!knownKinds.has(kind.data.kind)) { unsupported = true; section.blocks = []; break; }`` | ``node --import tsx --test '--test-name-pattern=PDF: unknown payload' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: unknown payload is absent while supported siblings, questions and compatibility notices remain`` |
| **polling-post**<br>``src/readings/status-polling.ts``<br>``{ method: "GET", cache: "no-store", signal: controller.signal }`` → ``{ method: "POST", cache: "no-store", signal: controller.signal }`` | ``node --import tsx --test --test-name-pattern=unused/terminal tests/readings-controls.test.ts`` | ``ERR_ASSERTION: polling: unused/terminal initial GET stops; never PUT/POST/consent`` |
| **consent-grant-on-mount**<br>``src/components/reading-generation-controls.tsx``<br>``fetch("/api/readings/consent", { method: "GET",`` → ``fetch("/api/readings/consent", { method: "PUT",`` | ``node --import tsx --test '--test-name-pattern=dashboard en withdrawal' tests/readings-browser.test.ts`` | ``ERR_ASSERTION: browser controls: dashboard en withdrawal has no reading/status dependency`` |
| **lost-post-retry**<br>``src/components/reading-generation-controls.tsx``<br>``// No lost-response POST/PUT retry. Only a new finite GET session.`` → ``await fetch(`/api/readings/${readingId}/generate`, { method: "POST" }).catch(() => undefined);`` | ``node --import tsx --test '--test-name-pattern=lost POST response' tests/readings-browser.test.ts`` | ``ERR_ASSERTION: browser controls: lost POST response checks partial status without automatic POST/PUT retry`` |
| **polling-time-budget**<br>``src/readings/status-polling.ts``<br>``durationMs: 60_000`` → ``durationMs: 600_000`` | ``node --import tsx --test '--test-name-pattern=3/6/10 second' tests/readings-controls.test.ts`` | ``ERR_ASSERTION: polling: 3/6/10 second backoff and a 60 second total budget`` |
| **polling-request-budget**<br>``src/readings/status-polling.ts`` ×2<br>``count >= STATUS_POLL_LIMITS.requests`` → ``false`` | ``node --import tsx --test '--test-name-pattern=hard request cap' tests/readings-controls.test.ts`` | ``ERR_ASSERTION: polling: hard request cap still holds if a clock stops advancing`` |
| **refresh-identity-guard**<br>``src/readings/status-polling.ts``<br>`` \|\| seen.has(view.documentId)`` → (delete) | ``node --import tsx --test '--test-name-pattern=refresh: once' tests/readings-controls.test.ts`` | ``ERR_ASSERTION: refresh: once per published identity for this chart, including unavailable projections`` |
| **native-timer-binding**<br>``src/readings/status-polling.ts``<br>``later: (action, ms) => setTimeout(action, ms), cancel: timer => clearTimeout(timer)`` → ``later: setTimeout, cancel: clearTimeout`` | ``node --import tsx --test '--test-name-pattern=native Window timers' tests/readings-browser.test.ts`` | ``ERR_ASSERTION: browser controls: native Window timers work without fake-clock binding leniency`` |
| **private-cache-header**<br>``src/readings/pdf-http.ts``<br>``for (const { key, value } of [...authenticatedCacheHeaders, ...privateReferrerHeaders])`` → ``for (const { key, value } of [...privateReferrerHeaders])`` | ``node --import tsx --test '--test-name-pattern=authenticated selectors' tests/readings-page.test.ts`` | ``ERR_ASSERTION: PDF HTTP: authenticated selectors and tenancy fail closed with private headers`` |
| **final-ownership-check**<br>``src/readings/pdf-http.ts``<br>``if (!await store.stillOwned`` → ``if (false && !await store.stillOwned`` | ``node --import tsx --test '--test-name-pattern=deletion/replacement during render' tests/readings-page.test.ts`` | ``ERR_ASSERTION: PDF HTTP: deletion/replacement during render discards the bytes and never recreates content`` |
| **parent-input-cap**<br>``src/readings/pdf-render.ts``<br>``if (Buffer.byteLength(serialized) >`` → ``if (false && Buffer.byteLength(serialized) >``<br>``src/readings/pdf-render.ts``<br>``textLength > (input.content.kind === "saved-reading"`` → ``false && textLength > (input.content.kind === "saved-reading"`` | ``node --import tsx --test '--test-name-pattern=oversized input' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: unsupported glyphs and oversized input fail closed before success/fork`` |
| **parent-output-cap**<br>``src/readings/pdf-render.ts``<br>``bytes > limits.outputBytes \|\| `` → (delete) | ``node --import tsx --test '--test-name-pattern=output/memory/deadline caps' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: output/memory/deadline caps terminate real workers, then the slot is reusable`` |
| **concurrency-cap**<br>``src/readings/pdf-render.ts``<br>``if (this.active) throw new ReadingPdfError("pdf_capacity");`` → (delete) | ``node --import tsx --test '--test-name-pattern=abort and concurrent saturation' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: abort and concurrent saturation have no queue and no early slot release`` |
| **early-slot-release**<br>``src/readings/pdf-render.ts``<br>``error ??= code;`` → ``error ??= code; this.active = false;`` | ``node --import tsx --test '--test-name-pattern=abort and concurrent saturation' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: abort and concurrent saturation have no queue and no early slot release`` |
| **promise-only-cancel**<br>``src/readings/pdf-render.ts``<br>``child.kill("SIGKILL");`` → ``// Mutant: do not kill the actual render process.`` | ``node --import tsx --test '--test-name-pattern=abort and concurrent saturation' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: abort and concurrent saturation have no queue and no early slot release`` |
| **external-rss-cap**<br>``src/readings/pdf-render.ts``<br>``if (rss > limits.rssBytes) terminate("pdf_memory_limit");`` → (delete) | ``node --import tsx --test '--test-name-pattern=parent RSS monitoring' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: parent RSS monitoring interrupts a worker whose own JavaScript never yields`` |
| **notes-as-generated-premium**<br>``src/readings/presentation-copy.ts``<br>``"Carta y notas ilustrativas" : "Chart and illustrative notes"`` → ``"TU LECTURA PREMIUM" : "YOUR PREMIUM READING"`` | ``node --import tsx --test '--test-name-pattern=long legacy notes' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: repeated rendering stays semantically/visually stable, long legacy notes stay illustrative`` |
| **mutable-notes-substitution**<br>``src/readings/reading-view.ts``<br>``if (decoded?.ok) return { chart, content: decoded.value, generation, availability: "ready" };`` → ``if (decoded?.ok) return { chart, content: chartNotes(chart, await (deps.notes ?? getReadingNotes)(chart.result, locale), locale, user.plan === "paid"), generation, availability: "ready" };`` | ``node --import tsx --test '--test-name-pattern=actual canonical reads stay frozen' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF/HTML: actual canonical reads stay frozen when mutable editorial notes change`` |
| **section-heading-orphan**<br>``src/components/solar-pdf.tsx``<br>``minPresenceAhead={section.blocks[0]?.kind === "aspectTable" ? 300 : 90}`` → ``minPresenceAhead={0}`` | ``node --import tsx --test '--test-name-pattern=PDF: frozen paid-es' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: frozen paid-es, semantic order, glyphs, metadata and fixed-DPI layout`` |
| **table-heading-orphan**<br>``src/components/solar-pdf.tsx``<br>``if (index === 0) narrative.splice(beforeHeading);`` → (delete) | ``node --import tsx --test '--test-name-pattern=leading long tables' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: leading long tables keep section headings with data; all long cells and Spanish titles survive`` |
| **section-heading-overflow**<br>``src/components/solar-pdf.tsx``<br>``if (headingHeight > PDF_FIXED_LAYOUT_LIMITS.sectionHeadingPt)`` → ``if (false && headingHeight > PDF_FIXED_LAYOUT_LIMITS.sectionHeadingPt)`` | ``node --import tsx --test '--test-name-pattern=multiline section titles' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: multiline section titles and subtitles fail safely before unbreakable heading clipping`` |
| **table-title-overflow**<br>``src/components/solar-pdf.tsx``<br>``if (!inline && repeatedTitle.length > PDF_FIXED_LAYOUT_LIMITS.tableTitleLines)`` → ``if (false && !inline && repeatedTitle.length > PDF_FIXED_LAYOUT_LIMITS.tableTitleLines)`` | ``node --import tsx --test '--test-name-pattern=oversized repeated table headings' tests/pdf.test.ts`` | ``ERR_ASSERTION: PDF: oversized repeated table headings fail pre-layout instead of exhausting the deadline`` |
| **premium-plans-promise**<br>``src/app/pricing/page.tsx``<br>``Full AI interpretations are not available yet; a subscription does not unlock them.`` → ``Premium unlocks all nine generated topics now.`` | ``node --import tsx scripts/verify-reading-browser.ts`` | ``AssertionError: plans do not promise generated paid output`` |
| **raw-client-rsc-prop**<br>``src/app/reading/[id]/page.tsx``<br>``controls={<ReadingGenerationControls key=`` → ``controls={<ReadingGenerationControls {...{ rawDocument: { models: { overview: "fixture-only" } } }} key=`` | ``node --import tsx scripts/verify-reading-browser.ts`` | ``AssertionError: HTML/RSC leak: fixture-only`` |

## Outstanding release gates — not waived

- This feature has **not been pushed, submitted for PR review, merged or deployed** by this delivery. No COMMENT review or new mergeability verdict is claimed. Apply the existing SHA-pinned PR process; a coding-agent verification report is not an independent review. No issue was closed, and #106 must not be claimed complete merely from synthetic renderer capability.
- Hosted PDF qualification remains required: numeric **function** memory allocation (not build-machine RAM), Node version reconciliation, child/permission support, deployed asset tracing, aggregate app+child memory <=75% of allocation, actual cold <=10 s / warm p95 <=5 s and cancellation on the approved isolated deployment. The earlier read-only inspection returned Fluid/standard, a 300 s default and project 22.x versus deployment 26.x, not numeric function MiB or runtime proof. If the request-time host cannot meet the gate, #81/#83 are prerequisites; do not increase timeouts or leave untracked work running.
- Generation-off staging authorization still requires preview isolation, old-dispatch shutdown/drain, recovery/restore/representative-upgrade rehearsal, refreshed cutover counts and the exact-SHA migration/readiness process. The last hosted verification left `0006` pending. Local seven-migration success does not satisfy that gate. This feature does not edit that migration.
- Require authenticated hosted health/readiness and en/es browser/download QA on the approved target; READY status or a protected login page is not application evidence. Roll back only to a reviewed schema-compatible build or forward-fix, never by deleting saved documents/ledger rows or resetting the offer.
- Real-provider/model/prompt quality/cost evaluation, activation credentials, live paid acceptance, email QA and production promotion remain separate. **Generation is off and is not ready for live testing.**

PR148's prior [final verdict](https://github.com/jtanori/solara/pull/148#issuecomment-6936495944) remains scoped to its own reviewed tree. Its low non-blocking empty query/fragment URL observation was not silently bundled into this renderer work. The approved safety/cutover runbook remains authoritative.
