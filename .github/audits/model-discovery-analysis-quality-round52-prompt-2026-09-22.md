# 52차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

51차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

시간 부사는 문장 전체가 아니라, 이 모델의 이름 또는 `the model` 바로 앞에
있을 때만 그 문장을 과거로 읽습니다. `until`은 `recently`·`now`·`then`이
붙을 때만 과거입니다. 이름 뒤의 과거 동사가 측정값을 담고 있으면 그 문장도
현재 값이 아닙니다. `and supports`처럼 현재 동사가 그 값을 받으면 읽습니다.

`Previously, GLM-5.4 shipped with a 128K-token context window.`
는 컨텍스트를 비웁니다.

`GLM-5.4 offered a 128K-token context window.`
는 컨텍스트를 비웁니다.

`The model supports a 1M-token context window; previously, it supported 128K tokens.`
는 1,000,000입니다.

`Until further notice, the model supports a 1M-token context window.`
는 1,000,000입니다.

`Previously unavailable in the EU, the model supports a 1M-token context window.`
는 1,000,000입니다.

자리 거절은 역할 공백을 덮지 않습니다. 후보 근거가 추론이고 서비스 모델이
`glm-5.3-flash`뿐이면 `glm-5.2`의 우선순위는 `recommended`입니다.
판정문은 더 낮은 자리를 그대로 말합니다.

파서 버전은 `2026-09-22.27`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
