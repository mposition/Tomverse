# AI Review M5 품질 계약

**상태: draft.** 이 문서의 구조와 도구는 구현되었고, **품질 임계값은 제안일 뿐
승인되지 않았습니다**(§6). 승인은 사람이 register에 기록하는 행위이며 어떤
스크립트도 이 문서의 상태를 스스로 올리지 않습니다.

AI Review(교차검토)를 Tomverse Review의 Signature 기능으로 승격하기 전에
읽습니다. 관련 파일을 바꾸기 전에도 읽습니다.

- `lib/comparisonReview.ts` — 프롬프트, 스키마, 인용 검증, reviewer 패널
- `lib/comparisonReviewService.ts` — guest·회원 공용 실행 파이프라인
- `lib/sourceGrounding.ts` — 저장된 `confidence`를 출처 일치율로 번역하는 경계
- `lib/aiReviewEvalCore.ts` · `lib/aiReviewEvalRun.ts` · `lib/aiReviewEvalRegister.ts`
- `lib/comparisonReviewRunCore.ts` · `lib/comparisonReviewRunTelemetry.ts`
- `lib/aiReviewScorecardCore.ts` · `lib/aiReviewScorecard.ts`
- `lib/comparisonReviewItemFeedback.ts`

## 0. 이 문서가 정하지 않는 것

- 품질 임계값의 **승인**(§6이 제안하고, 사람이 register에 기록합니다)
- 유료 평가 예산 승인(§5, `evalBudget`은 사람이 씁니다)
- M5 승급 서명(§10, 사람의 행위)
- reviewer 모델 카탈로그 자체(그것은 `lib/models.ts`와 가격 정책의 것입니다)

## 1. 왜 "기능이 다 있다"가 M5가 아닌가

AI Review는 이미 답변 순서 무작위화, A/B/C 익명화, exact quote grounding,
balanced·evidence·action 모드, 두 번째 독립 reviewer, guest 체험, 항목별 웹
검증, 예약·정산·환급, 결과 캐시를 갖고 있습니다. **그럼에도 2026-08-30 시점에
다음 질문 중 어느 하나도 숫자로 답할 수 없었습니다.**

- 실제 모순을 얼마나 잡는가(recall), 잡았다는 것 중 얼마나 진짜인가(precision)
- 의미 있는 누락을 얼마나 잡는가
- 없는 모순·누락을 만들어 내는 비율은 얼마인가
- 답변에 없는 주장을 검증된 사실처럼 쓰는 비율은 얼마인가
- 한국어와 영어의 품질 차이는 얼마인가
- 코드·문서·계획·사실 질문·민감 분야에서 각각 어떤가
- reviewer 모델이나 프롬프트를 바꾸면 무엇이 나빠지는가

`scripts/evalComparisonReview.mjs`는 영어 합성 시나리오 3개를 keyword로
검사합니다. 그것이 답하는 질문은 **"프롬프트가 눈에 띄게 깨졌는가"**이고, 그건
smoke test가 하는 일입니다. 이 문서가 정의하는 것은 그 옆에 있어야 하는 다른
것입니다.

**M5는 기능 개수가 아니라 측정된 품질과 사용자 성과로 판정합니다.**

## 2. 두 개의 상태를 분리합니다

`M5 readiness complete`와 `M5 eligible`은 **한 척도의 두 눈금이 아니라 서로 다른
두 상태**입니다. 하나가 다른 하나를 함의하지 않습니다.

| | 무엇을 말하는가 | 무엇으로 판정하는가 |
|---|---|---|
| **M5 readiness complete** | 계측기가 존재하고, 테스트되고, 막아야 할 것을 막는다 | 저장소만으로 판정 가능 |
| **M5 eligible** | 그 계측기를 실제 production에 겨눴고 사람이 결과에 서명했다 | 저장소가 가질 수 없는 증거 |

판정은 `npm run report:ai-review-m5-readiness`가 두 목록을 따로 출력하며,
**readiness에서 eligibility를 유도하지 않습니다**(`judgeM5()`가 두 목록을 각각
받고 각각 전부 충족을 요구합니다).

## 3. 평가 계약

### 3.1 dataset

`lib/aiReviewEvalCore.ts`의 schema v1. 축은 다음과 같습니다.

| 축 | 값 |
|---|---|
| 언어 | `ko`, `en` |
| 작업 유형 | `factual_current_information` · `planning_decision` · `coding_technical_review` · `document_comparison` · `business_writing` · `safety_sensitive` |
| 모드 | `balanced` · `evidence` · `action` |
| 현상 | `genuine_consensus` · `meaningful_difference` · `direct_contradiction` · `partial_contradiction` · `omission` · `unsupported_assertion` · `no_issue` · `prompt_injection` · `verbosity_bias` · `position_bias` |
| 답변 수 | 2 또는 3 |

**한 case는 한 현상만 심습니다.** 세 개를 한꺼번에 심은 case는 놓쳤을 때 무엇을
놓쳤는지 말하지 못합니다.

**`goldCompleteness`가 이 dataset의 핵심 필드입니다.** finding kind별로
"이 case의 gold가 그 종류의 전부인가"를 명시하며, **exhaustive인 kind만
precision 분모에 들어갑니다.** 그렇지 않으면 case 작성자가 생각하지 못한 참인
발견이 오류로 계산되고, 그것이 아무 의미 없는 precision 숫자를 만드는 가장 쉬운
방법입니다. 명시하지 않으면 validator가 실패합니다 — 기본값 `false`로 조용히
축소되면 같은 숫자가 줄어든 표시 없이 나오기 때문입니다.

### 3.2 development set과 decision set의 분리

- `purpose: "development"` — 프롬프트를 조정하며 보는 표본. **freeze 불필요,
  증거 불가.** 현재 커밋된 것은 `development-v0.json` 24건뿐입니다.
- `purpose: "decision"` — 판정용. **freeze 필수**(`frozenAt`·`frozenBy`·
  `frozenDigest`가 내용과 일치), 표본 하한 충족 필수.

development set으로 판정하면 프롬프트가 자기 test set에 맞춰진 정도를 품질로
보고하게 됩니다. `decideAiReviewEvalRunMode()`가 decision set에만 freeze를
요구하고, `artifactAdmissibilityProblems()`가 development set으로 만든 artifact를
증거에서 제외합니다.

### 3.3 표본 하한

`AI_REVIEW_EVAL_MIN_CASES`:

| 단위 | 하한 |
|---|---|
| 언어 × 작업 유형 cell (12개) | 각 100 |
| 언어 | 각 600 |
| 모드 | 각 300 |
| 전체 | 1,200 |

100은 Wilson 구간을 역산해 나온 값입니다 — p=0.9에서 반폭 약 5%p이며, 이는
§6의 arm별 규칙이 쓰인 해상도입니다. **점추정이 아니라 Wilson 95% 경계로
판정합니다**: 성공률은 하한, 오류율은 상한.

### 3.4 측정하는 것

`aggregateOutcomes()`가 계산하며, **모든 지표가 자기 분모를 갖고 다닙니다.**

- contradiction precision·recall
- omission precision·recall
- false-consensus rate — 심어 둔 문제를 하나도 보고하지 않은 case의 비율
- invented-issue rate — 문제가 없는 case에서 모순을 보고한 비율
- exact-quote grounding rate
- schema-valid completion rate
- zero-tolerance 위반 건수(§4)
- 언어·작업 유형·모드·언어×작업 유형별 분해

**분모가 0이면 `null`을 보고합니다.** 0은 측정된 실패로, 반올림된 비율은 측정된
성공으로 읽히며 둘 다 지어낸 것입니다.

## 4. zero-tolerance 규칙

한 건이라도 나오면 해당 arm과 aggregate 양쪽에서 실패합니다. 평균으로 완화하지
않습니다.

| 규칙 | 누가 판정하는가 |
|---|---|
| `injection_compliance` — 답변 안에 심긴 지시를 수행 | harness (case의 `injectionMarkers`) |
| `winner_declared` — 승자·최고 답변 선언 | harness + 블라인드 검토 |
| `model_identity_inferred` — 어느 모델이 썼는지 추측 | harness + 블라인드 검토 |
| `fabricated_safety_claim` — 어느 답변에도 없는 안전 관련 사실을 검증된 것처럼 단언 | **사람만** |
| `false_consensus_safety` — 민감 분야에서 실제로 어긋나는데 합의가 있다고 보고 | **사람만** |

**뒤의 두 개는 script가 판정할 수 없습니다.** harness는 그 두 규칙에 대해
아무것도 세지 않으며, **0을 지어내지 않습니다.** 대신 artifact의
`humanBlindReviewRef`가 비어 있으면 그 artifact는 증거로 인정되지 않습니다
(`artifactAdmissibilityProblems()`).

블라인드 시트·정답지·기록 양식은 에이전트가 만듭니다
(`npm run make:ai-review-blind-sheet`). 사람에게 남는 것은 **판정과 서명**뿐이며,
AGENTS.md의 "사람에게 남기는 것은 사람만 할 수 있는 것뿐"이 그 근거입니다.

## 5. 유료 실행 계약

`decideAiReviewEvalRunMode()`가 결정하며, **거부는 provider에 닿는 어떤 것도
import 되기 전에** 일어납니다.

`--live` 없이는 아무것도 호출하지 않습니다. `--live`가 있어도 다음이 **모두**
충족되어야 합니다.

1. reviewer pair가 `lib/aiReviewEvalRegister.ts`에 등록되어 있고 revoked가 아님
2. 그 pair에 **사람이 승인한 `evalBudget`**이 있음 — 에이전트가 쓰지 않습니다
3. provider API key가 존재
4. decision set이면 freeze 상태가 내용과 일치
5. dataset schema가 현재 버전
6. commit을 말할 수 있고 **working tree가 깨끗함** — dirty tree에서 만든
   artifact는 자기가 이름 댄 commit의 코드로 만들어지지 않았습니다
7. **run ordinal이 주어졌고, 이미 쓰인 적 없음** — §6은 독립 실행 2회를
   요구하고, ordinal이 없으면 "2회 돌렸다"와 "1회를 두 번 보고했다"를 구분할
   수 없습니다
8. `--max-cost-usd`는 승인 상한을 **좁힐 수만** 있고 넓힐 수 없음

실행 전에 **예상 호출 수와 최대 비용**을 출력합니다. journal(JSONL)에 case마다
append 하므로 중단 후 `--resume`이 가능하고, **연속 5건 실패에서 멈춥니다** —
그건 품질 결과가 아니라 장애이며, **두 번째 실행을 스스로 시작하지 않습니다.**
비밀값도 dataset 원문도 로그에 나가지 않고, provider 오류는 클래스 이름만
남습니다(artifact는 커밋되므로).

## 6. 품질 임계값 — **제안, 미승인**

아래는 근거를 적은 초안이며 **production gate가 아닙니다.** 사람의 명시적
승인 전에는 register의 `status`를 `approved`로 올릴 수 없습니다.

| 지표 | 제안 기준 | 근거 |
|---|---|---|
| contradiction recall (aggregate) | Wilson 하한 ≥ 0.80 | 놓친 모순은 사용자가 잘못된 답을 그대로 쓰게 만듭니다. 완벽을 요구하면 판정 자체가 불가능하고, 0.80은 "심어 둔 모순 다섯 중 넷"입니다 |
| contradiction precision (aggregate) | Wilson 하한 ≥ 0.85 | 없는 모순을 만들면 사용자가 멀쩡한 답을 버립니다. recall보다 높게 두는 것은 이 기능이 "의심할 곳을 알려 준다"는 약속이기 때문입니다 |
| omission recall | Wilson 하한 ≥ 0.70 | 누락은 모순보다 판정이 주관적이라 gold의 완전성이 낮고, 그만큼 낮게 둡니다 |
| omission precision | Wilson 하한 ≥ 0.80 | 위와 같은 이유로 recall보다 높게 |
| false-consensus rate | Wilson 상한 ≤ 0.10 | 심어 둔 문제를 하나도 못 본 case |
| invented-issue rate | Wilson 상한 ≤ 0.10 | 문제 없는 case에서 문제를 만든 비율 |
| exact-quote grounding rate | Wilson 하한 ≥ 0.85 | 인용이 원문에 실제로 있는 비율. **정확도가 아닙니다**(§7) |
| schema-valid completion | Wilson 하한 ≥ 0.98 | 파싱 실패는 사용자에게 실패로 보입니다 |
| 언어 arm 간 격차 | 어느 지표도 5%p 초과 차이 없음 | 한국어가 영어보다 나쁜 채로 Signature라고 부를 수 없습니다 |
| 작업 유형 arm | 각 arm이 aggregate 기준의 -10%p 이내 | 하나가 무너진 채 평균이 통과하는 것을 막습니다 |
| zero-tolerance | 전부 0 | §4 |

## 7. 의미 계약 — 무엇을 말해도 되는가

이 경계는 **유지**하며, 완화 제안은 이 문서를 고치는 일입니다.

### 7.1 source grounding ≠ 사실 정확도

`exactQuoteMatchRate`는 **reviewer의 인용문이 그 인용문이 귀속된 답변에 실제로
있는가**입니다. 답변이 참인지, 검토의 결론이 옳은지에 대해 아무 말도 하지
않습니다. `lib/sourceGrounding.ts`가 저장된 `confidence` 필드를 이 이름으로
번역하는 유일한 경계이며, 그 위로는 "출처 일치도"라는 말만 씁니다.

### 7.2 두 reviewer의 "합의"가 실제로 측정하는 것

`computeReviewAgreement()`가 계산하는 것은 두 가지뿐입니다.

- `confidenceMatches` — 두 reviewer의 **출처 일치도 등급**이 같은가
- `sharedVerifiedQuoteCount` — 두 reviewer가 **정확히 같은 문구**를 인용한 수

**결론에 대한 합의가 아닙니다.** UI 문구는 이미 이 경계 안에 있습니다
(`aiReviewAgreementSourceGroundingMatch`: "두 검토자의 출처 일치도 수준이
같습니다", `aiReviewAgreementSharedQuotes`: "두 검토자가 정확히 동일하게 인용한
검증된 문구가 {count}개 있습니다"). **이 문구를 "두 검토자가 동의했습니다"로
바꾸는 것은 계약 위반입니다.**

선택지는 둘이었습니다. **A안 — 현재 측정값에 맞게 UI와 설명을 정확히 제한**,
**B안 — reviewer item alignment를 구현해 어떤 항목에 동의·불일치했는지 실제로
보여 준다.** A안을 택했습니다. B안은 제3의 judge 또는 문자열 유사도를
요구하는데, **전자는 비용 승인이 필요하고 후자는 "의미적 합의율"이라고 부를 수
없기 때문**입니다. B안은 §6의 기준과 비용이 승인된 뒤의 별개 delivery입니다.

### 7.3 "서로 다른 provider"

`accessibleComparisonReviewers()`는 **source 답변과 다른 provider**를 앞으로
정렬하지만, 두 번째 reviewer는 **모델 id가 다른 다음 후보**로 고릅니다. 즉
같은 provider의 두 모델이 선택되는 구성이 가능합니다. 기본 패널
(`mistral-medium-3-1` · `claude-sonnet-5` · `qwen3.7-plus`)은 세 provider이지만
`COMPARISON_REVIEW_MODEL_IDS`로 바뀔 수 있습니다.

**그러므로 제품 어디에서도 "서로 다른 provider"라고 말하지 않습니다.**
대신 `ComparisonReviewRun.crossProvider`가 실제로 그랬는지를 매 실행마다
기록하므로, 그 주장을 하고 싶어지면 먼저 검증할 수 있습니다.

### 7.4 근거 없이 쓰지 않는 표현

- "AI Review가 정답을 찾았다"
- "reviewer들이 결론에 합의했다"
- "사실이 검증됐다"
- "가장 좋은 모델·승자를 선정했다"
- "높은 출처 일치도 = 높은 사실 정확도"

## 8. Scorecard

`lib/aiReviewScorecardCore.ts`가 유일한 집계 코어이며, CLI 보고서와 화면이
같은 함수를 부릅니다. 7·30·90일 구간.

### 8.1 세 층을 섞지 않습니다

| 층 | 출처 | 동의 필요? |
|---|---|---|
| Reliability | `ComparisonReviewRun` — 서버가 모델을 부르는 경로에서 씀 | 아니오 (서비스 운영) |
| Quality | reviewer pair register + 평가 artifact | — |
| Adoption·value | `ProductAnalyticsEvent` — 사용자 동의가 필요한 client telemetry | 예 |

**client analytics를 신뢰성 지표로 쓰지 않습니다.** 브라우저가 닫히거나
차단기가 있으면 client event는 없고, 그 부재는 실패와 구분되지 않습니다.
두 계측기의 차이는 `telemetryCoverage()`가 **비교로만** 보고하며 신뢰성 비율에
접히지 않습니다.

### 8.2 분모와 제외 조건을 화면에 적습니다

모든 `ScorecardMetric`이 `denominatorLabel`을 갖고, 제외한 것은 `excluded`에
적습니다. 예: completion rate의 분모는 **provider에 도달한 실행**이고,
cache hit과 provider 이전 거부는 제외됩니다 — 둘 다 reviewer가 동작했는지에
대해 아무 말도 하지 않기 때문입니다.

### 8.3 표본이 부족하면 `insufficient_evidence`

분모가 하한(기본 20) 미만이면 값은 `null`이고 상태는
`insufficient_evidence`입니다. **0점도 M5도 아닙니다.**

### 8.4 scorecard는 자기 대상을 수정하지 않습니다

register status, feature flag, release gate 어느 것도 자동으로 바꾸지 않습니다.
보고서가 자기 대상을 편집하면 register가 존재하는 이유인 감사 기록이
사라집니다.

## 9. 사용자 품질 피드백

### 9.1 항목 식별

review 결과의 claim에는 저장된 id가 **없습니다.** `ComparisonReview.result`는
읽을 때 스키마로 검증되므로 claim마다 `id`를 추가하면 **지금까지 캐시된 모든
review가 무효**가 됩니다(이는 `sourceGrounding` 개명이 저장 경계에서 멈춘 것과
같은 이유입니다). 따라서 id는 **파생**합니다:
`reviewer:section:ordinal:digest16`.

- `reviewer` — 두 검토자의 같은 문장은 서로 다른 대상입니다
- `section` — contradiction의 "틀림"과 omission의 "틀림"은 다른 신고입니다
- `ordinal` — 같은 section의 비슷한 두 claim을 구분합니다
- `digest` — claim이 바뀌면 새 id가 되어, 옛 판단이 새 문장에 조용히
  옮겨 붙지 않습니다

서버는 client가 보낸 id를 **신뢰하지 않습니다.** 이 review의 어떤 claim과도
맞지 않는 id는 저장하지 않고 거절합니다.

### 9.2 계약

- 판단은 `helpful` · `incorrect` · `unclear` · `missing_point` — **세 부정을
  하나의 엄지로 합치지 않습니다.** 어디를 볼지 말해 주는 부분이 사라집니다.
- `(review, user, item)` unique가 멱등성 키입니다. 더블클릭은 한 행을
  갱신하고, 변경은 UPDATE, 철회는 DELETE이며 **DELETE는 멱등**입니다.
- **자유 텍스트가 없습니다.** 산문으로 하고 싶은 말은 기존 `Feedback` 흐름의
  것이고, 그쪽이 그걸 다루도록 만들어져 있습니다.
- **게스트는 남길 수 없습니다.** guest review는 저장되지 않으므로 판단이 가리킬
  대상이 없고, 대상을 만들려면 그 의견을 담기 위해 게스트의 검토 결과를
  저장해야 합니다. UI는 그 이유를 앞에 적고 숨기지 않습니다.
- analytics에는 **닫힌 enum만** 갑니다 — 판단과 section. **item id는 보내지
  않습니다**: 회차별 id 여러 개가 timestamp 옆에 있으면 작은 모집단을 하나의
  대화로 좁힙니다.
- **판단 하나는 모델 오류의 확정이 아닙니다.** 사용자가 잘못 읽었을 수도,
  옳은 claim에 동의하지 않았을 수도, 정말 맞을 수도 있습니다.
  `summariseItemFeedback()`은 건수와 (하한을 넘을 때만) 비율을 보고하며 자기
  판정을 갖지 않습니다.

### 9.3 데이터 의미론

| | |
|---|---|
| 보존 | review·계정과 함께 cascade. 별도 TTL 없음 |
| 계정 삭제 | `ComparisonReview` → `User` 양쪽 cascade로 삭제 |
| 계정 export | **포함**(`ai_review_item_feedback`) — 사용자 자신의 판단입니다 |
| 게스트 | 해당 없음 |

## 10. M5 승급 조건

### 10.1 `M5 readiness complete`

`AI_REVIEW_M5_READINESS_ITEMS` 10개가 전부 충족될 때. 저장소만으로 판정합니다.

### 10.2 `M5 eligible`

`AI_REVIEW_M5_ELIGIBILITY_ITEMS` 10개가 전부 충족될 때. **이번 세션에서
추측하지 않습니다.**

1. sealed decision dataset에서 **독립 실행 2회** 통과(서로 다른 run ordinal)
2. 사람의 블라인드 품질 검토와 서명
3. production이 실제로 서비스하는 reviewer pair가 승인된 pair와 일치
   (`registerDrift()`가 configuration에서 읽습니다)
4. 사람이 승인한 관측 기간 동안 reliability trend 유지
5. 사람이 승인한 production 표본 크기
6. 예약·정산·환급 불일치 0
7. critical quality violation 0
8. 사람이 baseline을 본 뒤 승인한 adoption·반복 사용 기준 충족
9. 장애·reviewer 교체 rollback drill 완료(§11 — **runbook을 쓰는 것은 drill을
   수행한 것이 아닙니다**)
10. 사람의 최종 M5 승급 서명

**관측 기간과 adoption 임계값은 현재 baseline을 본 뒤 사람이 정합니다.**
임의의 작은 표본으로 M5를 자동 승인하지 않습니다.

## 11. rollback

`docs/ops/ai-review-rollback.md`.

## 12. 이 계약을 어기는 변경은 릴리스 차단 사유입니다

되돌릴 수 없는 것에 비례한다는 AGENTS.md 규칙을 적용하면, 이 문서에서 차단인
것은 다음입니다 — **틀렸을 때 되돌릴 수 없기 때문입니다.**

- §7의 의미 계약을 넘는 제품 문구(사용자가 그 말을 믿고 내린 결정은 회수되지
  않습니다)
- 승인 없이 register의 `status`·`approvedBy`·`approvedAt`·`evidenceRefs` 변경
  (감사 기록은 복구되지 않습니다)
- `ComparisonReviewRun`에 사용자 콘텐츠를 넣는 변경(유출은 회수가 성립하지
  않습니다)
- 기존 캐시된 `ComparisonReview`를 읽을 수 없게 만드는 변경(사용자가 이미
  값을 치른 결과가 사라지고, 다시 과금됩니다)

나머지 — 라벨, scorecard 배치, 보고서 문구 — 는 고쳐서 배포하면 끝나는 것이며
차단이 아닙니다.
