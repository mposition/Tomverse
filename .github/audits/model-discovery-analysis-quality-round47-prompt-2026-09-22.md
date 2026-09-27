# 47차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

46차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

형용사 목록에 `last`를 넣지 않았습니다. 모델 이름을 안 대는 문장에
generation·predecessor·flagship·version·release가 있고, `the model` /
`this model` 뒤가 이 모델의 현재 능력이 아니면 그 문장은 읽지 않습니다.
`was limited`와 `is limited`는 현재 능력이 아닙니다.

한 모델을 다루는 페이지에서 `this model` / `the model`이 `supports`·
`accepts`·`is`처럼 현재 능력으로 이어지면, 이전 세대 절은 그 목소리에서
끝납니다. `the model was limited`는 절을 닫지 않습니다.

`and`뿐 아니라 `but`도 이 모델 동사의 이어짐입니다. 접속사와 동사 사이에
부사나 조동사를 둘까지 둡니다. `and now supports`가 여기 해당합니다.

`On the last generation, the model was limited to a 128K-token context
window.`
는 컨텍스트를 비웁니다.

`Note that on the predecessor, the model was limited to a 128K-token
context window.`
는 컨텍스트를 비웁니다.

`On the previous flagship, the model was limited to a 128K-token context
window.`
는 컨텍스트를 비웁니다.

`Compared with the previous generation, this model supports a 1M-token
context window.`
의 컨텍스트는 1,000,000입니다.

`Compared with the previous generation, the model supports a 1M-token
context window.`
의 컨텍스트는 1,000,000입니다.

`For teams moving off previous generation models, this model accepts image
input.`
은 이미지 입력이 있습니다.

`GLM-5.4 is fully backward compatible with previous generation models and
now supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`GLM-5.4 replaces the previous generation but supports a 1M-token context
window.`
의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.22`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
