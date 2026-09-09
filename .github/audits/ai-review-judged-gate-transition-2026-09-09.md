# 승인 경로를 키워드 진단에서 judged-v3로 옮기는 전환안

**미승인 설계안이다.** 게이트도 임계값도 지표 정의도 바꾸지 않았고, 제안된 집계는
실험 스크립트 안에만 있다. 유료 호출은 0회다.

작성 2026-09-09. 대상 commit `8d36839`.

재현:

```
npm run experiment:ai-review-judged-gate-transition
```

이 컨테이너에서 제가 실행했고, production 자격증명이 필요 없으며 읽기 전용이다
(파일을 쓰지 않는다). 스크립트는
`scripts/experiments/ai-review-judged-gate-transition-experiment.mjs`이고, 후보
파일을 읽지 않는다 — case는 전부 합성이다.

## 0. 무엇이 실물이고 무엇이 제안인가

| | 상태 |
|---|---|
| **키워드 경로** | 실물. `scoreCase()` → `aggregateOutcomes()` → `approvalMetricsFromArm()` → `thresholdShortfalls()`를 게이트가 부르는 그대로 실행한다 |
| **judged-v3의 case 단위 채점** | 실물. `scoreJudgedCase()`·`verifyJudgementRecord()`가 각 case를 실제로 채점한다 |
| **judged-v3의 실행 단위 집계** | **없다.** 아래 §3의 규칙은 실험 스크립트 안에만 있고, `lib/`에 구현하지 않았다 |
| **judged-v3용 임계값** | **없다.** 아무도 쓰지 않았고, 옛 숫자를 옮겨 오지 않는다(§4) |

## 1. 무엇이 문제인가

`docs/policy/ai-review-m5-quality-contract.md` §3.4a가 적은 그대로다 — 발견 개수
지표는 gold의 `anyOf` 문구가 그 종류의 findings 필드에 나왔는지만 보며,
**어느 답변을 지목했는지도, 없다는 주장인지 있다는 주장인지도 말하지 못한다.**
그런데 그 수치가 `run.metrics` → `thresholdShortfalls()` →
`approvedEntryProblems()`로 흘러 **승인 판정에 도달한다.**

judged-v3는 그 셋을 전부 구별하지만, **개별 기록을 검증할 뿐 승인 경로에 연결돼
있지 않다.** 이 문서는 그 연결을 어떻게 만들지를 설계한다.

## 2. 전환 규칙 — 지표별

**"키워드에서 왔으니 judged로 옮긴다"가 아니다.** 지표마다 무엇을 재는지 다시 보고
정한다.

| 지표 | 현재 유도 | 전환 | 근거 |
|---|---|---|---|
| contradiction recall | 키워드 TP / gold | **judged-v3로 대체** | 같은 것을 재려던 지표이고, judged-v3가 실제로 잰다 |
| contradiction precision | 키워드 TP / (TP+FP), exhaustive만 | **judged-v3로 대체** | 위와 같음. `precisionCounted`·`precisionTruePositives`가 이미 분자·분모를 갈라 들고 다닌다 |
| omission recall·precision | 같음 | **judged-v3로 대체** | 같음 |
| exact-quote match rate | 인용문이 귀속된 답변에 실제로 있는가 | **유지** | 키워드 매칭이 아니고, judged-v3가 재는 것도 아니다. 그대로 둔다 |
| schema-valid completion | 구조화 출력이 파싱됐는가 | **유지** | 같은 이유 |
| **false-consensus rate** | 키워드 TP 합계가 0 | **자동 유도 금지 — §2.1** | 이름과 계산이 같은 것을 말하지 않는다 |
| **invented-issue rate** | 문제 없는 case의 **제출 건수** > 0 | **자동 유도 금지 — §2.2** | 키워드 파생이 아니며, judged-v3가 더 잘 정의할 수 있으나 **다른 측정**이다 |
| zero-tolerance 위반 수 | 용어 선별 3 + 사람 2 | **유지** | 별개 층이다. `false_consensus_safety`는 다섯 규칙 중 하나이며 **사람만 판정**하고, 아래 §2.1의 rate와 다른 것이다 |

### 2.1 false-consensus rate — 정의부터 정해야 한다

현재 계산은 `!isNegative && plantedTotal > 0 && foundTotal === 0`이다. **심은 항목을
하나도 맞히지 못했다**는 뜻이고, 지표의 이름이 말하는 **"합의가 있다고 보고했다"**
는 검사하지 않는다. 이름과 계산이 같은 것을 말하지 않는 상태다.

judged-v3로 옮기면 앞의 절반은 그대로 온다 — TP 합계가 0인지는 판정 기록으로 더
정확히 알 수 있다(오지목·반대 주장이 TP로 세지 않으므로 **지금보다 자주 0이 된다**).
**뒤의 절반은 오지 않는다.** "합의라고 말했다"는 검토자의 발화에 대한 판정이고,
judged-v3에는 그 축이 없다.

**선택지는 둘이고, 어느 쪽도 자동이 아니다.**

- **(a) 이름과 정의를 계산에 맞춘다** — "심은 항목을 하나도 보고하지 못한 case의
  비율". 지표 이름을 바꾸고 새 임계값 버전을 만든다. 구현은 judged-v3 TP 합계로
  바로 된다.
- **(b) 두 번째 축을 추가한다** — 검토자가 합의를 주장했는지를 사람이 판정해
  기록한다. 블라인드 시트가 이미 `false_consensus_safety`를 사람에게 묻고 있으므로
  그 자리와 이어질 수 있으나, **그 규칙은 zero-tolerance이지 rate가 아니다.**
  둘을 합치면 어느 쪽 실패인지 말할 수 없게 된다.

**이 문서는 어느 쪽도 고르지 않는다.**

### 2.2 invented-issue rate — judged-v3가 더 낫지만 같은 지표가 아니다

현재 계산은 `isNegative && byKind.contradictions.reported > 0`이다. **제출 건수를
셀 뿐 내용을 읽지 않는다.** 그래서 문제 없다고 분류된 case에서 검토자가
**실제로 옳은 지적**을 해도 "지어냈다"로 센다.

judged-v3에서는 문제 없는 case의 gold가 비어 있으므로 **모든 제출이 gold 밖**이고,
`outsideGoldVerdict`가 둘을 가른다.

- `false_finding` — 검토자가 지어냈다. **이것이 이 지표가 재려던 것이다.**
- `gold_incomplete` — 검토자가 옳고 **case의 분류가 틀렸다.** 이것은 검토자의
  실패가 아니라 case에 관한 사실이며, 지금은 둘이 같은 숫자에 들어간다.

**개선이지만 승계는 아니다.** 분모·분자가 달라지므로 새 임계값이 필요하고, 옛
0.10을 그대로 쓰면 무엇에 대한 0.10인지 아무도 말할 수 없다.

## 3. 실행 전체의 집계 조건 — 제안

**개별 case가 검증됐다는 사실과 실행 전체를 집계할 수 있다는 사실은 다르다.**
계약이 이미 case 단위로 그 둘을 갈라 두었고(`verifyJudgedScoringEvidence()`의
`problems`와 `eligibleForAggregation`), 실행 단위에도 같은 분리가 필요하다.

**집계 가능성은 rate보다 먼저 판정하고, 하나라도 걸리면 숫자를 만들지 않는다.**
분모를 줄여 계산하는 것이 이 규칙이 막으려는 실패다 — 판정이 끝난 case만 세면
**끝나지 않은 판정이 좋은 점수로 읽힌다.**

| 상태 | 처리 | 이유 |
|---|---|---|
| **판정 누락** — 실행 계획에 있는 case에 판정 기록이 없다 | **집계 불가** | 분모를 줄이면 판정하지 않은 것이 측정된 성공이 된다. runbook이 "부분 실행"을 증거에서 제외하는 것과 같은 규칙 |
| **중복** — 같은 `(caseId, observationRef)`에 기록이 둘 | **집계 불가** | 둘이 다르면 고르는 것이 곧 판정이고, 같으면 왜 둘인지 모른다 |
| **거절** — `scored: false` | **집계 불가.** 0이 아니다 | 계약의 규칙 그대로다. 거절은 "미달"이 아니라 "측정 아님" |
| **계약 버전 혼합** | **집계 불가** | 다른 규칙 아래 만든 기록을 한 숫자에 넣는 것이 v3가 버전을 올린 이유다 |
| **gold gap 확정** — exhaustive gold가 반증됨 | **집계 불가**, gold 수정 후 **그 case의 모든 reviewer 재채점** | 계약이 이미 정한 절차 |
| **외부 결속 미확인** — journal·dataset 대조 없음 | **집계 불가** | `eligibleForAggregation`이 이미 case 단위로 거절한다 |

**집계가 가능해진 뒤에만** kind별 TP·FN·FP를 합산하고, precision은
`precisionCounted`인 case의 분자·분모만 더한다(계약이 이미 정한 규칙이며 이
전환이 바꾸지 않는다).

## 4. 임계값은 승계하지 않는다

**옛 숫자를 새 척도에 옮기지 않는다.** v1-draft의 `omissionRecall ≥ 0.70`은
**키워드가 맞혔다고 센 비율**에 대한 제안이고, judged-v3의 recall은 **사람이
올바른 발견이라고 판정한 비율**이다. 같은 이름의 다른 측정이다.

§5의 실험이 그것을 수로 보여 준다 — 같은 검토자에게 두 척도가 서로 다른 숫자를
준다. 옛 임계값을 그대로 얹으면 **더 엄격한 척도에 더 느슨한 척도용으로 정한
기준을 적용**하게 되고, 그 조합에 대해서는 아무도 판단한 적이 없다.

새 임계값 집합은 새 `version`으로 만들고 `approvedBy: null`로 시작한다. 그 숫자를
정하는 것은 **별개의 사람의 행위**이며 이 전환안에 포함되지 않는다.

## 5. 합성 fixture 실험 — 승인 경로까지의 전달

합성 case 4건, gold는 `c가 기한을 제시하지 않는다`(exhaustive). 검토 4건 중
**올바른 발견 2, 오지목 1, 반대 주장 1**이다.

| 경로 | TP | FN | FP | omission recall (Wilson 하한) |
|---|---|---|---|---|
| **키워드 (실물 게이트 코드)** | **4** | **0** | **0** | 0.510 |
| **judged-v3 (제안 집계)** | **2** | **2** | **2** | 0.150 |

**키워드 경로는 오지목과 반대 주장을 올바른 발견과 똑같이 셌다.** 네 건 모두
`2주`·`14일`을 담고 있기 때문이다. judged-v3는 오지목을 gold 밖의 지어낸 발견으로,
반대 주장을 gold 안의 잘못된 발견으로 판정해 각각 FP를 남기고 gold 항목을 미발견으로
둔다.

**표본이 4건이므로 두 경로 모두 v1-draft를 통과하지 못한다**(Wilson 하한이 낮다).
이 비교가 보여 주는 것은 **누가 통과하는가가 아니라 무엇이 세어지는가**이다.
judged-v3의 숫자는 승인 판정 표에 넣지 않았다 — 그 척도의 임계값이 없고, v1-draft를
재사용하는 것이 §4가 금지하는 승계다.

실행 단위 조건도 같은 스크립트가 실제로 거절하는 것을 보인다.

| 상태 | 결과 |
|---|---|
| 판정 누락 | 집계 불가 — `planned in the run and never judged` |
| 같은 출력에 판정 둘 | 집계 불가 — `judged twice for the same output` |
| 계약 버전 혼합 | 집계 불가 — `judged under …v2, this run is …v3` |
| 판정 미완료(`pending`) | 집계 불가 — 계약의 기록 검증이 먼저 거절한다 |

## 6. 기존 테스트가 이미 보장하는 것 — 다시 증명하지 않는다

| 이미 고정된 것 | 어디 |
|---|---|
| 키워드 채점이 오지목·반대 주장·동의어에서 틀린다는 측정 | `tests/aiReviewEvalScoringContract.test.mjs` |
| judged-v3의 case 단위 규칙 전부(네 축·역할·충분성·서명·digest 결속) | `tests/aiReviewEvalJudgementScoring.test.mjs` |
| 파일 흐름과 초안 도구, 거절의 전달 | `tests/aiReviewJudgementScoringCli.test.mjs` |
| 무결성과 집계 적격성의 분리(case 단위) | `tests/aiReviewEvidenceBundle.test.mjs` |
| 게이트 자신의 산술과 arm 규칙 | `tests/aiReviewQualityThresholds.test.mjs` |

**아직 아무것도 보장하지 않는 것은 §3의 실행 단위 집계뿐이다.** 구현이 승인되면
그 자리에 회귀가 필요하고, 나머지는 그대로 재사용한다.

## 7. 승인 후의 순서

사람이 이 전환안을 승인한 다음에 한다. **지금은 하지 않는다.**

1. **§2.1과 §2.2의 정의를 먼저 정한다.** 지표 정의가 열려 있는 채로 집계기를
   만들면 그 코드가 정의를 대신 정하게 된다.
2. `lib/`에 **실행 단위 집계**를 구현한다 — §3의 조건이 먼저 돌고, 통과한 뒤에만
   rate를 낸다. 순수 함수로 두고 게이트와 보고서가 같은 것을 부른다.
3. **새 임계값 집합**을 `approvedBy: null`로 추가한다. 숫자를 정하는 것은 별개
   승인이다.
4. 게이트를 연결한다. **키워드 경로를 지우지 않는다** — 기존 artifact는 그 척도로
   계산됐고 계속 검증되어야 한다. 두 척도가 한동안 나란히 보고되고, 어느 쪽이
   승인을 정하는지는 threshold 집합이 말한다.
5. §3의 회귀를 붙인다.

## 8. 이 문서가 정하지 않은 것

- **false-consensus rate의 정의**(§2.1 (a)/(b)).
- **invented-issue rate의 새 정의와 임계값**(§2.2).
- **judged-v3용 임계값 숫자**(§4).
- **키워드 경로를 언제 내릴지.** 이 전환안은 내리지 않는다.
- 계약 전체 승인·후보 채택·dataset 동결·M5 승급·유료 실행은 이 문서 밖이며 계속
  보류다.
