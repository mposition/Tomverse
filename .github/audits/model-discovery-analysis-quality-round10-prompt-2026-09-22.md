# 10차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

9차 P2 6건 대응입니다. 여섯 반례를 전부 재현한 뒤 고쳤고 회귀 테스트로 고정했습니다.
`git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **괄호 내용까지 제거하고 단어를 셉니다.** `### Turbo (preview)`는 한 단어 heading이고
   거절됩니다.
2. **표 heading의 통화 코드.** `tableUnits()`가 `claimsAnotherCurrencyCode()`도 부르므로
   `## Model pricing (AED)`는 셀이 `1.40`이어도 `not_usd`입니다.
3. **열마다 통화가 다른 표는 통째로 거절합니다.** 두 번째 통화에 `in`이 없어
   "모든 `in` 검사"로 잡히지 않는다는 지적이 맞았습니다. `SIDE_SPECIFIC_CURRENCY`가
   `for input … for output`처럼 **양쪽을 각각 이름 댄** 통화 문장을 거절합니다.
   한쪽만 이름 댄 `in USD for input and output`은 그대로 통과합니다.
4. **combined 경로는 분할 전에 판정합니다.** 셀 전체와 헤더를 통화 코드와
   `OTHER_UNIT_STATED`로 먼저 검사하므로 `(AED)`와 `per 1K tokens`가 분할에서
   사라지지 않습니다. groq의 실제 형태는 그대로 읽힙니다.
5. **`per 1,000` · `per 1000` · `per thousand` · `per hundred`를 다른 단위로 봅니다.**
   1,000배 오차 경로였습니다.
6. **표시명도 모델 이름입니다.** `DISPLAY_NAME_MODEL`이 `Claude Sonnet 4.5`,
   `Llama 3.1`을 인식하고, 월 이름·`Figure`·`Table`·`Version` 등은
   `NOT_A_DISPLAY_NAME`으로 제외합니다(빠뜨리면 문장을 잃을 뿐 지어내지 않습니다).

검증: 표 리더 44건, unit 10,038건(실패 0), 타입체크, 정적 게이트 9종 통과.
실제 픽스처(zhipu·xai·groq)는 그대로 정확히 파싱됩니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 특히 (a) 새 규칙들이 실제 공급자 문서를 과잉 차단하는 경우,
(b) 아직도 잘못된 **숫자**가 통과하는 경로, (c) 단위·통화 판정이 닿지 않는 자리가
남았는지 봐 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
