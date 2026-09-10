# Router development collector v1.1 independent review

The existing controller derived **`passed` at round 2** from an actual Claude
CLI verdict of `approve` with `findings: []`. Author: `codex`; reviewer:
`claude`. This is one exchange with two permitted revision rounds, not reuse
of the earlier v1 approval or an internal Codex review relabeled as Claude.

- Task: `router-development-collector-v1-1`; exact reviewed scope: 13 paths.
- Base: `88dc1d6bfd6cbac983d6d0c2609b7eb37df08910`.
- Approved source: `d087876da40a574e8d4e5baa0c2412525620f92c`.
- Approved digest: `sha256:68a70f500dd8579a40224c0c6f7f297715d447e8ba5557d55163fffad2491acc`.
- [Task](../router-development-collector-v1-1.task.json),
  [limited authorization](../router-development-collector-v1-1.authorization.md),
  [final package](package-round2.json), [reviewed diff](change-round2.diff),
  [verdict](verdict-round2.json), [CLI event](review-round2.events.jsonl),
  [exchange](exchange.json), [final prompt](review-prompt.md).

## Chronology: an approve label was not sufficient

| Round | Source | Raw Claude result | Controller result |
| --- | --- | --- | --- |
| 0 | `40ce5fc2179f040d3d8bf4a3e4c147f33af93133` | approve, 3 evidence findings | awaiting_revision |
| 1 | `bf433682da1cf82c26e9c82aefd6c0dfcb4883c8` | approve, 1 evidence nit | awaiting_revision |
| 2 | `d087876da40a574e8d4e5baa0c2412525620f92c` | approve, no findings | passed |

Round 0 digest:
`sha256:55cb20818f04feabb2ea0af86cb641da5caed13d329ea34d424558ac2b5b3420`.
Round 1 digest:
`sha256:b968bf159f191459ed02e5f4df376829ea5706d580eb91c4f20a7c223e66150b`.

[Round 0](verdict-round0.json) identified output-path handling, explicit refusal
of unsupported provider families, and the documented relative-path semantics.
[Round 1](verdict-round1.json) identified that `not_run` alone conflated selected
but unattempted rows with never-selected rows. Round 2 approved the manifest-
derived `selected` marker, documentation and assertions without changing outcome
labels, denominators, journal, reservation or export semantics.
The final record has `packagedRounds: 3`, `concludedAtRound: 2`,
`maxRevisions: 2`; no history reset or extra revision was used.

## Actual execution and its limits

Round 2 used Claude Code `2.1.261`, starting at
`2026-09-10T04:21:28.015Z` and receiving the verdict at
`2026-09-10T04:23:23.059Z`. Controller-measured reviewer duration was
`114989 ms`; the raw event's `113592 ms` and outer wrapper's `115359 ms`
measure different intervals.

The recorded argv below is execution evidence, not an instruction to rerun:

`claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`

No model override was supplied. Only the authorized `--skip-preflight` exception
was used; `preflight` remains `null`, not passed. No failed-check override was
used. Read/Grep/Glob and strict mode are invocation configuration, not a
successful sandbox write-refusal experiment. The preserved final event confirms
an actual reviewer result but is not a full per-tool transcript or evidence that
Claude personally executed each package test.

The execution summary labels usage as a CLI-reported subscription usage/cost
estimate. Round 2 reported `totalCostUsd: 1.7176185000000002`: not an invoice,
settled API charge, independently authenticated billing mode, or benchmark
spend. Nullable usage was not filled with zero. The documented child-only
API-key removal and retained-login conditions are separate from production
provider access, health or invoice verification.

## Package verification versus reviewer evidence

The final [package](package-round2.json) records actual checks on d087:
collector **79**, original benchmark **95**, related Router **181**, and
processing-tier guard **9**: **364/364**, with fail/cancelled/skipped/todo all
zero in every group. Exact commands and observed counts are preserved in
`testResults[0].command` and its output. This is a targeted suite, not the
entire default CI unit suite or a model-quality evaluation.

All **10 guard entries passed**: official typecheck; exact nine-file lint;
encoding; document references; policy references against the fixed base;
model pricing; Router quality; Router context window; context-window register;
and explicit byte/scope/package-union/processing-tier-pin preservation.
The preservation check covered 124 protected paths, including the original
11 records and eight v1 source/data/test paths. `checkFailures` is empty.
Controller-executed package checks and the independent review verdict are
different evidence.

Supplemental local corroboration, not additional reviewer output:

- `C:/Users/Vyper/AppData/Local/Temp/router-collector-review-d087876d-round2-20260910/review-summary.json`
  — SHA-256 `80717ed111daae2a8b90237ff92cd80e2867a09bbdcf3379ef8ace01b57ae525`.
- `C:/Users/Vyper/AppData/Local/Temp/router-collector-round2-final-verification-1789012995258/ROUND2-FINAL-VERDICT-AUDIT.json`
  — SHA-256 `362af019ebdd48745b8c9d9d58075caf30dcac4bee9abde401ea70157f95da1c`.

The independent read-only Codex audit checked each raw result against its
envelope/schema, existing pure replay against the persisted exchange, and
source/prior-record preservation. It made no reviewer or benchmark provider
call. Final raw SHA-256 values:

- Verdict: `5ab07c38026b4df7244d18704ed1a946a0aea706b9352e5f706a90be188b5056`.
- Event: `36babeda3e066b8d5276d05a32983f879a73accb659e3c4cf135bb6fbdbf6113`.
- Exchange: `0580ba068e407b055f379cd4320ed523a008ba82feb6cac048e58c6c3037ede1`.

## Historical records and storage relocation

[Preparation notes](preparation-notes.md) and `preparation-attempt-1/` retain
the initial `sh`-unavailable attempt, in which checks did not execute. Their
`awaiting_review` and not-yet-run statements describe that preparation time,
not the final exchange. Historical contents and renderer whitespace are not
rewritten to look current.

After round 0, the controller's whole-tree scope check encountered its own
untracked documentation output. Records were recoverably relocated to the
default output under the pre-existing `/artifacts/` ignore rule. Task, base,
13-path source scope, revision cap and prior raw bytes stayed unchanged.
Rounds 1 and 2 used **zero exclusions**. No controller, ignore rule or source
permission was widened; reviewed code was not hidden. Returning final evidence
to documentation does not solve future packaging's whole-tree constraint or
authorize reopening this terminal exchange.

Preserve the original `change.diff`, `review-prompt.md` and `exchange.json`
aliases separately in `round0-aliases/` and `round1-aliases/`. Their external
originals remain at:

- `C:/Users/Vyper/AppData/Local/Temp/router-collector-round0-preserved-20260910-aa101467e6e14ee7b42f00b145b1aed1/records`
- `C:/Users/Vyper/AppData/Local/Temp/router-collector-round1-preserved-20260910-c9477e07d9274d6abc2e58065f4be243/round1-aliases`

The archive contains 21 completed active files, six historical aliases and
this README = **28 files**, copied only after actual review pass and integrated
verification. The 27 raw copies retain their original bytes; external originals
remain intact.

## Separate local integration evidence

The review remains bound to d087, not an implied advance approval of another
snapshot. Normal local integration was recorded at
`2026-09-10T04:29:36.917Z` as `065aee02867423128e049e6dd64249babd234902`,
with parents d087 above and the fixed develop snapshot
`e0ec7c6429c35d2c3dff1f5999adc87fe23e1ce5`. The actual command was
`git merge --no-ff --no-edit e0ec7c6429c35d2c3dff1f5999adc87fe23e1ce5`.
No source edit or further fetch was part of that integration.

The integration observation confirms exact working/index bytes for reviewed
source 13, dependencies 38, protected paths 124 and active review files 21;
existing dependencies 34 match upstream; upstream's 21 changed paths were
accepted exactly. The feature diff remains 13 paths and preserves the reviewed
digest. Supplemental record:

`C:/Users/Vyper/AppData/Local/Temp/router-collector-integrate-e0ec7c64-20260910/integration-summary.json`
— SHA-256 `4223ab4768161d1cc2c5e4e3777eaeca2b968154e722e9308c6cc61bcc044eb3`.

That merge-time observation explicitly has `integratedTestsExecuted: false`;
it has not been rewritten. The later execution evidence is recorded below.

### Actual integrated verification

A separate read-only verifier completed the checks on clean integrated HEAD
`065aee02867423128e049e6dd64249babd234902` at
`2026-09-10T04:34:32.679Z`. Required tests were **364/364**
(79 + 95 + 181 + 9); additional upstream wire/voice/auth tests were **189/189**,
reported separately. Every test group had zero fail/cancelled/skipped/todo.
Official typecheck, scoped lint and all seven policy/document guards exited 0.
Both `git diff --check` and
`git diff --check e0ec7c6429c35d2c3dff1f5999adc87fe23e1ce5` passed.

Execution context: local Windows/PowerShell in
`H:/Project/tomverse-router-collector-v1-1-20260910`, using the installed
workspace dependencies. These were offline/component/mock checks requiring no
production/provider credentials. The commands below are recorded executions,
not live-collection instructions. Log timestamps are file creation/last-write
observations on 2026-09-10 UTC, not authenticated process start/end times.

| Check | Passed/tests | Exit | Log-created–last-write UTC |
| --- | ---: | ---: | --- |
| collector-79 | 79/79 | 0 | 04:32:19.894–04:32:41.521 |
| benchmark-95 | 95/95 | 0 | 04:32:45.470–04:32:56.857 |
| related-router-181 | 181/181 | 0 | 04:32:45.424–04:32:49.091 |
| processing-tier-9 | 9/9 | 0 | 04:32:45.502–04:32:45.516 |
| official-typecheck | — | 0 | 04:32:19.894–04:32:21.716 |
| scoped-lint-9 | — | 0 | 04:32:45.504–04:32:45.508 |
| encoding | — | 0 | 04:33:32.897–04:33:34.010 |
| doc-references | — | 0 | 04:33:32.928–04:33:34.164 |
| policy-section-references | — | 0 | 04:33:32.927–04:33:33.822 |
| router-quality-eval | — | 0 | 04:33:32.927–04:33:33.326 |
| model-pricing | — | 0 | 04:33:32.944–04:33:33.431 |
| router-context-window | — | 0 | 04:33:32.991–04:33:33.357 |
| context-window-register | — | 0 | 04:33:32.967–04:33:33.442 |
| upstream-wire-voice-auth | 189/189 | 0 | 04:32:46.637–04:32:57.518 |

Exact executed commands:

- **collector-79:** `npm run test:router-development-collector`
- **benchmark-95:** `npm run test:router-development-benchmark`
- **related-router-181:** `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/routerFullCatalogDiagnostic.test.mjs tests/routerCandidates.test.mjs tests/routerDecision.test.mjs tests/routerSelection.test.mjs tests/routerCallLimits.test.mjs tests/chatContextWindow.test.mjs tests/taskProfileCore.test.mjs tests/routerScorePolicy.test.mjs tests/routerCostProjection.test.mjs tests/routerSignalCore.test.mjs tests/routerQualityEvalSet.test.mjs tests/routerQualityDecisionGate.test.mjs`
- **processing-tier-9:** `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/processingTierGuard.test.mjs`
- **official-typecheck:** `npm run typecheck`
- **scoped-lint-9:** `npm run lint -- lib/routerDevelopmentCollector.ts lib/routerDevelopmentCollectorJournal.ts lib/routerDevelopmentCollectorProvider.ts scripts/router-development-collect.mjs scripts/check-processing-tier-core.mjs tests/routerDevelopmentCollector.test.mjs tests/routerDevelopmentCollectorAdversarial.test.mjs tests/routerDevelopmentCollectorCli.test.mjs tests/routerDevelopmentCollectorProvider.test.mjs`
- **encoding:** `npm run check:encoding`
- **doc-references:** `npm run check:doc-references`
- **policy-section-references:** `npm run check:policy-section-references -- --since e0ec7c6429c35d2c3dff1f5999adc87fe23e1ce5`
- **router-quality-eval:** `npm run check:router-quality-eval`
- **model-pricing:** `npm run check:model-pricing`
- **router-context-window:** `npm run check:router-context-window`
- **context-window-register:** `npm run check:context-window-register`
- **upstream-wire-voice-auth:** `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/memoryEvalVnextWire.test.mjs tests/mobileAuthDeploymentBinding.test.mjs tests/mobileAuthUndeterminedSigning.test.mjs tests/voiceProviderBudget.test.mjs`

The final summary binds those commands, counts, exits, timestamps and per-log
SHA-256 values:
`FINAL-INTEGRATED-VERIFICATION.json`, SHA-256
`f205690da3d5852dce0125a286559b2e8ade2cb06bcf5aa3f0105f393f2f7455`.
Its supplemental local directory is
`C:/Users/Vyper/AppData/Local/Temp/router-collector-integrated-final-verification-065aee02-1789014729202`.
`INTEGRATED-FROZEN-SNAPSHOT.json` in that directory records the exact source,
dependency and review-file hashes. Archive preparation independently compared
all 14 log hashes with the summary before copying records.

The verifier confirmed source 13/dependencies 38/protected 124/review 21 and
upstream 21 preservation, the original reviewed digest, historical 88dc pins,
unchanged 212-script union and processing-tier pin, and a clean source scope
after checks. These are actual integrated runs, separate from the earlier
package checks; they do not constitute another Claude review of 065aee.

## No live, quality or production approval

No benchmark provider call was performed in this work. Review permission does
not supply the separate numeric budget, selected rows, manifest digest, expiry
and accepted assumptions required for a real collection. The source-40ce
reservation census is historical conditional allocation, not an actual-spend
forecast, current manifest or spending approval.

Synthetic development fixtures, static eligibility, passing tests and successful
acquisition do not establish a model winner, quality improvement, quality-band
promotion, ROUTE-01 evidence or production adoption. This review does not
authorize main integration, production deployment, or production Router, price,
registry or credit changes.
