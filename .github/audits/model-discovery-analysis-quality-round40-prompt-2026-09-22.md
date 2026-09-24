# 40차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

39차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 1건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

이전 세대·predecessor를 주어로 하는 절 안의 사실은 이 모델의 것이 아닙니다.
숫자 사이의 쉼표는 절 경계가 아니고, 바로 이어지는 `which` 절은 그 절에
포함됩니다.

`GLM-5.3-Flash offers a maximum output length of 64K tokens, whereas the
previous generation offered a 128K-token context window.`
는 컨텍스트를 비우고, 최대 출력은 64,000입니다.

`GLM-5.4 is a multimodal model, whereas the previous generation accepted
text-only input.`
은 이미지 입력을 비웁니다.

앞 문장만 이전 세대를 말하고 다음 문장이 이 모델의 1M을 말하면 컨텍스트는
1,000,000입니다. 같은 사실이 서로 다른 값으로 두 문장에 남으면 비웁니다.
`###` 제목 페이지도 같은 절 규칙을 탑니다.

파서 버전은 `2026-09-22.15`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
