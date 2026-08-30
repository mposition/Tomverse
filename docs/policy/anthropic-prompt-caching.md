# Anthropic prompt caching과 cache write 회계

Anthropic first-party 요청의 5분 automatic prompt caching, 그리고 그것이 만들어
낸 **cache write 토큰의 비용 회계**에 대한 계약입니다. 아래 파일을 바꾸기 전에
읽어 주세요.

- `lib/anthropicPromptCaching.ts`
- `lib/modelGenerationCompatibility.ts`
- `lib/providerUsageCost.ts`
- `lib/modelPricing.ts`의 `cacheWriteUsdPerMillionTokens`
- `lib/chatSecurity.ts`의 예약·정산 경로
- `scripts/report-anthropic-cache-efficiency*.mjs`

관련 정책: `docs/policy/credit-and-cost-limits.md`(§3 가격 registry, §9 lock
order).

## 1. 왜 켰는가

Anthropic이 Tomverse의 direct API 트래픽에서 prompt cache hit rate가 낮다고
알려 왔습니다. 대화형 채팅은 turn N+1이 turn 1..N을 **바이트 단위로 그대로**
다시 보내므로 prefix 재사용률이 구조적으로 높은데, 요청에 `cache_control`이
없어서 그 prefix가 매번 full price로 처리되고 있었습니다.

## 2. 무엇에 적용하고 무엇에 적용하지 않는가

**적용 여부는 provider가 아니라 "그 경로에 반복되는 prefix가 있는가"로
정합니다.** 판정은 `lib/anthropicPromptCaching.ts`의
`ANTHROPIC_PROMPT_CACHE_PATHS` 표 하나이고, 각 항목은 근거를 함께 적습니다.

| 경로 | 캐시 | 근거 |
|---|---|---|
| `chat_turn` | O | turn N+1이 turn 1..N을 그대로 재전송 |
| `chat_fallback_turn` | O | 같은 대화·같은 메시지, 다른 모델 |
| `comparison_review` | O | 고정 rubric + 같은 답변들, 재실행·항목별 검증이 반복 |
| `compare_summary` | O | review와 같은 답변을 공유하고 대개 직후에 실행 |
| `conversation_title` | X | 대화당 1회. 두 번째 요청이 없음 |
| `provider_probe` | X | 최소 prefix 미달 + probe에 parameter 추가는 두 번 장애로 기록됨 |
| `provider_verification` | X | 고정된 짧은 일회성 요청 |
| `memory_extraction` | X | 대화당 1회, 매번 다른 transcript |

절대 조건:

- **`provider === "anthropic"`으로만 게이트합니다.** `providerOptions.anthropic`
  은 "Anthropic용 옵션"이 아니라 `@ai-sdk/anthropic`이 읽는 namespace이고,
  `lib/activeAiModel.ts`는 **MiniMax도 `createAnthropic()`으로 만듭니다**
  (`https://api.minimax.io/anthropic/v1`). "Anthropic SDK를 쓰는가"로 판정하면
  캐시 의미와 가격이 검증되지 않은 endpoint로 `cache_control`이 나갑니다.
- **경로 없이는 캐시하지 않습니다.** `promptCachePath`는 opt-in이고 기본값이
  없습니다. 반대 기본값("지정하지 않으면 캐시")이었다면 probe와 title 호출이
  아무도 읽지 않는 write를 조용히 만들었을 것입니다.
- **provider option은 namespace 한 단계 깊이에서 병합합니다.**
  `mergeProviderOptions()`. Anthropic reasoning 모델은 같은 `anthropic`
  namespace에 이미 `thinking`·`effort`를 갖고 있으므로, 얕은 spread는 그것을
  `cacheControl`로 **교체**합니다. 증상은 "모델이 조용히 추론을 멈춤"입니다.
- **최소 prefix 미달은 오류가 아니라 정상 cache miss입니다.** Haiku 4.5는
  4,096토큰, Sonnet 5는 1,024, Opus 5·Fable 5는 512이며 세대에 따라 단조롭지
  않습니다. 값은 `ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS`에 기록만 하고
  **marker를 억제하는 데 쓰지 않습니다** — 억제하려면 이 앱의 토큰 *추정치*로
  판단해야 하고, 그 추정이 맞아야만 안전한 판단이 됩니다.

## 3. TTL은 5분 하나입니다

`ANTHROPIC_PROMPT_CACHE_TTL = "5m"`. 1시간 캐시는 **구현하지 않습니다.**

- 5분 write는 base input의 1.25배, 1시간 write는 2배입니다.
- cache read는 추가 비용 없이 TTL 타이머를 갱신하므로, prefix를 공유하는 요청이
  5분 안에 이어지면 5분 entry가 무한히 살아 있고 2배 write는 아무것도 사지
  않습니다.
- Tomverse 트래픽에 5분보다 긴 공백이 있는지는 **이 저장소가 답할 수 없는
  production 사실**입니다. `npm run report:anthropic-cache-efficiency`가 그것을
  측정하기 위한 도구이고, 측정 전에 2배 write를 고르는 것은 추측입니다.

TTL은 요청에 **명시**합니다(`{ type: "ephemeral", ttl: "5m" }`). 기본값에
맡기지 않는 이유는 값이 요청 바이트에 들어가야 manifest의
`effectiveRequestHash`에 반영되고, 나중에 저장된 turn이 어떤 TTL로 나갔는지를
배포 날짜로 추론하지 않아도 되기 때문입니다.

## 4. cache write는 기록만 하는 것이 아니라 과금합니다

이전 계약은 `CACHE_WRITE_PRICING_IS_RECORDED_NOT_BILLED = true`였습니다. 그때는
맞았습니다 — **cache write 토큰을 보고하는 usage adapter가 하나도 없었고**, read
수에서 write 수를 유도하는 것은 숫자를 지어내는 일이었기 때문입니다.

Anthropic 캐싱을 켜면서 그 전제가 깨졌습니다. AI SDK가
`usage.inputTokenDetails.cacheWriteTokens`(API의 `cache_creation_input_tokens`)
를 보고합니다. 그래서 계약은 다음으로 바뀌었습니다.

```
CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED = true
```

**양쪽이 다 있을 때만 과금합니다** — tier의 검증된 요율 **그리고** provider가
보고한 write 토큰 수. 한쪽만으로는 어느 쪽도 지어내기입니다.

### 4.1 이중 계산 함정

`usage.inputTokens`(AI SDK)는 **총합**입니다: `noCache + cacheRead + cacheWrite`
(`convertAnthropicUsage`). Anthropic API 자체의 `input_tokens`(= 캐시되지 않은
나머지)와 **다릅니다.**

그래서 `calculateProviderUsageCost()`는 두 캐시 수치를 총합에서 **뺍니다**:

```
uncached = inputTokens - cacheRead - cacheWrite
uncached  x inputRate x 1.00
cacheRead x inputRate x 0.10
cacheWrite x cacheWriteRate      (= inputRate x 1.25, 5분 TTL)
```

이 뺄셈이 없으면 write 토큰이 "uncached 나머지"에 섞여 **1.0배로** 과금되고,
캐시를 만드는 turn이 실제보다 25% 싸게 기록됩니다. 반대로 더하면 캐시된
prompt를 두 번 셉니다.

세 곳의 clamp가 **같은 규칙**이어야 합니다 — `calculateProviderUsageCost`,
`chatAttemptCostLedger`, `settleChatUsage`. 행의 토큰 컬럼들은 그 행 자신의
`inputTokens`의 분할이고, clamp가 어긋나면 분할이 합계와 맞지 않게 됩니다.

### 4.2 검증되지 않은 요율은 0이 아닙니다

요율이 없는 모델의 write는 비용 0으로 기록되되 `unpricedCacheWriteTokens`로
**보고**됩니다. 알려진 토큰 수만큼 과소 기록된 비용과 완전한 비용은 다른
것이고, 저장된 snapshot을 읽는 사람이 그 둘을 구분할 다른 방법이 없습니다.

`cacheWriteUsdPerMillionTokens`는 **env·DB override 대상이 아닙니다.** 관리자
콘솔에 cache write 요율 컨트롤이 없으므로, override 경로를 만들면 아무도 볼 수
없는 가격을 움직이게 됩니다.

## 5. 예약 — entitlement가 아니라 operational guardrail

캐시 marker를 다는 요청은 최악의 경우 **prompt 전체**를 1.25배로 씁니다(첫
turn이 정확히 그렇습니다). 그래서 요청이 나가기 **전에** provider budget이 그
0.25배 premium을 승인해야 합니다. 정산에서 발견하는 것은 돈이 나간 뒤에
발견하는 것입니다.

- `ChatBudget.promptCacheWriteReservedPremiumMicroUsd`.
- **premium**만 더합니다(전체 write 비용이 아니라). 같은 토큰이 이미 base input
  요율로 예약돼 있으므로 전체를 더하면 base를 두 번 셉니다.
- 캐시하지 않는 turn의 산술은 **한 글자도 바뀌지 않습니다**.
- **`usageCredits`에는 절대 닿지 않습니다.** cache write는 Anthropic에 대한
  Tomverse의 비용이지 사용자가 요청한 것도 볼 수 있는 것도 아닙니다. 여기에
  entitlement를 청구하면 `docs/policy/credit-and-cost-limits.md`가 credit 층에서
  몰아내려고 만들어진 바로 그 "숨은 USD 한도"가 됩니다.
- 예약이 과다하면 정산에서 환불됩니다. 과소하면 이미 요청이 나간 뒤입니다.

`createChatBudget`의 `promptCachePath`와 `getModelGenerationSettings`의
`promptCachePath`는 **같은 값이어야 합니다.**
`tests/anthropicPromptCaching.test.mjs`가 두 literal이 일치하는지 고정합니다.

## 6. Snapshot에 무엇을 남기는가

`pricingSnapshot`에 요율과 TTL을 **함께** 남깁니다.

- `cacheWriteUsdPerMillionTokens` — 이 turn이 예약된 시점의 요율. 정산은
  registry를 다시 읽지 않습니다(가격 변경 비소급, §3).
- `cacheWriteInputTokens`, `cacheWriteInputCostMicroUsd`,
  `unpricedCacheWriteTokens`.
- `promptCacheTtl` — 요율만으로는 무엇을 샀는지 알 수 없습니다. 5분 write와
  1시간 write는 서로 다른 것에 대한 서로 다른 가격이고, 요율만 있고 TTL이 없는
  snapshot은 그 자리에 없었던 사람이 재현할 수 없습니다.

## 7. Migration

`20260830090000_prompt_cache_write_accounting`. **additive이고 backfill이
없습니다.**

| 테이블 | 컬럼 |
|---|---|
| `ChatCreditReservation` | `settledCacheWriteInputTokens Int NOT NULL DEFAULT 0` |
| `ChatAttemptUsage` | `cacheWriteInputTokens Int?` |
| `ChatAttemptUsageAdjustment` | `observedCacheWriteInputTokens Int?` |
| `ProviderDailyUsage` | `cacheWriteInputTokens`, `cacheWriteInputCostMicroUsd` (둘 다 `NOT NULL DEFAULT 0`) |

이 migration 이전의 행에 0은 placeholder가 아니라 **참값**입니다 — 어떤 요청도
write 토큰을 만들 수 없었습니다. audit 성격 컬럼 둘은 형제 토큰 컬럼과 같은
"NULL = 아무도 관측하지 않음" 계약을 따르므로 nullable입니다.

되돌리기: 네 컬럼을 drop하면 됩니다. 기존 컬럼의 타입·nullability·default가
바뀌지 않고 제약이 추가·삭제되지 않습니다.

## 8. 측정은 아직 남아 있습니다

`npm run report:anthropic-cache-efficiency -- --days=7`은 **읽기 전용 도구가
구현됐다**는 뜻이지 절감이 관측됐다는 뜻이 아닙니다. 실제 hit rate와 절감액은
캐싱이 production에 배포되고 최소 7일의 완결된 UTC 일자가 쌓인 뒤에만 나옵니다.

보고서가 두 숫자를 **분리해서** 표시하는 것도 같은 이유입니다.

- **Usage API 기반 list-price 추정치** — 토큰 수 × 공개 요율.
- **Cost API의 실제 청구 총액** — 계약 할인·세금이 반영된 값.

둘이 같다고 주장하지 않습니다. 차이는 결함이 아니라 할인일 수 있고, 그것을
이 저장소가 알 수 없습니다.
