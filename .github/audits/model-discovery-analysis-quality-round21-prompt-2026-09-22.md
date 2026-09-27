# 21차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

20차 P2 3건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **주어 앞 수식어도 범위를 정합니다.** 임의의 한 단어를 허용하던 것을
   허용 목록(`all`·`listed`·`published`·`displayed`·`quoted`·`stated`·`shown`·
   `api`·`token`·`model`·`our`·`these`·`the`, 최대 2개)으로 바꿨습니다.
   `Input prices are in USD.`·`Regional/Priority/Enterprise prices are in USD.`는
   침묵이고, `All listed prices are in USD.`·`Our prices are in USD.`는 읽힙니다.
2. **부정이 통화 앞에 있을 때만 선언을 지웁니다**(`deniesBeforeCurrency`).
   표 preamble의 `All prices are in USD and do not include taxes.`와
   `All prices are in USD, excluding taxes.`가 읽힙니다.
3. **표 context의 통화 코드 검사에도 가격 문장 제한**을 적용했습니다.
   `Prices per 1M tokens in USD. Also available on OCI.`는 읽히고,
   `Prices below are in AED.`는 거절됩니다.

## 테스트 경로

지적하신 대로 새 테스트들이 페이지 경로만 지나고 있었습니다. 이번 회귀 테스트는
`zhipuPreamble()`을 써서 **표 preamble 경로**를 직접 검사합니다.

검증: 표 리더 82건, unit 10,076건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
세 픽스처의 페이지 판정은 zhipu·xai `usd`, groq `null` 그대로입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 각 항목에 **방향(우회 / 과잉 차단)**과 **실제 공급자 문서에서 가능한
표기인지**, 그리고 **어느 자리(페이지 prose / 표 heading·preamble / 열 헤더 / 셀)**
인지를 표시해 주십시오.

마지막 항목을 요청하는 이유는, 19·20차 지적이 모두 "같은 결함이 다른 자리에 남아
있다"였기 때문입니다. 네 자리에 같은 성격의 결함이 계속 나온다면 판정을 한
함수로 합치는 것이 남은 구조적 작업이라고 보고 있습니다 — **이 판단에 대한
의견도 함께 주시면 좋겠습니다.**

반례는 수집기가 실제로 읽는 `.md` 구조를 기준으로 삼아 주시고, 코드를 수정하지
말고 한국어로 답해 주세요.
