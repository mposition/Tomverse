# Release deviation — 2026-08-19, `348a3df`

**A fix reached `main` without passing through `develop`, so the SHA production
serves was never deployed to staging.** This records that.

Not a waiver, and not an emergency either. The change is a release blocker's
fix, it was verified on staging in every way that matters except the one this
document is about, and it is being written before the merge rather than after
somebody noticed.

## The gap

| | |
|---|---|
| `main` before the merge | `abedcf33aac05d145b7ec0b44b20965c54888273` |
| **SHA production was actually serving** | `ad9b69a505547cdfa7cb167690e3895bdddd6f88` — see below |
| Cherry-pick commit | `e85f458c2ac717a5e30e81acdcd59b6e2ec4ca8b` |
| Merge commit | `348a3df49bd66d691cba67ef5c664163a324b313` (PR #672) |
| **SHA production serves** | `348a3df49bd66d691cba67ef5c664163a324b313`, deployment `9e794081-aebb-4182-9f4f-e26ab30ab7f6`, deployed 2026-08-19T03:45:35Z |
| SHA verified on staging | `79d967fef4a6857aaa56fdd75db45c12cfe3bb41` (deployment `c8cf99b6-ef9b-4bde-9455-4bcb1f4f0916`) |
| Staging run | `docs/ops/staging-verification-records/2026-08-18__79d967fef4a6857aaa56fdd75db45c12cfe3bb41.md` — `runType: exploratory` |
| Rollback SHA | `ad9b69a505547cdfa7cb167690e3895bdddd6f88` (the last build production actually ran) |

### `main` and production had already diverged

This was found while checking where the fix would land, not by looking for it.

```
ad9b69a  #665  deployed 2026-08-17T13:16:32Z  SUCCESS   ← production served this
abedcf3  #666  deployed 2026-08-17T13:05:26Z  FAILED    ← never ran
```

`abedcf3` merged to `main` on 2026-08-17 and its production deployment failed
an hour later. Railway kept the previous build running, so **production served
a commit behind `main` for two days** and `/api/build-info` says so:

```json
{"commitSha":"ad9b69a505547cdfa7cb167690e3895bdddd6f88",
 "deployedAt":"2026-08-17T13:16:32.546Z","deploymentStatus":"success"}
```

The failed build produced no build output and no deploy log — four
`scheduling build on Metal builder` lines across three builders over an hour,
and nothing else. That reads as a platform-side failure rather than anything
in #666, but the logs do not say so; they say nothing.

**Two consequences for this deviation.** The rollback target is `ad9b69a`, not
`abedcf3`, because `abedcf3` is not a build anyone has run. And this merge
carries #666 with it — `348a3df` is a descendant — so the deployment being
recorded here is not "the import fix" alone but "the import fix and the
infrastructure monitoring change that failed to deploy on 2026-08-17".

## What changed

PR #672, a cherry-pick of #669 (`3857ae4`), which fixes #664.

| File | |
| --- | --- |
| `lib/externalImportZipDirectory.ts` | new, 282 lines — ZIP central-directory reader |
| `lib/workers/externalImportWorker.ts` | +29 / −5 — reads entry sizes from the directory, local header as fallback |
| `tests/externalImportZipDirectory.test.mjs` | new, 266 lines, 9 tests |

Nothing else. No migration, no schema change, no dependency, no environment
variable, no feature flag.

**The three files are byte-identical to what `develop` carries.**

```
lib/externalImportZipDirectory.ts          fa1c5784
lib/workers/externalImportWorker.ts        ca3bfea1
tests/externalImportZipDirectory.test.mjs  2e5b4c51
```

The commit differs; the content does not. That distinction is the whole of
this deviation, and it is why this record is short.

## Why it went to `main` directly

`develop` carries 255 lines this fix does not need — `app/api/chat/route.ts`,
`lib/chatSecurity.ts`, `lib/chatAttemptCostLedger.ts` and the infrastructure
monitoring work. Those are unrelated, unreleased, and each wants its own
release decision. Merging `develop` to move one fix would have made this a
release of everything else as well.

The alternative was to cut a release for the whole of `develop`, which is a
larger decision than the one being made here.

## Why this is a deviation and not a covered release

The exact commit that will run in production has never been deployed anywhere.
What exists instead:

- **The same content was exercised on staging through the product.** On
  2026-08-18, deploy `79d967f`, the original Google Takeout archive that failed
  on 2026-08-16 parsed as Gemini with all six preview values matching the
  reference; the HTML-only archive still returned `html_export_unsupported`;
  the ChatGPT export reproduced its three values exactly; a synthetic
  data-descriptor archive finalised at 3 conversations / 12 messages / 200
  bytes, matching the precomputed expectation.
- **That run is `exploratory` and says so.** It covers the archive-reading path
  and nothing downstream. Quota, seal, TTL, the XSS check, deletion, admin
  metrics and the locales were verified on `62987e9` and are not re-established
  by it.
- **PR CI passed on the cherry-pick branch**: 36 unit tests including the nine
  that cover this code, eslint clean, `check:release-records` clean.
- **`checkSuites: true`** on the production service, so the deployment waits for
  the check suite rather than racing it.

## What this does not change

**The external conversation import feature stays off in production.** This
merge does not touch `feature.externalConversationImportEnabled`. Policy §15
requires the code to be deployable with the flag off, and that is what this is:
the blocker leaves the build, and nothing becomes visible to a user.

Activation remains a separate decision with its own conditions — the checklist's
H section requires a full A~H/H2 run on the activation SHA, and the 2026-08-16
formal run is recorded as `failed` precisely because of the defect this fixes.

## Production observations

Recorded as what they are — the absence of a reported symptom, not a test
result.

| Check | Result | Time |
| --- | --- | --- |
| `/api/build-info` | `348a3df`, deployment `9e794081-aebb-4182-9f4f-e26ab30ab7f6`, `deploymentStatus: success`, built 2026-08-19T03:43:08Z | 2026-08-19T05:01:58Z |
| `/api/ready` | `ok: true` — `database`, `securityEnvironment`, `providerBudgets`, `imageProviderBudget` all true | 2026-08-19T05:01:58Z |
| `db:migrate` | `56 migrations found in prisma/migrations` / `No pending migrations to apply.` — all three pre-checks passed (DIRECT_DATABASE_URL, connectivity, advisory locks) | 2026-08-19T03:45:12Z |

The deployment that failed on 2026-08-17 did not recur: build 03:06:54Z →
03:43:08Z, deploy complete 03:45:35Z, one attempt. `main` and production name
the same SHA again.

**No behavioural check of external conversation import has been run against
`348a3df`.** The feature's flag is off in production, so there is nothing for a
user to exercise; what this build changes is only reachable once the flag is
turned on, which is the decision this record does not make.

## What would close this

The gap is one commit's provenance, so closing it is narrow.

- [x] Read `/api/build-info` back from production and confirm it names `348a3df` — before this merge it named `ad9b69a`, two commits behind `main`
- [x] `/api/ready` returns true on all four checks
- [x] `db:migrate` applied nothing, as expected for a change with no migration
- [x] Confirm `feature.externalConversationImportEnabled` is still off in production
- [x] Confirm no external-import error events appear in the hour after deployment

The wider question — whether the feature may be activated — is **not** closed by
this and is not meant to be. That needs the activation-SHA run described in the
checklist's H section.

```
Verified by:     @mposition
Verified at:     2026-08-19T05:01:58Z
Outcome:         pass
```

## Whether anything should change so it does not recur

Nothing here suggests a rule was missing. `.github/RELEASE_CHECKLIST.md` already
has an "Out-of-band changes to main" section, and this is what it describes: a
narrow change, its blast radius named, its content verified elsewhere, recorded
before the merge rather than discovered after it.

Worth noting for the count, though: this is the fifth deviation record in the
directory, and the four from 2026-08-15 already observed that "three in a day is
a lane". This one is three days later and has a better justification than any of
them, which is exactly how a lane stays open.
