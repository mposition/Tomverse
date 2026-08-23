# batch-010 — `durable_facts:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-010`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 10건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

이 batch는 범주 ①이라 `docs/ops/memory-extraction-eval-dataset.md` §6.3의 **20% 표본 검수**로 갈음됩니다 — 50건 중 10건.

표본에서 **반려가 한 건이라도 나오면 불일치율이 5%를 넘으므로 batch 전건 재검수**입니다
(10건 중 1건 = 10%). 더 보고 싶으시면 아래 전체 목록에서 골라 보셔도 됩니다.

아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `constraint` 5/50 = **10%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 50건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.32 | 0.20 | durable-en-2 ~ cand-durable-en2-44 |
| 0.31 | 0.07 | cand-durable-en-17 ~ cand-durable-en2-26 |
| 0.27 | 0.15 | cand-durable-en-24 ~ cand-durable-en2-47 |
| 0.27 | 0.05 | cand-durable-en2-41 ~ cand-durable-en2-45 |
| 0.26 | 0.08 | cand-durable-en2-29 ~ cand-durable-en2-33 |
| 0.25 | 0.12 | cand-durable-en-4 ~ cand-durable-en2-2 |
| 0.25 | 0.12 | cand-durable-en-5 ~ cand-durable-en2-2 |
| 0.25 | 0.10 | cand-durable-en-24 ~ cand-durable-en2-43 |
| 0.25 | 0.10 | cand-durable-en2-20 ~ cand-durable-en2-21 |
| 0.25 | 0.00 | cand-durable-en-19 ~ cand-durable-en-20 |

---

## 표본 — 판정할 10건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### cand-durable-en2-1

**제안 gold label**: `identity` — 키워드 `halifax`

> **사용자** I've lived in Halifax my whole life and I'm not moving.
>
> **assistant** I'll keep suggestions local to there.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-6

**제안 gold label**: `preference` — 키워드 `train`

> **사용자** For anything under six hours I'd rather take the train than fly.
>
> **assistant** I'll price rail first on those routes.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-11

**제안 gold label**: `occupation` — 키워드 `electrician`

> **사용자** I'm a self-employed electrician, so my invoicing questions are about my own books.
>
> **assistant** Understood — sole trader, then.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-16

**제안 gold label**: `expertise` — 키워드 `accessibility`

> **사용자** Accessibility auditing is what I do professionally, so WCAG references are fine as-is.
>
> **assistant** I'll cite the criteria directly.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-21

**제안 gold label**: `project` — 키워드 `greenhouse`

> **사용자** I'm building a greenhouse in the back garden. It'll take me most of the summer.
>
> **assistant** I'll assume that's the project when you mention the build.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-26

**제안 gold label**: `decision` — 키워드 `renting`

> **사용자** We decided to keep renting rather than buy. It's a deliberate choice, not a temporary one.
>
> **assistant** I'll stop framing options around ownership.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-31

**제안 gold label**: `relationship` — 키워드 `co-founder`

> **사용자** I have a co-founder, and any decision about equity or hiring goes through both of us.
>
> **assistant** I'll frame those as joint decisions.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-36

**제안 gold label**: `constraint` — 키워드 `30` + `minutes`

> **사용자** I have about 30 minutes a day for this and no more. Plans that assume two hours are useless to me.
>
> **assistant** I'll size everything to that.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-41

**제안 gold label**: `communication_style` — 키워드 `disclaimers`

> **사용자** Please drop the disclaimers. Just tell me what you think and I'll decide what to do with it.
>
> **assistant** I'll answer directly.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en2-46

**제안 gold label**: `formatting` — 키워드 `tables`

> **사용자** Use tables when you're comparing things. Prose comparisons are hard for me to follow.
>
> **assistant** I'll put comparisons in a table.

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
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 10건에서 계산 |

초안 생성자 칸을 에이전트가 비워 두는 이유는 하나입니다 — 이 저장소에 남기는
산출물에 에이전트의 모델 식별자를 적지 않는다는 규칙이 있어서, 자기 이름을 적을
수 있는 것은 운영자뿐입니다.

---

## 전체 50건 (참고용 — 판정 불필요)

| # | 제안 kind | 키워드 | 첫 사용자 발화 |
|---|---|---|---|
| 1 **←표본** | `identity` | `halifax` | I've lived in Halifax my whole life and I'm … |
| 2 | `identity` | `1988` | Born in 1988, if that matters for any of the… |
| 3 | `identity` | `twin` | I have an identical twin, which comes up mor… |
| 4 | `identity` | `colour` + `blind` | I'm red-green colour blind, so don't tell me… |
| 5 | `preference` | `night` | I do all my real work at night. Mornings are… |
| 6 **←표본** | `preference` | `train` | For anything under six hours I'd rather take… |
| 7 | `preference` | `secondhand` | I buy almost everything secondhand. It's a h… |
| 8 | `preference` | `paper` | I read on paper. E-books just don't stick fo… |
| 9 | `occupation` | `midwife` | I'm a midwife. Twelve-hour shifts, mostly ni… |
| 10 | `occupation` | `archivist` | I work as an archivist at a county records o… |
| 11 **←표본** | `occupation` | `electrician` | I'm a self-employed electrician, so my invoi… |
| 12 | `occupation` | `translator` | I'm a freelance translator working on legal … |
| 13 | `expertise` | `statistics` | I have a graduate background in statistics, … |
| 14 | `expertise` | `sailing` | I've been sailing since I was a kid. Points … |
| 15 | `expertise` | `new` + `gardening` | I'm completely new to gardening. I don't kno… |
| 16 **←표본** | `expertise` | `accessibility` | Accessibility auditing is what I do professi… |
| 17 | `long_term_goal` | `sabbatical` | The long-term plan is a year-long sabbatical… |
| 18 | `long_term_goal` | `citizenship` | I'm working toward citizenship here. It's a … |
| 19 | `long_term_goal` | `debt` | Everything I'm doing financially is aimed at… |
| 20 | `long_term_goal` | `teach` | Eventually I want to teach at a community co… |
| 21 **←표본** | `project` | `greenhouse` | I'm building a greenhouse in the back garden… |
| 22 | `project` | `podcast` | I run a small podcast about local history. T… |
| 23 | `project` | `thesis` | My thesis is on coastal erosion. I'm in the … |
| 24 | `project` | `bike` | I'm restoring a 1970s motorbike in the garag… |
| 25 | `decision` | `postgres` | We settled on Postgres for the new service. … |
| 26 **←표본** | `decision` | `renting` | We decided to keep renting rather than buy. … |
| 27 | `decision` | `car` | We got rid of the car last year and decided … |
| 28 | `decision` | `one` + `supplier` | After the last mess we decided to consolidat… |
| 29 | `relationship` | `daughter` + `coeliac` | My daughter is coeliac, so anything I cook a… |
| 30 | `relationship` | `mother` + `japan` | My mother lives in Japan and I visit twice a… |
| 31 **←표본** | `relationship` | `co-founder` | I have a co-founder, and any decision about … |
| 32 | `relationship` | `flatmates` | I live with three flatmates, so anything inv… |
| 33 | `constraint` | `dial-up` | My internet at home is barely faster than di… |
| 34 | `constraint` | `shellfish` | Severe shellfish allergy here. Please never … |
| 35 | `constraint` | `windows` | I'm on Windows only. No Mac, no Linux box, s… |
| 36 **←표본** | `constraint` | `30` + `minutes` | I have about 30 minutes a day for this and n… |
| 37 | `constraint` | `phone` + `calls` | I can't take phone calls at work, so anythin… |
| 38 | `recurring_context` | `monday` | Every Monday morning I'm in a two-hour revie… |
| 39 | `recurring_context` | `quarter` | We close the books at the end of each quarte… |
| 40 | `recurring_context` | `school` + `run` | I do the school run at half three every week… |
| 41 **←표본** | `communication_style` | `disclaimers` | Please drop the disclaimers. Just tell me wh… |
| 42 | `communication_style` | `question` | If my question is ambiguous, ask me one clar… |
| 43 | `tone` | `formal` | Keep it formal, please. I often paste your a… |
| 44 | `verbosity` | `short` | Short answers. A paragraph at most unless I … |
| 45 | `structure` | `conclusion` + `first` | Give me the conclusion first and the reasoni… |
| 46 **←표본** | `formatting` | `tables` | Use tables when you're comparing things. Pro… |
| 47 | `language` | `german` | Answer me in German even when I write in Eng… |
| 48 | `explanation_depth` | `trade-offs` | Don't just give me the recommendation — walk… |
| 49 | `citation_preference` | `primary` + `sources` | When you cite something, point me at primary… |
| 50 | `code_style` | `test` | Any code example you give me should come wit… |

