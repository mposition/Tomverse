# Independent review — task prompt-refiner-same-instance-fixture-followup-v2, round 1

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

종료된 prompt-refiner-same-instance-fixture-v1 exchange의 round 2 승인 verdict에 남은 E2E fixture nit 두 건만 보완한다. 첫째, Refiner 제안 cookie는 있지만 별도 mode-refresh cookie가 없는 브라우저에서 refresh control이 렌더되지 않음을 검증한다. 둘째, Chat conversation 생성 POST probe가 예상 밖의 메서드를 기록하되 abort하지 않고 기존 route로 넘긴다. 기존 exchange와 제품 경로는 변경하지 않는다. author는 Codex, 독립 reviewer는 Claude Code Max 구독 CLI다.

## Completion criteria

- 기존 offered:true 브라우저 테스트가 별도 refresh cookie 부재 시 refresh control 0개를 명시적으로 확인한다.
- Chat conversation 생성 probe가 POST만 모의 처리하고 예상 밖 메서드는 기록 후 route.fallback()으로 넘긴다. 기존 테스트의 unexpected-method 빈 배열 검증은 유지한다.
- 기존 v1 exchange는 on_hold(revisions_exhausted)로 불변 보존하고 successor lineage와 미해결 nit 두 건을 새 exchange에 상속한다.
- desktop/mobile focused 브라우저 E2E와 변경 테스트의 정적 검사가 통과하고 실제 provider 호출은 발생하지 않는다.
- 새 package digest는 이 task와 authorization 및 변경된 E2E 테스트를 포함하고, 생성 records 디렉터리만 exact out/diff-exclude로 제외한다. Claude verdict는 그 digest에 결속한다.

## Change under review — digest sha256:0cdb272f6470a98749737709d3bad45b6051cb31bfd0fa2c1a0cfcfc48d95d9f

```diff
diff --git a/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-followup-v2/authorization.md b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-followup-v2/authorization.md
new file mode 100644
index 000000000..321e58ff5
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-followup-v2/authorization.md
@@ -0,0 +1,29 @@
+# Prompt Refiner 동일 인스턴스 fixture 후속 검토 승인 기록
+
+- approvedBy: `mposition` (대화의 권장 순서 자동 개발 및 필요한 Claude 독립 검토 승인)
+- approvedAt: `2026-09-22` (Australia/Brisbane, 후속 작업 시점)
+- author: `codex`
+- independentReviewer: `claude-code-max`
+- task: [task.json](./task.json)
+
+원 `prompt-refiner-same-instance-fixture-v1` exchange는 round 2에서 `approve`와
+재현 가능한 nit 두 건을 남겼다. 두 건 모두 `unresolved_on_hold`이므로 control
+program의 통과를 차단해 `on_hold(revisions_exhausted)`로 종료됐다. 원본
+exchange와 review record의 바이트·상태는 수정하지 않는다. 두 로컬 checkpoint
+commit 중 두 번째 `1f2115c6173b5ca2fb5e023f6a750243b0385cb1`을 후속
+작업의 정확한 base로 고정한다. 이 successor는 원 exchange를 재개하거나
+수정 round 상한을 초기화해 같은 기록을 덮는 것이 아니라, control program의
+`supersedes` lineage에 결속된 별도 작업이다.
+
+승인 범위는 E2E fixture 테스트 한 파일의 두 nit 수정, 로컬 무과금 검증,
+새 package와 Claude Code Max 구독 CLI의 읽기 전용 독립 검토다. 사용자가
+이번 작업에도 `--skip-preflight` 예외를 허용했다. Anthropic API 또는
+provider 호출, 제품 mode·Router·flag 전환, stage/run 승인, 유료 실행,
+실제 사용자 traffic, PR 자동 병합·배포는 승인 범위 밖이다.
+
+검토 package는 정확한 base 뒤의 E2E 테스트와 이 task/authorization을
+포함한다. 새 `records/`는 package 명령의 동일한 exact `--out` 및
+`--diff-exclude` 경로로만 제외하며 `generatedPaths`에는 넣지 않는다.
+Claude는 요구사항·diff를 먼저, 작성자 검증 기록을 다음에 검토한다. 저장된
+Max 구독 CLI의 Read/Grep/Glob 제한과 사용자 승인 `--skip-preflight`
+예외만 사용하며 API-key 환경 변수 fallback은 금지한다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-followup-v2/task.json b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-followup-v2/task.json
new file mode 100644
index 000000000..c5a63ce9d
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-followup-v2/task.json
@@ -0,0 +1,21 @@
+{
+  "taskId": "prompt-refiner-same-instance-fixture-followup-v2",
+  "requirement": "종료된 prompt-refiner-same-instance-fixture-v1 exchange의 round 2 승인 verdict에 남은 E2E fixture nit 두 건만 보완한다. 첫째, Refiner 제안 cookie는 있지만 별도 mode-refresh cookie가 없는 브라우저에서 refresh control이 렌더되지 않음을 검증한다. 둘째, Chat conversation 생성 POST probe가 예상 밖의 메서드를 기록하되 abort하지 않고 기존 route로 넘긴다. 기존 exchange와 제품 경로는 변경하지 않는다. author는 Codex, 독립 reviewer는 Claude Code Max 구독 CLI다.",
+  "completionCriteria": [
+    "기존 offered:true 브라우저 테스트가 별도 refresh cookie 부재 시 refresh control 0개를 명시적으로 확인한다.",
+    "Chat conversation 생성 probe가 POST만 모의 처리하고 예상 밖 메서드는 기록 후 route.fallback()으로 넘긴다. 기존 테스트의 unexpected-method 빈 배열 검증은 유지한다.",
+    "기존 v1 exchange는 on_hold(revisions_exhausted)로 불변 보존하고 successor lineage와 미해결 nit 두 건을 새 exchange에 상속한다.",
+    "desktop/mobile focused 브라우저 E2E와 변경 테스트의 정적 검사가 통과하고 실제 provider 호출은 발생하지 않는다.",
+    "새 package digest는 이 task와 authorization 및 변경된 E2E 테스트를 포함하고, 생성 records 디렉터리만 exact out/diff-exclude로 제외한다. Claude verdict는 그 digest에 결속한다."
+  ],
+  "baseCommit": "1f2115c6173b5ca2fb5e023f6a750243b0385cb1",
+  "writableScope": [
+    "tests/e2e/prompt-refiner-chat-input.spec.ts",
+    "docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-followup-v2"
+  ],
+  "generatedPaths": [],
+  "supersedes": {
+    "taskId": "prompt-refiner-same-instance-fixture-v1",
+    "exchange": "docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1/records/exchange.json"
+  }
+}
diff --git a/tests/e2e/prompt-refiner-chat-input.spec.ts b/tests/e2e/prompt-refiner-chat-input.spec.ts
index 24dff30da..4fc896860 100644
--- a/tests/e2e/prompt-refiner-chat-input.spec.ts
+++ b/tests/e2e/prompt-refiner-chat-input.spec.ts
@@ -244,7 +244,17 @@ test.describe("Prompt Refiner in the actual ChatInput", { tag: "@ui-risk" }, ()
         chatPosts += 1;
       }
     });
-    await enterChat(page, { offered: true });
+    await enterChat(page, { offered: true, modeRefresh: true });
+    await expect(page.getByTestId("prompt-refiner-fixture-refresh")).toHaveCount(1);
+    await page.evaluate(() => {
+      document.cookie = "__tomverse_e2e_prompt_refiner_mode_refresh=; Max-Age=0; Path=/";
+    });
+    await page.getByTestId("prompt-refiner-fixture-refresh").evaluate((button) => {
+      if (!(button instanceof HTMLButtonElement)) throw new Error("not a button");
+      button.click();
+    });
+    await expect(page.getByTestId("prompt-refiner-fixture-refresh")).toHaveCount(0);
+    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
     const responseGate = await holdRefinerResponse(page);
     const textarea = page.getByTestId("chat-textarea");
     await textarea.fill(SOURCE_PROMPT);
@@ -517,7 +527,7 @@ async function blockAndCountChatPosts(page: Page, durable: Awaited<ReturnType<ty
   await page.route("**/api/products/chat/conversations", async (route) => {
     if (route.request().method() !== "POST") {
       unexpectedCreateMethods.push(route.request().method());
-      await route.abort("aborted");
+      await route.fallback();
       return;
     }
     const conversation = {

```

## Test results (run by the control program)

- PASS `npx playwright test tests/e2e/prompt-refiner-chat-input.spec.ts --project=desktop-chromium --project=mobile-chromium --grep 'both explicit decisions|same-instance fixture mode transitions' --workers=1 --retries=0` (30901ms)
  ok 5 [mobile-chromium] › tests\e2e\prompt-refiner-chat-input.spec.ts:590:7 › Prompt Refiner same-instance fixture mode transitions › off/on/off/on discards ready and accepted previews without changing the authored draft @ui-risk (6.5s)
    ok 6 [mobile-chromium] › tests\e2e\prompt-refiner-chat-input.spec.ts:654:7 › Prompt Refiner same-instance fixture mode transitions › a pending response stays stale after off/on while the same Chat instance survives @ui-risk (4.3s)
  
    1 skipped
    5 passed (28.6s)

## Guard results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/promptRefinerSuggestion.test.mjs` (536ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 438.6875
- PASS `node --import tsx --test --test-reporter=spec tests/client/promptRefinerSuggestionRender.test.tsx` (549ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 456.4867
- PASS `npm run check:prompt-injection` (860ms)
  adversarial_retrieved_content_instruction_precedence_violations = 0
  18 adversarial payload(s) through memory (18), attachment (18), attachment-filename (18), profile-knowledge (18), prompt-refiner (18)
  not exercised: project (ConversationProject has a name and no instruction text, so no prompt path exists)
  Untrusted content stayed data at every fenced and role-separated boundary.
- PASS `npx eslint tests/e2e/prompt-refiner-chat-input.spec.ts` (3149ms)
- PASS `git diff --cached --check` (63ms)

## Findings from the previous round (check each was addressed)

- [nit/judgement] tests/e2e/prompt-refiner-chat-input.spec.ts:248: The new `toHaveCount(0)` runs immediately after `enterChat` resolves on server-rendered markup, but the control it denies is a `ssr: false` `next/dynamic` client component (components/chat/PromptRefinerFixtureRefreshLoader.tsx:7-10), so the assertion can be satisfied by the chunk not having mounted yet rather than by the second-cookie gate holding.

## Author's account (read last; a claim, not a finding)

Summary: Fix the inherited timing nit by proving fixture control mounted before cookie removal and checking its disappearance after RSC refresh; author-observed controlled wrong-gate mutation failed at post-refresh count0 Received 1, then shell restored byte-identical b4a351824228c374fbc28aac6773c7a906ebb464; independent normal focused E2E passed

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-same-instance-fixture-followup-v2",
  "round": 1,
  "reviewedDigest": "sha256:0cdb272f6470a98749737709d3bad45b6051cb31bfd0fa2c1a0cfcfc48d95d9f",
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
