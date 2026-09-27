# 3차 검토 요청 — 발견 대기열 분석 품질 + 공급자 문서 확대

2차 P2 5건 대응입니다. `git diff`(intent-to-add 포함)를 검토해 주세요.

## 대응

1. **tier 경계 검증** (`tierFromRows`, `tierBoundary`)
   - 두 행이 **같은 경계의 반대쪽**일 때만 tier로 읽습니다(`<`/`≥` 등 연산자와 숫자 일치).
     `<100k` + `<200k` 같은 합성 입력은 tier가 아니므로 `model_row_duplicated`로 닫힙니다.
   - `< N`은 포함 상한 `N-1`로 정규화합니다. profile은 `promptTokens <= maxPromptTokens`로 읽으므로
     200,000 토큰이 싼 tier로 들어가던 문제를 막습니다. xAI 픽스처 기대값을 199,999로 갱신했습니다.
   - cached-input 열이 양쪽에 있으면 입력 배수와 같은지 확인합니다. 같으면
     `cacheTakesInputMultiplier: true`, 다르면 tier를 포기하고
     `long_context_cache_multiplier_mismatch`를 남깁니다.
2. **combined 셀**은 쪼개기 전에 셀 전체를 판정합니다. 비USD 통화·프로모션·비공개 문구를 먼저
   거절하고, `$`가 없으면 `currency_unstated`입니다. `€0.15 input€0.60 output`과
   `Limited-time $0.15 input$0.60 output` 모두 거절되는 테스트를 넣었습니다.
3. **프로모션 문장 탐지**는 표 줄 전체가 아니라 **값 셀만** 건너뜁니다(`TABLE_VALUE_CELL`).
   `| Pricing | Limited-time promotional pricing for GLM-5.3 |` 같은 안내 행은 그대로 잡히고,
   Zhipu의 `Limited-time Free` 값 셀만 빠집니다. 양쪽을 테스트로 고정했습니다.
4. **wave 상한 제거.** 열린 항목 전체를 두 컬럼만 읽습니다. 상한이 있으면 두 조회가 서로 다른
   2,000개를 볼 수 있고, 그것이 바로 1차 P2-2의 재발 경로였습니다.
5. **예산 독점 제거.** 공급자별 공유 문서를 `Promise.all`로 동시에 읽고, 모델별 작업을 공급자
   교차(round-robin) 순서로 한 리스트에 담아 처리합니다. 각 작업은 시작 전에 예산을 확인합니다.
   OpenAI·Anthropic 전용 파서 경로는 그대로 유지했습니다.

## 그 밖

- 계약 문서에 §52를 추가했습니다(`.github/audits/model-lifecycle-email-2026-08-22.md`).
- 전체 unit 10,011건 통과, 실패 0.

## 요청

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
특히 수집기 재구성이 기존 OpenAI·Anthropic 경로의 의미(소스 순서, problems 문자열, 상태 매핑)를
바꾸지 않았는지 확인해 주세요. 코드를 수정하지 말고 한국어로 답해 주세요.
