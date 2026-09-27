# 49차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

48차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 3건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

전치 틀은 문두에 쉼표로 닫히는 부사구 하나를 허용합니다.
`However, with the previous generation`이 여기 해당합니다.
`Compared with`는 그 부사구가 아닙니다. `Compared`와 `with` 사이에 쉼표가
없습니다.

명사는 둘로 나뉩니다. `generation`·`predecessor`·`flagship`은 그 자체로
뒤를 가리킵니다. `version`·`release`·`model`은 이전 세대 형용사
(`previous`·`prior`·`earlier`·`preceding`·`older`·`legacy`·`outgoing`)가
앞에 있을 때만 틀을 엽니다. 그 형용사 목록은 이전 세대 주어와 같습니다.

`However, with the previous generation, the model has a 128K-token context
window.`
는 컨텍스트를 비웁니다.

`However, with the previous generation, the model accepts image input.`
은 이미지 입력을 비웁니다.

`With older models, the model has a 128K-token context window.`
는 컨텍스트를 비웁니다.

`On previous models, the model is restricted to a 128K-token context
window.`
는 컨텍스트를 비웁니다.

`In this release, the model supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`In the latest version, the model supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`With the latest release, the model now supports image input.`
은 이미지 입력이 있습니다.

파서 버전은 `2026-09-22.24`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
