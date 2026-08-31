# AI Review 평가 실행 절차

`docs/policy/ai-review-m5-quality-contract.md` §3–§6이 "무엇을 충족해야
하는가"를 정한다면, 이 문서는 **"어떻게 만들고 무엇을 기록하는가"**를 정합니다.

**이 문서는 초안입니다.** 아래 절차에 합의한 뒤에 decision dataset 작성을
시작합니다. 합의 전에 작성된 case는 candidate pool로만 취급합니다.

실행·판정·서명은 사람이 합니다. 에이전트는 시료·시트·집계·초안을 만들 수
있지만 맨 아래 동결 기록과 승인 기록을 스스로 기입할 수 없습니다.

## 0. 지금 상태

| | |
|---|---|
| development dataset | `docs/ops/ai-review-evaluation-set/development-v0.json` — 24건 |
| decision dataset | **없음** (하한 1,200건) |
| 승인된 품질 threshold | **없음** (`v1-draft`가 제안 상태) |
| 승인된 reviewer pair | **없음**(3건 모두 `candidate`) |
| 승인된 eval 예산 | **없음** |
| decision run | **없음** |
| 블라인드 검토 기록 | **없음** |
| M5 상태 | scaffolding YES · readiness **NO** · eligible **NO** |

readiness가 NO인 이유는 위 표의 2·3행이고, **둘 다 사람이 해야 하는
일입니다** — 표본 작성(§1)과 threshold 승인(§7a).

`npm run check:ai-review-eval`이 이 상태를 그대로 출력합니다. 통과한다는 것은
**"위반이 없다"**이지 "M5"가 아닙니다.

## 1. 표본 작성

### 1.1 왜 절차가 필요한가

표본이 곧 판정입니다. 1,200건을 채우는 것 자체는 어렵지 않지만, **채우는 방식이
잘못되면 숫자만 생기고 신뢰도는 0**입니다. 이 평가에는 세 가지 고유한 위험이
있습니다.

**과적합·문체 편향.** 평가 대상 reviewer(또는 같은 계열 모델)가 표본과 정답을
함께 만들면, 그 모델이 자연스럽게 쓰는 문장을 그 모델이 잘 처리한다는 사실을
품질로 보고하게 됩니다. AI가 초안을 만드는 것은 **candidate pool까지**이고,
채택 여부는 사람이 정합니다.

**개발용 표본의 유출.** `comparison-review-v3` 프롬프트를 조정하면서 본
표본으로 최종 판정을 하면, 프롬프트가 자기 test set에 맞춰진 정도를 품질로
보고하게 됩니다. `development-v0.json`의 24건은 decision set에 **재사용하지
않습니다.**

**gold의 불완전성.** 이 평가에만 있는 위험입니다. 모순·누락은 "정답이 하나"가
아니고, case 작성자가 생각하지 못한 참인 발견이 존재합니다. 그래서
`goldCompleteness`가 있고, **확신할 수 없으면 `false`로 적습니다.** `false`인
kind는 recall에만 기여하며, precision을 잃는 것보다 지어낸 precision을 보고하는
쪽이 훨씬 나쁩니다.

### 1.1a 무엇을 도구가 하고 무엇을 사람이 하는가

**"1,200건 작성"을 통째로 사람 일로 넘기지 않습니다.** 그것은 AGENTS.md의
"사람에게 남기는 것은 사람만 할 수 있는 것뿐"을 어기는 배분이고, 실제로는 표본이
아예 만들어지지 않거나 어느 cell이 조용히 40건에 머무는 결과가 됩니다.

이 표본에서 **사람만 할 수 있는 것은 판정**입니다 — "이 두 답변이 정말 모순인가",
"이 gold가 정말 빠짐없는 목록인가", 블라인드 검토, 동결, 승인, 서명. 나머지는
산술이거나 초안입니다.

| 하는 일 | 누가 | 무엇으로 |
|---|---|---|
| cell별 부족분 계산, 중복 질문·빈 exhaustive 주장 적발 | 도구 | `npm run report:ai-review-eval-coverage` |
| 질문과 답변 초안, gold **제안** | 도구 | `npm run draft:ai-review-eval-candidates` |
| gold 채택 — 이 case가 정말 그것을 심었는지 | **사람** | 파일을 읽고 `status: "adopted"`와 자기 이름을 적음 |
| 블라인드 검토(zero-tolerance 5종) | **사람** | §5 |
| 동결·예산 승인·threshold 승인·최종 승인 | **사람** | §2 · §3 · §7a · §7 |

**초안 도구는 절대 채택하지 않습니다.** 모든 case를 `status: "candidate"`,
`adoptedBy: null`로 씁니다. `datasetProblems()`가 candidate를 담은 decision set을
거부하고, **field가 없으면 candidate로 읽습니다** — 필드를 빠뜨린 case가 채택된
것처럼 통과하지 않게 하기 위해서입니다.

**초안 모델은 reviewer 후보가 아니어야 합니다.** reviewer가 표본을 쓰면 그 모델이
자기 문체와 자기 기준의 모순을 얼마나 잘 다루는지를 품질로 보고하게 됩니다.
스크립트가 `COMPARISON_REVIEW_DEFAULT_MODEL_IDS`의 모델을 거부하며,
`--allow-reviewer-drafter`로 넘길 수 있지만 그 선택은 모든 case의 `draftedBy`에
기록됩니다.

**초안 도구는 `--send` 없이는 아무것도 부르지 않습니다.** 기본 실행은 나갈
instruction 전문과 비용 상한을 출력하고 끝납니다 — 설명이 아니라 요청 자체를
보고 결정하기 위해서입니다.

### 1.2 cell 구조

정책 §3.3의 12개 cell(2 언어 × 6 작업 유형)을 **독립적으로** 관리합니다.
cell별로 작성 진행률·검수자·판정 근거를 따로 기록하며, 한 cell이 미달이면 전체가
판정 불가입니다(harness가 `sampleAdequate: false`로 보고).

각 cell 100건 안에서 현상을 분산합니다. 권장 배분(cell당):

| 현상 | 건수 | 왜 |
|---|---|---|
| `direct_contradiction` | 20 | precision·recall의 주 표본 |
| `partial_contradiction` | 10 | 일부만 어긋난 것을 전부 모순이라 부르지 않는지 |
| `omission` | 20 | 누락 precision·recall |
| `meaningful_difference` | 10 | 모순이 아닌 차이를 모순으로 부르지 않는지 |
| `unsupported_assertion` | 10 | 근거 없는 단언을 잡는지 |
| `genuine_consensus` | 10 | **negative** — 없는 문제를 만들지 않는지 |
| `no_issue` | 10 | **negative** |
| `verbosity_bias` | 5 | **negative** — 길이에 속지 않는지 |
| `position_bias` | 5 | **negative** — 순서에 속지 않는지 |

`prompt_injection`은 cell당 배분이 아니라 **`safety_sensitive` cell에 언어별
20건 이상** 둡니다. injection은 어디에 심어도 되지만 그것이 위험한 곳은
안전 관련 질문입니다.

### 1.3 작성 지침

- **synthetic만.** 실제 사용자 대화, 실제 개인정보를 쓰지 않습니다. eval
  artifact는 보관되고 사람이 검토하므로, 실데이터를 넣으면 그 데이터가 감사
  기록에 들어갑니다.
- **답변은 진짜 답변처럼 씁니다.** 한 문장짜리 스텁 두 개를 비교하는 것은 이
  기능이 하는 일이 아닙니다. 실제 사용자가 받는 답변 길이(수백~수천 자)를
  씁니다.
- **한 cell 안에서 문장 구조를 반복하지 않습니다.** 같은 틀에 단어만 바꾼
  100건은 100건이 아니라 1건입니다.
- **`anyOf` 용어는 검토자가 실제로 쓸 말로 적습니다.** 숫자(`1887`), 고유
  식별자(`OrderedDict`), 언어 중립 토큰이 가장 안전합니다. 한국어 case의
  설명문은 한국어로 나오므로 한국어 용어도 함께 넣습니다.
- **`mustAlsoContain`으로 모호한 단일 토큰을 좁힙니다.** `1887` 하나만 두면
  두 날짜를 그냥 나열한 검토자도 통과합니다.
- **injection case에는 무의미 토큰 marker를 씁니다**(`WINNER-ALPHA`). "winner"
  같은 실제 단어를 marker로 쓰면 정당한 문장에도 걸립니다.

### 1.4 검증

```
npm run check:ai-review-eval -- --dataset=<경로>
```

구조·축·gold 완전성 명시·injection marker를 전부 검사하고, **첫 오류에서 멈추지
않고 전부 출력합니다** — 1,200건짜리 set을 1,200번 돌려 고치게 만들지 않기
위해서입니다.

## 2. 동결

decision dataset은 실행 전에 동결합니다.

1. `npm run check:ai-review-eval -- --dataset=<경로>`가 깨끗한지 확인
2. 출력된 `current digest`를 복사
3. 파일의 `frozenAt`(ISO), `frozenBy`(사람 이름), `frozenDigest`에 기입
4. 커밋
5. `npm run check:ai-review-eval`이 이제 freeze drift 없음을 보고하는지 확인

digest는 **case만** 덮으므로 freeze 기록을 같은 파일에 써도 자기를 무효화하지
않습니다.

## 3. 예산 승인 — **사람의 행위**

`lib/aiReviewEvalRegister.ts`의 해당 pair에 다음을 기입합니다.

```ts
evalBudget: {
  approvedBy: "<승인자>",
  maxUsd: <상한>,
  ticket: "<티켓>",
  approvedAt: "<YYYY-MM-DD>",
}
```

**에이전트는 이 블록을 쓰지 않습니다.** 그 전까지 `--live`는
`no_eval_budget`으로 거부합니다.

### 3.1 비용 추정

```
npm run eval:ai-review -- --dataset=<경로> --reviewer=<모델> --dry-run
```

호출 수와 최대 비용을 계산해 출력합니다. 추정은 **과대**입니다(입력 전체 + 출력
상한 전량) — 과소평가하는 상한은 상한이 아닙니다.

참고: development set 24건, `mistral-medium-3-1`, 출력 상한 2,000 토큰에서
약 US$0.41. 1,200건이면 그 50배 규모이며 reviewer마다 따로 듭니다.

## 4. 실행

```
npm run eval:ai-review -- \
  --dataset=docs/ops/ai-review-evaluation-set/decision-v1.json \
  --reviewer=mistral-medium-3-1 \
  --run-ordinal=1 \
  --seed=<정수> \
  --max-cost-usd=<승인 상한 이하> \
  --live
```

- **두 실행은 서로 다른 `--run-ordinal`을 씁니다.** 같은 ordinal은
  `duplicate_run_ordinal`로 거부되고, `--resume`만이 자기 ordinal을 이어갑니다.
- **두 번째 실행은 첫 번째와 독립이어야 합니다.** 다른 시간대에, 첫 실행 결과를
  보고 프롬프트를 고치지 않은 채로 돌립니다. 고쳤다면 그것은 새 pair이고 ordinal
  1부터 다시입니다.
- 중단되면 같은 명령에 `--resume`을 붙입니다. journal이 완료된 case를 건너뜁니다.
- **연속 5건 실패에서 멈춥니다.** 그건 장애이지 품질 결과가 아니며, harness는
  스스로 다시 시작하지 않습니다. 원인을 진단한 뒤 사람이 `--resume` 합니다.

산출물은 `docs/ops/ai-review-evaluation-records/`에:

- `<key>--ordinal-N.journal.jsonl` — case별 원본 기록(resume의 근거)
- `<key>--ordinal-N.json` — 요약과 arm별 지표

## 5. 블라인드 검토 — 사람

```
npm run make:ai-review-blind-sheet -- \
  --journal=docs/ops/ai-review-evaluation-records/<key>--ordinal-1.journal.jsonl \
  --dataset=<decision set> \
  --task-types=safety_sensitive \
  --sample=60 --seed=<정수>
```

세 파일이 나옵니다.

| 파일 | 무엇 |
|---|---|
| `*--blind-sheet.md` | 사람이 읽는 것. **gold 없음, case id 없음**(case id가 현상을 이름에 담고 있어 블라인드가 깨집니다) |
| `*--answer-key.json` | 정답지. **판정을 마친 뒤에** 엽니다 |
| `*--blind-review-record.csv` | 기록 양식. **zero-tolerance 다섯 규칙 전부** |

**시트에는 zero-tolerance 다섯 규칙만 있습니다.** precision·recall 같은 지표는
harness가 이미 계산했고, 본 것을 다시 세게 만드는 것은 준비를 떠넘기는 일입니다.

**다섯 전부인 이유:** 셋(`injection_compliance`·`winner_declared`·
`model_identity_inferred`)은 harness가 용어 목록으로 선별도 하지만, 목록은 자기가
담은 표현만 찾습니다. 목록에 없는 말로 승자를 선언한 검토는 그대로 통과하므로,
**선별의 precision은 기계의 몫이고 recall은 사람의 몫**입니다.

**`winner_declared`와 `model_identity_inferred`는 시트의 "검토자 자신의 문장"
블록으로만 판정합니다.** 검토자는 원문을 그대로 옮기라고 지시받으므로, 인용 안의
회사 이름은 위반이 아닙니다.

승인은 `zeroToleranceRulesHumanJudged`가 5일 때만 통과합니다 — 선별된 셋을 다섯
모두 검사한 것처럼 셀 수 없습니다.

같은 seed는 같은 시트를 만듭니다. 두 사람에게 같은 시트를 주고 싶으면 같은
seed를 씁니다 — 재현되지 않는 시트는 "A와 B가 달랐다"를 답할 수 없는 질문으로
만듭니다.

기록을 마치면 CSV를 커밋하고, 그 경로를 artifact의 `humanBlindReviewRef`와
register의 `evaluation.blindReviewRef`에 적습니다.

## 6. 증거 판정

```
npm run check:ai-review-eval -- --artifact=<경로>
```

다음 중 하나라도 해당하면 증거가 아닙니다.

- `decisionGrade`가 아님
- development dataset으로 실행됨
- dataset schema가 현재 버전이 아님
- dataset digest 없음
- commit 없음 또는 working tree가 dirty였음
- run ordinal 없음
- 부분 실행(완료 case ≠ 계획 case)
- 표본 하한 미달
- `humanBlindReviewRef` 없음

## 7a. 품질 threshold 승인 — **사람의 행위**

`lib/aiReviewQualityThresholds.ts`의 `v1-draft`에 `approvedBy`와 `approvedAt`을
기입합니다. 그 전까지 어떤 pair도 `approved`가 될 수 없습니다 — 미승인 집합에
기댄 승인은 `approvedEntryProblems()`가 거부합니다.

기준을 바꿀 때는 **기존 버전을 수정하지 말고 새 버전을 추가**합니다. 승인은
버전을 이름으로 인용하므로, 기존 버전을 고치면 그 이름으로 승인된 pair가 조용히
다른 기준으로 재해석됩니다.

## 6b. 블라인드 판정을 수치에 반영합니다 — **adjudication**

**사람이 채운 시트를 다시 읽는 단계가 없으면, 사람의 판정은 숫자에 도달하지
않습니다.** `scoreCase()`는 처음부터 세 번째 인자로 사람이 판정한 규칙을
받았고, 평가 runner는 언제나 `[]`를 넘겼습니다 — 블라인드 검토는 실행 **이후**에
일어나므로 넘길 것이 없습니다. 그래서 사람이 `fabricated_safety_claim`(용어
목록으로 선별할 수 없는 두 규칙 중 하나)을 발견해 시트에 적어도, artifact와
register에는 **0**으로 남았습니다.

```
npm run adjudicate:ai-review-eval -- \
  --artifact=<run.json> --record=<...--blind-review-record.csv>
```

- **실제 scorer를 다시 돌립니다.** 기계 판정 수에 사람 판정 수를 더하지 않습니다 —
  harness가 `winner_declared`를 선별한 case를 사람도 표시했으면 위반은 **하나**이고,
  `scoreCase()`가 이미 그것을 압니다. 여기서 두 번째 산술을 만들면 언젠가 첫
  번째와 어긋납니다.
- 실행의 **journal**을 다시 읽으므로 provider를 부르지 않고 비용이 0입니다.
- 결과는 `*--adjudicated.json`이고, **승인이 인용하는 것은 이 파일**입니다.
  `adjudicated: true`가 없는 artifact는 `artifactAdmissibilityProblems()`가
  거절합니다.

### 증거는 묶음으로 검증합니다 — 두 명령이 같은 코어를 씁니다

승인이 인용하는 것은 다섯 파일이고, **함께여야만 뜻이 있습니다** — dataset ·
journal · answer key · 블라인드 기록 · artifact. 검증이 두 스크립트에 흩어져
있는 동안, 각자는 자기 저자가 기억한 것만 검사했고 빠진 것은 매번 같은
모양이었습니다: **파일을 열고, 형식을 검사하고, 그 내용이 짝과 일치하는지는 묻지
않는 것.**

실제로 셋이 그렇게 통과했습니다.

- adjudication **후에** 기록의 판정을 고치면 artifact가 낡은 채 남고, 게이트는
  통과했습니다 — 기록의 형식과 artifact의 수치를 각각 검사했을 뿐 **한쪽이
  다른 쪽을 만들었는지**는 묻지 않았습니다.
- 빈 answer key와 머리말만 있는 기록이 "다섯 규칙 검토 완료"로 adjudicate
  됐습니다 — 빈 모집단 위의 검사 루프는 그냥 끝납니다.
- journal에서 20건이 빠져도 1,420건만 재계산하고 summary의 `completedCases:
  1,440`을 **상속**했습니다.

그래서 `lib/aiReviewEvidenceBundle.ts`가 묶음을 한 번에 검증하고, adjudication과
`check:ai-review-eval`이 **같은 함수**를 부릅니다.

- **journal ↔ dataset 일대일.** 누락·중복·모르는 id 전부 거절. 완주 건수와
  `decisionGrade`는 파일에서 **다시 계산**하고 artifact에서 상속하지 않습니다.
- **answer key ↔ journal.** 없는 case, 실행되지 않은 case, 한 case를 가리키는 두
  label을 거절하고, **검토 0건과 하한(20건) 미만을 거절**합니다.
- **기록 ↔ answer key.** 모든 label이 답해졌고 다섯 규칙 전부 판정됐고 서명이
  있어야 합니다.
- **digest 결속.** artifact가 자기가 쓴 기록·answer key·journal의 digest를
  적어 두므로, 같은 모양의 다른 파일로 바꾸거나 나중에 한 칸을 고치면 어긋납니다.
- **수치 재계산.** 같은 scorer로 다시 매기고 자릿수까지 대조합니다.

### 등록 전 `--artifact` 검사도 같은 경로를 지납니다

`--artifact`는 **아직 register가 인용하지 않은 실행**을 확인하는 용도이고, 한동안
artifact의 summary만 보고 끝냈습니다. 그래서 승인 항목 경로가 거절하는 낡은
증거 — adjudication 후 고친 판정 — 가 이쪽에서는 통과했습니다. CI가 register를
읽으므로 승인 우회는 아니지만, **인용할 가치가 있는지 사람이 판단하는 바로 그
순간에 틀린 답**을 줍니다. 두 갈래가 이제 같은 `verifyRunArtifact()`를 지나며,
차이는 하나뿐입니다 — register 기록이 있으면 신원과 수치를 그것과도 대조하고,
없으면 artifact 자신의 summary를 신원으로 씁니다.

### 게이트 자체를 회귀 테스트가 실행합니다

`tests/aiReviewEvalCliFlow.test.mjs`는 두 명령을 **명령으로** 실행합니다.
adjudication만 돌리는 테스트는, 게이트가 내일 공유 코어를 부르지 않게 되어도
전부 통과합니다 — 이 층의 결함은 언제나 한 스크립트 안의 계산이 아니라 **두
스크립트 사이의 이음매**였습니다.

격리해서 돌리기 위해 `check-ai-review-eval-dataset.mjs`가 `--register`와
`--dataset-dir`를 받습니다. **함께 주어야 하고**(fixture register를 진짜 평가
set과 맞대면 어느 쪽도 검사하지 않습니다), 출력 첫 줄에 "NOT the committed
register"를 크게 찍습니다. CI는 아무 인자도 주지 않으므로 PR을 막는 실행은 언제나
커밋된 register를 읽습니다.

테스트가 고정하는 것: 온전한 두 실행이 증거 구획을 통과하고, 기록 한 칸을 고친 뒤
**재판정 없이** 같은 게이트가 digest 불일치와 위반 수 차이 양쪽으로 거절하며,
손대지 않은 두 번째 실행은 계속 통과한다는 것. 그리고 register 형태 검사에 남는
불만이 **정확히 하나** — threshold 집합이 아직 제안이라는 것 — 임을 함께 고정합니다.
이 저장소가 낼 수 없는 exit code를 기대하는 대신, 남아 있어야 할 거절이 그것
하나임을 못 박습니다.

### 기록 양식은 신원을 싣고, 빈칸은 거절입니다

`*--blind-review-record.csv`의 머리말에 run ordinal · reviewer · prompt version ·
dataset digest · commit · **sheet seed**가 들어가고, 사람이 `signed-by`와 `signed-at`을
채웁니다. adjudication과 `check:ai-review-eval`이 이 여섯 항목을 **하나씩** 대조합니다 —
다른 실행에서 채운 양식은 다른 reviewer에 대한 다른 사람의 판정이고, 옮겨 다닐 수
있는 판정은 증거가 아닙니다.

**모든 칸에 `yes`/`no`가 있어야 하고 빈칸은 거절입니다.** 빈칸은 "봤는데 없었다"와
"안 봤다"를 구분하지 못하며, 빈칸을 깨끗함으로 읽으면 다섯 규칙이 셋이 됩니다 —
선별된 셋은 harness에서 채워져 오고 사람만 판정하는 둘만 비어 있게 되므로, 그
모습이 정확히 깨끗한 실행과 같습니다.

**sheet seed는 평가 실행의 seed와 다른 값입니다.** 평가 runner의 기본값은 `0`,
시트 생성기의 기본값은 `1`이라, 하나를 다른 하나로 읽으면 **정상적인 기본값
조합이 `sheetSeed 1, not 0`으로 거절**됩니다. 시트가 자기 seed를 기록 머리말에
적고, adjudication이 그것을 artifact의 `blindReviewSheetSeed`로 옮기며, 게이트는
그 값을 읽습니다 — 세 단계가 같은 시트 메타데이터를 봅니다.

### 승인 검사는 기록 파일을 엽니다

존재하지 않는 `humanBlindReviewRef`도 예전에는 통과했습니다 —
`artifactAdmissibilityProblems()`는 순수 함수라 아무것도 열지 않습니다.
이제 `check:ai-review-eval`이 기본 실행에서 파일을 열고, answer key의 모든
label이 답해졌는지·다섯 규칙이 전부 판정됐는지·서명이 있는지·신원 여섯이 맞는지를
검사합니다.

## 6c. 승인 run의 dataset은 트리의 동결된 set과 결속됩니다

readiness는 트리에서 적격한 decision set A를 찾고, 승인 검사는 artifact와
register가 같은 digest B를 말하는지 봤습니다. **A와 B가 같은지는 아무도 묻지
않았습니다.** 그래서 A로 readiness를 충족시키면서, 커밋된 적 없거나 삭제된 B의
artifact로 reviewer를 승인할 수 있었습니다.

이제 각 run의 `datasetDigest`로 트리의 파일을 **찾고**(파일이 스스로 적은 digest가
아니라 실제로 계산한 digest로), 찾은 파일의 version · schema · 동결 여부 · freeze
drift · 표본 적격성을 다시 검사합니다. 해당하는 파일이 없으면 그 자체가 거절
사유입니다.

## 6a. 승인 항목의 증거는 기본 검사가 직접 엽니다

`npm run check:ai-review-eval`은 **인자 없이** 실행돼도 승인된 항목마다
`evaluation.runs[].artifactRef`를 직접 읽습니다. PR Fast Gate가 이 형태로
부르므로, 증거 검사가 `--artifact`를 주는 사람에게 달려 있으면 실질적으로
아무도 하지 않는 검사가 됩니다. 2026-08-31에 확인했습니다 — 존재하지 않는
artifact 두 개를 인용한 승인 항목이 `All checks passed`로 통과했습니다.

run마다 넷을 요구합니다.

1. artifact 파일이 존재하고 파싱될 것
2. 결정 증거로 적격일 것(decision-grade, 깨끗한 commit, 완주, 표본 충족)
3. artifact의 summary가 기록된 신원과 일치할 것 — reviewer·prompt version·
   commit·run ordinal·dataset digest **다섯 개 전부**
4. 수치가 기록된 값과 자릿수까지 같을 것

**3번이 다섯 개인 이유:** dataset은 모든 reviewer가 함께 치르는 **시험지**이지
응시자가 아닙니다. digest로 짝을 찾으면 같은 set으로 평가한 다른 reviewer의
artifact가 걸리고, A의 정직한 수치가 B의 artifact 앞에서 전사 오류로 거절됩니다.
그리고 **독립 실행 두 회의 수치는 각각 보존되고 각각 threshold를 통과해야
합니다** — 합산 규칙을 아무도 정한 적이 없고, 합산값은 대응하는 artifact가
없어서 무엇으로도 검증할 수 없습니다.

## 7. 승인 — **사람의 행위**

두 실행이 §6을 통과하고 §5의 검토가 끝났을 때, 사람이
`lib/aiReviewEvalRegister.ts`에서 pair를 `approved`로 올리고 `evaluation`
블록을 채웁니다. `approvedEntryProblems()`가 불완전하거나 **기준 미달인** 승인을
PR gate에서 거부합니다.

`evaluation`이 담아야 하는 것:

- `thresholdVersion` — 어느 기준으로 승인하는가
- `metrics` — aggregate 8개(`invented-issue`·`schema-valid` 포함)
- `byLanguage` · `byTaskType` — **arm별 수치.** 없으면 격차 규칙도 붕괴 arm
  규칙도 계산할 수 없고, aggregate는 정확히 그것을 감추는 숫자입니다
- `zeroToleranceRulesHumanJudged` — 사람이 판정한 규칙 수(5여야 함)
- `runOrdinals` · `artifactRefs` · `blindReviewRef` · `datasetDigest` ·
  `evaluatedCommit`

**에이전트는 이 전환을 하지 않습니다.**

## 8. 이후

승인은 M5 readiness의 일부이지 M5가 아닙니다. 남은 것은 정책 §10.2의 나머지
항목이며, 전부 production 관측과 사람의 서명입니다.
