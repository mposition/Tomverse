# 18차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

17차 P2 5건 대응입니다. 개별 반례를 때우는 대신 **11차의 표 구조 계약과 같은
방식을 통화 선언에도** 적용했습니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 통화 선언을 형태로 인정합니다

지금까지는 "이 문장이 무엇을 한정하는가"를 해석하려 했습니다. 그 질문에는 유한한
답이 없어서 열 회차 동안 양방향으로 결함이 나왔습니다. 이제 묻는 것은 **"가격
페이지가 실제로 쓰는 형태 중 하나인가"**이고, 그 답은 유한합니다.

`PAGE_USD_DECLARATION`이 인정하는 형태(테스트로 고정):

```
All prices are in USD.
All prices are in US dollars (USD).
All prices are in [USD](url).
All prices are in USD and do not include taxes.
All prices are in USD, including image and tool prices.
All prices, including image and tool prices, are in USD.
All prices are denominated\nin USD.
Prices are in USD per 1M tokens.
Prices are not shown in the table below. All prices are in USD.
```

그 밖은 **침묵**입니다. `All prices are in USD for the table below.`는 인정되지
않고 표는 `currency_unstated`로 거절됩니다(통화 뒤에 올 수 있는 것은 `,`·`;`·`.`·
`and`·`per`·문장 끝뿐).

**외화는 페이지 어디든 통화 단어가 있으면 전체를 거절**합니다(`FOREIGN_CURRENCY`).
어느 표에 대한 말인지 알아내려 하지 않고 사람에게 넘깁니다.

**부정은 주어와 무관하게 "다른 통화다"**입니다
(`NEGATED_USD_DECLARATION`). `Token charges below are not in USD.` → `not_usd`.

## 그 밖의 대응

5. **네임스페이스.** 문서 셀이 `/`를 포함하면 그 전체가 이 모델의 id여야 하고,
   앞 문자가 식별자 문자면 거부합니다. `xvendor-a/target-1`은 `vendor-a/target-1`이
   아니고, groq의 `…120Bopenai/gpt-oss-120b`는 그대로 읽힙니다. 질의가 문서에 없는
   접두를 달고 오는 경우(`ZHIPU/GLM-5.3-Flash`)는 셀에 `/`가 없을 때만 허용합니다.

검증: 표 리더 73건, unit 10,067건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
세 픽스처의 페이지 판정은 zhipu·xai `usd`, groq `null` 그대로입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 각 항목에 **방향(우회 / 과잉 차단)**과 **실제 공급자 문서에서 가능한
표기인지**를 표시해 주십시오.

특히 새 형태 기반 판정이 **실제 공급자가 쓰는 정상 선언을 거절하는지** 봐 주세요 —
이 방식의 비용은 그쪽에 몰려 있습니다. 반례는 수집기가 실제로 읽는 `.md` 구조를
기준으로 삼아 주시고, 코드를 수정하지 말고 한국어로 답해 주세요.
