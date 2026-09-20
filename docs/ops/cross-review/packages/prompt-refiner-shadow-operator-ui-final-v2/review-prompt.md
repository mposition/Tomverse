# Independent review — task prompt-refiner-shadow-operator-ui-final-v2, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Claude가 approve한 prompt-refiner-shadow-operator-ui-v1의 마지막 비차단 nit를 닫는다. stage card의 approvalTtlMinutes는 남은 시간이 아니라 동결된 60분 승인 window이므로 execution card의 실제 approvalExpiresAt과 같은 'Expires/만료' 라벨을 재사용하지 않고 'Approval window/승인 유효기간'으로 명확히 구분한다. 그 밖의 owner/recent-auth, exact preview binding, 비용·모델 상수, GET-only refresh, explicit POST, unknown stop, no retry·redispatch, content-free UI 계약은 바꾸지 않는다. author는 Codex, reviewer는 Claude Code Max이고 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only 및 strict MCP로 검토한다.

## Completion criteria

- stage 카드의 60 min 값은 Approval window/승인 유효기간 라벨을 쓰고 execution 카드의 절대시각만 Expires/만료 라벨을 쓴다.
- focused operator/navigation test, TypeScript, 수정 파일 ESLint, encoding과 diff whitespace 검사가 통과한다.
- 제품 runtime 동작, provider/model/Railway/database/stage/run/flag/비용 경계는 변경하지 않는다.
- Claude verdict는 새 package digest와 결속하고 재현 가능한 finding을 기록한다.

## Change under review — digest sha256:fb5713256b73432019b24912818b82ed26ceed67c7ae251278231d72ffe7bfe5

```diff
diff --git a/components/admin/AdminPromptRefinerShadowPanel.tsx b/components/admin/AdminPromptRefinerShadowPanel.tsx
index 950334d3..9f9aca08 100644
--- a/components/admin/AdminPromptRefinerShadowPanel.tsx
+++ b/components/admin/AdminPromptRefinerShadowPanel.tsx
@@ -411,7 +411,10 @@ export function AdminPromptRefinerShadowPanel() {
             <Field label={m.status} value={stage.status} />
             <Field label={m.deployment} value={stage.deploymentId} />
             <Field label={m.commit} value={stage.commitSha} />
-            <Field label={m.expires} value={`${stage.approvalTtlMinutes} min`} />
+            <Field
+              label={m.approvalWindow}
+              value={`${stage.approvalTtlMinutes} min`}
+            />
             <Field
               label={m.perRequestCeiling}
               value={usd(stage.perRequestCostMicroUsd)}
diff --git a/docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.authorization.md b/docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.authorization.md
new file mode 100644
index 00000000..262e0dcf
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.authorization.md
@@ -0,0 +1,22 @@
+# Prompt Refiner shadow 운영 화면 최종 정리 Claude 독립 검토 제한 승인
+
+Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 권장 순서에 따른 자동 진행과
+필요한 Claude 독립 검토를 요청했고, 이 작업에 `--skip-preflight` 예외를 승인했다.
+이 문서는 전자서명, 제품 실행 승인, 배포 승인 또는 검토 통과 기록이 아니다.
+
+## 적용 범위
+
+이 승인은 round 상한으로 `on_hold`가 된
+`prompt-refiner-shadow-operator-ui-v1`의 단일 비차단 문구 nit와 EOF whitespace를
+닫는 [후속 task](prompt-refiner-shadow-operator-ui-final-v2.task.json)의 Claude
+읽기 전용 독립 검토에만 적용한다.
+
+## 유지되는 경계
+
+- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. child 환경에서
+  `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 대소문자와 무관하게 제거한다.
+- reviewer는 Read/Grep/Glob만 사용하고 shell, write, hook, plugin, skill, MCP를
+  사용할 수 없다. 사용자가 승인한 `--skip-preflight`만 기록한다.
+- 실패 test/guard 우회, provider/model 호출, Railway 변경, database mutation,
+  stage/run 승인, flag 활성화, 유료 shadow 실행, push·merge·deploy는 이 검토에
+  포함하지 않는다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.task.json b/docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.task.json
new file mode 100644
index 00000000..f5fe29ba
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.task.json
@@ -0,0 +1,23 @@
+{
+  "taskId": "prompt-refiner-shadow-operator-ui-final-v2",
+  "requirement": "Claude가 approve한 prompt-refiner-shadow-operator-ui-v1의 마지막 비차단 nit를 닫는다. stage card의 approvalTtlMinutes는 남은 시간이 아니라 동결된 60분 승인 window이므로 execution card의 실제 approvalExpiresAt과 같은 'Expires/만료' 라벨을 재사용하지 않고 'Approval window/승인 유효기간'으로 명확히 구분한다. 그 밖의 owner/recent-auth, exact preview binding, 비용·모델 상수, GET-only refresh, explicit POST, unknown stop, no retry·redispatch, content-free UI 계약은 바꾸지 않는다. author는 Codex, reviewer는 Claude Code Max이고 승인된 --skip-preflight 예외 아래 Read/Grep/Glob only 및 strict MCP로 검토한다.",
+  "completionCriteria": [
+    "stage 카드의 60 min 값은 Approval window/승인 유효기간 라벨을 쓰고 execution 카드의 절대시각만 Expires/만료 라벨을 쓴다.",
+    "focused operator/navigation test, TypeScript, 수정 파일 ESLint, encoding과 diff whitespace 검사가 통과한다.",
+    "제품 runtime 동작, provider/model/Railway/database/stage/run/flag/비용 경계는 변경하지 않는다.",
+    "Claude verdict는 새 package digest와 결속하고 재현 가능한 finding을 기록한다."
+  ],
+  "baseCommit": "59c425c3e9a76c87eede685874dddb753005daa2",
+  "writableScope": [
+    "components/admin/AdminPromptRefinerShadowPanel.tsx",
+    "docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.authorization.md",
+    "docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.task.json",
+    "lib/adminMessages/promptRefinerShadow.ts",
+    "tests/adminPromptRefinerShadowOperator.test.mjs"
+  ],
+  "generatedPaths": [],
+  "supersedes": {
+    "taskId": "prompt-refiner-shadow-operator-ui-v1",
+    "exchange": "docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-v1/exchange.json"
+  }
+}
diff --git a/lib/adminMessages/promptRefinerShadow.ts b/lib/adminMessages/promptRefinerShadow.ts
index 93b6744e..b93d2d49 100644
--- a/lib/adminMessages/promptRefinerShadow.ts
+++ b/lib/adminMessages/promptRefinerShadow.ts
@@ -31,6 +31,7 @@ export const adminPromptRefinerShadowMessages = defineAdminMessages({
     model: "Model",
     status: "Status",
     expires: "Expires",
+    approvalWindow: "Approval window",
     perRequestCeiling: "Per-request ceiling",
     stageCeiling: "Stage authority ceiling",
     runCeiling: "Run ceiling",
@@ -97,6 +98,7 @@ export const adminPromptRefinerShadowMessages = defineAdminMessages({
     model: "모델",
     status: "상태",
     expires: "만료",
+    approvalWindow: "승인 유효기간",
     perRequestCeiling: "요청당 상한",
     stageCeiling: "stage 권한 상한",
     runCeiling: "run 상한",
diff --git a/tests/adminPromptRefinerShadowOperator.test.mjs b/tests/adminPromptRefinerShadowOperator.test.mjs
index 5f40dcd6..fcc8ef81 100644
--- a/tests/adminPromptRefinerShadowOperator.test.mjs
+++ b/tests/adminPromptRefinerShadowOperator.test.mjs
@@ -2,6 +2,7 @@ import assert from "node:assert/strict";
 import test from "node:test";
 import { readFileSync } from "node:fs";
 import { join } from "node:path";
+import { adminPromptRefinerShadowMessages } from "../lib/adminMessages/promptRefinerShadow.ts";
 
 const root = process.cwd();
 const panel = readFileSync(
@@ -59,6 +60,25 @@ test("the page exposes recent-auth recovery but no prompt or model output", () =
   assert.match(panel, /promptRefinerExecutionBody\(execution\)/);
 });
 
+test("the stage TTL and execution expiry keep distinct labels", () => {
+  assert.match(
+    panel,
+    /label=\{m\.approvalWindow\}[\s\S]*?stage\.approvalTtlMinutes/
+  );
+  assert.match(
+    panel,
+    /label=\{m\.expires\}[\s\S]*?execution\.approvalExpiresAt/
+  );
+  assert.notEqual(
+    adminPromptRefinerShadowMessages.en.approvalWindow,
+    adminPromptRefinerShadowMessages.en.expires
+  );
+  assert.notEqual(
+    adminPromptRefinerShadowMessages.ko.approvalWindow,
+    adminPromptRefinerShadowMessages.ko.expires
+  );
+});
+
 test("refresh re-reads the visible step instead of advancing the workflow", () => {
   const refresh = panel.match(/const refresh = async \(\) => \{([\s\S]*?)\n  \};/)?.[1];
   assert.ok(refresh, "refresh remains inspectable");

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-reporter=spec tests/promptRefinerShadowOperatorCore.test.mjs tests/adminPromptRefinerShadowOperator.test.mjs tests/adminNavigation.test.mjs` (498ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 409.2705

## Guard results (run by the control program)

- PASS `npm run typecheck` (50426ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npx eslint components/admin/AdminPromptRefinerShadowPanel.tsx lib/adminMessages/promptRefinerShadow.ts tests/adminPromptRefinerShadowOperator.test.mjs --max-warnings=0` (3636ms)
- PASS `npm run check:encoding` (1854ms)
  > ai-chat-hub@0.1.0 check:encoding
  > node scripts/check-text-encoding.mjs
  
  Text encoding check passed. No mojibake markers found.
- PASS `git diff --check` (56ms)

## Findings from the previous round (check each was addressed)

- [nit/evidence] tests/adminPromptRefinerShadowOperator.test.mjs:62-71 vs lib/adminMessages/promptRefinerShadow.ts:33-34,100-101: The new test pins the key binding in the panel (`m.approvalWindow` on the stage TTL, `m.expires` on the execution timestamp) but never asserts that the two keys resolve to different strings, so the distinction can be undone entirely inside the message catalog with every gate still green.
- [nit/evidence] app/(site)/(application)/admin/prompt-refiner-shadow/page.tsx (EOF) and docs/ops/cross-review/packages/prompt-refiner-shadow-operator-ui-final-v2.task.json:3: The requirement's second half — remove the EOF blank line from page.tsx — describes a condition that does not exist at baseCommit 59c425c3, so that part of the task is a recorded no-op rather than work performed by this diff.

## Author's account (read last; a claim, not a finding)

Summary: (no summary supplied; the diff is the record)

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-shadow-operator-ui-final-v2",
  "round": 2,
  "reviewedDigest": "sha256:fb5713256b73432019b24912818b82ed26ceed67c7ae251278231d72ffe7bfe5",
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
