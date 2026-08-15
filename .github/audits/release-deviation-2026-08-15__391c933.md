# Release deviation — 2026-08-15, `391c933`

> **Superseded on "what production serves".** Later the same day `78af657`
> was merged to `main` and deployed — see
> `.github/audits/release-deviation-2026-08-15__78af657.md`. Everything else
> here still holds: `391c933` remains unverified, it is contained in the build
> now running, its migration is still the only schema change of the three, and
> the rollback target is still `851598eb`.

**Production is running a build that no release checklist covers**, and the
distance from the last verified build grew rather than closed. This is the
second deviation in one day; the first
(`release-deviation-2026-08-15__b0cf10e.md`) is superseded by this one on the
question of what production actually serves, and stays accurate about how the
gap opened.

**Not a waiver, and it cannot become one.** A waiver is a decision someone owns
*in advance*; this is a description of something that already happened, written
while it is still true. A record made afterwards cannot create the approval
that was not sought beforehand, and the condition table below says so rather
than pointing at this document as if it satisfied itself.

**Intent is recorded only as far as it is evidenced.** The pull request says it
cherry-picks the external-import provider fix onto `main`. Nothing states
urgency, and nothing here infers it: a correctness fix brought forward and an
emergency are different risks, and the difference is not in the commit.

## The gap

| | |
|---|---|
| Verified release SHA | `851598eb8957342bc66d742596692961dbaec03f` |
| Previous deviation's SHA | `b0cf10e761053fd5f00c3cd6064edc41925e1898` |
| **SHA production actually serves** | `391c9336d4d73110bd30f2ad3cb95ceae367eeb4` |
| Deployment ID | `b080424a-0806-480e-a6cd-1e36859d5ea1` |
| Checklist run | `.github/audits/release-2026-08-15__9424a4bd.md` — covers `851598eb`, **not** this |
| Rollback SHA | `851598eb8957342bc66d742596692961dbaec03f` (the last build a checklist covers) |

```
b0cf10e  Merge pull request #574                 ← previous deviation
28952de  fix(import): let the server accept the provider the browser just parsed (#583)
391c933  Merge pull request #587                 ← deployed to production, current
```

## What changed

One cherry-pick: [#587](https://github.com/mposition/Tomverse/pull/587), which
carries `e047347` from `develop` (#583) onto `main`.

`main` already shipped the Gemini Takeout parser and could not store what it
parsed. The provider set was written in five places — the adapter union, the
digest union, the create route's request schema, and two database CHECK
constraints — and Gemini reached only the first. A browser on `main` recognised
a Takeout export, offered its conversations, and the first server call answered
400. The cherry-pick adds `lib/externalImportProviders.ts` as the one canonical
list, widens both constraints to match, and holds the copies that cannot import
TypeScript to it with two database tests.

15 files, +440/−17, and one migration:
`20260815100000_external_import_gemini_provider`.

**No feature was activated.** `feature.externalConversationImportEnabled`
governs external import and was not changed by this deploy. What the change
closes is a defect nobody could reach while that flag is off.

## Why this is a deviation and not a release

`.github/RELEASE_CHECKLIST.md` §7.9 lists six conditions for a change that
reaches `main` directly. Four hold; the first does not, and the first is what
makes the exception an exception.

| §7.9 condition | Status |
|---|---|
| It is a **security update**, named as one, with its advisory | **No.** It is a correctness fix. §7.9 says a change that merely arrived on `main` is not this |
| A person approved it, and a staging waiver is recorded | **Partly.** Human merge approval: evidenced by `@mposition` merging #587. Pre-merge staging waiver: **not evidenced / not recorded.** This document records the deviation; it is not a retroactive waiver |
| The new release SHA is recorded | Yes — `391c9336…`, the merge commit, not the PR head |
| Verified beyond PR CI | **Partly.** See below |
| A rollback SHA is named | Yes — `851598eb` |
| The back-merge to `develop` is confirmed | Yes — [#589](https://github.com/mposition/Tomverse/pull/589), merged as a merge commit. `git merge-base --is-ancestor origin/main origin/develop` returns 0 |

Because the first is missing, this is recorded as a deviation at the time
rather than deferred to a checklist that covers a different SHA.

## Deployment record

Production deploys on push to `main`, so the merge was the deployment. Railway
runs `npm run check:encoding:strict && npm run db:migrate` as the service's
pre-deploy command, which is what put the migration ahead of the application
without anyone sequencing it by hand.

| | |
|---|---|
| App SHA | `391c9336d4d73110bd30f2ad3cb95ceae367eeb4` |
| Deployment ID | `b080424a-0806-480e-a6cd-1e36859d5ea1` |
| Deployment created | 2026-08-15T06:12:20.826Z |
| Migration | `20260815100000_external_import_gemini_provider` |
| Migration completed | 2026-08-15T06:16:06Z — `All migrations have been successfully applied.` (51 found) |
| Migration applied before the app took traffic | Yes — pre-deploy command |
| Terminal status | `SUCCESS`, 2026-08-15T06:16:26.256Z |
| Previous deployment | `b0cf10e…` → `REMOVED` at 06:19:29Z |
| Flag before / after | **Not read back.** See "What is not verified" |

## What was verified

| Check | Result | Time |
| --- | --- | --- |
| PR CI on #587 | 24 checks, all success — including CodeQL, which runs only on `main`-targeted pull requests | finished 06:08:13Z, ahead of the 06:12 deploy |
| Cherry-pick rehearsal on a branch cut from `origin/main` | typecheck, lint; 51 migrations applied to an empty database; `pg_get_constraintdef()` reads `chatgpt, claude, gemini` on both tables; `prisma migrate diff` shows no difference; provider boundary suites 18/18 | before the merge |
| `/api/build-info` | `commitSha: 391c9336…`, `deploymentId: b080424a…`, `deploymentStatus: success` | 2026-08-15T06:34:19Z |
| `/api/ready` | `database`, `securityEnvironment`, `providerBudgets`, `imageProviderBudget` all true | 2026-08-15T06:34:19Z |
| `/api/health` | `{"ok":true}` | 2026-08-15T06:34:19Z |

## Migration ledger, read back

`npx prisma migrate status` against the production datasource, 2026-08-15,
after the deploy. Output paraphrased; no connection string, credential or host
detail is reproduced here.

| | |
|---|---|
| Last common migration | `20260814150000_settlement_attempt_pointer` |
| `20260815100000_external_import_gemini_provider` | **not listed as pending — applied** |
| Listed as not yet applied | 5, and all five are the `develop`-only migrations below |

```
20260814160000_settlement_pointer_commit_check
20260814170000_attempt_cost_accrual
20260815012000_validate_credit_lot_non_negative
20260815030000_perplexity_async_job_updated_at_index
20260815090000_attempt_cost_rollup_date
```

That list matches `git diff --name-only origin/main origin/develop --
prisma/migrations/` exactly, which is the reading that matters: **the
production database is at `main`'s migration set, and the five it lacks are
ones `main` does not have either.**

Two caveats, and both are the point rather than footnotes.

- **It was run from a tree that is not `391c933`.** The five "pending" entries
  are pending relative to the local checkout, not relative to what production
  is serving. A run at the exact SHA would report none. The conclusion drawn
  above survives that, because it rests on which migration is *absent* from the
  pending list, not on the count.
- **The command reads `_prisma_migrations` and nothing else.** A ledger row
  says the migration ran, not that the constraint has the definition it was
  supposed to produce. That still needs `pg_get_constraintdef()`, and it is
  still on the list below.

The same output also reported roughly 79 migrations present in the database and
absent from `prisma/migrations`. That is **not** drift caused by anything here:
the repository's history was replaced by
`prisma/migrations/00000000000000_baseline` because the old history could not
build the schema from empty, and databases created before that keep their
original rows. `scripts/baseline-existing-database.mjs` exists for exactly this
and runs ahead of every deploy. Recorded so the next reader does not treat a
known, handled condition as a new incident.

## What is not verified

- **The flag's actual value in production.** `feature.externalConversationImportEnabled`
  is an `AppSetting` row, not an environment variable, and it was not read back
  before or after the deploy — production deploys on the push, so there was no
  window between the merge and the deployment for anyone to look. It is
  believed off; believed is not read back.
- **The constraint in the production database.** Prisma recorded the migration
  as applied and `/api/ready` reports the database reachable. Neither is
  `pg_get_constraintdef()` on the production instance. The read-back that was
  performed was on an empty database built from `main`'s history.
- **Behavioural verification of anything.** As with `b0cf10e`, this build has
  had no chat turn, no settlement, no payment path and no image generation
  exercised against it. `/api/ready` was green before the deploy and after it.
- **Nothing about `b0cf10e` was closed.** That deviation's checklist is still
  open, and this build contains it.

## What would close this

Both deviations at once, since `391c933` contains `b0cf10e`. Verify this SHA,
not the current `develop` — at the time of writing `develop` is 43 commits
ahead and a run against it measures a different build.

- [ ] Deploy `391c9336d4d73110bd30f2ad3cb95ceae367eeb4` to staging or a scratch environment
- [ ] Read `/api/build-info` back and confirm it names that SHA and its deployment ID
- [ ] Read `feature.externalConversationImportEnabled` back from production and record the value
- [ ] Read `pg_get_constraintdef()` for `ExternalImport_provider_check` and `ExternalConversation_provider_check` from production, on a read-only role, and confirm both admit `chatgpt`, `claude` and `gemini`
- [ ] Re-run `prisma migrate status` **from a worktree at `391c933` itself**, against production, and confirm it reports nothing pending
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

## Two things this exposed

**Production does not wait for CI.** The service's source configuration has
`checkSuites: false`, so a push to `main` deploys whether or not its checks
have finished. Here CI finished at 06:08 and the deploy started at 06:12, which
is luck rather than a guarantee — a slower run would have shipped an unverified
build. Turning it on is a one-line change to the service's source settings and
is not made by this document.

**One flag covers three providers.** `feature.externalConversationImportEnabled`
activates ChatGPT, Claude and Gemini together. Now that this SHA is in
production, whoever turns that flag on is activating Gemini as well, whose
staging section (H) has not been run. Either the activation approval says so
explicitly, or a provider-level gate has to exist first — hiding the guidance
card is not one, because detection reads the uploaded file rather than the
card.
