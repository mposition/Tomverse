# Provider Model Catalogue 후보 필터 독립 검토 보고서

- 검토일: 2026-09-11
- 검토 대상: `03c99205045dfe4d324e369e5301f5ccc65b37a2`
- 비교 기준: `origin/develop` (`30e0375280224c2e65686fb2ceaefb74373ec0fc`)
- 결론: 결함 1건 — 높음 0건, **중간 1건**, 낮음 0건

## 발견 사항

### 1. [중간] `already_served`로 억제된 후보가 일간 요약에서 흔적 없이 사라짐

해당 파일: `lib/providerModelCatalogReport.ts:195-219` (검토 대상 SHA 기준). 특히 `:201-206`의 수동 `named` 목록에 `already_served`가 없고, `:219`가 빈 `parts`를 그대로 빈 문자열로 반환합니다.

`CandidateSuppression`은 `already_served`를 유효한 억제 사유로 정의하고 큐 선택기는 실제로 그 값을 만들지만, 리포트의 별도 수동 목록은 다섯 사유 중 네 개만 열거합니다. 따라서 공급자 스캔과 큐 기록 사이에 운영자가 모델을 등록하는 등 `already_served` 분기가 실행되면, 후보는 큐에서 제외되면서도 일간 메시지에는 필터가 작동했다는 표시가 전혀 남지 않습니다. 이는 변경의 명시적 계약인 “모든 필터가 제거한 수를 보고한다”와 조용한 누락 금지 원칙을 위반합니다.

재현 입력 → 잘못된 출력:

```text
discovery = {
  recorded: true,
  createdItems: [],
  suppressed: [
    { provider: "openai", apiModel: "gpt-5.5", reason: "already_served" }
  ]
}

→ suppressionSummary(discovery) = ""
→ 일간 Summary에는 "filtered already served 1"이 없고
  "... · new candidates 0"에서 끝남
```

기대 출력:

```text
" · filtered already served 1"
```

영향은 후보를 잘못 생성하는 것이 아니라 필터의 동작을 운영자에게 숨기는 것입니다. 이 상태에서는 `already_served` 판정이 과도하게 넓어져도 일간 보고만으로 탐지할 수 없습니다. 발생 조건이 동시 등록 경로로 제한되므로 심각도는 중간으로 분류했습니다.

## 후속 상태와 검증

- 후속 커밋 `89b1bc1fd03966cd863878aa66aa93a582d97747`에서 모든 `CandidateSuppression`을 포괄하는 `Record<CandidateSuppression, string>`으로 교체되어 이 결함은 수정됐습니다.
- 새 검증은 `CANDIDATE_SUPPRESSIONS` 전체를 순회하므로 이후 억제 사유가 추가되면서 리포트 매핑이 빠지면 타입 검사 또는 테스트에서 드러납니다.
- 후속 커밋 상태에서 관련 테스트 120건을 실행했고 모두 통과했습니다.
- 소스 코드는 이 보고서를 작성하는 과정에서 수정하지 않았습니다.
