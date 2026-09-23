# 55차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

54차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

이름 뒤의 괄호와 줄표도 쉼표와 같은 아사이드입니다. 아사이드 안의 claim은
그 claim보다 앞에 현재 동사가 다시 나오면 읽습니다. 과거 표지만 앞에 있으면
버립니다.

`GLM-5.4 (previously limited to a maximum output length of 64K tokens) now supports a 1M-token context window.`
의 컨텍스트는 1,000,000이고 최대 출력은 비웁니다.

`GLM-5.4 (previously a text-only input model) supports a 1M-token context window.`
의 이미지 입력은 비웁니다.

`GLM-5.4, which is used for agentic workflows and supports a 1M-token context window, is available on the Open Platform.`
의 컨텍스트는 1,000,000입니다.

`GLM-5.4, which was released on 2026-09-01 and supports a 1M-token context window, is generally available.`
의 컨텍스트는 1,000,000입니다.

미리보기는 `sameWaveSiblings`에서 한 번 빠집니다. `gpt-5.7`의 분석은
`gpt-5.7-mini-preview`를 파생형으로 부르지 않습니다. `glm-5.3-flash`는
`glm-5.3-flashx-preview`와 한 글자 차이라고 말하지 않습니다. 정식
`glm-5.3-flashx`와의 한 글자 차이는 그대로입니다.

파서 버전은 `2026-09-22.30`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
