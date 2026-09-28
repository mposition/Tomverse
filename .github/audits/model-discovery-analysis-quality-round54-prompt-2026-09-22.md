# 54차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

53차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

이름 바로 뒤 아사이드 안에 과거 동사나 시간 부사가 있으면, 그 안의 claim만
현재 값이 아닙니다. 주절의 값은 읽습니다.

`GLM-5.4, which previously had a maximum output length of 64K tokens, now supports a 1M-token context window.`
의 컨텍스트는 1,000,000이고 최대 출력은 비웁니다.

`GLM-5.4, which previously accepted text-only input, now supports a 1M-token context window.`
의 컨텍스트는 1,000,000이고 이미지 입력은 비웁니다.

미리보기 id는 같은 세대의 기본형이 아닙니다. `o1-preview`가 같은 대기열에
있어도 `o1-mini`의 분석은 그 미리보기를 먼저 결정하라고 말하지 않고,
우선순위를 `review`로 내리지 않습니다. 정식 기본형 `glm-5.3`이 대기열에
있는 파생형은 그대로 `review`입니다.

파서 버전은 `2026-09-22.29`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
