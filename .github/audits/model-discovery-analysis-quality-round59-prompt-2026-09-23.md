# 59차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

58차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 1건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

이름 뒤 아사이드는 양쪽 공백이 있는 홑 하이픈만 줄표로 받습니다. 붙여 쓴
하이픈(`128K-token`, `GLM-5.4`)은 닫는 위치가 아닙니다. 그 공백 하이픈은
새 주어를 세는 단어가 아닙니다.

`GLM-5.4 - the first agentic release - offered a maximum output length of 64K tokens.`
의 최대 출력은 비웁니다.

`GLM-5.4 - unlike the previous generation - supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.34`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
