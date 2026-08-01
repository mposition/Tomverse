# 크레딧과 내부 비용 한도

Production Pro 계정(플랜 크레딧 2,932 잔여)이 Gemini 3.1 Pro · Claude Opus 4.8 ·
GPT-5.5 Thinking + Web Search 요청에서 `INTERNAL_DAILY_COST_SAFETY_LIMIT`으로
차단된 사건의 후속 조치 문서입니다. 이 문서는 승인된 정책과 코드 구조를
기록합니다. 관련 파일을 바꾸기 전에 읽어 주세요.

- `lib/modelPricing.ts`
- `lib/chatCostGuardrails.ts`
- `lib/chatCostSafetyCore.ts`
- `lib/chatAvailabilityCore.ts`
- `lib/chatLimitDecisionCore.ts` / `lib/chatLimitDecisions.ts`
- `lib/chatSecurity.ts`의 예약·정산 경로

## 1. 사고 원인

두 가지 결함이 겹쳤습니다.

1. **가격이 모델별로 없었다.** `lib/models.ts`는 `standard | advanced | premium`
   세 등급의 기본값만 갖고 있었고, GPT-5.5, GPT-5.5 Thinking, Gemini 3.1 Pro,
   Claude Opus 4.8이 모두 premium 공통값 US$15 입력 / US$60 출력(MTok)으로
   계산됐습니다. 실제 표준 API 가격의 3~7.5배입니다.
2. **숨은 사용자 USD 한도가 entitlement 역할을 했다.**
   `CHAT_PRO_COST_MICROUSD_PER_DAY` 기본값 1,500,000(US$1.50/일)이 크레딧과
   별개로 일반 사용을 차단했습니다. 사용자에게는 표시되지 않았고, 잘못된
   가격 때문에 훨씬 빨리 소진됐습니다.

## 2. 두 층으로 분리

| 층 | 무엇 | 어디 | 오류 코드 |
|---|---|---|---|
| User entitlement | 플랜 크레딧 + 구매 크레딧 | `lib/chatCreditAllocation.ts`, credit ledger | `PLAN_ENTITLEMENT_EXHAUSTED`, `CREDIT_BALANCE_INSUFFICIENT`, `CREDIT_COST_ALLOWANCE_INSUFFICIENT`, `PLAN_DAILY_CREDIT_LIMIT_REACHED` |
| Operational guardrail | 비정상 사용·비용 폭증·가격 오설정·provider 사고 | `lib/chatCostGuardrails.ts` | `OPERATIONAL_COST_GUARDRAIL_TRIGGERED`, `PROVIDER_BUDGET_EXHAUSTED` |

동시 요청 경쟁은 어느 쪽도 아니며 `CONCURRENT_RESERVATION_CONFLICT`(409)로
재시도를 요청합니다.

### guardrail은 entitlement에서 유도한다

한도를 손으로 고르면 같은 사고가 반복됩니다. 그래서 guardrail은 플랜이
부여하는 크레딧에서 계산합니다.

```
guardrail = 크레딧 수 × COST_PER_CREDIT_CEILING_MICRO_USD × GUARDRAIL_HEADROOM_MULTIPLIER
```

`COST_PER_CREDIT_CEILING_MICRO_USD`(40,000)은 "크레딧 1개가 정당하게 쓸 수 있는
최대 비용"의 상한입니다. 유도 근거는 `lib/chatCostGuardrails.ts` 주석에
적혀 있습니다(premium 8 크레딧 × 입력 배수 3 = 24 크레딧, 최대 입력
128,000 토큰, 가장 비싼 premium 모델 기준).

결과(기본 플랜 설정 기준):

| 플랜 | 일일 plan guardrail | 월간 plan guardrail |
|---|---|---|
| Free (30/300 크레딧) | US$1.50 | US$15.00 |
| Pro (300/3,000 크레딧) | US$15.00 | US$150.00 |
| Max (일일 무제한 / 10,000 크레딧) | 월간과 동일 | US$500.00 |

`totalDay`/`totalMonth`는 구매 크레딧 여유분(`PURCHASED_CREDIT_HEADROOM_MULTIPLE`
= 5배)까지 포함한 전체 비용 guardrail입니다.

### 환경변수 override는 유도값 아래로 내려갈 수 없다

`CHAT_COST_GUARDRAIL_{PLAN}_{PLAN|TOTAL}_MICROUSD_PER_{DAY|MONTH}`로 올릴 수는
있지만, 유도값보다 낮은 값은 **자동으로 유도값까지 올려서** 적용하고
`clampedOverrides`에 기록합니다. 설정만으로 이 사고를 재현할 수 없게 만드는
장치입니다.

기존 `CHAT_{FREE|PRO|MAX}_COST_MICROUSD_PER_{DAY|MONTH}`는 **더 이상 읽지
않습니다.** 값이 남아 있으면 startup에서
`retired_cost_limit_env_ignored` 경고를 남깁니다.

### 버킷 구분

| period | 무엇을 센다 | 한도 |
|---|---|---|
| `cost-day` / `cost-month` | 플랜 크레딧으로 지불된 비용만 | `guardrails.planDay/planMonth` |
| `op-cost-day` / `op-cost-month` | 플랜 + 구매 크레딧 전체 비용 | `guardrails.totalDay/totalMonth` |
| `provider-cost-day` / `provider-cost-month` | provider 전체 지출 | `CHAT_PROVIDER_*` |

구매 크레딧으로 충당되는 비용은 `cost-*`에 들어가지 않습니다. 구매 크레딧은
credit lot의 `remainingFundedCostMicroUsd`가 이미 제한하고 있어서, 플랜 모양의
한도로 두 번 막는 것은 정책 7 위반입니다. 전역 guardrail(`op-cost-*`)과
provider guardrail은 그대로 적용됩니다.

## 3. 가격 registry

`lib/modelPricing.ts`가 유일한 가격 출처입니다. 항목마다 다음을 기록합니다.

- provider, API model ID
- routing(`direct_provider_api`)과 processing tier(`standard`)
- 가격 tier 배열(long-context 임계값 포함)
- reasoning token 과금 방식
- native web-search 단가
- `maxOutputTokens` / `reservationOutputTokens` / 산정 근거
- `priceSource`, `pricingVersion`, `effectiveDate`
- `cachedInputPricingVerified`

### 실제 요청 경로 확인

`lib/activeAiModel.ts`와 `lib/modelRegistryShared.ts` 기준으로 모든 provider는
자사 1st-party endpoint로 직접 호출합니다. OpenRouter 등 중계 경로, priority /
flex service tier, regional·data-residency endpoint를 쓰지 않습니다. 따라서
표준 API 가격이 그대로 적용됩니다. 경로가 바뀌면 registry 항목을 함께
바꿔야 합니다.

### 현재 명시된 가격

| 모델 | 입력 | 출력 | 비고 |
|---|---|---|---|
| GPT-5.5 / GPT-5.5 Thinking | US$5 | US$30 | 동일 upstream(`gpt-5.5`), reasoning token은 출력에 포함 |
| Gemini 3.1 Pro Preview | US$2 (≤200K) / US$4 (>200K) | US$12 / US$18 | prompt 크기로 tier 선택 |
| Claude Opus 4.8 | US$5 | US$25 | |

cached input 할인은 이 네 모델에 대해 검증된 출처가 없어서 배수 1(할인 없음)로
둡니다. 보수적인 쪽이며 기존 동작과 동일합니다. 검증되면
`cachedInputPricingVerified`와 함께 갱신합니다.

### 알 수 없는 모델과 CI

명시적 profile이 없는 모델은 보수적인 등급 fallback을 씁니다.
`npm run check:model-pricing`이 **enabled premium 모델에 profile이 없으면
실패**하고, PR Fast Gate의 static 단계에서 실행됩니다. 아직 검증된 가격이 없는
기존 premium 모델은 `PENDING_VERIFIED_PRICE_MODEL_IDS`에 명시적으로 적어
두었고, 이 목록에 없는 새 premium 모델은 CI에서 막힙니다. 목록이 낡으면
(이미 가격이 붙었는데 남아 있으면) 역시 실패합니다.

### 소급 적용 금지

가격표를 바꿔도 기존 `ChatUsageBucket`은 다시 계산하지 않습니다. 예약 시점의
`pricingVersion`·`costSource`·`longContextThresholdTokens`가 reservation payload와
`pricingSnapshot`에 저장되고, 정산은 그 값으로 이뤄집니다.

## 4. 예약 정확도

- 입력 토큰 추정은 `lib/chatTokenEstimate.ts` 하나로 통일했습니다. CJK 문자는
  1.5토큰/자, 나머지는 4바이트/토큰입니다. 이전에는 표면마다 복사본이 있었고
  한국어 대화를 크게 과소 추정했습니다.
- native web search가 켜지면 검색 결과가 프롬프트로 되돌아오므로 입력에
  `WEB_SEARCH_INPUT_TOKEN_OVERHEAD`(6,000) + tool 정의(400)를 더해 예약합니다.
  **크레딧에는 반영하지 않습니다** — 사용자 과금은 대화 길이 기준입니다.
- 출력 예약은 모델별 p90입니다. premium 4,096, reasoning 모델 6,144
  (`maxOutputTokens` 8,192 유지).
- 정산은 provider usage metadata를 우선 사용하고, 없을 때만 fallback
  estimator를 씁니다. 어느 쪽을 썼는지 `pricingSnapshot.usageSource`에
  남습니다. reasoning token은 `outputTokens`에 이미 포함되므로 별도 과금하지
  않고 관측용으로만 기록합니다.

## 5. 시간대와 reset

일일 window는 사용자 IANA timezone 기준(`lib/userTimeZone.ts`)입니다. 모든
오류 응답의 `resetAt`은 생성 시점보다 미래임이 보장됩니다.

- `futureResetAt()`은 과거·현재 시각을 `null`로 버립니다.
- `safeDailyResetAt()`은 timezone 변경이나 DST 경계로 window 끝이 과거가 된
  경우 하루 단위로 앞으로 굴려 미래 시각을 만듭니다.

## 6. 관측 가능성

`ChatLimitDecisionEvent`는 차단(그리고 `CHAT_LIMIT_DECISION_LOG_ALLOWED=1`이면
허용까지)을 Trace ID로 남깁니다. 프롬프트 본문과 메시지 내용은 저장하지
않으며, 주체는 rate limiter가 쓰는 해시된 usage subject key입니다.

조회:

- `GET /api/admin/limit-decisions?traceId=...`
- Admin 전역 검색에서 Trace ID로도 나옵니다.

사용자에게 가는 응답에서는 `internal`로 시작하는 진단 필드를
`publicChatErrorDetails()`가 제거합니다. 원시 내부 USD는 로그·이벤트·Admin
Console에만 남습니다.

보존 기간은 90일이며 `cleanupExpiredData()`가 정리합니다.

## 7. 요청 전 확인

`POST /api/chat/availability`가 현재 모델 선택·Web Search 상태·초안 기준으로
실행 가능 여부를 알려 줍니다. 아무것도 기록하지 않습니다. 판정 로직은
`lib/chatAvailabilityCore.ts`에 있고, 예약 경로와 같은 순서로 검사합니다
(entitlement 먼저, guardrail 나중). 크레딧이 없는 사용자에게 내부 안전장치
이야기를 하지 않기 위한 순서입니다.

## 8. 바꾸기 전에

- 새 premium 모델을 enable하기 전에 `MODEL_PRICING`에 항목을 추가합니다.
- guardrail 기본값을 낮추려면 `COST_PER_CREDIT_CEILING_MICRO_USD` 유도 근거를
  먼저 갱신합니다. 환경변수로는 내려갈 수 없습니다.
- entitlement 오류와 guardrail 오류를 하나의 코드로 합치지 않습니다.
- 사용자 응답에 원시 내부 USD를 넣지 않습니다.
- 관련 테스트: `tests/modelPricing.test.mjs`, `tests/chatCostGuardrails.test.mjs`,
  `tests/chatAvailabilityCore.test.mjs`, `tests/chatLimitDecisionCore.test.mjs`,
  `tests/chatTokenEstimate.test.mjs`, `tests/chatCostSafetyCore.test.mjs`,
  `tests/integration/credit-finance.db.test.ts`,
  `tests/e2e/credit-entitlement-disclosure.spec.ts`.
