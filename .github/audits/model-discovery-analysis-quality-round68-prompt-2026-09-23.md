# 68차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

67차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

이름을 적지 않은 문장도 다른 주어 검사를 통과합니다. 단일 모델 페이지에서
`the model`·`this model` 뒤에서 같은 검사를 이어 갑니다. 공유 제목과 앞선
세대 프레임은 그 검사를 열지 않습니다.

`the model` 면제는 머리 명사가 `model(s)`이고 그 뒤에 동사나 계사만 올 때입니다.
`'s`로 이어지거나 `in`·`of`·`under` 같은 전치사가 오면 다른 주어입니다.

`The model is available in two tiers, and the Air tier supports a 128K-token context window.`
의 컨텍스트는 비웁니다.

`GLM-5.3 raises the ceiling, and the model's Air variant supports a 128K-token context window.`
의 컨텍스트는 비웁니다.

`GLM-5.3 raises the ceiling, and the models in the Air line keep a 128K-token context window.`
의 컨텍스트는 비웁니다.

`GLM-5.4 is now generally available, and the model supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`The model supports a 1M-token context window`은 그대로 1,000,000입니다.

파서 버전은 `2026-09-22.43`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
