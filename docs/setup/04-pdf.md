# 4. Private saved-reading and chart-note PDFs

## Editions and access

`GET /api/readings/<reading-id>/pdf` is dynamic, Node-only and verified-owner-only.
It uses the same bounded SELECT-only projection as `/reading/<reading-id>`:

- A coherent published lifetime-free run selects **exactly its canonical saved
  document**, not the newest row, interface language, or subscription. Free
  prose is `overview` + `sun`, including saved questions. Partial content stays
  partial. Both adapters show nine static topic previews, explicitly distinguishing
  unavailable paid generation from planned profection/transit calculations.
- `?document=<uuid>` pins that identity. Stale/foreign IDs do not substitute another
  reading. The page’s generated-reading download link always pins the document.
- `?edition=chart` pins the saved-chart / **illustrative notes** edition. Its notes
  are mutable editorial material; active verified subscriptions retain the
  existing Moon/Ascendant/house notes. Subscription does **not** select a paid AI
  document. The page keeps these editions separate.
- Saved documents and their PDFs retain their saved language, date and versions.
  The interface language only controls navigation/status and illustrative notes.
  Editing a note cannot change a saved document’s prose.

Downloads/prefetch/HEAD/status reads never dispatch generation, re-grant consent,
repair content or reset the lifetime offer. Withdrawn consent and disabled
providers do not hide an otherwise valid saved reading. HEAD authenticates and
selects without rendering discarded bytes. No PDF is stored or publicly shared.
The decorative on-screen wheel is not a computed chart. Calculations remain
preliminary; HTML is the accessible primary format (no PDF/UA claim).

All responses, including errors, set `Cache-Control: private, no-store`,
`Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. Filenames use
only validated year, saved locale and edition, never names/provider metadata.
The independent download quota remains **20/account/hour**. Errors are stable
codes: 401 unauthenticated/unverified, 400 invalid selectors, 404 inaccessible,
409 unsafe/unrepresentable selected content, 429 quota, 503 availability/capacity/
timeout. A missing document store is not an unused offer. Explicit chart mode
can still work independently. Ownership/canonical identity is rechecked after
rendering; already-delivered bytes cannot be recalled after deletion.

## Build and renderer boundaries

`npm run dev` and `npm run build` automatically run `npm run pdf:build`. The
esbuild script produces an ignored `.pdf/` bundle, bootstrap, local fonts/license,
PDFKit builtin metrics/private import map and ICC asset. `next.config.ts` traces
**only that directory** into the PDF function. Do not deploy without it. No
runtime tsx/dev dependency is needed. No remote fonts/images or arbitrary links
are rendered. The pinned Noto Sans Latin WOFFs and SIL license live in
`src/readings/fonts/`; unsupported glyphs fail safely instead of becoming boxes.

`.vercelignore` excludes `tests/` and the local reading browser, benchmark and
mutation runners that depend on those fixtures. It must retain `build-pdf.mjs`
and the renderer/font sources. `tests/deployment-inputs.test.ts` applies those
exclusions to a disposable tracked-source copy, asserts both boundaries and runs
strict TypeScript checking there; a full-checkout build alone misses this class
of deployment-only import failure. Local/CI typechecking still includes the
runners and tests; production typechecking is not disabled.

The typed `SolarReturnDocument({ chart, content, renderer })` replaces the old
notes/premium overload. Five block kinds share the same minimal projection as
HTML. Small tables stay inline; long tables have repeated fixed column headers,
measured cell wrapping, and bounded row fragments for over-page rows. Ordinary
prose/list/callout/key-value content can flow across pages. Questions, accents,
degree values and every row remain selectable text. Page counts are not fixed.

Each request forks one fresh, terminable Node process:

| Boundary | Enforced limit |
| --- | --- |
| Saved JSON / chart JSON before transfer | 512 KiB / 16 KiB |
| Sections / blocks per section | 11 / 30; existing per-block field/array limits |
| Aggregate free / paid-fixture text | 32,768 / 131,072 UTF-16 units |
| Fixed layout geometry | Section heading group <=400 pt; repeated table title <=20 measured lines |
| PDF output | 8 MiB, checked during collection in child and parent |
| Pages | 40 production / 80 synthetic paid-renderer stress |
| Concurrency | One active child per Node process, zero pending queue |
| Render deadline | 15 s; route `maxDuration = 30` leaves read/cleanup headroom |
| Child heap / RSS | 160 MiB V8 old-space; 256 MiB externally sampled RSS ceiling |

The fixed-layout caps leave space for opening content and a full bounded table
row fragment. Character limits alone do not constrain height: a short title can
contain many newlines. Such an unrepresentable PDF returns `pdf_input_limit`
(409) before layout, without clipping or rewriting text; the saved HTML remains
available. Ordinary prose and large blocks still wrap, and normal frozen snapshots
are unchanged by this guard.

The child receives only chart display data and the validated content projection,
not raw documents, birth input, account/run/consent/attempt records, DB URLs or
provider keys. Its environment is allowlisted, fs reads are restricted to its
bundle directory, writes/child processes/native addons are denied, and network
entrypoints are disabled before dependencies load. This is defense in depth for
our own renderer, not an arbitrary-JavaScript sandbox. Yoga uses its embedded
base64 WASM rather than remote fetching. Child stdout/stderr is discarded.

Timeout/client abort/output or memory failure kills the actual child. The
promise and render slot are not released until its `close` event. A timer around
an uncanceled React-PDF promise is not sufficient. Linux `/proc` sampling runs in
the parent even when child layout blocks its own event loop; it is a sampled
native-memory guard, not an OS hard-memory reservation. No DB transaction spans
layout. Logs contain stable failure codes, not renderer/DB error objects or text.

## Local verification (synthetic only)

Use a migrated disposable loopback PostgreSQL database, Node 22, and generation
off. No email/Stripe/AI credentials are needed. New dependencies are pinned
**dev-only**: esbuild, pdfjs-dist, @napi-rs/canvas, playwright-core and
@sparticuz/chromium. Browser tests use the pinned Linux binary and bundled NSS/
NSPR libraries; they do not disable browser web security or modify app headers.

```bash
# DATABASE_URL must already identify a migrated disposable loopback database.
export READINGS_GENERATION_ENABLED=false RUN_INTEGRATION_TESTS=1 RUN_BILLING_INTEGRATION_TESTS=1
npm run pdf:build
npx tsx --test tests/readings-presentation.test.ts tests/readings-renderer.test.ts tests/readings-controls.test.ts tests/readings-browser.test.ts tests/pdf.test.ts
npx tsx --test tests/readings-view.test.ts tests/readings-page.test.ts tests/readings-service.test.ts
npm run build && node scripts/check-pdf-package.mjs
npx tsx scripts/verify-reading-browser.ts
# Commit a clean checkpoint first; deliberately mutates then restores sources.
node scripts/verify-reading-mutations.mjs
npx tsx scripts/benchmark-reading-pdf.ts
```

The component browser tests mock the Next boundary and API replies. The separate
production-mode browser script starts/tears down a local Next server and uses
real synthetic session/subscription rows, authenticated HTML/RSC, native timers,
PDF downloads and navigation. It blocks remote browser assets and server fetch,
without weakening application security headers; public UI webfonts therefore
use their system fallback during this offline check. The 200% test emulates a
half-width, doubled-density layout viewport; it is not a browser-toolbar zoom or
screen-reader certification.

PDF tests extract text/metadata, check ordering and glyphs, rasterize at 96 DPI,
and compare committed small text/hash snapshots. Generated PDF/PNG files and
benchmark samples stay under ignored `.venv/`, not Git. Intentional snapshot
updates require `UPDATE_READING_PDF_SNAPSHOTS=1` plus manual visual review; never
use that flag to make a defect mutation pass. The author verification document
records scope, measured results and unverified gates separately.

## Staging / production gates — still required

Local benchmarks are **not hosted evidence**. Confirm numeric runtime-memory
allocation, deployed Node version, process/permission support, worker/font/NFT
packaging, peak aggregate app+child RSS <=75% of that allocation, cold <=10 s and
warm p95 <=5 s, and cancellation on the actual approved isolated deployment.
A read-only project/deployment inspection showed Fluid/standard memory class and
a 300 s default function timeout; it did **not** expose a numeric runtime-memory
allocation. Do not confuse build-machine memory with function memory. The
project/deployment Node-version fields also need reconciliation at rollout.

If the admitted report or host cannot meet these limits, private artifact/jobs
under #81 and status/readiness under #83 become prerequisites. Do not extend the
timeout, leave an untracked background promise, or open public storage. These
benchmarks do not authorize paid production selection/generation (#107/#108/#110).

The generation-off rollout still requires preview isolation, old-dispatch drain,
recovery/restore/upgrade rehearsal, exact-SHA migration/readiness checks and real
authenticated en/es browser/download QA. The last hosted verification had `0006`
pending. This change adds no migration and must not rewrite it. Keep generation
off; real-provider evaluation/activation, email QA and production promotion remain
separate. Roll back only to a schema-compatible reviewed build or forward-fix;
never delete documents/ledger rows to reset access.
