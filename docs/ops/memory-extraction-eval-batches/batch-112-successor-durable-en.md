# batch-112 — `durable_facts:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-112`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 10건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

이 batch는 범주 ①이라 `docs/ops/memory-extraction-eval-dataset.md` §6.3의 **20% 표본 검수**로 갈음됩니다 — 46건 중 10건.

표본에서 **반려가 한 건이라도 나오면 불일치율이 5%를 넘으므로 batch 전건 재검수**입니다
(10건 중 1건 = 10%). 더 보고 싶으시면 아래 전체 목록에서 골라 보셔도 됩니다.

아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `recurring_context` 6/46 = **13%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 46건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.52 | 0.38 | cand-durable-en4-6 ~ cand-durable-en5-4 |
| 0.52 | 0.38 | cand-durable-en5-4 ~ succ-durable-en-131 |
| 0.46 | 0.41 | cand-durable-en4-22 ~ cand-durable-en5-12 |
| 0.46 | 0.41 | cand-durable-en5-12 ~ succ-durable-en-147 |
| 0.44 | 0.21 | cand-durable-en3-16 ~ cand-durable-en4-21 |
| 0.44 | 0.21 | cand-durable-en3-16 ~ succ-durable-en-146 |
| 0.43 | 0.19 | cand-durable-en2-1 ~ cand-durable-en3-1 |
| 0.42 | 0.17 | cand-durable-en2-1 ~ cand-durable-en4-6 |
| 0.42 | 0.17 | cand-durable-en2-1 ~ succ-durable-en-131 |
| 0.42 | 0.39 | cand-durable-en3-1 ~ cand-durable-en4-6 |

---

> **아래 판정란은 에이전트가 옮겨 적은 전사입니다.** 2026-08-26 대화에서 운영자가
> 「1. 배치 시트 승인합니다」라고 보고한 판정을 그대로 옮긴 것이고, 지어낸 값은
> 없습니다. `AGENTS.md`「기록을 채우는 경계는 관측과 판정입니다」에 따라 **판정은
> 사람의 것**이므로, 운영자가 각 줄을 확인한 뒤 확정합니다. 확인 전에는 채워져
> 있어도 검수가 성립하지 않습니다.
>
> **`초안 생성자` 칸은 비워 두었습니다.** 이 저장소에 남기는 산출물에 에이전트의
> 모델 식별자를 적지 않는다는 규칙이 있어, 그 칸을 채울 수 있는 것은 운영자뿐입니다.


## 표본 — 판정할 10건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### succ-durable-en-126

**제안 gold label**: `constraint` — 키워드 `gluten`

> **사용자** I'm coeliac, so gluten is completely off the table for me.
>
> **assistant** I'll keep everything gluten free.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-131

**제안 gold label**: `identity` — 키워드 `cardiff`

> **사용자** I'm in Cardiff and have been for most of my adult life.
>
> **assistant** I'll keep things local to there.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-135

**제안 gold label**: `preference` — 키워드 `newspaper`

> **사용자** I read a printed newspaper. I don't use news apps at all.
>
> **assistant** I'll bear that in mind.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-139

**제안 gold label**: `occupation` — 키워드 `hygienist`; `recurring_context` — 키워드 `saturday`

> **사용자** I'm a dental hygienist. We run Saturday clinics too.
>
> **assistant** I'll assume that pattern.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-143

**제안 gold label**: `expertise` — 키워드 `calligraphy`; `explanation_depth` — 키워드 `script name`

> **사용자** I've done calligraphy for twenty years — you can use the proper script names.
>
> **assistant** I'll use them directly.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-147

**제안 gold label**: `long_term_goal` — 키워드 `poetry`

> **사용자** Publishing a poetry collection is the long-term aim. Still gathering the poems.
>
> **assistant** I'll treat that as the goal.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-150

**제안 gold label**: `project` — 키워드 `footpath`

> **사용자** I'm mapping the local footpaths, walking and recording them one by one.
>
> **assistant** I'll treat that as the running project.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-154

**제안 gold label**: `decision` — 키워드 `mortgage`

> **사용자** We decided to overpay the mortgage rather than invest. That's settled.
>
> **assistant** I'll work from that decision.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-158

**제안 gold label**: `relationship` — 키워드 `father-in-law`

> **사용자** My father-in-law lives with us, and household decisions go through him too.
>
> **assistant** I'll treat those as joint decisions.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-162

**제안 gold label**: `communication_style` — 키워드 `not sure`

> **사용자** If you're not sure, say you don't know. A made-up answer is worse than none.
>
> **assistant** I'll say so when I'm unsure.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

---

## batch 채택 결정

`docs/ops/memory-extraction-eval-dataset.md` §6.3: 표본만 보고 넘어가는 것은 채택이 아닙니다. 아래에 적어야 나머지가 dataset에 들어갑니다.

| 항목 | 값 |
|---|---|
| batch 채택 여부 | 채택 *(전사 — 확인 필요)* |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | 충분 *(전사 — 확인 필요)* |
| 검수 완료일 | 2026-08-26 *(전사 — 확인 필요)* |

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
| 검수자 (사람 · 최초의 권위 있는 판정) | @mposition *(전사 — 확인 필요)* |
| 재작성 회차 | 1 (최초 초안) |
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | 같음 *(전사 — 확인 필요)* |
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 10건에서 계산 |

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

## 전체 46건 (참고용 — 판정 불필요)

| # | 제안 kind | 키워드 | 첫 사용자 발화 |
|---|---|---|---|
| 1 **←표본** | `constraint` | `gluten` | I'm coeliac, so gluten is completely off the… |
| 2 | `constraint` | `fragrance` | I react badly to fragrance, so scented produ… |
| 3 | `constraint` | `drive` | I can't drive — never learned — so anything … |
| 4 | `constraint` | `weekend` | Weekends are completely spoken for. Nothing … |
| 5 | `constraint` | `printer` | There's no printer here, so please don't sug… |
| 6 **←표본** | `identity` | `cardiff` | I'm in Cardiff and have been for most of my … |
| 7 | `identity` | `1962` | Born in 1962, so retirement questions are li… |
| 8 | `identity` | `hard of hearing` | I'm hard of hearing in one ear. Phone calls … |
| 9 | `identity` | `dual citizenship` | I have dual citizenship, so paperwork usuall… |
| 10 **←표본** | `preference` | `newspaper` | I read a printed newspaper. I don't use news… |
| 11 | `preference` | `subtitle` | I watch everything with subtitles on, even i… |
| 12 | `preference` | `alone` | I actually prefer eating alone. Group meals … |
| 13 | `preference` | `cash` | I pay in cash wherever I can. Card-only plac… |
| 14 **←표본** | `occupation` | `hygienist` | I'm a dental hygienist. We run Saturday clin… |
| 15 | `occupation` | `orchard` | I run an apple orchard. During harvest I'm u… |
| 16 | `occupation` | `school cook` | I'm a school cook, so my day ends early but … |
| 17 | `occupation` | `decorator` | I'm a decorator. Different site every week, … |
| 18 **←표본** | `expertise` | `calligraphy` | I've done calligraphy for twenty years — you… |
| 19 | `expertise` | `engine` | Engines are my trade. You don't need to expl… |
| 20 | `expertise` | `portuguese` | I'm a complete beginner in Portuguese. I don… |
| 21 | `expertise` | `lifeguard` | I'm a qualified lifeguard, so water safety t… |
| 22 **←표본** | `long_term_goal` | `poetry` | Publishing a poetry collection is the long-t… |
| 23 | `long_term_goal` | `abroad` | The plan is to move abroad eventually. Every… |
| 24 | `long_term_goal` | `social work` | I want to retrain into social work. I'm look… |
| 25 **←표본** | `project` | `footpath` | I'm mapping the local footpaths, walking and… |
| 26 | `project` | `album` | My band is recording an album. Five tracks d… |
| 27 | `project` | `barn` | I'm converting an old barn. It's a weekends-… |
| 28 | `decision` | `television` | We got rid of the television and we're not g… |
| 29 **←표본** | `decision` | `mortgage` | We decided to overpay the mortgage rather th… |
| 30 | `decision` | `side business` | I wound down the side business deliberately.… |
| 31 | `relationship` | `mother` | My mother is in a care home and I visit twic… |
| 32 | `relationship` | `daughter` | My daughter is at university, so the house i… |
| 33 **←표본** | `relationship` | `father-in-law` | My father-in-law lives with us, and househol… |
| 34 | `recurring_context` | `october` | Every October is appraisal season and it swa… |
| 35 | `recurring_context` | `saturday` | Saturday mornings are football, every week, … |
| 36 | `recurring_context` | `peak season` | Summer is peak season for us, so those three… |
| 37 **←표본** | `communication_style` | `not sure` | If you're not sure, say you don't know. A ma… |
| 38 | `communication_style` | `jargon` | Keep the jargon but put a short gloss in bra… |
| 39 | `tone` | `joke` | No jokes, please. Straight answers only. |
| 40 | `verbosity` | `one paragraph` | One paragraph per answer. I'll ask if I want… |
| 41 | `structure` | `numbered` | Anything procedural should come as numbered … |
| 42 | `formatting` | `emoji` | Please don't use emoji. I paste a lot of thi… |
| 43 | `language` | `italian` | Answer in Italian from now on — I'm trying t… |
| 44 | `explanation_depth` | `twelve` | Explain things as you would to a twelve year… |
| 45 | `citation_preference` | `year` | When you cite something, give me the publica… |
| 46 | `code_style` | `single file` | Give code examples as a single file rather t… |

