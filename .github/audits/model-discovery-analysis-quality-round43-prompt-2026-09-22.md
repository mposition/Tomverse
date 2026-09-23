# 43차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

42차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

비교 절은 안의 쉼표에서 끊지 않습니다. 이전 세대 주어나 `whereas` ·
`unlike` · `compared with/to` · `versus` · `up from`에서 시작해, 그 다음
이 모델의 이름 또는 문장 끝까지입니다.

`over` · `than` · `while`은 비교 표지가 아닙니다.

이 모델의 이름을 대지 않는 문장은 크기를 읽지 않습니다. 단일 모델
페이지에서 `this model` 또는 `the model`이라고 말한 문장만 예외입니다.

`GLM-5.4 offers a 1M-token context window, whereas earlier models, released
in 2025, offered a maximum output length of 128K tokens.`
는 컨텍스트 1,000,000이고 최대 출력은 비웁니다.

`GLM-5.4 lifts that ceiling: with the previous generation, developers were
limited to a 128K-token context window.`
는 컨텍스트를 비웁니다.

`With older models, developers were limited to a 128K-token context window.`
는 컨텍스트를 비웁니다.

`GLM-5.4 was trained on over 20T tokens and supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`While GLM-5.4 supports a 1M-token context window, output is capped at 64K tokens.`
의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.18`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
