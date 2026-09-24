# 26차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

25차 Claude 검토는 승인하지 않았습니다. P1 1건과 P2 9건을 고친 뒤의
`git diff`(커밋되지 않은 워킹 트리, intent-to-add 포함)를 검토해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

공유 모델 페이지(`# GLM-5.3-Flash/FlashX`)에서 모델을 이름으로 부르지 않는
문장은 어느 SKU의 컨텍스트·출력 한도·입력 모달리티도 되지 않습니다.
`It supports a 128K-token context window.`는 Flash와 FlashX 모두 null입니다.
그 모델을 이름으로 부르는 문장만 귀속됩니다. 제목의 `vendor/model-id`처럼
뒤쪽 조각에 하이픈이 있으면 SKU 결합이 아니라 경로 하나이고, 네임스페이스를
버린 뒤 비교하지 않습니다.

요율 tier는 두 자리로 나뉩니다.

- 제목·상위 제목: `Fast pricing`이 문장 중간에 있어도 tier입니다. 매치는 첫
  하나가 아니라 전부입니다.
- 문단: `Turbo pricing`처럼 문장을 여는 경우만 tier입니다. `provides pricing`,
  `current prices`, `following prices`, `inference prices`, `updated prices`,
  `long context pricing`은 아닙니다.
- `processing` · `tier` · `lane` · `queue` · `mode`는 문단에서도 전부 봅니다.

`models and tools`라는 소개는 tool 요율 표가 아닙니다. 제목의 `Tools`는
그대로 비표준입니다. 맨 `tool`은 단어 경계로만 맞습니다.

`pricing` · `priced`는 가격을 말하는 단어입니다. `Model pricing in AED`,
`Pricing per 1M tokens in AED`, `Pricing shown in Saudi riyals`는 USD가
아닙니다.

`All prices are in USD excluding cached input prices.`는 쉼표가 없어도 귀속
불가이고, 페이지의 `All prices are in USD.`로 되돌아가지 않습니다.
`All prices are in USD excluding taxes.`는 선언입니다.

문장 경로도 맨 `dollars`를 USD로 읽지 않습니다. `All prices are in dollars.`
는 침묵이 아니라 다른 통화입니다. `US dollars` · `U.S. dollars` ·
`United States dollars` · `American dollars`는 그대로 USD입니다.

`flash`와 `flash-lite`는 한 글자 차이가 아닙니다. 추가 글자는 하나이고
하이픈을 넘지 않습니다. `flash` / `flashx`는 그대로 그 안내가 나갑니다.
`modelTier()`는 연속된 tier 단어만 잇습니다. `whisper-large-v3-turbo`의
단어는 `turbo`이고, `grok-3-mini-fast`의 단어는 `mini-fast`입니다.

공유 페이지에서 한 SKU만 부르는 프로모션 문장은 다른 SKU의 가격을 보류하지
않습니다. 아무도 부르지 않는 프로모션 문장은 양쪽을 보류합니다. 페이지가
모델 하나이면 예전과 같습니다. 같은 문장은 수집 요약에 한 번만 남습니다.

파서 버전은 `2026-09-22.1`입니다. 그 이전 버전으로 저장된 행은 재수집
전까지 prefill되지 않습니다.

## 행렬

통화 corpus는 44문장, 페이지·제목·preamble 132판정입니다. 표 리더·triage·
문서 prefill 테스트 189건이 이 트리에서 통과했습니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리(페이지 / 제목 / preamble / 셀 / 모델 페이지 / ID), 그 표기가 실제
공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면 **승인**이라고 명시해
주세요. A1–A4, B1, B3도 이 diff 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
