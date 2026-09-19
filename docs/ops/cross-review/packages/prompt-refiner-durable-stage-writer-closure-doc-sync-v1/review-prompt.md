# Independent review — task prompt-refiner-durable-stage-writer-closure-doc-sync-v1, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

on_hold로 종결된 prompt-refiner-durable-stage-writer-rebase-fingerprints-v1의 마지막 비차단 finding을 닫는다. Prompt Refiner runtime import closure가 186개에서 187개로 늘어난 사실을 Prisma schema와 운영 계약·작업·진행 문서에 일치시키고, TypeScript/JavaScript source 수는 177개에서 178개로 바로잡는다. schema.prisma의 주석 byte 변경 때문에 marketing webhook pipeline fingerprint를 결정적으로 다시 계산하고 기존 fail-closed 검사를 유지한다. 문서의 closure 수가 다시 drift하지 않도록 기존 runtime source closure test가 상수와 운영 문구를 직접 결속한다. 제품 runtime 동작, database schema 구조, provider/model, Railway, credential, stage mutation, flag/rollout 및 유료 실행은 변경하지 않는다. author는 Codex, reviewer는 Claude Code Max이며 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only와 strict MCP로 검토한다.

## Completion criteria

- Prisma schema와 Prompt Refiner durable writer 계약·작업·진행 문서가 runtime closure 187개 및 그중 TypeScript/JavaScript source 178개를 동일하게 기술한다.
- runtime source closure test가 PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT를 기준으로 운영 문서와 schema의 count-bearing 문구를 검사해 186 회귀를 fail-closed한다.
- MARKETING_WEBHOOK_PIPELINE_FINGERPRINT는 주석 byte가 바뀐 schema.prisma를 포함해 computeMarketingWebhookPipelineFingerprint가 재현하는 값과 정확히 일치한다.
- focused fingerprint/source-closure test, typecheck, 수정 파일 lint, strict encoding 및 diff whitespace 검사가 통과한다.
- 이 task는 이전 on_hold exchange와 finding을 수정하지 않고 supersedes로 계승하며 product database mutation, provider/model/Railway 호출, credential, stage/flag/rollout 또는 paid execution을 추가하지 않는다.
- Claude verdict는 새 package digest와 결속하며 최초 검토와 최대 두 번의 수정 검토 후 actionable finding이 남으면 on_hold다.

## Change under review — digest sha256:c64fd87a617e7822ad144a600baa90dc42f78c889857394ac1e9b18d13e633ab, commit e016fb643e5656dc88b78d09e6cb5fb008842cc6

```diff
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.authorization.md b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.authorization.md
new file mode 100644
index 00000000..b99c91e9
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.authorization.md
@@ -0,0 +1,28 @@
+# Prompt Refiner runtime closure 문서 동기화 Claude 독립 검토 제한 승인
+
+Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 중단된 자동 개발을 이어서
+마무리하도록 요청했고, 앞선 지시에서 독립 검토가 필요하면 Claude에 요청하며
+`--skip-preflight` 예외를 허용했다. 이 문서는 전자서명, 제품 실행 승인 또는 검토
+통과 기록이 아니다.
+
+## 적용 범위
+
+이 승인은
+[검토 task](prompt-refiner-durable-stage-writer-closure-doc-sync-v1.task.json)에 정의된
+새 continuation exchange의 Claude 읽기 전용 독립 검토에만 적용한다. 이전 exchange는
+`on_hold (revisions_exhausted)` 상태와 마지막 문서 finding을 그대로 보존한다.
+
+## 유지되는 경계
+
+- Claude는 저장된 Claude Max `claude.ai` 로그인으로 `claude --print --safe-mode
+  --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
+  --strict-mcp-config`를 사용한다. shell, write, 추가 MCP, 모델 override는 허용하지 않는다.
+- review child 환경에서 `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고
+  `claude auth status --json`이 `authMethod=claude.ai`, `subscriptionType=max`임을
+  확인한다. 실패하면 API key 방식으로 전환하지 않는다.
+- `--skip-preflight`만 허용하며 `--review-despite-check-failures`와 test/CI 우회는
+  금지한다.
+- 최초 검토와 actionable finding 대응 후 최대 두 번의 수정 검토만 허용한다.
+- product database, provider/model 호출, external 또는 Railway API, credential 조회,
+  stage mutation, flag/rollout, 유료 실행과 실제 지출은 승인하지 않는다.
+- 이 기록의 작성·검증·커밋은 push, merge 또는 deploy 승인이 아니다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.task.json b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.task.json
new file mode 100644
index 00000000..6f20bab2
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.task.json
@@ -0,0 +1,29 @@
+{
+  "taskId": "prompt-refiner-durable-stage-writer-closure-doc-sync-v1",
+  "requirement": "on_hold로 종결된 prompt-refiner-durable-stage-writer-rebase-fingerprints-v1의 마지막 비차단 finding을 닫는다. Prompt Refiner runtime import closure가 186개에서 187개로 늘어난 사실을 Prisma schema와 운영 계약·작업·진행 문서에 일치시키고, TypeScript/JavaScript source 수는 177개에서 178개로 바로잡는다. schema.prisma의 주석 byte 변경 때문에 marketing webhook pipeline fingerprint를 결정적으로 다시 계산하고 기존 fail-closed 검사를 유지한다. 문서의 closure 수가 다시 drift하지 않도록 기존 runtime source closure test가 상수와 운영 문구를 직접 결속한다. 제품 runtime 동작, database schema 구조, provider/model, Railway, credential, stage mutation, flag/rollout 및 유료 실행은 변경하지 않는다. author는 Codex, reviewer는 Claude Code Max이며 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only와 strict MCP로 검토한다.",
+  "completionCriteria": [
+    "Prisma schema와 Prompt Refiner durable writer 계약·작업·진행 문서가 runtime closure 187개 및 그중 TypeScript/JavaScript source 178개를 동일하게 기술한다.",
+    "runtime source closure test가 PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT를 기준으로 운영 문서와 schema의 count-bearing 문구를 검사해 186 회귀를 fail-closed한다.",
+    "MARKETING_WEBHOOK_PIPELINE_FINGERPRINT는 주석 byte가 바뀐 schema.prisma를 포함해 computeMarketingWebhookPipelineFingerprint가 재현하는 값과 정확히 일치한다.",
+    "focused fingerprint/source-closure test, typecheck, 수정 파일 lint, strict encoding 및 diff whitespace 검사가 통과한다.",
+    "이 task는 이전 on_hold exchange와 finding을 수정하지 않고 supersedes로 계승하며 product database mutation, provider/model/Railway 호출, credential, stage/flag/rollout 또는 paid execution을 추가하지 않는다.",
+    "Claude verdict는 새 package digest와 결속하며 최초 검토와 최대 두 번의 수정 검토 후 actionable finding이 남으면 on_hold다."
+  ],
+  "baseCommit": "3f050c8789a3bdefa16580aadbae2f3e14761f38",
+  "writableScope": [
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.authorization.md",
+    "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-closure-doc-sync-v1.task.json",
+    "docs/ops/prompt-refiner-durable-stage-writer-contract.md",
+    "docs/ops/prompt-refiner-durable-stage-writer-task.md",
+    "docs/ops/tomverse-chat-progress.md",
+    "lib/marketingAutomationAccess.ts",
+    "prisma/schema.prisma",
+    "tests/marketingAutomationAccess.test.mjs",
+    "tests/promptRefinerRuntimeSourceClosure.test.mjs"
+  ],
+  "generatedPaths": [],
+  "supersedes": {
+    "taskId": "prompt-refiner-durable-stage-writer-rebase-fingerprints-v1",
+    "exchange": "docs/ops/cross-review/packages/prompt-refiner-durable-stage-writer-rebase-fingerprints-v1/exchange.json"
+  }
+}
diff --git a/docs/ops/prompt-refiner-durable-stage-writer-contract.md b/docs/ops/prompt-refiner-durable-stage-writer-contract.md
index bc440a94..b51444ad 100644
--- a/docs/ops/prompt-refiner-durable-stage-writer-contract.md
+++ b/docs/ops/prompt-refiner-durable-stage-writer-contract.md
@@ -17,7 +17,7 @@
 `GET /api/admin/prompt-refiner/shadow-stage`
 
 인증된 owner와 최근 인증을 요구한다. DB mutation, rate-limit 소비, stage/audit 생성은 없다.
-서버가 과거 evidence를 replay하고 현재 deployment의 186개 고정 source 파일 raw bytes를 읽어
+서버가 과거 evidence를 replay하고 현재 deployment의 187개 고정 source 파일 raw bytes를 읽어
 proposal/runtime-source/execution digest, commit, deployment, 고정 비용·slot·TTL과
 `executionAdmitted:false`, `productAdapterReady:false`를 반환한다. 또한 environment,
 deployment id, commit SHA, 세 digest, 비용·capacity·TTL 전체의 canonical JSON을 결속한
@@ -75,9 +75,9 @@ error/body는 담지 않는다.
 - migration은 기존 stage가 있으면 중단하고 seed/backfill하지 않는다.
 - writer가 UTC로 정규화한 한 DB clock snapshot으로 승인·만료 시각을 audit metadata와 stage 양쪽에
   기록하고, INSERT trigger는 두 값이 정확히 일치하지 않으면 거부한다.
-- DB CHECK는 186개 경로의 순서·exact key set·개별/총 크기·lowercase SHA-256 shape와 두 canonical
+- DB CHECK는 187개 경로의 순서·exact key set·개별/총 크기·lowercase SHA-256 shape와 두 canonical
   digest를 다시 계산하고 execution manifest의 canonical digest도 다시 계산한다.
-- 186개 중 177개 TypeScript/JavaScript source는 8개 실행 root에서 현재 parser가 지원하는
+- 187개 중 178개 TypeScript/JavaScript source는 8개 실행 root에서 현재 parser가 지원하는
   static import/re-export, literal dynamic import, literal `require`, require alias,
   `module.require`와 `createRequire` 호출로 도달하는 local runtime 폐쇄와 같아야 한다.
   `node:module`과 `module`은 같은 builtin으로 취급하고 named·default·namespace import의
diff --git a/docs/ops/prompt-refiner-durable-stage-writer-task.md b/docs/ops/prompt-refiner-durable-stage-writer-task.md
index 93d31e21..8062bc61 100644
--- a/docs/ops/prompt-refiner-durable-stage-writer-task.md
+++ b/docs/ops/prompt-refiner-durable-stage-writer-task.md
@@ -14,7 +14,7 @@ flag·credential·receipt writer를 연결하지 않는다.
 
 - 기존 `PromptRefinerReservationStage`의 additive migration
 - 승인 시점의 DB-owned 시각과 고정 60분 TTL
-- staging 환경, runtime commit, Railway deployment id, 186-file/16 MiB bounded exact-byte
+- staging 환경, runtime commit, Railway deployment id, 187-file/16 MiB bounded exact-byte
   runtime import-closure source manifest
 - 과거 proposal/evidence/corpus/source identity와 현재 execution manifest의 immutable 결속
 - owner 전용 관리자 GET preview와 POST create-only writer
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index 07502490..8fca1882 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -1172,7 +1172,7 @@ events와 최종 `exchange.json`의 감사 기록은 수정하지 않았다. 검
 ## 2026-09-17 Prompt Refiner durable stage writer 회차 (round 0 request_changes, 수정 검증·round 1 대기)
 
 앞 회차의 다음 순서 ①을 구현했다. 과거 admission proposal/evidence/corpus/source
-identity와 승인 시점 staging deployment의 full commit, exact 186-file runtime import-closure source manifest,
+identity와 승인 시점 staging deployment의 full commit, exact 187-file runtime import-closure source manifest,
 고정 execution manifest를 하나의 immutable stage에 결속한다. 승인 시각과 60분 expiry는
 DB clock이 소유하며, owner 전용 POST는 advisory lock 아래 tamper-evident success audit과
 stage insert를 한 transaction으로 처리한다. 동일 actor·동일 runtime의 exact replay만
diff --git a/lib/marketingAutomationAccess.ts b/lib/marketingAutomationAccess.ts
index c8b0cb0d..8a1f8b84 100644
--- a/lib/marketingAutomationAccess.ts
+++ b/lib/marketingAutomationAccess.ts
@@ -172,7 +172,7 @@ export const computeMarketingWebhookPipelineFingerprint = (
 
 /** Updated only by the fingerprint test after reviewing a declared file change. */
 export const MARKETING_WEBHOOK_PIPELINE_FINGERPRINT =
-  "9bcf4eb3b861f41bd8508e0e6e772c648c22351e19b58ad8e50bb39705432285";
+  "ac8d4125347e59b7f896d2b70927f45595768e369716d8299db2692414bbc63e";
 
 const sha256 = (value: string): string =>
   createHash("sha256").update(value, "utf8").digest("hex");
diff --git a/prisma/schema.prisma b/prisma/schema.prisma
index 16885db0..d9da0a9a 100644
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -5525,7 +5525,7 @@ model PromptRefinerReservationStage {
   corpusDigest                   String
   runtimeCommitSha               String
   runtimeSourceIdentityDigest    String
-  /// Content-free v2 manifest for the exact 186-file runtime import closure;
+  /// Content-free v2 manifest for the exact 187-file runtime import closure;
   /// the database validates ordered paths plus 8 MiB/file and 16 MiB total.
   runtimeSourceManifest          Json
   runtimeSourceManifestDigest    String
diff --git a/tests/promptRefinerRuntimeSourceClosure.test.mjs b/tests/promptRefinerRuntimeSourceClosure.test.mjs
index 03a9e322..1c2245db 100644
--- a/tests/promptRefinerRuntimeSourceClosure.test.mjs
+++ b/tests/promptRefinerRuntimeSourceClosure.test.mjs
@@ -1215,3 +1215,34 @@ test("TypeScript and PostgreSQL enforce the identical ordered runtime source pat
     "migration executionManifest runtimeSource.fileCount differs from the TypeScript runtime source contract"
   );
 });
+
+test("operator-facing contracts name the enforced runtime source closure size", () => {
+  const expectedCount = String(PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT);
+  const expectedRuntimeSourceCount = String(runtimeImportClosure().length);
+  for (const [path, pattern] of [
+    ["prisma/schema.prisma", /exact (\d+)-file runtime import closure/],
+    ["docs/ops/prompt-refiner-durable-stage-writer-contract.md", /deployment의 (\d+)개 고정 source 파일/],
+    ["docs/ops/prompt-refiner-durable-stage-writer-task.md", /(\d+)-file\/16 MiB bounded exact-byte/],
+    ["docs/ops/tomverse-chat-progress.md", /exact (\d+)-file runtime import-closure source manifest/],
+  ]) {
+    const source = readFileSync(join(repositoryRoot, path), "utf8");
+    const found = source.match(pattern);
+    assert.ok(found, `${path} has no runtime source closure count`);
+    assert.equal(found[1], expectedCount, `${path} runtime source closure count drifted`);
+  }
+
+  const contract = readFileSync(
+    join(repositoryRoot, "docs/ops/prompt-refiner-durable-stage-writer-contract.md"),
+    "utf8"
+  );
+  assert.match(
+    contract,
+    new RegExp(`${expectedCount}개 경로의 순서`),
+    "database path-count contract drifted"
+  );
+  assert.match(
+    contract,
+    new RegExp(`${expectedCount}개 중 ${expectedRuntimeSourceCount}개 TypeScript/JavaScript source`),
+    "runtime TypeScript/JavaScript source-count contract drifted"
+  );
+});

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/promptRefinerRuntimeSourceClosure.test.mjs tests/marketingAutomationAccess.test.mjs` (2838ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 2756.1634

## Guard results (run by the control program)

- PASS `npm run typecheck` (38767ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npx eslint lib/marketingAutomationAccess.ts tests/marketingAutomationAccess.test.mjs tests/promptRefinerRuntimeSourceClosure.test.mjs` (2967ms)
- PASS `npm run check:encoding:strict` (1348ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `npm run check:doc-references` (1447ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 900 referenced path(s) across 116 instruction document(s), and 1013 path(s) named by comments across 3034 source file(s), all present.
- PASS `git diff --check 3f050c8789a3bdefa16580aadbae2f3e14761f38 HEAD -- .` (64ms)

## Findings from the previous round (check each was addressed)

- [nit/evidence] docs/policy/prompt-refiner-observability.md:301-302, docs/policy/prompt-refiner-durable-stage-writer-threat-model.md:40: Two live policy documents still describe the closure as 186 fixed source files and 177 TypeScript/JavaScript sources, and the new count-binding test covers only schema.prisma plus the three ops documents, so this prose can keep drifting undetected; both files are outside this task's writableScope and requirement wording (Prisma schema plus 운영 계약·작업·진행 문서), so it is recorded rather than actionable here.

## Author's account (read last; a claim, not a finding)

Summary: Round 1에서 현재 task scope의 모든 finding은 닫혔다. 남은 두 policy 문구는 승인된 writableScope 밖이므로 기존 digest를 변경하지 않고 마지막 round에 그대로 공개한다. controller 종결 후 새 continuation이 해당 두 policy 파일과 이를 검증하는 test를 명시적으로 포함한다.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-durable-stage-writer-closure-doc-sync-v1",
  "round": 2,
  "reviewedDigest": "sha256:c64fd87a617e7822ad144a600baa90dc42f78c889857394ac1e9b18d13e633ab",
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
