# 44차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

43차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

`older`, `legacy`, `outgoing`, `first generation`을 이전 세대 주어로
봅니다. `while`·`than`·`over`는 비교 표지로 되돌리지 않았습니다.

이름 바로 뒤에 오는 삽입절은 그 절을 닫는 쉼표에서 끝납니다. 이름 뒤에
자기 사실이 먼저 나오고 그 다음 `whereas`가 오는 문장은 문장 끝까지
이전 세대의 것입니다.

`GLM-5.4 offers a maximum output length of 200K tokens, while older models
offered a 128K-token context window.`
는 컨텍스트를 비우고, 최대 출력은 200,000입니다.

`GLM-5.4 is a multimodal model, while older models accepted text-only input.`
은 이미지 입력을 비웁니다.

`GLM-5.4 doubles the context window over older models, which offered a
maximum output length of 64K tokens.`
은 최대 출력을 비웁니다.

`GLM-5.4, unlike the previous generation, supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

`GLM-5.4, whose predecessor was limited to 64K, supports a 1M-token context
window.`
의 컨텍스트는 1,000,000입니다.

`GLM-5.4, unlike the previous generation, accepts image input.`
은 이미지 입력이 있습니다.

파서 버전은 `2026-09-22.19`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
