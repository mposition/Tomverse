# 46차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

45차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

이전 세대 명사는 기본적으로 절을 엽니다. 전치사를 문두 여섯 단어로 닫아
열거하지 않습니다. 열지 않는 예외는 그 명사가 이 모델 동사의 목적어이고
바로 뒤에 `and`와 이 모델의 동사가 이어질 때뿐입니다.
`compatible with older models and supports a 1M`이 그 예외입니다.

세대 명사 뒤에 핵어 `models`가 붙으면 그 명사구 전체를 주어로 봅니다.
`previous generation models offered`와 `previous-generation models accepted`가
여기 해당합니다.

`while`·`than`·`over`는 비교 표지로 되돌리지 않았습니다.

`GLM-5.4 raises the ceiling, while previous generation models offered a
128K-token context window.`
는 컨텍스트를 비웁니다.

`GLM-5.4 is a multimodal model, while previous-generation models accepted
text-only input.`
은 이미지 입력을 비웁니다.

`On the previous generation, the model was limited to a 128K-token context
window.`
는 컨텍스트를 비웁니다.

`Note that with the previous generation, the model was limited to a
128K-token context window.`
는 컨텍스트를 비웁니다.

`GLM-5.4 is fully backward compatible with older models and supports a
1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`GLM-5.4 is fully backward compatible with previous generation models and
supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.21`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
