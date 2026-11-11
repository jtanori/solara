## Problem

Nothing tells us **which build we are testing against**. Concretely, after #133 went to staging today (`d7d7634`), answering "what is staging running?" meant guessing which of these was authoritative:

- `docs/deploys.md` — append-only, written only when `deploy.sh` runs. #133 was merged manually, so the row did not exist until I wrote it by hand on #137.
- the `<!-- deploy-record -->` PR comment — same caveat: it exists because `record_deploy` ran, or because someone typed it.
- Vercel's dashboard — true, but off-repo.
- GitHub Deployments — **actively misleading here.** All 12 deployments are `environment: staging`, the newest is the PR *branch* head `002e7b0`, and there is no `production` environment at all. It records "a deploy-ish event happened", not "this is what is live".

And when the deploy silently fails — merge landed, Vercel build died, alias never moved — every one of those can still look right. `scripts/deploy.sh:417` says so itself:

> `# A readiness 200 alone does not prove the new deployment is live: the previous release also serves /api/ready.`

Nothing the running app says can confirm or deny it.

## Constraint: keep the invariant

`AGENTS.md` §105:

> `/api/ready` … returns `503` and `Cache-Control: no-store`, **never hostnames, URLs, or versions**.

**This issue complies with that rule and does not revise it.** No version data enters `/api/health`, `/api/ready`, the footer, or any other public response. All three stay byte-identical.

---

# Proposal v2 — no payload, no sha, no secrets

Revised after feedback: **(1) build-sha comparison is deferred, (2) status-only, gated on never exposing a sha, (3) the key is per-environment.** v1 proposed an HMAC key held by an operator and left the expected-sha source undecided. This version removes both moving parts.

## Step 0 — a build identity that is already in the repo

Today `package.json` has **no `version` field at all** (`node -p "require('./package.json').version"` → `undefined`), so there is nothing to compare against. Everything below depends on that being fixed first, and it is useful on its own.

- Add `"version": "0.0.0"` and let each deploy bump it, or use a monotonically increasing `"build"` integer. The build number is the identity: **`build 47` is a fact about a deploy, not about a commit.**
- `deploy.sh` increments it and writes the new value in the deploy record (`docs/deploys.md` gains a `build` column), so **the repo always contains "build 47 = sha d7d7634 = staging"**. That table is the comparison basis.
- The number is public and non-derivable: knowing `build 47` reveals nothing about any commit. This is the property that makes status-only work.

## The probe: status-only, no sha anywhere

```
GET https://<env-host>/api/ready
  x-solara-build: 47
  x-solara-env: staging
→ 200   (that build, in that env, is answering)
→ 403   (indistinguishable from any other refused request)
```

Server side:

- the running build knows its own number at build time (inlined at compile, server-only, never in a client bundle)
- compare the requested `(build, env)` against its own; on match, 200 with the unchanged `/api/ready` body; otherwise the endpoint behaves as if the header were not understood
- the **response never contains the build number, the sha, a hostname or a URL** — not in the body, not in a header. Success is a bare 200 on the existing payload, and that payload is already public
- the request header is the only place a number appears, and the caller supplied it

`x-solara-env` is required, not inferred, so **a staging caller cannot get a 200 from production** without naming production. Per-environment `BUILD_ATTEST_KEY` ([3] confirmed) means each environment's key is distinct; a request signed for staging is useless against production even if someone replays it.

## What this answers

| question | answer |
| --- | --- |
| Is staging running build 47? | 200 → yes; 403 → no |
| Did the deploy silently fail? | the recorded build still answers → **yes, it failed** |
| What *is* staging running? | binary search the deploy record, then read the row — repo-side, needs no fingerprint |
| Does production expose a sha? | never; no endpoint returns one in any direction |

The last row is the reason for the whole design: an attacker with the key and unlimited guessing can only test hypotheses against a number that is already public. Verifying "did build 47 land" does not leak anything that was not already in the repo.

## Explicit limits — please accept these knowingly

- **"What is live?" is a loop, not a lookup.** You cannot ask the app; you test a guess and read the repo for the answer. For a single environment at a known deploy that is one request. For an unknown state it is `log2(n)` requests against a build list.
- **The build number must never be derived from the sha** (no `sha mod 1000`). Derived numbers are partly invertible and reintroduce the exposure we are avoiding; the counter must be independent.
- **If the counter ever diverges from the deploy record, the probe is useless** — the record is the comparison basis, so `deploy.sh` must write both atomically or fail loudly. #136's dry-run and this share that requirement.

## Acceptance criteria

- [ ] `package.json` has a build identity; `deploy.sh` bumps it once per successful deploy and refuses to deploy if the record and the counter disagree
- [ ] `docs/deploys.md` gains a `build` column; the existing row for `d7d7634` is backfilled as `build 1` (first recorded deploy) for continuity
- [ ] `/api/health`, `/api/ready` and the footer: **unchanged**; a test asserts no response body or header contains a sha, a hostname or a version
- [ ] the probe returns 200 for the correct `(build, env)` and 403 otherwise; the 403 is byte-identical to the 403 returned for an unrelated refused request
- [ ] no response header echoes the build number; asserted by diffing full response headers for a match and a mismatch
- [ ] `x-solara-env` is required; omitting it is a 403, never an inferred default
- [ ] key is per-environment; a staging key produces 403 against production (tested with two keys)
- [ ] missing key config → fail closed (403) in production, loud log, never a 500 that explains itself
- [ ] `deploy.sh` post-merge asserts the probe before reporting success — replacing "trust Vercel's status" with "this build answered"
- [ ] operator command documented and tested: give it env URL + build number → match / mismatch / unreachable, printing no secrets
- [ ] mutation check: returning 200 regardless of the header must turn the probe test red

## Deferred (agreed with the requester)

- **Asserting a commit sha in the probe.** Explicitly out of scope for v2: the requester has no answer yet on where an operator gets the expected sha, and until that is settled the probe compares build numbers only. Revisit once automatic version bumps have been running long enough that "build 47 = sha X" is trustworthy in the record.
- Automatic version bumps on every deploy *from CI rather than the operator's machine* — related but separate; called out here because the probe's usefulness depends on it.
- Changes to `log.ts` redaction (a 40-char sha currently logs as `build=[hex]`; a 12-char sha survives). Only relevant if boot logging is also wanted.
- Sentry-style release association; semver or release channels.

## Open questions

1. **Counter commits how?** A version bump means `deploy.sh` writes a commit to the target branch. That is a new behaviour for the script and interacts with `protect-main`'s strict checks — worth its own decision, and the reason step 0 may want to land separately from the probe.
2. **Backfill `d7d7634` as build 1, or start the counter at the first deploy under this scheme?** Restarting is cleaner; backfilling makes the existing deploy record immediately useful.
