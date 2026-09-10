# Router development benchmark collector v1.1

This collector is a development-only acquisition companion to the
[offline v1 benchmark](README.md). It is not production Router dispatch,
an account-access probe, a model-health check, a pricing-policy change, or
permission to spend. The synthetic corpus remains a DEVELOPMENT FIXTURE /
CANDIDATE set, not human-adopted `ROUTE-01` evidence.

Implementation: [manifest and approval core](../../../lib/routerDevelopmentCollector.ts),
[journal and export](../../../lib/routerDevelopmentCollectorJournal.ts),
[provider adapter](../../../lib/routerDevelopmentCollectorProvider.ts), and
[CLI](../../../scripts/router-development-collect.mjs).

## Status and authorization boundary

No paid benchmark run is performed as part of this implementation. At source
`40ce5fc2179f040d3d8bf4a3e4c147f33af93133` preparation, independent Claude review
of v1.1 had not yet run. This is historical preparation status, not the current
exchange verdict; later review results and revision status belong to the
control-program records. Earlier v1 and integration approvals apply to their
recorded source snapshots and digests, not this collector.
There is no quality-band promotion, production adoption, release-registry
change, main-branch integration, or production deployment in this work.

A preview is a proposal, not an approval. Any real collection needs a separate
authorization binding the exact manifest digest, selected rows, numeric
per-request and total budgets, call count, time limits, and expiry. An agent
must not choose numbers and present them as the user's approved budget.
Authorization for independent code review, including a review-preflight
exception, does not authorize benchmark provider calls.

The local collector's admission rules do not replace the product's entitlement,
operational guardrail, concurrency, or provider-budget layers. Those separate
contracts remain in [the credit and cost policy](../../policy/credit-and-cost-limits.md)
and [the concurrency policy](../../policy/chat-concurrency-and-identity.md).
No credit ledger, production reservation, price registry, or runtime model
registry is changed by this development workflow.

## Population, selection, and coverage

The v1 corpus has 24 synthetic cases: 12 Korean and 12 English, with 12
structured extraction and 12 source-grounded calculation tasks. Their prompts
contain the facts needed to answer; they need no search, attachments, or code
execution. The existing exact-answer grader, gold data, and v1 result contract
are not redefined by the collector.

Keep the full catalogue-by-case plan, including refused rows, alongside any
selected collection subset. In the original documented v1 static snapshot,
42 models times 24 cases yielded 1,008 population rows: 360 statically eligible
rows (15 models per case) and 648 refusals. These are snapshot observations,
not guaranteed totals for future catalogues or accounts. Selecting a few rows
does not turn them into the whole benchmark, or remove the other rows from
coverage reporting.

The two v1 diagnostics remain distinct:

- `row.router` preserves the product Router's inferred profile, eligibility,
  cap, rank, and selection diagnostics.
- `row.benchmarkEligibility` is static admission for validated fixture
  requirements and model-specific product caps. It is not production dispatch
  admission or evidence that credentials, quota, region, provider health,
  model availability, or current runtime registry permit a call.

Each run-report row carries `selected: boolean`, derived from the frozen
manifest's `selectedRowIds`. Read it alongside the existing `outcome`:
`selected: true` with `not_run` means selected but unattempted;
`selected: false` with `not_run` means eligible but never selected. This does
not change outcome labels, population or coverage denominators, or scoring.
Selection and attempt counts are not model-quality evidence.

Only the case's model input is sent for generation. Gold answers, grading
rules, verdicts, and other models' answers are not prompt inputs. Correctness
is checked later by the existing deterministic grader; this is not an LLM
judge or a coding executor.

Partial collection remains partial evidence. Preserve refusals, selected and
unselected rows, attempts, transport outcomes, missing results, and export
omissions separately. An unknown or oversize acquisition is not proof of a
wrong model answer and must not be converted into one to obtain a score.
The v1 scorer's existing coverage and complete-group denominator rules still
apply to exported results. No model winner or quality-band claim follows
from a preview, a successful API request, or a partial score.

## Conditional reservation is not a bill

The collector's conservative reservation uses catalogue context capacity and
the highest rates across the current pricing revision's tiers, subject to the approved
assumptions. This differs from the v1 prompt-token planning estimate. Neither
figure verifies provider tokenization, actual model context capacity, account
access, processing tier, additional fees, or the eventual invoice.

The word "reservation" describes a local admission/accounting allocation,
not a provider-enforced spending ceiling or a product credit reservation.
Even a calculation using the largest current listed tier is conditional on
the catalogue and pricing assumptions being correct. Request output limits
and cancellation signals are not proof of a billed-cost maximum.

Keep these quantities separate: reserved conditional budget, observed token
usage, token-price estimates derived from that usage, and provider-billed
cost. Missing usage and cost remain `null`; unknown is not zero. Partial known
usage must not make an incomplete total look fully measured. Aborted,
interrupted, or unconfirmed requests can have incurred charges even when no
answer is available locally. Their reservation is not automatically returned
to a spendable pool.

The product policy explicitly separates catalogue pricing from account
visibility and records an unresolved actual-processing-tier gap. See
[credit and cost policy, pricing registry and reservation sections](../../policy/credit-and-cost-limits.md).
This development collector does not close that gap by relabeling assumptions
as verified prices or actual billing.

`totalReservedMicroUsd` is the reservation required by all selected calls.
`completionPossibleWithinLimits` reports whether those calls all fit the
proposed per-request, total, and call-count limits; `false` does not make the
proposal an approval or silently shrink its population. An approved partial
budget can execute a prefix of sorted `selectedRowIds` and stop with
`budget_stopped`. No skipped row is removed from the report.

The run report uses `committedReservationMicroUsd`,
`reservationPolicy: "never_released_not_actual_spend"`, and
`actualInvoiceMicroUsd: null`. Per-terminal
`tokenUsageAtFrozenRatesMicroUsd` is a conditional token-cost estimate, not
actual spend. It is `null` unless the needed input partitions, output usage,
and applicable cache-write rates are known and consistent. Money limits use
positive safe-integer micro-USD: 1,000,000 micro-USD equals US$1. The reservation
also includes two micro-USD of input-partition rounding allowance.

## Durable request and interruption boundary

The acquisition contract is intent before dispatch, followed by a terminal
record for the same request. Persisting an intent is not evidence that a
provider received it; an intent with no confirmed terminal record is also not
evidence that nothing happened.

An interrupted or unknown request stays on hold. Do not reissue its row just
because the process exited, the client timed out, or a lock looks old. There
is no exactly-once guarantee at the provider boundary, and local cancellation
does not verify provider-side cancellation or billing. Do not automatically
delete a waiting lock, fabricate a terminal record, refund the reservation,
or copy a manifest into a new location to bypass duplicate protection.
Resolve uncertain calls through a separately authorized reconciliation; this
document does not authorize manual lock or journal surgery.

The journal is shared by worktrees of the same Git repository, under
`git-common-dir/router-development-collector-v1.1/`. Each `approvalId` has a
registration witness (`.registration.jsonl`), append-only event ledger
(`.jsonl`), and exclusive active lock (`.lock`). These are local operational
artifacts outside the worktree, not tracked benchmark source files. The
registration binds the approval and manifest and records each ledger event's
sequence and digest. Event hashes, ordering, duplicates, missing terminal
records, and a ledger rolled back behind its registration witness are checked
on replay. Writes loop over partial writes and call file `fsync` before
dispatch. This is not a central ledger, a power-loss guarantee, or protection
against an administrator deleting both files or using a separate clone.

The lock is removed by the running process on ordinary exit from its locked
operation. An already-existing lock is refused without age-based recovery.
After a normal restart, completed or attempted rows are not called again; only
unattempted rows can continue if the journal is unambiguous and time/budget
remain. The run deadline starts at the first journal header's `startedAt`, not
each restart. All dispatch intents continue to count against the budget.

`unknown`, `timeout`, `measurement_unsupported`, an intent without a terminal,
or an observed token-cost estimate over its reservation stops further calls.
Missing usage alone remains nullable metadata, not a fabricated transport
failure. The report retains every original plan row as a refusal, `not_run`,
or its acquisition outcome.

Known raw-token violations are checked independently of whether a complete
cost estimate is available. An observed input total, or the lower bound formed
by known disjoint input partitions, above the frozen catalogue-context
assumption stops further dispatch and resume. The same applies to observed
output or reasoning tokens above the frozen output cap. Unknown partitions
remain `null`; using known parts to detect a lower-bound violation does not
fill in an observed total. Such a breach also blocks export. It is evidence
that a reservation assumption failed, not proof of an actual invoice overrun
or permission to raise the cap, refund the reservation, or retry the row.
The exact stop reason is `observed_token_bound_exceeded`. The terminal retains
the existing answer and raw allowlisted observations, keeps the reservation,
and records its token-cost estimate as `null`; even a very large valid token
count cannot overflow cost arithmetic before that evidence is recorded.

A durably recorded SDK deadline timeout is different from a crash with no
terminal. It is a known client execution outcome and can be exported as v1
`timeout`; it is not confirmation of provider cancellation or zero billing.
Its reservation stays committed and its row cannot retry. The run and any
resume stop with `request_timeout`; remaining unattempted rows do not continue
under that approval. Export allows this specific stop reason while still
refusing crash-unknown and unsupported measurements.
`completeResponse: false` describes the missing complete HTTP response, not
the absence of a durable local terminal record.

## Data retention and byte limits

The implementation reuses the existing product client rather than introducing
a new network transport. Consequently there is no hard network-ingress or
in-memory response byte cap. Response-size checks after SDK completion can
limit what is persisted, but cannot undo bytes already received or allocated.
The v1 export/grader input limit is a separate boundary, not a transport
limit. An answer can be collected yet not be exportable to v1.

Current limits are 1,048,576 UTF-8 bytes for persisted answer text, 7,340,032
bytes per journal event, and 536,870,912 bytes for the journal. Above the answer
storage limit, text is omitted but its byte count and SHA-256 digest remain;
the outcome is `measurement_unsupported`, not a wrong answer. v1 accepts at
most 65,536 answer bytes and a 16,777,216-byte results document. A stored answer
between the two answer limits therefore still blocks v1 export.

Do not persist raw reasoning, request/response bodies, HTTP headers, provider
error payloads, credentials, or environment dumps. Retain only the defined
answer and allowlisted acquisition metadata. Safe diagnostic codes are not
the provider's raw error text. The adapter explicitly requests SDK 7 response
bodies in memory to inspect provider-origin usage/identity fields, then
retains only the allowlisted observation, not the body. It does not substitute
SDK-normalized usage or generated IDs for missing provider observations.
Request bodies are not opted into SDK result metadata. None of this is a
network or memory sandbox.

Provider-body measurement supports only the eight provider identifiers in
`COLLECTION_SUPPORTED_PROVIDERS`, grouped by the implemented response parser:

- `openai`: Responses-style body.
- `deepseek`, `xai`, `mistral`, `moonshot`: Chat Completions-style body.
- `anthropic`, `minimax`: Messages-style body.
- `google`: `usageMetadata` and candidate fields.

This is parser coverage, not approval of every API or model offered by those
providers. `groq`, `qwen`, `zhipu`, `perplexity`, and any other unlisted provider
are explicitly refused with `collector_provider_family_unsupported` during
selected-manifest construction, before pricing, and at dispatch before SDK
imports or model/settings/generation calls. Adding a catalogue context window
does not grant measurement support. The full v1 population remains intact;
this extra collector gate does not rewrite static eligibility or remove rows.
An unsupported provider's observation retains `source: "unavailable"`, null
metrics/tier and `unsupportedBilling: true`. For otherwise valid, storable
returned text, the outcome is `measurement_unsupported` with
`provider_family_unsupported`, not a successful measurement with invented zero
usage. Such a terminal blocks the whole export.

`servedProcessingTier` records an allowlisted provider response field or
`null`. A reported non-standard/default tier such as priority, flex, or batch
marks billing unsupported and stops acquisition. A reported `auto` stays
`auto`; missing stays `null`. Neither is filled in as verified standard
processing, and neither authenticates the eventual invoice. Reading this
field does not send a processing-tier selector or alter the product policy.

The adapter reuses `getActiveAiModel` and `getModelGenerationSettings`, checks
the generation settings against the manifest, supplies only the prompt and
model-specific output cap, disables retries with `maxRetries: 0`, and passes
the remaining request/run deadline as an abort signal. There are no search
tools, tool executors, fallbacks, or explicit processing-tier overrides.
Additional or unmeasurable paid steps are unsupported, not silently accepted
as one measured answer. Provider client imports are deferred until dispatch.

## Manifest and approval records

The schema version is `router-development-collector-v1.1`. A manifest stays
`status: "proposal"`; approving it does not rewrite that file. Its digest
binds the complete v1 `plan`, `collectorSource`, `selectedRowIds`, per-call
`pricing`/`reserve`/`settings`, `limits`, `assumptions`, and summary fields.
Source, catalogue, pricing, input, and generation-setting drift cannot be
accepted by editing a saved digest. Execution rejects dirty source snapshots.

`limits` contains exactly `maxTotalMicroUsd`, `maxRequestMicroUsd`, `maxCalls`,
`requestTimeoutMs`, `runTimeoutMs`, and `expiresAt`. The first five are positive
safe integers. `maxRequestMicroUsd` cannot exceed `maxTotalMicroUsd`;
`maxCalls` is at most 1,008, request timeout at most 3,600,000 milliseconds, and
run timeout at most 86,400,000 milliseconds. These validation maxima are not
recommended or already-approved budget values.

The separate approval contains exactly `schemaVersion`, `status`,
`approvalId`, `manifestDigest`, `approvedBy`, `approvedAt`, `expiresAt`, and
`acknowledgements`. Required status is `approved`. The ID is 1-64 lowercase
letters/digits/hyphens, starting with a letter or digit. The manifest digest
must match exactly; expiry must equal the manifest's expiry. Approval must be
no earlier than manifest creation, not in the future, and before expiry. Copy the exact
`assumptions` array into `acknowledgements` only after the responsible person
has actually accepted those assumptions; do not synthesize their identity,
time, or consent. File/schema validation is not signature authentication.
The CLI does not generate an approval.

## Export and scoring boundary

Export replays the same registered journal under a lock and validates its
approval binding. An expired approval may be used for exporting existing
records, never for new execution; its original identity and time checks still
apply. Crash-unknown, unsupported, incomplete returned answers, or oversized
attempted rows block the whole export. Export does not drop those rows to
improve a score. The explicit exception is a durably recorded deadline timeout:
it exports as a timeout outcome with null answer, not as a wrong answer or an
invented complete response.

Eligible returned answers become v1 `succeeded` rows, including blank or wrong
answers that the existing grader must judge. Complete provider HTTP failures
become v1 `failed` rows, with safe failure codes. `providerCostUsd` remains
`null`, not the reservation or frozen-rate estimate. Exported origin is
`externally-saved` with a journal-bound, self-reported provenance statement;
neither local hashes nor provider-response labels authenticate provider
billing. Unattempted rows are absent from the results file but remain in the
full plan and the scorer's missing-row/coverage accounting.

## Operating interface

Run these on the operator's local Windows PC in PowerShell, at the repository
root shown below. Prerequisites are Git, Node.js 22, and dependencies installed
with this checkout's lockfile using the repository setup workflow. The npm
script supplies the `react-server` condition and TypeScript loader. Do not
run this from a production container or substitute production credentials.

Help, preview, export, and the offline tests need no provider credentials.
Only explicitly approved execution needs credentials for its selected
providers, inherited from the process environment through
[`resolveProviderApiKey`](../../../lib/modelRegistryShared.ts). The CLI does
not load a dotenv file. Use the existing approved secret-loading process;
never paste keys into command lines, manifests, approvals, journals, or this
document. Product `CHAT_MODEL_*` price/cache-price/output/reservation overrides
are rejected, including differently cased environment-variable names.

| Mode | Provider calls | Filesystem effects |
| --- | --- | --- |
| `--help` alone | None | Prints help; no collector state or output file. |
| `preview` (default) | None | Reads local snapshots; prints JSON, or creates the requested new output file. No registration, ledger, or lock. |
| `execute` with approval and `--live` | Possible, after admission | Creates/extends registration and ledger in Git common-dir; holds the approval lock; prints a report or creates the requested output file. |
| `export` | None | Reads registered records under a temporary lock; can create the state directory while checking; prints v1 results or creates the requested output file. |

All value flags use `--key=value`. Duplicate/unknown flags and mode-incompatible
flags fail. `--help` must stand alone; `--live` is required only for `execute`
and forbidden elsewhere. `--output` never overwrites, requires an existing
parent directory, and cannot point inside Git common-dir. Default output is
stdout. Relative input/output paths resolve from the collector process's
working directory. For the documented `npm run benchmark:router:collect --`
invocation, npm runs the script from the package root, even when invoked from
a checkout subdirectory. A direct Node invocation instead uses that process's
working directory, normally the invoking shell's directory. The collector does
not use npm's `INIT_CWD`; source paths remain fixed to the checkout containing
the CLI. The examples below use absolute paths to avoid this distinction.

### 1. Inspect the complete population without authorization or calls

```powershell
Set-Location -LiteralPath 'H:/Project/tomverse-router-collector-v1-1-20260910'
npm run benchmark:router:collect -- --help
npm run benchmark:router:collect -- --mode=preview --plan=Pro
```

The no-budget preview returns the full v1 plan, `collectionManifest: null`,
`approval: null`, required proposal flags, and assumptions. It does not select
rows or create an executable manifest. `--plan` accepts `Guest`, `Free`, `Pro`,
or `Max` (default `Pro`); `--requested-model` optionally selects the existing
product diagnostic's requested-model ID. These two flags are preview-only,
not execution overrides. A dirty snapshot is inspectable but not executable.

### 2. Prepare a proposal, then obtain separate approval

First finish validation and review, commit the intended source, and create
the proposal from that clean snapshot. Later source commits also change its
binding; do not use a draft-tree proposal as final execution authorization.
Inspect the full plan and choose exact eligible `rowId` values. The following
prompts collect proposal values; they do not record human spending approval.
Choose a new task-specific artifact directory and do not reuse filenames.

```powershell
$collectorArtifacts = 'H:/Project/router-collector-v1-1-local-artifacts'
New-Item -ItemType Directory -Path $collectorArtifacts
$collectorRows = Read-Host 'Exact comma-separated eligible rowIds for the proposal'
$collectorTotal = Read-Host 'Proposed total limit in integer micro-USD'
$collectorRequest = Read-Host 'Proposed per-request limit in integer micro-USD'
$collectorCalls = Read-Host 'Proposed maximum call count'
$collectorRequestMs = Read-Host 'Proposed request timeout in milliseconds'
$collectorRunMs = Read-Host 'Proposed total run timeout in milliseconds'
$collectorExpiry = Read-Host 'Proposed expiry as a UTC ISO timestamp'
$collectorProposalArgs = @(
  '--mode=preview'
  '--plan=Pro'
  "--rows=$collectorRows"
  "--max-total-microusd=$collectorTotal"
  "--max-request-microusd=$collectorRequest"
  "--max-calls=$collectorCalls"
  "--request-timeout-ms=$collectorRequestMs"
  "--run-timeout-ms=$collectorRunMs"
  "--expires-at=$collectorExpiry"
  "--output=$collectorArtifacts/manifest.json"
)
npm run benchmark:router:collect -- @collectorProposalArgs
```

All seven row/limit/expiry proposal flags must be present together. Inspect
the written manifest, its full digest, source and catalogue bindings, selected
rows, reservation amount, assumptions, and `completionPossibleWithinLimits`.
Have the responsible person separately approve those exact values and supply
the approval record described above as `approval.json` in the artifact
directory. No approval JSON is generated by these examples. The approval
file is evidence of an authorization decision, not a way to manufacture one.

### 3. Execute only after the separate live-run authorization

This is a future authorized operating command, **not an instruction to run it
as part of implementing or reviewing v1.1**. It can incur provider charges and
write durable local operational state. Both files must already exist, source
must still match, credentials must be loaded safely, and approval must still
be valid. Do not add plan/model/budget overrides or retry flags.

```powershell
npm run benchmark:router:collect -- --mode=execute "--manifest=$collectorArtifacts/manifest.json" "--approval=$collectorArtifacts/approval.json" --live "--output=$collectorArtifacts/run.json"
```

Inspect `stopReason`, `dispatchIntents`, `terminalRecords`, `unknownRows`, the
full row dispositions, committed reservation, and the reported state location.
A saved report is not the ledger. If output writing fails after calls, charges
and durable intents do not disappear. Investigate the existing journal rather
than creating a new approval ID or clearing state to repeat calls. A later
legitimate resume must use the same manifest and approval and a new report
filename; it cannot retry an already attempted row or bypass a hold/deadline.

### 4. Export existing unambiguous records; score separately

This command makes no provider calls. It still acquires the shared local lock
and creates a new results file. It does not repair uncertain records or grant
additional execution time.

```powershell
npm run benchmark:router:collect -- --mode=export "--manifest=$collectorArtifacts/manifest.json" "--approval=$collectorArtifacts/approval.json" "--output=$collectorArtifacts/answers.json"
```

Use the existing v1 scoring workflow with the exact embedded `manifest.plan`
saved as its separate plan artifact and these exported answers. The collector
manifest wrapper itself is not a v1 plan file. Do not regenerate a fresh plan
with a new timestamp or edit its digest to make saved answers match. The
[v1 scoring instructions](README.md) specify `--plan-file` and `--answers`.

## Offline verification and observed status

The local help command and a no-budget preview were observed to exit 0 on
2026-09-10 while this implementation was still a dirty development tree.
That preview reported 1,008 catalogue rows, 360 planned calls, 648 refusals,
and null manifest/approval. It was stdout-only: no provider request, paid
answer, approval, or collector run was created. This is a development smoke
observation, not evidence for a final committed execution manifest.

The following package scripts are offline verification commands. Tests use
mock/injected providers and temporary local files, not paid model calls.
Run from the same local repository root; no credentials are needed.

```powershell
npm run test:router-development-collector
npm run test:router-development-benchmark
npm run check:encoding
npm run check:doc-references
npm run check:policy-section-references
```

Record the exact source commit, commands, actual results, and remaining gaps
when verification finishes. Listing these commands does not assert that this
document's author ran the suites or that independent Claude review passed.

## Evidence and references

- [v1 benchmark scope, plan, result and scoring contract](README.md).
- [Router evaluation procedure, sections 6-9](../tomverse-chat-router-evaluation-set.md):
  checkable correctness, development/decision separation, candidate sourcing,
  and evidence requirements.
- [Product client](../../../lib/activeAiModel.ts) and
  [generation compatibility](../../../lib/modelGenerationCompatibility.ts):
  existing client and provider-specific settings, not a new dispatch policy.
- [AI SDK request settings](https://ai-sdk.dev/docs/ai-sdk-core/settings):
  `maxRetries: 0` disables retries; abort and timeout controls are client request
  controls. They do not certify that a provider stopped billing.
- [AI SDK generateText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text):
  token usage fields may be undefined.
- [AI SDK 7 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0):
  request and response bodies are excluded from results by default.
- [npm run documentation](https://docs.npmjs.com/cli/commands/npm-run):
  `--` separates npm arguments from the package script's arguments.

Official SDK documentation was checked through Context7 on 2026-09-10.
Documentation lookup and offline tests are not provider model invocations.
