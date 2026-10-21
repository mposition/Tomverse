# MEMORY-01 quality improvement agent

Runnable local quality loop: development failure analysis -> prompt candidate ->
evaluation -> incumbent comparison -> case regression check -> frozen candidate ->
independent synthetic validation -> recorded recommendation.

The CLI supports mock and archived-response replay. It has no live flag, scheduler,
product database access, user Memory collector, publication or promotion command.
The existing extraction register and feature flags are untouched: v8 remains
revoked and there are zero approved extraction pairs.

## Run and inspect

Use the local PC, PowerShell, from the root of the dedicated quality worktree.
Prerequisite: repository Node dependencies installed. Production credentials are
not required. Runs write only local output files; inspection reads them.
There is no package.json script for this standalone tool.

```powershell
node --import tsx tools/memory-quality/cli.ts run --mode mock
node --import tsx tools/memory-quality/cli.ts list
node --import tsx tools/memory-quality/cli.ts show --run <run-id>
node --import tsx tools/memory-quality/cli.ts stop --run <unfinished-run-id>
```

The default output directory is `.tmp/memory-quality` (Git ignored).
Use `--out <directory>` consistently to change it. Run options:
`--iterations 3 --max-calls 1000 --timeout-ms 60000`.

- `events.jsonl`: sequential requests, responses, proposals, development
  outcomes, comparisons, validation and terminal reason. All text is synthetic.
- `result.json`: terminal recommendation and stop reason. An unfinished run
  means no terminal result was recorded; it does not prove a process is alive.
- `stop.json`: durable operator stop request. Checked before each call and
  after its response. The run deadline bounds an unresponsive adapter; late
  responses do not become success. Dispatched unknown outcomes are not retried.
- `show` includes candidate prompts, parent ID, development/validation metrics
  and regression reasons. A recommendation never updates the product.

Replay a completed run without another provider request:

```powershell
node --import tsx tools/memory-quality/cli.ts export-replay --run <run-id> --file .tmp/memory-quality-replay.json
node --import tsx tools/memory-quality/cli.ts run --mode replay --responses .tmp/memory-quality-replay.json
```

Exports never overwrite a file. Replay requires exact request digests; a changed
prompt, schema or sample needs a corresponding archived output. Missing outputs
stop the run. Requests are in the local events for offline adapter preparation.

## Evaluator and fixed targets

`memory-quality-semantic-v1` is a new **development** evaluator, not a rewrite of
historical frozen scorers or a retroactive v8 approval. A structured semantic
judge compares propositions, actual direction, subject and scope against user
evidence. Existing factual/style kind groups remain distinct; fine kind and polarity **labels** are diagnostic. Korean inflection,
paraphrase and synonyms do not require hand-written semantic rules.

The deterministic layer validates complete judge coverage, exact user evidence,
one-to-one matching, IDs, lifecycle states and output schemas. Safety examines
every stored candidate independently of matching: unsupported/forbidden bulk
adoption and sensitive-review leaks remain visible even on zero-gold cases.
Extraction uses the existing product parser and validator. Rejected candidates
are not stored; original model outputs remain in synthetic run records for diagnosis.
Retrieval is an offline candidate LLM selection experiment over the supplied
synthetic pool, not a change to the product retrieval service.

Existing extraction gates are reused from the historical evaluation modules:

| Metric | Target |
| --- | --- |
| Extraction precision, Wilson 95% lower bound | >= 0.95 |
| Extraction recall, Wilson 95% lower bound | >= 0.85 |
| Bulk eligibility recall, Wilson 95% lower bound | >= 0.85 |
| Critical bulk adoption and sensitive-review bulk leaks | 0 |
| Korean Recall@5 | >= 0.85 |
| Irrelevant injections / selected memories | <= 0.02 |
| Forbidden injections; deleted/superseded/expired reuse | 0 |

Extraction gates apply to the aggregate and each ko/en arm. Existing sample
adequacy rules (200 durable and 125 critical cases per category/language arm,
subject to their existing validator condition) remain unchanged.

`targetPass` reports these numeric/sample gates, while
`measuredQualityAchieved` and `decisionGrade` remain false for this development
tool. A tiny perfect synthetic run cannot establish the quality targets.
Mock outcomes are scripted, including an intentionally faulty baseline; they
prove orchestration and regression detection, **not** improvement of a real model.
The semantic judge itself still needs independent calibration with approved
model execution or archived real judge outputs before its scores support claims.
No past score is treated as the current model's absolute quality.

## Data isolation and candidate authority

`fixtures/development.json` and `fixtures/validation.json` contain ten synthetic
scenarios each, including Korean/English paraphrase and negation, health review,
withdrawals, roleplay, third-party facts, secrets, directives and abstention.
IDs, scenario families and normalized source duplicates cannot cross splits.
No database or actual-user import path exists. These authored fixtures are not
a sealed decision-grade holdout and are not human-approved gold.

The model receives development failures and can return only analysis plus two
bounded prompt strings: `{ extraction, retrieval }`. It has no files, tools or
criteria mutation API. Source data, gold, rubric and targets are snapshotted;
the instrument ID binds both corpora, rubric, targets, schemas and base prompt
version. A candidate must improve at least one metric, regress on no metric or
case, and meet zero safety counts to become the development incumbent.

Validation is evaluated only after candidate selection is frozen. Its outcomes
never return to the proposal task, and a validation rejection ends the run.
Repeated development runs on these known fixtures cannot substitute for a fresh,
sealed independent dataset for later measured-quality claims.

## Existing provider and budget integration

`existingProviderPort` accepts the adapter built by the existing
`createExtractionProviderAdapter` for extraction and an already configured
structured-output host adapter for analysis, proposals, judging and selection.
It loads no provider SDK, key or database client.

`budgetedProviderPort` is a dormant integration seam and defaults to disabled.
An approved host must supply:

1. Explicit enablement, a run ceiling and already approved provider/model settings.
2. An agent-only, durable, atomic reservation port. Each grant binds the exact
   request digest, conservative full input/output cost and pre-reservation day/
   month provider and sub-budget usage. Agent spending must never use user credits.
3. Durable mark-issued and close hooks in that existing ledger. The adapter
   reuses `decideMemoryExtractionBudget`, shares one run cap across all tasks,
   retains the full reservation after dispatch, and latches unknown outcomes.
4. Provider-enforced output bounds, request cancellation/deadlines, no hidden
   retries and isolated credentials. The host owns real provider construction.

The CLI cannot enable this seam and no live host is installed by this change.
An injected adapter run reports unknown paid-call count rather than claiming
zero. Live execution, new spending or authority, operational installation,
publication, merge and deployment require their separate authorization.

## Product-session interface

No shared product files, routes, UI, schemas, migrations, flags, registered pairs,
credits or audit writers were edited. The product integration session can read
candidate prompt strings and instrument/candidate IDs from run records. Applying
them to extraction or retrieval is a later explicit action; this agent never
writes a product configuration. Conflict handling, Review UI/API and answer-linked
feedback remain owned by that session.

## Verify

Local PC, PowerShell, quality worktree root. No production credentials or network
are required. Tests use synthetic data and temporary local files.

```powershell
node --import tsx --test tests/memoryQualityEvaluator.test.mjs tests/memoryQualityRunner.test.mjs tests/memoryQualityProvider.test.mjs tests/memoryQualityCli.test.mjs
node node_modules/typescript/bin/tsc --project tools/memory-quality/tsconfig.json --noEmit
node node_modules/eslint/bin/eslint.js tools/memory-quality tests/memoryQuality*.test.mjs
```

The CLI regression runs the complete loop with socket/fetch access disabled,
checks persisted candidates/results and replays it to the identical recommendation.
Tests also cover label/paraphrase defects, true direction reversals, unrelated
same-source facts, zero-gold safety, evidence failures, duplicates, data leakage,
criteria tampering, validation regression, malformed outputs, stop/timeout,
cost caps, unknown dispatch retention and disabled paid execution.
