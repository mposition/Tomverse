# 9차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

8차 P2 4건 대응입니다. 네 반례를 전부 재현한 뒤 고쳤고 회귀 테스트로 고정했습니다.
`git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **통화 코드는 문장 밖에서도 통화 주장입니다.** `CURRENCY_CODE_SHAPE`가 괄호 안
   (`Input (AED)`) 또는 숫자·`$`에 인접한(`AED 1.40`) **대문자 3자**를 통화 주장으로
   보고, `USD`가 아니면 셀을 거절합니다. 열거가 아니라 모양이므로 `AED`·`TWD`·`SAR`
   모두 걸립니다. groq의 전부 대문자 헤더 `PRICE PER 1M TOKENS`에서 `PER`가 걸리는
   문제는 `NOT_A_CURRENCY_CODE`로 막았습니다.
2. **한 단어 heading은 그 단어가 수식어입니다.** `### Turbo`·`### Flex`·`### Priority`는
   거절하고 `### Standard`·`### Pricing`·`### Models`는 읽습니다. `STANDARD_SECTION`에
   `standard`를 넣어 `### Standard`가 허용 판정도 통과합니다.
3. **통화구를 문장 안의 모든 `in`에서 찾고 단위 꼬리에서 자릅니다.**
   `Prices are in USD per 1M tokens.`는 통과하고(`per`에서 절단),
   `Prices shown in the table below are in UAE dirhams.`는 두 번째 `in`에서 거절합니다.
4. **표준은 모델이 아닙니다.** `NON_MODEL_IDENTIFIER`(rfc·sha·iso·iec·nist·fips…)를
   제외해 `RFC-9110`이 든 문장이 버려지지 않습니다.

**이번에 추가한 세 목록의 방향을 짚어 둡니다.** `NOT_A_CURRENCY_CODE`,
`NOT_A_CURRENCY`, `NON_MODEL_IDENTIFIER`는 빠뜨리면 **거절**이 되는 목록입니다.
앞선 회차에서 문제였던 "거절할 통화 목록"은 빠뜨리면 **잘못된 숫자가 통과**했습니다.
전자는 사실 하나를 잃고 후자는 사실을 지어냅니다.

검증: 표 리더 38건, unit 10,032건(실패 0), 타입체크, 정적 게이트 9종 통과.
실제 픽스처(zhipu·xai·groq)는 그대로 정확히 파싱됩니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 특히 (a) 통화 코드 모양 규칙이 정상 표를 막는 경우, (b) 한 단어 heading
규칙이 실제 공급자 표를 막는 경우, (c) 아직도 잘못된 숫자가 통과하는 경로가 있는지
봐 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
