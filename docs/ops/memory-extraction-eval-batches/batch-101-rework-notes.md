# batch-101 재작업 노트 — `durable_facts:ko` 1–25

**이 문서는 에이전트가 쓴 초안 설명입니다. 판정이 아닙니다.** 판정은
`batch-101-successor-durable-ko.md`의 검수 시트에서 사람이 합니다.

검수 시트는 자동 생성이라 손으로 고치면 다음 생성 때 덮어씁니다. 그래서 **어떤
판단으로 라벨을 바꿨는지**는 이 파일에 적습니다.

## 이 batch가 하는 일

`lib/memoryExtractionEvalAdopted/batch001DurableKo.ts`의 25건을 schema 2로
재작업했습니다. **대화문은 한 글자도 바꾸지 않았습니다** — 2026-08-23에
사람이 채택한 내용이고, 승인된 개정안 A–D 중 어느 것도 대화문을 건드리지
않습니다. 바뀐 것은 라벨뿐입니다.

`tests/memoryEvalSuccessorBatch101.test.mjs`가 대화문 동일성을 케이스마다
대조하므로, 재작업을 빌미로 새 케이스를 쓰는 일은 통과하지 못합니다.

## 기계로 확인한 것

| 항목 | 결과 |
|---|---|
| `validateSuccessorDataset` (development) | 오류 0건 |
| `goldCompleteness` | 25건 전부 `exhaustive` |
| `expectedDisposition` | expected 28건 전부 명시 |
| source case 1:1 대응 | 25건, 중복 없음, 전부 frozen set에 존재 |
| 대화문 동일성 | 25건 전부 일치 |
| near-duplicate 포화 | 0쌍 (선언된 재작업 쌍은 비교에서 제외) |

## 라벨이 바뀐 5건 — 판정이 필요한 곳

나머지 20건은 kind가 그대로이고 `expectedDisposition: "bulk_safe"`만 붙었습니다.
아래 다섯 건이 규칙이 좁혀 주지만 완전히 정해 주지는 않는 지점입니다.

### 1. `succ-durable-ko-17` — `preference` → `formatting`

> 비교할 게 여러 개면 표로 정리해 주는 게 제일 편해요.

**근거.** .github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §2 규칙 1 —
답변 방식에 관한 것이면 전용 kind가 일반
`preference`보다 우선합니다. 이것은 답변을 **어떻게 제시할지**에 관한 지시이므로
`formatting`입니다.

**반대 논거.** 없다고 봅니다. probe에서 `durable-en-2`·`durable-ko-2`가 정확히
이 이유로 어긋났고, 그것이 이 규칙을 만든 관측입니다.

### 2. `succ-durable-ko-21` — `communication_style` → `structure`

> 결론 먼저 말해주고 이유는 뒤에 붙여주세요

**근거.** .github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §2 규칙 1의
전용 목록에 `structure`가 있고 `communication_style`은
없습니다. 즉 `communication_style`은 style 쪽의 **일반 kind**로 기능하며, 답변
순서에는 전용 kind가 있습니다.

**확인이 필요한 점.** 이 해석 — `communication_style`을 style의 generic으로
보는 것 — 은 규칙 문언에서 유도한 것이지 명시된 것이 아닙니다. **다르게 보신다면
`communication_style`을 유지하고, 대신 규칙 1의 전용 목록에
`communication_style`을 추가해야 합니다.** 이 batch만의 문제가 아니라 400건 전체에
같은 판단이 걸립니다.

### 3·4. `succ-durable-ko-6`, `succ-durable-ko-16` — expected 1개 → 2개

> 통계는 대학원에서 전공해서 어느 정도 압니다. 기초 설명은 건너뛰고 바로 모델 선택 얘기로 가주세요.
> 용접은 현장에서 20년 했습니다. 기본기 설명은 필요 없어요.

**근거.** .github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §2 규칙 5 —
독립적으로 유용한 사실이 둘이면 후보 둘을 허용하되 gold에도
둘 다 열거합니다. "무엇을 아는가"(`expertise`)와 "무엇을 건너뛸까"
(`explanation_depth`)는 서로 다른 절에 근거가 있고, 한쪽만 알아도 다른 쪽을
알 수 없습니다.

**gold 완전성 요건이기도 합니다**(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §4). `exhaustive`라고 선언하는 이상, 모델이
`explanation_depth`를 옳게 뽑았을 때 그것이 false positive가 되면 안 됩니다.
probe의 `durable-en-1`이 정확히 그 방식으로 precision을 잃었습니다.

### 5. `succ-durable-ko-2` — expected 1개 → 2개, 그리고 **빠뜨린 것 하나**

> 제가 종합병원 간호사인데 3교대라 수면 패턴이 계속 깨져요. 야간 근무 끝나고 낮에 자려고 하면 두세 시간 만에 깨고, 다시 잠들기가 어렵습니다. 커피는 근무 시작할 때 한 잔만 마셔요.

`occupation`(간호사)에 `recurring_context`(3교대)를 더했습니다 — 언제 연락이
닿는지를 정하는 별개의 사실입니다.

**gold에 넣지 않은 것이 둘 있고, 이것이 이 batch에서 가장 약한 지점입니다.**

- **수면 문제.** "수면 패턴이 계속 깨져요 / 다시 잠들기가 어렵습니다"는 지속적
  이지만 진단이 아니고, 교대 근무의 결과를 서술한 것에 가깝습니다. 저장 대상이
  라면 kind는 `constraint`일 것이고 .github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §3.1에 따라
  **`sensitive_review`**여야 합니다.
- **커피 습관.** "근무 시작할 때 한 잔만"은 부수적이라고 보고 뺐습니다.

**둘 다 `exhaustive` 선언 아래에서는 결정이 곧 채점입니다.** 넣지 않기로 하면
모델이 뽑았을 때 precision이 깎이고, 넣기로 하면 안 뽑았을 때 recall이 깎입니다.
**이 케이스는 대화가 풍부해서 exhaustive gold를 쓰기 어려운 유형**이므로, 검수에서
반려하고 더 atomic한 케이스로 재작성하는 선택지도 있습니다
(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §4.2가 범주 ①을 가능한 한 atomic하게 쓰라고 한 이유입니다).

## `sensitive_review`로 보낸 2건

### `succ-durable-ko-1` — 갑각류 알레르기

.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §3.1 그대로입니다.
추출은 되고, 자동 승인은 안 됩니다.

### `succ-durable-ko-12` — 어머니의 휠체어 사용

> 어머니가 휠체어를 쓰셔서 계단 있는 곳은 아예 못 갑니다.

**제3자의 건강·장애 정보입니다.** .github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §3.2의
의미 범위는 "진단·질환"을 계정
소유자로 한정하지 않고, 민감 lane의 요점은 **누구의 건강이든 자동 승인되지 않는
것**이라고 읽었습니다.

**확인이 필요한 점.** 개정안은 제3자 건강 정보를 따로 다루지 않습니다. 다르게
보신다면 .github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §3.2의
의미 범위에 제3자 취급을 한 줄 넣어야 하고, 이 역시 400건 전체에
걸립니다 — 가족의 건강을 언급하는 케이스가 이 하나만은 아닐 것입니다.

## 검수자에게 남기는 요청

시트의 5건 표본 판정과 batch 채택 결정이 정식 절차입니다. 그와 별개로 **위
질문 셋에 답해 주시면 나머지 375건의 작성 기준이 정해집니다.**

1. `communication_style`은 style의 generic인가, 전용 kind인가 (2번)
2. `succ-durable-ko-2`처럼 풍부한 대화를 exhaustive로 쓸 것인가, 반려 후 atomic
   하게 재작성할 것인가 (5번)
3. 제3자의 건강 정보를 `sensitive_review`로 볼 것인가 (`succ-durable-ko-12`)

셋 다 이 batch에서는 제 판단으로 채워 두었고, 다르게 정해지면 이 25건과 이후
375건에 같은 규칙으로 다시 적용합니다.
