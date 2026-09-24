# 6차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

5차 P2 6건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **표준 요율 판정을 긍정 식별로.** 표의 heading·preamble이 `model|pricing|price|rate|token|text|
   chat|llm|api` 중 하나를 말해야 표준 요율 표로 봅니다. `## Priority processing`·`## Flex
   processing`처럼 알지 못하는 이름은 통과하지 못합니다. 다만 heading도 preamble도 **아예 없는**
   표는 다른 요율을 주장한 적이 없으므로 그대로 읽습니다(과잉 차단 방지).
2. **표 직후 heading 유실.** `index = cursor - 1`로 고쳐, 빈 줄 없이 이어지는 `## Batch pricing`이
   자기 표에 붙습니다. 테스트로 고정했습니다.
3. **heading·preamble의 외화 선언.** `tableUnits()`가 외화를 만나면 `foreignCurrency: true`로
   기록하고, 페이지의 `All prices are in USD.`를 무효화합니다. `docPriceCell()`은 그 표의 모든 셀을
   `not_usd`로 거절합니다(셀에 `$`가 있어도).
4. **모델 페이지의 프로모션.** 수집기가 모델 페이지에도 `promotionNotices()`를 돌려 parse에 넘기고
   요약에도 올립니다.
5. **문장 귀속.** 문서를 블록 단위로 잘라 heading이 다음 문장에 붙지 않게 했고, **다른 모델을
   언급하는 문장은 모두 제외**합니다(이 모델을 함께 언급해도 마찬가지). 값은 다른 모델이 등장하지
   않는 문장에서만 읽습니다.
6. **한 셀에 숫자 둘.** `$4.40 before, $1.40 now`, `~~$4.40~~ $1.40`, `$1.40-$4.40` 모두
   `ambiguous_value`로 거절합니다.

실제 픽스처(zhipu·xai·groq)는 그대로 정확히 파싱됩니다:
GLM-5.3 $1.4/$4.4·1M·128K, Flash $0.15/$0.5, FlashX $0.37/$1.25, grok-4.6 $2/$6·500k,
groq gpt-oss-120b $0.15/$0.6·131,072·65,536.

검증: 표 리더 테스트 26건, 전체 unit 10,021건(실패 0), 정적 게이트 7종 통과.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
