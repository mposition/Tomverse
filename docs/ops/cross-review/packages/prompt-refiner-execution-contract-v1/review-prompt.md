# Independent review — task prompt-refiner-execution-contract-v1, round 1

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Prompt Refiner를 제품에서 활성화하거나 provider를 호출하지 않은 채 첫 shadow 실행의 provider-independent 사전등록 계약을 고정한다. 계약은 Refiner·model/catalog/pricing identity, context와 reasoning billing, 입력·출력 cap, timeout, retry 0, 요청·단계 최악 비용을 정확히 고정하고 drift를 fail-closed한다. 현재 원자 예약 authority가 없으므로 caller가 만든 lease나 boolean으로 성공 admission을 만들 수 없어야 하며, 모든 다른 조건이 맞아도 reservation_authority_unavailable로 dispatch 전에 거절해야 한다. terminal reason은 content-free receipt의 lifecycle·failure layer/code·disposition 단계에 하나씩 매핑되고 receipt schema와 합치해야 한다. runtime writer, 원자 예약 구현, provider adapter/API/model 호출, billing, 제품 mode, Router 결합, AppSetting writer, flag 활성화, 유료 benchmark와 rollout 승인은 포함하지 않는다. author는 codex, reviewer는 claude이며 Claude Code Max 구독 CLI의 읽기 전용 도구만 사용한다.

## Completion criteria

- 실행 계약은 gpt-5-6-luna의 provider·catalog/API model·pricing version/effective date·routing·tier·reasoning effort·context window·reasoning token billing과 입출력 단가를 정확히 고정하고 checked-in catalog/pricing drift를 거절한다.
- 입력 100000 tokens, 출력 4096 tokens, context 요구량 104096 tokens, timeout 15000ms, retry 0, 요청당 24916 microUSD, 최대 100 dispatch와 단계 2491600 microUSD가 같은 가격 계산 경로에서 도출되고 경계 테스트로 고정된다.
- admission은 eligibility, 별도 단계 승인, adapter readiness, 정확한 계약 identity를 순서대로 fail-closed하며, 원자 예약 authority가 없는 현재 계약에는 admitted true 경로가 없고 caller가 임의의 lease·atomic 표식을 추가해도 reservation_authority_unavailable로 거절한다.
- 성공 admission을 후속 계약에 추가하려면 requestId 결속, 만료, stage slot과 최악 비용의 원자 예약, 1회 consume을 실제 authority가 제공해야 한다는 경계가 코드와 정책에 기록된다.
- 모든 공개 admission refusal과 terminal reason은 도달 가능하고 content-free receipt lifecycle·failure layer/code·retry 0·disposition 단계에 전단사적으로 매핑되며 strict receipt schema가 그 조합을 검증한다.
- 기존 Prompt Refiner 제안·receipt 계약과 관련 문서는 provider 호출, 제품 writer/adapter, flag 활성화 또는 rollout 승인을 주장하지 않고 현재 authority 부재와 default-off 경계를 정확히 설명한다.
- 관련 unit, 전체 typecheck, lint, model-pricing, 문서·정책 참조, strict encoding과 diff whitespace 검사가 통과한다.
- Claude Code Max는 사용자가 승인한 skip-preflight 예외 아래 Read·Grep·Glob만으로 고정 digest를 독립 검토하며 Anthropic API key를 사용하지 않는다. 최초 검토와 최대 2회 수정 검토만 허용한다.

## Change under review — digest sha256:ca9d7a2aa1a27fe5241c404815c985921d69dd809708a83a8d7212432df92618, commit b87863d325eb24b43b3e12248ad0d593b5be86c3

```diff
diff --git a/AGENTS.md b/AGENTS.md
index 41c949d6..fafe4330 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1294,8 +1294,9 @@ Non-negotiable requirements:
 
 Before changing the Prompt Refiner surface or request boundary in
 `ChatInput.tsx`, `PromptRefinerSuggestionPanel.tsx`,
-`lib/promptRefinerSuggestion.ts`, `lib/promptRefinerModelPrompt.ts`, or
-`lib/promptRefinerReceiptCore.ts`, read:
+`lib/promptRefinerSuggestion.ts`, `lib/promptRefinerModelPrompt.ts`,
+`lib/promptRefinerReceiptCore.ts`, `lib/promptRefinerExecutionContract.ts`, or
+their tests, read:
 
 - `docs/ui-contracts/prompt-refiner-suggestion.md`
 - `docs/policy/prompt-refiner-observability.md`
@@ -1329,6 +1330,14 @@ Non-negotiable requirements:
 - No provider call, billing, automatic offer, Router coupling or rollout is
   implied by the composer seam. Each requires its own approved server-owned
   gate and evidence.
+- The execution preregistration is pure and fail-closed. Exact contract,
+  refiner, model/catalog/pricing identity, output cap, timeout, retry zero and
+  request/stage cost ceilings are frozen, but no reservation authority exists.
+  Admission therefore always refuses before dispatch with
+  `reservation_authority_unavailable` after earlier checks pass. A caller-made
+  lease or atomic boolean is never proof. Only a future authority with atomic
+  requestId binding, expiry and one-time consume may introduce `admitted: true`
+  under a new contract version. Product mode remains unadmitted.
 - The current server gate folds the default-off AppSetting, environment kill
   switch and adapter readiness into one mode. The only active mode is the
   loopback E2E fixture; a stored flag alone must never expose an inert product
diff --git a/docs/ops/cross-review/packages/prompt-refiner-execution-contract-v1.task.json b/docs/ops/cross-review/packages/prompt-refiner-execution-contract-v1.task.json
new file mode 100644
index 00000000..fa852e86
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-execution-contract-v1.task.json
@@ -0,0 +1,28 @@
+{
+  "taskId": "prompt-refiner-execution-contract-v1",
+  "requirement": "Prompt Refiner를 제품에서 활성화하거나 provider를 호출하지 않은 채 첫 shadow 실행의 provider-independent 사전등록 계약을 고정한다. 계약은 Refiner·model/catalog/pricing identity, context와 reasoning billing, 입력·출력 cap, timeout, retry 0, 요청·단계 최악 비용을 정확히 고정하고 drift를 fail-closed한다. 현재 원자 예약 authority가 없으므로 caller가 만든 lease나 boolean으로 성공 admission을 만들 수 없어야 하며, 모든 다른 조건이 맞아도 reservation_authority_unavailable로 dispatch 전에 거절해야 한다. terminal reason은 content-free receipt의 lifecycle·failure layer/code·disposition 단계에 하나씩 매핑되고 receipt schema와 합치해야 한다. runtime writer, 원자 예약 구현, provider adapter/API/model 호출, billing, 제품 mode, Router 결합, AppSetting writer, flag 활성화, 유료 benchmark와 rollout 승인은 포함하지 않는다. author는 codex, reviewer는 claude이며 Claude Code Max 구독 CLI의 읽기 전용 도구만 사용한다.",
+  "completionCriteria": [
+    "실행 계약은 gpt-5-6-luna의 provider·catalog/API model·pricing version/effective date·routing·tier·reasoning effort·context window·reasoning token billing과 입출력 단가를 정확히 고정하고 checked-in catalog/pricing drift를 거절한다.",
+    "입력 100000 tokens, 출력 4096 tokens, context 요구량 104096 tokens, timeout 15000ms, retry 0, 요청당 24916 microUSD, 최대 100 dispatch와 단계 2491600 microUSD가 같은 가격 계산 경로에서 도출되고 경계 테스트로 고정된다.",
+    "admission은 eligibility, 별도 단계 승인, adapter readiness, 정확한 계약 identity를 순서대로 fail-closed하며, 원자 예약 authority가 없는 현재 계약에는 admitted true 경로가 없고 caller가 임의의 lease·atomic 표식을 추가해도 reservation_authority_unavailable로 거절한다.",
+    "성공 admission을 후속 계약에 추가하려면 requestId 결속, 만료, stage slot과 최악 비용의 원자 예약, 1회 consume을 실제 authority가 제공해야 한다는 경계가 코드와 정책에 기록된다.",
+    "모든 공개 admission refusal과 terminal reason은 도달 가능하고 content-free receipt lifecycle·failure layer/code·retry 0·disposition 단계에 전단사적으로 매핑되며 strict receipt schema가 그 조합을 검증한다.",
+    "기존 Prompt Refiner 제안·receipt 계약과 관련 문서는 provider 호출, 제품 writer/adapter, flag 활성화 또는 rollout 승인을 주장하지 않고 현재 authority 부재와 default-off 경계를 정확히 설명한다.",
+    "관련 unit, 전체 typecheck, lint, model-pricing, 문서·정책 참조, strict encoding과 diff whitespace 검사가 통과한다.",
+    "Claude Code Max는 사용자가 승인한 skip-preflight 예외 아래 Read·Grep·Glob만으로 고정 digest를 독립 검토하며 Anthropic API key를 사용하지 않는다. 최초 검토와 최대 2회 수정 검토만 허용한다."
+  ],
+  "baseCommit": "7f0fe682b11ac9529fdd7bf7acc968edecf36a9c",
+  "writableScope": [
+    "AGENTS.md",
+    "docs/ops/cross-review/packages/",
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/policy/prompt-refiner-observability.md",
+    "docs/ui-contracts/prompt-refiner-suggestion.md",
+    "lib/promptRefinerExecutionContract.ts",
+    "lib/promptRefinerReceiptCore.ts",
+    "lib/promptRefinerSuggestion.ts",
+    "tests/promptRefinerExecutionContract.test.mjs",
+    "tests/promptRefinerReceiptCore.test.mjs"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index 56663170..91538fe8 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -931,3 +931,43 @@ AppSetting writer, flag 활성화와 품질·rollout 승인을 추가하지 않
    측정하고, 통과했을 때만 durable writer·제품 adapter 연결을 제안한다.
 5. 사람에게 보이는 제안형 rollout 증거를 얻은 뒤 Refiner 결과의 Router 결합과
    전체 카탈로그 선택 품질을 별도 실험으로 판단한다.
+
+## 2026-09-16 Prompt Refiner 실행 사전등록 계약 회차
+
+앞 회차의 다음 순서 ②를 외부 호출 없이 구현했다. 순수 계약 모듈은 Refiner
+contract/refiner/model/catalog/pricing identity를 정확히 고정하고, 입력 100,000 tokens,
+출력 4,096 tokens, timeout 15초, retry 0을 요구한다. 고정 standard 가격으로 계산한
+요청당 최악 비용은 24,916 microUSD이며, 최대 100 dispatch의 단계 상한은
+2,491,600 microUSD다. 다만 requestId 결속·만료·1회 consume을 갖춘 원자 예약
+authority는 아직 없다. caller가 만든 lease/boolean은 받지 않고, eligibility·별도 단계
+승인·adapter readiness·계약이 모두 맞아도 `reservation_authority_unavailable`로
+dispatch 전에 거절한다. 따라서 현재 성공 admission 경로는 구조적으로 없다.
+
+terminal reason은 성공, admission/adapter 거절, dispatch 후 provider/response 검증
+실패와 cancellation을 content-free receipt 사실과 disposition 단계로 한 번만 매핑한다.
+receipt schema의 retry도 literal 0으로 좁혔다. 이 회차는 runtime writer, 비용 예약기,
+provider adapter/API/model 호출, product mode, Router 배선, AppSetting writer, flag
+활성화를 추가하지 않았다. 따라서 실행 계약 구현은 운영 실행이나 공개 진척으로
+계산하지 않는다.
+
+### 한눈에 보는 전체 Chat 진척
+
+| 항목 | 이번 판단 |
+| --- | --- |
+| 전체 웹 Chat | **약 67%** (주관적 범위 **57–77%**) |
+| 직전 의미 있는 회차 대비 | **약 0%p** — 실행 사전등록은 닫혔지만 제품 호출·공개 범위는 그대로 |
+| C19–C20 Refiner·Planner·품질 평가 | **약 38%** (직전 약 37%, 예약 authority 미구현을 반영한 보수적 추정) |
+| 구현 | 순수 실행 사전등록·authority 부재 fail-closed·terminal mapping·핵심 단위 테스트 완료 |
+| 로컬 검증 | focused 30/30, 대상 lint, 전체 typecheck 통과 |
+| 독립 검토·통합 CI | 대기 — 이 회차에서는 독립 Claude 호출을 하지 않음 |
+| 병합·배포·공개 | 모두 미실행 — product adapter 없음, flag default-off, provider 호출 0 |
+
+### 이 Cycle 다음 권장 순서
+
+1. 이 source의 좁은 diff를 독립 읽기 전용 검토와 Linux 통합 CI로 검증한다.
+2. provider 호출이 없는 동결 corpus·output parser·중단 규칙의 shadow harness를 만든다.
+3. 별도 과금 승인과 원자적 단계 budget reservation이 준비된 뒤에만 작은 shadow를
+   실행해 의미 보존·주입 저항·비용·지연을 측정한다.
+4. 승인된 관측 뒤 durable writer·제품 adapter를 별도 회차로 연결한다.
+5. 제안형 rollout 증거 뒤 Refiner 결과의 Router 결합을 별도 ROUTE-03 실험으로
+   판단한다.
diff --git a/docs/policy/prompt-refiner-observability.md b/docs/policy/prompt-refiner-observability.md
index 4a0da87a..3c7f7b85 100644
--- a/docs/policy/prompt-refiner-observability.md
+++ b/docs/policy/prompt-refiner-observability.md
@@ -1,11 +1,19 @@
 # Prompt Refiner receipt와 관측 계약
 
-상태: **provider-independent 데이터 계약 구현, 제품 수집 미연결**.
+상태: **provider-independent 데이터·실행 사전등록 계약 구현, 제품 수집 미연결**.
 
 이 문서는 Prompt Refiner 한 요청에서 무엇을 관측하고 어떤 분모로 읽는지를
 정한다. 현재 구현은 strict schema, 결속 검사, 순수 집계와 오프라인 report까지다.
 provider adapter, API route, Prisma table, browser event writer, 비용 예약·정산,
-Router 결합과 rollout 활성화는 없다.
+Router 결합과 rollout 활성화는 없다. `lib/promptRefinerExecutionContract.ts`는 정확한
+model/catalog/pricing identity와 4,096 output tokens, 15초 timeout, retry 0,
+요청당 24,916 microUSD, 최대 100 dispatch의 단계 2,491,600 microUSD를 동결하지만
+그 자체로 실행을 승인하거나 비용을 예약하지 않는다.
+현재는 원자 예약 authority가 없으므로 모든 다른 조건이 맞아도
+`reservation_authority_unavailable`로 dispatch 전에 거절한다. caller가 전달한 lease나
+atomic 여부 boolean을 성공 증거로 받는 입력과 `admitted: true` 경로는 없다. 후속
+authority가 requestId 결속·만료·1회 consume·비용과 stage slot의 원자 예약을 실제로
+구현한 뒤에만 새 계약 버전으로 성공 admission을 추가할 수 있다.
 
 ## 1. 하나의 변경 가능한 행 대신 두 개의 불변 사실
 
@@ -13,7 +21,8 @@ Router 결합과 rollout 활성화는 없다.
 
 1. `PromptRefinerExecutionReceipt`는 서버가 쓴다. 어느 provider/model/adapter가
    호출됐는지, suggestion을 만들었는지, 실패 또는 dispatch 전 거절이었는지,
-   서버 시각·token·실비용·retry 수를 기록한다.
+   서버 시각·token·실비용을 기록한다. `retryCount`는 literal `0`만 허용하며 이
+   계약에는 재시도가 없다.
 2. `PromptRefinerDispositionReceipt`는 서버가 승인한 browser 관측이다. 사용자가
    suggestion을 채택했는지, 원문을 유지했는지, draft/scope 변경 등으로 stale이
    됐는지를 기록한다.
@@ -28,7 +37,7 @@ execution에는 disposition이 최대 하나다. 중복·orphan·request/suggest
 | outcome | 의미 | provider failure 분모 |
 | --- | --- | --- |
 | `suggested` | dispatch 뒤 strict response 검증을 통과해 suggestion을 만들었다 | 포함, 성공 |
-| `failed` | dispatch 이후 adapter/provider/response 검증에서 suggestion을 만들지 못했다 | 포함, 실패 |
+| `failed` | dispatch 이후 provider/response 검증에서 suggestion을 만들지 못했다 | 포함, 실패 |
 | `refused_before_dispatch` | admission/adapter가 provider 호출 전에 거절했다 | 제외 |
 
 `failed`와 `refused_before_dispatch`를 합치지 않는다. provider에 보내지 않은 요청은
@@ -37,8 +46,11 @@ dispatch 시각을 가지며 `admission` layer를 쓸 수 없고, dispatch되지
 `admission`/`adapter` 실패는 `refused_before_dispatch`로만 기록한다.
 `failureLayer`는 `admission`, `adapter`, `provider`, `response_validation` 중 하나이며
 성공만 `none`이다.
+`adapter` layer는 dispatch 전 `adapter_unavailable` 거절에만 사용하며 dispatch 뒤
+adapter 실패로 가장한 receipt는 거부한다.
 `failureCode`는 고정 enum이고 provider 오류 본문을 담을 문자열 필드는 없다.
-`adapter_unavailable`과 `cost_guardrail`은 pre-dispatch 전용이고,
+`eligibility_refused`, `execution_not_approved`, `execution_contract_mismatch`,
+`reservation_authority_unavailable`, `adapter_unavailable`은 pre-dispatch 전용이고,
 `provider_error`, `timeout`, `invalid_response`, `empty_response`, `no_change`,
 `unknown_after_dispatch`는 post-dispatch 전용이다. `cancelled`는 dispatch 전후 모두
 일어날 수 있으므로 code만으로 단계를 주장하지 않고 `dispatchedAt`과 outcome이 그
@@ -134,7 +146,7 @@ provider 호출 없이 동결된 bundle을 읽는다. `--json`은 같은 aggrega
 
 ## 8. 다음 연결 단계
 
-1. 모델, output cap, timeout, retry 0, per-request/stage 비용 상한을 사전등록한다.
+1. 구현된 사전등록을 독립 검토와 통합 CI로 검증한다. 이는 실행 승인이 아니다.
 2. 별도 승인된 작은 shadow가 execution bundle을 생성한다. 사용자에게 UI를
    노출하지 않으므로 disposition은 만들지 않는다.
 3. 품질·비용·지연 증거가 승인된 뒤 제품 adapter와 서버 receipt writer를 붙인다.
diff --git a/docs/ui-contracts/prompt-refiner-suggestion.md b/docs/ui-contracts/prompt-refiner-suggestion.md
index cdf2695c..9272e3e3 100644
--- a/docs/ui-contracts/prompt-refiner-suggestion.md
+++ b/docs/ui-contracts/prompt-refiner-suggestion.md
@@ -8,6 +8,7 @@
 - 사용자 표면: `components/chat/PromptRefinerSuggestionPanel.tsx`
 - 요청·결정 계약: `lib/promptRefinerSuggestion.ts`
 - 모델 경계: `lib/promptRefinerModelPrompt.ts`
+- 실행 사전등록: `lib/promptRefinerExecutionContract.ts`
 
 이 단계의 목적은 모델을 먼저 붙이는 것이 아니라, 모델이 붙었을 때 사용자 원문과
 라우팅 입력이 조용히 같은 것으로 취급되지 않도록 경계를 고정하는 것이다.
@@ -116,6 +117,8 @@ accepted+kept-original을 각각 분모로 쓴다. 서로 다른 분모를 한 c
 provider adapter와 자동 요청을 활성화하려면 다음이 별도로 필요하다.
 
 1. 비용이 고정된 Refiner 모델·출력 cap·timeout·재시도 0 계약
+   (provider-independent 사전등록은 구현됨. 예약 authority가 없으므로 admission은
+   항상 dispatch 전에 거절하며 실제 adapter·비용 예약·dispatch 권한은 없음)
 2. request/receipt와 사용자 선택률·stale·실패·지연 계측 (provider-independent
    schema와 오프라인 집계는 구현됨; writer·저장소·제품 수집은 미구현)
 3. 원문 대비 제안문 주입·의미 보존 평가
diff --git a/lib/promptRefinerExecutionContract.ts b/lib/promptRefinerExecutionContract.ts
new file mode 100644
index 00000000..b007ee88
--- /dev/null
+++ b/lib/promptRefinerExecutionContract.ts
@@ -0,0 +1,516 @@
+import {
+    getModel,
+    type AiModel,
+} from "@/lib/models";
+import {
+    getModelPricingProfile,
+    type ModelPricingProfile,
+} from "@/lib/modelPricing";
+import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
+import type { PromptRefinerFailureCode } from "@/lib/promptRefinerReceiptCore";
+import {
+    PROMPT_REFINER_MAX_PROMPT_BYTES,
+    PROMPT_REFINER_MAX_PROMPT_CHARS,
+    PROMPT_REFINER_VERSION,
+} from "@/lib/promptRefinerSuggestion";
+
+/**
+ * Provider-independent preregistration for the first Prompt Refiner shadow.
+ *
+ * This module cannot call a provider, select an adapter, read rollout state,
+ * write a receipt, charge credits or authorize a run. It only freezes the
+ * configuration a separately approved future harness must present before it
+ * may dispatch. Product mode is deliberately absent.
+ *
+ * docs/ui-contracts/prompt-refiner-suggestion.md
+ * docs/policy/prompt-refiner-observability.md
+ */
+
+export const PROMPT_REFINER_EXECUTION_CONTRACT_VERSION =
+    "prompt-refiner-execution-contract-v1" as const;
+
+export const PROMPT_REFINER_EXECUTION_MODEL_PIN = Object.freeze({
+    provider: "openai",
+    /** Stable Tomverse catalogue identity recorded in internal receipts. */
+    modelId: "gpt-5-6-luna",
+    /** Exact upstream identifier. A catalogue remap requires a new contract. */
+    apiModelId: "gpt-5.6-luna",
+    pricingVersion: "openai-gpt-5.6-luna-2026-08-01",
+    pricingEffectiveDate: "2026-08-01",
+    routing: "direct_provider_api",
+    processingTier: "standard",
+    reasoningEffort: "medium",
+    contextWindowTokens: 1_050_000,
+    reasoningTokenBilling: "billed_as_output",
+    inputUsdPerMillionTokens: 0.2,
+    outputUsdPerMillionTokens: 1.2,
+} as const);
+
+/**
+ * Worst-case rendered-input allowance.
+ *
+ * The public request accepts at most 16,000 UTF-16 code units and 32 KiB of
+ * UTF-8 source. JSON escaping can expand one control character to six ASCII
+ * bytes, so the source alone can render to 96,000 bytes. 100,000 tokens keeps
+ * that worst case, the fixed system instruction, the canonical JSON envelope
+ * and message framing inside the priced short-context tier. A future adapter
+ * must prove a request-specific upper bound no larger than this before call.
+ */
+export const PROMPT_REFINER_MAX_INPUT_TOKENS = 100_000;
+export const PROMPT_REFINER_MESSAGE_FRAMING_TOKEN_ALLOWANCE = 2_048;
+export const PROMPT_REFINER_MAX_OUTPUT_TOKENS = 4_096;
+export const PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS =
+    PROMPT_REFINER_MAX_INPUT_TOKENS + PROMPT_REFINER_MAX_OUTPUT_TOKENS;
+export const PROMPT_REFINER_TIMEOUT_MS = 15_000;
+export const PROMPT_REFINER_RETRY_COUNT = 0;
+export const PROMPT_REFINER_SHADOW_MAX_DISPATCHES = 100;
+
+export const promptRefinerWorstCaseCostMicroUsd = (input: {
+    inputTokens: number;
+    outputTokens?: number;
+}): number =>
+    calculateProviderUsageCost({
+        inputTokens: input.inputTokens,
+        outputTokens:
+            input.outputTokens ?? PROMPT_REFINER_MAX_OUTPUT_TOKENS,
+        inputUsdPerMillionTokens:
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens,
+        outputUsdPerMillionTokens:
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens,
+        // The preregistration attaches no prompt cache. Costing the whole
+        // prompt as uncached is both the requested path and the upper bound.
+        cachedInputPriceMultiplier: 1,
+    }).totalCostMicroUsd;
+
+export const PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD =
+    promptRefinerWorstCaseCostMicroUsd({
+        inputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+    });
+
+export const PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD =
+    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD *
+    PROMPT_REFINER_SHADOW_MAX_DISPATCHES;
+
+export const PROMPT_REFINER_EXECUTION_CONTRACT = Object.freeze({
+    contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    refinerVersion: PROMPT_REFINER_VERSION,
+    mode: "shadow" as const,
+    userVisible: false,
+    model: PROMPT_REFINER_EXECUTION_MODEL_PIN,
+    request: Object.freeze({
+        maxSourceChars: PROMPT_REFINER_MAX_PROMPT_CHARS,
+        maxSourceBytes: PROMPT_REFINER_MAX_PROMPT_BYTES,
+        maxInputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+        maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
+        timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
+        retryCount: PROMPT_REFINER_RETRY_COUNT,
+        promptCaching: "disabled" as const,
+        tools: "none" as const,
+        perRequestCostCeilingMicroUsd:
+            PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    }),
+    stage: Object.freeze({
+        maxDispatches: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+        costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+        requiresSeparateApproval: true,
+        reservationAuthority: "unavailable" as const,
+    }),
+} as const);
+
+type ContractModel = Pick<
+    AiModel,
+    | "id"
+    | "apiModel"
+    | "provider"
+    | "enabled"
+    | "status"
+    | "reasoning"
+    | "contextWindowTokens"
+>;
+
+/**
+ * Compares the preregistration with the checked-in catalogue and price facts.
+ * A drift is a refusal, not a request to silently inherit the new value.
+ */
+export const promptRefinerExecutionContractProblems = (input?: {
+    model?: ContractModel | null;
+    pricing?: ModelPricingProfile | null;
+}): string[] => {
+    const model =
+        input && "model" in input
+            ? input.model
+            : getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    const pricing =
+        input && "pricing" in input
+            ? input.pricing
+            : getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    const problems: string[] = [];
+
+    if (!model) {
+        problems.push("model_missing");
+    } else {
+        if (model.id !== PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId) {
+            problems.push("model_id_mismatch");
+        }
+        if (model.provider !== PROMPT_REFINER_EXECUTION_MODEL_PIN.provider) {
+            problems.push("model_provider_mismatch");
+        }
+        if (model.apiModel !== PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId) {
+            problems.push("api_model_mismatch");
+        }
+        if (model.reasoning !== PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningEffort) {
+            problems.push("reasoning_effort_mismatch");
+        }
+        if (
+            model.contextWindowTokens !==
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.contextWindowTokens
+        ) {
+            problems.push("context_window_mismatch");
+        }
+        if (
+            (model.contextWindowTokens ?? 0) <
+            PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS
+        ) {
+            problems.push("context_window_insufficient");
+        }
+        if (!model.enabled || model.status !== "enabled") {
+            problems.push("model_not_enabled");
+        }
+    }
+
+    if (!pricing) {
+        problems.push("pricing_missing");
+    } else {
+        if (pricing.modelId !== PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId) {
+            problems.push("pricing_model_mismatch");
+        }
+        if (pricing.provider !== PROMPT_REFINER_EXECUTION_MODEL_PIN.provider) {
+            problems.push("pricing_provider_mismatch");
+        }
+        if (pricing.apiModelId !== PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId) {
+            problems.push("pricing_api_model_mismatch");
+        }
+        if (pricing.routing !== PROMPT_REFINER_EXECUTION_MODEL_PIN.routing) {
+            problems.push("routing_mismatch");
+        }
+        if (
+            pricing.processingTier !==
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.processingTier
+        ) {
+            problems.push("processing_tier_mismatch");
+        }
+        if (
+            pricing.pricingVersion !==
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingVersion
+        ) {
+            problems.push("pricing_version_mismatch");
+        }
+        if (
+            pricing.effectiveDate !==
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingEffectiveDate
+        ) {
+            problems.push("pricing_effective_date_mismatch");
+        }
+        if (pricing.priceSchedule?.length) {
+            problems.push("pricing_schedule_requires_new_contract");
+        }
+        if (
+            pricing.reasoningTokenBilling !==
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningTokenBilling
+        ) {
+            problems.push("reasoning_token_billing_mismatch");
+        }
+        const applicableTier = pricing.tiers.find(
+            (tier) =>
+                tier.maxPromptTokens === null ||
+                PROMPT_REFINER_MAX_INPUT_TOKENS <= tier.maxPromptTokens
+        );
+        if (!applicableTier) {
+            problems.push("pricing_tier_missing");
+        } else {
+            if (
+                applicableTier.inputUsdPerMillionTokens !==
+                PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens
+            ) {
+                problems.push("input_price_mismatch");
+            }
+            if (
+                applicableTier.outputUsdPerMillionTokens !==
+                PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens
+            ) {
+                problems.push("output_price_mismatch");
+            }
+        }
+        if (pricing.maxOutputTokens < PROMPT_REFINER_MAX_OUTPUT_TOKENS) {
+            problems.push("output_cap_exceeds_model_profile");
+        }
+    }
+
+    if (
+        promptRefinerWorstCaseCostMicroUsd({
+            inputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+        }) !== PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD
+    ) {
+        problems.push("request_cost_ceiling_mismatch");
+    }
+    if (
+        PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD !==
+        PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD *
+            PROMPT_REFINER_SHADOW_MAX_DISPATCHES
+    ) {
+        problems.push("stage_cost_ceiling_mismatch");
+    }
+
+    return problems;
+};
+
+export const PROMPT_REFINER_ADMISSION_REFUSAL_REASONS = Object.freeze([
+    "eligibility_refused",
+    "execution_not_approved",
+    "adapter_unavailable",
+    "execution_contract_mismatch",
+    "reservation_authority_unavailable",
+] as const);
+export type PromptRefinerAdmissionRefusalReason =
+    (typeof PROMPT_REFINER_ADMISSION_REFUSAL_REASONS)[number];
+
+export type PromptRefinerExecutionCandidate = {
+    mode: "shadow" | "product" | null;
+    /** Unknown is null and fails closed. */
+    eligible: boolean | null;
+    /** Separate human/cost approval; this contract is not that approval. */
+    stageApproved: boolean | null;
+    /** A real model-facing adapter exists for this exact candidate. */
+    adapterReady: boolean | null;
+    contractVersion: string | null;
+    refinerVersion: string | null;
+    model: {
+        provider: string;
+        modelId: string;
+        apiModelId: string;
+        pricingVersion: string;
+        pricingEffectiveDate: string;
+        routing: string;
+        processingTier: string;
+        reasoningEffort: string;
+        contextWindowTokens: number;
+        reasoningTokenBilling: string;
+        inputUsdPerMillionTokens: number;
+        outputUsdPerMillionTokens: number;
+    } | null;
+    maxOutputTokens: number | null;
+    timeoutMs: number | null;
+    retryCount: number | null;
+    promptCaching: string | null;
+    tools: string | null;
+    /** Exact preregistered ceiling, not a caller-selected cost estimate. */
+    inputTokenCeiling: number | null;
+};
+
+export type PromptRefinerAdmissionDecision = {
+    admitted: false;
+    reason: PromptRefinerAdmissionRefusalReason;
+};
+
+const exactModelPin = (
+    candidate: PromptRefinerExecutionCandidate["model"]
+): boolean => {
+    if (!candidate) return false;
+    return (
+        candidate.provider === PROMPT_REFINER_EXECUTION_MODEL_PIN.provider &&
+        candidate.modelId === PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId &&
+        candidate.apiModelId === PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId &&
+        candidate.pricingVersion ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingVersion &&
+        candidate.pricingEffectiveDate ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingEffectiveDate &&
+        candidate.routing === PROMPT_REFINER_EXECUTION_MODEL_PIN.routing &&
+        candidate.processingTier ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.processingTier &&
+        candidate.reasoningEffort ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningEffort &&
+        candidate.contextWindowTokens ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.contextWindowTokens &&
+        candidate.reasoningTokenBilling ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningTokenBilling &&
+        candidate.inputUsdPerMillionTokens ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens &&
+        candidate.outputUsdPerMillionTokens ===
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens
+    );
+};
+
+/**
+ * Pure fail-closed preregistration check. It reserves no money and dispatches
+ * nothing. There is deliberately no admitted:true branch: a future authority
+ * must atomically bind a request id, reserve one stage slot and worst-case
+ * cost, attach expiry, and consume the lease once before a new contract may
+ * expose successful admission.
+ */
+export const admitPromptRefinerExecution = (
+    candidate: PromptRefinerExecutionCandidate
+): PromptRefinerAdmissionDecision => {
+    if (candidate.eligible !== true || candidate.mode !== "shadow") {
+        return { admitted: false, reason: "eligibility_refused" };
+    }
+    if (candidate.stageApproved !== true) {
+        return { admitted: false, reason: "execution_not_approved" };
+    }
+    if (candidate.adapterReady !== true) {
+        return { admitted: false, reason: "adapter_unavailable" };
+    }
+    if (
+        promptRefinerExecutionContractProblems().length > 0 ||
+        candidate.contractVersion !==
+            PROMPT_REFINER_EXECUTION_CONTRACT_VERSION ||
+        candidate.refinerVersion !== PROMPT_REFINER_VERSION ||
+        !exactModelPin(candidate.model) ||
+        candidate.maxOutputTokens !== PROMPT_REFINER_MAX_OUTPUT_TOKENS ||
+        candidate.timeoutMs !== PROMPT_REFINER_TIMEOUT_MS ||
+        candidate.retryCount !== PROMPT_REFINER_RETRY_COUNT ||
+        candidate.promptCaching !== "disabled" ||
+        candidate.tools !== "none" ||
+        candidate.inputTokenCeiling !== PROMPT_REFINER_MAX_INPUT_TOKENS
+    ) {
+        return {
+            admitted: false,
+            reason: "execution_contract_mismatch",
+        };
+    }
+    return {
+        admitted: false,
+        reason: "reservation_authority_unavailable",
+    };
+};
+
+export type PromptRefinerTerminalReason =
+    | "suggested"
+    | PromptRefinerAdmissionRefusalReason
+    | "cancelled_before_dispatch"
+    | "provider_error"
+    | "timeout"
+    | "invalid_response"
+    | "empty_response"
+    | "no_change"
+    | "cancelled_after_dispatch"
+    | "unknown_after_dispatch";
+
+const PROMPT_REFINER_TERMINAL_REASON_COVERAGE = {
+    suggested: true,
+    eligibility_refused: true,
+    execution_not_approved: true,
+    execution_contract_mismatch: true,
+    adapter_unavailable: true,
+    reservation_authority_unavailable: true,
+    cancelled_before_dispatch: true,
+    provider_error: true,
+    timeout: true,
+    invalid_response: true,
+    empty_response: true,
+    no_change: true,
+    cancelled_after_dispatch: true,
+    unknown_after_dispatch: true,
+} as const satisfies Record<PromptRefinerTerminalReason, true>;
+
+export const PROMPT_REFINER_TERMINAL_REASONS = Object.freeze(
+    Object.keys(
+        PROMPT_REFINER_TERMINAL_REASON_COVERAGE
+    ) as PromptRefinerTerminalReason[]
+);
+
+export type PromptRefinerTerminalDispositionPolicy =
+    | "choice_or_stale_after_ready"
+    | "stale_before_ready_only";
+
+export type PromptRefinerTerminalReceiptFacts = {
+    outcome: "suggested" | "failed" | "refused_before_dispatch";
+    failureLayer:
+        | "none"
+        | "admission"
+        | "adapter"
+        | "provider"
+        | "response_validation";
+    failureCode: PromptRefinerFailureCode | null;
+    retryCount: 0;
+    dispositionPolicy: PromptRefinerTerminalDispositionPolicy;
+};
+
+const terminalFacts = (
+    facts: Omit<PromptRefinerTerminalReceiptFacts, "retryCount">
+): PromptRefinerTerminalReceiptFacts => ({
+    ...facts,
+    retryCount: PROMPT_REFINER_RETRY_COUNT,
+});
+
+/**
+ * One terminal reason has one receipt encoding and one disposition boundary.
+ * Provider prose and content never enter this mapping.
+ */
+export const promptRefinerTerminalReceiptFacts = (
+    reason: PromptRefinerTerminalReason
+): PromptRefinerTerminalReceiptFacts => {
+    switch (reason) {
+        case "suggested":
+            return terminalFacts({
+                outcome: "suggested",
+                failureLayer: "none",
+                failureCode: null,
+                dispositionPolicy: "choice_or_stale_after_ready",
+            });
+        case "eligibility_refused":
+        case "execution_not_approved":
+        case "execution_contract_mismatch":
+            return terminalFacts({
+                outcome: "refused_before_dispatch",
+                failureLayer: "admission",
+                failureCode: reason,
+                dispositionPolicy: "stale_before_ready_only",
+            });
+        case "adapter_unavailable":
+            return terminalFacts({
+                outcome: "refused_before_dispatch",
+                failureLayer: "adapter",
+                failureCode: "adapter_unavailable",
+                dispositionPolicy: "stale_before_ready_only",
+            });
+        case "reservation_authority_unavailable":
+            return terminalFacts({
+                outcome: "refused_before_dispatch",
+                failureLayer: "admission",
+                failureCode: reason,
+                dispositionPolicy: "stale_before_ready_only",
+            });
+        case "cancelled_before_dispatch":
+            return terminalFacts({
+                outcome: "refused_before_dispatch",
+                failureLayer: "admission",
+                failureCode: "cancelled",
+                dispositionPolicy: "stale_before_ready_only",
+            });
+        case "provider_error":
+        case "timeout":
+        case "unknown_after_dispatch":
+            return terminalFacts({
+                outcome: "failed",
+                failureLayer: "provider",
+                failureCode: reason,
+                dispositionPolicy: "stale_before_ready_only",
+            });
+        case "invalid_response":
+        case "empty_response":
+        case "no_change":
+            return terminalFacts({
+                outcome: "failed",
+                failureLayer: "response_validation",
+                failureCode: reason,
+                dispositionPolicy: "stale_before_ready_only",
+            });
+        case "cancelled_after_dispatch":
+            return terminalFacts({
+                outcome: "failed",
+                failureLayer: "provider",
+                failureCode: "cancelled",
+                dispositionPolicy: "stale_before_ready_only",
+            });
+    }
+};
diff --git a/lib/promptRefinerReceiptCore.ts b/lib/promptRefinerReceiptCore.ts
index ef34d345..efd64178 100644
--- a/lib/promptRefinerReceiptCore.ts
+++ b/lib/promptRefinerReceiptCore.ts
@@ -32,9 +32,14 @@ export const PROMPT_REFINER_FAILURE_LAYERS = [
     "provider",
     "response_validation",
 ] as const;
+export type PromptRefinerFailureLayer =
+    (typeof PROMPT_REFINER_FAILURE_LAYERS)[number];
 export const PROMPT_REFINER_FAILURE_CODES = [
+    "eligibility_refused",
+    "execution_not_approved",
+    "execution_contract_mismatch",
+    "reservation_authority_unavailable",
     "adapter_unavailable",
-    "cost_guardrail",
     "invalid_response",
     "empty_response",
     "no_change",
@@ -43,18 +48,33 @@ export const PROMPT_REFINER_FAILURE_CODES = [
     "cancelled",
     "unknown_after_dispatch",
 ] as const;
-const PRE_DISPATCH_ONLY_FAILURE_CODES = new Set<string>([
-    "adapter_unavailable",
-    "cost_guardrail",
-]);
-const POST_DISPATCH_ONLY_FAILURE_CODES = new Set<string>([
-    "invalid_response",
-    "empty_response",
-    "no_change",
-    "provider_error",
-    "timeout",
-    "unknown_after_dispatch",
-]);
+export type PromptRefinerFailureCode =
+    (typeof PROMPT_REFINER_FAILURE_CODES)[number];
+type FixedLayerFailureCode = Exclude<PromptRefinerFailureCode, "cancelled">;
+type FailureLayer = Exclude<PromptRefinerFailureLayer, "none">;
+const FAILURE_LAYER_BY_CODE = {
+    eligibility_refused: "admission",
+    execution_not_approved: "admission",
+    execution_contract_mismatch: "admission",
+    reservation_authority_unavailable: "admission",
+    adapter_unavailable: "adapter",
+    provider_error: "provider",
+    timeout: "provider",
+    unknown_after_dispatch: "provider",
+    invalid_response: "response_validation",
+    empty_response: "response_validation",
+    no_change: "response_validation",
+} as const satisfies Record<FixedLayerFailureCode, FailureLayer>;
+
+const expectedFailureLayer = (
+    code: PromptRefinerFailureCode,
+    dispatched: boolean
+): FailureLayer =>
+    code === "cancelled"
+        ? dispatched
+            ? "provider"
+            : "admission"
+        : FAILURE_LAYER_BY_CODE[code];
 export const PROMPT_REFINER_DISPOSITION_OUTCOMES = [
     "accepted",
     "kept_original",
@@ -108,7 +128,7 @@ const executionReceiptBaseSchema = z
         outputTokens: optionalTelemetryCount,
         reasoningTokens: optionalTelemetryCount,
         actualCostMicroUsd: optionalTelemetryCount,
-        retryCount: z.number().int().min(0).max(10),
+        retryCount: z.literal(0),
     })
     .strict();
 
@@ -227,23 +247,29 @@ export const promptRefinerExecutionReceiptSchema =
                 "inputTokens",
             ]);
         }
-        if (
-            receipt.failureCode !== null &&
-            dispatchedAt === null &&
-            POST_DISPATCH_ONLY_FAILURE_CODES.has(receipt.failureCode)
-        ) {
-            issue("prompt_refiner_post_dispatch_code_requires_dispatch", [
-                "failureCode",
-            ]);
-        }
-        if (
-            receipt.failureCode !== null &&
-            dispatchedAt !== null &&
-            PRE_DISPATCH_ONLY_FAILURE_CODES.has(receipt.failureCode)
-        ) {
-            issue("prompt_refiner_pre_dispatch_code_forbids_dispatch", [
-                "failureCode",
-            ]);
+        if (receipt.failureCode !== null) {
+            const expectedLayer = expectedFailureLayer(
+                receipt.failureCode,
+                dispatchedAt !== null
+            );
+            const codeRequiresDispatch =
+                expectedLayer === "provider" ||
+                expectedLayer === "response_validation";
+            if (dispatchedAt === null && codeRequiresDispatch) {
+                issue("prompt_refiner_post_dispatch_code_requires_dispatch", [
+                    "failureCode",
+                ]);
+            }
+            if (dispatchedAt !== null && !codeRequiresDispatch) {
+                issue("prompt_refiner_pre_dispatch_code_forbids_dispatch", [
+                    "failureCode",
+                ]);
+            }
+            if (receipt.failureLayer !== expectedLayer) {
+                issue("prompt_refiner_failure_code_layer_mismatch", [
+                    "failureLayer",
+                ]);
+            }
         }
     });
 
diff --git a/lib/promptRefinerSuggestion.ts b/lib/promptRefinerSuggestion.ts
index 950a0a31..8c94cb2a 100644
--- a/lib/promptRefinerSuggestion.ts
+++ b/lib/promptRefinerSuggestion.ts
@@ -1,6 +1,7 @@
 import { z } from "zod";
 
 export const PROMPT_REFINER_INPUT_SCOPE = "current_user_turn_text_only" as const;
+export const PROMPT_REFINER_VERSION = "suggest-v1" as const;
 export const PROMPT_REFINER_MAX_PROMPT_CHARS = 16_000;
 export const PROMPT_REFINER_MAX_PROMPT_BYTES = 32 * 1024;
 
diff --git a/tests/promptRefinerExecutionContract.test.mjs b/tests/promptRefinerExecutionContract.test.mjs
new file mode 100644
index 00000000..ac6c9e05
--- /dev/null
+++ b/tests/promptRefinerExecutionContract.test.mjs
@@ -0,0 +1,324 @@
+import assert from "node:assert/strict";
+import test from "node:test";
+
+import { getModel } from "../lib/models.ts";
+import { getModelPricingProfile } from "../lib/modelPricing.ts";
+import {
+    PROMPT_REFINER_ADMISSION_REFUSAL_REASONS,
+    PROMPT_REFINER_EXECUTION_CONTRACT,
+    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    PROMPT_REFINER_EXECUTION_MODEL_PIN,
+    PROMPT_REFINER_MAX_INPUT_TOKENS,
+    PROMPT_REFINER_MAX_OUTPUT_TOKENS,
+    PROMPT_REFINER_MESSAGE_FRAMING_TOKEN_ALLOWANCE,
+    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
+    PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS,
+    PROMPT_REFINER_RETRY_COUNT,
+    PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
+    PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
+    PROMPT_REFINER_TERMINAL_REASONS,
+    PROMPT_REFINER_TIMEOUT_MS,
+    admitPromptRefinerExecution,
+    promptRefinerExecutionContractProblems,
+    promptRefinerTerminalReceiptFacts,
+} from "../lib/promptRefinerExecutionContract.ts";
+import { promptRefinerModelMessages } from "../lib/promptRefinerModelPrompt.ts";
+import {
+    PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
+    PROMPT_REFINER_FAILURE_CODES,
+    promptRefinerExecutionReceiptSchema,
+} from "../lib/promptRefinerReceiptCore.ts";
+import { PROMPT_REFINER_VERSION } from "../lib/promptRefinerSuggestion.ts";
+
+const candidate = (overrides = {}) => ({
+    mode: "shadow",
+    eligible: true,
+    stageApproved: true,
+    adapterReady: true,
+    contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+    refinerVersion: PROMPT_REFINER_VERSION,
+    model: { ...PROMPT_REFINER_EXECUTION_MODEL_PIN },
+    maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
+    timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
+    retryCount: PROMPT_REFINER_RETRY_COUNT,
+    promptCaching: "disabled",
+    tools: "none",
+    inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS,
+    ...overrides,
+});
+
+test("execution contract freezes the shadow limits and worst-case cost", () => {
+    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.mode, "shadow");
+    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.userVisible, false);
+    assert.equal(PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId, "gpt-5.6-luna");
+    assert.equal(PROMPT_REFINER_EXECUTION_MODEL_PIN.contextWindowTokens, 1_050_000);
+    assert.equal(PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS, 104_096);
+    assert.equal(PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningTokenBilling, "billed_as_output");
+    assert.equal(PROMPT_REFINER_MAX_OUTPUT_TOKENS, 4_096);
+    assert.equal(PROMPT_REFINER_TIMEOUT_MS, 15_000);
+    assert.equal(PROMPT_REFINER_RETRY_COUNT, 0);
+    assert.equal(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD, 24_916);
+    assert.equal(PROMPT_REFINER_SHADOW_MAX_DISPATCHES, 100);
+    assert.equal(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD, 2_491_600);
+    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.request.promptCaching, "disabled");
+    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.request.tools, "none");
+    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.stage.requiresSeparateApproval, true);
+    assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.stage.reservationAuthority, "unavailable");
+    assert.equal(Object.isFrozen(PROMPT_REFINER_ADMISSION_REFUSAL_REASONS), true);
+    assert.equal(Object.isFrozen(PROMPT_REFINER_TERMINAL_REASONS), true);
+});
+
+test("the maximum escaped request fits the conservative input-token ceiling", () => {
+    const messages = promptRefinerModelMessages({
+        requestId: "request_max_escaped",
+        prompt: "\0".repeat(16_000),
+    });
+    const renderedBytes = messages.reduce(
+        (total, message) => total + new TextEncoder().encode(message.content).length,
+        0
+    );
+
+    assert.equal(messages.length, 2);
+    assert.equal(renderedBytes, 96_848);
+    assert.ok(
+        renderedBytes + PROMPT_REFINER_MESSAGE_FRAMING_TOKEN_ALLOWANCE <=
+            PROMPT_REFINER_MAX_INPUT_TOKENS
+    );
+});
+
+test("the checked-in catalogue and pricing must match the exact pin", () => {
+    assert.deepEqual(promptRefinerExecutionContractProblems(), []);
+    assert.deepEqual(
+        promptRefinerExecutionContractProblems({ model: null, pricing: null }),
+        ["model_missing", "pricing_missing"]
+    );
+
+    const model = getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    assert.ok(model);
+    assert.ok(pricing);
+    assert.ok(
+        promptRefinerExecutionContractProblems({
+            model: { ...model, apiModel: "drifted-model" },
+            pricing,
+        }).includes("api_model_mismatch")
+    );
+    assert.ok(
+        promptRefinerExecutionContractProblems({
+            model,
+            pricing: { ...pricing, pricingVersion: "drifted-price" },
+        }).includes("pricing_version_mismatch")
+    );
+    assert.ok(
+        promptRefinerExecutionContractProblems({
+            model,
+            pricing: {
+                ...pricing,
+                tiers: pricing.tiers.map((tier, index) =>
+                    index === 0
+                        ? { ...tier, inputUsdPerMillionTokens: 999 }
+                        : tier
+                ),
+            },
+        }).includes("input_price_mismatch")
+    );
+    assert.ok(
+        promptRefinerExecutionContractProblems({
+            model: { ...model, contextWindowTokens: 100_000 },
+            pricing,
+        }).includes("context_window_mismatch")
+    );
+    assert.ok(
+        promptRefinerExecutionContractProblems({
+            model,
+            pricing: { ...pricing, reasoningTokenBilling: "not_billed" },
+        }).includes("reasoning_token_billing_mismatch")
+    );
+});
+
+test("an otherwise eligible request cannot fabricate successful admission", () => {
+    assert.deepEqual(admitPromptRefinerExecution(candidate()), {
+        admitted: false,
+        reason: "reservation_authority_unavailable",
+    });
+    assert.deepEqual(
+        admitPromptRefinerExecution(
+            candidate({
+                stageReservation: {
+                    kind: "forged",
+                    leaseId: "caller_controlled",
+                },
+            })
+        ),
+        {
+            admitted: false,
+            reason: "reservation_authority_unavailable",
+        }
+    );
+});
+
+test("unknown, unapproved, drifted and authority-less candidates fail closed", () => {
+    const cases = [
+        [candidate({ eligible: null }), "eligibility_refused"],
+        [candidate({ mode: "product" }), "eligibility_refused"],
+        [candidate({ stageApproved: null }), "execution_not_approved"],
+        [candidate({ adapterReady: null }), "adapter_unavailable"],
+        [candidate({ contractVersion: "drifted" }), "execution_contract_mismatch"],
+        [candidate({ retryCount: 1 }), "execution_contract_mismatch"],
+        [candidate({ promptCaching: "enabled" }), "execution_contract_mismatch"],
+        [candidate({ tools: "allowed" }), "execution_contract_mismatch"],
+        [candidate({ inputTokenCeiling: null }), "execution_contract_mismatch"],
+        [candidate({ inputTokenCeiling: 0 }), "execution_contract_mismatch"],
+        [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS - 1 }), "execution_contract_mismatch"],
+        [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS + 1 }), "execution_contract_mismatch"],
+        [candidate(), "reservation_authority_unavailable"],
+    ];
+
+    for (const [input, reason] of cases) {
+        assert.deepEqual(admitPromptRefinerExecution(input), {
+            admitted: false,
+            reason,
+        });
+    }
+    assert.deepEqual(
+        [...PROMPT_REFINER_ADMISSION_REFUSAL_REASONS].sort(),
+        [...new Set(cases.map(([, reason]) => reason))].sort()
+    );
+});
+
+test("every terminal reason has one content-free receipt and disposition mapping", () => {
+    const expected = {
+        suggested: ["suggested", "none", null, "choice_or_stale_after_ready"],
+        eligibility_refused: ["refused_before_dispatch", "admission", "eligibility_refused", "stale_before_ready_only"],
+        execution_not_approved: ["refused_before_dispatch", "admission", "execution_not_approved", "stale_before_ready_only"],
+        execution_contract_mismatch: ["refused_before_dispatch", "admission", "execution_contract_mismatch", "stale_before_ready_only"],
+        adapter_unavailable: ["refused_before_dispatch", "adapter", "adapter_unavailable", "stale_before_ready_only"],
+        reservation_authority_unavailable: ["refused_before_dispatch", "admission", "reservation_authority_unavailable", "stale_before_ready_only"],
+        cancelled_before_dispatch: ["refused_before_dispatch", "admission", "cancelled", "stale_before_ready_only"],
+        provider_error: ["failed", "provider", "provider_error", "stale_before_ready_only"],
+        timeout: ["failed", "provider", "timeout", "stale_before_ready_only"],
+        invalid_response: ["failed", "response_validation", "invalid_response", "stale_before_ready_only"],
+        empty_response: ["failed", "response_validation", "empty_response", "stale_before_ready_only"],
+        no_change: ["failed", "response_validation", "no_change", "stale_before_ready_only"],
+        cancelled_after_dispatch: ["failed", "provider", "cancelled", "stale_before_ready_only"],
+        unknown_after_dispatch: ["failed", "provider", "unknown_after_dispatch", "stale_before_ready_only"],
+    };
+
+    assert.deepEqual(Object.keys(expected), [...PROMPT_REFINER_TERMINAL_REASONS]);
+    assert.deepEqual(
+        [...new Set(Object.values(expected).map(([, , code]) => code).filter(Boolean))].sort(),
+        [...PROMPT_REFINER_FAILURE_CODES].sort()
+    );
+    for (const reason of PROMPT_REFINER_ADMISSION_REFUSAL_REASONS) {
+        assert.ok(PROMPT_REFINER_TERMINAL_REASONS.includes(reason));
+        const facts = promptRefinerTerminalReceiptFacts(reason);
+        assert.ok(facts);
+        assert.equal(
+            promptRefinerExecutionReceiptSchema.safeParse({
+                receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
+                receiptId: `execution_${reason}`,
+                requestId: `request_${reason}`,
+                suggestionId: null,
+                refinerVersion: PROMPT_REFINER_VERSION,
+                provider: null,
+                modelId: null,
+                adapterVersion: null,
+                outcome: facts.outcome,
+                failureLayer: facts.failureLayer,
+                failureCode: facts.failureCode,
+                requestedAt: "2026-09-16T00:00:00.000Z",
+                dispatchedAt: null,
+                completedAt: "2026-09-16T00:00:00.050Z",
+                preparationLatencyMs: 50,
+                inputTokens: null,
+                cachedInputTokens: null,
+                outputTokens: null,
+                reasoningTokens: null,
+                actualCostMicroUsd: null,
+                retryCount: facts.retryCount,
+            }).success,
+            true
+        );
+    }
+    for (const reason of PROMPT_REFINER_TERMINAL_REASONS) {
+        const facts = promptRefinerTerminalReceiptFacts(reason);
+        assert.deepEqual(
+            [facts.outcome, facts.failureLayer, facts.failureCode, facts.dispositionPolicy],
+            expected[reason]
+        );
+        assert.equal(facts.retryCount, 0);
+        const dispatched = facts.outcome !== "refused_before_dispatch";
+        assert.equal(
+            promptRefinerExecutionReceiptSchema.safeParse({
+                receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
+                receiptId: `terminal_${reason}`,
+                requestId: `terminal_request_${reason}`,
+                suggestionId:
+                    facts.outcome === "suggested"
+                        ? `terminal_suggestion_${reason}`
+                        : null,
+                refinerVersion: PROMPT_REFINER_VERSION,
+                provider: dispatched
+                    ? PROMPT_REFINER_EXECUTION_MODEL_PIN.provider
+                    : null,
+                modelId: dispatched
+                    ? PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId
+                    : null,
+                adapterVersion: dispatched
+                    ? PROMPT_REFINER_EXECUTION_CONTRACT_VERSION
+                    : null,
+                outcome: facts.outcome,
+                failureLayer: facts.failureLayer,
+                failureCode: facts.failureCode,
+                requestedAt: "2026-09-16T00:00:00.000Z",
+                dispatchedAt: dispatched
+                    ? "2026-09-16T00:00:00.100Z"
+                    : null,
+                completedAt: dispatched
+                    ? "2026-09-16T00:00:01.000Z"
+                    : "2026-09-16T00:00:00.050Z",
+                preparationLatencyMs: dispatched ? 1_000 : 50,
+                inputTokens: null,
+                cachedInputTokens: null,
+                outputTokens: null,
+                reasoningTokens: null,
+                actualCostMicroUsd: null,
+                retryCount: facts.retryCount,
+            }).success,
+            true,
+            reason
+        );
+    }
+});
+
+test("execution receipt schema structurally rejects any retry", () => {
+    const receipt = {
+        receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
+        receiptId: "execution_1",
+        requestId: "request_1",
+        suggestionId: "suggestion_1",
+        refinerVersion: PROMPT_REFINER_VERSION,
+        provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
+        modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
+        adapterVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
+        outcome: "suggested",
+        failureLayer: "none",
+        failureCode: null,
+        requestedAt: "2026-09-16T00:00:00.000Z",
+        dispatchedAt: "2026-09-16T00:00:00.100Z",
+        completedAt: "2026-09-16T00:00:01.000Z",
+        preparationLatencyMs: 1_000,
+        inputTokens: 1,
+        cachedInputTokens: 0,
+        outputTokens: 1,
+        reasoningTokens: null,
+        actualCostMicroUsd: 2,
+        retryCount: 0,
+    };
+
+    assert.equal(promptRefinerExecutionReceiptSchema.safeParse(receipt).success, true);
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.safeParse({ ...receipt, retryCount: 1 }).success,
+        false
+    );
+});
diff --git a/tests/promptRefinerReceiptCore.test.mjs b/tests/promptRefinerReceiptCore.test.mjs
index 72f4a9c7..70828c7c 100644
--- a/tests/promptRefinerReceiptCore.test.mjs
+++ b/tests/promptRefinerReceiptCore.test.mjs
@@ -99,6 +99,75 @@ test("execution receipts keep success, failure and refusal facts distinct", () =
     );
 });
 
+test("failure codes require their exact lifecycle layer", () => {
+    const refusal = {
+        receiptId: "exec_exact_layer",
+        requestId: "request_exact_layer",
+        suggestionId: null,
+        provider: null,
+        modelId: null,
+        adapterVersion: null,
+        outcome: "refused_before_dispatch",
+        dispatchedAt: null,
+        completedAt: "2026-09-15T00:00:00.050Z",
+        preparationLatencyMs: 50,
+        inputTokens: null,
+        cachedInputTokens: null,
+        outputTokens: null,
+        reasoningTokens: null,
+        actualCostMicroUsd: null,
+    };
+    const exactPairs = [
+        ["eligibility_refused", "admission"],
+        ["execution_not_approved", "admission"],
+        ["execution_contract_mismatch", "admission"],
+        ["reservation_authority_unavailable", "admission"],
+        ["adapter_unavailable", "adapter"],
+    ];
+
+    for (const [failureCode, failureLayer] of exactPairs) {
+        assert.equal(
+            promptRefinerExecutionReceiptSchema.safeParse(
+                execution({ ...refusal, failureCode, failureLayer })
+            ).success,
+            true
+        );
+    }
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.safeParse(
+            execution({
+                ...refusal,
+                failureCode: "execution_not_approved",
+                failureLayer: "adapter",
+            })
+        ).success,
+        false
+    );
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.safeParse(
+            execution({
+                ...refusal,
+                failureCode: "adapter_unavailable",
+                failureLayer: "admission",
+            })
+        ).success,
+        false
+    );
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.safeParse(
+            execution({
+                receiptId: "exec_postdispatch_adapter_layer",
+                requestId: "request_postdispatch_adapter_layer",
+                suggestionId: null,
+                outcome: "failed",
+                failureCode: "provider_error",
+                failureLayer: "adapter",
+            })
+        ).success,
+        false
+    );
+});
+
 test("execution receipts reject contradictory lifecycle and telemetry claims", () => {
     const refusal = {
         outcome: "refused_before_dispatch",
@@ -122,7 +191,7 @@ test("execution receipts reject contradictory lifecycle and telemetry claims", (
             outcome: "failed",
             suggestionId: null,
             failureLayer: "admission",
-            failureCode: "cost_guardrail",
+            failureCode: "reservation_authority_unavailable",
         }),
         execution({
             outcome: "failed",
@@ -179,7 +248,7 @@ test("execution receipts reject contradictory lifecycle and telemetry claims", (
             "no_change",
             "unknown_after_dispatch",
         ].map((failureCode) => execution({ ...refusal, failureCode })),
-        ...["adapter_unavailable", "cost_guardrail"].map((failureCode) =>
+        ...["adapter_unavailable", "reservation_authority_unavailable"].map((failureCode) =>
             execution({
                 outcome: "failed",
                 suggestionId: null,

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test tests/promptRefinerExecutionContract.test.mjs tests/promptRefinerReceiptCore.test.mjs tests/promptRefinerSuggestion.test.mjs` (1139ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 1063.4925

## Guard results (run by the control program)

- PASS `npm run typecheck` (35800ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm run lint -- --quiet` (47715ms)
  > ai-chat-hub@0.1.0 lint
  > eslint --quiet
- PASS `npm run check:model-pricing` (672ms)
  > ai-chat-hub@0.1.0 check:model-pricing
  > node --import tsx scripts/check-model-pricing.mjs
  
  
  Model pricing check passed: 36 explicit profiles, 0 model(s) on a conservative fallback, 0 unpriced premium models, 0 register warning(s), 0 expired pending prices.
- PASS `npm run check:doc-references` (1278ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 854 referenced path(s) across 108 instruction document(s), and 954 path(s) named by comments across 2898 source file(s), all present.
- PASS `npm run check:policy-section-references` (946ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4428 citation(s) against 35 policy document(s). 2788 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1414 and 226 predate this change).
- PASS `npm run check:encoding:strict` (1235ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `git diff --check 7f0fe682b11ac9529fdd7bf7acc968edecf36a9c HEAD -- . ':(exclude)docs/ops/cross-review/packages/prompt-refiner-execution-contract-v1'` (46ms)

## Findings from the previous round (check each was addressed)

- [warning/evidence] lib/promptRefinerReceiptCore.ts:64 and :274 (FAILURE_LAYER_BY_CODE / expectedFailureLayer !== undefined): The new failure-code/layer invariant is fail-open on drift: the table is typed `Map<string, string>` and an unmapped code silently skips the check, so a failure code added to `PROMPT_REFINER_FAILURE_CODES` but omitted from the table accepts any `failureLayer`, which is exactly the combination criterion 5 asks the strict schema to validate.
- [nit/evidence] lib/promptRefinerExecutionContract.ts:397 (PROMPT_REFINER_TERMINAL_REASONS): `as const satisfies readonly PromptRefinerTerminalReason[]` only checks that each listed element is a valid reason, not that every reason is listed, so the exported list and the bijection test can silently miss a reason even though the switch is exhaustiveness-checked.
- [nit/evidence] lib/promptRefinerExecutionContract.ts:426 (PromptRefinerTerminalReceiptFacts.failureCode): The failure-code union here hand-duplicates `PROMPT_REFINER_FAILURE_CODES` in lib/promptRefinerReceiptCore.ts with no type-level link, so the two can diverge without a compile error even though the mapping is the thing that must agree with the receipt schema.
- [nit/judgement] docs/policy/prompt-refiner-observability.md:24: Section 1 still describes the execution receipt as recording a "retry 수" without stating that the schema now pins `retryCount` to literal 0, so the policy document is less precise than AGENTS.md and the progress note on the retry-zero freeze.
- [nit/judgement] AGENTS.md:1295-1299: The file list now reads "..., `lib/promptRefinerModelPrompt.ts`, or `lib/promptRefinerReceiptCore.ts`, `lib/promptRefinerExecutionContract.ts`, or their tests", carrying two `or`s in one list.

## Author's account (read last; a claim, not a finding)

Summary: Close all five Claude round-0 findings: make failure-code/layer and terminal-reason coverage type-exhaustive, derive the execution failure-code type from receipt core without a runtime cycle, document literal retry zero, and fix the AGENTS file-list grammar. No provider/API/model call or runtime activation.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-execution-contract-v1",
  "round": 1,
  "reviewedDigest": "sha256:ca9d7a2aa1a27fe5241c404815c985921d69dd809708a83a8d7212432df92618",
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
