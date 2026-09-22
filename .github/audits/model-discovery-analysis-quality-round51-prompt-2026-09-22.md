# 51차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

50차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

같은 종류의 다른 단어가 더 낮은 세대를 닫지 않습니다. `gemini-3-flash`는
서비스 중인 `gemini-3.5-flash-lite` 때문에 `older_generation`이 되지
않습니다. 같은 세대의 `flash`와 `flash-lite`는 계속 `same_generation`입니다.
더 높은 종류가 더 낮은 세대를 닫는 기존 판정은 그대로입니다.
`glm-4.5-air`와 `glm-5-turbo`는 서비스 중인 `glm-5.2`에 대해
`older_generation`입니다.

자리를 거절한 비교는 `family_seat_mismatch`입니다. 판정문은 후보 세대를
말하고, 서비스 모델이 더 낮은 자리인지 다른 자리인지를 말합니다.
"세대도 역할도 확정되지 않아"는 이 경로에 붙지 않습니다.

문두의 시간 부사(`Previously`, `Formerly`, `Historically`, `In the past`,
`Up to now`, `Until`)가 있으면 그 문장은 이 모델의 현재 값이 아닙니다.
동사 목록은 늘리지 않았습니다.

`Previously, the model shipped with a 128K-token context window.`
는 컨텍스트를 비웁니다.

`Formerly, the model delivered a 128K-token context window.`
는 컨텍스트를 비웁니다.

서비스 중인 모델이 `glm-5.3-flash`뿐일 때 `glm-5.2`의 판정문은
5.2 세대와 더 낮은 자리를 말합니다.

파서 버전은 `2026-09-22.26`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
