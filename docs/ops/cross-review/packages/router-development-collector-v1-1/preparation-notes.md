# Router collector v1.1 package preparation

This records two preparation attempts for the same unreviewed round 0. It is
not a reviewer verdict, a new review round, a failed-check override or evidence
of provider access. No Claude review or benchmark provider call ran here.

## Frozen review identity

- Task: `router-development-collector-v1-1`; author Codex, reviewer Claude.
- Reviewed source/specification/receipt commit:
  `40ce5fc2179f040d3d8bf4a3e4c147f33af93133`.
- Base: `88dc1d6bfd6cbac983d6d0c2609b7eb37df08910`, an explicitly selected
  develop snapshot, not a claim to include every later develop commit.
- Both attempts used the same 13 scoped paths, empty `generatedPaths`,
  explicit `--round=0`, no `supersedes`, and only this package's exact output
  directory as `--diff-exclude`.
- Both source diffs have digest
  `sha256:55cb20818f04feabb2ea0af86cb641da5caed13d329ea34d424558ac2b5b3420`.

## Preparation attempt 1: required shell unavailable

The unchanged controller invokes check commands through `sh`. In the initial
package process environment, spawning `sh` failed with `ENOENT`. All one
test-command entry and ten guard entries were recorded as failed, with blank
child output and durations of 1-2 ms. Zero tests or guard commands executed in
this attempt; these are not test assertion failures or passing checks.

The generated exchange remained `awaiting_review`, with 11 `checkFailures`,
`reviewConclusion`, `failure`, `holdReason` and `concludedAtRound` all null,
and no verdict. The controller's package command exited 0 despite reporting
`CHECKS NOT PASSING`; the preparation wrapper then exited 1 because its
explicit passing-check assertion failed.

The five original generated files were moved to an external temporary archive
without content changes before the orchestrator's pause message arrived. No
retry had run at that pause. The orchestrator then inspected the actual state
and the controller's same-unreviewed-round behavior before authorizing retry.
This did not reopen a concluded exchange or reset a consumed review revision.

The originals are preserved externally at
`C:/Users/Vyper/AppData/Local/Temp/router-collector-package-40ce5fc2-20260910/failed-attempt-1/`
and copied byte-identically for repository handoff:

| Original file | Preserved copy | SHA-256 |
| --- | --- | --- |
| change-round0.diff | [copy](preparation-attempt-1/change-round0.diff) | `55cb20818f04feabb2ea0af86cb641da5caed13d329ea34d424558ac2b5b3420` |
| change.diff | [copy](preparation-attempt-1/change.diff) | `55cb20818f04feabb2ea0af86cb641da5caed13d329ea34d424558ac2b5b3420` |
| exchange.json | [copy](preparation-attempt-1/exchange.json) | `5ed6def00687f44c9d4a6bcf64c99dc0595446d2ad4393acc80c75ddf8069e45` |
| package-round0.json | [copy](preparation-attempt-1/package-round0.json) | `ee700373f9cec097c953b7f9d5c1910992160e417ba038afd39c128df690de93` |
| review-prompt.md | [copy](preparation-attempt-1/review-prompt.md) | `ed3a119a0728a1fa1a941997d590781a035e436ab1fcd602779204187fb42931` |

The existing controller rejects re-packaging a round that already has a
verdict, but permits an explicit same round with no verdict. Its review
failure guidance is to fix the checks and package again. Its current
whole-tree scope check also rejects generated untracked output left in place
under this exact 13-path task. The already-empty output location was therefore
reused only after the above inspection and explicit retry authorization. No
source, controller, writable scope, ignore rule or exclusion was widened.

## Preparation retry: same source and checks, usable child shell

Only the package child's environment copy changed: the existing PATH key was
found case-insensitively, its spelling preserved, and
`C:/Program Files/Git/bin` prepended. Parent/persistent environment, permissions
and reviewer sandbox were not changed. Read-only child prerequisite checks
resolved `sh` as `/usr/bin/sh`, Node as `v22.22.2` and npm as `10.9.7`, exit 0.
The complete package argument array, including test and guard command bodies,
was asserted identical to the saved first invocation before retry.

The official command entry was
`node --import tsx scripts/cross-review.mjs --mode=package`, with
`--author=codex --reviewer=claude --round=0`, the task and base above,
`--out=docs/ops/cross-review/packages/router-development-collector-v1-1`,
and that exact directory as the sole `--diff-exclude`. The full executed test
command is recorded in [package-round0.json](package-round0.json)
`testResults[0].command`; each full guard command is in `guardCommands` and
`guardRuns[].rule`. No live/review/preflight flag or failed-check override was
used. The machine-readable complete executable/argument array and child-only
PATH adjustment are retained outside the repository in
`C:/Users/Vyper/AppData/Local/Temp/router-collector-package-40ce5fc2-20260910/attempt-2/package-invocation.json`.

The successful package was produced at `2026-09-10T03:15:37.221Z` and records
a clean named commit, all 13 files and the unchanged digest. Actual test
results, parsed and asserted from each execution, are retained together in
the test output tail:

| Executed test group | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| `npm run test:router-development-collector` | 72 | 72 | 0 | 0 |
| `npm run test:router-development-benchmark` | 95 | 95 | 0 | 0 |
| Named 12-file related Router regression command | 181 | 181 | 0 | 0 |
| `tests/processingTierGuard.test.mjs` | 9 | 9 | 0 | 0 |
| Total | 357 | 357 | 0 | 0 |

All ten guard entries passed: official typecheck; scoped nine-file lint;
encoding; document references; policy-section references against the fixed
base; model pricing; Router quality; Router context window; context-window
register; and explicit byte/scope/package-script/processing-tier preservation.
The last guard checked 124 protected paths, original records 11 and v1 source
8, author files 10 excluding the expected package union, all 212 package
scripts, package non-script fields and lock, existing four allowlist entries
plus the exact new observation pin, and rejection of an unregistered outbound
tier mutation. These checks do not establish runtime account access, health,
invoice correctness or human adoption of the synthetic corpus.

[The current exchange](exchange.json) remains `awaiting_review`, with zero
check failures and no verdict. The failed preparation copies and this note
were added only after package checks completed; they are preparation metadata
inside the exact own-output directory, not additional reviewed source files.
An actual independent review still requires its separately announced go.
