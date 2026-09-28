# 48차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

47차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

전치사 `on`·`in`·`with`·`under`·`for`가 세대 명사를 직접 이끌면, 그 문장은
그 세대의 문장입니다. 뒤의 동사가 `limited`인지 `restricted`인지 `has`인지는
보지 않습니다. `For teams moving off previous generation models`처럼
전치사가 세대 명사를 직접 이끌지 않는 문장은 이 틀이 아닙니다.
`Compared with`도 이 틀이 아닙니다.

페이지 목소리는 이름과 같이 삽입절을 건너뜁니다.
`The model, unlike the previous generation, supports`는 삽입절 뒤에서
재개된 것으로 읽습니다.

`On the previous generation, the model is restricted to a 128K-token
context window.`
는 컨텍스트를 비웁니다.

`With the previous generation, the model has a 128K-token context window.`
는 컨텍스트를 비웁니다.

`In the previous generation, the model is available only with a 128K-token
context window.`
는 컨텍스트를 비웁니다.

`The model, unlike the previous generation, supports a 1M-token context
window.`
의 컨텍스트는 1,000,000입니다.

`The model, unlike its predecessor, supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`Compared with the previous generation, this model supports a 1M-token
context window.`
의 컨텍스트는 1,000,000입니다.

`For teams moving off previous generation models, this model accepts image
input.`
은 이미지 입력이 있습니다.

파서 버전은 `2026-09-22.23`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
