# Collector cache-observation CI fix: independent review

The existing controller concluded `passed` at round 2 from an actual Claude
CLI verdict of `approve` with no findings. Author: Codex; reviewer: Claude.
This new four-path exchange addresses the Google cache-write unknown/null
CI follow-up. The earlier collector exchange remains closed and unchanged;
its approval was not reused or reopened.

## Review binding and chronology

Task: `router-development-collector-cache-observation-fix`; base:
`886ea27f852a7d00c6cccbba26ec0002f2086d16`. Scope is the provider source,
provider test, task and authorization receipt. There are no diff exclusions
or generated source paths; `maxRevisions: 2`, `packagedRounds: 3`.

| Round / attempt | Actual result | Controller outcome |
| --- | --- | --- |
| 0 / first | Output rejected as invalid_json; no accepted verdict | awaiting_review |
| 0 / second | approve with four findings | awaiting_revision |
| 1 | approve with one receipt-wording finding | awaiting_revision |
| 2 | approve with no findings | passed, concludedAtRound 2 |

Exact source and change-digest bindings:

- Round 0: `dcabb4e3e130781de5819d2639ea4ab0e7f0df0f`;
  `sha256:eed64ad80aac2977a59b50570d2d8245b2251262328e9c4bac5f53199e07a33e`.
- Round 1: `ff0600e1858130988ea7820611736ec0dba5ed59`;
  `sha256:0a9537d609e5ec898abe89eb90ba1c6231f75b7d5003b3bc06d15546eba15eba`.
- Round 2: `34a179fd1986afbb2909cc38b0fa988814e5aa0e`;
  `sha256:ba44bb1c84ef0f9c95d04ae947a5991f79f18a14b10664022c156d94a51108cf`.

The final package SHA-256 is
`eafab3402fe037f934c4e5eddece4b308b2a28265e992044ab9132ec8109f66e`.
The controller, task and revision cap were not changed to obtain approval.

## Actual CLI execution and evidence limits

Final review used Claude Code `2.1.261`, controller start
`2026-09-10T06:53:57.608Z`, verdict received
`2026-09-10T06:55:32.765Z`, measured duration `95101 ms`.
Recorded argv, not a rerun instruction:

`claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`

Only the user's limited `--skip-preflight` exception was used:
`preflight: null` means skipped, not passed. There was no model override,
shell/write tool, failed-check override or API-billing fallback. Codex observed
stored `claude.ai` / `firstParty` login after removing every case spelling of
`ANTHROPIC_API_KEY` from the child environment only; parent environment and
stored login were unchanged. Git/bin was added only to the child PATH.

The final CLI-reported cost estimate was `$0.605464`, not an invoice,
settled API charge or benchmark spend. Nullable reasoning usage remained null
in the normalized record. The result event is not a complete per-tool
transcript, proof of a sandbox write-refusal test, or a claim that Claude
personally reran package checks or independently calculated file hashes.

## Checks, historical failures and preserved records

The round-2 package genuinely executed the collector checks: **80/80**, plus
the exact cache-harvest wiring regression: **1/1**, with zero
fail/cancelled/skipped/todo. Eleven other wiring tests were intentionally
deselected, not passed. Actual counts remain in the package's final summary
lines and the new `round2-package-*.raw.tap` files. All **11 guards passed**,
including official typecheck, two-file lint, encoding/document/policy checks,
pricing/Router/context checks and the base-bound diff check.

Historical full Windows wiring was **11/12, exit 1**, with its pre-existing
path-separator failure; the original source-886 Linux run was 8,436 tests:
8,434 pass, one fail and one skip. These are not rewritten as successful
whole-suite results. Fresh full Linux CI on the actually published fix head
remains required before merge.

This archive preserves all **36 review files / 565,104 bytes** unchanged,
this separately authored README and **38 integration-verification files**:
**75 files** in total. `failed-attempt-1/` retains the first
unaccepted response and failure. The root `review-round0.failure.json` is
that historical first-attempt failure, not the final status; root
`review-round0.events.jsonl` records the accepted-format second attempt.
`round0-aliases/` and `round1-aliases/` retain prior diff/prompt/exchange
aliases. Preparation plans, supplemental evidence and original statements
retain their original dates and limits; they are not rewritten as current
certification. Current aliases represent round 2.

## Separate local integration, not an expanded review approval

A normal local merge produced
`f301f2d8365ae094a764477a9fea56a2de1d08ab`, with parents
`34a179fd1986afbb2909cc38b0fa988814e5aa0e` and fixed develop
`ea9c802d4c96cb0e320e9681bd7476495840a314`.
Codex's merge-time checks found the reviewed four files unchanged in working
tree/index/commit, 37 unchanged dependencies, and unchanged older archive
28 / active 21 / current review 36 files. Upstream's 26 paths were preserved
exactly; the diff against ea9c is only the four reviewed paths. Upstream
gitleaks, voice-policy and model-lifecycle changes are not this fix's changes.

A separate offline verifier completed integrated checks on f301f2d8 at
`2026-09-10T07:09:36.542Z`: **412 passed** = collector 80 + original
benchmark 95 + related Router 181 + processing-tier 9 + exact wiring target 1
+ separate upstream gitleaks/voice 46. Every executed test group had zero
fail/cancelled/skipped/todo; the other 11 wiring cases were not executed.
All **17 commands exited 0**, including official typecheck, two-file lint,
seven document/policy guards and two diff checks. This is targeted local
verification, not a full Linux CI pass or a new Claude review of the merge.

The durable [integration summary](integration-verification/FINAL-INTEGRATION-VERIFICATION.json)
has SHA-256
`fa454b75982addcb1ca5e48c76d2455700db8aeff7b99ef0937a1b5a5f6ac1fb`.
Its exact commands, timestamps and log hashes are preserved alongside all
34 stdout/stderr logs, `FROZEN-SNAPSHOT.json`, and the two original
`summary-audit-attempt*.tool-output.txt` files. The 38 files retain their
original bytes. Their filenames are mirrored in `integration-verification/`;
absolute temp paths inside the raw JSON are historical source locations,
not a requirement to access those machines. Two summary-audit harness
SyntaxErrors are preserved as preparation failures; they did not rerun the
tests or change their results. Historical logs and whitespace were not edited.

No benchmark provider call or numerical execution approval was made. The
source-886 60-call pilot proposal remains an unapproved historical draft:
final-source regeneration and separate exact human budget/digest approval
are required before any execution. No model ranking, production adoption,
main deployment or quality-policy promotion follows from these checks.
