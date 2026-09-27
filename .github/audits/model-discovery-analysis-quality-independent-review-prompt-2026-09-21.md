# 독립 검토 요청 — 발견 대기열 분석 품질

`git diff --cached`(HEAD 대비 staged)를 검토해 주세요. 기준 브랜치는 `origin/develop`입니다.

## 왜 고쳤나 (운영자 신고, 2026-09-21)

Zhipu GLM 5.2를 서비스하는 상태에서 스캔이 다섯 후보를 올렸습니다 — `glm-4.5-air`,
`glm-5-turbo`, `ZHIPU/GLM-5.3`, `glm-5.3-flash`, `glm-5.3-flashx`. 대기열은 다섯 행에
**같은 문단**을 썼습니다: "공급자 근거가 후보의 제품 역할을 분류할 만큼 충분하지 않습니다 …
현재 정보만으로 Tomverse의 어떤 모델을 보완하거나 대체하는지 확정할 수 없으므로 공식
포지셔닝·가격과 실제 지연시간을 먼저 확인해야 합니다." 우선순위도 사실상 동일했습니다.

원인:

1. `modelLine()`이 tier 단어를 라인 이름에 포함해(`glm-4.5-air` → `glm-air`) 서비스 중인
   `glm-5.2`와 세대 비교 자체를 하지 않았습니다. 상위 세대인 `GLM-5.3`조차 "무엇을 대체하는지
   알 수 없음"으로 떨어졌습니다.
2. `chatRole()`의 economy 정규식에 `air`·`flashx`가 없어 역할 분류가 실패했습니다.
3. 공급자 API가 메타데이터를 주지 않는 공급자(zhipu 등)에서는 근거 문장과 마무리 문장이
   글자 그대로 같습니다.
4. 각 행이 서로를 모릅니다. 한 세대를 tier별로 함께 내보내는 공급자 관행이 다섯 개의 독립
   결정처럼 보였습니다.

## 구현 요약

- `lib/modelLifecycleTriage.ts`
  - `modelTier()` (tier 단어 표 하나), `modelGenerationFamily()` (line에서 tier 제거),
    `modelPortfolioRelation()` (같은 제작사·같은 family 안에서 세대 비교).
  - `chatRole()`이 같은 tier 표를 읽습니다. `speed`는 role로 승격하지 않습니다
    (`gpt-4-turbo`와 `glm-5-turbo`가 같은 단어를 다르게 씁니다).
  - `ModelTriageAssessment`가 `verdictKo` / `pointsKo[]` / `nextStepKo`로 나뉘고,
    `analysisKo`는 그 셋을 join한 값입니다(제외 스냅샷·fingerprint 호환).
  - `siblingWavePoints()`: 같은 대기열에 있는 같은 세대의 형제 후보를 읽어 기본형 우선,
    한 글자 차이 tier(`flash`/`flashx`) 확인 필요를 말합니다.
  - 파생형은 같은 세대 기본형이 대기열에 있으면 `recommended`로 올리지 않습니다.
  - 빠진 값(컨텍스트·최대 출력·단가·이미지 입력)을 이름으로 말하고, 그 공급자가 공식 문서
    자동 수집 대상인지까지 밝힙니다.
- `lib/modelLifecycleWorkItems.ts`: family별 wave를 한 번 만들어 각 행에 넘기고, 구조화된
  세 필드를 큐 항목으로 내보냅니다.
- `components/admin/AdminModelDiscoveryPanel.tsx`: 판정(굵게) → 근거 목록 → 다음 행동.
  `verdictKo`가 없는 옛 응답은 기존 문단을 그대로 렌더합니다.

## 특히 봐 주실 것

1. **사실이 아닌 주장**: tier·세대는 ID 명명에서 읽은 것입니다. 문구가 이를 측정값처럼
   말하는 곳이 있는지. 다른 제작사 모델과 비교하거나, 품질을 단정하는 문장이 있는지.
2. **버전 비교의 안전성**: `glm-5` vs `glm-5.2`, `claude-opus-4-6`, `gemini-2.5-flash` 같은
   표기에서 오판이 나는 경우. family 축약이 서로 다른 제품을 한 family로 묶는 경우.
3. **우선순위 변화의 부작용**: 기존 `recommended` 항목이 조용히 `low`로 내려가 화면에서
   사라지는 경로가 있는지(기본 필터가 `recommended`입니다).
4. **스냅샷 호환**: `analysisKo`가 여전히 제외 결정의 fingerprint 대상이며, 패널이 보낸
   값과 서버 계산이 어긋날 여지가 생겼는지.
5. 성능: 큐 1,000행에서 wave 계산이 O(n²)로 퇴화하는지.

P1/P2로 분류해 파일:줄과 재현 시나리오를 적어 주세요. 없으면 "승인"이라고 명시해 주세요.
코드를 수정하지 말고 한국어로 답해 주세요.
