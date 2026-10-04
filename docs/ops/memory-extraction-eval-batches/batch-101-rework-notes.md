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

**[확정 · 2026-08-25]** `communication_style`은 **style 영역의 residual generic
kind**입니다. 전용 목록에 추가하지 않고, 어느 전용 kind에도 정확히 들어가지 않는
상호작용 방식에만 씁니다(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §9.1,
`docs/ops/memory-extraction-eval-dataset.md` §4.1.2). 따라서 `structure` 유지.

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

### 5. `succ-durable-ko-2` — **반려 후 재작성** [확정 · 2026-08-25]

원본 대화에는 독립적으로 유효한 memory가 **최소 넷** 있었습니다.

- 간호사라는 직업
- 반복되는 3교대
- 지속되는 수면 문제
- 근무 시작 시 커피를 마시는 습관

수면과 커피를 빼고 `exhaustive`라고 부르는 것은 방어할 수 없고, 넷을 다 넣으면
`docs/ops/memory-extraction-eval-dataset.md` §4.1의 "한 케이스 1~3개" 원칙을
어깁니다. **라벨로 해결할 수 없는 케이스**이므로 반려하고 atomic하게 다시
썼습니다.

> 저 종합병원 간호사예요. 3교대라 근무 시간이 주마다 바뀝니다.

gold는 `occupation`(간호사)과 `recurring_context`(3교대) 둘입니다.

**이 케이스는 `sourceCaseId`를 선언하지 않습니다.** 아무것도 복사하지 않았으므로
원본을 댈 수 없고, 대지 않는 것이 정직한 형태입니다. `cand-durable-ko-2`는 후속
dataset에서 재작업되지 않고 대체됩니다.

**나머지 375건에 같은 규칙이 걸립니다**(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §9.2).

> 유효 후보가 3개를 넘거나 gold 포함 여부에 합리적인 이견이 생기는 대화는
> 라벨로 해결하지 않고 atomic case로 재작성한다.

## `sensitive_review`로 보낸 2건

### `succ-durable-ko-1` — 갑각류 알레르기

.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §3.1 그대로입니다.
추출은 되고, 자동 승인은 안 됩니다.

### `succ-durable-ko-12` — 어머니의 휠체어 사용 [확정 · 2026-08-25]

> 어머니가 휠체어를 쓰셔서 계단 있는 곳은 아예 못 갑니다.

category와 `sensitive_review`를 유지하되 **gold 문장을 정규화하도록 토큰을
바꿨습니다**: `["휠체어"]` → `["휠체어", "계단"]`.

제3자 건강 정보는 `bulk_safe`가 될 수 없고, **동시에 제3자의 의료 프로필 자체를
저장해서도 안 됩니다**(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §9.3).

| | statement | 이 gold에 매칭되는가 |
|---|---|---|
| 부적절 | 사용자의 어머니가 휠체어를 사용한다. | 아니오 (계단 없음) |
| 적절 | 사용자는 휠체어 이용 가족과 이동할 때 계단 없는 경로가 필요하다. | 예 |

토큰 하나였을 때는 앞 문장도 정답이 됐습니다. 두 토큰이 **사용자 중심 제약을
정답의 조건으로 만듭니다.** `tests/memoryEvalSuccessorBatch101.test.mjs`가 두
문장을 각각 대조합니다.

**v3 프롬프트에도 한 줄이 필요합니다** — 건강 정보에서 파생된 최소화된
statement 역시 sensitive이며, 정규화했다는 이유로 민감도가 내려가지 않습니다.

## 검수자에게 남기는 요청

시트의 5건 표본 판정과 batch 채택 결정이 남아 있습니다.

**작성 기준 세 건은 2026-08-25에 확정됐고 이 batch에 이미 반영돼 있습니다**
(.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §9).

| 항목 | 결정 | 이 batch |
|---|---|---|
| `communication_style` | style 영역의 residual generic kind | `succ-durable-ko-21`은 `structure` 유지 |
| 풍부한 대화 | 조건부 허용, 현재 사례는 atomic 재작성 | `succ-durable-ko-2` 반려 후 재작성 |
| 제3자 건강 정보 | 최소화한 사용자 중심 맥락만, 언제나 sensitive | `succ-durable-ko-12` 유지 + gold 정규화 |

셋 다 batch 메모가 아니라 정책과 작성 지침에 들어갔습니다 —
.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md §9,
`docs/ops/memory-extraction-eval-dataset.md` §4.1.2·§4.1.3. 나머지 375건은 그
문서들을 근거로 씁니다.
