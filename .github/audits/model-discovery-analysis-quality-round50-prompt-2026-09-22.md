# 50차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

49차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

전치 틀의 전치사는 `on`·`in`·`with`·`under`·`for` 다섯 단어가 아닙니다.
문두의 한 단어가 세대 명사를 직접 이끌면 틀입니다. `Compared`·`Unlike`·
`Whereas`·`Versus`는 그 단어가 아닙니다. 세대 명사와 `the model` 사이의
쉼표는 없어도 됩니다.

페이지 목소리가 과거형이면 그 문장은 이 모델의 현재 값이 아닙니다.
`Previously, the model supported a 128K`가 여기 해당합니다.

같은 tier의 서비스 모델이 없으면, 후보보다 낮은 자리의 서비스 모델은
세대 비교의 기준이 되지 않습니다. 이름을 안 단 id는 기본 자리이고,
economy·speed는 그보다 낮습니다. `glm-4.5-air`를 `glm-5.2`에 재는 기존
판정은 그대로입니다.

`On the previous generation the model is restricted to a 128K-token
context window.`
는 컨텍스트를 비웁니다.

`Across previous releases, the model has a 128K-token context window.`
는 컨텍스트를 비웁니다.

`Previously, the model supported a 128K-token context window.`
는 컨텍스트를 비웁니다.

서비스 중인 모델이 `glm-5.3-flash`뿐일 때 `glm-5.2`의 관계는
`no_shared_family`이고, 판정은 "편입 근거가 없습니다"가 아닙니다.

파서 버전은 `2026-09-22.25`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
