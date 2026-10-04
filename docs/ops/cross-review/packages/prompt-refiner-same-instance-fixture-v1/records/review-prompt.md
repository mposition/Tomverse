# Independent review — task prompt-refiner-same-instance-fixture-v1, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Prompt Refiner의 loopback E2E fixture에서만 서버 mode prop을 off→on→off/on으로 바꾸고, 동일 mounted ChatPageClient에서 이전 ready·accepted preview와 전환 전 pending 응답이 폐기되는지 브라우저로 증명한다. 사용자 원문은 composer와 durable draft에 그대로 남고 합성 제안문이 draft PUT 또는 Chat POST로 승격되지 않아야 한다. fixture trigger는 서버측 loopback/auth/database-bypass 게이트와 별도 테스트 cookie 뒤에만 있으며 일반 사용자 DOM에는 없다. 제품 mode·공급자·Router·flag·stage/run·유료 호출·실제 사용자 traffic은 이 작업의 범위 밖이다. author는 Codex, 독립 reviewer는 Claude Code Max 구독 CLI다.

## Completion criteria

- desktop 및 mobile Chromium에서 off→on→off/on을 전체 문서 reload 없이 같은 ChatPageClient의 textarea DOM node로 재현하고, 새 server prop 적용을 각 전환에서 확인한다.
- ready와 accepted preview는 mode-off 직후 및 재활성화 후 나타나지 않고, 전환 전 pending 요청의 늦은 응답도 owner scope epoch에서 거부한다. Refiner fixture 요청의 늦은 응답 시험은 Router refresh의 AbortController 동작을 바꾸지 않는다.
- authored 원문은 composer와 durable draft PUT에서 보존되고 합성문이 durable draft에 기록되지 않는다. fixture-on 동안 Chat POST는 0건이며 fixture-off positive control의 Chat POST 1건은 원문을 포함하고 합성문을 포함하지 않으며 브라우저에서 중단된다.
- 테스트용 refresh control의 Client loader는 서버측 loopback E2E 게이트와 별도 cookie 없이는 렌더되지 않으며 제품 Refiner mode, provider, Router, rollout flag, stage/run 승인 또는 실제 사용자 traffic을 활성화하지 않는다.
- focused desktop/mobile E2E, Prompt Refiner unit 및 React render, prompt-injection 검사, 변경 파일 ESLint와 diff guard 결과를 각각 재현 가능하게 기록한다. 전체 typecheck에 기존 무관 오류가 남으면 경로·진단을 명시하고 전체 통과로 주장하지 않는다.
- 검토 package는 exact base 이후 변경된 다섯 source/test/UI 계약 경로와 이 task/authorization을 모두 포함하고, 생성된 records만 diff에서 제외한다. Claude verdict는 package digest와 일치해야 한다.
- Claude는 요구사항과 diff를 먼저, 작성자 테스트 기록을 다음에 검토한다. 저장된 Claude Code Max 구독 CLI의 Read/Grep/Glob 읽기 전용 제한과 사용자 승인 --skip-preflight 예외만 사용한다. Anthropic API, provider 유료 호출, 테스트 실패 우회, 자동 병합·배포는 허용하지 않는다.

## Change under review — digest sha256:26882d26dd20e5c8c0d7f2cd2a5c1d538d0b168c6a448806b3916e051230e2da

```diff
diff --git a/components/chat/PromptRefinerFixtureRefresh.tsx b/components/chat/PromptRefinerFixtureRefresh.tsx
new file mode 100644
index 000000000..1ee925898
--- /dev/null
+++ b/components/chat/PromptRefinerFixtureRefresh.tsx
@@ -0,0 +1,17 @@
+"use client";
+
+import { useRouter } from "next/navigation";
+
+/** Rendered only behind the server's loopback E2E gate and a test-only cookie. */
+export function PromptRefinerFixtureRefresh({ mode }: { mode: "off" | "e2e_fixture" }) {
+  const router = useRouter();
+  return (
+    <button
+      type="button"
+      hidden
+      data-testid="prompt-refiner-fixture-refresh"
+      data-mode={mode}
+      onClick={() => router.refresh()}
+    />
+  );
+}
diff --git a/components/chat/PromptRefinerFixtureRefreshLoader.tsx b/components/chat/PromptRefinerFixtureRefreshLoader.tsx
new file mode 100644
index 000000000..73e71c3de
--- /dev/null
+++ b/components/chat/PromptRefinerFixtureRefreshLoader.tsx
@@ -0,0 +1,14 @@
+"use client";
+
+import dynamic from "next/dynamic";
+
+// A Client boundary is required here: dynamic-importing a Client Component
+// directly from the server shell does not enable automatic code splitting.
+const FixtureRefresh = dynamic(
+  () => import("./PromptRefinerFixtureRefresh").then((mod) => mod.PromptRefinerFixtureRefresh),
+  { ssr: false }
+);
+
+export function PromptRefinerFixtureRefreshLoader({ mode }: { mode: "off" | "e2e_fixture" }) {
+  return <FixtureRefresh mode={mode} />;
+}
diff --git a/components/chat/ReviewWorkspaceShell.tsx b/components/chat/ReviewWorkspaceShell.tsx
index 10c71e1af..b4a351824 100644
--- a/components/chat/ReviewWorkspaceShell.tsx
+++ b/components/chat/ReviewWorkspaceShell.tsx
@@ -50,6 +50,7 @@ import {
 import { resolveWebSearchBackendReadiness } from "@/lib/webSearchBackendRuntime";
 import { GuestVerificationProvider } from "@/components/chat/GuestVerificationProvider";
 import { ChatPageClient } from "@/app/(site)/(application)/chat/ChatPageClient";
+import { PromptRefinerFixtureRefreshLoader } from "@/components/chat/PromptRefinerFixtureRefreshLoader";
 import { HelpGuideAccessProvider } from "@/components/chat/HelpGuideAccess";
 import { HELP_FLAG_KEYS } from "@/lib/helpNavigationIntents";
 
@@ -105,6 +106,7 @@ export async function ReviewWorkspaceShell({
   // below, so production cannot offer or call a Refiner yet.
   let promptRefinerAvailableToDeployment = false;
   let promptRefinerFixtureAdapterEnabled = false;
+  let promptRefinerFixtureModeRefreshEnabled = false;
   /*
     Whether the welcome screen offers the starter catalogue at all
     (docs/ui-contracts/chat-starter-catalog.md section 5).
@@ -206,6 +208,8 @@ export async function ReviewWorkspaceShell({
     // helper is still used so PROMPT_REFINER_KILL_SWITCH wins even in tests.
     promptRefinerFixtureAdapterEnabled =
       jar.get("__tomverse_e2e_prompt_refiner")?.value === "1";
+    promptRefinerFixtureModeRefreshEnabled =
+      jar.get("__tomverse_e2e_prompt_refiner_mode_refresh")?.value === "1";
     if (promptRefinerFixtureAdapterEnabled) {
       promptRefinerAvailableToDeployment = promptRefinerAvailable({
         storedFlagValue: "true",
@@ -247,6 +251,7 @@ export async function ReviewWorkspaceShell({
     available: promptRefinerAvailableToDeployment,
     adapterReady: promptRefinerFixtureAdapterEnabled,
   });
+  const promptRefinerMode = promptRefinerOffered ? "e2e_fixture" : "off";
 
   /*
     What the starter catalogue is allowed to promise on this request.
@@ -281,11 +286,14 @@ export async function ReviewWorkspaceShell({
       siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
     >
       <HelpGuideAccessProvider enabledFlagKeys={helpGuideEnabledFlagKeys}>
+      {promptRefinerFixtureModeRefreshEnabled ? (
+        <PromptRefinerFixtureRefreshLoader mode={promptRefinerMode} />
+      ) : null}
       <ChatPageClient
         guestDefaultModelId={guestDefaultModelId}
         imageGenerationEnabled={imageGenerationEnabled}
         voiceInputEnabled={voiceInputEnabled}
-        promptRefinerMode={promptRefinerOffered ? "e2e_fixture" : "off"}
+        promptRefinerMode={promptRefinerMode}
         // The composer cannot read this itself: `process.env` in a Client
         // Component is substituted at build time, so a client-side copy would
         // keep offering yesterday's limit after a deployment changed it. This
diff --git a/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1/authorization.md b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1/authorization.md
new file mode 100644
index 000000000..e53449aa3
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1/authorization.md
@@ -0,0 +1,55 @@
+# Prompt Refiner 동일 인스턴스 fixture 회귀 독립 검토 제한 승인 기록
+
+- approvedBy: `mposition` (대화에서 권장 순서 자동 진행·필요한 Claude 독립 검토·`--skip-preflight` 예외 승인)
+- approvedAt: `2026-09-21` (Australia/Brisbane, 해당 대화의 승인 기록 기준)
+- author: `codex`
+- independentReviewer: `claude-code-max`
+- task: [task.json](./task.json)
+
+이 기록은 사용자 지시의 **검토 범위**를 명시한다. 사용자 전자서명이나 검토 통과,
+제품 출시, 공급자 과금, commit·push·PR 병합·배포, stage/run 승인으로 해석하지 않는다.
+이 작업은 이미 종결된 fixture handoff exchange를 재개하거나 revision 상한을
+우회하지 않는 **별개의 동일 인스턴스 브라우저 회귀**다. cross-review control
+program의 고정 수정 round 상한과 digest 검증은 그대로 적용한다.
+
+검토 대상은 base commit `96a6990ee82cfa624affefac43e711a5244cd9ae` 이후
+변경된 다섯 구현·테스트·UI 계약 파일 및 이 디렉터리의 task/authorization이다.
+생성된 `records/`만 정확한 `--out` 경로로 package diff에서 제외한다.
+`records/`는 `generatedPaths`에 중복 선언하지 않아 package 작성 뒤 생긴
+기록 파일을 사전 snapshot drift로 오판하지 않는다. 이 범위 밖 파일 변경이나
+source/test 제외, 실패한 검사 우회는 허용하지 않는다. 검토자는 package digest에
+결속된 판정을 남겨야 한다.
+
+Claude 독립 검토에는 저장된 `claude.ai` Max 구독 CLI만 사용한다. 검토 child에서
+`ANTHROPIC_*`, `CLAUDE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` 및
+Bedrock/Vertex/Foundry 전환 변수를 제거하고 Max 로그인 상태가 확인되지 않으면
+중단한다. `claude --print --safe-mode --output-format json --tools
+Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`의 읽기 전용
+제한을 유지한다. Claude가 쓰기 도구를 갖지 않아 사전 검사 probe를 수행할 수
+없는 이 검토에 한해 사용자가 승인한 `--skip-preflight` 예외를 기록한다.
+Anthropic API fallback과 `--review-despite-check-failures`는 금지한다.
+
+author의 loopback fixture 브라우저 실행은 desktop·mobile 신규 4건 모두
+통과했다. 해당 두 Chromium 프로젝트 외에는 실행 시 명시적으로 skip한다.
+fixture on에서는 Chat POST 0건이고, off positive control에서 원문을 포함하고
+fixture 합성문을 포함하지 않는 POST 1건은 브라우저가 서버 전송 전에 중단한다.
+서버의 loopback·cookie 게이트 아래에서만 Client loader가 렌더되고, 실제
+refresh 버튼은 loader 안에서 동적 import한다. 이는 코드 경계이며 측정 없는
+production bundle 크기·chunk 제외 주장으로 해석하지 않는다.
+author가 처음에 unit과 render를 잘못 같은 React-server 조건으로
+실행한 혼합 명령은 unit 11건이 각각 통과했지만 render import 실패로 **명령
+전체가 실패**했다. 이후 올바른 조건의 별도 render 명령은 10/10 통과했다.
+독립 검증 담당은 unit-only 11/11과 render-only 10/10을 각각 성공한 명령으로
+다시 실행했다. 실패한 author 혼합 명령을 이 성공 기록으로 덮어쓰지 않는다.
+prompt-injection 검사는 위반 0, 변경 파일 ESLint 및 `git diff --check`는
+통과했다. author의 로컬 TypeScript 실행에는 변경 밖의 기존
+`tests/integration/marketing-automation-schema.db.test.ts:742`의
+`factsDigest` TS2339 한 건이 나왔다. 독립 검증 담당의 최종
+`next typegen` + `tsc`에는 그 오류와 별도로
+`.next/dev/types/app/api/assistant-profiles/route.ts`의 기존
+`assistantProfileErrorResponse` export 오류도 나와 **총 두 baseline 오류**가
+관측됐다. 검토 package의 신규 검사 기록은 두 실행 환경의 차이를 숨기거나
+전체 typecheck 통과로 표현하지 않아야 한다.
+
+제품 Prompt Refiner mode·provider·Router·flag 전환, stage/run 승인, 유료 실행,
+실제 사용자 traffic, 자동 PR 병합·배포는 승인 범위 밖이다.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1/task.json b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1/task.json
new file mode 100644
index 000000000..4836cac8f
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1/task.json
@@ -0,0 +1,23 @@
+{
+  "taskId": "prompt-refiner-same-instance-fixture-v1",
+  "requirement": "Prompt Refiner의 loopback E2E fixture에서만 서버 mode prop을 off→on→off/on으로 바꾸고, 동일 mounted ChatPageClient에서 이전 ready·accepted preview와 전환 전 pending 응답이 폐기되는지 브라우저로 증명한다. 사용자 원문은 composer와 durable draft에 그대로 남고 합성 제안문이 draft PUT 또는 Chat POST로 승격되지 않아야 한다. fixture trigger는 서버측 loopback/auth/database-bypass 게이트와 별도 테스트 cookie 뒤에만 있으며 일반 사용자 DOM에는 없다. 제품 mode·공급자·Router·flag·stage/run·유료 호출·실제 사용자 traffic은 이 작업의 범위 밖이다. author는 Codex, 독립 reviewer는 Claude Code Max 구독 CLI다.",
+  "completionCriteria": [
+    "desktop 및 mobile Chromium에서 off→on→off/on을 전체 문서 reload 없이 같은 ChatPageClient의 textarea DOM node로 재현하고, 새 server prop 적용을 각 전환에서 확인한다.",
+    "ready와 accepted preview는 mode-off 직후 및 재활성화 후 나타나지 않고, 전환 전 pending 요청의 늦은 응답도 owner scope epoch에서 거부한다. Refiner fixture 요청의 늦은 응답 시험은 Router refresh의 AbortController 동작을 바꾸지 않는다.",
+    "authored 원문은 composer와 durable draft PUT에서 보존되고 합성문이 durable draft에 기록되지 않는다. fixture-on 동안 Chat POST는 0건이며 fixture-off positive control의 Chat POST 1건은 원문을 포함하고 합성문을 포함하지 않으며 브라우저에서 중단된다.",
+    "테스트용 refresh control의 Client loader는 서버측 loopback E2E 게이트와 별도 cookie 없이는 렌더되지 않으며 제품 Refiner mode, provider, Router, rollout flag, stage/run 승인 또는 실제 사용자 traffic을 활성화하지 않는다.",
+    "focused desktop/mobile E2E, Prompt Refiner unit 및 React render, prompt-injection 검사, 변경 파일 ESLint와 diff guard 결과를 각각 재현 가능하게 기록한다. 전체 typecheck에 기존 무관 오류가 남으면 경로·진단을 명시하고 전체 통과로 주장하지 않는다.",
+    "검토 package는 exact base 이후 변경된 다섯 source/test/UI 계약 경로와 이 task/authorization을 모두 포함하고, 생성된 records만 diff에서 제외한다. Claude verdict는 package digest와 일치해야 한다.",
+    "Claude는 요구사항과 diff를 먼저, 작성자 테스트 기록을 다음에 검토한다. 저장된 Claude Code Max 구독 CLI의 Read/Grep/Glob 읽기 전용 제한과 사용자 승인 --skip-preflight 예외만 사용한다. Anthropic API, provider 유료 호출, 테스트 실패 우회, 자동 병합·배포는 허용하지 않는다."
+  ],
+  "baseCommit": "96a6990ee82cfa624affefac43e711a5244cd9ae",
+  "writableScope": [
+    "components/chat/ReviewWorkspaceShell.tsx",
+    "components/chat/PromptRefinerFixtureRefresh.tsx",
+    "components/chat/PromptRefinerFixtureRefreshLoader.tsx",
+    "tests/e2e/prompt-refiner-chat-input.spec.ts",
+    "docs/ui-contracts/prompt-refiner-suggestion.md",
+    "docs/ops/cross-review/packages/prompt-refiner-same-instance-fixture-v1"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ui-contracts/prompt-refiner-suggestion.md b/docs/ui-contracts/prompt-refiner-suggestion.md
index 1faaaffe6..532b9ebeb 100644
--- a/docs/ui-contracts/prompt-refiner-suggestion.md
+++ b/docs/ui-contracts/prompt-refiner-suggestion.md
@@ -75,9 +75,13 @@ fixture 전용 resolver는 원문을 반환한다. 두 경우 모두 `executionP
 composer→Image handoff도 차단된다. fixture cookie를 제거하거나 다시 로드해도
 제안문은 제품 draft에 없으므로 실행 입력으로 승격되지 않는다. 제품 모드의
 원문 보존/실행문 분리 전송은 별도 server handoff로 구현해야 한다.
-현재 브라우저 회귀는 cookie 제거 후 전체 reload와 재활성화 reload를 검증한다.
-동일 mounted instance의 server prop 전환은 mode를 scope epoch에 포함해 reset하지만,
-그 전환을 실제 브라우저에서 재현하는 별도 검증은 제품 모드 연결 전에 필요하다.
+브라우저 회귀는 cookie 제거 후 전체 reload와 재활성화 reload뿐 아니라,
+loopback E2E 전용 `router.refresh()`로 동일 mounted `ChatPageClient`에 새 server prop을
+적용하는 off→on→off/on 전환도 검증한다. 동일 document와 textarea DOM node를
+유지하면서 ready·accepted preview를 폐기하고, 늦게 도착한 pending 응답도
+scope epoch로 거부한다. desktop Chromium은 1366×768의 `desktop-chat-shell`,
+mobile Chromium은 390×680의 `mobile-chat-shell`을 각각 확인한다. 이 검증은
+fixture 경계이며 제품 모드를 켜지 않는다.
 
 ## 4. Refiner가 읽을 수 있는 것은 현재 턴 텍스트뿐이다
 
@@ -210,7 +214,13 @@ provider adapter와 자동 요청을 활성화하려면 다음이 별도로 필
   같은 제안의 중복 소비는 순수 validator 단위 테스트로 검증한다. 브라우저 E2E는
   미리보기 확인 뒤 재요청 차단, 대화 전환 후 복원, Image seed 차단,
   `/chat/workspace`의 원문 draft PUT·합성문 부재 및 fixture mode off/on 전체
-  reload를 검증한다. 실제 편집 후에만 새 요청이 보이는지도 검사한다.
+  reload를 검증한다. 별도 desktop·mobile shell 회귀는 같은 mounted 인스턴스에서
+  서버 prop off→on→off/on 전환 후 ready·accepted·pending 결과의 폐기,
+  원문 draft 보존과 fixture on 상태의 Chat POST 0건을 검증한다. 같은
+  browser-mocked 인증·durable 환경에서 fixture off로 전환한 뒤에는 Chat POST
+  1건이 실제로 시작되는 positive control을 확인하고, 그 요청은 Playwright가
+  즉시 중단해 서버·provider에는 전달하지 않는다. 실제 편집 후에만 새 요청이
+  보이는지도 검사한다.
 - `tests/e2e/prompt-refiner-focus.spec.ts`: E2E 전용 fixture에서 초기 mount가
   textarea focus를 빼앗지 않는지, 새 requesting·failed·ready 도착에는 한 번씩
   focus가 이동하는지, draft를 바꿨다가 같은 source로 되돌려도 같은 제안이
diff --git a/tests/e2e/prompt-refiner-chat-input.spec.ts b/tests/e2e/prompt-refiner-chat-input.spec.ts
index e236b6855..24dff30da 100644
--- a/tests/e2e/prompt-refiner-chat-input.spec.ts
+++ b/tests/e2e/prompt-refiner-chat-input.spec.ts
@@ -58,7 +58,9 @@ async function enterChat(page: Page, options: {
   withImageGeneration?: boolean;
   withConversationPair?: boolean;
   durableChat?: boolean;
+  modeRefresh?: boolean;
   viewport?: { width: number; height: number };
+  expectedShell?: "mobile" | "desktop";
 } = {}) {
   await prepareGuestPage(page, "ko");
   await mockAuthenticatedApi(page, options.withConversationPair
@@ -94,19 +96,75 @@ async function enterChat(page: Page, options: {
           url: "http://127.0.0.1:3100",
         }]
       : []),
+    ...(options.modeRefresh
+      ? [{
+          name: "__tomverse_e2e_prompt_refiner_mode_refresh",
+          value: "1",
+          url: "http://127.0.0.1:3100",
+        }]
+      : []),
   ]);
   if (options.withConversationPair && !options.durableChat) {
     await restoreActiveConversation(page, PRIMARY_CONVERSATION);
   }
   await page.setViewportSize(options.viewport ?? { width: 390, height: 680 });
   await page.goto(options.durableChat ? "/chat/workspace?lang=ko" : "/chat?lang=ko");
-  await expect(page.getByTestId("mobile-chat-shell")).toBeVisible({ timeout: 30_000 });
+  await expect(page.getByTestId(`${options.expectedShell ?? "mobile"}-chat-shell`))
+    .toBeVisible({ timeout: 30_000 });
   await expect(page.getByTestId("chat-textarea")).toBeVisible();
   if (options.withConversationPair) {
     await expect(page.getByText("Primary history", { exact: true })).toBeVisible();
   }
 }
 
+async function refreshPromptRefinerFixtureMode(page: Page, enabled: boolean) {
+  if (enabled) {
+    await page.context().addCookies([{
+      name: "__tomverse_e2e_prompt_refiner",
+      value: "1",
+      url: "http://127.0.0.1:3100",
+    }]);
+  } else {
+    await page.evaluate(() => {
+      document.cookie = "__tomverse_e2e_prompt_refiner=; Max-Age=0; Path=/";
+    });
+  }
+  await page.getByTestId("prompt-refiner-fixture-refresh").evaluate((button) => {
+    if (!(button instanceof HTMLButtonElement)) throw new Error("not a button");
+    button.click();
+  });
+  await expect(page.getByTestId("prompt-refiner-fixture-refresh"))
+    .toHaveAttribute("data-mode", enabled ? "e2e_fixture" : "off", { timeout: 20_000 });
+  if (enabled) {
+    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
+  } else {
+    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
+  }
+}
+
+async function markPromptRefinerComposerInstance(page: Page) {
+  await page.evaluate(() => {
+    const probe = window as Window & {
+      __promptRefinerComposerProbe?: Element | null;
+      __promptRefinerWindowProbe?: string;
+    };
+    probe.__promptRefinerComposerProbe = document.querySelector('[data-testid="chat-textarea"]');
+    probe.__promptRefinerWindowProbe = "same-document";
+  });
+}
+
+async function expectPromptRefinerComposerInstancePreserved(page: Page) {
+  expect(await page.evaluate(() => {
+    const probe = window as Window & {
+      __promptRefinerComposerProbe?: Element | null;
+      __promptRefinerWindowProbe?: string;
+    };
+    return probe.__promptRefinerWindowProbe === "same-document" &&
+      probe.__promptRefinerComposerProbe !== null &&
+      probe.__promptRefinerComposerProbe === document.querySelector('[data-testid="chat-textarea"]');
+  }), "the Chat composer remounted during the server-prop transition").toBe(true);
+}
+
 async function selectConversation(page: Page, conversationId: string) {
   await page.getByTestId("mobile-sidebar-open").click();
   const drawer = page.getByTestId("mobile-chat-shell").getByRole("dialog");
@@ -176,6 +234,7 @@ test.describe("Prompt Refiner in the actual ChatInput", { tag: "@ui-risk" }, ()
     await enterChat(page);
     await page.getByTestId("chat-textarea").fill(SOURCE_PROMPT);
     await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
+    await expect(page.getByTestId("prompt-refiner-fixture-refresh")).toHaveCount(0);
   });
 
   test("both explicit decisions return focus and never submit", async ({ page }) => {
@@ -447,3 +506,209 @@ test.describe("Prompt Refiner in the actual ChatInput", { tag: "@ui-risk" }, ()
     });
   }
 });
+
+async function blockAndCountChatPosts(page: Page, durable: Awaited<ReturnType<typeof mockDurableDrafts>>) {
+  let posts = 0;
+  const postBodies: string[] = [];
+  const unexpectedCreateMethods: string[] = [];
+  // The positive control needs the real Chat send path to reach /api/chat.
+  // Keep its preceding durable create/save steps inside the browser fixture;
+  // they do not touch the database or a provider.
+  await page.route("**/api/products/chat/conversations", async (route) => {
+    if (route.request().method() !== "POST") {
+      unexpectedCreateMethods.push(route.request().method());
+      await route.abort("aborted");
+      return;
+    }
+    const conversation = {
+      id: PRIMARY_CONVERSATION, title: "QA conversation", productKey: "chat",
+      surface: "chat", selectedModels: ["gpt-5-6-luna"], disabledPanels: [],
+      webSearchMode: "off", isLocked: false,
+    };
+    await route.fulfill({ status: 201, json: conversation });
+  });
+  await page.route("**/api/chat/context", (route) =>
+    route.fulfill({ json: { contextBundle: null } })
+  );
+  await page.route(`**/api/conversations/${PRIMARY_CONVERSATION}/messages`, async (route) => {
+    if (route.request().method() !== "POST") return route.fallback();
+    const body = route.request().postDataJSON() as {
+      messages?: Array<{ clientRequestId?: string }>;
+      draftConsume?: { scopeKey?: string; expectedRevision?: number; requestId?: string };
+    };
+    const consume = body.draftConsume;
+    const requestId = body.messages?.[0]?.clientRequestId;
+    const draft = consume?.scopeKey ? durable.drafts.get(consume.scopeKey) : null;
+    if (!requestId || requestId !== consume?.requestId || !draft ||
+        draft.revision !== consume.expectedRevision) {
+      return route.fulfill({ status: 409, json: { code: "QA_DRAFT_CONSUME_MISMATCH" } });
+    }
+    durable.drafts.delete(consume.scopeKey!);
+    return route.fulfill({ status: 201, json: {
+      success: true, created: 1, draftConsumed: true,
+      messageMappings: [{ requestId, messageId: "11111111-1111-4111-8111-111111111111" }],
+      attachments: [],
+    } });
+  });
+  // Install after the authenticated fixture routes, so this exact Chat route
+  // wins route precedence and no request can reach a provider.
+  await page.route(/\/api\/chat(?:$|\?)/, async (route) => {
+    if (route.request().method() === "POST") {
+      posts += 1;
+      postBodies.push(route.request().postData() ?? "");
+      await route.abort("aborted");
+      return;
+    }
+    await route.fallback();
+  });
+  return {
+    posts: () => posts,
+    bodies: () => [...postBodies],
+    unexpectedCreateMethods: () => [...unexpectedCreateMethods],
+  };
+}
+
+test.describe("Prompt Refiner same-instance fixture mode transitions", { tag: "@ui-risk" }, () => {
+  test.setTimeout(60_000); // cold loopback RSC compilation may outlast the default 30s test budget
+  test.beforeEach(async ({}, testInfo) => {
+    test.skip(
+      !["desktop-chromium", "mobile-chromium"].includes(testInfo.project.name),
+      "Same-instance fixture transitions are measured on desktop and mobile Chromium."
+    );
+  });
+
+  test("off/on/off/on discards ready and accepted previews without changing the authored draft", async ({ page }, testInfo) => {
+    const durable = await mockDurableDrafts(page);
+    const desktop = testInfo.project.name === "desktop-chromium";
+    await enterChat(page, { durableChat: true, modeRefresh: true,
+      viewport: desktop ? { width: 1366, height: 768 } : undefined,
+      expectedShell: desktop ? "desktop" : "mobile" });
+    const chatProbe = await blockAndCountChatPosts(page, durable);
+    await expect(page.getByTestId("prompt-refiner-fixture-refresh")).toHaveCount(1);
+    await expect(page.getByTestId("prompt-refiner-request")).toHaveCount(0);
+    await markPromptRefinerComposerInstance(page);
+    const textarea = page.getByTestId("chat-textarea");
+    await textarea.fill(SOURCE_PROMPT);
+    await expect.poll(() => durable.writes.includes(SOURCE_PROMPT)).toBe(true);
+
+    await refreshPromptRefinerFixtureMode(page, true);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(textarea).toHaveValue(SOURCE_PROMPT);
+    await page.getByTestId("prompt-refiner-request").click();
+    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible({ timeout: 30_000 });
+
+    await refreshPromptRefinerFixtureMode(page, false);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
+    await expect(textarea).toHaveValue(SOURCE_PROMPT);
+    await refreshPromptRefinerFixtureMode(page, true);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
+    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
+
+    await page.getByTestId("prompt-refiner-request").click();
+    await expect(page.getByTestId("prompt-refiner-ready")).toBeVisible({ timeout: 30_000 });
+    await page.getByTestId("prompt-refiner-use").click();
+    const proposal = page.getByTestId("prompt-refiner-accepted-preview-proposal");
+    await expect(proposal).toContainText("목표, 제약 조건, 원하는 출력 형식");
+    const synthetic = (await proposal.textContent()) ?? "";
+    expect(synthetic).not.toBe(SOURCE_PROMPT);
+    await expect(textarea).toHaveValue(SOURCE_PROMPT);
+
+    await refreshPromptRefinerFixtureMode(page, false);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
+    await refreshPromptRefinerFixtureMode(page, true);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
+    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
+    await expect(textarea).toHaveValue(SOURCE_PROMPT);
+    await page.waitForTimeout(1000); // full durable-draft debounce after the mode transitions
+    expect(durable.writes).not.toContain(synthetic);
+    expect([...durable.drafts.values()].every((draft) => draft.text !== synthetic)).toBe(true);
+    await page.getByTestId("chat-send-button").click();
+    await page.waitForTimeout(500);
+    expect(chatProbe.posts(), "fixture mode dispatched a Chat turn").toBe(0);
+    await refreshPromptRefinerFixtureMode(page, false);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(textarea).toHaveValue(SOURCE_PROMPT);
+    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
+    await page.getByTestId("chat-send-button").click();
+    await expect.poll(chatProbe.posts).toBe(1); // positive control: off mode reaches the blocked Chat route
+    expect(chatProbe.bodies()).toHaveLength(1);
+    expect(chatProbe.bodies()[0]).toContain(SOURCE_PROMPT);
+    expect(chatProbe.bodies()[0]).not.toContain(synthetic);
+    expect(chatProbe.unexpectedCreateMethods()).toEqual([]);
+  });
+
+  test("a pending response stays stale after off/on while the same Chat instance survives", async ({ page }, testInfo) => {
+    const durable = await mockDurableDrafts(page);
+    const desktop = testInfo.project.name === "desktop-chromium";
+    await enterChat(page, { durableChat: true, modeRefresh: true,
+      viewport: desktop ? { width: 1366, height: 768 } : undefined,
+      expectedShell: desktop ? "desktop" : "mobile" });
+    const chatProbe = await blockAndCountChatPosts(page, durable);
+    await markPromptRefinerComposerInstance(page);
+    const textarea = page.getByTestId("chat-textarea");
+    await textarea.fill(SOURCE_PROMPT);
+    await expect.poll(() => durable.writes.includes(SOURCE_PROMPT)).toBe(true);
+    await refreshPromptRefinerFixtureMode(page, true);
+    await expectPromptRefinerComposerInstancePreserved(page);
+
+    // Keep the fixture response deliverable after its owner aborts, so the
+    // scope epoch must reject it. Other requests, including router.refresh,
+    // keep their normal AbortController and fetch cancellation semantics.
+    await page.evaluate(() => {
+      const originalFetch = window.fetch.bind(window);
+      window.fetch = (input, init) => {
+        const url = input instanceof Request ? input.url : String(input);
+        if (new URL(url, window.location.href).pathname === "/e2e/prompt-refiner-adapter") {
+          return originalFetch(input, { ...init, signal: undefined });
+        }
+        return originalFetch(input, init);
+      };
+    });
+    const responseGate = await holdRefinerResponse(page);
+    await page.getByTestId("prompt-refiner-request").click();
+    await responseGate.intercepted;
+    await expect(page.getByTestId("prompt-refiner-requesting")).toBeVisible();
+    await refreshPromptRefinerFixtureMode(page, false);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await refreshPromptRefinerFixtureMode(page, true);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(page.getByTestId("prompt-refiner-requesting")).toHaveCount(0);
+    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
+    const lateResponse = page.waitForResponse((response) =>
+      response.url().endsWith("/e2e/prompt-refiner-adapter") &&
+      response.request().method() === "POST"
+    );
+    const previouslySettled = Number(await page.evaluate(
+      () => document.documentElement.dataset.promptRefinerFixtureSettled ?? "0"
+    ));
+    responseGate.release();
+    const response = await lateResponse;
+    await response.finished();
+    await expect.poll(() => page.evaluate(
+      () => Number(document.documentElement.dataset.promptRefinerFixtureSettled ?? "0")
+    )).toBeGreaterThan(previouslySettled);
+    await expect(page.getByTestId("prompt-refiner-ready")).toHaveCount(0);
+    await expect(page.getByTestId("prompt-refiner-accepted-preview")).toHaveCount(0);
+    await expect(page.getByTestId("prompt-refiner-request")).toBeVisible();
+    await expect(textarea).toHaveValue(SOURCE_PROMPT);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    expect(durable.writes.every((text) => text === SOURCE_PROMPT)).toBe(true);
+    await page.getByTestId("chat-send-button").click();
+    await page.waitForTimeout(500);
+    expect(chatProbe.posts(), "stale fixture response dispatched a Chat turn").toBe(0);
+    await refreshPromptRefinerFixtureMode(page, false);
+    await expectPromptRefinerComposerInstancePreserved(page);
+    await expect(textarea).toHaveValue(SOURCE_PROMPT);
+    await expect(page.getByTestId("chat-send-button")).toBeEnabled();
+    await page.getByTestId("chat-send-button").click();
+    await expect.poll(chatProbe.posts).toBe(1); // positive control cannot reach the server/provider
+    expect(chatProbe.bodies()).toHaveLength(1);
+    expect(chatProbe.bodies()[0]).toContain(SOURCE_PROMPT);
+    expect(chatProbe.bodies()[0]).not.toContain("목표, 제약 조건, 원하는 출력 형식");
+    expect(chatProbe.unexpectedCreateMethods()).toEqual([]);
+  });
+});

```

## Test results (run by the control program)

- PASS `npx playwright test tests/e2e/prompt-refiner-chat-input.spec.ts --project=desktop-chromium --project=mobile-chromium --grep 'same-instance fixture mode transitions' --workers=1 --retries=0` (52453ms)
  ok 2 [desktop-chromium] › tests\e2e\prompt-refiner-chat-input.spec.ts:644:7 › Prompt Refiner same-instance fixture mode transitions › a pending response stays stale after off/on while the same Chat instance survives @ui-risk (5.0s)
    ok 3 [mobile-chromium] › tests\e2e\prompt-refiner-chat-input.spec.ts:580:7 › Prompt Refiner same-instance fixture mode transitions › off/on/off/on discards ready and accepted previews without changing the authored draft @ui-risk (5.9s)
    ok 4 [mobile-chromium] › tests\e2e\prompt-refiner-chat-input.spec.ts:644:7 › Prompt Refiner same-instance fixture mode transitions › a pending response stays stale after off/on while the same Chat instance survives @ui-risk (4.7s)
  
    4 passed (51.1s)

## Guard results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test --test-concurrency=1 --test-reporter=spec tests/promptRefinerSuggestion.test.mjs` (477ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 394.2071
- PASS `node --import tsx --test --test-reporter=spec tests/client/promptRefinerSuggestionRender.test.tsx` (496ms)
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 420.9646
- PASS `npm run check:prompt-injection` (766ms)
  adversarial_retrieved_content_instruction_precedence_violations = 0
  18 adversarial payload(s) through memory (18), attachment (18), attachment-filename (18), profile-knowledge (18), prompt-refiner (18)
  not exercised: project (ConversationProject has a name and no instruction text, so no prompt path exists)
  Untrusted content stayed data at every fenced and role-separated boundary.
- PASS `npx eslint components/chat/PromptRefinerFixtureRefresh.tsx components/chat/PromptRefinerFixtureRefreshLoader.tsx components/chat/ReviewWorkspaceShell.tsx tests/e2e/prompt-refiner-chat-input.spec.ts` (3779ms)
- PASS `git diff --cached --check` (51ms)

## Findings from the previous round (check each was addressed)

- [warning/judgement] tests/e2e/prompt-refiner-chat-input.spec.ts:565 (describe "Prompt Refiner same-instance fixture mode transitions"): Unlike the file's other describe (line 226-231, which skips every project but desktop-chromium), the new describe has no project restriction and derives its shell expectation from `testInfo.project.name === "desktop-chromium"`, so a full-suite run also executes it on WebKit `mobile-safari` and on `desktop-compact` (whose native 1366x768 desktop viewport is then overridden to 390x680 and asserted as `mobile-chat-shell`) — neither covered by the recorded two-project evidence.
- [nit/judgement] tests/e2e/prompt-refiner-chat-input.spec.ts:585-596 (blockAndCountChatPosts) and :617-620, :686-689: The Chat probe only counts POSTs and never reads `route.request().postData()`, so the requirement's "합성 제안문이 … Chat POST로 승격되지 않아야 한다" is evidenced only by a count; the one POST the positive control does observe is never checked to carry the authored text rather than the synthetic proposal.
- [nit/judgement] components/chat/PromptRefinerFixtureRefresh.tsx:1-17 and components/chat/ReviewWorkspaceShell.tsx:53 (static import): The fixture-only client component is statically imported by the production chat shell, so its code is emitted into the client bundle of every chat route even though the loopback+cookie gate means it can never render there.

## Author's account (read last; a claim, not a finding)

Summary: Loopback-only Prompt Refiner same-instance mode regression, explicit Chromium project scope, original-only Chat POST positive control, deferred fixture helper

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-same-instance-fixture-v1",
  "round": 2,
  "reviewedDigest": "sha256:26882d26dd20e5c8c0d7f2cd2a5c1d538d0b168c6a448806b3916e051230e2da",
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
