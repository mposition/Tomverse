# 가격 검증 — claude-fable-5 (이슈 #244)

공식 문서만 근거로 씁니다. 검색 요약, 블로그, 3자 집계는 근거로 쓰지 않았고,
provider API를 호출하지도 않았습니다.

| | |
|---|---|
| 대상 | `claude-fable-5` (Tomverse 모델 ID = provider API ID) |
| 검증 시각 | 2026-08-04 |
| 근거 1 | `https://platform.claude.com/docs/en/about-claude/pricing` |
| 근거 2 | `https://platform.claude.com/docs/en/about-claude/models/overview` |
| 접근 경로 | `docs.claude.com/...`은 302로 `platform.claude.com/...`으로 이동 |

## 1. 체크리스트 대조

이슈 #244의 항목을 그대로 따라갑니다. `lib/modelPricing.ts`의 현행 profile은
2026-08-03에 등록됐고, 이번 검증은 그 값이 공식 표와 일치하는지를 확인한
것입니다.

| 항목 | 공식 문서 | 현행 profile | 결과 |
|---|---|---|---|
| provider apiModel | Claude API ID·alias 모두 `claude-fable-5` | `apiModelId: "claude-fable-5"` | 일치 |
| 1st-party endpoint·처리 tier | Claude API 직접 호출, 기본 global 라우팅 | `DIRECT_STANDARD` | 일치 |
| input | `$10 / MTok` | `flatTier(10, …)` | 일치 |
| cached input | `Cache Hits & Refreshes $1 / MTok` (= 0.1x) | `cachedInputPriceMultiplier: 0.1` | 일치 |
| output·reasoning | `$50 / MTok`, adaptive thinking always on | `50`, `reasoningTokenBilling: "billed_as_output"` | 일치 |
| 장문 tier | "Claude 4.6 and later models … include the full 1M token context window at standard pricing" | 단일 tier(`flatTier`) | 일치 |
| search·tool 과금 | web search `$10 per 1,000 searches` | `nativeSearchCostMicroUsdPerQuery: 10_000` | 일치 |
| max output | `128k tokens` | `maxOutputTokens: 128_000` | 일치 |
| reservation output | — | `8_192` / `conservative_default` | 아래 §3 |
| 명시적 profile 존재 | — | 있음 | 충족 |
| PENDING register 제거 | — | 애초에 등재된 적 없음 | 해당 없음 |
| `npm run check:model-pricing` | — | 통과 | 충족 |

검증 결과 **가격 자체는 바꿀 것이 없습니다.** 등록돼 있던 값이 공식 표와
전부 일치합니다. `cachedInputPricingVerified: true`는 이번에 실제 근거를
갖게 됐습니다.

## 2. 이번에 바꾼 것

### 2.1 cache write 요율 기록

공식 표의 5분 cache write 요율을 profile에 넣었습니다. 정책상 **기록만 하고
과금하지 않습니다**(`CACHE_WRITE_PRICING_IS_RECORDED_NOT_BILLED`) — cache
write 토큰을 보고하는 usage adapter가 없기 때문입니다.

| 모델 | 5분 write | 1시간 write | 기록한 값 |
|---|---|---|---|
| Claude Fable 5 | `$12.50 / MTok` | `$20 / MTok` | `12.5` |
| Claude Opus 5 | `$6.25 / MTok` | `$10 / MTok` | `6.25` |

`claude-opus-4-8`(upstream이 `claude-opus-5`)도 같은 페이지에서 함께 확인돼
포함했습니다. **`pricingVersion`은 올리지 않았습니다** — 이 값은 해석에
쓰이지 않아 과금되는 가격이 1µUSD도 달라지지 않습니다. 버전을 올리면 비용이
바뀐 것처럼 snapshot에 남습니다.

### 2.2 `inference_geo` 를 request-side 검사에 추가

검증 중 발견한 실제 공백입니다. 공식 문서:

> For Claude 4.6 and later models, specifying US-only inference through the
> `inference_geo` parameter incurs a 1.1x multiplier on all token pricing
> categories, including input tokens, output tokens, cache writes, and cache
> reads.

이 저장소가 라우팅하는 Anthropic 모델은 전부 4.6 이후입니다. 즉
`inference_geo: "us"` 한 줄이 추가되면 **모든 Anthropic 예약이 실제 원가보다
10% 낮게** 잡히고, 아무 검사도 실패하지 않습니다. OpenAI `service_tier`를
막는 기존 검사와 정확히 같은 위험이라 같은 allowlist로 묶었습니다.

- 현재 코드베이스에 `inference_geo` 사용처는 **없습니다**(`git grep` 확인).
- 임시 파일로 검사가 실제로 실패하는 것을 확인한 뒤 삭제했습니다.

## 3. 반영하지 않은 것과 그 이유

- **`reservationOutputTokens`를 p90/p95로 바꾸지 않았습니다.** 이슈 체크리스트는
  production p90/p95를 쓰라고 하지만, `docs/policy/default-model-luna-migration.md`
  3.1이 `reservationOutputBasis`를 바꿀 때 요구하는 9개 조건(모델별 독립 산출,
  기간·표본 수, workload 분리, 정산된 출력·과금 reasoning 토큰, 중단·부분 응답
  포함, 동질 표본, 감사 보관, 안전 여유·floor, drift 감시)을 충족하는 데이터가
  없습니다. 정책이 그 전까지 `conservative_default` 유지를 요구하므로 그대로
  뒀습니다. 이 항목만 이슈에서 열린 채로 남습니다.
- **tokenizer 변화는 가격이 아닙니다.** Fable 5는 Opus 4.7 tokenizer를 쓰며
  같은 텍스트가 약 30% 더 많은 토큰이 됩니다. 토큰당 단가가 아니라 토큰 수의
  문제라 profile은 바뀌지 않지만, 예약량 재산정 시 고려해야 할 사실이라
  여기 적어 둡니다.
- **Batch·Fast mode 가격은 넣지 않았습니다.** Batch는 이 앱이 쓰지 않고, Fast
  mode는 Opus 5·4.8 전용이라 Fable 5에 존재하지 않습니다.
- **Bedrock·Google Cloud·Foundry 경유 가격은 대상이 아닙니다.** 요청은
  `api.anthropic.com` 직접 호출입니다(`DIRECT_STANDARD`).

## 4. 다른 열린 가격 이슈

#246(mistral-large-3), #247(qwen3.7-max), #248(perplexity/sonar-deep-research),
#256(GLM-5.2)은 이번에 다루지 않았습니다. `docs.mistral.ai`는 이 환경에서
HTTP 403이었고, 나머지도 각자의 공식 도메인 접근을 먼저 확인해야 합니다.
`PENDING_VERIFIED_PRICE_REGISTER`의 세 모델은 기한이 2026-10-30로 아직
87일 남아 있습니다.
