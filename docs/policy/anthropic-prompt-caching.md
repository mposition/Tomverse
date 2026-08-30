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
| `chat_turn` | **O** | turn N+1이 turn 1..N을 그대로 재전송 |
| `chat_turn_native_search` | X | server tool의 agentic loop가 반복마다 캐시를 다시 씀 — §2.3 |
| `chat_fallback_turn` | X | 1차 범위 제외 — §2.2 |
| `comparison_review` | X | 1차 범위 제외 — §2.2 |
| `comparison_review_verify_item` | X | 항목 1건당 1회, 그 항목으로 만든 prompt |
| `compare_summary` | X | 1차 범위 제외 — §2.2 |
| `conversation_title` | X | 대화당 1회. 두 번째 요청이 없음 |
| `provider_probe` | X | 최소 prefix 미달 + probe에 parameter 추가는 두 번 장애로 기록됨 |
| `provider_verification` | X | 고정된 짧은 일회성 요청 |
| `memory_extraction` | X | 대화당 1회, 매번 다른 transcript |

## 2.2 1차 출시 범위는 `chat_turn` 하나입니다

처음 작성 시 `true`였던 네 경로가 지금 `false`입니다. **prefix가 나빠서가
아니라, 경로 하나에 세 부분이 필요한데 두 경로에만 배선돼 있었기 때문**입니다.

1. `createChatBudget(..., { promptCachePath })` — provider budget이 1.25배
   write premium을 **요청 전에** 승인
2. `getModelGenerationSettings(..., { promptCachePath })` — 요청이 marker를 실음
3. `settleChatUsage(..., { cacheWriteInputTokens })` — write를 1.25배로 정산

`comparison_review`·`comparison_review_verify_item`·`compare_summary`는 (2)만
있고 (1)과 (3)이 **둘 다 없었습니다.** 승인받지 않은 budget에 marker를 보내고,
그 결과 생긴 write를 일반 input 요율로 정산했을 것입니다.

**두 결함 모두 조용합니다.** 과소 승인된 turn도 dispatch되고(거절되지 않음),
과소 청구된 turn도 정산됩니다(숫자가 그럴듯함). 아무것도 raise하지 않고
아무것도 로그를 남기지 않으며, 증상은 몇 주 뒤 provider 청구서와 내부 원장이
안 맞는 것뿐입니다.

**나머지 둘을 배선하는 대신 끄는 것이 답인 이유**는, 각 경로가 기대던 prefix
논거도 증명되지 않았기 때문입니다(아래). 검증되지 않은 것 두 개를 동시에 켜는
것은 출시가 아닙니다.

경로별 근거:

- **`comparison_review`** — "한 comparison은 여러 번 리뷰된다"는 재실행을
  말하는데, **재실행은 provider에 닿지 않습니다.** 저장된 `ComparisonReview`
  행이 input hash로 키잉돼 DB에서 답하므로, prompt cache를 읽었을 그 두 번째
  요청이 바로 일어나지 않는 요청입니다.
- **`compare_summary`** — review와 답변 내용을 공유하지만, "다른 요청과 내용을
  공유"와 "prefix를 반복"은 다릅니다. 캐싱은 tools → system → messages 순
  **바이트 prefix 일치**이고, summary의 system prompt와 지시문은 review의 것과
  **첫 토큰부터 다릅니다.** 두 렌더링된 prefix를 아무도 비교하지 않았습니다.
- **`chat_fallback_turn`** — "자기 entry를 이전 turn에서 읽는다"는 같은 대화가
  같은 모델로 5분 안에 두 번 fallback해야 성립하고, 그 빈도를 아무도 측정하지
  않았습니다. 자동 fallback은 설계상 드물므로 실제 모양은 **fallback마다 write,
  read는 0** — 이미 더 오래 기다린 turn에 1.25배 할증입니다.

`tests/anthropicPromptCachingWiring.test.mjs`가 `caches: true`인 경로에 셋 중
하나라도 없으면 실패합니다. gap이 조용히 다시 열릴 수 없습니다.

## 2.3 native web search turn은 예약이 안전하지 않습니다

`chat_turn_native_search`가 꺼진 이유는 **prefix 논거가 아니라 예약 안전성
논거**입니다. prefix는 다른 chat turn과 똑같이 반복됩니다.

Anthropic 공식 문서(`Tool use with prompt caching` → *Server tool results are
cached automatically*):

> "When your request has prompt caching enabled and Claude uses a server tool
> such as web search, web fetch, or code execution, **the API automatically
> places a cache breakpoint on the server tool result before running the next
> iteration of the agentic loop.**"
>
> "**This behavior only applies when your request already has at least one
> `cache_control` marker.** Requests without prompt caching do not receive the
> automatic breakpoint."

두 번째 문장이 핵심입니다. **marker가 그 write를 허용하는 게 아니라
발생시킵니다.** marker가 없으면 자동 breakpoint 자체가 없습니다.

그리고 그 write는 **loop 반복마다 하나씩**, **검색 결과가 더해져 커진 prefix
전체**에 대해 일어납니다. 이 앱의 예약은 `0.25 × 추정 입력 토큰` —
**prompt를 한 번 쓰는 것의 상한**이지, **계속 커지는 prompt를 N번 쓰는 것의
상한이 아닙니다.** 검색 상한이 5회면 write가 최대 6번까지 날 수 있고, 각각이
직전보다 큽니다.

`ephemeral_5m_input_tokens`로 보고되므로 우리가 1시간 TTL을 지정했더라도 5분
write로 잡힙니다(같은 문서).

**다시 켜는 조건은 §2.1과 다릅니다.** prefix 반복은 이미 성립하므로, 필요한
것은 **강제된 검색 질의 상한에서 한 turn이 만들 수 있는 write 토큰의 증명된
천장**입니다. 그 천장이 나오면 예약 산식을
`0.25 × 입력 × (1 + maxQueries)` 같은 형태로 고치고 함께 켭니다.

## 2.1 다시 켜는 조건

`false`를 `true`로 바꾸려면 **다음을 테스트로 증명**해야 합니다.

1. **바이트 단위로 동일한 렌더링 prefix**가 두 번의 실제 dispatch에 나타날 것.
   렌더링 순서(tools → system → messages)대로 실제 전송 payload를 비교합니다.
2. **같은 Anthropic 모델**일 것. 캐시는 model-scoped이므로 모델이 다르면 같은
   prefix라도 읽지 못합니다.
3. **provider에 실제로 도달하는 정상 실행 경로**일 것.
4. 세 배선(§2.2의 1·2·3)이 모두 존재할 것 — wiring 테스트가 강제합니다.

**근거로 인정하지 않는 것:**

- **DB `inputHash` cache로 provider 호출이 생략되는 재실행.** 캐시를 읽었을
  요청이 발생하지 않으므로, 그 재실행은 prompt cache에 대해 아무것도 말하지
  않습니다. `tests/comparisonReviewCacheCompatibility.test.mjs`가 지키는 것이
  바로 그 DB 캐시입니다 — 두 캐시는 서로 다른 층입니다.
- **대칭성 논거**("primary가 캐시하니 fallback도").
- **내용 공유 논거**("같은 답변을 담으니 prefix도 같을 것").

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
  production 사실**입니다. 측정 전에 2배 write를 고르는 것은 추측입니다.

TTL은 요청에 **명시**합니다(`{ type: "ephemeral", ttl: "5m" }`). 기본값에
맡기지 않는 이유는 값이 요청 바이트에 들어가야 manifest의
`effectiveRequestHash`에 반영되고, 나중에 저장된 turn이 어떤 TTL로 나갔는지를
배포 날짜로 추론하지 않아도 되기 때문입니다.

## 3.1 7일 보고서는 1시간 TTL을 결정하지 못합니다

이전 문서는 `npm run report:anthropic-cache-efficiency`가 TTL 질문에 답할
도구라고 적었습니다. **틀렸습니다.** 그 보고서는 **일자 × 모델**로 집계하는데,
TTL 결정이 걸린 값은 **prefix를 공유하는 연속 요청 사이의 start-to-start
간격**입니다.

일별 합계는 하루에 고르게 퍼진 트래픽과 12시간 떨어진 두 번의 버스트를
**구분하지 못합니다** — 둘 다 같은 행을 만듭니다. bucket을 `1h`로 좁혀도
마찬가지입니다: 같은 시간 bucket 안의 두 요청이 같은 prefix를 공유했는지,
서로 다른 대화였는지 usage report는 말하지 않습니다.

**보고서가 실제로 말할 수 있는 것**은 hit rate와 read/write 비율, 즉 *지금
5분으로* 캐시가 얼마나 잡히고 있는가입니다. read/write 비율이 낮다는 것은
"entry가 읽히기 전에 만료된다"의 **후보 설명 중 하나**일 뿐이고, 다른 설명
(prefix가 매번 달라짐, 최소 길이 미달, workspace 분리)과 구분되지 않습니다.

### 5분 캐시의 경제성 판정 기준

- **read/write 비율 손익분기는 `0.25 / 0.9 ≈ 0.278`**입니다. 토큰 하나를 한 번
  쓰고 R번 읽으면 캐시가 `1.25 + 0.1R`, 캐시 없이 `1 + R`이므로
  `1.25 + 0.1R = 1 + R` → `R = 0.25/0.9`. **0.25가 아닙니다** — 0.25는 read가
  공짜일 때만 맞고, read는 0.1배를 냅니다. 상수는
  `CACHE_5M_BREAK_EVEN_READ_RATIO`에 나눗셈 그대로 둡니다.
- **판정은 `listPriceSavingUsd > 0`으로 합니다.** 비율은 모델과 무관하게 토큰을
  똑같이 세므로, 비싼 모델과 싼 모델이 섞인 기간은 임계값을 넘고도 손해일 수
  있습니다. 비율은 **왜 그런지**를 보는 진단값이고, 절감액이 **그래서 이득인지**
  를 답하는 값입니다.
- 즉 기준은 두 개이며 순서가 있습니다: `listPriceSavingUsd > 0`이 판정,
  `read/write > 0.278`이 그 판정을 설명하는 보조 지표.

### 답할 수 있는 설계 두 가지

**(A) privacy-safe prefix digest 기반 재호출 간격 히스토그램**

- 각 dispatch에서 **cache breakpoint까지의 렌더링된 prefix**에 대해 keyed
  digest를 계산합니다. 키는 `lib/manifestHashKeyring.ts`의 것을 쓰고 —
  세션 secret이 아닙니다 — bare SHA-256을 쓰지 않습니다. 짧은 prefix는 사전
  공격으로 복원되고, 그것이 manifest가 이미 keyed digest를 쓰는 이유입니다.
- **저장하는 것은 `(digest, path, modelId, dispatchedAt)` 넷뿐**입니다. prompt
  본문도, 대화 ID도, 사용자 ID도 아닙니다. `ContextManifest`가 "보내진 것을
  증명하되 사본을 두지 않는다"로 이미 푼 문제와 같은 모양입니다.
- 같은 digest의 연속 dispatch 간격을 히스토그램으로 냅니다. **5분 이하 / 5–60분
  / 1시간 초과** 세 구간의 비율이 곧 답입니다 — 두 번째 구간이 의미 있게 크면
  1시간 TTL이 값을 하고, 아니면 하지 않습니다.
- 보존 기한은 manifest와 같게 두고, digest는 키 회전 시 재계산하지 않습니다
  (회전 전 간격은 회전 전 키로만 비교 가능).
- **비용 0**: provider 호출이 없습니다. 이미 만들고 있는 요청을 관찰만 합니다.

**(B) 5m/1h canary 분할**

- `chat_turn`의 안정적인 소수 비율(예: 5%)을 `ttl: "1h"`로 dispatch하고 나머지는
  5분으로 둡니다. 배정은 **대화 단위**로 고정해야 합니다 — turn마다 흔들면 두 arm이
  서로의 entry를 무효화합니다.
- 두 arm의 `cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens` / `cache_read_input_tokens`를 usage report에서
  **arm별로** 읽습니다. `speed`와 달리 TTL은 group-by 차원이 아니므로, arm을
  분리하려면 **arm마다 다른 API key 또는 workspace**가 필요합니다. 그것이 이
  설계의 진짜 선행 조건입니다.
- 판정: 1h arm의 `(추가 write 비용) < (추가 read로 아낀 비용)`이면 채택.
- **비용이 있습니다**: canary arm은 2배 write를 실제로 지불합니다. (A)를 먼저
  하고, (A)가 5–60분 구간이 크다고 말할 때만 (B)로 확인하는 순서를 권합니다.

둘 중 어느 것도 하기 전에는 5분을 유지합니다.

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

**컬럼은 5개입니다** — 토큰 4개 + 비용 1개.

| # | 테이블 | 컬럼 | 형 |
|---|---|---|---|
| 1 | `ChatCreditReservation` | `settledCacheWriteInputTokens` | `Int NOT NULL DEFAULT 0` |
| 2 | `ChatAttemptUsage` | `cacheWriteInputTokens` | `Int?` |
| 3 | `ChatAttemptUsageAdjustment` | `observedCacheWriteInputTokens` | `Int?` |
| 4 | `ProviderDailyUsage` | `cacheWriteInputTokens` | `Int NOT NULL DEFAULT 0` |
| 5 | `ProviderDailyUsage` | `cacheWriteInputCostMicroUsd` | `Int NOT NULL DEFAULT 0` |

> **migration 파일 자신의 주석은 "Three token columns and one cost column"으로
> 하나 적게 셉니다.** 틀렸고, **고치지 않습니다.** Prisma는 적용된 migration의
> 내용 checksum을 `_prisma_migrations`에 기록하므로, 주석 한 줄만 바꿔도 이미
> 적용한 모든 환경에서 `migrate deploy`가 drift로 실패합니다. **적용된
> migration 파일은 내용이 무엇이든 불변**이고, 정정은 여기에 둡니다.

이 migration 이전의 행에 0은 placeholder가 아니라 **참값**입니다 — 어떤 요청도
write 토큰을 만들 수 없었습니다. audit 성격 컬럼 둘(2·3)은 형제 토큰 컬럼과 같은
"NULL = 아무도 관측하지 않음" 계약을 따르므로 nullable입니다.

### 7.1 롤백 — 코드와 schema는 함께 되돌아가지 않습니다

이전 문서는 "`git revert`로 되돌리면 된다"고 적었습니다. **틀렸습니다.**
`git revert`는 **코드만** 되돌립니다. migration은 이미 실행된 DDL이고, revert
commit에는 그것을 취소하는 SQL이 없으므로 **컬럼 5개는 DB에 그대로 남습니다.**

**기본 운영 롤백은 코드만 되돌리고 컬럼은 남겨 두는 것입니다.**

1. 코드 롤백(revert 또는 이전 릴리스 재배포).
2. **컬럼 5개는 그대로 둡니다.** 전부 additive이고, 넷은 nullable이거나
   `DEFAULT 0`이라 이전 코드가 INSERT할 때 값을 주지 않아도 됩니다. 이전 코드는
   이 컬럼들을 읽지도 쓰지도 않으므로 남아 있어도 **아무 동작에도 영향이
   없습니다.**
3. 그 상태에서 `prisma migrate deploy`는 통과합니다 — 적용 이력이 남아 있고
   파일도 그대로이므로 checksum이 맞습니다. 반면 `schema.prisma`만 되돌린 코드와
   비교하면 `db:compare-schema`가 이 5개를 drift로 보고합니다. **예상된
   결과이며**, 롤백 상태에서는 그 보고를 그대로 읽으면 됩니다.

**정말 컬럼을 지워야 한다면 별도의 forward migration입니다.**

- 새 timestamp의 새 migration 디렉터리에 `DROP COLUMN` 5개를 씁니다.
- 기존 migration 파일은 **건드리지 않습니다**(checksum).
- 되돌리기 전에 그 컬럼에 실제 데이터가 있는지 확인합니다 — 캐싱이 한 번이라도
  production에서 돌았다면 `settledCacheWriteInputTokens`와
  `ProviderDailyUsage.cacheWriteInput*`에는 **재구성 불가능한 정산 이력**이
  들어 있습니다. drop은 그 이력을 지웁니다.
- 그래서 기본값은 **남겨 두기**입니다. 쓰이지 않는 컬럼 5개의 비용은 0에
  가깝고, 지운 정산 이력은 돌아오지 않습니다.

## 8. 측정은 아직 남아 있습니다

`npm run report:anthropic-cache-efficiency -- --days=7`은 **읽기 전용 도구가
구현됐다**는 뜻이지 절감이 관측됐다는 뜻이 아닙니다. 실제 hit rate와 절감액은
캐싱이 production에 배포되고 최소 7일의 완결된 UTC 일자가 쌓인 뒤에만 나옵니다.

보고서가 두 숫자를 **분리해서** 표시하는 것도 같은 이유입니다.

- **Usage API 기반 list-price 추정치** — 토큰 수 × 공개 요율.
- **Cost API의 실제 청구 총액** — 계약 할인·세금이 반영된 값.

둘이 같다고 주장하지 않습니다. 차이는 결함이 아니라 할인일 수 있고, 그것을
이 저장소가 알 수 없습니다.
