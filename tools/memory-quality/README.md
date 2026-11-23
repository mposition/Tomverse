# MEMORY-01 quality improvement agent

Runnable local quality loop: development failure analysis -> prompt candidate ->
evaluation -> incumbent comparison -> case regression check -> frozen candidate ->
independent synthetic validation -> recorded recommendation.

The quality-loop commands (`run`) support mock and archived-response replay. They have
no live flag, scheduler, product database access, user Memory collector, publication
or promotion command. The only paid path in this tool is the opt-in `--live` of the
two semantic retrieval comparisons below.
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
Retrieval in the quality loop is an offline candidate LLM selection experiment
over the supplied synthetic pool, not a change to the product retrieval service.

## Product retrieval Recall@5 (MEMORY-01)

`top5` and `fullSelectedSet` separately report recall, relevance-gated irrelevant
inclusion and forbidden/inactive gold counts. Core, pinned and style context is
counted separately from question-answer evidence. The pool is synthetic and
does not exercise DB eligibility or the write validator; a forbidden synthetic
row selected here is not evidence of a product storage success or data leak.
`answerQuality.status` stays `not_run` until an answer model is actually evaluated.
The 16 bilingual P0 input fixtures also record answer criteria and the bounded
middle-query limitation without inventing semantic pass results.

`retrieval` measures what the product actually ships: statements indexed with
`memoryRetrievalTerms` and ranked by `selectMemoryContext`, the scorer the chat
context builder uses. It makes no model call and writes no files.

```powershell
node --import tsx tools/memory-quality/cli.ts retrieval
node --import tsx tools/memory-quality/cli.ts retrieval --corpus all
```

- Recall@5 is read off the prompt order, where core and pinned memories come
  first and style last, exactly as injected. `koreanRecallInjected` counts
  everything the prompt would carry (up to the 24-item budget).
- `gatedIrrelevantRate` counts only term-matched memories; core and style are
  never relevance-gated, so `summary.irrelevantInjectionRate` includes them.
- Only active rows reach the scorer, as in `retrieveMemoryContext`. Forbidden
  gold stays in the synthetic pool and is never passed into the product selector.
  This does not simulate write validation or database eligibility.
- `fixtures/retrieval-ko.json` is a synthetic Korean set built on one account
  pool, tagged by failure mode (particle, one_syllable, spacing, ending,
  compound, synonym, nfd, mixed_script, core, abstain). Its overall number
  follows its composition; `byTag` is the informative part. The development and
  validation corpora carry no memory kinds, so they report `poolKinds: defaulted`
  and treat every row as relevance-gated.

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

## Semantic retrieval comparison (Cohere Rerank / Embed)

Before the `retrieval.cohere.*` switches (policy
`docs/policy/external-conversation-import-and-memory.md` section 9a) are turned on,
these two commands answer "does it beat lexical retrieval on the same data". Both
run the product's own pure selectors; only the source of the scores differs. Both
are operator tools: they do not use the product budget bucket, switches or cache,
and they write no product data.

Use the local PC, PowerShell, from the root of the worktree. Prerequisite: repository
Node dependencies installed. Saved-score runs need no credentials and no network.

### Memory: `retrieval --semantic`

New saved scores bind corpus, normalized query/candidate hashes, candidate IDs,
model, collection time, query/selection versions and settings in `provenance`.
`scoreEvidence` distinguishes provider, mock, oracle and unverified legacy files.
Mismatch is rejected; incomplete score maps fall back to lexical and are reported
in coverage. Neither mock scores nor transport tests establish measured semantic
retrieval or generated-answer accuracy. The default `current-query` mode reproduces
the legacy head/tail query. `full-query` preserves the whole current query and
`full-query+history` adds up to two synthetic previous user bodies. Knowledge query
behavior and the two-pool candidate budget are unchanged.

The `relevance` corpus separates project omission/switching/correction, long-query
middle conditions, irrelevant history, absent candidates, and assistant-only
references outside this implementation's scope. User bodies may contain copied
Review or external text; this scope does not classify or remove that material.

Measures lexical `selectMemoryContext` and, beside it, the same function given
`externalRelevance` scores (the section 9a rerank path). The reranked set is what the
service sends: the active memories `memoryTier` relevance-gates (core, pinned and
style memories are never sent or moved), at most 100 using the shared two-pool
budget. This small pool does not exercise the DB400 cap or database read filters.

```powershell
node --import tsx tools/memory-quality/cli.ts retrieval --semantic --rerank-scores <scores.json>
node --import tsx tools/memory-quality/cli.ts retrieval --semantic --corpus all --rerank-scores <scores.json>
node --import tsx tools/memory-quality/cli.ts retrieval --semantic --corpus relevance --query-mode full-query+history --rerank-scores <scores.json>
```

Output (`semantic.<corpus>`): lexical and semantic Korean Recall@5 and irrelevant
injection rates, the delta, a per-tag table (`byTag.<tag>.lexical|semantic|delta`),
per-case `differences` (gold memories gained or lost, with both top-5 lists) and
`coverage`. A case with no entry in the scores file keeps its lexical selection, like a
failed provider call, and is listed under `casesFallingBackToLexical`.
New full-query score files bind the effective query, mode, normalized current query,
actual included history, corpus and ordered candidate digests. A provider result
from a different mode or history cannot be reused. Full-query live inputs use the
same model-limit preparation and unbounded Memory wire policy as the product;
their configured rerank billing unit is required and recorded. Unsupported model
or billing contracts stop before dispatch. These tools still have their own
explicit call budget and do not enable a product flag or product privacy gate.

Scores file: `{ "<caseId>": { "<memoryId>": <score 0..1> } }`, or the wrapped form
`--save-scores` writes (`format: "memory-rerank-scores-v1"`, `scores`, `usage`).

### Knowledge files: `knowledge-retrieval`

Synthetic corpus `fixtures/knowledge-retrieval-ko.json`: six fictional documents, 46
paragraph-sized chunks, 27 questions, tagged `exact`, `synonym` (different wording),
`cross_language` (Korean question, English document) and `distractor` (words overlap
with chunks that are not the answer; `distractorChunkIds` names them). Chunks are
indexed with `memoryRetrievalTerms` at the chunker's term cap, as stored chunks are,
and are shorter than production chunks so the token budget rarely binds; the chunk
and per-file caps are the product's.

```powershell
node --import tsx tools/memory-quality/cli.ts knowledge-retrieval
node --import tsx tools/memory-quality/cli.ts knowledge-retrieval --scores <scores.json>
```

Four configurations, each as `retrieveKnowledgeContext` would run it with those steps
on: `lexical` (`selectKnowledgeContext`), `embedOnly` (nearest chunks added to the
candidates, `fuseKnowledgeScores`), `rerankOnly` (lexical candidates, then
`selectKnowledgeContextRanked`) and `embedRerank` (both). Each reports Recall@6 (the
product `maxChunks`), MRR over the selected chunks in rank order, the average number
of chunks injected, how many `distractorChunkIds` were injected, and the same by tag.
`differences` lists gold chunks gained or lost against lexical; `stepFallbacks` lists
questions where a switched-on step had no vector, score or neighbour above the floor.
Without `--scores` only `lexical` is available and the others say why.

Scores file (`format: "knowledge-retrieval-scores-v1"`, `corpus` must equal the
corpus version): `chunkVectors` and `queryVectors` (int8 vectors, base64, by chunk id
and case id) and `rerank` (`{ "<caseId>": { "<chunkId>": <score> } }`). Rerank scores
are read per question and chunk, so one set serves both `rerankOnly` (its lexical
subset) and `embedRerank`, on the assumption that a pair's score does not depend on
the other documents in the request.

### `--live` (paid)

`--live` sends the corpus text and questions to the provider (Cohere) and **costs
money**. Run it only when the owner has approved the spend; this tool does not
decide that. It runs only when all of these hold, each checked before the first
request:

- `--max-calls <n>` is given and positive (absent or 0 is refused). The run is also
  refused if its planned request count exceeds `n` (`live.planned` is the upper
  bound: memory is one rerank per case; knowledge is the embed batches plus one
  rerank per question), and the meter stops before any request past `n`.
- Environment variables are set: `COHERE_API_KEY`, `COHERE_RERANK_MODEL`, and for
  knowledge `COHERE_EMBED_MODEL` (optional `COHERE_EMBED_DIMENSION`). Values are never
  printed or written; set them for the session only (for example `$env:COHERE_API_KEY`
  from the secret store) and do not paste them into chat or a file.
- `--save-scores <new file>` names a file that does not exist. It is created
  exclusively and never overwritten, also after a failed or interrupted run: a failed
  request ends the run (one request each, never retried, since an unknown outcome could
  be billed twice) and what was already paid for is saved with `complete: false`.
- The run uses `node --conditions=react-server`, because the provider client is a
  `server-only` module. Without it `--live` stops with `live_client_unavailable` before
  any request; the offline commands do not need the condition.

```powershell
$env:COHERE_API_KEY = "<from the secret store>"
$env:COHERE_RERANK_MODEL = "<rerank model id>"
$env:COHERE_EMBED_MODEL = "<embed model id>"
node --conditions=react-server --import tsx tools/memory-quality/cli.ts retrieval --semantic --live --max-calls 40 --save-scores .tmp/memory-rerank-scores.json
node --conditions=react-server --import tsx tools/memory-quality/cli.ts knowledge-retrieval --live --max-calls 30 --save-scores .tmp/knowledge-scores.json
```

`--live` for memory takes one corpus (not `all`). The output carries `live.calls`,
`live.searchUnits` (sum of `billed_units.search_units`; `searchUnitsUnreported` counts
responses that did not report it) and `live.embedInputTokens`; the request body is the
product's `rerankRequestBody` / `embedRequestBody`. Re-run any comparison for free from
the saved file with `--rerank-scores` / `--scores`. The results are synthetic-corpus
measurements, not decision grade (`decisionGrade: false`).

## Follow-up Memory evaluation (`followup-eval`)

Measures whether a follow-up question in web Chat gets the right account memory
and, once answers exist, whether the answer follows the latest correction and keeps
projects apart. Local PC, PowerShell, quality worktree root; no credentials, no
network, no provider call:

```powershell
node --conditions=react-server --import tsx tools/memory-quality/cli.ts followup-eval --out .tmp/memory-quality/followup-dev
node --conditions=react-server --import tsx tools/memory-quality/cli.ts followup-eval --inputs <inputs.json> --key <key.json> --out <directory> `
  [--scores-full-query <json>] [--scores-full-query-history <json>] [--answers <json>] [--verdicts <json>]
```

- **Inputs and key are separate files** (`memory-followup-inputs-v1`, `memory-followup-key-v1`).
  Inputs hold scenarios, variants, original language, role-ordered conversation, the
  current query and the account pool. The key holds phenomena, expected behaviour
  (answer, compare, clarify, insufficient), where the needed fact lives (`memory_only`,
  `history_only`, `both`, `unavailable`), gold and distractor memory IDs, required,
  acceptable and forbidden facts. Without arguments the development fixture
  `fixtures/followup-dev.*.json` runs; it is for plumbing and tests only. Keep a real
  holdout's text and key out of this repository.
- **Conditions.** `lexical` always runs. `full-query` and `full-query+history` replay a
  saved `memory-rerank-scores-v1` file through `compareMemory` (same provenance checks,
  `corpus` = bundle ID); without a file they are `not_run`, and a refused file is
  recorded with its reason. `full-query+history` applies the product's current-query
  displacement fallback. Search history is the last two user messages; the answer
  messages keep the whole conversation, assistant turns included. `no-memory` sends
  the same conversation with no memory block.
- **Messages.** `answer-requests.json` holds, per case and condition, exactly what the
  chat route would send for that selection: `buildMemoryContextPrompt` rules through
  `buildProfileSystemPrompt` as system, memory data as user (`buildChatTurnPrelude`),
  then the conversation and the current query. Profile, knowledge, capability, date
  and attachment blocks are left out identically for every condition. No key data
  reaches these messages.
- **Answers** (`memory-followup-answers-v1`) are accepted only when the bundle's
  `evalDigest` (inputs, key and annotation version), the case, condition, completed
  messages digest and prompt version match; one generator (model and settings) per
  file. Only `generator.kind: provider` answers on measured retrieval count.
- **Blind judging.** `blind-sheet.md`/`.json` shows the conversation, account memories,
  key and anonymised answers (equal answers share a label); condition names, model,
  ranks and IDs stay in `blind-map.json`. Fill `verdicts.template.json`
  (`memory-followup-verdicts-v1`, with evidence for every verdict) and pass it with
  `--verdicts`; it binds to `sheetDigest`, so a changed key or answer set refuses it.
  Condition-level answer metrics appear only after that.
- **Report.** `report.json` and `report.md`: per-condition retrieval (gold in rerank
  candidates, top 5 and full recall, irrelevant general injection, distractor
  injection, correct empty selection, history fallbacks), answer metrics, overall,
  by language and by phenomenon, with numerators and denominators, `N/A` for zero
  denominators, and same-case pairs (both right, one side only, both wrong) that skip
  any case missing a measured side. `answerQuality` is `not_run` without measured
  answers and `unjudged` without verdicts. Variants are reported next to the number
  of independent scenarios; `decisionGrade` needs an independently authored,
  separately reviewed bundle frozen before results.
- **Collecting the score files (PAID).** `followup-scores` sends one Cohere rerank
  request per case that has relevant candidates, with the same query plan, corpus name
  and provenance `followup-eval` checks on replay. It shares the `--live` rules below:
  `COHERE_API_KEY`, `COHERE_RERANK_MODEL` and the billing variables, an explicit
  `--max-calls` at or above the plan (refused before the first request otherwise), and
  a new `--save-scores` file written after every request. Run it once per query mode:

  ```powershell
  node --conditions=react-server --import tsx tools/memory-quality/cli.ts followup-scores --inputs <inputs.json> --key <key.json> `
    --query-mode full-query --live --max-calls <n> --save-scores <new-fq.json>
  node --conditions=react-server --import tsx tools/memory-quality/cli.ts followup-scores --inputs <inputs.json> --key <key.json> `
    --query-mode full-query+history --live --max-calls <n> --save-scores <new-fqh.json>
  ```

  A run stopped by a provider failure prints `failure` (`rate_limited`, `unauthorized`,
  ...) and keeps what was paid for with `complete: false`. `--resume-scores <partial>`
  reuses those cases when corpus, model, digest and each request identity match, and
  requests only the rest; `--min-interval-ms` spaces requests for rate-limited keys.
- **Generating the answers (PAID).** `followup-answers` sends each distinct message list
  in `answer-requests.json` once to the product's default Chat model (`gpt-6-luna`, the
  product's generation settings, the chat route's system-to-instructions split, 4,096
  output tokens, no retry) and writes the answers file `followup-eval --answers` imports.
  It needs `OPENAI_API_KEY`, `--max-calls` and `--max-usd` at or above the plan's worst
  case (every character a token plus the full output allowance), checked before the
  first request; a failed call is charged at its worst case. `--resume-answers` continues
  an interrupted file. Answers stay unread until the blind verdicts are frozen.

  ```powershell
  node --conditions=react-server --import tsx tools/memory-quality/cli.ts followup-answers --requests <answer-requests.json> `
    --live --max-calls <n> --max-usd <usd> --save-answers <new-answers.json>
  ```

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

Validation must independently improve with no regression before a human-review
recommendation; a tie is recorded as `validation_no_improvement`.
Validation is evaluated only after candidate selection is frozen. Its outcomes
never return to the proposal task, and a validation rejection ends the run.
Repeated development runs on these known fixtures cannot substitute for a fresh,
sealed independent dataset for later measured-quality claims.

## Existing provider and budget integration

`existingProviderPort` accepts a per-call factory for the existing
`createExtractionProviderAdapter`, constructed with the current abort signal, and an already configured
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
   retains the full reservation after dispatch, and latches unknown reservation,
   dispatch or settlement outcomes without repeating those writes.
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
node --conditions=react-server --import tsx --test tests/memoryQualitySemantic.test.mjs
node --conditions=react-server --import tsx --test tests/memoryQualityFollowupEval.test.mjs
```

`tests/memoryQualitySemantic.test.mjs` covers the two semantic comparisons: saved-score
reproduction, tag deltas and lost cases, the `--live` refusals (no ceiling, missing
environment, existing save file, ceiling below plan), metering, no retry, exclusive
saving and the key staying out of output. Its `--live` runs use a fake `fetch`; nothing
in the test reaches a network. It runs with the unit suite.

The CLI regression runs the complete loop with socket/fetch access disabled,
checks persisted candidates/results and replays it to the identical recommendation.
Tests also cover label/paraphrase defects, true direction reversals, unrelated
same-source facts, zero-gold safety, evidence failures, duplicates, data leakage,
criteria tampering, validation regression, malformed outputs, stop/timeout,
cost caps, unknown dispatch retention and disabled paid execution.
