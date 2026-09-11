# Router development benchmark v1

This is an agent-authored synthetic **DEVELOPMENT FIXTURE / CANDIDATE** corpus
and an offline planning and exact-answer scoring tool. Codex drafted these
items for development; no human adoption, independent reviewer verdict or
release decision is recorded here. Its 24 prompts are available for inspection
and tuning. They are not a representative sample of real traffic, a frozen
decision set, or `ROUTE-01` evidence.

The separation follows
[the Router evaluation procedure, §§6–8](../tomverse-chat-router-evaluation-set.md):
check correctness when it is checkable, keep development and decision data
separate, and treat model-drafted items as candidates. This directory does not
modify the existing evaluation sets, answer exchanges, score policy, adoption
records, preregistration, or release registry. There is no model winner,
confidence interval, quality-band update, or product-readiness conclusion.

## Contents and scope

The separate [v2 execution-contract slice](execution-contract-v2.md) validates
condition/observation compatibility and a fixed offline collector-to-Replay
mock. It does not replace this v1 corpus, grader or frozen result format.

- [development-v1.json](development-v1.json): exactly 24 cases, six in each
  language/task cell. Schema `router-development-corpus-v1`, corpus
  `tomverse-router-development-v1`, purpose `development-only`.
- [Corpus answer checks](../../../tests/routerDevelopmentBenchmarkCorpus.test.mjs):
  separately encoded source facts, prompt anchors and task-specific derivations;
  every expected answer is checked without reading the dataset's `expected`
  value to construct the answer. The same agent authored the corpus and these
  checks; separate code paths are not independent human review. Every case has wrong-value, missing-key,
  extra-key, type and formatting checks as applicable.
- [Scoring core](../../../lib/routerDevelopmentBenchmark.ts),
  [planning core](../../../lib/routerDevelopmentBenchmarkPlan.ts), and
  [CLI](../../../scripts/router-development-benchmark.mjs): deterministic
  local operations only.

| Task | Korean | English | Total |
| --- | ---: | ---: | ---: |
| Structured extraction | 6 | 6 | 12 |
| Grounded calculation | 6 | 6 | 12 |
| Total | 12 | 12 | 24 |

All entities and facts are fictional. Prompts contain their complete data and
rules, including conversions and date-comparison rules. No case needs search,
attachments, code execution or external current knowledge. The two language
groups use different records and scenarios; they are not paired translations.
This is not a difficulty calibration between languages. Coding execution,
research, open-ended writing, long-context use and tool quality are outside v1.

## Case inventory and answer rationale

The JSON file contains the full expected objects; the table gives the reason
each answer follows from its prompt. The tests independently reconstruct the
full objects, including exact key names, nulls, booleans and nested values.

| Case | Operation and known answer |
| --- | --- |
| `dev-en-extract-01` | Dispatched AND North Dock selects S-41; fragile is true; labels are glass, then blue. S-42 has another destination and S-43 is queued. |
| `dev-en-extract-02` | The current LAMP-7 record gives Annex/B2, rechargeable false, stand then shade, custodian null. Historical Team Gray is not inherited. |
| `dev-en-extract-03` | Elm alone is both available and step-free; copy 8 seats and whiteboard then speaker. |
| `dev-en-extract-04` | T-18's final event gives paused / Parts / awaitingExternal true / resolution null; T-19's resolution is unrelated. |
| `dev-en-extract-05` | Explicit vegan AND available selects Zest bowl then Bean soup; copy Noon List and the two spaces in `Collect  at hatch`. |
| `dev-en-extract-06` | MAP-3 current v2 gives River Paths, draft false, tags `[]`, reviewer null; old metadata is excluded. |
| `dev-ko-extract-01` | The loan copy of 빛의 지도 is D-8, loanable true, 동관/3번, topics 관측 then 기록; D-9 is a reference copy. |
| `dev-ko-extract-02` | 주말 AND 열림 selects 유리 새 then 나무 배; material flags are true then false in nested objects. |
| `dev-ko-extract-03` | Received G-4 gives 은색/충전식, sealed false, 본체 then 받침대 then 안내지, locker null. G-5 is pending. |
| `dev-ko-extract-04` | Confirmed first broadcasts on 파도 are 저녁 창 at 18:40 then 아침 돌 at 07:30; preserve source order, not time order. |
| `dev-ko-extract-05` | R-2 gives 모형 조각, sealed true, exact two-space label `위  아래`, inspectionDate null. |
| `dev-ko-extract-06` | Issued N-6 gives 작은 전시 / 북쪽 홀 / registrationRequired false / bring `[]` / endDate null; ignore the draft. |
| `dev-en-calc-01` | Available = 18 + 7 − 9 − 2 = 14; removed = 9 + 2 = 11. |
| `dev-en-calc-02` | Paid, uncancelled O-7 then O-4: count 2, total = 4 × 8 + 3 × 5 = 47 tokens. |
| `dev-en-calc-03` | Unmarked = 40 − 15 = 25; marked = 15/40 × 100 = 37.5%; unmarked = 62.5%. |
| `dev-en-calc-04` | Combined = 2000 + 350 + 750 = 3100 g; remaining = 2500 g = 2.5 kg. |
| `dev-en-calc-05` | 10:05 − 09:10 = 605 − 550 = 55 minutes; minus 10-minute break = 45 minutes = 0.75 hours. |
| `dev-en-calc-06` | Open and due on/before 2026-04-10 selects J-4 then J-8, including equality: count 2, units 3 + 4 = 7. |
| `dev-ko-calc-01` | Initially packed = 4 × 6 = 24; shippable = 24 − 3 + 5 = 26. |
| `dev-ko-calc-02` | Visitors = 7 + 5 + 2 = 14; paying = 12; tokens = 7 × 3 + 5 × 8 = 61. |
| `dev-ko-calc-03` | Discount = 12000 × 12.5/100 = 1500; item = 10500; add undiscounted 500 packaging points to get 11000. |
| `dev-ko-calc-04` | Combined = 1.2 × 100 + 85 + 350/10 = 240 cm; remaining = 200 cm = 2 m. |
| `dev-ko-calc-05` | Approval order gives Q-3, Q-7, Q-1; 3 unique admissions from 4 approvals, 1 duplicate approval, 2 rejected scans. |
| `dev-ko-calc-06` | Inclusive 2026-06-03 through 2026-06-08 and no return selects B-6 then B-9: count 2, units 5 + 2 = 7. |

## Correctness contract

Every prompt requests exactly one JSON object with specified keys and types,
without commentary or code fences. `exact-json` checks the actual semantic
answer, not merely schema compliance. The grader version is
`router-development-exact-json-v1`.

- Object key order and JSON formatting whitespace do not matter, including
  at nested levels. Decoded JSON Unicode escapes are equivalent to literal
  characters.
- Arrays are ordered. Prompts state the required source order, including cases
  where alphabetical or time order would produce a different result.
- Strings have **no normalization**: no trimming, case folding, space
  collapsing, or Unicode normalization. Spaces inside strings matter.
- Missing and extra keys fail. `null`, an absent key, `"null"`, `false`, and
  an empty array are distinct values. Numeric and boolean strings fail.
- Numbers are compared as JSON numeric values: `2`, `2.0`, and `2e0` represent
  the same value. These cases require only safe integers and exact finite
  results; there is no rounding tolerance or percentage-string parsing.
- Blank text, invalid JSON, duplicate keys, non-finite/out-of-range numbers,
  fenced JSON and surrounding commentary fail. Parsing is bounded by byte,
  depth and node limits; the model's answer is never evaluated as code.

`modelInputForCase()` emits only `{ prompt }`. Expected answers, grading
metadata, case IDs and corpus identity are not part of model input. The
separate row envelope retains case identity for matching. Possessing the
development answer file does not establish blinded measurement, model
independence or human adoption.

## What planning and scoring mean

`dry-run` builds all case × static-catalogue rows and retains explicit refusal
reasons. It uses the existing product profiler, Router diagnostic, call-limit,
pricing and context-window functions. `row.router` preserves the Router's
original inferred profile, output cap, rank, selection and filtering outcome.
`row.benchmarkEligibility` separately describes static benchmark admission:
it reuses `filterRouterCandidates()` with the validated fixture's declared
requirements and a per-model proposed answer cap. Its basis is explicitly
`declared_fixture_requirements_not_router_inference`. This does not modify
Auto, rerank the Router or implement production dispatch. Disagreement between
the two eligibility results remains visible.

The static catalogue is not a runtime registry read. Plan eligibility does not
verify credits, provider budgets, health, regional/account access, current
registry overrides or execution readiness. Search backends are not assumed
ready; intrinsic-search models are explicitly refused in v1, and the corpus
validator refuses declared search, attachment or tool requirements. Disabled,
plan-ineligible or unsupported-context candidates remain subject to the reused
product candidate filter; missing context declarations and unverified fallback
pricing are also refused. No provider client or request is constructed. There
is no live mode, live answer collection, model judge, coding executor or
network model call.

The plan records source commit and listed source-file digests, dirty status, corpus
and catalogue digests, model/API identities, pricing and context snapshots,
per-row prompt and call-configuration digests, and versioned dependencies.
The saved plan also has its own digest. Offline scoring checks the saved plan
against the same recorded source-file bytes, corpus and resolved planning snapshot;
changed listed source, model identity, configuration or prices are refused rather than
silently substituted. A digest detects mismatch; it does not authenticate a
provider response or certify a human review. The source-file list is explicit;
it is not a complete capture of transitive dependencies or runtime authenticity.

`plannedCalls` counts eligible matrix rows. `completedActualGenerations` and
`incurredProviderSpendUsd` are zero in a dry run because nothing is called.
`plannedTokenCostUsdEstimate` applies the recorded token-price snapshot to a
prompt-only input heuristic and the proposed output cap. It is not a bill,
approved budget, runtime credit limit, or guaranteed maximum: provider
tokenization, prompt wrappers, cache behavior, reasoning and actual execution
can differ. A large cap-based projection is not observed spending.

`score` reads saved answers and checks values locally. Results can be labelled
`synthetic-fixture` or `externally-saved`; the latter is self-reported,
unverified provenance. Neither label changes the exact-answer grading rule.
The score explicitly reports zero provider calls and zero incurred spend by
this tool; it does not claim verified actual generations from an imported row.

Saved-answer schema `router-development-results-v1` has these fields:

| Level | Required contents |
| --- | --- |
| Root | `schemaVersion`, `purpose: "development-only"`, `corpusDigest`, `planDigest`, `origin`, `rows`. |
| Origin | `kind: "synthetic-fixture"` or `"externally-saved"`, plus an accurate `description`. |
| Row identity | `rowId`, `caseId`, `modelId`, `provider`, `apiModel`, `promptDigest`, `callConfigDigest`, matching one eligible planned row. |
| Outcome | `status: "succeeded"`, `"failed"` or `"timeout"`; `answerText`, `answerDigest`, `failureCode`. Success has string text, its SHA-256 digest and null failure code. Failure/timeout has null text/digest and an explicit failure code. |
| Observation | `recordedAt`, `providerResponseId`, `modelVersion`. Unknown provider fields are null; externally saved rows require a recorded-at instant. Synthetic rows require all three to be null. |
| Metrics | `metrics` contains exactly `inputTokens`, `outputTokens`, `latencyMs`, `providerCostUsd`. Each is a measured non-negative number or null when unknown; token counts are integers. All are null for synthetic fixtures. |

Unknown measurements must remain `null`; zero asserts an observed quantity.
The scorer rejects duplicate/unknown rows, answers for refused rows, stale
digests and synthetic fixtures that claim provider observations. A missing
eligible row is `not_run`, not a failed model answer. Failed/timeout, blank,
invalid-JSON and wrong-value rows are separately counted; submitting a wrong
answer does not convert it into an exclusion.

Summaries retain planned, refused, submitted, not-run and passed denominators
overall, per model and per model/task/language cell. `coverage` is submitted
divided by planned. `correctnessRate` stays null until all planned rows in that
group are submitted; `correctShareOfPlanned` can describe observed progress
without treating pending work as a model failure. A fully submitted group's
correctness denominator includes failures/timeouts. Zero planned rows have
null ratios. Do not compare model percentages without their cell coverage;
different eligibility means different populations. Reported metric totals are
null if any submitted row's corresponding metric is unknown, and imported
metric values remain self-reported.

## Known profiler disagreement, preserved for diagnosis

The local development check on 2026-09-10, using `plan=Pro` and the default
requested model, retained 42 catalogue models × 24 cases = 1008 rows. Static
benchmark admission planned 360 rows and refused 648: every case had 15 planned
and 27 refused model rows. Eight closed-book cases were classified by the
existing product profiler as requiring search. The original Router and
benchmark eligibility differed on 80 rows (10 rows for each of those cases).
`summary.routerInferenceMismatchCases`, `summary.routerEligibilityMismatchRows`
and `byCase` expose those differences. The profiler's search classification
disagrees with the prompts' supplied-data contract; it does not establish
that those questions require external information.

| Cases | Observed profiler signal and source |
| --- | --- |
| `dev-en-extract-01`, `02`, `03`, `05`; `dev-en-calc-02`, `06` | `search:source-intent`: the word `source` in the explicit source-order instruction matches `RESEARCH_PATTERN` in `lib/modelFinder.ts`, via `lib/webSearchSuggestion.ts`. |
| `dev-en-extract-06` | `search:recency-heuristic`: `current` labels a supplied publication version. |
| `dev-ko-calc-06` | `search:recency-heuristic`: `오늘` occurs in the explicit instruction not to use today's date. |

The data and Router are left as written. The separate benchmark admission
uses the corpus's validated declared requirements, while retaining the
profiler result for diagnosis. Removing those words from questions would tune
the corpus to the current classifier. Future profiler, catalogue or planning
revisions may change these counts; the saved source/corpus snapshot identifies
the observation. Refusal is a routing/planning observation and is not a model
correctness failure. The grader tests exercise all 24 known answers regardless
of planning eligibility. This snapshot incurred no provider spend or actual
generations.

## Local commands

Run on the local PC in **PowerShell**, inside the Tomverse clone/worktree root
(for this work, `H:\Project\tomverse-router-benchmark-v1-20260910`). Git, Node
22 and dependencies installed with `npm ci` must be available. No production
credentials, provider keys, DB connection, or environment variables are needed.
Do not set `CHAT_MODEL_*` price/cap override variables for this offline run;
the CLI refuses them because v1 records the code pricing snapshot.

Local PC / PowerShell / Tomverse worktree root; prerequisites above. This
command reads local files and prints help, without writing files or calling
providers:

```powershell
npm run benchmark:router -- --help
```

Local PC / PowerShell / Tomverse worktree root; prerequisites above. This
command reads local files and prints the complete development matrix to
stdout. No credentials or persistent writes:

```powershell
npm run benchmark:router -- --mode=dry-run --plan=Pro
```

Local PC / PowerShell / Tomverse worktree root; prerequisites above. This
command writes a new local `router-development.plan.json` file and refuses to
overwrite an existing file. No credentials or provider calls. To undo, remove
only that generated file after any offline scoring that needs it:

```powershell
npm run benchmark:router -- --mode=dry-run --plan=Pro --output=router-development.plan.json
```

Local PC / PowerShell / the **original** Tomverse worktree root and source
snapshot; prerequisites above, plus that plan and a saved-answer file matching
the schema above. This command reads both files and prints a score; it does
not write, collect answers or call providers. These file names refer to local
inputs, not committed provider observations:

```powershell
npm run benchmark:router -- --mode=score --plan-file=router-development.plan.json --answers=router-development.answers.json
```

Local PC / PowerShell / Tomverse worktree root; Git, Node 22 and installed
dependencies required, with no credentials. This runs the offline core, CLI
and corpus tests. CLI tests use temporary local files and clean them up:

```powershell
npm run test:router-development-benchmark
```

All value-bearing CLI arguments use `--key=value`. `--corpus=PATH` selects a
validated v1 development corpus, `--requested-model=ID` sets the diagnostic's
requested model during planning, and `--output=NEW_PATH` can save the score to
a new local file. There is no overwrite flag. A plan must be recreated after
source changes; recreating it does not make old answer digests valid for the
new plan. Errors emit fixed diagnostic codes rather than input contents or
environment values. Successful output includes the intentionally synthetic
prompts; an externally saved answer file must be inspected for its own data
before sharing.
