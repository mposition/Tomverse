# batch-002 — `durable_facts:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-002`
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
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `occupation` 3/25 = **12%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 25건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.25 | 0.00 | cand-durable-en-19 ~ cand-durable-en-20 |
| 0.21 | 0.10 | cand-durable-en-17 ~ cand-durable-en-22 |
| 0.20 | 0.05 | cand-durable-en-8 ~ cand-durable-en-20 |
| 0.18 | 0.04 | cand-durable-en-12 ~ cand-durable-en-18 |
| 0.18 | 0.08 | cand-durable-en-22 ~ cand-durable-en-23 |
| 0.18 | 0.03 | cand-durable-en-12 ~ cand-durable-en-20 |
| 0.17 | 0.07 | cand-durable-en-4 ~ cand-durable-en-5 |
| 0.17 | 0.07 | cand-durable-en-6 ~ cand-durable-en-23 |
| 0.17 | 0.11 | cand-durable-en-17 ~ cand-durable-en-23 |
| 0.17 | 0.00 | durable-en-1 ~ cand-durable-en-11 |

---

## 표본 — 판정할 5건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### cand-durable-en-1

**제안 gold label**: `occupation` — 키워드 `paramedic`

> **사용자** I'm a paramedic, twelve-hour shifts, mostly nights this quarter. Any advice on eating properly when the schedule is like that?
>
> **assistant** Batch cooking on your days off tends to survive that schedule better than daily prep.
>
> **사용자** That's roughly what I've been doing.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en-6

**제안 gold label**: `preference` — 키워드 `examples` + `theory`

> **사용자** I'd much rather see examples first and the theory afterwards. The other order never sticks for me.
>
> **assistant** Then I'll lead with examples from here on.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en-11

**제안 gold label**: `expertise` — 키워드 `tax law`

> **사용자** I've practised tax law for fifteen years. You can skip the introductions and go straight to the edge cases.
>
> **assistant** Straight to the edge cases, then.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en-16

**제안 gold label**: `project` — 키워드 `cookbook`

> **사용자** I'm putting together a cookbook of my grandmother's recipes. Most of them are on index cards in her handwriting.
>
> **assistant** Transcription order matters more than layout at this stage.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en-21

**제안 gold label**: `recurring_context` — 키워드 `friday`

> **사용자** Every Friday afternoon I'm offline for prayers, so don't plan anything for that window.
>
> **assistant** Friday afternoons are out.

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
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 5건에서 계산 |

초안 생성자 칸을 에이전트가 비워 두는 이유는 하나입니다 — 이 저장소에 남기는
산출물에 에이전트의 모델 식별자를 적지 않는다는 규칙이 있어서, 자기 이름을 적을
수 있는 것은 운영자뿐입니다.

---

## 전체 25건 (참고용 — 판정 불필요)

| # | 제안 kind | 키워드 | 첫 사용자 발화 |
|---|---|---|---|
| 1 **←표본** | `occupation` | `paramedic` | I'm a paramedic, twelve-hour shifts, mostly … |
| 2 | `occupation` | `chemistry` + `teacher` | I've been a high school chemistry teacher fo… |
| 3 | `occupation` | `bakery` | I run a small bakery. Two staff, one oven, n… |
| 4 | `identity` | `lisbon` | I'm based in Lisbon, if that changes any of … |
| 5 | `identity` | `1974` | I was born in 1974, for whatever that's wort… |
| 6 **←표본** | `preference` | `examples` + `theory` | I'd much rather see examples first and the t… |
| 7 | `preference` | `aisle` | I always take the aisle seat, every flight, … |
| 8 | `constraint` | `subscription` | Please don't suggest anything that needs a s… |
| 9 | `constraint` | `budget` + `2000` | my budget is 2000 dollars and thats a hard l… |
| 10 | `constraint` | `penicillin` | I'm allergic to penicillin — worth knowing b… |
| 11 **←표본** | `expertise` | `tax law` | I've practised tax law for fifteen years. Yo… |
| 12 | `expertise` | `beginner` + `spreadsheets` | I'm a complete beginner with spreadsheets. I… |
| 13 | `long_term_goal` | `marathon` | The goal is a marathon. Not this year, but t… |
| 14 | `long_term_goal` | `retire` + `55` | I want to retire at 55. That number has been… |
| 15 | `project` | `camper` + `van` | I'm restoring a 1968 camper van. Been at it … |
| 16 **←표본** | `project` | `cookbook` | I'm putting together a cookbook of my grandm… |
| 17 | `decision` | `kubernetes` | We've decided on kubernetes. That's settled … |
| 18 | `decision` | `homeschool` | After a lot of back and forth we decided to … |
| 19 | `relationship` | `partner` + `deaf` | My partner is deaf, so anything you suggest … |
| 20 | `relationship` | `father` + `dementia` | I look after my father. He has dementia and … |
| 21 **←표본** | `recurring_context` | `friday` | Every Friday afternoon I'm offline for praye… |
| 22 | `communication_style` | `hedge` | Don't hedge with me. If you're not sure, say… |
| 23 | `verbosity` | `detail` | Give me the long version. I actually want th… |
| 24 | `language` | `spanish` | Write your answers in spanish even when I as… |
| 25 | `code_style` | `type hints` | Every python example you give me should have… |

