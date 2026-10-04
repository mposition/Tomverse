# Independent review — task router-full-catalog-diagnostic-v1, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Build the offline foundation for improving Auto Router model selection over the whole catalogue without repeated human hand-offs. (1) A full-catalogue routing diagnostic that uses the product's own routing logic (not a copy) on the development fixture and, per request, shows every catalogue model, its candidacy and exclusion reason, the presence/source/version of per-task quality evidence, the score/band and the actual tie-break criterion, the final primary and the actually executable fallback, why each non-selected model lost, and where no evidence exists to judge. Unevaluated models are not scored 0, not promoted, and no operational score changes. (2) A minimal Claude–Codex cross-review structure: author, independent reviewer, control program; roles configurable; exchange record with task ID, original requirement and completion criteria, change digest, change summary, test results, review conclusion, per-finding location/severity/basis/reproduction, next action; reviewer reads requirement and diff before the author's self-assessment; reviewer has no write access; a new change needs a new review; max 2 fix rounds then hold; preference-only findings follow project rules; unevidenced proposals keep the current version; two AIs agreeing is not a pass without tests and guards. No model calls, no production routing/score/flag change, no push, no workflow dispatch.

## Completion criteria

- Every model in the catalogue appears in the diagnostic for every item; a model excluded from candidacy carries a fixed reason (tests/routerFullCatalogDiagnostic.test.mjs).
- The diagnostic's candidate set, rejections, primary and deciding criterion equal decideRouterModel's on the same input, and the Router-vs-dispatch output cap difference is reported, not hidden.
- The cross-review loop runs end to end on mocks: pass, request_changes then fix then approve, and revision cap reached (tests/crossReview.test.mjs).
- Invalid JSON, missing result, timeout, execution failure and digest mismatch are named failures, never a pass.
- In dry-run mode the command-line executors are never spawned.
- No production routing behaviour, score, flag, pre-registration, or protection rule changes: existing router tests pass unchanged and no file under app/ or lib/router{Candidates,Selection,ScorePolicy,Decision}.ts is modified.

## Change under review — digest sha256:6500e0e274e884de9ea1d720c7488387bea96e6764ce088016dd0946cb01073a, commit 7d61d2b2afe2bb5601ce79d0eb77a6959bdfe2a5

```diff
diff --git a/docs/ops/cross-review/README.md b/docs/ops/cross-review/README.md
new file mode 100644
index 00000000..f455c9b8
--- /dev/null
+++ b/docs/ops/cross-review/README.md
@@ -0,0 +1,137 @@
+# Cross review: an author, an independent reviewer, and a control program
+
+Offline development tooling. It is not a product path: no user request calls
+either executor, and nothing here runs unless a person runs the script.
+
+## Roles
+
+| role | does | writes |
+|---|---|---|
+| author | produces a change for a task: diff, summary, files touched, its own assessment kept apart | inside the task's `writableScope` only |
+| reviewer | reads the original requirement and the diff first, then the tests, then the author's account; returns a verdict bound to the change's digest | nothing |
+| control program (`lib/crossReviewCore.ts`) | computes the digest itself, runs the tests, applies the handling rules, counts rounds, decides the outcome | the exchange record |
+
+Which model plays which role is configuration (`--author`, `--reviewer`;
+default Claude authors and Codex reviews). The executors are injected, so the
+same loop runs against scripted mocks and against command-line tools.
+
+## Handling rules the loop applies
+
+- An approval names the digest it reviewed; a verdict on another digest,
+  task or round fails the run. Round n's approval is never reused for n+1.
+- Two executors agreeing is not a pass: the control program's own checks
+  must pass as well -- at least one test run and every run passed, at least
+  one guard rule run and every rule passed. Nothing run is a failed check
+  (an empty test list is not a passing one, and neither is an empty guard
+  list), and so is a diff that names a file the author did not report. A
+  failed check sends the approved change back to the author.
+- An actionable finding is never passed over: with a revision left it goes
+  back to the author, and in the last round it puts the change on hold even
+  under an approval.
+- The cap is fixed at two fix rounds (`MAX_REVISIONS`). `--max-revisions`
+  may lower it for a run and cannot raise it.
+- The scope check reads the diff as well as the author's file list: a file
+  the diff touches outside `writableScope` is refused before review,
+  whatever was reported. `package` mode reads the whole working tree for
+  the same question, so nothing hides behind the scoped diff.
+- A finding is acted on only with a reproduction, whatever its basis:
+  `evidence` names something checkable and the reproduction is how to check
+  it; a `judgement` likewise. A `preference` is settled by the project's
+  rules. A finding with no reproduction keeps the current version. All are
+  recorded, none dropped.
+- After the fix rounds are spent, an unresolved change is put on hold with
+  its findings and reproductions. It is not retried.
+- Invalid JSON, a missing result, a timeout, a failed execution and a digest
+  mismatch are each a named failure, never a pass.
+
+## Running it
+
+```
+npm run cross-review -- --task=<task.json> --mode=mock --fixture=<fixture.json> --out=<dir>
+npm run cross-review -- --task=<task.json> --mode=dry-run --out=<dir>
+npm run cross-review -- --task=<task.json> --mode=package --test-command="..." --diff-exclude=<generated> --out=<dir>
+npm run cross-review -- --task=<task.json> --mode=review --out=<dir> [--i-have-authorised-live-execution]
+```
+
+`mock` runs the whole loop from a fixture. `dry-run` builds the command-line
+executors and proves they do not run. `package` calls no executor: it takes
+the diff against the task's base commit (or `--base`), digests it, runs the
+test command and every `--guard-command`, and writes the round's package and
+the reviewer prompt. `review` runs only the reviewer on a packaged round,
+writes `verdict-round<N>.json` next to it, and rewrites `exchange.json` as
+the control program's replay of every round so far
+(`replayExchange` in `lib/crossReviewCore.ts`); without
+`--i-have-authorised-live-execution` it shows the exact command and runs
+nothing. `--mode=live` runs both executors in the loop and is refused without
+the same flag.
+
+The checks are the control program's, so they are named on the command line:
+`--test-command` is the test run (its exit status decides) and
+`--guard-command` (repeatable) is a guard rule, run once per round and
+recorded with its result (a non-zero exit is a failed rule). In `live` mode
+the diff of record is the working tree's diff against the base after the
+author ran -- what the author returned is kept only as its claim -- and one
+guard rule always checks that the tree holds nothing that diff cannot show.
+
+What a package may leave out of the reviewed diff is fixed before the
+exchange: `--diff-exclude` accepts only the task's `generatedPaths` and the
+package's own `--out` directory. An excluded file still counts as changed,
+its content digest is recorded in the package, and a review refuses to run
+if it has changed since.
+
+The person-driven loop is `package` → `review` → (fix) → `package --round=1`
+→ `review` …, and `exchange.json` carries `awaiting_review` or
+`awaiting_revision` between steps and the control program's own `passed`,
+`on_hold` or `failed` once it has decided. The script refuses what would make
+the record untrustworthy: a change outside the scope anywhere in the tree or
+an untracked file the diff would not show; a package or review of round N
+unless the replay of rounds 0..N-1 is `awaiting_revision` (after `passed`,
+`on_hold` or `failed` the exchange has concluded, and a further change is a
+new task or a new `--out`); a second verdict on a reviewed round; and a
+review of a package the working tree does not match, where matching means
+the tree's diff against the base, scoped and excluded as the package was,
+digests to the package's digest.
+
+### The reviewer's invocation
+
+`CLI_INVOCATIONS` in `lib/crossReviewExecutors.ts` records the intended
+invocations. They were checked on 2026-09-09 against codex-cli 0.146.0 and
+Claude Code 2.1.261 (`--help` of both; the `codex` source at tag
+`rust-v0.146.0` for the JSONL event shape, the headless approval policy and
+the config layers). What the check changed:
+
+- The Codex reviewer runs `codex --sandbox read-only exec --ignore-user-config
+  --json -`. The sandbox bounds shell commands only; MCP servers, plugins and
+  hooks from `~/.codex/config.toml` run outside it, and `-c mcp_servers={}`
+  merges rather than replaces, so the user layer is left out altogether. The
+  stored login is still used. `codex exec` sets the approval policy to
+  `never`, so a command the sandbox refuses is rejected, not escalated.
+- What a run still needs from configuration is passed with
+  `--codex-config=key=value` (repeatable) and recorded with the verdict. A
+  reviewer accepts only `REVIEWER_CONFIG_OVERRIDE_KEYS` -- the model, its
+  reasoning effort, and the Windows sandbox backend -- so an override cannot
+  widen what it may do. Give values without quotes (`model=gpt-5.6-sol`).
+- On Windows, with the user layer ignored, `windows.sandbox` is unset, and
+  unset resolves to no backend, under which `codex` rejects every command
+  rather than running unsandboxed. Pass `--codex-config=windows.sandbox=elevated`
+  (or `unelevated`) to keep the sandbox the machine already has set up.
+- `--codex-auth=login` (the default) drops `OPENAI_API_KEY` and
+  `CODEX_API_KEY` from the child environment so the run uses the stored
+  login; `env` keeps them.
+- The Claude Code reviewer runs `claude --print --output-format json --tools
+  Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`: only the
+  read tools are built in, nothing prompts, and no MCP server is loaded. It
+  has not been run.
+
+Neither author invocation has been run. The check is due again whenever
+either tool is upgraded.
+
+`fixtures/` holds a demo task and three fixtures: a fix-then-approve pass, an
+exhausted-revisions hold, and a digest-mismatch failure.
+
+## The exchange record
+
+`exchange.json` carries the task ID, the original requirement and completion
+criteria, the digest and commit of the change reviewed, the change summary,
+the test results, the review conclusion, every finding with its location,
+severity, basis, reproduction and disposition, and the next action.
diff --git a/docs/ops/cross-review/fixtures/sum-helper.digest-mismatch.json b/docs/ops/cross-review/fixtures/sum-helper.digest-mismatch.json
new file mode 100644
index 00000000..b99ffb60
--- /dev/null
+++ b/docs/ops/cross-review/fixtures/sum-helper.digest-mismatch.json
@@ -0,0 +1,14 @@
+{
+  "author": [
+    { "diff": "+v0", "summary": "attempt 0", "filesChanged": ["lib/sum.ts"], "commit": null }
+  ],
+  "reviewer": [
+    { "taskId": "demo-sum-helper", "round": 0, "reviewedDigest": "sha256:not-this-change", "conclusion": "approve", "findings": [], "nextAction": "merge" }
+  ],
+  "tests": [
+    [{ "command": "node --test tests/sum.test.mjs", "passed": true, "output": "pass 1", "durationMs": 38 }]
+  ],
+  "guards": [
+    [{ "rule": "npm run lint -- lib/sum.ts", "passed": true, "detail": "no problems", "durationMs": 12 }]
+  ]
+}
diff --git a/docs/ops/cross-review/fixtures/sum-helper.pass-after-fix.json b/docs/ops/cross-review/fixtures/sum-helper.pass-after-fix.json
new file mode 100644
index 00000000..084a26ca
--- /dev/null
+++ b/docs/ops/cross-review/fixtures/sum-helper.pass-after-fix.json
@@ -0,0 +1,63 @@
+{
+  "author": [
+    {
+      "diff": "--- a/lib/sum.ts\n+++ b/lib/sum.ts\n+export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b);\n",
+      "summary": "Adds sum() using reduce.",
+      "filesChanged": ["lib/sum.ts"],
+      "selfAssessment": "Straightforward; no edge cases.",
+      "commit": null
+    },
+    {
+      "diff": "--- a/lib/sum.ts\n+++ b/lib/sum.ts\n+export const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0);\n--- a/tests/sum.test.mjs\n+++ b/tests/sum.test.mjs\n+test(\"empty\", () => assert.equal(sum([]), 0));\n",
+      "summary": "Seeds reduce with 0 and adds the empty-array test.",
+      "filesChanged": ["lib/sum.ts", "tests/sum.test.mjs"],
+      "commit": null
+    }
+  ],
+  "reviewer": [
+    {
+      "taskId": "demo-sum-helper",
+      "round": 0,
+      "reviewedDigest": "@current",
+      "conclusion": "request_changes",
+      "findings": [
+        {
+          "location": "lib/sum.ts:1",
+          "severity": "error",
+          "basis": "evidence",
+          "claim": "reduce without a seed throws on an empty array, so sum([]) does not return 0 and the first completion criterion fails.",
+          "reproduction": "node -e '[].reduce((a,b)=>a+b)'"
+        },
+        {
+          "location": "tests/",
+          "severity": "error",
+          "basis": "evidence",
+          "claim": "No test covers the empty array; the requirement asks for one."
+        },
+        {
+          "location": "lib/sum.ts:1",
+          "severity": "nit",
+          "basis": "preference",
+          "claim": "I would name the parameter xs."
+        }
+      ],
+      "nextAction": "seed the reduce, add the test, resubmit"
+    },
+    {
+      "taskId": "demo-sum-helper",
+      "round": 1,
+      "reviewedDigest": "@current",
+      "conclusion": "approve",
+      "findings": [],
+      "nextAction": "ready to merge"
+    }
+  ],
+  "tests": [
+    [{ "command": "node --test tests/sum.test.mjs", "passed": false, "output": "TypeError: Reduce of empty array with no initial value", "durationMs": 40 }],
+    [{ "command": "node --test tests/sum.test.mjs", "passed": true, "output": "pass 1", "durationMs": 38 }]
+  ],
+  "guards": [
+    [{ "rule": "npm run lint -- lib/sum.ts", "passed": true, "detail": "no problems", "durationMs": 12 }],
+    [{ "rule": "npm run lint -- lib/sum.ts", "passed": true, "detail": "no problems", "durationMs": 11 }]
+  ]
+}
diff --git a/docs/ops/cross-review/fixtures/sum-helper.revisions-exhausted.json b/docs/ops/cross-review/fixtures/sum-helper.revisions-exhausted.json
new file mode 100644
index 00000000..9a1484a2
--- /dev/null
+++ b/docs/ops/cross-review/fixtures/sum-helper.revisions-exhausted.json
@@ -0,0 +1,22 @@
+{
+  "author": [
+    { "diff": "+v0", "summary": "attempt 0", "filesChanged": ["lib/sum.ts"], "commit": null },
+    { "diff": "+v1", "summary": "attempt 1", "filesChanged": ["lib/sum.ts"], "commit": null },
+    { "diff": "+v2", "summary": "attempt 2", "filesChanged": ["lib/sum.ts"], "commit": null }
+  ],
+  "reviewer": [
+    { "taskId": "demo-sum-helper", "round": 0, "reviewedDigest": "@current", "conclusion": "request_changes", "findings": [{ "location": "lib/sum.ts:1", "severity": "error", "basis": "evidence", "claim": "sum([]) still throws", "reproduction": "node -e '[].reduce((a,b)=>a+b)'" }], "nextAction": "fix" },
+    { "taskId": "demo-sum-helper", "round": 1, "reviewedDigest": "@current", "conclusion": "request_changes", "findings": [{ "location": "lib/sum.ts:1", "severity": "error", "basis": "evidence", "claim": "sum([]) still throws", "reproduction": "node -e '[].reduce((a,b)=>a+b)'" }], "nextAction": "fix" },
+    { "taskId": "demo-sum-helper", "round": 2, "reviewedDigest": "@current", "conclusion": "request_changes", "findings": [{ "location": "lib/sum.ts:1", "severity": "error", "basis": "evidence", "claim": "sum([]) still throws", "reproduction": "node -e '[].reduce((a,b)=>a+b)'" }], "nextAction": "fix" }
+  ],
+  "tests": [
+    [{ "command": "node --test tests/sum.test.mjs", "passed": false, "output": "TypeError: Reduce of empty array with no initial value", "durationMs": 40 }],
+    [{ "command": "node --test tests/sum.test.mjs", "passed": false, "output": "TypeError: Reduce of empty array with no initial value", "durationMs": 41 }],
+    [{ "command": "node --test tests/sum.test.mjs", "passed": false, "output": "TypeError: Reduce of empty array with no initial value", "durationMs": 39 }]
+  ],
+  "guards": [
+    [{ "rule": "npm run lint -- lib/sum.ts", "passed": true, "detail": "no problems", "durationMs": 12 }],
+    [{ "rule": "npm run lint -- lib/sum.ts", "passed": true, "detail": "no problems", "durationMs": 12 }],
+    [{ "rule": "npm run lint -- lib/sum.ts", "passed": true, "detail": "no problems", "durationMs": 12 }]
+  ]
+}
diff --git a/docs/ops/cross-review/fixtures/sum-helper.task.json b/docs/ops/cross-review/fixtures/sum-helper.task.json
new file mode 100644
index 00000000..a08d8ffa
--- /dev/null
+++ b/docs/ops/cross-review/fixtures/sum-helper.task.json
@@ -0,0 +1,11 @@
+{
+  "taskId": "demo-sum-helper",
+  "requirement": "Add a pure helper `sum(numbers)` in lib/ that returns the total of an array of numbers, with 0 for an empty array, and a test for the empty case.",
+  "completionCriteria": [
+    "sum([]) returns 0",
+    "sum([1, 2, 3]) returns 6",
+    "only files under lib/ and tests/ change"
+  ],
+  "baseCommit": "0000000000000000000000000000000000000000",
+  "writableScope": ["lib/", "tests/"]
+}
diff --git a/docs/ops/cross-review/packages/router-full-catalog-diagnostic.task.json b/docs/ops/cross-review/packages/router-full-catalog-diagnostic.task.json
new file mode 100644
index 00000000..30ff533f
--- /dev/null
+++ b/docs/ops/cross-review/packages/router-full-catalog-diagnostic.task.json
@@ -0,0 +1,29 @@
+{
+  "taskId": "router-full-catalog-diagnostic-v1",
+  "requirement": "Build the offline foundation for improving Auto Router model selection over the whole catalogue without repeated human hand-offs. (1) A full-catalogue routing diagnostic that uses the product's own routing logic (not a copy) on the development fixture and, per request, shows every catalogue model, its candidacy and exclusion reason, the presence/source/version of per-task quality evidence, the score/band and the actual tie-break criterion, the final primary and the actually executable fallback, why each non-selected model lost, and where no evidence exists to judge. Unevaluated models are not scored 0, not promoted, and no operational score changes. (2) A minimal Claude–Codex cross-review structure: author, independent reviewer, control program; roles configurable; exchange record with task ID, original requirement and completion criteria, change digest, change summary, test results, review conclusion, per-finding location/severity/basis/reproduction, next action; reviewer reads requirement and diff before the author's self-assessment; reviewer has no write access; a new change needs a new review; max 2 fix rounds then hold; preference-only findings follow project rules; unevidenced proposals keep the current version; two AIs agreeing is not a pass without tests and guards. No model calls, no production routing/score/flag change, no push, no workflow dispatch.",
+  "completionCriteria": [
+    "Every model in the catalogue appears in the diagnostic for every item; a model excluded from candidacy carries a fixed reason (tests/routerFullCatalogDiagnostic.test.mjs).",
+    "The diagnostic's candidate set, rejections, primary and deciding criterion equal decideRouterModel's on the same input, and the Router-vs-dispatch output cap difference is reported, not hidden.",
+    "The cross-review loop runs end to end on mocks: pass, request_changes then fix then approve, and revision cap reached (tests/crossReview.test.mjs).",
+    "Invalid JSON, missing result, timeout, execution failure and digest mismatch are named failures, never a pass.",
+    "In dry-run mode the command-line executors are never spawned.",
+    "No production routing behaviour, score, flag, pre-registration, or protection rule changes: existing router tests pass unchanged and no file under app/ or lib/router{Candidates,Selection,ScorePolicy,Decision}.ts is modified."
+  ],
+  "baseCommit": "8134ce44",
+  "writableScope": [
+    "lib/routerFullCatalogDiagnostic.ts",
+    "lib/crossReviewCore.ts",
+    "lib/crossReviewExecutors.ts",
+    "scripts/report-router-full-catalog.mjs",
+    "scripts/cross-review.mjs",
+    "tests/routerFullCatalogDiagnostic.test.mjs",
+    "tests/crossReview.test.mjs",
+    "docs/ops/router-full-catalog-diagnostic/",
+    "docs/ops/cross-review/",
+    "package.json"
+  ],
+  "generatedPaths": [
+    "docs/ops/router-full-catalog-diagnostic/development-v0.md",
+    "docs/ops/router-full-catalog-diagnostic/development-v0.summary.json"
+  ]
+}
diff --git a/docs/ops/router-full-catalog-diagnostic/README.md b/docs/ops/router-full-catalog-diagnostic/README.md
new file mode 100644
index 00000000..d2e61f36
--- /dev/null
+++ b/docs/ops/router-full-catalog-diagnostic/README.md
@@ -0,0 +1,74 @@
+# Full-catalogue routing diagnostic
+
+What the Router would do with every model in the catalogue, for every item in
+an evaluation set, decided offline by the product's own functions.
+
+```
+npm run report:router-full-catalog -- [--set=docs/ops/router-evaluation-set/development-v0.json] \
+  [--items=adopted|all] [--plan=Pro] [--requested-model=<id>] [--fallback-flag=off|on] \
+  [--json=<out>] [--summary-json=<out>] [--md=<out>]
+```
+
+The committed files are regenerated with the defaults:
+
+```
+npm run report:router-full-catalog -- --quiet \
+  --md=docs/ops/router-full-catalog-diagnostic/development-v0.md \
+  --summary-json=docs/ops/router-full-catalog-diagnostic/development-v0.summary.json \
+  --json=artifacts/router-full-catalog/development-v0.full.json
+```
+
+`lib/routerFullCatalogDiagnostic.ts` calls `decideRouterModel` for the
+decision and `filterRouterCandidates` / `selectRouterModel` again only to
+explain it; `consistency` on every item says whether the explanation agreed
+with the decision, and a disagreement is reported rather than reconciled. No
+band is moved, no interval invented, no model promoted: an unmeasured model is
+shown as unmeasured.
+
+Per item it records every model's disposition (primary, fallback candidate, or
+refused with the filter's own reason), the quality cell and whether any
+approved evidence stands behind it, the criterion each loser lost to the
+primary on, the ranked fallback candidates with the fallback gate's answer
+under the shipped flag and with the flag on, and the output cap the Router
+routed under beside the one dispatch will apply to the chosen model.
+
+Whether a turn could reach a fallback is answered in the product's own
+order (`app/api/chat/route.ts`, `attemptFallback`) with the product's own
+functions where an offline report can call them: the gate
+(`autoFallbackScope`) must allow it, `decideFallback` -- called, under the
+one failure hypothesis the fallback path exists for (`FALLBACK_FAILURE_HYPOTHESIS`:
+the primary failed at the provider before any token was shown) -- names a
+candidate, and dispatch must fit that one candidate under its own cap, since
+the product tries no other. `fallback.decision` is `decideFallback`'s answer
+as given; `fallback.firstCandidate` is that candidate as dispatch would fit
+it; `fallback.reachableAsDeployed` and `fallback.reachableIfFlagOn` are the
+three-step answer, each refusal naming the step that said no
+(`gate:<reason>`, `decision:<reason>`, `candidate_context_window_exceeded`).
+
+`planAttemptExecution` is not called: it builds the provider client and the
+credit budget for a real dispatch, which an offline report has no account,
+credentials or reservation for. Its refusals that depend on those, and the
+two runtime checks the route makes around it, are carried on every
+reachable answer as `undecidedOffline` (`search_path_unavailable`,
+`budget_refused`, `candidate_unavailable`, `no_provider_hold`), so
+`reachable: true` reads as "nothing decidable offline refused it" and not
+as a promise. `fallback.notModelled` repeats the hypothesis and that list.
+
+## What the product has that this does not
+
+The product routes over the runtime registry's rows, with health exclusions
+and measured tie-break signals from the database, under the account's plan
+and credits, with the conversation's sticky state. This runs over the static
+catalogue in `lib/models.ts`, with no sticky state and no measured signals,
+so cost from the pricing registry decides every tie. A model an operator has
+disabled in the registry is absent from the product's candidate list and
+produces no rejection row there; here the static catalogue's disabled rows
+are refused as `disabled`. The report's `inputs` block records what was used.
+
+## Files
+
+- `development-v0.md`: the report on the 210 adopted items, plan Pro, routed
+  under `gpt-5-6-luna`'s cap, fallback flag off.
+- `development-v0.summary.json`: the same run with per-item decision,
+  rejections, caps, fallback and evidence; per-model rows are in the full
+  JSON the script writes under `artifacts/`, which is not committed.
diff --git a/lib/crossReviewCore.ts b/lib/crossReviewCore.ts
new file mode 100644
index 00000000..a3da4f56
--- /dev/null
+++ b/lib/crossReviewCore.ts
@@ -0,0 +1,996 @@
+/**
+ * The control program for an author–reviewer exchange between two AI
+ * executors, with a fix loop and a hard iteration cap.
+ *
+ * ## Roles
+ *
+ * - The **author** produces a change for a task: a diff, a summary, the files
+ *   it touched, and -- kept apart from all of that -- its own assessment.
+ * - The **reviewer** reads the original requirement and the actual diff first,
+ *   then the test results, and only then the author's summary and
+ *   self-assessment, labelled as such. It returns a conclusion and findings,
+ *   each with a location, a severity, and the basis it rests on.
+ * - This module is the **control program**: it hands results between the two,
+ *   computes the change digest itself, runs the tests and the guards, applies
+ *   the handling rules, counts the rounds, and decides the outcome. Neither
+ *   executor decides whether the task passed.
+ *
+ * Which model plays which role is configuration (`RoleAssignment`), and the
+ * executors are injected, so the same loop runs against scripted mocks in a
+ * test and against command-line tools in a session. Nothing here spawns a
+ * process, reads a file, or reaches the network.
+ *
+ * ## Rules the loop applies, from the operating defaults
+ *
+ * - An approval is bound to a digest. The reviewer names the digest it
+ *   reviewed; if that is not the digest of the change in hand, the verdict is
+ *   not a verdict on this change and the run fails. An approval of round n is
+ *   never reused for round n+1.
+ * - Two executors agreeing is not a pass. The control program's own checks
+ *   must pass as well: at least one test run and every run passed, at least
+ *   one guard rule run and every rule passed. Nothing run is a failed check
+ *   -- an empty test list is not a passing one, and neither is an empty
+ *   guard list -- and so is a diff that names a file the author did not
+ *   report. A failed check sends the approved change back to the author
+ *   (counting a round) and, if rounds are exhausted, on hold.
+ * - A finding is acted on only with a reproduction, whatever its basis:
+ *   `evidence` names something checkable and the reproduction is how to
+ *   check it, and a `judgement` is an opinion that a reproduction turns into
+ *   something checkable. A `preference` is settled by the project's rules
+ *   and recorded as such. A finding with no reproduction is insufficient
+ *   evidence: the current version stands, and the finding is recorded, never
+ *   dropped.
+ * - An actionable finding is never passed over. With a revision left it goes
+ *   back to the author; in the last round it puts the change on hold, even
+ *   under an approval -- a reviewer that approves while naming a reproducible
+ *   error has named an error, not waived it.
+ * - The cap is fixed: `MAX_REVISIONS` (2) fix rounds after the first review,
+ *   and then an unresolved change is put on hold with its findings and
+ *   reproduction material. A caller may lower the cap for a run; it cannot
+ *   raise it.
+ * - Invalid JSON, a missing result, a timeout, an executor failure and a
+ *   digest mismatch are each a named failure. None of them is a pass.
+ *
+ * Pure apart from the injected executors, test runner, guards and clock.
+ */
+
+export const CROSS_REVIEW_VERSION = "cross-review-v1";
+
+export type CrossReviewRole = "author" | "reviewer";
+
+/** Which executor plays which role. Swappable; the loop does not care. */
+export type RoleAssignment = {
+    author: string;
+    reviewer: string;
+};
+
+export const DEFAULT_ROLE_ASSIGNMENT: RoleAssignment = {
+    author: "claude",
+    reviewer: "codex",
+};
+
+export type CrossReviewTask = {
+    taskId: string;
+    /** The original requirement, verbatim. What the reviewer reads first. */
+    requirement: string;
+    completionCriteria: readonly string[];
+    /** The commit the change is measured against. */
+    baseCommit: string;
+    /**
+     * Paths the author may write. The reviewer writes nowhere: it is given
+     * the diff as text and returns a verdict as text, so there is nothing it
+     * could write even if it wanted to. Two executors never edit one file.
+     */
+    writableScope: readonly string[];
+    /**
+     * Generated files inside the scope that a package may leave out of the
+     * reviewed diff, named here before the exchange so an author cannot
+     * decide later what the reviewer does not see. Each is still counted as
+     * changed, and its content is digested into the package.
+     */
+    generatedPaths?: readonly string[];
+};
+
+/** What an author executor returns. Its digest claim, if any, is ignored. */
+export type AuthorOutput = {
+    /** The unified diff against `baseCommit`, or the current worktree. */
+    diff: string;
+    summary: string;
+    filesChanged: readonly string[];
+    /**
+     * The author's own view of its work. Carried separately so the reviewer
+     * can be shown the requirement and the diff before it, and so a reader of
+     * the record can tell the author's claim from the reviewer's finding.
+     */
+    selfAssessment?: string;
+    /** The commit the author made, or null when the change is a worktree. */
+    commit?: string | null;
+};
+
+export type TestRun = {
+    command: string;
+    passed: boolean;
+    /** Kept short by the caller; the record is not a log. */
+    output: string;
+    durationMs: number;
+};
+
+/** One guard rule, run once, with what it found. */
+export type GuardRun = {
+    rule: string;
+    passed: boolean;
+    /** What the rule reported. Short; the record is not a log. */
+    detail: string;
+    durationMs?: number;
+};
+
+export const FINDING_SEVERITIES = ["error", "warning", "nit"] as const;
+export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
+
+export const FINDING_BASES = [
+    /** Backed by something checkable: a failing test, a wrong output, a spec line. The reproduction is how to check it. */
+    "evidence",
+    /** A matter of taste. Settled by the project's rules, not by argument. */
+    "preference",
+    /** An opinion about behaviour. Actionable only with a reproduction. */
+    "judgement",
+] as const;
+export type FindingBasis = (typeof FINDING_BASES)[number];
+
+export type Finding = {
+    /** `path:line`, a symbol, or a section. Never empty. */
+    location: string;
+    severity: FindingSeverity;
+    basis: FindingBasis;
+    claim: string;
+    /** How to see the problem: a command, an input and expected output. Required for the finding to be acted on. */
+    reproduction?: string;
+};
+
+export const REVIEW_CONCLUSIONS = ["approve", "request_changes", "blocked"] as const;
+export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];
+
+export type ReviewVerdict = {
+    taskId: string;
+    round: number;
+    /** The digest of the change the reviewer actually read. */
+    reviewedDigest: string;
+    conclusion: ReviewConclusion;
+    findings: readonly Finding[];
+    nextAction: string;
+};
+
+/** What the reviewer is handed, in the order it is meant to read it. */
+export type ReviewRequest = {
+    task: CrossReviewTask;
+    round: number;
+    changeDigest: string;
+    commit: string | null;
+    diff: string;
+    testResults: readonly TestRun[];
+    guardRuns: readonly GuardRun[];
+    /** Failed guard rules and consistency failures, as text. */
+    guardViolations: readonly string[];
+    /** Last, and labelled: the author's summary and self-assessment. */
+    authorSummary: string;
+    authorSelfAssessment: string | null;
+    /** Findings from the previous round, so the reviewer can check they were addressed. */
+    previousFindings: readonly Finding[];
+};
+
+export type AuthorRequest = {
+    task: CrossReviewTask;
+    round: number;
+    /** Actionable findings and failed checks from the previous round; null on round 0. */
+    feedback: {
+        findings: readonly Finding[];
+        failedTests: readonly TestRun[];
+        guardViolations: readonly string[];
+        /** Every reason the checks did not pass, including "no test was run". */
+        checkFailures: readonly string[];
+    } | null;
+};
+
+export const EXECUTOR_FAILURES = [
+    "invalid_json",
+    "missing_result",
+    "timeout",
+    "execution_failed",
+    "schema_mismatch",
+    "not_executed",
+] as const;
+export type ExecutorFailure = (typeof EXECUTOR_FAILURES)[number];
+
+export type ExecutorResult<T> =
+    | { ok: true; value: T }
+    | { ok: false; failure: ExecutorFailure; detail: string };
+
+export type AuthorExecutor = {
+    id: string;
+    produce: (request: AuthorRequest) => Promise<ExecutorResult<AuthorOutput>>;
+};
+
+export type ReviewerExecutor = {
+    id: string;
+    review: (request: ReviewRequest) => Promise<ExecutorResult<ReviewVerdict>>;
+};
+
+export type FindingDisposition =
+    /** Sent back to the author. */
+    | "fix_requested"
+    /** A preference; the project's rules decide, and the change stands. */
+    | "resolved_by_project_rule"
+    /** No reproduction, whatever the basis; the current version is kept. */
+    | "insufficient_evidence_kept_current"
+    /** Rounds exhausted with this still open. */
+    | "unresolved_on_hold";
+
+export type DisposedFinding = Finding & { disposition: FindingDisposition };
+
+export type RoundRecord = {
+    round: number;
+    changeDigest: string;
+    commit: string | null;
+    filesChanged: readonly string[];
+    changeSummary: string;
+    testResults: readonly TestRun[];
+    guardRuns: readonly GuardRun[];
+    guardViolations: readonly string[];
+    /** Why the control program's checks did not pass; empty when they did. */
+    checkFailures: readonly string[];
+    reviewConclusion: ReviewConclusion | null;
+    findings: readonly DisposedFinding[];
+    nextAction: string;
+};
+
+export const CROSS_REVIEW_STATUSES = ["passed", "on_hold", "failed"] as const;
+export type CrossReviewStatus = (typeof CROSS_REVIEW_STATUSES)[number];
+
+export type CrossReviewFailure =
+    | `author_${ExecutorFailure}`
+    | `reviewer_${ExecutorFailure}`
+    | "digest_mismatch"
+    | "task_mismatch"
+    | "round_mismatch"
+    | "scope_violation";
+
+export type HoldReason =
+    | "revisions_exhausted"
+    | "reviewer_blocked"
+    | "approved_but_checks_failed";
+
+/**
+ * The exchange record: everything either side needs, and nothing that lets
+ * one side's claim stand in for the other's finding.
+ */
+export type ExchangeRecord = {
+    version: string;
+    taskId: string;
+    requirement: string;
+    completionCriteria: readonly string[];
+    baseCommit: string;
+    roles: RoleAssignment;
+    maxRevisions: number;
+    rounds: readonly RoundRecord[];
+    /** The latest change's digest, the one any further verdict must name. */
+    changeDigest: string | null;
+    commit: string | null;
+    changeSummary: string | null;
+    testResults: readonly TestRun[];
+    guardRuns: readonly GuardRun[];
+    guardViolations: readonly string[];
+    checkFailures: readonly string[];
+    reviewConclusion: ReviewConclusion | null;
+    findings: readonly DisposedFinding[];
+    nextAction: string;
+    status: CrossReviewStatus;
+    failure: CrossReviewFailure | null;
+    holdReason: HoldReason | null;
+    producedAt: string;
+};
+
+export type CrossReviewOutcome = {
+    status: CrossReviewStatus;
+    failure: CrossReviewFailure | null;
+    holdReason: HoldReason | null;
+    exchange: ExchangeRecord;
+};
+
+export type CrossReviewControl = {
+    task: CrossReviewTask;
+    roles?: RoleAssignment;
+    author: AuthorExecutor;
+    reviewer: ReviewerExecutor;
+    /** Runs the required tests against the change. The control program's, not the author's. */
+    runTests: (change: { diff: string; filesChanged: readonly string[]; commit: string | null }) => Promise<readonly TestRun[]>;
+    /**
+     * Runs the existing protection rules against the change and reports each
+     * with its result. A failed rule is a failed check; so is an empty list,
+     * since a guard that was not run has protected nothing.
+     */
+    guards: (change: { diff: string; filesChanged: readonly string[] }) => Promise<readonly GuardRun[]>;
+    /** sha256 of the diff text. Injected so a test can pin it; the control computes it, never the author. */
+    digest: (diff: string) => string;
+    /** Fix-and-re-review rounds after the first review. At most `MAX_REVISIONS`; a caller may only lower it. */
+    maxRevisions?: number;
+    timeoutMs?: number;
+    now?: () => Date;
+};
+
+/** The operating default's cap on fix rounds. Fixed; a run may go lower, never higher. */
+export const MAX_REVISIONS = 2;
+export const DEFAULT_MAX_REVISIONS = MAX_REVISIONS;
+export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
+
+/** The cap a run may use, or a thrown error: raising the cap is not a run option. */
+export const resolveMaxRevisions = (requested: number | undefined): number => {
+    if (requested === undefined) return MAX_REVISIONS;
+    if (!Number.isInteger(requested) || requested < 0 || requested > MAX_REVISIONS) {
+        throw new RangeError(`maxRevisions must be an integer from 0 to ${MAX_REVISIONS}; got ${requested}`);
+    }
+    return requested;
+};
+
+const isRecord = (value: unknown): value is Record<string, unknown> =>
+    typeof value === "object" && value !== null && !Array.isArray(value);
+
+const isStringArray = (value: unknown): value is string[] =>
+    Array.isArray(value) && value.every((entry) => typeof entry === "string");
+
+/** Why a parsed object is not an `AuthorOutput`. Empty means it is one. */
+export const authorOutputProblems = (value: unknown): readonly string[] => {
+    if (!isRecord(value)) return ["not an object"];
+    const problems: string[] = [];
+    if (typeof value.diff !== "string") problems.push("diff must be a string");
+    if (typeof value.summary !== "string" || value.summary.trim() === "") problems.push("summary must be a non-empty string");
+    if (!isStringArray(value.filesChanged)) problems.push("filesChanged must be a string array");
+    if (value.selfAssessment !== undefined && typeof value.selfAssessment !== "string") {
+        problems.push("selfAssessment must be a string when present");
+    }
+    if (value.commit !== undefined && value.commit !== null && typeof value.commit !== "string") {
+        problems.push("commit must be a string or null");
+    }
+    return problems;
+};
+
+const findingProblems = (value: unknown, index: number): readonly string[] => {
+    if (!isRecord(value)) return [`findings[${index}] is not an object`];
+    const problems: string[] = [];
+    if (typeof value.location !== "string" || value.location.trim() === "") problems.push(`findings[${index}].location must be a non-empty string`);
+    if (!FINDING_SEVERITIES.includes(value.severity as FindingSeverity)) problems.push(`findings[${index}].severity must be one of ${FINDING_SEVERITIES.join("|")}`);
+    if (!FINDING_BASES.includes(value.basis as FindingBasis)) problems.push(`findings[${index}].basis must be one of ${FINDING_BASES.join("|")}`);
+    if (typeof value.claim !== "string" || value.claim.trim() === "") problems.push(`findings[${index}].claim must be a non-empty string`);
+    if (value.reproduction !== undefined && typeof value.reproduction !== "string") problems.push(`findings[${index}].reproduction must be a string when present`);
+    return problems;
+};
+
+/** Why a parsed object is not a `ReviewVerdict`. Empty means it is one. */
+export const reviewVerdictProblems = (value: unknown): readonly string[] => {
+    if (!isRecord(value)) return ["not an object"];
+    const problems: string[] = [];
+    if (typeof value.taskId !== "string") problems.push("taskId must be a string");
+    if (typeof value.round !== "number" || !Number.isInteger(value.round)) problems.push("round must be an integer");
+    if (typeof value.reviewedDigest !== "string" || value.reviewedDigest === "") problems.push("reviewedDigest must be a non-empty string");
+    if (!REVIEW_CONCLUSIONS.includes(value.conclusion as ReviewConclusion)) problems.push(`conclusion must be one of ${REVIEW_CONCLUSIONS.join("|")}`);
+    if (!Array.isArray(value.findings)) problems.push("findings must be an array");
+    else value.findings.forEach((finding, index) => problems.push(...findingProblems(finding, index)));
+    if (typeof value.nextAction !== "string") problems.push("nextAction must be a string");
+    return problems;
+};
+
+/**
+ * Parses executor output as JSON and checks it against a schema.
+ *
+ * Whole text first; then the last line, for a tool that streams events and
+ * prints its result last; then the last `{...}` block. Anything else is
+ * `invalid_json`, and a document that parses but is not the shape asked for
+ * is `schema_mismatch`. An empty output is `missing_result`.
+ */
+export const parseExecutorJson = <T>(
+    text: string,
+    problemsOf: (value: unknown) => readonly string[]
+): ExecutorResult<T> => {
+    if (typeof text !== "string" || text.trim() === "") {
+        return { ok: false, failure: "missing_result", detail: "the executor produced no output" };
+    }
+    const attempts: string[] = [text.trim()];
+    const lines = text.trim().split("\n");
+    if (lines.length > 1) attempts.push(lines[lines.length - 1].trim());
+    const lastBrace = text.lastIndexOf("}");
+    const firstBrace = text.indexOf("{");
+    if (firstBrace !== -1 && lastBrace > firstBrace) attempts.push(text.slice(firstBrace, lastBrace + 1));
+
+    let parsed: unknown = undefined;
+    let parsedAny = false;
+    for (const attempt of attempts) {
+        try {
+            parsed = JSON.parse(attempt);
+            parsedAny = true;
+            break;
+        } catch {
+            // try the next shape
+        }
+    }
+    if (!parsedAny) {
+        return { ok: false, failure: "invalid_json", detail: `no JSON document in ${text.length} byte(s) of output` };
+    }
+    const problems = problemsOf(parsed);
+    if (problems.length > 0) {
+        return { ok: false, failure: "schema_mismatch", detail: problems.join("; ") };
+    }
+    return { ok: true, value: parsed as T };
+};
+
+const withTimeout = async <T>(
+    work: Promise<ExecutorResult<T>>,
+    timeoutMs: number
+): Promise<ExecutorResult<T>> => {
+    let timer: ReturnType<typeof setTimeout> | null = null;
+    const timeout = new Promise<ExecutorResult<T>>((resolve) => {
+        timer = setTimeout(
+            () => resolve({ ok: false, failure: "timeout", detail: `no result within ${timeoutMs}ms` }),
+            timeoutMs
+        );
+    });
+    try {
+        return await Promise.race([
+            work.catch(
+                (error): ExecutorResult<T> => ({
+                    ok: false,
+                    failure: "execution_failed",
+                    detail: error instanceof Error ? error.message : String(error),
+                })
+            ),
+            timeout,
+        ]);
+    } finally {
+        if (timer) clearTimeout(timer);
+    }
+};
+
+const hasReproduction = (finding: Finding): boolean =>
+    typeof finding.reproduction === "string" && finding.reproduction.trim() !== "";
+
+/**
+ * A finding the author has to act on, under the operating defaults: one
+ * that comes with a reproduction. The basis says what kind of thing the
+ * reproduction shows; it does not stand in for one.
+ */
+export const isActionable = (finding: Finding): boolean =>
+    (finding.basis === "evidence" || finding.basis === "judgement") && hasReproduction(finding);
+
+const dispose = (finding: Finding, disposition: FindingDisposition): DisposedFinding => ({
+    ...finding,
+    disposition,
+});
+
+const disposeFindings = (findings: readonly Finding[], canRevise: boolean): readonly DisposedFinding[] =>
+    findings.map((finding) => {
+        if (isActionable(finding)) return dispose(finding, canRevise ? "fix_requested" : "unresolved_on_hold");
+        if (finding.basis === "preference") return dispose(finding, "resolved_by_project_rule");
+        return dispose(finding, "insufficient_evidence_kept_current");
+    });
+
+/** Findings that stop a pass: sent back, or left open with no revision to send them to. */
+const blocking = (disposed: readonly DisposedFinding[]): readonly DisposedFinding[] =>
+    disposed.filter((finding) => finding.disposition === "fix_requested" || finding.disposition === "unresolved_on_hold");
+
+/**
+ * The files a unified diff names: `diff --git` headers, and `+++` / `---`
+ * pairs for a diff without them. What the author *says* it changed is
+ * checked against this, so a file left out of `filesChanged` is still seen.
+ */
+export const filesNamedByDiff = (diff: string): readonly string[] => {
+    const named = new Set<string>();
+    let pendingOld: string | null = null;
+    for (const line of diff.split("\n")) {
+        const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
+        if (header) {
+            named.add(header[2]);
+            pendingOld = null;
+            continue;
+        }
+        const removed = /^--- a\/(.+)$/.exec(line);
+        if (removed) {
+            pendingOld = removed[1];
+            continue;
+        }
+        const added = /^\+\+\+ b\/(.+)$/.exec(line);
+        if (added) {
+            named.add(added[1]);
+            pendingOld = null;
+            continue;
+        }
+        if (line.startsWith("+++ /dev/null") && pendingOld) {
+            named.add(pendingOld);
+            pendingOld = null;
+        }
+    }
+    return [...named];
+};
+
+const inScope = (task: CrossReviewTask, file: string): boolean =>
+    task.writableScope.length === 0 ||
+    task.writableScope.some((scope) => file === scope || file.startsWith(scope.endsWith("/") ? scope : `${scope}/`));
+
+const scopeViolations = (task: CrossReviewTask, files: readonly string[]): readonly string[] =>
+    files.filter((file) => !inScope(task, file));
+
+export async function runCrossReview(control: CrossReviewControl): Promise<CrossReviewOutcome> {
+    const roles = control.roles ?? DEFAULT_ROLE_ASSIGNMENT;
+    const maxRevisions = resolveMaxRevisions(control.maxRevisions);
+    const timeoutMs = control.timeoutMs ?? DEFAULT_TIMEOUT_MS;
+    const now = control.now ?? (() => new Date());
+    const task = control.task;
+    const rounds: RoundRecord[] = [];
+
+    const finish = (
+        status: CrossReviewStatus,
+        failure: CrossReviewFailure | null,
+        holdReason: HoldReason | null,
+        nextAction: string
+    ): CrossReviewOutcome => {
+        const last = rounds[rounds.length - 1] ?? null;
+        const exchange: ExchangeRecord = {
+            version: CROSS_REVIEW_VERSION,
+            taskId: task.taskId,
+            requirement: task.requirement,
+            completionCriteria: task.completionCriteria,
+            baseCommit: task.baseCommit,
+            roles,
+            maxRevisions,
+            rounds,
+            changeDigest: last?.changeDigest ?? null,
+            commit: last?.commit ?? null,
+            changeSummary: last?.changeSummary ?? null,
+            testResults: last?.testResults ?? [],
+            guardRuns: last?.guardRuns ?? [],
+            guardViolations: last?.guardViolations ?? [],
+            checkFailures: last?.checkFailures ?? [],
+            reviewConclusion: last?.reviewConclusion ?? null,
+            findings: last?.findings ?? [],
+            nextAction,
+            status,
+            failure,
+            holdReason,
+            producedAt: now().toISOString(),
+        };
+        return { status, failure, holdReason, exchange };
+    };
+
+    let feedback: AuthorRequest["feedback"] = null;
+    let previousFindings: readonly Finding[] = [];
+
+    for (let round = 0; round <= maxRevisions; round += 1) {
+        const produced: ExecutorResult<AuthorOutput> = await withTimeout<AuthorOutput>(
+            control.author.produce({ task, round, feedback }),
+            timeoutMs
+        );
+        if (!produced.ok) {
+            rounds.push({
+                round,
+                changeDigest: "",
+                commit: null,
+                filesChanged: [],
+                changeSummary: "",
+                testResults: [],
+                guardRuns: [],
+                guardViolations: [],
+                checkFailures: [],
+                reviewConclusion: null,
+                findings: [],
+                nextAction: `author ${produced.failure}: ${produced.detail}`,
+            });
+            return finish("failed", `author_${produced.failure}`, null, "the author produced no usable change; nothing was reviewed");
+        }
+        const output: AuthorOutput = produced.value;
+        // The scope check reads the diff as well as the author's list: a
+        // file the diff touches is a file changed, whatever was reported.
+        const named = filesNamedByDiff(output.diff);
+        const touched = [...new Set([...output.filesChanged, ...named])];
+        const violations = scopeViolations(task, touched);
+        if (violations.length > 0) {
+            rounds.push({
+                round,
+                changeDigest: control.digest(output.diff),
+                commit: output.commit ?? null,
+                filesChanged: output.filesChanged,
+                changeSummary: output.summary,
+                testResults: [],
+                guardRuns: [],
+                guardViolations: violations.map((file) => `outside writable scope: ${file}`),
+                checkFailures: violations.map((file) => `outside writable scope: ${file}`),
+                reviewConclusion: null,
+                findings: [],
+                nextAction: "the change touched files outside the task's writable scope",
+            });
+            return finish("failed", "scope_violation", null, "the change touched files outside the task's writable scope; nothing was reviewed");
+        }
+
+        // The control program's digest, of the diff it holds. The author's
+        // own claim about its digest, if it made one, is not consulted.
+        const changeDigest = control.digest(output.diff);
+        const testResults = await control.runTests({
+            diff: output.diff,
+            filesChanged: output.filesChanged,
+            commit: output.commit ?? null,
+        });
+        const guardRuns: readonly GuardRun[] =
+            typeof control.guards === "function" ? await control.guards({ diff: output.diff, filesChanged: output.filesChanged }) : [];
+        const unreported = named.filter((file) => !output.filesChanged.includes(file));
+        const guardViolations: readonly string[] = [
+            ...guardRuns.filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`),
+            ...unreported.map((file) => `the diff names ${file}, which filesChanged does not`),
+        ];
+        const checkFailures: string[] = [];
+        if (testResults.length === 0) checkFailures.push("no test was run");
+        for (const run of testResults) if (!run.passed) checkFailures.push(`test failed: ${run.command}`);
+        if (guardRuns.length === 0) checkFailures.push("no guard was run");
+        for (const run of guardRuns) if (!run.passed) checkFailures.push(`guard failed: ${run.rule}`);
+        for (const file of unreported) checkFailures.push(`the diff names ${file}, which filesChanged does not`);
+        const checksPass = checkFailures.length === 0;
+
+        const reviewed: ExecutorResult<ReviewVerdict> = await withTimeout<ReviewVerdict>(
+            control.reviewer.review({
+                task,
+                round,
+                changeDigest,
+                commit: output.commit ?? null,
+                diff: output.diff,
+                testResults,
+                guardRuns,
+                guardViolations,
+                authorSummary: output.summary,
+                authorSelfAssessment: output.selfAssessment ?? null,
+                previousFindings,
+            }),
+            timeoutMs
+        );
+        const record: RoundRecord = {
+            round,
+            changeDigest,
+            commit: output.commit ?? null,
+            filesChanged: output.filesChanged,
+            changeSummary: output.summary,
+            testResults,
+            guardRuns,
+            guardViolations,
+            checkFailures,
+            reviewConclusion: null,
+            findings: [],
+            nextAction: "",
+        };
+        if (!reviewed.ok) {
+            rounds.push({ ...record, nextAction: `reviewer ${reviewed.failure}: ${reviewed.detail}` });
+            return finish("failed", `reviewer_${reviewed.failure}`, null, "the reviewer returned no usable verdict; the change is not approved");
+        }
+        const verdict = reviewed.value;
+        if (verdict.reviewedDigest !== changeDigest) {
+            rounds.push({
+                ...record,
+                reviewConclusion: verdict.conclusion,
+                nextAction: `the verdict names digest ${verdict.reviewedDigest}, the change is ${changeDigest}`,
+            });
+            return finish("failed", "digest_mismatch", null, "the verdict is about a different change; it does not apply to this one");
+        }
+        if (verdict.taskId !== task.taskId) {
+            rounds.push({ ...record, reviewConclusion: verdict.conclusion, nextAction: `the verdict names task ${verdict.taskId}` });
+            return finish("failed", "task_mismatch", null, "the verdict is about a different task");
+        }
+        if (verdict.round !== round) {
+            rounds.push({ ...record, reviewConclusion: verdict.conclusion, nextAction: `the verdict names round ${verdict.round}` });
+            return finish("failed", "round_mismatch", null, "the verdict is about a different round; an earlier approval is not reused");
+        }
+
+        const canRevise = round < maxRevisions;
+
+        if (verdict.conclusion === "blocked") {
+            rounds.push({
+                ...record,
+                reviewConclusion: "blocked",
+                findings: verdict.findings.map((finding) => dispose(finding, "unresolved_on_hold")),
+                nextAction: verdict.nextAction,
+            });
+            return finish("on_hold", null, "reviewer_blocked", verdict.nextAction || "the reviewer could not review this change; a person decides");
+        }
+
+        if (verdict.conclusion === "approve") {
+            const disposed = disposeFindings(verdict.findings, canRevise);
+            const open = blocking(disposed);
+            if (checksPass && open.length === 0) {
+                rounds.push({ ...record, reviewConclusion: "approve", findings: disposed, nextAction: verdict.nextAction });
+                return finish("passed", null, null, verdict.nextAction || "approved on this digest with tests and guards passing");
+            }
+            // Two executors agreeing is not a pass. Failing checks, or a
+            // reproducible finding named alongside the approval, send the
+            // change back and count a round.
+            const why = [
+                ...checkFailures,
+                ...open.map((finding) => `open finding: ${finding.location}`),
+            ].join("; ");
+            rounds.push({
+                ...record,
+                reviewConclusion: "approve",
+                findings: disposed,
+                nextAction: canRevise
+                    ? `approved, but a required check failed or a finding is open (${why}); the author fixes it and the change is re-reviewed`
+                    : `approved, but a required check failed or a finding is open (${why}) and no revision remains`,
+            });
+            if (!canRevise) {
+                return finish(
+                    "on_hold",
+                    null,
+                    open.length > 0 ? "revisions_exhausted" : "approved_but_checks_failed",
+                    open.length > 0
+                        ? `approved by the reviewer with ${open.length} reproducible finding(s) still open after ${maxRevisions} revision(s); a person decides`
+                        : "approved by the reviewer, refused by the checks; a person decides"
+                );
+            }
+            feedback = {
+                findings: disposed.filter((finding) => finding.disposition === "fix_requested"),
+                failedTests: testResults.filter((run) => !run.passed),
+                guardViolations,
+                checkFailures,
+            };
+            previousFindings = verdict.findings;
+            continue;
+        }
+
+        // request_changes
+        const disposed = disposeFindings(verdict.findings, canRevise);
+        const actionable = disposed.filter((finding) => finding.disposition === "fix_requested");
+        const unresolved = disposed.filter((finding) => finding.disposition === "unresolved_on_hold");
+        if (actionable.length === 0 && unresolved.length === 0 && checksPass) {
+            // Nothing the reviewer raised comes with a reproduction, and the
+            // checks pass: the current version stands, with every finding recorded.
+            rounds.push({
+                ...record,
+                reviewConclusion: "request_changes",
+                findings: disposed,
+                nextAction: "no finding was actionable under the operating defaults; the current version stands",
+            });
+            return finish("passed", null, null, "changes were requested on preference or unreproduced findings only; the current version stands with the findings on record");
+        }
+        rounds.push({
+            ...record,
+            reviewConclusion: "request_changes",
+            findings: disposed,
+            nextAction: canRevise ? verdict.nextAction || "fix and re-review" : "revisions exhausted",
+        });
+        if (!canRevise) {
+            return finish("on_hold", null, "revisions_exhausted", `unresolved after ${maxRevisions} revision(s); on hold with the findings and reproductions recorded`);
+        }
+        feedback = {
+            findings: actionable,
+            failedTests: testResults.filter((run) => !run.passed),
+            guardViolations,
+            checkFailures,
+        };
+        previousFindings = verdict.findings;
+    }
+
+    // Unreachable: every branch above returns before the loop ends.
+    return finish("on_hold", null, "revisions_exhausted", "the loop ended without a verdict");
+}
+
+// ---------------------------------------------------------------------------
+// A person-driven exchange: packaged rounds and their verdicts, replayed.
+
+/** One round as a person packaged it and, once it exists, the verdict on it. */
+export type PackagedRound = {
+    round: number;
+    diff: string;
+    summary: string;
+    filesChanged: readonly string[];
+    commit: string | null;
+    testResults: readonly TestRun[];
+    /** Every guard rule the packager ran, with its result. */
+    guardRuns: readonly GuardRun[];
+    verdict: ReviewVerdict | null;
+};
+
+export type ReplayStatus = CrossReviewStatus | "awaiting_review" | "awaiting_revision";
+
+export type ReplayedExchange = Omit<ExchangeRecord, "status"> & {
+    status: ReplayStatus;
+    packagedRounds: number;
+    /**
+     * The round at which the control program reached passed, on_hold or
+     * failed, or null while it is still waiting on a verdict or a revision.
+     * A package after this round is not part of the exchange.
+     */
+    concludedAtRound: number | null;
+};
+
+/**
+ * Runs the packaged rounds through `runCrossReview` exactly as a live loop
+ * would have, with the packages standing in for the author and the verdicts
+ * for the reviewer, and reads off where it stopped. The two waiting states
+ * are where the stand-ins had nothing to say -- a package with no verdict
+ * yet, or a verdict the control program answered by asking for a revision
+ * nobody has made -- and everything else is the control program's own
+ * outcome. Nothing is decided here that `runCrossReview` did not decide.
+ */
+export async function replayExchange(input: {
+    task: CrossReviewTask;
+    roles?: RoleAssignment;
+    maxRevisions?: number;
+    digest: (diff: string) => string;
+    rounds: readonly PackagedRound[];
+    now?: () => Date;
+}): Promise<ReplayedExchange> {
+    const roles = input.roles ?? DEFAULT_ROLE_ASSIGNMENT;
+    const rounds = input.rounds;
+    if (rounds.length === 0) throw new Error("nothing to replay: no round is packaged");
+    rounds.forEach((entry, index) => {
+        if (entry.round !== index) throw new Error(`packaged rounds must be contiguous from 0; found round ${entry.round} at position ${index}`);
+    });
+    let current = -1;
+    const author: AuthorExecutor = {
+        id: roles.author,
+        produce: async ({ round }) => {
+            const entry = rounds[round];
+            if (!entry) return { ok: false, failure: "missing_result", detail: `no package for round ${round}` };
+            return { ok: true, value: { diff: entry.diff, summary: entry.summary, filesChanged: entry.filesChanged, commit: entry.commit } };
+        },
+    };
+    const reviewer: ReviewerExecutor = {
+        id: roles.reviewer,
+        review: async ({ round }) => {
+            const verdict = rounds[round]?.verdict ?? null;
+            if (!verdict) return { ok: false, failure: "missing_result", detail: `no verdict for round ${round}` };
+            return { ok: true, value: verdict };
+        },
+    };
+    const outcome = await runCrossReview({
+        task: input.task,
+        roles,
+        author,
+        reviewer,
+        digest: input.digest,
+        maxRevisions: input.maxRevisions,
+        now: input.now,
+        runTests: async () => {
+            current += 1;
+            return rounds[current]?.testResults ?? [];
+        },
+        guards: async () => rounds[current]?.guardRuns ?? [],
+    });
+    const consumed = outcome.exchange.rounds.length;
+    const base: ReplayedExchange = {
+        ...outcome.exchange,
+        packagedRounds: rounds.length,
+        concludedAtRound: consumed - 1,
+    };
+    if (outcome.failure === "reviewer_missing_result" && consumed === rounds.length) {
+        const latest = rounds[rounds.length - 1];
+        const open: RoundRecord = { ...outcome.exchange.rounds[consumed - 1], nextAction: "awaiting the reviewer's verdict" };
+        return {
+            ...base,
+            rounds: [...outcome.exchange.rounds.slice(0, -1), open],
+            status: "awaiting_review",
+            failure: null,
+            concludedAtRound: null,
+            nextAction: `hand the review prompt (round ${latest.round}) to the ${roles.reviewer} reviewer; its verdict must name digest ${open.changeDigest}`,
+        };
+    }
+    if (outcome.failure === "author_missing_result" && consumed === rounds.length + 1) {
+        // The control program asked for the next revision; nobody has made it.
+        const reviewed = outcome.exchange.rounds[consumed - 2];
+        return {
+            ...base,
+            rounds: outcome.exchange.rounds.slice(0, -1),
+            changeDigest: reviewed.changeDigest,
+            commit: reviewed.commit,
+            changeSummary: reviewed.changeSummary,
+            testResults: reviewed.testResults,
+            guardRuns: reviewed.guardRuns,
+            guardViolations: reviewed.guardViolations,
+            checkFailures: reviewed.checkFailures,
+            reviewConclusion: reviewed.reviewConclusion,
+            findings: reviewed.findings,
+            status: "awaiting_revision",
+            failure: null,
+            concludedAtRound: null,
+            nextAction: `${reviewed.nextAction}; package round ${consumed - 1} once the change is revised`,
+        };
+    }
+    return base;
+}
+
+/**
+ * The text the reviewer is given, in reading order: requirement, criteria,
+ * the diff, the tests and guards, and only then the author's account of
+ * itself. The reviewer answers with one JSON document in the `ReviewVerdict`
+ * shape.
+ */
+export const renderReviewPrompt = (request: ReviewRequest): string => {
+    const lines: string[] = [];
+    lines.push(`# Independent review — task ${request.task.taskId}, round ${request.round}`);
+    lines.push("");
+    lines.push("Review the change against the original requirement below. Read the requirement and the diff before anything else.");
+    lines.push("Do not take the author's summary as a description of what the change does; the diff is.");
+    lines.push("");
+    lines.push("## Requirement (original)");
+    lines.push("");
+    lines.push(request.task.requirement);
+    lines.push("");
+    lines.push("## Completion criteria");
+    lines.push("");
+    for (const criterion of request.task.completionCriteria) lines.push(`- ${criterion}`);
+    lines.push("");
+    lines.push(`## Change under review — digest ${request.changeDigest}${request.commit ? `, commit ${request.commit}` : ""}`);
+    lines.push("");
+    lines.push("```diff");
+    lines.push(request.diff);
+    lines.push("```");
+    lines.push("");
+    lines.push("## Test results (run by the control program)");
+    lines.push("");
+    if (request.testResults.length === 0) lines.push("- none run");
+    for (const run of request.testResults) {
+        lines.push(`- ${run.passed ? "PASS" : "FAIL"} \`${run.command}\` (${run.durationMs}ms)`);
+        if (run.output.trim()) lines.push(`  ${run.output.trim().split("\n").join("\n  ")}`);
+    }
+    lines.push("");
+    lines.push("## Guard results (run by the control program)");
+    lines.push("");
+    if (request.guardRuns.length === 0) lines.push("- none run");
+    for (const run of request.guardRuns) {
+        lines.push(`- ${run.passed ? "PASS" : "FAIL"} \`${run.rule}\`${run.durationMs !== undefined ? ` (${run.durationMs}ms)` : ""}`);
+        if (run.detail.trim()) lines.push(`  ${run.detail.trim().split("\n").join("\n  ")}`);
+    }
+    if (request.guardViolations.length > 0) {
+        lines.push("");
+        lines.push("## Guard violations");
+        lines.push("");
+        for (const violation of request.guardViolations) lines.push(`- ${violation}`);
+    }
+    if (request.previousFindings.length > 0) {
+        lines.push("");
+        lines.push("## Findings from the previous round (check each was addressed)");
+        lines.push("");
+        for (const finding of request.previousFindings) {
+            lines.push(`- [${finding.severity}/${finding.basis}] ${finding.location}: ${finding.claim}`);
+        }
+    }
+    lines.push("");
+    lines.push("## Author's account (read last; a claim, not a finding)");
+    lines.push("");
+    lines.push(`Summary: ${request.authorSummary}`);
+    if (request.authorSelfAssessment) lines.push(`Self-assessment: ${request.authorSelfAssessment}`);
+    lines.push("");
+    lines.push("## Answer format");
+    lines.push("");
+    lines.push("Reply with exactly one JSON document and nothing else:");
+    lines.push("");
+    lines.push("```json");
+    lines.push(
+        JSON.stringify(
+            {
+                taskId: request.task.taskId,
+                round: request.round,
+                reviewedDigest: request.changeDigest,
+                conclusion: "approve | request_changes | blocked",
+                findings: [
+                    {
+                        location: "path:line or symbol",
+                        severity: "error | warning | nit",
+                        basis: "evidence | preference | judgement",
+                        claim: "what is wrong, in one sentence",
+                        reproduction: "how to see it: a command, or an input and its expected output (required for the finding to be acted on)",
+                    },
+                ],
+                nextAction: "one sentence",
+            },
+            null,
+            2
+        )
+    );
+    lines.push("```");
+    lines.push("");
+    lines.push(
+        "`reviewedDigest` must be the digest above, verbatim. A finding with basis `preference` is settled by the project's rules; any other finding is acted on only with a reproduction, and without one it is recorded and the current version stands."
+    );
+    return `${lines.join("\n")}\n`;
+};
diff --git a/lib/crossReviewExecutors.ts b/lib/crossReviewExecutors.ts
new file mode 100644
index 00000000..f0bf80d5
--- /dev/null
+++ b/lib/crossReviewExecutors.ts
@@ -0,0 +1,409 @@
+/**
+ * Executors for the cross-review loop: scripted mocks for tests and the
+ * offline flow, and command-line shells for Claude Code and Codex that never
+ * run a process unless a caller passes a spawner and asks for live mode.
+ *
+ * ## The boundary
+ *
+ * A command-line executor takes `spawn` as an argument. In `dry-run` mode it
+ * returns `not_executed` without touching it, and a test can hand it a
+ * spawner that throws to prove the point. There is no default spawner: an
+ * executor built without one cannot run anything, whatever mode it is in.
+ * That is the same arrangement `lib/aiReviewEvalLiveAdapter.ts` uses for the
+ * evaluation harness -- whether an invocation can spend is a question about
+ * what was passed in, not about control flow that might be mis-read.
+ *
+ * ## What the shells assume about the tools
+ *
+ * Both are asked for one JSON document on stdout, in the shape the control
+ * program checks (`authorOutputProblems` / `reviewVerdictProblems`). The
+ * prompt says so and the parser tolerates a result printed after streamed
+ * lines. The flag sets below were checked on 2026-09-09 against the installed
+ * tools -- codex-cli 0.146.0 and Claude Code 2.1.261 -- and, for the event
+ * shape, against the `codex` source at tag `rust-v0.146.0`; what each check
+ * covered is written next to the invocation. `CLI_INVOCATIONS` exists so that
+ * check is a comparison against one place, and it is due again whenever
+ * either tool is upgraded.
+ *
+ * ## Why the reviewer ignores the user's configuration
+ *
+ * The sandbox bounds shell commands, not the tools a configuration adds. A
+ * `~/.codex/config.toml` may register MCP servers and plugins that execute
+ * outside the sandbox (an infrastructure CLI, a JavaScript REPL, desktop
+ * control), and `-c mcp_servers={}` merges rather than replaces, so nothing
+ * short of `--ignore-user-config` takes them away. The reviewer therefore
+ * runs with the user layer empty; what a run still needs from configuration
+ * -- the model, or the Windows sandbox backend -- is passed explicitly as an
+ * override from the allow list below and recorded with the command.
+ */
+
+import {
+    authorOutputProblems,
+    parseExecutorJson,
+    renderReviewPrompt,
+    reviewVerdictProblems,
+    type AuthorExecutor,
+    type AuthorOutput,
+    type AuthorRequest,
+    type CrossReviewRole,
+    type ExecutorResult,
+    type ReviewerExecutor,
+    type ReviewRequest,
+    type ReviewVerdict,
+} from "@/lib/crossReviewCore";
+
+export type ExecutorMode = "mock" | "dry-run" | "live";
+
+/** One scripted answer per round. A function may inspect the request. */
+export type MockAuthorScript = readonly (
+    | ExecutorResult<AuthorOutput>
+    | ((request: AuthorRequest) => ExecutorResult<AuthorOutput>)
+)[];
+
+export type MockReviewerScript = readonly (
+    | ExecutorResult<ReviewVerdict>
+    /** `reviewedDigest: "@current"` in a scripted verdict is replaced with the request's digest. */
+    | ((request: ReviewRequest) => ExecutorResult<ReviewVerdict>)
+)[];
+
+const missing = <T>(role: string, round: number): ExecutorResult<T> => ({
+    ok: false,
+    failure: "missing_result",
+    detail: `the mock ${role} has no scripted answer for round ${round}`,
+});
+
+export const mockAuthor = (id: string, script: MockAuthorScript): AuthorExecutor & { calls: AuthorRequest[] } => {
+    const calls: AuthorRequest[] = [];
+    return {
+        id,
+        calls,
+        produce: async (request) => {
+            calls.push(request);
+            const entry = script[request.round];
+            if (entry === undefined) return missing<AuthorOutput>("author", request.round);
+            return typeof entry === "function" ? entry(request) : entry;
+        },
+    };
+};
+
+export const mockReviewer = (
+    id: string,
+    script: MockReviewerScript
+): ReviewerExecutor & { calls: ReviewRequest[] } => {
+    const calls: ReviewRequest[] = [];
+    return {
+        id,
+        calls,
+        review: async (request) => {
+            calls.push(request);
+            const entry = script[request.round];
+            if (entry === undefined) return missing<ReviewVerdict>("reviewer", request.round);
+            const result = typeof entry === "function" ? entry(request) : entry;
+            if (result.ok && result.value.reviewedDigest === "@current") {
+                return { ok: true, value: { ...result.value, reviewedDigest: request.changeDigest } };
+            }
+            return result;
+        },
+    };
+};
+
+/** A scripted reviewer answer that approves whatever it is shown, on the right digest. */
+export const approveCurrent = (taskId: string, round: number, nextAction = "merge"): ExecutorResult<ReviewVerdict> => ({
+    ok: true,
+    value: { taskId, round, reviewedDigest: "@current", conclusion: "approve", findings: [], nextAction },
+});
+
+/** What a spawner returns. Mirrors the useful part of `child_process.spawnSync`. */
+export type SpawnResult = {
+    status: number | null;
+    stdout: string;
+    stderr: string;
+    /** True when the spawner itself enforced a timeout. */
+    timedOut?: boolean;
+    error?: Error;
+};
+
+export type Spawner = (
+    command: string,
+    args: readonly string[],
+    options: { input: string; cwd: string; timeoutMs: number; env?: Record<string, string | undefined> }
+) => Promise<SpawnResult>;
+
+export type CliInvocation = {
+    command: string;
+    /** Fixed arguments. Per-run configuration overrides, if any, come after them. */
+    args: readonly string[];
+    /**
+     * The flag that carries one `key=value` configuration override, for a
+     * tool that has one (`codex -c`). A tool without one refuses overrides.
+     */
+    configFlag?: string;
+    /** The final argument that makes the tool read its prompt from stdin, for a tool that needs one (`codex exec -`). */
+    promptArg?: string;
+    /** What the invocation is for and what was checked, so a reader can compare it with `--help`. */
+    note: string;
+};
+
+/**
+ * The intended invocations, one per tool and role.
+ *
+ * Checked 2026-09-09. Claude Code 2.1.261 lists every flag used here in
+ * `claude --help`; neither Claude Code invocation has been run. codex-cli
+ * 0.146.0 lists `--sandbox` on the root command and on `exec`, and `exec`
+ * documents `--json` ("Print events to stdout as JSONL"), `-` ("instructions
+ * are read from stdin"), `--ignore-user-config` and `-c`; `codex exec` sets
+ * the approval policy to `never` in its own source (`exec/src/lib.rs`, "Default
+ * to never ask for approvals in headless mode"), so a command the read-only
+ * sandbox refuses is rejected rather than escalated.
+ */
+export const CLI_INVOCATIONS: Readonly<Record<"claude" | "codex", Readonly<Record<CrossReviewRole, CliInvocation>>>> = {
+    claude: {
+        author: {
+            command: "claude",
+            args: ["--print", "--output-format", "json", "--permission-mode", "acceptEdits"],
+            note: "Claude Code non-interactive; may edit within the task's writable scope; result JSON on stdout.",
+        },
+        reviewer: {
+            command: "claude",
+            args: ["--print", "--output-format", "json", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--strict-mcp-config"],
+            note:
+                "Claude Code non-interactive with only the read tools built in (`--tools`), pre-approved so nothing prompts " +
+                "(`--allowedTools`), and no MCP server (`--strict-mcp-config` with no `--mcp-config`). Nothing offered can write.",
+        },
+    },
+    codex: {
+        author: {
+            command: "codex",
+            args: ["--sandbox", "workspace-write", "exec", "--json"],
+            configFlag: "-c",
+            promptArg: "-",
+            note:
+                "Codex non-interactive: prompt on stdin (`-`), `--json` prints JSONL events, the final agent_message " +
+                "carries the document. Writes are confined to the working directory by the sandbox.",
+        },
+        reviewer: {
+            command: "codex",
+            args: ["--sandbox", "read-only", "exec", "--ignore-user-config", "--json"],
+            configFlag: "-c",
+            promptArg: "-",
+            note:
+                "Codex non-interactive in the read-only sandbox with the user's config.toml ignored: no MCP server, plugin " +
+                "or hook from the user's setup, since those run outside the sandbox; the stored login is still used. " +
+                "What a run needs from configuration is passed as `-c` overrides from REVIEWER_CONFIG_OVERRIDE_KEYS.",
+        },
+    },
+};
+
+/**
+ * Configuration keys a reviewer run may override. Anything that would widen
+ * what the reviewer can do -- the sandbox mode, approvals, MCP servers,
+ * plugins, features, the shell environment policy -- is absent, so it cannot
+ * be passed. `windows.sandbox` is here because with the user layer ignored
+ * the Windows backend is otherwise unset, and unset means commands are
+ * rejected (`codex` refuses to run unsandboxed), not that they run free.
+ */
+export const REVIEWER_CONFIG_OVERRIDE_KEYS: readonly string[] = [
+    "model",
+    "model_reasoning_effort",
+    "windows.sandbox",
+    "windows.sandbox_private_desktop",
+];
+
+export type CliCommandLine = { ok: true; args: readonly string[] } | { ok: false; detail: string };
+
+/**
+ * The full argument list for one run: the fixed arguments, then one
+ * `configFlag key=value` per override, then the stdin marker. Overrides are
+ * refused for a tool without a config flag, when malformed, and -- when an
+ * allow list is given -- for any key outside it.
+ */
+export const cliCommandLine = (
+    invocation: CliInvocation,
+    configOverrides: readonly string[] = [],
+    allowedKeys: readonly string[] | null = null
+): CliCommandLine => {
+    if (configOverrides.length > 0 && !invocation.configFlag) {
+        return { ok: false, detail: `${invocation.command} takes no configuration override; got ${configOverrides.join(", ")}` };
+    }
+    const overrideArgs: string[] = [];
+    for (const override of configOverrides) {
+        const separator = override.indexOf("=");
+        const key = separator === -1 ? "" : override.slice(0, separator).trim();
+        if (key === "") return { ok: false, detail: `a configuration override must be key=value; got \`${override}\`` };
+        if (allowedKeys && !allowedKeys.includes(key)) {
+            return {
+                ok: false,
+                detail: `configuration override \`${key}\` is not allowed for this role; allowed: ${allowedKeys.join(", ")}`,
+            };
+        }
+        overrideArgs.push(invocation.configFlag as string, override);
+    }
+    return { ok: true, args: [...invocation.args, ...overrideArgs, ...(invocation.promptArg ? [invocation.promptArg] : [])] };
+};
+
+export type CliExecutorOptions = {
+    id: string;
+    invocation: CliInvocation;
+    mode: Exclude<ExecutorMode, "mock">;
+    cwd: string;
+    timeoutMs: number;
+    /** Required for `live`; ignored -- never called -- in `dry-run`. */
+    spawn?: Spawner;
+    env?: Record<string, string | undefined>;
+    /** `key=value` configuration overrides, each passed with the invocation's `configFlag`. */
+    configOverrides?: readonly string[];
+};
+
+const notExecuted = <T>(mode: string, command: string, args: readonly string[]): ExecutorResult<T> => ({
+    ok: false,
+    failure: "not_executed",
+    detail: `${mode}: would run \`${[command, ...args].join(" ")}\` with the prompt on stdin`,
+});
+
+const runCli = async <T>(
+    options: CliExecutorOptions,
+    role: CrossReviewRole,
+    prompt: string,
+    problemsOf: (value: unknown) => readonly string[]
+): Promise<ExecutorResult<T>> => {
+    const line = cliCommandLine(
+        options.invocation,
+        options.configOverrides ?? [],
+        role === "reviewer" ? REVIEWER_CONFIG_OVERRIDE_KEYS : null
+    );
+    if (!line.ok) return { ok: false, failure: "execution_failed", detail: line.detail };
+    if (options.mode === "dry-run") return notExecuted<T>("dry-run", options.invocation.command, line.args);
+    if (!options.spawn) {
+        return { ok: false, failure: "execution_failed", detail: "live mode with no spawner; nothing was run" };
+    }
+    let result: SpawnResult;
+    try {
+        result = await options.spawn(options.invocation.command, line.args, {
+            input: prompt,
+            cwd: options.cwd,
+            timeoutMs: options.timeoutMs,
+            env: options.env,
+        });
+    } catch (error) {
+        return { ok: false, failure: "execution_failed", detail: error instanceof Error ? error.message : String(error) };
+    }
+    if (result.timedOut) return { ok: false, failure: "timeout", detail: `${options.invocation.command} exceeded ${options.timeoutMs}ms` };
+    if (result.error) return { ok: false, failure: "execution_failed", detail: result.error.message };
+    if (result.status !== 0) {
+        return {
+            ok: false,
+            failure: "execution_failed",
+            detail: `${options.invocation.command} exited ${result.status}: ${result.stderr.trim().slice(0, 400)}`,
+        };
+    }
+    return parseExecutorJson<T>(unwrapCodexJsonl(unwrapClaudeResult(result.stdout)), problemsOf);
+};
+
+/**
+ * Codex's `exec --json` prints one event per line; the model's final message
+ * arrives as `{"type":"item.completed","item":{"id":…,"type":"agent_message",
+ * "text":…}}` (`codex-rs/exec/src/exec_events.rs` at tag `rust-v0.146.0`:
+ * `ThreadEvent` tagged by `type`, `ThreadItem` flattening `ThreadItemDetails`
+ * tagged by `type`, `AgentMessageItem { text }`). That text is the document
+ * asked for; the last such message wins. The older `{"msg":{"type":
+ * "agent_message","message":…}}` shape is read too. Output that is not JSONL
+ * is returned untouched for the parser to judge.
+ */
+export const unwrapCodexJsonl = (stdout: string): string => {
+    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
+    if (lines.length === 0) return stdout;
+    let last: string | null = null;
+    for (const line of lines) {
+        let event: unknown;
+        try {
+            event = JSON.parse(line);
+        } catch {
+            return stdout;
+        }
+        if (typeof event !== "object" || event === null) continue;
+        const item = (event as { item?: { type?: unknown; text?: unknown } }).item;
+        if (item && item.type === "agent_message" && typeof item.text === "string") last = item.text;
+        const msg = (event as { msg?: { type?: unknown; message?: unknown } }).msg;
+        if (msg && msg.type === "agent_message" && typeof msg.message === "string") last = msg.message;
+    }
+    return last ?? stdout;
+};
+
+/**
+ * Claude Code's `--output-format json` wraps the answer in an envelope whose
+ * `result` field holds the model's text. The text is what carries the
+ * document asked for; the envelope is not it. Any other output is returned
+ * as-is for the parser to read directly.
+ */
+export const unwrapClaudeResult = (stdout: string): string => {
+    try {
+        const parsed = JSON.parse(stdout.trim()) as unknown;
+        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
+            const result = (parsed as { result?: unknown }).result;
+            if (typeof result === "string") return result;
+        }
+    } catch {
+        // not an envelope
+    }
+    return stdout;
+};
+
+export const renderAuthorPrompt = (request: AuthorRequest): string => {
+    const lines: string[] = [];
+    lines.push(`# Author — task ${request.task.taskId}, round ${request.round}`);
+    lines.push("");
+    lines.push("## Requirement");
+    lines.push("");
+    lines.push(request.task.requirement);
+    lines.push("");
+    lines.push("## Completion criteria");
+    lines.push("");
+    for (const criterion of request.task.completionCriteria) lines.push(`- ${criterion}`);
+    lines.push("");
+    lines.push(`Base commit: ${request.task.baseCommit}. You may change only: ${request.task.writableScope.join(", ") || "(unrestricted)"}.`);
+    if (request.feedback) {
+        lines.push("");
+        lines.push("## Findings to address from the previous review");
+        lines.push("");
+        for (const finding of request.feedback.findings) {
+            lines.push(`- [${finding.severity}/${finding.basis}] ${finding.location}: ${finding.claim}`);
+            if (finding.reproduction) lines.push(`  reproduction: ${finding.reproduction}`);
+        }
+        for (const run of request.feedback.failedTests) lines.push(`- FAILED \`${run.command}\`: ${run.output.trim().slice(0, 300)}`);
+        for (const violation of request.feedback.guardViolations) lines.push(`- guard: ${violation}`);
+        for (const failure of request.feedback.checkFailures) {
+            if (!failure.startsWith("test failed:") && !failure.startsWith("guard:")) lines.push(`- check: ${failure}`);
+        }
+    }
+    lines.push("");
+    lines.push("## Answer format");
+    lines.push("");
+    lines.push("When the change is made, reply with exactly one JSON document and nothing else:");
+    lines.push("");
+    lines.push("```json");
+    lines.push(
+        JSON.stringify(
+            {
+                diff: "unified diff of the change against the base commit",
+                summary: "what changed, in a few sentences",
+                filesChanged: ["path/one", "path/two"],
+                selfAssessment: "optional: your own view of the risks",
+                commit: "commit sha, or null for an uncommitted worktree",
+            },
+            null,
+            2
+        )
+    );
+    lines.push("```");
+    return `${lines.join("\n")}\n`;
+};
+
+export const cliAuthor = (options: CliExecutorOptions): AuthorExecutor => ({
+    id: options.id,
+    produce: (request) => runCli<AuthorOutput>(options, "author", renderAuthorPrompt(request), authorOutputProblems),
+});
+
+export const cliReviewer = (options: CliExecutorOptions): ReviewerExecutor => ({
+    id: options.id,
+    review: (request) => runCli<ReviewVerdict>(options, "reviewer", renderReviewPrompt(request), reviewVerdictProblems),
+});
diff --git a/lib/routerFullCatalogDiagnostic.ts b/lib/routerFullCatalogDiagnostic.ts
new file mode 100644
index 00000000..218bae11
--- /dev/null
+++ b/lib/routerFullCatalogDiagnostic.ts
@@ -0,0 +1,995 @@
+/**
+ * What the Router would do with the whole catalogue, item by item, offline.
+ *
+ * ## What this is for
+ *
+ * The product's decision (`lib/routerDecision.ts`) answers "which model serves
+ * this turn". It records the eligible set, every rejection with a reason, the
+ * winner and the criterion that separated the top two. It does not say, for
+ * each model that was not chosen, why *that* model lost; it does not say
+ * whether the choice rested on any quality evidence at all; and it does not
+ * compare the output cap it routed under with the one dispatch will actually
+ * apply. Those are the questions somebody improving the Router has to ask
+ * before they can tell whether the whole catalogue is really being
+ * considered, and this module answers them.
+ *
+ * ## What this is not
+ *
+ * Not a second router. Every disposition here comes from the product's own
+ * functions, called with the product's own inputs: `decideRouterModel` makes
+ * the decision, `filterRouterCandidates` and `selectRouterModel` are called
+ * again only to *explain* it, and `consistency` records whether the
+ * explanation agrees with the decision. A disagreement is reported, never
+ * reconciled -- a diagnostic that patched over a difference between itself
+ * and the product would be describing a Router the product does not run.
+ *
+ * Not an evaluation. An unmeasured model is reported as unmeasured: its band
+ * is whatever the score policy says (neutral, today, for every cell), and
+ * nothing here moves a band, invents an interval or promotes a model. The
+ * evidence columns exist to make the absence of evidence legible, which is a
+ * different thing from filling it.
+ *
+ * ## Inputs the product has that this does not
+ *
+ * The product routes over the runtime registry's rows, with health exclusions
+ * and measured tie-break signals read from the database, under the account's
+ * plan and credits, with the conversation's sticky state. This runs over
+ * whatever catalogue the caller passes -- the static one, usually -- with no
+ * sticky state and only the signals the caller supplies. Every one of those
+ * differences is a way the product's answer can differ from this one, and
+ * `DiagnosticReport.inputs` records which values were used so a reader can
+ * tell what the answer is conditional on.
+ *
+ * Pure. No I/O, no clock unless injected, no network, no model call.
+ */
+
+import { autoFallbackScope, type FallbackScope } from "@/lib/autoFallbackGate";
+import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
+import { toReservedInputTokens } from "@/lib/chatTokenEstimate";
+import { resolveModelPricing } from "@/lib/modelPricing";
+import type { AiModel, AiProvider, ModelTier } from "@/lib/models";
+import {
+    filterRouterCandidates,
+    type CandidateRejection,
+    type RouterCandidate,
+} from "@/lib/routerCandidates";
+import { expectedTotalCostUsdByModel } from "@/lib/routerCostSignal";
+import {
+    decideRouterModel,
+    ROUTER_VERSIONS,
+    type RouterDecision,
+    type RouterVersions,
+} from "@/lib/routerDecision";
+import {
+    getRouterScoreCell,
+    isRouterScoreSnapshotModel,
+    NEUTRAL_QUALITY_BAND,
+    rankingKindFor,
+    ROUTER_TIE_BREAK_ORDER,
+    type RouterQualityBand,
+    type RouterTieBreakCriterion,
+    type RouterTieBreakSignals,
+} from "@/lib/routerScorePolicy";
+import { selectRouterModel, type SelectionReason } from "@/lib/routerSelection";
+import { decideFallback, MAX_MODEL_FALLBACKS, type FallbackDecision } from "@/lib/routingFallbackPolicy";
+import type { TaskKind, TaskProfile } from "@/lib/taskProfileCore";
+import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
+
+/** Bump with any change to the shape of the report or how a row is derived. */
+export const ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION = "router-full-catalog-diagnostic-v2";
+
+/** One request to diagnose. The shape `EvalSetItem` already has, and no more. */
+export type DiagnosticItem = {
+    id: string;
+    stratum?: string;
+    cell?: string;
+    prompt: string;
+    attachments?: readonly { mediaType?: string }[];
+    webSearchRequested?: boolean;
+};
+
+export type DiagnosticInput = {
+    items: readonly DiagnosticItem[];
+    /** The whole catalogue, disabled and unlisted models included. */
+    models: readonly AiModel[];
+    plan: ModelTier | "Guest";
+    /**
+     * The model whose output cap the Router routes under.
+     *
+     * The product resolves `requestOutputCapTokens` from the model the user
+     * had selected *before* Auto ran (`app/api/chat/route.ts`, the
+     * `selectAutoModel` call), and the candidate filter fits that one figure
+     * to every candidate's window. It is an input here for the same reason:
+     * the diagnostic has to route under the cap the product would, and
+     * report what changes when dispatch then budgets the chosen model under
+     * its own.
+     */
+    requestedModelId: string;
+    searchBackendReadiness: WebSearchBackendReadiness;
+    unhealthyModelIds?: readonly string[];
+    regionBlockedModelIds?: readonly string[];
+    availableCredits?: number;
+    creditsByModelId?: Readonly<Record<string, number>>;
+    signals?: RouterTieBreakSignals;
+    /**
+     * The environment the fallback gate reads its flag from. Defaults to an
+     * empty one, which is the shipped state: `AUTO_ROUTER_FALLBACK_ENABLED`
+     * unset, so no fallback executes. `fallback.scopeIfFlagOn` is computed
+     * under the flag regardless, so the report shows both what would happen
+     * today and what would happen once the flag is turned on.
+     */
+    fallbackEnvironment?: Record<string, string | undefined>;
+    /** Where the catalogue came from, for the record. */
+    catalogueSource?: string;
+    now?: () => number;
+};
+
+export type QualityEvidenceStatus =
+    /** The score policy holds no approved record for this (model, task). */
+    | "no_evidence"
+    /** An approved record moved this cell off neutral. */
+    | "approved_evidence";
+
+/**
+ * The failure the fallback question is asked about. `decideFallback` decides
+ * on what happened to the primary, and offline nothing has happened, so the
+ * diagnostic asks the one question the fallback path exists for: the primary
+ * failed at the provider before any token was shown, with none of §7's
+ * excluded answers. Every other failure shape terminates by policy, and a
+ * report that picked one of those would be reporting that fallback is
+ * refused, which is true and useless.
+ */
+export const FALLBACK_FAILURE_HYPOTHESIS = {
+    outcome: "failed_pre_token",
+    failureLayer: "provider",
+    providerRefusal: null,
+    visibleTokenEmitted: false,
+    passThroughUsed: false,
+    rerouteCount: 0,
+} as const;
+
+/** `decideFallback`'s own answer under the hypothesis, recorded as given. */
+export type FallbackDecisionRecord = {
+    version: string;
+    action: FallbackDecision["action"];
+    modelId: string | null;
+    reason: string | null;
+};
+
+/**
+ * Whether a turn could reach a fallback, as far as can be decided offline,
+ * in the product's own order (`app/api/chat/route.ts`, `attemptFallback`):
+ * the gate (`autoFallbackScope`), then `decideFallback` under the stated
+ * hypothesis, then the one candidate it names fitted under dispatch's cap
+ * the way `planAttemptExecution` fits it. `refusal` names the step that
+ * said no: `gate:<reason>`, `decision:<reason>`, or
+ * `candidate_context_window_exceeded`.
+ *
+ * `planAttemptExecution` itself is not called: it builds the provider client
+ * and the credit budget for a real dispatch, which an offline report has no
+ * account, credentials or reservation for. Its refusals that depend on
+ * those, and the two runtime checks the route makes around it, are listed
+ * in `undecidedOffline` on every reachable answer, so `reachable: true`
+ * reads as "nothing decidable offline refused it" and not as a promise.
+ */
+export type FallbackReachability =
+    | {
+          reachable: true;
+          modelId: string;
+          dispatchFit: "fitted" | "unbounded";
+          dispatchOutputTokens: number | null;
+          undecidedOffline: readonly string[];
+      }
+    | { reachable: false; refusal: string };
+
+export const FALLBACK_UNDECIDED_OFFLINE: readonly string[] = [
+    "search_path_unavailable: planAttemptExecution refuses a candidate that cannot search when the primary's turn had a search path; the request's web-search mode is not an input here",
+    "budget_refused: createChatBudget and reserveTurnSearchCost need the account's credits and the provider budget",
+    "candidate_unavailable: the runtime registry row's enabled and catalogDeleted state; this report reads the catalogue passed in",
+    "no_provider_hold: the primary's provider reservation for this turn",
+];
+
+export type ModelDisposition = {
+    modelId: string;
+    provider: AiProvider;
+    apiModel: string;
+    enabled: boolean;
+    publiclyListed: boolean;
+    minimumPlan: AiModel["minimumPlan"];
+    contextWindowTokens: number | null;
+    /** Enrolled in `ROUTER_SCORE_SNAPSHOT`. Absence is unmeasured, not bad. */
+    inScoreSnapshot: boolean;
+    disposition: "primary" | "fallback_candidate" | "rejected";
+    /** The first hard filter it failed, or null when it was eligible. */
+    rejectionReason: CandidateRejection | null;
+    /** 1-based position in the Router's ranking; null when rejected. */
+    rank: number | null;
+    /** Output room the Router computed for it; null when rejected. */
+    routerOutputTokens: number | null;
+    quality: {
+        band: RouterQualityBand;
+        evidenceRef: string | null;
+        qualityCi95Lower: number | null;
+        status: QualityEvidenceStatus;
+    };
+    /** The cost figure the tie-break compared, from the pricing registry. */
+    expectedTotalCostUsd: number | null;
+    /**
+     * How this model compares with the primary, head to head, using the
+     * product's own comparator. Null for the primary itself and for rejected
+     * models. `wouldBeatPrimary` is true when the pairwise call picks this
+     * model over the primary -- possible only if the tie-break's epsilons
+     * make the order non-transitive, and reported rather than hidden when it
+     * happens.
+     */
+    versusPrimary: {
+        decidedBy: RouterTieBreakCriterion;
+        marginBands: number;
+        wouldBeatPrimary: boolean;
+    } | null;
+};
+
+export type CapReconciliation = {
+    /** What the Router routed every candidate under. */
+    routerRequestOutputCapTokens: number;
+    routerReservedInputTokens: number;
+    /** The primary's own figures, as dispatch will resolve them. */
+    primary: {
+        modelId: string;
+        routerOutputTokens: number;
+        dispatchRequestOutputCapTokens: number;
+        dispatchProviderMaxOutputTokens: number | null;
+        dispatchReservedInputTokens: number;
+        dispatchOutputTokens: number | null;
+        dispatchFit: "fitted" | "unbounded" | "exceeded";
+        outputCapDiffers: boolean;
+        reservedInputDiffers: boolean;
+    } | null;
+    /**
+     * What the offline reservation does not model: dispatch adds a search
+     * tool's input overhead and prices under the account's access kind.
+     * Stated so the `dispatchReservedInputTokens` figure is read as a floor.
+     */
+    notModelled: readonly string[];
+};
+
+export type ItemDiagnostic = {
+    itemId: string;
+    stratum: string | null;
+    cell: string | null;
+    profile: {
+        version: string;
+        kind: TaskKind;
+        kindConfidence: TaskProfile["kindConfidence"];
+        /** The snapshot column that actually ranked this item. */
+        rankingKind: TaskKind;
+        needsCurrentInformation: boolean;
+        hasImageInput: boolean;
+        hasDocumentInput: boolean;
+        expectedOutputLength: TaskProfile["expectedOutputLength"];
+        signals: readonly string[];
+    };
+    decision: {
+        outcome: RouterDecision["outcome"];
+        primaryModelId: string | null;
+        selectionReason: SelectionReason;
+        decidedBy: RouterTieBreakCriterion | null;
+        marginBands: number;
+        rankedModelIds: readonly string[];
+        fallbackCandidateModelIds: readonly string[];
+    };
+    /** Every model in the catalogue, in catalogue order. */
+    models: readonly ModelDisposition[];
+    fallback: {
+        /** Best first, from the Router; what §7 may try. */
+        rankedCandidateModelIds: readonly string[];
+        /** How many of those a turn may actually fall back to. */
+        maxModelFallbacks: number;
+        scopeAsDeployed: FallbackScope;
+        scopeIfFlagOn: FallbackScope;
+        /**
+         * The candidate `decideFallback` would name -- the first ranked one --
+         * re-fitted under dispatch's own cap the way `planAttemptExecution`
+         * will. Null when there is none. Whether a turn could reach it is the
+         * next two fields' question, not this one's: a candidate the gate
+         * refuses, or one dispatch cannot fit, is still listed here.
+         */
+        firstCandidate: {
+            modelId: string;
+            dispatchFit: "fitted" | "unbounded" | "exceeded";
+            dispatchOutputTokens: number | null;
+        } | null;
+        /**
+         * `decideFallback`'s own answer, called with the product's function
+         * under `FALLBACK_FAILURE_HYPOTHESIS` and the Router's ranked
+         * candidates. The product tries the one candidate it names and no
+         * other (`MAX_MODEL_FALLBACKS`).
+         */
+        decision: FallbackDecisionRecord;
+        /**
+         * Whether a turn could reach a fallback as deployed, as far as can be
+         * decided offline: gate, decision, dispatch fit, in the product's
+         * order. A refusal at any step is the turn ending on the primary's
+         * failure, and `refusal` names the step.
+         */
+        reachableAsDeployed: FallbackReachability;
+        /** The same question with `AUTO_ROUTER_FALLBACK_ENABLED` turned on. */
+        reachableIfFlagOn: FallbackReachability;
+        /**
+         * What the product decides at runtime that this cannot: the
+         * hypothesis the decision was asked under, and the refusals only a
+         * real dispatch can raise. Stated so the two answers above are read
+         * as necessary conditions, not a promise.
+         */
+        notModelled: readonly string[];
+    };
+    caps: CapReconciliation;
+    evidence: {
+        rankingKind: TaskKind;
+        eligibleWithEvidence: readonly string[];
+        eligibleWithoutEvidence: readonly string[];
+        /** True when no quality evidence touched the choice. */
+        decidedWithoutQualityEvidence: boolean;
+    };
+    consistency: {
+        agreesWithProduct: boolean;
+        problems: readonly string[];
+    };
+};
+
+export type ImprovementCandidate = {
+    /** Fixed identifier, never prose derived from a prompt. */
+    kind:
+        | "context_window_undeclared"
+        | "never_eligible"
+        | "eligible_never_primary"
+        | "no_quality_evidence_for_kind"
+        | "decided_by_tie_break"
+        | "web_search_capability_gap"
+        | "output_cap_mismatch"
+        | "pairwise_inversion"
+        | "fallback_candidate_does_not_fit";
+    modelIds: readonly string[];
+    taskKinds: readonly TaskKind[];
+    itemCount: number;
+    detail: string;
+};
+
+export type DiagnosticReport = {
+    version: string;
+    routerVersions: RouterVersions;
+    inputs: {
+        catalogueSource: string;
+        catalogueModelCount: number;
+        enabledModelCount: number;
+        itemCount: number;
+        plan: ModelTier | "Guest";
+        requestedModelId: string;
+        routerRequestOutputCapTokens: number;
+        searchBackendReadiness: WebSearchBackendReadiness;
+        signalsSupplied: readonly (keyof RouterTieBreakSignals)[];
+        unhealthyModelIds: readonly string[];
+        stickyState: "none";
+        fallbackFlagAsDeployed: "on" | "off";
+    };
+    items: readonly ItemDiagnostic[];
+    summary: {
+        primaryCounts: Readonly<Record<string, number>>;
+        primaryCountsByKind: Readonly<Record<TaskKind, Readonly<Record<string, number>>>>;
+        decidedByCounts: Readonly<Record<RouterTieBreakCriterion | "none", number>>;
+        rejectionCounts: Readonly<Record<CandidateRejection, number>>;
+        /** Models never eligible on any item, with every reason they were refused for. */
+        neverEligible: readonly { modelId: string; reasons: readonly CandidateRejection[] }[];
+        eligibleNeverPrimary: readonly string[];
+        evidenceCells: { withEvidence: number; total: number };
+        outputCapMismatchItems: number;
+        consistencyProblems: number;
+        pairwiseInversions: number;
+        fallbackScopeAsDeployed: Readonly<Record<string, number>>;
+        /** Items by `reachable` or by the refusal that stopped them, as deployed. */
+        fallbackReachableAsDeployed: Readonly<Record<string, number>>;
+        /** The same with the flag on. */
+        fallbackReachableIfFlagOn: Readonly<Record<string, number>>;
+    };
+    improvementCandidates: readonly ImprovementCandidate[];
+    /** Anything that stops this report being read as the product's answer. */
+    problems: readonly string[];
+};
+
+const versionOf = (): RouterVersions => ROUTER_VERSIONS;
+
+const qualityFor = (modelId: string, kind: TaskKind) => {
+    const cell = getRouterScoreCell(modelId, kind);
+    return {
+        band: cell.qualityBand,
+        evidenceRef: cell.evidenceRef,
+        qualityCi95Lower: cell.qualityCi95Lower,
+        status: (cell.evidenceRef === null ? "no_evidence" : "approved_evidence") as QualityEvidenceStatus,
+    };
+};
+
+const sameList = (left: readonly string[], right: readonly string[]) =>
+    left.length === right.length && left.every((value, index) => value === right[index]);
+
+/** `decideFallback`, asked the product's question under the stated hypothesis. */
+export const fallbackDecisionFor = (primaryModelId: string, rankedCandidateModelIds: readonly string[]): FallbackDecisionRecord => {
+    const decision = decideFallback({
+        attempt: {
+            modelId: primaryModelId,
+            outcome: FALLBACK_FAILURE_HYPOTHESIS.outcome,
+            failureLayer: FALLBACK_FAILURE_HYPOTHESIS.failureLayer,
+            providerRefusal: FALLBACK_FAILURE_HYPOTHESIS.providerRefusal,
+        },
+        run: {
+            passThroughUsed: FALLBACK_FAILURE_HYPOTHESIS.passThroughUsed,
+            rerouteCount: FALLBACK_FAILURE_HYPOTHESIS.rerouteCount,
+            visibleTokenEmitted: FALLBACK_FAILURE_HYPOTHESIS.visibleTokenEmitted,
+        },
+        nextCandidateModelIds: rankedCandidateModelIds,
+    });
+    return {
+        version: decision.version,
+        action: decision.action,
+        modelId: decision.action === "terminate" ? null : decision.modelId,
+        reason: decision.action === "terminate" ? decision.reason : null,
+    };
+};
+
+/**
+ * Whether a turn could reach a fallback, in the product's own order
+ * (`app/api/chat/route.ts`, `attemptFallback`): the gate first, then the
+ * decision, then dispatch fitting the one candidate the decision names.
+ * `candidate` is that candidate as dispatch would fit it, or null when the
+ * decision named none. The refusals only a real dispatch can raise are
+ * carried on every reachable answer.
+ */
+export const fallbackReachabilityFor = (
+    scope: FallbackScope,
+    decision: FallbackDecisionRecord,
+    candidate: ItemDiagnostic["fallback"]["firstCandidate"]
+): FallbackReachability => {
+    if (!scope.allowed) return { reachable: false, refusal: `gate:${scope.reason}` };
+    if (decision.action !== "fallback") return { reachable: false, refusal: `decision:${decision.reason ?? decision.action}` };
+    if (!candidate || candidate.modelId !== decision.modelId) {
+        return { reachable: false, refusal: `decision:${decision.modelId} is not the candidate dispatch was asked to fit` };
+    }
+    if (candidate.dispatchFit === "exceeded") {
+        return { reachable: false, refusal: "candidate_context_window_exceeded" };
+    }
+    return {
+        reachable: true,
+        modelId: candidate.modelId,
+        dispatchFit: candidate.dispatchFit,
+        dispatchOutputTokens: candidate.dispatchOutputTokens,
+        undecidedOffline: FALLBACK_UNDECIDED_OFFLINE,
+    };
+};
+
+const diagnoseItem = (item: DiagnosticItem, input: DiagnosticInput, requestOutputCapTokens: number): ItemDiagnostic => {
+    const reservedInputTokens = Math.max(1, Math.ceil(Buffer.byteLength(item.prompt, "utf8") / 4));
+    const attachments = (item.attachments ?? []).map((attachment) => ({ mediaType: attachment.mediaType }));
+    const routerInput = {
+        text: item.prompt,
+        attachments,
+        webSearchRequested: item.webSearchRequested === true,
+        models: input.models,
+        plan: input.plan,
+        searchBackendReadiness: input.searchBackendReadiness,
+        reservedInputTokens,
+        requestOutputCapTokens,
+        unhealthyModelIds: input.unhealthyModelIds,
+        regionBlockedModelIds: input.regionBlockedModelIds,
+        availableCredits: input.availableCredits,
+        creditsByModelId: input.creditsByModelId,
+        signals: input.signals,
+        sticky: null,
+    };
+
+    // The product's decision. Everything below explains it and nothing below
+    // replaces it.
+    const decision = decideRouterModel(routerInput, input.now ?? Date.now);
+    const profile = decision.profile;
+    const rankingKind = rankingKindFor(profile);
+
+    // The explanation: the same filter and the same selector, called again
+    // with the same inputs, so per-model detail the decision does not carry
+    // (each candidate's output room, each loser's head-to-head) can be read
+    // off. `consistency` says whether they agreed.
+    const candidates = filterRouterCandidates({
+        models: input.models,
+        plan: input.plan,
+        profile,
+        searchBackendReadiness: input.searchBackendReadiness,
+        reservedInputTokens,
+        requestOutputCapTokens,
+        unhealthyModelIds: input.unhealthyModelIds,
+        regionBlockedModelIds: input.regionBlockedModelIds,
+        availableCredits: input.availableCredits,
+        creditsByModelId: input.creditsByModelId,
+    });
+    const signals: RouterTieBreakSignals = {
+        expectedTotalCostUsdByModelId: expectedTotalCostUsdByModel({
+            models: input.models,
+            reservedInputTokens,
+            requestOutputCapTokens,
+        }),
+        ...input.signals,
+    };
+    const selection = selectRouterModel({ profile, eligible: candidates.eligible, sticky: null, signals });
+
+    const problems: string[] = [];
+    const record = decision.record;
+    if (!sameList(record.eligibleModelIds, candidates.eligible.map((candidate) => candidate.modelId))) {
+        problems.push("the explanation's eligible set differs from the decision's");
+    }
+    const recordRejections = record.rejections.map((entry) => `${entry.modelId}:${entry.reason}`);
+    const explainRejections = candidates.rejected.map((entry) => `${entry.modelId}:${entry.reason}`);
+    if (!sameList(recordRejections, explainRejections)) {
+        problems.push("the explanation's rejections differ from the decision's");
+    }
+    if (selection.selectedModelId !== record.selectedModelId) {
+        problems.push(
+            `the explanation selected ${selection.selectedModelId ?? "nothing"} and the decision ${record.selectedModelId ?? "nothing"}`
+        );
+    }
+    if (selection.decidedBy !== record.selectionDecidedBy) {
+        problems.push("the explanation and the decision name different deciding criteria");
+    }
+
+    const primaryModelId = decision.outcome === "selected" ? decision.modelId : null;
+    const rankedModelIds = selection.rankedModelIds;
+    const rankOf = new Map(rankedModelIds.map((modelId, index) => [modelId, index + 1]));
+    const candidateOf = new Map(candidates.eligible.map((candidate) => [candidate.modelId, candidate]));
+    const rejectionOf = new Map(candidates.rejected.map((entry) => [entry.modelId, entry.reason]));
+    const primaryCandidate = primaryModelId ? candidateOf.get(primaryModelId) ?? null : null;
+
+    const versus = (candidate: RouterCandidate): ModelDisposition["versusPrimary"] => {
+        if (!primaryCandidate || candidate.modelId === primaryCandidate.modelId) return null;
+        const pair = selectRouterModel({
+            profile,
+            eligible: [primaryCandidate, candidate],
+            sticky: null,
+            signals,
+        });
+        return {
+            decidedBy: pair.decidedBy ?? "model_id",
+            marginBands: pair.margin,
+            wouldBeatPrimary: pair.selectedModelId === candidate.modelId,
+        };
+    };
+
+    const models: ModelDisposition[] = input.models.map((model) => {
+        const candidate = candidateOf.get(model.id) ?? null;
+        const rejection = rejectionOf.get(model.id) ?? null;
+        if (candidate === null && rejection === null) {
+            problems.push(`${model.id} is neither eligible nor rejected, so the filter did not see it`);
+        }
+        return {
+            modelId: model.id,
+            provider: model.provider,
+            apiModel: model.apiModel,
+            enabled: model.enabled,
+            publiclyListed: model.publiclyListed !== false,
+            minimumPlan: model.minimumPlan,
+            contextWindowTokens: model.contextWindowTokens ?? null,
+            inScoreSnapshot: isRouterScoreSnapshotModel(model.id),
+            disposition:
+                model.id === primaryModelId ? "primary" : candidate ? "fallback_candidate" : "rejected",
+            rejectionReason: rejection,
+            rank: rankOf.get(model.id) ?? null,
+            routerOutputTokens: candidate?.outputTokens ?? null,
+            quality: qualityFor(model.id, rankingKind),
+            expectedTotalCostUsd: signals.expectedTotalCostUsdByModelId?.[model.id] ?? null,
+            versusPrimary: candidate ? versus(candidate) : null,
+        };
+    });
+
+    // Dispatch fits the chosen model under *its own* pricing cap and the
+    // provider's verified ceiling, with the reservation the estimator makes.
+    // The Router fitted it under the requested model's cap with the raw
+    // estimate. Both figures are reported; neither is corrected.
+    const dispatchFitFor = (modelId: string) => {
+        const model = input.models.find((entry) => entry.id === modelId);
+        if (!model) return null;
+        const pricing = resolveModelPricing(model, { estimatedPromptTokens: reservedInputTokens });
+        const dispatchReservedInputTokens = toReservedInputTokens(reservedInputTokens);
+        const fit = fitChatOutputToContextWindow({
+            contextWindowTokens: model.contextWindowTokens,
+            reservedInputTokens: dispatchReservedInputTokens,
+            requestOutputCapTokens: pricing.maxOutputTokens,
+            providerMaxOutputTokens: pricing.providerMaxOutputTokens,
+        });
+        return {
+            pricing,
+            dispatchReservedInputTokens,
+            fit: fit.kind,
+            outputTokens: fit.kind === "fitted" ? fit.outputTokens : null,
+        };
+    };
+
+    const primaryDispatch = primaryModelId ? dispatchFitFor(primaryModelId) : null;
+    const caps: CapReconciliation = {
+        routerRequestOutputCapTokens: requestOutputCapTokens,
+        routerReservedInputTokens: reservedInputTokens,
+        primary:
+            primaryModelId && primaryCandidate && primaryDispatch
+                ? {
+                      modelId: primaryModelId,
+                      routerOutputTokens: primaryCandidate.outputTokens,
+                      dispatchRequestOutputCapTokens: primaryDispatch.pricing.maxOutputTokens,
+                      dispatchProviderMaxOutputTokens: primaryDispatch.pricing.providerMaxOutputTokens,
+                      dispatchReservedInputTokens: primaryDispatch.dispatchReservedInputTokens,
+                      dispatchOutputTokens: primaryDispatch.outputTokens,
+                      dispatchFit: primaryDispatch.fit,
+                      outputCapDiffers:
+                          primaryDispatch.pricing.maxOutputTokens !== requestOutputCapTokens ||
+                          primaryDispatch.outputTokens !== primaryCandidate.outputTokens,
+                      reservedInputDiffers:
+                          primaryDispatch.dispatchReservedInputTokens !== reservedInputTokens,
+                  }
+                : null,
+        notModelled: [
+            "search tool input overhead (estimateToolInputTokenOverhead)",
+            "access-kind pricing and credit reservation (createChatBudget)",
+            "runtime registry rows in place of the static catalogue",
+        ],
+    };
+
+    const fallbackCandidateModelIds =
+        decision.outcome === "selected" ? decision.fallbackCandidateModelIds : [];
+    const scopeInput = {
+        routed: decision.outcome === "selected",
+        isGuest: input.plan === "Guest",
+        toolsOffered: false,
+        nativeSearchEnabled: profile.needsCurrentInformation,
+        appManagedSearchEnabled: false,
+        deepResearch: false,
+        hasAttachments: attachments.length > 0,
+        candidateCount: fallbackCandidateModelIds.length,
+    };
+    const scopeAsDeployed = autoFallbackScope({ ...scopeInput, environment: input.fallbackEnvironment ?? {} });
+    const scopeIfFlagOn = autoFallbackScope({
+        ...scopeInput,
+        environment: { ...(input.fallbackEnvironment ?? {}), AUTO_ROUTER_FALLBACK_ENABLED: "on" },
+    });
+    // The product's own decision function, asked under the stated hypothesis
+    // with the Router's ranked candidates. Dispatch is then asked to fit the
+    // one candidate it names (or, when it names none, the one the Router
+    // ranked next, so the report still shows what was there).
+    const fallbackDecision = fallbackDecisionFor(primaryModelId ?? "(no primary)", fallbackCandidateModelIds);
+    const firstFallback = fallbackDecision.modelId ?? fallbackCandidateModelIds[0] ?? null;
+    const firstFallbackFit = firstFallback ? dispatchFitFor(firstFallback) : null;
+    const firstCandidate =
+        firstFallback && firstFallbackFit
+            ? {
+                  modelId: firstFallback,
+                  dispatchFit: firstFallbackFit.fit,
+                  dispatchOutputTokens: firstFallbackFit.outputTokens,
+              }
+            : null;
+
+    const eligibleIds = candidates.eligible.map((candidate) => candidate.modelId);
+    const eligibleWithEvidence = eligibleIds.filter(
+        (modelId) => getRouterScoreCell(modelId, rankingKind).evidenceRef !== null
+    );
+
+    return {
+        itemId: item.id,
+        stratum: item.stratum ?? null,
+        cell: item.cell ?? null,
+        profile: {
+            version: profile.version,
+            kind: profile.kind,
+            kindConfidence: profile.kindConfidence,
+            rankingKind,
+            needsCurrentInformation: profile.needsCurrentInformation,
+            hasImageInput: profile.hasImageInput,
+            hasDocumentInput: profile.hasDocumentInput,
+            expectedOutputLength: profile.expectedOutputLength,
+            signals: profile.signals,
+        },
+        decision: {
+            outcome: decision.outcome,
+            primaryModelId,
+            selectionReason: record.selectionReason,
+            decidedBy: record.selectionDecidedBy,
+            marginBands: record.selectionMargin,
+            rankedModelIds,
+            fallbackCandidateModelIds,
+        },
+        models,
+        fallback: {
+            rankedCandidateModelIds: fallbackCandidateModelIds,
+            maxModelFallbacks: MAX_MODEL_FALLBACKS,
+            scopeAsDeployed,
+            scopeIfFlagOn,
+            firstCandidate,
+            decision: fallbackDecision,
+            reachableAsDeployed: fallbackReachabilityFor(scopeAsDeployed, fallbackDecision, firstCandidate),
+            reachableIfFlagOn: fallbackReachabilityFor(scopeIfFlagOn, fallbackDecision, firstCandidate),
+            notModelled: [
+                `the decision is asked under one hypothesis: the primary failed ${FALLBACK_FAILURE_HYPOTHESIS.outcome} at the ${FALLBACK_FAILURE_HYPOTHESIS.failureLayer} layer with no provider refusal and no visible token; any other failure shape terminates by policy`,
+                ...FALLBACK_UNDECIDED_OFFLINE,
+            ],
+        },
+        caps,
+        evidence: {
+            rankingKind,
+            eligibleWithEvidence,
+            eligibleWithoutEvidence: eligibleIds.filter((modelId) => !eligibleWithEvidence.includes(modelId)),
+            decidedWithoutQualityEvidence:
+                eligibleWithEvidence.length === 0 || record.selectionDecidedBy !== "quality_band",
+        },
+        consistency: { agreesWithProduct: problems.length === 0, problems },
+    };
+};
+
+const count = <K extends string>(keys: Iterable<K>): Record<K, number> => {
+    const counts = {} as Record<K, number>;
+    for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
+    return counts;
+};
+
+export const diagnoseFullCatalog = (input: DiagnosticInput): DiagnosticReport => {
+    const problems: string[] = [];
+    const requestedModel = input.models.find((model) => model.id === input.requestedModelId);
+    if (!requestedModel) {
+        throw new Error(
+            `requestedModelId ${input.requestedModelId} is not in the catalogue, so there is no cap to route under.`
+        );
+    }
+    // The same resolution the chat route makes before Auto runs.
+    const requestOutputCapTokens = resolveModelPricing(requestedModel).maxOutputTokens;
+
+    const items = input.items.map((item) => diagnoseItem(item, input, requestOutputCapTokens));
+
+    const primaryIds = items.flatMap((item) => (item.decision.primaryModelId ? [item.decision.primaryModelId] : []));
+    const primaryCounts = count(primaryIds);
+    const primaryCountsByKind = {} as Record<TaskKind, Record<string, number>>;
+    for (const item of items) {
+        if (!item.decision.primaryModelId) continue;
+        const byModel = (primaryCountsByKind[item.profile.rankingKind] ??= {});
+        byModel[item.decision.primaryModelId] = (byModel[item.decision.primaryModelId] ?? 0) + 1;
+    }
+    const decidedByCounts = count(items.map((item) => item.decision.decidedBy ?? "none"));
+    const rejectionCounts = count(
+        items.flatMap((item) =>
+            item.models.flatMap((model) => (model.rejectionReason ? [model.rejectionReason] : []))
+        )
+    );
+
+    const everEligible = new Set<string>();
+    const reasonsByModel = new Map<string, Set<CandidateRejection>>();
+    for (const item of items) {
+        for (const model of item.models) {
+            if (model.rejectionReason === null) everEligible.add(model.modelId);
+            else {
+                const reasons = reasonsByModel.get(model.modelId) ?? new Set();
+                reasons.add(model.rejectionReason);
+                reasonsByModel.set(model.modelId, reasons);
+            }
+        }
+    }
+    const neverEligible = input.models
+        .filter((model) => !everEligible.has(model.id))
+        .map((model) => ({
+            modelId: model.id,
+            reasons: [...(reasonsByModel.get(model.id) ?? [])].sort(),
+        }));
+    const eligibleNeverPrimary = [...everEligible].filter((modelId) => !(modelId in primaryCounts)).sort();
+
+    const kindsSeen = [...new Set(items.map((item) => item.profile.rankingKind))].sort();
+    const evidenceTotal = input.models.filter((model) => model.enabled).length * kindsSeen.length;
+    let evidenceWith = 0;
+    for (const model of input.models) {
+        if (!model.enabled) continue;
+        for (const kind of kindsSeen) {
+            if (getRouterScoreCell(model.id, kind).evidenceRef !== null) evidenceWith += 1;
+        }
+    }
+
+    const outputCapMismatchItems = items.filter((item) => item.caps.primary?.outputCapDiffers).length;
+    const consistencyProblems = items.filter((item) => !item.consistency.agreesWithProduct).length;
+    const pairwiseInversions = items.reduce(
+        (sum, item) => sum + item.models.filter((model) => model.versusPrimary?.wouldBeatPrimary).length,
+        0
+    );
+    for (const item of items) {
+        for (const problem of item.consistency.problems) problems.push(`${item.itemId}: ${problem}`);
+    }
+    const fallbackScopeAsDeployed = count(
+        items.map((item) => (item.fallback.scopeAsDeployed.allowed ? "allowed" : item.fallback.scopeAsDeployed.reason))
+    );
+    const reachableKey = (answer: FallbackReachability) => (answer.reachable ? "reachable" : answer.refusal);
+    const fallbackReachableAsDeployed = count(items.map((item) => reachableKey(item.fallback.reachableAsDeployed)));
+    const fallbackReachableIfFlagOn = count(items.map((item) => reachableKey(item.fallback.reachableIfFlagOn)));
+
+    const improvementCandidates: ImprovementCandidate[] = [];
+    const undeclared = input.models
+        .filter((model) => model.enabled && !model.contextWindowTokens)
+        .map((model) => model.id);
+    if (undeclared.length > 0) {
+        improvementCandidates.push({
+            kind: "context_window_undeclared",
+            modelIds: undeclared,
+            taskKinds: kindsSeen,
+            itemCount: items.length,
+            detail:
+                "enabled but declares no context window in this catalogue, so the Router refuses it on every " +
+                "item (context_window_undeclared). Declaring the window is what makes it reachable; nothing " +
+                "about its quality is known either way.",
+        });
+    }
+    const neverEligibleOther = neverEligible.filter(
+        (entry) => !undeclared.includes(entry.modelId) && input.models.find((m) => m.id === entry.modelId)?.enabled
+    );
+    if (neverEligibleOther.length > 0) {
+        improvementCandidates.push({
+            kind: "never_eligible",
+            modelIds: neverEligibleOther.map((entry) => entry.modelId),
+            taskKinds: kindsSeen,
+            itemCount: items.length,
+            detail:
+                "enabled and never eligible on any item, for: " +
+                neverEligibleOther.map((entry) => `${entry.modelId} (${entry.reasons.join(", ")})`).join("; "),
+        });
+    }
+    if (eligibleNeverPrimary.length > 0) {
+        improvementCandidates.push({
+            kind: "eligible_never_primary",
+            modelIds: eligibleNeverPrimary,
+            taskKinds: kindsSeen,
+            itemCount: items.length,
+            detail:
+                "passed every hard filter on at least one item and was never chosen. With every quality band " +
+                "neutral, the tie-break decides, and these lose it; a comparative evaluation on the kinds they " +
+                "are eligible for is what could change that, and nothing else should.",
+        });
+    }
+    for (const kind of kindsSeen) {
+        const eligibleForKind = new Set(
+            items
+                .filter((item) => item.profile.rankingKind === kind)
+                .flatMap((item) => item.evidence.eligibleWithoutEvidence)
+        );
+        if (eligibleForKind.size > 0) {
+            improvementCandidates.push({
+                kind: "no_quality_evidence_for_kind",
+                modelIds: [...eligibleForKind].sort(),
+                taskKinds: [kind],
+                itemCount: items.filter((item) => item.profile.rankingKind === kind).length,
+                detail: `eligible for ${kind} items with no approved quality evidence for that kind.`,
+            });
+        }
+        const tieBreakItems = items.filter(
+            (item) =>
+                item.profile.rankingKind === kind &&
+                item.decision.decidedBy !== null &&
+                item.decision.decidedBy !== "quality_band"
+        );
+        if (tieBreakItems.length > 0) {
+            const criteria = [...new Set(tieBreakItems.map((item) => item.decision.decidedBy))];
+            improvementCandidates.push({
+                kind: "decided_by_tie_break",
+                modelIds: [...new Set(tieBreakItems.flatMap((item) => item.decision.primaryModelId ?? []))].sort(),
+                taskKinds: [kind],
+                itemCount: tieBreakItems.length,
+                detail: `${kind}: the primary was separated from the runner-up by ${criteria.join(", ")}, not by quality.`,
+            });
+        }
+    }
+    const searchGap = new Set(
+        items.flatMap((item) =>
+            item.models
+                .filter(
+                    (model) =>
+                        model.rejectionReason === "web_search_unverified" ||
+                        model.rejectionReason === "web_search_cost_unbounded"
+                )
+                .map((model) => model.modelId)
+        )
+    );
+    if (searchGap.size > 0) {
+        improvementCandidates.push({
+            kind: "web_search_capability_gap",
+            modelIds: [...searchGap].sort(),
+            taskKinds: kindsSeen,
+            itemCount: items.filter((item) => item.profile.needsCurrentInformation).length,
+            detail:
+                "refused on current-information items because search support is unverified or its cost cannot " +
+                "be bounded. Verifying the register entry, or a backend credential, is what would admit them.",
+        });
+    }
+    if (outputCapMismatchItems > 0) {
+        improvementCandidates.push({
+            kind: "output_cap_mismatch",
+            modelIds: [
+                ...new Set(items.filter((item) => item.caps.primary?.outputCapDiffers).map((item) => item.caps.primary!.modelId)),
+            ].sort(),
+            taskKinds: kindsSeen,
+            itemCount: outputCapMismatchItems,
+            detail:
+                `the Router fitted candidates under ${input.requestedModelId}'s cap (${requestOutputCapTokens}) and ` +
+                "dispatch will budget the primary under its own. The candidate set was decided under one number and " +
+                "the answer is sized under another.",
+        });
+    }
+    if (pairwiseInversions > 0) {
+        improvementCandidates.push({
+            kind: "pairwise_inversion",
+            modelIds: [
+                ...new Set(
+                    items.flatMap((item) =>
+                        item.models.filter((model) => model.versusPrimary?.wouldBeatPrimary).map((model) => model.modelId)
+                    )
+                ),
+            ].sort(),
+            taskKinds: kindsSeen,
+            itemCount: pairwiseInversions,
+            detail:
+                "beats the primary head to head under the product's comparator but ranked below it in the sort. " +
+                "The tie-break's epsilons make the order non-transitive on these inputs.",
+        });
+    }
+
+    const doesNotFit = items.filter(
+        (item) =>
+            !item.fallback.reachableIfFlagOn.reachable &&
+            item.fallback.reachableIfFlagOn.refusal === "candidate_context_window_exceeded"
+    );
+    if (doesNotFit.length > 0) {
+        improvementCandidates.push({
+            kind: "fallback_candidate_does_not_fit",
+            modelIds: [...new Set(doesNotFit.flatMap((item) => item.fallback.firstCandidate?.modelId ?? []))].sort(),
+            taskKinds: [...new Set(doesNotFit.map((item) => item.profile.rankingKind))].sort(),
+            itemCount: doesNotFit.length,
+            detail:
+                "named as the fallback candidate by the Router, which fitted it with the raw input estimate, and " +
+                "refused by dispatch, which reserves the widened one; with the flag on the turn would end on the " +
+                "primary's failure. The candidate list was decided under one reservation and the attempt under " +
+                "another.",
+        });
+    }
+
+    return {
+        version: ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION,
+        routerVersions: versionOf(),
+        inputs: {
+            catalogueSource: input.catalogueSource ?? "caller-supplied",
+            catalogueModelCount: input.models.length,
+            enabledModelCount: input.models.filter((model) => model.enabled).length,
+            itemCount: items.length,
+            plan: input.plan,
+            requestedModelId: input.requestedModelId,
+            routerRequestOutputCapTokens: requestOutputCapTokens,
+            searchBackendReadiness: input.searchBackendReadiness,
+            signalsSupplied: Object.keys(input.signals ?? {}) as (keyof RouterTieBreakSignals)[],
+            unhealthyModelIds: input.unhealthyModelIds ?? [],
+            stickyState: "none",
+            fallbackFlagAsDeployed:
+                (input.fallbackEnvironment ?? {}).AUTO_ROUTER_FALLBACK_ENABLED === "on" ? "on" : "off",
+        },
+        items,
+        summary: {
+            primaryCounts,
+            primaryCountsByKind,
+            decidedByCounts: decidedByCounts as Record<RouterTieBreakCriterion | "none", number>,
+            rejectionCounts: rejectionCounts as Record<CandidateRejection, number>,
+            neverEligible,
+            eligibleNeverPrimary,
+            evidenceCells: { withEvidence: evidenceWith, total: evidenceTotal },
+            outputCapMismatchItems,
+            consistencyProblems,
+            pairwiseInversions,
+            fallbackScopeAsDeployed,
+            fallbackReachableAsDeployed,
+            fallbackReachableIfFlagOn,
+        },
+        improvementCandidates,
+        problems,
+    };
+};
+
+/** The tie-break order, re-exported so a report can print the policy it read. */
+export const TIE_BREAK_ORDER = ROUTER_TIE_BREAK_ORDER;
+export const NEUTRAL_BAND = NEUTRAL_QUALITY_BAND;
diff --git a/package.json b/package.json
index f82fc3b7..3f2caab5 100644
--- a/package.json
+++ b/package.json
@@ -207,7 +207,9 @@
     "report:mobile-auth-keyring-health": "node --import tsx scripts/report-mobile-auth-keyring-health.mjs",
     "score:ai-review-judgements": "node --conditions=react-server --import tsx scripts/score-ai-review-judgements.mjs",
     "draft:ai-review-judgement": "node --conditions=react-server --import tsx scripts/draft-ai-review-judgement.mjs",
-    "report:router-judge-comparison": "node --import tsx scripts/report-router-judge-comparison.mjs"
+    "report:router-judge-comparison": "node --import tsx scripts/report-router-judge-comparison.mjs",
+    "report:router-full-catalog": "node --import tsx scripts/report-router-full-catalog.mjs",
+    "cross-review": "node --import tsx scripts/cross-review.mjs"
   },
   "dependencies": {
     "@ai-sdk/anthropic": "^4.0.49",
diff --git a/scripts/cross-review.mjs b/scripts/cross-review.mjs
new file mode 100644
index 00000000..602e73d9
--- /dev/null
+++ b/scripts/cross-review.mjs
@@ -0,0 +1,668 @@
+// Runs the author–reviewer exchange for one task, packages a change for an
+// independent reviewer to read, or runs only the reviewer on such a package.
+//
+// Modes:
+//   --mode=mock     scripted executors from --fixture; the whole loop, offline.
+//   --mode=dry-run  the command-line executors are built and never run; the
+//                   outcome is `failed` with `author_not_executed`, and the
+//                   record shows the exact commands that would have run.
+//   --mode=package  no executor at all: takes the diff of the task's base
+//                   commit (or --base) against HEAD or the worktree as round
+//                   --round (default: the next round), computes the digest,
+//                   runs --test-command and every --guard-command, and writes
+//                   the package for that round plus the reviewer prompt.
+//   --mode=review   runs only the reviewer, on the package of --round
+//                   (default: the latest packaged round). The prompt is rebuilt
+//                   from the stored package, the verdict is written as
+//                   verdict-round<N>.json, and exchange.json becomes the
+//                   control program's replay of every round so far. Refused
+//                   unless --i-have-authorised-live-execution is given; without
+//                   it the reviewer is built in dry-run and the exact command
+//                   is shown.
+//   --mode=live     runs both command-line executors in the loop. Refused
+//                   unless --i-have-authorised-live-execution is also given,
+//                   because a live run spends and edits. The diff of record is
+//                   the working tree's diff against the base after the author
+//                   ran -- not the diff the author returned, which is recorded
+//                   only as its claim -- so the digest, the scope check and
+//                   the reviewer all read the change that exists.
+//
+// What the package refuses, so a record can be trusted:
+//   - a change outside the task's writableScope anywhere in the tree -- a
+//     tracked file changed against the base, or an untracked file -- not just
+//     in the scoped diff. The diff is scoped so a reviewer reads the change;
+//     the scope check is not, so nothing hides behind the scoping.
+//   - an untracked file the diff would not show, unless it lies under a
+//     --diff-exclude path (a declared generated file; the package's own
+//     outputs are such files).
+//   - a --diff-exclude path that is not one of the task's `generatedPaths`
+//     or the package's own --out directory. What the reviewer does not see is
+//     fixed before the exchange, not chosen by the author at packaging time;
+//     an excluded file still counts as changed, and its content digest is
+//     recorded in the package and checked again at review time.
+//   - round N > 0 unless the control program's replay of rounds 0..N-1 is
+//     `awaiting_revision`. After `passed`, `on_hold` or `failed` the exchange
+//     has concluded; a further change is a new task or a new --out.
+//   - a second verdict on a round that has one. A new digest needs a new
+//     package and a new review.
+//   - a review of a package the working tree does not match: the tree's diff
+//     against the base, scoped and excluded as the package was, must digest
+//     to the package's digest, and every excluded file must still digest to
+//     what the package recorded.
+//
+// Codex executors:
+//   --codex-config=<key=value>  repeatable; passed as `-c key=value`. A
+//                   reviewer accepts only REVIEWER_CONFIG_OVERRIDE_KEYS. Give
+//                   the value without quotes (`model=gpt-5.6-sol`): codex keeps
+//                   a value that is not TOML as a literal string, and the
+//                   Windows spawner refuses quotes.
+//   --codex-auth=login|env      default `login`: OPENAI_API_KEY and
+//                   CODEX_API_KEY are dropped from the child environment so
+//                   codex uses its stored login; `env` leaves them in place.
+//
+// Checks the control program applies (lib/crossReviewCore.ts): a pass needs at
+// least one passing test run and at least one guard rule run with every rule
+// passing. Nothing run is a failed check.
+//   --test-command=<sh>   the test run, once per round; exit status decides.
+//   --guard-command=<sh>  repeatable; each is a guard rule, recorded with its
+//                         result; a non-zero exit is a failed rule.
+// In live mode a guard rule also compares the working tree with what the
+// author reported (an untracked file the diff cannot show fails it).
+//
+// --max-revisions may lower the fixed cap (MAX_REVISIONS, 2) for a run and
+// cannot raise it.
+//
+// Usage:
+//   node --import tsx scripts/cross-review.mjs --task=<task.json> --mode=mock \
+//     --fixture=<fixture.json> --out=<dir> [--author=claude] [--reviewer=codex] \
+//     [--max-revisions=2] [--test-command="npm test -- x"] [--timeout-ms=600000]
+//
+// task.json: { taskId, requirement, completionCriteria[], baseCommit, writableScope[], generatedPaths?[] }
+// fixture.json (mock): { author: AuthorOutput[], reviewer: ReviewVerdict[], tests?: TestRun[][], guards?: GuardRun[][] }
+//   A reviewer entry may carry reviewedDigest "@current" to mean the digest
+//   of the change it is shown; anything else is compared literally.
+//
+// Package layout under --out:
+//   package-round<N>.json     the change of round N: digest, commit, summary,
+//                             files, test and guard results, the whole-tree
+//                             file list the scope check read, the excluded
+//                             paths with their content digests, and the diff
+//                             itself (kept inside JSON so line-ending
+//                             conversion on checkout cannot alter what is
+//                             digested)
+//   change-round<N>.diff      the same diff, for a person
+//   verdict-round<N>.json     the reviewer's verdict on round N, with the exact
+//                             command that produced it
+//   review-round<N>.events.jsonl  the reviewer's raw output
+//   review-prompt.md, change.diff  the latest round, for a person
+//   exchange.json             the record: the control program's replay
+//
+// exchange.json carries the control program's statuses -- passed, on_hold,
+// failed -- and two that only a person-driven exchange has: awaiting_review
+// (a package with no verdict yet) and awaiting_revision (actionable findings
+// or failed checks, and a revision remains). Both are read off where the
+// replay through runCrossReview stopped (lib/crossReviewCore.ts,
+// replayExchange), never decided here.
+//
+// Nothing here pushes, merges, or dispatches a workflow.
+
+import { createHash } from "node:crypto";
+import { execFileSync, spawn as nodeSpawn } from "node:child_process";
+import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+
+import {
+  MAX_REVISIONS,
+  renderReviewPrompt,
+  replayExchange,
+  resolveMaxRevisions,
+  runCrossReview,
+} from "../lib/crossReviewCore.ts";
+import {
+  CLI_INVOCATIONS,
+  REVIEWER_CONFIG_OVERRIDE_KEYS,
+  cliAuthor,
+  cliCommandLine,
+  cliReviewer,
+  mockAuthor,
+  mockReviewer,
+} from "../lib/crossReviewExecutors.ts";
+
+const argv = process.argv.slice(2);
+const args = new Map(
+  argv.map((arg) => {
+    const [key, ...rest] = arg.replace(/^--/, "").split("=");
+    return [key, rest.length > 0 ? rest.join("=") : "true"];
+  })
+);
+const flag = (name, fallback) => args.get(name) ?? fallback;
+const repeated = (name) => argv.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
+const die = (message) => {
+  console.error(message);
+  process.exit(1);
+};
+
+const mode = flag("mode", "mock");
+if (!["mock", "dry-run", "package", "review", "live"].includes(mode)) die("--mode must be mock, dry-run, package, review or live.");
+const taskPath = flag("task");
+if (!taskPath) die("--task=<task.json> is required.");
+const task = JSON.parse(readFileSync(taskPath, "utf8"));
+for (const field of ["taskId", "requirement", "completionCriteria", "baseCommit", "writableScope"]) {
+  if (task[field] === undefined) die(`${taskPath} has no ${field}.`);
+}
+const generatedPaths = task.generatedPaths ?? [];
+const outDir = flag("out", `artifacts/cross-review/${task.taskId}`);
+let maxRevisions;
+try {
+  maxRevisions = resolveMaxRevisions(args.has("max-revisions") ? Number(flag("max-revisions")) : undefined);
+} catch (error) {
+  die(`--max-revisions: ${error.message} (the cap is fixed at ${MAX_REVISIONS}; a run may only lower it).`);
+}
+const roles = { author: flag("author", "claude"), reviewer: flag("reviewer", "codex") };
+const testCommand = args.get("test-command") ?? null;
+const guardCommands = repeated("guard-command");
+const timeoutMs = Number.parseInt(flag("timeout-ms", String(10 * 60 * 1000)), 10);
+if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) die("--timeout-ms must be a positive integer.");
+const authorised = flag("i-have-authorised-live-execution", "false") === "true";
+const codexConfig = repeated("codex-config");
+const codexAuth = flag("codex-auth", "login");
+if (!["login", "env"].includes(codexAuth)) die("--codex-auth must be login or env.");
+// Node drops an environment entry whose value is undefined, so these remove
+// the keys from the child rather than setting them to a string.
+const codexEnv = codexAuth === "login" ? { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } : undefined;
+
+const digest = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
+const digestFile = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
+
+// ---------------------------------------------------------------------------
+// Commands the control program runs: the test command and the guard commands.
+
+const runCommand = (command) => {
+  const startedAt = Date.now();
+  try {
+    const output = execFileSync("sh", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
+    return { passed: true, output: output.trim().split("\n").slice(-5).join("\n"), durationMs: Date.now() - startedAt };
+  } catch (error) {
+    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim().split("\n").slice(-10).join("\n");
+    return { passed: false, output, durationMs: Date.now() - startedAt };
+  }
+};
+const runTestCommand = () => (testCommand ? [{ command: testCommand, ...runCommand(testCommand) }] : []);
+/** Every --guard-command, run once, as the guard runs the control program records. */
+const runGuardCommands = () =>
+  guardCommands.map((command) => {
+    const run = runCommand(command);
+    return { rule: command, passed: run.passed, detail: run.output.slice(-400), durationMs: run.durationMs };
+  });
+
+// ---------------------------------------------------------------------------
+// The working tree, as git sees it. The scope check reads all of it.
+
+const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
+const gitLines = (...gitArgs) =>
+  git(...gitArgs)
+    .split("\n")
+    .map((line) => line.trim())
+    .filter(Boolean);
+const under = (file, path) => file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`);
+const inScope = (file) => task.writableScope.length === 0 || task.writableScope.some((scope) => under(file, scope));
+/** Tracked files changed against the base (index and worktree), and every untracked file. */
+const treeChanges = (base) => {
+  const tracked = gitLines("diff", "--name-only", base);
+  const untracked = gitLines("status", "--porcelain", "--untracked-files=all")
+    .filter((line) => line.startsWith("??"))
+    .map((line) => line.slice(2).trim());
+  return { tracked: [...new Set(tracked)].sort(), untracked: [...new Set(untracked)].sort() };
+};
+const scopePathspec = () => (task.writableScope.length > 0 ? task.writableScope : ["."]);
+const scopedDiff = (base, excluded) => git("diff", base, "--", ...scopePathspec(), ...excluded.map((path) => `:(exclude)${path}`));
+/** Content digests of the excluded files that exist, so an exclusion cannot hide a later change. */
+const excludedDigests = (excluded) =>
+  Object.fromEntries(
+    excluded
+      .filter((path) => existsSync(path) && statSync(path).isFile())
+      .map((path) => [path, digestFile(path)])
+  );
+
+mkdirSync(outDir, { recursive: true });
+const write = (name, contents) => {
+  const path = join(outDir, name);
+  writeFileSync(path, contents);
+  console.error(`written ${path}`);
+};
+const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
+
+// ---------------------------------------------------------------------------
+// The package of a round, and the control program's reading of the rounds.
+
+const packageFile = (round) => join(outDir, `package-round${round}.json`);
+const verdictFile = (round) => join(outDir, `verdict-round${round}.json`);
+const packagedRounds = () =>
+  (existsSync(outDir) ? readdirSync(outDir) : [])
+    .map((name) => /^package-round(\d+)\.json$/.exec(name))
+    .filter(Boolean)
+    .map((match) => Number(match[1]))
+    .sort((a, b) => a - b);
+
+const loadRound = (round) => {
+  if (!existsSync(packageFile(round))) die(`no package for round ${round} under ${outDir}.`);
+  const pkg = readJson(packageFile(round));
+  if (typeof pkg.diff !== "string") die(`${packageFile(round)} carries no diff.`);
+  if (digest(pkg.diff) !== pkg.changeDigest) die(`${packageFile(round)}: the diff no longer digests to ${pkg.changeDigest}; the package was altered.`);
+  if (pkg.taskId !== task.taskId) die(`${packageFile(round)} is for task ${pkg.taskId}, not ${task.taskId}.`);
+  const verdict = existsSync(verdictFile(round)) ? readJson(verdictFile(round)).verdict : null;
+  return { round, pkg, verdict };
+};
+
+const loadRounds = (upTo) => {
+  const rounds = [];
+  for (let round = 0; round <= upTo; round += 1) {
+    rounds.push(loadRound(round));
+    if (round < upTo && !rounds[round].verdict) die(`round ${round} has no verdict, so round ${upTo} cannot exist yet.`);
+  }
+  return rounds;
+};
+
+const replay = async (rounds) => {
+  const latest = rounds[rounds.length - 1];
+  const exchange = await replayExchange({
+    task,
+    roles,
+    maxRevisions,
+    digest,
+    rounds: rounds.map((entry) => ({
+      round: entry.round,
+      diff: entry.pkg.diff,
+      summary: entry.pkg.changeSummary,
+      filesChanged: entry.pkg.filesChanged,
+      commit: entry.pkg.commit,
+      testResults: entry.pkg.testResults,
+      guardRuns: entry.pkg.guardRuns ?? [],
+      verdict: entry.verdict,
+    })),
+  });
+  if (exchange.concludedAtRound !== null && exchange.concludedAtRound < rounds.length - 1) {
+    console.error(`note: the control program concluded at round ${exchange.concludedAtRound}; packages after it are not part of the record.`);
+  }
+  return {
+    ...exchange,
+    headCommit: latest.pkg.headCommit,
+    worktreeDirty: latest.pkg.worktreeDirty,
+    filesChanged: latest.pkg.filesChanged,
+  };
+};
+
+/** Why round N cannot be packaged or reviewed now, or null when it can. */
+const refusalToContinue = (state, nextRound) => {
+  if (state.status === "awaiting_revision") return null;
+  if (state.status === "awaiting_review") return `round ${nextRound - 1} awaits its verdict; review it before round ${nextRound}.`;
+  return `the exchange concluded as ${state.status}${state.holdReason ? ` (${state.holdReason})` : ""}${state.failure ? ` (${state.failure})` : ""} at round ${state.concludedAtRound}; a further change is a new task or a new --out.`;
+};
+
+// ---------------------------------------------------------------------------
+// The spawner for live runs, and the command-line executors.
+
+const SAFE_ARG = /^[A-Za-z0-9_.,=:@+\/-]+$/;
+const killTree = (child) => {
+  if (process.platform === "win32") {
+    nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
+  } else {
+    child.kill("SIGKILL");
+  }
+};
+let lastSpawn = null;
+const spawner = async (command, cliArgs, options) =>
+  new Promise((resolve) => {
+    // On Windows the tools are npm `.cmd` shims, which Node refuses to spawn
+    // without a shell; a shell gets an argument list it cannot mangle, or
+    // nothing at all.
+    const shell = process.platform === "win32";
+    const unsafe = shell ? cliArgs.filter((arg) => !SAFE_ARG.test(arg)) : [];
+    if (unsafe.length > 0) {
+      resolve({ status: null, stdout: "", stderr: "", error: new Error(`refusing to pass through a shell: ${unsafe.join(" ")}`) });
+      return;
+    }
+    const child = nodeSpawn(command, cliArgs, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, shell, windowsHide: true });
+    let stdout = "";
+    let stderr = "";
+    let timedOut = false;
+    const timer = setTimeout(() => {
+      timedOut = true;
+      killTree(child);
+    }, options.timeoutMs);
+    child.stdout.on("data", (chunk) => (stdout += chunk));
+    child.stderr.on("data", (chunk) => (stderr += chunk));
+    child.on("error", (error) => {
+      clearTimeout(timer);
+      lastSpawn = { command, args: cliArgs, stdout, stderr, status: null, timedOut, error: error.message };
+      resolve({ status: null, stdout, stderr, error });
+    });
+    child.on("close", (status) => {
+      clearTimeout(timer);
+      lastSpawn = { command, args: cliArgs, stdout, stderr, status, timedOut, error: null };
+      resolve({ status, stdout, stderr, timedOut });
+    });
+    child.stdin.on("error", () => {
+      // the child closed stdin early; its exit status says what happened
+    });
+    child.stdin.end(options.input);
+  });
+
+const buildCli = (role, id, executorMode) => {
+  const invocation = CLI_INVOCATIONS[id]?.[role];
+  if (!invocation) die(`no command-line invocation is recorded for ${id} as ${role}; known: ${Object.keys(CLI_INVOCATIONS).join(", ")}`);
+  const codex = id === "codex";
+  return {
+    id,
+    invocation,
+    mode: executorMode,
+    cwd: process.cwd(),
+    timeoutMs,
+    spawn: executorMode === "live" ? spawner : undefined,
+    configOverrides: codex ? codexConfig : undefined,
+    env: codex ? codexEnv : undefined,
+  };
+};
+
+/**
+ * In live mode the author changes the tree; the tree is the change. The
+ * diff of record is git's, over the whole tree, so the digest binds what
+ * exists and an out-of-scope edit surfaces as a scope violation. What the
+ * author returned is kept as its claim, next to its self-assessment.
+ */
+const treeBackedAuthor = (executor) => ({
+  id: executor.id,
+  produce: async (request) => {
+    const produced = await executor.produce(request);
+    if (!produced.ok) return produced;
+    const tree = treeChanges(task.baseCommit);
+    const diff = git("diff", task.baseCommit);
+    const claimed = produced.value;
+    const claim = `author-claimed diff digest ${digest(claimed.diff)} over ${claimed.filesChanged.length} file(s); the tree's diff digests to ${digest(diff)}${
+      digest(claimed.diff) === digest(diff) ? " (identical)" : " (DIFFERS)"
+    }`;
+    return {
+      ok: true,
+      value: {
+        diff,
+        summary: claimed.summary,
+        filesChanged: [...tree.tracked, ...tree.untracked],
+        selfAssessment: claimed.selfAssessment ? `${claimed.selfAssessment}\n${claim}` : claim,
+        commit: claimed.commit ?? null,
+      },
+    };
+  },
+});
+
+// ---------------------------------------------------------------------------
+// package: the change of one round, for a reviewer to read.
+
+if (mode === "package") {
+  const packaged = packagedRounds();
+  const round = Number.parseInt(flag("round", String(packaged.length)), 10);
+  if (!Number.isInteger(round) || round < 0) die("--round must be a non-negative integer.");
+  if (existsSync(packageFile(round)) && existsSync(verdictFile(round))) {
+    die(`round ${round} is packaged and reviewed; a revised change is round ${round + 1}.`);
+  }
+  let previous = [];
+  if (round > 0) {
+    previous = loadRounds(round - 1);
+    if (!previous[round - 1].verdict) die(`round ${round - 1} has no verdict yet; review it before packaging round ${round}.`);
+    const refusal = refusalToContinue(await replay(previous), round);
+    if (refusal) die(`refusing to package round ${round}: ${refusal}`);
+  }
+  const base = flag("base", task.baseCommit);
+
+  // What the reviewer does not see was fixed before the exchange: only the
+  // task's generated paths and this package's own outputs may be excluded.
+  const diffExcluded = repeated("diff-exclude");
+  const undeclared = diffExcluded.filter((path) => !generatedPaths.includes(path) && !under(outDir.replace(/\\/g, "/"), path) && !under(path, outDir.replace(/\\/g, "/")));
+  if (undeclared.length > 0) {
+    die(`refusing to package: --diff-exclude names ${undeclared.join(", ")}, which the task's generatedPaths does not declare and which is not the package directory.`);
+  }
+  const isExcluded = (file) => diffExcluded.some((path) => under(file, path));
+
+  // The whole tree, not the scoped diff, decides whether the change stayed
+  // inside the scope. An untracked file the diff would not show is refused
+  // too, unless it lies under a --diff-exclude path.
+  const tree = treeChanges(base);
+  const outside = [...tree.tracked, ...tree.untracked].filter((file) => !inScope(file));
+  if (outside.length > 0) die(`refusing to package: changed outside the writable scope: ${outside.join(", ")}`);
+  const unseen = tree.untracked.filter((file) => !isExcluded(file));
+  if (unseen.length > 0) {
+    die(`refusing to package: untracked file(s) the diff would not show: ${unseen.join(", ")}. Add them, remove them, or declare them with --diff-exclude.`);
+  }
+
+  const diff = scopedDiff(base, diffExcluded);
+  const filesChanged = gitLines("diff", "--name-only", base, "--", ...scopePathspec());
+  const commit = git("rev-parse", "HEAD").trim();
+  const dirty = git("status", "--porcelain").trim() !== "";
+  const changeDigest = digest(diff);
+  const testResults = runTestCommand();
+  const guardRuns = runGuardCommands();
+  const guardViolations = guardRuns.filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`);
+  const summary = flag("summary", "(no summary supplied; the diff is the record)");
+  const pkg = {
+    version: "cross-review-package-v3",
+    taskId: task.taskId,
+    round,
+    baseCommit: base,
+    changeDigest,
+    commit: dirty ? null : commit,
+    headCommit: commit,
+    worktreeDirty: dirty,
+    changeSummary: summary,
+    filesChanged,
+    treeFilesChanged: tree.tracked,
+    diffExcluded,
+    excludedDigests: excludedDigests(diffExcluded.filter((path) => generatedPaths.includes(path))),
+    testResults,
+    guardCommands,
+    guardRuns,
+    producedAt: new Date().toISOString(),
+    diff,
+  };
+  write(`package-round${round}.json`, `${JSON.stringify(pkg, null, 2)}\n`);
+  write(`change-round${round}.diff`, diff);
+  write("change.diff", diff);
+  write(
+    "review-prompt.md",
+    renderReviewPrompt({
+      task,
+      round,
+      changeDigest,
+      commit: pkg.commit,
+      diff,
+      testResults,
+      guardRuns,
+      guardViolations,
+      authorSummary: summary,
+      authorSelfAssessment: null,
+      previousFindings: round > 0 ? previous[round - 1].verdict.findings : [],
+    })
+  );
+  const exchange = await replay([...previous, { round, pkg, verdict: null }]);
+  write("exchange.json", `${JSON.stringify(exchange, null, 2)}\n`);
+  const checks = [...testResults, ...guardRuns];
+  console.log(
+    `packaged ${task.taskId} round ${round}: ${filesChanged.length} file(s), digest ${changeDigest}, ${testResults.length} test command(s), ${guardRuns.length} guard rule(s)${checks.every((t) => t.passed) && checks.length > 0 ? "" : " (CHECKS NOT PASSING)"} — ${exchange.status}`
+  );
+  process.exit(0);
+}
+
+// ---------------------------------------------------------------------------
+// review: only the reviewer, on a packaged round.
+
+if (mode === "review") {
+  const packaged = packagedRounds();
+  if (packaged.length === 0) die(`nothing is packaged under ${outDir}; run --mode=package first.`);
+  const round = Number.parseInt(flag("round", String(packaged[packaged.length - 1])), 10);
+  if (!Number.isInteger(round) || round < 0) die("--round must be a non-negative integer.");
+  const rounds = loadRounds(round);
+  const current = rounds[round];
+  if (current.verdict) die(`${verdictFile(round)} already exists; a new review needs a new package with a new digest.`);
+  if (round > 0) {
+    const refusal = refusalToContinue(await replay(rounds.slice(0, round)), round);
+    if (refusal) die(`refusing to review round ${round}: ${refusal}`);
+  }
+  // The reviewer reads the tree it is run in and is told which change it is
+  // reading. The two have to be the same change: the tree's diff against
+  // the base, scoped and excluded exactly as the package was, must digest to
+  // what the package says, and every excluded file must still be what the
+  // package recorded. (HEAD is not the test -- committing the package files
+  // moves HEAD without changing the change.)
+  const liveDiff = scopedDiff(current.pkg.baseCommit, current.pkg.diffExcluded ?? []);
+  if (digest(liveDiff) !== current.pkg.changeDigest) {
+    die(
+      `the working tree is not the packaged change: its diff against ${current.pkg.baseCommit} digests to ${digest(liveDiff)}, ` +
+        `the package to ${current.pkg.changeDigest}. Check out the packaged change, or package again.`
+    );
+  }
+  for (const [path, recorded] of Object.entries(current.pkg.excludedDigests ?? {})) {
+    const now = existsSync(path) ? digestFile(path) : "(missing)";
+    if (now !== recorded) die(`the excluded file ${path} is not what the package recorded (${now} vs ${recorded}). Package again.`);
+  }
+  const request = {
+    task,
+    round,
+    changeDigest: current.pkg.changeDigest,
+    commit: current.pkg.commit,
+    diff: current.pkg.diff,
+    testResults: current.pkg.testResults,
+    guardRuns: current.pkg.guardRuns ?? [],
+    guardViolations: (current.pkg.guardRuns ?? []).filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`),
+    authorSummary: current.pkg.changeSummary,
+    authorSelfAssessment: null,
+    previousFindings: round > 0 ? rounds[round - 1].verdict.findings : [],
+  };
+  write("review-prompt.md", renderReviewPrompt(request));
+  const options = buildCli("reviewer", roles.reviewer, authorised ? "live" : "dry-run");
+  const line = cliCommandLine(options.invocation, options.configOverrides ?? [], REVIEWER_CONFIG_OVERRIDE_KEYS);
+  if (!line.ok) die(line.detail);
+  console.error(`reviewer command: ${[options.invocation.command, ...line.args].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
+  const startedAt = new Date();
+  const result = await cliReviewer(options).review(request);
+  const durationMs = Date.now() - startedAt.getTime();
+  if (lastSpawn) {
+    if (lastSpawn.stdout) write(`review-round${round}.events.jsonl`, lastSpawn.stdout);
+    if (lastSpawn.stderr) write(`review-round${round}.stderr.txt`, lastSpawn.stderr);
+  }
+  if (!result.ok) {
+    if (authorised) {
+      write(
+        `review-round${round}.failure.json`,
+        `${JSON.stringify({ round, reviewer: roles.reviewer, command: [options.invocation.command, ...line.args], startedAt: startedAt.toISOString(), durationMs, failure: result.failure, detail: result.detail }, null, 2)}\n`
+      );
+    }
+    console.log(`${task.taskId} round ${round}: reviewer ${result.failure} — ${result.detail}`);
+    process.exit(2);
+  }
+  write(
+    `verdict-round${round}.json`,
+    `${JSON.stringify(
+      {
+        version: "cross-review-verdict-v1",
+        taskId: task.taskId,
+        round,
+        reviewer: roles.reviewer,
+        command: [options.invocation.command, ...line.args],
+        startedAt: startedAt.toISOString(),
+        durationMs,
+        receivedAt: new Date().toISOString(),
+        verdict: result.value,
+      },
+      null,
+      2
+    )}\n`
+  );
+  current.verdict = result.value;
+  const exchange = await replay(rounds);
+  write("exchange.json", `${JSON.stringify(exchange, null, 2)}\n`);
+  console.log(
+    `${task.taskId} round ${round}: ${result.value.conclusion} with ${result.value.findings.length} finding(s) — ${exchange.status}${exchange.holdReason ? ` (${exchange.holdReason})` : ""}: ${exchange.nextAction}`
+  );
+  process.exit(exchange.status === "passed" ? 0 : 2);
+}
+
+// ---------------------------------------------------------------------------
+// mock, dry-run, live: the whole loop.
+
+let author;
+let reviewer;
+let fixtureTests = null;
+let fixtureGuards = null;
+let current = -1;
+let guards;
+if (mode === "mock") {
+  const fixturePath = flag("fixture");
+  if (!fixturePath) die("--fixture=<fixture.json> is required in mock mode.");
+  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
+  author = mockAuthor(roles.author, (fixture.author ?? []).map((entry) => ("ok" in entry ? entry : { ok: true, value: entry })));
+  reviewer = mockReviewer(roles.reviewer, (fixture.reviewer ?? []).map((entry) => ("ok" in entry ? entry : { ok: true, value: entry })));
+  fixtureTests = fixture.tests ?? null;
+  fixtureGuards = fixture.guards ?? null;
+  guards = async () => [...(fixtureGuards ? fixtureGuards[current] ?? [] : []), ...runGuardCommands()];
+} else {
+  if (mode === "live" && !authorised) {
+    die("--mode=live runs external tools that edit and spend. Pass --i-have-authorised-live-execution to confirm.");
+  }
+  const executorMode = mode === "live" ? "live" : "dry-run";
+  const cliAuthorExecutor = cliAuthor(buildCli("author", roles.author, executorMode));
+  author = mode === "live" ? treeBackedAuthor(cliAuthorExecutor) : cliAuthorExecutor;
+  reviewer = cliReviewer(buildCli("reviewer", roles.reviewer, executorMode));
+  // One guard rule the loop always runs in live mode: the tree the author
+  // left behind holds nothing the diff of record cannot show.
+  guards = async () => {
+    const tree = treeChanges(task.baseCommit);
+    // An untracked file is never in a git diff, so the diff of record cannot
+    // show it whatever the author reported.
+    const unseen = tree.untracked;
+    const treeRule = {
+      rule: "the working tree holds nothing the diff cannot show",
+      passed: unseen.length === 0,
+      detail: unseen.length === 0 ? `${tree.tracked.length} tracked change(s), no untracked file` : `untracked: ${unseen.join(", ")}`,
+    };
+    return [treeRule, ...runGuardCommands()];
+  };
+}
+
+const outcome = await runCrossReview({
+  task,
+  roles,
+  author,
+  reviewer,
+  digest,
+  maxRevisions,
+  timeoutMs,
+  runTests: async () => {
+    current += 1;
+    const fromFixture = fixtureTests ? fixtureTests[current] ?? [] : [];
+    return testCommand ? runTestCommand() : fromFixture;
+  },
+  guards,
+});
+
+write("exchange.json", `${JSON.stringify(outcome.exchange, null, 2)}\n`);
+const last = outcome.exchange.rounds[outcome.exchange.rounds.length - 1];
+if (last) {
+  write(
+    "review-prompt.md",
+    renderReviewPrompt({
+      task,
+      round: last.round,
+      changeDigest: last.changeDigest,
+      commit: last.commit,
+      diff: "(see exchange.json rounds[].changeDigest; the diff is held by the author executor)",
+      testResults: last.testResults,
+      guardRuns: last.guardRuns,
+      guardViolations: last.guardViolations,
+      authorSummary: last.changeSummary,
+      authorSelfAssessment: null,
+      previousFindings: [],
+    })
+  );
+}
+console.log(
+  `${task.taskId}: ${outcome.status}${outcome.failure ? ` (${outcome.failure})` : ""}${outcome.holdReason ? ` (${outcome.holdReason})` : ""} after ${outcome.exchange.rounds.length} round(s) — ${outcome.exchange.nextAction}`
+);
+process.exit(outcome.status === "passed" ? 0 : 2);
diff --git a/scripts/report-router-full-catalog.mjs b/scripts/report-router-full-catalog.mjs
new file mode 100644
index 00000000..a377efc7
--- /dev/null
+++ b/scripts/report-router-full-catalog.mjs
@@ -0,0 +1,271 @@
+// What the Router would do with the whole catalogue, for every item in an
+// evaluation set, decided offline.
+//
+// Reads the set, runs the product's own decision on each item over the static
+// catalogue, and prints for every model whether it was chosen, was a fallback
+// candidate, or was refused and for which fixed reason; which quality evidence
+// (if any) the choice rested on; what separated the primary from each loser;
+// and how the output cap the Router routed under compares with the one
+// dispatch will apply. Nothing is called, nothing is billed, nothing is
+// written unless --json or --md names a path.
+//
+// Usage:
+//   node --import tsx scripts/report-router-full-catalog.mjs \
+//     [--set=docs/ops/router-evaluation-set/development-v0.json] \
+//     [--items=adopted|all] [--plan=Pro] [--requested-model=<catalogue id>] \
+//     [--fallback-flag=off|on] [--json=<out.json>] [--summary-json=<out.json>] [--md=<out.md>] [--quiet]
+//
+// The catalogue is lib/models.ts as committed. The product routes over the
+// runtime registry's rows instead, with health and measured signals from the
+// database, so this describes the Router as the catalogue would run it, not
+// as the deployment does today. The report's `inputs` block says so.
+
+import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
+import { dirname } from "node:path";
+
+import { AVAILABLE_MODELS } from "../lib/models.ts";
+import { diagnoseFullCatalog, TIE_BREAK_ORDER } from "../lib/routerFullCatalogDiagnostic.ts";
+import { adoptedItems } from "../lib/routerQualityEvalSet.ts";
+import { NO_WEB_SEARCH_BACKENDS } from "../lib/webSearchBackends.ts";
+
+const args = new Map(
+  process.argv.slice(2).map((arg) => {
+    const [key, ...rest] = arg.replace(/^--/, "").split("=");
+    return [key, rest.length > 0 ? rest.join("=") : "true"];
+  })
+);
+const flag = (name, fallback) => args.get(name) ?? fallback;
+const die = (message) => {
+  console.error(message);
+  process.exit(1);
+};
+
+const setPath = flag("set", "docs/ops/router-evaluation-set/development-v0.json");
+const itemScope = flag("items", "adopted");
+if (itemScope !== "adopted" && itemScope !== "all") die("--items must be adopted or all.");
+const plan = flag("plan", "Pro");
+if (!["Guest", "Free", "Pro", "Max"].includes(plan)) die("--plan must be Guest, Free, Pro or Max.");
+const fallbackFlag = flag("fallback-flag", "off");
+if (fallbackFlag !== "off" && fallbackFlag !== "on") die("--fallback-flag must be off or on.");
+const quiet = flag("quiet", "false") === "true";
+
+const set = JSON.parse(readFileSync(setPath, "utf8"));
+const items = itemScope === "adopted" ? adoptedItems(set) : set.items;
+const requestedModelId = flag("requested-model", set.baseline?.modelId);
+if (!requestedModelId) die("--requested-model is required when the set names no baseline.");
+
+const report = diagnoseFullCatalog({
+  items,
+  models: AVAILABLE_MODELS,
+  plan,
+  requestedModelId,
+  // No credential is assumed. A deployment holding one passes a different
+  // readiness and gets a different answer on current-information items.
+  searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
+  fallbackEnvironment: fallbackFlag === "on" ? { AUTO_ROUTER_FALLBACK_ENABLED: "on" } : {},
+  catalogueSource: "lib/models.ts (static catalogue, not the runtime registry)",
+});
+
+const pct = (numerator, denominator) =>
+  denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(1)}%`;
+
+const lines = [];
+const say = (line = "") => lines.push(line);
+
+say(`# Full-catalogue routing diagnostic — ${set.version} (${itemScope} items)`);
+say();
+say(`Diagnostic ${report.version}; Router ${JSON.stringify(report.routerVersions)}.`);
+say(
+  `Catalogue: ${report.inputs.catalogueModelCount} models, ${report.inputs.enabledModelCount} enabled ` +
+    `(${report.inputs.catalogueSource}). Plan ${report.inputs.plan}; routed under ${report.inputs.requestedModelId}'s ` +
+    `cap of ${report.inputs.routerRequestOutputCapTokens} output tokens; no sticky state; signals supplied: ` +
+    `${report.inputs.signalsSupplied.length === 0 ? "none (cost derived from the pricing registry)" : report.inputs.signalsSupplied.join(", ")}; ` +
+    `fallback flag ${report.inputs.fallbackFlagAsDeployed}.`
+);
+say(`Tie-break order: ${TIE_BREAK_ORDER.join(" > ")}.`);
+say();
+
+say("## Summary");
+say();
+say(`| | |`);
+say(`|---|---|`);
+say(`| items | ${report.inputs.itemCount} |`);
+say(`| items whose explanation disagrees with the product decision | ${report.summary.consistencyProblems} |`);
+say(
+  `| (model, kind) cells with approved quality evidence | ${report.summary.evidenceCells.withEvidence} of ${report.summary.evidenceCells.total} |`
+);
+say(`| items where dispatch's output cap differs from the Router's | ${report.summary.outputCapMismatchItems} |`);
+say(`| pairwise inversions against the primary | ${report.summary.pairwiseInversions} |`);
+say(`| enabled models never eligible on any item | ${report.summary.neverEligible.filter((e) => AVAILABLE_MODELS.find((m) => m.id === e.modelId)?.enabled).length} |`);
+say(`| models eligible at least once and never primary | ${report.summary.eligibleNeverPrimary.length} |`);
+say();
+
+say("### Primary by model");
+say();
+say("| model | items | share |");
+say("|---|---|---|");
+for (const [modelId, n] of Object.entries(report.summary.primaryCounts).sort((a, b) => b[1] - a[1])) {
+  say(`| ${modelId} | ${n} | ${pct(n, report.inputs.itemCount)} |`);
+}
+say();
+
+say("### Primary by ranking kind");
+say();
+say("| kind | items | primaries |");
+say("|---|---|---|");
+for (const [kind, byModel] of Object.entries(report.summary.primaryCountsByKind).sort()) {
+  const total = Object.values(byModel).reduce((sum, n) => sum + n, 0);
+  say(
+    `| ${kind} | ${total} | ${Object.entries(byModel)
+      .sort((a, b) => b[1] - a[1])
+      .map(([id, n]) => `${id} ${n}`)
+      .join(", ")} |`
+  );
+}
+say();
+
+say("### What decided the top two");
+say();
+say("| criterion | items |");
+say("|---|---|");
+for (const [criterion, n] of Object.entries(report.summary.decidedByCounts).sort((a, b) => b[1] - a[1])) {
+  say(`| ${criterion} | ${n} |`);
+}
+say();
+
+say("### Rejections, summed over items");
+say();
+say("| reason | model-items |");
+say("|---|---|");
+for (const [reason, n] of Object.entries(report.summary.rejectionCounts).sort((a, b) => b[1] - a[1])) {
+  say(`| ${reason} | ${n} |`);
+}
+say();
+
+say("### Never eligible");
+say();
+say("| model | enabled | reasons |");
+say("|---|---|---|");
+for (const entry of report.summary.neverEligible) {
+  const model = AVAILABLE_MODELS.find((m) => m.id === entry.modelId);
+  say(`| ${entry.modelId} | ${model?.enabled ? "yes" : "no"} | ${entry.reasons.join(", ")} |`);
+}
+say();
+if (report.summary.eligibleNeverPrimary.length > 0) {
+  say("### Eligible at least once, never primary");
+  say();
+  say(report.summary.eligibleNeverPrimary.map((id) => `- ${id}`).join("\n"));
+  say();
+}
+
+say("### Fallback scope as deployed");
+say();
+say("| scope | items |");
+say("|---|---|");
+for (const [scope, n] of Object.entries(report.summary.fallbackScopeAsDeployed).sort((a, b) => b[1] - a[1])) {
+  say(`| ${scope} | ${n} |`);
+}
+say();
+
+say("### Fallback reachable, as far as can be decided offline");
+say();
+say(
+  "Reachable means the gate allows a fallback, decideFallback (the product's function, under the stated failure hypothesis) names a candidate, and dispatch fits that candidate under its own reservation; the product tries that one candidate and no other. A refusal names the step that said no. What only a real dispatch can refuse (search path, budget, registry row, provider hold) is listed per item as undecided and is not folded into these counts."
+);
+say();
+say("| as deployed | items | | with the flag on | items |");
+say("|---|---|---|---|---|");
+const asDeployed = Object.entries(report.summary.fallbackReachableAsDeployed).sort((a, b) => b[1] - a[1]);
+const withFlag = Object.entries(report.summary.fallbackReachableIfFlagOn).sort((a, b) => b[1] - a[1]);
+for (let i = 0; i < Math.max(asDeployed.length, withFlag.length); i += 1) {
+  const left = asDeployed[i] ? `${asDeployed[i][0]} | ${asDeployed[i][1]}` : " | ";
+  const right = withFlag[i] ? `${withFlag[i][0]} | ${withFlag[i][1]}` : " | ";
+  say(`| ${left} | | ${right} |`);
+}
+say();
+
+say("## Improvement and evaluation candidates");
+say();
+say("Offline work this diagnostic points at. None of it changes routing on its own.");
+say();
+for (const candidate of report.improvementCandidates) {
+  say(`- **${candidate.kind}** (${candidate.itemCount} item(s); kinds ${candidate.taskKinds.join(", ")}): ${candidate.detail}`);
+  say(`  models: ${candidate.modelIds.join(", ")}`);
+}
+say();
+
+if (report.problems.length > 0) {
+  say("## Problems");
+  say();
+  for (const problem of report.problems) say(`- ${problem}`);
+  say();
+}
+
+say("## Per item");
+say();
+say("| item | kind (conf) | primary | decided by | reason | eligible | rejected | router→dispatch output cap | fallback candidate | reachable as deployed | reachable with flag on |");
+say("|---|---|---|---|---|---|---|---|---|---|---|");
+const executable = (answer) => (answer.reachable ? `${answer.modelId} (${answer.dispatchFit})` : answer.refusal);
+for (const item of report.items) {
+  const eligible = item.models.filter((m) => m.rejectionReason === null).length;
+  const cap = item.caps.primary
+    ? `${item.caps.primary.routerOutputTokens}→${item.caps.primary.dispatchOutputTokens ?? item.caps.primary.dispatchFit}${item.caps.primary.outputCapDiffers ? " (differs)" : ""}`
+    : "—";
+  const candidate = item.fallback.firstCandidate
+    ? `${item.fallback.firstCandidate.modelId} (${item.fallback.firstCandidate.dispatchFit})`
+    : "none";
+  say(
+    `| ${item.itemId} | ${item.profile.rankingKind} (${item.profile.kindConfidence}) | ${item.decision.primaryModelId ?? "—"} | ` +
+      `${item.decision.decidedBy ?? "—"} | ${item.decision.selectionReason} | ${eligible} | ${item.models.length - eligible} | ${cap} | ${candidate} | ` +
+      `${executable(item.fallback.reachableAsDeployed)} | ${executable(item.fallback.reachableIfFlagOn)} |`
+  );
+}
+
+const markdown = `${lines.join("\n")}\n`;
+if (!quiet) process.stdout.write(markdown);
+
+const jsonOut = args.get("json");
+if (jsonOut) {
+  mkdirSync(dirname(jsonOut), { recursive: true });
+  writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
+  console.error(`written ${jsonOut}`);
+}
+// The committed per-item summary: the full report without the per-model rows,
+// each item's rejections folded to `{ modelId: reason }`, and the fallback
+// block without the identical `notModelled` list. Everything else is the
+// report as computed, so the two files cannot disagree.
+const summaryOut = args.get("summary-json");
+if (summaryOut) {
+  const summary = {
+    ...report,
+    items: report.items.map(({ models, fallback, ...item }) => ({
+      ...item,
+      rejections: Object.fromEntries(models.filter((m) => m.rejectionReason !== null).map((m) => [m.modelId, m.rejectionReason])),
+      fallback: {
+        maxModelFallbacks: fallback.maxModelFallbacks,
+        scopeAsDeployed: fallback.scopeAsDeployed,
+        scopeIfFlagOn: fallback.scopeIfFlagOn,
+        decision: fallback.decision,
+        firstCandidate: fallback.firstCandidate,
+        reachableAsDeployed: fallback.reachableAsDeployed.reachable
+          ? { ...fallback.reachableAsDeployed, undecidedOffline: "see the full report" }
+          : fallback.reachableAsDeployed,
+        reachableIfFlagOn: fallback.reachableIfFlagOn.reachable
+          ? { ...fallback.reachableIfFlagOn, undecidedOffline: "see the full report" }
+          : fallback.reachableIfFlagOn,
+      },
+    })),
+    note:
+      `Per-item model rows are in the full report (${jsonOut ?? "the --json output"}, regenerated by npm run report:router-full-catalog -- --json=...); ` +
+      "this file keeps the decision, rejections, caps, fallback and evidence per item. fallback.notModelled is the same for every item and is in the full report.",
+  };
+  mkdirSync(dirname(summaryOut), { recursive: true });
+  writeFileSync(summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
+  console.error(`written ${summaryOut}`);
+}
+const mdOut = args.get("md");
+if (mdOut) {
+  mkdirSync(dirname(mdOut), { recursive: true });
+  writeFileSync(mdOut, markdown);
+  console.error(`written ${mdOut}`);
+}
diff --git a/tests/crossReview.test.mjs b/tests/crossReview.test.mjs
new file mode 100644
index 00000000..79b53f3a
--- /dev/null
+++ b/tests/crossReview.test.mjs
@@ -0,0 +1,653 @@
+import assert from "node:assert/strict";
+import { createHash } from "node:crypto";
+import test from "node:test";
+
+import {
+  CROSS_REVIEW_VERSION,
+  DEFAULT_MAX_REVISIONS,
+  MAX_REVISIONS,
+  authorOutputProblems,
+  filesNamedByDiff,
+  isActionable,
+  parseExecutorJson,
+  renderReviewPrompt,
+  replayExchange,
+  resolveMaxRevisions,
+  reviewVerdictProblems,
+  runCrossReview,
+} from "../lib/crossReviewCore.ts";
+import {
+  CLI_INVOCATIONS,
+  REVIEWER_CONFIG_OVERRIDE_KEYS,
+  approveCurrent,
+  cliAuthor,
+  cliCommandLine,
+  cliReviewer,
+  mockAuthor,
+  mockReviewer,
+  unwrapClaudeResult,
+} from "../lib/crossReviewExecutors.ts";
+
+/**
+ * The control program decides; the executors only answer. What these tests
+ * hold: a pass needs a verdict on the current digest *and* passing checks; a
+ * fix is re-reviewed on its new digest; the cap ends the loop on hold rather
+ * than retrying; and every way an executor can fail to answer is a named
+ * failure, never a pass. The command-line shells are proven never to run in
+ * dry-run by handing them a spawner that throws.
+ */
+
+const digest = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
+
+const task = {
+  taskId: "T-1",
+  requirement: "Add a pure helper that sums an array.",
+  completionCriteria: ["a test covers the empty array", "no file outside lib/ and tests/ changes"],
+  baseCommit: "abc123",
+  writableScope: ["lib/", "tests/"],
+};
+
+const change = (n, overrides = {}) => ({
+  ok: true,
+  value: {
+    diff: `--- a/lib/sum.ts\n+++ b/lib/sum.ts\n+export const sum = (xs) => xs.reduce((a, b) => a + b, ${n});\n`,
+    summary: `round ${n} change`,
+    filesChanged: ["lib/sum.ts"],
+    selfAssessment: "looks fine to me",
+    commit: null,
+    ...overrides,
+  },
+});
+
+const pass = (command = "npm test") => [{ command, passed: true, output: "ok", durationMs: 1 }];
+const fail = (command = "npm test") => [{ command, passed: false, output: "1 failing", durationMs: 1 }];
+const guardPass = (rule = "npm run lint") => [{ rule, passed: true, detail: "no problems", durationMs: 1 }];
+const guardFail = (rule = "protected files", detail = "tests/protected.test.mjs was modified") => [{ rule, passed: false, detail, durationMs: 1 }];
+
+const finding = (overrides = {}) => ({
+  location: "lib/sum.ts:1",
+  severity: "error",
+  basis: "evidence",
+  claim: "sum([]) returns the seed, which is wrong for the empty array",
+  reproduction: "node -e 'sum([])'",
+  ...overrides,
+});
+
+const control = (overrides = {}) => ({
+  task,
+  digest,
+  runTests: async () => pass(),
+  guards: async () => guardPass(),
+  now: () => new Date("2026-09-09T00:00:00Z"),
+  timeoutMs: 1000,
+  ...overrides,
+});
+
+test("a verdict on the current digest with passing checks is the only pass", async () => {
+  const author = mockAuthor("claude", [change(0)]);
+  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0)]);
+  const outcome = await runCrossReview(control({ author, reviewer }));
+  assert.equal(outcome.status, "passed");
+  assert.equal(outcome.failure, null);
+  assert.equal(outcome.exchange.version, CROSS_REVIEW_VERSION);
+  assert.equal(outcome.exchange.rounds.length, 1);
+  assert.equal(outcome.exchange.changeDigest, digest(change(0).value.diff));
+  assert.equal(outcome.exchange.reviewConclusion, "approve");
+  assert.deepEqual(outcome.exchange.roles, { author: "claude", reviewer: "codex" });
+  assert.equal(outcome.exchange.maxRevisions, DEFAULT_MAX_REVISIONS);
+  // The reviewer was shown the requirement and the diff, and the author's
+  // self-assessment only as a labelled claim.
+  const request = reviewer.calls[0];
+  assert.equal(request.task.requirement, task.requirement);
+  assert.equal(request.changeDigest, outcome.exchange.changeDigest);
+  const prompt = renderReviewPrompt(request);
+  assert.ok(prompt.indexOf("## Requirement (original)") < prompt.indexOf("## Change under review"));
+  assert.ok(prompt.indexOf("## Change under review") < prompt.indexOf("## Author's account"));
+  assert.ok(prompt.includes("a claim, not a finding"));
+});
+
+test("an evidenced finding sends the change back, and the fix is reviewed on its new digest", async () => {
+  const author = mockAuthor("claude", [change(0), change(1)]);
+  const reviewer = mockReviewer("codex", [
+    { ok: true, value: { taskId: "T-1", round: 0, reviewedDigest: "@current", conclusion: "request_changes", findings: [finding()], nextAction: "fix the seed" } },
+    approveCurrent("T-1", 1),
+  ]);
+  const outcome = await runCrossReview(control({ author, reviewer }));
+  assert.equal(outcome.status, "passed");
+  assert.equal(outcome.exchange.rounds.length, 2);
+  assert.equal(outcome.exchange.rounds[0].findings[0].disposition, "fix_requested");
+  assert.notEqual(outcome.exchange.rounds[0].changeDigest, outcome.exchange.rounds[1].changeDigest);
+  assert.equal(reviewer.calls[1].changeDigest, outcome.exchange.rounds[1].changeDigest);
+  assert.deepEqual(reviewer.calls[1].previousFindings, [finding()]);
+  assert.deepEqual(author.calls[1].feedback.findings.map((f) => f.location), ["lib/sum.ts:1"]);
+});
+
+test("after the revision cap the change goes on hold with its findings, and is not retried", async () => {
+  const author = mockAuthor("claude", [change(0), change(1), change(2), change(3)]);
+  const requestChanges = (round) => ({
+    ok: true,
+    value: { taskId: "T-1", round, reviewedDigest: "@current", conclusion: "request_changes", findings: [finding()], nextAction: "still wrong" },
+  });
+  const reviewer = mockReviewer("codex", [requestChanges(0), requestChanges(1), requestChanges(2), requestChanges(3)]);
+  const outcome = await runCrossReview(control({ author, reviewer, maxRevisions: 2 }));
+  assert.equal(outcome.status, "on_hold");
+  assert.equal(outcome.holdReason, "revisions_exhausted");
+  assert.equal(outcome.exchange.rounds.length, 3, "round 0 plus two revisions");
+  assert.equal(author.calls.length, 3);
+  assert.equal(outcome.exchange.findings[0].disposition, "unresolved_on_hold");
+  assert.equal(outcome.exchange.findings[0].reproduction, "node -e 'sum([])'");
+});
+
+test("two executors agreeing is not a pass while a required check fails", async () => {
+  const author = mockAuthor("claude", [change(0), change(1)]);
+  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0), approveCurrent("T-1", 1)]);
+  const outcome = await runCrossReview(control({ author, reviewer, runTests: async () => fail(), maxRevisions: 1 }));
+  assert.equal(outcome.status, "on_hold");
+  assert.equal(outcome.holdReason, "approved_but_checks_failed");
+  assert.equal(outcome.exchange.rounds.length, 2);
+  assert.equal(outcome.exchange.rounds[0].reviewConclusion, "approve");
+  assert.deepEqual(author.calls[1].feedback.failedTests.map((t) => t.command), ["npm test"]);
+});
+
+test("a guard violation is a failed check even with passing tests and an approval", async () => {
+  const author = mockAuthor("claude", [change(0), change(1)]);
+  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0), approveCurrent("T-1", 1)]);
+  const outcome = await runCrossReview(
+    control({ author, reviewer, guards: async () => guardFail(), maxRevisions: 1 })
+  );
+  assert.equal(outcome.status, "on_hold");
+  assert.equal(outcome.holdReason, "approved_but_checks_failed");
+  assert.deepEqual(author.calls[1].feedback.guardViolations, ["protected files: tests/protected.test.mjs was modified"]);
+  assert.deepEqual(author.calls[1].feedback.checkFailures, ["guard failed: protected files"]);
+});
+
+test("a finding without a reproduction never forces a revision, whatever its basis; the current version stands with it recorded", async () => {
+  const author = mockAuthor("claude", [change(0)]);
+  const reviewer = mockReviewer("codex", [
+    {
+      ok: true,
+      value: {
+        taskId: "T-1",
+        round: 0,
+        reviewedDigest: "@current",
+        conclusion: "request_changes",
+        findings: [
+          finding({ basis: "preference", severity: "nit", claim: "I would name it total", reproduction: undefined }),
+          finding({ basis: "judgement", severity: "warning", claim: "this will be slow", reproduction: undefined }),
+          // "evidence" is a label; without the reproduction that would let
+          // anyone check it, it is a claim like any other.
+          finding({ basis: "evidence", severity: "error", claim: "this is wrong, trust me", reproduction: undefined }),
+          finding({ basis: "evidence", severity: "error", claim: "this is wrong, trust me", reproduction: "   " }),
+        ],
+        nextAction: "rename and optimise",
+      },
+    },
+  ]);
+  const outcome = await runCrossReview(control({ author, reviewer }));
+  assert.equal(outcome.status, "passed");
+  assert.equal(author.calls.length, 1);
+  assert.deepEqual(
+    outcome.exchange.findings.map((f) => f.disposition),
+    ["resolved_by_project_rule", "insufficient_evidence_kept_current", "insufficient_evidence_kept_current", "insufficient_evidence_kept_current"]
+  );
+  assert.equal(isActionable(finding({ basis: "judgement", reproduction: "node -e 1" })), true);
+  assert.equal(isActionable(finding({ basis: "judgement", reproduction: undefined })), false);
+  assert.equal(isActionable(finding({ basis: "evidence", reproduction: "node -e 1" })), true);
+  assert.equal(isActionable(finding({ basis: "evidence", reproduction: undefined })), false);
+  assert.equal(isActionable(finding({ basis: "preference", reproduction: "node -e 1" })), false);
+  // The schema still admits the finding -- a verdict is not thrown away for
+  // a missing field -- and the prompt says what the field is for.
+  assert.equal(reviewVerdictProblems({ taskId: "T-1", round: 0, reviewedDigest: "d", conclusion: "approve", findings: [finding({ basis: "evidence", reproduction: undefined })], nextAction: "" }).length, 0);
+  assert.match(renderReviewPrompt({ task, round: 0, changeDigest: "d", commit: null, diff: "", testResults: [], guardRuns: [], guardViolations: [], authorSummary: "s", authorSelfAssessment: null, previousFindings: [] }), /acted on only with a reproduction/);
+});
+
+test("a verdict naming another digest, task or round does not apply", async () => {
+  for (const [patch, failure] of [
+    [{ reviewedDigest: "sha256:0000" }, "digest_mismatch"],
+    [{ taskId: "T-9" }, "task_mismatch"],
+    [{ round: 4 }, "round_mismatch"],
+  ]) {
+    const author = mockAuthor("claude", [change(0)]);
+    const reviewer = mockReviewer("codex", [
+      { ok: true, value: { ...approveCurrent("T-1", 0).value, ...patch } },
+    ]);
+    const outcome = await runCrossReview(control({ author, reviewer }));
+    assert.equal(outcome.status, "failed", failure);
+    assert.equal(outcome.failure, failure);
+  }
+});
+
+test("invalid JSON, a missing result, a timeout and an executor failure are named failures, not passes", async () => {
+  const cases = [
+    [{ ok: false, failure: "invalid_json", detail: "x" }, "reviewer_invalid_json"],
+    [{ ok: false, failure: "missing_result", detail: "x" }, "reviewer_missing_result"],
+    [{ ok: false, failure: "execution_failed", detail: "x" }, "reviewer_execution_failed"],
+  ];
+  for (const [scripted, failure] of cases) {
+    const outcome = await runCrossReview(
+      control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", [scripted]) })
+    );
+    assert.equal(outcome.status, "failed");
+    assert.equal(outcome.failure, failure);
+  }
+  // A reviewer that never answers is a timeout.
+  const hanging = { id: "codex", review: () => new Promise(() => {}) };
+  const timedOut = await runCrossReview(control({ author: mockAuthor("claude", [change(0)]), reviewer: hanging, timeoutMs: 20 }));
+  assert.equal(timedOut.status, "failed");
+  assert.equal(timedOut.failure, "reviewer_timeout");
+  // An author that throws is an execution failure.
+  const throwing = { id: "claude", produce: async () => { throw new Error("boom"); } };
+  const crashed = await runCrossReview(control({ author: throwing, reviewer: mockReviewer("codex", []) }));
+  assert.equal(crashed.status, "failed");
+  assert.equal(crashed.failure, "author_execution_failed");
+  // A reviewer with no scripted answer is a missing result.
+  const silent = await runCrossReview(control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", []) }));
+  assert.equal(silent.failure, "reviewer_missing_result");
+});
+
+test("a reviewer that is blocked puts the change on hold for a person", async () => {
+  const outcome = await runCrossReview(
+    control({
+      author: mockAuthor("claude", [change(0)]),
+      reviewer: mockReviewer("codex", [
+        { ok: true, value: { taskId: "T-1", round: 0, reviewedDigest: "@current", conclusion: "blocked", findings: [], nextAction: "the diff does not apply to the base" } },
+      ]),
+    })
+  );
+  assert.equal(outcome.status, "on_hold");
+  assert.equal(outcome.holdReason, "reviewer_blocked");
+});
+
+test("a change outside the writable scope is refused before review", async () => {
+  const outcome = await runCrossReview(
+    control({
+      author: mockAuthor("claude", [change(0, { filesChanged: ["lib/sum.ts", "app/api/chat/route.ts"] })]),
+      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
+    })
+  );
+  assert.equal(outcome.status, "failed");
+  assert.equal(outcome.failure, "scope_violation");
+});
+
+test("the control program digests the diff itself and ignores any digest the author claims", async () => {
+  const author = mockAuthor("claude", [change(0, { changeDigest: "sha256:forged" })]);
+  const reviewer = mockReviewer("codex", [approveCurrent("T-1", 0)]);
+  const outcome = await runCrossReview(control({ author, reviewer }));
+  assert.equal(outcome.exchange.changeDigest, digest(change(0).value.diff));
+});
+
+test("executor output is parsed strictly: whole document, last line, or last block; anything else is a named failure", () => {
+  const verdict = { taskId: "T-1", round: 0, reviewedDigest: "sha256:a", conclusion: "approve", findings: [], nextAction: "ok" };
+  assert.equal(parseExecutorJson(JSON.stringify(verdict), reviewVerdictProblems).ok, true);
+  assert.equal(parseExecutorJson(`event 1\nevent 2\n${JSON.stringify(verdict)}`, reviewVerdictProblems).ok, true);
+  assert.equal(parseExecutorJson(`Here you go:\n${JSON.stringify(verdict)}\nthanks`, reviewVerdictProblems).ok, true);
+  assert.equal(parseExecutorJson("", reviewVerdictProblems).failure, "missing_result");
+  assert.equal(parseExecutorJson("not json at all", reviewVerdictProblems).failure, "invalid_json");
+  assert.equal(parseExecutorJson(JSON.stringify({ ...verdict, conclusion: "yes" }), reviewVerdictProblems).failure, "schema_mismatch");
+  assert.equal(
+    parseExecutorJson(JSON.stringify({ ...verdict, findings: [{ location: "", severity: "high", basis: "vibes", claim: "" }] }), reviewVerdictProblems).failure,
+    "schema_mismatch"
+  );
+  assert.deepEqual(authorOutputProblems({ diff: "", summary: "s", filesChanged: [] }), []);
+  assert.ok(authorOutputProblems({ diff: 1, summary: "", filesChanged: "x" }).length >= 3);
+  assert.equal(unwrapClaudeResult(JSON.stringify({ type: "result", result: JSON.stringify(verdict) })), JSON.stringify(verdict));
+  assert.equal(unwrapClaudeResult("plain"), "plain");
+});
+
+test("in dry-run the command-line executors never spawn, and the run ends as not executed", async () => {
+  const spawn = async () => {
+    throw new Error("spawn must not be called in dry-run");
+  };
+  const options = (role, id) => ({
+    id,
+    invocation: CLI_INVOCATIONS[id][role],
+    mode: "dry-run",
+    cwd: "/nowhere",
+    timeoutMs: 10,
+    spawn,
+  });
+  const outcome = await runCrossReview(
+    control({ author: cliAuthor(options("author", "claude")), reviewer: cliReviewer(options("reviewer", "codex")) })
+  );
+  assert.equal(outcome.status, "failed");
+  assert.equal(outcome.failure, "author_not_executed");
+  assert.match(outcome.exchange.rounds[0].nextAction, /dry-run: would run `claude --print/);
+  // Live mode with a spawner that fails is an execution failure, not a pass.
+  const live = await runCrossReview(
+    control({
+      author: cliAuthor({ ...options("author", "claude"), mode: "live", spawn: async () => ({ status: 1, stdout: "", stderr: "no such tool" }) }),
+      reviewer: cliReviewer(options("reviewer", "codex")),
+    })
+  );
+  assert.equal(live.failure, "author_execution_failed");
+  // Live mode with no spawner cannot run anything.
+  const noSpawn = await runCrossReview(
+    control({ author: cliAuthor({ ...options("author", "claude"), mode: "live", spawn: undefined }), reviewer: cliReviewer(options("reviewer", "codex")) })
+  );
+  assert.equal(noSpawn.failure, "author_execution_failed");
+});
+
+test("the reviewer's command-line invocation offers no write tool and nothing from the user's configuration", () => {
+  for (const id of Object.keys(CLI_INVOCATIONS)) {
+    const args = CLI_INVOCATIONS[id].reviewer.args.join(" ");
+    assert.ok(!/Edit|Write|workspace-write|acceptEdits|danger-full-access|bypass/.test(args), `${id} reviewer: ${args}`);
+  }
+  // codex-cli 0.146.0: the sandbox flag, headless `exec`, and the user layer of
+  // config.toml -- where MCP servers, plugins and hooks come from -- left out.
+  const codex = CLI_INVOCATIONS.codex.reviewer;
+  assert.deepEqual(codex.args.slice(0, 3), ["--sandbox", "read-only", "exec"]);
+  assert.ok(codex.args.includes("--ignore-user-config"));
+  assert.ok(codex.args.includes("--json"));
+  assert.equal(codex.promptArg, "-");
+  assert.equal(codex.configFlag, "-c");
+  // Claude Code 2.1.261: only the read tools are built in, they are pre-approved,
+  // and no MCP server is loaded.
+  const claude = CLI_INVOCATIONS.claude.reviewer;
+  const toolsAt = claude.args.indexOf("--tools");
+  assert.ok(toolsAt !== -1);
+  assert.deepEqual(claude.args[toolsAt + 1].split(","), ["Read", "Grep", "Glob"]);
+  assert.ok(claude.args.includes("--strict-mcp-config"));
+  assert.equal(claude.configFlag, undefined);
+  // The author keeps its write scope; that is its job.
+  assert.ok(CLI_INVOCATIONS.codex.author.args.includes("workspace-write"));
+});
+
+test("a reviewer run may only override the keys on the allow list, and overrides go before the stdin marker", async () => {
+  const codex = CLI_INVOCATIONS.codex.reviewer;
+  const allowed = cliCommandLine(codex, ['model="m"', 'windows.sandbox="elevated"'], REVIEWER_CONFIG_OVERRIDE_KEYS);
+  assert.equal(allowed.ok, true);
+  assert.deepEqual(allowed.args.slice(-5), ["-c", 'model="m"', "-c", 'windows.sandbox="elevated"', "-"]);
+  assert.deepEqual(cliCommandLine(codex).args, [...codex.args, "-"]);
+  for (const widening of ['sandbox_mode="danger-full-access"', 'approval_policy="never"', "mcp_servers.x.command=\"y\"", "features.hooks=true", "plugins.x.enabled=true"]) {
+    const refused = cliCommandLine(codex, [widening], REVIEWER_CONFIG_OVERRIDE_KEYS);
+    assert.equal(refused.ok, false, widening);
+    assert.match(refused.detail, /not allowed/);
+  }
+  assert.equal(cliCommandLine(codex, ["nonsense"], REVIEWER_CONFIG_OVERRIDE_KEYS).ok, false);
+  // A tool without a config flag refuses overrides outright.
+  assert.equal(cliCommandLine(CLI_INVOCATIONS.claude.reviewer, ['model="m"']).ok, false);
+  for (const key of REVIEWER_CONFIG_OVERRIDE_KEYS) {
+    assert.ok(!/sandbox_mode|approval|mcp|plugin|feature|shell_environment/.test(key), key);
+  }
+
+  // Through the executor: a widening override is refused before anything runs,
+  // in dry-run and in live mode alike; an allowed one reaches the spawner in order.
+  const request = { task, round: 0, changeDigest: "sha256:a", commit: null, diff: "", testResults: [], guardRuns: [], guardViolations: [], authorSummary: "s", authorSelfAssessment: null, previousFindings: [] };
+  const base = { id: "codex", invocation: codex, cwd: "/nowhere", timeoutMs: 10 };
+  const throwing = async () => {
+    throw new Error("spawn must not be called");
+  };
+  const refusedDry = await cliReviewer({ ...base, mode: "dry-run", spawn: throwing, configOverrides: ['sandbox_mode="danger-full-access"'] }).review(request);
+  assert.equal(refusedDry.failure, "execution_failed");
+  const refusedLive = await cliReviewer({ ...base, mode: "live", spawn: throwing, configOverrides: ['sandbox_mode="danger-full-access"'] }).review(request);
+  assert.equal(refusedLive.failure, "execution_failed");
+  const dry = await cliReviewer({ ...base, mode: "dry-run", spawn: throwing, configOverrides: ['model="m"'] }).review(request);
+  assert.equal(dry.failure, "not_executed");
+  assert.match(dry.detail, /codex --sandbox read-only exec --ignore-user-config --json -c model="m" -/);
+  const seen = [];
+  const verdict = { taskId: "T-1", round: 0, reviewedDigest: "sha256:a", conclusion: "approve", findings: [], nextAction: "ok" };
+  const live = await cliReviewer({
+    ...base,
+    mode: "live",
+    configOverrides: ['model="m"'],
+    env: { OPENAI_API_KEY: undefined },
+    spawn: async (command, args, options) => {
+      seen.push({ command, args, env: options.env });
+      return { status: 0, stdout: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify(verdict) } }), stderr: "" };
+    },
+  }).review(request);
+  assert.equal(live.ok, true);
+  assert.equal(seen[0].command, "codex");
+  assert.deepEqual(seen[0].args, [...codex.args, "-c", 'model="m"', "-"]);
+  assert.deepEqual(seen[0].env, { OPENAI_API_KEY: undefined });
+});
+
+test("Codex JSONL output is unwrapped to its final agent message; anything else passes through", async () => {
+  const { unwrapCodexJsonl } = await import("../lib/crossReviewExecutors.ts");
+  const verdict = { taskId: "T-1", round: 0, reviewedDigest: "sha256:a", conclusion: "approve", findings: [], nextAction: "ok" };
+  // The shape `codex exec --json` prints at rust-v0.146.0 (exec_events.rs):
+  // events tagged by `type`, items tagged by `type` with an `id`, and the
+  // agent's message in `text`.
+  const jsonl = [
+    JSON.stringify({ type: "thread.started", thread_id: "0199c3b2-1f2e-7d5a-9b1c-3f4e5d6a7b8c" }),
+    JSON.stringify({ type: "turn.started" }),
+    JSON.stringify({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "git status", aggregated_output: "", status: "in_progress" } }),
+    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "git status", aggregated_output: "clean", exit_code: 0, status: "completed" } }),
+    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "thinking" } }),
+    JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "draft" } }),
+    JSON.stringify({ type: "item.completed", item: { id: "item_3", type: "agent_message", text: JSON.stringify(verdict) } }),
+    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } }),
+  ].join("\n");
+  assert.equal(unwrapCodexJsonl(jsonl), JSON.stringify(verdict));
+  assert.equal(parseExecutorJson(unwrapCodexJsonl(jsonl), reviewVerdictProblems).ok, true);
+  // The older core-protocol shape.
+  const legacy = [JSON.stringify({ id: "1", msg: { type: "agent_message", message: JSON.stringify(verdict) } }), JSON.stringify({ id: "2", msg: { type: "task_complete" } })].join("\n");
+  assert.equal(unwrapCodexJsonl(legacy), JSON.stringify(verdict));
+  // A failed turn has no agent message: the output passes through and is a named failure downstream.
+  const failed = [JSON.stringify({ type: "thread.started", thread_id: "x" }), JSON.stringify({ type: "turn.failed", error: { message: "rate limited" } })].join("\n");
+  assert.equal(unwrapCodexJsonl(failed), failed);
+  assert.equal(parseExecutorJson(unwrapCodexJsonl(failed), reviewVerdictProblems).failure, "schema_mismatch");
+  assert.equal(unwrapCodexJsonl("plain text"), "plain text");
+  assert.equal(unwrapCodexJsonl(JSON.stringify(verdict)), JSON.stringify(verdict));
+});
+
+test("nothing run is a failed check: no test, or no guard, and an approval is not a pass", async () => {
+  // No test was run: an empty list is not a passing one.
+  const noTests = await runCrossReview(
+    control({
+      author: mockAuthor("claude", [change(0)]),
+      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
+      runTests: async () => [],
+    })
+  );
+  assert.notEqual(noTests.status, "passed");
+  assert.deepEqual(noTests.exchange.rounds[0].checkFailures, ["no test was run"]);
+  assert.match(noTests.exchange.rounds[0].nextAction, /no test was run/);
+  // No guard was run: a guards function that ran nothing is the same as none
+  // at all. What counts is a rule that ran and is on record.
+  for (const guards of [undefined, async () => []]) {
+    const noGuards = await runCrossReview(
+      control({
+        author: mockAuthor("claude", [change(0)]),
+        reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
+        guards,
+      })
+    );
+    assert.notEqual(noGuards.status, "passed");
+    assert.deepEqual(noGuards.exchange.rounds[0].checkFailures, ["no guard was run"]);
+    assert.deepEqual(noGuards.exchange.rounds[0].guardRuns, []);
+  }
+  // A guard that ran and failed is recorded as such, and the reviewer sees the run.
+  const failedGuard = await runCrossReview(
+    control({
+      author: mockAuthor("claude", [change(0)]),
+      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
+      guards: async () => [...guardPass(), ...guardFail("npm run check:x", "1 problem")],
+    })
+  );
+  assert.notEqual(failedGuard.status, "passed");
+  assert.deepEqual(failedGuard.exchange.rounds[0].checkFailures, ["guard failed: npm run check:x"]);
+  assert.deepEqual(failedGuard.exchange.rounds[0].guardViolations, ["npm run check:x: 1 problem"]);
+  assert.equal(failedGuard.exchange.rounds[0].guardRuns.length, 2);
+  // The author hears every reason in its feedback, not just failed tests.
+  const author = mockAuthor("claude", [change(0), change(1)]);
+  const fed = await runCrossReview(
+    control({ author, reviewer: mockReviewer("codex", [approveCurrent("T-1", 0), approveCurrent("T-1", 1)]), runTests: async () => [] })
+  );
+  assert.notEqual(fed.status, "passed");
+  assert.deepEqual(author.calls[1].feedback.checkFailures, ["no test was run"]);
+  // With one passing test and a guard consulted, the same approval passes.
+  const ok = await runCrossReview(
+    control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]) })
+  );
+  assert.equal(ok.status, "passed");
+  assert.deepEqual(ok.exchange.checkFailures, []);
+});
+
+test("the diff is read for the files it names: an unreported file is a failed check, an out-of-scope one is refused before review", async () => {
+  const twoFiles =
+    "diff --git a/lib/sum.ts b/lib/sum.ts\n--- a/lib/sum.ts\n+++ b/lib/sum.ts\n+1\n" +
+    "diff --git a/lib/other.ts b/lib/other.ts\n--- a/lib/other.ts\n+++ b/lib/other.ts\n+2\n";
+  assert.deepEqual(filesNamedByDiff(twoFiles), ["lib/sum.ts", "lib/other.ts"]);
+  assert.deepEqual(filesNamedByDiff("--- a/x.ts\n+++ b/x.ts\n+1\n--- a/gone.ts\n+++ /dev/null\n-1\n"), ["x.ts", "gone.ts"]);
+  assert.deepEqual(filesNamedByDiff(""), []);
+  // Reported one file, changed two: the second is a guard violation and the
+  // approval does not pass.
+  const underReported = await runCrossReview(
+    control({
+      author: mockAuthor("claude", [change(0, { diff: twoFiles, filesChanged: ["lib/sum.ts"] })]),
+      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
+    })
+  );
+  assert.notEqual(underReported.status, "passed");
+  assert.deepEqual(underReported.exchange.rounds[0].guardViolations, ["the diff names lib/other.ts, which filesChanged does not"]);
+  // Reported nothing outside the scope, but the diff touches app/: refused.
+  const outOfScope = await runCrossReview(
+    control({
+      author: mockAuthor("claude", [
+        change(0, { diff: "diff --git a/app/route.ts b/app/route.ts\n--- a/app/route.ts\n+++ b/app/route.ts\n+1\n", filesChanged: ["lib/sum.ts"] }),
+      ]),
+      reviewer: mockReviewer("codex", [approveCurrent("T-1", 0)]),
+    })
+  );
+  assert.equal(outOfScope.status, "failed");
+  assert.equal(outOfScope.failure, "scope_violation");
+  assert.deepEqual(outOfScope.exchange.rounds[0].guardViolations, ["outside writable scope: app/route.ts"]);
+});
+
+test("a person-driven exchange replays through the control program: waiting states are where a stand-in had nothing to say, and a concluded exchange takes no further round", async () => {
+  const packaged = (round, verdict = null, overrides = {}) => ({
+    round,
+    diff: change(round).value.diff,
+    summary: `round ${round}`,
+    filesChanged: ["lib/sum.ts"],
+    commit: null,
+    testResults: pass(),
+    guardRuns: guardPass(),
+    verdict,
+    ...overrides,
+  });
+  const verdictOn = (round, conclusion, findings = []) => ({
+    taskId: "T-1",
+    round,
+    reviewedDigest: digest(change(round).value.diff),
+    conclusion,
+    findings,
+    nextAction: "next",
+  });
+  const replay = (rounds) => replayExchange({ task, digest, rounds, now: () => new Date("2026-09-09T00:00:00Z") });
+
+  // A package with no verdict yet.
+  const waiting = await replay([packaged(0)]);
+  assert.equal(waiting.status, "awaiting_review");
+  assert.equal(waiting.failure, null);
+  assert.equal(waiting.concludedAtRound, null);
+  assert.equal(waiting.packagedRounds, 1);
+  assert.match(waiting.nextAction, new RegExp(digest(change(0).value.diff)));
+  assert.equal(waiting.rounds[0].nextAction, "awaiting the reviewer's verdict");
+
+  // A verdict with an actionable finding: the control program asked for a
+  // revision nobody has made.
+  const revising = await replay([packaged(0, verdictOn(0, "request_changes", [finding()]))]);
+  assert.equal(revising.status, "awaiting_revision");
+  assert.equal(revising.rounds.length, 1);
+  assert.equal(revising.findings[0].disposition, "fix_requested");
+  assert.match(revising.nextAction, /package round 1/);
+
+  // The revision, packaged and approved with passing checks: passed, and
+  // concluded at round 1.
+  const done = await replay([packaged(0, verdictOn(0, "request_changes", [finding()])), packaged(1, verdictOn(1, "approve"))]);
+  assert.equal(done.status, "passed");
+  assert.equal(done.concludedAtRound, 1);
+
+  // A package after the conclusion is not part of the exchange.
+  const extra = await replay([packaged(0, verdictOn(0, "approve"))]);
+  assert.equal(extra.status, "passed");
+  assert.equal(extra.concludedAtRound, 0);
+  const afterPass = await replay([packaged(0, verdictOn(0, "approve")), packaged(1)]);
+  assert.equal(afterPass.status, "passed");
+  assert.equal(afterPass.concludedAtRound, 0);
+  assert.equal(afterPass.rounds.length, 1);
+
+  // An approval with failing checks in the last allowed round: on hold, not awaiting.
+  const held = await replay([
+    packaged(0, verdictOn(0, "request_changes", [finding()])),
+    packaged(1, verdictOn(1, "request_changes", [finding()])),
+    packaged(2, verdictOn(2, "approve"), { testResults: fail() }),
+  ]);
+  assert.equal(held.status, "on_hold");
+  assert.equal(held.holdReason, "approved_but_checks_failed");
+  assert.equal(held.concludedAtRound, 2);
+
+  // A verdict on the wrong digest is the control program's own failure.
+  const wrong = await replay([packaged(0, { ...verdictOn(0, "approve"), reviewedDigest: "sha256:other" })]);
+  assert.equal(wrong.status, "failed");
+  assert.equal(wrong.failure, "digest_mismatch");
+  assert.equal(wrong.concludedAtRound, 0);
+
+  // Rounds must be contiguous from 0.
+  await assert.rejects(() => replay([packaged(1)]), /contiguous/);
+  await assert.rejects(() => replay([]), /nothing to replay/);
+});
+
+test("a reproducible finding named alongside an approval is never passed over: fixed with a revision left, on hold without one", async () => {
+  // Last allowed round (cap 0): approve, checks pass, one finding with a
+  // reproduction. Not a pass -- the reviewer named an error, and nothing can
+  // fix it now.
+  const approveWithFinding = (round) => ({
+    ok: true,
+    value: { taskId: "T-1", round, reviewedDigest: "@current", conclusion: "approve", findings: [finding()], nextAction: "merge anyway" },
+  });
+  const held = await runCrossReview(control({ author: mockAuthor("claude", [change(0)]), reviewer: mockReviewer("codex", [approveWithFinding(0)]), maxRevisions: 0 }));
+  assert.equal(held.status, "on_hold");
+  assert.equal(held.holdReason, "revisions_exhausted");
+  assert.deepEqual(held.exchange.findings.map((f) => f.disposition), ["unresolved_on_hold"]);
+  assert.match(held.exchange.rounds[0].nextAction, /open finding/);
+  // With a revision left the same approval sends the finding back, and the
+  // fix is reviewed on its own digest.
+  const author = mockAuthor("claude", [change(0), change(1)]);
+  const fixed = await runCrossReview(
+    control({ author, reviewer: mockReviewer("codex", [approveWithFinding(0), approveCurrent("T-1", 1)]), maxRevisions: 1 })
+  );
+  assert.equal(fixed.status, "passed");
+  assert.equal(author.calls.length, 2);
+  assert.deepEqual(author.calls[1].feedback.findings.map((f) => f.disposition), ["fix_requested"]);
+  // An approval with a preference-only finding in the last round still passes.
+  const preference = await runCrossReview(
+    control({
+      author: mockAuthor("claude", [change(0)]),
+      reviewer: mockReviewer("codex", [
+        { ok: true, value: { taskId: "T-1", round: 0, reviewedDigest: "@current", conclusion: "approve", findings: [finding({ basis: "preference", reproduction: undefined })], nextAction: "ok" } },
+      ]),
+      maxRevisions: 0,
+    })
+  );
+  assert.equal(preference.status, "passed");
+});
+
+test("the revision cap is fixed at two: a run may lower it and cannot raise it", async () => {
+  assert.equal(MAX_REVISIONS, 2);
+  assert.equal(DEFAULT_MAX_REVISIONS, MAX_REVISIONS);
+  assert.equal(resolveMaxRevisions(undefined), 2);
+  assert.equal(resolveMaxRevisions(0), 0);
+  assert.equal(resolveMaxRevisions(2), 2);
+  for (const bad of [3, 10, -1, 1.5, Number.NaN]) assert.throws(() => resolveMaxRevisions(bad), RangeError);
+  const requestChanges = (round) => ({
+    ok: true,
+    value: { taskId: "T-1", round, reviewedDigest: "@current", conclusion: "request_changes", findings: [finding()], nextAction: "fix" },
+  });
+  const author = mockAuthor("claude", [change(0), change(1), change(2), change(3)]);
+  await assert.rejects(
+    () => runCrossReview(control({ author, reviewer: mockReviewer("codex", [0, 1, 2, 3].map(requestChanges)), maxRevisions: 3 })),
+    RangeError
+  );
+  assert.equal(author.calls.length, 0, "nothing ran under a cap above the fixed one");
+  const capped = await runCrossReview(control({ author, reviewer: mockReviewer("codex", [0, 1, 2, 3].map(requestChanges)) }));
+  assert.equal(capped.status, "on_hold");
+  assert.equal(capped.holdReason, "revisions_exhausted");
+  assert.equal(author.calls.length, 3, "the first review and two fix rounds, and no more");
+  await assert.rejects(
+    () => replayExchange({ task, digest, maxRevisions: 3, rounds: [{ round: 0, diff: "d", summary: "s", filesChanged: ["lib/sum.ts"], commit: null, testResults: pass(), guardRuns: guardPass(), verdict: null }] }),
+    RangeError
+  );
+});
diff --git a/tests/routerFullCatalogDiagnostic.test.mjs b/tests/routerFullCatalogDiagnostic.test.mjs
new file mode 100644
index 00000000..b9793be2
--- /dev/null
+++ b/tests/routerFullCatalogDiagnostic.test.mjs
@@ -0,0 +1,292 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+
+import { decideRouterModel } from "../lib/routerDecision.ts";
+import {
+  diagnoseFullCatalog,
+  FALLBACK_UNDECIDED_OFFLINE,
+  fallbackReachabilityFor,
+  ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION,
+} from "../lib/routerFullCatalogDiagnostic.ts";
+import { decideFallback } from "../lib/routingFallbackPolicy.ts";
+import { CANDIDATE_REJECTIONS } from "../lib/routerCandidates.ts";
+import { NEUTRAL_QUALITY_BAND, ROUTER_TIE_BREAK_ORDER } from "../lib/routerScorePolicy.ts";
+import { resolveModelPricing } from "../lib/modelPricing.ts";
+import { toReservedInputTokens } from "../lib/chatTokenEstimate.ts";
+import { NO_WEB_SEARCH_BACKENDS } from "../lib/webSearchBackends.ts";
+
+/**
+ * The diagnostic is an explanation of the product's decision, not a second
+ * decision. What these tests hold is that it never disagrees with the product
+ * on the same input, that every model in the catalogue is accounted for with
+ * a fixed reason when refused, that an unmeasured model is reported as
+ * unmeasured rather than scored, and that the cap the Router routed under is
+ * reported beside the cap dispatch will apply rather than reconciled with it.
+ */
+
+const model = (id, overrides = {}) => ({
+  id,
+  name: id,
+  apiModel: id,
+  provider: "openai",
+  icon: "",
+  bestFor: "",
+  minimumPlan: "Guest",
+  usageClass: "standard",
+  enabled: true,
+  status: "available",
+  contextWindowTokens: 100_000,
+  maxOutputTokens: 4_000,
+  inputUsdPerMillionTokens: 1,
+  outputUsdPerMillionTokens: 1,
+  ...overrides,
+});
+
+const catalogue = () => [
+  model("cheap", { inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.1 }),
+  model("mid", { maxOutputTokens: 16_000 }),
+  model("dear", { inputUsdPerMillionTokens: 10, outputUsdPerMillionTokens: 10 }),
+  model("off", { enabled: false, status: "disabled" }),
+  model("paid", { minimumPlan: "Pro" }),
+  model("nowindow", { contextWindowTokens: undefined }),
+];
+
+const items = () => [
+  { id: "i-1", cell: "en", stratum: "general_question_answering", prompt: "What is a mortgage?" },
+  { id: "i-2", cell: "en", stratum: "coding", prompt: "Fix this TypeScript function:\n```ts\nconst f = () => {}\n```" },
+];
+
+const base = (overrides = {}) => ({
+  items: items(),
+  models: catalogue(),
+  plan: "Free",
+  requestedModelId: "mid",
+  searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
+  now: () => 0,
+  ...overrides,
+});
+
+test("every catalogue model appears on every item, and a refused one carries a declared reason", () => {
+  const report = diagnoseFullCatalog(base());
+  assert.equal(report.version, ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION);
+  assert.equal(report.items.length, 2);
+  for (const item of report.items) {
+    assert.deepEqual(
+      item.models.map((row) => row.modelId),
+      catalogue().map((entry) => entry.id),
+      "catalogue order, nothing missing"
+    );
+    for (const row of item.models) {
+      if (row.disposition === "rejected") {
+        assert.ok(CANDIDATE_REJECTIONS.includes(row.rejectionReason), `${row.modelId}: ${row.rejectionReason}`);
+        assert.equal(row.rank, null);
+      } else {
+        assert.equal(row.rejectionReason, null);
+        assert.ok(row.rank >= 1);
+      }
+    }
+    const byId = Object.fromEntries(item.models.map((row) => [row.modelId, row]));
+    assert.equal(byId.off.rejectionReason, "disabled");
+    assert.equal(byId.paid.rejectionReason, "plan");
+    assert.equal(byId.nowindow.rejectionReason, "context_window_undeclared");
+  }
+  assert.deepEqual(
+    report.summary.neverEligible.map((entry) => entry.modelId).sort(),
+    ["nowindow", "off", "paid"]
+  );
+});
+
+test("the diagnostic agrees with the product's own decision on the same input", () => {
+  const report = diagnoseFullCatalog(base());
+  const cap = resolveModelPricing(catalogue()[1]).maxOutputTokens;
+  for (const [index, item] of report.items.entries()) {
+    const source = items()[index];
+    const product = decideRouterModel(
+      {
+        text: source.prompt,
+        attachments: [],
+        webSearchRequested: false,
+        models: catalogue(),
+        plan: "Free",
+        searchBackendReadiness: NO_WEB_SEARCH_BACKENDS,
+        reservedInputTokens: item.caps.routerReservedInputTokens,
+        requestOutputCapTokens: cap,
+        sticky: null,
+      },
+      () => 0
+    );
+    assert.equal(product.outcome, "selected");
+    assert.equal(item.decision.primaryModelId, product.modelId);
+    assert.deepEqual(item.decision.rankedModelIds, [product.modelId, ...product.fallbackCandidateModelIds]);
+    assert.deepEqual(item.decision.fallbackCandidateModelIds, product.fallbackCandidateModelIds);
+    assert.deepEqual(
+      item.models.filter((row) => row.rejectionReason !== null).map((row) => ({ modelId: row.modelId, reason: row.rejectionReason })),
+      product.record.rejections
+    );
+    assert.equal(item.decision.decidedBy, product.record.selectionDecidedBy);
+    assert.equal(item.consistency.agreesWithProduct, true, item.consistency.problems.join("; "));
+    assert.equal(item.caps.primary.routerOutputTokens, product.outputTokens);
+  }
+  assert.equal(report.summary.consistencyProblems, 0);
+  assert.deepEqual(report.problems, []);
+});
+
+test("the cost tie-break picks the cheapest, and every loser says which criterion it lost on", () => {
+  const report = diagnoseFullCatalog(base());
+  const item = report.items[0];
+  assert.equal(item.decision.primaryModelId, "cheap");
+  assert.equal(item.decision.decidedBy, "expected_total_cost");
+  assert.equal(item.decision.selectionReason, "fallback_order");
+  for (const row of item.models) {
+    if (row.disposition !== "fallback_candidate") continue;
+    assert.ok(ROUTER_TIE_BREAK_ORDER.includes(row.versusPrimary.decidedBy));
+    assert.equal(row.versusPrimary.wouldBeatPrimary, false);
+    assert.ok(row.expectedTotalCostUsd > item.models.find((m) => m.modelId === "cheap").expectedTotalCostUsd);
+  }
+  assert.equal(report.summary.pairwiseInversions, 0);
+});
+
+test("an unmeasured model is reported at the neutral band with no evidence, never at zero and never promoted", () => {
+  const report = diagnoseFullCatalog(base());
+  for (const item of report.items) {
+    for (const row of item.models) {
+      assert.equal(row.quality.band, NEUTRAL_QUALITY_BAND);
+      assert.equal(row.quality.evidenceRef, null);
+      assert.equal(row.quality.status, "no_evidence");
+    }
+    assert.deepEqual(item.evidence.eligibleWithEvidence, []);
+    assert.equal(item.evidence.decidedWithoutQualityEvidence, true);
+  }
+  assert.equal(report.summary.evidenceCells.withEvidence, 0);
+  assert.ok(report.improvementCandidates.some((c) => c.kind === "no_quality_evidence_for_kind"));
+  // Nothing here writes a band: the policy module is read, not edited.
+  assert.ok(!report.improvementCandidates.some((c) => c.detail.includes("promote")));
+});
+
+test("the Router's output cap and dispatch's are both reported, and a difference is named rather than hidden", () => {
+  // Routed under `mid`'s cap of 16,000; the primary `cheap` dispatches under
+  // its own 4,000. The Router fitted every candidate to 16,000 output tokens
+  // and dispatch will hand `cheap` 4,000.
+  const report = diagnoseFullCatalog(base());
+  const item = report.items[0];
+  assert.equal(report.inputs.routerRequestOutputCapTokens, 16_000);
+  assert.equal(item.caps.primary.modelId, "cheap");
+  assert.equal(item.caps.primary.routerOutputTokens, 16_000);
+  assert.equal(item.caps.primary.dispatchRequestOutputCapTokens, 4_000);
+  assert.equal(item.caps.primary.dispatchOutputTokens, 4_000);
+  assert.equal(item.caps.primary.outputCapDiffers, true);
+  assert.equal(report.summary.outputCapMismatchItems, 2);
+  assert.ok(report.improvementCandidates.some((c) => c.kind === "output_cap_mismatch"));
+
+  // Routed under the primary's own cap, the two agree and nothing is flagged.
+  const aligned = diagnoseFullCatalog(base({ requestedModelId: "cheap" }));
+  assert.equal(aligned.items[0].caps.primary.outputCapDiffers, false);
+  assert.equal(aligned.summary.outputCapMismatchItems, 0);
+});
+
+test("fallback is reachable only when the gate, the product's own decision and dispatch all say yes; as deployed the gate says no", () => {
+  const report = diagnoseFullCatalog(base());
+  const item = report.items[0];
+  assert.deepEqual(item.fallback.scopeAsDeployed, { allowed: false, reason: "flag_off" });
+  assert.deepEqual(item.fallback.scopeIfFlagOn, { allowed: true });
+  assert.equal(item.fallback.maxModelFallbacks, 1);
+  const first = item.decision.fallbackCandidateModelIds[0];
+  assert.ok(first, "the catalogue leaves a candidate behind the primary");
+  // decideFallback -- the product's function, asked under the stated
+  // hypothesis -- names the Router's next candidate, and is recorded as it
+  // answered, version included.
+  const policyVersion = decideFallback({
+    attempt: { modelId: "x", outcome: "failed_pre_token", failureLayer: "provider", providerRefusal: null },
+    run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: false },
+    nextCandidateModelIds: [],
+  }).version;
+  assert.deepEqual(item.fallback.decision, { version: policyVersion, action: "fallback", modelId: first, reason: null });
+  // The candidate is listed as what it is: named by the decision, re-fitted
+  // by dispatch. That is not the same as reachable.
+  assert.equal(item.fallback.firstCandidate.modelId, first);
+  assert.equal(item.fallback.firstCandidate.dispatchFit, "fitted");
+  assert.deepEqual(item.fallback.reachableAsDeployed, { reachable: false, refusal: "gate:flag_off" });
+  assert.equal(item.fallback.reachableIfFlagOn.reachable, true);
+  assert.equal(item.fallback.reachableIfFlagOn.modelId, first);
+  // A reachable answer carries what only a real dispatch could still refuse.
+  assert.deepEqual(item.fallback.reachableIfFlagOn.undecidedOffline, FALLBACK_UNDECIDED_OFFLINE);
+  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("search_path_unavailable")));
+  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("budget_refused")));
+  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("candidate_unavailable")));
+  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("no_provider_hold")));
+  assert.ok(item.fallback.notModelled.length > FALLBACK_UNDECIDED_OFFLINE.length);
+  assert.equal(report.inputs.fallbackFlagAsDeployed, "off");
+  assert.equal(report.summary.fallbackReachableAsDeployed["gate:flag_off"], 2);
+  assert.equal(report.summary.fallbackReachableIfFlagOn.reachable, 2);
+
+  const on = diagnoseFullCatalog(base({ fallbackEnvironment: { AUTO_ROUTER_FALLBACK_ENABLED: "on" } }));
+  assert.deepEqual(on.items[0].fallback.scopeAsDeployed, { allowed: true });
+  assert.equal(on.items[0].fallback.reachableAsDeployed.reachable, true);
+  assert.equal(on.inputs.fallbackFlagAsDeployed, "on");
+
+  // With nothing ranked behind the primary the decision itself terminates,
+  // and that is what is reported: no candidate is invented.
+  const lone = diagnoseFullCatalog(base({ models: [model("cheap")], requestedModelId: "cheap", fallbackEnvironment: { AUTO_ROUTER_FALLBACK_ENABLED: "on" } }));
+  assert.equal(lone.items[0].decision.primaryModelId, "cheap");
+  assert.deepEqual(lone.items[0].fallback.decision, { version: policyVersion, action: "terminate", modelId: null, reason: "no_candidate" });
+  assert.equal(lone.items[0].fallback.firstCandidate, null);
+  // The gate is asked first and refuses on the same fact, so the refusal
+  // names the gate; the decision's own answer is still on record above.
+  assert.deepEqual(lone.items[0].fallback.reachableAsDeployed, { reachable: false, refusal: "gate:no_candidate" });
+
+  // The three steps, each answered by the product's order: the gate, then the
+  // decision naming a candidate, then dispatch fitting it. A candidate that
+  // dispatch cannot fit (planAttemptExecution's context_window_exceeded) is
+  // named by the Router and refused at the attempt, and no other is tried.
+  //
+  // Under the active estimator calibration the diagnostic's dispatch
+  // reservation equals the Router's raw estimate (`toReservedInputTokens` of
+  // a bare number is identity), so the Router refuses such a model before it
+  // is ever a candidate; the product reaches the case through attachment and
+  // tool overhead, which the diagnostic lists as not modelled. The branch is
+  // held here on the helper itself.
+  const prompt = items()[0].prompt;
+  const routerReserved = Math.max(1, Math.ceil(Buffer.byteLength(prompt, "utf8") / 4));
+  assert.equal(toReservedInputTokens(routerReserved), routerReserved);
+  const named = { version: "v", action: "fallback", modelId: "mid", reason: null };
+  const terminated = { version: "v", action: "terminate", modelId: null, reason: "visible_token_emitted" };
+  const fitted = { modelId: "mid", dispatchFit: "fitted", dispatchOutputTokens: 4_000 };
+  const exceeded = { modelId: "mid", dispatchFit: "exceeded", dispatchOutputTokens: null };
+  assert.deepEqual(fallbackReachabilityFor({ allowed: false, reason: "flag_off" }, named, fitted), { reachable: false, refusal: "gate:flag_off" });
+  assert.deepEqual(fallbackReachabilityFor({ allowed: false, reason: "tools_offered" }, named, exceeded), { reachable: false, refusal: "gate:tools_offered" });
+  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, terminated, fitted), { reachable: false, refusal: "decision:visible_token_emitted" });
+  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, null), { reachable: false, refusal: "decision:mid is not the candidate dispatch was asked to fit" });
+  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, exceeded), { reachable: false, refusal: "candidate_context_window_exceeded" });
+  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, fitted), { reachable: true, ...fitted, undecidedOffline: FALLBACK_UNDECIDED_OFFLINE });
+  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, { ...fitted, dispatchFit: "unbounded" }), {
+    reachable: true,
+    ...fitted,
+    dispatchFit: "unbounded",
+    undecidedOffline: FALLBACK_UNDECIDED_OFFLINE,
+  });
+});
+
+test("improvement candidates name the reachability gap and the never-chosen models with fixed identifiers", () => {
+  const report = diagnoseFullCatalog(base());
+  const kinds = report.improvementCandidates.map((c) => c.kind);
+  assert.ok(kinds.includes("context_window_undeclared"));
+  assert.deepEqual(
+    report.improvementCandidates.find((c) => c.kind === "context_window_undeclared").modelIds,
+    ["nowindow"]
+  );
+  assert.ok(kinds.includes("eligible_never_primary"));
+  assert.deepEqual(report.summary.eligibleNeverPrimary, ["dear", "mid"]);
+  assert.ok(kinds.includes("decided_by_tie_break"));
+  // `paid` is never eligible on the Free plan, and is neither undeclared nor disabled.
+  assert.deepEqual(report.improvementCandidates.find((c) => c.kind === "never_eligible").modelIds, ["paid"]);
+});
+
+test("a requested model outside the catalogue is refused rather than routed under an invented cap", () => {
+  assert.throws(() => diagnoseFullCatalog(base({ requestedModelId: "ghost" })), /not in the catalogue/);
+});
+
+test("the report carries nothing derived from a prompt", () => {
+  const secret = "PROMPT-TEXT-THAT-MUST-NOT-LEAK";
+  const report = diagnoseFullCatalog(base({ items: [{ id: "i-1", prompt: `Explain ${secret} please` }] }));
+  assert.ok(!JSON.stringify(report).includes(secret));
+});

```

## Test results (run by the control program)

- FAIL `set -o pipefail; node --import tsx --test tests/routerFullCatalogDiagnostic.test.mjs tests/crossReview.test.mjs tests/routerDecision.test.mjs tests/routerCandidates.test.mjs tests/routerSelection.test.mjs tests/routerScorePolicy.test.mjs tests/autoFallbackGate.test.mjs tests/automaticFallbackBoundary.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'` (613ms)
  # tests 117
  # pass 116
  # fail 1

## Guard results (run by the control program)

- PASS `npm run check:doc-references` (6229ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 751 referenced path(s) across 92 instruction document(s), and 868 path(s) named by comments across 2592 source file(s), all present.
- PASS `npm run check:release-gate-coverage` (594ms)
  > ai-chat-hub@0.1.0 check:release-gate-coverage
  > node scripts/check-release-gate-coverage.mjs
  
  Release gate coverage check passed: 51 CI-enforced and 3 manually gated check(s), all named in the release checklist.
- PASS `npm run security:regression` (659ms)
  > ai-chat-hub@0.1.0 security:regression
  > node scripts/security-regression-check.mjs
  
  Security regression checks passed (188 checks).

## Findings from the previous round (check each was addressed)

- [error/evidence] lib/crossReviewCore.ts:runCrossReview approve branch: 마지막 허용 round에서 재현 가능한 finding은 unresolved_on_hold로 분류되지만 pass 조건은 fix_requested만 검사하므로, 해결되지 않은 finding을 기록한 채 status가 passed가 됩니다.
- [error/evidence] lib/crossReviewCore.ts:runCrossReview loop bound; scripts/cross-review.mjs:max-revisions: 요구사항의 최대 2회 fix round가 상한이 아니라 임의로 높일 수 있는 옵션으로 구현되어 revision cap을 우회할 수 있습니다.
- [error/evidence] lib/crossReviewCore.ts:runCrossReview guardsConsulted; scripts/cross-review.mjs:mock/package guard setup: guard 실행 여부를 실제 guard 수나 실행 기록이 아니라 함수 존재 여부로 판정하므로, guard가 하나도 실행되지 않은 정상 CLI 경로도 검사를 통과합니다.
- [error/evidence] scripts/cross-review.mjs:live-mode guards; lib/crossReviewCore.ts:changeDigest: live 모드는 실제 working-tree diff의 내용과 author가 반환한 diff를 비교하지 않고 파일명만 비교하므로, reviewer가 읽지 않은 실제 변경을 다른 digest로 승인할 수 있습니다.
- [error/evidence] scripts/cross-review.mjs:package/review diffExcluded handling: --diff-exclude가 생성물로 제한되지 않아 임의의 scoped 소스 변경을 diff와 digest에서 제외할 수 있고, review 단계도 같은 제외를 적용하므로 새 변경에 새 review가 필요하다는 규칙을 우회합니다.
- [error/evidence] lib/routerFullCatalogDiagnostic.ts:dispatchFitFor and fallback construction: executableAsDeployed와 executableIfFlagOn은 실제 decideFallback 및 planAttemptExecution을 호출하지 않고 첫 후보와 context-window fit만 재구현하므로, search_path_unavailable, budget_refused, candidate_unavailable 또는 no_provider_hold인 fallback도 executable: true로 보고될 수 있습니다.
- [error/evidence] control-program test and guard results: 제출된 필수 검증은 115개 중 2개가 실패했고 security:regression guard도 실패했으므로, 기존 Router 테스트 통과와 tests-and-guards 통과 완료 조건이 충족되지 않았습니다.

## Author's account (read last; a claim, not a finding)

Summary: Round 2 (the last revision allowed) answers the seven round-1 findings; commit after 4b21ad92 on top of the earlier rounds. (1) An actionable finding is never passed over: fix_requested or unresolved_on_hold blocks a pass, so an approval carrying a reproducible finding in the last round goes on hold (revisions_exhausted) instead of passed. (2) The cap is fixed: MAX_REVISIONS is 2, resolveMaxRevisions refuses anything above it, --max-revisions may only lower it, and replayExchange is bound the same way. (3) A guard is a rule that ran: guards return GuardRun records, a pass needs at least one run and every run passing, an empty list is the failed check no guard was run, the reviewer prompt lists guard results beside test results, and --guard-command runs are those records. (4) In live mode the diff of record is the working tree diff against the base over the whole tree (treeBackedAuthor); the diff the author returned is kept only as its claim next to its self-assessment, and one guard rule always checks the tree holds nothing the diff cannot show. (5) --diff-exclude accepts only the task generatedPaths (now declared: the two generated report files) and the package directory; an excluded file still counts as changed, its content digest is recorded in the package (excludedDigests) and a review refuses to run if it changed since packaging. (6) The fallback decision is the product decideFallback, called under the one failure hypothesis the fallback path exists for (FALLBACK_FAILURE_HYPOTHESIS) and recorded as it answered with its version; the answer is reachable rather than executable and every reachable answer carries the refusals only a real dispatch can raise (search_path_unavailable, budget_refused, candidate_unavailable, no_provider_hold) as undecidedOffline. planAttemptExecution is not called because it builds the provider client and the credit budget, which an offline report has no account, credentials or reservation for; the report and README say so and the committed report is regenerated (with the flag on: 165 reachable, 45 refused by the gate for web search). (7) Checks on this checkout: the worktree is now checked out with LF like CI, under which the security:regression guard and the routerScorePolicy import walk pass; the automaticFallbackBoundary import walk still fails here on path separators, is outside the writable scope and passes on Linux; the package records what ran.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "router-full-catalog-diagnostic-v1",
  "round": 2,
  "reviewedDigest": "sha256:6500e0e274e884de9ea1d720c7488387bea96e6764ce088016dd0946cb01073a",
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
