# 23차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

22차 P2 6건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## `null`이 감추고 있던 두 답을 분리했습니다

지적하신 대로 `null`이 서로 다른 두 답을 뭉개고 있었습니다.

- **침묵**: 아무 말도 하지 않았다 → 더 넓은 선언으로 내려가도 됨
- **귀속 불가**(`unattributable`): 통화를 말했는데 어느 가격인지 알 수 없다 →
  **내려가면 안 됨**

`All prices, except cached input prices, are in USD.`는 페이지의
`All prices are in USD.`를 **한정하려던 문장**이므로, 그 한정 대상으로 내려가서는
안 됩니다.

## 범위 한정 선언은 자리에 따라 뜻이 다릅니다

`proseCurrency(text, about)`가 `"page"`와 `"table"`을 구분합니다.
`All prices in the table below are in USD.`는 페이지에서는 아무것도 세우지 않고,
**그 표 바로 위에서는 그 표를 가리킵니다.** 행렬의 기대값도 자리별(`atTable`)로
갖게 했습니다.

## 나머지

- **통화 뒤도 봅니다.** `in USD, except cached input prices`와
  `in USD, for the table below`가 쉼표 하나로 통과하던 것을 막았습니다.
- **`ancestry`에도 포함 절을 제거**해 heading의 `including image and tool prices`가
  그 표를 이미지 표로 만들지 않습니다.
- **가격 명사는 같은 절에 있어야 합니다.**
  `Prices are listed below, and models are available in OCI.`는 통화 주장이 아니고,
  `Discounts are available for input and output.`도 아닙니다(side 규칙은 통화를
  이름 댄 문장에서만 돕니다).
- **셀이 직접 밝힌 단위를 인정합니다.** `USD 1.40 per million tokens`가 읽히고,
  단위의 숫자는 가격 후보에서 뺍니다.

## 행렬

**표 heading을 행렬에 넣으라는 지적을 반영했습니다** — 넣자마자 위 `ancestry`
결함이 잡혔습니다. 이제 페이지·preamble·heading 세 자리 × 27문장 = 81판정입니다.
열 헤더·셀은 별도 corpus라는 판단에 동의해 주셔서 그대로 두었고, 셀 형식 결함
(P2-6)은 이번에 고쳤습니다.

검증: 표 리더 88건, unit 10,082건(실패 0), `tsc` 무출력, 정적 게이트 9종 통과.
실제 픽스처는 그대로 읽힙니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해
주세요. 각 항목에 **방향(우회 / 과잉 차단)**, **자리**, **실제 공급자 문서에서
가능한 표기인지**를 표시해 주십시오. 반례는 수집기가 실제로 읽는 `.md` 구조를
기준으로 삼아 주시고, 코드를 수정하지 말고 한국어로 답해 주세요.
