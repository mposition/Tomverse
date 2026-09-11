# Benchmark v2 execution-contract slice

This is the first bounded implementation slice, not completion of Benchmark
v2 or evidence of better model selection. It adds strict condition comparison
and an offline mock path through the existing collector, journal, exact grader
and Replay. The proposed 48-case corpus, new paid manifest, real collection,
Router-policy changes and Chat product integration remain later work.

Implementation: [contract core](../../../lib/routerDevelopmentExecution.ts),
[offline smoke](../../../scripts/router-development-contract-smoke.mjs),
[core tests](../../../tests/routerDevelopmentExecution.test.mjs) and
[CLI tests](../../../tests/routerDevelopmentExecutionCli.test.mjs).
The [v1 benchmark](README.md), [collector v1.1](collector-v1.1.md) and
[Replay v1](../router-replay/README.md) keep their existing formats and behavior.

## Conditions, observations and limits

`router-development-execution-v2` binds the exact prompt digest, opaque
context content/provenance digests, source commit and source-snapshot digests,
corpus/catalogue/policy/plan/manifest digests, internal model ID, provider,
API model ID, output cap, generation-settings digest and zero retries.
The settings digest covers the complete frozen settings object, including
provider-specific options; the contract does not copy those options or
context text into a second artifact. `policyDigest` covers the original
plan's version set; a candidate selection policy remains independently
versioned by Replay.

`collectionExecutionContracts()` first reconstructs the v1 plan and manifest
using independently supplied source snapshots, corpus and models. Its current
bridge always records **no additional context**, no system/Planner stage and
search/tools/attachments false: the collector sends the case prompt alone.
The generic schema can compare opaque supplied-text context snapshots, but
this does not add context execution to the existing collector. Search, tools
and attachments remain explicit unsupported-mode refusals even when both
compared contracts contain the same true value.

`router-development-observation-v2` binds a contract digest and row ID to an
allowlisted collector outcome, a journal-entry digest and the terminal's
recorded-at instant. Replaying at a later time does not alter that instant.
Changing the actual collection timestamp changes the observation digest,
not the execution contract. A changed plan/manifest is still incompatible;
this slice does not merge different runs or infer that two aliases resolved
to the same deployed provider version.

`validateExecutionObservationSet()` accepts raw journal text, the manifest and
its approval, plus independently supplied frozen corpus, catalogue and source
snapshots. It bounds the journal using the existing collector limit, checks
the manifest body digest and calls `collectionExecutionContracts()` internally
to rerun the existing plan and manifest validators. Each supplied row contract
must match its reconstructed contract; rehashing an invalid plan or changing
a contract's model/settings/cap cannot manufacture compatible evidence.
It calls `replayCollectionJournal()` internally and reuses approval validation
against the recorded run-start instant. A fabricated `{ entries }` object cannot
substitute for replay. It checks each observation's row, time, complete
outcome and digest against the read-back terminal. Duplicates, unknown rows,
swapped receipts and changed outcomes are refused. The reconstructed journal
header's manifest digest binds every execution contract to that same run;
terminal content cannot be relabelled under a different manifest. The CLI uses the
existing exporter, which checks the registration witness under its lock.
The journal hash chain and these comparisons establish local record
consistency. They do not authenticate providers or prove that a metadata
declaration describes an independently observed network request.

The returned array preserves every supplied execution contract in its input
order. A contract without an observation retains its row ID, a null
observation, and `hold` / `not_observed`; partial input cannot silently shrink
the selected-contract population. The full catalogue population remains in
the separate v1 plan and score.

`compatible` means the listed benchmark conditions match and the local
acquisition outcome can be consumed in its stated category. It does not mean
an answer is correct or the product was executed. `comparedFieldsCompatible`
can be true while a mode is unsupported or a response is held.
`productExecutionVerified` is always false and `productPerformanceDelta`
is always null.

- Complete returned text with a confirmed `stop` is eligible for exact
  grading, including blank text and invalid JSON. Those are different grader
  outcomes, not transport errors.
- Known acquisition failure and timeout are separately named outcomes, not
  incorrect-answer grades. The original no-retry and timeout-stop rules remain.
- Missing observations, unknown or unsupported acquisition, incomplete/length
  responses, unconfirmed completion, unsupported billing and observed output
  cap violations remain on hold.
- Bare v1 results remain readable by v1. They have no v2 context/completion
  receipt, so importing them alone returns hold rather than manufacturing
  those fields. Original results and scores are not rewritten.
- TTFT, end-to-end latency and provider-billed cost are unsupported in this
  schema and must be null. Whole-call time and token usage retain the old
  collector's nullable fields. A new measurement path needs a versioned
  schema, not zero defaults. Mocks cannot claim those provider measurements.

The parsers reuse the existing duplicate-key, JSON-value, depth and node
checks. Serialized contracts are limited to 16 KiB and observations to 2 MiB;
the underlying answer-storage and v1 grader limits also remain in force.
These are storage/parser limits, not network ingress limits or a claim that
all 256 declared catalogue slots fit every plan.

## Fixed offline smoke

The command selects four existing synthetic cases and two eligible models
(the default model and DeepSeek Flash), eight rows in total. The complete
24-case catalogue matrix remains in planning, scoring and coverage. The stub
deliberately returns four correct values, one wrong value, one blank, one
invalid JSON and one acquisition failure. It uses the gold only inside the
fixed mock closure; the model-facing request is checked to contain exactly
model ID, prompt, output cap, settings and cancellation signal. The selector
does not receive gold, answers or grades.

The command interrupts after two durable terminal records, resumes only the
six unattempted rows, and confirms that another resume dispatches zero rows.
The report's `recoveredRows` records the actual adapter-call count increase
across that resume, independently of the terminal-record counters.
It reads the journal back, checks observation binding, exports through v1,
then grades and runs the existing Replay comparison. A separate intent-only
interruption proves that unknown state prevents dispatch and export; a
synthetic length response remains held by v2 compatibility.
Terminal-record counts include only attempts with a terminal, so the
intent-only interruption records one dispatch intent and zero terminal
records. The cross-run regression separately collects genuine A and B mock
journals, verifies both, and refuses an A terminal rebound under B's contract
even when the terminal content matches.

The mock uses a fixed clock, a plainly synthetic all-zero source commit and
an in-memory mock approval identified as **not human spending authorization**.
The report separately records the real implementation HEAD, dirty status and
an explicit source-file digest list. The list is not an authenticated or
complete transitive environment snapshot. Nothing runs against the real
Git common-directory collector ledger or loads provider credentials.

The unchanged v1 exporter labels records `externally-saved`. Only this new
mock output is converted to `synthetic-fixture`, retaining the manifest digest
in its origin description and clearing local timestamps
and nullable provider fields before scoring/Replay. Answer bytes and identity
bindings stay intact. The saved v2 observation retains the mock timestamp and
`mock-only` provenance; synthetic finish markers are not provider evidence.

Run on the local Windows PC, PowerShell, at this Tomverse worktree's root.
Node 22, Git and the existing installed dependencies are required; no provider
or production credentials are needed. Help is read-only. The default smoke
creates its own temporary mock journal, prints a content-free report, and
removes only that temporary directory after use.

```powershell
npm run benchmark:router:contract-smoke -- --help
npm run benchmark:router:contract-smoke
npm run test:router-development-execution
```

To retain reviewable mock artifacts, run in the same environment. This writes
only a **new** directory under an existing parent and refuses an existing
destination. Choose an unused path outside historical observation folders.
There is no live flag, custom provider, corpus override or approval input.

```powershell
npm run benchmark:router:contract-smoke -- --output-dir=H:/Project/router-contract-mock-results
```

Outputs are `MOCK-ONLY.json`, `manifest.mock.json`, `contracts.mock.json`,
`observations.mock.json`, `answers.mock.json`, `report.json`, and mock journals
under `router-development-collector-v1.1/`. Manifest/answer files contain
synthetic fixture text. The report contains no prompt, answer or expected
text and keeps failure, refusal and unmeasured denominators visible. Preserve
the directory when review needs it; otherwise only that generated mock
directory can be removed after checking its contents. No real approval or
old artifact is replaced.

Adding package scripts changes this checkout's package snapshot. Existing
historical Replay remains reproducible using its original compatible
checkout; this slice does not weaken Replay's source check to consume old
60-call artifacts under a new package snapshot.

## Acceptance and remaining work

The tests cover twelve acceptance groups: canonical digests; unchanged v1;
prompt/context binding; model/provider/API identity; cap/settings; unsupported
modes; source/policy drift; null metrics; refusal/failure/grader populations;
duplicate/tampered observation and journal binding; bounded parsers; and
offline provider-free/gold-free model-input wiring. Test results and Claude
independent review must be recorded against the final diff, not inferred from
this list. This document does not assert an independent verdict.

Next are the separately scoped v2 corpus and offline validation partitions,
followed by a concrete paid proposal if needed. This smoke creates neither
one, and no prior paid approval is reused.
