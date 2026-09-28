# 발견 대기열 분석 품질 — 독립 검토 기록

- 작업: `claude/to-develop/discovery-analysis-quality`
- 작성: Claude (Opus 5), 독립 검토: Codex (`gpt-5.6-sol`, xhigh)
- 기간: 2026-09-21
- 근거 문서: `.github/audits/model-lifecycle-email-2026-08-22.md` §52

저자와 검토자가 다릅니다(agent-foundation 8). 검토자는 코드를 수정하지 않았고,
모든 수정은 저자가 했습니다.

## 무엇을 고쳤는가

운영자 화면의 분석 문단이 한 릴리스 파동의 다섯 모델에 **똑같이** 붙었습니다.
원인은 둘이었습니다.

1. **문단이 모델을 구분하지 않았습니다.** 분석은 등급·역할·컨텍스트를 문장으로
   나열했을 뿐, "이 모델을 지금 편입할 이유가 있는가"라는 질문에 답하지 않았고
   같은 공급자의 같은 세대 모델은 그 나열이 동일했습니다.
2. **비교 대상이 없었습니다.** 이미 서비스하는 모델과의 관계를 계산하지 않아,
   `glm-4.5-air`(구세대)와 `glm-5.3`(상위 세대)이 같은 문장을 받았습니다.

대응은 셋입니다.

- **판정 우선 구조.** `ModelTriageAssessment`가 `verdictKo`(한 줄 판정) +
  `pointsKo[]`(근거) + `nextStepKo`(다음 행동)를 따로 들고, `analysisKo`는 그 셋을
  이은 문자열입니다. 제외 스냅샷과 `analysisFingerprint`는 종전대로 `analysisKo`를
  묶으므로 감사 계약은 바뀌지 않습니다.
- **포트폴리오 관계.** `modelGenerationFamily()`가 등급 단어를 떼어 한 릴리스 파동을
  묶고, `modelPortfolioRelation()`이 **같은 등급 단어를 가진 서비스 중 모델을 먼저**
  기준선으로 잡아 세대 비교를 합니다(`gpt-4-turbo`와 `glm-5-turbo`가 같은 뜻이
  아니므로 `speed`는 포트폴리오 역할로 승격하지 않습니다).
- **파동 인식.** 대기열에 열린 같은 세대의 형제 `add` 항목을 함께 읽어, 파생 SKU가
  기준 모델보다 앞서 추천되지 않게 합니다. 이 읽기는 **화면의 필터와 무관하게**
  (상한 없는 별도 질의로) 수행하므로 패널과 제외 재검사가 같은 답을 냅니다.

외부 웹 근거는 공급자 **1차 문서만** 수집합니다. 집계 사이트(APIMaster, CloudPrice)와
벤치마크 사이트(Artificial Analysis)는 수집하지 않습니다. 가격은 여전히
`lib/modelPricing.ts`에서만 나오며, 문서 근거는 **사람이 볼 증거**이지 요율이
아닙니다.

## 공급자 범위

| 공급자 | 기계 판독 | 출처 |
|---|---|---|
| openai | 예 | 기존 파서 유지 |
| anthropic | 예(가격만) | 기존 파서 유지 |
| zhipu | 예 | `docs.z.ai` 가격표 + 모델 페이지 |
| xai | 예 | `docs.x.ai/developers/pricing.md` |
| groq | 예 | `console.groq.com/docs/models.md` |
| perplexity · moonshot · google · mistral · deepseek · minimax · qwen | 아니오 | 사람이 볼 링크만 제공 |

`groq`의 `/docs/pricing.md`는 200 응답에 404 본문을 돌려주므로 쓰지 않습니다.
`moonshot`은 MDX `<DocTable>`이라 마크다운 표가 아닙니다. 나머지 사람 전용
공급자는 HTML만 제공하며, **HTML 스크레이핑은 별도 결정 없이는 하지 않습니다.**

## 검토 회차

스물네 회차, P2 111건. **P1은 한 번도 제기되지 않았습니다.** 103건은 수정했고,
**24차의 6건은 미수정 상태로 이관**했습니다.
1건(18차 `Prices are not tax-inclusive in USD.`)은 의도적으로 침묵에 두었고,
1건(12차 xAI 라이브 표)은 검토자가 `.md`가 아닌 렌더링 HTML을 본 것으로 확인해
정정했으며 13차에서 검토자도 철회했습니다.

회차별 지적 수는 5 · 5 · 5 · 5 · 6 · 5 · 4 · 4 · 6 · 5 · 4 · 5 · 3 · 4 · 4 · 5 · 5 · 6 · 3 · 3 · 4 · 6 · 8 · 6이고, **6차부터 22차까지의
지적은 전부 범용 문서 리더(B2) 한 곳에 몰려 있었고, 23차에서 처음으로 두 건이
분석 본체(A2·A3)에서 나왔습니다.**

이 수렴 실패는 구조적이었습니다 — 형식을 강제할 수 없는 외부 문서에서 숫자를
뽑는 일이고 반례 공간이 무한합니다. 11차에서 **공급자별 문서 구조 계약**으로
그 공간을 닫았고, 17차에서 **통화 선언에도 같은 방식**을 적용했으며, 21차에서
**네 자리의 판정을 한 함수로 합쳤습니다**(아래 11·17·21차 절).

### 1차 — P2 5건

| # | 지적 | 대응 |
|---|---|---|
| 1 | 기준선 선택이 등급에 무지해 `flash`가 flagship과 비교됨 | 같은 등급 단어 우선 선택 |
| 2 | 파동을 화면 필터로 읽어 제외 재검사가 409를 냄 | 상한·필터 없는 전용 질의 |
| 3 | 파동이 공급자를 넘나듦 | owner 범위로 한정 |
| 4 | 파동 계산이 O(n²) | 세대 패밀리 맵 1회 구성 |
| 5 | "자동 수집됩니다" 문구가 수집 못 하는 필드에도 붙음 | `docCollectableFields()`로 필드별 판정 |

### 2차 — P2 5건

| # | 지적 | 대응 |
|---|---|---|
| 1 | 장문 tier 경계·캐시 배수를 검증 없이 읽음 | 경계 일치·배수 `unstated`/`flat`/`mismatch` 구분 |
| 2 | 결합 셀(`$1.40 / $4.40`)이 통화 검사를 우회 | 셀 전체를 먼저 판정한 뒤 분할 |
| 3 | 표 줄 제외가 너무 넓어 고지 행이 사라짐 | 값 셀만 제외(`TABLE_VALUE_CELL`) |
| 4 | 파동에 상한이 걸려 뒤쪽 형제가 안 보임 | 상한 제거 |
| 5 | 예산 검사가 늦어 앞선 공급자가 예산을 독식 | 모델 과업을 공급자별 라운드로빈 |

### 3차 — P2 5건

| # | 지적 | 대응 |
|---|---|---|
| 1 | 프로모션 문장이 parse에 전달되지 않음 | `promotionalNotices` 인자 추가 |
| 2 | 헤더의 통화·단위를 읽지 않음 | `docPriceCell(cell, header, units)` |
| 3 | 캐시 관련 문장을 표준 요율로 오독 | 캐시 섹션 거절 |
| 4 | 예산 검사가 fetch 이후 | 어떤 fetch보다 먼저 |
| 5 | `retire` 항목이 파동에 섞임 | `action: "add"`만 |

### 4차 — P2 5건

| # | 지적 | 대응 |
|---|---|---|
| 1 | 승인된 프로모션이 어느 모델 것인지 잃음 | `promoted` 맵을 `(provider, apiModel)`로 조회 |
| 2 | 헤더 검사가 input/cached/combined 경로에 연결 안 됨 | 세 경로 모두 같은 관문 통과 |
| 3 | 단위·통화가 fail-open | 긍정 선언이 없으면 `unit_unstated`/`currency_unstated` |
| 4 | 표 섹션·행 폭 미검사 | `pricing_table_not_standard_rate`, `row_width_mismatch` |
| 5 | 모델 페이지가 다른 모델 이야기를 읽음 | `model_page_names_other_model` |

### 5차 — P2 6건

| # | 지적 | 대응 |
|---|---|---|
| 1 | 표준 요율이 여전히 **거절 목록** — 새 tier 이름은 통과 | `STANDARD_SECTION` 허용 목록(heading·preamble 모두 없으면 통과) |
| 2 | 표 바로 다음 줄의 heading이 통째로 유실 | `index = cursor - 1` |
| 3 | 표 위의 외화 선언이 페이지의 USD 선언에 짐 | `foreignCurrency`가 페이지 선언을 무효화 |
| 4 | 모델 페이지의 프로모션 고지를 수집 안 함 | 모델 페이지에도 `promotionNotices()` |
| 5 | 비교 문단의 숫자가 이 모델 것으로 읽힘 | 블록 단위 분해 + 다른 모델을 언급하는 문장 전부 제외 |
| 6 | 한 셀에 숫자 둘(`~~$4.40~~ $1.40`)이면 앞의 것이 이김 | `ambiguous_value`로 거절 |

### 6차 — P2 5건

5차에서 넣은 방어가 **실제로는 작동하지 않는다**는 것을 Codex가 반례로 보였습니다.
모두 프로브를 직접 실행해 잘못된 값을 출력시킨 뒤 보고했습니다.

| # | 지적 | 대응 |
|---|---|---|
| 1 | 허용 목록이 무력 — 가격표의 preamble이 언제나 "Prices per 1M tokens"라서 `## Turbo processing`이 그 문장 힘으로 통과. `Accelerated`의 `rate`도 단어 경계가 없어 통과 | 요율 tier를 **모양**으로 인식(`RATE_TIER_SECTION`: 단어 + `processing`/`tier`/`lane`/`queue`, `standard`만 허용) + `STANDARD_SECTION`에 시작 단어 경계 |
| 2 | 영문 통화명(`euros`, `Canadian dollars`, `yen`)을 외화로 보지 않아 표 위의 외화 선언이 페이지 USD 선언을 못 이김 | `FOREIGN_CURRENCY`에 통화명·국가+dollars/pounds 추가 |
| 3 | combined 셀은 다중 가격 거절을 우회 — `~~$0.15 input~~ $0.10 input $0.60 output`이 폐기된 0.15로 파싱 | `matchAll`로 후보 수를 세고 둘 이상이면 `ambiguous_value` |
| 4 | 파생 모델이 기본 모델의 문장으로 인정 — `GLM-5.3-Flash has a 128K-token context window.`가 `glm-5.3`에 128K를 줌 | 다른 모델 판정을 **완전 일치**로. 한쪽이 다른 쪽을 포함해도 다른 모델 |
| 5 | 모델 페이지 프로모션을 **승인하면 표식이 사라짐** — `unacknowledged`만 보관해서, 승인 후 가격이 다시 prefill | 모델 페이지도 공유 페이지와 같은 회계(`noteModelPageNotices()`)를 지나며, 승인 여부와 무관하게 그 모델에 귀속 |

5번이 이 회차에서 가장 무거운 지적입니다. **승인은 "이 문장이 어느 모델에 대한
것인지 기록"이지 "가격이 영구적"이라는 뜻이 아니라는** 계약이, 공유 가격 페이지에서는
지켜지고 모델 페이지에서는 뒤집혀 있었습니다.

회귀 테스트 4건을 추가했습니다(표 리더 26건 → 30건).

### 7차 — P2 4건

이 회차의 지적은 하나의 문장으로 요약됩니다. **열거 목록은 닫히지 않습니다.**

| # | 지적 | 대응 |
|---|---|---|
| 1 | xAI 문서가 `/developers/`로 이동 — 레거시 경로는 308이고 수집기는 redirect를 거절하므로 **현재 xAI 읽기가 전부 실패 중** | 2026-09-22 실측(`308 -> /developers/models.md`)으로 확인. `pricingUrl`을 `https://docs.x.ai/developers/pricing.md`로, `humanUrl`을 `/developers/pricing`으로 갱신하고 픽스처 교체 |
| 2 | 모델 토큰 인식기가 실제 ID 형태를 놓침 — `GPT-4o`는 아예 모델로 안 잡혀 "다른 모델 없음"이 되고, `glm-4.6v`는 `glm-4`로 잘려 **자기 자신과 다른 모델**이 됨 | 버전 뒤 영문자 접미사를 허용(`-\d+(?:\.\d+)*[a-z]*`) |
| 3 | tier 규칙이 `processing\|tier\|lane\|queue` 밖의 실제 명칭을 표준 가격으로 읽음 — `## Fast mode pricing`은 실존하며 표준의 2배 | **수식어를 검사**하도록 전환. `STANDARD_PRICE_QUALIFIER`(무엇이 값 매겨지는지: standard/model/token/text/api…)가 아니면 거절 |
| 4 | 외화 판정이 열거 목록이라 `New Taiwan dollars`, `UAE dirhams`가 USD로 통과 | **질문을 뒤집음**. 통화를 말하는 문장이 있으면 그 문장이 USD를 말해야 함(`CURRENCY_STATEMENT` + `USD_PHRASE`). 모르는 통화는 자동으로 거절 |

3·4번은 같은 병이었고, 둘 다 "거절 목록"에서 "허용 판정"으로 구조를 바꿨습니다.
1번은 **가설이 아니라 현재 진행 중인 장애**였습니다 — 실측으로 확인했습니다.

`U.S. dollars`의 마침표가 통화구 캡처를 끊는 결함이 자체 테스트에서 드러나
`SENTENCE_END`로 고쳤습니다.

회귀 테스트 4건을 추가했습니다(30건 → 34건). 새 xAI 페이지에서
`grok-4.7` $2/$6·500k, `grok-4.3` $1.25/$2.5·1M, 200k 경계 ×2 tier가 그대로
읽힙니다.

### 8차 — P2 4건

7차에서 뒤집은 두 판정이 **문장에만 적용되고 다른 자리에는 안 닿았다**는 지적입니다.

| # | 지적 | 대응 |
|---|---|---|
| 1 | 긍정 판정이 heading·preamble 문장에만 적용됨 — `Input (AED)` 헤더나 `AED 1.40` 셀은 여전히 열거 목록이라 통과 | 통화 **코드 모양**(대문자 3자)을 통화 위치(괄호 안, 숫자에 인접)에서 인식. `USD`가 아니면 거절 |
| 2 | 한 단어 heading을 처리 못 함 — `### Turbo`는 통과하고 `### Standard`는 차단(Google 가격 문서가 이 구조) | 한 단어 heading은 **그 단어가 곧 수식어**. `### Standard`·`### Pricing`은 읽고 `### Turbo`·`### Flex`는 거절 |
| 3 | `Prices are in USD per 1M tokens.`는 과잉 차단되고, `...in the table below are in UAE dirhams.`는 첫 `in`만 봐서 fail-open | 문장 안의 **모든** `in`을 보고, 단위 꼬리(`per`, `for`…)에서 통화구를 자름 |
| 4 | 넓힌 토큰 패턴이 `RFC-9110`·`SHA-256`을 모델로 잡아 정상 문장을 버림 | `NON_MODEL_IDENTIFIER`(표준 기구·알고리즘)로 제외 |

**1·2·3의 열거는 앞선 회차의 열거와 방향이 반대입니다.** `NOT_A_CURRENCY_CODE`
(`PER`, `MAX` 같은 영어 단어)와 `NOT_A_CURRENCY`(`the`, `future`)는 **빠뜨리면
거절이 되는** 목록이고, 거절은 안전한 쪽입니다. 반대로 "거절할 통화 목록"은
빠뜨리면 **잘못된 숫자가 통과**했습니다. `NON_MODEL_IDENTIFIER`도 같은 성질로,
빠뜨리면 사실 하나를 잃을 뿐 지어내지 않습니다.

groq의 전부 대문자 헤더 `PRICE PER 1M TOKENS`에서 `PER`가 통화 코드로 잡히는
결함이 자체 테스트에서 드러나, 통화 코드 인식 위치를 괄호·숫자 인접으로 좁혔습니다.

회귀 테스트 4건을 추가했습니다(34건 → 38건).

### 9차 — P2 6건

| # | 지적 | 대응 |
|---|---|---|
| 1 | `### Turbo (preview)`는 두 단어가 돼 한 단어 규칙을 빠져나감 | heading에서 괄호·대괄호의 **내용까지** 제거한 뒤 단어를 셈 |
| 2 | 통화 코드 검사가 셀·열 제목에만 적용되고 표 heading(`## Model pricing (AED)`)에는 안 닿음 | `tableUnits()`가 코드 모양도 검사 |
| 3 | `Prices are in USD for input and UAE dirhams for output` — 두 번째 통화에 `in`이 없어 모든 `in`을 봐도 못 잡음 | **열마다 통화가 다른 표는 통째로 거절**(`SIDE_SPECIFIC_CURRENCY`). 한쪽만 이름 댄 `in USD for input and output`은 그대로 통과 |
| 4 | combined 경로가 분할 과정에서 원래 셀의 통화 코드·단위를 버림 | 분할 **전에** 셀 전체와 헤더를 통화 코드·다른 단위로 검사 |
| 5 | `per 1,000 tokens`·`per thousand tokens`를 다른 단위로 인식 못 함 — **최대 1,000배 오차** | `OTHER_UNIT_STATED`에 `1,000`·`1000`·`thousand`·`hundred` 추가 |
| 6 | `Claude Sonnet 4.5`, `Llama 3.1` 같은 표시명을 모델로 못 잡아 비교 문장의 숫자를 가져옴 | `DISPLAY_NAME_MODEL`(대문자 단어 + 버전)로 인식하고, 월·`Figure`·`Table` 등은 `NOT_A_DISPLAY_NAME`으로 제외 |

5번이 이 회차에서 가장 무겁습니다. **틀린 단위는 틀린 통화보다 조용합니다** —
`1.40`은 어느 쪽으로 읽어도 그럴듯한 숫자이고, 1,000배 차이는 운영자가 다른
근거로 대조하기 전까지 드러나지 않습니다.

회귀 테스트 6건을 추가했습니다(38건 → 44건).

### 10차 — P2 5건

| # | 지적 | 대응 |
|---|---|---|
| 1 | `per 10,000 tokens`·`per 1 billion tokens`는 통과하고 `per 1,000,000 tokens`(Perplexity의 실제 표기)는 거절 | **수량을 긍정 판정**으로. `per <수량> tokens`를 전부 뽑아 그 수량이 100만이어야 통과(`MILLION_QUANTITY`) |
| 2 | 통화 판정이 열 제목·combined 셀의 말로 쓴 통화(`Input AED …`, `(UAE dirhams)`)에 안 닿음 | 셀·헤더에도 `statedCurrencyIsForeign()`·코드 검사를 적용하고, 가격 자리의 **괄호 내용이 인식되지 않으면 거절**(`RECOGNISED_PARENTHETICAL`) |
| 3 | `SIDE_SPECIFIC_CURRENCY`가 문장 모양만 봐서 양방향 오판 — `USD for input and AED for output` 통과, `in USD for input and separately for output` 거절 | 각 측 **앞에 붙은 통화 자체를 판정**(`sideCurrencyIsForeign`) |
| 4 | `### Turbo [preview](url)`는 `plainCell()`이 링크를 먼저 펴서 한 단어 규칙을 우회 | **heading이 있으면 heading이 판정**하고, preamble은 heading이 없을 때만 읽음 |
| 5 | `GPT 4o`·`o4-mini`·`DeepSeek V3.2`를 모델로 못 잡음 | 토큰·표시명 패턴 확장 |

4번이 6차에서 고친 것과 같은 병의 재발이었습니다. **가격표의 preamble은 어떤
heading 아래서든 "Prices per 1M tokens"라고 말하므로, 둘을 합쳐 판정하면 heading이
무엇이든 통과합니다.** 이번에는 heading이 있으면 heading만 보게 했습니다.

수정 중 자체 프로브에서 두 결함이 더 드러났습니다 — 수량 캡처가 쉼표를 배제해
`10,000`을 못 읽던 것과, 9차에 넣은 `per 1,000` 패턴이 `1,000,000`의 앞 세 자리에
걸리던 것입니다. 둘 다 고쳤습니다.

회귀 테스트 6건을 추가했습니다(44건 → 50건).

### 11차 — P2 4건, 그리고 범위에 대한 판단

이 회차에서 검토자에게 **남은 반례가 실제 공급자 표기인지 이론적 표기인지**를
구분해 달라고 요청했습니다. 답은 "대부분 (b) 이론적"이고, 현재 실제 문서는 정확히
읽힌다는 것이었습니다. 다만 라이브 문서가 바뀌면 잘못된 가격을 문제 없이 생성하므로
"범용 fail-closed 리더"라는 계약으로는 승인하기 어렵다고 했습니다.

**제안된 수렴점은 공급자 축소가 아니라 문서 구조 계약이었고, 그대로 채택했습니다.**

| # | 지적 | 대응 |
|---|---|---|
| 1 | `per 1,000,000,000 tokens`가 `1,000,000`의 접두부로 통과 | 뒤에 숫자가 더 오면 불일치 |
| 2 | 괄호 없는 통화명(`Input in Saudi riyals …`, `1.40 Saudi riyals`)이 가격 자리를 우회 | 가격 자리에 **모르는 단어**가 있으면 거절(`RECOGNISED_PRICE_WORD`). 통화·단위·값 판정 **뒤**에 두어 더 구체적인 이유가 먼저 나옴 |
| 3 | heading-only 판정이 preamble의 tier 의미와 상위 heading을 잃음 | 허용 판정은 heading만, **거절 판정은 heading과 preamble 모두** |
| 4 | `DeepSeek V3.2` 페이지가 `deepseek-v3.2`를 자기 모델로 인정 안 함 | 페이지 귀속 검사만 평탄화 비교로 완화. **표 행은 여전히 id를 요구**합니다 — 거기서는 행과 행의 차이가 곧 id이기 때문입니다 |

#### 공급자별 문서 구조 계약

각 공급자가 **사람이 읽고 기록한 표준 요율 표의 컬럼 행**을 계약으로 갖습니다
(`expectedPriceHeaders`).

```
zhipu  model | input | cached input | cached input storage | output
xai    model | context | input / 1m tokens | cached input / 1m tokens | output / 1m tokens
groq   model id | speed (t/sec) | price per 1m tokens | rate limits (developer plan) | ...
```

**나머지 규칙은 전부 "이 표에 무엇이 잘못됐는가"를 묻고, 그 질문에는 유한한 답이
없습니다.** 이 계약은 "이것이 그 표인가"를 묻고, 그 질문은 유한합니다. 컬럼이
하나라도 달라지면 `pricing_table_shape_unrecognised`가 되고, 공급자가 문서를
개편하면 **잘못 읽히는 대신 읽히지 않게** 됩니다 — 그때는 사람이 페이지를 다시
읽습니다.

실측 확인: zhipu 표의 `Input`을 `Input (AED)`로 바꾸자 그 표가 대상에서 빠졌고,
xAI의 `Batch API Pricing`·`Priority Processing Pricing` 표는 컬럼 자체가 달라
애초에 계약에 걸리지 않습니다.

회귀 테스트 4건을 추가했습니다(50건 → 54건).

### 12차 — P2 5건 중 4건 수정, 1건 사실관계 정정

**정정.** 검토자가 "현재 xAI 라이브 표가 이미 계약과 다르다"며 그룹 표 구조를
들었으나, 그것은 **렌더링된 HTML 페이지**입니다. 수집기가 읽는
`https://docs.x.ai/developers/pricing.md`를 2026-09-22에 다시 받아 픽스처와
바이트 단위로 대조했고 **평면 5열 헤더 그대로** 동일했습니다. 과잉 차단은
발생하지 않습니다.

**다만 같은 지적의 뒷부분은 정확했고, 이 회차에서 가장 중요한 발견입니다.**
테스트 helper가 `expectedHeaders`를 넘기지 않아 세 픽스처가 **생산 경로의 새 계약을
한 번도 지나지 않았습니다.** "기존 기대값 유지"가 계약을 검증하지 않았다는 뜻입니다.
helper를 고쳐 이제 픽스처가 각 공급자의 기록된 표 구조를 통과해야만 읽히며, 전
항목이 그대로 통과합니다 — 이것이 계약이 과잉 차단하지 않는다는 실제 증거입니다.

| # | 지적 | 대응 |
|---|---|---|
| 2 | 가격 자리 통화 방어를 우회 — combined는 분할 뒤 숫자만 넘기고, `R$`·`₽`·`1.40 SR`은 기호 열거 밖 | combined도 **원문 셀**로 판정. 기호는 열거 대신 **가격에 올 수 있는 문자 전체를 허용 목록**으로 두고 벗어나면 거절 |
| 3 | 같은 헤더의 비표준 표 — `## Pricing` + preamble `Fast mode pricing`, `## Batch API Pricing` > `### Text Models` | **상위 heading 계보**(`ancestry`)를 추적하고 preamble의 tier 주장도 읽음 |
| 4 | **API id가 모델 열이 아닌 아무 셀에만 있어도 그 행을 대상 모델로 읽음** | 모델 열에서만 대조. groq는 링크 평탄화로 id 경계가 사라지므로 **원문 셀**을 씀 |
| 5 | 평탄화 비교가 파생 페이지를 base로 인정 | 페이지 **제목을 동등 비교**(`titleNamesModel`) |

**4번이 이 회차에서 가장 무겁습니다.** `| other-1 | 9.99 | target-1 | - | 19.99 |`에서
`target-1`을 조회하면 **other-1의 가격이 문제 없이 반환**됐습니다. "표 행은 여전히
API id를 요구한다"고 적어 둔 11차의 계약보다 실제 검사가 넓었던 것입니다.

자체 검증에서 타입 오류 하나가 남아 있던 것도 이 회차에 고쳤습니다.

회귀 테스트 5건을 추가했습니다(54건 → 59건).

### 13차 — P2 3건

지적 수가 5 → 3으로 줄었고, 검토자가 xAI 건을 `.md` 기준으로 재확인해 철회했습니다.

| # | 지적 | 대응 |
|---|---|---|
| 1 | 페이지가 선언한 외화를 잃어 셀의 모호한 `$`를 USD로 읽음 — `All prices are in Canadian dollars.` 아래 `$1.40` | `documentUnits()`가 **페이지 전체 통화 선언**(`All prices are in …`)을 보존 |
| 2 | 제목이 다른 모델이어도 본문이 기준 모델을 한 번 언급하면 귀속이 뒤집힘 | **제목이 있으면 제목만으로** 판정. 제목이 없을 때만 본문으로 후퇴 |
| 3 | groq 모델 열의 **링크 목적지**를 id로 인식해 다른 행의 가격을 반환 | 링크 목적지를 제거한 **표시값**으로만 대조. 경계 일치 또는 셀 끝 일치 |

#### 이 회차에 제가 만든 두 결함

수정이 실제 픽스처 6건을 깨뜨렸고, 원인은 제 변경 쪽이었습니다.

1. `charge a $0.05 fee`의 **관사 "a"가 `A$`(호주 달러)로 오인**됐습니다. 통화 접두는
   기호에 붙여 쓰므로 공백을 허용하지 않도록 고쳤습니다. 이 오탐은 전부터 있었지만
   표 범위에서만 쓰일 때는 드러나지 않았고, 페이지 전역으로 올리자 드러났습니다.
2. 페이지 전역에 통화 문장 스캔을 그대로 돌린 것이 과했습니다. 가격 페이지는
   지나가는 말로 금액을 언급하므로, **페이지 전체를 두고 하는 선언**만 보도록
   좁혔습니다.

**픽스처가 이 둘을 잡았습니다.** 12차에서 helper에 구조 계약을 연결하지 않았다면
1번은 통과했을 것입니다.

회귀 테스트 3건을 추가했습니다(59건 → 62건).

### 14차 — P2 4건

넷 모두 13차에 제가 손댄 자리였고, 하나의 공통 원인이 있었습니다.
**페이지 통화 선언을 읽는 방식이 "USD인가"와 "외화인가"에서 서로 달랐습니다.**
외화는 선언 문장만 보고, USD는 본문 아무 곳의 언급이나 믿었습니다.

| # | 지적 | 대응 |
|---|---|---|
| 1 | `All prices in the table below are in Canadian dollars.`가 첫 `in`에서 잘려 놓침 | 선언 문장 안의 **모든** `in`을 읽음 |
| 2 | `A separate usage fee is charged in USD.` 한 줄이 표 전체를 USD로 만듦 | 두 답을 **같은 읽기**에서 냄. 선언의 주어가 페이지의 가격이어야 하며, 선언이 없으면 `currency_unstated` |
| 3 | `not-target-1`이 `target-1`으로 끝나 다른 행을 가져감 | 접미사 앞이 구분자(`-._/`)면 거부. groq는 표시명에 글자로 붙이므로 글자는 허용 |
| 4 | `All prices are in U.S. dollars.`가 마침표에서 잘려 **정상 USD 표가 거절** | 선언 캡처가 문장 끝까지 읽도록 |

4번은 방향이 반대인 결함입니다 — 허용 목록에 `U.S. dollars`가 있었는데 **거기
도달하지 못했습니다.**

#### 이 회차에 제가 만든 결함

선언 문장을 페이지 전체에서 자르면서 **앞선 heading이 문장 앞에 붙어** 선언으로
인식되지 않았고, 픽스처 4건이 깨졌습니다. 줄 단위로 읽도록 고쳤습니다.

회귀 테스트 2건을 추가했습니다(62건 → 64건).

### 15차 — P2 4건

| # | 지적 | 대응 |
|---|---|---|
| 1 | `Prices are not in USD.`가 USD 선언으로 읽힘 | 부정문(`not`·`no longer`·과거형)은 선언으로 세지 않음 |
| 2 | `All prices in the table below are in USD.`가 페이지 전체로 승격돼 무관한 표까지 USD가 됨 | **범위가 한정된 선언은 이 통화를 페이지에 세우지 못함.** 한정된 **외화** 선언은 여전히 거절 — 거절은 어디에 걸려도 안전한 쪽 |
| 3 | `pretendtarget-1`이 `target-1`으로 인정 | 14차의 "구분자가 아니면 허용"이 임의 접두사를 전부 허용했음. **대문자로 끝나는 표시명**이거나 **알려진 배지 단어**여야 함 |
| 4 | `**All prices are in USD.**`가 외화로 판정돼 **정상 문서를 거절** | 강조 문법은 내용이 아니므로 제거 |

4번은 방향이 반대인 결함이고, 공급자 `.md`에서 흔한 문법이라 실제로 걸렸을
것입니다. 2번의 비대칭(한정된 USD 선언은 무효, 한정된 외화 선언은 유효)은 의도된
것이며, **두 방향 모두 fail-closed**입니다.

이 회차에는 제 수정이 픽스처를 깨뜨리지 않았습니다.

회귀 테스트 4건을 추가했습니다(64건 → 68건).

### 16차 — P2 5건, 그리고 균형의 전환

**이 회차에서 처음으로 과잉 차단이 우회보다 많았습니다.** 다섯 중 셋이 정상 문서를
거절하는 방향이었고, 전부 실제 공급자 문서에 나올 수 있는 표기였습니다.

| # | 지적 | 방향 | 대응 |
|---|---|---|---|
| 1 | `Prices are not in USD.`가 표 preamble에 있으면 `tableUnits()`가 같은 문장의 `USD`를 다시 긍정 선언으로 읽음 | 우회 | 부정문을 **"다른 통화다"**로 판정. 침묵이 아니라 진술입니다 |
| 2 | `vendor-b/target-1`이 `vendor-a/target-1`로 인정. groq 픽스처에 이미 네임스페이스 id가 있음. `pretend2target-1`도 통과 | 우회 | 문서 쪽의 다른 네임스페이스만 거부(질의 쪽 접두는 계속 허용). 앞 문자 허용에서 숫자 제외 |
| 3 | `All prices are in US dollars (USD).`와 `All prices are in [USD](url).`를 외화로 판정 | **과잉 차단** | 괄호 이후를 자르고, 선언 줄에 `plainCell()`을 적용해 링크를 평탄화 |
| 4 | `…in USD and do not include taxes.`의 `not`이 선언을 지우고, `…in USD, including image and tool prices.`가 한정 선언으로 오판 | **과잉 차단** | 부정·범위 한정을 **통화 앞부분에서만** 읽음 |
| 5 | `All prices are denominated\nin USD.` — hard-wrap된 한 문장이 둘로 잘림 | **과잉 차단** | 선언을 문단 단위로 모아 읽되 heading 줄은 버림 |

4번의 수정이 핵심입니다. **`not`이 통화 뒤에 있으면 그 통화를 부정하는 것이
아닙니다.** 세금 고지("do not include taxes")는 가격 페이지의 흔한 문장이고, 그것이
통화 선언을 지우고 있었습니다.

1번에서 부정문의 답이 `currency_unstated`에서 `not_usd`로 바뀌었습니다. 15차에
넣은 테스트를 함께 고쳤고, 바뀐 쪽이 맞습니다 — 페이지가 "USD가 아니다"라고
말했으면 그것은 다른 통화라는 진술입니다.

회귀 테스트 3건을 추가했습니다(68건 → 71건).

### 17차 — P2 5건(우회 3, 과잉 차단 2)

개별 반례를 때우는 대신 **11차의 표 구조 계약과 같은 방식을 통화 선언에도**
적용했습니다.

지금까지는 "이 문장이 무엇을 한정하는가"를 영어로 이해하려 했습니다 —
`in the table below`는 무엇을 한정하는지, `not`은 무엇을 부정하는지,
`including image and tool prices`는 범위인지. **그 질문에는 유한한 답이 없어서
열 회차 동안 양방향으로 결함이 나왔습니다.**

이제 묻는 것은 **"가격 페이지가 실제로 쓰는 형태 중 하나인가"**이고, 그 답은
유한합니다(`PAGE_USD_DECLARATION`). 인정되는 형태:

```
All prices are in USD.
All prices are in US dollars (USD).
All prices are in [USD](url).
All prices are in USD and do not include taxes.
All prices are in USD, including image and tool prices.
All prices, including image and tool prices, are in USD.
All prices are denominated\nin USD.
Prices are in USD per 1M tokens.
```

그 밖은 전부 **침묵**입니다 — `All prices are in USD for the table below.`는
인정되지 않고 표는 `currency_unstated`로 거절됩니다. 그리고 **페이지 어디든 다른
통화 단어가 있으면 전체를 거절**하고 사람에게 넘깁니다.

| # | 지적 | 방향 | 대응 |
|---|---|---|---|
| 1 | `Token charges below are not in USD.`가 주어 형태 때문에 부정 판정을 빠져나가고 `USD_STATED`로 되살아남 | 우회 | 부정은 주어와 무관하게 "다른 통화다"(`NEGATED_USD_DECLARATION`) |
| 2 | `All prices are in USD for the table below.`가 페이지 전체 선언으로 승격 | 우회 | 통화 뒤에 올 수 있는 것은 `,`·`;`·`.`·`and`·`per`·문장 끝뿐 |
| 3 | `All prices, including image and tool prices, are in USD.`가 한정 선언으로 오판 | 과잉 차단 | 삽입절(`, … ,`)을 형태에 포함 |
| 4 | `Prices are not shown in the table below. All prices are in USD.`가 첫 문장 때문에 전체 거절 | 과잉 차단 | 형태 기반 판정이라 첫 문장은 선언이 아님 |
| 5 | `xvendor-a/target-1`이 `vendor-a/target-1`을 포함해 같은 모델로 인정 | 우회 | 문서 셀이 네임스페이스를 가지면 **그 네임스페이스가 이것이어야** 함 |

회귀 테스트 2건을 추가했고, 그 중 하나가 **정상으로 읽혀야 하는 아홉 형태**를
한꺼번에 고정합니다(71건 → 73건).

### 18차 — P2 6건(우회 2, 과잉 차단 4)

17차에 형태 기반으로 바꾼 직후라 **비용이 과잉 차단 쪽에 몰렸고**, 검토도 그 방향을
집중적으로 찾았습니다.

가장 중요한 지적은 **`won't`가 원화 `won`으로 읽힌다**는 것입니다. xAI 픽스처에 이미
`you will not be charged`라는 같은 뜻의 비축약형이 두 번 있어서, **편집상 축약
하나로 그 공급자 전체가 파싱 불가**가 될 수 있었습니다. 6차에 통화 단어 목록을
넓히면서 만든 결함입니다.

| # | 지적 | 방향 | 대응 |
|---|---|---|---|
| 1 | `vendor-a/target-1-pro`·`vendor-a/target-10`이 `vendor-a/target-1`로 인정 | 우회 | id **양 끝** 경계 검사 |
| 2 | `Usage fees below are not in USD.` — 주어 목록에 없어 부정을 빠져나감 | 우회 | 부정 판정에서 주어 요구를 없애고 **`not … in USD` 인접성**만 봄 |
| 3 | `All prices do not include taxes and are in USD.`가 거절 | 과잉 차단 | 절이 낀 형태를 인정하되, **범위 한정 단어가 절에 있으면 불인정** |
| 4 | `Local prices below are in AED.`를 못 잡음 — 페이지 판정이 통화 **단어**만 봄 | 우회 | `in <대문자 3자>` 자리도 검사 |
| 5 | **`won't` → 원화** | 과잉 차단 | `won(?!'t)` |
| 6 | `All payments are in USD`(실제 Anthropic 문구), `Unless otherwise noted, …`, `All listed prices …`, `All prices are in USD:` 전부 거절 | 과잉 차단 | 형태 목록 확장 |

**한 건은 의도적으로 보류했습니다.** `Prices are not tax-inclusive in USD.`는 여전히
침묵(`currency_unstated`)입니다. 드문 어순이고, 여기서 추측하려면 다시 "`not`이
무엇을 부정하는가"를 해석해야 합니다. 추측 대신 거절이 맞습니다.

회귀 테스트 4건을 추가했습니다(73건 → 77건).

### 19차 — P2 3건(우회 2, 과잉 차단 1)

가장 중요한 지적은 **제 테스트가 의도한 것을 검사하지 않았다**는 것입니다.
`zhipuUnder()` helper가 주어진 문장 뒤에 `## Text Models` heading을 삽입하므로,
"표 preamble 부정문"이라고 쓴 테스트는 실제로는 **앞 구획의 본문**을 검사하고
있었습니다. 그 경로에서 `Prices aren't in USD.`는 그대로 파싱됐고, 의도적으로
침묵에 두기로 한 `not tax-inclusive`도 거기서는 통과했습니다.

표 preamble을 실제로 채우는 helper(`zhipuPreamble`)를 만들어 두 경로를 따로
고정했습니다.

| # | 지적 | 방향 | 대응 |
|---|---|---|---|
| 1 | `Image prices are in USD.`·`Batch prices are in USD.`·`For the table below, all prices are in USD.`가 페이지 전체 선언으로 승격 — 범위 검사가 중간 절에만 걸림 | 우회 | **통화 앞 전체**를 봄. 단 `including …`은 제한이 아니라 포함이므로 구분 |
| 2 | `Prices aren't in USD.`가 표 preamble에서 긍정으로 되살아남 | 우회 | 축약 부정(`n't`)을 인식하고, **부정이 있는 context는 `USD_STATED`로도 긍정하지 않음** |
| 3 | `Models are available in UAE.`의 지역명을 통화 코드로 읽음 | 과잉 차단 | `in <대문자 3자>` 검사를 **가격 문장에서만** 수행 |

3번은 Anthropic 픽스처의 `in AWS`도 우연히 예외 목록 덕에 통과하던 상태였습니다 —
새 약어가 나올 때마다 공급자 전체 근거가 거절될 수 있었습니다.

검토자는 `Prices are not tax-inclusive in USD.`를 **추측하지 않고 거절한다는 결정
자체에는 동의**했습니다. 문제는 그 거절이 문구 위치에 따라 우회된다는 것이었고,
그것을 고쳤습니다.

회귀 테스트 3건을 추가했습니다(77건 → 80건).

### 20차 — P2 3건(우회 1, 과잉 차단 2)

**19차에 페이지 경로에서 고친 것이 표 context 경로에는 닿지 않았습니다.**
검토자가 제 새 테스트를 읽고 "이 테스트는 그 경로를 지나지 않는다"고 각각
짚었습니다.

| # | 지적 | 방향 | 대응 |
|---|---|---|---|
| 1 | `Input prices are in USD.`·`Regional prices are in USD.` — 주어 앞에 **아무 단어나** 허용 | 우회 | 허용 수식어(`all`·`listed`·`published`·`our` 등)만 인정 |
| 2 | `All prices are in USD and do not include taxes.`가 **표 preamble에서는** 거절 | 과잉 차단 | **부정이 통화 앞에 있을 때만** 선언을 지움(`deniesBeforeCurrency`) |
| 3 | `Also available on OCI.`가 표 context에서 통화 코드로 읽힘 | 과잉 차단 | 표 context의 코드 검사에도 **가격 문장 제한** 적용 |

2번은 Moonshot 픽스처에 실제로 세금 제외 고지가 있습니다. 3번에서 `UAE`·`AWS`가
통과하던 것은 예외 목록 덕분이었지 규칙 덕분이 아니었습니다.

회귀 테스트 2건을 추가했습니다(80건 → 82건).

#### 남은 구조적 작업 → 21차에서 수행

**19차와 20차 모두 "같은 결함이 다른 경로에 남아 있다"였습니다.** 이 리더는
페이지 prose · 표 heading/preamble · 열 헤더 · 셀 **네 자리**에서 같은 질문
(통화·단위·모델 id)을 묻는데, 한 자리를 고치면 나머지 세 자리가 남습니다.
21차에서 이 판정을 합쳤습니다.

### 21차 — P2 4건, 그리고 세 번째 구조적 전환

21차 프롬프트에서 "네 자리의 판정을 한 함수로 합치는 것이 남은 구조적 작업으로
보인다"는 판단에 대한 의견을 물었고, **검토자가 동의하며 설계를 제시했습니다** —
문장을 한 번만 분석해 통화·범위·주어를 반환할 것, 우선순위를 명시할 것,
heading과 preamble을 이어 붙이지 말 것, 같은 반례 corpus를 여러 자리에 넣는
행렬 테스트를 둘 것.

그대로 구현했습니다. `readCurrencyClaim()` 한 함수가 문장 하나를 읽고
`{currency, scoped}`를 돌려주며, 페이지 prose·표 heading·표 preamble이 전부 이
함수를 지납니다. heading과 preamble은 각각 판정하고 가까운 쪽이 우선합니다.
**원시 `USD` fallback을 없앴습니다** — 그 fallback이 이 리더가 "판단할 수 없다"고
결정한 문장을 계속 되살리고 있었습니다.

| # | 지적 | 방향 | 해결 |
|---|---|---|---|
| 1 | `Input prices are in USD.`가 표 preamble에서 `USD_STATED`로 부활 | 우회 | fallback 제거 + 수식어 검사 |
| 2 | `For regional customers, …`의 임의 선행 절이 수식어 허용 목록을 우회 | 우회 | 선행 절은 `Unless otherwise noted,` 류만 허용 |
| 3 | `All prices, except cached input prices, are in USD.`가 제외된 열까지 읽음 | 우회 | 예외 절이 **가격 종류를 빼면** 침묵 |
| 4 | `Models are shown in OCI.`의 `shown` 때문에 클라우드를 통화로 읽음 | 과잉 차단 | 통화 코드는 **가격이 주어일 때만** |

#### 행렬 테스트가 찾은 것

27개 문장 × 2개 자리의 행렬 테스트를 처음 돌리자 **네 건의 교차 자리 불일치**가
연달아 드러났고, 전부 통화가 아니라 **다른 판정**에서 온 것이었습니다.

1. 포함 절의 `image and tool prices`가 그 표를 이미지 표로 보이게 함
2. `listed prices`가 tier 이름으로 읽힘
3. `USD:` 뒤의 텍스트가 통화구에 섞임
4. 문장 끝 `tokens.`의 마침표 때문에 수식어 검사가 실패

이 넷은 검토자가 지적한 것이 아니라 **테스트가 찾은 것**입니다. 같은 문장이
자리에 따라 다르게 읽히는지를 묻는 테스트가 없었기 때문에 열 회차 넘게 보이지
않았습니다.

회귀 테스트 1건(행렬, 54개 판정)을 추가했습니다(82건 → 83건).

### 22차 — P2 6건, 그리고 `null`이 감추고 있던 두 답

가장 중요한 지적은 **`null`이 두 가지 다른 답을 뭉개고 있었다**는 것입니다.

- "아무 말도 하지 않았다" → 더 넓은 선언으로 내려가도 됨
- "통화를 말했는데 어느 가격에 대한 것인지 알 수 없다" → **내려가면 안 됨**

`All prices, except cached input prices, are in USD.`가 표 preamble에 있고 페이지에
`All prices are in USD.`가 있으면, 앞 문장은 **뒤 문장을 한정하려던 것**입니다.
그런데 `null`로 뭉개지면서 바로 그 한정 대상으로 내려가 캐시 가격까지 읽혔습니다.
`CurrencyClaim`에 `unattributable`을 두어 fallback을 막습니다.

두 번째는 **범위 한정 선언이 자리에 따라 다른 뜻**이라는 것입니다.
`All prices in the table below are in USD.`는 페이지에서는 아무것도 세우지
못하지만, **그 표 바로 위에 있으면 그 표를 가리킵니다.** 판정을 `page`/`table`
자리별로 나눴고, 행렬의 기대값도 자리별(`atTable`)로 갖게 했습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 가까운 예외 선언이 `null`로 축약돼 먼 USD 선언이 되살아남 | 우회 | preamble → page | `unattributable`이 fallback을 막음 |
| 2 | 통화 **뒤**의 쉼표가 예외·범위 절을 통째로 숨김 | 우회 | 전 자리 | 앞뒤를 같이 판정 |
| 3 | 바로 뒤 표를 지칭한 정상 선언도 쓸 수 없음 | 과잉 차단 | preamble | 자리별 판정(`about: "table"`) |
| 4 | heading의 포함 절 — `ancestry`에 원본이 남아 이미지 표로 오판 | 과잉 차단 | heading | ancestry에도 포함 절 제거 |
| 5 | `…and models are available in OCI.`가 통화 주장으로 읽힘 | 과잉 차단 | 전 자리 | 가격 명사가 **같은 절에** 있어야 함 |
| 6 | `USD 1.40 per million tokens` 셀을 못 읽음 | 과잉 차단 | 셀 | 셀이 직접 밝힌 단위를 인정하고, 단위의 숫자는 가격에서 제외 |

**열 자리(column header·cell)를 별도 corpus로 미루는 판단에는 검토자가
동의했고**, **표 heading은 이미 같은 함수를 지나는 문장 자리이니 지금 행렬에
넣으라**고 해서 넣었습니다. 넣자마자 4번이 잡혔습니다.

회귀 테스트 5건을 추가했습니다(83건 → 88건). 행렬은 세 자리 81판정입니다.

### 23차 — P2 8건, 그리고 지적이 문서 리더 밖으로 나옴

**5차 이후 처음으로 두 건이 분석 본체(A2·A3)에서 나왔습니다.**

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 5 | **sibling wave의 비결정적 DB 순서**가 분석 문구를 바꿔 정상 제외를 `ANALYSIS_CHANGED` 409로 막음 | 과잉 차단 | A3 대기열 | 질의에 `orderBy`, 계산에도 정렬 |
| 6 | `gemini-3.5-flash` → family `gemini`인데 `gemini-3.5-flash-lite` → `gemini-lite`. **같은 세대 형제로 분석되지 않음** | 우회 | A2 세대 판정 | tier 단어를 **전부** 제거 |
| 1 | 포함 절의 `[^,]*`가 마침표를 넘어 다음 문장을 삼켜 Batch 가격이 표준으로 읽힘 | 우회 | preamble·heading·ancestry | 절이 자기 문장 안에서 끝나도록 |
| 2 | `in USD, but cached input prices are not` · `in USD for input` · `in USD for regional customers`가 전부 페이지 선언으로 승격 | 우회 | 전 자리 | 통화 뒤의 부정·열 제한·대상 제한을 각각 판정 |
| 3 | 같은 prose 안에서 `blocked`가 정상 USD 선언에 묻힘 | 우회 | 전 자리 | **blocked가 usd를 이김** |
| 4 | `in the table above` 선언이 뒤에 오는 표의 통화로 인정 | 우회 | 두 번째 표 | 범위를 **앞/뒤로 구분** |
| 7 | `including text, image, and tool prices`에서 절이 첫 쉼표에서 끊겨 나머지가 남음 | 과잉 차단 | 전 자리 | 절이 주절 재개(`, are`)까지 이어짐 |
| 8 | `USD_STATED`는 `US dollars`를 인정하는데 셀 단어 목록에는 `dollar(s)`가 없음 | 과잉 차단 | 셀·열 헤더 | 목록을 통화 판정과 맞춤 |

5번은 **1차에서 지적받은 "화면 의존적 wave"가 정렬을 통해 되살아난 것**입니다.
같은 집합이라도 순서가 다르면 다른 문장이 되고, fingerprint는 그것을 변경으로
읽습니다.

1·2·3·4·7은 개념적으로 둘이었습니다.

- **범위 한정은 두 종류입니다.** `in the table below`는 그 표를 가리키고,
  `for regional customers`·`for input`·`in the table above`는 이 표에 대해
  아무것도 말하지 않습니다. 앞은 표 자리에서 선언이 되고 뒤는 **귀속 불가**입니다.
- **절의 경계는 문장을 넘지 않고, 주절이 재개되는 곳까지입니다.**

회귀 테스트 2건을 추가하고 corpus를 6문장 늘렸습니다(88건 → 90건, 행렬 99판정).

### 24차 — P2 6건, 수정

Codex 24차 세션은 파일:줄 표를 남긴 뒤 판정문 "승인"은 쓰지 않고 종료됐습니다.
아래 여섯은 그 프로브와 이 기록의 표입니다. 정식 승인은 25차(Claude)에 묻습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `modelTier()`가 첫 tier 단어에서 반환해 `gemini-3.5-flash-lite`가 `{word:"flash"}`가 되고 Flash의 별칭으로 `low` | 우회 | A2 | 연속 tier 단어는 한 자리(`flash-lite`). family는 그대로 `gemini` |
| 2 | Zhipu Flash 모델 페이지 URL이 `/guides/llm/`이라 307·404. 모델 페이지 문제가 가격표 prefill까지 지움 | 과잉 차단 | B1·prefill | `llms.txt`(2026-09-22)의 공유 페이지 `/guides/vlm/glm-5.3-flash.md`. 제목 `GLM-5.3-Flash/FlashX`는 두 SKU를 모두 가리킴. `model_page*` 문제는 가격을 지우지 않음 |
| 3 | `for cache reads`·`for pay-as-you-go usage`가 페이지 선언으로 통과 | 우회 | 세 자리 | `for` 꼬리는 양쪽 열을 다 대거나 바로 그 표를 가리킬 때만 선언 |
| 4 | `except cached input`에 `prices`가 없으면 제한이 사라짐 | 우회 | 세 자리 | 예외가 열 이름을 대면 귀속 불가. `excluding taxes`는 선언 |
| 5 | 포함 절을 지울 때 `but not … prices`까지 삭제 | 우회 | 세 자리 | 포함 절이 가격을 부정하면 지우기 전에 귀속 불가 |
| 6 | `United States dollars`·`American dollars`·`U.S. dollars` 셀이 `currency_unstated` | 과잉 차단 | 셀 | `USD_STATED`를 문장 표기와 맞춤. 맨 `dollars`는 넣지 않음 |

3·4·5는 corpus에 넣어 세 자리 모두에서 고정했습니다(33문장 → 37문장, 111판정).
2번은 2026-09-22 `llms.txt`와 공유 페이지 제목을 다시 읽어 확인했습니다.
`glm-5.3`은 계속 `/guides/llm/glm-5.3.md`입니다.

표 리더·triage·문서 prefill 테스트를 함께 186건 통과했습니다. 실제 픽스처
(glm-5.3·flash·flashx, grok-4.7·4.3, gpt-oss-120b)를 읽는 기존 테스트도
그 실행에 포함됩니다.

25차 독립 검토는 운영자 지시에 따라 **Claude**입니다. `--skip-preflight`는
2026-09-22에 이 작업에 한해 운영자가 승인했습니다.

### 25차 — P1 1건, P2 9건, 수정

Claude 25차(세션 `b6c2c480-bc5d-4138-a134-c5735ea032b2`)는 "승인"을 쓰지 않았습니다.
본문 번호 1은 P1, 2–8은 헤더가 센 P2 7건, 9–10은 본문이 P2로 둔 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 공유 페이지의 무명칭 문장이 두 SKU의 컨텍스트가 됨 | 우회 | 모델 페이지 | 제목이 SKU를 둘 이상 가리키면, 그 모델을 이름으로 부르는 문장만 귀속 |
| 2 | preamble의 `provides pricing`이 tier 제목이 됨 | 과잉 차단 | 표 preamble | 가격 명사 규칙은 제목에서는 어디든, 문단에서는 문장 첫머리만 |
| 3 | preamble의 첫 `Standard prices`가 뒤의 `Turbo pricing`을 가림 | 우회 | 표 preamble | 문장마다 판정. serving tier(`processing`·`mode`·`lane`)는 전부 |
| 4 | `pricing in AED`가 `prices`가 아니라 통화 검사를 통과 | 우회 | 제목·preamble | `MENTIONS_PRICES`에 `pricing`·`priced` |
| 5 | `in USD excluding cached input prices`가 쉼표가 없어 침묵 | 우회 | 세 자리 | 쉼표 없는 예외가 열을 빼면 귀속 불가. `excluding taxes`는 선언 |
| 6 | 문장 경로가 맨 `dollars`를 USD로 읽음 | 우회 | 페이지·제목·preamble | `USD_AT`·`USD_PHRASE`에서 맨 `dollars` 제외 |
| 7 | `flash` / `flash-lite`가 "한 글자 차이"로 안내됨 | 오진술 | A3 | 접두가 하이픈을 넘지 않고, 추가 글자는 하나 |
| 8 | `whisper-large-v3-turbo`가 `large-turbo`로 이어짐 | 오분류 | ID | 연속된 tier 단어만 한 자리. 끊기면 마지막 연속 구간 |
| 9 | 공유 페이지의 FlashX 프로모션이 Flash 가격까지 보류 | 과잉 차단 | B3 | 다른 SKU만 부르는 문장은 이쪽에 안 붙임. 무명칭 프로모션은 양쪽 보류. 요약에는 한 번 |
| 10 | 파서 버전이 `2026-09-21.1`에 멈춤 | 우회 | 저장 증거 | `2026-09-22.1`. 이전 행은 재수집 전까지 prefill 안 함 |

제목의 `vendor/model-id` 슬래시는 SKU 결합이 아닙니다. `embedding`의 복수
`embeddings`도 범위 단어에 넣었습니다. 빈 정규식 `SCOPE_WORD`는 지웠습니다.

통화 corpus는 44문장, 세 자리 132판정입니다. 표 리더·triage·문서 prefill
테스트 189건이 통과했습니다.

26차 독립 검토도 Claude입니다. `--skip-preflight` 예외는 25차와 같습니다.

### 26차 — P2 4건, 수정

로컬 Claude Code CLI(`C:\Users\Vyper\.local\bin\claude.exe`, 읽기 전용) 26차는
"승인"을 쓰지 않았습니다. P1은 없었고 P2는 4건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `search`가 `research`에, `scale`이 `scales`에, `flex`가 `Flexible`에 맞음 | 과잉 차단 | 제목·문단 | 비표준 구간은 단어 경계. 문단 전체는 보지 않고, 문장을 여는 요율 단어만 |
| 2 | `Transparent pricing`·`Current prices`·`Pricing:`가 tier | 과잉 차단 | preamble·한 단어 제목 | 문단은 알려진 요율 단어만 tier. 제목의 콜론은 떼고 검사 |
| 3 | 두 SKU를 함께 부르는 문장이 양쪽에서 탈락 | 과잉 차단 | 모델 페이지 | 제목이 가리키는 SKU만 부르면 각 SKU의 사실. 제목 밖 모델이 있으면 버림. 무명칭 문장은 여전히 어느 쪽도 아님 |
| 4 | `mini-fast`의 kind가 `speed` | 오진술 | ID | 한 구간의 kind는 첫 단어. `grok-3-mini-fast`는 economy, 단어는 `mini-fast`. 세대 숫자로 끊긴 `claude-opus-5-fast`의 마지막 구간은 그대로 `fast` |

2026-09-22에 받은 `docs.z.ai` Flash 공유 페이지에서 1M을 말하는 문장은
GLM-5.3도 함께 부르므로 Flash·FlashX의 컨텍스트로 쓰지 않습니다. 카드의
`1M`·`128K`는 문장이 아닙니다. 파서 버전은 `2026-09-22.2`입니다.

27차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 27차 — P2 3건, 수정

로컬 Claude Code CLI 27차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `A has 128K and B has 1M`이 B에 128K를 줌 | 오진술 | 모델 페이지 | 제목 SKU가 둘 이상인 문장은 그 수치가 딱 한 번일 때만 공유. 두 번이면 어느 쪽에도 주지 않음 |
| 2 | `Batch API prices`가 표준 요율로 읽힘 | 우회 | preamble | 가격 명사 앞의 요율 단어는 바로 앞이 아니어도 tier. `Discounted rates` 포함 |
| 3 | `Image prices are listed separately.`가 표준 표를 막음 | 과잉 차단 | preamble | `image`·`video`·`search`·`tool`은 문단의 요율 단어가 아님. 제목의 비표준 검사는 그대로 |

제목의 `cache writes`도 비표준 구간에 다시 넣었습니다. 파서 버전은 `2026-09-22.3`입니다.

28차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 28차 — P2 2건, 수정

로컬 Claude Code CLI 28차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 대조 문장의 첫 수치만 세어 양쪽 SKU에 붙음 | 오진술 | 모델 페이지 | 제목 SKU들이 `and`·쉼표·`/`만으로 이어진 한 주어일 때만 공유. 그 뒤에도 수치가 한 번이어야 함 |
| 2 | `Prices shown apply to batch requests.`와 `are discounted rates`가 통과 | 우회 | preamble | 요율 단어가 가격 명사를 두 단어 안에서 수식하면 문장 어디든 tier. 주어가 가격이고 `apply to`/`are for` 뒤에 요율 단어가 있어도 tier. `cache`는 첫 가격 명사 앞에 있을 때만 |

두 SKU를 함께 부르는 문장의 모달리티는 침묵으로 둡니다. 파서 버전은 `2026-09-22.4`입니다.

29차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 29차 — P2 2건, 수정

로컬 Claude Code CLI 29차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `128K- and 1M-token … respectively`가 패턴에 한 번만 잡혀 1M을 양쪽에 줌 | 오진술 | 모델 페이지 | 한 주어로 공유하려면 문장의 토큰 수치가 통틀어 한 번이어야 함 |
| 2 | `Cache hits are billed at 10% of the input rate.`가 표준 표를 막음 | 과잉 차단 | preamble | `cache`/`caching`이 가격 명사를 두 단어 안에서 수식할 때만 tier. `Cached input prices`는 표준 열 |

파서 버전은 `2026-09-22.5`입니다.

30차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 30차 — P2 3건, 수정

로컬 Claude Code CLI 30차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `Compared with A, B supports 1M`이 A에도 1M을 줌 | 오진술 | 모델 페이지 | 첫 이름 앞의 `Compared with`·`Unlike`·`Besides` 등은 한 주어가 아님 |
| 2 | 컨텍스트와 최대 출력을 한 문장에 적으면 둘 다 버려짐 | 과잉 차단 | 모델 페이지 | 수치가 서로 다른 사실에 하나씩 나뉘면 공유. 같은 사실에 두 수치면 버림 |
| 3 | `Prices below include cache write rates`가 표준 표를 버림 | 과잉 차단 | preamble | `include` 뒤의 cache 열 설명은 표준. `Caching prices`와 `Prices for cache writes`만 tier. 주석을 코드와 맞춤 |

파서 버전은 `2026-09-22.6`입니다.

31차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 31차 — P2 2건, 수정

로컬 Claude Code CLI 31차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `Compared to`가 대조어 목록에 없어 1M이 양쪽에 붙음 | 오진술 | 모델 페이지 | 문장이 모델 이름으로 열릴 때만 한 주어. `The`·`Both`만 앞에 허용 |
| 2 | `128,000- and 1,000,000-token`을 수치로 세지 않음 | 오진술 | 모델 페이지 | 하이픈 뒤 `token`, `- and`, `and` 다음 숫자도 수치 |

파서 버전은 `2026-09-22.7`입니다.

32차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 32차 — P1 1건, P2 1건, 수정

로컬 Claude Code CLI 32차는 "승인"을 쓰지 않았습니다. P1 1건, P2 1건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `Flash`·`FlashX`처럼 숫자가 없는 짧은 제목 별칭을 모델 이름으로 못 읽음. `FlashX supports a 1M-token context window, unlike GLM-5.3-Flash.`에서 Flash만 보여 1M이 Flash에 붙고, 프로모션 문장도 반대 SKU를 막음 | 오진술 | 모델 페이지 | 슬래시 제목의 마지막 조각과 뒤 접미사를 전체 이름에 묶음. 이름이 보이면 그 SKU만. 한 주어가 아니면 양쪽 모두 침묵 |
| 2 | 한 주어 판정이 원문 문장 앞머리만 봐서 굵게·목록·백틱·링크가 실제 공유 사실을 막음 | 과잉 차단 | 모델 페이지 | 링크는 라벨만 남기고 `*_`와 앞머리 기호를 벗긴 문장으로 이름·수치를 읽음 |

파서 버전은 `2026-09-22.8`입니다.

33차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 33차 — P2 3건, 수정

로컬 Claude Code CLI 33차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 3자 접미사 `Air`가 버려져 `Air … while AirX`에서 AirX가 Air의 128K를 받음 | 오진술 | 모델 페이지 | 3자는 제목의 대소문자 그대로 이름. 1–2자는 공유 페이지의 크기 사실을 비움 |
| 2 | `A and B …, and the latter supports 1M`이 한 주어로 통과 | 오진술 | 모델 페이지 | `the latter`·`the former`·`only the`·서수·`the X variant`가 있으면 한 주어가 아님 |
| 3 | 모델 페이지 프로모션이 일일 리포트에서 가격표가 모든 가격을 막은 것처럼 인쇄 | 오진술 | 일일 리포트 | 모델 페이지 문장은 그 모델만 막는다고 적음. 가격표 문장은 이전 문구 |

파서 버전은 `2026-09-22.9`입니다.

34차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 34차 — P2 3건, 수정

로컬 Claude Code CLI 34차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `the faster model`이 한 주어로 통과해 1M이 양쪽에 붙음. `the first token`은 반대로 1M을 지움 | 오진술 / 과잉 차단 | 모델 페이지 | 비교급과 `the … model` 형태를 선택 표현으로 봄. `the first token`은 그대로 둠 |
| 2 | `Flash-series`·`flash attention`이 Flash만 지목해 프로모션과 1M이 한쪽으로 감 | 우회 | 모델 페이지 | 별칭은 제목의 대소문자만. 뒤에 하이픈이 붙으면 이름이 아님. `all`·`series`·`models`는 제목의 모든 SKU |
| 3 | OpenAI 모델 페이지의 미검토 프로모션이 리포트에 안 나옴 | 오진술 | 일일 리포트 | 문제 코드를 남기고, 다른 공급자와 같이 모델 페이지 문장으로 기록 |

파서 버전은 `2026-09-22.10`입니다.

35차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 35차 — P2 2건, 수정

로컬 Claude Code CLI 35차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `all GLM-5.3 models`처럼 제목 밖 모델을 부르는 프로모션이 공유 페이지에서 사라짐 | 우회 | 모델 페이지 | 계열 단어이거나 제목 밖 모델 이름이면 제목의 모든 SKU에 적용 |
| 2 | `the second supports 1M`이 한 주어로 통과 | 오진술 | 모델 페이지 | 마지막 이름과 수치 사이에 새 절(`and the`, `while`, `whereas`, `but`)이 있으면 그 수치는 그 이름들의 것이 아님 |

파서 버전은 `2026-09-22.11`입니다.

36차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 36차 — P2 2건, 수정

로컬 Claude Code CLI 36차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 절 경계가 별칭의 짧은 글자를 전체 이름과 비교해 별칭 문장을 못 봄 | 오진술 | 모델 페이지 | 맞춘 글자의 길이와 전체 이름을 나눠 봄. `Flash and FlashX … the second`는 어느 쪽도 1M을 받지 않음 |
| 2 | `, and the`가 쉼표에만 걸려 쉼표 없는 `and the second`가 통과 | 오진술 | 모델 페이지 | 마지막 이름과 수치 사이에 새 주어(`the`, `it`, `its`, `one`, `former`, `latter`)가 있으면 그 수치는 그 이름들의 것이 아님 |

파서 버전은 `2026-09-22.12`입니다.

37차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 37차 — P2 3건, 수정

로컬 Claude Code CLI 37차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 새 주어 규칙이 수치에만 있고 `imageInput`은 문장 전체를 받음 | 오진술 | 모델 페이지 | 모달리티도 같은 규칙. `the second accepts images`는 어느 쪽도 이미지가 아님 |
| 2 | `the`만으로 `support the same 1M`이 버려짐 | 과잉 차단 | 모델 페이지 | 한정사 뒤에 자기 동사가 있을 때만 새 주어 |
| 3 | 단일 SKU 페이지는 같은 종류의 수치 둘 중 왼쪽을 집음 | 오진술 | 모델 페이지 | 한 문장에 같은 사실이 둘이면 어느 쪽도 받지 않음 |

파서 버전은 `2026-09-22.13`입니다.

38차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 38차 — P2 2건, 수정

로컬 Claude Code CLI 38차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 이름보다 앞에 있는 한 종류의 수치가 이 모델의 것이 됨 | 오진술 | 모델 페이지 | 페이지 이름보다 앞의 사실은 그 이름의 것이 아님 |
| 2 | 앞 절의 text-only가 이 모델의 모달리티가 됨 | 오진술 | 모델 페이지 | 같은 규칙. 이름 뒤의 image input만 남음. 둘 다 이름 뒤에 있으면 비움 |

파서 버전은 `2026-09-22.14`입니다.

39차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 39차 — P2 1건, 수정

로컬 Claude Code CLI 39차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 1건입니다. 같은 결함의 절 순서를 뒤집은 네 가지 재현입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 이름 뒤에 오는 이전 세대의 수치가 이 모델의 것이 됨 | 오진술 | 모델 페이지 | 이전 세대·predecessor 절 안의 사실은 버림. 같은 사실이 서로 다른 값이면 비움 |

`whereas the previous generation offered a 128K`는 컨텍스트를 비우고 최대 출력 64,000은 남깁니다. 앞 문장만 이전 세대를 말하는 페이지는 그 문장을 건너뛰고 이 모델의 1M을 읽습니다. `###` 제목이라 페이지 이름을 못 읽는 경우에도 같은 절 규칙이 적용됩니다. 모달리티는 이전 세대의 text-only를 이 모델의 값으로 쓰지 않습니다.

파서 버전은 `2026-09-22.15`입니다.

40차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 40차 — P2 2건, 수정

로컬 Claude Code CLI 40차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 복수형·한정사 없는 이전 세대와 `whose predecessor`가 이 모델의 값이 됨 | 오진술 | 모델 페이지 | 명사 복수, 한정사 생략, `whose`를 같은 주어로 봄. 새 주어의 동사에 과거형을 넣음 |
| 2 | 쉼표 없는 비교 꼬리가 문장 앞의 수치까지 버림 | 과잉 차단 | 모델 페이지 | 절은 `than`·`whereas`·`while`·`unlike` 등 비교 표지에서 시작 |

`whereas earlier models offered a 128K`는 컨텍스트를 비우고 최대 출력 200,000은 남깁니다. `than the previous generation` 앞의 1M은 이 모델의 컨텍스트로 남습니다.

파서 버전은 `2026-09-22.16`입니다.

41차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 41차 — P2 2건, 수정

로컬 Claude Code CLI 41차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `older models`, `previous-generation models`가 비교 표지 뒤에서 통과 | 오진술 | 모델 페이지 | `whereas`·`while`·`than` 등 비교 표지 뒤의 사실은 주어와 무관하게 버림 |
| 2 | 문두 `With/In the previous generation,` 뒤의 수치가 쉼표 밖으로 남음 | 오진술 | 모델 페이지 | 이전 세대를 말하고 이 모델 이름을 안 대는 문장은 통째로 버림 |

`whereas older models offered a 128K`는 컨텍스트를 비우고 최대 출력 200,000은 남깁니다. `With the previous generation, … 128K`는 컨텍스트를 비웁니다.

파서 버전은 `2026-09-22.17`입니다.

42차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 42차 — P2 3건, 수정

로컬 Claude Code CLI 42차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 비교 절 안의 쉼표 뒤에 있는 이전 세대 수치가 남음 | 오진술 | 모델 페이지 | 비교 절은 다음 번 이 모델 이름, 또는 문장 끝까지 |
| 2 | 이름을 안 대는 `older models` 문장이 크기를 읽음 | 오진술 | 모델 페이지 | 이름을 안 대는 문장은 크기를 읽지 않음. `this model`·`the model`만 예외 |
| 3 | `over`·`than`·`while`이 이 모델의 뒷수치를 지움 | 과잉 차단 | 모델 페이지 | 그 세 단어는 비교 표지에서 뺌 |

`whereas earlier models, released in 2025, offered a maximum output length of 128K`는 최대 출력을 비우고 앞의 1M 컨텍스트는 남깁니다. `trained on over 20T tokens and supports a 1M-token context window`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.18`입니다.

43차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 43차 — P2 2건, 수정

로컬 Claude Code CLI 43차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `while`·`over`를 표지에서 빼자 `older models`가 다시 통과 | 오진술 | 모델 페이지 | `older`·`legacy`·`outgoing`·`first generation`을 이전 세대 주어에 넣음 |
| 2 | 이름 바로 뒤 삽입절이 그 다음 사실까지 지움 | 과잉 차단 | 모델 페이지 | 이름 직후의 삽입절은 그 쉼표에서 닫음 |

`while older models offered a 128K`는 컨텍스트를 비우고 최대 출력 200,000은 남깁니다. `GLM-5.4, unlike the previous generation, supports a 1M-token context window`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.19`입니다.

44차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 44차 — P2 2건, 수정

로컬 Claude Code CLI 44차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 이름 직후 삽입절을 첫 쉼표에서 닫아, `which` 절의 64K·text-only가 이 모델의 값이 됨 | 오진술 | 모델 페이지 | `which`·`that`·`whose`가 이어지면 삽입절은 주절이 재개되는 쉼표까지 |
| 2 | 이전 세대 명사가 목적어여도 문장 끝까지 삼킴. `first generation`이 이 모델의 최초를 지움 | 과잉 차단 | 모델 페이지 | 주어 자리이거나 비교 표지 뒤일 때만 절을 염. `first generation`은 목록에서 뺌 |

`GLM-5.4, unlike the previous generation, which offered a maximum output length of 64K tokens, supports a 1M-token context window.`는 최대 출력을 비우고 컨텍스트는 1,000,000입니다. `backward compatible with older models and supports a 1M`의 컨텍스트는 1,000,000입니다. `is the first generation to support a 1M`의 컨텍스트는 1,000,000입니다. `and supports`는 새 주어가 아닙니다.

파서 버전은 `2026-09-22.20`입니다.

45차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 45차 — P2 2건, 수정

로컬 Claude Code CLI 45차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `previous generation models`처럼 핵어가 더 붙으면 절이 열리지 않음 | 오진술 | 모델 페이지 | 세대 명사 뒤의 `models`까지 주어로 봄 |
| 2 | 전치사 전치를 여섯 단어·문두로만 봐서 `On`·`Note that with`가 통과 | 오진술 | 모델 페이지 | 이전 세대 명사는 기본적으로 절을 염. 예외는 이 모델 동사의 목적어 뒤 `and` 연결 |

`while previous generation models offered a 128K`는 컨텍스트를 비웁니다. `On the previous generation, the model was limited to a 128K`와 `Note that with the previous generation, … 128K`도 비웁니다. `compatible with older models and supports a 1M`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.21`입니다.

46차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 46차 — P2 3건, 수정

로컬 Claude Code CLI 46차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `last generation`·`the predecessor`·`flagship`이 페이지 목소리로 통과 | 오진술 | 모델 페이지 | 이름을 안 대는 문장은 세대 명사가 있고 이 모델의 현재 능력이 아니면 읽지 않음. 형용사 목록은 늘리지 않음 |
| 2 | `this model`·`the model`이 절을 닫지 못해 뒤의 1M이 사라짐 | 과잉 차단 | 모델 페이지 | 한 모델 페이지에서 그 목소리가 현재 능력으로 재개되면 절이 거기서 끝남 |
| 3 | `and now supports`·`but supports`가 예외에서 빠짐 | 과잉 차단 | 모델 페이지 | `and`·`but`과 동사 사이에 부사·조동사를 둘까지 허용 |

`On the last generation, the model was limited to a 128K`는 컨텍스트를 비웁니다. `Compared with the previous generation, this model supports a 1M`의 컨텍스트는 1,000,000입니다. `and now supports a 1M`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.22`입니다.

47차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 47차 — P2 2건, 수정

로컬 Claude Code CLI 47차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 두 건은 페이지 목소리가 절을 닫는 규칙의 양면입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `is restricted`·`has`가 전치된 이전 세대 틀을 통과 | 오진술 | 모델 페이지 | `On/In/With/Under/For`가 세대 명사를 직접 이끌면 그 문장은 그 세대의 것. 동사 목록으로 가르지 않음 |
| 2 | `The model, unlike …, supports`가 삽입절 때문에 버려짐 | 과잉 차단 | 모델 페이지 | 페이지 목소리에도 이름 뒤 삽입절과 같은 재개를 적용 |

`On the previous generation, the model is restricted to a 128K`는 컨텍스트를 비웁니다. `The model, unlike the previous generation, supports a 1M`의 컨텍스트는 1,000,000입니다. `Compared with`·`For teams moving off`·`and now`·`but`은 그대로입니다.

파서 버전은 `2026-09-22.23`입니다.

48차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 48차 — P2 3건, 수정

로컬 Claude Code CLI 48차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `However, with the previous generation`처럼 문두 부사가 전치 틀을 피함 | 오진술 | 모델 페이지 | 쉼표로 닫히는 문두 부사구 하나를 틀 앞에 허용 |
| 2 | `older models`가 틀의 명사에서 빠져 128K가 통과 | 오진술 | 모델 페이지 | `models`·`versions`·`releases`는 이전 세대 형용사가 있을 때만 틀을 염 |
| 3 | `this release`·`latest version`이 틀에 걸려 이 모델의 1M이 사라짐 | 과잉 차단 | 모델 페이지 | 같은 구분. 형용사 없는 version·release는 이 모델의 문장 |

`However, with the previous generation, the model has a 128K`는 컨텍스트를 비웁니다. `With older models, the model has a 128K`도 비웁니다. `In this release, the model supports a 1M`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.24`입니다.

49차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 49차 — P2 2건, 수정

로컬 Claude Code CLI 49차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 쉼표 없는 전치 틀, `Across`, `Previously, the model supported`가 통과 | 오진술 | 모델 페이지 | 전치사는 닫힌 다섯 단어가 아니고, 쉼표는 없어도 됨. 페이지 목소리의 과거형은 이 모델의 현재 값이 아님 |
| 2 | Flash만 서비스 중일 때 기본형 후보가 편입 근거 없음으로 내려감 | 오진술 | 포트폴리오 | 같은 tier가 없으면, 후보보다 낮은 자리의 서비스 모델은 비교 기준으로 쓰지 않음 |

`On the previous generation the model is restricted to a 128K`는 컨텍스트를 비웁니다. `Across previous releases, the model has a 128K`도 비웁니다. `Previously, the model supported a 128K`도 비웁니다. 서비스 모델이 `glm-5.3-flash`뿐일 때 `glm-5.2`는 `older_generation`이 아닙니다.

파서 버전은 `2026-09-22.25`입니다.

50차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 50차 — P2 3건, 수정

로컬 Claude Code CLI 50차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `flash-lite`가 같은 종류라서 `flash`를 닫음 | 과잉 차단 | 포트폴리오 | 다른 단어가 더 낮은 세대를 닫지 않음. 같은 세대의 다른 자리는 그대로 비교 |
| 2 | 자리를 거절한 행이 세대를 못 읽었다고 말함 | 오진술 | 판정문 | `family_seat_mismatch`. 세대는 말하고, 비교하지 않은 이유를 말함 |
| 3 | `Previously, the model shipped with a 128K`가 통과 | 우회 | 모델 페이지 | 문두 시간 부사가 있으면 동사와 관계없이 현재 값이 아님 |

`gemini-3-flash`는 서비스 중인 `gemini-3.5-flash-lite` 때문에 `older_generation`이 되지 않습니다. `glm-5.2`와 `glm-5.3-flash`의 판정문은 5.2 세대와 더 낮은 자리를 말합니다. `Previously, the model shipped with a 128K`는 컨텍스트를 비웁니다.

파서 버전은 `2026-09-22.26`입니다.

51차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 51차 — P2 3건, 수정

로컬 Claude Code CLI 51차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 시간 부사가 이름 있는 문장에는 안 걸림 | 우회 | 모델 페이지 | 부사가 이 모델의 이름 또는 `the model`을 바로 열면 현재 값이 아님 |
| 2 | 문장 어디의 `previously`·`until`도 현재 값을 지움 | 과잉 차단 | 모델 페이지 | 부사는 주어 바로 앞만. `until`은 recently·now·then일 때만 |
| 3 | 자리 거절이 역할 공백을 `review`로 덮음 | 과잉 차단 | 판정·화면 | 역할 공백이면 `recommended` |

`Previously, GLM-5.4 shipped with a 128K`는 컨텍스트를 비웁니다. `The model supports a 1M; previously, it supported 128K`는 1M을 읽습니다. 추론 근거가 있고 서비스 모델이 Flash뿐인 `glm-5.2`는 `recommended`입니다.

파서 버전은 `2026-09-22.27`입니다.

52차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 52차 — P2 2건, 수정

로컬 Claude Code CLI 52차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 과거 절 판정이 컨텍스트 한 곳으로 문장 전체를 결정 | 우회 | 모델 페이지 | claim이 현재 동사보다 앞이면 그 값만 버림 |
| 2 | 기본형이 대기열에 있어도 자리 거절·역할 공백이 `recommended` | 과잉 승격 | 판정 | 두 분기에도 기본형 대기 규칙을 적용 |

`GLM-5.4 was limited to a maximum output length of 64K tokens and now supports a 1M-token context window.`는 컨텍스트 1,000,000, 출력은 비움. `accepted text-only input and now supports a 1M`의 이미지 입력은 비움. 같은 대기열에 `glm-5.3`이 있으면 `glm-5.3-plus`는 `review`입니다.

파서 버전은 `2026-09-22.28`입니다.

53차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 53차 — P2 2건, 수정

로컬 Claude Code CLI 53차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 이름 뒤 아사이드 안의 과거 값이 현재 값으로 읽힘 | 우회 | 모델 페이지 | 아사이드 안의 과거 동사·시간 부사가 붙은 claim만 버림 |
| 2 | `-preview`가 같은 세대의 기본형으로 읽힘 | 과잉 차단 | 파동 | 미리보기 형제는 기본형이 아님 |

`GLM-5.4, which previously had a maximum output length of 64K tokens, now supports a 1M`은 컨텍스트 1,000,000, 출력은 비움. `which previously accepted text-only input`의 이미지 입력은 비움. `o1-preview`가 같은 대기열에 있어도 `o1-mini`는 그 미리보기를 기본형으로 기다리지 않습니다.

파서 버전은 `2026-09-22.29`입니다.

54차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 54차 — P2 3건, 수정

로컬 Claude Code CLI 54차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 괄호 아사이드의 과거 값이 현재 값으로 읽힘 | 우회 | 모델 페이지 | 괄호와 줄표도 이름 뒤 아사이드 |
| 2 | 아사이드 전체의 `was`·`used`가 현재 값을 지움 | 과잉 차단 | 모델 페이지 | 현재 동사가 claim보다 앞이면 그 값은 읽음 |
| 3 | 미리보기 배제가 파생형 문구 두 자리에 없음 | 오진술 | 파동 | `sameWaveSiblings`에서 미리보기를 한 번 제외 |

`GLM-5.4 (previously limited to a maximum output length of 64K tokens) now supports a 1M`은 컨텍스트 1,000,000, 출력은 비움. `which is used for agentic workflows and supports a 1M`은 1,000,000을 읽습니다. `gpt-5.7-mini-preview`는 `gpt-5.7`의 파생형 목록에 나오지 않습니다.

파서 버전은 `2026-09-22.30`입니다.

55차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 55차 — P2 1건, 수정

로컬 Claude Code CLI 55차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 1건입니다. 54차에서 고친 괄호 아사이드와 미리보기 배제는 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 줄표 아사이드의 닫는 위치가 한 칸 뒤 | 우회 + 과잉 차단 | 모델 페이지 | 닫는 줄표의 마지막 글자를 `close`로 맞춤 |

`GLM-5.4 — the first agentic release — offered a maximum output length of 64K tokens.`의 최대 출력은 비웁니다. `The model — unlike the previous generation — supports a 1M-token context window.`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.31`입니다.

56차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 56차 — P2 1건, 수정

로컬 Claude Code CLI 56차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 1건입니다. 55차의 공백 있는 줄표는 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 공백 없는 줄표 뒤의 절이 시제를 읽지 못함 | 우회 + 과잉 차단 | 모델 페이지 | 줄표 아사이드 뒤에만 공백 한 칸을 빌려 줌 |

`GLM-5.4—the first agentic release—offered a maximum output length of 64K tokens.`의 최대 출력은 비웁니다. `The model—unlike the previous generation—supports a 1M-token context window.`의 컨텍스트는 1,000,000입니다. 하이픈 세 개(`---`)도 줄표 하나로 읽습니다.

파서 버전은 `2026-09-22.32`입니다.

57차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 57차 — P2 1건, 수정

로컬 Claude Code CLI 57차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 1건입니다. 56차의 공백 없는 줄표 아사이드는 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 앞선 세대 문장의 `the model` 앞 공백이 필수라 붙은 줄표가 통과 | 우회 | 모델 페이지 | 세대 프레임이 공백 또는 줄표를 구분자로 받음 |

`With the previous generation—the model has a 128K-token context window.`의 컨텍스트는 비웁니다. `With the previous generation—now deprecated—the model has a 128K`도 비웁니다.

파서 버전은 `2026-09-22.33`입니다.

58차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 58차 — P2 1건, 수정

로컬 Claude Code CLI 58차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 1건입니다. 57차의 붙은 줄표 세대 프레임은 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 양쪽 공백이 있는 홑 하이픈이 줄표로 안 읽힘 | 우회 + 과잉 차단 | 모델 페이지 | 공백 있는 `-`만 아사이드로 받고, 그 하이픈은 새 주어의 단어가 아님 |

`GLM-5.4 - the first agentic release - offered a maximum output length of 64K tokens.`의 최대 출력은 비웁니다. `GLM-5.4 - unlike the previous generation - supports a 1M-token context window.`의 컨텍스트는 1,000,000입니다. `128K-token`처럼 붙여 쓴 하이픈은 그대로입니다.

파서 버전은 `2026-09-22.34`입니다.

59차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 59차 — P2 1건, 수정

로컬 Claude Code CLI 59차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 1건입니다. 58차의 공백 있는 홑 하이픈 아사이드는 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 새 주어 판정이 아사이드 닫는 위치를 보지 않음 | 우회 | 모델 페이지 | 이름 아사이드의 닫는 하이픈만 새 주어에서 빼고, 점 있는 번호는 단어로 읽음 |

`the Air tier - has a maximum output length of 64K`는 `glm-5.4`의 출력이 아닙니다. `the 4.6 model supports a 128K`도 이 모델의 컨텍스트가 아닙니다. 이름 바로 뒤 아사이드가 다시 여는 `supports a 1M`은 1,000,000입니다.

파서 버전은 `2026-09-22.35`입니다.

60차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 60차 — P2 2건, 수정

로컬 Claude Code CLI 60차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 59차의 공백 하이픈·점 있는 번호는 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 새 주어가 ASCII 하이픈만 단어로 셈 | 우회 | 모델 페이지 | 줄표 철자를 모두 단어로 읽고, `now`는 단어 예산 밖 |
| 2 | 이어 붙인 불릿 마커가 아사이드 닫힘으로 읽힘 | 우회 | 모델 페이지 | 불릿 줄은 문장을 새로 시작 |

`the Air tier — has a maximum output length of 64K`와 `the Air tier - now has a 64K`는 이 모델의 출력이 아닙니다. id만 있는 첫 불릿 다음의 `the Air tier - has a 64K`도 이 모델의 출력이 아닙니다.

파서 버전은 `2026-09-22.36`입니다.

61차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 61차 — P2 2건, 수정

로컬 Claude Code CLI 61차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 60차의 줄표 철자와 불릿 분리는 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 아사이드 뒤의 `now`가 주절 재개를 못 알아봄 | 과잉 차단 | 모델 페이지 | 동사 앞 부사도 아사이드 닫힘까지 되짚음 |
| 2 | 쉼표·둘째 줄표가 새 주어를 끊음 | 우회 | 모델 페이지 | 쉼표 구와 줄표 삽입구를 새 주어 안에 둠 |

`GLM-5.4 — unlike the previous generation — now supports a 1M`의 컨텍스트는 1,000,000입니다. `the Air tier, however, has a 64K`와 `the Air tier — a cheaper SKU — has a 64K`는 이 모델의 출력이 아닙니다.

파서 버전은 `2026-09-22.37`입니다.

62차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 62차 — P2 2건, 수정

로컬 Claude Code CLI 62차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 61차의 부사 재개와 짧은 쉼표·공백 줄표는 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 붙임 줄표·괄호·긴 쉼표가 새 주어를 끊음 | 우회 | 모델 페이지 | 줄표 표기를 한곳에 두고, 괄호와 길이 제한 없는 쉼표 구를 새 주어에 넣음 |
| 2 | 이름 아사이드 뒤의 삽입구가 주절 재개를 놓침 | 과잉 차단 | 모델 페이지 | 이름 안에서 시작한 주어만 뒤 삽입구를 재개로 읽음 |

`the Air tier—a cheaper SKU—has a 64K`, `the Air tier (a cheaper SKU) has a 64K`, `the Air tier, which is priced lower and aimed at high-volume workloads, has a 64K`는 이 모델의 출력이 아닙니다. `GLM-5.4, the flagship model, however, supports a 1M`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.38`입니다.

63차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 63차 — P2 2건, 수정

로컬 Claude Code CLI 63차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 62차의 여섯 문장은 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 다른 주어의 관계절 안 숫자가 이 모델의 값이 됨 | 우회 | 모델 페이지 | 한정사 뒤 `which`/`that`/`whose` 절이 닫히기 전의 숫자는 그 주어의 것 |
| 2 | 계사와 `delivers`/`ships`/`tops`를 새 주어로 못 읽음 | 우회 | 모델 페이지 | 그 동사를 새 주어 동사에 넣음 |

`the Air tier, which has a 64K, costs less`와 `the Air tier is limited to a 64K`는 이 모델의 출력이 아닙니다. 페이지 자신의 `, which …`는 그대로 이 모델의 절입니다.

파서 버전은 `2026-09-22.39`입니다.

64차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 64차 — P1 1건, P2 2건, 수정

로컬 Claude Code CLI 64차는 "승인"을 쓰지 않았습니다. P1은 1건, P2는 2건입니다. 63차의 아홉 문장은 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 목록에 없는 동사면 다른 등급의 숫자가 이 모델의 값이 됨 | 우회 | 모델 페이지 | 절을 여는 한정사 주어는 동사와 상관없이 그 주어의 것 |
| 2 | 이름 자신이나 이름 아사이드 안의 `, which`를 남의 절로 읽음 | 과잉 차단 | 모델 페이지 | 이름 앞에서 시작한 구와 이름 아사이드 안은 이 모델의 절 |
| 3 | `that is`가 이 모델의 문장을 자름 | 과잉 차단 | 모델 페이지 | 계사를 새 주어 동사에서 뺌. 한정사 주어가 `is limited`를 맡음 |

`while the Air tier keeps a 128K`는 이 모델의 창이 아닙니다. `The GLM-5.4 model, which supports a 1M`과 `GLM-5.4, the flagship model, which supports a 1M`, `a model that is tuned … and supports a 1M`의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.40`입니다.

65차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 65차 — P2 2건, 수정

로컬 Claude Code CLI 65차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 64차의 일곱 문장은 확인됐습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 이름 아사이드 안의 전치사 목적어 관계절까지 이 모델의 것으로 읽음 | 우회 | 모델 페이지 | 관계절이 붙는 명사구가 전치사의 목적어면 면제하지 않음 |
| 2 | 형제 라벨이 이 모델 이름을 품으면 이물 주어 구간이 그 뒤로 밀림 | 우회 | 모델 페이지 | 첫 언급부터 보고, 이름 뒤에 다른 명사가 있으면 이 모델이 아님 |

`GLM-5.3, a step up from the Air tier, which supports a 128K`의 컨텍스트는 비웁니다. `while the GLM-5.3 Air tier keeps a 128K`도 비웁니다. `the flagship model, which supports a 1M`은 1,000,000입니다.

파서 버전은 `2026-09-22.41`입니다.

66차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 66차 — P2 3건, 수정

로컬 Claude Code CLI 66차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 3건입니다. 65차의 다섯 문장은 확인됐습니다. A1–A4와 B1·B3에 새 지적은 없었고, A4와 B3는 이번 회차에서 정독하지 않았습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | `, and`로 열린 형제 절이 이물 주어 검사를 통과 | 우회 | 모델 페이지 | 등위접속사도 절 개시로 읽음. 동사 목록은 늘리지 않음 |
| 2 | `its`·`our`·고유명사 소유격이 두 검사를 빠짐 | 우회 | 모델 페이지 | 한정사와 전치사 목적어에 소유격과 `in`·`under` 등을 넣음 |
| 3 | 단일 페이지의 `the model`을 남의 주어로 읽음 | 과잉 차단 | 모델 페이지 | 공유 제목이 아니고 세대 프레임이 아닐 때만 이 페이지의 목소리 |

`, and the Air tier keeps a 128K`, `while its Air tier keeps a 128K`, `of our flagship tier, which supports a 1M`, `of Zhipu's flagship tier, which`, `under the flagship tier, which`의 컨텍스트는 비웁니다. `and the model supports a 1M`과 `: the model supports a 1M`은 단일 페이지에서 1,000,000입니다.

파서 버전은 `2026-09-22.42`입니다.

67차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 67차 — P2 2건, 수정

로컬 Claude Code CLI 67차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 66차의 여덟 문장은 확인됐습니다. A1–A4와 B1·B3에 새 지적은 없었습니다. 아사이드 안의 완결 절은 P3로만 적혀 있어 이번 수정에 넣지 않았습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 이름을 적지 않은 문장은 다른 주어 검사를 건너뜀 | 우회 | 모델 페이지 | 단일 페이지의 `the model` 뒤에서 같은 검사를 이어 감 |
| 2 | `the model`로 시작하는 다른 주어까지 면제됨 | 우회 | 모델 페이지 | 소유격과 전치사가 이어지면 이 페이지의 목소리가 아님 |

`The model is available in two tiers, and the Air tier supports a 128K`의 컨텍스트는 비웁니다. `and the model's Air variant supports a 128K`와 `and the models in the Air line keep a 128K`도 비웁니다. `and the model supports a 1M`은 1,000,000입니다.

파서 버전은 `2026-09-22.43`입니다.

68차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 68차 — P2 2건, 수정

로컬 Claude Code CLI 68차는 "승인"을 쓰지 않았습니다. P1은 없었고 P2는 2건입니다. 67차의 다섯 문장은 확인됐습니다. A2와 B1에는 새 지적이 없었고, A1·A3·A4·B3는 이번 회차에서 재검토하지 않았습니다. 단수·복수 `the models` 관찰은 P로 세지 않았습니다.

| # | 지적 | 방향 | 자리 | 대응 |
|---|---|---|---|---|
| 1 | 이름이 없으면 한정된 `the model`이 주어 검사를 끔 | 우회 | 모델 페이지 | 소유 판정과 주어 검사가 같은 한정 규칙을 씀. 한정된 보이스 뒤의 숫자는 다른 주어 |
| 2 | `the model now supports`가 페이지 목소리에서 빠짐 | 과잉 차단 | 모델 페이지 | 부사는 기존 capability 재개와 같은 규칙으로 허용 |

`The model's Air variant supports a 128K`와 `The model in the Air line …, and the flagship tier supports a 1M`의 컨텍스트는 비웁니다. `and the model now supports a 1M`과 `The model now supports a 1M`은 1,000,000입니다. `The model, unlike the previous generation, supports a 1M`도 1,000,000입니다.

파서 버전은 `2026-09-22.44`입니다.

69차 독립 검토도 같은 로컬 Claude Code CLI입니다.

### 69차 — 승인

로컬 Claude Code CLI 69차는 **승인**이라고 적었습니다. P1은 없고 P2도 없습니다. 68차의 여섯 문장과 zhipu 픽스처 27행(1M / 128K / 텍스트 전용)은 확인됐습니다. 셸이 없어 테스트는 실행하지 않았고, 판정은 파일을 읽은 추적입니다.

P3와 관찰은 승인의 조건이 아닙니다.

- `pageVoiceOwns`의 `PAGE_VOICE_OTHER` 줄은 바로 아래 판정과 같은 결과를 냅니다.
- `The model, in the Air line, supports a 128K`는 비제한적 쉼표 동격이라 P2로 올리지 않았습니다.
- `pageVoiceOwns`는 단수 `the model`만 보고, 다른 자리는 `models?`를 봅니다.
- `will support` 같은 미래 시제는 이번 변경이 만든 것이 아니고, 컨텍스트 창 경로입니다.
- 쓰이지 않는 통화 선언 네 개(`PAGE_DECLARATION_SUBJECT`, `NEGATED_DECLARATION`, `SCOPED_DECLARATION`, `deniesBeforeCurrency`)는 이전 회차에서 하나로 합친 흔적입니다.
- 가격 URL이 없는 공급자의 모델 페이지 호스트, 그리고 공유 문서와 모델 페이지가 함께 실패할 때의 상태 코드는 이번 변경 밖입니다.

## 실제 문서 파싱 결과

강화된 파서가 2026-09-21에 저장한 실제 픽스처를 그대로 읽습니다.

| 모델 | 입력 | 출력 | 컨텍스트 | 최대 출력 |
|---|---|---|---|---|
| `glm-5.3` | $1.4 | $4.4 | 1,000,000 | 128,000 |
| `glm-5.3-flash` | $0.15 | $0.50 | — | — |
| `glm-5.3-flashx` | $0.37 | $1.25 | — | — |
| `grok-4.7` | $2 | $6 | 500,000 | — |
| `grok-4.6` | $2 | $6 | 500,000 | — |
| `grok-4.3` | $1.25 | $2.50 | 1,000,000 | — |
| `openai/gpt-oss-120b` | $0.15 | $0.60 | 131,072 | 65,536 |

`grok-4.6`은 200k 초과 구간에 ×2 tier가 있고, 경계 일치와 캐시 배수까지 검증한
뒤에만 읽습니다.

## 검증

| 항목 | 결과 |
|---|---|
| unit 전체 | 10,021건 중 10,020 통과, 실패 0 |
| 표 리더 전용 | 26건 통과 |
| `tsc`, ESLint | 통과 |
| `check:encoding:strict` | 통과 |
| `security:regression` | 190건 통과 |
| `check:enum-constraints` | 125건 통과 |
| `check:locale-translation` | 6 locale, 2,080 key 통과 |
| `check:accent-tokens` | 26 파일, 14 역할 통과 |
| `check:policy-section-references` | 4,573 인용 통과 |
| `check:db-integration-coverage` | 137 suite 통과 |

**검증하지 못한 것**: 이 기계에 사용 가능한 DB가 없어 integration suite는 CI에서만
돌고, staging 실행은 하지 않았습니다.

## 남은 한계

- 사람 전용 7개 공급자는 링크만 제공합니다. HTML 스크레이핑은 별도 결정입니다.
- 벤치마크 사이트는 수집하지 않습니다. 품질 비교 근거는 여전히 사람이 넣습니다.
- 문서 근거는 **증거**이며 가격의 출처가 아닙니다. 요율은
  `lib/modelPricing.ts`에서만 나옵니다.
