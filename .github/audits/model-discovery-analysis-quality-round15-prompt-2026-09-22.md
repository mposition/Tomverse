# 15차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

14차 P2 4건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

넷의 공통 원인은 하나였습니다 — **페이지 통화 선언을 읽는 방식이 "USD인가"와
"외화인가"에서 서로 달랐습니다.** 이제 `pageDeclaredCurrency()` 하나가 두 답을
같은 읽기에서 냅니다: `"usd"` / `"foreign"` / `null`.

1. 선언 문장 안의 **모든** `in`을 읽습니다.
   `All prices in the table below are in Canadian dollars.` → `foreign`.
2. 선언으로 인정하려면 **주어가 페이지의 가격**이어야 합니다
   (`PAGE_DECLARATION_SUBJECT`). `A separate usage fee is charged in USD.`는 선언이
   아니므로 표는 `currency_unstated`입니다. 본문의 임의 `USD` 언급으로 `page.usd`를
   만들지 않습니다.
3. 접미사 앞이 구분자(`-._/`)면 모델 id로 인정하지 않습니다. `not-target-1`은
   `target-1`이 아니고, groq의 `Enterprisetarget-1`(표시명에 글자로 붙는 형태)은
   그대로 인정됩니다.
4. 선언 캡처가 문장 끝까지 읽습니다. `All prices are in U.S. dollars.`는 이제
   `USD_PHRASE`에 도달해 정상적으로 읽힙니다 — 허용 목록에 있었는데 거기 닿지
   못하던 결함이었습니다.

## 이 회차에 제 수정이 만든 결함 (픽스처가 잡음)

선언 문장을 페이지 전체에서 자르면서 **앞선 heading이 문장 앞에 붙어** 선언으로
인식되지 않았고, 실제 픽스처 4건이 깨졌습니다. 줄 단위로 읽은 뒤 문장으로 자르고
`> `·`#` 같은 머리 기호를 떼도록 고쳤습니다.

검증: 표 리더 64건, unit 10,058건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
세 픽스처의 페이지 판정은 zhipu·xai `usd`, groq `null`입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 반례는 수집기가 실제로 읽는 `.md` 문서 구조를 기준으로 삼아 주십시오.
코드를 수정하지 말고 한국어로 답해 주세요.
