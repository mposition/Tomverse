# router-full-catalog-diagnostic-v2: the records of the second exchange

**Status: `on_hold` (`revisions_exhausted`) at round 2.** The control
program's replay is `exchange.json`; nothing in this directory is edited by
hand, and this README is the only file here that was not written by
`scripts/cross-review.mjs`.

## What the records show

| Round | Package | Verdict | Findings |
|---|---|---|---|
| 0 | `package-round0.json` | `request_changes` | 4, basis evidence, each with a reproduction |
| 1 | `package-round1.json`, digest `sha256:acdba9ee…`, commit `b9ce8626` | `request_changes` | 4, basis evidence, each with a reproduction |
| 2 | `package-round2.json`, digest `sha256:e8f9d835…`, commit `152eff4a` | `request_changes` | 2, basis evidence, each with a reproduction |

Round 2 was the second revision, the last the cap allows (`MAX_REVISIONS`
in `lib/crossReviewCore.ts`), so the exchange concluded. The two round-2
findings are recorded `unresolved_on_hold`:

1. `packageExclusionProblems` / `scopedDiff`: a name git reads as a pattern
   (`lib/[c]rossReviewCore.ts`) passed the exact-match check, and git, handed
   it as a pathspec, hid the scoped source it matches from the diff and the
   digest.
2. `writeRefusalEvidence`: the probe path was matched as a substring, so a
   denial at `shadow/<probe>` counted as the probe's.

This exchange continued `router-full-catalog-diagnostic-v1` (`lineage` in
the packages, `supersedes` in the task file), which concluded the same way
with four findings open. Those four were shown to the reviewer of round 0
and were not raised again after round 1.

## After the conclusion, without a review

Both round-2 findings were reproduced offline and fixed in the commit
"Answer the two findings the second exchange was put on hold with, after
its conclusion and without an independent re-review". **That change was
not read by the independent reviewer.** No third exchange was opened (one
more continuation would be allowed by `MAX_SUPERSESSIONS`), and no further
model call was made. Its verification is offline only: the regression
tests that carry the reviewer's reproductions
(`tests/crossReview.test.mjs`), the guard rules, the type check and the
eight-file test set, all re-run on the integrated tree.

The preflight record version moved to `cross-review-preflight-v3` with
that fix. The preflight that passed here
(`preflight-2026-09-09T12-03-31-095Z.json`) was judged under v2; no
preflight has been run under v3, and none was needed since no review
followed. A review of a later change needs a new preflight.

## Provenance

- Every record names the commit it was made on. Those commits, and the
  base `787a37c8` the digests are measured against, are on the feature
  branch `claude/to-develop/router-full-catalog-diagnostic`, not on
  develop: the integration replayed the reviewed state as fresh commits.
  To check a digest, check that branch out at the recorded commit and run
  `--mode=review` without `--i-have-authorised-live-execution`; the dry run
  verifies the tree against the package before it stops.
- The reviewer's raw output (`review-round*.events.jsonl`) shows read-only
  commands and no patch in every round. In round 2 its own attempt to run
  the test set was stopped by the sandbox (`spawn EPERM`,
  `review-round2.stderr.txt`); the control program's test run recorded in
  each package is the test record.
- Four preflights failed before the sandbox could start its shell (the
  Store-installed PowerShell under WindowsApps, which the sandbox's
  restricted token cannot start); they are kept as environment results,
  apart from any finding about the change. The two that passed are
  `preflight-2026-09-09T10-53-10-800Z.json` (record version v1; its
  evidence was a pathless "patch rejected" line, which v2 stopped
  accepting) and `preflight-2026-09-09T12-03-31-095Z.json` (v2).

## Not covered by any check here

- Whether a reachable fallback candidate would execute on a real request:
  the diagnostic labels it execution-unverified by design, and the
  conditions it cannot verify are listed in `unverifiedConditions`.
- The reviewer's environment on any other machine or sandbox signature.
- A preflight of the Claude Code reviewer invocation, which is pinned to
  have no shell and no write tool and so cannot show a refused write.
