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

### 저장 자료형 계약: `ChatUsageBucket.count`는 BIGINT를 유지한다

guardrail 산식의 결과는 **DB에 저장되고 SQL로 비교되는 값**입니다. 산식만
맞고 저장 자료형이 좁으면, 한도가 느슨해지는 게 아니라 쿼리 자체가 실패합니다.
실제로 그렇게 됐습니다.

```
Max totalMonth = 10,000 × 40,000 × 1.25 × 5 = 2,500,000,000 micro-USD
int4 상한                                    = 2,147,483,647
```

`acquireChatAccess`가 이 한도를 guardrail UPSERT의
`WHERE "count" <= $limit - $amount`에 바인딩하므로, int4에서는 PostgreSQL이
allow/deny를 돌려주는 대신 `22003 (value out of range for type integer)`을
던졌습니다. 즉 요청이 깔끔하게 거절되는 게 아니라 **실패**했고, 경계인
**약 8,590 월간 크레딧**을 넘는 모든 플랜이 해당됐습니다. 기본 설정에서는
Max 전체입니다(Pro는 3,000이라 아래에 머뭅니다).

계약:

1. **`ChatUsageBucket.count`는 PostgreSQL `BIGINT` / Prisma `BigInt`를
   유지합니다.** 저장되는 카운터 자체가 한도값까지 도달해야 하므로, 한도를
   int4 아래로 되돌려 맞추는 것은 해결이 아니라 이 문서가 막으려는 "크레딧이
   살 수 있는 것보다 낮은 숨은 한도"를 다시 만드는 일입니다.
2. **`Int` / `INTEGER`로 되돌리는 마이그레이션을 금지합니다.** 좁히려면 먼저
   위 산식과 모든 플랜의 최대 저장값을 다시 계산해 근거를 이 문서에 남깁니다.
3. **guardrail 상수, 플랜 크레딧, headroom 배수를 바꿀 때마다 최대 저장값을
   재계산합니다.** `COST_PER_CREDIT_CEILING_MICRO_USD`,
   `GUARDRAIL_HEADROOM_MULTIPLIER`, `PURCHASED_CREDIT_HEADROOM_MULTIPLE`,
   그리고 플랜의 `monthlyMessageLimit`가 모두 이 곱에 들어갑니다.
4. **읽기 경계에서 `usageBucketCount()`를 씁니다.** `bigint`를 `number`로
   좁히고 `Number.isSafeInteger()`로 검증합니다. 안전 정수를 벗어나면 조용히
   반올림하지 않고 실패합니다.
5. **`bigint`를 API JSON으로 그대로 넘기지 않습니다.**
   `NextResponse.json()`에 `bigint`가 도달하면
   `Do not know how to serialize a BigInt`로 던집니다.

관련 파일:

- `prisma/migrations/20260801130000_widen_chat_usage_bucket_count/migration.sql`
- `lib/chatUsageBucketCount.ts`
- `tests/usageBucketRange.test.mjs` (schema 자료형 + 플랜별 최대 저장값)
- `tests/integration/credit-finance.db.test.ts`
  ("a cost bucket's running total crosses int4's ceiling",
  "the largest derived guardrail survives a database round trip")

자동 검사: `npm run check:usage-bucket-range`가 PR Fast Gate에서 schema 자료형,
되돌리는 마이그레이션, 모든 기본 플랜의 최대 guardrail이 DB·JavaScript 안전
범위 안에 있는지를 fail-closed로 확인합니다.

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

### Provider 예산 계약

`lib/providerCostBudget.ts`. provider 예산은 필요한 운영 장치입니다 — 가격
오설정·재시도 폭주·남용 계정으로 비용이 폭주하면 청구서가 아니라 시스템이
먼저 멈춰야 합니다. 다만 이건 **전역 상한**이라 최악의 방향으로 실패합니다.
잘못된 기본값 하나가 크레딧을 가진 모든 사용자를 한꺼번에 거절하고,
`PROVIDER_BUDGET_EXHAUSTED`(503)는 크레딧에 대해 아무 말도 하지 않습니다.

원래 provider마다 **일 US$10 / 월 US$100**이 조용한 기본값이었습니다. Pro 계정
한 명의 plan guardrail(일 US$15 / 월 US$150)보다 낮고, Max 한 명(US$500)보다는
한참 낮습니다. **전체 사용자를 위한 전역 상한이 한 사용자의 entitlement보다
좁았다**는 뜻입니다. 보고된 사고의 원인은 아니었고 이번 변경의 회귀도
아니었습니다 — 같은 결함이 한 층 아래에서 기다리고 있었을 뿐입니다.

계약은 넷입니다.

1. **production은 예산을 명시한다.** production 기본값은 없습니다. 활성
   provider에 예산이 없으면 조용히 아무도 고르지 않은 숫자를 물려받는 대신
   readiness가 실패합니다(`GET /api/ready`의 `providerBudgets`).
2. **바닥 아래 값은 올려서 강제하고 보고한다.** 바닥은 단일 계정의 최대 plan
   guardrail(`getSingleAccountCostCeiling()`)입니다. 한 계정의 entitlement보다
   좁은 전역 상한은 그 계정이 권리를 다 쓰기 전에 발동하므로, 운영 장치의
   이름을 쓴 entitlement 한도가 됩니다. 이 저장소가 릴리스 하나를 들여 분리한
   바로 그 혼동입니다. 오늘 값은 **일 US$500 / 월 US$500**(Max 10,000크레딧,
   일일 무제한이라 day = month)입니다.
3. **값은 신뢰하지 않고 검증한다.** 양의 안전 정수, day ≤ month, 그리고
   micro-USD 단위 — `500`은 US$500이 아니라 0.05센트이므로 오타로 보고
   차단합니다(`PROVIDER_BUDGET_UNIT_SUSPICION_MICRO_USD`).
4. **막기 전에 알린다.** 사용률 **70% / 85% / 95%**에서
   `provider_budget_utilisation` 구조화 로그가 남고, 85% 이상은
   `reportOperationalIncident`로 알림이 갑니다(70%는 로그만 — 아직 아무도 근처에
   가지 않은 한도의 첫 임계에서 호출하면 정작 중요한 알림을 무시하게 됩니다).
   판정은 **이미 쓴 양 + 지금 요청분**으로 합니다. 지나간 것만 보는 보고는 항상
   늦게 도착합니다.

차단될 때는 같은 provider 전체가 아니라 **다른 provider의 대체 모델**을
`alternativeModelIds`로 함께 돌려줍니다(`lib/providerFallbackCandidates.ts`).
모델 ID만 담으며 가격·예산·내부 USD는 절대 넣지 않습니다.

조회: `GET /api/admin/provider-budgets` — provider별 설정값·유효값·오늘과 이번
달 사용량·잔여·사용률·reset 시각(UTC)·clamp 여부를 함께 돌려줍니다. 설정값과
유효값을 따로 보고하는 이유는 clamp가 일어났을 때 **운영자가 설정한 숫자가
실제로 적용되는 숫자가 아니라는 사실**이 보여야 하기 때문입니다.

**배포 순서는 뒤집을 수 없습니다.** 코드를 먼저 배포하면 예산이 없는
production이 readiness에서 죽습니다.

1. 활성 provider별 production·staging 예산 결정
2. 환경변수 선배포
3. production fallback 금지·검증 로직이 든 코드 배포
4. `/api/ready`와 `/api/admin/provider-budgets`로 유효값 확인

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
기존 premium 모델은 `PENDING_VERIFIED_PRICE_REGISTER`에 명시적으로 등록해
두었고, 이 목록에 없는 새 premium 모델은 CI에서 막힙니다.

### 검증 대기 가격 운영

premium fallback(US$15 입력 / US$60 출력)은 **과소 예약과 비용 폭증은
막지만 무해하지 않습니다.** 실제 가격보다 크게 잡히므로

- 예약이 과다해져 실제 가격이라면 통과했을 요청이 일찍 거절될 수 있고,
- 정산이 예약 시점 가격을 쓰는 경로에서는 내부 비용이 실제 청구액보다
  크게 기록됩니다.

그래서 fallback은 **기한이 있는 임시 상태**로만 허용합니다.
`PENDING_VERIFIED_PRICE_REGISTER`(`lib/modelPricing.ts`)의 각 항목은 다음을
가집니다.

| 항목 | 의미 |
|---|---|
| `owner` | 가격 검증 담당자. `null`이면 미지정(경고) |
| `verificationTicket` | 검증 추적 티켓. `null`이면 미발행(경고) |
| `registeredAt` | fallback 등록일(UTC, `YYYY-MM-DD`) |
| `expiresAt` | 기한. 지나면 CI **실패** |
| `productionApproval` | 미검증 가격으로 production 활성화를 유지한다는 별도 승인(`approvedBy`·`approvedAt`·`rationale`). `null`이면 미승인(경고) |
| `settlementSource` | `reservation_pricing`이면 fallback 단가가 정산까지 반영되고, `provider_reported_usage`면 예약 크기만 정한다 |

기한은 `PENDING_PRICE_VERIFICATION_WINDOW_DAYS`(90일)를 넘길 수 없습니다.
`findPendingPriceRegisterProblems()`가 다음을 검사하고
`npm run check:model-pricing`이 이를 실행합니다.

- **실패**: 기한 초과, 이미 가격이 붙었는데 목록에 남아 있음, 항목 중복,
  날짜 형식 오류
- **경고**: 담당자 미지정, 티켓 미발행, production 승인 미기록

기한이 지났을 때 할 일은 둘 중 하나입니다. 검증된 가격으로
`MODEL_PRICING` 항목을 추가하거나, 가격을 확인할 수 없다면 production 유지
여부를 `productionApproval`에 다시 승인으로 남기고 새 기한을 설정합니다.
**기한만 미루는 것은 승인이 아닙니다.**

이 검사는 CI·리뷰용이며 startup guard가 아닙니다. 날짜가 지났다고 production이
내려가서는 안 되므로 runtime gate는 `assertPricedPremiumModels()` 그대로이고,
그쪽은 애초에 등록조차 되지 않은 모델만 막습니다.

### fallback 사용량 모니터링

등록부는 "어떤 가격이 미검증인가"만 말하고 "그래서 누가 막히고 있는가"는
말하지 않습니다. 후자는 시스템이 이미 쓰고 있는 데이터로 집계합니다
(`lib/fallbackPricingMetricsCore.ts`, `lib/fallbackPricingMetrics.ts`).

- `ChatLimitDecisionEvent`의 모델별 `costSource`로
  **`conservative_fallback` 요청 수와 비율**(`fallbackShare`)
- 같은 이벤트에서 **fallback이 관여한 크레딧·비용 거절 건수**
  (`fallbackAttributableRejections`, 코드별 분해 포함)
- `ChatCreditReservation`의 `reservedCostMicroUsd` / `settledCostMicroUsd`와
  `pricingSnapshot.reservationCostSource`로 **예약 대비 정산 비율**
  (`reservedToSettledRatio`, 모델별 포함)

거절 건수는 **상한값**입니다. 실제 가격이었어도 한도를 넘었을 요청이 섞여
있으므로 인과가 아니라 "다시 계산해 봐야 할 모집단"으로 읽습니다. 비율은
정산이 끝난 예약만으로 계산합니다 — 미정산 예약의 0을 분모에 넣으면 측정하지
않은 과다 예약을 보고하게 됩니다.

조회: `GET /api/admin/fallback-pricing?days=7`(admin 전용, 최대 90일). 등록부에
없는데 트래픽에 나타난 fallback 모델은 `unregisteredFallbackModels`로 함께
보고합니다.

### Perplexity Deep Research 예약 모델 검토

`perplexity/sonar-deep-research`는 다른 다섯 모델과 상태가 다릅니다. 정산이
provider가 보고한 usage(`lib/perplexityUsageCore.ts`,
`pricingSnapshot.usageSource`)에서 오므로 **fallback 단가는 내부 비용 기록을
왜곡하지 않고 예약 크기만 정합니다.** 남는 문제는 예약 모양입니다. deep
research 한 턴은 다수의 검색 질의와 reasoning token을 발생시키므로, chat
completion 모양의 토큰 예약은 체계적으로 어긋납니다.

전용 예약 모델의 판단 근거는 위 지표입니다. `reservedToSettledRatio`가 이
모델에서 지속적으로 1에서 멀면(과다 예약이면 조기 거절, 1 미만이면 과소 예약)
토큰이 아니라 요청·검색 질의 단위로 예약하는 전용 항목을 도입합니다. 그때까지는
보수적인 예약을 유지합니다 — 과소 예약 쪽이 더 나쁩니다. 이 검토는 등록부
항목의 `note`에 연결돼 있습니다.

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
- 가격을 확인할 수 없어 fallback으로 enable해야 한다면
  `PENDING_VERIFIED_PRICE_REGISTER`에 담당자·티켓·기한·production 승인을 함께
  등록합니다. 등록 없는 fallback은 CI에서 막힙니다.
- guardrail 기본값을 낮추려면 `COST_PER_CREDIT_CEILING_MICRO_USD` 유도 근거를
  먼저 갱신합니다. 환경변수로는 내려갈 수 없습니다.
- entitlement 오류와 guardrail 오류를 하나의 코드로 합치지 않습니다.
- 사용자 응답에 원시 내부 USD를 넣지 않습니다.
- 관련 테스트: `tests/modelPricing.test.mjs`, `tests/chatCostGuardrails.test.mjs`,
  `tests/pendingModelPricing.test.mjs`, `tests/fallbackPricingMetrics.test.mjs`,
  `tests/chatAvailabilityCore.test.mjs`, `tests/chatLimitDecisionCore.test.mjs`,
  `tests/chatTokenEstimate.test.mjs`, `tests/chatCostSafetyCore.test.mjs`,
  `tests/integration/credit-finance.db.test.ts`,
  `tests/e2e/credit-entitlement-disclosure.spec.ts`.
