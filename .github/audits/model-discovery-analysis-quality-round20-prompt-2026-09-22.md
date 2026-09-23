# 20차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

19차 P2 3건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **범위 한정을 통화 앞 전체에서 봅니다.** `Image prices are in USD.`,
   `Batch prices are in USD.`, `Tool prices are in USD.`,
   `For the table below, all prices are in USD.` 전부 침묵입니다.
   다만 `including …` 절은 **제한이 아니라 포함**이므로 범위 검사에서 제외합니다 —
   `All prices, including image and tool prices, are in USD.`는 읽힙니다.
2. **축약 부정을 인식하고, 부정이 있는 context는 `USD_STATED`로도 긍정하지
   않습니다.** `Prices aren't in USD.` → `not_usd`.
   `Prices are not tax-inclusive in USD.` → `currency_unstated`(의도적 침묵),
   이제 **표 preamble 위치에서도 같습니다.**
3. **`in <대문자 3자>` 검사를 가격 문장에서만** 수행합니다.
   `Models are available in UAE.`·`Also available in AWS.`는 통과하고,
   `Local prices below are in AED.`는 거절됩니다.

## 테스트 결함을 함께 고쳤습니다

지적하신 대로 `zhipuUnder()`가 주어진 문장 뒤에 heading을 삽입하므로, "표 preamble"
테스트가 실제로는 **앞 구획 본문**을 검사하고 있었습니다. 표 preamble을 실제로
채우는 `zhipuPreamble()`을 만들어 두 경로를 따로 고정했습니다. 그 경로에서
`Prices aren't in USD.`가 파싱되던 것이 2번 수정의 실제 대상이었습니다.

검증: 표 리더 80건, unit 10,074건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
세 픽스처의 페이지 판정은 zhipu·xai `usd`, groq `null` 그대로입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 각 항목에 **방향(우회 / 과잉 차단)**과 **실제 공급자 문서에서 가능한
표기인지**를 표시해 주십시오.

**테스트가 의도한 경로를 실제로 지나는지도 함께 봐 주십시오** — 19차의 지적이
그것이었고, 같은 착오가 다른 테스트에도 있을 수 있습니다. 반례는 수집기가 실제로
읽는 `.md` 구조를 기준으로 삼아 주시고, 코드를 수정하지 말고 한국어로 답해 주세요.
