# Independent review — task router-development-collector-cache-observation-fix, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Review the minimal collector CI follow-up discovered on PR #1319 at source 886ea27f852a7d00c6cccbba26ec0002f2086d16: explicitly retain cacheWriteTokens=null next to the Google cache-read observation and add an offline mock regression proving non-allowlisted raw fields and SDK-normalized fields cannot fill unknown writes, uncached input or estimated cost. This preserves the existing unknown/null behavior; it is not evidence of historical paid underbilling and does not add a provider observation. Implementation is limited to the two provider source/test files; this task and its receipt are review instructions and authorization provenance only. Use a new digest-bound Codex-author/Claude-reviewer exchange for this newly discovered CI issue, with at most two fix rounds and no supersedes. Keep the completed collector review and all original records unchanged. The user's fresh limited permission allows --skip-preflight only for the announced read-only review of this fix, not failed-test/CI overrides, API-billing fallback or paid benchmark execution. Authoring these records performs no commit, package, review, push or merge.

## Completion criteria

- The eventual clean review commit differs from exact base 886ea27f852a7d00c6cccbba26ec0002f2086d16 only in the four listed paths. The initial implementation patch is two files, +33/-1: an explicit Google cacheWriteTokens=null assignment/comment and one provider mock regression plus its import. Do not broaden the runtime fix, replace null with zero, infer no-cache usage, change raw allowlists, or change model caps/settings/pricing. Any requested revision stays within this bounded purpose and is separately verified.
- The regression observes cachedContentTokenCount from the existing Google raw-body allowlist while preserving cacheWriteTokens=null, noCacheInputTokens=null and estimateCollectionUsageCost=null despite adversarial non-allowlisted raw fields and SDK-normalized nonzero cache-write fields. It uses MockLanguageModelV4 without credentials or network and verifies one mock generation. No production provider call, additional raw-body persistence or synthetic provider usage is introduced.
- Run the entire collector suite with npm run test:router-development-collector and record the actual result (currently 80 tests), with zero failures/skips. Also run the exact CI regression named 'every place that harvests cacheReadTokens harvests cacheWriteTokens too' in tests/anthropicPromptCachingWiring.test.mjs through the existing react-server/tsx serial Node test invocation. Assert that this exact named case actually executed and passed (one executed target, one pass, zero failures); exit 0 with zero matched tests is not a pass. Report intentionally deselected tests separately; filtering is not a full-wiring-suite pass. Preserve the reported whole-wiring local result of 11/12, exit 1, and its pre-existing Windows path-separator failure, which was also present before this patch. Do not edit the scanner, test runner or workflow or use --review-despite-check-failures. The Linux full CI suite must pass on the actual subsequently published head before merge; a local full-unit run has not been completed and cannot be claimed from targeted checks.
- Official npm run typecheck, lint of both changed implementation/test files, check:encoding, check:doc-references, check:policy-section-references, check:model-pricing, check:router-quality-eval, check:router-context-window and check:context-window-register pass with actual commands/results recorded. Verify the four-path diff and handwritten whitespace, and preserve all other source and historical-record bytes. Supplied author summaries are not raw logs or independently rerun checks; package-stage test and guard results must come from genuine executions without failure overrides.
- Preserve the original collector task/receipt, its canonical 28-file archive and active 21-file passed exchange, the original v1 records, corpus/grader/planner, reservation/journal/export behavior, product client and policy, pricing/registry/credits, caps/settings, package/lock, processing-tier guard, cross-review controller and workflows. The previous passed review remains concluded on its own digest; it does not approve this patch and is not reopened or reset. The source-886 60-call pilot proposal remains a historical unapproved draft and must be regenerated after final source/merge before any separate numerical human execution approval.
- Only after separate orchestrator go, package round 0 using the unchanged control program, author codex, reviewer claude, exact base and full four-path diff, with output artifacts/cross-review/router-development-collector-cache-observation-fix. generatedPaths is empty and no --diff-exclude arguments are permitted. Use the existing ignored artifacts location without changing ignore/scope/controller rules. Record a newly computed source digest and actual checks; packaging is not a reviewer verdict. Do not move or overwrite earlier exchanges.
- Announce independent review before invocation and wait for its separate go. Retain the existing Claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config configuration, with no shell/write tools, model override or expanded MCP access. In the review child environment only, remove every case spelling of ANTHROPIC_API_KEY, retain stored claude.ai login, and allow Git/bin on the existing PATH solely for shell availability. Observe sanitized login status before invocation; no login means stop, not API fallback. Keep parent/persistent environment unchanged. Record --skip-preflight as a skip, never a passed preflight. At most two fix rounds apply; unresolved actionable findings at the cap mean on_hold, not a new exchange or revision-cap override.
- This task/receipt does not certify tests, a package, an independent verdict, a new CI pass, a push or a merge. Keep the author-reported pre-patch local wiring result 10/12 and post-patch 11/12 distinct from the Linux CI result at source 886 (8,436 tests: 8,434 pass, one fail, one skip) and from future actual checks. Commit, package, reviewer invocation, push and merge each require their separate applicable go. No paid collector/provider run, API-billing switch, main merge, deployment, model ranking or quality promotion is authorized.

## Change under review — digest sha256:ba44bb1c84ef0f9c95d04ae947a5991f79f18a14b10664022c156d94a51108cf, commit 34a179fd1986afbb2909cc38b0fa988814e5aa0e

```diff
diff --git a/docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.authorization.md b/docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.authorization.md
new file mode 100644
index 00000000..48c9a4af
--- /dev/null
+++ b/docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.authorization.md
@@ -0,0 +1,116 @@
+# Limited Claude review authorization — collector cache-observation CI fix
+
+Recorded by Codex on `2026-09-10` after reading the current conversation's
+authorization. This is a receipt date, not an asserted timestamp of the user
+messages, a signature, a preflight result or a reviewer execution.
+
+## Fresh permission and exact scope
+
+The immediately preceding user-facing question was:
+
+> CI 수정 2파일의 새 Claude 읽기 전용 검토에도 기존 --skip-preflight 예외를 허용하시겠어요? 종료된 검토 기록은 보존하고 새 기록으로 검토합니다. 테스트·CI 우회, API 과금 전환, 유료 벤치마크 실행은 포함하지 않습니다.
+
+The user responded:
+
+> 승인합니다
+
+This new permission applies only to the announced read-only Claude review of
+the two-file CI fix, through
+[router-development-collector-cache-observation-fix](router-development-collector-cache-observation-fix.task.json).
+Its base is `886ea27f852a7d00c6cccbba26ec0002f2086d16`; its four scoped paths
+are the provider source/test pair and this task/receipt pair. The documents
+are provenance and instructions, not additional runtime implementation.
+
+This is a new CI issue discovered after the earlier collector exchange
+concluded. There is no `supersedes`, prior-verdict reuse, history reset or
+revision-cap increase. Preserve the original task, canonical 28-file archive,
+active 21-file passed exchange and original v1 records byte-for-byte. The new
+output is `artifacts/cross-review/router-development-collector-cache-observation-fix`,
+using the existing ignore rule, `generatedPaths: []` and zero diff exclusions.
+
+## Boundaries retained
+
+- The orchestrator already announced the need for this new independent
+  review. Actual invocation still awaits its separate go and successful
+  required local checks. Authoring this receipt is not invocation authority
+  for the current documentation step.
+- Use the unchanged controller with author Codex and reviewer Claude. Keep
+  `claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`,
+  with no shell/write tools, model override or extra MCP access.
+- `--skip-preflight` is a recorded skip only. It does not demonstrate a
+  passed preflight, refused write probe or human source-code inspection.
+  `--review-despite-check-failures` and test/CI bypasses are prohibited.
+- Before an authorized invocation, remove `ANTHROPIC_API_KEY` in every case
+  spelling only from the child environment copy and observe sanitized
+  stored `claude.ai` login status. Preserve parent/persistent environment and
+  login configuration. Child-only Git/bin PATH availability is allowed;
+  `--bare`, API-billing fallback and secret output are not. Missing login
+  stops the review. This receipt is not an auth-status observation.
+- At most two fix rounds apply to the new exchange. At the cap, actionable
+  findings require `on_hold`, not another exchange or an override.
+- No paid benchmark execution, provider probe, API-billing switch, main
+  merge, deployment, model-quality claim or policy/pricing change is
+  authorized. The existing 60-call source-886 proposal remains unapproved;
+  future paid collection needs a regenerated final-source manifest and its
+  own exact numerical/digest-bound human approval.
+- Commit, packaging, actual review, push and merge each await separate go.
+  No result or future CI success is manufactured by this permission.
+
+## Historical round-0 evidence, not current-round certification
+
+These observations concern the original two-file +33/-1 implementation at
+`dcabb4e3e130781de5819d2639ea4ab0e7f0df0f`, not a later revision. The original
+receipt and its initial hash table remain in that Git commit and the immutable
+round-0 diff. The fixed source is addressable with
+`git show dcabb4e3e130781de5819d2639ea4ab0e7f0df0f:lib/routerDevelopmentCollectorProvider.ts`
+and the same command for `tests/routerDevelopmentCollectorProvider.test.mjs`.
+No unavailable public URL or machine-local temp file is required to understand
+the observations below. Publication of that ancestry remains a later step.
+
+At the reviewed round-1 source `ff0600e1858130988ea7820611736ec0dba5ed59`,
+the implementation diff against the same base is provider +2/-0 and test
++33/-1, totaling +35/-1 across those two files, distinct from the initial
+dcabb4e3 +33/-1 above. The two additional lines assert
+`servedProcessingTier === null` and `unsupportedBilling === false`.
+The fixture comment replaces wording within the existing added block and
+adds no net line. This patch-size observation grants no new permission and
+certifies no later checks or review outcome.
+
+The original author summary transcribed tool observations rather than saving
+full raw logs: collector 80/80, official typecheck, two-file lint and diff check
+passed; full local wiring changed from 10/12 to 11/12 but **still exited 1**.
+The cache-harvest CI regression passed, while the pre-existing Windows
+path-separator failure remained. Those are historical author reports, not
+new tests or independent Claude observations.
+
+The actual round-0 controller package, produced at
+`2026-09-10T05:42:02.317Z`, records one successful collector command and 11
+successful guards at that source. Its change digest is
+`sha256:eed64ad80aac2977a59b50570d2d8245b2251262328e9c4bac5f53199e07a33e`;
+the records are `package-round0.json` and `change-round0.diff` in the existing
+task output directory named above. Its five-line excerpts omit pass totals.
+Subsequent native raw TAP logs at the same source recorded 80/80 and the exact
+named CI target 1/1, zero fail/skip/cancel/todo; the other 11 wiring tests were
+not executed. They are separately labelled `collector-tests.supplemental.raw.tap`
+and `wiring-target.supplemental.raw.tap`, not replacement package output.
+Generated local records still need their later authorized durable archive;
+this receipt does not claim they are already available in a fresh clone.
+
+Codex also compared working and committed bytes directly at the fixed source.
+Claude's Read/Grep/Glob-only review could not independently compute hashes.
+Do not treat either a duplicated hash table or this receipt as current-file
+authentication: each later package must bind its own actual source/diff digest
+and record genuine checks. Editing this evidence section creates no new user
+permission and certifies no later test result or reviewer verdict.
+
+Targeting one CI regression is not a full-wiring-suite pass. No local full-unit
+pass has been observed. The reported Linux CI run at source 886 had 8,436
+tests: 8,434 pass, one fail and one skip. Fresh full Linux CI on the actual
+published fix head remains mandatory before merge; historical records and
+the earlier review cannot substitute for it.
+
+The fix makes the existing Google cache-write **unknown/null** explicit and
+tests that non-allowlisted raw/SDK fields cannot fill writes, uncached input
+or cost. It does not establish historical paid underbilling or newly observe
+a Google cache-write metric. All tests described above are offline mocks or
+static checks, not benchmark provider calls or independent Claude findings.
diff --git a/docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.task.json b/docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.task.json
new file mode 100644
index 00000000..48fa9065
--- /dev/null
+++ b/docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.task.json
@@ -0,0 +1,22 @@
+{
+  "taskId": "router-development-collector-cache-observation-fix",
+  "requirement": "Review the minimal collector CI follow-up discovered on PR #1319 at source 886ea27f852a7d00c6cccbba26ec0002f2086d16: explicitly retain cacheWriteTokens=null next to the Google cache-read observation and add an offline mock regression proving non-allowlisted raw fields and SDK-normalized fields cannot fill unknown writes, uncached input or estimated cost. This preserves the existing unknown/null behavior; it is not evidence of historical paid underbilling and does not add a provider observation. Implementation is limited to the two provider source/test files; this task and its receipt are review instructions and authorization provenance only. Use a new digest-bound Codex-author/Claude-reviewer exchange for this newly discovered CI issue, with at most two fix rounds and no supersedes. Keep the completed collector review and all original records unchanged. The user's fresh limited permission allows --skip-preflight only for the announced read-only review of this fix, not failed-test/CI overrides, API-billing fallback or paid benchmark execution. Authoring these records performs no commit, package, review, push or merge.",
+  "completionCriteria": [
+    "The eventual clean review commit differs from exact base 886ea27f852a7d00c6cccbba26ec0002f2086d16 only in the four listed paths. The initial implementation patch is two files, +33/-1: an explicit Google cacheWriteTokens=null assignment/comment and one provider mock regression plus its import. Do not broaden the runtime fix, replace null with zero, infer no-cache usage, change raw allowlists, or change model caps/settings/pricing. Any requested revision stays within this bounded purpose and is separately verified.",
+    "The regression observes cachedContentTokenCount from the existing Google raw-body allowlist while preserving cacheWriteTokens=null, noCacheInputTokens=null and estimateCollectionUsageCost=null despite adversarial non-allowlisted raw fields and SDK-normalized nonzero cache-write fields. It uses MockLanguageModelV4 without credentials or network and verifies one mock generation. No production provider call, additional raw-body persistence or synthetic provider usage is introduced.",
+    "Run the entire collector suite with npm run test:router-development-collector and record the actual result (currently 80 tests), with zero failures/skips. Also run the exact CI regression named 'every place that harvests cacheReadTokens harvests cacheWriteTokens too' in tests/anthropicPromptCachingWiring.test.mjs through the existing react-server/tsx serial Node test invocation. Assert that this exact named case actually executed and passed (one executed target, one pass, zero failures); exit 0 with zero matched tests is not a pass. Report intentionally deselected tests separately; filtering is not a full-wiring-suite pass. Preserve the reported whole-wiring local result of 11/12, exit 1, and its pre-existing Windows path-separator failure, which was also present before this patch. Do not edit the scanner, test runner or workflow or use --review-despite-check-failures. The Linux full CI suite must pass on the actual subsequently published head before merge; a local full-unit run has not been completed and cannot be claimed from targeted checks.",
+    "Official npm run typecheck, lint of both changed implementation/test files, check:encoding, check:doc-references, check:policy-section-references, check:model-pricing, check:router-quality-eval, check:router-context-window and check:context-window-register pass with actual commands/results recorded. Verify the four-path diff and handwritten whitespace, and preserve all other source and historical-record bytes. Supplied author summaries are not raw logs or independently rerun checks; package-stage test and guard results must come from genuine executions without failure overrides.",
+    "Preserve the original collector task/receipt, its canonical 28-file archive and active 21-file passed exchange, the original v1 records, corpus/grader/planner, reservation/journal/export behavior, product client and policy, pricing/registry/credits, caps/settings, package/lock, processing-tier guard, cross-review controller and workflows. The previous passed review remains concluded on its own digest; it does not approve this patch and is not reopened or reset. The source-886 60-call pilot proposal remains a historical unapproved draft and must be regenerated after final source/merge before any separate numerical human execution approval.",
+    "Only after separate orchestrator go, package round 0 using the unchanged control program, author codex, reviewer claude, exact base and full four-path diff, with output artifacts/cross-review/router-development-collector-cache-observation-fix. generatedPaths is empty and no --diff-exclude arguments are permitted. Use the existing ignored artifacts location without changing ignore/scope/controller rules. Record a newly computed source digest and actual checks; packaging is not a reviewer verdict. Do not move or overwrite earlier exchanges.",
+    "Announce independent review before invocation and wait for its separate go. Retain the existing Claude --print --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config configuration, with no shell/write tools, model override or expanded MCP access. In the review child environment only, remove every case spelling of ANTHROPIC_API_KEY, retain stored claude.ai login, and allow Git/bin on the existing PATH solely for shell availability. Observe sanitized login status before invocation; no login means stop, not API fallback. Keep parent/persistent environment unchanged. Record --skip-preflight as a skip, never a passed preflight. At most two fix rounds apply; unresolved actionable findings at the cap mean on_hold, not a new exchange or revision-cap override.",
+    "This task/receipt does not certify tests, a package, an independent verdict, a new CI pass, a push or a merge. Keep the author-reported pre-patch local wiring result 10/12 and post-patch 11/12 distinct from the Linux CI result at source 886 (8,436 tests: 8,434 pass, one fail, one skip) and from future actual checks. Commit, package, reviewer invocation, push and merge each require their separate applicable go. No paid collector/provider run, API-billing switch, main merge, deployment, model ranking or quality promotion is authorized."
+  ],
+  "baseCommit": "886ea27f852a7d00c6cccbba26ec0002f2086d16",
+  "writableScope": [
+    "docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.authorization.md",
+    "docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.task.json",
+    "lib/routerDevelopmentCollectorProvider.ts",
+    "tests/routerDevelopmentCollectorProvider.test.mjs"
+  ],
+  "generatedPaths": []
+}
diff --git a/lib/routerDevelopmentCollectorProvider.ts b/lib/routerDevelopmentCollectorProvider.ts
index a72076fe..23b4eddc 100644
--- a/lib/routerDevelopmentCollectorProvider.ts
+++ b/lib/routerDevelopmentCollectorProvider.ts
@@ -80,6 +80,8 @@ export function observeCollectionBody(provider: string, body: unknown): Collecti
       // Missing thoughts are unknown, not zero; SDK-normalized output is not evidence.
       observation.outputTokens = sum(count(googleUsage.candidatesTokenCount), observation.reasoningTokens);
       observation.cacheReadTokens = count(googleUsage.cachedContentTokenCount);
+      // This allowlist has no Google cache-write observation; unknown is not zero.
+      observation.cacheWriteTokens = null;
       observation.rawFinishReason = label(candidate.finishReason) ?? label(record(root.promptFeedback).blockReason);
       observation.finish = finish(observation.rawFinishReason);
       observation.unsupportedBilling = candidates.length > 1 || googleUsage.toolUsePromptTokenCount != null && googleUsage.toolUsePromptTokenCount !== 0 || candidate.groundingMetadata != null || hasItems(record(candidate.content).parts) && (record(candidate.content).parts as unknown[]).some((part) => record(part).functionCall != null);
diff --git a/tests/routerDevelopmentCollectorProvider.test.mjs b/tests/routerDevelopmentCollectorProvider.test.mjs
index 4c6083ce..6f64b51c 100644
--- a/tests/routerDevelopmentCollectorProvider.test.mjs
+++ b/tests/routerDevelopmentCollectorProvider.test.mjs
@@ -5,7 +5,7 @@ import { MockLanguageModelV4 } from "ai/test";
 import { AVAILABLE_MODELS, DEFAULT_MODEL_ID } from "../lib/models.ts";
 import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";
 import { collectFromProvider, createCollectionSdkAdapter, observeCollectionBody, collectionReturnedOutcome } from "../lib/routerDevelopmentCollectorProvider.ts";
-import { COLLECTION_LIMITS, emptyCollectionObservation, validateCollectionOutcome } from "../lib/routerDevelopmentCollector.ts";
+import { COLLECTION_LIMITS, emptyCollectionObservation, estimateCollectionUsageCost, validateCollectionOutcome } from "../lib/routerDevelopmentCollector.ts";
 import { auditProcessingTierMentions, PROCESSING_TIER_REQUEST_ALLOWLIST } from "../scripts/check-processing-tier-core.mjs";
 
 const originalFetch = globalThis.fetch;
@@ -65,6 +65,38 @@ test("raw usage preserves missing versus explicit zero across five adapter famil
   assert.equal(observeCollectionBody("deepseek", { usage: { prompt_cache_hit_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } } }).cacheReadTokens, 2);
 });
 
+test("Google cached reads leave writes, uncached input, and cost unknown despite extra raw and normalized values", async () => {
+  const googleModel = AVAILABLE_MODELS.find((entry) => entry.provider === "google");
+  assert.ok(googleModel);
+  const body = {
+    usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 0, cachedContentTokenCount: 3 },
+    // The adversarial keys supplied here are not Google usage-counter allowlist fields.
+    usage: { input_tokens: 8, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 5 } },
+    candidates: [{ finishReason: "STOP" }],
+  };
+  const normalizedUsage = { inputTokens: { total: 8, noCache: 0, cacheRead: 3, cacheWrite: 5 }, outputTokens: { total: 2, text: 2, reasoning: 0 } };
+  const mock = new MockLanguageModelV4({ doGenerate: { content: [{ type: "text", text: "{}" }], usage: normalizedUsage,
+    finishReason: { unified: "stop", raw: "STOP" }, response: { body }, warnings: [] } });
+  const adapter = createCollectionSdkAdapter({ generate: generateText, getModel: () => mock, getSettings: getModelGenerationSettings });
+  const outcome = await adapter({ ...request(), modelId: googleModel.id, settings: getModelGenerationSettings(googleModel), maxOutputTokens: 128 });
+  assert.equal(mock.doGenerateCalls.length, 1);
+  assert.equal(outcome.status, "returned");
+  assert.equal(outcome.answerText, "{}");
+  assert.deepEqual(outcome.observation, observeCollectionBody("google", body));
+  const observation = outcome.observation;
+  assert.equal(observation.source, "provider_body_allowlist");
+  assert.equal(observation.inputTokens, 8);
+  assert.equal(observation.outputTokens, 2);
+  assert.equal(observation.cacheReadTokens, 3);
+  assert.equal(observation.cacheWriteTokens, null);
+  assert.equal(observation.noCacheInputTokens, null);
+  assert.equal(observation.servedProcessingTier, null);
+  assert.equal(observation.unsupportedBilling, false);
+  const pricedCall = { pricing: { tiers: [{ maxPromptTokens: null, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1,
+    cachedInputPriceMultiplier: 0.1, cacheWriteUsdPerMillionTokens: 1.25 }] } };
+  assert.equal(estimateCollectionUsageCost(observation, pricedCall), null);
+});
+
 test("metadata failures, invalid counters, and oversize do not invent evidence", () => {
   for (const number of [-1, Infinity, NaN, 1.5, "2", Number.MAX_SAFE_INTEGER + 1]) assert.equal(observeCollectionBody("openai", { usage: { input_tokens: number } }).inputTokens, null);
   const throwing = Object.defineProperty({}, "usage", { get() { throw new Error("SECRET"); }, enumerable: true });

```

## Test results (run by the control program)

- PASS `node --input-type=module -e 'import {spawnSync,execFileSync} from "node:child_process"; import fs from "node:fs"; import assert from "node:assert/strict"; import {createHash} from "node:crypto"; const log="artifacts/cross-review/router-development-collector-cache-observation-fix/round2-package-collector.raw.tap",expected=80; assert.equal(fs.existsSync(log),false,"raw log already exists; refusing overwrite"); const sourceCommit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(); assert.equal(execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim(),"","package checks require clean source"); const run=spawnSync(process.execPath,["--conditions=react-server","--import","tsx","--test","--test-concurrency=1","--test-reporter=spec","--test-reporter=tap","--test-reporter-destination=stdout","--test-reporter-destination=artifacts/cross-review/router-development-collector-cache-observation-fix/round2-package-collector.raw.tap","tests/routerDevelopmentCollector.test.mjs","tests/routerDevelopmentCollectorProvider.test.mjs","tests/routerDevelopmentCollectorCli.test.mjs","tests/routerDevelopmentCollectorAdversarial.test.mjs"],{stdio:"inherit"}); if(run.error||run.signal||run.status!==0)process.exit(run.status||1); const bytes=fs.readFileSync(log),raw=bytes.toString("utf8"); const matches=[...raw.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)]; assert.equal(matches.length,6,"missing or repeated TAP totals"); const counts=Object.fromEntries(matches.map(m=>[m[1],Number(m[2])])); assert.deepEqual(counts,{tests:expected,pass:expected,fail:0,cancelled:0,skipped:0,todo:0}); assert.equal((raw.match(/^ok \d+ - /gm)||[]).length,expected); assert.equal(/^not ok /m.test(raw),false); console.log(JSON.stringify({offlineTestLog:{suite:"collector",sourceCommit,rawLog:log,rawBytes:bytes.length,rawSha256:createHash("sha256").update(bytes).digest("hex")}})); const lastLine=JSON.stringify({observedOfflineTests:{suite:"collector",...counts}}); assert.ok(lastLine.length<400,"summary must fit the existing guard detail limit"); console.log(lastLine);'` (19357ms)
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 19200.5752
  {"offlineTestLog":{"suite":"collector","sourceCommit":"34a179fd1986afbb2909cc38b0fa988814e5aa0e","rawLog":"artifacts/cross-review/router-development-collector-cache-observation-fix/round2-package-collector.raw.tap","rawBytes":18536,"rawSha256":"27472f20a77936874f303d71648a6e2e491e7da419900084ddedaac33d230b1a"}}
  {"observedOfflineTests":{"suite":"collector","tests":80,"pass":80,"fail":0,"cancelled":0,"skipped":0,"todo":0}}

## Guard results (run by the control program)

- PASS `node --input-type=module -e 'import {spawnSync,execFileSync} from "node:child_process"; import fs from "node:fs"; import assert from "node:assert/strict"; import {createHash} from "node:crypto"; const log="artifacts/cross-review/router-development-collector-cache-observation-fix/round2-package-wiring.raw.tap",expected=1; assert.equal(fs.existsSync(log),false,"raw log already exists; refusing overwrite"); const sourceCommit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(); assert.equal(execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim(),"","package checks require clean source"); const run=spawnSync(process.execPath,["--conditions=react-server","--import","tsx","--test","--test-concurrency=1","--test-reporter=tap","--test-reporter=tap","--test-reporter-destination=stdout","--test-reporter-destination=artifacts/cross-review/router-development-collector-cache-observation-fix/round2-package-wiring.raw.tap","--test-name-pattern=^every place that harvests cacheReadTokens harvests cacheWriteTokens too$","tests/anthropicPromptCachingWiring.test.mjs"],{stdio:"inherit"}); if(run.error||run.signal||run.status!==0)process.exit(run.status||1); const bytes=fs.readFileSync(log),raw=bytes.toString("utf8"); const matches=[...raw.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)]; assert.equal(matches.length,6,"missing or repeated TAP totals"); const counts=Object.fromEntries(matches.map(m=>[m[1],Number(m[2])])); assert.deepEqual(counts,{tests:expected,pass:expected,fail:0,cancelled:0,skipped:0,todo:0}); assert.equal((raw.match(/^ok \d+ - /gm)||[]).length,expected); assert.equal(/^not ok /m.test(raw),false); assert.equal((raw.match(/^ok 1 - every place that harvests cacheReadTokens harvests cacheWriteTokens too\r?$/gm)||[]).length,1,"named target must execute and pass"); const declared=[...fs.readFileSync("tests/anthropicPromptCachingWiring.test.mjs","utf8").matchAll(/^test\("([^"]+)"/gm)].map(m=>m[1]); assert.equal(declared.length,12); assert.equal(declared.filter(t=>t==="every place that harvests cacheReadTokens harvests cacheWriteTokens too").length,1); console.log(JSON.stringify({offlineTestLog:{suite:"wiring",sourceCommit,rawLog:log,rawBytes:bytes.length,rawSha256:createHash("sha256").update(bytes).digest("hex")}})); const lastLine=JSON.stringify({observedOfflineTests:{suite:"wiring",...counts,namedTarget:"every place that harvests cacheReadTokens harvests cacheWriteTokens too",intentionallyDeselected:11}}); assert.ok(lastLine.length<400,"summary must fit the existing guard detail limit"); console.log(lastLine);'` (2627ms)
  outer-development-collector-cache-observation-fix/round2-package-wiring.raw.tap","rawBytes":331,"rawSha256":"1b4d306b8e1384750cf7db4633a4d5a51332e4f580160fb35457c011a55a83cc"}}
  {"observedOfflineTests":{"suite":"wiring","tests":1,"pass":1,"fail":0,"cancelled":0,"skipped":0,"todo":0,"namedTarget":"every place that harvests cacheReadTokens harvests cacheWriteTokens too","intentionallyDeselected":11}}
- PASS `npm run typecheck` (34376ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm run lint -- lib/routerDevelopmentCollectorProvider.ts tests/routerDevelopmentCollectorProvider.test.mjs` (2418ms)
  > ai-chat-hub@0.1.0 lint
  > eslint lib/routerDevelopmentCollectorProvider.ts tests/routerDevelopmentCollectorProvider.test.mjs
- PASS `npm run check:encoding` (1150ms)
  > ai-chat-hub@0.1.0 check:encoding
  > node scripts/check-text-encoding.mjs
  
  Text encoding check passed. No mojibake markers found.
- PASS `npm run check:doc-references` (1273ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 767 referenced path(s) across 92 instruction document(s), and 892 path(s) named by comments across 2632 source file(s), all present.
- PASS `npm run check:policy-section-references` (954ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4136 citation(s) against 30 policy document(s). 2485 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1421 and 230 predate this change).
- PASS `npm run check:model-pricing` (688ms)
  > ai-chat-hub@0.1.0 check:model-pricing
  > node --import tsx scripts/check-model-pricing.mjs
  
  
  Model pricing check passed: 36 explicit profiles, 0 model(s) on a conservative fallback, 0 unpriced premium models, 0 register warning(s), 0 expired pending prices.
- PASS `npm run check:router-quality-eval` (637ms)
  none supplied. Pass --report=<path> to validate one.
    No decision-grade run exists in this repository, so ROUTE-01 has no evidence
    and remains pending regardless of what the shadow numbers show.
  
  No problems found in what was checked.
- PASS `npm run check:router-context-window` (649ms)
  > ai-chat-hub@0.1.0 check:router-context-window
  > node --import tsx scripts/check-router-context-window.mjs
  
  catalogue: 31 enabled models, 16 without a declared context window (16 accepted as the current baseline).
  OK: no new undeclared models. 16 remain in the baseline and must be resolved before ESTIMATE-03 can be approved.
- PASS `npm run check:context-window-register` (687ms)
  > ai-chat-hub@0.1.0 check:context-window-register
  > node --import tsx scripts/check-context-window-register.mjs
  
  OK docs/policy/tomverse-chat-context-window-register.yaml: 31 enabled models, 4 verified, 27 unverified (14 of those already declare a window in the catalogue with no recorded source).
- PASS `git diff --check 886ea27f852a7d00c6cccbba26ec0002f2086d16 HEAD` (39ms)

## Findings from the previous round (check each was addressed)

- [nit/evidence] docs/ops/cross-review/packages/router-development-collector-cache-observation-fix.authorization.md:61: The receipt records only the historical `+33/-1` size of the dcabb4e3 patch and never states the current revision's size, so the durable record leaves the reviewed implementation diff (+35/-1 across the two files) unstated next to a criterion that names +33/-1.

## Author's account (read last; a claim, not a finding)

Summary: (no summary supplied; the diff is the record)

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "router-development-collector-cache-observation-fix",
  "round": 2,
  "reviewedDigest": "sha256:ba44bb1c84ef0f9c95d04ae947a5991f79f18a14b10664022c156d94a51108cf",
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
