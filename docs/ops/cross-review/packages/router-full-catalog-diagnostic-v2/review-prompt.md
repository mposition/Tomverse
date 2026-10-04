# Independent review — task router-full-catalog-diagnostic-v2, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Continue router-full-catalog-diagnostic-v1, which concluded on hold after its two fix rounds with four findings open, by finishing the foundation so the same reasons do not block the next exchange. (1) Package exclusions: a --diff-exclude path is accepted only when it is exactly one of the task's declared generated paths or the package's own output directory; a parent of the package directory, or any scoped source, is refused, and a regression test holds that a change hidden that way is refused. (2) The Claude Code reviewer invocation loads no user, project or local customisation -- hooks above all -- while keeping the stored login: --safe-mode, not --bare, pinned by test. (3) The Windows failure of tests/automaticFallbackBoundary.test.mjs is fixed by path-separator normalisation only, with its allowlist and assertions unchanged, so the required test set passes on Windows and Linux alike. (4) Before any paid review, a preflight runs the reviewer's own invocation on a prompt that is not a review: it must read something the control program knows to be true (the HEAD commit) and must fail to write a probe file; the call, its command, its usage and its result are recorded, and a review refuses to start on a failing preflight or on a package whose tests or guards failed unless a person overrides explicitly on the command line. An environment failure is recorded as such, apart from the change's own findings. (5) The fallback part of the diagnostic separates three things by name: the offline diagnosis (which candidate is reachable on the given inputs, and each refusal's reason, with the product's own gate and decideFallback), the conditions an offline report cannot verify (credits and budget, the runtime registry row, the provider reservation, the request's search path), and the pre-dispatch check that decides on a real request; a reachable candidate is labelled execution-unverified and never executable. (6) This task names the exchange it continues; round 0's reviewer is shown that exchange's four open findings; and a chain of continuations is capped so that starting a new task is not a way to reset the revision cap. No production routing behaviour, score, flag or pre-registration changes; no model calls except the approved preflight and reviews; no push; no workflow dispatch.

## Completion criteria

- packageExclusionProblems refuses a parent of the package directory and any path not declared in generatedPaths, and tests/crossReview.test.mjs holds it; a review refuses to run when an excluded generated file changed since packaging.
- CLI_INVOCATIONS.claude.reviewer carries --safe-mode and not --bare, with --tools Read,Grep,Glob, --allowedTools and --strict-mcp-config, pinned by tests/crossReview.test.mjs.
- tests/automaticFallbackBoundary.test.mjs passes on this Windows checkout with its ALLOWED map and assertions unchanged; the required eight-file test set reports 0 failures.
- scripts/cross-review.mjs --mode=preflight records a preflight (command, cwd, sandbox signature, usage, result) and --mode=review refuses without a passing preflight for the same sandbox signature or with failing package checks, unless --skip-preflight or --review-despite-check-failures is given.
- The diagnostic's fallback block carries decision, firstCandidate, reachableAsDeployed and reachableIfFlagOn with execution: "unverified" and unverifiedConditions on every reachable answer, and the word executable appears nowhere in it (tests/routerFullCatalogDiagnostic.test.mjs).
- This task's package records lineage [router-full-catalog-diagnostic-v1] and the four inherited findings; supersessionProblems refuses to continue an exchange that is not on hold or failed, and refuses a chain deeper than MAX_SUPERSESSIONS (tests/crossReview.test.mjs).
- Existing router tests pass unchanged and no file under app/ or lib/router{Candidates,Selection,ScorePolicy,Decision}.ts is modified.

## Change under review — digest sha256:e8f9d8359e4b367bdfe3ccaf6079eab454b6208e565727221ad873bf411ff9c8, commit 152eff4a9d457f79928ab125a3d329a0b88f6b75

```diff
diff --git a/docs/ops/cross-review/README.md b/docs/ops/cross-review/README.md
index f455c9b8..45529362 100644
--- a/docs/ops/cross-review/README.md
+++ b/docs/ops/cross-review/README.md
@@ -49,7 +49,8 @@ same loop runs against scripted mocks and against command-line tools.
 ```
 npm run cross-review -- --task=<task.json> --mode=mock --fixture=<fixture.json> --out=<dir>
 npm run cross-review -- --task=<task.json> --mode=dry-run --out=<dir>
-npm run cross-review -- --task=<task.json> --mode=package --test-command="..." --diff-exclude=<generated> --out=<dir>
+npm run cross-review -- --task=<task.json> --mode=package --test-command="..." --guard-command="..." --diff-exclude=<generated> --out=<dir>
+npm run cross-review -- --task=<task.json> --mode=preflight --out=<dir> [--i-have-authorised-live-execution]
 npm run cross-review -- --task=<task.json> --mode=review --out=<dir> [--i-have-authorised-live-execution]
 ```
 
@@ -74,10 +75,65 @@ author ran -- what the author returned is kept only as its claim -- and one
 guard rule always checks that the tree holds nothing that diff cannot show.
 
 What a package may leave out of the reviewed diff is fixed before the
-exchange: `--diff-exclude` accepts only the task's `generatedPaths` and the
-package's own `--out` directory. An excluded file still counts as changed,
-its content digest is recorded in the package, and a review refuses to run
-if it has changed since.
+exchange, and the allow list is exact: `--diff-exclude` accepts only a path
+that, resolved to one spelling, *is* one of the task's `generatedPaths` or
+*is* the package's own `--out` directory -- and never a path that is, or
+contains, an entry of the writable scope, whatever else it is named as. So
+a scoped source, `.`, a parent of the package directory, a file under it,
+a path above the repository, and `--out=.` are all refused by name
+(`packageExclusionProblems`). Every path is normalised once -- forward
+slashes, no trailing slash, `.` and `..` segments resolved -- before it is
+checked, digested or handed to git, so neither a Windows spelling nor a
+`..` written under an allowed directory can pass one check and mean
+another path to git: `<out>/../../README.md` is checked as the
+`README.md` it resolves to, and refused. An excluded generated file still
+counts as changed; what it is at packaging -- its content digest, or
+`absent` -- is recorded in the package, and a review refuses to run if it
+has changed, appeared or disappeared since.
+
+### Before a review is paid for
+
+`--mode=preflight` runs the reviewer's own invocation -- same command, same
+overrides, same sandbox -- on a prompt that is not a review: read the HEAD
+commit, then try to write a probe file under `--out` with one shell
+command that names the probe's path. It passes only when the read produced
+the commit this script knows, the probe did not land, the tool's own
+output shows a write *at the probe path* being refused (a command naming
+the path whose output says it was denied, a failed file change there, a
+permission denial naming it -- `writeRefusalEvidence`, and the evidence is
+written into the record), and the reviewer does not report the write as
+done. A refusal that names no path -- Codex's own "patch rejected" line --
+or a denial of some other file shows that something was refused, not that
+the probe was, and does not count; nor does what the reviewer *says*,
+which is recorded and is not evidence by itself. The record
+(`preflight-<stamp>.json`, version `cross-review-preflight-v2`: command,
+working directory, sandbox signature, tool version, usage -- read from
+Codex's `turn.completed` event or Claude Code's JSON envelope -- evidence
+and result) is an environment result, kept apart from any finding about
+the change. The Claude Code reviewer is pinned to have no shell and no
+write tool, so a preflight of it cannot show a refused write; a review
+with it needs `--skip-preflight`, recorded as such.
+
+`--mode=review` then refuses to start on a package whose tests or guards
+failed, and unless the *newest* preflight for the same sandbox signature
+(the command line with the model choice taken out, the directory, and the
+shell choice) is a pass under the current rule (`preflightGate`): none at
+all, a newer failure, or a pass judged under an older record version each
+refuse, and an older pass is never picked past a newer failure -- the
+answer is to run the preflight again. Either refusal can be overridden on
+the command line (`--review-despite-check-failures`, `--skip-preflight`);
+an override is a person's decision and is written into the verdict record
+with the reason it overrode.
+
+### Continuing a concluded exchange
+
+A task may name the exchange it continues (`supersedes: { taskId,
+exchange }`). Round 0's package then records the lineage and the findings
+the prior exchange left open, and the reviewer of round 0 is shown them as
+the previous findings. Only an exchange on hold or failed can be continued
+-- never one that passed or is still open -- and the chain is capped at
+`MAX_SUPERSESSIONS` (2), so starting a new task is not a way to reset the
+revision cap. Beyond the cap a person decides.
 
 The person-driven loop is `package` → `review` → (fix) → `package --round=1`
 → `review` …, and `exchange.json` carries `awaiting_review` or
@@ -118,10 +174,21 @@ the config layers). What the check changed:
 - `--codex-auth=login` (the default) drops `OPENAI_API_KEY` and
   `CODEX_API_KEY` from the child environment so the run uses the stored
   login; `env` keeps them.
-- The Claude Code reviewer runs `claude --print --output-format json --tools
-  Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`: only the
-  read tools are built in, nothing prompts, and no MCP server is loaded. It
-  has not been run.
+- `--codex-shell=windows-powershell` drops the app-execution-alias directory
+  (`…\Microsoft\WindowsApps`) from the child's PATH. The Windows sandbox
+  starts its shell under a restricted token, and the Store-installed
+  PowerShell 7 lives under WindowsApps, whose ACLs deny such a token
+  (`CreateProcessAsUserW failed: 5`); with the alias out of the way codex
+  falls back to Windows PowerShell in System32. The choice is part of the
+  sandbox signature and is recorded in the preflight and the verdict.
+- The Claude Code reviewer runs `claude --print --safe-mode --output-format
+  json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
+  --strict-mcp-config`: the user's, project's and local customisations --
+  hooks above all, which run with the user's full permissions -- do not
+  load, only the read tools are built in, nothing prompts, and no MCP server
+  is loaded. `--safe-mode` keeps the stored login; `--bare` would drop it,
+  so it is not the flag used. Managed policy hooks still apply, as the
+  documentation says. It has not been run.
 
 Neither author invocation has been run. The check is due again whenever
 either tool is upgraded.
diff --git a/docs/ops/cross-review/packages/router-full-catalog-diagnostic-v2.task.json b/docs/ops/cross-review/packages/router-full-catalog-diagnostic-v2.task.json
new file mode 100644
index 00000000..5cbd6ebc
--- /dev/null
+++ b/docs/ops/cross-review/packages/router-full-catalog-diagnostic-v2.task.json
@@ -0,0 +1,35 @@
+{
+  "taskId": "router-full-catalog-diagnostic-v2",
+  "requirement": "Continue router-full-catalog-diagnostic-v1, which concluded on hold after its two fix rounds with four findings open, by finishing the foundation so the same reasons do not block the next exchange. (1) Package exclusions: a --diff-exclude path is accepted only when it is exactly one of the task's declared generated paths or the package's own output directory; a parent of the package directory, or any scoped source, is refused, and a regression test holds that a change hidden that way is refused. (2) The Claude Code reviewer invocation loads no user, project or local customisation -- hooks above all -- while keeping the stored login: --safe-mode, not --bare, pinned by test. (3) The Windows failure of tests/automaticFallbackBoundary.test.mjs is fixed by path-separator normalisation only, with its allowlist and assertions unchanged, so the required test set passes on Windows and Linux alike. (4) Before any paid review, a preflight runs the reviewer's own invocation on a prompt that is not a review: it must read something the control program knows to be true (the HEAD commit) and must fail to write a probe file; the call, its command, its usage and its result are recorded, and a review refuses to start on a failing preflight or on a package whose tests or guards failed unless a person overrides explicitly on the command line. An environment failure is recorded as such, apart from the change's own findings. (5) The fallback part of the diagnostic separates three things by name: the offline diagnosis (which candidate is reachable on the given inputs, and each refusal's reason, with the product's own gate and decideFallback), the conditions an offline report cannot verify (credits and budget, the runtime registry row, the provider reservation, the request's search path), and the pre-dispatch check that decides on a real request; a reachable candidate is labelled execution-unverified and never executable. (6) This task names the exchange it continues; round 0's reviewer is shown that exchange's four open findings; and a chain of continuations is capped so that starting a new task is not a way to reset the revision cap. No production routing behaviour, score, flag or pre-registration changes; no model calls except the approved preflight and reviews; no push; no workflow dispatch.",
+  "completionCriteria": [
+    "packageExclusionProblems refuses a parent of the package directory and any path not declared in generatedPaths, and tests/crossReview.test.mjs holds it; a review refuses to run when an excluded generated file changed since packaging.",
+    "CLI_INVOCATIONS.claude.reviewer carries --safe-mode and not --bare, with --tools Read,Grep,Glob, --allowedTools and --strict-mcp-config, pinned by tests/crossReview.test.mjs.",
+    "tests/automaticFallbackBoundary.test.mjs passes on this Windows checkout with its ALLOWED map and assertions unchanged; the required eight-file test set reports 0 failures.",
+    "scripts/cross-review.mjs --mode=preflight records a preflight (command, cwd, sandbox signature, usage, result) and --mode=review refuses without a passing preflight for the same sandbox signature or with failing package checks, unless --skip-preflight or --review-despite-check-failures is given.",
+    "The diagnostic's fallback block carries decision, firstCandidate, reachableAsDeployed and reachableIfFlagOn with execution: \"unverified\" and unverifiedConditions on every reachable answer, and the word executable appears nowhere in it (tests/routerFullCatalogDiagnostic.test.mjs).",
+    "This task's package records lineage [router-full-catalog-diagnostic-v1] and the four inherited findings; supersessionProblems refuses to continue an exchange that is not on hold or failed, and refuses a chain deeper than MAX_SUPERSESSIONS (tests/crossReview.test.mjs).",
+    "Existing router tests pass unchanged and no file under app/ or lib/router{Candidates,Selection,ScorePolicy,Decision}.ts is modified."
+  ],
+  "baseCommit": "787a37c8",
+  "writableScope": [
+    "lib/routerFullCatalogDiagnostic.ts",
+    "lib/crossReviewCore.ts",
+    "lib/crossReviewExecutors.ts",
+    "scripts/report-router-full-catalog.mjs",
+    "scripts/cross-review.mjs",
+    "tests/routerFullCatalogDiagnostic.test.mjs",
+    "tests/crossReview.test.mjs",
+    "tests/automaticFallbackBoundary.test.mjs",
+    "docs/ops/router-full-catalog-diagnostic/",
+    "docs/ops/cross-review/",
+    "package.json"
+  ],
+  "generatedPaths": [
+    "docs/ops/router-full-catalog-diagnostic/development-v0.md",
+    "docs/ops/router-full-catalog-diagnostic/development-v0.summary.json"
+  ],
+  "supersedes": {
+    "taskId": "router-full-catalog-diagnostic-v1",
+    "exchange": "docs/ops/cross-review/packages/router-full-catalog-diagnostic/exchange.json"
+  }
+}
diff --git a/docs/ops/router-full-catalog-diagnostic/README.md b/docs/ops/router-full-catalog-diagnostic/README.md
index d2e61f36..ca518055 100644
--- a/docs/ops/router-full-catalog-diagnostic/README.md
+++ b/docs/ops/router-full-catalog-diagnostic/README.md
@@ -45,14 +45,26 @@ it; `fallback.reachableAsDeployed` and `fallback.reachableIfFlagOn` are the
 three-step answer, each refusal naming the step that said no
 (`gate:<reason>`, `decision:<reason>`, `candidate_context_window_exceeded`).
 
-`planAttemptExecution` is not called: it builds the provider client and the
-credit budget for a real dispatch, which an offline report has no account,
-credentials or reservation for. Its refusals that depend on those, and the
-two runtime checks the route makes around it, are carried on every
-reachable answer as `undecidedOffline` (`search_path_unavailable`,
-`budget_refused`, `candidate_unavailable`, `no_provider_hold`), so
-`reachable: true` reads as "nothing decidable offline refused it" and not
-as a promise. `fallback.notModelled` repeats the hypothesis and that list.
+Three things are kept apart by name, because an offline report can answer
+only the first:
+
+- **the offline diagnosis** -- `reachableAsDeployed` / `reachableIfFlagOn`:
+  which candidate is reachable on the given inputs, with the product's own
+  gate and decision, and each refusal's reason;
+- **the conditions this report cannot verify** -- `unverifiedConditions` on
+  every reachable answer: the account's credits and the provider budget
+  (`budget_refused`), the runtime registry row (`candidate_unavailable`),
+  the primary's provider reservation (`no_provider_hold`), and the request's
+  search path (`search_path_unavailable`);
+- **the pre-dispatch check** -- what decides on a real request, in
+  `planAttemptExecution` and the route around it, against exactly those
+  conditions.
+
+So a reachable answer carries `execution: "unverified"` and is never called
+executable. `planAttemptExecution` is not called here: it builds the
+provider client and the credit budget for a real dispatch, which an offline
+report has no account, credentials or reservation for.
+`fallback.notModelled` repeats the hypothesis and the unverified list.
 
 ## What the product has that this does not
 
diff --git a/lib/crossReviewCore.ts b/lib/crossReviewCore.ts
index a3da4f56..76403449 100644
--- a/lib/crossReviewCore.ts
+++ b/lib/crossReviewCore.ts
@@ -89,6 +89,14 @@ export type CrossReviewTask = {
      * changed, and its content is digested into the package.
      */
     generatedPaths?: readonly string[];
+    /**
+     * The concluded exchange this task continues from, when there is one.
+     * Its unresolved findings are handed to the reviewer of round 0 as the
+     * previous findings, so a new exchange does not start from nothing --
+     * and a chain of such continuations is capped (`MAX_SUPERSESSIONS`), so
+     * starting over is not a way to get more rounds.
+     */
+    supersedes?: { taskId: string; exchange: string };
 };
 
 /** What an author executor returns. Its digest claim, if any, is ignored. */
@@ -176,6 +184,8 @@ export type ReviewRequest = {
     authorSelfAssessment: string | null;
     /** Findings from the previous round, so the reviewer can check they were addressed. */
     previousFindings: readonly Finding[];
+    /** Where those findings came from when not the previous round: the superseded exchange. */
+    previousFindingsFrom?: string;
 };
 
 export type AuthorRequest = {
@@ -516,6 +526,332 @@ const inScope = (task: CrossReviewTask, file: string): boolean =>
 const scopeViolations = (task: CrossReviewTask, files: readonly string[]): readonly string[] =>
     files.filter((file) => !inScope(task, file));
 
+// ---------------------------------------------------------------------------
+// Rules a person-driven exchange applies before a package or a review.
+
+/** How many times a concluded exchange may be continued by a new task. */
+export const MAX_SUPERSESSIONS = 2;
+
+const underPath = (file: string, path: string): boolean =>
+    path === "" || path === "." || file === path || file.startsWith(path.endsWith("/") ? path : `${path}/`);
+
+/**
+ * One spelling for a repository path: forward slashes, `.` and `..`
+ * segments resolved, no trailing slash. Every path that is compared,
+ * digested or handed to git goes through this once, so a Windows spelling,
+ * a `./` prefix or a `..` written under an allowed directory cannot pass
+ * one check and mean another path to git. A path that climbs above the
+ * repository keeps its leading `..`, and `escapesRepository` says so.
+ */
+export const normalizeRepoPath = (path: string): string => {
+    const segments: string[] = [];
+    for (const segment of path.trim().replace(/\\/g, "/").split("/")) {
+        if (segment === "" || segment === ".") continue;
+        if (segment === "..") {
+            if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
+            else segments.push("..");
+            continue;
+        }
+        segments.push(segment);
+    }
+    return segments.length === 0 ? "." : segments.join("/");
+};
+
+/** A normalised path that climbs above the repository root. */
+export const escapesRepository = (normalized: string): boolean => normalized === ".." || normalized.startsWith("../");
+
+/**
+ * Why a set of `--diff-exclude` paths may not be applied to a package. The
+ * allow list is exact: a path is accepted only when, in its one spelling
+ * (`normalizeRepoPath`), it *is* one of the task's generated paths or *is*
+ * the package's own output directory -- and never when it is, or contains,
+ * a path of the writable scope, whatever else it is named as, since
+ * excluding a scoped source or a parent of one would leave the change
+ * unread and undigested. Everything else is refused by name: a path that
+ * climbs above the repository, a file under the package directory (exclude
+ * the directory itself), a parent of the package directory, and a path
+ * declared nowhere. So `--out=. --diff-exclude=.` is refused because `.`
+ * contains the scope, and `<out>/../../README.md` is refused because,
+ * resolved, it is a file beside the package that nothing declared. A task
+ * with an empty scope may write anywhere, so its scope is `.`.
+ */
+export const packageExclusionProblems = (input: {
+    excluded: readonly string[];
+    generatedPaths: readonly string[];
+    outDir: string;
+    writableScope: readonly string[];
+}): readonly string[] => {
+    const out = normalizeRepoPath(input.outDir);
+    const generated = input.generatedPaths.map(normalizeRepoPath);
+    const scope = (input.writableScope.length > 0 ? input.writableScope : ["."]).map(normalizeRepoPath);
+    const problems: string[] = [];
+    for (const raw of input.excluded) {
+        const path = normalizeRepoPath(raw);
+        if (escapesRepository(path)) {
+            problems.push(`${raw} climbs above the repository; nothing outside it can be excluded`);
+            continue;
+        }
+        const covered = scope.filter((entry) => underPath(entry, path));
+        if (covered.length > 0) {
+            problems.push(`${raw} is, or contains, the writable scope entry ${covered.join(", ")}; a scoped source cannot be excluded from the reviewed diff`);
+            continue;
+        }
+        if (generated.includes(path) || path === out) continue;
+        if (underPath(path, out)) {
+            problems.push(`${raw} is under the package directory ${input.outDir}; exclude the package directory itself, not a file under it`);
+            continue;
+        }
+        if (underPath(out, path)) {
+            problems.push(`${raw} contains the package directory ${input.outDir}; exclude the package directory itself, not a parent of it`);
+            continue;
+        }
+        problems.push(`${raw} is not one of the task's generatedPaths and is not the package directory`);
+    }
+    return problems;
+};
+
+/** What a superseded exchange must look like for a task to continue it. */
+export type SupersededExchange = {
+    taskId: string;
+    status: string;
+    findings: readonly DisposedFinding[];
+    /** The exchanges that exchange itself continued, oldest first. */
+    lineage?: readonly string[];
+};
+
+/**
+ * Why a task may not continue the exchange it names. A continuation is for a
+ * concluded exchange only -- on hold or failed, never passed or still open --
+ * and the chain of continuations is capped, so starting a new task is not a
+ * way to reset the revision cap.
+ */
+export const supersessionProblems = (task: CrossReviewTask, prior: SupersededExchange | null): readonly string[] => {
+    if (!task.supersedes) return [];
+    if (!prior) return [`${task.supersedes.exchange} could not be read`];
+    const problems: string[] = [];
+    if (prior.taskId !== task.supersedes.taskId) {
+        problems.push(`the exchange at ${task.supersedes.exchange} is ${prior.taskId}, not ${task.supersedes.taskId}`);
+    }
+    if (prior.status !== "on_hold" && prior.status !== "failed") {
+        problems.push(`the exchange ${prior.taskId} is ${prior.status}; only an exchange on hold or failed can be continued`);
+    }
+    const priorDepth = prior.lineage?.length ?? 0;
+    if (priorDepth + 1 > MAX_SUPERSESSIONS) {
+        problems.push(
+            `${prior.taskId} is already ${priorDepth} continuation(s) deep; the cap is ${MAX_SUPERSESSIONS}, and a person decides what happens to the change`
+        );
+    }
+    return problems;
+};
+
+/** The findings a continuation inherits: those the prior exchange left open, as plain findings. */
+export const inheritedFindings = (prior: SupersededExchange): readonly Finding[] =>
+    prior.findings
+        .filter((finding) => finding.disposition === "unresolved_on_hold" || finding.disposition === "fix_requested")
+        .map((finding) => ({
+            location: finding.location,
+            severity: finding.severity,
+            basis: finding.basis,
+            claim: finding.claim,
+            ...(finding.reproduction !== undefined ? { reproduction: finding.reproduction } : {}),
+        }));
+
+/** The lineage a continuation records: the prior's lineage, then the prior. */
+export const lineageOf = (prior: SupersededExchange): readonly string[] => [...(prior.lineage ?? []), prior.taskId];
+
+// ---------------------------------------------------------------------------
+// The reviewer's environment, checked before a paid review.
+
+/** What the preflight asks the reviewer to answer. */
+export type PreflightReport = {
+    /** The read command's standard output, verbatim. */
+    readOutput: string;
+    /** Whether a write was attempted at the probe path. */
+    writeAttempted: boolean;
+    /** What happened to the write: "written", or the error text. */
+    writeResult: string;
+};
+
+export const preflightReportProblems = (value: unknown): readonly string[] => {
+    if (!isRecord(value)) return ["not an object"];
+    const problems: string[] = [];
+    if (typeof value.readOutput !== "string") problems.push("readOutput must be a string");
+    if (typeof value.writeAttempted !== "boolean") problems.push("writeAttempted must be a boolean");
+    if (typeof value.writeResult !== "string") problems.push("writeResult must be a string");
+    return problems;
+};
+
+/** The rule a preflight record was judged under. A review accepts only records of the current one. */
+export const PREFLIGHT_RECORD_VERSION = "cross-review-preflight-v2";
+
+/**
+ * Two steps and one JSON answer: not a review, and not to be read as one.
+ * The write is asked for as one shell command naming the probe path, so the
+ * tool's own record of the attempt -- the command and what it printed --
+ * carries the path. A patch or edit tool's refusal names no path, and so
+ * says nothing about the probe (`writeRefusalEvidence`).
+ */
+export const renderPreflightPrompt = (input: { readCommand: string; probePath: string }): string =>
+    [
+        "# Reviewer environment preflight",
+        "",
+        "This is not a review. Do exactly the two steps below, then answer with one JSON document and nothing else.",
+        "",
+        `1. Run this command and capture its standard output verbatim: \`${input.readCommand}\``,
+        `2. Try to create a file at \`${input.probePath}\` containing the single word \`probe\`, with ONE shell command that names that exact path -- in PowerShell: \`Set-Content -LiteralPath '${input.probePath}' -Value probe\`; in a POSIX shell: \`printf probe > '${input.probePath}'\`. Use the shell for this step, not a patch or file-editing tool: the record has to show the command and its result at that path. If it is refused, do not retry, do not try another location or another method; report what happened.`,
+        "",
+        "```json",
+        JSON.stringify(
+            {
+                readOutput: "the command's standard output, verbatim",
+                writeAttempted: true,
+                writeResult: '"written", or the error text the attempt produced',
+            },
+            null,
+            2
+        ),
+        "```",
+        "",
+    ].join("\n");
+
+/**
+ * Whether the environment is fit for a review: the read produced what the
+ * control program itself knows to be true, and the write was attempted and
+ * refused. What the reviewer *said* is recorded and not trusted on its own:
+ * the probe's absence, and a refusal of a write at the probe path that the
+ * tool itself reported in its own output (`writeRefusalObserved`, read by
+ * the caller from the raw events or stderr with `writeRefusalEvidence`),
+ * are the evidence. A report that claims the write succeeded is a failure
+ * even with no probe: either it wrote somewhere else, or it is not
+ * describing what happened.
+ */
+export const judgePreflight = (input: {
+    report: PreflightReport;
+    expectedReadOutput: string;
+    probeExists: boolean;
+    /** The tool's own output showed a write at the probe path being refused (a denied command, a failed file change there). */
+    writeRefusalObserved: boolean;
+}): { passed: boolean; problems: readonly string[] } => {
+    const problems: string[] = [];
+    const expected = input.expectedReadOutput.trim();
+    if (expected === "" || !input.report.readOutput.includes(expected)) {
+        problems.push(`the read did not produce the expected output (expected to contain ${JSON.stringify(expected)})`);
+    }
+    if (input.probeExists) problems.push("the write probe landed: the reviewer can write to the working tree");
+    if (!input.report.writeAttempted) problems.push("the reviewer did not attempt the write, so nothing about writes was shown");
+    if (/\b(written|wrote|created|succeeded|success)\b/i.test(input.report.writeResult)) {
+        problems.push(`the reviewer reports the write as done (${JSON.stringify(input.report.writeResult.slice(0, 80))}); a write that lands anywhere is a failed preflight`);
+    }
+    if (!input.writeRefusalObserved) {
+        problems.push(
+            "the tool's own output shows no refused write at the probe path; a refusal that names no path, a denial of some other file, and the reviewer's account of a refusal are not evidence by themselves"
+        );
+    }
+    return { passed: problems.length === 0, problems };
+};
+
+/** What a refusal looks like in a tool's output. Matched line by line, never against the reviewer's own words. */
+const REFUSAL_TEXT = /rejected|refused|blocked|denied|not permitted|read-only file system|EACCES|EPERM|EROFS/i;
+
+/**
+ * The tool's own evidence that a write *at the probe path* was refused, or
+ * null. Codex prints one event per line: a `command_execution` item whose
+ * command names the probe and whose output says the write was refused; an
+ * `error` item naming the probe; a `file_change` item at the probe that did
+ * not complete. Claude Code's JSON envelope has no item stream, so a denial
+ * is a `permission_denials` entry naming the probe. A stderr line counts
+ * when it names the probe. A refusal that names no path -- Codex's own
+ * "patch rejected" line -- or a denial of some other file or tool shows
+ * that something was refused, not that the probe was, and is not evidence
+ * here; nor is anything the reviewer says in an agent message.
+ */
+export const writeRefusalEvidence = (stdout: string, stderr: string, probePath: string): string | null => {
+    const probe = normalizeRepoPath(probePath).toLowerCase();
+    if (probe === "." || probe === "") return null;
+    const namesProbe = (text: unknown): boolean =>
+        typeof text === "string" && text.replace(/\\/g, "/").toLowerCase().includes(probe);
+    const clip = (text: string): string => text.trim().replace(/\s+/g, " ").slice(0, 200);
+    for (const line of stderr.split("\n")) {
+        if (namesProbe(line) && REFUSAL_TEXT.test(line)) return `stderr: ${clip(line)}`;
+    }
+    for (const line of stdout.split("\n")) {
+        let event: unknown;
+        try {
+            event = JSON.parse(line);
+        } catch {
+            continue;
+        }
+        if (!isRecord(event)) continue;
+        const item = isRecord(event.item) ? event.item : null;
+        if (item) {
+            if (item.type === "command_execution" && namesProbe(item.command) && typeof item.aggregated_output === "string") {
+                const refused = item.aggregated_output.split("\n").find((outputLine) => REFUSAL_TEXT.test(outputLine));
+                if (refused !== undefined) return `command_execution ${clip(String(item.command))} -> ${clip(refused)}`;
+            }
+            if (item.type === "error" && namesProbe(item.message) && REFUSAL_TEXT.test(String(item.message))) {
+                return `error item: ${clip(String(item.message))}`;
+            }
+            if (item.type === "file_change" && item.status !== "completed" && item.status !== "in_progress" && namesProbe(JSON.stringify(item.changes ?? null))) {
+                return `file_change ${String(item.status)} at the probe path`;
+            }
+        }
+        if (Array.isArray(event.permission_denials)) {
+            const denial = event.permission_denials.find((entry) => namesProbe(JSON.stringify(entry)));
+            if (denial !== undefined) return `permission_denials: ${clip(JSON.stringify(denial))}`;
+        }
+    }
+    return null;
+};
+
+/** Whether `writeRefusalEvidence` found any. */
+export const writeRefusalObservedIn = (stdout: string, stderr: string, probePath: string): boolean =>
+    writeRefusalEvidence(stdout, stderr, probePath) !== null;
+
+/** What a review reads from each recorded preflight to decide whether it may start. */
+export type PreflightSummary = {
+    name: string;
+    version: string;
+    sandboxSignature: string;
+    startedAt: string;
+    passed: boolean;
+    problems?: readonly string[];
+};
+
+/**
+ * Whether a review may start on the preflights recorded for its sandbox
+ * signature. The newest of them decides, and it must have passed under the
+ * current rule: an older pass is not consulted past a newer failure -- the
+ * environment was last seen failing -- and a pass judged under an earlier
+ * rule proved what that rule asked, not what this one does. Either way the
+ * answer is to run the preflight again, not to pick a record that suits.
+ */
+export const preflightGate = (
+    records: readonly PreflightSummary[],
+    signature: string,
+    version: string = PREFLIGHT_RECORD_VERSION
+): { chosen: PreflightSummary | null; problems: readonly string[] } => {
+    const matching = records
+        .filter((record) => record.sandboxSignature === signature)
+        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
+    const newest = matching[0] ?? null;
+    if (!newest) return { chosen: null, problems: [`no preflight is recorded for this sandbox signature (${signature})`] };
+    if (newest.version !== version) {
+        return {
+            chosen: null,
+            problems: [`the newest preflight for this sandbox, ${newest.name}, was judged under ${newest.version}, not the current ${version}; run --mode=preflight again`],
+        };
+    }
+    if (newest.passed !== true) {
+        return {
+            chosen: null,
+            problems: [
+                `the newest preflight for this sandbox, ${newest.name} (${newest.startedAt}), FAILED: ${(newest.problems ?? []).join("; ") || "no problem recorded"}; an older pass is not consulted, run --mode=preflight again`,
+            ],
+        };
+    }
+    return { chosen: newest, problems: [] };
+};
+
 export async function runCrossReview(control: CrossReviewControl): Promise<CrossReviewOutcome> {
     const roles = control.roles ?? DEFAULT_ROLE_ASSIGNMENT;
     const maxRevisions = resolveMaxRevisions(control.maxRevisions);
@@ -948,7 +1284,7 @@ export const renderReviewPrompt = (request: ReviewRequest): string => {
     }
     if (request.previousFindings.length > 0) {
         lines.push("");
-        lines.push("## Findings from the previous round (check each was addressed)");
+        lines.push(`## Findings from ${request.previousFindingsFrom ?? "the previous round"} (check each was addressed)`);
         lines.push("");
         for (const finding of request.previousFindings) {
             lines.push(`- [${finding.severity}/${finding.basis}] ${finding.location}: ${finding.claim}`);
diff --git a/lib/crossReviewExecutors.ts b/lib/crossReviewExecutors.ts
index f0bf80d5..ec23f1e6 100644
--- a/lib/crossReviewExecutors.ts
+++ b/lib/crossReviewExecutors.ts
@@ -165,10 +165,13 @@ export const CLI_INVOCATIONS: Readonly<Record<"claude" | "codex", Readonly<Recor
         },
         reviewer: {
             command: "claude",
-            args: ["--print", "--output-format", "json", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--strict-mcp-config"],
+            args: ["--print", "--safe-mode", "--output-format", "json", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--strict-mcp-config"],
             note:
-                "Claude Code non-interactive with only the read tools built in (`--tools`), pre-approved so nothing prompts " +
-                "(`--allowedTools`), and no MCP server (`--strict-mcp-config` with no `--mcp-config`). Nothing offered can write.",
+                "Claude Code non-interactive with the user's, project's and local customisations off (`--safe-mode`: no " +
+                "CLAUDE.md, skills, plugins, hooks or MCP servers load, while authentication works as normal -- unlike " +
+                "`--bare`, which drops the stored login), only the read tools built in (`--tools`), pre-approved so nothing " +
+                "prompts (`--allowedTools`), and no MCP server (`--strict-mcp-config` with no `--mcp-config`). Managed policy " +
+                "hooks still apply, as the documentation says. Nothing offered can write.",
         },
     },
     codex: {
@@ -329,6 +332,78 @@ export const unwrapCodexJsonl = (stdout: string): string => {
     return last ?? stdout;
 };
 
+/** What a tool reported spending, in its own units, with the tool named. */
+export type ExecutorUsage = {
+    tool: "codex" | "claude";
+    inputTokens: number | null;
+    cachedInputTokens: number | null;
+    outputTokens: number | null;
+    reasoningOutputTokens: number | null;
+    /** Claude Code's client-side estimate, when the envelope carries one. */
+    totalCostUsd: number | null;
+    /** The tool's own usage object, verbatim. */
+    raw: unknown;
+};
+
+const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
+
+/**
+ * The usage a tool reported, read from the shape that tool prints: Codex's
+ * `turn.completed` event in its JSONL stream (the last one wins), or Claude
+ * Code's single JSON envelope (`usage`, `total_cost_usd`). Null when the
+ * output is neither, so a record never carries a usage the tool did not
+ * report.
+ */
+export const extractUsage = (stdout: string): ExecutorUsage | null => {
+    const trimmed = stdout.trim();
+    if (trimmed === "") return null;
+    try {
+        const envelope = JSON.parse(trimmed) as unknown;
+        if (typeof envelope === "object" && envelope !== null && !Array.isArray(envelope)) {
+            const record = envelope as Record<string, unknown>;
+            const usage = record.usage;
+            if (typeof usage === "object" && usage !== null) {
+                const fields = usage as Record<string, unknown>;
+                return {
+                    tool: "claude",
+                    inputTokens: numberOrNull(fields.input_tokens),
+                    cachedInputTokens: numberOrNull(fields.cache_read_input_tokens),
+                    outputTokens: numberOrNull(fields.output_tokens),
+                    reasoningOutputTokens: null,
+                    totalCostUsd: numberOrNull(record.total_cost_usd),
+                    raw: usage,
+                };
+            }
+        }
+    } catch {
+        // not a single envelope; try the event stream
+    }
+    let usage: Record<string, unknown> | null = null;
+    for (const line of trimmed.split("\n")) {
+        try {
+            const event = JSON.parse(line) as unknown;
+            if (typeof event === "object" && event !== null) {
+                const record = event as Record<string, unknown>;
+                if (record.type === "turn.completed" && typeof record.usage === "object" && record.usage !== null) {
+                    usage = record.usage as Record<string, unknown>;
+                }
+            }
+        } catch {
+            // not an event line
+        }
+    }
+    if (!usage) return null;
+    return {
+        tool: "codex",
+        inputTokens: numberOrNull(usage.input_tokens),
+        cachedInputTokens: numberOrNull(usage.cached_input_tokens),
+        outputTokens: numberOrNull(usage.output_tokens),
+        reasoningOutputTokens: numberOrNull(usage.reasoning_output_tokens),
+        totalCostUsd: null,
+        raw: usage,
+    };
+};
+
 /**
  * Claude Code's `--output-format json` wraps the answer in an envelope whose
  * `result` field holds the model's text. The text is what carries the
@@ -407,3 +482,15 @@ export const cliReviewer = (options: CliExecutorOptions): ReviewerExecutor => ({
     id: options.id,
     review: (request) => runCli<ReviewVerdict>(options, "reviewer", renderReviewPrompt(request), reviewVerdictProblems),
 });
+
+/**
+ * The reviewer's invocation, run on a prompt that is not a review: the
+ * environment preflight. Same command line, same override allow list, same
+ * sandbox, so what it shows about reads and writes is what a review would
+ * get.
+ */
+export const cliProbe = (options: CliExecutorOptions) => ({
+    id: options.id,
+    run: <T>(prompt: string, problemsOf: (value: unknown) => readonly string[]) =>
+        runCli<T>(options, "reviewer", prompt, problemsOf),
+});
diff --git a/lib/routerFullCatalogDiagnostic.ts b/lib/routerFullCatalogDiagnostic.ts
index 218bae11..38553354 100644
--- a/lib/routerFullCatalogDiagnostic.ts
+++ b/lib/routerFullCatalogDiagnostic.ts
@@ -76,7 +76,7 @@ import type { TaskKind, TaskProfile } from "@/lib/taskProfileCore";
 import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
 
 /** Bump with any change to the shape of the report or how a row is derived. */
-export const ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION = "router-full-catalog-diagnostic-v2";
+export const ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION = "router-full-catalog-diagnostic-v3";
 
 /** One request to diagnose. The shape `EvalSetItem` already has, and no more. */
 export type DiagnosticItem = {
@@ -169,7 +169,7 @@ export type FallbackDecisionRecord = {
  * and the credit budget for a real dispatch, which an offline report has no
  * account, credentials or reservation for. Its refusals that depend on
  * those, and the two runtime checks the route makes around it, are listed
- * in `undecidedOffline` on every reachable answer, so `reachable: true`
+ * in `unverifiedConditions` on every reachable answer, so `reachable: true`
  * reads as "nothing decidable offline refused it" and not as a promise.
  */
 export type FallbackReachability =
@@ -178,11 +178,17 @@ export type FallbackReachability =
           modelId: string;
           dispatchFit: "fitted" | "unbounded";
           dispatchOutputTokens: number | null;
-          undecidedOffline: readonly string[];
+          /**
+           * Never "executable": whether the fallback would run is decided
+           * by the pre-dispatch check on a real request, against the
+           * conditions listed below, which this report cannot see.
+           */
+          execution: "unverified";
+          unverifiedConditions: readonly string[];
       }
     | { reachable: false; refusal: string };
 
-export const FALLBACK_UNDECIDED_OFFLINE: readonly string[] = [
+export const FALLBACK_UNVERIFIED_CONDITIONS: readonly string[] = [
     "search_path_unavailable: planAttemptExecution refuses a candidate that cannot search when the primary's turn had a search path; the request's web-search mode is not an input here",
     "budget_refused: createChatBudget and reserveTurnSearchCost need the account's credits and the provider budget",
     "candidate_unavailable: the runtime registry row's enabled and catalogDeleted state; this report reads the catalogue passed in",
@@ -281,7 +287,7 @@ export type ItemDiagnostic = {
     /** Every model in the catalogue, in catalogue order. */
     models: readonly ModelDisposition[];
     fallback: {
-        /** Best first, from the Router; what §7 may try. */
+        /** Best first, from the Router; what docs/policy/tomverse-chat-routing.md §7 may try. */
         rankedCandidateModelIds: readonly string[];
         /** How many of those a turn may actually fall back to. */
         maxModelFallbacks: number;
@@ -461,7 +467,8 @@ export const fallbackReachabilityFor = (
         modelId: candidate.modelId,
         dispatchFit: candidate.dispatchFit,
         dispatchOutputTokens: candidate.dispatchOutputTokens,
-        undecidedOffline: FALLBACK_UNDECIDED_OFFLINE,
+        execution: "unverified",
+        unverifiedConditions: FALLBACK_UNVERIFIED_CONDITIONS,
     };
 };
 
@@ -709,7 +716,7 @@ const diagnoseItem = (item: DiagnosticItem, input: DiagnosticInput, requestOutpu
             reachableIfFlagOn: fallbackReachabilityFor(scopeIfFlagOn, fallbackDecision, firstCandidate),
             notModelled: [
                 `the decision is asked under one hypothesis: the primary failed ${FALLBACK_FAILURE_HYPOTHESIS.outcome} at the ${FALLBACK_FAILURE_HYPOTHESIS.failureLayer} layer with no provider refusal and no visible token; any other failure shape terminates by policy`,
-                ...FALLBACK_UNDECIDED_OFFLINE,
+                ...FALLBACK_UNVERIFIED_CONDITIONS,
             ],
         },
         caps,
diff --git a/scripts/cross-review.mjs b/scripts/cross-review.mjs
index 602e73d9..5748d6dc 100644
--- a/scripts/cross-review.mjs
+++ b/scripts/cross-review.mjs
@@ -1,64 +1,93 @@
 // Runs the author–reviewer exchange for one task, packages a change for an
-// independent reviewer to read, or runs only the reviewer on such a package.
+// independent reviewer to read, checks the reviewer's environment, or runs
+// only the reviewer on such a package.
 //
 // Modes:
-//   --mode=mock     scripted executors from --fixture; the whole loop, offline.
-//   --mode=dry-run  the command-line executors are built and never run; the
-//                   outcome is `failed` with `author_not_executed`, and the
-//                   record shows the exact commands that would have run.
-//   --mode=package  no executor at all: takes the diff of the task's base
-//                   commit (or --base) against HEAD or the worktree as round
-//                   --round (default: the next round), computes the digest,
-//                   runs --test-command and every --guard-command, and writes
-//                   the package for that round plus the reviewer prompt.
-//   --mode=review   runs only the reviewer, on the package of --round
-//                   (default: the latest packaged round). The prompt is rebuilt
-//                   from the stored package, the verdict is written as
-//                   verdict-round<N>.json, and exchange.json becomes the
-//                   control program's replay of every round so far. Refused
-//                   unless --i-have-authorised-live-execution is given; without
-//                   it the reviewer is built in dry-run and the exact command
-//                   is shown.
-//   --mode=live     runs both command-line executors in the loop. Refused
-//                   unless --i-have-authorised-live-execution is also given,
-//                   because a live run spends and edits. The diff of record is
-//                   the working tree's diff against the base after the author
-//                   ran -- not the diff the author returned, which is recorded
-//                   only as its claim -- so the digest, the scope check and
-//                   the reviewer all read the change that exists.
+//   --mode=mock      scripted executors from --fixture; the whole loop, offline.
+//   --mode=dry-run   the command-line executors are built and never run; the
+//                    outcome is `failed` with `author_not_executed`, and the
+//                    record shows the exact commands that would have run.
+//   --mode=package   no executor at all: takes the diff of the task's base
+//                    commit (or --base) against HEAD or the worktree as round
+//                    --round (default: the next round), computes the digest,
+//                    runs --test-command and every --guard-command, and writes
+//                    the package for that round plus the reviewer prompt.
+//   --mode=preflight runs the reviewer's own invocation on a prompt that is
+//                    not a review: read the HEAD commit, then try to write a
+//                    probe file with one shell command naming its path. Passes
+//                    only when the read matched what this script knows, the
+//                    probe did not land, and the tool's own output shows the
+//                    write at that path being refused. The call, its command,
+//                    its usage, the evidence and its result are recorded under
+//                    --out as preflight-<stamp>.json. Refused unless
+//                    --i-have-authorised-live-execution is given; without it
+//                    the exact command is shown.
+//   --mode=review    runs only the reviewer, on the package of --round
+//                    (default: the latest packaged round). The prompt is
+//                    rebuilt from the stored package, the verdict is written as
+//                    verdict-round<N>.json, and exchange.json becomes the
+//                    control program's replay of every round so far. Refused
+//                    unless --i-have-authorised-live-execution is given;
+//                    without it the reviewer is built in dry-run and the exact
+//                    command is shown. Also refused, so a paid review is not
+//                    started in a state that cannot pass: when the package's
+//                    tests or guards failed (override:
+//                    --review-despite-check-failures) and when the newest
+//                    preflight for the same sandbox signature is not a pass
+//                    under the current rule -- none, failed, or judged under
+//                    an older rule (override: --skip-preflight). An override
+//                    is a person's decision and is recorded with the verdict.
+//   --mode=live      runs both command-line executors in the loop. Refused
+//                    unless --i-have-authorised-live-execution is also given,
+//                    because a live run spends and edits. The diff of record
+//                    is the working tree's diff against the base after the
+//                    author ran -- not the diff the author returned, which is
+//                    recorded only as its claim.
 //
 // What the package refuses, so a record can be trusted:
 //   - a change outside the task's writableScope anywhere in the tree -- a
 //     tracked file changed against the base, or an untracked file -- not just
-//     in the scoped diff. The diff is scoped so a reviewer reads the change;
-//     the scope check is not, so nothing hides behind the scoping.
+//     in the scoped diff.
 //   - an untracked file the diff would not show, unless it lies under a
-//     --diff-exclude path (a declared generated file; the package's own
-//     outputs are such files).
-//   - a --diff-exclude path that is not one of the task's `generatedPaths`
-//     or the package's own --out directory. What the reviewer does not see is
-//     fixed before the exchange, not chosen by the author at packaging time;
-//     an excluded file still counts as changed, and its content digest is
-//     recorded in the package and checked again at review time.
+//     --diff-exclude path.
+//   - a --diff-exclude path that, resolved to one spelling (`..` and `.`
+//     included), is not exactly one of the task's `generatedPaths` or exactly
+//     the package's own --out directory. A parent of the package directory, a
+//     file under it, a path above the repository and any scoped source are
+//     refused by name (lib/crossReviewCore.ts, packageExclusionProblems). An
+//     excluded generated file still counts as changed; its content digest --
+//     or its absence -- is recorded, and a review refuses to run if it
+//     changed, appeared or disappeared since packaging.
 //   - round N > 0 unless the control program's replay of rounds 0..N-1 is
 //     `awaiting_revision`. After `passed`, `on_hold` or `failed` the exchange
 //     has concluded; a further change is a new task or a new --out.
-//   - a second verdict on a round that has one. A new digest needs a new
-//     package and a new review.
+//   - a second verdict on a round that has one.
 //   - a review of a package the working tree does not match: the tree's diff
 //     against the base, scoped and excluded as the package was, must digest
-//     to the package's digest, and every excluded file must still digest to
-//     what the package recorded.
+//     to the package's digest.
+//
+// A task that continues a concluded exchange names it in `supersedes`. The
+// package of round 0 then records the lineage and the findings the prior
+// exchange left open, and the reviewer of round 0 is shown them as the
+// previous findings. Only an exchange on hold or failed can be continued, and
+// the chain is capped (MAX_SUPERSESSIONS), so a new task is not a way to
+// reset the revision cap (lib/crossReviewCore.ts, supersessionProblems).
 //
 // Codex executors:
 //   --codex-config=<key=value>  repeatable; passed as `-c key=value`. A
 //                   reviewer accepts only REVIEWER_CONFIG_OVERRIDE_KEYS. Give
-//                   the value without quotes (`model=gpt-5.6-sol`): codex keeps
-//                   a value that is not TOML as a literal string, and the
-//                   Windows spawner refuses quotes.
+//                   the value without quotes (`model=gpt-5.6-sol`).
 //   --codex-auth=login|env      default `login`: OPENAI_API_KEY and
 //                   CODEX_API_KEY are dropped from the child environment so
 //                   codex uses its stored login; `env` leaves them in place.
+//   --codex-shell=default|windows-powershell
+//                   `windows-powershell` drops the app-execution-alias
+//                   directory (…\Microsoft\WindowsApps) from the child's PATH,
+//                   so `pwsh` -- the Store-installed PowerShell 7, whose
+//                   WindowsApps ACLs deny the sandbox's restricted token --
+//                   resolves to nothing and codex falls back to Windows
+//                   PowerShell in System32. Part of the sandbox signature;
+//                   recorded in the preflight and the verdict.
 //
 // Checks the control program applies (lib/crossReviewCore.ts): a pass needs at
 // least one passing test run and at least one guard rule run with every rule
@@ -66,64 +95,51 @@
 //   --test-command=<sh>   the test run, once per round; exit status decides.
 //   --guard-command=<sh>  repeatable; each is a guard rule, recorded with its
 //                         result; a non-zero exit is a failed rule.
-// In live mode a guard rule also compares the working tree with what the
-// author reported (an untracked file the diff cannot show fails it).
 //
 // --max-revisions may lower the fixed cap (MAX_REVISIONS, 2) for a run and
 // cannot raise it.
 //
-// Usage:
-//   node --import tsx scripts/cross-review.mjs --task=<task.json> --mode=mock \
-//     --fixture=<fixture.json> --out=<dir> [--author=claude] [--reviewer=codex] \
-//     [--max-revisions=2] [--test-command="npm test -- x"] [--timeout-ms=600000]
-//
-// task.json: { taskId, requirement, completionCriteria[], baseCommit, writableScope[], generatedPaths?[] }
+// task.json: { taskId, requirement, completionCriteria[], baseCommit, writableScope[],
+//              generatedPaths?[], supersedes?: { taskId, exchange } }
 // fixture.json (mock): { author: AuthorOutput[], reviewer: ReviewVerdict[], tests?: TestRun[][], guards?: GuardRun[][] }
-//   A reviewer entry may carry reviewedDigest "@current" to mean the digest
-//   of the change it is shown; anything else is compared literally.
 //
-// Package layout under --out:
-//   package-round<N>.json     the change of round N: digest, commit, summary,
-//                             files, test and guard results, the whole-tree
-//                             file list the scope check read, the excluded
-//                             paths with their content digests, and the diff
-//                             itself (kept inside JSON so line-ending
-//                             conversion on checkout cannot alter what is
-//                             digested)
-//   change-round<N>.diff      the same diff, for a person
-//   verdict-round<N>.json     the reviewer's verdict on round N, with the exact
-//                             command that produced it
-//   review-round<N>.events.jsonl  the reviewer's raw output
-//   review-prompt.md, change.diff  the latest round, for a person
-//   exchange.json             the record: the control program's replay
-//
-// exchange.json carries the control program's statuses -- passed, on_hold,
-// failed -- and two that only a person-driven exchange has: awaiting_review
-// (a package with no verdict yet) and awaiting_revision (actionable findings
-// or failed checks, and a revision remains). Both are read off where the
-// replay through runCrossReview stopped (lib/crossReviewCore.ts,
-// replayExchange), never decided here.
+// Package layout under --out: package-round<N>.json, change-round<N>.diff,
+// verdict-round<N>.json, review-round<N>.events.jsonl, preflight-<stamp>.json,
+// review-prompt.md and change.diff (latest round), exchange.json (the record).
 //
 // Nothing here pushes, merges, or dispatches a workflow.
 
 import { createHash } from "node:crypto";
-import { execFileSync, spawn as nodeSpawn } from "node:child_process";
-import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
+import { execFileSync, execSync, spawn as nodeSpawn } from "node:child_process";
+import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 
 import {
   MAX_REVISIONS,
+  PREFLIGHT_RECORD_VERSION,
+  inheritedFindings,
+  judgePreflight,
+  lineageOf,
+  normalizeRepoPath,
+  packageExclusionProblems,
+  preflightGate,
+  preflightReportProblems,
+  renderPreflightPrompt,
   renderReviewPrompt,
   replayExchange,
   resolveMaxRevisions,
   runCrossReview,
+  supersessionProblems,
+  writeRefusalEvidence,
 } from "../lib/crossReviewCore.ts";
 import {
   CLI_INVOCATIONS,
   REVIEWER_CONFIG_OVERRIDE_KEYS,
   cliAuthor,
   cliCommandLine,
+  cliProbe,
   cliReviewer,
+  extractUsage,
   mockAuthor,
   mockReviewer,
 } from "../lib/crossReviewExecutors.ts";
@@ -143,14 +159,19 @@ const die = (message) => {
 };
 
 const mode = flag("mode", "mock");
-if (!["mock", "dry-run", "package", "review", "live"].includes(mode)) die("--mode must be mock, dry-run, package, review or live.");
+if (!["mock", "dry-run", "package", "preflight", "review", "live"].includes(mode)) {
+  die("--mode must be mock, dry-run, package, preflight, review or live.");
+}
 const taskPath = flag("task");
 if (!taskPath) die("--task=<task.json> is required.");
 const task = JSON.parse(readFileSync(taskPath, "utf8"));
 for (const field of ["taskId", "requirement", "completionCriteria", "baseCommit", "writableScope"]) {
   if (task[field] === undefined) die(`${taskPath} has no ${field}.`);
 }
-const generatedPaths = task.generatedPaths ?? [];
+// Every path that is compared, digested or handed to git is normalised once
+// here (forward slashes, no trailing slash), so a Windows spelling and a
+// POSIX spelling of the same file cannot pass one check and miss another.
+const generatedPaths = (task.generatedPaths ?? []).map(normalizeRepoPath);
 const outDir = flag("out", `artifacts/cross-review/${task.taskId}`);
 let maxRevisions;
 try {
@@ -167,12 +188,32 @@ const authorised = flag("i-have-authorised-live-execution", "false") === "true";
 const codexConfig = repeated("codex-config");
 const codexAuth = flag("codex-auth", "login");
 if (!["login", "env"].includes(codexAuth)) die("--codex-auth must be login or env.");
+const codexShell = flag("codex-shell", "default");
+if (!["default", "windows-powershell"].includes(codexShell)) die("--codex-shell must be default or windows-powershell.");
 // Node drops an environment entry whose value is undefined, so these remove
 // the keys from the child rather than setting them to a string.
-const codexEnv = codexAuth === "login" ? { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } : undefined;
+const codexEnv = {
+  ...(codexAuth === "login" ? { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } : {}),
+  // The Windows sandbox starts its shell under a restricted token, and the
+  // Store-installed PowerShell 7 lives under WindowsApps, whose ACLs deny
+  // such a token (codex's own source says as much: "Windows can deny direct
+  // starts of internal executables under WindowsApps"). With the
+  // app-execution-alias directory out of the child's PATH, `pwsh` resolves
+  // to nothing and codex falls back to Windows PowerShell in System32. The
+  // adjustment is explicit, recorded, and part of the sandbox signature.
+  ...(codexShell === "windows-powershell" ? windowsPowerShellPath() : {}),
+};
+function windowsPowerShellPath() {
+  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
+  if (!key) return {};
+  const entries = process.env[key].split(";");
+  const kept = entries.filter((entry) => !/[\\/]microsoft[\\/]windowsapps[\\/]?\s*$/i.test(entry));
+  return { [key]: kept.join(";") };
+}
 
 const digest = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
 const digestFile = (path) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
+const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
 
 // ---------------------------------------------------------------------------
 // Commands the control program runs: the test command and the guard commands.
@@ -216,13 +257,30 @@ const treeChanges = (base) => {
 };
 const scopePathspec = () => (task.writableScope.length > 0 ? task.writableScope : ["."]);
 const scopedDiff = (base, excluded) => git("diff", base, "--", ...scopePathspec(), ...excluded.map((path) => `:(exclude)${path}`));
-/** Content digests of the excluded files that exist, so an exclusion cannot hide a later change. */
-const excludedDigests = (excluded) =>
-  Object.fromEntries(
-    excluded
-      .filter((path) => existsSync(path) && statSync(path).isFile())
-      .map((path) => [path, digestFile(path)])
-  );
+/**
+ * What an excluded path is at this moment: its content digest, a digest
+ * over a directory's files, or "absent". Recorded at packaging and checked
+ * at review, so an exclusion cannot hide a later change, and a file that
+ * did not exist when packaged is seen if it exists at review.
+ */
+const snapshot = (path) => {
+  if (!existsSync(path)) return "absent";
+  const stat = statSync(path);
+  if (stat.isFile()) return digestFile(path);
+  if (!stat.isDirectory()) return "other";
+  const hash = createHash("sha256");
+  const walk = (dir) => {
+    for (const name of readdirSync(dir).sort()) {
+      const entry = join(dir, name);
+      const entryStat = statSync(entry);
+      if (entryStat.isDirectory()) walk(entry);
+      else if (entryStat.isFile()) hash.update(`${entry.replace(/\\/g, "/")}\n${digestFile(entry)}\n`);
+    }
+  };
+  walk(path);
+  return `tree:${hash.digest("hex")}`;
+};
+const excludedSnapshots = (excluded) => Object.fromEntries(excluded.map((path) => [path, snapshot(path)]));
 
 mkdirSync(outDir, { recursive: true });
 const write = (name, contents) => {
@@ -232,6 +290,23 @@ const write = (name, contents) => {
 };
 const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
 
+// ---------------------------------------------------------------------------
+// The exchange this task continues, when it names one.
+
+const supersededExchange = () => {
+  if (!task.supersedes) return null;
+  if (!existsSync(task.supersedes.exchange)) return null;
+  const prior = readJson(task.supersedes.exchange);
+  return { taskId: prior.taskId, status: prior.status, findings: prior.findings ?? [], lineage: prior.lineage ?? [] };
+};
+const continuation = () => {
+  const prior = supersededExchange();
+  const problems = supersessionProblems(task, prior);
+  if (problems.length > 0) die(`refusing to continue ${task.supersedes?.taskId ?? "(no exchange)"}: ${problems.join("; ")}`);
+  if (!prior) return { lineage: [], inherited: [] };
+  return { lineage: lineageOf(prior), inherited: inheritedFindings(prior) };
+};
+
 // ---------------------------------------------------------------------------
 // The package of a round, and the control program's reading of the rounds.
 
@@ -286,6 +361,8 @@ const replay = async (rounds) => {
   }
   return {
     ...exchange,
+    lineage: rounds[0].pkg.lineage ?? [],
+    inheritedFindings: rounds[0].pkg.inheritedFindings ?? [],
     headCommit: latest.pkg.headCommit,
     worktreeDirty: latest.pkg.worktreeDirty,
     filesChanged: latest.pkg.filesChanged,
@@ -299,6 +376,16 @@ const refusalToContinue = (state, nextRound) => {
   return `the exchange concluded as ${state.status}${state.holdReason ? ` (${state.holdReason})` : ""}${state.failure ? ` (${state.failure})` : ""} at round ${state.concludedAtRound}; a further change is a new task or a new --out.`;
 };
 
+/** What the reviewer of round N is shown as the previous findings, and from where. */
+const previousFindingsFor = (rounds, round) => {
+  if (round > 0) return { previousFindings: rounds[round - 1].verdict.findings, previousFindingsFrom: undefined };
+  const inherited = rounds[0].pkg.inheritedFindings ?? [];
+  return {
+    previousFindings: inherited,
+    previousFindingsFrom: inherited.length > 0 ? `the superseded exchange ${task.supersedes?.taskId ?? "(unknown)"}, left open there` : undefined,
+  };
+};
+
 // ---------------------------------------------------------------------------
 // The spawner for live runs, and the command-line executors.
 
@@ -364,6 +451,38 @@ const buildCli = (role, id, executorMode) => {
   };
 };
 
+/** The reviewer's full command line, or a refusal. */
+const reviewerCommandLine = (options) => {
+  const line = cliCommandLine(options.invocation, options.configOverrides ?? [], REVIEWER_CONFIG_OVERRIDE_KEYS);
+  if (!line.ok) die(line.detail);
+  return line.args;
+};
+
+/**
+ * What a preflight proves for: the command, its arguments with the model
+ * choice taken out (a different model in the same sandbox is the same
+ * environment), and the directory. A review matches on this.
+ */
+const sandboxSignature = (options, lineArgs) => {
+  const args = [];
+  for (let i = 0; i < lineArgs.length; i += 1) {
+    if (lineArgs[i] === "-c" && /^(model|model_reasoning_effort)=/.test(lineArgs[i + 1] ?? "")) {
+      i += 1;
+      continue;
+    }
+    args.push(lineArgs[i]);
+  }
+  return `${options.invocation.command} ${args.join(" ")} @ ${options.cwd} shell:${codexShell}`;
+};
+
+const toolVersion = (command) => {
+  try {
+    return execSync(`${command} --version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
+  } catch {
+    return null;
+  }
+};
+
 /**
  * In live mode the author changes the tree; the tree is the change. The
  * diff of record is git's, over the whole tree, so the digest binds what
@@ -411,16 +530,17 @@ if (mode === "package") {
     const refusal = refusalToContinue(await replay(previous), round);
     if (refusal) die(`refusing to package round ${round}: ${refusal}`);
   }
+  // A continuation is checked at round 0, where it starts; later rounds
+  // carry what round 0 recorded.
+  const { lineage, inherited } = round === 0 ? continuation() : { lineage: previous[0].pkg.lineage ?? [], inherited: previous[0].pkg.inheritedFindings ?? [] };
   const base = flag("base", task.baseCommit);
 
   // What the reviewer does not see was fixed before the exchange: only the
-  // task's generated paths and this package's own outputs may be excluded.
-  const diffExcluded = repeated("diff-exclude");
-  const undeclared = diffExcluded.filter((path) => !generatedPaths.includes(path) && !under(outDir.replace(/\\/g, "/"), path) && !under(path, outDir.replace(/\\/g, "/")));
-  if (undeclared.length > 0) {
-    die(`refusing to package: --diff-exclude names ${undeclared.join(", ")}, which the task's generatedPaths does not declare and which is not the package directory.`);
-  }
-  const isExcluded = (file) => diffExcluded.some((path) => under(file, path));
+  // task's generated paths and this package's own directory may be excluded.
+  const diffExcluded = repeated("diff-exclude").map(normalizeRepoPath);
+  const exclusionProblems = packageExclusionProblems({ excluded: diffExcluded, generatedPaths, outDir, writableScope: task.writableScope });
+  if (exclusionProblems.length > 0) die(`refusing to package: ${exclusionProblems.join("; ")}`);
+  const isExcluded = (file) => diffExcluded.some((path) => under(normalizeRepoPath(file), path));
 
   // The whole tree, not the scoped diff, decides whether the change stayed
   // inside the scope. An untracked file the diff would not show is refused
@@ -443,10 +563,12 @@ if (mode === "package") {
   const guardViolations = guardRuns.filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`);
   const summary = flag("summary", "(no summary supplied; the diff is the record)");
   const pkg = {
-    version: "cross-review-package-v3",
+    version: "cross-review-package-v4",
     taskId: task.taskId,
     round,
     baseCommit: base,
+    lineage,
+    inheritedFindings: inherited,
     changeDigest,
     commit: dirty ? null : commit,
     headCommit: commit,
@@ -455,7 +577,7 @@ if (mode === "package") {
     filesChanged,
     treeFilesChanged: tree.tracked,
     diffExcluded,
-    excludedDigests: excludedDigests(diffExcluded.filter((path) => generatedPaths.includes(path))),
+    excludedDigests: excludedSnapshots(diffExcluded.filter((path) => generatedPaths.includes(path))),
     testResults,
     guardCommands,
     guardRuns,
@@ -465,6 +587,7 @@ if (mode === "package") {
   write(`package-round${round}.json`, `${JSON.stringify(pkg, null, 2)}\n`);
   write(`change-round${round}.diff`, diff);
   write("change.diff", diff);
+  const rounds = [...previous, { round, pkg, verdict: null }];
   write(
     "review-prompt.md",
     renderReviewPrompt({
@@ -478,18 +601,89 @@ if (mode === "package") {
       guardViolations,
       authorSummary: summary,
       authorSelfAssessment: null,
-      previousFindings: round > 0 ? previous[round - 1].verdict.findings : [],
+      ...previousFindingsFor(rounds, round),
     })
   );
-  const exchange = await replay([...previous, { round, pkg, verdict: null }]);
+  const exchange = await replay(rounds);
   write("exchange.json", `${JSON.stringify(exchange, null, 2)}\n`);
   const checks = [...testResults, ...guardRuns];
   console.log(
-    `packaged ${task.taskId} round ${round}: ${filesChanged.length} file(s), digest ${changeDigest}, ${testResults.length} test command(s), ${guardRuns.length} guard rule(s)${checks.every((t) => t.passed) && checks.length > 0 ? "" : " (CHECKS NOT PASSING)"} — ${exchange.status}`
+    `packaged ${task.taskId} round ${round}: ${filesChanged.length} file(s), digest ${changeDigest}, ${testResults.length} test command(s), ${guardRuns.length} guard rule(s)${checks.every((t) => t.passed) && checks.length > 0 ? "" : " (CHECKS NOT PASSING)"}${lineage.length > 0 ? `, continues ${lineage.join(" > ")} with ${inherited.length} inherited finding(s)` : ""} — ${exchange.status}`
   );
   process.exit(0);
 }
 
+// ---------------------------------------------------------------------------
+// preflight: the reviewer's environment, before a review is paid for.
+
+if (mode === "preflight") {
+  const options = buildCli("reviewer", roles.reviewer, authorised ? "live" : "dry-run");
+  const lineArgs = reviewerCommandLine(options);
+  const head = git("rev-parse", "HEAD").trim();
+  const probeName = `preflight-write-probe-${stamp()}.txt`;
+  const probePath = join(outDir, probeName).replace(/\\/g, "/");
+  const prompt = renderPreflightPrompt({ readCommand: "git rev-parse HEAD", probePath });
+  const signature = sandboxSignature(options, lineArgs);
+  console.error(`preflight command: ${[options.invocation.command, ...lineArgs].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
+  console.error(`sandbox signature: ${signature}`);
+  const startedAt = new Date();
+  const result = await cliProbe(options).run(prompt, preflightReportProblems);
+  const durationMs = Date.now() - startedAt.getTime();
+  if (!authorised) {
+    console.log(`${task.taskId} preflight: ${result.failure} — ${result.detail}`);
+    process.exit(2);
+  }
+  const probeExists = existsSync(probePath);
+  if (probeExists) {
+    // Evidence recorded below; the tree is left as it was.
+    unlinkSync(probePath);
+  }
+  // The tool's own output, naming the probe path, is the evidence for the
+  // refusal -- not the reviewer's account of it, and not a refusal of
+  // something else.
+  const evidence = writeRefusalEvidence(lastSpawn?.stdout ?? "", lastSpawn?.stderr ?? "", probePath);
+  const writeRefusalObserved = evidence !== null;
+  const judged = result.ok
+    ? judgePreflight({ report: result.value, expectedReadOutput: head, probeExists, writeRefusalObserved })
+    : { passed: false, problems: [`the reviewer returned no usable report: ${result.failure} — ${result.detail}`, ...(probeExists ? ["the write probe landed"] : [])] };
+  const record = {
+    version: PREFLIGHT_RECORD_VERSION,
+    taskId: task.taskId,
+    reviewer: roles.reviewer,
+    toolVersion: toolVersion(options.invocation.command),
+    command: [options.invocation.command, ...lineArgs],
+    cwd: options.cwd,
+    sandboxSignature: signature,
+    codexShell,
+    codexAuth,
+    expectedReadOutput: head,
+    probePath,
+    probeLanded: probeExists,
+    writeRefusalObserved,
+    writeRefusalEvidence: evidence,
+    startedAt: startedAt.toISOString(),
+    durationMs,
+    usage: extractUsage(lastSpawn?.stdout ?? ""),
+    exitStatus: lastSpawn?.status ?? null,
+    report: result.ok ? result.value : null,
+    executorFailure: result.ok ? null : { failure: result.failure, detail: result.detail },
+    passed: judged.passed,
+    problems: judged.problems,
+  };
+  const name = `preflight-${stamp()}`;
+  write(`${name}.json`, `${JSON.stringify(record, null, 2)}\n`);
+  if (lastSpawn?.stdout) write(`${name}.events.jsonl`, lastSpawn.stdout);
+  if (lastSpawn?.stderr) write(`${name}.stderr.txt`, lastSpawn.stderr);
+  console.log(`${task.taskId} preflight: ${judged.passed ? "PASSED" : "FAILED"}${judged.problems.length > 0 ? ` — ${judged.problems.join("; ")}` : ""}`);
+  process.exit(judged.passed ? 0 : 2);
+}
+
+/** Every preflight recorded under --out, as the gate reads them. */
+const preflightRecords = () =>
+  (existsSync(outDir) ? readdirSync(outDir) : [])
+    .filter((name) => /^preflight-.*\.json$/.test(name))
+    .map((name) => ({ name, ...readJson(join(outDir, name)) }));
+
 // ---------------------------------------------------------------------------
 // review: only the reviewer, on a packaged round.
 
@@ -509,8 +703,7 @@ if (mode === "review") {
   // reading. The two have to be the same change: the tree's diff against
   // the base, scoped and excluded exactly as the package was, must digest to
   // what the package says, and every excluded file must still be what the
-  // package recorded. (HEAD is not the test -- committing the package files
-  // moves HEAD without changing the change.)
+  // package recorded.
   const liveDiff = scopedDiff(current.pkg.baseCommit, current.pkg.diffExcluded ?? []);
   if (digest(liveDiff) !== current.pkg.changeDigest) {
     die(
@@ -518,10 +711,46 @@ if (mode === "review") {
         `the package to ${current.pkg.changeDigest}. Check out the packaged change, or package again.`
     );
   }
-  for (const [path, recorded] of Object.entries(current.pkg.excludedDigests ?? {})) {
-    const now = existsSync(path) ? digestFile(path) : "(missing)";
+  // Every excluded generated path must be what the package recorded --
+  // "absent" included, so a file made after packaging is seen -- and the
+  // package must have recorded each of them.
+  const recordedSnapshots = current.pkg.excludedDigests ?? {};
+  for (const path of (current.pkg.diffExcluded ?? []).filter((entry) => generatedPaths.includes(entry))) {
+    if (!(path in recordedSnapshots)) die(`the package recorded no snapshot of the excluded generated path ${path}. Package again.`);
+  }
+  for (const [path, recorded] of Object.entries(recordedSnapshots)) {
+    const now = snapshot(path);
     if (now !== recorded) die(`the excluded file ${path} is not what the package recorded (${now} vs ${recorded}). Package again.`);
   }
+  // A paid review is not started in a state that cannot pass, unless a
+  // person says so and the record shows it.
+  const failedChecks = [
+    ...current.pkg.testResults.filter((run) => !run.passed).map((run) => `test failed: ${run.command}`),
+    ...(current.pkg.testResults.length === 0 ? ["no test was run"] : []),
+    ...(current.pkg.guardRuns ?? []).filter((run) => !run.passed).map((run) => `guard failed: ${run.rule}`),
+    ...((current.pkg.guardRuns ?? []).length === 0 ? ["no guard was run"] : []),
+  ];
+  const overrides = [];
+  if (failedChecks.length > 0) {
+    if (flag("review-despite-check-failures", "false") !== "true") {
+      die(`refusing to review round ${round}: the package's checks did not pass (${failedChecks.join("; ")}). Fix and package again, or pass --review-despite-check-failures to record a person's decision to review anyway.`);
+    }
+    overrides.push(`review-despite-check-failures: ${failedChecks.join("; ")}`);
+  }
+  const options = buildCli("reviewer", roles.reviewer, authorised ? "live" : "dry-run");
+  const lineArgs = reviewerCommandLine(options);
+  const signature = sandboxSignature(options, lineArgs);
+  console.error(`sandbox signature: ${signature}`);
+  // The newest preflight for this sandbox decides, and it must be a pass
+  // under the current rule; an older pass is not picked past a newer failure.
+  const gate = preflightGate(preflightRecords(), signature, PREFLIGHT_RECORD_VERSION);
+  const preflight = gate.chosen;
+  if (!preflight) {
+    if (flag("skip-preflight", "false") !== "true") {
+      die(`refusing to review round ${round}: ${gate.problems.join("; ")}. Run --mode=preflight first, or pass --skip-preflight to record a person's decision to review without one.`);
+    }
+    overrides.push(`skip-preflight: ${gate.problems.join("; ")}`);
+  }
   const request = {
     task,
     round,
@@ -533,13 +762,12 @@ if (mode === "review") {
     guardViolations: (current.pkg.guardRuns ?? []).filter((run) => !run.passed).map((run) => `${run.rule}: ${run.detail}`),
     authorSummary: current.pkg.changeSummary,
     authorSelfAssessment: null,
-    previousFindings: round > 0 ? rounds[round - 1].verdict.findings : [],
+    ...previousFindingsFor(rounds, round),
   };
   write("review-prompt.md", renderReviewPrompt(request));
-  const options = buildCli("reviewer", roles.reviewer, authorised ? "live" : "dry-run");
-  const line = cliCommandLine(options.invocation, options.configOverrides ?? [], REVIEWER_CONFIG_OVERRIDE_KEYS);
-  if (!line.ok) die(line.detail);
-  console.error(`reviewer command: ${[options.invocation.command, ...line.args].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
+  console.error(`reviewer command: ${[options.invocation.command, ...lineArgs].join(" ")} (prompt on stdin, cwd ${options.cwd}, timeout ${timeoutMs}ms, codex auth: ${codexAuth})`);
+  if (preflight) console.error(`preflight: ${preflight.name} (${preflight.startedAt})`);
+  for (const override of overrides) console.error(`override: ${override}`);
   const startedAt = new Date();
   const result = await cliReviewer(options).review(request);
   const durationMs = Date.now() - startedAt.getTime();
@@ -551,7 +779,11 @@ if (mode === "review") {
     if (authorised) {
       write(
         `review-round${round}.failure.json`,
-        `${JSON.stringify({ round, reviewer: roles.reviewer, command: [options.invocation.command, ...line.args], startedAt: startedAt.toISOString(), durationMs, failure: result.failure, detail: result.detail }, null, 2)}\n`
+        `${JSON.stringify(
+          { round, reviewer: roles.reviewer, command: [options.invocation.command, ...lineArgs], preflight: preflight?.name ?? null, overrides, startedAt: startedAt.toISOString(), durationMs, usage: extractUsage(lastSpawn?.stdout ?? ""), failure: result.failure, detail: result.detail },
+          null,
+          2
+        )}\n`
       );
     }
     console.log(`${task.taskId} round ${round}: reviewer ${result.failure} — ${result.detail}`);
@@ -561,13 +793,20 @@ if (mode === "review") {
     `verdict-round${round}.json`,
     `${JSON.stringify(
       {
-        version: "cross-review-verdict-v1",
+        version: "cross-review-verdict-v2",
         taskId: task.taskId,
         round,
         reviewer: roles.reviewer,
-        command: [options.invocation.command, ...line.args],
+        toolVersion: toolVersion(options.invocation.command),
+        command: [options.invocation.command, ...lineArgs],
+        sandboxSignature: signature,
+        codexShell,
+        codexAuth,
+        preflight: preflight?.name ?? null,
+        overrides,
         startedAt: startedAt.toISOString(),
         durationMs,
+        usage: extractUsage(lastSpawn?.stdout ?? ""),
         receivedAt: new Date().toISOString(),
         verdict: result.value,
       },
diff --git a/scripts/report-router-full-catalog.mjs b/scripts/report-router-full-catalog.mjs
index a377efc7..6e7146e7 100644
--- a/scripts/report-router-full-catalog.mjs
+++ b/scripts/report-router-full-catalog.mjs
@@ -248,10 +248,10 @@ if (summaryOut) {
         decision: fallback.decision,
         firstCandidate: fallback.firstCandidate,
         reachableAsDeployed: fallback.reachableAsDeployed.reachable
-          ? { ...fallback.reachableAsDeployed, undecidedOffline: "see the full report" }
+          ? { ...fallback.reachableAsDeployed, unverifiedConditions: "see the full report" }
           : fallback.reachableAsDeployed,
         reachableIfFlagOn: fallback.reachableIfFlagOn.reachable
-          ? { ...fallback.reachableIfFlagOn, undecidedOffline: "see the full report" }
+          ? { ...fallback.reachableIfFlagOn, unverifiedConditions: "see the full report" }
           : fallback.reachableIfFlagOn,
       },
     })),
diff --git a/tests/automaticFallbackBoundary.test.mjs b/tests/automaticFallbackBoundary.test.mjs
index b81cfd66..f0676445 100644
--- a/tests/automaticFallbackBoundary.test.mjs
+++ b/tests/automaticFallbackBoundary.test.mjs
@@ -1,6 +1,6 @@
 import { strict as assert } from "node:assert";
 import { readFileSync, readdirSync, statSync } from "node:fs";
-import { extname, join, relative } from "node:path";
+import { extname, join, relative, sep } from "node:path";
 import test from "node:test";
 import { fileURLToPath } from "node:url";
 
@@ -176,9 +176,13 @@ test("only the surfaces that offer a choice import the fallback table", () => {
       "renders those candidates for the user to pick from",
   };
 
+  // The allowlist keys are POSIX-shaped literals, so the separator is
+  // normalised once here (the pattern tests/typographyPolicy.test.mjs uses);
+  // unnormalised, a Windows run matched no allowlist entry and failed on the
+  // platform rather than on the rule.
   const importers = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")]
     .filter((file) => read(file).includes("providerFallbackCandidates"))
-    .map((file) => relative(".", file));
+    .map((file) => relative(".", file).split(sep).join("/"));
 
   const unexpected = importers.filter((file) => !(file in ALLOWED));
   assert.deepEqual(
diff --git a/tests/crossReview.test.mjs b/tests/crossReview.test.mjs
index 79b53f3a..d5b1204f 100644
--- a/tests/crossReview.test.mjs
+++ b/tests/crossReview.test.mjs
@@ -1,20 +1,39 @@
 import assert from "node:assert/strict";
+import { execFileSync, spawnSync } from "node:child_process";
 import { createHash } from "node:crypto";
+import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { dirname, join } from "node:path";
 import test from "node:test";
+import { fileURLToPath } from "node:url";
 
 import {
   CROSS_REVIEW_VERSION,
   DEFAULT_MAX_REVISIONS,
   MAX_REVISIONS,
+  MAX_SUPERSESSIONS,
+  PREFLIGHT_RECORD_VERSION,
   authorOutputProblems,
+  escapesRepository,
   filesNamedByDiff,
+  inheritedFindings,
   isActionable,
+  judgePreflight,
+  lineageOf,
+  normalizeRepoPath,
+  packageExclusionProblems,
   parseExecutorJson,
+  preflightGate,
+  preflightReportProblems,
+  renderPreflightPrompt,
   renderReviewPrompt,
   replayExchange,
   resolveMaxRevisions,
   reviewVerdictProblems,
   runCrossReview,
+  supersessionProblems,
+  writeRefusalEvidence,
+  writeRefusalObservedIn,
 } from "../lib/crossReviewCore.ts";
 import {
   CLI_INVOCATIONS,
@@ -23,6 +42,7 @@ import {
   cliAuthor,
   cliCommandLine,
   cliReviewer,
+  extractUsage,
   mockAuthor,
   mockReviewer,
   unwrapClaudeResult,
@@ -347,6 +367,11 @@ test("the reviewer's command-line invocation offers no write tool and nothing fr
   assert.ok(toolsAt !== -1);
   assert.deepEqual(claude.args[toolsAt + 1].split(","), ["Read", "Grep", "Glob"]);
   assert.ok(claude.args.includes("--strict-mcp-config"));
+  // The user's, project's and local customisations -- hooks above all, which
+  // run with the user's full permissions -- do not load. `--safe-mode` keeps
+  // the stored login; `--bare` would not, so it is not the flag used.
+  assert.ok(claude.args.includes("--safe-mode"));
+  assert.ok(!claude.args.includes("--bare"));
   assert.equal(claude.configFlag, undefined);
   // The author keeps its write scope; that is its job.
   assert.ok(CLI_INVOCATIONS.codex.author.args.includes("workspace-write"));
@@ -431,6 +456,45 @@ test("Codex JSONL output is unwrapped to its final agent message; anything else
   assert.equal(unwrapCodexJsonl(JSON.stringify(verdict)), JSON.stringify(verdict));
 });
 
+test("usage is read from whichever shape the tool prints, and is null when it printed neither", () => {
+  const codex = [
+    JSON.stringify({ type: "thread.started", thread_id: "x" }),
+    JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "{}" } }),
+    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 81177, cached_input_tokens: 80128, cache_write_input_tokens: 0, output_tokens: 373, reasoning_output_tokens: 105 } }),
+  ].join("\n");
+  assert.deepEqual(extractUsage(codex), {
+    tool: "codex",
+    inputTokens: 81177,
+    cachedInputTokens: 80128,
+    outputTokens: 373,
+    reasoningOutputTokens: 105,
+    totalCostUsd: null,
+    raw: { input_tokens: 81177, cached_input_tokens: 80128, cache_write_input_tokens: 0, output_tokens: 373, reasoning_output_tokens: 105 },
+  });
+  // Claude Code's --output-format json envelope carries usage and a cost estimate.
+  const claude = JSON.stringify({
+    type: "result",
+    subtype: "success",
+    result: "{}",
+    session_id: "s",
+    total_cost_usd: 0.0123,
+    usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 7 },
+  });
+  assert.deepEqual(extractUsage(claude), {
+    tool: "claude",
+    inputTokens: 10,
+    cachedInputTokens: 5,
+    outputTokens: 7,
+    reasoningOutputTokens: null,
+    totalCostUsd: 0.0123,
+    raw: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5, output_tokens: 7 },
+  });
+  assert.equal(extractUsage(JSON.stringify({ type: "result", result: "{}" })), null, "an envelope without usage reports none");
+  assert.equal(extractUsage("plain text"), null);
+  assert.equal(extractUsage(""), null);
+  assert.equal(extractUsage(JSON.stringify({ type: "thread.started", thread_id: "x" })), null, "a stream with no completed turn reports none");
+});
+
 test("nothing run is a failed check: no test, or no guard, and an approval is not a pass", async () => {
   // No test was run: an empty list is not a passing one.
   const noTests = await runCrossReview(
@@ -651,3 +715,366 @@ test("the revision cap is fixed at two: a run may lower it and cannot raise it",
     RangeError
   );
 });
+
+test("a package may exclude exactly the task's generated paths and exactly its own directory, never a scoped source, a parent of one, a parent or a child of the package, or a path resolved elsewhere", () => {
+  const generatedPaths = ["docs/ops/report/out.md", "docs/ops/report/out.summary.json"];
+  const outDir = "docs/ops/cross-review/packages/demo";
+  const writableScope = ["lib/sum.ts", "lib/other/", "docs/ops/report/", "docs/ops/cross-review/"];
+  const problemsOf = (excluded, overrides = {}) => packageExclusionProblems({ excluded, generatedPaths, outDir, writableScope, ...overrides });
+  const ok = (excluded, overrides) => assert.deepEqual(problemsOf(excluded, overrides), [], excluded.join());
+  ok([]);
+  ok(["docs/ops/report/out.md"]);
+  ok(["docs/ops/report/out.md", "docs/ops/report/out.summary.json"]);
+  ok([outDir]);
+  ok([`${outDir}/`]);
+  // Spelling does not matter: the check, the digest and git all see one path.
+  ok(["docs\\ops\\cross-review\\packages\\demo\\"]);
+  ok(["docs\\ops\\report\\out.md"]);
+  ok(["./docs/ops/report/out.md"]);
+  ok([`${outDir}/../demo`]);
+  ok([`${outDir}/../../../report/out.md`], "resolved, this is a generated path");
+  const refused = (excluded, pattern, overrides) => {
+    const problems = problemsOf(excluded, overrides);
+    assert.equal(problems.length, 1, excluded.join());
+    assert.match(problems[0], pattern);
+  };
+  // A scoped source, or a path that contains one, is never excluded --
+  // whether it is named as a generated path, as the package directory, or
+  // as anything else.
+  refused(["lib/sum.ts"], /writable scope entry lib\/sum\.ts/);
+  refused(["lib"], /writable scope entry lib\/sum\.ts, lib\/other/);
+  refused(["."], /writable scope entry/);
+  refused(["docs/ops/cross-review"], /writable scope entry docs\/ops\/cross-review/);
+  refused(["docs/ops/report/"], /writable scope entry docs\/ops\/report/);
+  refused(["lib/sum.ts"], /writable scope entry/, { generatedPaths: ["lib/sum.ts"] });
+  // `--out=. --diff-exclude=.`, and anything "under" such a package directory.
+  refused(["."], /writable scope entry/, { outDir: "." });
+  refused(["lib/x.ts"], /is under the package directory \./, { outDir: "." });
+  refused(["docs/x"], /is under the package directory docs/, { outDir: "docs" });
+  // The allow list is exact: a file under the package directory is refused
+  // too -- the directory itself is what may be excluded.
+  refused([`${outDir}/verdict-round0.json`], /is under the package directory .*; exclude the package directory itself, not a file under it/);
+  // A parent of the package directory that contains no scope entry is still
+  // refused for what it would hide beside the package.
+  refused(["docs/ops/cross-review/packages"], /contains the package directory/, { writableScope: ["lib/sum.ts"] });
+  refused(["docs/ops"], /contains the package directory/, { writableScope: ["lib/sum.ts"] });
+  // A source file outside the scope, or generated files not declared as such.
+  refused(["lib/z.ts"], /not one of the task's generatedPaths/);
+  refused(["docs/ops/report/other.md"], /not one of the task's generatedPaths/);
+  // The reviewer's reproduction from round 1: `..` written under the package
+  // directory resolves to a file beside it that nothing declared. It is
+  // checked as what it resolves to, and refused -- git would otherwise have
+  // been handed the traversal and dropped the README from the diff.
+  refused(["docs/ops/cross-review/packages/demo/../../README.md"], /not one of the task's generatedPaths/, { generatedPaths: [], writableScope: ["docs/ops/cross-review/"] });
+  refused([`${outDir}/../../README.md`], /not one of the task's generatedPaths/);
+  refused([`${outDir}/../..`], /writable scope entry docs\/ops\/cross-review/);
+  refused([`${outDir}/../../../..`], /writable scope entry/);
+  // Above the repository is not a place anything can be excluded from.
+  refused(["../elsewhere"], /climbs above the repository/);
+  refused([`${outDir}/../../../../../../etc`], /climbs above the repository/);
+  refused([".."], /climbs above the repository/);
+  // A task with no scope may write anywhere, so its scope is the root.
+  refused(["."], /writable scope entry \./, { writableScope: [] });
+  ok([outDir], { writableScope: [] });
+  // Every offending path is named, not just the first.
+  assert.equal(problemsOf(["lib/z.ts", "docs/ops"]).length, 2);
+});
+
+test("normalizeRepoPath gives one spelling to a repository path, `..` resolved, and says when a path climbs above the repository", () => {
+  assert.equal(normalizeRepoPath("docs\\ops\\x.md"), "docs/ops/x.md");
+  assert.equal(normalizeRepoPath("./docs/ops/"), "docs/ops");
+  assert.equal(normalizeRepoPath("  docs/ops//  "), "docs/ops");
+  assert.equal(normalizeRepoPath("."), ".");
+  assert.equal(normalizeRepoPath(""), ".");
+  assert.equal(normalizeRepoPath("docs/ops/../x.md"), "docs/x.md");
+  assert.equal(normalizeRepoPath("docs/ops/./../ops/x.md"), "docs/ops/x.md");
+  assert.equal(normalizeRepoPath("docs/.."), ".");
+  assert.equal(normalizeRepoPath("docs/../../x"), "../x");
+  assert.equal(normalizeRepoPath(".."), "..");
+  assert.equal(normalizeRepoPath("../a/.."), "..");
+  assert.equal(normalizeRepoPath("../../a"), "../../a");
+  for (const escaped of ["..", "../x", "../../a"]) assert.equal(escapesRepository(normalizeRepoPath(escaped)), true, escaped);
+  for (const inside of [".", "docs", "docs/..", "docs/ops/../x.md", "..a", "a.."]) assert.equal(escapesRepository(normalizeRepoPath(inside)), false, inside);
+});
+
+test("a task continues only a concluded exchange, inherits what it left open, and the chain is capped", () => {
+  const open = (overrides = {}) => ({ ...finding(), disposition: "unresolved_on_hold", ...overrides });
+  const prior = {
+    taskId: "T-0",
+    status: "on_hold",
+    findings: [
+      open(),
+      open({ location: "b", basis: "preference", reproduction: undefined, disposition: "resolved_by_project_rule" }),
+      open({ location: "c", disposition: "fix_requested" }),
+    ],
+  };
+  const continuing = { ...task, taskId: "T-1", supersedes: { taskId: "T-0", exchange: "packages/t0/exchange.json" } };
+  assert.deepEqual(supersessionProblems(task, prior), [], "a task without supersedes has nothing to check");
+  assert.deepEqual(supersessionProblems(continuing, prior), []);
+  assert.deepEqual(supersessionProblems(continuing, null), ["packages/t0/exchange.json could not be read"]);
+  assert.match(supersessionProblems(continuing, { ...prior, taskId: "T-9" })[0], /is T-9, not T-0/);
+  for (const status of ["passed", "awaiting_review", "awaiting_revision"]) {
+    assert.match(supersessionProblems(continuing, { ...prior, status })[0], /only an exchange on hold or failed/);
+  }
+  assert.deepEqual(supersessionProblems(continuing, { ...prior, status: "failed" }), []);
+  // The findings it inherits are the open ones, as plain findings the
+  // reviewer of round 0 is shown; a preference already settled is not.
+  assert.deepEqual(
+    inheritedFindings(prior).map((f) => [f.location, "disposition" in f]),
+    [["lib/sum.ts:1", false], ["c", false]]
+  );
+  // Lineage: the prior's, then the prior. Two continuations are the cap.
+  assert.deepEqual(lineageOf(prior), ["T-0"]);
+  assert.deepEqual(lineageOf({ ...prior, lineage: ["T-a"] }), ["T-a", "T-0"]);
+  assert.equal(MAX_SUPERSESSIONS, 2);
+  assert.deepEqual(supersessionProblems(continuing, { ...prior, lineage: ["T-a"] }), []);
+  assert.match(supersessionProblems(continuing, { ...prior, lineage: ["T-a", "T-b"] })[0], /the cap is 2/);
+});
+
+test("the preflight asks for a read and a write, and passes only on the read the control program expects and a write that did not land", () => {
+  const prompt = renderPreflightPrompt({ readCommand: "git rev-parse HEAD", probePath: "out/probe.txt" });
+  assert.match(prompt, /This is not a review/);
+  assert.match(prompt, /git rev-parse HEAD/);
+  assert.match(prompt, /out\/probe\.txt/);
+  assert.match(prompt, /do not retry/);
+  // The write is asked for as one shell command naming the path, so the
+  // tool's record of the attempt carries the path; a patch tool's refusal
+  // would not.
+  assert.match(prompt, /ONE shell command that names that exact path/);
+  assert.match(prompt, /Set-Content -LiteralPath 'out\/probe\.txt' -Value probe/);
+  assert.match(prompt, /printf probe > 'out\/probe\.txt'/);
+  assert.match(prompt, /not a patch or file-editing tool/);
+  assert.deepEqual(preflightReportProblems({ readOutput: "abc", writeAttempted: true, writeResult: "denied" }), []);
+  assert.ok(preflightReportProblems({ readOutput: 1, writeAttempted: "yes" }).length >= 3);
+  assert.ok(preflightReportProblems("nope").length >= 1);
+  const report = { readOutput: "abc123\n", writeAttempted: true, writeResult: "EACCES: permission denied" };
+  const judge = (overrides = {}) => judgePreflight({ report, expectedReadOutput: "abc123", probeExists: false, writeRefusalObserved: true, ...overrides });
+  assert.deepEqual(judge(), { passed: true, problems: [] });
+  // The reviewer's own account of the write is not the evidence; the file
+  // is, and so is the tool's own output showing the refusal.
+  const landed = judge({ report: { ...report, writeResult: "denied" }, probeExists: true });
+  assert.equal(landed.passed, false);
+  assert.match(landed.problems[0], /write probe landed/);
+  const unobserved = judge({ writeRefusalObserved: false });
+  assert.equal(unobserved.passed, false);
+  assert.match(unobserved.problems[0], /shows no refused write/);
+  // A report that says the write was done fails even with no probe: it went
+  // somewhere else, or it is not describing what happened.
+  for (const claim of ["written", "File created successfully", "wrote 5 bytes", "success"]) {
+    const done = judge({ report: { ...report, writeResult: claim } });
+    assert.equal(done.passed, false, claim);
+    assert.match(done.problems[0], /reports the write as done/);
+  }
+  // A read that produced something else (an error, a refusal) fails.
+  const blind = judge({ report: { ...report, readOutput: "execution error: sandbox refused" } });
+  assert.equal(blind.passed, false);
+  assert.match(blind.problems[0], /did not produce the expected output/);
+  // A write never attempted shows nothing about writes.
+  assert.equal(judge({ report: { ...report, writeAttempted: false } }).passed, false);
+  assert.equal(judge({ expectedReadOutput: "  " }).passed, false);
+
+  // What counts as the tool's own evidence of a refused write: a refusal
+  // the tool reported *at the probe path*, in either spelling. Anything
+  // that names no path, or another path, shows something else was refused.
+  const probe = "docs/ops/pkg/preflight-write-probe-2026-09-09T10-52-47-175Z.txt";
+  const item = (type, fields) => JSON.stringify({ type: "item.completed", item: { id: "i", type, ...fields } });
+  const deniedAt = (path) =>
+    item("command_execution", {
+      command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Set-Content -LiteralPath ''${path}'' -Value probe'`,
+      aggregated_output: `Set-Content : Access to the path '${path}' is denied.\nAt line:1 char:1`,
+      exit_code: 1,
+      status: "failed",
+    });
+  assert.match(writeRefusalEvidence(deniedAt(probe), "", probe), /^command_execution .*Access to the path .* is denied/);
+  assert.equal(writeRefusalObservedIn(deniedAt(probe), "", probe), true);
+  assert.equal(writeRefusalObservedIn(deniedAt(`H:\\Project\\repo\\${probe.replace(/\//g, "\\")}`), "", probe), true, "an absolute Windows spelling names the same probe");
+  assert.equal(writeRefusalObservedIn(item("command_execution", { command: `printf probe > '${probe}'`, aggregated_output: `sh: ${probe}: Read-only file system`, exit_code: 1, status: "failed" }), "", probe), true);
+  // The reviewer's reproduction from round 1: a denial of some other file
+  // is not evidence about the probe, and the preflight fails on it.
+  const other = item("command_execution", { command: "Set-Content other.txt", aggregated_output: "Access is denied", status: "failed" });
+  assert.equal(writeRefusalEvidence(other, "", probe), null);
+  const onOther = judgePreflight({
+    report: { readOutput: "abc", writeAttempted: true, writeResult: "denied" },
+    expectedReadOutput: "abc",
+    probeExists: false,
+    writeRefusalObserved: writeRefusalObservedIn(other, "", probe),
+  });
+  assert.equal(onOther.passed, false);
+  assert.match(onOther.problems[0], /no refused write at the probe path/);
+  // Codex's own "patch rejected" line names no path: something was refused,
+  // not shown to be the probe. A stderr line that names the probe counts.
+  assert.equal(writeRefusalObservedIn("", "2026-09-09T10:53:04Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox", probe), false);
+  assert.match(writeRefusalEvidence("", `error: cannot write ${probe}: permission denied`, probe), /^stderr: /);
+  assert.equal(writeRefusalObservedIn(item("error", { message: `patch rejected: ${probe}: writing is blocked by read-only sandbox` }), "", probe), true);
+  assert.equal(writeRefusalObservedIn(item("error", { message: "patch rejected: writing is blocked by read-only sandbox" }), "", probe), false);
+  assert.equal(writeRefusalObservedIn(item("file_change", { status: "failed", changes: [{ path: probe, kind: "add" }] }), "", probe), true);
+  assert.equal(writeRefusalObservedIn(item("file_change", { status: "failed", changes: [{ path: "other.txt", kind: "add" }] }), "", probe), false);
+  assert.equal(writeRefusalObservedIn(item("file_change", { status: "completed", changes: [{ path: probe, kind: "add" }] }), "", probe), false, "a completed change is a write, not a refusal");
+  assert.equal(writeRefusalObservedIn(JSON.stringify({ type: "result", result: "no", permission_denials: [{ tool_name: "Write", tool_input: { file_path: probe } }] }), "", probe), true);
+  assert.equal(writeRefusalObservedIn(JSON.stringify({ type: "result", result: "no", permission_denials: [{ tool_name: "Write", tool_input: { file_path: "other.txt" } }] }), "", probe), false);
+  assert.equal(writeRefusalObservedIn(item("command_execution", { command: `Set-Content ${probe}`, aggregated_output: "", exit_code: 0, status: "completed" }), "", probe), false, "a command at the probe that was not refused is not a refusal");
+  assert.equal(writeRefusalObservedIn(item("agent_message", { text: `the write to ${probe} was denied` }), "", probe), false, "the reviewer's own words do not count");
+  assert.equal(writeRefusalObservedIn(deniedAt(probe), "", "."), false, "no probe path, no evidence");
+  assert.equal(writeRefusalObservedIn("", "", probe), false);
+});
+
+test("a review starts only on the newest preflight for its sandbox, and only when that one passed under the current rule", () => {
+  const sig = "codex --sandbox read-only exec --ignore-user-config --json - @ /repo shell:default";
+  const record = (name, startedAt, passed, overrides = {}) => ({
+    name,
+    version: PREFLIGHT_RECORD_VERSION,
+    sandboxSignature: sig,
+    startedAt,
+    passed,
+    problems: passed ? [] : ["the write probe landed: the reviewer can write to the working tree"],
+    ...overrides,
+  });
+  const older = record("preflight-a.json", "2026-09-09T10:00:00.000Z", true);
+  const newerFailed = record("preflight-b.json", "2026-09-09T11:00:00.000Z", false);
+  assert.deepEqual(preflightGate([older], sig), { chosen: older, problems: [] });
+  // The reviewer's reproduction from round 1: an older pass is not picked
+  // past a newer failure, whatever order the records are read in.
+  for (const records of [[older, newerFailed], [newerFailed, older]]) {
+    const gate = preflightGate(records, sig);
+    assert.equal(gate.chosen, null);
+    assert.match(gate.problems[0], /newest preflight for this sandbox, preflight-b\.json \(2026-09-09T11:00:00\.000Z\), FAILED: the write probe landed/);
+    assert.match(gate.problems[0], /run --mode=preflight again/);
+  }
+  const newest = record("preflight-c.json", "2026-09-09T12:00:00.000Z", true);
+  assert.equal(preflightGate([older, newerFailed, newest], sig).chosen, newest);
+  // A record of another sandbox is not this sandbox's evidence.
+  assert.match(preflightGate([record("preflight-d.json", "2026-09-09T13:00:00.000Z", true, { sandboxSignature: "other" })], sig).problems[0], /no preflight is recorded for this sandbox signature/);
+  assert.match(preflightGate([], sig).problems[0], /no preflight is recorded/);
+  // A pass judged under an earlier rule proved what that rule asked, not
+  // what this one does.
+  const earlierRule = record("preflight-e.json", "2026-09-09T14:00:00.000Z", true, { version: "cross-review-preflight-v1" });
+  const stale = preflightGate([older, newest, earlierRule], sig);
+  assert.equal(stale.chosen, null);
+  assert.match(stale.problems[0], /preflight-e\.json, was judged under cross-review-preflight-v1, not the current cross-review-preflight-v2/);
+  assert.equal(PREFLIGHT_RECORD_VERSION, "cross-review-preflight-v2");
+});
+
+// The script's own package and review paths, run in a repository made for
+// the purpose. What these hold is what the reviewer of round 1 asked to see
+// held end to end: exclusions are an exact allow list after `..` resolves,
+// an absent generated file is recorded as absent and noticed when it
+// appears, and the newest preflight for the sandbox decides whether a
+// review may start.
+const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
+const runScript = (cwd, args) => {
+  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), join(repoRoot, "scripts", "cross-review.mjs"), ...args], {
+    cwd,
+    encoding: "utf8",
+    env: { ...process.env, TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.json") },
+    windowsHide: true,
+  });
+  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
+};
+
+test("the script's package and review paths hold the rules end to end: exact exclusions, absent snapshots, and the newest preflight", { timeout: 180_000 }, () => {
+  const work = mkdtempSync(join(tmpdir(), "cross-review-script-"));
+  try {
+    const repo = join(work, "repo");
+    mkdirSync(join(repo, "src"), { recursive: true });
+    mkdirSync(join(repo, "reports"), { recursive: true });
+    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" }).trim();
+    git("init", "-q");
+    git("config", "core.autocrlf", "false");
+    writeFileSync(join(repo, "src", "a.txt"), "a\n");
+    writeFileSync(join(repo, "reports", "generated.md"), "g\n");
+    git("add", "-A");
+    git("commit", "-q", "-m", "base");
+    const base = git("rev-parse", "HEAD");
+    const taskFile = join(work, "task.json");
+    writeFileSync(
+      taskFile,
+      JSON.stringify({
+        taskId: "T-script",
+        requirement: "r",
+        completionCriteria: ["c"],
+        baseCommit: base,
+        writableScope: ["src/", "reports/", "artifacts/"],
+        generatedPaths: ["reports/generated.md", "reports/absent.md"],
+      })
+    );
+    writeFileSync(join(repo, "src", "a.txt"), "b\n");
+    writeFileSync(join(repo, "reports", "generated.md"), "g2\n");
+    const common = [`--task=${taskFile}`, "--out=artifacts/pkg", "--round=0"];
+    const excludes = ["--diff-exclude=reports/generated.md", "--diff-exclude=reports/absent.md", "--diff-exclude=artifacts/pkg"];
+    const checks = ["--test-command=true", "--guard-command=true"];
+    const pkg = (extra) => runScript(repo, ["--mode=package", ...common, ...checks, ...extra]);
+    const packageRecord = join(repo, "artifacts", "pkg", "package-round0.json");
+
+    // Exclusions are an exact allow list, after `..` is resolved.
+    const traversal = pkg([...excludes, "--diff-exclude=artifacts/pkg/../../src"]);
+    assert.equal(traversal.status, 1, traversal.stderr);
+    assert.match(traversal.stderr, /refusing to package: .*writable scope entry src/);
+    const above = pkg([...excludes, "--diff-exclude=../elsewhere"]);
+    assert.equal(above.status, 1, above.stderr);
+    assert.match(above.stderr, /climbs above the repository/);
+    const underOut = pkg([...excludes, "--diff-exclude=artifacts/pkg/review-prompt.md"]);
+    assert.equal(underOut.status, 1, underOut.stderr);
+    assert.match(underOut.stderr, /is under the package directory artifacts\/pkg/);
+    assert.equal(existsSync(packageRecord), false, "nothing was packaged");
+
+    // The package records what each excluded generated path is, absence included.
+    const packaged = pkg([...excludes, "--summary=round 0"]);
+    assert.equal(packaged.status, 0, packaged.stderr);
+    const record = JSON.parse(readFileSync(packageRecord, "utf8"));
+    assert.match(record.excludedDigests["reports/generated.md"], /^sha256:[0-9a-f]{64}$/);
+    assert.equal(record.excludedDigests["reports/absent.md"], "absent");
+    assert.deepEqual(record.diffExcluded, ["reports/generated.md", "reports/absent.md", "artifacts/pkg"]);
+    assert.match(record.diff, /src\/a\.txt/);
+    assert.doesNotMatch(record.diff, /generated\.md/);
+    assert.equal(record.testResults[0].passed, true);
+    assert.equal(record.guardRuns[0].passed, true);
+
+    // The reviewer's reproduction from round 1: a generated file that did not
+    // exist at packaging appears before the review. The review refuses; so
+    // does a changed one. With the tree as packaged, both checks pass.
+    const review = (extra) => runScript(repo, ["--mode=review", ...common, ...extra]);
+    writeFileSync(join(repo, "reports", "absent.md"), "made after packaging\n");
+    const appeared = review(["--skip-preflight"]);
+    assert.equal(appeared.status, 1, appeared.stderr);
+    assert.match(appeared.stderr, /reports\/absent\.md is not what the package recorded \(sha256:[0-9a-f]{64} vs absent\)/);
+    rmSync(join(repo, "reports", "absent.md"));
+    writeFileSync(join(repo, "reports", "generated.md"), "g3\n");
+    const changed = review(["--skip-preflight"]);
+    assert.equal(changed.status, 1, changed.stderr);
+    assert.match(changed.stderr, /reports\/generated\.md is not what the package recorded \(sha256:[0-9a-f]{64} vs sha256:[0-9a-f]{64}\)/);
+    writeFileSync(join(repo, "reports", "generated.md"), "g2\n");
+
+    // The newest preflight for the sandbox decides. With none the review is
+    // refused by name; the reviewer's reproduction -- an older pass and a
+    // newer failure -- is refused; a pass under an older rule is refused;
+    // a newer pass lets the review reach the reviewer, which in dry-run
+    // stops there, not executed.
+    const none = review([]);
+    assert.equal(none.status, 1, none.stderr);
+    assert.match(none.stderr, /refusing to review round 0: no preflight is recorded for this sandbox signature/);
+    const signature = /^sandbox signature: (.+)$/m.exec(none.stderr)?.[1];
+    assert.ok(signature, none.stderr);
+    const preflight = (name, startedAt, passed, overrides = {}) =>
+      writeFileSync(
+        join(repo, "artifacts", "pkg", `${name}.json`),
+        JSON.stringify({ version: PREFLIGHT_RECORD_VERSION, sandboxSignature: signature, startedAt, passed, problems: passed ? [] : ["the write probe landed"], ...overrides })
+      );
+    preflight("preflight-2026-01-01T00-00-00-000Z", "2026-01-01T00:00:00.000Z", true);
+    preflight("preflight-2026-01-02T00-00-00-000Z", "2026-01-02T00:00:00.000Z", false);
+    const newerFailed = review([]);
+    assert.equal(newerFailed.status, 1, newerFailed.stderr);
+    assert.match(newerFailed.stderr, /newest preflight for this sandbox, preflight-2026-01-02T00-00-00-000Z\.json \(2026-01-02T00:00:00\.000Z\), FAILED: the write probe landed/);
+    preflight("preflight-2026-01-03T00-00-00-000Z", "2026-01-03T00:00:00.000Z", true, { version: "cross-review-preflight-v1" });
+    const earlierRule = review([]);
+    assert.equal(earlierRule.status, 1, earlierRule.stderr);
+    assert.match(earlierRule.stderr, /judged under cross-review-preflight-v1/);
+    preflight("preflight-2026-01-04T00-00-00-000Z", "2026-01-04T00:00:00.000Z", true);
+    const reached = review([]);
+    assert.equal(reached.status, 2, reached.stderr);
+    assert.match(reached.stderr, /preflight: preflight-2026-01-04T00-00-00-000Z\.json \(2026-01-04T00:00:00\.000Z\)/);
+    assert.match(reached.stdout, /T-script round 0: reviewer not_executed/);
+    assert.equal(existsSync(join(repo, "artifacts", "pkg", "verdict-round0.json")), false, "a dry-run leaves no verdict");
+  } finally {
+    rmSync(work, { recursive: true, force: true });
+  }
+});
diff --git a/tests/routerFullCatalogDiagnostic.test.mjs b/tests/routerFullCatalogDiagnostic.test.mjs
index b9793be2..78689221 100644
--- a/tests/routerFullCatalogDiagnostic.test.mjs
+++ b/tests/routerFullCatalogDiagnostic.test.mjs
@@ -4,7 +4,7 @@ import test from "node:test";
 import { decideRouterModel } from "../lib/routerDecision.ts";
 import {
   diagnoseFullCatalog,
-  FALLBACK_UNDECIDED_OFFLINE,
+  FALLBACK_UNVERIFIED_CONDITIONS,
   fallbackReachabilityFor,
   ROUTER_FULL_CATALOG_DIAGNOSTIC_VERSION,
 } from "../lib/routerFullCatalogDiagnostic.ts";
@@ -209,12 +209,12 @@ test("fallback is reachable only when the gate, the product's own decision and d
   assert.equal(item.fallback.reachableIfFlagOn.reachable, true);
   assert.equal(item.fallback.reachableIfFlagOn.modelId, first);
   // A reachable answer carries what only a real dispatch could still refuse.
-  assert.deepEqual(item.fallback.reachableIfFlagOn.undecidedOffline, FALLBACK_UNDECIDED_OFFLINE);
-  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("search_path_unavailable")));
-  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("budget_refused")));
-  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("candidate_unavailable")));
-  assert.ok(FALLBACK_UNDECIDED_OFFLINE.some((line) => line.startsWith("no_provider_hold")));
-  assert.ok(item.fallback.notModelled.length > FALLBACK_UNDECIDED_OFFLINE.length);
+  assert.deepEqual(item.fallback.reachableIfFlagOn.unverifiedConditions, FALLBACK_UNVERIFIED_CONDITIONS);
+  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("search_path_unavailable")));
+  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("budget_refused")));
+  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("candidate_unavailable")));
+  assert.ok(FALLBACK_UNVERIFIED_CONDITIONS.some((line) => line.startsWith("no_provider_hold")));
+  assert.ok(item.fallback.notModelled.length > FALLBACK_UNVERIFIED_CONDITIONS.length);
   assert.equal(report.inputs.fallbackFlagAsDeployed, "off");
   assert.equal(report.summary.fallbackReachableAsDeployed["gate:flag_off"], 2);
   assert.equal(report.summary.fallbackReachableIfFlagOn.reachable, 2);
@@ -257,13 +257,22 @@ test("fallback is reachable only when the gate, the product's own decision and d
   assert.deepEqual(fallbackReachabilityFor({ allowed: true }, terminated, fitted), { reachable: false, refusal: "decision:visible_token_emitted" });
   assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, null), { reachable: false, refusal: "decision:mid is not the candidate dispatch was asked to fit" });
   assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, exceeded), { reachable: false, refusal: "candidate_context_window_exceeded" });
-  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, fitted), { reachable: true, ...fitted, undecidedOffline: FALLBACK_UNDECIDED_OFFLINE });
+  // Reachable offline is never "executable": the answer says so itself.
+  assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, fitted), {
+    reachable: true,
+    ...fitted,
+    execution: "unverified",
+    unverifiedConditions: FALLBACK_UNVERIFIED_CONDITIONS,
+  });
   assert.deepEqual(fallbackReachabilityFor({ allowed: true }, named, { ...fitted, dispatchFit: "unbounded" }), {
     reachable: true,
     ...fitted,
     dispatchFit: "unbounded",
-    undecidedOffline: FALLBACK_UNDECIDED_OFFLINE,
+    execution: "unverified",
+    unverifiedConditions: FALLBACK_UNVERIFIED_CONDITIONS,
   });
+  assert.equal(item.fallback.reachableIfFlagOn.execution, "unverified");
+  assert.ok(!JSON.stringify(report.items[0].fallback).includes('"executable"'));
 });
 
 test("improvement candidates name the reachability gap and the never-chosen models with fixed identifiers", () => {

```

## Test results (run by the control program)

- PASS `set -o pipefail; node --import tsx --test tests/routerFullCatalogDiagnostic.test.mjs tests/crossReview.test.mjs tests/routerDecision.test.mjs tests/routerCandidates.test.mjs tests/routerSelection.test.mjs tests/routerScorePolicy.test.mjs tests/autoFallbackGate.test.mjs tests/automaticFallbackBoundary.test.mjs 2>&1 | grep -E '^# (tests|pass|fail)'` (3110ms)
  # tests 124
  # pass 124
  # fail 0

## Guard results (run by the control program)

- PASS `npm run check:doc-references` (1313ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 751 referenced path(s) across 92 instruction document(s), and 869 path(s) named by comments across 2592 source file(s), all present.
- PASS `npm run check:release-gate-coverage` (564ms)
  > ai-chat-hub@0.1.0 check:release-gate-coverage
  > node scripts/check-release-gate-coverage.mjs
  
  Release gate coverage check passed: 51 CI-enforced and 3 manually gated check(s), all named in the release checklist.
- PASS `npm run security:regression` (630ms)
  > ai-chat-hub@0.1.0 security:regression
  > node scripts/security-regression-check.mjs
  
  Security regression checks passed (188 checks).

## Findings from the previous round (check each was addressed)

- [error/evidence] lib/crossReviewCore.ts:normalizeRepoPath, packageExclusionProblems: 출력 디렉터리의 임의 하위 경로를 허용하면서 `..`를 정규화하거나 거부하지 않아, 패키지 디렉터리 아래처럼 작성한 path traversal로 scoped source를 review diff에서 숨길 수 있습니다.
- [error/evidence] scripts/cross-review.mjs:excludedDigests, review excluded-file verification: 패키징 시 존재하지 않는 excluded generated file은 상태가 기록되지 않아, 패키징 후 생성되어도 review가 변경을 감지하지 못합니다.
- [error/evidence] lib/crossReviewCore.ts:writeRefusalObservedIn, judgePreflight: write-refusal 증거를 probe path와 연결하지 않아 다른 파일이나 도구의 permission denial만 있어도 reviewer의 writeAttempted 주장과 결합해 preflight가 통과합니다.
- [error/evidence] scripts/cross-review.mjs:passingPreflight: 동일 sandbox signature의 더 최신 preflight가 실패해도 실패 기록을 먼저 제거하고 과거의 성공 기록을 선택하므로 review가 환경 실패 뒤에도 시작됩니다.

## Author's account (read last; a claim, not a finding)

Summary: Round 2 answers the four round-1 findings. (1) Exclusions are an exact allow list after .. resolves: normalizeRepoPath resolves . and .. segments and reports a path that climbs above the repository; packageExclusionProblems accepts only a path that is exactly a generated path or exactly the package directory, and refuses a file under the package directory, a parent of it, a path above the repository and any scoped source. The reviewer's reproduction (out/../../README.md) is checked as the README.md it resolves to and refused; held by test at the core and through the script. (2) Absence is recorded: every excluded generated path is snapshotted at packaging as its content digest, a tree digest or the word absent; the review requires a record for each and compares it, so a file that appeared, changed or disappeared since packaging is refused. Held by a test that runs the script's package and review paths in a repository made for it, with the reviewer's reproduction. (3) A refused write is evidence only at the probe path: the preflight prompt asks for one shell command naming the probe path, writeRefusalEvidence counts only a refusal the tool reported at that path (a command naming it whose output says it was denied, a failed file change there, a permission denial naming it, a stderr line naming it), and the tool's own pathless patch-rejected line does not. The evidence is written into the record, whose version is now cross-review-preflight-v2, and a review accepts only records of the current version, so the 10:53 pass, which rested on the pathless line, is not reused and a new preflight precedes this review. (4) The newest preflight decides: preflightGate takes the newest record for the sandbox signature and requires it to be a pass under the current rule; none, a newer failure or an older rule each refuse, an older pass is never picked past a newer failure, and --skip-preflight records the reason it overrode; held by test at the core and through the script. Test set 124 of 124, guard rules 3 of 3 on this checkout. No routing behaviour, score, flag or pre-registration changed.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "router-full-catalog-diagnostic-v2",
  "round": 2,
  "reviewedDigest": "sha256:e8f9d8359e4b367bdfe3ccaf6079eab454b6208e565727221ad873bf411ff9c8",
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
