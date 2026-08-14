# 이미지 모델 가격 검증 워크시트

확인일: **2026-08-04**

확인 범위: Google Gemini Developer API와 xAI Inference API의 공식 문서

검증 방식: 공식 문서 본문 대조와 보수적 최악 원가 계산. **유료 provider 호출은
하지 않았으며, 계정별 모델 가시성·실호출 가능 여부는 확인하지 않았다.**

## 0. 결론

> **2026-08-04 승인자 결정 반영.** 아래 A-2 유도는 **채택하지 않았다.**
> 결정 근거와 후속 절차는 `docs/policy/image-generation.md` §12.1에 있다.
> 이 문서는 그날 확인한 사실의 기록으로 그대로 보존한다.

이번 확인으로 네 후보의 공개 가격과 정적 사양은 공식 문서에서 확인됐다.
Google 3종은 직접 thinking을 끌 수 없다. 모델 카드의 출력 토큰 상한 전체를
`text and thinking` 단가로 계산하는 보수적 방법이 §A-2에 있으나, **채택되지
않았다** — GenerateContent API가 `totalOutputTokens`와 `totalThoughtTokens`를
별도 필드로 두므로, hidden thinking이 그 상한 안에 포함되지 않는다면 이
계산은 과대 추정이 아니라 상한 자체가 아니게 된다.

| 모델 | 이미지 출력가 | 요청당 상한 | 수학적 최소 크레딧 | 상태 |
|---|---|---|---:|---|
| `grok-imagine-image-quality-20260403` | **확인 완료** | **확인 완료** (토큰 과금 없음) | 1K **62**, 2K **84** | 판매가 승인(75/100). adapter·budget·계정 가시성 확인 후 1K부터 출시 |
| `gemini-3.1-flash-image` | **확인 완료** | **조건부 — 미확정** | (유도 시 1K 190) | 공급자 확인 대기 |
| `gemini-3.1-flash-lite-image` | **확인 완료** | **조건부 — 미확정** | (유도 시 1K 50) | 공급자 확인 대기 |
| `gemini-3-pro-image` | **확인 완료** | **조건부 — 미확정** | (유도 시 592/710) | 공급자 확인 대기 + 제품 판단 보류 |

Google 3종의 상태는 **가격 확인 완료 / 요청당 상한 조건부**로 분리해 둔다.
괄호 안 최소 크레딧은 미채택 유도에 근거한 값이므로 판매가 산정에 쓰지
않는다.

따라서 이 워크시트만으로 `disabledReason`을 즉시 `null`로 바꾸면 안 된다.
§D의 운영·구현 gate와 판매 크레딧 승인이 모두 끝난 모델만 활성화한다.

---

## A. Google 3종의 thinking·text 비용 상한

### A-1. 요청에서 직접 thinking 상한을 거는 방법

- [ ] `generationConfig.maxOutputTokens`가 이미지 생성 모델의 thinking 토큰만
      별도로 제한한다는 모델별 보장은 확인되지 않았다.
- [x] `gemini-3.1-flash-image`는 `thinking_level`의 `minimal`·`high`를 받는다.
      이는 수준 선택이지 숫자 토큰 상한이 아니다.
- [ ] `thinkingBudget: 0`으로 thinking을 끌 수 없다. 이미지 생성 문서는
      thinking이 기본 활성화되고 API에서 비활성화할 수 없다고 명시한다.

판정: **A-1을 가격 상한 근거로 사용하지 않는다.** `thinking_level=minimal`은
지연·평균 비용 최적화에는 쓸 수 있지만 최악 원가 증명은 아니다.

근거:

- URL: https://ai.google.dev/gemini-api/docs/image-generation
- 확인일: 2026-08-04
- 원문 발췌: “enabled by default and cannot be disabled in the API.”

### A-2. 모델 카드의 하드 출력 상한

모델 카드의 `Output token limit` 전체에 Standard의 `text and thinking` 단가를
곱한다. 이미지 전용 응답을 요청하더라도, 이 상한 전부가 과금 가능한 thinking
또는 text 토큰이라고 가정한다. Google의 token 문서는 context window가 모델이
생성할 수 있는 출력량을 정한다고 설명하고, thinking 사용 시 응답 가격은 output
토큰과 thinking 토큰의 합이라고 설명한다. 이 두 문장과 모델별 출력 상한을
결합한 **보수적 추론**이며, 공식 문서가 같은 문장 안에서 “hidden thinking이
반드시 output token limit에 포함된다”고 표현한 것은 아니다.

| 모델 | 최대 출력 토큰 | Standard text/thinking 단가 | `thinkingCapMicroUsd` |
|---|---:|---:|---:|
| `gemini-3.1-flash-image` | 32,768 | $3.00 / 1M | **98,304µUSD** |
| `gemini-3.1-flash-lite-image` | 4,096 | $1.50 / 1M | **6,144µUSD** |
| `gemini-3-pro-image` | 32,768 | $12.00 / 1M | **393,216µUSD** |

계산:

```text
Flash:      32,768 × $3.00 / 1,000,000 = $0.098304 = 98,304µUSD
Flash Lite:  4,096 × $1.50 / 1,000,000 = $0.006144 =  6,144µUSD
Pro:        32,768 × $12.00 / 1,000,000 = $0.393216 = 393,216µUSD
```

입력 단가는 각각 $0.50, $0.25, $2.00 / 1M tokens다. Tomverse의 1,000-token
prompt budget 5,000µUSD는 실제 최대 입력비 500µUSD, 250µUSD, 2,000µUSD보다
크므로 기존 공통 budget을 그대로 쓰는 것이 보수적이다.

모델 카드 근거:

| 모델 | URL | 확인일 | 원문 발췌 |
|---|---|---|---|
| Flash | https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image | 2026-08-04 | “Output token limit 32,768” |
| Flash Lite | https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image | 2026-08-04 | “Output token limit 4,096” |
| Pro | https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image | 2026-08-04 | “Output token limit 32,768” |

가격 근거:

- URL: https://ai.google.dev/gemini-api/docs/pricing
- 확인일: 2026-08-04
- 원문 발췌: “Output price … $3 (text and thinking) … $1.50 … $12.00.”
- 위 페이지의 각 모델 Standard 표에서 입력·이미지 출력 단가도 함께 대조했다.

출력 상한 해석 근거:

- URL: https://ai.google.dev/gemini-api/docs/generate-content/tokens
- 확인일: 2026-08-04
- 원문 발췌: “The context window defines … how much output the model can generate.”
  “response pricing is the sum of output tokens and thinking tokens.”

판정: 이 워크시트가 제시한 A-2 기준에서는 Google 3종의 최악 요청 원가를
유한하게 계산할 수 있다.

> **승인자 결정(2026-08-04): 채택하지 않는다.** GenerateContent API 스키마가
> `totalOutputTokens`와 `totalThoughtTokens`를 별도 필드로 두고
> `maxOutputTokens`를 response candidate의 한도로 설명하므로, hidden thinking이
> `output_token_limit` 안에 포함된다는 보장이 없다. 포함되지 않으면 이 계산은
> 보수적 상한이 아니라 상한이 아니다. Google 3종은 보류를 유지하고, 공급자
> 답변을 받아 `priceVerification.sources`에 추가한다. 질문 문구는 정책
> §12.1에 있다.

---

## B. Google 3종 — 가격과 사양

### B-1. `gemini-3.1-flash-image`

- 정확한 API 모델 ID: `gemini-3.1-flash-image`
  - 모델 카드가 Stable ID로 명시한다.
- Standard 이미지 출력 가격:
  - 0.5K: $0.045
  - 1K: **$0.067**
  - 2K: **$0.101**
  - 4K: **$0.151**
- 지원 크기: `512`, `1K`, `2K`, `4K`
- 지원 화면비: `1:1`, `1:4`, `1:8`, `2:3`, `3:2`, `3:4`, `4:1`,
  `4:3`, `4:5`, `5:4`, `8:1`, `9:16`, `16:9`, `21:9`
- 출력 MIME:
  - 이미지 생성 가이드의 요청 예제로 `image/jpeg`, `image/png`가 확인된다.
  - Tomverse adapter는 둘 중 하나를 요청에 고정하고 실제 응답의 MIME을
    저장해야 한다. `image/webp`는 content block enum에는 있으나 이 모델의
    선택 가능한 출력으로 명시되지 않았으므로 실호출 전에는 보장하지 않는다.
- provenance: 모든 생성 이미지에 SynthID watermark가 포함된다.
- thinking: 끌 수 없음. Flash는 `minimal`·`high` 수준 선택 가능.

### B-2. `gemini-3.1-flash-lite-image`

- 정확한 API 모델 ID: `gemini-3.1-flash-lite-image`
  - 모델 카드가 Stable ID로 명시한다.
- Standard 이미지 출력 가격(1K): **$0.0336**
- 1K 전용 여부: **맞음.** 모델 카드는 `1024px (1K)`만 지원하며 2K·4K는
  미지원이라고 명시한다.
- 지원 화면비: 공식 모델 카드는 14개 화면비 지원을 명시한다. 공통 API enum은
  `1:1`, `1:4`, `1:8`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:4`,
  `8:1`, `9:16`, `16:9`, `21:9`를 제공한다.
- 출력 MIME: B-1과 같은 Interactions API 계약. adapter에서 요청 MIME을
  `image/jpeg` 또는 문서 예제로 확인된 `image/png`로 고정한다.
- provenance: **SynthID always on + C2PA watermarking**.

### B-3. `gemini-3-pro-image`

- 정확한 API 모델 ID: `gemini-3-pro-image`
  - 모델 카드가 Stable ID로 명시한다.
- Standard 이미지 출력 가격:
  - 1K·2K: **$0.134**
  - 4K: **$0.24**
- 지원 크기: `1K`, `2K`, `4K`
- 지원 화면비: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`,
  `9:16`, `16:9`, `21:9`
- 출력 MIME: B-1과 같은 Interactions API 계약.
- provenance: 모든 생성 이미지에 SynthID watermark가 포함된다.
- 제품 상태: 가격 검증과 무관하게, `gpt-image-2` Final과의 중복 때문에
  기존 보류 결정을 유지한다.

공통 사양·provenance 근거:

- URL: https://ai.google.dev/gemini-api/docs/image-generation
- 확인일: 2026-08-04
- 원문 발췌: “All generated images include a SynthID watermark.”

Flash Lite의 추가 provenance 근거:

- URL: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image
- 확인일: 2026-08-04
- 원문 발췌: “SynthID (Always On) + C2PA watermarking.”

가격 근거:

- URL: https://ai.google.dev/gemini-api/docs/pricing
- 확인일: 2026-08-04
- 각 모델의 Standard 표에서 위 per-image 값과 text/thinking 단가를 확인했다.

---

## C. xAI Grok Imagine Image Quality

- 정확한 API 모델 ID(날짜 스냅샷):
  **`grok-imagine-image-quality-20260403`**
  - 공식 모델 페이지의 alias 목록에 날짜 스냅샷과 `-latest`가 함께 나온다.
  - 문서상 요청 가능한 alias임은 확인했지만 Tomverse xAI key로 실제 호출하지
    않았다. 활성화 전 `GET /v1/image-generation-models`와 1회 staging 호출로
    계정 가시성을 확인한다.
- 이미지 가격:
  - 1K: **$0.05 / image**
  - 2K: **$0.07 / image**
- 프롬프트 text 토큰 별도 과금: **없음.** text-to-image는 prompt 길이와
  무관한 고정 per-image 가격이다.
- thinking·reasoning 토큰 별도 과금: **없음.** 공개 가격 계약은 생성 이미지
  단위 고정 요금이며 별도 reasoning 항목이 없다. `thinkingCapMicroUsd = 0`.
- 지원 크기: `1k`, `2k`
- 지원 화면비: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`,
  `2:1`, `1:2`, `19.5:9`, `9:19.5`, `20:9`, `9:20`, `auto`
- 응답 형식과 MIME:
  - 기본은 임시 URL, `response_format="b64_json"`으로 base64 요청 가능
  - 공식 REST 응답 예제는 `mime_type: "image/jpeg"`를 반환한다.
  - adapter는 응답의 `mime_type`을 신뢰하고 원본 bytes를 무변형 저장한다.
- provenance: 공식 xAI 문서에서 watermark·C2PA·기타 메타데이터 보장 문구를
  찾지 못했다. registry의 `provenance: []`를 유지한다.
- 엔드포인트와 요청 형식:
  - `POST https://api.x.ai/v1/images/generations`
  - `model`, `prompt`, 선택적 `aspect_ratio`, `resolution`, `response_format`
  - OpenAI client에 `base_url="https://api.x.ai/v1"`을 지정하는 공식 예제가
    있으므로 OpenAI Images API와 같은 형태다. 별도 xAI adapter는 여전히 필요하다.
- rate limit: 모든 tier에서 **5 requests/second**. TPM 표기는 없으며 공식
  문서에 별도 동시 요청 한도는 명시되지 않았다.

모델·가격 근거:

- URL: https://docs.x.ai/developers/models/grok-imagine-image-quality
- 확인일: 2026-08-04
- 원문 발췌: “Aliases grok-imagine-image-quality-20260403 … 1K $0.05 2K $0.07.”

고정 가격 계약 근거:

- URL: https://docs.x.ai/developers/model-capabilities/imagine
- 확인일: 2026-08-04
- 원문 발췌: “Image generation uses flat per-image pricing regardless of prompt length.”

요청·응답 형식 근거:

- URL: https://docs.x.ai/developers/model-capabilities/images/generation
- 확인일: 2026-08-04
- 원문 발췌: “Images are returned as URLs by default.”

MIME·REST 응답 근거:

- URL: https://docs.x.ai/developers/rest-api-reference/inference/images
- 확인일: 2026-08-04
- 원문 발췌: `"mime_type": "image/jpeg"`

rate limit 근거:

- URL: https://docs.x.ai/developers/rate-limits
- 확인일: 2026-08-04
- 표의 Image Generation / `grok-imagine-image-quality` 행에서 5 RPS를 확인했다.

---

## D. 정책 최소 크레딧 계산

정책식:

```text
maxRequestCostMicroUsd
  = imageOutputCostMicroUsd + 5,000µUSD prompt budget + thinkingCapMicroUsd

minimumCredits
  = ceil(maxRequestCostMicroUsd / 900µUSD)
```

| 모델 | 옵션 | 이미지 출력 | prompt budget | thinking 상한 | 최악 원가 | 최소 크레딧 |
|---|---|---:|---:|---:|---:|---:|
| `grok-imagine-image-quality-20260403` | 1K | 50,000 | 5,000 | 0 | 55,000 | **62** |
| `grok-imagine-image-quality-20260403` | 2K | 70,000 | 5,000 | 0 | 75,000 | **84** |
| `gemini-3.1-flash-image` | 1K | 67,000 | 5,000 | 98,304 | 170,304 | **190** |
| `gemini-3.1-flash-image` | 2K | 101,000 | 5,000 | 98,304 | 204,304 | **228** |
| `gemini-3.1-flash-image` | 4K | 151,000 | 5,000 | 98,304 | 254,304 | **283** |
| `gemini-3.1-flash-lite-image` | 1K | 33,600 | 5,000 | 6,144 | 44,744 | **50** |
| `gemini-3-pro-image` | 1K·2K | 134,000 | 5,000 | 393,216 | 532,216 | **592** |
| `gemini-3-pro-image` | 4K | 240,000 | 5,000 | 393,216 | 638,216 | **710** |

이 값은 판매가가 아니라 **수학적 바닥값**이다. 마진, 가격 drift, 환불 위험을
반영한 판매 크레딧은 제품 책임자가 별도로 승인해야 한다.

### 활성화 전 필수 작업

- [ ] 판매 크레딧 승인
- [ ] 선택 모델의 `prices`와 `thinkingCapMicroUsd` 반영
- [ ] `priceVerification.verifiedAt = "2026-08-04"`와 위 공식 URL 기록
- [ ] provider별 adapter 구현 및 실제 반환 MIME·usage·request ID 정규화
- [ ] `IMAGE_PROVIDER_XAI_*` 또는 `IMAGE_PROVIDER_GOOGLE_*` 일·월 budget을
      코드보다 먼저 staging/production에 배포
- [ ] provider별 execution concurrency 환경변수와 429 재시도 검증
- [ ] 인증된 provider key로 날짜 snapshot/model ID 가시성 확인
- [ ] 1회 staging 생성으로 원본 MIME, provenance, usage, 정산 원가 확인
- [ ] `npm run check:image-pricing`과 관련 registry/adapter 테스트 통과
- [ ] **budget floor가 새 모델을 실제로 반영하는지 확인.**
      `worstImageCostPerCreditMicroUsd()`는 2026-08-12까지 `gpt-image-2`의
      가격표만 순회했고, 그동안 enabled였던 xAI는 유도에 들어가지 않았다.
      지금은 registry 가격도 함께 읽으므로, 새 모델의 크레딧당 원가가 기존
      최대값(864µ)보다 크면 floor가 오른다 — 활성화 후 실제 floor 값을 읽어
      배포한 예산이 여전히 그 위인지 확인한다.
- [ ] **`/api/ready`를 활성화 후 직접 호출해 확인.** readiness 차단은
      "이미지 flag ON **그리고** 해당 provider의 enabled 모델 존재"일 때만
      발동한다. 모델만 등록돼 있거나 flag가 꺼져 있으면 예산이 없어도 통과하므로,
      활성화 전의 `ok:true`는 예산이 맞다는 증거가 아니다.
- [ ] **네 번째 모델이 켜지면 컴포저가 compact picker로 전환되는지 육안 확인.**
      임계값은 활성 모델 3개이고(`imageComposerModelLayout()`), Google 3종을
      켜면 2→5로 건너뛴다. 규칙은 unit test로 고정돼 있으나 이 배포는 e2e로
      그 분기에 닿을 수 없다(`docs/ui-contracts/image-generation-workspace.md`).

### provider 예산 승인은 한도 이전이 아니라 신규 노출이다

Google `IMAGE_PROVIDER_GOOGLE_COST_MICROUSD_PER_DAY/_PER_MONTH`에 값을 넣는
것은 기존 한도를 옮기는 작업이 아니라, **회사가 Google에 대해 그만큼의 월
노출을 새로 승인하는 결정**이다. 초기값으로 논의된 일 $50 / 월 $500은
2026-08-05에 xAI 이미지 provider에 승인된 것과 동일한 초기 envelope이며,
채팅 provider(MiniMax 등)의 승인과는 다른 층이다 — 같은 숫자라도 같은 결정이
아니다.

- **예산은 provider별 총액이다.** Google 모델 3종은 하나의 pool을 공유하고,
  모델별 값은 관측 차원일 뿐이다. 3종을 켜는 것은 세 개의 예산이 아니라 하나의
  예산을 세 배 빠르게 쓸 수 있게 하는 것이다.
- **승인되지 않은 숫자를 적느니 모델을 비활성으로 둔다.** floor($10.80)는
  거절당하지 않을 최소값이지 권고치가 아니며, 회사가 승인하지 않은 상한을
  적는 것은 예산이 없는 것보다 나쁘다.
- **`month <= day`는 차단 조건이 아니라 advisory다**(`month_not_above_day`).
  production에서는 월 > 일을 운영 원칙으로 하되, 코드는 위반 시 경고만 하고
  readiness는 통과시킨다. staging의 `$10.80 / $10.80`은 총 지출을 캡하려는
  의도된 예외다.

### 권장 활성화 순서

1. `grok-imagine-image-quality-20260403` 1K — cross-provider 비교가 가능하고
   고정 per-image 가격이라 원가 모델이 가장 단순하다.
2. `gemini-3.1-flash-image` 1K — Nano Banana 2 대표 슬롯. 보수적 thinking
   상한 때문에 최소 크레딧이 높으므로 판매가 승인 후 연다.
3. `gemini-3.1-flash-lite-image` 1K — Draft/대량 생성 수요가 확인되면 연다.
4. `gemini-3-pro-image` — Flash가 부족하다는 실사용 근거가 생길 때까지 보류한다.

---

## E. 이 워크시트로 해결되지 않은 것

- 판매 크레딧 승인
- 실제 계정에서 날짜 snapshot/model ID가 보이고 호출되는지 확인
- provider adapter 구현과 staging 유료 호출
- Google/xAI provider budget의 운영 금액 결정
- 2K·4K와 provider별 비정사각형 해상도의 `ImageSize`·UI·가격 확장
  - Google 1K landscape는 현재 Tomverse의 `1536x1024`와 픽셀 규격이 다르므로
    단순 문자열 치환 없이 provider별 resolution/aspect mapping이 필요하다.
- xAI 결과물의 공식 provenance 보장 부재
- Google `image/webp` 출력의 모델별 실호출 검증

이 항목들이 끝나기 전에는 후보를 `price_unverified`에서 바로 활성 상태로
옮기지 않는다. 가격 검증이 끝났다는 사실과 실행 준비가 끝났다는 사실은
서로 다른 gate다.

---

## F. 2026-08-05 재조사 — Google thinking 상한과 Interactions API 스펙

이 절은 §D·§E가 미결로 남긴 두 항목을 갱신한다. 정책 반영은
`docs/policy/image-generation.md` §12.1이다.

### F-1. thinking 상한 — **확인된 부재**로 확정

이전 상태는 "확인 필요"였다. 재조사 결과 **읽었고 그 문장이 없다**로
확정한다. 이는 미조사보다 강한 근거이며, 보류 사유를 그대로 유지한다.

| 확인한 페이지 | 무엇이 있고 무엇이 없는가 |
|---|---|
| `https://ai.google.dev/api/interactions-api` | `generation_config.max_output_tokens`를 "응답에 포함할 최대 토큰 수"로 정의. 사용량은 `usage.total_input_tokens`·`total_output_tokens`·`total_thought_tokens`·`total_tokens`로 **분리 보고**. 두 출력 계열의 합이 상한 이하라는 연결 문장 **없음** |
| `https://ai.google.dev/gemini-api/docs/thinking` | 비용을 output + thinking의 합으로 설명하고 두 사용량을 별도 필드로 보고. `max_output_tokens`가 그 합을 제한한다는 명시 **없음** |
| `https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image` | Output token limit 32,768 |
| `https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image` | Output token limit 4,096 |
| `https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image` | Output token limit 32,768 |

모델 카드의 출력 한도는 **같은 미정의 수량에 대한 한도**이므로 빠진 연결을
대신 제공하지 못한다. 포럼 답변·검색 요약·전언은 정책 §12의 공식 본문 요건을
충족하지 않아 근거에서 제외한다.

**판정**: 세 모델 모두 `worst_case_cost_unbounded` 유지. §D의 보수적 유도
(A-2)는 채택하지 않는다.

**해소 경로**: 산문이 아니라 과금 신호. `npm run measure:google-image-thinking-cap`
(정책 §12.1의 8단계 절차). 매 실행이 유료이므로 §15 eval 예산 승인이
선행돼야 하고, `--i-accept-the-cost` 없이는 아무것도 전송하지 않는다.
`gemini-3.1-flash-lite-image`(4,096)가 상한이 실제로 작동하는지 관찰하기에
가장 유용한 첫 대상이다.

### F-2. Interactions API 스펙 — 확정, adapter 선행 구현

현재 이미지 생성 가이드가 사용하는 API는 **Interactions**이며 GenerateContent의
`imageConfig`는 reference에서 deprecated로 표시된다.

| 항목 | Interactions API |
|---|---|
| endpoint·method | `POST https://generativelanguage.googleapis.com/v1beta/interactions` |
| 인증 | `x-goog-api-key` 헤더 (bearer token 아님) |
| 이미지 출력 지정 | `response_format.type: "image"` |
| 해상도·화면비 | `response_format.image_size`, `response_format.aspect_ratio` |
| 응답 이미지 위치 | `steps[]` 중 `type === "model_output"`, 그 안의 `content[]` 중 `type === "image"` |
| 바이트·MIME | `content.data`(Base64), `content.mime_type` |
| usage | 최상위 `usage.total_input_tokens`·`total_output_tokens`·`total_thought_tokens`·`total_tokens` |
| 출력 상한 위치 | `generation_config.max_output_tokens` |

구현 시 지킨 것:

- **`model_output` step만 읽는다.** thinking 과정의 중간 이미지가 응답에 있을
  수 있고, 완성본 요금을 받으며 습작을 저장하는 실패는 둘 다 그럴듯한 그림이라
  아무도 눈치채지 못한다. 전달 이미지가 1장이 아니면 fail-closed.
- SDK의 `interaction.output_image` 편의 필드에 의존하지 않는다.
- GenerateContent 어휘(`generationConfig`·`inlineData`·`usageMetadata`)를 코드에
  쓰지 않는다 — security regression check가 강제한다.
- `thinking_level`은 모델별 profile. 값이 없으면 필드를 보내지 않는다.
- `max_output_tokens`가 없으면 요청을 **거부**한다(정책 §12 조건 2).
- `ImageModelProfile.maxOutputTokens`는 **비용 상한이 아니다.** 카드 수치이자
  요청값일 뿐이고, 상한 성립 여부는 `thinkingCapMicroUsd`(현재 `null`)가 답한다.

**adapter 구현은 활성화 승인도 판매가 확정도 아니다.**
`generateImageWithProvider`가 `disabledReason`이 있는 모델을 dispatch 전에
거부하므로 실행 경로가 없다. 선행 구현하는 이유는 F-1의 실측 자체가 이 코드를
통해야 하기 때문이다.

### F-3. §E에서 갱신되는 항목

- ~~Google `image/webp` 출력의 모델별 실호출 검증~~ → 여전히 미결이지만
  F-1 실측과 같은 유료 호출에서 함께 확인 가능하다(응답의 `mime_type`을
  그대로 기록하므로).
- ~~provider adapter 구현~~ → Google·xAI 모두 구현 완료. 남은 것은
  **유료 호출**이며 이는 예산 승인 항목이다.


---

## G. 2026-08-06 첫 실측 시도 — 요청 형식 결함 발견 (과금 $0)

`gemini-3.1-flash-lite-image`, `--limit=4096 --repeats=3`. **세 표본 모두 HTTP 400,
이미지 생성 없음 — 과금되지 않았습니다.**

```
The value 'image/png' is not supported for 'response_format.mime_type'.
Supported values: 'image/jpeg'.
```

### 이것이 알려준 사실

`response_format.mime_type`에 Google Interactions API가 받는 값은 **`image/jpeg`
뿐입니다.** 이 환경에서 읽을 수 없는 문서 대신 **API 자신이 답한 것**이므로,
동작에 관한 한 문서보다 강한 근거입니다.

`sources`에 URL을 추가하지는 않습니다 — 이건 문서 인용이 아니라 관측입니다.
가격 검증(§12의 `verified`)과는 다른 층의 사실이며, 요청 형식에만 적용됩니다.

### 드러난 결함

adapter가 `model.outputMimeTypes[0]`을 요청 MIME으로 사용하고 있었습니다.
그 필드는 **"무변형 저장이 허용되는 MIME 목록"**이지 "요청할 형식"이 아닙니다.
Google profile의 배열이 `["image/png", "image/jpeg"]`라 **모든 Google 요청이
PNG를 요청했고, 따라서 전부 실패했을 것입니다.**

두 개념을 `ImageModelProfile.deliveryMimeType`으로 분리했습니다. 저장 허용목록은
공급자가 낼 수 있는 것만큼 넓게 두고, 요청은 명시적으로 지정합니다. 응답의
MIME을 그대로 기록하는 규칙은 그대로입니다 — 요청은 요청일 뿐 가정이 아닙니다.

### 부수 사항

실행 시 API key가 대화에 노출돼 **폐기·재발급이 필요합니다.** 스크립트의 redact
패턴이 `AIza` 형식만 알고 있었고 이 키는 `AQ.` 형식이었습니다(실제 키 값으로도
치환하므로 스크립트 출력에는 노출되지 않았으나, 패턴은 두 형식 모두 처리하도록
보완했습니다).

---

## H. 2026-08-13 두 번째 실측 시도 — 같은 층위의 결함 하나 더 (과금 $0)

`gemini-3.1-flash-lite-image`, `--limit=512 --prompts=2 --repeats=2
--thinking=high`. **첫 요청이 HTTP 400, 이미지 생성 없음 — 과금되지 않았습니다.**
스크립트가 첫 판독 불능에서 멈춰 나머지 3회는 보내지 않았습니다.

```
HTTP 400 invalid_request
{"error":{"message":"Image delivery mode is not supported.","code":"invalid_request"}}
```

### 결함

`buildGoogleImageRequest`가 `response_format.delivery: "inline"`을 보내고
있었습니다. **§F-2의 스펙 표에 없는 필드입니다.**

붙어 있던 주석은 제품 판단이었습니다 — "fetchable reference 대신 inline bytes를
받는다. 원본은 서버에 저장되고, 두 번째 fetch는 이미 과금된 생성이 사후에
실패할 수 있는 경로가 하나 더 늘어나는 것이다." 판단 자체는 옳습니다. 다만 그
판단을 **API가 받는 파라미터로 표현할 수 있다는 것이 확인된 적이 없습니다.**

그리고 그 선호는 이미 충족돼 있었습니다. Interactions API는 `content.data`에
base64를 실어 보내고 `parseGoogleImageResponse`가 그것을 읽습니다. 즉 아무것도
지정하지 않아도 inline입니다. **없어도 되는 필드를 말한 대가로 모든 Google
요청이 거절됐습니다.**

### 2026-08-06과 같은 부류입니다

| | 2026-08-06 | 2026-08-13 |
|---|---|---|
| 필드 | `response_format.mime_type` | `response_format.delivery` |
| 값 | `image/png` | `inline` |
| 출처 | `outputMimeTypes[0]`을 요청값으로 오해 | 근거 문서 없이 추가 |
| 결과 | 전 요청 400 | 전 요청 400 |

두 번 다 **그럴듯한 필드, 문서 근거 없음, 알아챌 장치 없음**입니다.

### 이번에 넣은 장치

요청 전체 모양을 pin하는 unit test는 이미 있었지만, 그것은 **builder가 만드는
것을 그대로 고정**하므로 근거 없이 추가된 필드도 함께 고정했습니다. 그래서
`response_format`의 **key 집합을 §F-2 표와 맞추는** assertion을 따로 뒀습니다.
key를 늘리려면 표를 먼저 고쳐야 하고, 표를 고치려면 reference의 어디에 그렇게
적혀 있는지를 적어야 합니다 — 두 번 다 건너뛴 단계가 그것입니다.

### 남은 것

`--limit=512`에서의 측정은 아직 시작되지 않았습니다. 승인된 $10 예산은 그대로
전액 남아 있습니다.

### 다음

키 재발급 후 같은 3단계(`4096` / `2048` / `1024`)를 재실행합니다. 이번 시도는
과금이 없었으므로 예산 소모는 여전히 $0입니다.

---

## I. 2026-08-14 실측 완료 — **반증**. `max_output_tokens`는 과금 대상을 bound하지 않는다

`gemini-3.1-flash-lite-image`, 상한 4종(512 · 256 · 4,096 · 2,048), 프롬프트 2종,
표본 18건, 실사용 약 262,000~287,000µUSD(승인 $10의 2.6~2.9%).

### 결론

**`generation_config.max_output_tokens`는 thinking을 단독으로는 bound하지만
`output + thinking` 합계를 bound하지 않는다.** 우리가 과금당하는 양은 그 합계다.

결정적 표본 (상한 2,048):

| 상한 | output | thinking | 합계 | status | 이미지 |
|---:|---:|---:|---:|---|---:|
| 2,048 | 891 | 981 | 1,872 | `incomplete` | 0 |
| 2,048 | **1,602** | **931** | **2,533** | `completed` | **1** |

두 번째 표본은 상한을 **485토큰 초과**했고, 잘리지도 실패하지도 않았다 —
완성된 이미지를 받고 초과분까지 청구됐다.

### 이르게 판단하지 않은 것이 답을 바꿨다

낮은 상한만 봤다면 정반대 결론이 나왔다.

| 상한 | thinking | output | 합계 vs 상한 |
|---:|---:|---:|---|
| 256 | 253 | 0 | −3 |
| 512 | 509 | 0 | −3 |
| 4,096 | 874~1,096 | 1,560~2,209 | 최대 78% |
| **2,048** | 931 | **1,602** | **+485 (초과)** |

256·512는 `consistent_with_limit_bounding_thinking`을 냈다. 상한 − 3이라는
정확한 추적은 진짜 신호였지만 **thinking에 대해서만** 참이었다. 4,096은
`inconclusive_limit_never_bound`였다 — 천장 근처에 가지 않았기 때문이다.
**출력이 있는 채로 천장에 닿는 상한은 2,048뿐이었고, 거기서만 반증이 보였다.**

### 정책 §12.1의 예측이 맞았다

> 포함되지 않는다면 A-2는 "지나치게 보수적인 상한"이 아니라 **상한 자체가
> 아닌 계산**이 된다.

바로 그 경우다. A-2 유도(39,744µUSD)를 `thinkingCapMicroUsd`에 기록했다면
**입증되지 않은 값을 입증된 값으로 기록**하는 일이었다. output과 thinking이
각각 따로 상한을 받는다면 4,096에서의 최악은 44,208µUSD이고, 그마저도
"각각 bound된다"는 또 하나의 미검증 가정 위에 서 있다.

### 조치

- 세 Google 이미지 모델은 `worst_case_cost_unbounded`를 **유지**한다.
- `priceVerification.thinkingCapMicroUsd`는 **`null`을 유지**한다.
  **허위 상한을 넣지 않는다.**
- `lib/googleImageRequest.ts`의 `maxOutputTokens` 주석을 측정된 사실로 고쳤다 —
  "열린 질문"이 아니라 "요청 파라미터이며 비용 천장이 아님"이다.
- 재검토 조건: Google이 thinking 토큰 상한을 거는 요청 파라미터를 제공하거나,
  공식 문서가 과금 대상의 상한을 명시하는 경우.

### 부수 관측

- **이미지 = $30.00/1M 출력 토큰.** `output_tokens_by_modality`가 매번
  `image: 1120`이고 검증된 1K 가격 $0.0336 ÷ 1,120 = $30.00/1M. 이미지는 별도
  항목이 아니라 비싼 단가의 출력 토큰이며 `total_output_tokens`에 포함된다.
- **`status`로 성공을 판정하면 안 된다.** 512·256에서는 thinking이 예산을 다
  쓰고 산출물이 없는데 `completed`였고, 2,048에서는 이미지가 잘리며
  `incomplete`였다. `generateWithGoogle`은 parser로 판정하고 재시도 없이
  `provider_failed`로 끝내며, 이는 옳다.
- **산출물 없이 과금된다.** 상한 2,048의 첫 표본은 891 output + 981 thinking을
  청구하고 이미지를 주지 않았다. 사용자에게는 청구되지 않지만 공급자 원가는
  발생한다.
- **모델이 시키지 않은 해설문을 낸다.** 표본의 절반에 `model_output` step이
  둘이고 하나는 그림 설명 문단이다. 표본당 약 1,000토큰을 과금당하고 버린다.
