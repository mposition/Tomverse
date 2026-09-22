# 4차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

3차 P2 5건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **페이지 프로모션이 parse에 도달합니다.** 수집기가 공급자별 미확인 프로모션 문장을 보관하고
   `genericModelFromDocs({ promotionalNotices })`로 넘깁니다. parse는 `fields.promotional`을 채우고
   `page_promotional_notice`를 남기므로, 기존 `docPricePrefill`의 `promotional` 거절 경로를 그대로
   탑니다. 테스트로 고정했습니다.
2. **통화·단위가 헤더에 적힌 경우.** `docPriceCell(cell, header)`가 헤더의 비USD 통화(`(EUR)`,
   `A$`, `CAD` 등)와 비1M 단위(`/ 1K tokens`, `per request`)를 먼저 거절합니다. 셀에도 헤더에도
   USD 표시가 없는 맨 숫자는 `currency_unstated`입니다. combined 셀은 셀 전체를 판정한 뒤 각 숫자에
   달러 표시를 붙여 다시 읽습니다.
3. **cached-input tier 판정.** 양쪽 행에 읽을 수 있는 캐시 값이 없으면
   `long_context_cache_unstated`, 값이 있고 비율이 1이면 `long_context_cache_flat`, 입력 배수와도
   1과도 다르면 tier를 포기하고 `long_context_cache_multiplier_mismatch`입니다. `false`가
   "문서가 말하지 않음"과 "평평하다고 말함"을 함께 뜻하던 문제를 없앴습니다.
4. **공유 문서 fetch 전 예산 확인.** 대기열 조회가 예산을 다 쓴 경우 문서를 한 건도 시작하지 않고
   전부 `time_budget`으로 보고합니다.
5. **wave는 `add` 항목만.** 열린 retirement 항목이 "기본형도 대기열에 있다"로 읽혀 파생형이
   `recommended`에서 내려가던 경로를 막았습니다.

## 남겨 둔 것과 그 이유

- 표의 **값 셀**을 프로모션 문장 탐지에서 제외하는 규칙은 유지합니다. 정확히 `Limited-time Free`
  같은 값 문구만 제외되고, 문장형 안내 셀은 그대로 잡힙니다. 값 셀 자체는 표 리더가 사유와 함께
  거절하므로 그 셀의 숫자가 가격으로 쓰이는 경로는 없습니다.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
