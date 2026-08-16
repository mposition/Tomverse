# Release deviation — 2026-08-15, `78af657`

The third out-of-band merge to `main` in one day. Recorded at the time, for the
same reason as the two before it: the next release checklist covers a different
SHA and cannot speak for this one.

**Not a waiver, and it cannot become one.** A waiver is a decision someone owns
*in advance*; this describes something that already happened. A record made
afterwards cannot create an approval that was not sought beforehand.

**Intent is recorded only as far as it is evidenced.** The branch is named
`claude/admin-reauthentication-ux-main` and the commit is "Give a spent admin
step-up window a way out". Nothing states urgency and nothing here infers it.

## The gap

| | |
|---|---|
| Newest build a checklist covers | `851598eb8957342bc66d742596692961dbaec03f` |
| Previous deviations, same day | `b0cf10e…`, then `391c933…` |
| **SHA production serves** | `78af6579aeb20c598735bdbbab9bcd6220cf678f` |
| Deployment ID | `8b7a0258-641f-4ebe-b198-5549c8ce2aa7` |
| Deployed at | 2026-08-15T08:16:52.881Z |
| **Rollback SHA** | `851598eb8957342bc66d742596692961dbaec03f` |
| `verifiedAt` | 2026-08-15T08:26:27Z (`curl https://tomverse.app/api/build-info`) |

```
391c933  Merge pull request #587                 ← previous deviation
d3bcc6f  Give a spent admin step-up window a way out
78af657  Merge pull request #596                 ← deployed to production, current
```

## What changed

[#596](https://github.com/mposition/Tomverse/pull/596), one commit `d3bcc6f`.
17 files, +1373/−95, of which 5 files and ~630 lines are tests.

**No migration and no schema change.** `git diff --name-only 391c933 origin/main
-- prisma/` is empty, so nothing about the production database moved. That is
the material difference from `391c933` and it is why this record is shorter.

Application files:

```
lib/adminReauthentication.ts          lib/adminReauthenticationCore.ts (new)
components/admin/AdminReauthenticationCard.tsx
components/admin/AdminAccountMenu.tsx
components/admin/AdminConsoleShell.tsx
components/admin/AdminUserSecurityControls.tsx
components/admin/PlatformSettingsPanel.tsx
app/(site)/(application)/auth/admin-reauthenticate/page.tsx
app/(site)/(application)/auth/signin/SignInPageContent.tsx
docs/ui-contracts/admin-console-ia.md   docs/qa/e2e-coverage-matrix.md   README.md
```

**It touches an authentication control.** Admin step-up re-authentication is
what stands between an admin session and a privileged action. That does not
make it a security *update* in §7.9's sense — there is no advisory and nothing
was disclosed — but it does mean this is not a cosmetic change, and it raises
rather than lowers the value of the staging step that was skipped.

## Why this is a deviation and not a release

`.github/RELEASE_CHECKLIST.md` §7.9 lists six conditions. The first fails, and
the first is what makes the exception an exception.

| §7.9 condition | Status |
|---|---|
| It is a **security update**, named as one, with its advisory | **No.** A UX correctness fix to an authentication control. §7.9 says a change that merely arrived on `main` is not this |
| A person approved it, and a staging waiver is recorded | **Partly.** Human merge approval: evidenced by `@mposition` merging #596. Pre-merge staging waiver: **not evidenced / not recorded** |
| The new release SHA is recorded | Yes — `78af6579…`, the merge commit |
| Verified beyond PR CI | **No.** See below |
| A rollback SHA is named | Yes — `851598eb` |
| The back-merge to `develop` is confirmed | Yes — `git merge-base --is-ancestor origin/main origin/develop` returns 0 at 2026-08-15T08:26Z |

## What was verified

| Check | Result | Time |
| --- | --- | --- |
| PR CI on #596 | 22 check runs, all success — including Admin Console E2E (PostgreSQL) and CodeQL | last finished 08:10:02Z |
| `/api/build-info` | `78af6579…`, `deploymentId 8b7a0258…`, `deploymentStatus: success` | 2026-08-15T08:26:27Z |
| `/api/ready` | `database`, `securityEnvironment`, `providerBudgets`, `imageProviderBudget` all true | 2026-08-15T08:26:27Z |

The Admin Console E2E suite is the relevant one here, and #596 adds to it:
`tests/e2e-admin/admin-step-up-recovery.spec.ts` is new, and the recovery
eligibility and account menu specs were extended. So the change arrived with
its own coverage rather than relying on what already existed.

## What is not verified

- **No staging deployment.** The change went to `main` directly, so the
  re-authentication flow has not been exercised on a deployed build by a person.
  E2E runs the flow against a test fixture; an admin signing in for real does
  not.
- **`/api/ready` is not behavioural verification.** It was green before this
  deploy and after it, and would stay green through a regression in the step-up
  window's behaviour.
- **Neither earlier deviation was closed.** `b0cf10e` and `391c933` are both
  contained in this build and both remain unverified.

## The margin, again

Recorded because it is now the third instance rather than an anecdote.

```
#587   CI finished 06:08:13Z   deploy started 06:12:20Z    4m 07s
#596   CI finished 08:10:02Z   deploy started 08:10:37Z      35s
```

The service's source configuration has `checkSuites: false`, so a push to
`main` deploys whether or not its checks have finished. Twice now the checks
have finished first, and the second time by thirty-five seconds. That is not a
guarantee; it is the same coin landing the same way twice.

Turning `checkSuites` on is a change to the service's source settings and is
not made by this document. It is named here so that whoever decides has the
measurement rather than an impression.

### Resolved, 2026-08-15

The decision was made after this record named it, and the setting was read
back rather than taken on report:

| Environment | Branch | `checkSuites` |
|---|---|---|
| production | `main` | **true** (was `false`) |
| staging | `develop` | **true** (was `false`) |

Read from the Railway service configuration at 2026-08-15T09:58Z. A push now
waits for its check suite before any deployment starts, so the margins tabled
above cannot recur.

Recorded here rather than in a new document because this is the one item the
record named that has since changed, and a reader arriving at the table above
should not be left measuring a race that no longer exists. It is an addition,
not a revision: every other fact in this document still describes 2026-08-15
as it happened.

Two consequences worth knowing before the next urgent change:

- **A red check suite now blocks the deploy entirely.** That is the point, and
  it is also the thing that will be inconvenient at the worst moment. A manual
  redeploy from the Railway dashboard bypasses the wait.
- **Staging now waits too**, and `develop`'s suite includes the credit and
  finance PostgreSQL scenarios at roughly 18 minutes. If that delay makes
  staging less useful as a place to look at something quickly, turning it off
  for staging alone is a coherent position — production carries the risk this
  setting was turned on for.

## What would close this

All three deviations at once, since `78af657` contains both earlier ones.
Verify this SHA — not the current `develop`, which is further ahead and would
measure a different build.

- [ ] Deploy `78af6579aeb20c598735bdbbab9bcd6220cf678f` to staging or a scratch environment
- [ ] Read `/api/build-info` back and confirm it names that SHA and its deployment ID
- [ ] Sign in as an admin, let the step-up window expire, and confirm the recovery path works
- [ ] The `391c933` record's outstanding items: constraint read-back, flag read-back, `migrate status` from a worktree at the served SHA
- [ ] The `b0cf10e` record's outstanding items: one turn per active provider, one Stripe path, one image generation, one Sentry error

```
Verified by:     ____________________
Verified at:     ____________________
Environment:     ____________________
Outcome:         ____________________
```

Until those are filled in, **the newest build with behavioural verification is
`851598eb`**, and that is the rollback target.

## Three in one day

Stated plainly, because the count is the finding.

```
2026-08-15
  851598eb   release, checklist run recorded
  b0cf10e    deviation — dependency group, no staging
  391c933    deviation — correctness fix + migration, no staging
  78af657    deviation — authentication control fix, no staging
```

§7.9 opens with "It is an exception, not a lane." Three in a day is a lane. The
rule is four hours old and the records are being written faithfully, which is
the system working as designed for its *recording* half — but a deviation
record is a description, not a control, and nothing here slows the next one
down.

That is a decision for a person and this document does not make it. What it
does is put the three in one place so the decision is made against the count
rather than against the most recent instance.

## Related

- `.github/audits/release-deviation-2026-08-15__b0cf10e.md`
- `.github/audits/release-deviation-2026-08-15__391c933.md`
- `.github/RELEASE_CHECKLIST.md` §7.9
- `.github/audits/image-generation-v2-handoff-2026-08-15.md` — written when production was `b0cf10e`; point-in-time and deliberately not updated
