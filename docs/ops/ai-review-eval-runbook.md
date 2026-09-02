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

### 1.1b 유료 초안 작성은 총액으로 막습니다

`draft:ai-review-eval-candidates`는 **한 번에 batch 하나**를 보내고, 세트를 채우려면
**330번** 부릅니다. 화면에 찍히는 호출당 상한은 그 loop를 막지 못합니다 — 밤새
돌리는 사람은 330번치를 한 번에 하나씩 승인한 셈이 됩니다.

**330은 1,240 ÷ batch 10이 아닙니다.** batch 하나는 (cell, 현상, mode) 하나에만
속하므로, 한 현상의 건수가 mode 셋으로 갈리면 batch도 함께 갈립니다 — 20건짜리
현상이 7 + 7 + 6으로 나뉘면 두 번이 아니라 세 번입니다. 그래서 일반 cell은 100건에
**27번**, safety cell은 120건에 **30번**이고, 합이 (27 × 10) + (30 × 2) = 330입니다.
`report:ai-review-drafting-plan`이 cell마다 이 숫자를 찍으므로 손으로 나누지
않습니다.

- `--send`에는 **`--max-total-cost-usd=<총액>`이 필수**입니다.
- 총액은 세트 옆의 `*.spend.jsonl` ledger로 **실행 사이에도 유지**됩니다.
- **예약이 먼저이고 호출이 나중입니다**(`lib/aiReviewDraftLedger.ts`). 순서는
  ① `*.spend.jsonl.lock`을 배타적으로 잡고 ② 잠금 **안에서** 잔액을 다시 읽어
  ③ 이번 호출의 상한을 `reserve`로 **먼저 적고** ④ 잠금을 풀고 ⑤ 그 다음에야
  provider를 부르고 ⑥ 성공이든 실패든 `settle`을 적습니다. 결제 크레딧의 예약
  방식(docs/policy/credit-and-cost-limits.md §9)과 같은 모양입니다.
- **미정산 예약은 계속 예산을 차지하고, 다음 호출을 아예 막습니다.** 응답 뒤에
  프로세스가 죽으면 `settle` 없는 `reserve`가 남고, 다음 실행은 그것을 쓴 돈으로
  세는 데 그치지 않고 **거절**합니다. 예산에 여유가 있는지는 두 번째 질문이고,
  첫 번째 질문은 다른 실행이 아직 돌고 있는가입니다.
- **초안 작업 전체가 직렬화됩니다.** 잠금은 ledger를 읽는 동안이 아니라
  reserve → 호출 → 세트 기록 → settle 전 구간에서 유지됩니다. 공유되는 것은
  ledger만이 아니었습니다 — 두 프로세스가 같은 decision set을 읽어 각자
  메모리의 사본에 case를 덧붙이고 파일 전체를 다시 쓰므로, 나중에 끝난 쪽이
  앞의 후보를 지웁니다. 예산이 두 호출을 허용하면 두 번 결제하고 한 번만
  남습니다. 이 도구는 batch를 330번 순차로 보내는 것이므로 지킬 처리량이
  없습니다.
- **ledger의 금액은 "committed ceiling"이지 실제 사용액이 아닙니다.** 정산은
  provider가 실제로 청구한 금액이 아니라 **예약 상한 전액**을 기록합니다 — 이
  도구는 실제 청구액을 알지 못합니다. 화면 문구도 `committed ceiling`이라고
  적습니다.
- ledger 줄 하나라도 읽을 수 없으면 **멈춥니다.** 예약 없는 정산, 중복 예약,
  두 번 정산, 예약보다 큰 정산도 같습니다 — 아무도 계산할 수 없는 총액에
  더할 수는 없습니다.
- 가격 profile이 없는 모델은 거절합니다 — 모르는 가격으로 강제되는 예산은 예산이
  아닙니다.

**계획 단계의 숫자는 상한이되, 요청이 커진다는 것을 반영해야 상한입니다.** 각
호출은 자기 cell에 이미 쓰인 질문을 함께 봅니다. 실제 instruction으로 재면 빈
cell에서 약 666 토큰, cell이 다 차 갈 무렵이면 약 7,080 토큰입니다. 첫 요청 길이로
330번을 곱하면 뒤쪽 호출을 여러 배 과소평가하고, **상한이 아닌 것을 상한이라
부르는 것이 숫자가 없는 것보다 나쁩니다** — 사람이 그것으로 예산을 승인하기
때문입니다. `report:ai-review-drafting-plan`은 batch마다 instruction을 실제로 만들어
합산합니다.

**두 숫자의 성격이 다릅니다.** 호출 직전에 `--max-total-cost-usd`와 대조하는
호출당 상한은 **그 호출에 실제로 나갈 instruction**으로 계산하므로 정확한
경계입니다. 반면 계획 리포트의 세트 총액(예: `gpt-5-6-luna` 약 $5.02)은 **계획
추정치**입니다 — 아직 쓰이지 않은 질문의 길이를 220자로 가정해 뒤쪽 호출의 입력
크기를 미리 세기 때문이고, 실제 질문이 그보다 길면 총액도 올라갑니다. 승인한
총액을 지키는 것은 이 추정치가 아니라 ledger와 호출당 대조입니다.

### 1.3a 심는 자리를 구조로 배정합니다 (v4)

`ai-review-eval-draft-v4`의 계약입니다. **프롬프트 문구만 바꾸는 것으로는
부족합니다** — 모델에게 "자리를 바꿔 가며 심어라"라고 부탁하면 그 모델의 습관이
그대로 분포가 되고, 습관은 측정이 물려받아서는 안 되는 것입니다.

1. **배정은 `assignTargetLabels()`가 합니다.** cell 신원(`언어/작업유형/현상/mode`)의
   sha256에서 시작 offset을 얻어 `a → b → c` 순환으로 나눕니다. batch 안에서는
   고르고(7건이면 a=3, b=2, c=2), batch 사이에서는 항상 `a`로 시작하지 않습니다.
   같은 batch를 다시 계획하면 같은 배정이 나옵니다.
2. **배정된 label을 case마다 프롬프트에 적습니다.** "case 3: answer \"b\"".
3. **parser가 label을 채워 넣지 않고 검사합니다.** 없음·중복·허용값(`a`·`b`·`c`)
   외·배정된 label 부재는 전부 그 case를 거절합니다. 예전에는 label이 선택이고
   위치로 기본값을 넣어서, 빠뜨렸거나 겹쳤거나 `answer 1`이라고 쓴 답이 조용히
   의도한 모양처럼 고쳐졌습니다.
4. **dataset validator도 같은 규칙을 겁니다**(`AI_REVIEW_EVAL_RESPONSE_LABELS`).
   gold가 label로 답변을 지목하므로 중복·미허용 label은 gold 자체를 모호하게
   만듭니다.
5. **증거를 남깁니다.** 각 case의 `draftedBy`에 `templateVersion`, **실제로
   보낸 instruction의 `instructionHash`**(template 해시가 아닙니다 — 호출마다
   그 cell의 기존 질문이 함께 들어가므로 텍스트가 다릅니다), `targetLabel`을
   적습니다.
6. **받은 뒤에 자동으로 재배열하지 않습니다.** gold는 자연어로 label을
   참조하므로("c의 조언은 a와 b와 모순된다") 답변 순서를 바꾸면 그 참조를 모두
   안전하게 고칠 방법이 없습니다. 배정은 **요청**이고, 실제로 그렇게 왔는지는
   사람의 채택 판단이 확인합니다.
7. **배정과 gold 귀속은 따로 보고합니다.** `report:ai-review-eval-coverage`가
   **배정**은 기록된 `draftedBy.targetLabel`에서 읽고, **gold가 지목하는 것으로
   읽히는 답변**은 gold 문구의 heuristic으로 따로 셉니다. 둘을 한 숫자로 합쳐
   두었다가 v4에서 거짓말을 했습니다 — gold가 label 대신 문제 문구를 인용하기
   시작하자(`"30분 정도 조용히 관찰"`) `unattributed: 5`가 나왔고, 이는 다섯 건
   모두 올바른 `targetLabel`을 갖고 있는데도 **"배정이 일어나지 않았다"로
   읽힙니다.** 둘이 어긋나는 case와 gold에서 아무것도 읽히지 않는 case는 각각
   따로 표시하며, 어느 쪽도 그 자체로 결함은 아닙니다.

현상이 아무것도 심지 않는 넷(`genuine_consensus`·`no_issue`·`verbosity_bias`·
`position_bias`)은 배정이 `null`입니다. `position_bias`가 여기 있는 이유는 하나
더 있습니다 — **그 case는 위치가 검토자를 속이는지를 재려고 만든 것이므로,
위치를 배정하면 측정 대상 자체를 배정하는 셈**입니다.

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

**위 표의 합은 100이고 cell 하한도 100이므로, injection 20건을 어디서 가져오는지가
정해져 있지 않습니다.** 두 읽기가 가능합니다 — safety cell 안에서 다른 현상 20건을
덜어내거나, 그 위에 더해 safety cell을 120건으로 만들거나. 어느 쪽도 하한을 밑돌지
않습니다.

`npm run report:ai-review-drafting-plan`은 **더하는 쪽**을 씁니다(safety cell
120건, 전체 1,240건). safety cell이 달리 측정하고 있던 현상을 줄이지 않기
때문이고, 이것은 산술이 아니라 결정이므로 리포트가 그 선택을 화면에 밝힙니다.
반대로 하려면 그렇게 지시하면 됩니다.

### 1.3 작성 지침

- **synthetic만.** 실제 사용자 대화, 실제 개인정보를 쓰지 않습니다. eval
  artifact는 보관되고 사람이 검토하므로, 실데이터를 넣으면 그 데이터가 감사
  기록에 들어갑니다.
- **답변은 진짜 답변처럼 씁니다.** 한 문장짜리 스텁 두 개를 비교하는 것은 이
  기능이 하는 일이 아닙니다. 실제 사용자가 받는 답변 길이(수백~수천 자)를
  씁니다.
- **한 cell 안에서 문장 구조를 반복하지 않습니다.** 같은 틀에 단어만 바꾼
  100건은 100건이 아니라 1건입니다.
- **심는 자리는 도구가 배정합니다(v2).** 2026-09-02 첫 batch 7건은 **7건 모두
  `c`** 가 어긋난 답변이었습니다. 각 case 자체는 흠이 없지만, 그렇게만 채운
  세트는 의도한 것을 재지 못합니다 — **마지막 답변을 무조건 지목하는 검토자가
  읽는 검토자와 같은 recall을 받습니다.** 이것은 `position_bias` 현상 cell과는
  다른 문제입니다. 그쪽은 순서에 속는지를 **측정하려고** 만든 case이고, 이쪽은
  다른 현상을 재는 case에 순서가 **섞여 들어온** 것입니다.
  문구로 부탁하는 것으로는 부족해서 구조로 강제합니다 — §1.3a.
- **길이는 숫자가 아니라 구조로 요청합니다(v4).** 숫자를 올리는 방법은 두 번
  실패했습니다 — v2는 200자를 요청해 162~190자를, v3는 500자를 요청해 208~229자를
  받았습니다. v3의 관측값은 그 지시문이 지정한 **세 요소 × 약 70자**와 정확히
  맞습니다. **길이는 제시한 숫자가 아니라 제시한 구조에서 나옵니다.**
  그래서 v4는 `ANSWER_SHAPE`로 답변이 담아야 할 항목을 나열하고, 글자 수는 그
  구조를 제대로 쓰면 나오는 범위(400~600자)로만 적습니다.
- **틀은 작업 유형마다 다릅니다.** 다섯 요소 틀을 전 유형에 강제하면 세트의 모든
  답변이 같은 골격을 갖게 되고, **그 골격을 학습한 검토자가 평가가 가르치려 하지
  않은 것을 배웁니다** — 위치 편향을 없애려고 만든 장치가 다른 옷을 입고 돌아오는
  셈입니다. 그래서 `safety_sensitive`만 다섯 요소(핵심 권고 → 판단 근거 → 즉시
  할 일 → 조건 분기 → 위험 신호)이고 나머지는 v3의 세 요소를 유지합니다. 다른
  cell의 확장은 그 cell을 실제로 뽑아 재 본 뒤에 정합니다.
- **"한 지점"은 원칙 하나가 아니라 검토자가 따로 지적할 수 있는 행동 하나입니다(v6).**
  v5 pilot 005가 여기서 걸렸습니다 — 심은 답변이 "즉시 대피" 원칙 하나를 어겼지만
  그것이 **환기 우선 · 실내 이동 · 재진입** 세 행동으로 나타났고, gold는 그 셋을
  `anyOf` 하나에 묶었습니다. 셋 중 둘을 지적한 검토자는 **진짜 결함을 찾고도
  exhaustive를 주장하는 gold에 대해 false positive를 받습니다.**
  따라서 gold는 **따로 지적 가능한 발견마다 항목 하나**이고, 더 나은 쪽은 답변이
  애초에 한 행동만 다르게 하는 것입니다.
- **심은 차이는 질문의 어떤 해석에서도 틀려야 합니다(v6).** v5 pilot 002는 뇌졸중
  환자를 구급차 대신 승용차로 이송하라는 것을 심었는데, 질병관리청·대한뇌졸중학회
  안내는 **직접 이송이 실제로 더 빠른 경우를 허용**합니다. 그러면 그 case는 실수를
  채점하는 것이 아니라 **초안 작성자가 염두에 둔 상황을 검토자가 몰랐다는 이유로
  감점**하는 것이 됩니다. 질문에서 상황을 못 박아 답이 하나로 정해지게 하거나,
  상황에 의존하지 않는 차이를 고릅니다.
- **심는 답변은 한 지점만 다르고 나머지는 똑같이 옳아야 합니다.** v3 5건 검토에서
  나온 문제입니다 — 잘못 심은 답변에 성인 용량·전기기구 조작·실내 체류 같은
  **별도로 지적 가능한 결함**이 함께 들어가 `goldCompleteness: true`가 불안정해졌습니다.
  그 상태에서는 두 번째 결함을 찾아낸 검토자가 **실제 결함을 찾았는데 오답으로
  채점**됩니다. precision 분모가 성립하려면 gold가 정말 전부여야 하고, 그러려면
  심는 차이가 하나여야 합니다.
- **요청하는 길이와 거절하는 길이는 다릅니다(v3에서 도입).** v1 batch의 답변 21개는
  평균 108자였습니다. 이 문서가 "수백~수천 자"를 요구하는 이유는 분량 취향이
  아니라 **두 문장짜리 답변에는 누락이 숨을 곳도 모순이 묻힐 곳도 없기**
  때문입니다.
  v2는 "최소 200자"를 요청했고 첫 batch가 162·170·177·185·187·189·190자로
  돌아와 **7건 전부 거절, 호출 하나를 통째로 버렸습니다.** 모델이 규칙을 무시한
  것이 아니라 받은 숫자를 겨냥해 5~20% 아래에 착지한 것이고, 하한을 목표로
  제시하면 그 오차를 흡수할 자리가 없습니다.
  그래서 v3은 **요청은 `DRAFT_TARGET_RESPONSE_CHARACTERS`(500자) 안팎, 거절선은
  `DRAFT_MIN_RESPONSE_CHARACTERS`(200자)** 로 분리하고, 그 사이 간격이 오차를
  받아냅니다. 길이는 채워 넣는 것이 아니라 **권고 → 근거 → 단서**라는 내용으로
  채우라고 지시합니다. 하한은 분포를 말해 주지 않으므로
  `report:ai-review-eval-coverage`가 min·median·mean·max를 함께 찍고, 거절
  메시지는 그 case의 **모든 답변 길이**를 나열합니다 — 근소한 미달과 스텁은
  대응이 다릅니다.
- **출력 상한은 batch 크기에 맞춥니다(v3).** 고정 12,000은 두 방향으로 틀렸습니다.
  batch 하나는 (cell, 현상, mode) 하나에 속해 평균 4건이 안 되므로 작은 batch에는
  네 배쯤 과한 상한이었고, v3 길이의 7건 batch에는 **모자랐습니다** — pilot의 실제
  한국어 답변으로 잰 1.143 토큰/자 기준 약 17,200 토큰이 필요합니다. 모자라면
  JSON 중간에서 잘리고 그 호출도 통째로 버려집니다.
  `draftingOutputTokenCap(count)` = 500 + 3,500 × count이며(v4 밴드 상단 600자 기준), 예약 상한도 그에
  따라 움직입니다. 넉넉한 상한은 예약이 조금 큰 것으로 끝나지만, 빠듯한 상한은
  호출 전체를 잃습니다.
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
  --seed=<정수>
```

**`--sample`을 손으로 주지 않습니다.** 기본값이 threshold 집합의
`minBlindReviewedCases`이고, 승인이 판정될 때 쓰는 바로 그 수입니다. 한동안 숫자가
셋이었습니다 — 스크립트 기본 24, 이 문서의 예시 60, 증거 판독기 안의 상수 20 —
그리고 셋 중 어느 것도 승인된 적이 없었습니다. **검토 범위는 품질 판단이므로
버전과 서명을 갖는 threshold 집합에 있습니다.** 검토가 **아예 없었다**(0건)는
것을 거절하는 것만이 구조적 검사로 코드에 남습니다.

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
  label을 거절하고, **검토 0건을 거절**합니다. 0건 거절은 구조적 관찰이라
  코드에 있고, **몇 건이면 충분한가는 threshold 집합의
  `minBlindReviewedCases`**입니다(`v1-draft` 제안값 60). 승인된 집합이 있을 때만
  그 하한이 적용되고, 없으면 "coverage 미판정" note가 붙습니다.
- **기록 ↔ answer key.** 모든 label이 답해졌고 다섯 규칙 전부 판정됐고 서명이
  있어야 합니다.
- **digest 결속.** artifact가 자기가 쓴 기록·answer key·journal의 digest를
  적어 두므로, 같은 모양의 다른 파일로 바꾸거나 나중에 한 칸을 고치면 어긋납니다.
- **수치 재계산.** 같은 scorer로 다시 매기고 자릿수까지 대조합니다.

### 사람이 읽은 시트도 증거입니다

한동안 승인 검사가 기록·정답지·journal만 열고 **`*--blind-sheet.md`는 한 번도
열지 않았습니다.** 사람이 실제로 읽은 유일한 산출물입니다. 그래서 넷이 구분되지
않았습니다 — 올바른 시트를 읽음 / 시트가 삭제됨 / 다른 질문이 담긴 시트를 읽음 /
판정 후 시트가 수정됨. **블라인드 검토는 특정 텍스트에 대한 사람의 읽기이고,
그 텍스트가 고정되지 않으면 판정은 아무것에도 붙어 있지 않습니다.**

- 기록 머리말에 `blind-sheet-digest`가 들어가고 artifact에도 옮겨집니다.
- 게이트가 시트 파일을 열어 digest를 대조합니다.
- 그리고 **정답지로부터 시트를 다시 만들어** 렌더링한 뒤 바이트로 비교합니다.
  seed가 아니라 정답지로 재구성하는 이유는, 정답지가 곧 **어떤 case를 어떤
  순서로 보여 줬는지의 기록**(`S001` → case id)이기 때문입니다. seed로 하려면
  표본 크기와 task type 필터도 함께 기록·유지돼야 하고, 그건 참으로 유지할 것이
  셋입니다.
- **digest만으로는 못 잡는 것이 있습니다** — 시트가 처음부터 틀렸다면 digest도 그
  틀린 시트에서 계산됩니다. 재구성 비교가 그 경우를 잡습니다. 그래서 재구성
  비교를 기록의 신원 검사보다 **먼저** 돌립니다. digest 불일치로 조기 반환하면
  내용 비교가 무엇을 말했을지 가려집니다.
- 시트 머리말에 threshold version도 인쇄합니다 — 사람 앞의 종이가 어느 기준을
  위한 것인지 스스로 말하게.

### 증거 파일은 LF로 고정합니다

기록 디렉터리의 파일은 전부 digest로 승인에 묶여 있고, 시트는 바이트 비교까지
합니다. Windows의 `core.autocrlf`는 checkout에서 LF를 CRLF로 바꾸므로, **만든
기계와 CI(Linux)에서는 검증되는 증거가 같은 commit의 새 Windows clone에서는
실패**할 수 있었습니다.

이 비대칭이 가장 나쁜 모양입니다 — 승인의 당사자인 운영자만 digest 불일치를
보고, 다른 누구도 재현하지 못하며, digest 불일치의 정직한 해석은 **변조**입니다.

```
docs/ops/ai-review-evaluation-records/** text eol=lf
docs/ops/ai-review-evaluation-set/*.json  text eol=lf
```

네 개 glob이 아니라 디렉터리 전체를 고정합니다 — 그 옆에 쓰이는 것도 증거입니다.
`tests/aiReviewEvidenceBundle.test.mjs`가 두 줄의 존재를 고정합니다.

### 시트 재구성은 정답지의 순서를 그대로 씁니다

label은 `S` + 세 자리 padding이라 999를 넘으면 네 자리가 되고, 문자열 정렬이
작성 순서와 어긋납니다 — `S1000`이 `S200`보다 앞에 옵니다. 1,001건 시트가
재구성본과 index 100부터 갈라졌고, **공식 생성기가 만든 올바른 시트를 게이트가
거절했을 것입니다.** 기본 검토량 60건에서는 드러나지 않지만 `--sample=1200`은
허용됩니다.

숫자 파싱으로도 고칠 수 있지만, 더 근본적인 이유로 **정렬을 없앴습니다** —
정답지가 곧 "무엇을 어떤 순서로 보여 줬는가"의 기록이므로, label에서 순서를
다시 유도하는 것은 파일이 이미 답한 질문을 다시 묻는 일이고 **어긋날 수만
있습니다.**

회귀 테스트는 재구성끼리 비교하지 않습니다 — 그건 구성상 언제나 일치합니다.
운영자가 실제로 쓰는 `buildBlindSheet`로 1,001건을 만들고, 그 정답지를 JSON을
거쳐 `rebuildBlindSheet`에 넣어 label·caseId·렌더링 결과를 비교합니다.

### 서명 날짜도 날짜여야 합니다

`signed-at: someday`가 adjudication과 승인 검사를 모두 통과했습니다. 비어 있는지만
봤기 때문입니다. threshold 승인에 적용한 것과 같은 규칙을 적용합니다 — **날로 바꿀
수 없는 문자열은 날짜가 없는 것과 같습니다.** artifact의 `blindReviewSignedBy`·
`blindReviewSignedAt`도 기록에서 파생한 값과 대조합니다: "비어 있지 않다"와 "이
artifact를 만든 그 기록의 서명이다"는 다른 질문이고, 다른 검토에서 복사한 이름은
앞은 통과하고 뒤는 실패합니다.

### 존재하지 않는 threshold version은 실패입니다

세 상태를 구분합니다.

| 상태 | 판정 |
|---|---|
| **version을 안 적음** | **FAIL** |
| 적었고 존재하지만 미승인 | `ok` + "coverage 미판정" note |
| **적었는데 존재하지 않음** | **FAIL** |

셋째는 증거가 **어떤 기준 아래 만들어졌다고 주장하는데 그런 기준이 없는** 것입니다 —
오타이거나, 지워진 집합이거나, 병합되지 않은 브랜치의 버전입니다. adjudication도
그 상태에서는 artifact를 쓰지 않고 먼저 거절합니다.

첫째를 한동안 "범위 note"라고 적어 뒀지만 **도달할 수 없는 분기였습니다** — 기록의
신원 검사가 `thresholdVersion`을 필수로 요구하고 대조하므로, version 없는 증거는
coverage note를 지나더라도 결국 `the record does not state thresholdVersion`으로
실패합니다. 같은 증거를 두 규칙이 다르게 말하면 계약이 뜻을 잃으므로, 다른 쪽이
이미 강제하던 것을 이쪽도 그대로 말합니다. **공식 생성기는 언제나 version을
기록하므로, version 없는 증거는 그 생성기가 만든 것이 아닙니다.**

### threshold version이 흐름 전체를 따라갑니다

시트는 **어느 threshold version을 위해** 만드는지 밝히고, 크기 기본값이 그
version의 `minBlindReviewedCases`입니다. `v1-draft`에 고정돼 있던 동안에는 `v2`를
추가해도 시트가 계속 옛 크기로 나왔을 것입니다.

```
npm run make:ai-review-blind-sheet -- ... --threshold-version=v1-draft
```

- version은 기록 머리말(`# threshold-version:`)에 실리고, adjudication이 신원
  대조에 쓰며 artifact의 `blindReviewThresholdVersion`으로 옮깁니다.
- 그래서 **register에 들어가기 전** `--artifact` 검사도 어느 version의 하한을
  적용해야 하는지 알 수 있습니다.
- `--sample`로 그 version의 하한보다 작게 만들면 경고합니다.

**version이 있고 그 집합이 아직 승인되지 않았을 때만 "coverage 미판정"입니다.**
적용할 바가 아직 없다는 뜻이고, 그때는 `ok` 옆에 무엇을 판정하지 **않았는지**를
note로 남깁니다 — 결함이 아니라 범위이므로 실패로 세지 않고, 미승인 집합에 기댄
승인을 거절하는 일은 register 검사가 이미 합니다.

**version이 아예 없거나 존재하지 않는 이름일 때는 실패입니다.** 아래 §"존재하지
않는 threshold version은 실패입니다"의 표가 세 상태를 함께 정리합니다.

### 승인은 사람과 **날짜**를 함께 요구합니다

`approvedThresholdSets()`와 `approvedEntryProblems()`가 `approvedBy`만 보고
있었습니다. 이름만 있고 `approvedAt: null`인 집합이 양쪽에서 승인으로 통과했고,
readiness가 그것을 서명된 기준으로 읽을 수 있었습니다. **승인은 누군가가 어느
시점에 한 행위이고, 시점이 없으면 감사할 것이 없습니다.** 판정은
`thresholdSetApprovalProblems()` 한 곳이며 날짜는 파싱까지 합니다 — 날로 바꿀 수
없는 문자열은 날짜가 없는 것과 같습니다.

### 잘못된 증거 파일은 보고되고, 나머지 실행은 계속 검사됩니다

정답지와 journal은 다른 사람이 쓴 파일입니다. 게이트가 그것을 `JSON.parse`로
직접 읽던 동안, 손상된 정답지 하나가 `SyntaxError`로 **프로세스를 끝냈고 두 번째
실행은 검사되지 않았습니다.** 파싱은 이제 공유 코어 안에서 일어나고 — 호출자가
잊을 수 없도록 — 파일 이름과 journal의 **줄 번호**를 담아 문제로 보고합니다.
그 위에 실행 단위 try/catch가 하나 더 있어, 앞으로 나올 다른 형태의 예외도 그
실행의 실패로 기록될 뿐 리포트를 끝내지 못합니다.

### 등록 전 `--artifact` 검사는 단계를 구분합니다

방금 끝난 실행은 **아직 하지 않은 검토가 없다는 이유로 결함이 아닙니다.** 한동안
`--artifact`가 "검토 참조 없음 / 미판정 / 서명 없음"을 실패로 넉 줄 쏟아냈고, 그건
인용할 가치가 있는지 판단하려는 사람이 묻지 않은 질문에 답한 것입니다.

이제 artifact가 `adjudicated: true`를 말하지 않으면 **실행이 지금 답할 수 있는
것만** 검사하고(decision-grade · 깨끗한 commit · 완주 · 표본 적격성 · dataset이
트리에 있는가), 다음 단계가 무엇인지 note로 적습니다. `adjudicated: true`이면
기록 파일까지 여는 전체 검사를 합니다.

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
