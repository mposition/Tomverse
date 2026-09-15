# Independent review — task prompt-refiner-receipt-metrics-v1, round 2

Review the change against the original requirement below. Read the requirement and the diff before anything else.
Do not take the author's summary as a description of what the change does; the diff is.

## Requirement (original)

Prompt Refiner를 제품에서 활성화하지 않은 채 provider-independent 내부 실행 receipt와 사용자 disposition receipt, 그리고 지연·실패·stale·사용자 선택률의 명시적 분모를 가진 무과금 집계 계약을 구현한다. 실행과 사용자 선택은 별도 immutable record로 유지하며, prompt·대화·사용자 식별자·provider 오류 본문을 저장할 필드를 두지 않는다. malformed·중복·orphan·결속 불일치·시간 역행은 fail-closed하고, 오프라인 report는 집계값과 provider/model attribution만 출력한다. provider 호출, billing, Router 입력, Prisma schema, 제품 adapter, AppSetting writer, flag 활성화, 품질·rollout 승인, 유료 실행은 포함하지 않는다. author는 codex, reviewer는 claude다.

## Completion criteria

- 실행 receipt는 성공·dispatch 후 실패·dispatch 전 거절을 구분하고 provider/model/adapter, contract version, timestamps, token·비용의 known-vs-unknown, retry count와 고정 failure 분류를 content-free하게 기록한다.
- 사용자 disposition receipt는 accepted·kept_original·stale을 실행 receipt와 결속하며 stale 원인이 requesting/ready 단계와 모순되거나 request/suggestion id가 어긋나면 거부한다.
- 집계는 request 수, suggestion yield, dispatched failure, refusal, preparation latency p50/p95, stale/request, explicit choice/suggestion, accepted/choice, 비용·token coverage와 provider/model breakdown의 분자·분모를 숨기지 않는다.
- 빈 표본은 rate·percentile을 null로 보고하고 malformed·중복·orphan·content field·provider 오류 문장을 fail-closed하는 회귀 테스트가 통과한다.
- 오프라인 report는 입력 receipt id·request id·suggestion id나 사용자 content를 출력하지 않고, 품질·release readiness·rollout 통과를 주장하지 않는다.
- 관련 unit, typecheck, lint, report dry run, 문서·인코딩·정책 참조와 diff whitespace 검사가 통과한다.
- Claude Code Max는 사용자가 승인한 skip-preflight 예외 아래 Read·Grep·Glob만으로 고정 digest를 독립 검토하며 API key를 사용하지 않는다.

## Change under review — digest sha256:ef3a83844798555e9324e50dd5e522d0d6640805ee324ed92b7cea8ebc755b16, commit 3452d730fc7066d2609e4675bf0f0b63821c4124

```diff
diff --git a/AGENTS.md b/AGENTS.md
index 05c5b520..e049535f 100644
--- a/AGENTS.md
+++ b/AGENTS.md
@@ -1283,9 +1283,11 @@ Non-negotiable requirements:
 
 Before changing the Prompt Refiner surface or request boundary in
 `ChatInput.tsx`, `PromptRefinerSuggestionPanel.tsx`,
-`lib/promptRefinerSuggestion.ts`, or `lib/promptRefinerModelPrompt.ts`, read:
+`lib/promptRefinerSuggestion.ts`, `lib/promptRefinerModelPrompt.ts`, or
+`lib/promptRefinerReceiptCore.ts`, read:
 
 - `docs/ui-contracts/prompt-refiner-suggestion.md`
+- `docs/policy/prompt-refiner-observability.md`
 
 Non-negotiable requirements:
 
@@ -1303,6 +1305,16 @@ Non-negotiable requirements:
   tool result, Router candidates, provider identity or model identity.
 - Refiner provider/model attribution belongs to an internal receipt and never
   replaces the answering-model badge.
+- Server execution and user disposition are separate immutable receipts. No
+  receipt may carry prompt/proposal bytes or digests, user/conversation/session
+  identity, attachment/Memory/profile/Router data, or provider error prose.
+  Unknown token/cost telemetry is null, not zero. Duplicate, orphan, binding
+  mismatch and time reversal fail closed.
+- Reliability, stale and choice metrics keep different denominators: provider
+  failure is over dispatched execution; stale is over all requests; explicit
+  choice is over successful suggestions; acceptance is over explicit choices.
+  Empty populations are null and no descriptive aggregate approves quality,
+  a release gate or rollout.
 - No provider call, billing, automatic offer, Router coupling or rollout is
   implied by the composer seam. Each requires its own approved server-owned
   gate and evidence.
diff --git a/docs/ops/cross-review/packages/prompt-refiner-receipt-metrics-v1.task.json b/docs/ops/cross-review/packages/prompt-refiner-receipt-metrics-v1.task.json
new file mode 100644
index 00000000..c59ee52f
--- /dev/null
+++ b/docs/ops/cross-review/packages/prompt-refiner-receipt-metrics-v1.task.json
@@ -0,0 +1,26 @@
+{
+  "taskId": "prompt-refiner-receipt-metrics-v1",
+  "requirement": "Prompt Refiner를 제품에서 활성화하지 않은 채 provider-independent 내부 실행 receipt와 사용자 disposition receipt, 그리고 지연·실패·stale·사용자 선택률의 명시적 분모를 가진 무과금 집계 계약을 구현한다. 실행과 사용자 선택은 별도 immutable record로 유지하며, prompt·대화·사용자 식별자·provider 오류 본문을 저장할 필드를 두지 않는다. malformed·중복·orphan·결속 불일치·시간 역행은 fail-closed하고, 오프라인 report는 집계값과 provider/model attribution만 출력한다. provider 호출, billing, Router 입력, Prisma schema, 제품 adapter, AppSetting writer, flag 활성화, 품질·rollout 승인, 유료 실행은 포함하지 않는다. author는 codex, reviewer는 claude다.",
+  "completionCriteria": [
+    "실행 receipt는 성공·dispatch 후 실패·dispatch 전 거절을 구분하고 provider/model/adapter, contract version, timestamps, token·비용의 known-vs-unknown, retry count와 고정 failure 분류를 content-free하게 기록한다.",
+    "사용자 disposition receipt는 accepted·kept_original·stale을 실행 receipt와 결속하며 stale 원인이 requesting/ready 단계와 모순되거나 request/suggestion id가 어긋나면 거부한다.",
+    "집계는 request 수, suggestion yield, dispatched failure, refusal, preparation latency p50/p95, stale/request, explicit choice/suggestion, accepted/choice, 비용·token coverage와 provider/model breakdown의 분자·분모를 숨기지 않는다.",
+    "빈 표본은 rate·percentile을 null로 보고하고 malformed·중복·orphan·content field·provider 오류 문장을 fail-closed하는 회귀 테스트가 통과한다.",
+    "오프라인 report는 입력 receipt id·request id·suggestion id나 사용자 content를 출력하지 않고, 품질·release readiness·rollout 통과를 주장하지 않는다.",
+    "관련 unit, typecheck, lint, report dry run, 문서·인코딩·정책 참조와 diff whitespace 검사가 통과한다.",
+    "Claude Code Max는 사용자가 승인한 skip-preflight 예외 아래 Read·Grep·Glob만으로 고정 digest를 독립 검토하며 API key를 사용하지 않는다."
+  ],
+  "baseCommit": "102006072838f09ff6e0104c0e4ae23e7dc8bfab",
+  "writableScope": [
+    "AGENTS.md",
+    "docs/ops/cross-review/packages/",
+    "docs/ops/tomverse-chat-progress.md",
+    "docs/policy/prompt-refiner-observability.md",
+    "docs/ui-contracts/prompt-refiner-suggestion.md",
+    "lib/promptRefinerReceiptCore.ts",
+    "package.json",
+    "scripts/report-prompt-refiner-receipts.mjs",
+    "tests/promptRefinerReceiptCore.test.mjs"
+  ],
+  "generatedPaths": []
+}
diff --git a/docs/ops/tomverse-chat-progress.md b/docs/ops/tomverse-chat-progress.md
index 9ade83db..fc49694c 100644
--- a/docs/ops/tomverse-chat-progress.md
+++ b/docs/ops/tomverse-chat-progress.md
@@ -866,3 +866,50 @@ deterministic하게 확인한다.
    측정한다.
 5. 품질 증거가 승인된 뒤에만 제품 adapter와 제안형 rollout을 열고, Refiner 결과의
    Router 결합 및 전체 카탈로그 선택 품질은 별도 실험으로 판단한다.
+
+## 2026-09-15 Prompt Refiner receipt·계측 계약 회차
+
+앞 회차의 다음 순서 ②를 provider 호출 없이 구현했다. 실행 사실과 사용자 반응을
+하나의 변경 가능한 행에 섞지 않고 `PromptRefinerExecutionReceipt`와
+`PromptRefinerDispositionReceipt`라는 두 immutable record로 분리했다. strict schema와
+bundle 결속 검사는 성공·dispatch 후 실패·dispatch 전 거절, provider/model/adapter,
+contract version, server timestamps, retry count와 token·microUSD의 known-vs-unknown을
+보존한다. prompt·제안문·digest·user/conversation/session identity·provider 오류
+본문을 담을 필드는 없다.
+
+집계는 suggestion yield, dispatched failure, refusal, 성공 preparation latency
+p50/p95, stale/request, explicit choice/suggestion, accepted/choice를 서로 다른 분모로
+계산하고 각 분자·분모를 함께 낸다. 빈 분모와 percentile은 0이 아니라 `null`이다.
+비용·token은 dispatch된 population 중 reported/missing/total을 분리하며,
+provider/model breakdown에서 attribution이 없는 request는 별도로 센다. 중복·orphan,
+request/suggestion 결속 불일치, stale 단계 모순, 시간 역행과 malformed 입력은
+fail-closed한다.
+
+`npm run report:prompt-refiner-receipts -- --input=<bundle.json>`은 자격증명과 과금
+없이 동결 bundle을 읽고 aggregate만 출력한다. 이 회차는 Prisma table·runtime writer,
+browser disposition API, product adapter, provider 호출, billing, Router 입력,
+AppSetting writer, flag 활성화와 품질·rollout 승인을 추가하지 않았다. 따라서 아직
+운영 데이터가 생기는 경로는 없고, 이 report의 수치는 release gate 증거가 아니다.
+
+### 한눈에 보는 전체 Chat 진척
+
+| 항목 | 이번 판단 |
+| --- | --- |
+| 전체 웹 Chat | **약 67%** (주관적 범위 **57–77%**) |
+| 직전 의미 있는 회차 대비 | **약 +1%p** — C19 관측 계약은 생겼지만 제품 호출·공개 범위는 그대로 |
+| C19–C20 Refiner·Planner·품질 평가 | **약 37%** (직전 약 32%) |
+| 구현 | receipt schema·결속·집계·오프라인 report 완료 |
+| 독립 검토·통합 CI | 이 기록 시점에는 대기 |
+| 공개 상태 | 변화 없음 — 제품 adapter 없음, flag default-off, provider 호출 0 |
+
+### 이 Cycle 다음 권장 순서
+
+1. 이 source를 Claude Code Max 읽기 전용 독립 검토와 Linux 통합 CI로 검증한다.
+2. Refiner model·output cap·timeout·retry 0·per-request/stage 비용 상한을 동결하는
+   사전등록을 만든다. **Claude 독립 검토 필요, provider 호출 0.**
+3. 동결 corpus와 중단 규칙을 가진 작은 shadow harness를 준비한다.
+   **Claude 독립 검토 필요, 준비 자체는 provider 호출 0.**
+4. 별도 과금 승인 뒤 shadow를 한 번 실행해 의미 보존·주입 저항·비용·지연을
+   측정하고, 통과했을 때만 durable writer·제품 adapter 연결을 제안한다.
+5. 사람에게 보이는 제안형 rollout 증거를 얻은 뒤 Refiner 결과의 Router 결합과
+   전체 카탈로그 선택 품질을 별도 실험으로 판단한다.
diff --git a/docs/policy/prompt-refiner-observability.md b/docs/policy/prompt-refiner-observability.md
new file mode 100644
index 00000000..4a0da87a
--- /dev/null
+++ b/docs/policy/prompt-refiner-observability.md
@@ -0,0 +1,142 @@
+# Prompt Refiner receipt와 관측 계약
+
+상태: **provider-independent 데이터 계약 구현, 제품 수집 미연결**.
+
+이 문서는 Prompt Refiner 한 요청에서 무엇을 관측하고 어떤 분모로 읽는지를
+정한다. 현재 구현은 strict schema, 결속 검사, 순수 집계와 오프라인 report까지다.
+provider adapter, API route, Prisma table, browser event writer, 비용 예약·정산,
+Router 결합과 rollout 활성화는 없다.
+
+## 1. 하나의 변경 가능한 행 대신 두 개의 불변 사실
+
+실행과 사용자 반응은 서로 다른 시점과 신뢰 경계에서 생긴다.
+
+1. `PromptRefinerExecutionReceipt`는 서버가 쓴다. 어느 provider/model/adapter가
+   호출됐는지, suggestion을 만들었는지, 실패 또는 dispatch 전 거절이었는지,
+   서버 시각·token·실비용·retry 수를 기록한다.
+2. `PromptRefinerDispositionReceipt`는 서버가 승인한 browser 관측이다. 사용자가
+   suggestion을 채택했는지, 원문을 유지했는지, draft/scope 변경 등으로 stale이
+   됐는지를 기록한다.
+
+두 번째 기록이 첫 번째 기록을 수정하지 않는다. 결속 키가 일치하는 별도 record로
+남기므로 늦은 browser 관측이 provider 결과나 비용을 소급해서 바꿀 수 없다. 한
+execution에는 disposition이 최대 하나다. 중복·orphan·request/suggestion 불일치는
+집계에서 제외하는 것이 아니라 bundle 전체를 거부한다.
+
+## 2. 실행 outcome과 실패 분류
+
+| outcome | 의미 | provider failure 분모 |
+| --- | --- | --- |
+| `suggested` | dispatch 뒤 strict response 검증을 통과해 suggestion을 만들었다 | 포함, 성공 |
+| `failed` | dispatch 이후 adapter/provider/response 검증에서 suggestion을 만들지 못했다 | 포함, 실패 |
+| `refused_before_dispatch` | admission/adapter가 provider 호출 전에 거절했다 | 제외 |
+
+`failed`와 `refused_before_dispatch`를 합치지 않는다. provider에 보내지 않은 요청은
+provider 신뢰성에 대해 아무 말도 하지 않기 때문이다. 따라서 `failed`는 반드시
+dispatch 시각을 가지며 `admission` layer를 쓸 수 없고, dispatch되지 않은
+`admission`/`adapter` 실패는 `refused_before_dispatch`로만 기록한다.
+`failureLayer`는 `admission`, `adapter`, `provider`, `response_validation` 중 하나이며
+성공만 `none`이다.
+`failureCode`는 고정 enum이고 provider 오류 본문을 담을 문자열 필드는 없다.
+`adapter_unavailable`과 `cost_guardrail`은 pre-dispatch 전용이고,
+`provider_error`, `timeout`, `invalid_response`, `empty_response`, `no_change`,
+`unknown_after_dispatch`는 post-dispatch 전용이다. `cancelled`는 dispatch 전후 모두
+일어날 수 있으므로 code만으로 단계를 주장하지 않고 `dispatchedAt`과 outcome이 그
+lifecycle을 결정한다.
+
+`requestedAt`, `dispatchedAt`, `completedAt`은 모두 서버 시각이다.
+`preparationLatencyMs`는 `completedAt - requestedAt`에서 도출한 값과 정확히 같아야
+한다. 미래 disposition API의 `observedAt`도 client clock이 아니라 서버가 그
+관측을 승인한 시각이어야 한다.
+
+## 3. known 0과 unknown은 다르다
+
+input, cache-read, output, reasoning token과 실제 비용은 nullable이다.
+
+- `0`: provider/정산기가 0이라고 보고했다.
+- `null`: 보고되지 않아 모른다.
+
+dispatch하지 않은 receipt는 이 값을 모두 `null`로 둔다. report는 각 항목마다
+`population`, `reported`, `missing`, `total`을 함께 보여 준다. 일부 값만 있는
+window에서 합계만 출력해 완전한 비용처럼 보이게 하지 않는다. 비용 단위는 정수
+microUSD이고 사용자 entitlement인 credit과 섞지 않는다.
+
+## 4. disposition과 stale
+
+명시적 선택은 `accepted`와 `kept_original` 두 개다. 둘 다 성공한 execution의
+같은 `suggestionId`에만 붙는다. `stale`은 suggestion 준비 전과 후를 이유 이름에서
+구분한다.
+
+- 준비 중: `draft_changed_while_requesting`, `scope_changed_while_requesting`,
+  `request_superseded`, `submitted_before_ready`. 아직 suggestion이 없으므로
+  `suggestionId`는 `null`이다.
+- 준비 후: `draft_changed_after_ready`, `scope_changed_after_ready`. 성공한
+  execution의 exact `suggestionId`가 필요하다.
+
+준비 중 stale은 provider 실행보다 먼저 관측될 수 있고 provider는 그 뒤 성공하거나
+실패할 수 있다. 따라서 stale을 실행 outcome으로 바꾸지 않는다. 반대로 채택과 원문
+유지는 `completedAt`보다 앞설 수 없다.
+
+## 5. 지표의 정확한 분자와 분모
+
+| 지표 | 분자 | 분모 | 0건일 때 |
+| --- | --- | --- | --- |
+| suggestion yield | `suggested` | 모든 execution request | `null` |
+| dispatched failure | dispatch된 `failed` | dispatch된 execution | `null` |
+| failed request | `failed` | 모든 execution request | `null` |
+| refusal | `refused_before_dispatch` | 모든 execution request | `null` |
+| stale request | `stale` disposition | 모든 execution request | `null` |
+| explicit choice | `accepted + kept_original` | `suggested` execution | `null` |
+| acceptance | `accepted` | `accepted + kept_original` | `null` |
+| keep-original | `kept_original` | `accepted + kept_original` | `null` |
+
+latency는 성공 suggestion의 `preparationLatencyMs` p50/p95와 모든 terminal
+execution의 p50/p95를 별도로 낸다. nearest-rank를 쓰고 표본 수를 같이 표시한다.
+실패 latency를 성공 latency에 섞거나 빈 표본을 0ms로 표시하지 않는다.
+
+provider/model breakdown은 attribution이 둘 다 있는 receipt만 묶고, 나머지는
+`unattributedRequests`로 따로 센다. breakdown은 어떤 모델이 더 낫다는 순위를
+만들지 않는다.
+
+## 6. 콘텐츠·개인정보 경계
+
+두 receipt schema에는 다음 필드가 없다.
+
+- prompt 원문·제안문·digest 또는 일부 발췌
+- user id, anonymous id, conversation id, session id, IP
+- attachment·Memory·profile·tool·Router 정보
+- provider 오류 본문
+
+허용되는 문자열은 제한된 id/version/provider/model과 고정 enum뿐이다. schema는
+strict이므로 `prompt`, `userId` 같은 추가 필드는 거부된다. 오프라인 report는
+receipt/request/suggestion/disposition id를 출력하지 않고 집계와 내부
+provider/model attribution만 출력한다.
+
+영속 저장소와 retention은 아직 결정하지 않았다. Prisma 또는 로그 writer를 붙일
+때는 삭제·export·telemetry completeness와 운영 조회 권한을 함께 결정해야 한다.
+현재 계약이 있다는 사실만으로 무기한 보관을 허용하지 않는다.
+
+## 7. 실행과 주장 경계
+
+`npm run report:prompt-refiner-receipts -- --input=<bundle.json>`은 자격증명과
+provider 호출 없이 동결된 bundle을 읽는다. `--json`은 같은 aggregate를 JSON으로
+낸다. malformed JSON, 16MiB 초과 입력, 100,000개 초과 배열, lifecycle 모순,
+중복·orphan은 fail-closed한다.
+
+이 report는 다음을 판정하지 않는다.
+
+- 제안문의 의미 보존 또는 주입 저항 품질
+- PLANNER-01/02, ROUTE-03 또는 다른 release gate 통과
+- provider/model 채택, 비용 상한 승인 또는 rollout readiness
+- 제품 adapter 활성화
+
+그 판단에는 별도 사전등록·품질 자료·비용 승인과 사람의 disposition이 필요하다.
+
+## 8. 다음 연결 단계
+
+1. 모델, output cap, timeout, retry 0, per-request/stage 비용 상한을 사전등록한다.
+2. 별도 승인된 작은 shadow가 execution bundle을 생성한다. 사용자에게 UI를
+   노출하지 않으므로 disposition은 만들지 않는다.
+3. 품질·비용·지연 증거가 승인된 뒤 제품 adapter와 서버 receipt writer를 붙인다.
+4. 제안형 UI가 실제로 제공될 때만 disposition API와 선택·stale 관측을 연결한다.
+5. 그 뒤에도 Refiner 결과의 Router 결합은 ROUTE-03의 별도 실험이다.
diff --git a/docs/ui-contracts/prompt-refiner-suggestion.md b/docs/ui-contracts/prompt-refiner-suggestion.md
index 16963a2b..cdf2695c 100644
--- a/docs/ui-contracts/prompt-refiner-suggestion.md
+++ b/docs/ui-contracts/prompt-refiner-suggestion.md
@@ -90,6 +90,13 @@ JSON의 `sourceText` 값으로 인코딩되며, system instruction은 이를 실
 - 최종 답변 provenance: 실제 답을 만든 provider/model을 기존 답변 badge가
   표시한다.
 
+내부 기록의 형식과 분모는
+[`docs/policy/prompt-refiner-observability.md`](../policy/prompt-refiner-observability.md)가
+소유한다. 서버 실행 receipt와 사용자 disposition receipt는 별개이며, 어느 쪽에도
+원문·제안문·digest·user/conversation/session identity 또는 provider 오류 본문을
+담지 않는다. browser response에는 이 receipt도 provider/model attribution도 싣지
+않는다.
+
 Refiner 모델을 답변 badge에 넣거나 Refiner 제안을 최종 답변으로 세는 것은 금지다.
 브라우저의 `refinerVersion`은 `suggest-vN` 형태의 Tomverse prompt-contract
 버전만 허용한다. provider나 model 이름·별칭·release를 이 필드에 인코딩해서
@@ -99,14 +106,18 @@ Refiner 모델을 답변 badge에 넣거나 Refiner 제안을 최종 답변으
 
 제안은 전송 전에 끝나므로 Refiner 대기 시간은 최종 답변의 TTFT 측정 시작보다
 앞에 있다. 그렇다고 지연이 사라진 것은 아니다. 제안 준비 시간은 별도 지표로
-측정해야 하고, 사용자가 기다리다 원문을 전송하거나 문장을 바꾼 stale 비율도
-보고해야 한다.
+측정하고, 사용자가 기다리다 원문을 전송하거나 문장을 바꾼 stale 비율도 보고한다.
+성공 지연은 성공 suggestion만의 p50/p95, provider 실패율은 dispatch된 execution만,
+stale은 모든 request, 명시적 선택률은 성공 suggestion, 채택률은
+accepted+kept-original을 각각 분모로 쓴다. 서로 다른 분모를 한 conversion 수치로
+합치지 않고, 빈 분모는 0이 아니라 `null`이다.
 
 이 UI 계약은 PLANNER-02, ROUTE-03 또는 품질 증거를 통과시킨 것이 아니다. 실제
 provider adapter와 자동 요청을 활성화하려면 다음이 별도로 필요하다.
 
 1. 비용이 고정된 Refiner 모델·출력 cap·timeout·재시도 0 계약
-2. request/receipt와 사용자 선택률·stale·실패·지연 계측
+2. request/receipt와 사용자 선택률·stale·실패·지연 계측 (provider-independent
+   schema와 오프라인 집계는 구현됨; writer·저장소·제품 수집은 미구현)
 3. 원문 대비 제안문 주입·의미 보존 평가
 4. 승인된 품질 증거와 release gate disposition
 5. server-owned offered 결정과 kill switch
diff --git a/lib/promptRefinerReceiptCore.ts b/lib/promptRefinerReceiptCore.ts
new file mode 100644
index 00000000..ef34d345
--- /dev/null
+++ b/lib/promptRefinerReceiptCore.ts
@@ -0,0 +1,657 @@
+import { z } from "zod";
+
+/**
+ * Content-free Prompt Refiner observability.
+ *
+ * The server-side execution receipt and the browser-originated disposition
+ * receipt are separate immutable facts. The first says what the adapter did;
+ * the second says what happened to the proposal in the composer. Keeping them
+ * separate prevents a late client event from rewriting provider telemetry and
+ * lets every rate retain its real denominator.
+ *
+ * docs/policy/prompt-refiner-observability.md
+ */
+
+export const PROMPT_REFINER_EXECUTION_RECEIPT_VERSION =
+    "prompt-refiner-execution-v1" as const;
+export const PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION =
+    "prompt-refiner-disposition-v1" as const;
+export const PROMPT_REFINER_RECEIPT_BUNDLE_VERSION =
+    "prompt-refiner-observability-v1" as const;
+export const PROMPT_REFINER_RECEIPT_MAX_RECORDS = 100_000;
+
+export const PROMPT_REFINER_EXECUTION_OUTCOMES = [
+    "suggested",
+    "failed",
+    "refused_before_dispatch",
+] as const;
+export const PROMPT_REFINER_FAILURE_LAYERS = [
+    "none",
+    "admission",
+    "adapter",
+    "provider",
+    "response_validation",
+] as const;
+export const PROMPT_REFINER_FAILURE_CODES = [
+    "adapter_unavailable",
+    "cost_guardrail",
+    "invalid_response",
+    "empty_response",
+    "no_change",
+    "provider_error",
+    "timeout",
+    "cancelled",
+    "unknown_after_dispatch",
+] as const;
+const PRE_DISPATCH_ONLY_FAILURE_CODES = new Set<string>([
+    "adapter_unavailable",
+    "cost_guardrail",
+]);
+const POST_DISPATCH_ONLY_FAILURE_CODES = new Set<string>([
+    "invalid_response",
+    "empty_response",
+    "no_change",
+    "provider_error",
+    "timeout",
+    "unknown_after_dispatch",
+]);
+export const PROMPT_REFINER_DISPOSITION_OUTCOMES = [
+    "accepted",
+    "kept_original",
+    "stale",
+] as const;
+export const PROMPT_REFINER_STALE_REASONS = [
+    "draft_changed_while_requesting",
+    "scope_changed_while_requesting",
+    "request_superseded",
+    "submitted_before_ready",
+    "draft_changed_after_ready",
+    "scope_changed_after_ready",
+] as const;
+
+const identifier = z
+    .string()
+    .min(1)
+    .max(128)
+    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/);
+const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
+const isoTimestamp = z.string().datetime({ offset: true });
+const optionalTelemetryCount = z
+    .number()
+    .int()
+    .nonnegative()
+    .max(Number.MAX_SAFE_INTEGER)
+    .nullable();
+
+const executionReceiptBaseSchema = z
+    .object({
+        receiptVersion: z.literal(PROMPT_REFINER_EXECUTION_RECEIPT_VERSION),
+        receiptId: opaqueId,
+        requestId: opaqueId,
+        suggestionId: opaqueId.nullable(),
+        /** Tomverse prompt contract version, never a provider/model alias. */
+        refinerVersion: z.string().regex(/^suggest-v[1-9][0-9]{0,3}$/),
+        provider: identifier.nullable(),
+        modelId: identifier.nullable(),
+        adapterVersion: identifier.nullable(),
+        outcome: z.enum(PROMPT_REFINER_EXECUTION_OUTCOMES),
+        failureLayer: z.enum(PROMPT_REFINER_FAILURE_LAYERS),
+        /** Closed code only. Provider error prose has no field in this schema. */
+        failureCode: z.enum(PROMPT_REFINER_FAILURE_CODES).nullable(),
+        requestedAt: isoTimestamp,
+        dispatchedAt: isoTimestamp.nullable(),
+        completedAt: isoTimestamp,
+        /** Derived requestedAt -> completedAt wall time. */
+        preparationLatencyMs: z.number().int().nonnegative(),
+        inputTokens: optionalTelemetryCount,
+        cachedInputTokens: optionalTelemetryCount,
+        outputTokens: optionalTelemetryCount,
+        reasoningTokens: optionalTelemetryCount,
+        actualCostMicroUsd: optionalTelemetryCount,
+        retryCount: z.number().int().min(0).max(10),
+    })
+    .strict();
+
+export const promptRefinerExecutionReceiptSchema =
+    executionReceiptBaseSchema.superRefine((receipt, context) => {
+        const requestedAt = Date.parse(receipt.requestedAt);
+        const completedAt = Date.parse(receipt.completedAt);
+        const dispatchedAt = receipt.dispatchedAt
+            ? Date.parse(receipt.dispatchedAt)
+            : null;
+        const issue = (message: string, path: Array<string | number>) =>
+            context.addIssue({ code: "custom", message, path });
+
+        if (completedAt < requestedAt) {
+            issue("prompt_refiner_completion_precedes_request", ["completedAt"]);
+        }
+        if (
+            dispatchedAt !== null &&
+            (dispatchedAt < requestedAt || dispatchedAt > completedAt)
+        ) {
+            issue("prompt_refiner_dispatch_outside_execution_window", [
+                "dispatchedAt",
+            ]);
+        }
+        if (
+            receipt.preparationLatencyMs !==
+            Math.max(0, completedAt - requestedAt)
+        ) {
+            issue("prompt_refiner_latency_does_not_match_timestamps", [
+                "preparationLatencyMs",
+            ]);
+        }
+
+        const hasCompleteAttribution =
+            receipt.provider !== null &&
+            receipt.modelId !== null &&
+            receipt.adapterVersion !== null;
+        const attributionCount = [
+            receipt.provider,
+            receipt.modelId,
+            receipt.adapterVersion,
+        ].filter((value) => value !== null).length;
+        const hasAnyTelemetry =
+            receipt.inputTokens !== null ||
+            receipt.cachedInputTokens !== null ||
+            receipt.outputTokens !== null ||
+            receipt.reasoningTokens !== null ||
+            receipt.actualCostMicroUsd !== null;
+
+        if (receipt.outcome === "suggested") {
+            if (!receipt.suggestionId) {
+                issue("prompt_refiner_success_requires_suggestion", [
+                    "suggestionId",
+                ]);
+            }
+            if (dispatchedAt === null || !hasCompleteAttribution) {
+                issue("prompt_refiner_success_requires_dispatch_attribution", [
+                    "outcome",
+                ]);
+            }
+            if (receipt.failureLayer !== "none" || receipt.failureCode !== null) {
+                issue("prompt_refiner_success_cannot_carry_failure", [
+                    "failureLayer",
+                ]);
+            }
+        } else {
+            if (receipt.suggestionId !== null) {
+                issue("prompt_refiner_non_success_cannot_carry_suggestion", [
+                    "suggestionId",
+                ]);
+            }
+            if (receipt.failureLayer === "none" || receipt.failureCode === null) {
+                issue("prompt_refiner_non_success_requires_failure", [
+                    "failureLayer",
+                ]);
+            }
+        }
+
+        if (attributionCount !== 0 && attributionCount !== 3) {
+            issue("prompt_refiner_attribution_is_partial", ["provider"]);
+        }
+
+        if (receipt.outcome === "refused_before_dispatch") {
+            if (dispatchedAt !== null || hasAnyTelemetry || receipt.retryCount !== 0) {
+                issue("prompt_refiner_refusal_cannot_claim_provider_work", [
+                    "outcome",
+                ]);
+            }
+            if (
+                receipt.failureLayer !== "admission" &&
+                receipt.failureLayer !== "adapter"
+            ) {
+                issue("prompt_refiner_refusal_has_invalid_failure_layer", [
+                    "failureLayer",
+                ]);
+            }
+        }
+
+        if (receipt.outcome === "failed") {
+            if (dispatchedAt === null) {
+                issue("prompt_refiner_failure_requires_dispatch", [
+                    "dispatchedAt",
+                ]);
+            }
+            if (receipt.failureLayer === "admission") {
+                issue("prompt_refiner_failure_cannot_use_admission_layer", [
+                    "failureLayer",
+                ]);
+            }
+        }
+        if (dispatchedAt !== null && !hasCompleteAttribution) {
+            issue("prompt_refiner_dispatch_requires_attribution", ["provider"]);
+        }
+        if (dispatchedAt === null && hasAnyTelemetry) {
+            issue("prompt_refiner_undispatched_receipt_cannot_have_telemetry", [
+                "inputTokens",
+            ]);
+        }
+        if (
+            receipt.failureCode !== null &&
+            dispatchedAt === null &&
+            POST_DISPATCH_ONLY_FAILURE_CODES.has(receipt.failureCode)
+        ) {
+            issue("prompt_refiner_post_dispatch_code_requires_dispatch", [
+                "failureCode",
+            ]);
+        }
+        if (
+            receipt.failureCode !== null &&
+            dispatchedAt !== null &&
+            PRE_DISPATCH_ONLY_FAILURE_CODES.has(receipt.failureCode)
+        ) {
+            issue("prompt_refiner_pre_dispatch_code_forbids_dispatch", [
+                "failureCode",
+            ]);
+        }
+    });
+
+const staleBeforeReady = new Set<string>([
+    "draft_changed_while_requesting",
+    "scope_changed_while_requesting",
+    "request_superseded",
+    "submitted_before_ready",
+]);
+
+export const promptRefinerDispositionReceiptSchema = z
+    .object({
+        receiptVersion: z.literal(PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION),
+        dispositionId: opaqueId,
+        executionReceiptId: opaqueId,
+        requestId: opaqueId,
+        suggestionId: opaqueId.nullable(),
+        outcome: z.enum(PROMPT_REFINER_DISPOSITION_OUTCOMES),
+        staleReason: z.enum(PROMPT_REFINER_STALE_REASONS).nullable(),
+        observedAt: isoTimestamp,
+    })
+    .strict()
+    .superRefine((receipt, context) => {
+        const issue = (message: string, path: Array<string | number>) =>
+            context.addIssue({ code: "custom", message, path });
+        if (receipt.outcome === "stale") {
+            if (receipt.staleReason === null) {
+                issue("prompt_refiner_stale_requires_reason", ["staleReason"]);
+            } else if (
+                staleBeforeReady.has(receipt.staleReason) !==
+                (receipt.suggestionId === null)
+            ) {
+                issue("prompt_refiner_stale_stage_does_not_match_suggestion", [
+                    "suggestionId",
+                ]);
+            }
+        } else {
+            if (receipt.suggestionId === null) {
+                issue("prompt_refiner_choice_requires_suggestion", [
+                    "suggestionId",
+                ]);
+            }
+            if (receipt.staleReason !== null) {
+                issue("prompt_refiner_choice_cannot_carry_stale_reason", [
+                    "staleReason",
+                ]);
+            }
+        }
+    });
+
+const receiptBundleBaseSchema = z
+    .object({
+        bundleVersion: z.literal(PROMPT_REFINER_RECEIPT_BUNDLE_VERSION),
+        executions: z
+            .array(promptRefinerExecutionReceiptSchema)
+            .max(PROMPT_REFINER_RECEIPT_MAX_RECORDS),
+        dispositions: z
+            .array(promptRefinerDispositionReceiptSchema)
+            .max(PROMPT_REFINER_RECEIPT_MAX_RECORDS),
+    })
+    .strict();
+
+export const promptRefinerReceiptBundleSchema =
+    receiptBundleBaseSchema.superRefine((bundle, context) => {
+        const executionsById = new Map(
+            bundle.executions.map((receipt) => [receipt.receiptId, receipt])
+        );
+        const duplicateValues = (
+            values: readonly string[],
+            path: "executions" | "dispositions",
+            label: string
+        ) => {
+            const seen = new Set<string>();
+            for (const [index, value] of values.entries()) {
+                if (seen.has(value)) {
+                    context.addIssue({
+                        code: "custom",
+                        message: `prompt_refiner_duplicate_${label}`,
+                        path: [path, index],
+                    });
+                }
+                seen.add(value);
+            }
+        };
+
+        duplicateValues(
+            bundle.executions.map((receipt) => receipt.receiptId),
+            "executions",
+            "execution_receipt_id"
+        );
+        duplicateValues(
+            bundle.executions.map((receipt) => receipt.requestId),
+            "executions",
+            "request_id"
+        );
+        duplicateValues(
+            bundle.executions.flatMap((receipt) =>
+                receipt.suggestionId ? [receipt.suggestionId] : []
+            ),
+            "executions",
+            "suggestion_id"
+        );
+        duplicateValues(
+            bundle.dispositions.map((receipt) => receipt.dispositionId),
+            "dispositions",
+            "disposition_id"
+        );
+        duplicateValues(
+            bundle.dispositions.map((receipt) => receipt.executionReceiptId),
+            "dispositions",
+            "execution_disposition"
+        );
+
+        for (const [index, disposition] of bundle.dispositions.entries()) {
+            const execution = executionsById.get(disposition.executionReceiptId);
+            const issue = (message: string, field: string) =>
+                context.addIssue({
+                    code: "custom",
+                    message,
+                    path: ["dispositions", index, field],
+                });
+            if (!execution) {
+                issue("prompt_refiner_orphan_disposition", "executionReceiptId");
+                continue;
+            }
+            if (execution.requestId !== disposition.requestId) {
+                issue("prompt_refiner_disposition_request_mismatch", "requestId");
+            }
+            const beforeReadyStale =
+                disposition.outcome === "stale" &&
+                disposition.staleReason !== null &&
+                staleBeforeReady.has(disposition.staleReason);
+            if (!beforeReadyStale) {
+                if (execution.outcome !== "suggested") {
+                    issue(
+                        "prompt_refiner_disposition_requires_suggestion_outcome",
+                        "outcome"
+                    );
+                }
+                if (execution.suggestionId !== disposition.suggestionId) {
+                    issue(
+                        "prompt_refiner_disposition_suggestion_mismatch",
+                        "suggestionId"
+                    );
+                }
+            }
+
+            const observedAt = Date.parse(disposition.observedAt);
+            if (observedAt < Date.parse(execution.requestedAt)) {
+                issue("prompt_refiner_disposition_precedes_request", "observedAt");
+            }
+            if (
+                !beforeReadyStale &&
+                observedAt < Date.parse(execution.completedAt)
+            ) {
+                issue("prompt_refiner_ready_disposition_precedes_completion", "observedAt");
+            }
+        }
+    });
+
+export type PromptRefinerExecutionReceipt = z.infer<
+    typeof promptRefinerExecutionReceiptSchema
+>;
+export type PromptRefinerDispositionReceipt = z.infer<
+    typeof promptRefinerDispositionReceiptSchema
+>;
+export type PromptRefinerReceiptBundle = z.infer<
+    typeof promptRefinerReceiptBundleSchema
+>;
+
+export type PromptRefinerPercentiles = {
+    count: number;
+    p50: number | null;
+    p95: number | null;
+};
+
+export type PromptRefinerTelemetryCoverage = {
+    population: number;
+    reported: number;
+    missing: number;
+    total: number;
+};
+
+export type PromptRefinerModelBreakdown = {
+    provider: string;
+    modelId: string;
+    requests: number;
+    dispatched: number;
+    suggested: number;
+    failed: number;
+    refusedBeforeDispatch: number;
+    dispatchedFailureRate: number | null;
+    suggestionPreparationLatencyMs: PromptRefinerPercentiles;
+};
+
+export type PromptRefinerReceiptSummary = {
+    requests: number;
+    outcomes: {
+        suggested: number;
+        failed: number;
+        refusedBeforeDispatch: number;
+    };
+    dispatched: number;
+    dispatchedFailures: number;
+    dispatchedFailureRate: number | null;
+    failedRequestRate: number | null;
+    refusalRate: number | null;
+    suggestionYieldRate: number | null;
+    terminalLatencyMs: PromptRefinerPercentiles;
+    suggestionPreparationLatencyMs: PromptRefinerPercentiles;
+    dispositions: {
+        observed: number;
+        unobservedRequests: number;
+        accepted: number;
+        keptOriginal: number;
+        stale: number;
+        staleRequestRate: number | null;
+        explicitChoices: number;
+        explicitChoiceRatePerSuggestion: number | null;
+        acceptanceRatePerChoice: number | null;
+        keptOriginalRatePerChoice: number | null;
+    };
+    telemetry: {
+        actualCostMicroUsd: PromptRefinerTelemetryCoverage;
+        inputTokens: PromptRefinerTelemetryCoverage;
+        outputTokens: PromptRefinerTelemetryCoverage;
+        reasoningTokens: PromptRefinerTelemetryCoverage;
+        cachedInputTokens: PromptRefinerTelemetryCoverage;
+    };
+    failureCodes: Record<string, number>;
+    unattributedRequests: number;
+    byProviderModel: PromptRefinerModelBreakdown[];
+};
+
+const rate = (numerator: number, denominator: number): number | null =>
+    denominator === 0 ? null : numerator / denominator;
+
+const percentiles = (values: readonly number[]): PromptRefinerPercentiles => {
+    if (values.length === 0) return { count: 0, p50: null, p95: null };
+    const sorted = [...values].sort((left, right) => left - right);
+    const at = (quantile: number) =>
+        sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
+    return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
+};
+
+const telemetryCoverage = (
+    receipts: readonly PromptRefinerExecutionReceipt[],
+    field:
+        | "actualCostMicroUsd"
+        | "inputTokens"
+        | "outputTokens"
+        | "reasoningTokens"
+        | "cachedInputTokens"
+): PromptRefinerTelemetryCoverage => {
+    const dispatched = receipts.filter((receipt) => receipt.dispatchedAt !== null);
+    const reported = dispatched
+        .map((receipt) => receipt[field])
+        .filter((value): value is number => value !== null);
+    return {
+        population: dispatched.length,
+        reported: reported.length,
+        missing: dispatched.length - reported.length,
+        total: reported.reduce((sum, value) => sum + value, 0),
+    };
+};
+
+const summarizeModel = (
+    provider: string,
+    modelId: string,
+    receipts: readonly PromptRefinerExecutionReceipt[]
+): PromptRefinerModelBreakdown => {
+    const dispatched = receipts.filter((receipt) => receipt.dispatchedAt !== null);
+    const failed = receipts.filter((receipt) => receipt.outcome === "failed").length;
+    const dispatchedFailures = dispatched.filter(
+        (receipt) => receipt.outcome === "failed"
+    ).length;
+    return {
+        provider,
+        modelId,
+        requests: receipts.length,
+        dispatched: dispatched.length,
+        suggested: receipts.filter((receipt) => receipt.outcome === "suggested")
+            .length,
+        failed,
+        refusedBeforeDispatch: receipts.filter(
+            (receipt) => receipt.outcome === "refused_before_dispatch"
+        ).length,
+        dispatchedFailureRate: rate(dispatchedFailures, dispatched.length),
+        suggestionPreparationLatencyMs: percentiles(
+            receipts
+                .filter((receipt) => receipt.outcome === "suggested")
+                .map((receipt) => receipt.preparationLatencyMs)
+        ),
+    };
+};
+
+/**
+ * Computes descriptive observability only. No threshold here can approve a
+ * provider, infer quality, activate rollout, or satisfy a release gate.
+ */
+export const summarizePromptRefinerReceipts = (
+    input: unknown
+): PromptRefinerReceiptSummary => {
+    const bundle = promptRefinerReceiptBundleSchema.parse(input);
+    const executions = bundle.executions;
+    const dispositions = bundle.dispositions;
+    const suggested = executions.filter(
+        (receipt) => receipt.outcome === "suggested"
+    ).length;
+    const failed = executions.filter(
+        (receipt) => receipt.outcome === "failed"
+    ).length;
+    const refusedBeforeDispatch = executions.filter(
+        (receipt) => receipt.outcome === "refused_before_dispatch"
+    ).length;
+    const dispatched = executions.filter(
+        (receipt) => receipt.dispatchedAt !== null
+    );
+    const dispatchedFailures = dispatched.filter(
+        (receipt) => receipt.outcome === "failed"
+    ).length;
+    const accepted = dispositions.filter(
+        (receipt) => receipt.outcome === "accepted"
+    ).length;
+    const keptOriginal = dispositions.filter(
+        (receipt) => receipt.outcome === "kept_original"
+    ).length;
+    const stale = dispositions.filter(
+        (receipt) => receipt.outcome === "stale"
+    ).length;
+    const explicitChoices = accepted + keptOriginal;
+    const grouped = new Map<string, PromptRefinerExecutionReceipt[]>();
+    let unattributedRequests = 0;
+    for (const receipt of executions) {
+        if (!receipt.provider || !receipt.modelId) {
+            unattributedRequests += 1;
+            continue;
+        }
+        const key = `${receipt.provider}\u0000${receipt.modelId}`;
+        const group = grouped.get(key) ?? [];
+        group.push(receipt);
+        grouped.set(key, group);
+    }
+    const failureCodes: Record<string, number> = {};
+    for (const receipt of executions) {
+        if (!receipt.failureCode) continue;
+        failureCodes[receipt.failureCode] =
+            (failureCodes[receipt.failureCode] ?? 0) + 1;
+    }
+
+    return {
+        requests: executions.length,
+        outcomes: { suggested, failed, refusedBeforeDispatch },
+        dispatched: dispatched.length,
+        dispatchedFailures,
+        dispatchedFailureRate: rate(dispatchedFailures, dispatched.length),
+        failedRequestRate: rate(failed, executions.length),
+        refusalRate: rate(refusedBeforeDispatch, executions.length),
+        suggestionYieldRate: rate(suggested, executions.length),
+        terminalLatencyMs: percentiles(
+            executions.map((receipt) => receipt.preparationLatencyMs)
+        ),
+        suggestionPreparationLatencyMs: percentiles(
+            executions
+                .filter((receipt) => receipt.outcome === "suggested")
+                .map((receipt) => receipt.preparationLatencyMs)
+        ),
+        dispositions: {
+            observed: dispositions.length,
+            unobservedRequests: executions.length - dispositions.length,
+            accepted,
+            keptOriginal,
+            stale,
+            staleRequestRate: rate(stale, executions.length),
+            explicitChoices,
+            explicitChoiceRatePerSuggestion: rate(explicitChoices, suggested),
+            acceptanceRatePerChoice: rate(accepted, explicitChoices),
+            keptOriginalRatePerChoice: rate(keptOriginal, explicitChoices),
+        },
+        telemetry: {
+            actualCostMicroUsd: telemetryCoverage(
+                executions,
+                "actualCostMicroUsd"
+            ),
+            inputTokens: telemetryCoverage(executions, "inputTokens"),
+            outputTokens: telemetryCoverage(executions, "outputTokens"),
+            reasoningTokens: telemetryCoverage(executions, "reasoningTokens"),
+            cachedInputTokens: telemetryCoverage(
+                executions,
+                "cachedInputTokens"
+            ),
+        },
+        failureCodes: Object.fromEntries(
+            Object.entries(failureCodes).sort(([left], [right]) =>
+                left.localeCompare(right)
+            )
+        ),
+        unattributedRequests,
+        byProviderModel: [...grouped.entries()]
+            .map(([key, receipts]) => {
+                const [provider, modelId] = key.split("\u0000");
+                return summarizeModel(provider, modelId, receipts);
+            })
+            .sort(
+                (left, right) =>
+                    right.requests - left.requests ||
+                    left.provider.localeCompare(right.provider) ||
+                    left.modelId.localeCompare(right.modelId)
+            ),
+    };
+};
diff --git a/package.json b/package.json
index 5108a6c6..146b59f1 100644
--- a/package.json
+++ b/package.json
@@ -197,6 +197,7 @@
     "check:capacitor-local-bundle": "node scripts/check-capacitor-local-bundle.mjs",
     "build:mobile-shell": "npm run build --workspace @tomverse/mobile",
     "check:prompt-injection": "node --conditions=react-server --import tsx scripts/report-prompt-injection.mjs",
+    "report:prompt-refiner-receipts": "node --import tsx scripts/report-prompt-refiner-receipts.mjs",
     "check:push-scope": "node scripts/check-push-scope.mjs",
     "check:retired-product-name": "node scripts/check-retired-product-name.mjs",
     "check:conversation-writers": "node scripts/check-conversation-writers.mjs",
diff --git a/scripts/report-prompt-refiner-receipts.mjs b/scripts/report-prompt-refiner-receipts.mjs
new file mode 100644
index 00000000..241a4d21
--- /dev/null
+++ b/scripts/report-prompt-refiner-receipts.mjs
@@ -0,0 +1,114 @@
+#!/usr/bin/env node
+
+import { readFile, stat } from "node:fs/promises";
+
+import { summarizePromptRefinerReceipts } from "../lib/promptRefinerReceiptCore.ts";
+
+const MAX_INPUT_BYTES = 16 * 1024 * 1024;
+
+const parseArguments = (argumentsList) => {
+    let inputPath = null;
+    let json = false;
+    for (const argument of argumentsList) {
+        if (argument === "--json") {
+            json = true;
+            continue;
+        }
+        if (argument.startsWith("--input=")) {
+            if (inputPath !== null) {
+                throw new Error("prompt_refiner_report_duplicate_input");
+            }
+            inputPath = argument.slice("--input=".length);
+            continue;
+        }
+        throw new Error("prompt_refiner_report_unknown_argument");
+    }
+    if (!inputPath) throw new Error("prompt_refiner_report_input_required");
+    return { inputPath, json };
+};
+
+const percent = (value) =>
+    value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
+const latency = (value) => (value === null ? "n/a" : `${value}ms`);
+const telemetryRows = [
+    ["actual cost", "actualCostMicroUsd", "microUSD"],
+    ["input tokens", "inputTokens", "tokens"],
+    ["cached input tokens", "cachedInputTokens", "tokens"],
+    ["output tokens", "outputTokens", "tokens"],
+    ["reasoning tokens", "reasoningTokens", "tokens"],
+];
+
+const printHumanReport = (summary) => {
+    console.log("Prompt Refiner receipt report");
+    console.log(`requests                     ${summary.requests}`);
+    console.log(
+        `suggested / failed / refused ${summary.outcomes.suggested} / ${summary.outcomes.failed} / ${summary.outcomes.refusedBeforeDispatch}`
+    );
+    console.log(
+        `suggestion yield              ${percent(summary.suggestionYieldRate)} (${summary.outcomes.suggested}/${summary.requests})`
+    );
+    console.log(
+        `dispatched failure            ${percent(summary.dispatchedFailureRate)} (${summary.dispatchedFailures}/${summary.dispatched})`
+    );
+    console.log(
+        `preparation p50 / p95         ${latency(summary.suggestionPreparationLatencyMs.p50)} / ${latency(summary.suggestionPreparationLatencyMs.p95)} (n=${summary.suggestionPreparationLatencyMs.count})`
+    );
+    console.log(
+        `stale per request             ${percent(summary.dispositions.staleRequestRate)} (${summary.dispositions.stale}/${summary.requests})`
+    );
+    console.log(
+        `explicit choice per suggestion ${percent(summary.dispositions.explicitChoiceRatePerSuggestion)} (${summary.dispositions.explicitChoices}/${summary.outcomes.suggested})`
+    );
+    console.log(
+        `accepted per explicit choice  ${percent(summary.dispositions.acceptanceRatePerChoice)} (${summary.dispositions.accepted}/${summary.dispositions.explicitChoices})`
+    );
+    console.log("telemetry coverage");
+    for (const [label, field, unit] of telemetryRows) {
+        const coverage = summary.telemetry[field];
+        console.log(
+            `  ${label}: population=${coverage.population}, reported=${coverage.reported}, missing=${coverage.missing}, total=${coverage.total} ${unit}`
+        );
+    }
+    console.log(`unattributed requests        ${summary.unattributedRequests}`);
+    if (summary.byProviderModel.length > 0) {
+        console.log("provider/model breakdown");
+        for (const row of summary.byProviderModel) {
+            console.log(
+                `  ${row.provider}/${row.modelId}: requests=${row.requests}, suggested=${row.suggested}, failed=${row.failed}, refused=${row.refusedBeforeDispatch}`
+            );
+        }
+    }
+    console.log(
+        "Descriptive telemetry only: this report does not judge quality, release readiness, or rollout approval."
+    );
+};
+
+try {
+    const options = parseArguments(process.argv.slice(2));
+    const metadata = await stat(options.inputPath);
+    if (!metadata.isFile() || metadata.size > MAX_INPUT_BYTES) {
+        throw new Error("prompt_refiner_report_input_too_large_or_not_a_file");
+    }
+    const bytes = await readFile(options.inputPath);
+    let input;
+    try {
+        input = JSON.parse(bytes.toString("utf8"));
+    } catch {
+        throw new Error("prompt_refiner_report_invalid_json");
+    }
+    let summary;
+    try {
+        summary = summarizePromptRefinerReceipts(input);
+    } catch {
+        // Schema diagnostics can contain received values. The report must not
+        // echo malformed input because a forbidden prompt field is exactly the
+        // kind of malformed receipt this boundary is designed to reject.
+        throw new Error("prompt_refiner_report_schema_invalid");
+    }
+    if (options.json) console.log(JSON.stringify(summary, null, 2));
+    else printHumanReport(summary);
+} catch (error) {
+    const message = error instanceof Error ? error.message : "unknown_error";
+    console.error(`Prompt Refiner receipt report failed: ${message}`);
+    process.exitCode = 1;
+}
diff --git a/tests/promptRefinerReceiptCore.test.mjs b/tests/promptRefinerReceiptCore.test.mjs
new file mode 100644
index 00000000..72f4a9c7
--- /dev/null
+++ b/tests/promptRefinerReceiptCore.test.mjs
@@ -0,0 +1,510 @@
+import assert from "node:assert/strict";
+import { mkdtemp, rm, writeFile } from "node:fs/promises";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { spawnSync } from "node:child_process";
+import test from "node:test";
+
+import {
+    PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION,
+    PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
+    PROMPT_REFINER_RECEIPT_BUNDLE_VERSION,
+    promptRefinerDispositionReceiptSchema,
+    promptRefinerExecutionReceiptSchema,
+    promptRefinerReceiptBundleSchema,
+    summarizePromptRefinerReceipts,
+} from "../lib/promptRefinerReceiptCore.ts";
+
+const execution = (overrides = {}) => ({
+    receiptVersion: PROMPT_REFINER_EXECUTION_RECEIPT_VERSION,
+    receiptId: "exec_1",
+    requestId: "request_1",
+    suggestionId: "suggestion_1",
+    refinerVersion: "suggest-v1",
+    provider: "example",
+    modelId: "example/refiner-1",
+    adapterVersion: "adapter-v1",
+    outcome: "suggested",
+    failureLayer: "none",
+    failureCode: null,
+    requestedAt: "2026-09-15T00:00:00.000Z",
+    dispatchedAt: "2026-09-15T00:00:00.100Z",
+    completedAt: "2026-09-15T00:00:01.000Z",
+    preparationLatencyMs: 1_000,
+    inputTokens: 100,
+    cachedInputTokens: 20,
+    outputTokens: 30,
+    reasoningTokens: null,
+    actualCostMicroUsd: 1_000,
+    retryCount: 0,
+    ...overrides,
+});
+
+const disposition = (overrides = {}) => ({
+    receiptVersion: PROMPT_REFINER_DISPOSITION_RECEIPT_VERSION,
+    dispositionId: "decision_1",
+    executionReceiptId: "exec_1",
+    requestId: "request_1",
+    suggestionId: "suggestion_1",
+    outcome: "accepted",
+    staleReason: null,
+    observedAt: "2026-09-15T00:00:02.000Z",
+    ...overrides,
+});
+
+const bundle = (executions = [execution()], dispositions = [disposition()]) => ({
+    bundleVersion: PROMPT_REFINER_RECEIPT_BUNDLE_VERSION,
+    executions,
+    dispositions,
+});
+
+test("execution receipts keep success, failure and refusal facts distinct", () => {
+    assert.equal(promptRefinerExecutionReceiptSchema.parse(execution()).outcome, "suggested");
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.parse(
+            execution({
+                receiptId: "exec_failed",
+                requestId: "request_failed",
+                suggestionId: null,
+                outcome: "failed",
+                failureLayer: "provider",
+                failureCode: "provider_error",
+            })
+        ).outcome,
+        "failed"
+    );
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.parse(
+            execution({
+                receiptId: "exec_refused",
+                requestId: "request_refused",
+                suggestionId: null,
+                provider: null,
+                modelId: null,
+                adapterVersion: null,
+                outcome: "refused_before_dispatch",
+                failureLayer: "adapter",
+                failureCode: "adapter_unavailable",
+                dispatchedAt: null,
+                completedAt: "2026-09-15T00:00:00.050Z",
+                preparationLatencyMs: 50,
+                inputTokens: null,
+                cachedInputTokens: null,
+                outputTokens: null,
+                reasoningTokens: null,
+                actualCostMicroUsd: null,
+            })
+        ).outcome,
+        "refused_before_dispatch"
+    );
+});
+
+test("execution receipts reject contradictory lifecycle and telemetry claims", () => {
+    const refusal = {
+        outcome: "refused_before_dispatch",
+        suggestionId: null,
+        provider: null,
+        modelId: null,
+        adapterVersion: null,
+        failureLayer: "adapter",
+        dispatchedAt: null,
+        inputTokens: null,
+        cachedInputTokens: null,
+        outputTokens: null,
+        reasoningTokens: null,
+        actualCostMicroUsd: null,
+    };
+    const invalid = [
+        execution({ suggestionId: null }),
+        execution({ preparationLatencyMs: 999 }),
+        execution({ completedAt: "2026-09-14T23:59:59.000Z", preparationLatencyMs: 0 }),
+        execution({
+            outcome: "failed",
+            suggestionId: null,
+            failureLayer: "admission",
+            failureCode: "cost_guardrail",
+        }),
+        execution({
+            outcome: "failed",
+            suggestionId: null,
+            provider: null,
+            modelId: null,
+            adapterVersion: null,
+            failureLayer: "adapter",
+            failureCode: "adapter_unavailable",
+            dispatchedAt: null,
+            inputTokens: null,
+            cachedInputTokens: null,
+            outputTokens: null,
+            reasoningTokens: null,
+            actualCostMicroUsd: null,
+        }),
+        execution({
+            outcome: "failed",
+            suggestionId: null,
+            failureLayer: "provider",
+            failureCode: "provider_error",
+            dispatchedAt: null,
+            inputTokens: null,
+            cachedInputTokens: null,
+            outputTokens: null,
+            reasoningTokens: null,
+            actualCostMicroUsd: null,
+        }),
+        execution({
+            ...refusal,
+            failureCode: "adapter_unavailable",
+            inputTokens: 1,
+        }),
+        execution({
+            provider: "example",
+            modelId: null,
+            adapterVersion: null,
+            outcome: "refused_before_dispatch",
+            suggestionId: null,
+            failureLayer: "adapter",
+            failureCode: "adapter_unavailable",
+            dispatchedAt: null,
+            inputTokens: null,
+            cachedInputTokens: null,
+            outputTokens: null,
+            reasoningTokens: null,
+            actualCostMicroUsd: null,
+        }),
+        ...[
+            "provider_error",
+            "timeout",
+            "invalid_response",
+            "empty_response",
+            "no_change",
+            "unknown_after_dispatch",
+        ].map((failureCode) => execution({ ...refusal, failureCode })),
+        ...["adapter_unavailable", "cost_guardrail"].map((failureCode) =>
+            execution({
+                outcome: "failed",
+                suggestionId: null,
+                failureLayer: "adapter",
+                failureCode,
+            })
+        ),
+    ];
+    for (const receipt of invalid) {
+        assert.equal(promptRefinerExecutionReceiptSchema.safeParse(receipt).success, false);
+    }
+});
+
+test("receipt schemas have no prompt, identity or provider-error prose channel", () => {
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.safeParse({
+            ...execution(),
+            prompt: "private user text",
+        }).success,
+        false
+    );
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.safeParse({
+            ...execution(),
+            userId: "user_1",
+        }).success,
+        false
+    );
+    assert.equal(
+        promptRefinerExecutionReceiptSchema.safeParse({
+            ...execution({
+                outcome: "failed",
+                suggestionId: null,
+                failureLayer: "provider",
+                failureCode: "Provider said the prompt was invalid",
+            }),
+        }).success,
+        false
+    );
+});
+
+test("disposition receipts encode explicit choice or a stage-bound stale reason", () => {
+    assert.equal(promptRefinerDispositionReceiptSchema.parse(disposition()).outcome, "accepted");
+    assert.equal(
+        promptRefinerDispositionReceiptSchema.parse(
+            disposition({
+                outcome: "stale",
+                suggestionId: null,
+                staleReason: "draft_changed_while_requesting",
+                observedAt: "2026-09-15T00:00:00.500Z",
+            })
+        ).outcome,
+        "stale"
+    );
+    assert.equal(
+        promptRefinerDispositionReceiptSchema.parse(
+            disposition({
+                outcome: "stale",
+                staleReason: "draft_changed_after_ready",
+            })
+        ).outcome,
+        "stale"
+    );
+});
+
+test("disposition receipts reject missing choices and contradictory stale stages", () => {
+    const invalid = [
+        disposition({ suggestionId: null }),
+        disposition({ staleReason: "draft_changed_after_ready" }),
+        disposition({ outcome: "stale", staleReason: null }),
+        disposition({
+            outcome: "stale",
+            suggestionId: null,
+            staleReason: "draft_changed_after_ready",
+        }),
+        disposition({
+            outcome: "stale",
+            staleReason: "draft_changed_while_requesting",
+        }),
+    ];
+    for (const receipt of invalid) {
+        assert.equal(promptRefinerDispositionReceiptSchema.safeParse(receipt).success, false);
+    }
+});
+
+test("bundle parsing refuses duplicate, orphan and mismatched receipts", () => {
+    const secondExecution = execution({
+        receiptId: "exec_2",
+        requestId: "request_2",
+        suggestionId: "suggestion_2",
+    });
+    const invalid = [
+        bundle([execution(), execution()]),
+        bundle([execution(), secondExecution], [
+            disposition(),
+            disposition({ dispositionId: "decision_2" }),
+        ]),
+        bundle([execution()], [
+            disposition({ executionReceiptId: "missing_execution" }),
+        ]),
+        bundle([execution()], [disposition({ requestId: "request_other" })]),
+        bundle([execution()], [
+            disposition({ suggestionId: "suggestion_other" }),
+        ]),
+        bundle([execution()], [
+            disposition({ observedAt: "2026-09-14T23:59:59.000Z" }),
+        ]),
+    ];
+    for (const value of invalid) {
+        assert.equal(promptRefinerReceiptBundleSchema.safeParse(value).success, false);
+    }
+});
+
+test("a stale observation made while requesting can outlive any execution outcome", () => {
+    const failed = execution({
+        suggestionId: null,
+        outcome: "failed",
+        failureLayer: "provider",
+        failureCode: "provider_error",
+    });
+    const stale = disposition({
+        suggestionId: null,
+        outcome: "stale",
+        staleReason: "scope_changed_while_requesting",
+        observedAt: "2026-09-15T00:00:00.500Z",
+    });
+    assert.equal(promptRefinerReceiptBundleSchema.parse(bundle([failed], [stale])).dispositions.length, 1);
+});
+
+test("summary exposes every denominator and preserves unknown telemetry", () => {
+    const executions = [
+        execution({
+            receiptId: "exec_1",
+            requestId: "request_1",
+            suggestionId: "suggestion_1",
+            preparationLatencyMs: 100,
+            completedAt: "2026-09-15T00:00:00.100Z",
+            dispatchedAt: "2026-09-15T00:00:00.010Z",
+            actualCostMicroUsd: 1_000,
+        }),
+        execution({
+            receiptId: "exec_2",
+            requestId: "request_2",
+            suggestionId: "suggestion_2",
+            preparationLatencyMs: 400,
+            completedAt: "2026-09-15T00:00:00.400Z",
+            dispatchedAt: "2026-09-15T00:00:00.020Z",
+            actualCostMicroUsd: null,
+        }),
+        execution({
+            receiptId: "exec_3",
+            requestId: "request_3",
+            suggestionId: null,
+            outcome: "failed",
+            failureLayer: "provider",
+            failureCode: "provider_error",
+            preparationLatencyMs: 300,
+            completedAt: "2026-09-15T00:00:00.300Z",
+            dispatchedAt: "2026-09-15T00:00:00.030Z",
+            actualCostMicroUsd: 400,
+        }),
+        execution({
+            receiptId: "exec_4",
+            requestId: "request_4",
+            suggestionId: null,
+            provider: null,
+            modelId: null,
+            adapterVersion: null,
+            outcome: "refused_before_dispatch",
+            failureLayer: "adapter",
+            failureCode: "adapter_unavailable",
+            dispatchedAt: null,
+            completedAt: "2026-09-15T00:00:00.050Z",
+            preparationLatencyMs: 50,
+            inputTokens: null,
+            cachedInputTokens: null,
+            outputTokens: null,
+            reasoningTokens: null,
+            actualCostMicroUsd: null,
+        }),
+    ];
+    const dispositions = [
+        disposition(),
+        disposition({
+            dispositionId: "decision_2",
+            executionReceiptId: "exec_2",
+            requestId: "request_2",
+            suggestionId: "suggestion_2",
+            outcome: "stale",
+            staleReason: "draft_changed_after_ready",
+            observedAt: "2026-09-15T00:00:01.000Z",
+        }),
+    ];
+    const summary = summarizePromptRefinerReceipts(bundle(executions, dispositions));
+
+    assert.equal(summary.requests, 4);
+    assert.deepEqual(summary.outcomes, {
+        suggested: 2,
+        failed: 1,
+        refusedBeforeDispatch: 1,
+    });
+    assert.equal(summary.dispatched, 3);
+    assert.equal(summary.dispatchedFailures, 1);
+    assert.equal(summary.dispatchedFailureRate, 1 / 3);
+    assert.equal(summary.suggestionYieldRate, 1 / 2);
+    assert.deepEqual(summary.suggestionPreparationLatencyMs, {
+        count: 2,
+        p50: 100,
+        p95: 400,
+    });
+    assert.equal(summary.dispositions.staleRequestRate, 1 / 4);
+    assert.equal(summary.dispositions.explicitChoiceRatePerSuggestion, 1 / 2);
+    assert.equal(summary.dispositions.acceptanceRatePerChoice, 1);
+    assert.deepEqual(summary.telemetry.actualCostMicroUsd, {
+        population: 3,
+        reported: 2,
+        missing: 1,
+        total: 1_400,
+    });
+    assert.equal(summary.unattributedRequests, 1);
+    assert.equal(summary.byProviderModel[0].requests, 3);
+});
+
+test("empty input reports null rates and percentiles instead of invented zeroes", () => {
+    const summary = summarizePromptRefinerReceipts(bundle([], []));
+    assert.equal(summary.requests, 0);
+    assert.equal(summary.suggestionYieldRate, null);
+    assert.equal(summary.dispatchedFailureRate, null);
+    assert.equal(summary.suggestionPreparationLatencyMs.p50, null);
+    assert.equal(summary.dispositions.staleRequestRate, null);
+    assert.equal(summary.dispositions.acceptanceRatePerChoice, null);
+});
+
+test("the CLI emits aggregate-only JSON and a non-approval disclaimer", async () => {
+    const directory = await mkdtemp(join(tmpdir(), "prompt-refiner-receipts-"));
+    const inputPath = join(directory, "receipts.json");
+    try {
+        const value = bundle(
+            [
+                execution({
+                    receiptId: "sensitive_receipt_id",
+                    requestId: "sensitive_request_id",
+                    suggestionId: "sensitive_suggestion_id",
+                }),
+            ],
+            [
+                disposition({
+                    executionReceiptId: "sensitive_receipt_id",
+                    requestId: "sensitive_request_id",
+                    suggestionId: "sensitive_suggestion_id",
+                }),
+            ]
+        );
+        await writeFile(inputPath, JSON.stringify(value), "utf8");
+
+        const jsonRun = spawnSync(
+            process.execPath,
+            [
+                "--import",
+                "tsx",
+                "scripts/report-prompt-refiner-receipts.mjs",
+                `--input=${inputPath}`,
+                "--json",
+            ],
+            { cwd: process.cwd(), encoding: "utf8" }
+        );
+        assert.equal(jsonRun.status, 0, jsonRun.stderr);
+        const output = JSON.parse(jsonRun.stdout);
+        assert.equal(output.requests, 1);
+        for (const secret of [
+            "sensitive_receipt_id",
+            "sensitive_request_id",
+            "sensitive_suggestion_id",
+        ]) {
+            assert.equal(jsonRun.stdout.includes(secret), false);
+        }
+
+        const humanRun = spawnSync(
+            process.execPath,
+            [
+                "--import",
+                "tsx",
+                "scripts/report-prompt-refiner-receipts.mjs",
+                `--input=${inputPath}`,
+            ],
+            { cwd: process.cwd(), encoding: "utf8" }
+        );
+        assert.equal(humanRun.status, 0, humanRun.stderr);
+        assert.match(humanRun.stdout, /does not judge quality, release readiness, or rollout approval/);
+        for (const label of [
+            "actual cost",
+            "input tokens",
+            "cached input tokens",
+            "output tokens",
+            "reasoning tokens",
+        ]) {
+            assert.match(
+                humanRun.stdout,
+                new RegExp(`${label}: population=1, reported=[01], missing=[01], total=`)
+            );
+        }
+
+        const forbiddenText = "never-echo-this-private-prompt";
+        await writeFile(
+            inputPath,
+            JSON.stringify({
+                ...value,
+                executions: [{ ...value.executions[0], prompt: forbiddenText }],
+            }),
+            "utf8"
+        );
+        const invalidRun = spawnSync(
+            process.execPath,
+            [
+                "--import",
+                "tsx",
+                "scripts/report-prompt-refiner-receipts.mjs",
+                `--input=${inputPath}`,
+            ],
+            { cwd: process.cwd(), encoding: "utf8" }
+        );
+        assert.notEqual(invalidRun.status, 0);
+        assert.match(invalidRun.stderr, /prompt_refiner_report_schema_invalid/);
+        assert.equal(invalidRun.stderr.includes(forbiddenText), false);
+    } finally {
+        await rm(directory, { recursive: true, force: true });
+    }
+});

```

## Test results (run by the control program)

- PASS `node --import tsx --test tests/promptRefinerReceiptCore.test.mjs` (1214ms)
  # fail 0
  # cancelled 0
  # skipped 0
  # todo 0
  # duration_ms 1136.9762

## Guard results (run by the control program)

- PASS `npm run typecheck` (43615ms)
  > ai-chat-hub@0.1.0 typecheck
  > next typegen && tsc --noEmit --incremental false
  
  Generating route types...
  ✓ Types generated successfully
- PASS `npm run lint` (64406ms)
  > ai-chat-hub@0.1.0 lint
  > eslint
- PASS `npm run check:doc-references` (1684ms)
  > ai-chat-hub@0.1.0 check:doc-references
  > node scripts/check-doc-references.mjs
  
  Document reference check passed: 833 referenced path(s) across 107 instruction document(s), and 942 path(s) named by comments across 2854 source file(s), all present.
- PASS `npm run check:policy-section-references` (1203ms)
  > ai-chat-hub@0.1.0 check:policy-section-references
  > node scripts/check-policy-section-references.mjs
  
  Policy section reference check passed: 4338 citation(s) against 34 policy document(s). 2698 resolve to a named document and none point at a section that does not exist. No added line introduces an unscoped or ambiguous one (1417 and 223 predate this change).
- PASS `npm run check:encoding:strict` (1494ms)
  > ai-chat-hub@0.1.0 check:encoding:strict
  > node scripts/check-text-encoding.mjs --strict
  
  Text encoding check passed. No mojibake markers found.
- PASS `git diff --check` (57ms)

## Findings from the previous round (check each was addressed)

- [warning/evidence] lib/promptRefinerReceiptCore.ts:182-217 (superRefine) and :560-565 (failureCodes aggregate): `failureCode` is validated only as a closed enum and is never constrained by `outcome`/`dispatchedAt`, so a `refused_before_dispatch` receipt that by contract never reached the provider may still be classified `provider_error`, `timeout` or `unknown_after_dispatch`, and the report then prints those codes next to `dispatched: 0` — the same writer's-free-choice ambiguity between pre- and post-dispatch facts that the two round-0 lifecycle findings closed for `failureLayer`.

## Author's account (read last; a claim, not a finding)

Summary: (no summary supplied; the diff is the record)

## Answer format

Reply with exactly one JSON document and nothing else:

```json
{
  "taskId": "prompt-refiner-receipt-metrics-v1",
  "round": 2,
  "reviewedDigest": "sha256:ef3a83844798555e9324e50dd5e522d0d6640805ee324ed92b7cea8ebc755b16",
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
