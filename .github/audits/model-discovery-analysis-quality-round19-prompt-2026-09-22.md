# 19차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

18차 P2 6건 중 5건을 고치고 1건은 의도적으로 침묵에 두었습니다.
`git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **네임스페이스 id의 양 끝을 봅니다.** `vendor-a/target-1-pro`·`vendor-a/target-10`·
   `xvendor-a/target-1` 전부 `vendor-a/target-1`이 아니고,
   groq의 `…120Bopenai/gpt-oss-120b`는 그대로 읽힙니다.
2. **부정은 주어를 묻지 않고 인접성만 봅니다.**
   `\b(?:not|never|no longer)\s+(부사)?\s*(동사)?\s*in\s+(us dollars?|usd)\b`.
   `Usage fees below are not in USD.` → `not_usd`.
3. **절이 낀 선언을 인정합니다**(`PAGE_USD_DECLARATION_WITH_CLAUSE`). 단, 그 절에
   범위 한정 단어(`table`·`section`·`below`·`tool`·`image`·`video`·`audio`·`voice`·
   `search`·`tier`·`plan`)가 있으면 인정하지 않습니다.
   `All prices do not include taxes and are in USD.` → 읽힘.
   `All prices in the table below are in USD.` → 침묵.
4. **`in <대문자 3자>` 자리의 코드도 외화로 봅니다.** `Local prices below are in AED.`
   → `not_usd`. 페이지 전체에서 대문자를 찾지 않고 `in` 뒤만 봅니다.
5. **`won(?!'t)`.** 지적대로 xAI 픽스처에 같은 뜻의 비축약형이 이미 두 번 있어서,
   축약 한 번으로 그 공급자가 통째로 파싱 불가가 될 수 있었습니다.
6. **형태 목록 확장**: `All payments are in USD`(실제 Anthropic 문구),
   `Unless otherwise noted, all prices are in USD.`, `All listed prices are in USD.`,
   `All prices are in USD:`.

## 의도적으로 보류한 1건

`Prices are not tax-inclusive in USD.`는 여전히 `currency_unstated`입니다.
이 어순을 읽으려면 다시 "`not`이 무엇을 부정하는가"를 해석해야 하고, 그 해석이
열 회차 동안 양방향 결함을 만들었습니다. **추측 대신 거절**을 택했습니다.
동의하지 않으시면 근거와 함께 적어 주십시오.

검증: 표 리더 77건, unit 10,071건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
세 픽스처의 페이지 판정은 zhipu·xai `usd`, groq `null` 그대로입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 각 항목에 **방향(우회 / 과잉 차단)**과 **실제 공급자 문서에서 가능한
표기인지**를 표시해 주십시오. 반례는 수집기가 실제로 읽는 `.md` 구조를 기준으로
삼아 주시고, 코드를 수정하지 말고 한국어로 답해 주세요.
