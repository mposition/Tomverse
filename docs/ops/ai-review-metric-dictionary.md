# AI Review 운영 지표 사전

`npm run report:ai-review-operations`과 Admin의 `analytics?tab=ai-review`가 같은 코어
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

### 1.1a attempt 행 — 신뢰성의 실제 출처

`ComparisonReviewRun`의 primary/secondary는 **사용자가 본 결과를 만든
reviewer**입니다. `ComparisonReviewRunAttempt`는 **실제로 시도된 것**입니다.
reviewer health·retry·정산 대조는 전부 attempt에서 읽습니다.

첫 후보가 실패하고 두 번째가 성공한 실행은 primary가 하나(성공한 쪽)이고
attempt가 둘(실패 + 성공)입니다. 개정 전에는 attempt 목록이 없어서 **fallback이
앞선 실패를 지웠고**, reviewer 실패율이 production보다 좋게 나왔습니다.

### 1.2 지표

| 지표 | 분자 | 분모 | 제외 |
|---|---|---|---|
| `completionRate` | `completed_dual` + `completed_primary_only` | **provider에 도달한 실행** | cache hit, provider 이전 거부 |
| `primaryOnlyRate` | `completed_primary_only` | 완료된 실행 | — |
| `dualAvailabilityRate` | 두 번째 reviewer 후보가 존재한 실행 | 두 번째를 요청한 실행 | — |
| `dualCompletionRate` | 두 번째가 실제로 완료된 실행 | **두 번째 후보가 존재한 실행** | 후보가 없던 실행 |
| `cachedRate` | `cached` | 전체 실행 | — |
| `retryRate` | 서비스가 재시도한 **attempt** | provider에 도달한 attempt | 거부된 attempt, **SDK가 스스로 재시도해 성공한 요청**(하한값) |
| `missingTraceRate` | 시도됐지만 표에 없는 telemetry write | **이 window에서 시도된 write** | writer 컬럼 이전 행. 하한값입니다(§1.2a) |
| `unreconciledSettlements` | 정산액도 환급액도 없는 attempt | **크레딧을 잡은 채 provider에 도달한 attempt** | 예약이 0인 attempt |
| `creditReconciliation` | 잘못된 방향으로 정리된 크레딧(초과 정산 + 미환급) | 금액이 기록된 attempt | 금액이 없는 attempt(위 지표가 셈) |
| `overSettledRate` | **예약보다 많이 정산된** 완료 attempt | 금액이 기록된 완료 attempt | — |
| `unrefundedFailureRate` | **0보다 크게 정산된** 실패 attempt | 금액이 기록된 실패 attempt | 환급이 보고되지 않은 실패 attempt |

**모집단은 완료된 attempt가 아니라 크레딧을 잡은 채 provider에 도달한 attempt
전체입니다.** 예약의 수명은 둘로 끝납니다 — 완료되면 정산, 실패하면 환급. 그런데
환급도 실패할 수 있고, 서비스는 실패한 환급을 실패한 정산과 **같은 방식으로**
기록합니다(`settledCredits: null`). 완료된 attempt만 물으면 그 절반이 통째로
보이지 않습니다.

2026-08-31에 재현했습니다 — 깨끗한 완료 20건과 환급이 보고되지 않은 실패 5건이
`unreconciled 0 / 20, status ok`로 나왔습니다. 사용자 크레딧 5건이 아무도 놓지
않는 예약에 묶여 있는 채로, `zero_credit_reconciliation_mismatch`가 통과할 수
있는 상태였습니다.

**두 절반의 판정 규칙이 다릅니다.** 완료된 attempt는 예약액 이하 어디든
정상입니다 — 쓰지 않은 부분은 반환됩니다. 초과는 아무것도 잡아 두지 않은
크레딧이 청구된 것입니다. 실패한 attempt는 환급됐으므로 정산액이 **0이어야**
하고, 그보다 크면 받지 못한 검토에 대해 청구된 것입니다. 둘을 `overSettledRate`
와 `unrefundedFailureRate`로 나눠 보고하는 이유는 **부르는 조사가 다르기**
때문입니다 — 앞은 정산·가격 결함이고 뒤는 일어나지 않은 환급입니다.

**예약이 0인 attempt는 이 질문 밖입니다.** 정리할 예약이 없으므로, 세면 비율만
희석됩니다.

**`settledCredits`의 `null`은 0이 아닙니다.** 정산이 실행되지 않았거나 보고하지
않았다는 뜻이며, 둘을 구분하지 못하면 정산 안 된 시도가 전부 환급으로 읽힙니다.
"모른다"와 "어긋난다"는 서로 다른 조사를 부릅니다.

**`dualAvailabilityRate`와 `dualCompletionRate`의 분모가 다른 것이 요점입니다.**
전자는 "두 번째 검토를 제공할 수 있었나", 후자는 "제공할 수 있었을 때 실제로
됐나"입니다. 하나로 합치면 reviewer 부족과 reviewer 실패가 구분되지 않습니다.

`unreconciledSettlements`는 **크레딧이 사라졌다는 증거가 아닙니다.** 정산은
fire-and-forget이고 그 자체의 실패는 이미 로그에 남습니다. 다만 예약이 정산되지
않기 시작하면 움직이는 숫자이므로 카드에 있습니다. 실제로 크레딧이 잘못 나간
것을 세는 것은 그 옆의 `creditReconciliation`입니다.

**`retryRate`는 하한입니다.** 세는 것은 **서비스 자신의** 재시도 루프이고, 그
아래 SDK 호출은 `maxRetries: 1`로 돕니다. SDK가 재시도해서 성공한 요청은 여기
평범한 1회 성공으로 돌아오므로 `retryCount`가 보지 못합니다. 정확하게 만들려면
`maxRetries: 0`으로 두고 여기서 재시도해야 하는데, 그러면 SDK의 backoff도 함께
사라집니다 — 429에 즉시 다시 던지는 것은 측정되지 않는 것보다 나쁜 동작이므로,
**동작이 아니라 숫자에 이름을 붙였습니다.**

### 1.2a `missingTraceRate` — 표에 없는 것을 세는 법

**나머지 모든 비율은 남아 있는 행에서 계산되므로, 몇 개가 없는지 말할 수
없습니다.** insert가 일부만 실패하는 부분 장애에서는 살아남은 행이 "잘 된
것들"로 치우친 표본이 되고, 완료율은 완벽하게 나옵니다. 실제로 그 상태였습니다 —
`comparisonReviewRunTelemetry.ts`의 주석이 scorecard가 `missingTraceRate`를
보고한다고 적어 두었지만, 저장소 전체에서 그 이름은 **그 주석에만** 있었습니다.

이제 각 write는 **쓰기를 시도할 때** 자기 process의 sequence를 하나 당겨서
가집니다(`writerId`, `writerSequence`). 한 writer 안에서 최소~최대 sequence
구간이 시도한 횟수이고, 실제 행 수가 도달한 횟수이며, 차이가 구멍입니다.
실패한 insert도 번호를 소비하므로 구멍이 남습니다.

**셋은 보이지 않고, 지표는 그것을 감추지 않습니다.**

1. process가 죽기 직전에 잃은 write — 뒤에 닻이 될 행이 없습니다.
2. 모든 write가 실패한 process — 행이 하나도 없으니 writer 자체가 없습니다.
3. window 경계가 자른 sequence — 안쪽 첫·마지막 행이 닻이 됩니다.

그래서 이 값은 **하한**입니다. 0보다 크면 구멍이 있다는 증명이고, 0이라고
없다는 증명은 아닙니다. `comparison_review_run_record_failed` 구조화 이벤트가
계속 두 번째 신호로 남으며, 실패 로그에 같은 `writerId`·`writerSequence`가
찍히므로 로그와 표의 구멍이 같은 write를 가리킵니다.

**`writerId`는 식별자가 아닙니다.** process마다 새로 만드는 난수이고 host·
사용자·배포에서 유도하지 않습니다. counter의 범위를 정하는 것 외에 아무 뜻도
없으며, 뜻이 있으면 그것은 "아무 신원도 담지 않는다"가 계약인 표에 신원을 하나
들이는 일입니다.

**신뢰성 비율에 접지 않습니다.** missing이 4%인 window는 완료율이 4% 나쁜
window가 아니라 **완료율이 불완전한 표본 위에서 측정된** window이고, 둘은 다른
대응을 부릅니다. 그래서 운영 리포트에서 이 줄이 신뢰성 숫자들보다 **먼저**
나옵니다 — 아래 숫자들을 한정하는 값이기 때문입니다.

`§2`의 telemetry coverage와도 다릅니다. 그쪽은 server와 client 두 계측기의
비교이고, 이쪽은 server 계측기 **자기 자신**이 놓친 양입니다.

### 1.3 duration

`p50DurationMs` · `p95DurationMs`는 **완료된 실행만** 씁니다. 45초 timeout으로
끝난 실패를 섞으면 p95가 timeout 값에 고정되어 아무것도 말하지 않습니다.

### 1.4 reviewerHealth

reviewer 모델별 `attempts` / `failures` / `failureRate`, **attempt 행에서**
계산합니다. **provider에 도달한 시도만** attempts이며, 로컬 거부(크레딧·한도·
context window)는 세지 않습니다 — 이는 `recordModelFailure`가 이미 지키는 구분과
같습니다.

fallback으로 건너뛴 reviewer의 실패도 여기 남습니다. 그것이 attempt 테이블이
존재하는 이유입니다.

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

| 지표 | 분모 | 순서 |
|---|---|---|
| `weeklyActiveReviewUsers` | (개수) 최근 7일 내 review를 시작하거나 완료한 actor | — |
| `comparisonToReview` | 다중 모델 비교를 완료한 사용자 | **순서 있음** |
| `reviewToFollowUp` | AI Review를 완료한 사용자 | **순서 있음** |
| `reviewToSaveOrShare` | AI Review를 완료한 사용자 | **순서 있음** |
| `reviewToItemWebCheck` | AI Review를 완료한 사용자 | **순서 있음** |
| `firstToSecondReview` | AI Review를 1회 이상 **완료**한 사용자 | — |
| `accountAgeReturnDay1/7/30` | AI Review를 완료한 사용자 | 계정 나이 기준 |
| `reviewAnchoredReturnDay1/7/30` | AI Review를 완료한 사용자 | **첫 검토 기준** |
| `cohortReturnDay7.comparisonOnly` | 비교는 했지만 AI Review를 열지 않은 사용자 | 계정 나이 기준 |
| `cohortReturnDay7.aiReview` | AI Review를 완료한 사용자 | 계정 나이 기준 |

**"순서 있음"은 두 번째 사건이 첫 번째보다 나중이어야 한다는 뜻입니다.** 개정
전에는 "같은 기간에 두 이벤트를 모두 가진 actor"였고, 오전에 follow-up을 보내고
오후에 첫 검토를 연 사용자가 전환으로 계산됐습니다. 순서는 이 이벤트 스트림이
지탱할 수 있는 **가장 강한 주장**이며, 인과가 아닙니다 — 이벤트에 대화 id가
없으므로 검토 이후의 행동이 다른 대화의 것일 수 있습니다.

**`firstToSecondReview`는 완료로 셉니다**, 시작이 아니라. 두 번 시작하고 한 번
끝낸 사용자는 결과로 돌아온 것이 아닙니다.

**재방문 두 종류를 혼동하지 않습니다.**

- `accountAgeReturnDay*` — `return_day_*` 이벤트는 **계정이 그 나이가 된 날**
  발생합니다. 검토 시점과 무관하므로 **"AI Review 이후 retention"이 아닙니다.**
  제품 전체 funnel과 같은 이벤트를 쓰므로 비교 가능하다는 이유로 남깁니다.
- `reviewAnchoredReturnDay*` — **첫 AI Review로부터 N일 이후에 무엇이든 한**
  사용자. 가치 질문이 실제로 묻는 것입니다. **하한**입니다: 돌아왔지만 analytics
  이벤트를 남기지 않은 사용자는 세어지지 않습니다.

**분모는 관측 창이 닫힌 cohort뿐입니다.** 어제 처음 검토한 사용자는 30일 뒤에
돌아왔을 수가 없습니다 — 30일째가 아직 오지 않았습니다. 그런데 그를 분모에 넣으면
**"돌아오지 않음"으로 채점**됩니다. 어제 한 번씩만 검토한 사용자 20명이
`0 / 20, status ok`를 만들었습니다 — 아무도 물을 만큼 기다리지 않은 질문에 대한
자신 있는 0입니다.

그래서 `reviewAnchoredReturnDayN`의 분모는 **첫 검토가 `now`로부터 N일 이상
지난** 사용자입니다. 분모가 작아지고, 지표 하한 아래로 내려가면
`insufficient_evidence`가 됩니다 — 3주 된 기능에게 30일 재방문을 물었을 때의
정답입니다.

**cohort 비교는 인과 주장이 아닙니다.** 두 cohort는 스스로 나뉘었고, 차이는
기능이 무엇을 해 줬는지만큼이나 누가 그 기능을 썼는지의 차이입니다. 보고서가
이 문장을 화면에 함께 출력합니다.

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
| `ComparisonReviewRunAttempt` | 부모 run과 함께 | 부모의 익명화로 충분 — 자체 식별자 없음 | 제외 |
| `ComparisonReviewItemFeedback` | review·계정과 함께 | cascade 삭제 | **포함** |
| `ProductAnalyticsEvent` | 기존 정책 | 기존 정책 | 기존 정책 |

## 7. attempt 행이 data-domain registry에 없는 이유

`ComparisonReviewRunAttempt`에는 `userId` 컬럼도 User 관계도 없고, 사람에게
닿는 경로는 부모 run 하나뿐입니다. registry의 검증기는 스키마의 user 컬럼과
관계에서 대상 집합을 유도하므로 이 표는 그 집합에 들어가지 않습니다.

**그래서 이 표에는 지울 식별자를 두지 않았습니다.** 초안에는 정산 불일치를
추적하려고 `reservationId`가 있었지만, 그것은 크레딧 예약으로 이어지는 join
key였고 registry가 행을 가질 수 없는 표에 새 식별자를 하나 더하는 일이었습니다.
추적은 실행의 `traceId`로 합니다 — 크레딧 예약이 이미 그 trace를 갖고 있고, 그
trace는 계정 삭제 시 run 행에서 이미 익명화됩니다.

남는 컬럼은 reviewer 모델 id, provider, 상태, 소요 시간, 토큰 수, retry 수,
예약·정산 크레딧뿐이며 어느 것도 사람을 가리키지 않습니다.
