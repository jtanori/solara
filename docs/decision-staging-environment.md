# Decision: how staging identifies itself on Vercel

**Status:** recommended (option B), awaiting operator sign-off. **Date:** 2026-11-19. **Owner:** operator.
**Affects:** #164 (this PR), #162 (Phase 0 inventory), #171 (`deploy-staging.yml`), #167 (readiness
states), #178 (tracker).

**Recommendation: keep staging as a Preview deployment and identify it from the Git branch** —
`VERCEL_ENV === "preview"` **and** `VERCEL_GIT_COMMIT_REF === "staging"` → `env:"staging"`. No plan
upgrade, no second project, no Vercel setting. The explicit `APP_DEPLOY_ENV` variable still takes
precedence, so a paid custom environment can replace this later without touching code.

Records a real constraint discovered while planning #164: **`VERCEL_ENV` is not `staging` on
staging**, and the project has no custom environments because it is on Hobby. Three ways out;
§3 compares them, §4 recommends, §7 lists what would change the answer.

This PR changes **documents only**. No Vercel setting is touched, and no project, domain or
environment variable is created — those remain the operator's decisions.

## 1. The observed fact

Read from the Vercel API, not inferred. Deployment `dpl_Cb6vgmbzBKobR1Xajtw5mq8jJ5rc` is the
merge of PR #161, served at `solara-stg.vercel.app`:

| Field | Value |
| --- | --- |
| `target` | `null` (not a Vercel *Production* deployment) |
| OIDC claim `environment` | `preview` |
| `meta.githubCommitRef` | `staging` |
| `meta.githubCommitRepo` | `solara` |

And for a feature preview (`dpl_6q3nExFJyLXgfZjdESouTHX6J6CP`): `githubCommitRef` is
`arena/0cabd00f-solara`.

The domain entry confirms the same binding from the other side — `list_project_domains` returns
`solara-stg.vercel.app` with `"git_branch": "staging"` and `"customEnvironmentId": null`. It is a
**branch-linked Vercel domain**, not an alias and not a custom environment.

**So staging is a preview deployment bound to the `staging` branch and served from a branch-linked
domain.** `VERCEL_ENV` there is `preview`, so `VERCEL_ENV === "staging"` is dead code anywhere in
this repository, and the value must be derived from something else.

`plan-deployment-alignment.md` §7 is not wrong, but it is incomplete: it assumes `APP_DEPLOY_ENV`
is set, without recording that setting it on the `staging` branch is a control-plane change that
nothing in the repository can make. #171 makes the same assumption implicitly. This record supplies
the missing default.

### Why this matters now, not later

`/api/version` (#164) must answer *"what is serving right now?"*. If staging reports `env:"preview"`,
then #171's gate cannot distinguish the staging deployment from any feature-branch preview — the
two are the same word to the app. A gate that cannot tell them apart will pass a staging check
against a pulled-request preview, or fail to notice that the staging alias points at a preview that
is not the merge.

## 2. The constraint

**Vercel custom environments are a paid feature, and this project is on Hobby.** Hobby includes
*no* custom environments; Pro includes one per project; Enterprise twelve. (Vercel pricing, checked 2026-11-13: Hobby $0, **zero custom environments**; Pro $20/mo, one custom
environment per project; Enterprise, twelve; additional Pro packs of five at $50/mo. An earlier
revision quoted Hobby as "1 environment per project", which contradicted the sentence it sat in —
that figure counts standard environments, not custom ones. Treat these numbers as indicative and
reconfirm on vercel.com before any purchase, since this record must not be the reason someone spends
money on a wrong number.)

This project is `"plan": "hobby"` — read from the Vercel project API for `solara`, not assumed.
Hobby is also **non-commercial only**, so a Hobby project cannot host a paid launch indefinitely and
an upgrade is likely for its own reasons eventually. That upgrade should not be *forced* by a
build-identity field, and the answer has to work on the current plan.

## 3. Options

### A — A second Vercel project for staging (`solara-stg`)

Separate project, `productionBranch: staging`, its own domain, its own environment variables.

| | |
| --- | --- |
| **Staging reports** | `env:"production"` — correct in the sense that it *is* that project's production deployment |
| **Control-plane cost** | New project, new env var set (a second copy of every secret), new Deployment Protection config and bypass token, and `solara-stg.vercel.app` **moved** — it is currently a branch-linked domain (`git_branch: staging`) in the existing project, so it must be removed there and re-added, which is a live-domain outage window rather than a rename |
| **Code cost** | None beyond #164 as planned |
| **Free-tier cost** | Fits: Hobby allows 200 projects. Doubles build minutes for the same commit (one build per project) |
| **Risk** | Two projects means two sets of environment variables that can drift. The staging database URL now lives in a project whose *production* environment holds it — the same class of mistake the boot guard (#168) exists to catch, but harder: a staging project whose "production" is staging invites exactly one copy-paste error into the real production project. Every "is this production?" question acquires a second, project-dependent answer |
| **Reversibility** | Moderate: requires alias move and env var migration back |

The naming problem is the real objection. In a second project, staging is *Production* — so every
guard, every `VERCEL_ENV === "production"` check, and every "never touch production from staging"
rule becomes ambiguous. The current design leans on the distinction between Vercel's Production and
Preview as a safety property.

### B — Keep staging as a preview, identify it by branch ref (**recommended**)

`APP_DEPLOY_ENV` is derived, and the *last* fallback before `local` is the branch:

```text
APP_DEPLOY_ENV
  → (VERCEL_ENV === "preview" && VERCEL_GIT_COMMIT_REF === "staging") ? "staging"
  → VERCEL_ENV                       (production | preview | development)
  → "local"
```

Two preconditions, both verified rather than assumed:

- **`VERCEL_GIT_COMMIT_REF` is a runtime variable, not only a build variable.** Vercel's system
  environment variable reference lists it as *"Available at: Both build and runtime"* — it is the
  one field this design depends on, so a build-only variable would have made B impossible.
- **The project already exposes system variables without opt-in.** `autoExposeSystemEnvs: true` on
  `prj_IKhfjZr67qbg3s0qvDPVhbqqlMwl`, so no setting has to be flipped for either variable to appear
  in the function at runtime. This is the difference between B costing nothing and B costing a
  control-plane change.

| | |
| --- | --- |
| **Staging reports** | `env:"staging"`, from the branch the deployment was built from |
| **Control-plane cost** | **Zero.** No new project, no new env var, no Vercel setting |
| **Code cost** | One branch in the stamp resolver's `env` order, plus a test per branch. It is *not* a second resolution path: the stamp resolver is the only implementation (§5 of the plan), so this is a branch in existing code, not three new lines somewhere else |
| **Free-tier cost** | None |
| **Risk** | `VERCEL_GIT_COMMIT_REF` is metadata, not a security boundary: anyone who can push to `staging` can make a deployment report `staging`. But anyone who can push to `staging` can already deploy staging, so the field grants nothing they did not have. It is an identity claim, not an authorization claim — and #171's gate also checks `commit` against the merge SHA, which is the check that actually matters |
| **Reversibility** | Trivial: the explicit `APP_DEPLOY_ENV` variable still wins, so adopting A or C later is one env var, no code change |

The reason this is clean rather than a hack: the deployment **is** built from `staging`, Vercel
records that fact, and the app reads it. Nothing is inferred or spoofed locally.

### C — Move to Pro and use a custom environment

One custom environment named `staging`, `staging` branch scoped, full runtime-variable isolation.

| | |
| --- | --- |
| **Staging reports** | `env:"staging"` natively, and Vercel enforces the variable scoping |
| **Control-plane cost** | Plan upgrade ($20/mo), then custom environment creation, env var re-scoping |
| **Code cost** | None |
| **Free-tier cost** | Ends the free tier |
| **Risk** | Low technically; the real cost is that a plan upgrade is a business decision and this is a *build-identity* field, not the reason to spend |
| **Reversibility** | Costs money to undo |

C is the correct end state for the #171 pipeline — it is what plan §7 assumes, and custom
environments are the mechanism #162's Phase 0 inventory is meant to record. It is not the correct
*next* step, because nothing about #164 requires it and Hobby is non-commercial-only anyway, so the
upgrade will be forced by a commercial decision with its own timing.

### Interaction with #171 (the reason the fallback order is shaped this way)

Today's deployments come from Vercel's Git integration reacting to a PR, which is why
`githubCommitRef` is populated. Under #171 the deploy is created by `deploy-staging.yml` running
`vercel deploy --prebuilt`, and **whether Vercel populates `VERCEL_GIT_COMMIT_REF` for a
CLI-created deployment is an open question** — it is one of the things #162 ("runtime variable
injection mechanism and environment/branch scope") exists to determine, and it is the same question
as the `--env` semantics that issue already owns.

That does not undermine B, because it inverts the priority rather than breaking it:

- In **Actions**, the deployment's environment is *known at dispatch time* — the workflow is
  deploying staging, on purpose. It can pass `APP_DEPLOY_ENV=staging` explicitly, which is
  something the Git-integration path cannot do without a control-plane setting. So under #171 the
  explicit variable is the primary mechanism and the branch mapping becomes the fallback for
  out-of-band deploys.
- In the **transitional period** (now), there is no workflow, so the branch mapping is the only
  available mechanism — which is exactly why it must exist and why it must not be the only one.

The resolution order above is deliberately the same order in both worlds, so #171 can adopt explicit
injection without rewriting the resolver and without this decision being re-litigated.

One control-plane observation to hand to #162 rather than resolve here: the project reports
`gitProviderOptions.createDeployments: "disabled"` alongside `gitComments.onPullRequest: true`, yet
PR #201's commit `8d607c2` did produce a preview deployment. Those settings are not what they
appear to be, and the deploy-trigger path matters for both #171 and #162. Recorded as an unknown,
not assumed.

## 4. Recommendation

**Adopt B now, plan C as the end state.**

- B costs zero control-plane change and one branch in the resolver, and gives #164 a correct `env`
  on staging today.
- B leaves the explicit `APP_DEPLOY_ENV` override in front, so C (or A) can be adopted later with
  **no code change** — set the variable and it wins.
- C stays the target for #171, because once the Actions workflow owns deployment it will inject
  runtime variables for a promoted candidate (#162's correction already requires this to be a
  recorded prerequisite), and custom environments are the natural scope for that.

Do **not** adopt A. It inverts the meaning of Vercel's own Production environment for staging: the
name `production` would then be true of two different things, and every guard and rule that reads it
becomes ambiguous — #168's `APP_DEPLOY_ENV` → DB-endpoint rows, "never touch production from
staging", and the instruction a future agent follows when the two disagree. That is not a
hypothetical: this repository's guard work already keys off the environment name, and the value
would stop being answerable without naming which project you meant. Add the live-domain move and it
is the most invasive of the three for a naming problem.

For accuracy about what breaks: `security-headers.ts` uses `VERCEL_ENV === "production"` for exactly
one thing, adding HSTS. So a second project reporting `production` would not *weaken*
`solara-stg`'s headers — it would add HSTS to it. The objection to A is the ambiguity above, not a
header regression, and an earlier revision of this record overstated that.

## 5. What changes in this PR

`docs/plan-build-identity-164.md`:

- **D8** now specifies the branch-ref step explicitly, and no longer says staging "must set
  `APP_DEPLOY_ENV` explicitly" — it says staging *is identified by* the explicit variable *or*, if
  absent, by the branch the preview was built from.
- The `env` resolution table in §5 gains the branch step, and the test-plan table gains four cases
  (including the one proving the explicit variable still wins).
- Landmine 6 records the observed `VERCEL_ENV: "preview"` so the next reader does not re-derive it.
- The "open for implementation" note about branch-scoped variables is replaced by this decision.
- The hosted verification step now uses `vercel curl` and states that an SSO challenge is not a
  failed mapping.

`docs/plan-deployment-alignment.md`:

- §7's `preview` guard row gains a note that staging resolves to the `staging` row, so the
  transitional `ALLOW_PREVIEW_ON_STAGING=1` exception no longer applies to staging.

No code beyond #164's own scope. No Vercel setting is touched by this PR.

## 6. A second effect: the preview database guard gets simpler

`plan-deployment-alignment.md` §7 defines the boot guard over `APP_DEPLOY_ENV`, and its `preview`
row currently needs a transitional exception (`ALLOW_PREVIEW_ON_STAGING=1`) because staging and
feature previews are indistinguishable — both are `preview` to Vercel.

Under B they are distinguishable: the staging deployment reports `staging`, so the guard's `staging`
row applies to it (staging DB endpoint, read-only-or-direct as that row allows), and the `preview`
row applies **only** to genuine feature previews. That is strictly stronger than the exception:

- staging is checked against the staging endpoint, so a staging deployment pointed at production
  fails closed at boot instead of relying on the exception being left off;
- feature previews keep the strict rule and no longer need an escape hatch that, if left enabled,
  would also have covered staging.

The exception is therefore **not needed for staging**. It may still be needed for the separate
question of whether a preview may *read* staging at all (`plan-deployment-alignment.md` §7 option 2),
which is a different decision with its own prerequisite (Phase 0 proving routing, read-only
credential). That decision is unaffected by this one; this only removes staging from its scope.

This makes the `VERCEL_GIT_COMMIT_REF` mapping load-bearing for the #168 guard as well as for
#171's gate, which raises the value of the pinned test in §7. It also raises the cost of a silent
regression: if the mapping stops working, staging falls back to `preview` and the guard's strict
preview rule rejects the staging database — fail closed, at boot, loudly. That is the correct
direction to fail.

## 7. What would change the decision

- **Moving to Pro for any other reason** (commercial launch, custom domains, spend cap): adopt C in
  the same change, since the custom environment is then free-tier-irrelevant and strictly better.
- **A second staging deployment** (a canary, or a second region): A's per-project isolation becomes
  attractive, and B's single-branch mapping stops being sufficient.
- **`VERCEL_GIT_COMMIT_REF` proving unreliable** for the merge commit — if a Vercel behaviour
  change stops recording it, B degrades to `preview` and #171's gate fails closed. That is the safe
  direction, and the test in #164 pins the mapping so the regression is visible rather than silent.
- **#162 finding that CLI deployments do not carry the branch ref at all** — B's branch step is then
  transitional only, and #171 must pass `APP_DEPLOY_ENV` explicitly on every deploy. The resolver
  order is unchanged; only which step fires changes.

## 8. Verification this decision depends on

Cheap, and they belong in #164's unit tests rather than in a spike — env vars mean the resolver can
be tested directly:

1. `VERCEL_ENV=preview` + `VERCEL_GIT_COMMIT_REF=staging` → `env:"staging"`.
2. `VERCEL_ENV=preview` + `VERCEL_GIT_COMMIT_REF=feature/x` → `env:"preview"`.
3. `APP_DEPLOY_ENV=production` + `VERCEL_GIT_COMMIT_REF=staging` → `"production"` (explicit wins, so
   a future custom environment needs no code change).
4. `VERCEL_ENV=production` + any branch → `"production"`.

Cases 1 and 2 are the mapping; 3 and 4 are what stop it from ever overriding a deliberate
configuration.

If (1) fails on a real staging deployment after #164 ships, the fallback is the explicit
`APP_DEPLOY_ENV=staging` variable, scoped to the `staging` branch in Vercel's Preview environment —
a control-plane change the operator would make, not a code change. That is why the explicit
variable is checked first: the escape hatch exists before it is needed.
