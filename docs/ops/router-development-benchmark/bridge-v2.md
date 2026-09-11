# Benchmark v2 offline bridge

This slice connects the existing 48-case [v2 corpus and family partitions](corpus-v2.md)
to a versioned full-catalogue plan, fixed mock collection, durable journal,
exact grading, execution receipts and static Replay. It is DEVELOPMENT FIXTURE /
CANDIDATE validation. It performs no provider call, paid collection, Router
policy adoption, Chat dispatch, release approval or production deployment.

The [v1 benchmark](README.md), [collector v1.1](collector-v1.1.md),
[execution contract](execution-contract-v2.md) and [historical Replay](../router-replay/README.md)
retain their own entry validation and schemas. The old 60-call observation,
approval, journal, score and source snapshot are not read or rewritten.
Additional package scripts do not qualify for the old Replay package exception;
historical Replay still requires its original compatible checkout.

## Versioned boundaries

- `router-development-plan-v2` reconstructs all 48 cases and every supplied
  catalogue model from the independently supplied source, corpus and frozen
  partition. It binds the full corpus digest, partition ID/digest, model/API
  identities, pricing, prompt and call configuration, and version set. Gold
  remains in the corpus and grader; it is absent from the plan and dispatch.
- `router-development-mock-manifest-v2` is a strict mock-only wrapper around
  the reused acquisition manifest. Its full embedded plan remains present.
  The legacy live CLI rejects both the wrapper and its embedded v2 plan before
  importing a provider. A mock approval label is not spending authorization.
- The existing collector now shares explicit structural matrix fields. Its
  intent-before-dispatch, fsync witness, exclusive lock, budget/deadline,
  unknown hold and no-repeat state machine are reused. It still accepts at
  most 1,008 selected rows; this slice selects only 96. No legacy limit is raised.
- The existing execution contract/observation schema is reused. The v2 builder
  first reconstructs the v2 plan and mock manifest. `policyDigest` includes the
  plan version set and partition digest; contract and journal manifest digests
  bind the same acquisition run. No system or Planner stage, extra context,
  search, attachment or tool is executed. Retries remain zero.
- `router-development-results-v2` accepts only synthetic-fixture observations
  with null provider metrics and identities. Export validates each witnessed
  terminal against its reconstructed execution contract under the collector
  lock. A returned `length` or unconfirmed finish cannot become a gradeable
  success, even when an outcome declares `completeResponse: true`.
- `router-development-mock-replay-v2` requires raw journal text, approval,
  contracts and observations as well as answers. It replays the hash chain and
  checks each answer against the exact terminal row, timestamp, digest and
  outcome. Rehashing a changed plan or moving a terminal across runs is refused.

Unknown, incomplete and unsupported acquisition remains held. Missing
observations retain their selected row IDs and `not_observed` holds. Known
failure and timeout remain acquisition categories; blank, invalid JSON and
wrong returned values remain distinct grader categories. A partial result
does not turn pending rows into failures or remove them from the denominator.

## Fixed mock and denominator accounting

The command retains 48 cases × 42 catalogue models = 2,016 plan rows in the
current catalogue snapshot: 720 statically planned calls and 1,296 refused
rows. The default model and DeepSeek Flash are selected for every case,
yielding 96 mock calls. These are assertions about this development snapshot,
not permanent catalogue counts or real model availability.

The fixed stub returns 92 exact fixture answers, one wrong value, one blank,
one invalid JSON and one known acquisition failure. Gold is read only in the
stub after checking the dispatch envelope, and later by the exact grader.
The model-facing request has exactly `modelId`, `prompt`, `maxOutputTokens`,
`settings` and `signal`. The static selector receives the prompt-derived
profile, eligible models, original baseline and data-only policy; it receives
no expected answer, saved answer or grade.

The journal is interrupted after two durable terminals. Resume acquires only
the remaining 94 rows, and a third invocation dispatches zero rows. A separate
intent-only interruption retains one intent, zero terminals, zero adapter
calls and an export refusal. A synthetic length probe remains held. Genuine
separate mock journals are also tested against cross-manifest receipt rebinding.

Reports keep planned/refused/selected/observed/unselected-eligible counts
overall, per model, in all eight task/language/difficulty cells, in twelve whole template
families and in the fixed 24/24 partitions. The score also retains every
catalogue row. Replay's paired-case population is 48; that denominator is
different from the full catalogue's 2,016 rows. Complete paired mock coverage
does not measure real quality. `productExecutionVerified` stays false and
`productPerformanceDelta` stays null.

TTFT, whole-call and end-to-end timing, token usage, and provider-billed cost
are unmeasured and null. Mock adapter counts and simulated reservation are
reported separately from zero real provider calls and zero incurred provider
spend. The simulated clock, all-zero protocol source commit and synthetic
approval are clearly identified; the real implementation HEAD, dirty state
and explicit source-file digests are separately recorded. Local hashes do not
authenticate provider execution or establish independent human judgement.

The shared limits remain 200,000 JSON nodes, depth 32 and 16,777,216 document
bytes. Both canonical and actually written pretty JSON are checked and
reparsed. The report records byte/node capacities for its own final bytes,
plan, manifest, contracts, observations and answers. These checks demonstrate
this snapshot's capacity, not support for every possible 256-model catalogue.

## Local operation

Run on the local Windows PC in PowerShell, inside the Tomverse worktree root
(for this work, `H:/Project/tomverse-router-benchmark-v2-bridge-20260911`). Git,
Node 22 and this checkout's installed dependencies are required. No production
credentials, provider keys or environment variables are needed. Do not set
`CHAT_MODEL_*` pricing/cap overrides; the command rejects those overrides.

Local PC / PowerShell / worktree root, with those prerequisites. Help is
read-only. The default bridge creates and removes only its own temporary
mock journal directory and prints a report without prompt/answer/gold text.

```powershell
npm run benchmark:router:v2-bridge -- --help
npm run benchmark:router:v2-bridge
```

Local PC / PowerShell / worktree root, with the same prerequisites and no
credentials. This creates a new directory under an existing parent and
refuses to overwrite an existing destination. Inspect and preserve the output
when needed for review; undo by removing only this generated directory after
checking it contains no work to retain. Keep it outside historical evidence.

```powershell
npm run benchmark:router:v2-bridge -- --output-dir=H:/Project/router-benchmark-v2-bridge-results-20260911
```

Outputs are `MOCK-ONLY.json`, `plan.v2.json`, `manifest.mock.v2.json`,
`contracts.mock.v2.json`, `observations.mock.v2.json`, `answers.mock.v2.json`,
`report.v2.json`, and mock journal/witness files under
`router-development-collector-v1.1/`. That child directory is under the new
mock destination, never the repository's real Git common directory. Plan and
manifest files contain synthetic prompt text; answer/observation files contain
synthetic responses. There is no live flag, external approval input, provider
selector or arbitrary corpus override.

Local PC / PowerShell / worktree root, with the same installed dependencies
and no credentials. These offline tests use injected adapters and temporary
files. The bridge tests preload a guard for fetch and common Node HTTP/socket
entry points; this is not an OS network sandbox.

```powershell
npm run test:router-development-v2-bridge
npm run test:router-development-benchmark
npm run test:router-development-collector
npm run test:router-development-execution
```

The new bridge suite includes v2 plan/results tests. Existing corpus and
Replay suites, type checking, scoped lint and repository document/encoding
guards are also required for the final source snapshot. Actual final command
results and independent Claude review belong to the frozen review record;
listing commands does not claim they passed or that review approved this source.
At source preparation, independent review, merge and deployment of this bridge
remain pending. This document is not changed after review merely to claim
approval of its own previous bytes.

Implementation: [plan](../../../lib/routerDevelopmentPlanV2.ts),
[results](../../../lib/routerDevelopmentResultsV2.ts),
[bridge](../../../lib/routerDevelopmentBridgeV2.ts),
[CLI](../../../scripts/router-development-v2-bridge.mjs), and
[bridge regression](../../../tests/routerDevelopmentBridgeV2.test.mjs).

Next work is a concrete, separately authorized provider observation proposal
if needed, and independent product integration for Chat. Existing 60-call
approval and code-review authorization cannot authorize a new paid benchmark.
