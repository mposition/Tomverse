# Image generation — exposure readiness, 2026-08-16

What is true immediately before `feature.imageGenerationEnabled` is considered
for production exposure. **A point-in-time record; do not overwrite it.** The
flag is `false` at the time of writing and this document does not turn it on —
that is a person's decision, and this exists so the decision is made against
measurements rather than recollection.

Reads on top of `.github/audits/image-generation-v2-handoff-2026-08-15.md`,
which was written when production served `b0cf10e`. Six deployments have
happened since; this record replaces its **measurements**, not its judgements.

## Build

```
verifiedAt   2026-08-16T01:17:19Z   (curl https://tomverse.app/api/build-info, /api/ready)

commitSha    a0867a73d6a71d3f0dc91c41036a7eefc116c676
deploymentId 3a3cdf7c-d160-4026-abf7-a5f35898b625
deployedAt   2026-08-16T00:52:02.878Z
/api/ready   database, securityEnvironment, providerBudgets, imageProviderBudget — all true
```

## The image source is the verified source

```
git diff 7680d65 origin/main -- lib/image* components/images/ app/api/images/ lib/imageModelRegistry.ts
→ no output
```

`7680d65` is the SHA the frozen staging record covers
(`docs/ops/image-generation-staging-verification-records/2026-08-14__7680d65….md`,
`result: 통과`). Ten production deployments separate the two builds and none of
them touched an image path.

**The artifact is not identical.** Dependencies moved:

```
@ai-sdk/openai                4.0.30 → 4.0.41
@ai-sdk/google                4.0.34 → 4.0.43
@ai-sdk/anthropic             4.0.30 → 4.0.38
ai                            7.0.52 → 7.0.64
@aws-sdk/client-s3            3.1104.0 → 3.1109.0
@aws-sdk/s3-request-presigner 3.1104.0 → 3.1109.0
```

The handoff required either a re-verification with the flag on or an explicit
named-risk approval of that delta. **One production image generation covered
most of it**: a `gpt-image-2` fan-out succeeded and its signed asset URL
resolved, which exercises the AI SDK and both `@aws-sdk` packages on the
production build. Six chat turns across four provider adapters settled the same
afternoon.

That run happened between `b0cf10e` and `5528317`. `@ai-sdk/*` moved once more
in #618 (patch level, e.g. `4.0.40 → 4.0.41`). **The residue is one patch
bump, not the twelve-package delta the handoff was written about.**

## Provider budgets — corrected and verified

`GET /api/admin/image-generation`, `providerBudgets[]`, 2026-08-16.

| Provider | day | month | source | problems | advisories | clamped |
|---|---|---|---|---|---|---|
| openai | 50,000,000 ($50) | 500,000,000 ($500) | environment | 0 | 0 | 0 |
| xai | 50,000,000 ($50) | 500,000,000 ($500) | environment | 0 | 0 | 0 |
| fal | 12,000,000 ($12) | 50,000,000 ($50) | environment | 0 | 0 | 0 |

Provider set is exactly `openai`, `xai`, `fal`. Google is absent, which is
correct while its models are held.

### What was wrong, and what it turned out to be

OpenAI read `day 10,800,000 / month 10,800,000` — **both windows at exactly
`floorMicroUsd`**, with `clamped` empty, so the environment held those numbers
literally rather than having been raised to the floor. That fired
`month_not_above_day` (`lib/imageProviderBudget.ts:261`): a month equal to the
day ceiling is exhausted by one day at the cap, so the monthly window stops
being a second bound.

The correction was assumed to be a monthly-only edit. It was not: **the daily
limit was $10.80, not the $50 the policy approves**, so both windows moved.
Recorded because "raise the month" and "the whole provider was at the minimum"
are different findings, and only the second explains why the numbers matched
the floor.

`month_not_above_day` is an advisory, not a problem — it surfaces and never
blocks readiness (`lib/imageProviderBudget.ts:117`). `/api/ready` reported
`imageProviderBudget: true` both before and after, so **readiness was not the
signal here and would not have been**.

Note that `budget` at the top level of the response is the legacy single-OpenAI
shape. `providerBudgets[]` is the one to read.

## Models: three active, three held

| Model | Provider | `disabledReason` | Exercised where |
|---|---|---|---|
| `gpt-image-2` | openai | `null` | staging (`7680d65`) **and** production |
| `fal-ai/nano-banana-2` | fal | `null` | staging (`7680d65`) |
| `grok-imagine-image-quality-20260403` | xai | `null` | **nowhere** |
| `gemini-3.1-flash-image` | google | `worst_case_cost_unbounded` | — |
| `gemini-3.1-flash-lite-image` | google | `worst_case_cost_unbounded` | — |
| `gemini-3-pro-image` | google | `worst_case_cost_unbounded` | — |

### One active model has never generated an image anywhere measured

`dimensionCoverage` reports one entry: `openai`, 1 succeeded, 1 measured. The
frozen staging record covered `gpt-image-2` and `fal-ai/nano-banana-2`. That
leaves **`grok-imagine-image-quality-20260403` unexercised in every environment
we have a record for**, while carrying `disabledReason: null` — so turning the
flag on exposes it to users.

The handoff already noted this as unexplained: the model was not held in code at
`7680d65` either, so its absence from that run is a runtime condition — a
credential or a per-environment registry row — and **the cause was never
established**.

This is not an argument against exposure. It is an argument for the first three
generations after the flag flips being one per provider, in the operator's own
hands, before anyone else's.

## The Google hold is the cap, not the price

Restating because the short version is wrong in a way that matters. Per-image
prices are verified and recorded per model. What is missing is a **documented
finite per-request ceiling on billed output plus thinking tokens**, without
which the worst legitimate cost of one request is unbounded and a
`bounded_fixed` fixed-price contract cannot sit on top of it.

The 2026-08-05 documentation review closed this as a *checked absence* rather
than an unread page. The conservative derivations exist and are inferences, not
documented caps. Per `AGENTS.md`, a model whose thinking ceiling cannot be
confirmed from official documentation stays disabled rather than carrying an
invented cap.

Unblocking is a measurement, not more reading — and that measurement is
billable and needs its own budget approval. Not on the exposure path.

## Health

```
invariants   emptyImageConversations 0   staleGenerations 0   strandedSettlements 0
             cleanupBacklog 0   thumbnailBacklog 0   thumbnailsExhausted 0
```

Settlement is exact: `reservedCredits 70 / settledCredits 70`; cost reserved
58,000 µUSD, settled 53,060. Storage pairs correctly — one original, one
thumbnail.

**Pricing headroom is 4%.** `ceilingMicroUsdPerCredit 900`,
`worstCostMicroUsdPerCredit 864`, headroom 36 µUSD. Positive, so the
fixed-price contract holds. It is the first thing a provider price rise breaks,
and it is thin enough to be worth watching rather than acting on.

## What remains before the flag is turned on

Everything below the line is a person's action; none of it is code.

- [x] Image source identical to the verified staging SHA
- [x] Dependency delta exercised on the production build (one image + four adapters), residue is one patch bump
- [x] Provider budgets present, correct, and free of problems, advisories and clamps for all three active providers
- [x] The state before the change recorded — `flagEnabled: false` at 2026-08-16T01:17Z, in this document
- [ ] Decide whether the one remaining patch-level `@ai-sdk/*` bump is accepted, or re-run one generation after this build
- [ ] Turn the flag on **through `PUT /api/admin/app-settings`**, never by editing the row — the route writes `app_settings.update_started` to `AdminAuditLog` before the change and the result after (`app/api/admin/app-settings/route.ts:104`). A direct edit produces the same behaviour and no audit record
- [ ] Confirm the `AdminAuditLog` entry afterwards
- [ ] Generate one image per active provider — openai, xai, **fal** — and confirm `dimensionCoverage` reports three providers
- [ ] If xAI fails, set its `disabledReason` and deploy that alone rather than closing the whole feature

```
Turned on by:   ____________________
Turned on at:   ____________________
Audit log id:   ____________________
Per-provider generations:  openai ______  xai ______  fal ______
```

## Related

- `.github/audits/image-generation-v2-handoff-2026-08-15.md` — the judgements this record's measurements sit under
- `docs/policy/image-generation.md` §11–§16
- `docs/ui-contracts/image-generation-workspace.md`
- `docs/ops/image-generation-staging-checklist.md`
- `.github/audits/release-verification-handoff-2026-08-15.md` — the release-verification thread, deliberately separate
