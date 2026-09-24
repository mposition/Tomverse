# 61차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

60차 로컬 Claude Code CLI 검토는 승인하지 않았습니다. P2 2건을 고친 뒤의
워킹 트리를 검토해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
이 세션에서 셸이 없으면 저장소 파일을 직접 읽으면 됩니다.

HEAD는 `50a63e353`입니다. 변경은 커밋되지 않았습니다.

## 이번에 고친 것

새 주어의 단어는 `—`, `–`, `---`, `--`, 공백 하이픈을 모두 받습니다.
`now` 같은 부사는 세 단어 예산 밖에 있습니다.

불릿으로 시작하는 줄은 자기 문장입니다. 다음 줄이 불릿이 아니면 그 불릿에
이어 붙습니다.

```
# GLM-5.4

- glm-5.4 — has a 1M-token context window
- the Air tier — has a maximum output length of 64K tokens
```

컨텍스트는 1,000,000이고 최대 출력은 비웁니다.

```
# GLM-5.4

- glm-5.4
- the Air tier - has a maximum output length of 64K tokens
```

최대 출력은 비웁니다.

`GLM-5.4 raises the ceiling while the Air tier — has a maximum output length of 64K tokens.`
의 최대 출력은 비웁니다.

`GLM-5.4 raises the ceiling while the Air tier - now has a maximum output length of 64K tokens.`
의 최대 출력은 비웁니다.

`GLM-5.4 - unlike the previous generation - supports a 1M-token context window.`
의 컨텍스트는 1,000,000입니다.

파서 버전은 `2026-09-22.36`입니다.

## 판정

P1 또는 P2가 있으면 파일:줄, 재현 문장, 방향(우회 / 과잉 차단 / 오진술),
자리, 그 표기가 실제 공급자 `.md`에 나올 수 있는지를 적어 주세요. 없으면
**승인**이라고 명시해 주세요. A1–A4, B1, B3도 이 변경 안에서 봐 주세요.

네 구조는 되돌리지 않습니다. 가격 헤더 완전 일치, 페이지 USD 선언의 모양,
`readCurrencyClaim()` 하나, `unattributable`과 침묵의 구분. 가격의 출처는
`lib/modelPricing.ts`이고 문서 숫자는 운영자 증거입니다.
