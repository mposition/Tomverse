# Independent review — task router-development-benchmark-v1, round 0

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Build the next offline development slice for improving Auto Router model selection across the whole static catalogue without repeated human evaluation hand-offs. Provide exactly 24 agent-authored synthetic development fixture/candidate cases: 12 Korean and 12 English, with six structured-extraction and six supplied-source grounded-calculation cases per language. Each prompt carries the facts and rules needed for its answer; no search, attachment, tool, external-current-information or code-execution requirement is permitted. Grade saved answer text with a bounded, deterministic exact-JSON semantic-value checker, not merely a schema check. Build a complete case-by-catalogue-model manifest that retains disabled, plan-ineligible, unsupported-context, intrinsic-search and other refused rows with explicit reasons. Preserve the existing product Router diagnostic and its original inferred profile, eligibility, rank, selection and cap separately from static benchmark admission based on the validated fixture requirements and each model's product answer cap. Record fitted caps, model/provider/API identity, pricing provenance, input estimates, source/corpus/configuration digests and planning versions without claiming runtime eligibility or observed spending. Support only offline dry-run planning and scoring of externally saved or explicitly synthetic answers. Do not implement provider collection, a live mode, an LLM judge, a coding executor, production routing or score-policy changes, quality-band promotion, adoption or approval records, sample-size activation, push, deployment or workflow dispatch. This is a new benchmark review task, not a continuation or reopening of either concluded full-catalogue diagnostic exchange. Independent reviewer execution is a separate control-program action; preparing this task or package does not authorize preflight, review, live execution or a skip-preflight override.

## Completion criteria

- npm run test:router-development-benchmark executes at least 95 offline tests with zero failures, covering the scoring core, CLI and all 24 corpus cases. The tests do not call providers, judges or a code-execution service.
- The corpus validator requires exactly 24 unique cases with six in each language/task cell, development-only purpose, supported exact-JSON grading rules and explicit no-search/no-attachment/no-tool requirements. All 24 expected objects are checked using separately encoded source facts and task-specific derivations; those checks are accurately described as agent-authored rather than independent human review.
- The exact-JSON grader checks semantic values, nested keys, types, nulls, booleans and ordered arrays. Object-key order, JSON formatting and equivalent numeric notation may vary; string values receive no normalization. Blank text, wrong values, missing or extra keys, duplicate keys, fenced/commentary output, malformed JSON, numeric precision loss and parser-limit violations fail without executing answer text.
- Every static catalogue model appears once per case with a stable row identity, including refused models. Against the stated base catalogue this is 42 models times 24 cases, or 1008 rows. Unknown or duplicate model identities and tampered plan rows are refused; no missing context window or quality evidence is invented.
- The original product Router diagnostic remains visible in row.router. Benchmark admission separately reuses the product candidate filter with validated fixture requirements and per-model product answer caps, names that distinct basis, exposes disagreements and does not change or rerank production Auto. Each case retains its planned/refused population and the known profiler disagreement remains documented.
- The manifest records model-specific product caps, fitted proposed output caps, context-window facts, prompt-only token-estimate limitations, API and pricing identities, pricing snapshots, versions, and source/corpus/plan/call-configuration digests. Static eligibility and cap-based cost estimates are never described as verified runtime dispatch, authorization, guaranteed maximum spend or actual provider observations.
- modelInputForCase emits only prompt text. Expected answers, grader metadata, case identifiers and provenance are absent from model input. Gold values remain available only to local corpus validation and saved-answer scoring.
- Saved-result validation rejects duplicate, unknown, refused or mismatched rows, stale digests, invalid statuses/metrics and synthetic fixtures that assert provider observations. Missing rows remain not_run; failed, timeout, blank, invalid-JSON and wrong-value outcomes are counted separately and remain in the complete planned denominator. Headline correctness is null until the relevant planned group has complete submitted coverage, and empty groups do not report a passing rate.
- The CLI accepts only dry-run and score modes, rejects unknown/duplicate/incompatible arguments and case-insensitive CHAT_MODEL price/cap environment overrides, bounds file reads, refuses output overwrite and requires a matching saved source/corpus/planning snapshot for scoring. External saved origin and measurements stay self-reported; the tool records zero provider calls and no verified actual generations.
- Production Router, score policy, flags, existing evaluation/adoption/preregistration/release records, and previous cross-review exchanges remain unchanged. Documentation makes no model-winner, confidence-interval, quality-band, representative-traffic or production-readiness claim. The new package is created only after source validation, uses author=codex and reviewer=claude, excludes only its own distinct output directory, and remains awaiting_review until an actual independent verdict exists.

## Change under review — digest sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345, commit 138bd4c60bd0534dbf131df5f7868fe9d1f623f4

```diff
diff --git a/docs/ops/cross-review/packages/router-development-benchmark-v1.task.json b/docs/ops/cross-review/packages/router-development-benchmark-v1.task.json
new file mode 100644
index 00000000..d6dae037
--- /dev/null
+++ b/docs/ops/cross-review/packages/router-development-benchmark-v1.task.json
@@ -0,0 +1,30 @@
+{
+  "taskId": "router-development-benchmark-v1",
+  "requirement": "Build the next offline development slice for improving Auto Router model selection across the whole static catalogue without repeated human evaluation hand-offs. Provide exactly 24 agent-authored synthetic development fixture/candidate cases: 12 Korean and 12 English, with six structured-extraction and six supplied-source grounded-calculation cases per language. Each prompt carries the facts and rules needed for its answer; no search, attachment, tool, external-current-information or code-execution requirement is permitted. Grade saved answer text with a bounded, deterministic exact-JSON semantic-value checker, not merely a schema check. Build a complete case-by-catalogue-model manifest that retains disabled, plan-ineligible, unsupported-context, intrinsic-search and other refused rows with explicit reasons. Preserve the existing product Router diagnostic and its original inferred profile, eligibility, rank, selection and cap separately from static benchmark admission based on the validated fixture requirements and each model's product answer cap. Record fitted caps, model/provider/API identity, pricing provenance, input estimates, source/corpus/configuration digests and planning versions without claiming runtime eligibility or observed spending. Support only offline dry-run planning and scoring of externally saved or explicitly synthetic answers. Do not implement provider collection, a live mode, an LLM judge, a coding executor, production routing or score-policy changes, quality-band promotion, adoption or approval records, sample-size activation, push, deployment or workflow dispatch. This is a new benchmark review task, not a continuation or reopening of either concluded full-catalogue diagnostic exchange. Independent reviewer execution is a separate control-program action; preparing this task or package does not authorize preflight, review, live execution or a skip-preflight override.",
+  "completionCriteria": [
+    "npm run test:router-development-benchmark executes at least 95 offline tests with zero failures, covering the scoring core, CLI and all 24 corpus cases. The tests do not call providers, judges or a code-execution service.",
+    "The corpus validator requires exactly 24 unique cases with six in each language/task cell, development-only purpose, supported exact-JSON grading rules and explicit no-search/no-attachment/no-tool requirements. All 24 expected objects are checked using separately encoded source facts and task-specific derivations; those checks are accurately described as agent-authored rather than independent human review.",
+    "The exact-JSON grader checks semantic values, nested keys, types, nulls, booleans and ordered arrays. Object-key order, JSON formatting and equivalent numeric notation may vary; string values receive no normalization. Blank text, wrong values, missing or extra keys, duplicate keys, fenced/commentary output, malformed JSON, numeric precision loss and parser-limit violations fail without executing answer text.",
+    "Every static catalogue model appears once per case with a stable row identity, including refused models. Against the stated base catalogue this is 42 models times 24 cases, or 1008 rows. Unknown or duplicate model identities and tampered plan rows are refused; no missing context window or quality evidence is invented.",
+    "The original product Router diagnostic remains visible in row.router. Benchmark admission separately reuses the product candidate filter with validated fixture requirements and per-model product answer caps, names that distinct basis, exposes disagreements and does not change or rerank production Auto. Each case retains its planned/refused population and the known profiler disagreement remains documented.",
+    "The manifest records model-specific product caps, fitted proposed output caps, context-window facts, prompt-only token-estimate limitations, API and pricing identities, pricing snapshots, versions, and source/corpus/plan/call-configuration digests. Static eligibility and cap-based cost estimates are never described as verified runtime dispatch, authorization, guaranteed maximum spend or actual provider observations.",
+    "modelInputForCase emits only prompt text. Expected answers, grader metadata, case identifiers and provenance are absent from model input. Gold values remain available only to local corpus validation and saved-answer scoring.",
+    "Saved-result validation rejects duplicate, unknown, refused or mismatched rows, stale digests, invalid statuses/metrics and synthetic fixtures that assert provider observations. Missing rows remain not_run; failed, timeout, blank, invalid-JSON and wrong-value outcomes are counted separately and remain in the complete planned denominator. Headline correctness is null until the relevant planned group has complete submitted coverage, and empty groups do not report a passing rate.",
+    "The CLI accepts only dry-run and score modes, rejects unknown/duplicate/incompatible arguments and case-insensitive CHAT_MODEL price/cap environment overrides, bounds file reads, refuses output overwrite and requires a matching saved source/corpus/planning snapshot for scoring. External saved origin and measurements stay self-reported; the tool records zero provider calls and no verified actual generations.",
+    "Production Router, score policy, flags, existing evaluation/adoption/preregistration/release records, and previous cross-review exchanges remain unchanged. Documentation makes no model-winner, confidence-interval, quality-band, representative-traffic or production-readiness claim. The new package is created only after source validation, uses author=codex and reviewer=claude, excludes only its own distinct output directory, and remains awaiting_review until an actual independent verdict exists."
+  ],
+  "baseCommit": "89288a8671ef25c30084b71f8a9266a3ae9f5475",
+  "writableScope": [
+    "docs/ops/cross-review/packages/router-development-benchmark-v1.task.json",
+    "docs/ops/router-development-benchmark/README.md",
+    "docs/ops/router-development-benchmark/development-v1.json",
+    "lib/routerDevelopmentBenchmark.ts",
+    "lib/routerDevelopmentBenchmarkPlan.ts",
+    "package.json",
+    "scripts/router-development-benchmark.mjs",
+    "tests/routerDevelopmentBenchmark.test.mjs",
+    "tests/routerDevelopmentBenchmarkCli.test.mjs",
+    "tests/routerDevelopmentBenchmarkCorpus.test.mjs"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ops/router-development-benchmark/README.md b/docs/ops/router-development-benchmark/README.md
new file mode 100644
index 00000000..ec699220
--- /dev/null
+++ b/docs/ops/router-development-benchmark/README.md
@@ -0,0 +1,275 @@
+# Router development benchmark v1
+
+This is an agent-authored synthetic **DEVELOPMENT FIXTURE / CANDIDATE** corpus
+and an offline planning and exact-answer scoring tool. Codex drafted these
+items for development; no human adoption, independent reviewer verdict or
+release decision is recorded here. Its 24 prompts are available for inspection
+and tuning. They are not a representative sample of real traffic, a frozen
+decision set, or `ROUTE-01` evidence.
+
+The separation follows
+[the Router evaluation procedure, §§6–8](../tomverse-chat-router-evaluation-set.md):
+check correctness when it is checkable, keep development and decision data
+separate, and treat model-drafted items as candidates. This directory does not
+modify the existing evaluation sets, answer exchanges, score policy, adoption
+records, preregistration, or release registry. There is no model winner,
+confidence interval, quality-band update, or product-readiness conclusion.
+
+## Contents and scope
+
+- [development-v1.json](development-v1.json): exactly 24 cases, six in each
+  language/task cell. Schema `router-development-corpus-v1`, corpus
+  `tomverse-router-development-v1`, purpose `development-only`.
+- [Corpus answer checks](../../../tests/routerDevelopmentBenchmarkCorpus.test.mjs):
+  separately encoded source facts, prompt anchors and task-specific derivations;
+  every expected answer is checked without reading the dataset's `expected`
+  value to construct the answer. The same agent authored the corpus and these
+  checks; separate code paths are not independent human review. Every case has wrong-value, missing-key,
+  extra-key, type and formatting checks as applicable.
+- [Scoring core](../../../lib/routerDevelopmentBenchmark.ts),
+  [planning core](../../../lib/routerDevelopmentBenchmarkPlan.ts), and
+  [CLI](../../../scripts/router-development-benchmark.mjs): deterministic
+  local operations only.
+
+| Task | Korean | English | Total |
+| --- | ---: | ---: | ---: |
+| Structured extraction | 6 | 6 | 12 |
+| Grounded calculation | 6 | 6 | 12 |
+| Total | 12 | 12 | 24 |
+
+All entities and facts are fictional. Prompts contain their complete data and
+rules, including conversions and date-comparison rules. No case needs search,
+attachments, code execution or external current knowledge. The two language
+groups use different records and scenarios; they are not paired translations.
+This is not a difficulty calibration between languages. Coding execution,
+research, open-ended writing, long-context use and tool quality are outside v1.
+
+## Case inventory and answer rationale
+
+The JSON file contains the full expected objects; the table gives the reason
+each answer follows from its prompt. The tests independently reconstruct the
+full objects, including exact key names, nulls, booleans and nested values.
+
+| Case | Operation and known answer |
+| --- | --- |
+| `dev-en-extract-01` | Dispatched AND North Dock selects S-41; fragile is true; labels are glass, then blue. S-42 has another destination and S-43 is queued. |
+| `dev-en-extract-02` | The current LAMP-7 record gives Annex/B2, rechargeable false, stand then shade, custodian null. Historical Team Gray is not inherited. |
+| `dev-en-extract-03` | Elm alone is both available and step-free; copy 8 seats and whiteboard then speaker. |
+| `dev-en-extract-04` | T-18's final event gives paused / Parts / awaitingExternal true / resolution null; T-19's resolution is unrelated. |
+| `dev-en-extract-05` | Explicit vegan AND available selects Zest bowl then Bean soup; copy Noon List and the two spaces in `Collect  at hatch`. |
+| `dev-en-extract-06` | MAP-3 current v2 gives River Paths, draft false, tags `[]`, reviewer null; old metadata is excluded. |
+| `dev-ko-extract-01` | The loan copy of 빛의 지도 is D-8, loanable true, 동관/3번, topics 관측 then 기록; D-9 is a reference copy. |
+| `dev-ko-extract-02` | 주말 AND 열림 selects 유리 새 then 나무 배; material flags are true then false in nested objects. |
+| `dev-ko-extract-03` | Received G-4 gives 은색/충전식, sealed false, 본체 then 받침대 then 안내지, locker null. G-5 is pending. |
+| `dev-ko-extract-04` | Confirmed first broadcasts on 파도 are 저녁 창 at 18:40 then 아침 돌 at 07:30; preserve source order, not time order. |
+| `dev-ko-extract-05` | R-2 gives 모형 조각, sealed true, exact two-space label `위  아래`, inspectionDate null. |
+| `dev-ko-extract-06` | Issued N-6 gives 작은 전시 / 북쪽 홀 / registrationRequired false / bring `[]` / endDate null; ignore the draft. |
+| `dev-en-calc-01` | Available = 18 + 7 − 9 − 2 = 14; removed = 9 + 2 = 11. |
+| `dev-en-calc-02` | Paid, uncancelled O-7 then O-4: count 2, total = 4 × 8 + 3 × 5 = 47 tokens. |
+| `dev-en-calc-03` | Unmarked = 40 − 15 = 25; marked = 15/40 × 100 = 37.5%; unmarked = 62.5%. |
+| `dev-en-calc-04` | Combined = 2000 + 350 + 750 = 3100 g; remaining = 2500 g = 2.5 kg. |
+| `dev-en-calc-05` | 10:05 − 09:10 = 605 − 550 = 55 minutes; minus 10-minute break = 45 minutes = 0.75 hours. |
+| `dev-en-calc-06` | Open and due on/before 2026-04-10 selects J-4 then J-8, including equality: count 2, units 3 + 4 = 7. |
+| `dev-ko-calc-01` | Initially packed = 4 × 6 = 24; shippable = 24 − 3 + 5 = 26. |
+| `dev-ko-calc-02` | Visitors = 7 + 5 + 2 = 14; paying = 12; tokens = 7 × 3 + 5 × 8 = 61. |
+| `dev-ko-calc-03` | Discount = 12000 × 12.5/100 = 1500; item = 10500; add undiscounted 500 packaging points to get 11000. |
+| `dev-ko-calc-04` | Combined = 1.2 × 100 + 85 + 350/10 = 240 cm; remaining = 200 cm = 2 m. |
+| `dev-ko-calc-05` | Approval order gives Q-3, Q-7, Q-1; 3 unique admissions from 4 approvals, 1 duplicate approval, 2 rejected scans. |
+| `dev-ko-calc-06` | Inclusive 2026-06-03 through 2026-06-08 and no return selects B-6 then B-9: count 2, units 5 + 2 = 7. |
+
+## Correctness contract
+
+Every prompt requests exactly one JSON object with specified keys and types,
+without commentary or code fences. `exact-json` checks the actual semantic
+answer, not merely schema compliance. The grader version is
+`router-development-exact-json-v1`.
+
+- Object key order and JSON formatting whitespace do not matter, including
+  at nested levels. Decoded JSON Unicode escapes are equivalent to literal
+  characters.
+- Arrays are ordered. Prompts state the required source order, including cases
+  where alphabetical or time order would produce a different result.
+- Strings have **no normalization**: no trimming, case folding, space
+  collapsing, or Unicode normalization. Spaces inside strings matter.
+- Missing and extra keys fail. `null`, an absent key, `"null"`, `false`, and
+  an empty array are distinct values. Numeric and boolean strings fail.
+- Numbers are compared as JSON numeric values: `2`, `2.0`, and `2e0` represent
+  the same value. These cases require only safe integers and exact finite
+  results; there is no rounding tolerance or percentage-string parsing.
+- Blank text, invalid JSON, duplicate keys, non-finite/out-of-range numbers,
+  fenced JSON and surrounding commentary fail. Parsing is bounded by byte,
+  depth and node limits; the model's answer is never evaluated as code.
+
+`modelInputForCase()` emits only `{ prompt }`. Expected answers, grading
+metadata, case IDs and corpus identity are not part of model input. The
+separate row envelope retains case identity for matching. Possessing the
+development answer file does not establish blinded measurement, model
+independence or human adoption.
+
+## What planning and scoring mean
+
+`dry-run` builds all case × static-catalogue rows and retains explicit refusal
+reasons. It uses the existing product profiler, Router diagnostic, call-limit,
+pricing and context-window functions. `row.router` preserves the Router's
+original inferred profile, output cap, rank, selection and filtering outcome.
+`row.benchmarkEligibility` separately describes static benchmark admission:
+it reuses `filterRouterCandidates()` with the validated fixture's declared
+requirements and a per-model proposed answer cap. Its basis is explicitly
+`declared_fixture_requirements_not_router_inference`. This does not modify
+Auto, rerank the Router or implement production dispatch. Disagreement between
+the two eligibility results remains visible.
+
+The static catalogue is not a runtime registry read. Plan eligibility does not
+verify credits, provider budgets, health, regional/account access, current
+registry overrides or execution readiness. Search backends are not assumed
+ready; intrinsic-search models are explicitly refused in v1, and the corpus
+validator refuses declared search, attachment or tool requirements. Disabled,
+plan-ineligible or unsupported-context candidates remain subject to the reused
+product candidate filter; missing context declarations and unverified fallback
+pricing are also refused. No provider client or request is constructed. There
+is no live mode, live answer collection, model judge, coding executor or
+network model call.
+
+The plan records source commit and listed source-file digests, dirty status, corpus
+and catalogue digests, model/API identities, pricing and context snapshots,
+per-row prompt and call-configuration digests, and versioned dependencies.
+The saved plan also has its own digest. Offline scoring checks the saved plan
+against the same recorded source-file bytes, corpus and resolved planning snapshot;
+changed listed source, model identity, configuration or prices are refused rather than
+silently substituted. A digest detects mismatch; it does not authenticate a
+provider response or certify a human review. The source-file list is explicit;
+it is not a complete capture of transitive dependencies or runtime authenticity.
+
+`plannedCalls` counts eligible matrix rows. `completedActualGenerations` and
+`incurredProviderSpendUsd` are zero in a dry run because nothing is called.
+`plannedTokenCostUsdEstimate` applies the recorded token-price snapshot to a
+prompt-only input heuristic and the proposed output cap. It is not a bill,
+approved budget, runtime credit limit, or guaranteed maximum: provider
+tokenization, prompt wrappers, cache behavior, reasoning and actual execution
+can differ. A large cap-based projection is not observed spending.
+
+`score` reads saved answers and checks values locally. Results can be labelled
+`synthetic-fixture` or `externally-saved`; the latter is self-reported,
+unverified provenance. Neither label changes the exact-answer grading rule.
+The score explicitly reports zero provider calls and zero incurred spend by
+this tool; it does not claim verified actual generations from an imported row.
+
+Saved-answer schema `router-development-results-v1` has these fields:
+
+| Level | Required contents |
+| --- | --- |
+| Root | `schemaVersion`, `purpose: "development-only"`, `corpusDigest`, `planDigest`, `origin`, `rows`. |
+| Origin | `kind: "synthetic-fixture"` or `"externally-saved"`, plus an accurate `description`. |
+| Row identity | `rowId`, `caseId`, `modelId`, `provider`, `apiModel`, `promptDigest`, `callConfigDigest`, matching one eligible planned row. |
+| Outcome | `status: "succeeded"`, `"failed"` or `"timeout"`; `answerText`, `answerDigest`, `failureCode`. Success has string text, its SHA-256 digest and null failure code. Failure/timeout has null text/digest and an explicit failure code. |
+| Observation | `recordedAt`, `providerResponseId`, `modelVersion`. Unknown provider fields are null; externally saved rows require a recorded-at instant. Synthetic rows require all three to be null. |
+| Metrics | `metrics` contains exactly `inputTokens`, `outputTokens`, `latencyMs`, `providerCostUsd`. Each is a measured non-negative number or null when unknown; token counts are integers. All are null for synthetic fixtures. |
+
+Unknown measurements must remain `null`; zero asserts an observed quantity.
+The scorer rejects duplicate/unknown rows, answers for refused rows, stale
+digests and synthetic fixtures that claim provider observations. A missing
+eligible row is `not_run`, not a failed model answer. Failed/timeout, blank,
+invalid-JSON and wrong-value rows are separately counted; submitting a wrong
+answer does not convert it into an exclusion.
+
+Summaries retain planned, refused, submitted, not-run and passed denominators
+overall, per model and per model/task/language cell. `coverage` is submitted
+divided by planned. `correctnessRate` stays null until all planned rows in that
+group are submitted; `correctShareOfPlanned` can describe observed progress
+without treating pending work as a model failure. A fully submitted group's
+correctness denominator includes failures/timeouts. Zero planned rows have
+null ratios. Do not compare model percentages without their cell coverage;
+different eligibility means different populations. Reported metric totals are
+null if any submitted row's corresponding metric is unknown, and imported
+metric values remain self-reported.
+
+## Known profiler disagreement, preserved for diagnosis
+
+The local development check on 2026-09-10, using `plan=Pro` and the default
+requested model, retained 42 catalogue models × 24 cases = 1008 rows. Static
+benchmark admission planned 360 rows and refused 648: every case had 15 planned
+and 27 refused model rows. Eight closed-book cases were classified by the
+existing product profiler as requiring search. The original Router and
+benchmark eligibility differed on 80 rows (10 rows for each of those cases).
+`summary.routerInferenceMismatchCases`, `summary.routerEligibilityMismatchRows`
+and `byCase` expose those differences. The profiler's search classification
+disagrees with the prompts' supplied-data contract; it does not establish
+that those questions require external information.
+
+| Cases | Observed profiler signal and source |
+| --- | --- |
+| `dev-en-extract-01`, `02`, `03`, `05`; `dev-en-calc-02`, `06` | `search:source-intent`: the word `source` in the explicit source-order instruction matches `RESEARCH_PATTERN` in `lib/modelFinder.ts`, via `lib/webSearchSuggestion.ts`. |
+| `dev-en-extract-06` | `search:recency-heuristic`: `current` labels a supplied publication version. |
+| `dev-ko-calc-06` | `search:recency-heuristic`: `오늘` occurs in the explicit instruction not to use today's date. |
+
+The data and Router are left as written. The separate benchmark admission
+uses the corpus's validated declared requirements, while retaining the
+profiler result for diagnosis. Removing those words from questions would tune
+the corpus to the current classifier. Future profiler, catalogue or planning
+revisions may change these counts; the saved source/corpus snapshot identifies
+the observation. Refusal is a routing/planning observation and is not a model
+correctness failure. The grader tests exercise all 24 known answers regardless
+of planning eligibility. This snapshot incurred no provider spend or actual
+generations.
+
+## Local commands
+
+Run on the local PC in **PowerShell**, inside the Tomverse clone/worktree root
+(for this work, `H:\Project\tomverse-router-benchmark-v1-20260910`). Git, Node
+22 and dependencies installed with `npm ci` must be available. No production
+credentials, provider keys, DB connection, or environment variables are needed.
+Do not set `CHAT_MODEL_*` price/cap override variables for this offline run;
+the CLI refuses them because v1 records the code pricing snapshot.
+
+Local PC / PowerShell / Tomverse worktree root; prerequisites above. This
+command reads local files and prints help, without writing files or calling
+providers:
+
+```powershell
+npm run benchmark:router -- --help
+```
+
+Local PC / PowerShell / Tomverse worktree root; prerequisites above. This
+command reads local files and prints the complete development matrix to
+stdout. No credentials or persistent writes:
+
+```powershell
+npm run benchmark:router -- --mode=dry-run --plan=Pro
+```
+
+Local PC / PowerShell / Tomverse worktree root; prerequisites above. This
+command writes a new local `router-development.plan.json` file and refuses to
+overwrite an existing file. No credentials or provider calls. To undo, remove
+only that generated file after any offline scoring that needs it:
+
+```powershell
+npm run benchmark:router -- --mode=dry-run --plan=Pro --output=router-development.plan.json
+```
+
+Local PC / PowerShell / the **original** Tomverse worktree root and source
+snapshot; prerequisites above, plus that plan and a saved-answer file matching
+the schema above. This command reads both files and prints a score; it does
+not write, collect answers or call providers. These file names refer to local
+inputs, not committed provider observations:
+
+```powershell
+npm run benchmark:router -- --mode=score --plan-file=router-development.plan.json --answers=router-development.answers.json
+```
+
+Local PC / PowerShell / Tomverse worktree root; Git, Node 22 and installed
+dependencies required, with no credentials. This runs the offline core, CLI
+and corpus tests. CLI tests use temporary local files and clean them up:
+
+```powershell
+npm run test:router-development-benchmark
+```
+
+All value-bearing CLI arguments use `--key=value`. `--corpus=PATH` selects a
+validated v1 development corpus, `--requested-model=ID` sets the diagnostic's
+requested model during planning, and `--output=NEW_PATH` can save the score to
+a new local file. There is no overwrite flag. A plan must be recreated after
+source changes; recreating it does not make old answer digests valid for the
+new plan. Errors emit fixed diagnostic codes rather than input contents or
+environment values. Successful output includes the intentionally synthetic
+prompts; an externally saved answer file must be inspected for its own data
+before sharing.
diff --git a/docs/ops/router-development-benchmark/development-v1.json b/docs/ops/router-development-benchmark/development-v1.json
new file mode 100644
index 00000000..7b5d62b9
--- /dev/null
+++ b/docs/ops/router-development-benchmark/development-v1.json
@@ -0,0 +1,223 @@
+{
+  "schemaVersion": "router-development-corpus-v1",
+  "corpusId": "tomverse-router-development-v1",
+  "purpose": "development-only",
+  "cases": [
+    {
+      "id": "dev-en-extract-01",
+      "language": "en",
+      "task": "structured-extraction",
+      "prompt": "Use only these synthetic dispatch records. Do not search, use attachments, execute code, or infer unstated facts. Records in source order: shipment S-41, destination North Dock, status dispatched, fragile yes, labels [glass, blue]; shipment S-42, destination South Dock, status dispatched, fragile no, labels [paper]; shipment S-43, destination North Dock, status queued, fragile no, labels [steel]. Select the dispatched shipment for North Dock. Return exactly one JSON object, with no code fences or commentary, containing exactly shipmentId (string), destination (string), fragile (boolean: yes means true, no means false), labels (array of strings in the selected record's source order). Copy string values exactly. Do not add keys or facts.",
+      "expected": { "shipmentId": "S-41", "destination": "North Dock", "fragile": true, "labels": ["glass", "blue"] },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-extract-02",
+      "language": "en",
+      "task": "structured-extraction",
+      "prompt": "Use only this synthetic equipment register. Do not search, use attachments, execute code, or infer unstated facts. Record: asset LAMP-7; current yes; location building Annex, room B2; rechargeable no; accessories [stand, shade]; custodian is not recorded. A historical record for LAMP-7 has current no, room A1 and custodian Team Gray. Extract only the current record. Return exactly one JSON object, with no code fences or commentary, and exactly these keys: assetId (string), location (object with exactly building and room, both strings), rechargeable (boolean, yes=true and no=false), accessories (array of strings in source order), custodian (string if recorded in the current record, otherwise null). Copy strings exactly and do not add keys or facts.",
+      "expected": { "assetId": "LAMP-7", "location": { "building": "Annex", "room": "B2" }, "rechargeable": false, "accessories": ["stand", "shade"], "custodian": null },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-extract-03",
+      "language": "en",
+      "task": "structured-extraction",
+      "prompt": "Use only these synthetic room cards. Do not search, use attachments, execute code, or infer unstated facts. In source order: Cedar, available no, stepFree yes, seats 12, equipment [screen]; Elm, available yes, stepFree yes, seats 8, equipment [whiteboard, speaker]; Ash, available yes, stepFree no, seats 20, equipment [screen, microphone]. Select the room marked both available yes and stepFree yes. Return exactly one JSON object without code fences or commentary, with exactly room (string), access (object with exactly available and stepFree, both booleans using yes=true/no=false), seats (integer), equipment (array of strings preserving the selected card's order). Copy strings exactly and add no keys or facts.",
+      "expected": { "room": "Elm", "access": { "available": true, "stepFree": true }, "seats": 8, "equipment": ["whiteboard", "speaker"] },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-extract-04",
+      "language": "en",
+      "task": "structured-extraction",
+      "prompt": "Use only this synthetic ticket log. Do not search, use attachments, execute code, or infer unstated facts. Ticket T-18 has events in authoritative oldest-to-newest order: opened with queue Intake; assigned with queue Repairs; paused with queue Parts. The final event explicitly gives status paused, queue Parts, awaitingExternal yes; it has no resolution text. Separate ticket T-19 is resolved with resolution Replaced seal. Extract T-18 from its final event only. Return exactly one JSON object without code fences or commentary, with exactly ticketId (string), status (string), queue (string), awaitingExternal (boolean using yes=true/no=false), resolution (string when present on T-18's final event, otherwise null). Preserve string spelling and add no keys or facts.",
+      "expected": { "ticketId": "T-18", "status": "paused", "queue": "Parts", "awaitingExternal": true, "resolution": null },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-extract-05",
+      "language": "en",
+      "task": "structured-extraction",
+      "prompt": "Use only this synthetic menu; dietary labels are explicit data and must not be inferred from names. Do not search, use attachments, or execute code. Items in source order: Zest bowl, vegan yes, available yes; Almond tart, vegan yes, available no; Bean soup, vegan yes, available yes; Garden pie, vegan no, available yes. Menu title is Noon List. The service note is exactly \"Collect  at hatch\" (two spaces between Collect and at). Select only items marked vegan yes and available yes. Return exactly one JSON object without code fences or commentary, with exactly menu (string), eligibleItems (array of item-name strings in source order), serviceNote (string copied exactly, including its two spaces). Add no keys or unstated facts.",
+      "expected": { "menu": "Noon List", "eligibleItems": ["Zest bowl", "Bean soup"], "serviceNote": "Collect  at hatch" },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-extract-06",
+      "language": "en",
+      "task": "structured-extraction",
+      "prompt": "Use only this synthetic publication register. Do not search, use attachments, execute code, or infer unstated facts. Document MAP-3 has version v1 marked current no, draft yes, tags [temporary], reviewer Unit Amber. Its version v2 is marked current yes, draft no, tags explicitly empty, title River Paths, and no reviewer is recorded. Return the current version as exactly one JSON object without code fences or commentary. Use exactly documentId (string), version (string), title (string), draft (boolean using yes=true/no=false), tags (array of strings in listed order; explicitly empty means []), reviewer (string when recorded on this version, otherwise null). Copy strings exactly and add no keys or facts.",
+      "expected": { "documentId": "MAP-3", "version": "v2", "title": "River Paths", "draft": false, "tags": [], "reviewer": null },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-extract-01",
+      "language": "ko",
+      "task": "structured-extraction",
+      "prompt": "다음은 가상의 도서 안내입니다. 제공한 정보만 사용하고 검색, 첨부파일, 코드 실행, 명시되지 않은 사실 추론을 하지 마세요. 목록 순서: 자료 D-8, 제목 빛의 지도, 구분 대출용, 대출가능 예, 서가 동관/3번, 주제 [관측, 기록]; 자료 D-9, 제목 빛의 지도, 구분 참고용, 대출가능 아니오, 서가 서관/1번, 주제 [역사]. 제목이 빛의 지도이며 구분이 대출용인 자료를 고르세요. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 키는 정확히 id(문자열), title(문자열), loanable(예=true, 아니오=false인 불리언), shelf(wing과 slot만 있는 객체이며 둘 다 문자열), topics(주제 문자열 배열, 원문 순서 유지)입니다. 문자열을 그대로 옮기고 추가 키나 사실을 넣지 마세요.",
+      "expected": { "id": "D-8", "title": "빛의 지도", "loanable": true, "shelf": { "wing": "동관", "slot": "3번" }, "topics": ["관측", "기록"] },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-extract-02",
+      "language": "ko",
+      "task": "structured-extraction",
+      "prompt": "다음 가상 공방 시간표에 적힌 정보만 사용하세요. 검색, 첨부파일, 코드 실행 및 외부 달력 지식은 사용하지 마세요. 시간표 이름은 작은 공방입니다. 목록 순서: 유리 새, 요일구분 주말, 신청상태 열림, 재료제공 예; 종이 집, 요일구분 평일, 신청상태 열림, 재료제공 예; 실 매듭, 요일구분 주말, 신청상태 닫힘, 재료제공 아니오; 나무 배, 요일구분 주말, 신청상태 열림, 재료제공 아니오. 주말이면서 신청상태가 열림인 수업만 고르세요. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 키는 정확히 timetable(문자열), classes(객체 배열)이며 각 수업 객체에는 name(문자열), materialsIncluded(예=true, 아니오=false인 불리언)만 넣으세요. 배열은 목록 순서를 유지하고 문자열은 그대로 복사하세요. 추가 키나 명시되지 않은 사실은 넣지 마세요.",
+      "expected": { "timetable": "작은 공방", "classes": [{ "name": "유리 새", "materialsIncluded": true }, { "name": "나무 배", "materialsIncluded": false }] },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-extract-03",
+      "language": "ko",
+      "task": "structured-extraction",
+      "prompt": "가상의 기기 인수 기록입니다. 제공한 정보만 사용하고 검색, 첨부파일, 코드 실행, 추측을 하지 마세요. 기기 G-4의 기록은 상태 인수완료, 본체 색상 은색, 전원 충전식, 봉인 아니오, 구성품 [본체, 받침대, 안내지]이며 보관함 번호는 기록되지 않았습니다. 기기 G-5는 상태 인수예정, 본체 색상 검정, 전원 건전지식, 봉인 예, 보관함 번호 함-2입니다. 인수완료인 기기 정보를 추출하세요. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하고 정확히 deviceId(문자열), body(color와 power만 있는 객체, 둘 다 문자열), sealed(예=true, 아니오=false인 불리언), components(문자열 배열, 원문 순서), locker(해당 기기에 기록이 있으면 문자열, 없으면 null)를 넣으세요. 추가 키나 사실을 넣지 마세요.",
+      "expected": { "deviceId": "G-4", "body": { "color": "은색", "power": "충전식" }, "sealed": false, "components": ["본체", "받침대", "안내지"], "locker": null },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-extract-04",
+      "language": "ko",
+      "task": "structured-extraction",
+      "prompt": "다음은 가상의 방송 편성표이며 제공된 정보만 사용하세요. 검색, 첨부파일, 코드 실행, 명시되지 않은 사실 추론은 금지합니다. 채널 이름은 파도입니다. 원문 순서: 저녁 창, 편성종류 본방송, 확정 예, 시각 18:40; 새벽 길, 편성종류 재방송, 확정 예, 시각 05:10; 낮은 숲, 편성종류 본방송, 확정 아니오, 시각 12:20; 아침 돌, 편성종류 본방송, 확정 예, 시각 07:30. 본방송이며 확정 예인 항목만 추출하세요. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 키는 channel(문자열), programmes(객체 배열)만 사용하고, 각 항목에는 title과 time이라는 문자열 키만 넣으세요. 시간순으로 정렬하지 말고 원문 순서를 유지하며 문자열을 그대로 옮기세요. 추가 키나 사실은 넣지 마세요.",
+      "expected": { "channel": "파도", "programmes": [{ "title": "저녁 창", "time": "18:40" }, { "title": "아침 돌", "time": "07:30" }] },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-extract-05",
+      "language": "ko",
+      "task": "structured-extraction",
+      "prompt": "가상의 보관함 표찰 두 개입니다. 제공한 정보만 사용하고 검색, 첨부파일, 코드 실행 및 추측을 하지 마세요. 표찰: 함 R-2, 내용물 모형 조각, 봉인 예, 주의문구 \"위  아래\"(위와 아래 사이 공백 두 칸), 점검일 미기록. 다른 표찰: 함 R-3, 내용물 빈 상자, 봉인 아니오, 주의문구 없음, 점검일 2026-02-11. R-2 표찰만 추출하여 코드 블록이나 설명 없이 JSON 객체 하나를 반환하세요. 정확한 키는 binId(문자열), contents(문자열), sealed(예=true, 아니오=false인 불리언), label(문자열, 두 칸 공백까지 그대로), inspectionDate(해당 표찰에 날짜가 기록되었으면 문자열, 미기록이면 null)입니다. 추가 키나 사실은 넣지 마세요.",
+      "expected": { "binId": "R-2", "contents": "모형 조각", "sealed": true, "label": "위  아래", "inspectionDate": null },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-extract-06",
+      "language": "ko",
+      "task": "structured-extraction",
+      "prompt": "가상의 행사 공지판입니다. 제공한 정보만 사용하고 검색, 첨부파일, 코드 실행, 외부 날짜 지식이나 추측을 사용하지 마세요. 공지 N-6 초안: 발행 아니오, 행사명 작은 전시, 장소 남쪽 홀, 신청필수 예, 준비물 [초대장]. 공지 N-6 확정본: 발행 예, 행사명 작은 전시, 장소 북쪽 홀, 신청필수 아니오, 준비물은 명시적으로 빈 목록, 종료일은 미기록. 발행된 확정본만 추출하세요. 코드 블록이나 설명 없이 JSON 객체 하나를 반환하고 noticeId, event, venue는 문자열, registrationRequired는 예=true/아니오=false인 불리언, bring은 원문 순서의 문자열 배열(빈 목록은 []), endDate는 날짜 문자열 또는 미기록이면 null로 작성하세요. 이 여섯 키만 사용하며 추가 사실은 넣지 마세요.",
+      "expected": { "noticeId": "N-6", "event": "작은 전시", "venue": "북쪽 홀", "registrationRequired": false, "bring": [], "endDate": null },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-calc-01",
+      "language": "en",
+      "task": "grounded-calculation",
+      "prompt": "Use only these synthetic stock facts and rules. Do not search, use attachments, execute code, or add unstated facts. There were 18 usable units at opening. Seven usable units arrived. Nine units were shipped, then two of the remaining units were marked damaged and became unusable. No other movement occurred. Define removedFromUsable as shipped plus damaged units; define available as opening plus arrivals minus removedFromUsable. Return exactly one JSON object without code fences or commentary, containing exactly available (integer) and removedFromUsable (integer). Add no other keys.",
+      "expected": { "available": 14, "removedFromUsable": 11 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-calc-02",
+      "language": "en",
+      "task": "grounded-calculation",
+      "prompt": "Use only these synthetic orders and rules. Do not search, use attachments, execute code, or infer extra charges. Include an order only if paid=yes and cancelled=no. Amount is quantity multiplied by unitTokens; there are no other charges. In source order: O-7 paid=yes cancelled=no quantity=4 unitTokens=8; O-2 paid=no cancelled=no quantity=10 unitTokens=9; O-9 paid=yes cancelled=yes quantity=2 unitTokens=6; O-4 paid=yes cancelled=no quantity=3 unitTokens=5. Return exactly one JSON object without code fences or commentary, with exactly includedIds (array of strings in source order), orderCount (integer), totalTokens (integer). Add no keys or unstated facts.",
+      "expected": { "includedIds": ["O-7", "O-4"], "orderCount": 2, "totalTokens": 47 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-calc-03",
+      "language": "en",
+      "task": "grounded-calculation",
+      "prompt": "Use only this synthetic inspection tally. Do not search, use attachments, execute code, or infer any facts. Exactly 40 tiles were inspected; exactly 15 were marked and every other tile was unmarked. A percentage is count divided by all 40 inspected tiles multiplied by 100. Return exactly one JSON object without code fences or commentary, with exactly unmarkedCount (integer), markedPercent (number), unmarkedPercent (number). Use exact finite numbers, not fractions or strings, and do not round. Add no other keys.",
+      "expected": { "unmarkedCount": 25, "markedPercent": 37.5, "unmarkedPercent": 62.5 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-calc-04",
+      "language": "en",
+      "task": "grounded-calculation",
+      "prompt": "Use only these synthetic material measurements and the supplied conversion: 1 kilogram = 1000 grams. Do not search, use attachments, execute code, or infer packaging weight. Three portions weigh 2 kilograms, 350 grams, and 0.75 kilograms. They are combined; exactly 600 grams are then used, with no other loss. Return exactly one JSON object without code fences or commentary, with exactly combinedGrams (integer), remainingGrams (integer), remainingKilograms (number). Use exact finite numbers with no rounding, no unit suffixes, and no extra keys or facts.",
+      "expected": { "combinedGrams": 3100, "remainingGrams": 2500, "remainingKilograms": 2.5 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-calc-05",
+      "language": "en",
+      "task": "grounded-calculation",
+      "prompt": "Use only this synthetic work log and supplied rules. Do not search, use attachments, execute code, or use external calendar facts. Work starts at 09:10 and ends at 10:05 on the same fictional day; no day boundary is crossed. Convert HH:MM to minutes as HH multiplied by 60 plus MM. Elapsed minutes are end minus start; active minutes subtract a 10-minute break from elapsed minutes; active hours are active minutes divided by 60. Return exactly one JSON object without code fences or commentary, with exactly elapsedMinutes (integer), activeMinutes (integer), activeHours (number). Use exact finite values without rounding and add no keys or unstated facts.",
+      "expected": { "elapsedMinutes": 55, "activeMinutes": 45, "activeHours": 0.75 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-en-calc-06",
+      "language": "en",
+      "task": "grounded-calculation",
+      "prompt": "Use only these synthetic queue rows. Do not search, use attachments, execute code, or infer today's date. All dates are fixed-width YYYY-MM-DD; compare their strings lexicographically, so equal counts as on the cutoff. Include only status=open rows with dueDate at or before cutoff 2026-04-10. In source order: J-4 dueDate=2026-04-09 status=open units=3; J-1 dueDate=2026-04-10 status=closed units=9; J-8 dueDate=2026-04-10 status=open units=4; J-2 dueDate=2026-04-11 status=open units=8. Return exactly one JSON object without code fences or commentary, with exactly dueIds (array of strings in source order), dueCount (integer), dueUnits (integer sum of included units). Add no keys or unstated facts.",
+      "expected": { "dueIds": ["J-4", "J-8"], "dueCount": 2, "dueUnits": 7 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-calc-01",
+      "language": "ko",
+      "task": "grounded-calculation",
+      "prompt": "다음 가상의 포장 기록과 규칙만 사용하세요. 검색, 첨부파일, 코드 실행, 명시되지 않은 사실 추론은 하지 마세요. 완성 상자 4개에 모형이 각각 6개씩 들어 있습니다. 이 모형 중 불량 3개를 꺼내 제외했고, 별도로 있던 정상 모형 5개를 추가했습니다. 그 밖의 모형이나 변화는 없습니다. 처음 포장된 수는 상자 수 곱하기 상자당 모형 수이고, 배송 가능한 수는 처음 포장된 수에서 불량을 빼고 별도 정상 모형을 더한 값입니다. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 키는 initiallyPacked(정수), shippable(정수)만 사용하고 추가 사실은 넣지 마세요.",
+      "expected": { "initiallyPacked": 24, "shippable": 26 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-calc-02",
+      "language": "ko",
+      "task": "grounded-calculation",
+      "prompt": "가상의 체험장 방문 기록입니다. 제공된 숫자와 규칙만 사용하고 검색, 첨부파일, 코드 실행, 외부 요금 정보나 추측을 사용하지 마세요. 서로 겹치지 않는 세 방문 그룹: 어린이 7명은 1명당 3토큰, 성인 5명은 1명당 8토큰, 면제 방문자 2명은 1명당 0토큰입니다. 전체 방문자는 세 그룹 인원의 합, 유료 방문자는 토큰 요금이 0보다 큰 그룹 인원의 합, 총 토큰은 각 그룹 인원 곱하기 요금의 합입니다. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 정확한 키는 visitorCount(정수), payingCount(정수), totalTokens(정수)이며 추가 키나 사실은 넣지 마세요.",
+      "expected": { "visitorCount": 14, "payingCount": 12, "totalTokens": 61 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-calc-03",
+      "language": "ko",
+      "task": "grounded-calculation",
+      "prompt": "다음 가상 교환소 계산 규칙만 사용하세요. 검색, 첨부파일, 코드 실행이나 실제 결제 정책 추론은 하지 마세요. 물품 가격은 12000포인트이고 물품 가격에만 12.5% 할인을 적용합니다. 할인액은 가격 곱하기 12.5 나누기 100입니다. 할인 뒤에 할인 대상이 아닌 포장비 500포인트를 한 번 더합니다. 다른 비용은 없습니다. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하고 정확히 discountPoints(정수 할인액), discountedItemPoints(정수 물품 할인가), payablePoints(정수 최종 합계)를 넣으세요. 반올림이나 단위 문자열, 추가 키나 사실은 넣지 마세요.",
+      "expected": { "discountPoints": 1500, "discountedItemPoints": 10500, "payablePoints": 11000 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-calc-04",
+      "language": "ko",
+      "task": "grounded-calculation",
+      "prompt": "가상의 리본 길이 기록과 변환 규칙만 사용하세요. 검색, 첨부파일, 코드 실행, 외부 지식이나 손실량 추측은 하지 마세요. 1미터=100센티미터, 10밀리미터=1센티미터입니다. 리본 세 조각의 길이는 1.2미터, 85센티미터, 350밀리미터입니다. 이어 붙일 때 손실은 없고, 합친 뒤 40센티미터를 잘라 사용합니다. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 키는 combinedCentimeters(정수 합친 길이), remainingCentimeters(정수 남은 길이), remainingMeters(숫자 남은 미터 값)만 사용하세요. 정확한 값을 쓰고 반올림, 단위 문자열, 추가 키나 사실은 넣지 마세요.",
+      "expected": { "combinedCentimeters": 240, "remainingCentimeters": 200, "remainingMeters": 2 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-calc-05",
+      "language": "ko",
+      "task": "grounded-calculation",
+      "prompt": "다음 가상 입장 스캔 기록과 규칙만 사용하세요. 검색, 첨부파일, 코드 실행, 명시되지 않은 사실 추론은 하지 마세요. 기록 순서: 표 Q-3 승인, 표 Q-1 거절, 표 Q-3 승인, 표 Q-7 승인, 표 Q-1 승인, 표 Q-7 거절. 승인 기록만 대상으로 표 ID가 같으면 한 장으로 셉니다. ID 배열은 처음 승인된 순서이며 거절된 시점은 이 순서에 영향을 주지 않습니다. 거절 횟수는 중복 제거 없이 모든 거절 기록 수입니다. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 정확한 키는 admittedIds(문자열 배열), uniqueAdmissions(정수 승인된 서로 다른 표 수), duplicateApprovals(정수 승인 기록 수에서 서로 다른 승인 표 수를 뺀 값), rejectedScans(정수 거절 횟수)입니다. 추가 키나 사실은 넣지 마세요.",
+      "expected": { "admittedIds": ["Q-3", "Q-7", "Q-1"], "uniqueAdmissions": 3, "duplicateApprovals": 1, "rejectedScans": 2 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    },
+    {
+      "id": "dev-ko-calc-06",
+      "language": "ko",
+      "task": "grounded-calculation",
+      "prompt": "다음 가상의 보관 기간 표와 비교 규칙만 사용하세요. 검색, 첨부파일, 코드 실행, 오늘 날짜나 실제 달력 지식은 사용하지 마세요. 날짜는 모두 고정 길이 YYYY-MM-DD 문자열이며 문자열 사전순으로 비교합니다. 시작일 2026-06-03과 종료일 2026-06-08을 모두 포함하는 구간에 수령일이 있고 반품이 아니오인 항목만 합산합니다. 원문 순서: 묶음 B-6 수령일 2026-06-08 반품 아니오 수량 5; 묶음 B-2 수령일 2026-06-02 반품 아니오 수량 9; 묶음 B-9 수령일 2026-06-03 반품 아니오 수량 2; 묶음 B-4 수령일 2026-06-05 반품 예 수량 8; 묶음 B-1 수령일 2026-06-09 반품 아니오 수량 4. 코드 블록이나 설명 없이 JSON 객체 하나만 반환하세요. 키는 includedIds(문자열 배열, 날짜순이 아닌 원문 순서), includedCount(정수), totalUnits(정수 포함 수량 합계)만 사용하고 추가 사실은 넣지 마세요.",
+      "expected": { "includedIds": ["B-6", "B-9"], "includedCount": 2, "totalUnits": 7 },
+      "grading": { "kind": "exact-json", "arrayOrder": "ordered", "stringNormalization": "none" },
+      "requirements": { "needsSearch": false, "attachments": [], "tools": [] }
+    }
+  ]
+}
diff --git a/lib/routerDevelopmentBenchmark.ts b/lib/routerDevelopmentBenchmark.ts
new file mode 100644
index 00000000..9770402d
--- /dev/null
+++ b/lib/routerDevelopmentBenchmark.ts
@@ -0,0 +1,302 @@
+/** Development fixtures only. No provider dispatch, executable checker, or release verdict. */
+import { createHash } from "node:crypto";
+import type { DevelopmentPlan } from "./routerDevelopmentBenchmarkPlan";
+
+export const DEVELOPMENT_CORPUS_VERSION = "router-development-corpus-v1";
+export const DEVELOPMENT_GRADER_VERSION = "router-development-exact-json-v1";
+export const DEVELOPMENT_RESULTS_VERSION = "router-development-results-v1";
+export const DEVELOPMENT_SCORE_VERSION = "router-development-score-v1";
+export const DEVELOPMENT_LIMITS = {
+    corpusBytes: 1_048_576,
+    documentBytes: 16_777_216,
+    answerBytes: 65_536,
+    promptBytes: 16_384,
+    depth: 32,
+    nodes: 200_000,
+    models: 256,
+} as const;
+
+export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
+type JsonObject = { [key: string]: JsonValue };
+export type DevelopmentCase = {
+    id: string;
+    language: "ko" | "en";
+    task: "structured-extraction" | "grounded-calculation";
+    prompt: string;
+    expected: JsonObject;
+    grading: { kind: "exact-json"; arrayOrder: "ordered"; stringNormalization: "none" };
+    requirements: { needsSearch: false; attachments: []; tools: [] };
+};
+export type DevelopmentCorpus = {
+    schemaVersion: typeof DEVELOPMENT_CORPUS_VERSION;
+    corpusId: "tomverse-router-development-v1";
+    purpose: "development-only";
+    cases: DevelopmentCase[];
+};
+
+function fail(code: string): never { throw new Error(code); }
+export const benchmarkDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
+
+// Compare decimal value before and after JS Number conversion, without expanding
+// an exponent into a large string. 14.0 and 1.4e1 agree; 14.0000000000000001 does not.
+function normalizedDecimal(token: string): string {
+    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)!;
+    const fraction = match[3] ?? "";
+    const coefficient = `${match[2]}${fraction}`.replace(/^0+/, "");
+    if (!coefficient) return "0";
+    const exponentText = (match[4] ?? "0").replace(/^[+-]?0+/, "");
+    if (exponentText.replace(/^[+-]/, "").length > 6) fail("json_number_precision_loss");
+    const exponent = Number(match[4] ?? 0);
+    const digits = coefficient.replace(/0+$/, "");
+    return `${match[1]}${digits}e${exponent - fraction.length + coefficient.length - digits.length}`;
+}
+
+/** Canonical semantic JSON: exact strings/values, sorted object keys, ordered arrays. */
+export function canonicalBenchmarkJson(value: unknown): string {
+    let nodes = 0;
+    const visit = (item: unknown, depth: number): string => {
+        if (++nodes > DEVELOPMENT_LIMITS.nodes || depth > DEVELOPMENT_LIMITS.depth) fail("json_complexity_limit");
+        if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
+        if (typeof item === "number") {
+            if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) fail("json_number_out_of_range");
+            return JSON.stringify(item);
+        }
+        if (Array.isArray(item)) {
+            if (Object.keys(item).length !== item.length) fail("json_invalid_array");
+            return `[${item.map((child) => visit(child, depth + 1)).join(",")}]`;
+        }
+        if (!item || typeof item !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("json_invalid_value");
+        return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
+    };
+    const text = visit(value, 0);
+    if (Buffer.byteLength(text, "utf8") > DEVELOPMENT_LIMITS.documentBytes) fail("json_byte_limit");
+    return text;
+}
+
+/** JSON.parse alone accepts duplicate keys; this bounded grammar rejects them before grading. */
+export function parseBenchmarkJson(text: string, maxBytes: number = DEVELOPMENT_LIMITS.documentBytes): JsonValue {
+    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maxBytes) fail("json_byte_limit");
+    let position = 0;
+    let nodes = 0;
+    const whitespace = () => { while (position < text.length && /[\t\n\r ]/.test(text[position])) position++; };
+    const string = (): string => {
+        const start = position++;
+        while (position < text.length) {
+            const character = text[position++];
+            if (character === "\\") { position++; continue; }
+            if (character === '"') {
+                try { return JSON.parse(text.slice(start, position)) as string; } catch { fail("json_syntax"); }
+            }
+        }
+        return fail("json_syntax");
+    };
+    const value = (depth: number): JsonValue => {
+        if (++nodes > DEVELOPMENT_LIMITS.nodes || depth > DEVELOPMENT_LIMITS.depth) fail("json_complexity_limit");
+        whitespace();
+        const character = text[position];
+        if (character === '"') return string();
+        if (character === "{" || character === "[") {
+            position++;
+            const object: JsonObject = {};
+            const array: JsonValue[] = [];
+            const keys = new Set<string>();
+            const close = character === "{" ? "}" : "]";
+            whitespace();
+            if (text[position] === close) { position++; return character === "{" ? object : array; }
+            while (position < text.length) {
+                whitespace();
+                if (character === "{") {
+                    if (text[position] !== '"') fail("json_syntax");
+                    const key = string();
+                    if (keys.has(key)) fail("json_duplicate_key");
+                    keys.add(key);
+                    whitespace();
+                    if (text[position++] !== ":") fail("json_syntax");
+                    // defineProperty treats __proto__ as data, never a prototype setter.
+                    Object.defineProperty(object, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
+                } else array.push(value(depth + 1));
+                whitespace();
+                const separator = text[position++];
+                if (separator === close) return character === "{" ? object : array;
+                if (separator !== ",") fail("json_syntax");
+            }
+            return fail("json_syntax");
+        }
+        const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(position))?.[0];
+        if (!token) return fail("json_syntax");
+        position += token.length;
+        const parsed = JSON.parse(token) as JsonValue;
+        if (typeof parsed === "number" && (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)))) fail("json_number_out_of_range");
+        if (typeof parsed === "number" && normalizedDecimal(token) !== normalizedDecimal(JSON.stringify(parsed))) fail("json_number_precision_loss");
+        return parsed;
+    };
+    const parsed = value(0);
+    whitespace();
+    if (position !== text.length) fail("json_syntax");
+    return parsed;
+}
+
+export function strictBenchmarkObject(value: unknown, fields: readonly string[], where: string): Record<string, unknown> {
+    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`${where}:object_required`);
+    const keys = Object.keys(value).sort();
+    const expected = [...fields].sort();
+    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail(`${where}:unexpected_or_missing_fields`);
+    return value as Record<string, unknown>;
+}
+export function benchmarkString(value: unknown, where: string, maxBytes = 512): string {
+    if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) return fail(`${where}:invalid_string`);
+    return value;
+}
+export const isBenchmarkDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
+export const isBenchmarkInstant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
+
+export function validateDevelopmentCorpus(value: unknown): DevelopmentCorpus {
+    const serialized = canonicalBenchmarkJson(value);
+    if (Buffer.byteLength(serialized, "utf8") > DEVELOPMENT_LIMITS.corpusBytes) fail("corpus_byte_limit");
+    const corpus = strictBenchmarkObject(value, ["schemaVersion", "corpusId", "purpose", "cases"], "corpus");
+    if (corpus.schemaVersion !== DEVELOPMENT_CORPUS_VERSION || corpus.corpusId !== "tomverse-router-development-v1" || corpus.purpose !== "development-only") fail("corpus_version_or_purpose");
+    if (!Array.isArray(corpus.cases) || corpus.cases.length !== 24) fail("corpus_requires_24_cases");
+    const ids = new Set<string>();
+    const prompts = new Set<string>();
+    const cells = new Map<string, number>();
+    for (const candidate of corpus.cases) {
+        const item = strictBenchmarkObject(candidate, ["id", "language", "task", "prompt", "expected", "grading", "requirements"], "case");
+        const id = benchmarkString(item.id, "case.id", 100);
+        if (!/^dev-(en|ko)-(extract|calc)-\d{2}$/.test(id)) fail("case_id_format");
+        if (ids.has(id)) fail("duplicate_case_id");
+        ids.add(id);
+        if (!["ko", "en"].includes(item.language as string) || !["structured-extraction", "grounded-calculation"].includes(item.task as string)) fail("case_cell");
+        const prefix = `dev-${item.language}-${item.task === "structured-extraction" ? "extract" : "calc"}-`;
+        if (!id.startsWith(prefix)) fail("case_id_cell_mismatch");
+        const prompt = benchmarkString(item.prompt, "case.prompt", DEVELOPMENT_LIMITS.promptBytes);
+        if (prompts.has(prompt)) fail("duplicate_case_prompt");
+        prompts.add(prompt);
+        if (!item.expected || typeof item.expected !== "object" || Array.isArray(item.expected) || Object.keys(item.expected).length === 0) fail("expected_nonempty_object_required");
+        const grading = strictBenchmarkObject(item.grading, ["kind", "arrayOrder", "stringNormalization"], "grading");
+        if (grading.kind !== "exact-json" || grading.arrayOrder !== "ordered" || grading.stringNormalization !== "none") fail("unsupported_grading_rule");
+        const requirements = strictBenchmarkObject(item.requirements, ["needsSearch", "attachments", "tools"], "requirements");
+        if (requirements.needsSearch !== false || !Array.isArray(requirements.attachments) || requirements.attachments.length !== 0 || !Array.isArray(requirements.tools) || requirements.tools.length !== 0) fail("unsupported_case_requirements_v1");
+        const cell = `${item.language}:${item.task}`;
+        cells.set(cell, (cells.get(cell) ?? 0) + 1);
+    }
+    if (cells.size !== 4 || [...cells.values()].some((count) => count !== 6)) fail("corpus_requires_six_per_cell");
+    return value as DevelopmentCorpus;
+}
+
+export const parseDevelopmentCorpus = (text: string): DevelopmentCorpus => validateDevelopmentCorpus(parseBenchmarkJson(text, DEVELOPMENT_LIMITS.corpusBytes));
+export const modelInputForCase = (item: DevelopmentCase): { prompt: string } => ({ prompt: item.prompt });
+export function gradeDevelopmentAnswer(item: DevelopmentCase, answerText: string) {
+    if (typeof answerText !== "string" || !answerText.trim()) return { pass: false, reason: "blank_answer" as const };
+    let actual: JsonValue;
+    try { actual = parseBenchmarkJson(answerText, DEVELOPMENT_LIMITS.answerBytes); }
+    catch { return { pass: false, reason: "invalid_json" as const }; }
+    const pass = canonicalBenchmarkJson(actual) === canonicalBenchmarkJson(item.expected);
+    return { pass, reason: pass ? "exact_match" as const : "value_mismatch" as const };
+}
+
+export type DevelopmentResultRow = {
+    rowId: string; caseId: string; modelId: string; provider: string; apiModel: string;
+    promptDigest: string; callConfigDigest: string;
+    status: "succeeded" | "failed" | "timeout";
+    answerText: string | null; answerDigest: string | null; failureCode: string | null;
+    recordedAt: string | null; providerResponseId: string | null; modelVersion: string | null;
+    metrics: { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; providerCostUsd: number | null };
+};
+export type DevelopmentResults = {
+    schemaVersion: typeof DEVELOPMENT_RESULTS_VERSION;
+    purpose: "development-only"; corpusDigest: string; planDigest: string;
+    origin: { kind: "synthetic-fixture" | "externally-saved"; description: string };
+    rows: DevelopmentResultRow[];
+};
+
+/** Identities and digests bind saved text to a plan. They are not proof of a provider call. */
+export function validateDevelopmentResults(value: unknown, plan: DevelopmentPlan): DevelopmentResults {
+    canonicalBenchmarkJson(value);
+    const results = strictBenchmarkObject(value, ["schemaVersion", "purpose", "corpusDigest", "planDigest", "origin", "rows"], "results");
+    if (results.schemaVersion !== DEVELOPMENT_RESULTS_VERSION || results.purpose !== "development-only") fail("results_version_or_purpose");
+    if (results.corpusDigest !== plan.corpusDigest || results.planDigest !== plan.planDigest) fail("results_digest_mismatch");
+    const origin = strictBenchmarkObject(results.origin, ["kind", "description"], "origin");
+    if (origin.kind !== "synthetic-fixture" && origin.kind !== "externally-saved") fail("results_origin");
+    benchmarkString(origin.description, "origin.description");
+    if (!Array.isArray(results.rows) || results.rows.length > plan.rows.length) fail("results_row_count");
+    const planned = new Map(plan.rows.map((row) => [row.rowId, row]));
+    const seen = new Set<string>();
+    for (const candidate of results.rows) {
+        const row = strictBenchmarkObject(candidate, ["rowId", "caseId", "modelId", "provider", "apiModel", "promptDigest", "callConfigDigest", "status", "answerText", "answerDigest", "failureCode", "recordedAt", "providerResponseId", "modelVersion", "metrics"], "result_row");
+        if (typeof row.rowId !== "string" || seen.has(row.rowId)) fail("duplicate_or_invalid_result_row");
+        seen.add(row.rowId);
+        const source = planned.get(row.rowId);
+        if (!source) fail("unknown_result_row");
+        if (!source!.benchmarkEligibility.eligible) fail("result_for_refused_row");
+        for (const key of ["caseId", "modelId", "provider", "apiModel", "promptDigest", "callConfigDigest"] as const) {
+            if (row[key] !== source![key]) fail(`result_${key}_mismatch`);
+        }
+        if (row.status === "succeeded") {
+            if (typeof row.answerText !== "string" || Buffer.byteLength(row.answerText, "utf8") > DEVELOPMENT_LIMITS.answerBytes) fail("answer_text_byte_limit_or_type");
+            if (!isBenchmarkDigest(row.answerDigest) || row.answerDigest !== benchmarkDigest(row.answerText as string)) fail("answer_digest_mismatch");
+            if (row.failureCode !== null) fail("success_with_failure_code");
+        } else if (row.status === "failed" || row.status === "timeout") {
+            if (row.answerText !== null || row.answerDigest !== null) fail("failed_row_has_answer");
+            if (typeof row.failureCode !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(row.failureCode)) fail("failure_code_required");
+        } else fail("invalid_result_status");
+        if (row.recordedAt !== null && !isBenchmarkInstant(row.recordedAt)) fail("recorded_at_invalid");
+        for (const key of ["providerResponseId", "modelVersion"] as const) if (row[key] !== null) benchmarkString(row[key], key);
+        const metrics = strictBenchmarkObject(row.metrics, ["inputTokens", "outputTokens", "latencyMs", "providerCostUsd"], "metrics");
+        for (const [key, metric] of Object.entries(metrics)) {
+            if (metric !== null && (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0 || ((key === "inputTokens" || key === "outputTokens") && !Number.isSafeInteger(metric)))) fail("invalid_metric");
+        }
+        if (origin.kind === "synthetic-fixture" && (Object.values(metrics).some((metric) => metric !== null) || row.recordedAt !== null || row.providerResponseId !== null || row.modelVersion !== null)) fail("synthetic_fixture_claims_provider_observation");
+        if (origin.kind === "externally-saved" && row.recordedAt === null) fail("external_recorded_at_required");
+    }
+    return value as DevelopmentResults;
+}
+
+export function scoreDevelopmentResults(corpus: DevelopmentCorpus, plan: DevelopmentPlan, value: unknown) {
+    validateDevelopmentCorpus(corpus);
+    if (benchmarkDigest(canonicalBenchmarkJson(corpus)) !== plan.corpusDigest) fail("score_corpus_digest_mismatch");
+    const results = validateDevelopmentResults(value, plan);
+    const resultById = new Map(results.rows.map((row) => [row.rowId, row]));
+    const cases = new Map(corpus.cases.map((item) => [item.id, item]));
+    const rows = plan.rows.map((planned) => {
+        const saved = resultById.get(planned.rowId);
+        const verdict = saved?.status === "succeeded" ? gradeDevelopmentAnswer(cases.get(planned.caseId)!, saved.answerText!) : null;
+        const outcome = !planned.benchmarkEligibility.eligible ? "refused" : !saved ? "not_run" : saved.status !== "succeeded" ? saved.status : verdict!.reason;
+        return { rowId: planned.rowId, caseId: planned.caseId, modelId: planned.modelId, language: planned.language, task: planned.task, outcome, pass: verdict?.pass ?? false };
+    });
+    const summarize = (group: typeof rows) => {
+        const plannedRows = group.filter((row) => row.outcome !== "refused");
+        const submitted = plannedRows.filter((row) => row.outcome !== "not_run");
+        const passed = submitted.filter((row) => row.pass).length;
+        const returnedAnswerRecords = submitted.filter((row) => !["failed", "timeout"].includes(row.outcome)).length;
+        return {
+            catalogueRows: group.length, planned: plannedRows.length, refused: group.length - plannedRows.length,
+            submitted: submitted.length, returnedAnswerRecords, notRun: plannedRows.length - submitted.length, passed,
+            incorrect: submitted.filter((row) => row.outcome === "value_mismatch").length,
+            blank: submitted.filter((row) => row.outcome === "blank_answer").length,
+            invalidJson: submitted.filter((row) => row.outcome === "invalid_json").length,
+            failed: submitted.filter((row) => row.outcome === "failed").length,
+            timeout: submitted.filter((row) => row.outcome === "timeout").length,
+            coverage: plannedRows.length ? submitted.length / plannedRows.length : null,
+            // Partial runs have no headline correctness rate. Pending work is not a model failure.
+            correctnessRate: plannedRows.length > 0 && submitted.length === plannedRows.length ? passed / plannedRows.length : null,
+            correctShareOfPlanned: submitted.length > 0 && plannedRows.length > 0 ? passed / plannedRows.length : null,
+        };
+    };
+    const metricSummary = (field: keyof DevelopmentResultRow["metrics"]) => {
+        const observed = results.rows.flatMap((row) => row.metrics[field] === null ? [] : [row.metrics[field]!]);
+        return { observedRows: observed.length, submittedRows: results.rows.length, total: observed.length > 0 && observed.length === results.rows.length ? observed.reduce((sum, number) => sum + number, 0) : null };
+    };
+    return {
+        schemaVersion: DEVELOPMENT_SCORE_VERSION, purpose: "development-only", graderVersion: DEVELOPMENT_GRADER_VERSION,
+        corpusDigest: plan.corpusDigest, planDigest: plan.planDigest,
+        resultsDigest: benchmarkDigest(canonicalBenchmarkJson(results)), origin: results.origin,
+        evidenceStatus: results.origin.kind === "synthetic-fixture" ? "fixture_validation_only" : "self_reported_saved_answers_unverified",
+        providerCallsByThisTool: 0, incurredProviderSpendUsdByThisTool: 0, verifiedActualGenerations: 0,
+        summary: summarize(rows),
+        byModel: plan.models.map((model) => ({ modelId: model.modelId, ...summarize(rows.filter((row) => row.modelId === model.modelId)) })),
+        byModelTaskLanguage: plan.models.flatMap((model) => ["ko", "en"].flatMap((language) => ["structured-extraction", "grounded-calculation"].map((task) => ({ modelId: model.modelId, language, task, ...summarize(rows.filter((row) => row.modelId === model.modelId && row.language === language && row.task === task)) })))),
+        reportedMetrics: { inputTokens: metricSummary("inputTokens"), outputTokens: metricSummary("outputTokens"), latencyMs: metricSummary("latencyMs"), providerCostUsd: metricSummary("providerCostUsd") },
+        rows,
+        limitations: ["Synthetic candidates, not human-adopted evaluation items or release evidence.", "No confidence intervals, quality-band changes, or production-readiness verdict.", "Hashes bind records; externally saved origin and provider metrics remain self-reported.", "A missing row is not_run, not a model failure; headline correctness requires complete planned coverage."],
+    };
+}
diff --git a/lib/routerDevelopmentBenchmarkPlan.ts b/lib/routerDevelopmentBenchmarkPlan.ts
new file mode 100644
index 00000000..fc4ce792
--- /dev/null
+++ b/lib/routerDevelopmentBenchmarkPlan.ts
@@ -0,0 +1,181 @@
+/** An offline development matrix, built from product functions without constructing a provider. */
+import { fitChatOutputToContextWindow } from "./chatContextWindow";
+import { ACTIVE_ESTIMATOR_VERSION, estimateTokenBreakdown, toReservedInputTokens } from "./chatTokenEstimate";
+import { resolveModelPricing } from "./modelPricing";
+import type { AiModel, ModelTier } from "./models";
+import { CALL_LIMIT_PROFILE_VERSION, resolveCallLimit } from "./routerCallLimits";
+import { filterRouterCandidates } from "./routerCandidates";
+import { diagnoseFullCatalog, ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION } from "./routerFullCatalogDiagnostic";
+import { NO_WEB_SEARCH_BACKENDS } from "./webSearchBackends";
+import { getWebSearchCapability } from "./webSearchCapability";
+import type { TaskProfile } from "./taskProfileCore";
+import {
+    benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_GRADER_VERSION, DEVELOPMENT_LIMITS,
+    isBenchmarkDigest, isBenchmarkInstant, modelInputForCase, strictBenchmarkObject,
+    validateDevelopmentCorpus, type DevelopmentCorpus,
+} from "./routerDevelopmentBenchmark";
+
+export const DEVELOPMENT_PLAN_VERSION = "router-development-plan-v1";
+export type DevelopmentSource = { commit: string; dirty: boolean; files: Record<string, string> };
+export type DevelopmentPlanInput = {
+    corpus: DevelopmentCorpus; models: readonly AiModel[]; plan: ModelTier | "Guest";
+    requestedModelId: string; createdAt: string; source: DevelopmentSource;
+};
+
+export function buildDevelopmentPlan(input: DevelopmentPlanInput) {
+    const corpus = validateDevelopmentCorpus(input.corpus);
+    if (!isBenchmarkInstant(input.createdAt)) throw new Error("plan_created_at_invalid");
+    if (!["Guest", "Free", "Pro", "Max"].includes(input.plan)) throw new Error("plan_tier_invalid");
+    const source = strictBenchmarkObject(input.source, ["commit", "dirty", "files"], "source");
+    if (typeof source.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit) || typeof source.dirty !== "boolean") throw new Error("plan_source_invalid");
+    if (!source.files || typeof source.files !== "object" || Array.isArray(source.files) || Object.keys(source.files).length === 0 || Object.values(source.files).some((digest) => !isBenchmarkDigest(digest))) throw new Error("plan_source_digests_invalid");
+    if (!input.models.length || input.models.length > DEVELOPMENT_LIMITS.models || new Set(input.models.map((model) => model.id)).size !== input.models.length) throw new Error("plan_catalogue_size_or_duplicate_ids");
+    const models = [...input.models].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
+    if (!models.some((model) => model.id === input.requestedModelId)) throw new Error("plan_unknown_requested_model");
+    const diagnostic = diagnoseFullCatalog({
+        items: [...corpus.cases].sort((a, b) => a.id < b.id ? -1 : 1).map((item) => ({ id: item.id, prompt: item.prompt })),
+        models, plan: input.plan, requestedModelId: input.requestedModelId,
+        searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
+        catalogueSource: "lib/models.ts static catalogue; runtime registry unverified",
+        now: () => Date.parse(input.createdAt),
+    });
+    if (diagnostic.problems.length || diagnostic.summary.consistencyProblems) throw new Error("diagnostic_product_inconsistency");
+    const manifest = models.map((model) => {
+        const pricing = resolveModelPricing(model, { at: Date.parse(input.createdAt) });
+        const callLimit = resolveCallLimit(model, "answer");
+        // resolveCallLimit has no historical clock argument. Refuse drift instead of re-pricing a saved plan.
+        if (callLimit.pricingVersion !== pricing.pricingVersion || callLimit.inputUsdPerMillionTokens !== pricing.inputUsdPerMillionTokens || callLimit.outputUsdPerMillionTokens !== pricing.outputUsdPerMillionTokens) throw new Error("plan_pricing_time_mismatch");
+        return {
+            modelId: model.id, provider: model.provider, apiModel: model.apiModel,
+            pricingApiModelId: pricing.apiModelId, enabled: model.enabled,
+            publiclyListed: model.publiclyListed !== false, minimumPlan: model.minimumPlan,
+            contextWindowTokens: model.contextWindowTokens ?? null,
+            contextWindowSource: "caller catalogue value; provenance files frozen in source.files",
+            callLimit, providerMaxOutputTokens: pricing.providerMaxOutputTokens,
+            intrinsicSearch: getWebSearchCapability(model.id).support === "search-model",
+        };
+    });
+    const rows = diagnostic.items.flatMap((item) => {
+        const testCase = corpus.cases.find((candidate) => candidate.id === item.itemId)!;
+        const modelInput = modelInputForCase(testCase);
+        const breakdown = estimateTokenBreakdown(modelInput.prompt);
+        const reservedInputTokens = toReservedInputTokens(breakdown);
+        // A supplied-source fixture declares its execution needs. Keep the product's
+        // inferred profile in row.router; this separate profile does not change Auto.
+        const fixtureProfile: TaskProfile = {
+            version: "development-fixture-requirements-v1", kind: "general", kindConfidence: "none",
+            needsCurrentInformation: testCase.requirements.needsSearch,
+            hasImageInput: false, hasDocumentInput: false, expectedOutputLength: "short",
+            scripts: testCase.language === "ko" ? ["cjk"] : ["latin"],
+            signals: ["declared_fixture_requirements"],
+        };
+        return item.models.map((disposition) => {
+            const model = models.find((candidate) => candidate.id === disposition.modelId)!;
+            const frozen = manifest.find((entry) => entry.modelId === model.id)!;
+            const pricing = resolveModelPricing(model, { estimatedPromptTokens: breakdown.rawTotal, at: Date.parse(input.createdAt) });
+            const fit = fitChatOutputToContextWindow({ contextWindowTokens: model.contextWindowTokens, reservedInputTokens, requestOutputCapTokens: frozen.callLimit.requestedMaxOutputTokens, providerMaxOutputTokens: pricing.providerMaxOutputTokens });
+            const admission = filterRouterCandidates({ models: [model], plan: input.plan, profile: fixtureProfile, searchBackendReadiness: NO_WEB_SEARCH_BACKENDS, reservedInputTokens, requestOutputCapTokens: frozen.callLimit.requestedMaxOutputTokens });
+            const reasons: string[] = [];
+            if (admission.rejected[0]) reasons.push(`candidate_filter:${admission.rejected[0].reason}`);
+            if (frozen.intrinsicSearch) reasons.push("benchmark:intrinsic_search_model_unsupported_v1");
+            if (fit.kind === "unbounded") reasons.push("benchmark:context_window_undeclared");
+            if (fit.kind === "exceeded") reasons.push("benchmark:context_exceeded");
+            if (pricing.isFallbackPricing) reasons.push("benchmark:unverified_fallback_pricing");
+            if (model.apiModel !== pricing.apiModelId) reasons.push("benchmark:api_identity_mismatch");
+            const callConfig = {
+                callRole: "answer" as const, callLimit: frozen.callLimit,
+                proposedMaxOutputTokens: fit.kind === "fitted" ? fit.outputTokens : null,
+                contextFit: fit.kind, contextWindowTokens: model.contextWindowTokens ?? null,
+                providerMaxOutputTokens: pricing.providerMaxOutputTokens,
+                tokenEstimate: { ...breakdown, reservedInputTokens, basis: "prompt_only_estimate_not_provider_tokenization" },
+                priceSnapshot: {
+                    pricingVersion: pricing.pricingVersion, costSource: pricing.costSource,
+                    priceSource: pricing.priceSource, effectiveDate: pricing.effectiveDate,
+                    processingTier: pricing.processingTier, routing: pricing.routing,
+                    inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
+                    outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
+                    cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
+                    cacheWriteUsdPerMillionTokens: pricing.cacheWriteUsdPerMillionTokens,
+                    longContextThresholdTokens: pricing.longContextThresholdTokens,
+                    reasoningTokenBilling: pricing.reasoningTokenBilling,
+                },
+                generationSettings: "unverified_no_provider_request_constructed",
+            };
+            return {
+                rowId: `${testCase.id}::${model.id}`, caseId: testCase.id,
+                language: testCase.language, task: testCase.task,
+                modelId: model.id, provider: model.provider, apiModel: model.apiModel,
+                input: modelInput, promptDigest: benchmarkDigest(modelInput.prompt),
+                router: {
+                    eligible: disposition.rejectionReason === null, rejectionReason: disposition.rejectionReason,
+                    rank: disposition.rank, selected: item.decision.primaryModelId === model.id,
+                    taskKind: item.profile.kind, needsCurrentInformation: item.profile.needsCurrentInformation,
+                    originalRequestOutputCapTokens: item.caps.routerRequestOutputCapTokens,
+                    originalReservedInputTokens: item.caps.routerReservedInputTokens,
+                    originalInputEstimateBasis: "existing_diagnostic_utf8_bytes_divided_by_four",
+                    originalFittedOutputTokens: disposition.routerOutputTokens,
+                },
+                benchmarkEligibility: { eligible: reasons.length === 0, reasons, basis: "declared_fixture_requirements_not_router_inference", runtimeEligibility: "unverified" },
+                callConfig, callConfigDigest: benchmarkDigest(canonicalBenchmarkJson(callConfig)),
+                plannedTokenCostUsdEstimate: reasons.length === 0 && fit.kind === "fitted"
+                    ? (reservedInputTokens * pricing.inputUsdPerMillionTokens + fit.outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000 : null,
+            };
+        });
+    });
+    const eligibleRows = rows.filter((row) => row.benchmarkEligibility.eligible);
+    const body = {
+        schemaVersion: DEVELOPMENT_PLAN_VERSION, purpose: "development-only" as const,
+        corpusId: corpus.corpusId, corpusDigest: benchmarkDigest(canonicalBenchmarkJson(corpus)),
+        createdAt: input.createdAt, source: input.source,
+        catalogueDigest: benchmarkDigest(canonicalBenchmarkJson(manifest)),
+        versions: { grader: DEVELOPMENT_GRADER_VERSION, diagnostic: ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION, callLimits: CALL_LIMIT_PROFILE_VERSION, estimator: ACTIVE_ESTIMATOR_VERSION, router: diagnostic.routerVersions },
+        inputs: { plan: input.plan, requestedModelId: input.requestedModelId, catalogueSource: "lib/models.ts static catalogue", searchBackendReadiness: "unverified_no_backend_assumed_ready", credits: "unverified", health: "unverified", region: "unverified", stickyState: "none" },
+        models: manifest, rows,
+        byCase: corpus.cases.map((item) => {
+            const caseRows = rows.filter((row) => row.caseId === item.id);
+            return {
+                caseId: item.id, catalogueRows: caseRows.length,
+                plannedCalls: caseRows.filter((row) => row.benchmarkEligibility.eligible).length,
+                refusedRows: caseRows.filter((row) => !row.benchmarkEligibility.eligible).length,
+                routerInferredSearch: caseRows[0]?.router.needsCurrentInformation ?? false,
+                eligibilityMismatchRows: caseRows.filter((row) => row.router.eligible !== row.benchmarkEligibility.eligible).length,
+                refusalReasons: [...new Set(caseRows.flatMap((row) => row.benchmarkEligibility.reasons))].sort(),
+            };
+        }),
+        summary: {
+            cases: corpus.cases.length, catalogueModels: models.length, catalogueRows: rows.length,
+            plannedCalls: eligibleRows.length, refusedRows: rows.length - eligibleRows.length,
+            routerInferenceMismatchCases: diagnostic.items.filter((item) => item.profile.needsCurrentInformation).map((item) => item.itemId),
+            routerEligibilityMismatchRows: rows.filter((row) => row.router.eligible !== row.benchmarkEligibility.eligible).length,
+            completedActualGenerations: 0, incurredProviderSpendUsd: 0,
+            plannedTokenCostUsdEstimate: eligibleRows.reduce((sum, row) => sum + row.plannedTokenCostUsdEstimate!, 0),
+        },
+        limitations: [
+            "Synthetic DEVELOPMENT FIXTURE/CANDIDATE corpus; not human-adopted ROUTE-01 evidence.",
+            "Static eligibility is conditional on the specified plan; runtime registry, credits, provider budget, health, regional access and account permissions are unverified.",
+            "All catalogue rows are retained. The product's original cap/filter outcome is not replaced by the proposed per-model answer cap and prompt estimate.",
+            "Benchmark admission reuses the candidate filter with validated fixture requirements, not the Router's inferred search profile. Any disagreement stays visible; this is not product dispatch admission.",
+            "Search, attachments and tools are unsupported in v1; intrinsic search models are retained as refused rows.",
+            "The proposed cap uses resolveCallLimit(model, answer) and the product context fitter. No provider request is constructed; settings, provider versions and execution remain unverified.",
+            "Token costs are estimates at the proposed output cap, not bills, spending authorization, or guaranteed maxima. Provider tokenization, wrappers, caching and execution may differ.",
+            "Offline rescoring requires the same corpus, source bytes and resolved planning snapshot. Changed versions or prices are refused, never silently rerouted or repriced.",
+            "No calls, quality intervals, band changes, or release verdicts are produced.",
+        ],
+    };
+    return { ...body, planDigest: benchmarkDigest(canonicalBenchmarkJson(body)) };
+}
+
+export type DevelopmentPlan = ReturnType<typeof buildDevelopmentPlan>;
+
+/** Conservative v1: re-derive a frozen plan only from the exact trusted source/corpus snapshot. */
+export function validateDevelopmentPlan(value: unknown, input: Omit<DevelopmentPlanInput, "createdAt" | "plan" | "requestedModelId">): DevelopmentPlan {
+    canonicalBenchmarkJson(value);
+    const saved = strictBenchmarkObject(value, ["schemaVersion", "purpose", "corpusId", "corpusDigest", "createdAt", "source", "catalogueDigest", "versions", "inputs", "models", "rows", "byCase", "summary", "limitations", "planDigest"], "plan");
+    if (saved.schemaVersion !== DEVELOPMENT_PLAN_VERSION || saved.purpose !== "development-only") throw new Error("plan_version_or_purpose");
+    if (canonicalBenchmarkJson(saved.source) !== canonicalBenchmarkJson(input.source)) throw new Error("plan_source_snapshot_mismatch_use_original_checkout");
+    const options = strictBenchmarkObject(saved.inputs, ["plan", "requestedModelId", "catalogueSource", "searchBackendReadiness", "credits", "health", "region", "stickyState"], "plan.inputs");
+    if (typeof saved.createdAt !== "string" || typeof options.requestedModelId !== "string") throw new Error("plan_input_invalid");
+    const expected = buildDevelopmentPlan({ ...input, createdAt: saved.createdAt, plan: options.plan as DevelopmentPlanInput["plan"], requestedModelId: options.requestedModelId });
+    if (canonicalBenchmarkJson(saved) !== canonicalBenchmarkJson(expected)) throw new Error("plan_snapshot_mismatch");
+    return expected;
+}
diff --git a/package.json b/package.json
index 95518091..486391cc 100644
--- a/package.json
+++ b/package.json
@@ -214,6 +214,8 @@
     "notify:voice-price-reverification": "node --import tsx scripts/notify-voice-price-reverification.mjs",
     "report:router-judge-comparison": "node --import tsx scripts/report-router-judge-comparison.mjs",
     "report:router-full-catalog": "node --import tsx scripts/report-router-full-catalog.mjs",
+    "benchmark:router": "node --import tsx scripts/router-development-benchmark.mjs",
+    "test:router-development-benchmark": "node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/routerDevelopmentBenchmark.test.mjs tests/routerDevelopmentBenchmarkCli.test.mjs tests/routerDevelopmentBenchmarkCorpus.test.mjs",
     "cross-review": "node --import tsx scripts/cross-review.mjs"
   },
   "dependencies": {
diff --git a/scripts/router-development-benchmark.mjs b/scripts/router-development-benchmark.mjs
new file mode 100644
index 00000000..544d41e1
--- /dev/null
+++ b/scripts/router-development-benchmark.mjs
@@ -0,0 +1,91 @@
+// Offline only. No provider SDK, registry reader, credentials, or live mode.
+import { closeSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
+import { execFileSync } from "node:child_process";
+import { dirname, resolve } from "node:path";
+import { fileURLToPath } from "node:url";
+import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
+import { benchmarkDigest, DEVELOPMENT_LIMITS, parseBenchmarkJson, parseDevelopmentCorpus, scoreDevelopmentResults } from "../lib/routerDevelopmentBenchmark.ts";
+import { buildDevelopmentPlan, validateDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";
+
+const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
+const sourceFiles = [
+  "scripts/router-development-benchmark.mjs", "lib/routerDevelopmentBenchmark.ts", "lib/routerDevelopmentBenchmarkPlan.ts",
+  "lib/models.ts", "lib/modelPricing.ts", "lib/routerCallLimits.ts", "lib/routerFullCatalogDiagnostic.ts",
+  "lib/routerCandidates.ts", "lib/routerDecision.ts", "lib/routerSelection.ts", "lib/routerScorePolicy.ts",
+  "lib/routerCostSignal.ts", "lib/chatContextWindow.ts", "lib/chatTokenEstimate.ts", "lib/taskProfileCore.ts",
+  "lib/webSearchCapability.ts", "lib/webSearchBackends.ts", "lib/webSearchSuggestion.ts", "lib/modelFinder.ts", "lib/autoFallbackGate.ts", "lib/routingFallbackPolicy.ts",
+  "package.json", "package-lock.json", "tsconfig.json",
+].sort();
+
+function readBoundedJson(path, maximum) {
+  const descriptor = openSync(resolve(path), "r");
+  try {
+    const stat = fstatSync(descriptor);
+    if (!stat.isFile() || stat.size > maximum) throw new Error("input_file_size_or_type");
+    const buffer = Buffer.alloc(maximum + 1);
+    let size = 0;
+    while (size < buffer.length) {
+      const read = readSync(descriptor, buffer, size, buffer.length - size, null);
+      if (!read) break;
+      size += read;
+    }
+    if (size > maximum) throw new Error("input_file_byte_limit");
+    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
+  } finally { closeSync(descriptor); }
+}
+
+function main() {
+  const options = new Map();
+  const allowed = new Set(["mode", "corpus", "plan", "requested-model", "plan-file", "answers", "output", "help"]);
+  for (const argument of process.argv.slice(2)) {
+    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
+    if (!match || !allowed.has(match[1])) throw new Error("unknown_argument_no_live_mode");
+    if (options.has(match[1])) throw new Error("duplicate_argument");
+    if (match[1] !== "help" && !match[2]) throw new Error("argument_requires_equals_value");
+    options.set(match[1], match[2] ?? true);
+  }
+  if (options.has("help")) {
+    if (options.size !== 1) throw new Error("help_must_be_used_alone");
+    console.log("Development fixtures only; no provider calls or credentials.\n" +
+      "npm run benchmark:router -- [--mode=dry-run] [--corpus=PATH] [--plan=Pro] [--requested-model=ID] [--output=NEW_PATH]\n" +
+      "npm run benchmark:router -- --mode=score --plan-file=PATH --answers=PATH [--corpus=PATH] [--output=NEW_PATH]\n" +
+      "Output defaults to stdout. Existing output files are refused. Score requires the original source/corpus/planning snapshot.");
+    return;
+  }
+  const mode = options.get("mode") ?? "dry-run";
+  if (mode !== "dry-run" && mode !== "score") throw new Error("unsupported_mode_only_dry_run_or_score");
+  if (mode === "dry-run" && (options.has("plan-file") || options.has("answers"))) throw new Error("score_arguments_in_dry_run");
+  if (mode === "score" && (!options.has("plan-file") || !options.has("answers") || options.has("plan") || options.has("requested-model"))) throw new Error("score_requires_plan_file_and_answers_no_overrides");
+  // Environment overrides affect existing pricing helpers. V1 never silently reads them.
+  if (Object.keys(process.env).some((key) => /^CHAT_MODEL_.*_(INPUT_USD_PER_MILLION|OUTPUT_USD_PER_MILLION|CACHED_INPUT_PRICE_MULTIPLIER|MAX_OUTPUT_TOKENS|RESERVATION_OUTPUT_TOKENS)$/i.test(key))) throw new Error("pricing_environment_overrides_unsupported_v1");
+  const corpusPath = options.get("corpus") ?? resolve(root, "docs/ops/router-development-benchmark/development-v1.json");
+  const corpus = parseDevelopmentCorpus(readBoundedJson(corpusPath, DEVELOPMENT_LIMITS.corpusBytes));
+  const source = {
+    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
+    dirty: execFileSync("git", ["status", "--porcelain", "--", ...sourceFiles], { cwd: root, encoding: "utf8" }).trim().length > 0,
+    files: Object.fromEntries(sourceFiles.map((path) => [path, benchmarkDigest(readFileSync(resolve(root, path), "utf8"))])),
+  };
+  const common = { corpus, models: AVAILABLE_MODELS, source };
+  let output;
+  if (mode === "dry-run") {
+    output = buildDevelopmentPlan({ ...common, plan: options.get("plan") ?? "Pro", requestedModelId: options.get("requested-model") ?? DEFAULT_MODEL_ID, createdAt: new Date().toISOString() });
+  } else {
+    const plan = validateDevelopmentPlan(parseBenchmarkJson(readBoundedJson(options.get("plan-file"), DEVELOPMENT_LIMITS.documentBytes)), common);
+    output = scoreDevelopmentResults(corpus, plan, parseBenchmarkJson(readBoundedJson(options.get("answers"), DEVELOPMENT_LIMITS.documentBytes)));
+  }
+  const serialized = `${JSON.stringify(output, null, 2)}\n`;
+  if (options.has("output")) {
+    const destination = resolve(options.get("output"));
+    // Exclusive creation: accidental reruns never overwrite earlier evidence.
+    writeFileSync(destination, serialized, { flag: "wx", encoding: "utf8" });
+    console.log(JSON.stringify({ mode, output: destination, summary: output.summary }));
+  } else process.stdout.write(serialized);
+}
+
+try { main(); }
+catch (error) {
+  // File contents, malformed input, environment values and provider credentials are never echoed.
+  const message = error instanceof Error ? error.message : "benchmark_failed";
+  console.error(`router-development-benchmark: ${/^[a-zA-Z0-9_.:-]+$/.test(message) ? message : "input_or_output_error"}`);
+  process.exitCode = 1;
+}
diff --git a/tests/routerDevelopmentBenchmark.test.mjs b/tests/routerDevelopmentBenchmark.test.mjs
new file mode 100644
index 00000000..34c40a98
--- /dev/null
+++ b/tests/routerDevelopmentBenchmark.test.mjs
@@ -0,0 +1,221 @@
+import assert from "node:assert/strict";
+import { readFileSync } from "node:fs";
+import { dirname, resolve } from "node:path";
+import { fileURLToPath } from "node:url";
+import test from "node:test";
+import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
+import { resolveCallLimit } from "../lib/routerCallLimits.ts";
+import { diagnoseFullCatalog } from "../lib/routerFullCatalogDiagnostic.ts";
+import { NO_WEB_SEARCH_BACKENDS } from "../lib/webSearchBackends.ts";
+import {
+  benchmarkDigest, canonicalBenchmarkJson, DEVELOPMENT_LIMITS, gradeDevelopmentAnswer,
+  modelInputForCase, parseBenchmarkJson, parseDevelopmentCorpus, scoreDevelopmentResults,
+  strictBenchmarkObject, validateDevelopmentCorpus, validateDevelopmentResults,
+} from "../lib/routerDevelopmentBenchmark.ts";
+import { buildDevelopmentPlan, validateDevelopmentPlan } from "../lib/routerDevelopmentBenchmarkPlan.ts";
+
+const corpus = parseDevelopmentCorpus(readFileSync(new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url), "utf8"));
+const source = { commit: "a".repeat(40), dirty: true, files: { fixture: "b".repeat(64) } };
+const models = AVAILABLE_MODELS.filter((model) => [DEFAULT_MODEL_ID, "gpt-5-4-mini", "claude-fable-5", "kimi-k3"].includes(model.id));
+const input = { corpus, models, source, requestedModelId: DEFAULT_MODEL_ID, plan: "Pro", createdAt: "2026-09-10T00:00:00.000Z" };
+const plan = buildDevelopmentPlan(input);
+const eligible = plan.rows.filter((row) => row.benchmarkEligibility.eligible);
+const emptyResults = () => ({ schemaVersion: "router-development-results-v1", purpose: "development-only", planDigest: plan.planDigest, corpusDigest: plan.corpusDigest, origin: { kind: "synthetic-fixture", description: "Unit-test answers; no provider was called." }, rows: [] });
+const savedRow = (row = eligible[0], overrides = {}) => {
+  const answerText = JSON.stringify(corpus.cases.find((item) => item.id === row.caseId).expected);
+  return { rowId: row.rowId, caseId: row.caseId, modelId: row.modelId, provider: row.provider, apiModel: row.apiModel, promptDigest: row.promptDigest, callConfigDigest: row.callConfigDigest, status: "succeeded", answerText, answerDigest: benchmarkDigest(answerText), failureCode: null, recordedAt: null, providerResponseId: null, modelVersion: null, metrics: { inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null }, ...overrides };
+};
+
+test("semantic grading accepts whitespace and object order, including equivalent numeric syntax", () => {
+  const item = { expected: { a: 2, b: { k: [true, null, "한국"] } } };
+  assert.deepEqual(gradeDevelopmentAnswer(item, ' { "b": {"k":[true,null,"한국"]}, "a": 2.0 } '), { pass: true, reason: "exact_match" });
+});
+
+test("wrong values, omission, extra keys, array order, types and unicode remain wrong", () => {
+  const item = { expected: { value: [1, 2], label: "é", missing: null } };
+  for (const answer of [
+    { value: [1, 9], label: "é", missing: null }, { value: [1, 2], label: "é" },
+    { ...item.expected, extra: true }, { value: [2, 1], label: "é", missing: null },
+    { value: ["1", 2], label: "é", missing: null }, { ...item.expected, label: "e\u0301" },
+    { ...item.expected, label: " é " }, { ...item.expected, missing: false },
+  ]) assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(answer)).reason, "value_mismatch");
+});
+
+test("blank, prose, fenced JSON and duplicate keys never pass", () => {
+  const item = { expected: { a: 1 } };
+  for (const answer of ["", " \t\r\n"]) assert.equal(gradeDevelopmentAnswer(item, answer).reason, "blank_answer");
+  for (const answer of ['```json\n{"a":1}\n```', 'Answer: {"a":1}', '{"a":9,"a":1}', '{"a":9,"\\u0061":1}', '{"nested":{"a":1,"a":1}}', '{"a":1e999}', '{"a":NaN}', '{"a":01}', '{"a":1,}', '{"a":1}{}']) assert.equal(gradeDevelopmentAnswer(item, answer).reason, "invalid_json");
+});
+
+test("parser bounds input bytes, depth and numeric precision without executing input", () => {
+  assert.throws(() => parseBenchmarkJson('"' + "x".repeat(100) + '"', 10), /byte_limit/);
+  assert.throws(() => parseBenchmarkJson("[".repeat(34) + "0" + "]".repeat(34)), /complexity_limit/);
+  assert.throws(() => parseBenchmarkJson("9007199254740993"), /number_out_of_range/);
+  assert.throws(() => parseBenchmarkJson('process.exit(7)'), /syntax/);
+  assert.equal(gradeDevelopmentAnswer({ expected: { a: 1 } }, '"' + "x".repeat(DEVELOPMENT_LIMITS.answerBytes) + '"').reason, "invalid_json");
+  assert.equal(canonicalBenchmarkJson(parseBenchmarkJson('{"__proto__":{"polluted":true}}')), '{"__proto__":{"polluted":true}}');
+  assert.equal({}.polluted, undefined);
+});
+
+test("decimal precision loss and underflow are invalid instead of a rounded exact match", () => {
+  const item = { expected: { available: 14, removedFromUsable: 11 } };
+  assert.equal(gradeDevelopmentAnswer(item, '{"available":14.0000000000000001,"removedFromUsable":11}').reason, "invalid_json");
+  assert.equal(gradeDevelopmentAnswer(item, '{"available":1.4e1,"removedFromUsable":11.0}').reason, "exact_match");
+  assert.equal(gradeDevelopmentAnswer({ expected: { n: 0 } }, '{"n":1e-999}').reason, "invalid_json");
+  assert.equal(gradeDevelopmentAnswer({ expected: { n: 0.1 } }, '{"n":0.10000000000000001}').reason, "invalid_json");
+  assert.equal(gradeDevelopmentAnswer({ expected: { n: 0.1 } }, '{"n":1e-1}').reason, "exact_match");
+});
+
+test("strict schema cannot collide through a NUL-containing key", () => {
+  assert.throws(() => strictBenchmarkObject({ "a\0b": 1 }, ["a", "b"], "test"), /unexpected_or_missing/);
+});
+
+test("corpus rejects duplicates, unsupported requirements, unknown fields and malformed expectations", () => {
+  const mutations = [
+    (copy) => copy.cases.pop(), (copy) => { copy.cases[1].id = copy.cases[0].id; },
+    (copy) => { copy.cases[1].prompt = copy.cases[0].prompt; },
+    (copy) => { copy.cases[0].requirements.needsSearch = true; },
+    (copy) => { copy.cases[0].requirements.attachments.push({ mediaType: "image/png" }); },
+    (copy) => { copy.cases[0].requirements.tools.push("calculator"); },
+    (copy) => { copy.cases[0].grading.arrayOrder = "unordered"; },
+    (copy) => { copy.cases[0].grading.stringNormalization = "trim"; },
+    (copy) => { copy.cases[0].expected = []; }, (copy) => { copy.cases[0].expected = { x: Infinity }; },
+    (copy) => { copy.cases[0].extra = true; }, (copy) => { copy.purpose = "decision"; },
+  ];
+  for (const mutate of mutations) { const copy = structuredClone(corpus); mutate(copy); assert.throws(() => validateDevelopmentCorpus(copy)); }
+});
+
+test("full catalogue matrix keeps disabled, missing context and intrinsic search rows", () => {
+  const full = buildDevelopmentPlan({ ...input, models: AVAILABLE_MODELS });
+  assert.equal(full.rows.length, 24 * AVAILABLE_MODELS.length);
+  for (const item of corpus.cases) assert.deepEqual(full.rows.filter((row) => row.caseId === item.id).map((row) => row.modelId), AVAILABLE_MODELS.map((model) => model.id).sort());
+  assert.ok(full.rows.some((row) => row.router.rejectionReason === "disabled"));
+  assert.ok(full.rows.some((row) => row.benchmarkEligibility.reasons.includes("benchmark:context_window_undeclared")));
+  assert.ok(full.rows.some((row) => row.benchmarkEligibility.reasons.includes("benchmark:intrinsic_search_model_unsupported_v1")));
+  assert.equal(full.summary.completedActualGenerations, 0);
+  assert.equal(full.summary.incurredProviderSpendUsd, 0);
+  assert.equal(full.summary.plannedCalls + full.summary.refusedRows, full.summary.catalogueRows);
+});
+
+test("plan is deterministic, binds exact corpus, and exports only prompt as model input", () => {
+  assert.deepEqual(plan, buildDevelopmentPlan({ ...input, models: [...models].reverse() }));
+  assert.deepEqual(validateDevelopmentPlan(plan, { corpus, models, source }), plan);
+  for (const row of plan.rows) {
+    assert.deepEqual(Object.keys(row.input), ["prompt"]);
+    assert.deepEqual(row.input, modelInputForCase(corpus.cases.find((item) => item.id === row.caseId)));
+  }
+  assert.ok(!JSON.stringify(plan).includes('"expected":'));
+  const changed = structuredClone(corpus); changed.cases[0].expected.extra = "oracle-change";
+  assert.notEqual(buildDevelopmentPlan({ ...input, corpus: changed }).corpusDigest, plan.corpusDigest);
+  assert.throws(() => validateDevelopmentPlan(plan, { corpus: changed, models, source }), /snapshot_mismatch/);
+});
+
+test("fixture requirements govern benchmark admission while original search-inference refusals remain visible", () => {
+  const full = buildDevelopmentPlan({ ...input, models: AVAILABLE_MODELS });
+  const disagreements = full.rows.filter((row) => row.router.needsCurrentInformation && !row.router.eligible && row.benchmarkEligibility.eligible);
+  assert.ok(disagreements.length > 0);
+  assert.ok(disagreements.every((row) => row.benchmarkEligibility.basis === "declared_fixture_requirements_not_router_inference"));
+  assert.ok(full.summary.routerInferenceMismatchCases.length > 0);
+  assert.ok(full.byCase.every((item) => item.plannedCalls > 0));
+});
+
+test("per-model answer cap preserves product provenance and original router fit separately", () => {
+  const diagnostic = diagnoseFullCatalog({ items: corpus.cases.map((item) => ({ id: item.id, prompt: item.prompt })), models, requestedModelId: DEFAULT_MODEL_ID, plan: "Pro", searchBackendReadiness: NO_WEB_SEARCH_BACKENDS, now: () => Date.parse(input.createdAt) });
+  for (const row of plan.rows) {
+    const original = diagnostic.items.find((item) => item.itemId === row.caseId);
+    assert.equal(row.router.originalRequestOutputCapTokens, original.caps.routerRequestOutputCapTokens);
+    assert.equal(row.router.originalReservedInputTokens, original.caps.routerReservedInputTokens);
+    assert.equal(row.router.rejectionReason, original.models.find((model) => model.modelId === row.modelId).rejectionReason);
+    assert.deepEqual(row.callConfig.callLimit, resolveCallLimit(models.find((model) => model.id === row.modelId), "answer"));
+    assert.equal(row.callConfigDigest, benchmarkDigest(canonicalBenchmarkJson(row.callConfig)));
+  }
+  assert.ok(new Set(plan.models.map((model) => model.callLimit.requestedMaxOutputTokens)).size > 1);
+});
+
+test("unknown and duplicate catalogue IDs, forged plans, changed source and unknown plan tiers fail", () => {
+  assert.throws(() => buildDevelopmentPlan({ ...input, models: [models[0], models[0]] }), /duplicate/);
+  assert.throws(() => buildDevelopmentPlan({ ...input, requestedModelId: "missing" }), /unknown_requested_model/);
+  assert.throws(() => buildDevelopmentPlan({ ...input, plan: "Unlimited" }), /tier_invalid/);
+  for (const mutate of [
+    (copy) => { copy.rows[0].benchmarkEligibility.eligible = !copy.rows[0].benchmarkEligibility.eligible; },
+    (copy) => { copy.rows[1] = copy.rows[0]; }, (copy) => { copy.rows[0].modelId = "forged"; },
+    (copy) => { copy.summary.plannedCalls = 1; }, (copy) => { copy.planDigest = "c".repeat(64); },
+    (copy) => { copy.rows[0].callConfig.proposedMaxOutputTokens = 2048; },
+  ]) { const copy = structuredClone(plan); mutate(copy); assert.throws(() => validateDevelopmentPlan(copy, { corpus, models, source }), /snapshot_mismatch/); }
+  assert.throws(() => validateDevelopmentPlan(plan, { corpus, models, source: { ...source, commit: "c".repeat(40) } }), /source_snapshot_mismatch/);
+});
+
+test("no results means not_run and null correctness/metrics, never pass or tie", () => {
+  const score = scoreDevelopmentResults(corpus, plan, emptyResults());
+  assert.equal(score.summary.notRun, eligible.length);
+  assert.equal(score.summary.passed, 0);
+  assert.equal(score.summary.failed, 0);
+  assert.equal(score.summary.correctnessRate, null);
+  assert.equal(score.summary.correctShareOfPlanned, null);
+  assert.equal(score.summary.coverage, 0);
+  assert.equal(score.reportedMetrics.providerCostUsd.total, null);
+});
+
+test("partial and complete scoring keep failures/invalid/blank in the planned denominator", () => {
+  const results = emptyResults(); results.rows = [savedRow()];
+  const partial = scoreDevelopmentResults(corpus, plan, results);
+  assert.equal(partial.summary.correctnessRate, null);
+  assert.equal(partial.summary.notRun, eligible.length - 1);
+  assert.equal(partial.summary.correctShareOfPlanned, 1 / eligible.length);
+  results.rows = eligible.map((row) => savedRow(row));
+  const complete = scoreDevelopmentResults(corpus, plan, results);
+  assert.equal(complete.summary.correctnessRate, 1);
+  assert.equal(complete.verifiedActualGenerations, 0);
+  const texts = ["", "not JSON", "{}"]; texts.forEach((answerText, i) => { results.rows[i] = savedRow(eligible[i], { answerText, answerDigest: benchmarkDigest(answerText) }); });
+  results.rows[3] = savedRow(eligible[3], { status: "failed", answerText: null, answerDigest: null, failureCode: "provider_error" });
+  results.rows[4] = savedRow(eligible[4], { status: "timeout", answerText: null, answerDigest: null, failureCode: "timeout" });
+  const score = scoreDevelopmentResults(corpus, plan, results);
+  for (const field of ["blank", "invalidJson", "incorrect", "failed", "timeout"]) assert.equal(score.summary[field], 1);
+  assert.equal(score.summary.planned, eligible.length);
+  assert.equal(score.summary.correctnessRate, (eligible.length - 5) / eligible.length);
+});
+
+test("saved result rows reject unknown, duplicate, forged and extra fields", () => {
+  for (const mutate of [
+    (results) => results.rows.push(results.rows[0]),
+    (results) => { results.rows[0].rowId = "unknown::model"; },
+    ...["caseId", "modelId", "provider", "apiModel", "promptDigest", "callConfigDigest", "answerDigest"].map((key) => (results) => { results.rows[0][key] = "forged"; }),
+    (results) => { delete results.rows[0].metrics.latencyMs; },
+    (results) => { results.rows[0].metrics.providerCostUsd = -1; },
+    (results) => { results.rows[0].extra = true; },
+    (results) => { results.planDigest = "d".repeat(64); },
+    (results) => { results.rows[0].status = "not_run"; },
+    (results) => { results.rows[0].failureCode = "failed"; },
+    (results) => { results.rows[0].metrics.inputTokens = 100; },
+  ]) { const results = emptyResults(); results.rows = [savedRow()]; mutate(results); assert.throws(() => validateDevelopmentResults(results, plan)); }
+});
+
+test("external saved records remain self-reported, missing metrics remain null and rescore is deterministic", () => {
+  const results = emptyResults(); results.origin = { kind: "externally-saved", description: "Imported from a separately authorized run; not authenticated here." };
+  results.rows = [savedRow(eligible[0], { recordedAt: "2026-09-10T00:01:00.000Z", metrics: { inputTokens: 50, outputTokens: 20, latencyMs: 120, providerCostUsd: 0.01 } }), savedRow(eligible[1], { recordedAt: "2026-09-10T00:01:02.000Z" })];
+  const score = scoreDevelopmentResults(corpus, plan, results);
+  assert.equal(score.evidenceStatus, "self_reported_saved_answers_unverified");
+  assert.equal(score.verifiedActualGenerations, 0);
+  assert.equal(score.reportedMetrics.providerCostUsd.observedRows, 1);
+  assert.equal(score.reportedMetrics.providerCostUsd.total, null);
+  assert.deepEqual(scoreDevelopmentResults(corpus, plan, structuredClone(results)), score);
+});
+
+test("the benchmark's transitive production import graph has no provider dispatch or I/O modules", () => {
+  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
+  const pending = ["lib/routerDevelopmentBenchmark.ts", "lib/routerDevelopmentBenchmarkPlan.ts"];
+  const seen = new Set();
+  while (pending.length) {
+    const path = pending.pop(); if (seen.has(path)) continue; seen.add(path);
+    const text = readFileSync(resolve(root, path), "utf8");
+    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^import\s+type\b[\s\S]*?;/gm, "");
+    for (const match of code.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
+      const specifier = match[1];
+      if (specifier === "node:crypto") continue;
+      assert.ok(specifier.startsWith("./") || specifier.startsWith("@/lib/"), `${path} imports non-pure ${specifier}`);
+      const target = specifier.startsWith("@/") ? specifier.slice(2) : resolve(dirname(resolve(root, path)), specifier).slice(root.length + 1).replaceAll("\\", "/");
+      pending.push(target.endsWith(".ts") ? target : `${target}.ts`);
+    }
+    assert.doesNotMatch(code, /\b(?:fetch|generateText|streamText|getActiveAiModel|eval)\s*\(/, path);
+  }
+});
diff --git a/tests/routerDevelopmentBenchmarkCli.test.mjs b/tests/routerDevelopmentBenchmarkCli.test.mjs
new file mode 100644
index 00000000..c283461d
--- /dev/null
+++ b/tests/routerDevelopmentBenchmarkCli.test.mjs
@@ -0,0 +1,99 @@
+import assert from "node:assert/strict";
+import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { basename, dirname, join, resolve } from "node:path";
+import { fileURLToPath, pathToFileURL } from "node:url";
+import { spawnSync } from "node:child_process";
+import test, { after } from "node:test";
+import { benchmarkDigest } from "../lib/routerDevelopmentBenchmark.ts";
+
+const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
+const temporary = mkdtempSync(join(tmpdir(), "router-development-benchmark-"));
+after(() => {
+  const target = resolve(temporary);
+  assert.equal(dirname(target), resolve(tmpdir()));
+  assert.ok(basename(target).startsWith("router-development-benchmark-"));
+  rmSync(target, { recursive: true });
+});
+const trap = join(temporary, "no-network.mjs");
+// A local test preload makes accidental network attempts fail, even with credentials present.
+writeFileSync(trap, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import { syncBuiltinESMExports } from 'node:module';
+const refused = () => { throw new Error('FORBIDDEN_PROVIDER_OR_NETWORK_CALL'); };
+globalThis.fetch = refused; http.request = refused; http.get = refused; https.request = refused; https.get = refused; net.connect = refused; net.createConnection = refused; net.Socket.prototype.connect = refused; tls.connect = refused; dgram.createSocket = refused; syncBuiltinESMExports();\n`);
+const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CHAT_MODEL_/i.test(key)));
+const run = (args, overrides = {}) => spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(trap).href, "scripts/router-development-benchmark.mjs", ...args], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...cleanEnvironment, OPENAI_API_KEY: "test-only-not-a-real-key", ...overrides } });
+const planPath = join(temporary, "plan.json");
+let plan;
+
+test("CLI defaults to offline full matrix and writes a new plan with no provider traffic", () => {
+  const before = readdirSync(temporary).sort();
+  const result = run([`--output=${planPath}`]);
+  assert.equal(result.status, 0, result.stderr);
+  plan = JSON.parse(readFileSync(planPath, "utf8"));
+  assert.equal(plan.inputs.plan, "Pro");
+  assert.equal(plan.inputs.requestedModelId, "gpt-5-6-luna");
+  assert.equal(plan.summary.cases, 24);
+  assert.equal(plan.summary.catalogueRows, 24 * plan.models.length);
+  assert.equal(plan.summary.completedActualGenerations, 0);
+  assert.equal(plan.summary.incurredProviderSpendUsd, 0);
+  assert.ok(plan.byCase.every((item) => item.plannedCalls > 0));
+  assert.deepEqual(readdirSync(temporary).sort(), [...before, "plan.json"].sort());
+});
+
+test("CLI refuses live/unknown/ambiguous arguments before work", () => {
+  for (const args of [["--live"], ["--mode=live"], ["--mode=pilot"], ["--send"], ["--mode=dry-run", "--mode=score"], ["--output"], ["--plan=Unlimited"], ["--requested-model=unknown-model"], ["--mode=score"], ["--answers=missing"], ["--help", "--output=x"]]) {
+    const result = run(args);
+    assert.equal(result.status, 1, JSON.stringify(args));
+    assert.ok(!result.stderr.includes("test-only-not-a-real-key"));
+  }
+  assert.equal(run(["--help"]).status, 0);
+});
+
+test("CLI refuses accidental overwrite and pricing environment overrides", () => {
+  const original = readFileSync(planPath, "utf8");
+  assert.equal(run([`--output=${planPath}`]).status, 1);
+  assert.equal(readFileSync(planPath, "utf8"), original);
+  const result = run(["--help"], { CHAT_MODEL_GPT_5_6_LUNA_MAX_OUTPUT_TOKENS: "2048" });
+  assert.equal(result.status, 0); // Help never reads a catalogue or pricing.
+  const overridden = run([], { CHAT_MODEL_GPT_5_6_LUNA_MAX_OUTPUT_TOKENS: "2048" });
+  assert.equal(overridden.status, 1);
+  assert.match(overridden.stderr, /pricing_environment_overrides_unsupported/);
+  const lowercase = run([], { chat_model_gpt_5_6_luna_input_usd_per_million: "123" });
+  assert.equal(lowercase.status, 1);
+  assert.match(lowercase.stderr, /pricing_environment_overrides_unsupported/);
+});
+
+test("CLI grades saved fixtures offline and keeps missing coverage explicit", () => {
+  const corpus = JSON.parse(readFileSync(join(root, "docs/ops/router-development-benchmark/development-v1.json"), "utf8"));
+  const selected = plan.rows.find((row) => row.benchmarkEligibility.eligible);
+  const answerText = JSON.stringify(corpus.cases.find((item) => item.id === selected.caseId).expected);
+  const answers = { schemaVersion: "router-development-results-v1", purpose: "development-only", corpusDigest: plan.corpusDigest, planDigest: plan.planDigest, origin: { kind: "synthetic-fixture", description: "CLI test only; no provider output." }, rows: [{ rowId: selected.rowId, caseId: selected.caseId, modelId: selected.modelId, provider: selected.provider, apiModel: selected.apiModel, promptDigest: selected.promptDigest, callConfigDigest: selected.callConfigDigest, status: "succeeded", answerText, answerDigest: benchmarkDigest(answerText), failureCode: null, recordedAt: null, providerResponseId: null, modelVersion: null, metrics: { inputTokens: null, outputTokens: null, latencyMs: null, providerCostUsd: null } }] };
+  const answersPath = join(temporary, "answers.json");
+  writeFileSync(answersPath, JSON.stringify(answers));
+  const scorePath = join(temporary, "score.json");
+  const result = run(["--mode=score", `--plan-file=${planPath}`, `--answers=${answersPath}`, `--output=${scorePath}`]);
+  assert.equal(result.status, 0, result.stderr);
+  const score = JSON.parse(readFileSync(scorePath, "utf8"));
+  assert.equal(score.summary.passed, 1);
+  assert.equal(score.summary.notRun, plan.summary.plannedCalls - 1);
+  assert.equal(score.summary.correctnessRate, null);
+  assert.equal(score.summary.failed, 0);
+  assert.equal(score.reportedMetrics.providerCostUsd.total, null);
+  assert.equal(score.providerCallsByThisTool, 0);
+  assert.equal(score.evidenceStatus, "fixture_validation_only");
+  assert.equal(run(["--mode=score", `--plan-file=${planPath}`, `--answers=${answersPath}`, `--output=${scorePath}`]).status, 1);
+  const duplicatePath = join(temporary, "duplicate.json");
+  writeFileSync(duplicatePath, JSON.stringify({ ...answers, rows: [...answers.rows, ...answers.rows] }));
+  assert.equal(run(["--mode=score", `--plan-file=${planPath}`, `--answers=${duplicatePath}`]).status, 1);
+  const forgedPath = join(temporary, "forged-plan.json");
+  writeFileSync(forgedPath, JSON.stringify({ ...plan, summary: { ...plan.summary, plannedCalls: 1 } }));
+  assert.equal(run(["--mode=score", `--plan-file=${forgedPath}`, `--answers=${answersPath}`]).status, 1);
+});
+
+test("CLI rejects malformed UTF-8, oversized input and duplicate JSON keys", () => {
+  for (const [name, bytes] of [["invalid-utf8.json", Buffer.from([0xff])], ["too-big.json", Buffer.alloc(1_048_577, 32)], ["duplicate-keys.json", Buffer.from('{"schemaVersion":"x","schemaVersion":"x"}')]]) {
+    const path = join(temporary, name); writeFileSync(path, bytes);
+    const result = run([`--corpus=${path}`]);
+    assert.equal(result.status, 1);
+  }
+});
diff --git a/tests/routerDevelopmentBenchmarkCorpus.test.mjs b/tests/routerDevelopmentBenchmarkCorpus.test.mjs
new file mode 100644
index 00000000..759a6ac3
--- /dev/null
+++ b/tests/routerDevelopmentBenchmarkCorpus.test.mjs
@@ -0,0 +1,310 @@
+import assert from "node:assert/strict";
+import { readFileSync } from "node:fs";
+import test from "node:test";
+
+import {
+  gradeDevelopmentAnswer,
+  modelInputForCase,
+  parseDevelopmentCorpus,
+} from "../lib/routerDevelopmentBenchmark.ts";
+
+const corpus = parseDevelopmentCorpus(readFileSync(
+  new URL("../docs/ops/router-development-benchmark/development-v1.json", import.meta.url),
+  "utf8",
+));
+
+// Separately encoded source facts and derivations, authored by the same agent
+// as the corpus; this is not an independent human review. These functions do not
+// read expected. Anchors fail if relevant prompt facts change without updating
+// the explanation. See the README inventory.
+const derivations = {
+  "dev-en-extract-01": {
+    why: "Select dispatched AND North Dock; preserve label order and convert yes to true.",
+    anchors: ["shipment S-41, destination North Dock, status dispatched, fragile yes, labels [glass, blue]", "shipment S-42, destination South Dock", "shipment S-43, destination North Dock, status queued"],
+    derive: () => {
+      const rows = [
+        { shipmentId: "S-41", destination: "North Dock", status: "dispatched", fragile: "yes", labels: ["glass", "blue"] },
+        { shipmentId: "S-42", destination: "South Dock", status: "dispatched" },
+        { shipmentId: "S-43", destination: "North Dock", status: "queued" },
+      ];
+      const row = rows.find((value) => value.destination === "North Dock" && value.status === "dispatched");
+      return { shipmentId: row.shipmentId, destination: row.destination, fragile: row.fragile === "yes", labels: row.labels };
+    },
+  },
+  "dev-en-extract-02": {
+    why: "The current asset record has Annex/B2 and no custodian; do not inherit the historical custodian.",
+    anchors: ["asset LAMP-7; current yes; location building Annex, room B2; rechargeable no; accessories [stand, shade]; custodian is not recorded", "current no, room A1 and custodian Team Gray"],
+    derive: () => {
+      const current = { asset: "LAMP-7", building: "Annex", room: "B2", rechargeable: "no", accessories: ["stand", "shade"] };
+      return { assetId: current.asset, location: { building: current.building, room: current.room }, rechargeable: current.rechargeable === "yes", accessories: current.accessories, custodian: current.custodian ?? null };
+    },
+  },
+  "dev-en-extract-03": {
+    why: "Elm is the only room with both required flags; seat count is copied, not inferred.",
+    anchors: ["Cedar, available no, stepFree yes", "Elm, available yes, stepFree yes, seats 8, equipment [whiteboard, speaker]", "Ash, available yes, stepFree no"],
+    derive: () => {
+      const rooms = [
+        { room: "Cedar", available: false, stepFree: true },
+        { room: "Elm", available: true, stepFree: true, seats: 8, equipment: ["whiteboard", "speaker"] },
+        { room: "Ash", available: true, stepFree: false },
+      ];
+      const row = rooms.find((value) => value.available && value.stepFree);
+      return { room: row.room, access: { available: row.available, stepFree: row.stepFree }, seats: row.seats, equipment: row.equipment };
+    },
+  },
+  "dev-en-extract-04": {
+    why: "Take T-18's final event; the resolution belongs to T-19 and must not fill T-18's null.",
+    anchors: ["Ticket T-18", "oldest-to-newest order", "status paused, queue Parts, awaitingExternal yes; it has no resolution text", "Separate ticket T-19 is resolved"],
+    derive: () => {
+      const events = [{ status: "opened", queue: "Intake" }, { status: "assigned", queue: "Repairs" }, { status: "paused", queue: "Parts", awaitingExternal: "yes" }];
+      const last = events.at(-1);
+      return { ticketId: "T-18", status: last.status, queue: last.queue, awaitingExternal: last.awaitingExternal === "yes", resolution: last.resolution ?? null };
+    },
+  },
+  "dev-en-extract-05": {
+    why: "Filter explicit vegan and available flags in source order; preserve two spaces inside the note.",
+    anchors: ["Zest bowl, vegan yes, available yes", "Almond tart, vegan yes, available no", "Bean soup, vegan yes, available yes", "Garden pie, vegan no, available yes", "Menu title is Noon List", "Collect  at hatch"],
+    derive: () => {
+      const items = [["Zest bowl", true, true], ["Almond tart", true, false], ["Bean soup", true, true], ["Garden pie", false, true]];
+      return { menu: "Noon List", eligibleItems: items.filter(([, vegan, available]) => vegan && available).map(([name]) => name), serviceNote: "Collect  at hatch" };
+    },
+  },
+  "dev-en-extract-06": {
+    why: "Current v2 explicitly has an empty tag list and no reviewer; old version metadata is irrelevant.",
+    anchors: ["Document MAP-3", "version v1 marked current no", "version v2 is marked current yes, draft no, tags explicitly empty, title River Paths, and no reviewer is recorded"],
+    derive: () => {
+      const versions = [{ version: "v1", current: false, reviewer: "Unit Amber" }, { version: "v2", current: true, draft: false, tags: [], title: "River Paths" }];
+      const row = versions.find((value) => value.current);
+      return { documentId: "MAP-3", version: row.version, title: row.title, draft: row.draft, tags: row.tags, reviewer: row.reviewer ?? null };
+    },
+  },
+  "dev-ko-extract-01": {
+    why: "Match title and loan category, not the reference copy with the same title.",
+    anchors: ["자료 D-8, 제목 빛의 지도, 구분 대출용, 대출가능 예, 서가 동관/3번, 주제 [관측, 기록]", "자료 D-9, 제목 빛의 지도, 구분 참고용"],
+    derive: () => {
+      const records = [{ id: "D-8", title: "빛의 지도", category: "대출용", loanable: "예", wing: "동관", slot: "3번", topics: ["관측", "기록"] }, { id: "D-9", title: "빛의 지도", category: "참고용" }];
+      const row = records.find((value) => value.title === "빛의 지도" && value.category === "대출용");
+      return { id: row.id, title: row.title, loanable: row.loanable === "예", shelf: { wing: row.wing, slot: row.slot }, topics: row.topics };
+    },
+  },
+  "dev-ko-extract-02": {
+    why: "Use declared weekend/open labels and copy materials flags into ordered nested objects.",
+    anchors: ["시간표 이름은 작은 공방", "유리 새, 요일구분 주말, 신청상태 열림, 재료제공 예", "종이 집, 요일구분 평일, 신청상태 열림", "실 매듭, 요일구분 주말, 신청상태 닫힘", "나무 배, 요일구분 주말, 신청상태 열림, 재료제공 아니오"],
+    derive: () => {
+      const rows = [["유리 새", "주말", "열림", "예"], ["종이 집", "평일", "열림", "예"], ["실 매듭", "주말", "닫힘", "아니오"], ["나무 배", "주말", "열림", "아니오"]];
+      return { timetable: "작은 공방", classes: rows.filter(([, day, state]) => day === "주말" && state === "열림").map(([name, , , supplied]) => ({ name, materialsIncluded: supplied === "예" })) };
+    },
+  },
+  "dev-ko-extract-03": {
+    why: "Copy received G-4's nested body and components; G-5's locker is not G-4's locker.",
+    anchors: ["기기 G-4의 기록은 상태 인수완료, 본체 색상 은색, 전원 충전식, 봉인 아니오, 구성품 [본체, 받침대, 안내지]이며 보관함 번호는 기록되지 않았습니다", "기기 G-5는 상태 인수예정"],
+    derive: () => {
+      const row = { id: "G-4", color: "은색", power: "충전식", sealed: "아니오", components: ["본체", "받침대", "안내지"] };
+      return { deviceId: row.id, body: { color: row.color, power: row.power }, sealed: row.sealed === "예", components: row.components, locker: row.locker ?? null };
+    },
+  },
+  "dev-ko-extract-04": {
+    why: "Select confirmed first broadcasts and keep source order, even though time order is different.",
+    anchors: ["채널 이름은 파도", "저녁 창, 편성종류 본방송, 확정 예, 시각 18:40", "새벽 길, 편성종류 재방송, 확정 예", "낮은 숲, 편성종류 본방송, 확정 아니오", "아침 돌, 편성종류 본방송, 확정 예, 시각 07:30"],
+    derive: () => {
+      const rows = [["저녁 창", "본방송", true, "18:40"], ["새벽 길", "재방송", true, "05:10"], ["낮은 숲", "본방송", false, "12:20"], ["아침 돌", "본방송", true, "07:30"]];
+      return { channel: "파도", programmes: rows.filter(([, kind, confirmed]) => kind === "본방송" && confirmed).map(([title, , , time]) => ({ title, time })) };
+    },
+  },
+  "dev-ko-extract-05": {
+    why: "R-2 is sealed with a two-space label; an unrecorded inspection date remains null.",
+    anchors: ["함 R-2, 내용물 모형 조각, 봉인 예", "위  아래", "점검일 미기록", "다른 표찰: 함 R-3"],
+    derive: () => {
+      const label = { id: "R-2", contents: "모형 조각", sealed: "예", text: "위  아래" };
+      return { binId: label.id, contents: label.contents, sealed: label.sealed === "예", label: label.text, inspectionDate: label.inspectionDate ?? null };
+    },
+  },
+  "dev-ko-extract-06": {
+    why: "The issued notice supersedes the draft; empty supplies and a missing end date are different values.",
+    anchors: ["공지 N-6 초안: 발행 아니오", "공지 N-6 확정본: 발행 예, 행사명 작은 전시, 장소 북쪽 홀, 신청필수 아니오, 준비물은 명시적으로 빈 목록, 종료일은 미기록"],
+    derive: () => {
+      const records = [{ published: false, venue: "남쪽 홀" }, { published: true, event: "작은 전시", venue: "북쪽 홀", registration: "아니오", bring: [] }];
+      const row = records.find((value) => value.published);
+      return { noticeId: "N-6", event: row.event, venue: row.venue, registrationRequired: row.registration === "예", bring: row.bring, endDate: row.endDate ?? null };
+    },
+  },
+  "dev-en-calc-01": {
+    why: "18 + 7 - 9 - 2 = 14 available; 9 + 2 = 11 removed.",
+    anchors: ["18 usable units", "Seven usable units", "Nine units were shipped", "two of the remaining units"],
+    derive: () => ({ available: 18 + 7 - 9 - 2, removedFromUsable: 9 + 2 }),
+  },
+  "dev-en-calc-02": {
+    why: "Only O-7 and O-4 qualify, yielding 4 × 8 + 3 × 5 = 47 tokens across 2 orders.",
+    anchors: ["O-7 paid=yes cancelled=no quantity=4 unitTokens=8", "O-2 paid=no cancelled=no quantity=10 unitTokens=9", "O-9 paid=yes cancelled=yes quantity=2 unitTokens=6", "O-4 paid=yes cancelled=no quantity=3 unitTokens=5"],
+    derive: () => {
+      const rows = [["O-7", true, false, 4, 8], ["O-2", false, false, 10, 9], ["O-9", true, true, 2, 6], ["O-4", true, false, 3, 5]];
+      const included = rows.filter(([, paid, cancelled]) => paid && !cancelled);
+      return { includedIds: included.map(([id]) => id), orderCount: included.length, totalTokens: included.reduce((sum, [, , , quantity, price]) => sum + quantity * price, 0) };
+    },
+  },
+  "dev-en-calc-03": {
+    why: "40 - 15 = 25 unmarked; 15/40 × 100 = 37.5 and 25/40 × 100 = 62.5.",
+    anchors: ["Exactly 40 tiles", "exactly 15 were marked", "divided by all 40 inspected tiles multiplied by 100"],
+    derive: () => ({ unmarkedCount: 40 - 15, markedPercent: 15 / 40 * 100, unmarkedPercent: (40 - 15) / 40 * 100 }),
+  },
+  "dev-en-calc-04": {
+    why: "2000 + 350 + 750 = 3100 grams; subtract 600 to obtain 2500 grams or 2.5 kilograms.",
+    anchors: ["1 kilogram = 1000 grams", "2 kilograms, 350 grams, and 0.75 kilograms", "exactly 600 grams"],
+    derive: () => {
+      const combined = 2 * 1000 + 350 + 0.75 * 1000;
+      return { combinedGrams: combined, remainingGrams: combined - 600, remainingKilograms: (combined - 600) / 1000 };
+    },
+  },
+  "dev-en-calc-05": {
+    why: "605 - 550 = 55 elapsed minutes; 55 - 10 = 45 active minutes or 0.75 hours.",
+    anchors: ["09:10", "10:05", "HH multiplied by 60 plus MM", "10-minute break", "divided by 60"],
+    derive: () => {
+      const elapsed = (10 * 60 + 5) - (9 * 60 + 10);
+      return { elapsedMinutes: elapsed, activeMinutes: elapsed - 10, activeHours: (elapsed - 10) / 60 };
+    },
+  },
+  "dev-en-calc-06": {
+    why: "Open rows at or before 2026-04-10 are J-4 and J-8, including equality; 3 + 4 = 7 units.",
+    anchors: ["cutoff 2026-04-10", "J-4 dueDate=2026-04-09 status=open units=3", "J-1 dueDate=2026-04-10 status=closed units=9", "J-8 dueDate=2026-04-10 status=open units=4", "J-2 dueDate=2026-04-11 status=open units=8"],
+    derive: () => {
+      const rows = [["J-4", "2026-04-09", "open", 3], ["J-1", "2026-04-10", "closed", 9], ["J-8", "2026-04-10", "open", 4], ["J-2", "2026-04-11", "open", 8]];
+      const included = rows.filter(([, date, state]) => state === "open" && date <= "2026-04-10");
+      return { dueIds: included.map(([id]) => id), dueCount: included.length, dueUnits: included.reduce((sum, [, , , units]) => sum + units, 0) };
+    },
+  },
+  "dev-ko-calc-01": {
+    why: "4 × 6 = 24 initially packed; 24 - 3 + 5 = 26 shippable.",
+    anchors: ["상자 4개", "각각 6개", "불량 3개", "정상 모형 5개"],
+    derive: () => ({ initiallyPacked: 4 * 6, shippable: 4 * 6 - 3 + 5 }),
+  },
+  "dev-ko-calc-02": {
+    why: "7 + 5 + 2 = 14 visitors, 12 paying; 7 × 3 + 5 × 8 + 2 × 0 = 61 tokens.",
+    anchors: ["어린이 7명은 1명당 3토큰", "성인 5명은 1명당 8토큰", "면제 방문자 2명은 1명당 0토큰"],
+    derive: () => {
+      const groups = [[7, 3], [5, 8], [2, 0]];
+      return { visitorCount: groups.reduce((sum, [count]) => sum + count, 0), payingCount: groups.filter(([, rate]) => rate > 0).reduce((sum, [count]) => sum + count, 0), totalTokens: groups.reduce((sum, [count, rate]) => sum + count * rate, 0) };
+    },
+  },
+  "dev-ko-calc-03": {
+    why: "12000 × 12.5/100 = 1500 discount; 10500 discounted price plus 500 gives 11000 payable.",
+    anchors: ["12000포인트", "물품 가격에만 12.5%", "포장비 500포인트"],
+    derive: () => {
+      const discount = 12000 * 12.5 / 100;
+      return { discountPoints: discount, discountedItemPoints: 12000 - discount, payablePoints: 12000 - discount + 500 };
+    },
+  },
+  "dev-ko-calc-04": {
+    why: "1.2 × 100 + 85 + 350/10 = 240 cm; subtract 40 to leave 200 cm or 2 m.",
+    anchors: ["1미터=100센티미터", "10밀리미터=1센티미터", "1.2미터, 85센티미터, 350밀리미터", "40센티미터를 잘라"],
+    derive: () => {
+      const combined = 1.2 * 100 + 85 + 350 / 10;
+      return { combinedCentimeters: combined, remainingCentimeters: combined - 40, remainingMeters: (combined - 40) / 100 };
+    },
+  },
+  "dev-ko-calc-05": {
+    why: "Four approvals contain three distinct IDs in first-approved order; one duplicate approval and two rejections.",
+    anchors: ["표 Q-3 승인, 표 Q-1 거절, 표 Q-3 승인, 표 Q-7 승인, 표 Q-1 승인, 표 Q-7 거절", "처음 승인된 순서"],
+    derive: () => {
+      const rows = [["Q-3", true], ["Q-1", false], ["Q-3", true], ["Q-7", true], ["Q-1", true], ["Q-7", false]];
+      const approved = rows.filter(([, accepted]) => accepted).map(([id]) => id);
+      const admittedIds = [...new Set(approved)];
+      return { admittedIds, uniqueAdmissions: admittedIds.length, duplicateApprovals: approved.length - admittedIds.length, rejectedScans: rows.length - approved.length };
+    },
+  },
+  "dev-ko-calc-06": {
+    why: "Both inclusive boundaries qualify, returns and outside dates do not: B-6 then B-9, 5 + 2 = 7 units.",
+    anchors: ["시작일 2026-06-03과 종료일 2026-06-08을 모두 포함", "B-6 수령일 2026-06-08 반품 아니오 수량 5", "B-2 수령일 2026-06-02 반품 아니오 수량 9", "B-9 수령일 2026-06-03 반품 아니오 수량 2", "B-4 수령일 2026-06-05 반품 예 수량 8", "B-1 수령일 2026-06-09 반품 아니오 수량 4"],
+    derive: () => {
+      const rows = [["B-6", "2026-06-08", false, 5], ["B-2", "2026-06-02", false, 9], ["B-9", "2026-06-03", false, 2], ["B-4", "2026-06-05", true, 8], ["B-1", "2026-06-09", false, 4]];
+      const included = rows.filter(([, date, returned]) => !returned && date >= "2026-06-03" && date <= "2026-06-08");
+      return { includedIds: included.map(([id]) => id), includedCount: included.length, totalUnits: included.reduce((sum, [, , , units]) => sum + units, 0) };
+    },
+  },
+};
+
+function reverseObjectKeys(value) {
+  if (Array.isArray(value)) return value.map(reverseObjectKeys);
+  if (value !== null && typeof value === "object") {
+    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
+  }
+  return value;
+}
+
+function pathsToLeaves(value, path = []) {
+  if (value !== null && typeof value === "object") {
+    return Object.entries(value).flatMap(([key, child]) => pathsToLeaves(child, [...path, key]));
+  }
+  return [{ path, value }];
+}
+
+function changedAt(answer, path, value) {
+  const clone = structuredClone(answer);
+  let parent = clone;
+  for (const key of path.slice(0, -1)) parent = parent[key];
+  parent[path.at(-1)] = value;
+  return clone;
+}
+
+test("development corpus has exactly six unique tasks in each language/task cell", () => {
+  assert.equal(corpus.purpose, "development-only");
+  assert.equal(corpus.cases.length, 24);
+  assert.deepEqual(Object.keys(derivations).sort(), corpus.cases.map(({ id }) => id).sort());
+  assert.equal(new Set(corpus.cases.map(({ prompt }) => prompt)).size, 24);
+  for (const language of ["en", "ko"]) {
+    for (const task of ["structured-extraction", "grounded-calculation"]) {
+      assert.equal(corpus.cases.filter((item) => item.language === language && item.task === task).length, 6);
+    }
+  }
+  for (const item of corpus.cases) {
+    assert.deepEqual(item.requirements, { needsSearch: false, attachments: [], tools: [] });
+    assert.deepEqual(item.grading, { kind: "exact-json", arrayOrder: "ordered", stringNormalization: "none" });
+    // No expected, grading, identity, provenance or other fields enter model input.
+    assert.deepEqual(modelInputForCase(item), { prompt: item.prompt });
+  }
+});
+
+for (const item of corpus.cases) {
+  const independent = derivations[item.id];
+  test(`${item.id}: independently derived known answer: ${independent.why}`, () => {
+    for (const fact of independent.anchors) {
+      assert.ok(item.prompt.includes(fact), `source fact changed or missing: ${fact}`);
+    }
+    const answer = independent.derive();
+    assert.deepEqual(item.expected, answer);
+    assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(answer)).pass, true);
+  });
+
+  test(`${item.id}: semantic leaf mutations, missing keys and extra keys fail`, () => {
+    const answer = independent.derive();
+    for (const { path, value } of pathsToLeaves(answer)) {
+      const wrong = typeof value === "number" ? value + 1
+        : typeof value === "boolean" ? !value
+          : value === null ? "unrecorded" : `${value}!`;
+      assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(changedAt(answer, path, wrong))).pass, false, `wrong value at ${path.join(".")}`);
+      if (typeof value === "number" || typeof value === "boolean") {
+        assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(changedAt(answer, path, String(value)))).pass, false, `coerced type at ${path.join(".")}`);
+      }
+      if (typeof value === "string") {
+        assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(changedAt(answer, path, ` ${value} `))).pass, false, `string whitespace at ${path.join(".")}`);
+      }
+    }
+    for (const key of Object.keys(answer)) {
+      const missing = structuredClone(answer);
+      delete missing[key];
+      assert.equal(gradeDevelopmentAnswer(item, JSON.stringify(missing)).pass, false, `missing ${key}`);
+    }
+    assert.equal(gradeDevelopmentAnswer(item, JSON.stringify({ ...answer, explanation: "extra" })).pass, false);
+    for (const [key, value] of Object.entries(answer)) {
+      if (!Array.isArray(value)) continue;
+      const altered = value.length > 1 ? [...value].reverse() : ["extra"];
+      assert.equal(gradeDevelopmentAnswer(item, JSON.stringify({ ...answer, [key]: altered })).pass, false, `array order/content at ${key}`);
+    }
+  });
+
+  test(`${item.id}: formatting and object-key order are ignored, decoded strings are preserved`, () => {
+    const answer = reverseObjectKeys(independent.derive());
+    // Literal and escaped Unicode represent the same JSON string, including ko.
+    const alternate = JSON.stringify(answer, null, 3).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
+    assert.equal(gradeDevelopmentAnswer(item, ` \n\t${alternate}\r\n `).pass, true);
+  });
+}

```

## Test results (run by the control program)

- PASS `npm run test:router-development-benchmark` (9907ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 9322.1746

## Guard results (run by the control program)

- PASS `npm run check:encoding` (1171ms)
  > ai-chat-hub@0.1.0 check:encoding
  > node scripts/check-text-encoding.mjs

  Text encoding check passed. No mojibake markers found.
- PASS `npm run check:doc-references` (1255ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs

  Document reference check passed: 759 referenced path(s) across 92 instruction document(s), and 878 path(s) named by comments across 2612 source file(s), all present.
- PASS `npm run check:policy-section-references` (951ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs

  Policy section reference check passed: 4128 citation(s) against 30 policy document(s). 2478 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1421 and 229 predate this change).
- PASS `npm run check:router-quality-eval` (668ms)
  none supplied. Pass --report=<path> to validate one.
    No decision-grade run exists in this repository, so ROUTE-01 has no evidence
    and remains pending regardless of what the shadow numbers show.

  No problems found in what was checked.

## Author's account (read last; a claim, not a finding)

Summary: Add 24 synthetic development cases, whole-catalogue static planning and deterministic saved-answer scoring, with explicit refusals and provenance limits. No provider collection or production routing changes.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "router-development-benchmark-v1",
  "round": 0,
  "reviewedDigest": "sha256:c5eae232832ac9cea55452bcd0425da493f7c65dd444f26a66fc3e0c21e9a345",
  "conclusion": "approve | request_changes | blocked",
  "findings": [
    {
      "location": "path:line or symbol",
      "severity": "error | warning | nit",
      "basis": "evidence | preference | judgement",
      "claim": "what is wrong, in one sentence",
      "reproduction": "how to see it: a command, or an input and its expected output (required for the finding to be acted on)"
    }
  ],
  "nextAction": "one sentence"
}
```

`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands.
