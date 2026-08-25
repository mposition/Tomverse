# batch-101 — `durable_facts:ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-101`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 5건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

이 batch는 범주 ①이라 `docs/ops/memory-extraction-eval-dataset.md` §6.3의 **20% 표본 검수**로 갈음됩니다 — 25건 중 5건.

표본에서 **반려가 한 건이라도 나오면 불일치율이 5%를 넘으므로 batch 전건 재검수**입니다
(5건 중 1건 = 20%). 더 보고 싶으시면 아래 전체 목록에서 골라 보셔도 됩니다.

아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `constraint` 3/25 = **12%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 25건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.42 | 0.35 | cand-durable-ko4-22 ~ cand-durable-ko5-12 |
| 0.33 | 0.41 | cand-durable-ko3-17 ~ cand-durable-ko5-12 |
| 0.30 | 0.37 | cand-durable-ko2-14 ~ cand-durable-ko4-18 |
| 0.30 | 0.37 | cand-durable-ko3-36 ~ cand-durable-ko4-4 |
| 0.35 | 0.35 | cand-durable-ko3-23 ~ cand-durable-ko5-15 |
| 0.29 | 0.35 | cand-durable-ko3-17 ~ cand-durable-ko4-22 |
| 0.07 | 0.33 | cand-durable-ko4-16 ~ cand-durable-ko4-23 |
| 0.27 | 0.33 | cand-durable-ko4-35 ~ cand-durable-ko5-21 |
| 0.25 | 0.32 | cand-durable-ko-13 ~ cand-durable-ko2-47 |
| 0.25 | 0.32 | cand-durable-ko2-47 ~ succ-durable-ko-13 |

---

## 표본 — 판정할 5건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### succ-durable-ko-1

**제안 gold label**: `constraint` — 키워드 `갑각류`

> **사용자** 저 갑각류 알레르기 있어서 새우나 게 들어간 건 빼주세요.
>
> **assistant** 알겠습니다. 갑각류 없는 메뉴로 골라 드릴게요.
>
> **사용자** 네 부탁드려요.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-6

**제안 gold label**: `expertise` — 키워드 `통계`; `explanation_depth` — 키워드 `기초`

> **사용자** 통계는 대학원에서 전공해서 어느 정도 압니다. 기초 설명은 건너뛰고 바로 모델 선택 얘기로 가주세요.
>
> **assistant** 그럼 바로 들어가겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-11

**제안 gold label**: `decision` — 키워드 `postgres`

> **사용자** 고민 끝에 postgres 쓰기로 정했습니다. 이제 안 바꿀 거예요.
>
> **assistant** 정하셨군요. 그럼 그 전제로 스키마 얘기를 이어가죠.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-17

**제안 gold label**: `formatting` — 키워드 `표`

> **사용자** 비교할 게 여러 개면 표로 정리해 주는 게 제일 편해요.
>
> **assistant** 그럼 비교는 표로 드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-21

**제안 gold label**: `structure` — 키워드 `결론`

> **사용자** 결론 먼저 말해주고 이유는 뒤에 붙여주세요
>
> **assistant** 네, 결론부터 말씀드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

---

## batch 채택 결정

`docs/ops/memory-extraction-eval-dataset.md` §6.3: 표본만 보고 넘어가는 것은 채택이 아닙니다. 아래에 적어야 나머지가 dataset에 들어갑니다.

| 항목 | 값 |
|---|---|
| batch 채택 여부 | |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | |
| 검수 완료일 | |

---

## batch 기록 (`docs/ops/memory-extraction-eval-dataset.md` §8)

`docs/ops/memory-extraction-eval-dataset.md` §7.1은 동결 조건으로 초안 도구·모델·버전, 검수자, 판정 근거, draft
disagreement 비율을 요구합니다. 케이스마다 여섯 칸을 채우는 대신 batch에 한 번
적습니다 — 초안 생성자와 검수자는 batch 전체가 같고, 케이스별 draft
disagreement는 위 판정에서 그대로 계산되며, 채택된 케이스의 gold label 근거는
제안 라벨 그 자체입니다.

| 항목 | 값 |
|---|---|
| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) | *(운영자 기입)* |
| 검수자 (사람 · 최초의 권위 있는 판정) | |
| 재작성 회차 | 1 (최초 초안) |
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | |
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 5건에서 계산 |

「초안 구성이 직전 batch와 같은가」는 `같음` 또는 `다름`으로 적습니다.
`docs/ops/memory-extraction-eval-dataset.md` §6.3의 안전장치이고, 20% 표본이 성립하는 조건입니다 — 초안
도구·모델·버전이 바뀐 뒤의 첫 batch는 전건 검수로 돌아갑니다. `다름`이라고
적으면 이 batch는 표본이 아니라 전건을 판정해야 하며, 시트를
`--full`로 다시 생성하면 전건 판정란이 나옵니다. 칸이 비어 있으면 승격되지
않습니다 — 답을 안 한 것과 `같음`은 다릅니다.

초안 생성자 칸을 에이전트가 비워 두는 이유는 하나입니다 — 이 저장소에 남기는
산출물에 에이전트의 모델 식별자를 적지 않는다는 규칙이 있어서, 자기 이름을 적을
수 있는 것은 운영자뿐입니다.

---

## 전체 25건 (참고용 — 판정 불필요)

| # | 제안 kind | 키워드 | 첫 사용자 발화 |
|---|---|---|---|
| 1 **←표본** | `constraint` | `갑각류` | 저 갑각류 알레르기 있어서 새우나 게 들어간 건 빼주세요. |
| 2 | `occupation` | `간호사` | 저 종합병원 간호사예요. 3교대라 근무 시간이 주마다 바뀝니다. |
| 3 | `verbosity` | `짧게` | 앞으로 짧게 대답해 주세요. 길면 안 읽게 돼요. |
| 4 | `project` | `가계부` + `앱` | 요즘 가계부 앱을 혼자 만들고 있어요. 주말에만 붙잡고 있는데 벌써 넉 달째네요… |
| 5 | `identity` | `부산` | 부산 살아요. 근처에 갈 만한 데 있을까요? |
| 6 **←표본** | `expertise` | `통계` | 통계는 대학원에서 전공해서 어느 정도 압니다. 기초 설명은 건너뛰고 바로 모델 … |
| 7 | `long_term_goal` | `변호사` | 최종 목표는 변호사가 되는 거예요. 지금은 직장 다니면서 준비 중이고요. |
| 8 | `relationship` | `쌍둥이` | 쌍둥이 아들 둘 키우고 있어요. 이제 여섯 살이요. |
| 9 | `code_style` | `탭` | 코드 예시 줄 때 들여쓰기는 탭으로 해주세요. 스페이스는 안 씁니다. |
| 10 | `preference` | `창가` | 비행기 예약할 때는 늘 창가 자리로 잡아요. |
| 11 **←표본** | `decision` | `postgres` | 고민 끝에 postgres 쓰기로 정했습니다. 이제 안 바꿀 거예요. |
| 12 | `constraint` | `휠체어` + `계단` | 어머니가 휠체어를 쓰셔서 계단 있는 곳은 아예 못 갑니다. 이거 꼭 감안해 주세요. |
| 13 | `language` | `한국어` | 영어로 물어봐도 답은 한국어로 주세요. |
| 14 | `occupation` | `세무사` | 세무사로 일한 지 12년 됐습니다. |
| 15 | `recurring_context` | `월요일` + `회의` | 매주 월요일 아침에 팀 회의가 있어서 그때는 답장이 늦어요. |
| 16 | `expertise` | `용접` | 용접은 현장에서 20년 했습니다. 기본기 설명은 필요 없어요. |
| 17 **←표본** | `formatting` | `표` | 비교할 게 여러 개면 표로 정리해 주는 게 제일 편해요. |
| 18 | `identity` | `1986` | 1986년생이에요. |
| 19 | `project` | `논문` + `기후` | 지금 기후 변화 관련 논문을 쓰고 있는데 자료 정리가 안 되네요. 인터뷰 스무 … |
| 20 | `constraint` | `예산` + `300` | 예산이 300만원을 못 넘습니다. 이 선은 절대 못 넘어요. |
| 21 **←표본** | `structure` | `결론` | 결론 먼저 말해주고 이유는 뒤에 붙여주세요 |
| 22 | `decision` | `전세` | 고민하다가 매매 말고 전세로 가기로 결정했어요. |
| 23 | `relationship` | `동업자` | 동업자랑 둘이서 운영하는 가게예요. 지분은 반반이고요. |
| 24 | `long_term_goal` | `귀농` | 언젠가는 귀농할 생각이에요. 아직 시기는 안 정했지만 방향은 확실합니다. |
| 25 | `preference` | `전화` | 전화 통화는 싫어해서 되도록 문자나 메일로 처리해요. 급한거 아니면 전화는 안받… |

