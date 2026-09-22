# 34차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

33차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

3글자 형제 접미사는 제목에 적힌 대소문자 그대로 모델 이름입니다.
`# GLM-4.5-Air/AirX` 아래
`Air supports a 128K-token context window, while AirX supports 1M tokens.`
는 어느 SKU도 컨텍스트를 받지 않습니다.
`Air and AirX support a 1M-token context window.`는 양쪽이 1,000,000을 받습니다.
소문자 `air`·`pro`는 이름이 아닙니다. 1–2글자 접미사가 있는 공유 제목은
크기 사실을 비웁니다.

`the latter`, `the former`, `only the`, `the first`·`the second` 같은 서수,
`the larger`, `the X variant`가 있으면 한 주어가 아닙니다.
`GLM-5.3-Flash and GLM-5.3-FlashX are multimodal models, and the latter
supports a 1M-token context window.`는 어느 쪽도 1M을 받지 않습니다.

모델 페이지의 미검토 프로모션은 일일 리포트와 공급자 행에서 그 페이지와
그 모델만 막는다고 적습니다. 가격표 문장은 이전과 같이 그 표의 모든 가격을
막는다고 적습니다.

파서 버전은 `2026-09-22.9`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
