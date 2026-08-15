# Release deviation — 2026-08-15, `5528317`

Three more out-of-band merges to `main`, recorded in one document because they
arrived inside four hours and the last one contains the other two. It also
carries the verification work done against production this afternoon, which
closes several items the three earlier records left open — and one it opened.

**Not a waiver, and it cannot become one.** A waiver is a decision someone owns
*in advance*; this describes something that already happened. A record made
afterwards cannot create an approval that was not sought beforehand.

**Intent is recorded only as far as it is evidenced.** All three branches are
named `claude/…-main`. Nothing states urgency and nothing here infers it.

## The gap

| | |
|---|---|
| Newest build a checklist covers | `851598eb8957342bc66d742596692961dbaec03f` |
| Earlier deviations, same day | `b0cf10e…`, `391c933…`, `78af657…` |
| **SHA production serves** | `5528317e19fb8f061f18a9fde98f68c9fecd6013` |
| Deployment ID | `441f60b3-9565-4aec-8eaf-70930716dfe7` |
| Deploy created / succeeded | 2026-08-15T12:03:05.353Z / 13:08:06.645Z |
| **Rollback SHA** | `851598eb8957342bc66d742596692961dbaec03f` |
| `verifiedAt` | 2026-08-15T13:13:35Z (`curl https://tomverse.app/api/build-info`) |

## Seven deployments, one day

The count is the finding, so it is written out rather than summarised. Every
row is a production deployment of the `Tomverse` service in the `production`
environment (`4ffdeab7-a1fb-4ec1-bf4a-4dd2818ba668`), read from Railway at
2026-08-15T13:30Z.

```
created     SHA        deployment                              covered by
01:10:21Z   851598eb   a155e054-20d3-4799-aea0-842d62db72b6    release checklist
01:34:29Z   de441b9    9c6aee22-104e-471a-a1dd-f81b28ecc695    deviation b0cf10e
02:15:22Z   b0cf10e    8c442b0a-284c-45b5-8254-9fc98fea76d8    deviation b0cf10e
06:12:20Z   391c933    b080424a-0806-480e-a6cd-1e36859d5ea1    deviation 391c933
08:10:37Z   78af657    8b7a0258-641f-4ebe-b198-5549c8ce2aa7    deviation 78af657
09:04:09Z   77d3009    4552e1de-acd1-4c94-891d-6cbff5802c83    this record
11:57:02Z   ed9b803    294fb3dd-e09e-4bdc-ac2a-f6b5ee394333    this record
12:03:05Z   5528317    441f60b3-9565-4aec-8eaf-70930716dfe7    this record, current
```

**Seven builds took production traffic after the last verified release.** The
`78af657` record said three in a day is a lane rather than an anecdote; the
number has since more than doubled. That record's observation stands and this
one adds nothing to it, because a deviation record is a description and not a
control. §7.9's three-lane rewrite is the control, and it is not merged yet.

A build takes roughly an hour here, so a merge time is not a deploy time.
Approximate windows each build actually served, derived from when the next
deployment succeeded:

```
77d3009   ~09:16Z → ~12:35Z     3h 19m
ed9b803   ~12:35Z →  13:08Z        33m
5528317    13:08Z → (current)
```

## What changed

Ten commits, `78af657..5528317`. 29 files, +1833/−49, of which roughly half is
test code. **No migration and no schema change** — `git diff --name-only
78af657 origin/main -- prisma/` is empty, so nothing about the production
database moved.

| PR | Merge | Subject |
|---|---|---|
| [#599](https://github.com/mposition/Tomverse/pull/599) | `77d3009` | Promotion checkout: stamp tool, coupon-id extraction, expired-checkout lease release |
| [#610](https://github.com/mposition/Tomverse/pull/610) | `ed9b803` | Make the compiler ask whether the candidate search ran |
| [#608](https://github.com/mposition/Tomverse/pull/608) | `5528317` | Serialize the admin user detail's usage counts |

Two of the three are worth naming precisely.

**#610 fixes a fix that shipped and did nothing.** `evaluateStripeLinkage()`
learned to tell "searched and found nothing" from "never looked", and
`runPromotionDiagnostics()` builds its facts field by field and never copied
the new one. The value arriving at the predicate was `undefined`, the branch
guarding on `=== false` never fired, and the admin panel went on calling a
working promotion `no_stripe_object_for_code`. A shipped change that changes
nothing is the failure mode this deviation lane makes most likely: nobody
looked at it running anywhere before it was in production.

**#608 fixes the page this record's own verification needed.** `GET
/api/admin/users/[userId]` passed `ChatUsageBucket."count"` — a BigInt column —
straight to `NextResponse.json()`, so the route answered 500 for any customer
who had chatted that day and the panel rendered "Failed to load user detail."
The Admin E2E fixture could not have caught it: the seeder wrote
`ChatUsageBucket."key"` as `user:<id>` while every admin route looks rows up
through `getUserChatUsageKey()`, which is `user:<sha256>`, so every usage figure
in the suite read zero and the specs stayed green through the exact condition
that fails in production.

## Why this is a deviation and not a release

`.github/RELEASE_CHECKLIST.md` §7.9 lists six conditions. The first fails for
all three merges, and the first is what makes the exception an exception.

| §7.9 condition | Status |
|---|---|
| It is a **security update**, named as one, with its advisory | **No.** Three correctness fixes. §7.9 says a change that merely arrived on `main` is not this |
| A person approved it, and a staging waiver is recorded | **Partly.** Human merge approval: evidenced by `@mposition` merging #599, #610 and #608. Pre-merge staging waiver: **not evidenced / not recorded** |
| The new release SHA is recorded | Yes — `5528317e…`, and the two it contains |
| Verified beyond PR CI | **Partly.** See below — more than the earlier three, and still not everything |
| A rollback SHA is named | Yes — `851598eb` |
| The back-merge to `develop` is confirmed | Yes — `git merge-base --is-ancestor origin/main origin/develop` returns 0 at 2026-08-15T13:30Z |

## What was verified against production this afternoon

This is the part that closes earlier records rather than adding to them. Every
row was run by `@mposition` against `https://tomverse.app` and read back
through the Admin Console or a direct request.

| Check | Result | Time (UTC) | Closes |
|---|---|---|---|
| One chat turn per provider adapter, settled | **4/4** — `openai/gpt-5-6-luna`, `anthropic/claude-haiku-4-5`, `google/gemini-2-5-flash`, `moonshot/kimi-k2.7-code`. All `settled`, `Outcome: completed`, provider request **and** response IDs present | 13:10–13:11 | `b0cf10e` |
| `pg_get_constraintdef()` on production | `ExternalImport_provider_check` and `ExternalConversation_provider_check` both read `chatgpt, claude, gemini` | ~13:2x | `391c933` |
| Admin step-up recovery path, steps 1–5 | Confirmed by a person signing in for real | ~13:3x | `78af657` |
| One image generated, signed asset URL resolves | Confirmed earlier in the day, 1 succeeded, 53,060 µUSD attributed | — | `b0cf10e` |
| `feature.externalConversationImportEnabled` | Turned on during testing, **left on**, found by asking, turned back off. `GET /api/admin/external-imports` over a 7-day window reports **0 imports, 0 of every status, `unavailable: false`** — so the zeros are measured, not a failed query | 13:35 | `391c933` |

### The four chat turns cover eleven providers, and that is not a coincidence

The check exists because #570 updated four provider SDK packages.
`lib/activeAiModel.ts:30` resolves eleven enabled providers through exactly
those four adapters:

| Package | #570 | Exercised | Other providers on the same adapter |
|---|---|---|---|
| `@ai-sdk/openai` | 4.0.30→4.0.40 | `openai` | deepseek, mistral, xai, qwen, perplexity, zhipu |
| `@ai-sdk/anthropic` | 4.0.30→4.0.38 | `anthropic` | minimax (`createAnthropic`) |
| `@ai-sdk/google` | 4.0.34→4.0.42 | `google` | — |
| `@ai-sdk/moonshotai` | 3.0.26→3.0.34 | `moonshot` | — |

`ai` 7.0.52→7.0.62 — streaming and usage reporting — is on the path of all
four. **Every adapter #570 updated produced a settled reservation.**

Two providers remain genuinely uncovered rather than covered by inference:
`deepseek` and `perplexity` wrap the client with their own `fetch` to read
usage out of the response (`lib/activeAiModel.ts:41`, `:57`). Same package,
their own parsing code, and provider usage parsing is precisely the class the
`b0cf10e` record named. One turn each closes it.

## What is still not verified

- **Stripe on this build.** The checkout path was exercised end to end on
  **staging in test mode**, which verifies `stripe` 22.5.0's code. It is not
  evidence about the production artifact, and it cannot become so: production
  requires a live key (`lib/securityEnvironment.ts:110`, asserted by
  `/api/ready`), and a live key rejects test cards. Closing this on production
  means a real charge, a read-only resync of an existing live subscription, or
  an explicit named-risk approval. That is a decision, not a task.
- **An error reaching Sentry with its own trace id.** Delivery works — the
  08:19:59Z `CSP_VIOLATION_DETECTED` event carries `release: 78af657…` — but
  that is the previous build and that path has no application trace id on it.
  The tagged capture is `lib/traceErrorEvidence.ts:128`, reachable only for
  `AI_PROVIDER_ERROR`, `AI_REQUEST_FAILED`, `DEEP_RESEARCH_JOB_FAILED`,
  `AI_EMPTY_RESPONSE` or a 5xx, and only when the caught value is a real
  `Error`. It cannot be provoked from outside without breaking something, so it
  is recorded as test-covered and production-unproven rather than manufactured.
- **`prisma migrate status` from a worktree at the served SHA.** Still open
  from `391c933`. Lower value now that the constraint has been read back
  directly, which is the fact the ledger could not give.
- **`77d3009` and `ed9b803` on their own.** Neither was verified while it was
  serving. Both are contained in `5528317` and are covered only to the extent
  the checks above cover their code.

## What this verification found

**A production secret was being sent to a third-party system.**

`sentry.server.config.ts` redacted a request header only when its name matched
`authorization|cookie|token|api[-_]?key`. `x-tomverse-origin-verify` matches
none of them, so `CLOUDFLARE_ORIGIN_SECRET` — the shared value proving a
request reached the origin through Cloudflare rather than around it
(`lib/originProtection.ts:81`) — travelled in plaintext on every Sentry event
carrying request headers. It was found by reading one such event during the
Sentry check above, not by any test or gate.

Scope, stated as measured rather than as feared: the value is in Sentry event
payloads, retained under that project's retention, visible to anyone with
project access. Whether it was used is not established and nothing here claims
it was. The value must be treated as burned regardless.

- Code fix: `redactReportableRequestHeaders()` inverts the denylist to an
  allowlist so a header added tomorrow is redacted by default. Node and Edge
  now share one helper.
- **Rotation is an operational action outside the tree and is not done by that
  fix.** Until `CLOUDFLARE_ORIGIN_SECRET` is rotated in both Cloudflare and
  Railway, the origin-protection boundary is a known-disclosed secret.

Separately, the same event shows `script-src-elem` blocking Cloudflare's Email
Address Obfuscation script on our own origin. Low severity — the obfuscation
simply does not run — but it is a standing source of CSP incident noise.

**Two feature flags were left on after testing today**
(`feature.imageGenerationEnabled`, then
`feature.externalConversationImportEnabled`). Both were found because someone
happened to ask. These are `AppSetting` rows: they change with no deploy, leave
no deployment trail, and neither `/api/ready` nor `/api/build-info` reports
them. **Nothing currently tells anyone that a flag was left on.** Naming it
here because it is now a pattern rather than an incident.

## What would close this

All four deviations at once, since `5528317` contains the other three. Verify
this SHA — not `develop`, which is further ahead and would measure a different
build.

- [x] One chat turn per provider adapter, settled — 4/4, 13:10–13:11Z
- [x] `pg_get_constraintdef()` read back from production — both tables admit `chatgpt, claude, gemini`
- [x] Admin step-up recovery path, steps 1–5
- [x] One image generated, signed asset URL resolves
- [x] `feature.externalConversationImportEnabled` read back — `false`, with 0 imports over 7 days
- [ ] One turn each on `deepseek` and `perplexity`, confirming usage settles
- [ ] Rotate `CLOUDFLARE_ORIGIN_SECRET` in Cloudflare and Railway
- [ ] One error reaching Sentry with its application trace id, on this SHA
- [ ] A Stripe path on the production build, or a recorded named-risk approval
- [ ] `prisma migrate status` from a worktree at `5528317` itself
- [ ] Deploy `5528317e19fb8f061f18a9fde98f68c9fecd6013` to staging and read `/api/build-info` back

```
Verified by:     ____________________
Verified at:     ____________________
Environment:     ____________________
Outcome:         ____________________
```

Until those are filled in, **the newest build with behavioural verification is
`851598eb`**, and that is the rollback target. That sentence has been true in
four consecutive records and is less true than it was this morning — most of
what `b0cf10e` and `391c933` were waiting on has now been measured against a
build that contains them.

## Related

- `.github/audits/release-deviation-2026-08-15__b0cf10e.md`
- `.github/audits/release-deviation-2026-08-15__391c933.md`
- `.github/audits/release-deviation-2026-08-15__78af657.md`
- `.github/RELEASE_CHECKLIST.md` §7.9
- `docs/policy/trace-feedback-automation.md` — why the Sentry item asks for a trace id rather than an event
