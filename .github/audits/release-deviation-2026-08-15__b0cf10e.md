# Release deviation — 2026-08-15, `b0cf10e`

> **Superseded on "what production serves".** Later the same day `391c933`
> was merged to `main` and deployed, so the row below naming `b0cf10e` as the
> served SHA is no longer current — see
> `.github/audits/release-deviation-2026-08-15__391c933.md`. Everything else
> here still holds: `b0cf10e` remains unverified, it is contained in the build
> now running, and the rollback target is still `851598eb`.

**Production is running a build that no release checklist covers.** This
records that, rather than leaving it to be noticed at the next release or
answered by pointing at a checklist run for a different SHA.

Not a waiver. A waiver is a decision someone owns in advance; this is a
description of something that already happened, written so the gap is legible
and closable.

## The gap

| | |
|---|---|
| Verified release SHA | `851598eb8957342bc66d742596692961dbaec03f` |
| Release candidate verified on staging | `63792fcd554ed93dd65a534cf05c26e05e306a06` |
| **SHA production actually serves** | `b0cf10e761053fd5f00c3cd6064edc41925e1898` |
| Checklist run | `.github/audits/release-2026-08-15__9424a4bd.md` — covers `851598eb`, **not** `b0cf10e` |
| Rollback SHA | `851598eb8957342bc66d742596692961dbaec03f` (the last build a checklist covers) |

Two pull requests landed on `main` after the release and before anyone looked
again:

```
851598e  Release 2026-08-15                     ← verified
ebc566f  Bump the production-dependencies group with 12 updates
de441b9  Merge pull request #570                ← deployed to production
030a6d0  Take the tsx bump, hold @types/node
b0cf10e  Merge pull request #574                ← deployed to production, current
```

## What changed

**[#570](https://github.com/mposition/Tomverse/pull/570)** — twelve production
dependencies, in one commit:

| Package | From | To | Talks to |
| --- | --- | --- | --- |
| `@ai-sdk/anthropic` | 4.0.30 | 4.0.38 | model provider |
| `@ai-sdk/google` | 4.0.34 | 4.0.42 | model provider |
| `@ai-sdk/moonshotai` | 3.0.26 | 3.0.34 | model provider |
| `@ai-sdk/openai` | 4.0.30 | 4.0.40 | model provider |
| `ai` | 7.0.52 | 7.0.62 | streaming, tool calls, usage reporting |
| `stripe` | 22.4.0 | 22.5.0 | payments |
| `pg` | 8.22.0 | 8.23.0 | database driver |
| `@sentry/nextjs` | 10.69.0 | 10.70.0 | observability |
| `@aws-sdk/client-s3` | 3.1104.0 | 3.1108.0 | object storage (R2) |
| `@aws-sdk/s3-request-presigner` | 3.1104.0 | 3.1108.0 | signed asset URLs |
| `lucide-react` | 1.28.0 | 1.31.0 | UI |
| `highlight.js` | 11.11.1 | 11.11.2 | UI |

**[#574](https://github.com/mposition/Tomverse/pull/574)** — `tsx` 4.23.8 →
4.23.12 (development dependency, not in the runtime bundle) and an
`@types/node` hold in `.github/dependabot.yml`. Low risk, and recorded here
only because it is the second half of the distance between the verified SHA
and the deployed one.

## Why this is a deviation and not a covered release

Neither PR passed through `develop`, so **neither was ever deployed to
staging**. What exists instead:

- **PR CI passed on both.** That is real evidence and it is quoted, not
  dismissed: lint, typecheck, unit, server-contract, production build,
  Chromium smoke, the high-risk UI tier, Admin Console E2E and the credit and
  finance PostgreSQL scenarios.
- **It is not evidence about the systems these packages exist to talk to.**
  CI reaches no model provider, no Stripe account, no Sentry project and no R2
  bucket. A driver or SDK change is exactly the class whose failure appears at
  the boundary CI replaces with a fixture.
- **`/api/ready` returning true is not behavioural verification.** It reports
  that the process started and its dependencies are reachable. It was green
  before these merges and after them, and would stay green through a
  regression in how a provider's usage numbers are parsed or how a Stripe
  object is shaped.

## Production observations to date

Recorded as what they are — the absence of a reported symptom, not a test
result.

| Check | Result | Time |
| --- | --- | --- |
| `/api/build-info` | `b0cf10e`, `deploymentStatus: success` | 2026-08-15 02:19:52Z |
| `/api/ready` | `database`, `securityEnvironment`, `providerBudgets`, `imageProviderBudget` all true | 2026-08-15 05:44:59Z |

No behavioural check of chat streaming, credit settlement, payments, image
asset signing or error reporting has been run against `b0cf10e`.

## What would close this

**Verify `b0cf10e` itself.** Not the current `develop`: at the time of writing
it is 36 commits and 71 files ahead of `main`, so a run against it measures a
different build and cannot be quoted for this one.

- [ ] Deploy the exact SHA `b0cf10e761053fd5f00c3cd6064edc41925e1898` to staging or a scratch environment
- [ ] Read `/api/build-info` back and confirm it names that SHA
- [ ] Exercise one turn per active provider and confirm usage settles
- [ ] Exercise one Stripe path end to end (checkout or plan change) against test mode
- [ ] Generate one image and confirm the signed asset URL resolves
- [ ] Confirm an error reaches Sentry with its trace id

```
Verified by:     ____________________
Verified at:     ____________________
Environment:     ____________________
Outcome:         ____________________
```

Until those are filled in, **the newest build with behavioural verification is
`851598eb`**, and that is the rollback target.

## What was changed so it does not recur

`.github/dependabot.yml` now sets `target-branch: develop` for npm version
updates, so a routine dependency bump is released like every other change.
Security updates are unaffected by that setting — GitHub raises them against
the default branch regardless — so `.github/RELEASE_CHECKLIST.md` gained an
"Out-of-band changes to main" section stating what an urgent direct merge has
to carry.

The production group was also split by blast radius (provider SDKs; payments
and data; infrastructure and observability; user interface). Twelve packages
in one commit meant that "which of these did it" had twelve answers and one
revert covering all of them.

Both changes live on `develop` and are inert until released: Dependabot reads
`.github/dependabot.yml` from the default branch. Until this reaches `main`,
version updates keep arriving there.
