# AI Review 운영 지표 사전

`npm run report:ai-review-operations`과 (구현되면) Admin 화면이 같은 코어
(`lib/aiReviewScorecardCore.ts`)에서 계산하는 지표들의 정의입니다. **어떤 숫자를
인용하기 전에 그 분모가 무엇인지 여기서 확인합니다.**

세 층은 출처가 다르고 **섞이지 않습니다**
(`docs/policy/ai-review-m5-quality-contract.md` §8.1).

## 0. 공통 규칙

- 모든 비율은 `ScorecardMetric`이며 `numerator`·`denominator`·
  `denominatorLabel`·`excluded`·`minimumDenominator`·`status`를 함께 갖습니다.
- 분모가 하한(기본 20) 미만이면 값은 `null`, 상태는 `insufficient_evidence`.
  **0이 아니고 M5도 아닙니다.**
- percentile은 nearest-rank입니다. 보간하면 어떤 실행에도 없던 시간을 만들어
  내며, 이 표본 크기에서는 그게 흔합니다.

## 1. Reliability — `ComparisonReviewRun`

서버가 reviewer를 부르는 경로에서 직접 씁니다. **사용자 동의를 요구하지
않습니다**: 서비스가 동작하는지 아는 것은 서비스 운영이지 행동 분석이
아닙니다.

### 1.1 outcome

| 값 | 의미 |
|---|---|
| `completed_dual` | 두 reviewer 모두 결과를 냄 |
| `completed_primary_only` | primary만. 두 번째가 없었거나 실패 |
| `failed` | provider에 도달한 모든 시도가 실패 |
| `refused_before_provider` | provider 호출 전에 거부(reviewer 없음, 크레딧 부족, 한도, payload 초과) |
| `cached` | 저장된 `ComparisonReview`로 응답. provider 호출 없음 |

**`refused_before_provider`는 `failed`가 아닙니다.** 아무것도 보내지 않았으므로
reviewer의 건강에 대해 아무 말도 하지 않으며, provider 실패율에 들어가면 안
됩니다.

### 1.2 지표

| 지표 | 분자 | 분모 | 제외 |
|---|---|---|---|
| `completionRate` | `completed_dual` + `completed_primary_only` | **provider에 도달한 실행** | cache hit, provider 이전 거부 |
| `primaryOnlyRate` | `completed_primary_only` | 완료된 실행 | — |
| `dualAvailabilityRate` | 두 번째 reviewer 후보가 존재한 실행 | 두 번째를 요청한 실행 | — |
| `dualCompletionRate` | 두 번째가 실제로 완료된 실행 | **두 번째 후보가 존재한 실행** | 후보가 없던 실행 |
| `cachedRate` | `cached` | 전체 실행 | — |
| `retryRate` | 재시도가 1회 이상인 시도 | provider에 도달한 reviewer 시도 | 거부된 시도 |
| `unreconciledSettlements` | 정산 상태가 없는 완료 시도 | 완료된 reviewer 시도 | — |

**`dualAvailabilityRate`와 `dualCompletionRate`의 분모가 다른 것이 요점입니다.**
전자는 "두 번째 검토를 제공할 수 있었나", 후자는 "제공할 수 있었을 때 실제로
됐나"입니다. 하나로 합치면 reviewer 부족과 reviewer 실패가 구분되지 않습니다.

`unreconciledSettlements`는 **크레딧이 사라졌다는 증거가 아닙니다.** 정산은
fire-and-forget이고 그 자체의 실패는 이미 로그에 남습니다. 다만 예약이 정산되지
않기 시작하면 **움직이는 유일한 숫자**이므로 카드에 있습니다.

### 1.3 duration

`p50DurationMs` · `p95DurationMs`는 **완료된 실행만** 씁니다. 45초 timeout으로
끝난 실패를 섞으면 p95가 timeout 값에 고정되어 아무것도 말하지 않습니다.

### 1.4 reviewerHealth

reviewer 모델별 `attempts` / `failures` / `failureRate`. **provider에 도달한
시도만** attempts이며, 로컬 거부(크레딧·한도·context window)는 세지 않습니다 —
이는 `recordModelFailure`가 이미 지키는 구분과 같습니다.

### 1.5 crossProvider

두 reviewer가 서로 다른 provider였는지. 두 번째 시도가 없으면 `null`.

**제품 어디에서도 "서로 다른 provider"라고 말하지 않습니다**(정책 §7.3).
이 컬럼은 그 주장을 하고 싶어졌을 때 **먼저 확인할 수 있게** 하는 것입니다.

## 2. Telemetry coverage — 비교이지 비율이 아님

| | |
|---|---|
| `serverRuns` | `ComparisonReviewRun` 행 수 |
| `clientStartedEvents` | `comparison_review_started` 이벤트 수 |
| `ratio` | client / server |

**1에 가까울 필요가 없습니다.** client event는 analytics 동의와 열려 있는
브라우저를 요구하므로 애초에 더 적습니다. 이 숫자가 **움직이는 것**이 신호이며,
두 계측기 중 하나가 실행을 놓치기 시작했다는 뜻입니다. 신뢰성 비율에 접지
않습니다.

## 3. Quality — reviewer pair register

| | |
|---|---|
| `approvedPairCount` | `status: approved`인 pair 수 |
| `datasetVersion` | 승인 근거가 된 dataset. 승인이 없으면 `null` |
| `independentRunOrdinals` | 승인이 인용하는 독립 실행 ordinal |
| `zeroToleranceViolations` | 승인 시점 기록. 승인이 없으면 **`null`**(0이 아님) |
| `drift.inSync` | production이 서비스할 pair가 승인된 pair와 같은가 |

`drift`는 **configuration에서** 서비스 pair를 읽습니다
(`COMPARISON_REVIEW_MODEL_IDS` 또는 기본 패널). register 자신에서 읽으면 drift를
보고할 수 없습니다.

## 4. Adoption·value — `ProductAnalyticsEvent`

**analytics 동의가 필요합니다.** 여기의 부재는 실패가 아니라 동의하지 않은
사용자입니다.

actor는 로그인 사용자면 `user:<id>`, 아니면 `anonymous:<hash>`이며 제품
analytics dashboard와 같은 규칙입니다.

| 지표 | 분모 |
|---|---|
| `weeklyActiveReviewUsers` | (개수) 최근 7일 내 review를 시작하거나 완료한 actor |
| `comparisonToReview` | 다중 모델 비교를 완료한 사용자 |
| `reviewToFollowUp` | AI Review를 완료한 사용자 |
| `reviewToSaveOrShare` | AI Review를 완료한 사용자 |
| `reviewToItemWebCheck` | AI Review를 완료한 사용자 |
| `firstToSecondReview` | AI Review를 1회 이상 **완료**한 사용자 |
| `returnDay1/7/30` | AI Review를 완료한 사용자 |
| `cohortReturnDay7.comparisonOnly` | 비교는 했지만 AI Review를 열지 않은 사용자 |
| `cohortReturnDay7.aiReview` | AI Review를 완료한 사용자 |

**`firstToSecondReview`는 완료로 셉니다**, 시작이 아니라. 두 번 시작하고 한 번
끝낸 사용자는 결과로 돌아온 것이 아닙니다.

**cohort 비교는 인과 주장이 아닙니다.** 두 cohort는 스스로 나뉘었고, 차이는
기능이 무엇을 해 줬는지만큼이나 누가 그 기능을 썼는지의 차이입니다. 보고서가
이 문장을 화면에 함께 출력합니다.

`return_day_*`는 계정 나이가 정확히 그 날인 하루 안에 앱을 연 사용자만
기록합니다. 그날 쉰 사용자는 어디에도 세어지지 않으므로, **이 숫자는 재방문율의
하한**입니다.

## 5. 항목 피드백

`summariseItemFeedback()`. `total`, 판단별 건수, section별 건수, 그리고
행 수가 하한(기본 20) 이상일 때만 `negativeRate`.

**판단 하나는 모델 오류의 확정이 아닙니다.** 사용자가 잘못 읽었을 수도, 옳은
claim에 동의하지 않았을 수도, 정말 맞을 수도 있습니다. 이 집계는 어디를 볼지
말해 주는 신호이고, 품질 주장은 평가(§3)에서 나옵니다.

Admin에는 **집계만** 표시하며 사용자가 무엇에 대해 어떤 판단을 했는지의 원문은
표시하지 않습니다.

## 6. 보존

| 테이블 | 보존 | 계정 삭제 | export |
|---|---|---|---|
| `ComparisonReviewRun` | 90일 TTL(`maintenance:cleanup`) | 익명화(userId·subjectKey·traceId·conversationId) | 제외 |
| `ComparisonReviewItemFeedback` | review·계정과 함께 | cascade 삭제 | **포함** |
| `ProductAnalyticsEvent` | 기존 정책 | 기존 정책 | 기존 정책 |
