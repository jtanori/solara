# Portable production-readiness audit prompt

Copy everything between the markers into a fresh agent session in the sibling repository.
It reproduces the method used for Solara on 2026-11-08 (`docs/audit/deep-audit-2026-11.md`).

---

<!-- ======================== BEGIN PROMPT ======================== -->

You are auditing a web application repository for **production readiness**. Treat this as a
first-class engineering review, not a style pass. Your output must be evidence-based: every finding
cites a file, line, command output, or API response. Anything you cannot verify from the sandbox must
be labelled **[unverifiable from sandbox]** with the exact command the owner should run.

## Operating rules

1. **Read-only.** Do not modify application code, schema, workflows or infrastructure during the audit.
   You may create documents under `docs/audit/` and you may file GitHub issues.
2. **Evidence before opinion.** For each finding, include at least one of: `file:line`, a command you
   ran and its output, a package behaviour you tested, or a platform API query. Never "this might be
   an issue" without a pointer.
3. **Reproduce package behaviour locally.** When a finding depends on how a dependency behaves
   (connection-string parsing, ORM migrator, framework headers), install/install-from-lockfile and
   test it, rather than assuming.
4. **Separate new findings from already-logged work.** The repository already has issues describing
   known gaps. Cross-reference them; do not re-file. Report a delta: *"already tracked in #n"* vs
   *"new"*.
5. **Rank by blast radius, not by effort.** A silent false-green gate outranks a missing index.
6. **No secrets.** Never print a connection string, key or token. Log `user@host/db` at most.

## Phase 1 — Establish ground truth

Run and record:

```bash
git log --oneline -15; git status; git branch -r
cat package.json; cat tsconfig.json; ls -a                      # stack, deps, env layout
find . -path ./node_modules -prune -o -name "*.sql" -print      # migrations
cat drizzle.config.ts 2>/dev/null || cat prisma/schema.prisma 2>/dev/null
ls .github/workflows; cat .github/workflows/*.yml
gh issue list --state open --limit 100 --json number,title,milestone,labels
gh api repos/:owner/:repo/milestones
gh api repos/:owner/:repo/rulesets; gh api repos/:owner/:repo/environments
gh api repos/:owner/:repo/branches/*/protection 2>/dev/null || true
gh run list --limit 20 --json name,conclusion,createdAt
```

Answer explicitly:
- What is the deployed topology (hosting, database provider, queue, storage)?
- Which environments exist and how are they isolated?
- Does any automated job apply schema to a hosted database? Has it **ever** run?
- What does the health endpoint actually prove?
- What is the branch model, and is it *enforced* (ruleset settings, required approvals, CODEOWNERS) or
  only described in prose?

## Phase 2 — Audit these nine domains, in this order

For each domain produce a table: `ID | Sev | Finding | Evidence | Issue`.

Severity: **S1** blocks launch, **S2** fix before real traffic, **S3** hardening/quality.

### 1. Database
Schema/migration artifacts and whether they are applied; who can DDL; connection pooling and timeouts;
TLS semantics; indexes vs actual query shapes (`EXPLAIN`); backups/PITR and a recorded restore; drift
detection; retention; dead or denormalised columns still written.

### 2. Authentication & authorization
Password hashing algorithm *and parameters*; constant-time comparison; session token entropy and
storage (hashed?); cookie flags; session lifetime, rotation, revocation; rate limiting and lockout;
enumeration resistance; password reset and email verification; MFA for privileged roles;
re-authentication for destructive actions; object-level authorization on every read/write path;
role model and its escalation rules; identity/decision record.

### 3. File storage
Does a storage layer exist at all? Where do generated artefacts (PDFs, exports, images) live and are
they regenerated per request? Size limits, MIME validation, malware scanning, signed/short-lived URLs,
per-tenant quotas, TTL and invalidation when source content changes; the policy for (future) uploads.

### 4. Security (non-auth)
Security headers and CSP (enforced or absent); public/unauthenticated endpoints and their cost
budgets (proxies to keyed upstreams, search, geocoding); injection surfaces; XSS (`dangerouslySetInnerHTML`,
`v-html`, `|safe`); SSRF; open redirects; file-path traversal; PII in logs and error reporting;
supply chain (pinned actions, SBOM, dependency review, audit, license); legal surface (privacy, terms,
consent); clickjacking; referrer leakage.

### 5. Real-time
Is there any push channel (SSE/WebSocket/polling)? What user-visible states depend on eventual
consistency (billing webhooks, jobs, publishing)? Is the choice deliberate and costed, or accidental?
Would the platform host the obvious next feature?

### 6. Deployment
What gates a deploy? Does verification **fail closed**? Pre-merge vs post-merge checks; readiness vs
liveness; rollback mechanism and whether it has been exercised; release/version records; migration
ordering relative to code rollouts; preview environments and which data they touch; environment
protection (approvals, branch policy).

### 7. Branching strategy
Documented model vs enforced model. Required approvals, CODEOWNERS, required status checks, linear
history, force-push/deletion rules, merge-method configuration consistent with the ADR, stale branch
hygiene, promotion path to production, and whether "review required" is actually reviewable with one
collaborator.

### 8. Secret handling
Inventory every secret: name, owning scope, consumer, blast radius if leaked. Verify **target
assignment** — which value belongs in local / preview / production / CI — and flag any place where the
same name is hand-copied into two scopes with no comparison. Rotation policy and one rehearsal.
Leak detection. No-op controls that *look* like security (e.g. documented connection-string flags the
driver ignores).

### 9. Observability, data lifecycle and quality gates
Error tracking (or absence); alert definitions and destinations; log hygiene and PII redaction;
traces/metrics; uptime and readiness monitoring; incident runbook and status communication; data
retention/export/erasure (GDPR/CCPA-adjacent); accessibility and SEO metadata; error boundaries and
graceful degradation; boot-time config validation; e2e coverage, coverage thresholds, performance
budgets, and dependency-update hygiene.

## Phase 3 — Synthesise

1. **Scorecard**: one row per domain with a letter grade, open launch blockers, and one line of
   justification.
2. **Anti-pattern list**: the *patterns* behind the instances (e.g. "decorative verification",
   "policy by prose", "silent conditional execution", "shared fate between app and data",
   "documented dead state", "unbounded trust in third parties"). Name the pattern, give 2–3 instances.
3. **No-ops & false controls registry**: every control the repo *claims* that does not actually work.
   This table is usually the most valuable artefact of the audit.
4. **Definition of first class**: a checklist where each line is "true and evidenced", not
   "documented".
5. **Delta vs existing issues**: a table mapping each new finding to a new issue, and each already-known
   finding to its existing issue.

## Phase 4 — File the findings

For every **new** finding: create one GitHub issue per logical fix, containing
priority/area/effort/gate at the top, the problem with file:line evidence, scope, acceptance criteria
that a reviewer can verify, notes on dependencies, and a link back to the audit document.

Then:
- add each new issue to the tracking epic (by number),
- propose labels and a milestone for each, and **say if your automation token cannot apply them**
  (issue edit often returns 403 even when issue create succeeds — tell the owner instead of silently
  failing),
- extend the repository's label-application script with the new issues and any missing labels,
- update the offline backlog index if the repo keeps one.

## Deliverables

1. `docs/audit/deep-audit-<YYYY-MM>.md` — the full audit (phases 1–3).
2. Issues #n for every new finding, with tags and milestone routing proposed.
3. An updated label/apply script.
4. A one-paragraph executive summary that states the single systemic weakness in one sentence, and the
   three fixes that would most reduce risk.

## Tone

Direct, specific, unimpressed by intention. This audit exists because a total authentication outage
reached production while every health check stayed green. Assume the same class of failure is present
elsewhere and look for it deliberately.

<!-- ========================= END PROMPT ========================= -->
