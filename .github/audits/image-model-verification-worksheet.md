# 이미지 모델 가격 검증 워크시트

확인일: **2026-08-04**

확인 범위: Google Gemini Developer API와 xAI Inference API의 공식 문서

검증 방식: 공식 문서 본문 대조와 보수적 최악 원가 계산. **유료 provider 호출은
하지 않았으며, 계정별 모델 가시성·실호출 가능 여부는 확인하지 않았다.**

## 0. 결론

이번 확인으로 네 후보의 공개 가격과 정적 사양은 공식 문서에서 확인됐다.
Google 3종은 직접 thinking을 끌 수 없지만, 모델 카드의 출력 토큰 상한 전체를
`text and thinking` 단가로 계산하는 보수적 방법을 쓰면 최악 원가를 유한하게
잡을 수 있다. 이 계산은 이미지 출력 토큰과 겹치는 부분이 있더라도 이중으로
잡는 fail-closed 방향이다.

| 모델 | 가격·상한 검증 | 수학적 최소 크레딧 | 활성화 판정 |
|---|---|---:|---|
| `grok-imagine-image-quality-20260403` | 완료 | 1K **62**, 2K **84** | **두 번째 비교 모델 1순위.** 판매 크레딧 승인, xAI adapter, provider budget, 계정별 alias 실호출 확인 후 가능 |
| `gemini-3.1-flash-image` | 완료 | 1K **190**, 2K **228**, 4K **283** | 판매 크레딧 승인, Google adapter, provider budget, 크기 매핑, 실호출 확인 후 가능 |
| `gemini-3.1-flash-lite-image` | 완료 | 1K **50** | Draft 후보. 첫 비교 슬롯을 같은 Google provider로 채우지 말고 xAI 이후 검토 |
| `gemini-3-pro-image` | 완료 | 1K·2K **592**, 4K **710** | 가격 검증과 별개로 기존 제품 판단에 따라 보류 유지 |

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
유한하게 계산할 수 있다. 배포 승인자가 위 결합 추론 대신 thinking 포함을 한
문장으로 명시한 공급자 확인을 요구한다면 Google 3종은 보류를 유지하고 Google
support 답변을 `priceVerification.sources`에 추가한다.

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
