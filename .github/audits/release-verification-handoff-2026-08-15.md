# Release verification — handoff, 2026-08-15 → 2026-08-16

A point-in-time record, written to close one working session and let the next
resume from measured state. **Do not overwrite it.** A later session that finds
something here out of date writes its own dated record; a handoff that gets
edited stops being a record of what was known when the decision was made.

This covers the **release-verification** work: four deviation records, what
each is waiting on, and the findings the verification turned up along the way.
The image generation feature work is a separate thread with its own handoff
(`.github/audits/image-generation-v2-handoff-2026-08-15.md`).

Everything about a system outside this repository carries a time and the
command that produced it. Everything about the repository is a `git` fact.

## How this thread started, and why it is not image generation

Image generation v2 shipped to production behind a flag. Verifying that deploy
surfaced the fact that production was running builds no release checklist
covered, which produced four deviation records, whose "what would close this"
lists became the work below.

The connection to image generation is real but indirect: the same unverified
artifact carries both. **None of the open items below block image generation** —
the two that did (provider settlement across the updated `@ai-sdk/*` adapters,
and one production image generation) are closed.

## Baseline

```
verifiedAt   2026-08-16T00:21:53Z   (curl https://tomverse.app/api/build-info)

production   adc19b89e923fe58060fd5e23b628da56edb93d6   deployed 00:07:15Z
origin/main  a0867a73d6a71d3f0dc91c41036a7eefc116c676
```

**Production is one merge behind `main`.** Deployment
`4429be21-d3f6-4ec8-88a2-e9cea96f6c39` for `a0867a7` was `WAITING` at
2026-08-15T23:23:46Z. Builds here have taken between 7 and 67 minutes today, so
a session picking this up should read `/api/build-info` rather than assume.

**`a0867a7` is the security fix. Until it deploys, the disclosure below is
still live**, and the value being disclosed is the *rotated* one.

## The four deviation records

| Record | SHA | Still open |
|---|---|---|
| `release-deviation-2026-08-15__b0cf10e.md` | `b0cf10e` | contained in the others; its own list is closed except Stripe and Sentry |
| `release-deviation-2026-08-15__391c933.md` | `391c933` | `prisma migrate status` from a worktree at the served SHA |
| `release-deviation-2026-08-15__78af657.md` | `78af657` | nothing of its own; step-up recovery verified |
| `release-deviation-2026-08-15__5528317.md` | `5528317` | Stripe, Sentry trace id, deepseek/perplexity turns — **all three now resolved or reclassified, see below** |

The fourth record has not been updated with what this session established after
it was written. **That is the first job for the next session** — the list below
is the input.

### Closed, with evidence

| Item | Result | Time (UTC) |
|---|---|---|
| One turn per provider adapter, settled | 4/4 — openai, anthropic, google, moonshot. All `settled`, `Outcome: completed`, provider request **and** response IDs present | 13:10–13:11 |
| `deepseek` and `perplexity` turns | Both `settled`, both with provider request/response IDs. These two were tracked separately because they parse usage with their own `fetch` wrapper (`lib/activeAiModel.ts:41`, `:57`) rather than the adapter's | ~14:20 |
| `pg_get_constraintdef()` on production | `ExternalImport_provider_check` and `ExternalConversation_provider_check` both read `chatgpt, claude, gemini` | ~13:2x |
| Admin step-up recovery, steps 1–5 | Verified by a person signing in for real | ~13:3x |
| One image generated, signed URL resolves | 1 succeeded, 53,060 µUSD attributed | earlier |
| `feature.externalConversationImportEnabled` | Turned on during testing, left on, found by asking, turned off. `GET /api/admin/external-imports` reports **0 imports over 7 days, `unavailable: false`** — a measured zero, not a failed query | 13:35 |
| `CLOUDFLARE_ORIGIN_SECRET` rotation | Done. `/api/ready` reports `securityEnvironment: true`, which asserts enforcement is on and the new value clears the 32-character floor. Cost a seven-minute outage | 14:13:54 |

**Provider coverage is 11/11.** `lib/activeAiModel.ts:30` resolves eleven
enabled providers through four adapter packages, and all four produced a
settled reservation.

### Open, with the reason rather than the box

**Stripe on the production build — blocked, and the blocker is structural.**

Option 2 from the original three (resync an existing live subscription, no
charge) was investigated and **cannot be executed**: the account checked reports
`subscriptionStatus: manually_adjusted`, which `lib/adminPlanAdjustCore.ts:54`
writes for an administrator-granted plan, with `stripePriceId` empty.
`billing-resync` answers 400 without a Stripe customer or subscription
(`app/api/admin/users/[userId]/billing-resync/route.ts:71`).

Whether **any** live subscription exists was not established — the
`Active paid subscriptions` segment was not read. That single check decides
whether option 2 returns. If it does not:

- **A real charge on a real card, then cancel** — the only complete evidence.
- **An explicit named-risk approval**, resting on staging test mode passing the
  same SDK version.

Production requires a live key (`lib/securityEnvironment.ts:110`) and a live key
rejects test cards, so there is no free path.

**An error reaching Sentry with its application trace id — not manufacturable.**

Delivery works; the `CSP_VIOLATION_DETECTED` event carries a `release` tag. But
the tagged capture is `lib/traceErrorEvidence.ts:128` and is reached only for
`AI_PROVIDER_ERROR`, `AI_REQUEST_FAILED`, `DEEP_RESEARCH_JOB_FAILED`,
`AI_EMPTY_RESPONSE` or a 5xx, **and** only when the caught value is a real
`Error`. It cannot be provoked from outside without breaking something.
Recorded as test-covered and production-unproven rather than manufactured. A
real provider failure closes it whenever one occurs.

**`prisma migrate status` from a worktree at the served SHA** — still open from
`391c933`, and lower value now that the constraint definitions were read back
directly, which is the fact the ledger could not give.

## What the verification found that it was not looking for

### 1. A production secret was being sent to Sentry — fixed, deploy pending

`x-tomverse-origin-verify` carries `CLOUDFLARE_ORIGIN_SECRET` and matched none
of the denylist patterns in `sentry.server.config.ts`, so it travelled in
plaintext on every event carrying request headers. Found by reading one event,
not by any gate.

- Fixed by [#621](https://github.com/mposition/Tomverse/pull/621), merged to
  `main` 23:23:44Z, **deployment `WAITING` as of this writing**.
- Secret rotated 14:13:54Z.
- **Still outstanding, operator action:** add `X-Tomverse-Origin-Verify` to the
  Sentry project's data-scrubbing rules, and decide whether to delete already
  ingested events. The window that matters is rotation (14:13:54Z) to the
  deploy of `a0867a7` — events in it carry the *new* value.

### 2. Six models bill at a credit price their source does not state

`npm run report:model-credit-weights` against production, 42 registry rows:

```
glm-5.2                          source 4    billed 1
gpt-5-5                          source 16   billed 8
mistral-large-3                  source 4    billed 8
perplexity/sonar                 source 16   billed 20
perplexity/sonar-deep-research   source 16   billed 30
qwen3.7-plus                     source 1    billed 4
groq-gpt-oss-120b                not in the catalogue at all, billed 4 (disabled)
```

**All six stored values are exactly the `usageClass` default**, which is what
seeding would have written. So none is a deliberate administrator override:
each is an edit to `lib/models.ts` that never reached its row, because
`ensureModelRegistrySeeded()` inserts with `skipDuplicates: true` and
reconciliation only touches `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`.

Divergence runs **both ways** — `qwen3.7-plus` bills 4× its stated price,
`gpt-5-5` bills half.

**The question that decides severity was not answered**: whether the value
shown to customers comes from the registry or from the catalogue. If it comes
from the registry, displayed equals billed and only the source is wrong. If it
comes from the catalogue, customers have been quoted one number and charged
another since 2026-08-04.

Held under `docs/policy/perplexity-sonar-credit-price-hold.md`. **That document
was written when only `perplexity/sonar` was known and needs widening to six.**
No production DB value and no price constant is to change before finance/product
approves — approval is per model and the six need not go the same way.

### 3. Nothing gates a feature flag or an environment variable

Two feature flags were left on after testing in one day
(`feature.imageGenerationEnabled`, then
`feature.externalConversationImportEnabled`). Both were found because somebody
happened to ask. They are `AppSetting` rows: no deploy, no deployment trail, and
neither `/api/ready` nor `/api/build-info` reports them.

The environment-variable path is the same shape and did more damage: rotating
`CLOUDFLARE_ORIGIN_SECRET` caused the day's only user-visible outage, and PR CI,
"Wait for CI" and §7.9's three lanes are all about how a *commit* reaches
production. Neither path has a control.

Two cheap options were proposed and neither was built: report active feature
flags in `/api/ready`, and write the both-sides-at-once constraint for
environment variables into the release checklist.

### 4. Dependabot still targets `main`

`.github/dependabot.yml` on `origin/main` has **no** `target-branch`, so the
retarget to `develop` has not reached the default branch and is inert. #618
arrived on `main` on schedule and merged — a production dependency group of six
packages, straight past `develop`, exactly the sequence `b0cf10e` recorded.

## Deployment count

Ten production deployments since the last build a checklist covers.

```
01:10:21Z  851598eb   release, checklist run recorded
01:34:29Z  de441b9    deviation b0cf10e
02:15:22Z  b0cf10e    deviation b0cf10e
06:12:20Z  391c933    deviation 391c933
08:10:37Z  78af657    deviation 78af657
09:04:09Z  77d3009    deviation 5528317
11:57:02Z  ed9b803    deviation 5528317
12:03:05Z  5528317    deviation 5528317
22:53:02Z  34a30d8    #618 dependabot — no record
23:00:25Z  adc19b8    #619 — no record, currently serving
23:23:46Z  a0867a7    #621 security fix — WAITING
```

The last three have no deviation record. §7.9's three-lane rewrite is merged to
`develop` and **not to `main`**, so it is not in force.

## First five things for the next session

1. **Read `/api/build-info`.** Do not assume `adc19b8`; `a0867a7` was mid-deploy.
2. **Confirm the security fix is serving**, then record it in
   `release-deviation-2026-08-15__5528317.md` and add the Sentry scrubbing item
   to whoever owns operator actions.
3. **Answer the displayed-vs-billed credit question**, then widen
   `docs/policy/perplexity-sonar-credit-price-hold.md` from one model to six.
4. **Write a deviation record for `34a30d8`, `adc19b8` and `a0867a7`**, or
   decide the lane rewrite lands first and these are the last of them.
5. **Read the `Active paid subscriptions` segment** — one screen, and it decides
   whether the Stripe item has a free path or not.

## Related

- `.github/audits/release-deviation-2026-08-15__{b0cf10e,391c933,78af657,5528317}.md`
- `.github/audits/accessibility-2026-08-15__5528317e19fb8f061f18a9fde98f68c9fecd6013.md` — ten rows `N/V`, each with what it is blocked on
- `.github/audits/ime-enter-observation-2026-08-15.md`
- `docs/policy/perplexity-sonar-credit-price-hold.md`
- `.github/RELEASE_CHECKLIST.md` §7.9
- `.github/audits/image-generation-v2-handoff-2026-08-15.md` — the other thread
