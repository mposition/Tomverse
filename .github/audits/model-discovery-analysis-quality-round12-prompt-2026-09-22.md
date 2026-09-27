# 12차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

11차 P2 4건을 고쳤고, **범위에 대한 제안을 그대로 채택했습니다.** 공급자를 줄이는
대신 범용 3곳의 표 구조를 명시적으로 고정했습니다. `git diff`(intent-to-add 포함)를
검토해 주세요.

## 공급자별 문서 구조 계약 (채택한 제안)

각 공급자가 `expectedPriceHeaders`를 갖습니다 — 사람이 라이브 페이지에서 읽고
기록한 **표준 요율 표의 컬럼 행**입니다.

```
zhipu  model | input | cached input | cached input storage | output
xai    model | context | input / 1m tokens | cached input / 1m tokens | output / 1m tokens
groq   model id | speed (t/sec) | price per 1m tokens | rate limits (developer plan) | context window (tokens) | max completion tokens | max file size
```

`readPricingRows()`가 이 행과 정규화 비교로 **정확히 일치하는 표만** 읽고, 없으면
`pricing_table_shape_unrecognised`입니다. 나머지 규칙은 "이 표에 무엇이 잘못됐는가"를
묻고 그 답이 무한한 반면, 이 계약은 "이것이 그 표인가"를 묻고 그 답은 유한합니다.
공급자가 문서를 개편하면 **잘못 읽히는 대신 읽히지 않게** 되고 사람이 다시 읽습니다.

실측: zhipu의 `Input`을 `Input (AED)`로 바꾸면 그 표가 대상에서 빠지고, xAI의
`Batch API Pricing`·`Priority Processing Pricing` 표는 컬럼이 달라 애초에 걸리지
않습니다. 세 픽스처의 기존 기대값은 전부 그대로입니다.

## P2 4건

1. **10억.** `per 1,000,000,000 tokens`가 `1,000,000` 접두부로 통과하던 것을
   뒤에 숫자가 더 오면 불일치하도록 고쳤습니다.
2. **괄호 없는 통화명.** 가격 자리에 이 리더가 모르는 단어가 있으면 거절합니다
   (`RECOGNISED_PRICE_WORD`). 통화·단위·값 판정 **뒤**에 두어 더 구체적인 이유가
   먼저 나오게 했습니다.
3. **heading-only의 손실.** 허용 판정은 heading만 읽고, **거절 판정은 heading과
   preamble을 모두** 읽습니다.
4. **자기 표시명.** 페이지 귀속 검사만 평탄화 비교로 완화했습니다. **표 행은
   여전히 API id를 요구합니다** — 거기서는 행과 행의 차이가 곧 id이기 때문입니다.

검증: 표 리더 54건, unit 10,048건(실패 0), 타입체크, 정적 게이트 9종 통과.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 특히 **구조 계약이 의도한 범위를 실제로 닫는지**(계약을 우회해 잘못된
숫자가 나오는 경로가 있는지)와, 계약이 실제 문서를 과잉 차단하는지 봐 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
