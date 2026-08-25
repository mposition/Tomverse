# batch-114 — `durable_facts:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-114`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 6건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

이 batch는 범주 ①이라 `docs/ops/memory-extraction-eval-dataset.md` §6.3의 **20% 표본 검수**로 갈음됩니다 — 29건 중 6건.

표본에서 **반려가 한 건이라도 나오면 불일치율이 5%를 넘으므로 batch 전건 재검수**입니다
(6건 중 1건 = 17%). 더 보고 싶으시면 아래 전체 목록에서 골라 보셔도 됩니다.

아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `constraint` 4/29 = **14%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 29건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.52 | 0.38 | cand-durable-en4-6 ~ cand-durable-en5-4 |
| 0.52 | 0.38 | cand-durable-en4-6 ~ succ-durable-en-175 |
| 0.46 | 0.41 | cand-durable-en4-22 ~ cand-durable-en5-12 |
| 0.46 | 0.41 | cand-durable-en4-22 ~ succ-durable-en-183 |
| 0.44 | 0.21 | cand-durable-en3-16 ~ cand-durable-en4-21 |
| 0.43 | 0.19 | cand-durable-en2-1 ~ cand-durable-en3-1 |
| 0.42 | 0.17 | cand-durable-en2-1 ~ cand-durable-en4-6 |
| 0.42 | 0.39 | cand-durable-en3-1 ~ cand-durable-en4-6 |
| 0.41 | 0.19 | cand-durable-en3-23 ~ cand-durable-en4-27 |
| 0.41 | 0.32 | cand-durable-en3-1 ~ cand-durable-en5-4 |

---

## 표본 — 판정할 6건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### succ-durable-en-172

**제안 gold label**: `constraint` — 키워드 `dizzy`

> **사용자** I get dizzy if I stand for long, so anything that needs me on my feet is out.
>
> **assistant** I'll suggest seated options.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-en-176

**제안 gold label**: `identity` — 키워드 `2001`

> **사용자** I was born in 2001 — I've only just started working.
>
> **assistant** I'll answer at that stage.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-en-180

**제안 gold label**: `occupation` — 키워드 `fisherman`; `recurring_context` — 키워드 `weather`

> **사용자** I'm a fisherman. The weather rewrites my week most weeks.
>
> **assistant** I won't assume a fixed schedule.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-en-184

**제안 gold label**: `long_term_goal` — 키워드 `woodwork`

> **사용자** I want to turn woodwork into an actual business eventually.
>
> **assistant** I'll frame things around that.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-en-188

**제안 gold label**: `decision` — 키워드 `city`

> **사용자** We decided against moving to the city. That question is closed.
>
> **assistant** I'll assume you're staying put.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-en-192

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
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | |
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 6건에서 계산 |

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

## 전체 29건 (참고용 — 판정 불필요)

| # | 제안 kind | 키워드 | 첫 사용자 발화 |
|---|---|---|---|
| 1 **←표본** | `constraint` | `dizzy` | I get dizzy if I stand for long, so anything… |
| 2 | `constraint` | `stairs` | I can't manage stairs. Ground floor or a lif… |
| 3 | `constraint` | `laptop` | My laptop is ten years old. Anything heavy s… |
| 4 | `identity` | `belfast` | I'm in Belfast, and have been for twenty yea… |
| 5 **←표본** | `identity` | `2001` | I was born in 2001 — I've only just started … |
| 6 | `preference` | `handwritten` | My notes are handwritten. Typing them out do… |
| 7 | `preference` | `market` | I shop at markets rather than supermarkets w… |
| 8 | `occupation` | `cabin crew` | I'm cabin crew, so I'm away about ten days a… |
| 9 **←표본** | `occupation` | `fisherman` | I'm a fisherman. The weather rewrites my wee… |
| 10 | `expertise` | `chess` | I've played chess seriously for years — no n… |
| 11 | `expertise` | `masonry` | Stone masonry is my trade, so the terminolog… |
| 12 | `long_term_goal` | `hostel` | Opening a walkers' hostel is the long-term p… |
| 13 **←표본** | `long_term_goal` | `woodwork` | I want to turn woodwork into an actual busin… |
| 14 | `project` | `comic` | I draw a comic, one page a fortnight. It's j… |
| 15 | `project` | `conference` | I'm preparing a conference talk for the autu… |
| 16 | `decision` | `gym` | I cancelled the gym membership and I'm train… |
| 17 **←표본** | `decision` | `city` | We decided against moving to the city. That … |
| 18 | `relationship` | `grandson` | I look after my grandson three days a week. |
| 19 | `relationship` | `brother-in-law` | I run the shop with my brother-in-law, so mo… |
| 20 | `recurring_context` | `march` | Every March I have my annual check-ups. That… |
| 21 **←표본** | `recurring_context` | `thursday` | Thursdays are a late finish for me, every we… |
| 22 | `structure` | `example` | Show me an example before the explanation. I… |
| 23 | `verbosity` | `five lines` | About five lines is right for me. Longer tha… |
| 24 | `formatting` | `code block` | Put commands in a code block. Copying them o… |
| 25 | `citation_preference` | `link` | Keep links out of the body and gather them a… |
| 26 | `occupation` | `backend` | I work as a backend engineer and I've been d… |
| 27 | `verbosity` | `short` | Please keep answers short. Long explanations… |
| 28 | `constraint` | `lactose` | I'm lactose intolerant, so no dairy in anyth… |
| 29 | `project` | `inventory` + `rust` | My side project is an inventory tracker I'm … |

