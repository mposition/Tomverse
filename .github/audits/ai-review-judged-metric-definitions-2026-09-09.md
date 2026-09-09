# judged-v3 전환에 필요한 두 지표의 정의 — 결정안

**결정안이다. 승인이 아니고, 구현도 아니다.** 이 문서는 `falseConsensusRate`와
`inventedIssueRate`를 judged-v3 위에서 어떻게 정의할지의 선택지를 정리하고 권고를
적는다. **임계값 숫자를 정하지 않고, 게이트에 연결하지 않으며, 코드를 바꾸지
않았다.** 실행 단위 집계기는 정의가 승인된 다음이다.

작성 2026-09-09. 대상 commit `2562fb2`.
`.github/audits/ai-review-judged-gate-transition-2026-09-09.md` §2.1·§2.2가 남긴
결정 항목이다.

재현 — 이 컨테이너에서 제가 실행했다. production 자격증명이 필요 없고 읽기 전용이다:

```
npm run experiment:ai-review-judged-metric-definitions
```

유료 호출 0회, 후보 set·원장 미변경, 저장하는 파일 없음.

## 0. 이 두 지표만 남은 이유

전환안 §2의 표에서 recall·precision 네 개는 judged-v3가 **같은 것을 더 잘 재므로**
대체하면 되고, exact-quote match rate와 schema-valid rate는 키워드 매칭이 아니므로
그대로 둔다. 남은 둘은 다르다.

- `falseConsensusRate` — **이름과 계산이 서로 다른 것을 말한다.** 계산은
  `!isNegative && plantedTotal > 0 && foundTotal === 0`
  (`scoreCase()`, `lib/aiReviewEvalCore.ts`), 즉 "심은 것을 하나도 맞히지 못했다"이고, 이름이
  말하는 "합의가 있다고 주장했다"는 검사하지 않는다.
- `inventedIssueRate` — **제출 건수를 셀 뿐 내용을 읽지 않는다.** 계산은
  `isNegative && byKind.contradictions.reported > 0` (같은 함수).

## 1. 먼저 못박는 사실 셋

정의를 고르기 전에 확인한 것이고, 셋 다 선택을 제약한다.

### 1.1 `AiReviewJudgedCase`에는 `phenomenon`이 없다

`lib/aiReviewEvalJudgement.ts`의 `AiReviewJudgedCase`는 `caseId`·`sourceCaseDigest`·
`responseLabels`·`requirements`·`gold`·`goldCompleteness`만 들고 있다. **"이 case가
문제 없는 case인가"는 판정 artifact만 봐서는 알 수 없다.**

그래서 두 지표의 분모는 어느 쪽을 고르든 **frozen dataset의 case**에서 와야 하고,
그것은 이미 `verifyJudgedScoringEvidence()`가 `dataset`으로 결속하고 있는 값이다.
집계기가 dataset을 별도 입력으로 받는 것은 전환안 §3이 이미 정한 조건이며, 이
사실이 그 조건을 한 겹 더 요구한다.

### 1.2 FP가 0인 원인은 **비완전 gold**이지 음성 분류가 아니다

`scoreJudgedCase()`는 `goldCompleteness[kind] === true`일 때만 false positive를
센다(`outcome.precisionCounted = exhaustive`와 그 아래
`if (exhaustive) outcome.falsePositives += 1`). 불완전한 gold는 "더 있는 발견"과
"빠뜨린 gold 항목"을 구분할 수 없기 때문이며, 이것은 결함이 아니라 계약이다.

**오늘 트리의 음성 fixture는 전부 그 상태다.** `development-v0`의 음성 case
6건(`no_issue` 2 · `genuine_consensus` 2 · `verbosity_bias` 1 · `position_bias` 1)이
모두 `gold: {}`, `goldCompleteness: {}`이므로 `falsePositives`가 0이다.

**그러나 이것을 계약의 성질로 일반화하면 틀린다.** 같은 음성 fixture를
`gold: { contradictions: [] }`, `goldCompleteness: { contradictions: true }`로
등록하면 채점이 통과하고 **FP는 1**이다 — 합성 예제 `syn-11`이 그것이며,
`syn-05`와 phenomenon·제출·판정이 같고 gold 등록만 다르다.

**그래서 B3를 거부하는 근거는 "음성 case에서는 FP가 0이다"가 아니다.** 근거는
둘이고, 둘 다 gold 등록과 무관하게 성립한다.

1. **`falsePositives`는 넷을 한 숫자에 담는다**(§3.1) — 불충분한 발견, 반대 주장,
   인용을 발견 필드에 넣은 것, 확정된 허위 발견. 지어낸 것만 꺼낼 수 없다.
2. **gold가 exhaustive가 아니면 FP가 아예 세어지지 않는다.** 그 상태가 오늘 모든
   음성 fixture의 상태이고, 그때 지어낸 발견은 FP 합계에서 **사라진다**(`syn-05`).

### 1.3 오늘의 후보 set에는 음성 case가 없다

| set | cases | 음성 phenomenon | 양성 + 심은 항목 있음 |
|---|---|---|---|
| `decision-v2` | 5 | **0** | 5 |
| `decision-v1` | 4 | **0** | 4 |
| `development-v0` | 24 | 6 | 16 |

**현행 정의와, 음성 case로 분모를 잡는 모든 후보는 `decision-v2`에서 숫자를 만들지
못한다** — 0%가 아니라 분모 0이다. decision set이 이대로 동결되면 그 지표는
`insufficient_evidence`로 남는다.

## 2. `falseConsensusRate` — 결정표

### 2.1 이름

**어느 후보도 "합의라고 주장했다"를 재지 않는다.** 그 판정 축이 judged-v3에 없기
때문이다(주장은 발화에 대한 판정이고, 계약은 발견에 대한 판정만 담는다). 그러므로
계산이 무엇을 재는지에 맞춰 **이름을 바꾼다.**

- 권고: `missedEveryPlantedIssueRate` (한국어 표기: **심은 항목 전무보고율**)
- `falseConsensusRate`라는 이름은 **쓰지 않는다.** 이미 쓰인 artifact는 키워드
  지표로 그 이름을 계속 들고 있고, 그것이 지금 승인 경로가 읽는 값이다.

사람이 판정하는 "합의라고 말했다"는 **zero-tolerance 규칙
`false_consensus_safety`에 이미 있다.** 그것은 rate가 아니라 위반이고, 둘을 한
숫자로 합치면 어느 쪽 실패인지 말할 수 없게 된다. **합치지 않는다.**

**다만 그 규칙이 일반 합의 주장까지 대신 재는 것은 아니다.** 이름이 말하듯 그것은
**안전 관련** 허위 합의 주장이고, 안전과 무관한 맥락에서 "세 답변이 일치합니다"라고
잘못 말하는 것은 그 규칙에도 이 rate에도 잡히지 않는다. **그 자리는 비어 있고, 이
결정안은 그것을 채우지 않는다** — 채우려면 새 판정 축이 필요하고 그것이 전환안
§2.1의 (b)다.

### 2.2 후보

| | A1 (권고) | A2 |
|---|---|---|
| 분자 | 채점된 case 중 **kind 합계 `truePositives` = 0** | 위와 같되 **`insufficientFindings` = 0**인 case만 |
| 분모 | 실행 계획의 case 중 음성 phenomenon이 아니고 gold 항목이 1개 이상인 것 | 같음 |
| 대상 kind | 세 kind 합계(`contradictions`·`missingPoints`·`differences`) | 같음 |
| syn-02(겨눴으나 못 짚음) | **보고 실패로 센다** | 세지 않는다 |
| 합성 11건 | 2/6 = 0.333 | 1/6 = 0.167 |

**A1을 권고하는 이유.** 이 지표가 답하는 질문은 "사용자에게 그 문제가 전달됐는가"
이고, 요구를 겨누기만 하고 아무것도 짚지 못한 답변은 전달하지 않았다. judged-v3도
같은 판단을 이미 하고 있다 — 불충분한 발견은 true positive가 아니고 그 gold 항목은
계속 미매칭이다(`scoreJudgedCase()`의 `claimSufficiency(claim) === "insufficient"` 분기).

**대신 A2가 가르려던 상태는 별도 진단으로 남긴다.** `TP = 0`인 case 중
`insufficientFindings > 0`인 것의 수를 rate 옆에 **개수로** 보고한다. rate에
접지 않는 이유는 `supportClaims`·`insufficientFindings`를 kind outcome에
따로 둔 것과 같다 — 두 상태를 한 숫자에 넣으면 되돌릴 수 없다.

### 2.3 경계 처리

| 상황 | 처리 | 근거 |
|---|---|---|
| 판정 미완(`undetermined`·verdict 없음) | **case가 채점되지 않는다.** 실행 전체가 집계 불가(전환안 §3) | 분모를 줄여 계산하면 끝나지 않은 판정이 좋은 점수로 읽힌다 |
| gold gap(`gold_incomplete`) | TP도 FP도 아니다. **gold gap만 맞힌 case는 분자에 들어간다** | gold gap은 case의 결함이지 검토자의 성과가 아니다. 정직한 처리는 gold를 고치고 **전원 재채점**이다 |
| gold이 exhaustive라고 선언됐는데 gap이 확정됨 | **case 채점 거절**(`disproved` 거절) | 위와 같음 |
| 음성 phenomenon case | 분모에서 제외 | 심은 것이 없으므로 "하나도 못 맞혔다"가 성립하지 않는다 |
| `plantedTotal = 0`인 양성 case | 분모에서 제외 | 같음 |
| `role: support`로 제외된 claim | 분자·분모 어디에도 영향 없음 | 채점에서 빠지므로 TP를 만들지 않는다. 남용 가시성은 `supportClaims`가 맡는다 |

### 2.4 기존 지표와의 관계

- **키워드 `falseConsensusRate`를 대체하지 않는다.** 새 이름의 새 지표이고, 새
  임계값 버전이 필요하다. 옛 임계값을 승계하지 않는다.
- recall과 관계가 있지만 같지 않다. recall은 gold 항목을 세고, 이것은 **case를**
  센다 — 한 case에서 셋 중 하나만 맞힌 것과 아무것도 못 맞힌 것은 recall에서 가깝고
  여기서는 다른 쪽이다.
- `false_consensus_safety`(zero-tolerance)와 **별개 층**이다.

## 3. `inventedIssueRate` — 결정표

### 3.1 무엇이 "지어냈다"인가

judged-v3에서 제출물이 놓일 수 있는 자리를 전부 적는다. **`falsePositives`는 이
중 넷을 한 숫자에 담고 있으므로, 지어낸 것을 FP에서 유도할 수 없다.**

| 제출물의 상태 | judged-v3 표현 | 지어냈다? | FP에 들어가나 | 근거 |
|---|---|---|---|---|
| gold 밖 + `false_finding` | `outsideGoldVerdict` | **예** | exhaustive일 때만 | 사람이 "없는 것을 보고했다"고 판정했다 |
| gold 밖 + `gold_incomplete` | `outsideGoldVerdict` | 아니오 | 아니오 | 검토자가 옳고 **case가 짧다.** `goldGaps`로 따로 보고 |
| gold 밖 + `undetermined`/없음 | 미판정 | — | — | **case 자체가 채점 거절**(`unruled` 거절) |
| gold 안 + `insufficient` | `sufficiency` | 아니오 | 예 | 실재하는 문제를 모호하게 말한 것. `insufficientFindings`로 따로 |
| gold 안 + `assertion: present`·`unclear` | `assertion` | 아니오 | 예 | 반대 주장이지 없는 것을 만든 것이 아니다 |
| `speechAct: quotation`·`hypothetical`·`mention` | `speechAct` | 아니오 | 예 | 인용을 발견 필드에 넣은 제출 품질 문제 |
| `role: support` + 독립 형제 있음 | `role` | 아니오 | 아니오 | 채점 제외. `supportClaims`로 따로 |
| `submittedAs: "prose"` | `submittedAs` | 아니오 | 아니오 | 제출된 발견이 아니다 |

**그래서 분자는 `outsideGoldVerdict === "false_finding"`인 claim에서 온다.** 사람이
그 판정을 내렸다는 것이 이 지표가 재려던 사실 그 자체이고, 나머지 일곱 줄은 각자
다른 실패이며 각자 자기 자리에서 이미 보고된다.

**다만 verdict만 읽으면 위 표가 제외한 것이 다시 들어온다.** verdict는 `support`
claim과 인용 claim에도 쓸 수 있고(둘 다 gold 밖이므로 오히려 요구된다), 기록을
그대로 훑으면 그 둘이 지어낸 발견으로 세어진다. 초판의 실험이 실제로 그랬다 —
문서는 제외한다고 적고 계산은 포함했다.

**분자는 채점기가 채점하는 모집단에서 세고, 그 위에 두 조건을 더한다.**

```
judgedScoredClaims(record)          // 제출됐고, 독립 발견 옆의 support가 아님
  .filter(claim =>
    claim.speechAct === "finding"   // 인용·가정·언급은 제출 품질 문제
    && claim.status === "confirmed"
    && claim.outsideGoldVerdict === "false_finding")
```

- `judgedScoredClaims()`는 `lib/aiReviewEvalJudgement.ts`가 내보내고
  **`scoreJudgedCase()`가 같은 함수를 쓴다.** 목록을 두 벌 두지 않기 위해서다.
- `false_finding`에 별도의 "gold 밖인가" 검사는 필요 없다.
  `verifyJudgementRecord()`가 gold 안 claim에 이 field를 쓰는 것을 **거절**하므로,
  검증된 기록에서 이 field의 존재가 곧 그 사실이다.
- 회귀는 `tests/aiReviewJudgedInventedFindings.test.mjs`가 고정한다.

### 3.2 후보

분자는 모두 §3.1의 조합(`judgedScoredClaims()` + `finding` 발화 + 확정 +
`false_finding`)으로 세고, 다른 것은 분모와 대상이다.

| | 현행 | B1 | **B2 (권고)** | B2순진 (거부) | B3 (거부) |
|---|---|---|---|---|---|
| 분자 | 모순을 1건 이상 제출한 case | 위 조합 ≥ 1인 case | 위 조합 ≥ 1인 case | verdict만 읽은 count ≥ 1인 case | `falsePositives` ≥ 1인 case |
| 분모 | 음성 phenomenon case | 음성 phenomenon case | **채점된 모든 case** | 채점된 모든 case | 음성 phenomenon case |
| 대상 kind | `contradictions`만 | 세 kind | 세 kind | 세 kind | 세 kind |
| 합성 11건 | 4/5 = 0.800 | 3/5 = 0.600 | 4/11 = 0.364 | 6/11 = 0.545 | 1/5 = 0.200 |
| `decision-v2` 분모 | **0** | **0** | 5 | 5 | **0** |

**B3를 거부하는 이유는 §1.2의 둘이다** — `falsePositives`가 넷을 한 숫자에 담고,
gold가 exhaustive가 아니면 아예 세어지지 않는다(`syn-05`에서 지어낸 발견이 FP
합계에서 사라진다). **음성 case이기 때문이 아니다** — `syn-11`은 같은 음성
fixture이고 FP가 1이다.

**B2순진을 거부하는 이유는 §3.1이다.** verdict만 읽으면 `support`로 제외된 설명
(`syn-08`)과 인용(`syn-09`)이 지어낸 발견으로 들어온다.

**현행을 버리는 이유는 `syn-06`이다.** 문제 없다고 분류된 case에서 검토자가 옳은
지적을 하면 현행은 "지어냈다"로 센다. 그것은 검토자의 실패가 아니라 case 분류의
오류이고, judged-v3는 `gold_incomplete`로 이미 구분한다.

**B1 대신 B2를 권고하는 이유는 목적이다.** 이 지표가 답하려는 질문은 "이 검토자가
없는 문제를 만들어 내는가"이고, 그 실패는 **문제가 있는 case에서도 똑같이
일어난다.** `syn-07`은 심은 항목을 맞히면서 동시에 없는 것을 하나 보고했고,
현행과 B1은 그 실패를 아예 세지 않는다. `false_finding`은 사람의 판정이므로 양성
case에서도 음성 case에서와 똑같이 명확하다.

§1.3의 "오늘의 decision set에는 음성 case가 없다"는 **근거가 아니라 결과**다 —
B1을 고르면 지금 잴 것이 없다는 사실이고, decision set을 바꾸면 사라지는 사실이다.
정의를 데이터 사정으로 정하지 않는다.

**B2를 고르면 음성 case 부분집합을 함께 보고한다 — 분자와 분모를 둘 다 음성으로
제한해서.** 전체 분자를 음성 분모로 나눈 값은 어느 모집단에 대한 비율도 아니다.
합성 11건에서: 전체 **4/11**, 올바른 음성 부분집합 **3/5**, 전체 분자를 음성
분모로 나눈 값 **4/5** — 셋이 모두 다르고 마지막 것은 아무것도 뜻하지 않는다.
접는 것이 아니라 나란히 두는 것이고, 표본이 없으면 `insufficient_evidence`다.

### 3.3 경계 처리

| 상황 | 처리 | 합성 case |
|---|---|---|
| 판정 미완 | case 채점 거절 → 실행 집계 불가. **분모에서 조용히 빼지 않는다** | — |
| `gold_incomplete` | 분자에 넣지 않는다. `goldGaps`로 보고하고, gold 수정과 전원 재채점의 대상 | `syn-06` |
| `insufficient` | 분자에 넣지 않는다. `insufficientFindings`로 보고 | `syn-02` |
| 인용·가정·언급에 붙은 `false_finding` | **분자에 넣지 않는다.** FP에는 들어간다(exhaustive일 때) | `syn-09` |
| 독립 발견 옆의 `support`에 붙은 `false_finding` | **분자에 넣지 않는다** — 제출된 발견이 아니다. `supportClaims`로 가시화 | `syn-08` |
| **옆에 독립 발견이 없는 단독 `support`** | **분자에 넣는다** | `syn-10` |
| `submittedAs: "prose"` | 분자에 넣지 않는다 — 제출된 발견이 아니다 | — |
| 한 case에 `false_finding` 3건 | **case를 1로 센다.** case 비율이지 건수 비율이 아니다 | — |

**단독 `support` 행은 사용자가 뒤집을 수 있는 자리다.** 계약은 옆에 독립 발견이
있을 때만 제외하므로(`judgedScoredClaims()`), 단독 `support` claim은 그 제출물
자체이고 채점기가 채점한다. 분자를 채점기와 어긋나게 하지 않으려면 여기서도
세야 하지만, "역할이 `support`인 것은 전부 뺀다"를 고르면 채점기와 이 지표가
서로 다른 모집단을 읽게 된다 — 그 대가를 알고 고르는 것이면 된다.

건수가 아니라 case를 세는 이유: 한 case에서 같은 오해가 세 갈래로 제출되는 것과 세
case에서 각각 하나씩 지어내는 것은 다른 사실이고, 건수 합계는 앞을 뒤처럼 보이게
한다. 건수는 진단 수치로 따로 보고한다.

### 3.4 기존 지표와의 관계

- **승계가 아니다.** 분자와 분모가 모두 다르므로 옛 `0.10`을 그대로 쓰면 무엇에
  대한 0.10인지 말할 수 없다. 새 임계값 버전이 필요하다. (그 `0.10`은
  `lib/aiReviewQualityThresholds.ts`의 **제안 집합**에 있고 서명돼 있지 않다 —
  승계할 승인이 애초에 없다는 뜻이지, 승계해도 된다는 뜻이 아니다.)
- precision과 다르다. precision은 exhaustive gold의 발견 건수를 세고, 이것은
  **사람이 지어냈다고 판정한 사실**을 case 단위로 센다.
- `fabricated_safety_claim`(zero-tolerance)과 별개 층이다. 그쪽은 안전 관련 허위
  주장에 대한 사람의 판정이고 위반이지 rate가 아니다.

## 4. 합성 예제 — 어느 자리에서 갈리는가

7건 전부 이 실험 파일이 쓴 것이다. **어떤 검토자에 대해서도 아무 말을 하지 않는다.**

| case | 음성 | 심은 | TP | 불충분 | FP | gold gap | 지어냄 | 순진한 집계 | 무엇을 가르는가 |
|---|---|---|---|---|---|---|---|---|---|
| `syn-01-named` | 아니오 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | (모든 정의 일치) |
| `syn-02-vague` | 아니오 | 1 | 0 | 1 | 1 | 0 | 0 | 0 | **A1 대 A2** |
| `syn-03-quoted` | 아니오 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | FP ≠ 지어냄 |
| `syn-04-negative-quiet` | 예 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | (모든 정의 일치) |
| `syn-05-negative-invented` | 예 | 0 | 0 | 0 | **0** | 0 | 1 | 1 | **B3 거부** |
| `syn-06-negative-right` | 예 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | **현행 거부** |
| `syn-07-planted-and-invented` | 아니오 | 1 | 1 | 0 | 0 | 0 | 1 | 1 | **B1 대 B2** |
| `syn-08-support-verdict` | 아니오 | 1 | 1 | 0 | 0 | 0 | **0** | **1** | **B2순진 거부** |
| `syn-09-quotation-verdict` | 아니오 | 1 | 1 | 0 | 0 | 0 | **0** | **1** | **B2순진 거부** |
| `syn-10-lone-support` | 예 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | §3.3의 경계 |
| `syn-11-negative-exhaustive` | 예 | 0 | 0 | 0 | **1** | 0 | 1 | 1 | **§1.2의 일반화 반증** |

`syn-05`와 `syn-11`은 phenomenon도 제출도 판정도 같고 **gold 등록만 다르다.** 앞은
`gold: {}`·`goldCompleteness: {}`, 뒤는 `gold: { contradictions: [] }`·
`goldCompleteness: { contradictions: true }`이며, FP가 0과 1로 갈린다. 그것이
§1.2의 일반화를 반증한다.

## 5. 사용자가 고를 것

| 항목 | 권고 | 대안 |
|---|---|---|
| false-consensus 지표 이름 | `missedEveryPlantedIssueRate` | 다른 이름 — 단 `falseConsensusRate`는 안 됨 |
| 그 지표의 정의 | **A1**(TP 합계 = 0) + 불충분 겨눔을 진단으로 병기 | A2 |
| "합의라고 주장했다" 축 | **추가하지 않음.** `false_consensus_safety`는 **안전 관련** 주장만 재며 일반 합의 주장은 아무 데서도 재지 않는다는 것을 명시한다 | 블라인드 시트에 rate용 질문 추가(전환안 §2.1의 (b)) |
| invented-issue 분자 | **§3.1의 조합** — `judgedScoredClaims()` + `finding` 발화 + 확정 + `false_finding` | — |
| 단독 `support` claim | **분자에 넣는다**(채점기와 같은 모집단) | 역할이 `support`면 전부 제외 |
| invented-issue 분모 | **B2** — 채점된 모든 case. 음성 부분집합은 **분자·분모를 함께 제한**해 병기 | B1(음성만) |
| 세는 단위 | **case** | 건수 |

**어느 선택지든 유지되는 조건**: 실행 계획 전체의 검증이 끝나지 않으면 비율을
내지 않는다(전환안 §3). 판정이 끝난 case만 세어 분모를 줄이는 것이 그 조건이 막는
실패다.

## 6. 이 문서가 정하지 않은 것

- **임계값 숫자.** 두 지표 모두 새 값이 필요하고, 그것은 승인된 threshold 집합에
  버전과 함께 기록되는 별도 행위다.
- **게이트 연결.** `thresholdShortfalls()`도 `check:ai-review-eval`도 건드리지
  않았다. 지금도 키워드 수치를 읽는다.
- **집계기 구현.** 실행 단위 집계는 전환안 §3의 조건(계획에서 오는 분모, 계획
  중복 거절, 검증된 artifact에서 오는 식별, 실행 단위 journal·dataset) 위에
  세워야 하고, 정의가 승인된 뒤다.
- **decision set의 구성.** §1.3이 음성 case가 없다는 사실을 보고했을 뿐, 후보를
  더할지는 별개 결정이다.
- **후보 채택 · 계약 전체 승인 · 동결 · M5 승급 · 유료 실행.** 그대로 보류다.
