# batch-016 — `durable_facts:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-016`
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
| 0.25 | 0.12 | cand-durable-en5-12 ~ cand-durable-en5-15 |
| 0.25 | 0.00 | cand-durable-en-19 ~ cand-durable-en-20 |
| 0.23 | 0.07 | cand-durable-en-19 ~ cand-durable-en5-1 |
| 0.23 | 0.23 | cand-durable-en-5 ~ cand-durable-en5-5 |
| 0.22 | 0.08 | cand-durable-en5-18 ~ cand-durable-en5-21 |
| 0.21 | 0.06 | cand-durable-en5-11 ~ cand-durable-en5-19 |
| 0.21 | 0.08 | cand-durable-en-9 ~ cand-durable-en5-20 |
| 0.21 | 0.05 | durable-en-4 ~ cand-durable-en5-15 |
| 0.21 | 0.10 | cand-durable-en-17 ~ cand-durable-en-22 |
| 0.21 | 0.06 | cand-durable-en5-8 ~ cand-durable-en5-12 |

---

## 표본 — 판정할 5건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### cand-durable-en5-1

**제안 gold label**: `constraint` — 키워드 `dizzy`

> **사용자** I get dizzy if I stand for long, so anything that needs me on my feet is out.
>
> **assistant** I'll suggest seated options.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en5-6

**제안 gold label**: `preference` — 키워드 `handwritten`

> **사용자** My notes are handwritten. Typing them out doesn't stick for me.
>
> **assistant** I'll shape things so they're easy to copy by hand.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en5-11

**제안 gold label**: `expertise` — 키워드 `masonry`

> **사용자** Stone masonry is my trade, so the terminology is fine as-is.
>
> **assistant** I'll keep the terms.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en5-16

**제안 gold label**: `decision` — 키워드 `gym`

> **사용자** I cancelled the gym membership and I'm training at home instead. That's decided.
>
> **assistant** I'll suggest home options only.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-durable-en5-21

**제안 gold label**: `recurring_context` — 키워드 `thursday`

> **사용자** Thursdays are a late finish for me, every week.
>
> **assistant** I'll leave Thursday evenings out.

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
| 1 **←표본** | `constraint` | `dizzy` | I get dizzy if I stand for long, so anything… |
| 2 | `constraint` | `stairs` | I can't manage stairs. Ground floor or a lif… |
| 3 | `constraint` | `laptop` | My laptop is ten years old. Anything heavy s… |
| 4 | `identity` | `belfast` | I'm in Belfast, and have been for twenty yea… |
| 5 | `identity` | `2001` | I was born in 2001 — I've only just started … |
| 6 **←표본** | `preference` | `handwritten` | My notes are handwritten. Typing them out do… |
| 7 | `preference` | `markets` | I shop at markets rather than supermarkets w… |
| 8 | `occupation` | `cabin crew` | I'm cabin crew, so I'm away about ten days a… |
| 9 | `occupation` | `fisherman` | I'm a fisherman. The weather rewrites my wee… |
| 10 | `expertise` | `chess` | I've played chess seriously for years — no n… |
| 11 **←표본** | `expertise` | `masonry` | Stone masonry is my trade, so the terminolog… |
| 12 | `long_term_goal` | `hostel` | Opening a walkers' hostel is the long-term p… |
| 13 | `long_term_goal` | `woodwork` | I want to turn woodwork into an actual busin… |
| 14 | `project` | `comic` | I draw a comic, one page a fortnight. It's j… |
| 15 | `project` | `conference` | I'm preparing a conference talk for the autu… |
| 16 **←표본** | `decision` | `gym` | I cancelled the gym membership and I'm train… |
| 17 | `decision` | `city` | We decided against moving to the city. That … |
| 18 | `relationship` | `grandson` | I look after my grandson three days a week. |
| 19 | `relationship` | `brother-in-law` | I run the shop with my brother-in-law, so mo… |
| 20 | `recurring_context` | `march` | Every March I have my annual check-ups. That… |
| 21 **←표본** | `recurring_context` | `thursday` | Thursdays are a late finish for me, every we… |
| 22 | `communication_style` | `example` | Show me an example before the explanation. I… |
| 23 | `verbosity` | `five lines` | About five lines is right for me. Longer tha… |
| 24 | `formatting` | `code block` | Put commands in a code block. Copying them o… |
| 25 | `citation_preference` | `links` | Keep links out of the body and gather them a… |

