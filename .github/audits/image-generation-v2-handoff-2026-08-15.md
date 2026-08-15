# Image generation v2 — handoff, 2026-08-15

A point-in-time record, written to close one working session and start the
next from measured state rather than from memory. **Do not overwrite it.** A
later session that finds something here out of date writes its own dated
record; a handoff that gets edited stops being a record of what was known when
the decision was made.

Everything about a system outside this repository carries `verifiedAt` and the
command that produced it. Everything about the repository is a `git` fact and
reproducible from the SHAs below.

## Baseline

```
origin/main     b0cf10e761053fd5f00c3cd6064edc41925e1898
origin/develop  3989675058eb5d0244dedfc357f4026c8211e73a
verifiedAt      2026-08-15T06:01:17Z   (git fetch && git rev-parse)
```

Production, `verifiedAt 2026-08-15T06:01:17Z` (`curl https://tomverse.app/api/build-info`, `/api/ready`):

```
commitSha         b0cf10e761053fd5f00c3cd6064edc41925e1898
deployedAt        2026-08-15T02:19:52Z
deploymentStatus  success
/api/ready        database, securityEnvironment, providerBudgets, imageProviderBudget — all true
```

`/api/ready` is a startup and dependency-reachability fact. It is not
behavioural verification of anything below.

## Scope status: complete, and not exposed

The image generation v2 work agreed at the start of the session is **built,
verified on staging, and deployed to production behind a flag that is off**.

Built and released: multi-model fan-out, the four entry points, the guest and
free lock states, retry-in-place, asset labelling and signed URLs, the
`fal-ai/nano-banana-2` activation with its smoke evidence, the daily fal price
drift workflow, and the staging verification checklist and its record system.

Authoritative documents:

| Subject | Document |
| --- | --- |
| Feature contract | `docs/policy/image-generation.md` (§11–§16) |
| UI contract | `docs/ui-contracts/image-generation-workspace.md` |
| Staging checklist (template) | `docs/ops/image-generation-staging-checklist.md` |
| Verification runs | `docs/ops/image-generation-staging-verification-records/` |

### The production artifact is not the verified artifact

Stated precisely, because the short version is wrong in a way that matters:

> **The image generation source paths are identical to the verified build. The
> production artifact is not — twelve production dependencies were updated
> between them.**

```
git diff 7680d65 origin/main -- lib/image* components/images/** \
    app/api/images/** lib/imageModelRegistry.ts
→ no output
```

But `package.json` and `package-lock.json` did change, via #570: the four
`@ai-sdk/*` provider adapters and `ai`, `stripe`, `pg`, `@sentry/nextjs`, both
`@aws-sdk` S3 packages, `lucide-react` and `highlight.js`. The image path calls
into the AI SDK and the S3 client directly.

Full accounting, including what CI did and did not establish:
`.github/audits/release-deviation-2026-08-15__b0cf10e.md`.

**Consequence for exposure:** before the flag is turned on, either re-verify
`b0cf10e` itself on staging with the flag on — one paid fan-out is enough to
exercise the SDK and the signing path — or approve the dependency delta
explicitly as a named risk. Not both silently skipped.

## Turning the flag on

`feature.imageGenerationEnabled` is a **row in `AppSetting`**, not a Railway
variable and not an environment variable (`lib/imageGenerationAccess.ts:7`,
`lib/appSettings.ts:188`). It is read per request from the database, so it
takes effect without a deploy — and it leaves no deployment trail of its own.

Change it through the admin path, never by editing the row:
`PUT /api/admin/app-settings` → `setImageGenerationEnabled()`. That route
writes `app_settings.update_started` to `AdminAuditLog` before the change and
records the result after (`app/api/admin/app-settings/route.ts:104`). A direct
database edit produces the same behaviour and no audit record, which is the
difference that matters six months later.

Before turning it on:

- [ ] `b0cf10e` re-verified with the flag on, **or** the dependency delta approved as a named risk, with the approver recorded
- [ ] Provider budgets present for every active image provider (`GET /api/admin/image-generation`)
- [ ] The state before the change recorded, so "it was off" is evidence rather than recollection
- [ ] Changed through the admin route, and the `AdminAuditLog` entry confirmed afterwards

## Models

Registry (`lib/imageModelRegistry.ts`, a `git` fact at the SHAs above):

| Model | Provider | Owner | `disabledReason` |
| --- | --- | --- | --- |
| `gpt-image-2` | openai | openai | `null` |
| `grok-imagine-image-quality-20260403` | xai | xai | `null` |
| `fal-ai/nano-banana-2` | fal | google | `null` |
| `gemini-3.1-flash-image` | google | google | `worst_case_cost_unbounded` |
| `gemini-3.1-flash-lite-image` | google | google | `worst_case_cost_unbounded` |
| `gemini-3-pro-image` | google | google | `worst_case_cost_unbounded` |

### What the frozen record actually exercised

`docs/ops/image-generation-staging-verification-records/2026-08-14__7680d65….md`
(`result: 통과`, `frozen: true`) records **two** active models in that
environment — `gpt-image-2` (openai) and `fal-ai/nano-banana-2` (fal) — and the
paid fan-out in §B was between those two.

That satisfies the core cross-provider contract, because the two are on
different providers and the budget attribution was observed splitting
correctly (fal `settledCostMicroUsd` +80,000 exactly, no `google` entry).

**It is not a verification of three models.** `grok-imagine-…` carried
`disabledReason: null` in the registry at that same SHA, so the difference
between "three not held in code" and "two active in that environment" is a
runtime one — a provider credential or a per-environment registry row. **The
cause was not established**, and the next session should not assume it.
Settling it takes one call: `GET /api/admin/image-generation` on the
environment in question.

### The Google hold is not a price question

Correcting a phrasing used earlier in the session. The **per-image price is
known**. What is unverified is the **finite per-request ceiling on billed
output plus thinking tokens** — without it the worst legitimate cost of one
request is unbounded, and a `bounded_fixed` fixed-price contract cannot be
offered on top of it. `worst_case_cost_unbounded` names exactly that.

Nor is the remaining work purely non-development. Even once an official cap is
published, activation needs a registry price profile derived from it, a sold
credit count approved separately from the mathematical floor
(`ceil(maxCost/900µ)`), tests, and a deploy.

**This does not affect the v2 completion judgement.** Nano Banana 2 — a Google
model — already ships through the fal path, so direct Google integration is a
follow-on feature rather than an unfinished part of v2.

## Database migrations: two different numbers

Do not conflate these.

**Git — migrations on `develop` and not on `main`: 6.** Measured at
2026-08-15T06:01:17Z with
`git diff --name-only origin/main origin/develop -- prisma/migrations/`:

```
20260814160000_settlement_pointer_commit_check
20260814170000_attempt_cost_accrual
20260815012000_validate_credit_lot_non_negative
20260815030000_perplexity_async_job_updated_at_index
20260815090000_attempt_cost_rollup_date
20260815100000_external_import_gemini_provider
```

**Production database — pending: not measured.** It needs
`npx prisma migrate status` against production, and the result belongs in the
next release checklist's §7.1 with its timestamp. An earlier run in this
session reported "Database schema is up to date! (50 migrations found)", but
that was against the `851598eb` tree and says nothing about the six above.

```
Ran at (UTC):   ____________________
Pending count:  ____________________
```

Two of the six are this session's and are both non-destructive — a `VALIDATE
CONSTRAINT` on already-surveyed data (zero violating rows, recorded in the
2026-08-15 checklist §7.7) and an index addition.

## Open items

### Owned, with a date

| Item | Owner | Due |
| --- | --- | --- |
| Credit reservation retention: period per status, account deletion / refund / dispute handling, backup reach | finance-ops + privacy/legal | **2026-08-28 (AEST)** |

Held as "no deletion before approval". Past the date
`npm run report:unswept-tables` reports it as an overdue policy rather than a
current hold; the hold itself does not lapse. Registry:
`scripts/report-unswept-tables-core.mjs`, checklist §7.8.

### Accessibility

The matrix is `.github/ACCESSIBILITY_QA_MATRIX.md` (template). State at
handoff:

- A dated copy exists **locally, uncommitted**, for `b0cf10e`, with row 14 written as a pass.
- Rows 15 and 16 were reported as run in conversation but are not in a committed record.
- Rows 1–13 and 17–19 are `N/V`, owned by `@mposition` in §8 of the checklist copy.

The first thing the next session should ask for is that copy, committed. An
uncommitted record is indistinguishable from no record once the machine is
closed.

Rows 17–19 (Windows Pinyin, Windows Japanese IME, macOS Apple Japanese IME)
were added this session and have never been run. Why they exist, and the
Korean measurement that produced them:
`.github/audits/ime-enter-observation-2026-08-15.md`.

### Release-path changes awaiting release

Both are on `develop` and **inert until they reach `main`**, because
Dependabot reads its config from the default branch:

- `target-branch: develop` for npm version updates, and production groups split by blast radius
- Release checklist §7.9, the six conditions an out-of-band `main` merge must carry

Until then, version updates keep arriving on `main`. PR #588.

## Rules that changed this session and are already live

A session starting from an older mental model will trip on these.

1. **`Auto PR to Develop` is opt-in.** Only a branch with a `to-develop` path segment gets a develop PR (`claude/to-develop/…`). No PR for an unrecognised branch is the rule working, not a fault. `scripts/auto-pr-branch-policy.mjs`, `AGENTS.md`.
2. **Writing results into `.github/RELEASE_CHECKLIST.md` fails CI.** Runs go in `.github/audits/release-<date>__<sha>.md`; a deviation goes in `release-deviation-<date>__<sha>.md`. `npm run check:release-records`.
3. **A missing Playwright golden fails.** It used to be written and passed. `playwright.config.ts`, `updateSnapshots: "none"`.
4. **Four tables gained retention policies** and the credit reservation tables are held under the dated decision above. `npm run report:unswept-tables` reports no undecided table.
