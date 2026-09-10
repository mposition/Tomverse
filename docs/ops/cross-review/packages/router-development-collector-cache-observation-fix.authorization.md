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

## Evidence at preparation time, not a new test run

The author-supplied summary at
`C:/Users/Vyper/AppData/Local/Temp/router-collector-google-cache-null-fix-20260910-d60aae3e917147f3908bb4a2383fa2d0/VERIFICATION-SUMMARY.json`
is a transcription of observed tool output, **not a full raw log**. Its
sibling `source.patch` records the two-file +33/-1 implementation. Codex
read the summary and directly checked the current diff and these file hashes:

| File | SHA-256 |
| --- | --- |
| `lib/routerDevelopmentCollectorProvider.ts` | `d4b3cdd679835166d723bad804ee20fe92c82436d31584596c1c3eb3c8539ab8` |
| `tests/routerDevelopmentCollectorProvider.test.mjs` | `ec3501b010870efe3343f91dca0b10b3e2e693557560699ad2229f5d954c6444` |

The supplied results report collector 80/80, official typecheck, two-file
lint and diff check passing. Full local wiring changed from 10/12 to 11/12
but **still exited 1**: the new cache-harvest CI regression passes while the
pre-existing Windows path-separator check still fails. Targeting the exact
CI regression must disclose deselected tests and cannot be called a full
wiring pass. No local full-unit pass has been observed. The reported Linux
CI run at source 886 had 8,436 tests: 8,434 pass, one fail and one skip.
Fresh Linux CI on the actual published fix head remains mandatory before
merge; these records and the earlier review cannot substitute for it.

The fix makes the existing Google cache-write **unknown/null** explicit and
tests that non-allowlisted raw/SDK fields cannot fill writes, uncached input
or cost. It does not establish historical paid underbilling or newly observe
a Google cache-write metric. All tests described above are offline mocks or
static checks, not benchmark provider calls or independent Claude findings.
