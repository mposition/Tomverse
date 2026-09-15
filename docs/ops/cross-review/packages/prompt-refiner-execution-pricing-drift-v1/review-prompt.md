# Independent review — task prompt-refiner-execution-pricing-drift-v1, round 1

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

종결된 prompt-refiner-execution-contract-v1 exchange의 round 2가 남긴 단일 unresolved_on_hold finding을 새 continuation에서 검토한다. 실제 비용 경로와 같은 resolveModelPricing()으로 gpt-5-6-luna의 effective input/output rate를 exact 0.2/1.2 pin과 다시 비교하여 per-model 환경 override나 전달된 runtime model row의 가격 drift를 dispatch 전에 execution_contract_mismatch로 거절해야 한다. 원래 exchange의 on_hold/revisions_exhausted 기록과 verdict bytes는 바꾸지 않는다. provider/API/model 호출, runtime writer·예약 authority·adapter, billing, Router 결합, AppSetting writer, flag 활성화, 유료 benchmark와 rollout 승인은 포함하지 않는다. reviewer는 상속된 가격 drift finding이 이 좁은 6-file 후속 diff로 닫혔는지 명시적으로 판정한다. author는 codex, reviewer는 claude이며 Claude Code Max 구독 CLI의 읽기 전용 도구만 사용한다.

## Completion criteria

- promptRefinerExecutionContractProblems()는 checked-in profile 검사와 별도로 resolveModelPricing(model, estimatedPromptTokens=100000)의 effective input/output rate를 정확한 pin과 비교한다.
- CHAT_MODEL_GPT_5_6_LUNA_INPUT_USD_PER_MILLION 또는 CHAT_MODEL_GPT_5_6_LUNA_OUTPUT_USD_PER_MILLION override가 어느 한쪽 rate를 바꾸면 해당 effective_*_price_mismatch를 내고 admission은 execution_contract_mismatch로 dispatch 전에 거절한다.
- 정상 catalog model과 pricing은 기존 24916 microUSD 요청 상한, 2491600 microUSD 단계 상한, retry 0, authority unavailable fail-closed 경계를 유지한다.
- runtime model row를 검사 함수에 전달할 수 있고 미래 예약 authority는 예약·dispatch와 같은 critical path에서 이 gate를 통과해야 한다는 경계가 코드와 한국어 정책·UI 계약·진척 기록에 일치하게 남는다.
- 환경 변수 격리 테스트는 input/output drift를 각각 재현하고 실행 뒤 원래 process.env 존재 여부와 값을 정확히 복원하며 환경값을 출력하거나 receipt에 저장하지 않는다.
- 기존 종결 exchange의 round 2 package·verdict·events·exchange bytes와 on_hold/revisions_exhausted 상태는 변경하지 않고 새 continuation만 그 finding의 해소 여부를 판단한다.
- focused unit, 전체 typecheck, lint, model-pricing, 문서·정책 참조, strict encoding과 실제 6-file diff whitespace 검사가 통과한다.
- Claude Code Max는 사용자가 승인한 skip-preflight 예외 아래 Read·Grep·Glob만으로 고정 digest를 독립 검토하며 Anthropic API key를 사용하지 않는다. 최초 검토와 최대 2회 수정 검토만 허용한다.

## Change under review — digest sha256:8a184a434b8dec53b573221ea824b67cc0d78e3400769f765b443b0dc796e979, commit 710cb5954f7f52138dbfe8a4a097e3ca0b22cd82

```diff
diff --git a/AGENTS.md b/AGENTS.md
index fafe4330..0a42e296 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1332,8 +1332,16 @@ Non-negotiable requirements:
   gate and evidence.
 - The execution preregistration is pure and fail-closed. Exact contract,
   refiner, model/catalog/pricing identity, output cap, timeout, retry zero and
-  request/stage cost ceilings are frozen, but no reservation authority exists.
-  Admission therefore always refuses before dispatch with
+  request/stage cost ceilings are frozen. The gate also resolves the effective
+  input/output rates through `resolveModelPricing()` so a per-model environment
+  or runtime registry override cannot bypass the 0.2/1.2 pin. Its effective
+  output cap must be at least 4,096; a larger capability is allowed but never
+  replaces the Refiner request's exact 4,096 cap. Caching is disabled, and the
+  generic model reservation-output setting must not reduce this contract's
+  4,096-token worst-case reservation. A future authority must pass its runtime
+  model row through this gate in the same critical path before reservation and
+  dispatch. No reservation authority exists today, so
+  admission always refuses before dispatch with
   `reservation_authority_unavailable` after earlier checks pass. A caller-made
   lease or atomic boolean is never proof. Only a future authority with atomic
   requestId binding, expiry and one-time consume may introduce `admitted: true`
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index 0fc988bb..3c089339 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -938,7 +938,14 @@ AppSetting writer, flag 활성화와 품질·rollout 승인을 추가하지 않
 contract/refiner/model/catalog/pricing identity를 정확히 고정하고, 입력 100,000 tokens,
 출력 4,096 tokens, timeout 15초, retry 0을 요구한다. 고정 standard 가격으로 계산한
 요청당 최악 비용은 24,916 microUSD이며, 최대 100 dispatch의 단계 상한은
-2,491,600 microUSD다. 다만 requestId 결속·만료·1회 consume을 갖춘 원자 예약
+2,491,600 microUSD다. 후속 결함 수정은 정적 profile에 더해 실제 비용 경로와 같은
+`resolveModelPricing()` 결과의 input/output rate도 0.2/1.2와 정확히 비교한다. 따라서
+per-model 환경 override나 전달된 runtime registry row가 가격을 바꾸면 계약 drift로
+거절한다. continuation 수정은 effective output cap도 최소 4,096인지 확인한다. 더 큰
+cap은 허용하되 Refiner 요청은 여전히 4,096으로 고정하며, cache disabled와 generic
+reservation cap은 이 계약의 비용·예약량을 바꾸지 않는다. 미래 예약 authority도 이
+gate를 예약·dispatch 전 같은 critical path에서 호출해야 한다. 다만 requestId
+결속·만료·1회 consume을 갖춘 원자 예약
 authority는 아직 없다. caller가 만든 lease/boolean은 받지 않고, eligibility·별도 단계
 승인·adapter readiness·계약이 모두 맞아도 `reservation_authority_unavailable`로
 dispatch 전에 거절한다. 따라서 현재 성공 admission 경로는 구조적으로 없다.
@@ -957,14 +964,14 @@ provider adapter/API/model 호출, product mode, Router 배선, AppSetting write
 | 전체 웹 Chat | **약 67%** (주관적 범위 **57–77%**) |
 | 직전 의미 있는 회차 대비 | **약 0%p** — 실행 사전등록은 닫혔지만 제품 호출·공개 범위는 그대로 |
 | C19–C20 Refiner·Planner·품질 평가 | **약 38%** (직전 약 37%, 예약 authority 미구현을 반영한 보수적 추정) |
-| 구현 | 순수 실행 사전등록·authority 부재 fail-closed·terminal mapping·핵심 단위 테스트 완료 |
-| 로컬 검증 | focused 26/26, 전체 lint·typecheck 통과 |
-| 독립 검토·통합 CI | 대기 — 이 회차에서는 독립 Claude 호출을 하지 않음 |
+| 구현 | 순수 실행 사전등록·effective 가격/output-cap drift·authority 부재 fail-closed·terminal mapping 구현 |
+| 로컬 검증 | output-cap/env 격리 테스트 포함 focused 30/30; 전체 lint·typecheck, pricing·문서·정책 참조·strict encoding 통과 |
+| 독립 검토·통합 CI | continuation round 0은 approve+재현 nit 2건으로 수정 대기; 이 revision은 아직 미검토 |
 | 병합·배포·공개 | 모두 미실행 — product adapter 없음, flag default-off, provider 호출 0 |
 
 ### 이 Cycle 다음 권장 순서
 
-1. 이 source의 좁은 diff를 독립 읽기 전용 검토와 Linux 통합 CI로 검증한다.
+1. 종료 exchange 기록은 바꾸지 말고 이 후속 좁은 diff를 새 내부 검토와 Linux 통합 CI로 검증한다.
 2. provider 호출이 없는 동결 corpus·output parser·중단 규칙의 shadow harness를 만든다.
 3. 별도 과금 승인과 원자적 단계 budget reservation이 준비된 뒤에만 작은 shadow를
    실행해 의미 보존·주입 저항·비용·지연을 측정한다.
diff --git a/docs/policy/prompt-refiner-observability.md b/docs/policy/prompt-refiner-observability.md
index 3c7f7b85..cce82b1c 100644
--- a/docs/policy/prompt-refiner-observability.md
+++ b/docs/policy/prompt-refiner-observability.md
@@ -8,12 +8,30 @@ provider adapter, API route, Prisma table, browser event writer, 비용 예약·
 Router 결합과 rollout 활성화는 없다. `lib/promptRefinerExecutionContract.ts`는 정확한
 model/catalog/pricing identity와 4,096 output tokens, 15초 timeout, retry 0,
 요청당 24,916 microUSD, 최대 100 dispatch의 단계 2,491,600 microUSD를 동결하지만
-그 자체로 실행을 승인하거나 비용을 예약하지 않는다.
+그 자체로 실행을 승인하거나 비용을 예약하지 않는다. 정적 pricing profile만
+대조하지 않고 실제 비용 경로와 같은 `resolveModelPricing()`으로 100,000-token
+요청의 effective input/output rate가 각각 0.2/1.2인지, effective
+`maxOutputTokens`가 고정 요청 cap 4,096 이상인지 다시 확인한다. 따라서
+`CHAT_MODEL_GPT_5_6_LUNA_*_USD_PER_MILLION` 환경 override나 미래 runtime registry
+row가 어느 rate든 바꾸거나 effective output cap을 4,096 미만으로 내리면
+`execution_contract_mismatch`로 fail-closed한다. 더 큰 effective cap은 모델·제품
+경로의 능력일 뿐 Refiner 요청을 키우지 않는다. 미래 adapter는 resolved maximum이
+아니라 계약의 4,096을 명시해야 한다.
+
+resolver 전체를 exact pin으로 오해하지 않는다. checked-in profile의 identity,
+routing, processing tier, pricing version/effective date, reasoning billing과 100,000-token
+tier는 별도로 exact 검사하며 `priceSchedule`이 생기면 새 계약을 요구한다. 반면
+cached-input multiplier는 prompt caching이 disabled라 이 계약의 비용을 바꾸지 않고,
+generic `reservationOutputTokens`는 Refiner authority가 사용할 예약량이 아니다. 미래
+authority는 이 계약의 4,096-token worst case를 예약해야 하며 generic reservation
+cap으로 낮춰 잡을 수 없다.
 현재는 원자 예약 authority가 없으므로 모든 다른 조건이 맞아도
 `reservation_authority_unavailable`로 dispatch 전에 거절한다. caller가 전달한 lease나
 atomic 여부 boolean을 성공 증거로 받는 입력과 `admitted: true` 경로는 없다. 후속
 authority가 requestId 결속·만료·1회 consume·비용과 stage slot의 원자 예약을 실제로
-구현한 뒤에만 새 계약 버전으로 성공 admission을 추가할 수 있다.
+구현한 뒤에만 새 계약 버전으로 성공 admission을 추가할 수 있다. 그 authority는
+runtime model row를 이 gate에 전달하고 원자 예약·dispatch 전에 같은 critical path에서
+통과시켜야 한다. 정적 profile 검사 결과를 과거에 캐시한 값으로 대신할 수 없다.
 
 ## 1. 하나의 변경 가능한 행 대신 두 개의 불변 사실
 
diff --git a/docs/ui-contracts/prompt-refiner-suggestion.md b/docs/ui-contracts/prompt-refiner-suggestion.md
index 9272e3e3..8385f0c3 100644
--- a/docs/ui-contracts/prompt-refiner-suggestion.md
+++ b/docs/ui-contracts/prompt-refiner-suggestion.md
@@ -118,7 +118,12 @@ provider adapter와 자동 요청을 활성화하려면 다음이 별도로 필
 
 1. 비용이 고정된 Refiner 모델·출력 cap·timeout·재시도 0 계약
    (provider-independent 사전등록은 구현됨. 예약 authority가 없으므로 admission은
-   항상 dispatch 전에 거절하며 실제 adapter·비용 예약·dispatch 권한은 없음)
+   항상 dispatch 전에 거절하며 실제 adapter·비용 예약·dispatch 권한은 없음.
+   정적 profile과 `resolveModelPricing()`의 effective input/output rate가 모두 exact
+   pin과 일치하고 effective output cap은 4,096 이상이어야 함. 더 큰 capability에도
+   adapter는 계약 cap 4,096을 명시하며 generic cached/reservation 설정을 이 계약의
+   비용·예약량으로 바꾸지 않음. 미래 authority도 runtime row를 전달해
+   예약·dispatch 전에 이 gate를 다시 통과해야 함)
 2. request/receipt와 사용자 선택률·stale·실패·지연 계측 (provider-independent
    schema와 오프라인 집계는 구현됨; writer·저장소·제품 수집은 미구현)
 3. 원문 대비 제안문 주입·의미 보존 평가
diff --git a/lib/promptRefinerExecutionContract.ts b/lib/promptRefinerExecutionContract.ts
index 477cd0e1..51c25934 100644
--- a/lib/promptRefinerExecutionContract.ts
+++ b/lib/promptRefinerExecutionContract.ts
@@ -4,6 +4,7 @@ import {
 } from "@/lib/models";
 import {
     getModelPricingProfile,
+    resolveModelPricing,
     type ModelPricingProfile,
 } from "@/lib/modelPricing";
 import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
@@ -136,6 +137,12 @@ type ContractModel = Pick<
     | "status"
     | "reasoning"
     | "contextWindowTokens"
+    | "usageClass"
+    | "maxOutputTokens"
+    | "reservationOutputTokens"
+    | "inputUsdPerMillionTokens"
+    | "outputUsdPerMillionTokens"
+    | "cachedInputPriceMultiplier"
 >;
 
 /**
@@ -186,6 +193,38 @@ export const promptRefinerExecutionContractProblems = (input?: {
         if (!model.enabled || model.status !== "enabled") {
             problems.push("model_not_enabled");
         }
+
+        // This is deliberately the same resolver used by reservation and cost
+        // settlement paths. Static profile checks below are necessary but not
+        // sufficient: DB/admin fields and per-model environment variables have
+        // higher precedence and must not silently move the effective price or
+        // make the frozen request output cap impossible.
+        const effectivePricing = resolveModelPricing(model, {
+            estimatedPromptTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+        });
+        if (
+            effectivePricing.inputUsdPerMillionTokens !==
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens
+        ) {
+            problems.push("effective_input_price_mismatch");
+        }
+        if (
+            effectivePricing.outputUsdPerMillionTokens !==
+            PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens
+        ) {
+            problems.push("effective_output_price_mismatch");
+        }
+        // The resolved cap is a product/provider capability, while this
+        // contract requests exactly 4,096 tokens. A larger capability does not
+        // change that request; a smaller or invalid one cannot honour it. The
+        // future adapter must pass the contract cap, never substitute this
+        // resolved maximum as the Refiner request cap.
+        if (
+            !Number.isSafeInteger(effectivePricing.maxOutputTokens) ||
+            effectivePricing.maxOutputTokens < PROMPT_REFINER_MAX_OUTPUT_TOKENS
+        ) {
+            problems.push("effective_output_cap_below_contract");
+        }
     }
 
     if (!pricing) {
diff --git a/tests/promptRefinerExecutionContract.test.mjs b/tests/promptRefinerExecutionContract.test.mjs
index 8ebf8f78..b42e9cce 100644
--- a/tests/promptRefinerExecutionContract.test.mjs
+++ b/tests/promptRefinerExecutionContract.test.mjs
@@ -2,7 +2,10 @@ import assert from "node:assert/strict";
 import test from "node:test";
 
 import { getModel } from "../lib/models.ts";
-import { getModelPricingProfile } from "../lib/modelPricing.ts";
+import {
+    getModelPricingProfile,
+    resolveModelPricing,
+} from "../lib/modelPricing.ts";
 import {
     PROMPT_REFINER_ADMISSION_REFUSAL_REASONS,
     PROMPT_REFINER_EXECUTION_CONTRACT,
@@ -47,6 +50,61 @@ const candidate = (overrides = {}) => ({
     ...overrides,
 });
 
+const INPUT_PRICE_ENV =
+    "CHAT_MODEL_GPT_5_6_LUNA_INPUT_USD_PER_MILLION";
+const OUTPUT_PRICE_ENV =
+    "CHAT_MODEL_GPT_5_6_LUNA_OUTPUT_USD_PER_MILLION";
+const CACHED_INPUT_MULTIPLIER_ENV =
+    "CHAT_MODEL_GPT_5_6_LUNA_CACHED_INPUT_PRICE_MULTIPLIER";
+const MAX_OUTPUT_TOKENS_ENV =
+    "CHAT_MODEL_GPT_5_6_LUNA_MAX_OUTPUT_TOKENS";
+const RESERVATION_OUTPUT_TOKENS_ENV =
+    "CHAT_MODEL_GPT_5_6_LUNA_RESERVATION_OUTPUT_TOKENS";
+const PROMPT_REFINER_PRICING_ENV_KEYS = [
+    INPUT_PRICE_ENV,
+    OUTPUT_PRICE_ENV,
+    CACHED_INPUT_MULTIPLIER_ENV,
+    MAX_OUTPUT_TOKENS_ENV,
+    RESERVATION_OUTPUT_TOKENS_ENV,
+];
+
+const envSnapshot = (keys) =>
+    Object.fromEntries(
+        keys.map((key) => [
+            key,
+            {
+                present: Object.prototype.hasOwnProperty.call(process.env, key),
+                value: process.env[key],
+            },
+        ])
+    );
+
+const withIsolatedPriceEnv = (overrides, callback) => {
+    const keys = PROMPT_REFINER_PRICING_ENV_KEYS;
+    const before = envSnapshot(keys);
+    try {
+        for (const key of keys) {
+            const value = overrides[key];
+            if (value === undefined) {
+                delete process.env[key];
+            } else {
+                process.env[key] = value;
+            }
+        }
+        return callback();
+    } finally {
+        for (const key of keys) {
+            const prior = before[key];
+            if (prior.present) {
+                process.env[key] = prior.value;
+            } else {
+                delete process.env[key];
+            }
+        }
+        assert.deepEqual(envSnapshot(keys), before);
+    }
+};
+
 test("execution contract freezes the shadow limits and worst-case cost", () => {
     assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.mode, "shadow");
     assert.equal(PROMPT_REFINER_EXECUTION_CONTRACT.userVisible, false);
@@ -90,104 +148,227 @@ test("the maximum escaped request fits the offline token upper bound", () => {
     assert.ok(maxRenderedRequestTokenUpperBound <= PROMPT_REFINER_MAX_INPUT_TOKENS);
 });
 
-test("the checked-in catalogue and pricing must match the exact pin", () => {
-    assert.deepEqual(promptRefinerExecutionContractProblems(), []);
-    assert.deepEqual(
-        promptRefinerExecutionContractProblems({ model: null, pricing: null }),
-        ["model_missing", "pricing_missing"]
-    );
+test("the checked-in catalogue and pricing must match the exact pin", { concurrency: false }, () => {
+    withIsolatedPriceEnv({}, () => {
+        assert.deepEqual(promptRefinerExecutionContractProblems(), []);
+        assert.deepEqual(
+            promptRefinerExecutionContractProblems({ model: null, pricing: null }),
+            ["model_missing", "pricing_missing"]
+        );
+
+        const model = getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+        const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+        assert.ok(model);
+        assert.ok(pricing);
+        assert.ok(
+            promptRefinerExecutionContractProblems({
+                model: { ...model, apiModel: "drifted-model" },
+                pricing,
+            }).includes("api_model_mismatch")
+        );
+        assert.ok(
+            promptRefinerExecutionContractProblems({
+                model,
+                pricing: { ...pricing, pricingVersion: "drifted-price" },
+            }).includes("pricing_version_mismatch")
+        );
+        assert.ok(
+            promptRefinerExecutionContractProblems({
+                model,
+                pricing: {
+                    ...pricing,
+                    tiers: pricing.tiers.map((tier, index) =>
+                        index === 0
+                            ? { ...tier, inputUsdPerMillionTokens: 999 }
+                            : tier
+                    ),
+                },
+            }).includes("input_price_mismatch")
+        );
+        assert.ok(
+            promptRefinerExecutionContractProblems({
+                model: { ...model, contextWindowTokens: 100_000 },
+                pricing,
+            }).includes("context_window_mismatch")
+        );
+        assert.ok(
+            promptRefinerExecutionContractProblems({
+                model,
+                pricing: { ...pricing, reasoningTokenBilling: "not_billed" },
+            }).includes("reasoning_token_billing_mismatch")
+        );
+    });
+});
 
+test("effective input price env drift fails closed without leaking env", { concurrency: false }, () => {
     const model = getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
-    const pricing = getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
     assert.ok(model);
-    assert.ok(pricing);
-    assert.ok(
-        promptRefinerExecutionContractProblems({
-            model: { ...model, apiModel: "drifted-model" },
-            pricing,
-        }).includes("api_model_mismatch")
-    );
-    assert.ok(
-        promptRefinerExecutionContractProblems({
-            model,
-            pricing: { ...pricing, pricingVersion: "drifted-price" },
-        }).includes("pricing_version_mismatch")
-    );
-    assert.ok(
-        promptRefinerExecutionContractProblems({
-            model,
-            pricing: {
-                ...pricing,
-                tiers: pricing.tiers.map((tier, index) =>
-                    index === 0
-                        ? { ...tier, inputUsdPerMillionTokens: 999 }
-                        : tier
+
+    withIsolatedPriceEnv(
+        {
+            [INPUT_PRICE_ENV]: "99",
+        },
+        () => {
+            const effective = resolveModelPricing(model, {
+                estimatedPromptTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+            });
+            assert.equal(effective.inputUsdPerMillionTokens, 99);
+            assert.equal(effective.outputUsdPerMillionTokens, 1.2);
+            assert.ok(
+                promptRefinerExecutionContractProblems().includes(
+                    "effective_input_price_mismatch"
+                )
+            );
+            assert.equal(
+                promptRefinerExecutionContractProblems().includes(
+                    "effective_output_price_mismatch"
                 ),
-            },
-        }).includes("input_price_mismatch")
-    );
-    assert.ok(
-        promptRefinerExecutionContractProblems({
-            model: { ...model, contextWindowTokens: 100_000 },
-            pricing,
-        }).includes("context_window_mismatch")
-    );
-    assert.ok(
-        promptRefinerExecutionContractProblems({
-            model,
-            pricing: { ...pricing, reasoningTokenBilling: "not_billed" },
-        }).includes("reasoning_token_billing_mismatch")
+                false
+            );
+            assert.deepEqual(admitPromptRefinerExecution(candidate()), {
+                admitted: false,
+                reason: "execution_contract_mismatch",
+            });
+        }
     );
 });
 
-test("an otherwise eligible request cannot fabricate successful admission", () => {
-    assert.deepEqual(admitPromptRefinerExecution(candidate()), {
-        admitted: false,
-        reason: "reservation_authority_unavailable",
-    });
-    assert.deepEqual(
-        admitPromptRefinerExecution(
-            candidate({
-                stageReservation: {
-                    kind: "forged",
-                    leaseId: "caller_controlled",
-                },
-            })
-        ),
+test("effective output price env drift fails closed without leaking env", { concurrency: false }, () => {
+    const model = getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    assert.ok(model);
+
+    withIsolatedPriceEnv(
         {
-            admitted: false,
-            reason: "reservation_authority_unavailable",
+            [OUTPUT_PRICE_ENV]: "99",
+        },
+        () => {
+            const effective = resolveModelPricing(model, {
+                estimatedPromptTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+            });
+            assert.equal(effective.inputUsdPerMillionTokens, 0.2);
+            assert.equal(effective.outputUsdPerMillionTokens, 99);
+            assert.ok(
+                promptRefinerExecutionContractProblems().includes(
+                    "effective_output_price_mismatch"
+                )
+            );
+            assert.equal(
+                promptRefinerExecutionContractProblems().includes(
+                    "effective_input_price_mismatch"
+                ),
+                false
+            );
+            assert.deepEqual(admitPromptRefinerExecution(candidate()), {
+                admitted: false,
+                reason: "execution_contract_mismatch",
+            });
         }
     );
 });
 
-test("unknown, unapproved, drifted and authority-less candidates fail closed", () => {
-    const cases = [
-        [candidate({ eligible: null }), "eligibility_refused"],
-        [candidate({ mode: "product" }), "eligibility_refused"],
-        [candidate({ stageApproved: null }), "execution_not_approved"],
-        [candidate({ adapterReady: null }), "adapter_unavailable"],
-        [candidate({ contractVersion: "drifted" }), "execution_contract_mismatch"],
-        [candidate({ retryCount: 1 }), "execution_contract_mismatch"],
-        [candidate({ promptCaching: "enabled" }), "execution_contract_mismatch"],
-        [candidate({ tools: "allowed" }), "execution_contract_mismatch"],
-        [candidate({ inputTokenCeiling: null }), "execution_contract_mismatch"],
-        [candidate({ inputTokenCeiling: 0 }), "execution_contract_mismatch"],
-        [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS - 1 }), "execution_contract_mismatch"],
-        [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS + 1 }), "execution_contract_mismatch"],
-        [candidate(), "reservation_authority_unavailable"],
-    ];
+test("effective output cap below 4096 fails closed without leaking env", { concurrency: false }, () => {
+    const model = getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    assert.ok(model);
 
-    for (const [input, reason] of cases) {
-        assert.deepEqual(admitPromptRefinerExecution(input), {
+    withIsolatedPriceEnv({ [MAX_OUTPUT_TOKENS_ENV]: "100" }, () => {
+        const effective = resolveModelPricing(model, {
+            estimatedPromptTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+        });
+        assert.equal(effective.maxOutputTokens, 100);
+        assert.ok(
+            promptRefinerExecutionContractProblems().includes(
+                "effective_output_cap_below_contract"
+            )
+        );
+        assert.deepEqual(admitPromptRefinerExecution(candidate()), {
             admitted: false,
-            reason,
+            reason: "execution_contract_mismatch",
         });
+    });
+});
+
+test("effective output cap at or above 4096 keeps the fixed request cap", { concurrency: false }, () => {
+    const model = getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
+    assert.ok(model);
+
+    for (const effectiveCap of [
+        PROMPT_REFINER_MAX_OUTPUT_TOKENS,
+        PROMPT_REFINER_MAX_OUTPUT_TOKENS + 1,
+    ]) {
+        withIsolatedPriceEnv(
+            { [MAX_OUTPUT_TOKENS_ENV]: String(effectiveCap) },
+            () => {
+                const effective = resolveModelPricing(model, {
+                    estimatedPromptTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
+                });
+                assert.equal(effective.maxOutputTokens, effectiveCap);
+                assert.equal(
+                    promptRefinerExecutionContractProblems().includes(
+                        "effective_output_cap_below_contract"
+                    ),
+                    false
+                );
+                assert.equal(
+                    PROMPT_REFINER_EXECUTION_CONTRACT.request.maxOutputTokens,
+                    PROMPT_REFINER_MAX_OUTPUT_TOKENS
+                );
+            }
+        );
     }
-    assert.deepEqual(
-        [...PROMPT_REFINER_ADMISSION_REFUSAL_REASONS].sort(),
-        [...new Set(cases.map(([, reason]) => reason))].sort()
-    );
+});
+
+test("an otherwise eligible request cannot fabricate successful admission", { concurrency: false }, () => {
+    withIsolatedPriceEnv({}, () => {
+        assert.deepEqual(admitPromptRefinerExecution(candidate()), {
+            admitted: false,
+            reason: "reservation_authority_unavailable",
+        });
+        assert.deepEqual(
+            admitPromptRefinerExecution(
+                candidate({
+                    stageReservation: {
+                        kind: "forged",
+                        leaseId: "caller_controlled",
+                    },
+                })
+            ),
+            {
+                admitted: false,
+                reason: "reservation_authority_unavailable",
+            }
+        );
+    });
+});
+
+test("unknown, unapproved, drifted and authority-less candidates fail closed", { concurrency: false }, () => {
+    withIsolatedPriceEnv({}, () => {
+        const cases = [
+            [candidate({ eligible: null }), "eligibility_refused"],
+            [candidate({ mode: "product" }), "eligibility_refused"],
+            [candidate({ stageApproved: null }), "execution_not_approved"],
+            [candidate({ adapterReady: null }), "adapter_unavailable"],
+            [candidate({ contractVersion: "drifted" }), "execution_contract_mismatch"],
+            [candidate({ retryCount: 1 }), "execution_contract_mismatch"],
+            [candidate({ promptCaching: "enabled" }), "execution_contract_mismatch"],
+            [candidate({ tools: "allowed" }), "execution_contract_mismatch"],
+            [candidate({ inputTokenCeiling: null }), "execution_contract_mismatch"],
+            [candidate({ inputTokenCeiling: 0 }), "execution_contract_mismatch"],
+            [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS - 1 }), "execution_contract_mismatch"],
+            [candidate({ inputTokenCeiling: PROMPT_REFINER_MAX_INPUT_TOKENS + 1 }), "execution_contract_mismatch"],
+            [candidate(), "reservation_authority_unavailable"],
+        ];
+
+        for (const [input, reason] of cases) {
+            assert.deepEqual(admitPromptRefinerExecution(input), {
+                admitted: false,
+                reason,
+            });
+        }
+        assert.deepEqual(
+            [...PROMPT_REFINER_ADMISSION_REFUSAL_REASONS].sort(),
+            [...new Set(cases.map(([, reason]) => reason))].sort()
+        );
+    });
 });
 
 test("every terminal reason has one content-free receipt and disposition mapping", () => {

```

## Test results (run by the control program)

- PASS `node --conditions=react-server --import tsx --test tests/promptRefinerExecutionContract.test.mjs tests/promptRefinerReceiptCore.test.mjs tests/promptRefinerSuggestion.test.mjs` (1171ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 1093.273

## Guard results (run by the control program)

- PASS `npm run typecheck` (37307ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm run lint -- --quiet` (49776ms)
  > ai-chat-hub@0.1.0 lint
  > eslint --quiet
- PASS `npm run check:model-pricing` (707ms)
  > ai-chat-hub@0.1.0 check:model-pricing
  > node --import tsx scripts/check-model-pricing.mjs
  
  
  Model pricing check passed: 36 explicit profiles, 0 model(s) on a conservative fallback, 0 unpriced premium models, 0 register warning(s), 0 expired pending prices.
- PASS `npm run check:doc-references` (1340ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 854 referenced path(s) across 108 instruction document(s), and 954 path(s) named by comments across 2898 source file(s), all present.
- PASS `npm run check:policy-section-references` (1024ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4428 citation(s) against 35 policy document(s). 2788 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1414 and 226 predate this change).
- PASS `npm run check:encoding:strict` (1271ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `git diff --check 96e20b351335a802f53a33e9f2af96572c989705 HEAD -- . ':(exclude)docs/ops/cross-review/packages/prompt-refiner-execution-contract-v1' ':(exclude)docs/ops/cross-review/packages/prompt-refiner-execution-pricing-drift-v1'` (48ms)

## Findings from the previous round (check each was addressed)

- [nit/evidence] lib/promptRefinerExecutionContract.ts:197-216 (promptRefinerExecutionContractProblems): The new effective-value gate covers only the two rates, so the sibling env override CHAT_MODEL_GPT_5_6_LUNA_MAX_OUTPUT_TOKENS still moves the resolved request output cap (the value app/api/chat/route.ts:1422-1423 feeds to requestOutputCapTokens) below the frozen 4,096 while the static check at lib/promptRefinerExecutionContract.ts:282 passes on the profile's 128,000 and the contract reports no drift.
- [nit/evidence] tests/promptRefinerExecutionContract.test.mjs:137: The baseline assertion that the checked-in catalogue yields no problems is no longer hermetic now that the gate reads process.env, and withIsolatedPriceEnv already supports the `undefined` = delete branch that would fix it but nothing exercises it, so the branch is dead code while the one test that needs it is left ambient.

## Author's account (read last; a claim, not a finding)

Summary: Close continuation round 0 findings by rejecting an effective resolved output cap below the frozen 4,096-token request while allowing equal or higher capability, making the baseline and admission tests hermetic across all five relevant model-pricing env variables with exact restoration, and documenting which resolved/static pricing fields can or cannot change the Refiner contract.

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-execution-pricing-drift-v1",
  "round": 1,
  "reviewedDigest": "sha256:8a184a434b8dec53b573221ea824b67cc0d78e3400769f765b443b0dc796e979",
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
