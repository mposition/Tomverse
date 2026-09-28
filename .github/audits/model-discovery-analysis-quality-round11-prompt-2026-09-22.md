# 11차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

10차 P2 5건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **수량을 긍정 판정으로.** `per <수량> tokens`를 전부 뽑아 그 수량이 100만이어야
   통과합니다(`MILLION_QUANTITY`). `per 10,000`·`per 100,000`·`per 1 billion`·
   `per token`은 거절되고, `per 1,000,000 tokens`(Perplexity의 실제 표기)는 통과합니다.
   컬럼 경로와 combined 경로 양쪽에 걸었습니다.
2. **가격 자리의 통화는 말로 써도 통화입니다.** 셀·헤더에도
   `statedCurrencyIsForeign()`과 코드 검사를 적용하고, **가격 자리의 괄호 내용이
   인식되지 않으면 거절**합니다(`RECOGNISED_PARENTHETICAL`). `Input AED per 1M tokens`,
   `Input (UAE dirhams) per 1M tokens`, combined `… output (UAE dirhams)` 모두 `not_usd`입니다.
3. **각 측의 통화 자체를 판정합니다.** `sideCurrencyIsForeign()`이 `for input`/`for output`
   앞에 붙은 말을 통화로 읽습니다. `USD for input and AED for output`은 거절되고,
   `shown in USD for input and separately for output`은 통과합니다.
4. **heading이 있으면 heading이 판정합니다.** preamble은 heading이 없을 때만 읽습니다.
   6차에서 고친 것과 같은 병이 `plainCell()`의 링크 평탄화로 재발한 것이며,
   가격표 preamble은 어떤 heading 아래서든 "Prices per 1M tokens"라고 말하므로 둘을
   합쳐 판정하는 한 heading은 아무 것도 막지 못합니다.
5. **토큰·표시명 패턴 확장.** `GPT 4o`, `o4-mini`, `DeepSeek V3.2`를 모델로 인식합니다.

수정 중 자체 프로브에서 두 결함이 더 드러나 함께 고쳤습니다 — 수량 캡처가 쉼표를
배제해 `10,000`을 못 읽던 것, 9차에 넣은 `per 1,000` 패턴이 `1,000,000`의 앞 세
자리에 걸리던 것.

검증: 표 리더 50건, unit 10,044건(실패 0), 타입체크, 정적 게이트 9종 통과.
실제 픽스처(zhipu·xai·groq)의 기대값은 그대로입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요.

이번에는 한 가지를 함께 판단해 주시면 좋겠습니다. 6차 이후 지적이 전부 이
범용 리더 한 곳에 몰려 있고 회차당 4~6건으로 줄지 않습니다. **남은 반례들이
(a) 실제 공급자가 쓰는 표기인지, (b) 이론적으로 가능한 표기인지** 구분해 주시고,
(b)가 대부분이라면 현재 상태로 병합 가능한지 의견을 주십시오. 자동 수집 대상을
5개 공급자에서 줄이는 선택지도 검토 중입니다. 코드를 수정하지 말고 한국어로
답해 주세요.
