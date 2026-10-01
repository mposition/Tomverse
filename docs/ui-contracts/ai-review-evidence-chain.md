# AI Review evidence chain 계약

`components/chat/ComparisonReviewDialog.tsx`의 검토 결과 표시, `QuoteBadge`,
`VerifyItemButton`, `ReviewItemFeedback`, `SourceGroundingBadge`, 또는 AI Review를
설명하는 제품·마케팅 문구를 바꾸기 전에 읽습니다.

관련 정책: `docs/policy/ai-review-m5-quality-contract.md` §7.

## 1. Signature 차별점이 무엇인가

Tomverse의 차별점은 **"여러 AI를 한 번 더 AI로 요약한다"가 아닙니다.** 그것은
누구나 하고, 그 자체로는 신뢰할 이유가 없습니다.

> **어떤 비교 판단이 어느 답변에서 나왔고, 무엇이 아직 검증되지 않았는지
> 사용자가 추적할 수 있는 AI 교차검토.**

이 한 문장이 아래 UI 규칙 전부의 근거입니다. 규칙을 어기는 화면은 요약기와
구별되지 않습니다.

## 2. evidence chain — 여섯 단계

```
① 검토 주장            "B는 1859년이라 하고 A·C는 1869년이라 합니다"
      ↓
② 그 주장을 뒷받침한다고 reviewer가 고른 원문 인용   "opened in 1859"
      ↓
③ 그 인용이 실제로 그 답변에 있는가                  검증됨 / 확인 안 됨
      ↓
④ 필요하면 그 항목만 별도 웹 검증                    사용자가 명시적으로 요청
      ↓
⑤ 웹 검증 결과와 원래 AI Review의 경계 표시          다른 색, 다른 라벨
      ↓
⑥ 사용자의 판단                                      helpful / incorrect / unclear / missing
```

**각 단계는 자기 앞 단계보다 강한 주장을 하지 않습니다.** ③은 ②가 존재한다고만
말하고, ①이 참이라고 말하지 않습니다. ⑤는 외부 소스가 무엇이라 했는지만 말하고
①을 확정하지 않습니다.

## 3. 불가침 요구사항

### 3.1 인용 없는 주장은 없다

`consensus` · `contradictions` · `differences[].positions`의 모든 항목은 원문
인용을 갖습니다. 프롬프트가 그것을 요구하고(찾을 수 없으면 항목을 만들지 말라고
지시), 스키마가 `citations`를 `.min(1)`로 강제합니다. **인용을 선택 사항으로
만드는 변경은 이 계약의 파기입니다** — 그 순간 ①에서 ②로 가는 링크가 끊기고,
화면은 근거 없는 요약이 됩니다.

### 3.2 검증 상태를 항목마다 보여 준다

`QuoteBadge`가 인용마다 검증 여부를 표시합니다. **검증되지 않은 인용을 숨기지
않습니다.** 숨기면 화면이 실제보다 잘 근거된 것처럼 보이고, 그게 이 계약이
막으려는 단 하나의 실패입니다.

### 3.3 출처 일치도는 정확도가 아니다

`SourceGroundingBadge`가 표시하는 것은 **reviewer의 인용문 중 원문에서 실제로
찾아진 비율**입니다. 라벨·설명·도움말 어디에도 정확도·사실 검증·신뢰도라는
말을 쓰지 않습니다. `lib/sourceGrounding.ts`가 저장된 `confidence` 필드를 이
이름으로 번역하는 유일한 경계입니다.

인용이 하나도 없으면 비율을 **표시하지 않습니다**(`available: false`).
`deriveConfidence()`가 빈 목록에 반환하는 `"medium"`은 저장 기본값이지 측정이
아닙니다.

### 3.4 웹 검증은 명시적이고 별개다

- 자동으로 실행되지 않습니다. 사용자가 특정 항목에 대해 누릅니다.
- 별도로 과금됩니다(live-search 모델).
- 결과는 **원래 검토와 시각적으로 구분**됩니다 — 자체 테두리와 배경, 그리고
  `supported` / `unsupported` / `inconclusive` 라벨.
- **웹 검증 결과가 원래 주장을 "확정"하지 않습니다.** 라벨은 외부 소스가 그
  주장을 뒷받침했는지를 말하며, 그 이상으로 읽히는 문구를 쓰지 않습니다.

### 3.5 두 검토자의 "합의"

`aiReviewAgreementSourceGroundingMatch` · `aiReviewAgreementSharedQuotes`가
말하는 것은 **출처 일치도 등급이 같다**와 **정확히 같은 문구를 인용한 수**뿐
입니다(`computeReviewAgreement()`가 계산하는 것의 전부입니다).

**"두 검토자가 결론에 동의했습니다"로 바꾸는 것은 계약 위반입니다.**

### 3.6 서로 다른 provider라고 말하지 않는다

두 번째 reviewer는 **모델 id가 다른 다음 후보**로 고릅니다. 같은 provider의 두
모델이 뽑히는 구성이 가능하고, `COMPARISON_REVIEW_MODEL_IDS`가 그것을 바꿀 수
있습니다. 실제로 그랬는지는 `ComparisonReviewRun.crossProvider`가 매 실행마다
기록하므로, 이 주장을 하고 싶으면 먼저 그 숫자를 봅니다.

### 3.7 항목 피드백은 판정이 아니다

- 네 가지 판단: `helpful` · `incorrect` · `unclear` · `missing_point`.
  **세 부정을 하나의 엄지로 합치지 않습니다** — 어디를 볼지 말해 주는 부분이
  사라집니다.
- 같은 판단을 다시 누르면 철회됩니다. 되돌릴 수 없는 피드백 컨트롤은 사람들이
  쓰지 않게 되는 컨트롤입니다.
- 컨트롤 옆 문구는 이 판단이 **그 항목 하나에 대한 사용자의 견해**이며 검토
  결과 전체를 맞다·틀리다로 표시하지 않는다고 말합니다.
- 게스트에게는 **잠금 상태로 노출하고 이유를 앞에 적습니다.** 숨기면 기능이
  없는 것으로 읽힙니다. 이유는 실제 제약입니다: guest review는 저장되지 않으므로
  판단이 가리킬 대상이 없습니다.

### 3.8 근거 없이 쓰지 않는 표현

- "AI Review가 정답을 찾았다"
- "reviewer들이 결론에 합의했다"
- "사실이 검증됐다"
- "가장 좋은 모델·승자를 선정했다"
- "높은 출처 일치도 = 높은 사실 정확도"

프롬프트가 승자 선정과 모델 신원 추측을 금지하고, 평가의 zero-tolerance 규칙이
그것을 검사합니다. **제품 문구가 모델이 하지 않기로 되어 있는 주장을 대신 하는
것**이 남은 위험이고, 이 절이 그것을 막습니다.

## 4. 레이아웃

- 검토 결과는 모바일 composer 계약의 형태를 따릅니다: 컨트롤이 텍스트 위에
  겹치거나 떠 있지 않습니다.
- 피드백 컨트롤은 자기 claim 아래 자기 행에 있습니다. 인용 배지 옆에 끼워 넣지
  않습니다 — 인용은 ②·③이고 피드백은 ⑥이며, 서로 다른 단계입니다.
- 320px에서 네 버튼이 줄바꿈되어도 각 버튼의 라벨이 잘리지 않습니다.
- 컨트롤 묶음은 `role="group"`과 접근 가능한 이름을 갖고, 각 버튼은
  `aria-pressed`로 상태를 알립니다. 포커스 링이 보입니다.

## 5. 시각 역할

AI Review는 `accent-ai-review-*`(cyan → blue → purple)를 씁니다. **이 조합은 AI
Review 전용으로 예약**되어 있습니다(AGENTS.md). 웹 검증 결과의
`supported` / `unsupported`는 `status-success-*` / `red-*`이며 accent가 아닙니다 —
그건 상태이지 기능 정체성이 아닙니다.

## 6. 회귀 검사

관련 변경은 다음을 통과해야 합니다.

- `tests/e2e/comparison-review.spec.ts`
- `tests/e2e/source-grounding.spec.ts`
- `tests/e2e/ai-review-item-feedback.spec.ts` (desktop **and** mobile)
- `tests/e2e/guest-attachment-ai-review-flow.spec.ts`
- `tests/e2e/comparison-action-rail.spec.ts`
- `tests/comparisonReviewCacheCompatibility.test.mjs`
- `tests/comparisonReviewItemFeedback.test.mjs`
- `tests/sourceGrounding.test.mjs` · `tests/sourceGroundingCopy.test.mjs`

## 7. 차단 여부

§3.1–§3.8의 **의미 계약을 넘는 제품 문구는 릴리스 차단**입니다. 사용자가 그
말을 믿고 내린 결정은 회수되지 않기 때문입니다.

레이아웃(§4)과 시각 역할(§5)은 고쳐서 배포하면 끝나는 것이며 차단이 아닙니다 —
다만 §4의 320px 규칙과 접근성 요구는 모바일 composer·comparison rail 계약이
이미 차단으로 정한 것과 같은 근거를 공유하므로, 그쪽 계약의 판정을 따릅니다.
