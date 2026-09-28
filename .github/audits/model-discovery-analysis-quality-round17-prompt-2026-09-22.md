# 17차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

16차 P2 5건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

**이번 다섯 중 셋이 과잉 차단이었습니다.** 방어가 너무 조여 있었다는 신호로 받고
그쪽을 풀었습니다.

1. **부정문은 "다른 통화다"라는 진술입니다.** `Prices are not in USD.`는 이제
   `currency_unstated`가 아니라 `not_usd`이고, `tableUnits()`도 같은 판정을 씁니다.
   표 preamble의 부정문이 `USD_STATED`로 되살아나던 경로를 닫았습니다.
2. **문서 쪽의 다른 네임스페이스만 거부합니다.** `vendor-b/target-1`은
   `vendor-a/target-1`이 아닙니다. 질의가 문서에 없는 접두를 달고 오는 경우
   (`ZHIPU/GLM-5.3-Flash`)는 계속 허용합니다. id 앞 허용 문자에서 숫자를 뺐으므로
   `pretend2target-1`도 거부됩니다.
3. **괄호와 링크.** 통화구를 `(` 앞에서 자르고, 선언 줄에 `plainCell()`을 적용해
   링크를 평탄화합니다. `All prices are in US dollars (USD).`와
   `All prices are in [USD](url).` 모두 읽힙니다.
4. **부정과 범위 한정은 통화 앞부분에서만 읽습니다.**
   `…in USD and do not include taxes.`는 통화를 부정하지 않고,
   `…in USD, including image and tool prices.`는 한정 선언이 아닙니다.
5. **선언을 문단 단위로 모아 읽습니다**(heading 줄은 버림).
   `All prices are denominated\nin USD.`가 한 문장으로 읽힙니다.

1번에서 부정문의 답이 바뀌어 15차에 넣은 테스트를 함께 고쳤습니다.

검증: 표 리더 71건, unit 10,065건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
세 픽스처의 페이지 판정은 zhipu·xai `usd`, groq `null` 그대로입니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요.

**각 항목에 방향을 표시해 주십시오** — 잘못된 숫자가 통과하는 것(우회)인지, 정상
문서를 거절하는 것(과잉 차단)인지. 그리고 실제 공급자 문서에서 가능한 표기인지도
함께 적어 주세요. 반례는 수집기가 실제로 읽는 `.md` 구조를 기준으로 삼아 주시고,
코드를 수정하지 말고 한국어로 답해 주세요.
