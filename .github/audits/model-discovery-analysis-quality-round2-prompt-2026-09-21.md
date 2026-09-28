# 2차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

1차 P2 5건 대응과, 그 뒤 운영자가 범위에 추가한 **외부(공급자 공식) 문서 근거 확대**가 함께
들어 있습니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 1차 P2 대응

1. **tier가 다른 상위 버전과 비교되어 `low`로 숨던 문제** — `modelPortfolioRelation()`이 후보와
   **같은 tier 단어를 가진 서비스 모델을 먼저** 비교하고, 없을 때만 family 전체에서 최신을 고릅니다.
2. **base가 채택 단계면 파생형 제외가 계속 409** — 아래 4번과 함께 봐 주세요. wave를 만드는
   범위를 큐 조회 view에서 분리했는지 확인이 필요합니다(현재 구현은 `listModelDiscoveryQueue`가
   읽은 rows 기준이며, 이 지적은 아직 **미해결**입니다. 우선순위 판단을 부탁드립니다).
3. **wave가 제작사로 구획되지 않음** — `sameWaveSiblings()`가 owner 일치를 요구합니다.
4. **O(n²)** — `modelGenerationFamily()`에 프로세스 캐시(4,096개, 초과 시 전체 비움)를 넣고
   `waveBaseIsQueued`가 자기 id를 반복 파싱하지 않게 했습니다.
5. **"다음 수집이 채워집니다"가 Anthropic에서 거짓** — 공급자별로 **필드 단위** 수집 가능 여부를
   선언하고(`docCollectableFields`), 문장을 "이 중 X는 자동 수집, Y는 사람이 확인"으로 나눴습니다.

## 외부 문서 근거 확대 (운영자 지시)

- `lib/providerModelDocSources.ts`: 12개 공급자 전부에 대한 소스 표. 1차 출처(공급자 자기 문서)만
  허용하고 집계·벤치마크 사이트는 넣지 않습니다. 호스트 허용목록과 수집 가능 공급자 목록이 이
  표에서 파생됩니다.
- 실측으로 확인한 결과: **openai·anthropic(기존) + zhipu·xai·groq**가 마크다운 표를 제공합니다.
  perplexity(산문), moonshot(MDX 컴포넌트), google·mistral·deepseek·minimax·qwen(HTML)은
  `pricingUrl: null` + `humanUrl`로 두고, 큐 문구가 "사람이 확인해야 한다"고 말합니다.
- `lib/providerModelDocTables.ts`: 공급자별 파서 대신 범용 마크다운 표 리더.
  - 행 식별은 이름 열 파싱이 아니라 **줄 전체에서 정확한 id 경계 일치**(Groq는 id가 링크 안에만
    있고, `glm-5.3`이 `glm-5.3-flash` 행을 먹으면 가격이 뒤바뀝니다).
  - `Free`·`ContactSales`·`¥`·프로모션 표기 셀은 숫자로 읽지 않고 사유와 함께 거절합니다.
  - 한 모델에 두 행이면 xAI식 장문 tier로 읽고, tier가 아니면 `model_row_duplicated`로 거절합니다.
  - 200 응답이 "404 - Page Not Found" 본문이면 문서가 아닙니다(Groq `/docs/pricing.md`가 그렇습니다).
- `lib/providerModelDocEvidence.ts`: 표를 돌며 수집합니다. OpenAI·Anthropic 전용 파서는 그대로입니다.
- 파서 버전을 `2026-09-21.1`로 올렸습니다(기존 저장 행은 재수집 전까지 무시됩니다).
- 픽스처는 2026-09-21에 실제로 받은 바이트입니다.

## 특히 봐 주실 것

1. **잘못된 가격이 들어오는 경로**: 경계 일치, 통화, 무료/비공개 셀, tier 판정, 중복 행.
   특히 `tierFromRows`의 배수 계산과 `cacheTakesInputMultiplier: false` 고정이 안전한지.
2. **1차 P2-2(파생형 제외 409)** 가 여전히 재현되는지, 재현된다면 어느 범위가 옳은 수정인지.
3. 호스트 허용목록과 redirect 정책이 새 공급자에서도 유지되는지.
4. 프로모션 탐지: 셀 단위 거절로 바꾼 것이 기존 OpenAI·Anthropic 페이지 차단 규칙을 약화시키는지.
5. 수집 예산(12개/공급자, 45초)과 새 공급자 3곳 추가의 상호작용.

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
