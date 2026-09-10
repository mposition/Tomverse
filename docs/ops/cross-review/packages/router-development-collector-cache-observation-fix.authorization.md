# Limited Claude review authorization — collector cache-observation CI fix

Recorded by Codex on `2026-09-10` after reading the current conversation's
authorization. This is a receipt date, not an asserted timestamp of the user
messages, a signature, a preflight result or a reviewer execution.

## Fresh permission and exact scope

The immediately preceding user-facing question was:

> CI 수정 2파일의 새 Claude 읽기 전용 검토에도 기존 --skip-preflight 예외를 허용하시겠어요? 종료된 검토 기록은 보존하고 새 기록으로 검토합니다. 테스트·CI 우회, API 과금 전환, 유료 벤치마크 실행은 포함하지 않습니다.

The user responded:

> 승인합니다

This new permission applies only to the announced read-only Claude review of
the two-file CI fix, through
[router-development-collector-cache-observation-fix](router-development-collector-cache-observation-fix.task.json).
Its base is `886ea27f852a7d00c6cccbba26ec0002f2086d16`; its four scoped paths
are the provider source/test pair and this task/receipt pair. The documents
are provenance and instructions, not additional runtime implementation.

This is a new CI issue discovered after the earlier collector exchange
concluded. There is no `supersedes`, prior-verdict reuse, history reset or
revision-cap increase. Preserve the original task, canonical 28-file archive,
active 21-file passed exchange and original v1 records byte-for-byte. The new
output is `artifacts/cross-review/router-development-collector-cache-observation-fix`,
using the existing ignore rule, `generatedPaths: []` and zero diff exclusions.

## Boundaries retained

- The orchestrator already announced the need for this new independent
  review. Actual invocation still awaits its separate go and successful
  required local checks. Authoring this receipt is not invocation authority
  for the current documentation step.
- Use the unchanged controller with author Codex and reviewer Claude. Keep
  `claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`,
  with no shell/write tools, model override or extra MCP access.
- `--skip-preflight` is a recorded skip only. It does not demonstrate a
  passed preflight, refused write probe or human source-code inspection.
  `--review-despite-check-failures` and test/CI bypasses are prohibited.
- Before an authorized invocation, remove `ANTHROPIC_API_KEY` in every case
  spelling only from the child environment copy and observe sanitized
  stored `claude.ai` login status. Preserve parent/persistent environment and
  login configuration. Child-only Git/bin PATH availability is allowed;
  `--bare`, API-billing fallback and secret output are not. Missing login
  stops the review. This receipt is not an auth-status observation.
- At most two fix rounds apply to the new exchange. At the cap, actionable
  findings require `on_hold`, not another exchange or an override.
- No paid benchmark execution, provider probe, API-billing switch, main
  merge, deployment, model-quality claim or policy/pricing change is
  authorized. The existing 60-call source-886 proposal remains unapproved;
  future paid collection needs a regenerated final-source manifest and its
  own exact numerical/digest-bound human approval.
- Commit, packaging, actual review, push and merge each await separate go.
  No result or future CI success is manufactured by this permission.

## Historical round-0 evidence, not current-round certification

These observations concern the original two-file +33/-1 implementation at
`dcabb4e3e130781de5819d2639ea4ab0e7f0df0f`, not a later revision. The original
receipt and its initial hash table remain in that Git commit and the immutable
round-0 diff. The fixed source is addressable with
`git show dcabb4e3e130781de5819d2639ea4ab0e7f0df0f:lib/routerDevelopmentCollectorProvider.ts`
and the same command for `tests/routerDevelopmentCollectorProvider.test.mjs`.
No unavailable public URL or machine-local temp file is required to understand
the observations below. Publication of that ancestry remains a later step.

At the reviewed round-1 source `ff0600e1858130988ea7820611736ec0dba5ed59`,
the implementation diff against the same base is provider +2/-0 and test
+33/-1, totaling +35/-1 across those two files, distinct from the initial
dcabb4e3 +33/-1 above. The two additional lines assert
`servedProcessingTier === null` and `unsupportedBilling === false`.
The fixture comment replaces wording within the existing added block and
adds no net line. This patch-size observation grants no new permission and
certifies no later checks or review outcome.

The original author summary transcribed tool observations rather than saving
full raw logs: collector 80/80, official typecheck, two-file lint and diff check
passed; full local wiring changed from 10/12 to 11/12 but **still exited 1**.
The cache-harvest CI regression passed, while the pre-existing Windows
path-separator failure remained. Those are historical author reports, not
new tests or independent Claude observations.

The actual round-0 controller package, produced at
`2026-09-10T05:42:02.317Z`, records one successful collector command and 11
successful guards at that source. Its change digest is
`sha256:eed64ad80aac2977a59b50570d2d8245b2251262328e9c4bac5f53199e07a33e`;
the records are `package-round0.json` and `change-round0.diff` in the existing
task output directory named above. Its five-line excerpts omit pass totals.
Subsequent native raw TAP logs at the same source recorded 80/80 and the exact
named CI target 1/1, zero fail/skip/cancel/todo; the other 11 wiring tests were
not executed. They are separately labelled `collector-tests.supplemental.raw.tap`
and `wiring-target.supplemental.raw.tap`, not replacement package output.
Generated local records still need their later authorized durable archive;
this receipt does not claim they are already available in a fresh clone.

Codex also compared working and committed bytes directly at the fixed source.
Claude's Read/Grep/Glob-only review could not independently compute hashes.
Do not treat either a duplicated hash table or this receipt as current-file
authentication: each later package must bind its own actual source/diff digest
and record genuine checks. Editing this evidence section creates no new user
permission and certifies no later test result or reviewer verdict.

Targeting one CI regression is not a full-wiring-suite pass. No local full-unit
pass has been observed. The reported Linux CI run at source 886 had 8,436
tests: 8,434 pass, one fail and one skip. Fresh full Linux CI on the actual
published fix head remains mandatory before merge; historical records and
the earlier review cannot substitute for it.

The fix makes the existing Google cache-write **unknown/null** explicit and
tests that non-allowlisted raw/SDK fields cannot fill writes, uncached input
or cost. It does not establish historical paid underbilling or newly observe
a Google cache-write metric. All tests described above are offline mocks or
static checks, not benchmark provider calls or independent Claude findings.
