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

**동시 실행 제한도 어느 쪽도 아닙니다.** "지금 몇 개가 흐르고 있는가"는 크레딧과
무관한 별개 층이며, `limitLayer`가 `concurrency`(주체 한도,
`CHAT_CONCURRENCY_EXCEEDED`)와 `operational_admission`(익명 IP 집계 상한,
`CHAT_IP_CONCURRENCY_EXCEEDED`)으로 나뉩니다. 문구·코드·환경변수를 entitlement나
guardrail과 섞지 않습니다 — `docs/policy/chat-concurrency-and-identity.md`.

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
6. **`?.count || 0`은 4번의 대체물이 아닙니다.** 행이 없을 때와 저장값이
   `0`일 때는 둘 다 `number`가 나오므로, 이 관용구는 사용 이력이 **있는**
   사용자에게만 실패합니다. 실패가 드물어 보이는 것이 아니라 테스트가
   닿지 않는 곳으로 옮겨갈 뿐입니다 — `GET /api/admin/users/[userId]`가
   그렇게 500을 냈습니다.

관련 파일:

- `prisma/migrations-archive/20260801130000_widen_chat_usage_bucket_count/migration.sql`
- `lib/chatUsageBucketCount.ts`
- `tests/usageBucketRange.test.mjs` (schema 자료형 + 플랜별 최대 저장값)
- `tests/server-contract/admin-user-detail-route.test.ts`
  (읽기 경계 한 곳의 응답 전체 — 사용 이력이 있는 사용자, 없는 사용자,
  안전 정수 범위를 벗어난 값)
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
| Gemini 3.6 Flash | US$1.50 | US$7.50 | cached US$0.15, 공개 Advanced 4크레딧 |
| Gemini 3.5 Flash | US$1.50 | US$9 | cached US$0.15, historical 전용 Advanced 4크레딧 |
| Claude Opus 5 (`claude-opus-4-8` stable ID) | US$5 | US$25 | cached US$0.50, 8 credits |
| Claude Fable 5 | US$10 | US$50 | cached US$1, 16 credits |
| Kimi K3 | US$3 | US$15 | cached US$0.30, 16 credits |
| MiniMax M3 (≤512K) | US$0.30 | US$1.20 | cached US$0.06, 4 credits |
| MiniMax M3 (>512K) | US$0.60 | US$2.40 | cached US$0.12, 4 credits |
| GPT-5.6 Luna (≤272K) | US$0.20 | US$1.20 | cached US$0.02, cache write US$0.25(기록만) |
| GPT-5.6 Luna (>272K) | US$0.40 | US$1.80 | cached US$0.04, cache write US$0.50(기록만) |
| GPT-5.4 mini | US$0.75 | US$4.50 | cached US$0.075, 단일 tier, cache write 미확인 |

Gemini 3.5 Flash와 3.6 Flash는 입력 단가가 같고 3.6의 출력 단가가 약 16.7%
낮습니다. 기능 역할도 겹치므로 공개 카탈로그에는 3.6만 노출합니다. 3.5의 모델
ID와 가격 profile은 과거 대화 표시와 비소급 정산을 위해 보존합니다. 1크레딧
경량 역할은 별도 제품인 Gemini 3.5 Flash-Lite(`gemini-2-5-flash`)가 담당합니다.

Luna의 장문 tier는 입력 상한(로그인 128,000 · 게스트 16,000 토큰) 때문에 chat
경로에서 도달하지 않습니다. 계산은 검증돼 있으나 실제 과금 경로에서 발동한 적은
없습니다.

cached input 할인은 이 네 모델에 대해 검증된 출처가 없어서 배수 1(할인 없음)로
둡니다. 보수적인 쪽이며 기존 동작과 동일합니다. 검증되면
`cachedInputPricingVerified`와 함께 갱신합니다.

### DB에 저장된 가격은 관리자 override입니다 (2026-08-02)

`ModelRegistryEntry`의 `inputUsdPerMillionTokens` ·
`outputUsdPerMillionTokens` · `cachedInputPriceMultiplier` 세 컬럼의 계약입니다.

| 저장값 | 뜻 |
|---|---|
| `NULL` | `lib/modelPricing.ts`를 **상속**합니다. tier와 장문 구간까지 그대로 |
| 숫자 | **관리자가 이 모델의 가격을 덮어썼습니다.** tier는 평탄해집니다 |

seed는 세 컬럼을 항상 `NULL`로 씁니다. **reconciliation은 세 컬럼을 아예 쓰지
않습니다** — 부팅마다 도는 경로라 값을 쓰면 다음 배포에서 관리자 override를
덮어쓰고, profile 가격을 쓰면 NULL-상속이 무의미해집니다. 가격 변경은 이미
코드 배포만으로 모든 환경에 도달합니다.

이전에는 그렇지 않았습니다. `STATIC_RUNTIME_MODELS`가
`getModelBillingProfile(model)` — **해석된** 가격 — 를 spread했기 때문에 모든
행이 숫자를 갖고 seed됐고, `resolveModelPricing`의
`model.inputUsdPerMillionTokens ?? <profile>`이 그 컬럼을 먼저 읽어 profile을
가렸습니다. 결과가 셋이었고 셋 다 조용했습니다.

1. **장문 tier가 사라졌습니다.** Gemini 3.1 Pro는 200K 초과 prompt를 4/18로
   과금하지만, 행에는 평탄한 2/12만 있고 컬럼은 tier를 표현하지 못합니다.
   `CHAT_USER_MAX_INPUT_TOKENS`를 200,000 위로 올렸다면 조용히 과소 과금했을
   자리입니다.
2. **`costSource`가 전부 `model_registry_override`였습니다.** 그래서
   `GET /api/admin/fallback-pricing`의 fallback 비율이 0%로 보였습니다 —
   `claude-fable-5`·`mistral-large-3`·`qwen3.7-max`·
   `perplexity/sonar-deep-research`가 실제로는 US$15/US$60 fallback으로 예약되고
   있는 동안에도요. 그 상태를 기한으로 관리하려던 등록부가 보고할 대상을
   잃었습니다.
3. **관리자의 결정과 상속된 기본값을 구분할 수 없었습니다.**

`prisma/migrations/20260802020000_registry_prices_inherit_profile`이 seed가
찍어 둔 행을 지웁니다. **전면 `SET NULL`이 아니라 allowlist**입니다 — 이
컬럼에서 살아남아야 하는 값은 관리자가 손으로 넣은 값뿐이므로, 각 행은
`(id, input, output)`이 그 모델에 대해 seed가 쓴 것으로 알려진 값과 정확히
일치할 때만 지워집니다(`gpt-5-4-mini`는 profile 이전의 US$0.50/US$1.00 포함).
cached multiplier는 double이라 등가 비교 대신 허용오차로 맞추고, 이 값만 다른
행은 세 컬럼을 모두 유지합니다 — 절반은 상속이고 절반은 선택인 가격을 만들지
않기 위해서입니다.

기존 reservation·settlement·usage bucket·결제 ledger는 건드리지 않습니다.
각자 자기 `pricingVersion`과 `costSource`를 갖고 있고, 가격 변경은 소급되지
않습니다.

확인: `npm run check:model-pricing-db`(읽기 전용). 모델별 저장값 · 유효 가격 ·
`costSource` · `pricingVersion`을 보여주고, **상속하면 같은 숫자가 나오는
override**가 남아 있으면 실패합니다. 그런 override는 오늘 아무 숫자도 바꾸지
않으면서 밑의 tier를 꺼 둡니다.

### 토큰 한도 컬럼에는 그 NULL 구분이 없습니다 (2026-08-23)

`ModelRegistryEntry.maxOutputTokens`와 `reservationOutputTokens`는 바로 위
세 가격 컬럼과 **다르게** 동작합니다. 이름이 비슷하고 같은 seed가 같은 시점에
쓰기 때문에 같은 계약일 것처럼 보이지만, 아닙니다.

| | 가격 세 컬럼 | 토큰 두 컬럼 |
|---|---|---|
| seed가 쓰는 값 | 항상 `NULL` | `getModelBillingProfile()`이 해석한 숫자 |
| 저장된 숫자의 뜻 | 관리자 override | 관리자 override **또는** 그때의 profile 화석 |
| 둘을 구분하는 근거 | `NULL` 여부 | 없음 |

`registryRowToModel()`은 저장된 숫자를 그대로 신뢰하고, `resolveModelPricing()`
의 `model.maxOutputTokens ?? <profile>`이 그것을 먼저 읽으며,
`createChatBudget()`을 지나 `app/api/chat/route.ts`가
`streamText({ maxOutputTokens })`로 넘깁니다. **그래서 이 컬럼의 화석은 낡은
표시 문구가 아니라 모든 답변에 걸리는 살아 있는 상한입니다.**

2026-08-23에 그 상태가 발견됐습니다. Trace `2e4327a9`의 `claude-sonnet-5`
요청이 `AI_EMPTY_RESPONSE.MAX_TOKENS`로 끝났습니다 — 입력 16,314 토큰, 허용
출력 4,096 토큰, 그중 4,095가 reasoning, 보이는 텍스트 0, tool 호출 0.
4,096은 `FALLBACK_PRICING.advanced`의 값이고, 행이 seed된 2026-07-17에는
`claude-sonnet-5`에 profile이 없었습니다. 128,000을 가진 profile은
2026-08-04에 도착해 **행이 없던 환경에만** 도달했습니다
(`createMany({ skipDuplicates: true })`는 기존 행을 다시 보지 않고,
`STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에도 없었습니다).

규칙:

- **profile의 출력 한도를 바꾸면 기존 행에는 반영되지 않습니다.** 반영하려면
  모델을 `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에 등록합니다. 코드만 고치고
  끝내면 소스는 새 숫자를 말하고 운영은 옛 숫자로 답합니다.
- **`maxOutputTokens`와 `reservationOutputTokens`를 함께 움직이지 않습니다.**
  앞의 것은 능력(capability) — 답변이 얼마나 길 수 있는가 — 이고, 뒤의 것은
  entitlement — 한 turn이 사용자 크레딧과 provider 예산에서 얼마를 잡아 두는가
  — 입니다. 상한을 고치는 변경이 예약을 따라 올리면 그것은 사고 대응이 아니라
  과금 변경입니다. `reservationOutputBasis`를 `conservative_default`에서
  옮기는 조건은 `docs/policy/default-model-luna-migration.md` 3.1에 있습니다.
- **화석과 결정을 구분할 근거는 actor 컬럼뿐입니다.** `updatedById`/
  `updatedByEmail`은 `PUT /api/admin/models`만 씁니다 — seed도 reconciliation도
  쓰지 않으므로, 둘 다 비어 있는 행의 차이는 관리자 결정일 가능성이 낮습니다.
  증거이지 증명은 아닙니다.

#### reconciliation에는 두 개의 scope가 있습니다

`STATIC_CATALOG_RECONCILIATION_MODEL_IDS`에 등록한다는 것은 원래 **검토된
메타데이터 블록 전체**(이름·apiModel·등급·`creditWeight`·capability·토큰 한도)를
행에 쓴다는 뜻입니다. 상한 하나를 고치려고 그 전체를 쓰면 안 되는 이유가
있습니다.

**`creditWeight`가 hold 중입니다.** `perplexity/sonar`는 소스 16, production
청구 20이고, `docs/policy/perplexity-sonar-credit-price-hold.md`는 승인 전
어느 쪽도 바꾸지 말라고 하면서 **바로 이 목록을 그 행을 움직일 수 있는
경로로 지목**합니다. 전체 scope로 등록하면 다음 부팅에 20이 16이 되고, 그것은
사고 대응에 섞여 들어간 승인 없는 가격 인하입니다. docs/policy/perplexity-sonar-credit-price-hold.md §5는 다른 모델도
같은 상태일 수 있고 production 대상 `report:model-credit-weights`만 그 범위를
정할 수 있다고 적어 두었으므로, 이 반대는 Perplexity 두 모델만이 아니라 아래
열두 개 전부에 적용됩니다.

그래서 2026-08-23에 좁은 scope를 두었습니다 —
`OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS`. payload는 `maxOutputTokens`
**한 필드**입니다.

| | 전체 scope | 상한 전용 | 예약 전용 |
|---|---|---|---|
| 쓰는 것 | 검토된 메타데이터 블록 | `maxOutputTokens` | `reservationOutputTokens` |
| `creditWeight` | 씁니다 | **쓰지 않습니다** | **쓰지 않습니다** |
| 가격 컬럼·lifecycle | 씁니다 | **쓰지 않습니다** | **쓰지 않습니다** |
| 근거 | 카탈로그가 그 모두의 authority임을 사람이 확인함 | 상한은 능력 | 숫자가 §4에 확정돼 있음 |

대상 열두 개는 전부 Sonnet 5와 같은 모양입니다 — profile이 생기기 전에 seed돼
class fallback 상한(profile의 1/4 ~ 1/64)을 들고 있습니다:
`claude-haiku-4-5`, `glm-5.2`, `kimi-k2.7-code`, `mistral-large-3`,
`mistral-small-4`, `perplexity/sonar`, `perplexity/sonar-deep-research`,
`perplexity/sonar-pro`, `perplexity/sonar-reasoning-pro`, `qwen3.6-flash`,
`qwen3.7-max`, `qwen3.7-plus`.

**`gpt-5-5-thinking`은 세 번째 scope입니다** —
`RESERVATION_ONLY_RECONCILIATION_MODEL_IDS`, payload는
`reservationOutputTokens` 한 필드. 상한은 이미 일치하므로(양쪽 8,192) 상한 전용
scope가 옮길 것이 없고, 어긋나는 것은 예약뿐입니다(premium fallback 4,096 →
6,144).

예약을 옮기는 것은 보통 이 저장소가 일괄로 하지 않는 일입니다. 여기서 허용되는
근거는 하나입니다 — **그 숫자가 이미 이 문서 §4에 확정돼 있습니다**: "출력
예약은 모델별 p90입니다. premium 4,096, reasoning 모델 6,144." 이 모델은
`premium-reasoning`이므로 승인된 값이 6,144이고, 4,096을 든 행은 결정이 아니라
premium class fallback 화석입니다. **이미 내려진 결정을 행에 옮기는 것이지 새
결정을 내리는 것이 아닙니다.**

p90 basis 일반에 대한 허가로 읽지 않습니다.
docs/policy/default-model-luna-migration.md 3.1은 모델을 `p90_output_tokens`로
**옮기는** 경우를 규율하며 9개 조건과 새 `pricingVersion`을 요구합니다. 이
모델의 profile은 §4 숫자가 정해질 때 이미 그 basis를 갖고 있었고 이 변경은
그것을 건드리지 않습니다. `conservative_default`인 모델은 여기 들어오지
않습니다.

**바뀌는 것과 바뀌지 않는 것.** 사용자에게 청구되는 크레딧은
`creditWeight`에서 나오므로 **변하지 않습니다.** 바뀌는 것은 turn이 앞단에서
잡아 두는 내부 USD로, 같은 단가에서 예약분이 `gpt-5-5-thinking`은 1.5배가
되고(4,096 → 6,144) 정산에서 환급됩니다.
그래서 경계에서 `CREDIT_COST_ALLOWANCE_INSUFFICIENT`나 operational guardrail에
더 일찍 걸릴 수 있습니다 — 과소 예약을 줄이는 방향이며, 정책이 경고하는 반대
방향(과소 예약)이 아닙니다.

`reservationOutputTokens`를 좁은 scope에서도 빼는 이유는, 열두 개 모두 오늘은
class fallback과 값이 같아 write가 no-op이지만 **profile이 움직이거나 관리자가
손으로 넣는 순간 조용히 진짜 write가 되기 때문**입니다.

### 2026-08-25 — `gpt-5-5`·`gemini-3-1-pro`가 예약 전용 scope에 들어갔습니다

같은 모양이 둘 더 있었습니다. 운영 행이 예약 2,048을 들고 있고 profile은
4,096이며, 상한은 양쪽 8,192로 이미 일치합니다 — 상한 전용 scope가 옮길 것이
없고 어긋나는 것은 예약뿐인, `gpt-5-5-thinking`과 정확히 같은 형태입니다. 둘 다
`usageClass: "premium"`이므로 §4가 확정한 값은 4,096이고, profile은 이미
`p90_output_tokens`입니다.

**등록의 근거는 차이가 아니라 provenance입니다.** `reservationOutputTokens`에는
가격 컬럼의 `NULL`=상속 규칙이 없어서 저장된 숫자가 자기 출처를 말하지 못하고,
관리자의 의도된 override와 seed 화석이 컬럼만 봐서는 구분되지 않습니다. 그래서
운영 DB에서 네 가지를 읽었고 전부 seed를 가리켰습니다.

- `updatedById`·`updatedByEmail` 둘 다 없음
- `updatedAt` = `createdAt` — 행이 한 번도 재작성되지 않음
- `targetType='Model'`로 그 id를 지목하는 `AdminAuditLog` 행 0건
- 그 `updatedAt`을 다른 행들과 밀리초 단위까지 공유 — 배치 write이며, 손 편집이
  남기는 고유 timestamp가 아님

저장된 숫자 자체도 seed 시점의 트리와 대조했습니다. seed 시각
`2026-07-17T11:08:29.814Z` 직전 commit `987c8ba5`에는 `lib/modelPricing.ts`가
아직 없었고, 두 모델은 그때도 `usageClass: "premium"`이었으며,
`lib/models.ts`의 `BILLING_DEFAULTS.premium`이
`{ maxOutputTokens: 8_192, reservationOutputTokens: 2_048 }`였습니다. **상한
8,192와 예약 2,048은 그 표의 같은 행에서 나온 한 쌍**이고, premium 예약이
4,096으로 오른 것은 profile이 도입된 뒤입니다.

`conservative_default`인 세 모델 — `mistral-large-3`,
`perplexity/sonar-deep-research`, `qwen3.7-max` — 은 예약이 어긋나 있어도 여전히
이 목록 밖입니다. 그쪽은 §4가 값을 정한 적이 없으므로 옮길 승인된 숫자가
존재하지 않습니다.

확인: `npm run report:model-token-limits`(읽기 전용). 모델별로 catalogue와
저장 행의 두 컬럼을 나란히 놓고, 행이 reconciliation 대상인지와 actor 유무를
함께 보고합니다. **gate가 아니라 보고입니다** — 행이 카탈로그와 다른 것은
`PUT /api/admin/models`가 만들라고 있는 상태이고, 예약 토큰 차이는 위 규칙
때문에 일괄 수정 대상이 아닙니다. `DATABASE_URL`이 없으면 비교할 대상이 없다고
밝히고 카탈로그 숫자만 출력합니다.

카탈로그가 모르는 행 중 **의도적으로 withdraw된 것**은
`expected_historical_withdrawal`로 따로 셉니다. 판정은
`scripts/report-model-token-limits-core.mjs`의 `HISTORICAL_WITHDRAWALS`이며
**손으로 쓴 표**입니다 — "disabled이고 카탈로그에 없으니 의도된 것"이라는 추론은
사고로 사라진 행까지 정상으로 분류하고, 그것이 `unknown_to_code`가 잡으라고
있는 실패입니다. 표의 값은 해당 migration이 쓴 문자열 그대로이고, **한 컬럼이라도
다르거나 조회에서 빠지면 `unknown_to_code`로 남습니다.** withdraw된 행도 계속
저장된 상한으로 답하므로 목록에서 지우지 않고 별도 구획으로 보고합니다.

### 처리 경로: `service_tier`와 `/v1/models`

`MODEL_PRICING`의 모든 항목은 `processingTier: "standard"`입니다. 이것은 선호가
아니라 **이 앱이 실제로 보내는 요청에 대한 주장**이고, **아무 요청도 tier를
지정하지 않는 동안에만** 참입니다.

- OpenAI는 `service_tier`가 생략되면 `auto`로 처리합니다. `auto`는 Standard
  가격표가 맞다는 보장이 아닙니다.
- Flex·Batch는 더 싸고, Priority/Fast는 더 비싸며, Regional Processing은 그
  위에 할증이 붙습니다.
- `npm run check:model-pricing`이 `app`·`lib`·`components`·`scripts`에서
  `service_tier`/`serviceTier`를 grep해, `PROCESSING_TIER_REQUEST_ALLOWLIST`에
  없는 파일에 나타나면 **실패**합니다. 목록은 의도적으로 비어 있습니다.

**남은 gap:** 응답의 `service_tier`를 읽지 않습니다. 그래서 snapshot에는 이
registry가 **가정한** tier가 남고 요청이 **실제로 처리된** tier는 남지 않습니다.
닫으려면 응답 필드를 pricing snapshot까지 배선해야 하고, 그것은 새
`pricingVersion`을 갖는 별개 변경입니다.

`GET /v1/models`는 **가격 출처가 아닙니다.** 계정·키별 모델 가시성만 답하고
가격은 전혀 돌려주지 않습니다. `npm run check:openai-model-access`가 그 확인을
따로 제공하되(기본은 읽기 한 번, `--invoke`는 명시적 opt-in과 예상 비용 표시
필요), 출력 자체가 "이것은 가격 근거가 아니다"라고 적습니다.

### cache write 가격은 측정된 곳에서 과금합니다 (2026-08-30 개정)

**이전 계약**(`CACHE_WRITE_PRICING_IS_RECORDED_NOT_BILLED`)은
`ModelPriceTier.cacheWriteUsdPerMillionTokens`를 감사용 기록으로만 두고 과금에
쓰지 않았습니다. 그때는 맞았습니다 — **cache write 토큰을 보고하는 provider
usage adapter가 하나도 없었고**, read 수에서 write 수를 유도하는 것은 숫자를
지어내는 일이었습니다.

Anthropic prompt caching을 켜면서 그 전제가 깨졌습니다. AI SDK가
`usage.inputTokenDetails.cacheWriteTokens`(API의
`cache_creation_input_tokens`)를 보고합니다. 새 계약은

```
CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED = true
```

이고, **양쪽이 다 있을 때만 과금합니다** — tier의 검증된 요율 **그리고**
provider가 보고한 write 토큰 수. 한쪽만으로는 어느 쪽도 지어내기입니다.

- 요율이 없는 모델의 write는 비용 0으로 계산되되
  `unpricedCacheWriteTokens`로 **보고**됩니다. 알려진 토큰 수만큼 과소 기록된
  비용과 완전한 비용은 다른 것입니다.
- `cacheWriteUsdPerMillionTokens`는 **env·DB override 대상이 아닙니다.** 관리자
  콘솔에 이 요율 컨트롤이 없으므로, override 경로는 아무도 볼 수 없는 가격을
  움직이는 뒷문이 됩니다.
- 5분 write는 base input의 1.25배입니다
  (`PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER`). 이 상수는 요율을 **계산하지
  않고 검사합니다** — 모든 요율은 Anthropic 가격표에서 읽어 적고,
  `npm run check:model-pricing`이 각 요율이 자기 tier의 입력 요율 × 1.25인지
  대조합니다.
- **1시간 캐시(2배)는 쓰지 않습니다.** 요청 경로가 없으므로 상수도 두지
  않습니다: docs/policy/anthropic-prompt-caching.md §3.

기록된 요율:

- `claude-opus-4-8`(Opus 5) US$6.25 · `claude-fable-5` US$12.50 ·
  `claude-sonnet-5` US$2.50 · `claude-haiku-4-5` US$1.25 — 전부 과금됩니다.
- `gpt-5-6-luna`: 단문 US$0.25, 장문 US$0.50 (입력 요율과 같은 x2). 요율은
  해석되지만 **OpenAI usage adapter가 write 수를 보고하지 않으므로 write 수가
  항상 0이고 비용도 0입니다** — 요율이 없어서가 아니라 측정이 없어서입니다. 이
  구분이 "양쪽이 다 있을 때만"의 요점입니다: adapter가 생기면 아무도 flag를
  뒤집지 않아도 0이 아니게 됩니다.
- `gpt-5-4-mini`: **기록하지 않습니다.** 확인된 값이 없으며, 아무도 확인하지
  않은 값을 기록하는 것은 없는 것보다 나쁩니다.

이중 계산 함정과 예약 계약은 docs/policy/anthropic-prompt-caching.md §4–§5에
있습니다. 요약: AI SDK의 `usage.inputTokens`는 **총합**(`noCache + cacheRead +
cacheWrite`)이므로 두 캐시 수치를 **빼야** 하고, 캐시 marker를 다는 요청은
0.25배 premium을 provider budget에 **미리** 예약하되 `usageCredits`에는 절대
닿지 않습니다.

### 가격은 effective date로 선택합니다 (2026-08-30)

`ModelPricingProfile.priceSchedule`은 예고된 가격 변경을 **효력 발생 전에 적어
둘 수 있게** 합니다. 이전에는 registry가 "오늘 참인 가격" 하나만 담을 수 있어서,
예고된 변경에 대해 나쁜 선택지가 둘뿐이었습니다 — 미래 숫자를 지금 써서 효력
전부터 청구하거나, 아무것도 안 써서 효력 후에 옛 숫자로 청구하거나.

- 각 항목은 `effectiveFrom`(RFC 3339 **UTC** instant, `Z` 필수)·`tiers`·
  `priceSource`·**새 `pricingVersion`**·`effectiveDate`를 갖습니다.
- 경계는 **포함**입니다: `at === effectiveFrom`이면 새 가격, 1밀리초 전이면 이전
  가격. 어느 쪽에도 속하지 않는 순간이 없습니다.
- UTC인 이유는 이 시스템의 다른 모든 경계가 UTC이기 때문입니다 —
  `ChatUsageBucket` period, `ProviderDailyUsage` day(`rollupDayOf`), 그리고
  대조 대상인 provider usage·cost API. local time 경계는 정산과 rollup을 변경의
  반대편에 놓습니다.
- **소급 적용은 여전히 금지입니다.** 항목은 자기 instant 이후 요청만 설명하고,
  저장된 snapshot은 이미 자기 요율과 `pricingVersion`을 갖고 있으므로 항목을
  추가해도 다시 계산되지 않습니다.
- **override 우선순위는 그대로입니다**: DB/admin override > env override >
  schedule이 고른 tier > class fallback. override가 있는 행은 tier가 평탄해지고
  schedule도 함께 평탄해집니다 — 컬럼이 둘 다 표현하지 못합니다.
- module load 시 검사합니다: 오름차순, 중복 `pricingVersion` 금지,
  `effectiveDate`가 `effectiveFrom`의 UTC 날짜와 일치.

**Claude Sonnet 5.** launch 시 US$2/US$10은 2026-08-31까지의 introductory
가격이고 2026-09-01부터 US$3/US$15로 오른다고 예고됐습니다. **2026-08-11에
Anthropic이 그 인상을 취소했습니다** — 공식 pricing 페이지의
`claude-sonnet-5-introductory-pricing` 각주: "is now the standard price. The
previously scheduled increase to $3/$15 per million input/output tokens on
September 1, 2026 will not occur."

그래서 registry는 US$3/US$15를 **예약하지 않습니다.** 예약했다면 2026-09-01부터
모든 Sonnet 5 요청을 50% 과대 계상했을 것이고, 과대 계상은 안전한 방향이
아닙니다 — provider budget과 operational guardrail이 이 숫자로 소진되므로
부풀린 요율은 돈이 있던 요청을 거절합니다. 대신 취소 사실을
`anthropic-claude-sonnet-5-standard-2026-08-11` 항목으로 적었습니다. 요율은
이전과 같고 **기간(term)이 달라졌으며**, 그것이 이 registry가 기록하는
것입니다. 2026-08-11 이전 요청은 계속
`anthropic-claude-sonnet-5-intro-2026-08-04`로 재현됩니다.

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
- web search가 켜지면 검색 결과가 프롬프트로 되돌아오므로 입력에
  `WEB_SEARCH_INPUT_TOKEN_OVERHEAD`(6,000) + tool 정의(400)를 더해 예약합니다.
  **크레딧에는 반영하지 않습니다** — 사용자 과금은 대화 길이 기준입니다.
  provider-native 검색과 application-managed 검색 모두 같은 overhead를 씁니다.
  경로는 달라도 입력 쪽에서 하는 일은 같기 때문이고, 한쪽만 예약하면 모든
  Gemini 검색 turn이 예약보다 수천 토큰 위에서 정산됩니다.
- **native web search의 질의당 비용은 요청이 상한을 강제할 때만 예약할 수
  있습니다.** 상한을 보내는 방법은 provider마다 다릅니다 — Anthropic은 tool의
  `maxUses`, OpenAI는 Responses 요청의 `max_tool_calls`
  (`providerOptions.openai.maxToolCalls`)입니다. Google의 Search grounding은
  tool에도 요청에도 상한 parameter가 없어서 **fail-closed로 남습니다.**
  Google 모델은 그래서 grounding 대신 아래의 application-managed 경로로
  검색합니다.
- **OpenAI에서는 요청이 강제하는 상한과 청구되는 상한이 같은 수가
  아닙니다.** 원래는 한 필드였고 근거는 "요청이 강제하는 상한이면 예산을
  그 위에 올려도 된다"였는데, 2026-08-26에 그 근거가 반증됐습니다 — Luna
  turn이 `max_tool_calls: 5`를 보내고 `web_search_call` 6건으로 청구됐습니다
  (Sentry `NATIVE_SEARCH_QUERY_CEILING_BREACHED`, `observedQueries: 6`).
  결론 전에 전 구간을 확인했습니다: SDK가 parameter를 전송하고, 앱이 그것을
  읽는 Responses 모델을 쓰며, `buildWebSearchToolConfig`가 `providerOptions`를
  덮지 않고, stream이 `web_search_call`당 `tool-result`를 정확히 하나 냅니다.
  따라서 6개 part는 6번의 검색입니다.
  - `requestEnforcedSearchToolCalls`(5)가 요청에 실리고
    `maxBillableSearchQueriesPerRequest`(6)가 돈을 산정합니다. 둘 다
    `OPENAI_MAX_SEARCH_TOOL_CALLS`와 `OPENAI_SEARCH_OVERSHOOT_ALLOWANCE`에서
    **파생**되므로 여전히 복사본이 아닙니다.
  - **요청 상한을 6으로 올리는 것은 답이 아닙니다.** 초과가 "보낸 값 +1"이면
    경계만 옮겨 7건이 청구됩니다.
  - **이 허용치의 근거는 관측 1건입니다.** OpenAI가 얼마나 넘을 수 있는지를
    잰 값이 아니고, 본 것과 모순되지 않는 가장 작은 수입니다. 이 bound를 또
    넘으면 답은 허용치를 키우는 것이 아니라 **OpenAI의 검색에는 강제 가능한
    최악값이 없다고 인정하고 Google과 같은 자리로 옮기는 것**입니다.
  - 검색 turn의 승인된 최악 비용이 US$0.05 → **US$0.06**으로 바뀝니다. 이는
    tuning이 아니라 승인 사항이며 2026-08-26에 승인됐습니다.
- **ceiling breach latch는 프로세스를 넘어 지속됩니다.**
  `lib/webSearchCeilingBreachStore.ts`가 provider별 `AppSetting` 행으로 기록하고
  최대 `REFRESH_INTERVAL_MS`(60초)마다 새로 읽습니다. 이전에는 메모리 Set
  하나였고 실제 보장은 "다음 배포까지"였습니다 — 2026-08-26 staging에서 latch가
  걸렸고, 다음 배포가 아무 흔적 없이 그것을 지웠을 것입니다. latch는 두
  집합입니다: **직접 관측한 것(`localBreaches`)은 새로고침이 지울 수
  없고**(쓰기 실패나 조기 새로고침이 목격자 프로세스를 풀어 주면 안 됩니다),
  공유분(`durableBreaches`)은 통째로 교체되므로 운영자가 행을 지우면 한 주기
  안에 모든 인스턴스가 재개합니다.
- **provider capability와 operational dispatchability는 다릅니다.**
  `webSearchIsDispatchable(capability, readiness)`(`lib/webSearchCapability.ts`)이
  유일한 판정이고, composer · credit estimate · model picker · router candidate ·
  `/api/chat` · `/api/chat/preflight` · `/api/chat/availability`가 모두 이것을
  묻습니다. native 전용 질문은 `nativeSearchIsDispatchable()`로 남습니다. **예약이 거절할 검색을 어떤 표면도 먼저 제안하지 않는다**는 것이
  규칙입니다 — 반대로 하면 UI가 네 번 허용한 기능이 dispatch에서만 503을
  냅니다(2026-08-25 `gpt-5-6-luna` · `WEB_SEARCH_COST_UNBOUNDED`).
- **세 route는 같은 검색 비용을 예약합니다.** `/api/chat/preflight`와
  `/api/chat/availability`도 `reserveTurnSearchCost()`를 부르고 결과를
  `createChatBudget({ nativeSearch, searchBackend })`에 넘깁니다. 사전 확인이
  실제 요청보다 적은 provider 비용을 계산하면 그것은 확인이 아닙니다. 한
  함수가 두 vendor 몫을 함께 돌려주므로 한쪽만 예약하고 다른 쪽을 잊을 수
  없습니다.
- 출력 예약은 모델별 p90입니다. premium 4,096, reasoning 모델 6,144
  (`maxOutputTokens` 8,192 유지).
- 정산은 provider usage metadata를 우선 사용하고, 없을 때만 fallback
  estimator를 씁니다. 어느 쪽을 썼는지 `pricingSnapshot.usageSource`에
  남습니다. reasoning token은 `outputTokens`에 이미 포함되므로 별도 과금하지
  않고 관측용으로만 기록합니다.

### Application-managed web search (2026-08-27)

Google Gemini의 Search grounding은 질의마다 과금되면서 **요청당 검색 횟수를
강제하는 parameter가 없습니다.** 그래서 위 규칙에 따라 fail-closed였고, 활성
Google 모델 넷이 전부 "웹 검색 불가"로 제공되고 있었습니다. 관측 평균으로
예약하거나 system prompt로 "최대 5회"를 요청하는 것은 **강제 가능한 상한이
아니므로** 답이 아닙니다 — 중요하지 않을 때만 맞고 중요할 때 틀리는 예약입니다.

그래서 검색을 provider의 것에서 **이 애플리케이션의 것**으로 옮겼습니다. 모델은
평범한 function tool(`web_search`)을 호출하고, 실행은 이 프로세스가 하며,
상한은 이 프로세스의 counter입니다. **여섯 번째 호출은 socket을 열지 않습니다**
(`lib/appManagedWebSearchCore.ts`). 설득할 수 없는 유일한 종류의 상한입니다.

#### 승인된 값

| 항목 | 값 | 근거 |
|---|---|---|
| 모델당 turn당 최대 backend 요청 | 5 | `APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest` |
| 요청당 결과 수 | 5 | 같은 표 |
| Brave 단가 | US$5.00 / 1,000 requests = 5,000 µUSD | Brave Search API "Data for AI" 가격표, 2026-08-27 확인 |
| turn당 검색 최악 비용 | 25,000 µUSD (US$0.025) | 5 × 5,000, 올림 |
| 사용자 surcharge | 8 크레딧 (변경 없음) | `WEB_SEARCH_SURCHARGE_CREDITS` |

가격은 `lib/webSearchBackendPricing.ts`가 유일한 출처이고 `pricingVersion` ·
`priceSource` · `effectiveDate`를 함께 들고 있습니다. **무료 할당량은 내부 비용
계산에서 무시합니다** — 무료분을 먼저 쓰는 추정은 할당량이 끝나는 날 갑자기
뛰고, 예산은 최악값을 묶으려고 존재합니다. Google grounding의 무료 quota를
무시하는 것과 같은 이유입니다.

**14,000 µUSD를 여기에 재사용하지 않습니다.** 그것은 Google이 자기 grounding에
매기는 값이고, Brave의 HTTP 요청 가격과는 아무 관계가 없습니다. 재사용하면 모든
Gemini turn을 2.8배로 과대 계상하고, 어떤 invoice와도 맞지 않는 숫자를 감사
기록에 남깁니다.

#### capability는 네 가지 사실을 구분합니다

`WebSearchSupport`에 `app-managed`를 추가했고, `native`로 위장하지
않았습니다. 호출자가 묻는 모든 질문의 답이 다르기 때문입니다 — 어느 예산이
지불하는지, citation이 어디서 오는지, artifact tool과 공존할 수 있는지, fallback이
무엇을 물려받을 수 있는지.

- **provider-native search** — `support: "native"`, `provider`
- **search-specialized model** — `support: "search-model"` (Perplexity)
- **Tomverse-managed search** — `support: "app-managed"`, `searchBackend`
- **선언된 capability** — register(컴파일 시점, 모든 배포에서 동일)
- **runtime backend readiness** — `resolveWebSearchBackendReadiness()`(배포별)
- **실제 turn의 execution** — `AppManagedSearchSnapshot`

`nativeSearchIsDispatchable()`에는 app-managed를 넣지 않았습니다. 대신
`appManagedSearchIsDispatchable(capability, readiness)`와, 둘을 합치는
`webSearchIsDispatchable(capability, readiness)`가 있습니다. **`readiness`는
optional이 아니라 required입니다** — "있다고 가정"하는 기본값은 credential 없는
배포에서 8크레딧을 받고 dispatch에서만 거절하는, 이 규칙이 막으려는 실패를 한
층 위에서 재현합니다.

readiness는 서버가 풀고 client에는 backend별 boolean 하나로만 건넵니다
(`WebSearchBackendReadinessProvider`). key의 존재 여부를 말하는 public 환경변수는
key의 존재 여부를 말하는 public 환경변수입니다.

#### 예산은 별개 층입니다

`provider:google`은 Google이 받을 돈을 셉니다. Brave 요청은 다른 invoice이므로
**`search-provider:brave`** 라는 자기 bucket에 들어갑니다.

- 환경변수: `SEARCH_PROVIDER_BRAVE_COST_MICROUSD_PER_DAY` · `_PER_MONTH`
- bucket period: `search-cost-day` · `search-cost-month`
- 오류 코드: `SEARCH_PROVIDER_BUDGET_EXHAUSTED`
  (`PROVIDER_BUDGET_EXHAUSTED`와 별개 — 운영자가 볼 예산이 다릅니다)
- reservation entry metric: `search-cost`

**floor는 유도값입니다.** chat provider floor(계정 하나의 plan guardrail, 월
US$500 수준)를 재사용하면 검색이 정당하게 쓸 수 있는 금액의 열 배가 넘는 값이
되어 bound 노릇을 못 합니다. image 예산이 자기 가격표에서 floor를 유도한 것과
같은 방식으로, 검색을 실제로 배급하는 것 — 검색 turn의 크레딧 가격 — 에서
유도합니다.

```
Max 월 크레딧 10,000 ÷ 검색 turn당 8크레딧 = 1,250 turn
1,250 × 25,000 µUSD × 1.25(headroom) = 39,062,500 µUSD ≈ US$39.06
```

일 floor와 월 floor는 같습니다. Max 플랜에는 일일 크레딧 한도가 없어서
(`dailyMessageLimit: 0`) 한 계정이 월 grant 전부를 하루에 쓸 수 있고, 그보다
낮은 일 floor는 정당한 트래픽을 거절합니다. image 예산 floor가 같은 모양인 것도
같은 이유입니다.

production에는 기본값이 없습니다. credential이 있는데 예산을 읽을 수 없거나,
활성 모델이 요구하는 backend의 credential이 없으면 `/api/ready`가 실패합니다
(`lib/searchProviderBudgetReadiness.ts`). **환경변수를 먼저 배포하고 코드를
나중에** — provider 예산과 같은 순서입니다. 개발·테스트는 development default를
쓰고, credential이 없으면 readiness는 통과하되 검색을 아무 데서도 제안하지
않습니다. `WEB_SEARCH_FAKE_BACKEND=1`은 결정적 fake adapter를 켜며
**production에서는 요청되기만 해도 readiness 실패**입니다.

#### 정산

- **예약**: 요청 전에 25,000 µUSD (5 × 5,000). rate와 ceiling과
  `pricingVersion`은 reservation에 동결됩니다.
- **정산**: 실제로 **응답을 받은** backend 요청 수 × 5,000. vendor는 서비스한
  요청에 청구하고, 429는 서비스된 요청이 아닙니다.
- **counter는 시도를 셉니다** — 그래야 아픈 backend를 무한 재시도할 수
  없습니다. **돈은 성공을 셉니다.** 두 숫자는 다르고 둘 다 기록합니다.
- 미사용분은 settlement에서 해제됩니다(metric `search-cost`).
- 사용자 크레딧: 검색 0회면 8크레딧 전액 환불, 1~5회면 기존 flat 8크레딧.
  **질의 수로 사용자에게 추가 과금하지 않습니다.**
- 가격 변경은 소급되지 않습니다. 동결된 rate가 정산을 매깁니다.

#### fallback

검색한 turn은 fallback하지 않습니다(`autoFallbackScope` → `web_search`).
application-managed 검색도 같습니다 — backend 요청을 이미 썼고 surcharge를 이미
받았으므로, 두 번째 시도는 둘 다 다시 쓰거나 사용자가 지불한 검색 없이
답하게 됩니다. 그럼에도 plan은 attempt마다 **자기 tool과 자기 counter와 자기
예약**을 만듭니다(`ATTEMPT_BOUND_FIELDS`에 `appManagedSearch` 포함): 물려받은
counter는 이미 쓴 allowance를 물려받거나, 지불하지 않은 allowance를 쓰게 합니다.

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
- 세 가격 컬럼에 값을 쓰기 전에 위 "DB에 저장된 가격은 관리자 override" 절을
  읽습니다. seed와 reconciliation은 쓰지 않습니다.
- 요청에 처리 tier를 넣기 전에 해당 tier의 가격 항목을 먼저 만들고
  `PROCESSING_TIER_REQUEST_ALLOWLIST`에 등록합니다.
- 읽기 전용 운영 도구: `npm run check:model-pricing-db`(저장값·유효값·
  `costSource`·`pricingVersion`), `npm run report:cost-bucket-corrections`
  (정상 가격 기준 재계산과 차이 — **후보만 만들고 bucket을 고치지 않습니다**),
  `npm run check:openai-model-access`(가시성만, 가격 아님).
- 관련 테스트: `tests/modelPricing.test.mjs`, `tests/chatCostGuardrails.test.mjs`,
  `tests/modelRegistryPricingInheritance.test.ts`,
  `tests/openAiPricingContract.test.ts`,
  `tests/costBucketCorrectionCore.test.ts`,
  `tests/pendingModelPricing.test.mjs`, `tests/fallbackPricingMetrics.test.mjs`,
  `tests/chatAvailabilityCore.test.mjs`, `tests/chatLimitDecisionCore.test.mjs`,
  `tests/chatTokenEstimate.test.mjs`, `tests/chatCostSafetyCore.test.mjs`,
  `tests/integration/credit-finance.db.test.ts`,
  `tests/e2e/credit-entitlement-disclosure.spec.ts`.

## 9. Canonical lock order (금융 트랜잭션)

크레딧을 예약·환급하는 경로가 셋(chat, 이미지 생성, memory extraction)이 되면서
필요해진 규칙입니다. 셋은 **같은 금융 primitive를 서로 다른 orchestration에서**
호출하므로, 잠금 순서가 갈리면 교착이 생기고 잠금이 빠지면 잔액이 음수가 됩니다.

### 왜 잠금이 필요한가

`reserveAddOnCredits()`는 계정의 `CreditLot`을 **읽어서 충분한지 판정한 뒤**
차감합니다. 차감(`{ decrement }` → `SET col = col - x`)은 행 단위로 원자적이지만
**판정은 그렇지 않습니다.** `remainingCredits`에는 CHECK 제약도, 차감 후 검사도
없으므로, 같은 잔액을 읽은 두 트랜잭션이 모두 통과해 음수가 됩니다. 이것을 막는
유일한 장치가 계정 advisory 잠금입니다.

### 순서

`lib/chatSecurity.ts`의 `acquireChatAccess`가 이미 쓰고 있는 순서를 정본으로 삼고,
새 금융 경로는 **이 순서를 뒤집지 않습니다.**

1. **`lockCreditAccount(tx, userId)`** (`credit-account:<userId>`) — 크레딧을 예약·
   정산·환급하는 트랜잭션은 언제나 이것을 **가장 먼저** 잡습니다. 다른 advisory
   잠금을 먼저 잡고 나중에 크레딧 계정을 잡는 경로를 만들지 않습니다.
2. **workflow advisory 잠금** — `<subjectKey>`(chat admission),
   `chat-lease:<key>`, `memory-extraction:<userId>`(run 입장),
   `memory-items:<userId>`(memory 항목 쓰기), `external-import:<userId>`,
   이미지 생성의 `scope.key`.
3. **lease row** — 만료 정리와 slot 확보.
4. **사용량 버킷** — 크레딧(월/일·debt offset) → rate·token → **provider 비용**.
   provider 비용 버킷은 항상 마지막 버킷 계층입니다.
5. **reservation row 삽입 / lot 차감** — 위 판정이 모두 통과한 뒤 마지막.

### 규칙

- 크레딧을 전혀 건드리지 않는 경로(예: run 조회, memory 삭제)는 1을 건너뛸 수
  있지만, 2 이후의 상대 순서는 동일하게 유지합니다.
- **판정과 예약을 다른 트랜잭션으로 나누지 않습니다.** 조회 후 별도로 예약하면
  동시 요청이 같은 잔여 예산을 보고 모두 통과합니다. provider 총예산·크레딧·
  fencing 검증은 한 경계 안에 있어야 합니다.
- **조건 분기 안에서 잠그지 않습니다.** 어떤 chunk가 종료 chunk인지는 트랜잭션
  중간에야 알 수 있으므로, 그 분기 뒤에 잠그면 "가끔 잠금 없이 정산하는"
  트랜잭션이 됩니다. 잠금은 트랜잭션 첫 문장입니다.
- 환급은 증가만 하므로 그 자체로는 안전하지만, 동시 예약의 *읽기와 차감 사이*에
  끼면 그 예약이 존재하지 않던 잔액을 근거로 판정합니다. 그래서 환급 경로도 같은
  잠금을 잡습니다.

### 현재 잠그는 곳

| 경로 | 모듈 |
|---|---|
| chat 예약·정산 | `lib/chatSecurity.ts` |
| 이미지 생성 예약·정산 | `lib/imageGenerationService.ts` |
| 크레딧 구매·분쟁 | `lib/creditPurchase.ts` |
| extraction run 생성·chunk 종료·취소 | `lib/memoryExtractionService.ts` |

### DB 제약 — 잠금의 대체물이 아니라 그 아래 그물

`CreditLot`에 non-negative CHECK 제약이 있습니다
(`20260812070000_credit_lot_non_negative`).

- `CreditLot_remainingCredits_non_negative_check`
- `CreditLot_remainingFundedCost_non_negative_check`

**잠금을 대신하지 않습니다.** CHECK는 직렬화를 못 하므로 잠금 없는 경로를
안전하게 만들지 못합니다. 하는 일은 *조용히 틀린 잔액*을 *실패한 트랜잭션*으로
바꾸는 것 — 몇 달 뒤 ledger 대사에서 발견되는 버그와 그날 발견되는 버그의
차이입니다. 위의 잠금 규칙은 그대로 지킵니다.

**`NOT VALID`로 추가했습니다.** 이후의 모든 INSERT·UPDATE는 강제되고(위험한 것은
아직 쓰이지 않은 행이므로 이것이 필요한 coverage 전부입니다), 전체 스캔과
ACCESS EXCLUSIVE 잠금은 건너뛰며, 아무도 조사하지 않은 과거 데이터로 배포가
실패하지 않습니다. validate는 **별도 migration**이고 순서가 있습니다.

1. 이 migration 배포
2. `npm run report:credit-lot-invariants`를 production에 실행 — 위반 행 보고
3. 0이 되면 후속 migration에서 `VALIDATE CONSTRAINT`

**(1)과 (3) 사이에 production에서 손으로 validate하지 않습니다.**
`scripts/compare-schema-to-migrations.mjs`가 `pg_get_constraintdef()`를
비교하는데 그 출력에 `NOT VALID`가 붙으므로, 손으로 validate하면 후속
migration이 들어올 때까지 schema drift로 보고됩니다.

위반 행은 잔액만 고치지 않습니다 — 보정 `CreditLedgerEntry`를 써서 행과 이력이
계속 일치하게 합니다.

- 관련 테스트: `tests/integration/credit-finance.db.test.ts`(동시 예약이 잔액을
  초과하지 않음, DB가 음수 잔액을 거부함),
  `tests/integration/memory-extraction-credits.db.test.ts`(extraction의 예약·
  환급이 계정 잠금을 기다림), `tests/creditLockOrder.test.mjs`(잠금 없는 네
  번째 caller 차단).
