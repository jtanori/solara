# Setting up `VERCEL_AUTOMATION_BYPASS_SECRET`

A step-by-step procedure. For *what the secret is and who holds a copy*, see
[`11-actions-deploys.md`](11-actions-deploys.md) §2.1; this page is the walkthrough.

**What it is for.** Vercel Deployment Protection blocks unauthenticated requests to a protected
deployment. Everything that must read a protected host *without* a browser session — the drift
monitor's probes, `deploy.sh`'s readiness and page checks, Stripe's inbound webhook — has to present
a bypass token. Vercel issues exactly one per project; every consumer holds its own copy.

**Preconditions.**

- Repository admin (environment and secret management needs more than `write`).
- Access to the Vercel project that owns the domain you are verifying.
- `gh` authenticated locally (`gh auth status`).

> **Repository facts checked at the time of writing.** `gh api repos/:owner/:repo/environments`
> reports only `staging` and `production`, both with `protection_rules: 0` and
> `deployment_branch_policy: null`. The `monitoring` environment does **not** exist yet, and the
> branch policies documented in `11-actions-deploys.md` §2 are not enforced. The steps below create
> `monitoring`; tightening `staging`/`production` is separate work.

---

## Step 1. Decide the scope first

Before touching anything, answer these three questions. They determine whether you need one secret
or two.

| Question | Why it matters |
| --- | --- |
| Are staging and production the **same** Vercel project? | Bypass secrets are **per project**. One project → one secret shared by both hosts. Two projects → you need `_STAGING` and `_PRODUCTION` variants and a code change. |
| Is Deployment Protection actually **on**? | If it is off, the header is harmless but unnecessary. The monitor sends it unconditionally either way. |
| Which hosts must be reachable? | `https://staging.thanatos.mx` and `https://www.thanatos.mx`. Preview hosts (`solara-stg.vercel.app`) are only used during a DNS cutover. |

Check the first question in Vercel → Project → Settings → **Domains**. Both custom domains under one
project means one secret is enough.

If they are two projects, **stop** and read
[`plan-drift-monitor-165.md`](../plan-drift-monitor-165.md) §5 — the workflow currently reads a
single `secrets.VERCEL_AUTOMATION_BYPASS_SECRET` for both matrix legs, so a second project requires a
naming change, not just a second secret.

---

## Step 2. Create the secret in Vercel

1. Open the Vercel dashboard for the project.
2. Go to **Settings → Deployment Protection**.
3. Find **Protection Bypass for Automation**.
4. Click **Generate** (or **Add Secret** if one already exists).
5. **Copy the value now.** Vercel shows it once; if you lose it, generate a new one and repeat
   Step 4 onward — the old value stops working.
6. Record only *that it exists* in the `00-manual-setup-ui.md` checklist. **Never record the value**
   in a file, an issue or a PR.

Sanity-check the value from your own machine before wiring it anywhere:

```bash
read -rsp 'bypass secret: ' BYPASS; echo
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "x-vercel-protection-bypass: $BYPASS" \
  https://staging.thanatos.mx/api/version
```

Expected: `200`. A `401`/`403` means the value is wrong or Deployment Protection is configured
differently than assumed. A `302` means the header did not take effect (check for a typo or a
trailing newline in the copied value).

Repeat against `https://www.thanatos.mx/api/version`. Production is public today, so it may answer
`200` with or without the header — that is expected and not a failure.

---

## Step 3. Create the `monitoring` GitHub environment

This is what the drift monitor binds to. It must exist **before** the workflow is promoted to `main`,
because a scheduled workflow that cannot resolve its environment fails every run.

```bash
gh api --method PUT repos/jtanori/solara/environments/monitoring
```

The environment is created with no protection rules. That is correct here: adding a required
reviewer would make every 15-minute cron run hang waiting for approval.

> **Why a dedicated environment.** A job that carries an `environment:` key creates a GitHub
> Deployment (`task: deploy`). Pointing the monitor at `staging` or `production` would fabricate
> ~192 `success` Deployment records a day against `main`'s SHA — including while a real production
> deploy is waiting on approval — corrupting the record ADR 012 and #174 read. The monitor reads only
> its own bypass token and consumes no Vercel deployment.

---

## Step 4. Add the secret to the environment

GitHub offers no API to *read* an environment secret, and the workflow below is the supported way to
write one. Keep the value out of shell history and out of the command line.

```bash
read -rsp 'bypass secret: ' BYPASS; echo

gh secret set VERCEL_AUTOMATION_BYPASS_SECRET \
  -R jtanori/solara \
  -e monitoring \
  -b "$BYPASS"

unset BYPASS
```

Add the same secret to `staging` and `production` (for `deploy.sh`):

```bash
read -rsp 'bypass secret: ' BYPASS; echo

for env in staging production; do
  gh secret set VERCEL_AUTOMATION_BYPASS_SECRET \
    -R jtanori/solara \
    -e "$env" \
    -b "$BYPASS"
done

unset BYPASS
```

Verify the *names* landed — GitHub returns names only, never values:

```bash
for env in monitoring staging production; do
  echo "--- $env ---"
  gh api "repos/jtanori/solara/environments/$env/secrets" --jq '.secrets[].name'
done
```

Expected: `VERCEL_AUTOMATION_BYPASS_SECRET` under all three.

> **Do not add it to Vercel's environment variables.** Those are injected into the running app, and
> no application code reads this value — `grep -rn VERCEL_AUTOMATION_BYPASS_SECRET src/` returns
> nothing. Putting it there puts an unused secret in the runtime process.

---

## Step 5. Add the copy Stripe needs (staging only)

Stripe's endpoint configuration has no header field, so the value goes in the URL as a query
parameter.

1. Stripe Dashboard → **Developers → Webhooks** → the staging endpoint
   (`https://staging.thanatos.mx/api/billing/webhook`).
2. Edit the endpoint URL to append the parameter:

   ```text
   https://staging.thanatos.mx/api/billing/webhook?x-vercel-protection-bypass=<secret>
   ```

3. Click **Send test event.**
4. Expect `200`. A `302` to `vercel.com/sso-api` in the response means protection blocked the
   request, not a signature problem.

Production's endpoint needs no parameter — `www.thanatos.mx` is public.

---

## Step 6. Verify end to end

### 6a. The monitor, with no write

`--dry-run` performs every read and logs the action it *would* take, writing nothing:

```bash
VERCEL_AUTOMATION_BYPASS_SECRET="$BYPASS" \
  npx tsx scripts/drift-monitor.ts --env staging --dry-run
```

Expected on a healthy host:

```text
drift-monitor[<timestamp>]: env=staging kind=exact action=none head=<sha> live=<sha> migrations=exact runs=0
drift-monitor[<timestamp>]: dry-run: would none; no write performed
```

Exit code `0`. A missing or wrong secret instead produces one of:

| Output | Meaning | Fix |
| --- | --- | --- |
| `degraded: unauthorized` / `forbidden` | header rejected | re-check the value; regenerate if unsure |
| `degraded: sso` | Vercel returned its SSO redirect | header not sent or not accepted |
| `rejected: GitHub API 401 …` with exit `1` | *not* a bypass problem — the GitHub token is wrong | check `GITHUB_TOKEN` / `gh auth` |

`exit 1` is reserved for a rejected credential; drift itself is always exit `0`. Run the same
command with `--env production` for the second leg.

> **`kind=unknown` with `exit 0` is not success.** It means the probe could not reach the host at
> all — wrong URL, DNS, no outbound network, or a sandbox that blocks the domain. The tick is
> reported as `degraded` and writes nothing. Only a *reported* `kind` (`exact`,
> `observing-commit`, `behind`, …) proves the read path works. When `kind=unknown` persists from a
> machine that can reach the host, check the URL before the secret.

### 6b. The workflow dry run

`drift-monitor.yml` accepts a `workflow_dispatch` input with a `dry_run` flag, but **it only becomes
dispatchable once the workflow is on the default branch**. Before promotion, run it against the
branch:

```bash
gh workflow run drift-monitor.yml --ref arena/3d452477-solara -f dry_run=true
gh run watch "$(gh run list --workflow=drift-monitor.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expect both matrix legs (`staging`, `production`) to log `kind=exact` (or the real state) and no
`rejected:` line. The run must not have created any Vercel deployment.

### 6c. `deploy.sh` (only if you are deploying today)

The script fails closed on `401`/`403` and prints the remedy:

```text
ERROR: https://staging.thanatos.mx/api/ready is blocked by Vercel Authentication (HTTP 401).
Set VERCEL_AUTOMATION_BYPASS_SECRET for this environment and re-run.
```

A run that reaches `/api/ready` and then renders `/account` means the header is working — `#212`
added that second check precisely because `/api/ready` has its own pool and can be green while pages
500.

---

## Step 7. Rotating it later

`02-stripe.md` recommends rotating after staging QA. Rotation breaks four things if done partially,
so treat it as one checklist:

1. **Vercel** — generate a new bypass secret, then delete the old one.
2. **GitHub** — repeat Step 4 for `monitoring`, `staging` and `production`. A stale value makes the
   monitor exit `1` on every tick and `deploy.sh` hard-fail before it can deploy.
3. **Stripe** — update the staging endpoint URL from Step 5. Deliveries start returning `401` until
   you do.
4. **Your local `.env`** — the `curl` checks in
   [`12-domains-and-email.md`](12-domains-and-email.md) fail until it is refreshed.

Then re-run Step 6a.

Nothing automates this; there is no way for one copy to discover another is stale.

---

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| `401`/`403` from a `curl` that has the header | wrong project's secret, or protection reconfigured | Step 1 (which project owns the domain) |
| `302` to `vercel.com/sso-api` | header absent, or a trailing newline in the value | re-enter with `read -rsp` as in Step 4 |
| Monitor exits `1` with `rejected:` | GitHub token, not the bypass | `gh auth status`; the workflow needs `issues: write` |
| Monitor exit `0` but alerts never close | not a bypass issue — see the D9 degradation log line | `degraded:` in the run output |
| `monitoring` environment missing after promotion | Step 3 was skipped | the scheduled run fails resolving `environment:` |
| Workflow has no `Run workflow` button | it is not on the default branch yet | use `--ref` as in Step 6b |

## What not to do

- **Do not** put it in Vercel environment variables — the app never reads it.
- **Do not** repo-scope `DATABASE_URL` alongside it, or otherwise mix the monitor's credentials. The
  `monitoring` environment holds this one secret and nothing else.
- **Do not** add required reviewers to `monitoring`; the cron would block on every run.
- **Do not** record the value in documentation, issues or a PR description.
