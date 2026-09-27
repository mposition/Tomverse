# 29차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

28차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

공유 페이지에서 두 SKU가 한 문장에 나오면, 그 이름들이 `and`·`or`·쉼표·`/`
만으로 이어진 하나의 주어일 때만 그 문장의 수치를 나눕니다. 수치도 그
패턴으로 한 번이어야 합니다.
`GLM-5.3-Flash and GLM-5.3-FlashX support a 128K-token context window.`는
양쪽 128K입니다.
`GLM-5.3-Flash supports a 128K-token context window, while GLM-5.3-FlashX
supports 1M tokens.`와
`GLM-5.3-Flash has a 128K-token context window and GLM-5.3-FlashX has a
maximum output length of 64K tokens.`는 이름 사이에 서술어가 있으므로
어느 쪽에도 주지 않습니다.

문단의 요율 판정은 두 가지입니다. 요율 단어가 가격 명사를 최대 두 단어
안에서 수식하면 문장 어디든 tier입니다 (`Batch API prices`,
`are discounted rates`). 문장의 주어가 가격이고 `apply to` 또는 `are for`
뒤에 요율 단어가 있으면 tier입니다 (`Prices shown apply to batch requests.`).
`Image prices`, `Transparent pricing`, `Flexible pricing`,
`Cached input prices`, `Prices below include cache write rates`는 tier가
아닙니다. `cache`는 첫 가격 명사보다 앞에 있을 때만 요율입니다.

두 SKU를 함께 부르는 문장은 모달리티에서 빼 두었습니다. 침묵입니다.
파서 버전은 `2026-09-22.4`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
