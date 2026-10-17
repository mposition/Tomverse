# Release deviation — 2026-10-17, `38c46e3`

**A selective release (§7.9.1) reached `main` without its release candidate
being deployed to Test.** PR #2622 was merged while Test still served another
candidate, and the move that would have replaced it was not approved. This
records what was verified, what was not, and why.

Drafted by the agent (Claude) on 2026-10-17 from repository, GitHub and
`/api/build-info` reads. Nothing below is a verification that did not happen.

## The release

| | |
|---|---|
| Pull request | #2622, `release/2026-10-17-marketing-s3` → `main` |
| `main` before the merge | `2a721388d34e4397a251d0682e35e77d0324d51f` |
| Release candidate (head of the branch) | `1b9e1cfcb71aa4315781c34f98e39328ec65ed40` |
| Merge commit | `38c46e3e9c319723970176222d577dc88761101c`, merged 2026-10-16T23:38:03Z by `mposition` |
| Content | Marketing automation S3, 15 `develop` PRs cherry-picked with `-m 1` (#2548, #2550, #2553, #2556, #2560, #2562, #2565, #2567, #2569, #2572, #2576, #2581, #2583, #2584, #2586), the kill-switch fix found in this release's review (#2623), a test assertion rewritten for CodeQL, and the regenerated admission manifest. 18 commits, 67 files, +10,363 / −108 |
| Conflict resolutions the originals never had | admission manifest regenerated; `docs/policy/marketing-automation.md` taken from each PR's merge; `lib/adminAuditSystemActors.ts` keeps `main`'s `ops-observer` block and adds the marketing generator scope block; the maintenance `credit-reservations` route and its contract test take only the marketing LLM expiry step and leave out AMUX Decision Maker lines whose module is not on `main` |
| Migrations | `20261016120000_marketing_llm_call_ledger`, `20261016150000_marketing_llm_call_legal_hold_decision` |
| Back-merge to `develop` | **Not confirmed.** The back-merge workflow conflicted (47 files, 35 of them AMUX/orchestrator) on 2026-10-16T23:38Z and again after the next release; a person has to resolve it |
| **Rollback SHA** | `2a721388d34e4397a251d0682e35e77d0324d51f` (`main` before this release) |

## The gap

§7.9.1 asks for the RC SHA to be deployed to Test and read back through
`/api/build-info`. That was not done.

- Test (staging) served `78f2a346e540cf300f8c65753cc2182ee64eb754`, the
  `develop` merge of #2532 (AMUX v4 plan screen), deployed 2026-10-15T11:54Z.
  `npm run promote:test -- --sha=<RC> --source=release/2026-10-17-marketing-s3
  --dry-run` reported the move as a rewind, so it needs `--allow-rewind`, and
  whether that candidate was still being verified was the operator's to say.
  The question was asked in the session and the release was merged before it
  was answered.
- Production now serves `bd747183fb462c63b83f570c3c2e96f0edd76adb` (deployment
  `9c819c8f-8309-4828-ab18-9705872ca7db`, deployed 2026-10-17T00:48:18Z,
  `deploymentStatus: success`). It is the next release (#2630) and contains
  `38c46e3e9…` in its history. `38c46e3e9…` itself was not measured.
- What was read on production after the deploy: `POST` with no credential to
  `/api/internal/marketing-llm-budget`, `/marketing-drafts`,
  `/marketing-generator-context` and `/marketing-intel-reports` each answered
  401, and an unknown path under `/api/internal/` answered 404. So the routes
  are deployed and refuse an unauthenticated caller. No authenticated call was
  made.

What was verified before the merge, on the release branch itself: `tsc`
(pre-existing route-type classes only), five static checks, 819 unit tests,
and a fresh PostgreSQL 17 database migrated from the branch with no schema
drift, on which 14 marketing database suites and the maintenance contract
tests passed. PR CI ran on the branch.

## What the gap leaves unmeasured, and the risk

**Closed by construction.** These were not exercised on any deployment:

- Every LLM reservation is refused (`MARKETING_LLM_PRICE_PINS` is empty).
- Draft intake is refused (the price-fallback alert is not ready).
- The generator service is not wired into Railway, and its worker refuses to start without a price pin.
- Market facts are counted, not stored (`MARKETING_COMPETITOR_SOURCE_HOSTS` is empty).

The route answers above are consistent with this.

**What runs in production without a person.** Two maintenance steps now run:

- The ledger expiry sweep, every 15 minutes, on a table that starts empty.
- Daily marketing retention (§12.2):
  - deletes expired reports and measurements, and rejected or expired drafts older than ninety days that never reached a platform;
  - purges the content of terminal posts twenty-four months after publication;
  - summarises attempt and webhook history entries older than ninety days.

The deletions and purges are **irreversible**. Their bounds:

- The database's delete and update triggers decide what may go, and refuse everything else.
- Legal hold is respected.
- Every change writes an audit row in the same transaction.
- The whole step does nothing while `MARKETING_AUTOMATION_KILL_SWITCH` is set (#2623).
- Production marketing accounts are test accounts.

What has not been checked is how many production rows the first run will touch. That count can be read before or after the first run from the `retention_run` reports and the `marketing_retention.*` audit rows.

**Migrations.** Both only create the `MarketingLlmCall` table, its constraints,
triggers and legal-hold decision columns. No existing table or row changes.

## To close

- [ ] Back-merge `main` into `develop`. Of the 47 conflicts, 30 are files
      whose `main` version appears verbatim in `develop`'s history, so
      `develop`'s side loses nothing. Of the other 17:
      - The marketing route `app/api/internal/maintenance/credit-reservations/route.ts`
        and its contract test have no `main`-only line, so they take `develop`.
      - The admission manifest is regenerated, not merged.
      - `lib/adminAuditSystemActors.ts`, `scripts/check-protected-table-writers-core.mjs`,
        `scripts/run-db-integration-tests.mjs`, `tests/adminAuditSystemActors.test.ts`
        and `AGENTS.md` each carry lines that appear nowhere on `develop` (for
        example the QA release actors and `DB_INTEGRATION_GROUPS`), so they
        need a line-by-line resolution, not "take `develop`".
      - The remaining AMUX files need the same care, and
        `tests/promptRefinerRuntimeSourceClosure.test.mjs` holds pins only the
        operator moves.
- [x] Confirm or correct the risk statement above, including whether the first
      production retention run should be checked, and sign below

```
Reviewed by:   mposition
Reviewed on:   2026-10-17
```

**Signed.** `mposition` gave the signature above in the session on
2026-10-17 and the agent transcribed it. It confirms this record's account of
the gap and the risk judgement. It is not a Test measurement of the RC, which
did not happen. The back-merge item stays open until the back-merge lands.
