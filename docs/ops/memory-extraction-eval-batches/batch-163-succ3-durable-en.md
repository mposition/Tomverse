# batch-163 — `durable_facts:en` 대체 케이스 (`mem-eval-succ-3`)

> **자동 생성 파일입니다.** `npm run make:memory-eval-succ3-records` 로 다시
> 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요.

## 이 batch가 무엇인가

`mem-eval-succ-3`을 위해 **새로 쓴 20건**입니다. 규칙을 쓴 케이스가
`lib/memoryEvalRegressionCorpus/` 로 빠지면서 `durable_facts:en` 이 §12.2 하한
아래로 내려가므로, 같은 경계를 재되 **상황을 바꿔** 그 자리를 채웁니다.

바꾼 것은 문장이 아니라 상황입니다. 명사만 갈아 끼운 대체는 `mem-extract-v5`가
자기가 쓰여진 문장에 답하게 두는 것이고, 원본이 decision set을 떠나므로 기계로는
잡히지 않습니다. `tests/memoryEvalReplacementPlan.test.mjs` 가 succ-2의 어떤
케이스와도 token 유사도 0.45를 넘지 않도록 잡습니다.

## 전건 — 판정할 20건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다.

> **아래 판정란은 에이전트가 옮겨 적은 전사입니다.** 2026-08-27 대화에서
> 운영자가 「판정결과: 통과 / 승인자: mposition / 승인일자: 2026-08-27」이라고
> 보고한 판정을 그대로 옮긴 것이고, 지어낸 값은 없습니다.
> `AGENTS.md`「기록을 채우는 경계는 관측과 판정입니다」에 따라 **판정은 사람의
> 것**이므로, 운영자가 각 줄을 확인한 뒤 확정합니다.

### succ-durable-en-301

`succ-durable-en-105` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `recurring_context` — [rota] · bulk_safe

> **사용자** My partner works nights at a depot, so our week runs on a two-week rota.
>
> **assistant** I'll treat the schedule as rotating.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-302

`succ-durable-en-106` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `constraint` — [bathroom] · bulk_safe

> **사용자** There's one bathroom for the whole house, so anything with a fixed morning routine won't work.
>
> **assistant** I won't assume a free slot in the morning.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-303

`succ-durable-en-133` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `constraint` — [disc] · sensitive_review

> **사용자** I have a slipped disc, so I can't sit through anything longer than about twenty minutes.
>
> **assistant** I'll keep sessions short.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-304

`succ-durable-en-134` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `identity` — [tax resident] · bulk_safe

> **사용자** I'm a tax resident in two countries, which means the rules are never just one set.
>
> **assistant** I'll cover both where it matters.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-305

`succ-durable-en-144` 를 대신합니다 (v4-kind-guide · §4.4).

**제안 gold label**: `occupation` — [kitchen] · bulk_safe / `explanation_depth` — [term] · bulk_safe

> **사용자** I've been fitting kitchens for twenty years, so you can say "carcass" and "scribe" without unpacking the terms.
>
> **assistant** I'll leave them as they are.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-306

`succ-durable-en-145` 를 대신합니다 (rule-5 · §6).

**제안 gold label**: `expertise` — [sail] · 택1 [first, beginner, new to, no experience, novice, just start, starting out] · bulk_safe

> **사용자** This is my first season sailing. I don't know any of the knots yet.
>
> **assistant** I'll start from the basics.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-307

`succ-durable-en-156` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `recurring_context` — [tuesday] · bulk_safe

> **사용자** I drive my neighbour to her appointment every Tuesday morning.
>
> **assistant** I'll keep Tuesday mornings blocked.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-308

`succ-durable-en-182` 를 대신합니다 (v4-kind-guide · §4.4).

**제안 gold label**: `occupation` — [potter] · bulk_safe / `explanation_depth` — [term] · bulk_safe

> **사용자** I glaze pottery for a living, so terms like bisque can go in without a gloss.
>
> **assistant** I'll use them directly.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-309

`succ-durable-en-189` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `recurring_context` — [thursday] · bulk_safe

> **사용자** I collect my niece from school every Thursday and Friday.
>
> **assistant** I'll account for those afternoons.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-310

`succ-durable-en-190` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [cousin] · bulk_safe / `occupation` — [baker] · bulk_safe / `recurring_context` — [sunday] · bulk_safe

> **사용자** I run a bakery with my cousin, and we set the following week's orders together every Sunday.
>
> **assistant** I'll treat those as joint calls.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-311

`succ-durable-en-28` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `relationship` — [brother] · bulk_safe

> **사용자** I was adopted, and I have two older brothers who weren't.
>
> **assistant** Noted.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-312

`succ-durable-en-29` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `constraint` — [tinnitus] · sensitive_review

> **사용자** I have tinnitus, so anything that relies on hearing a tone won't work for me.
>
> **assistant** I'll avoid audio cues.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-313

`succ-durable-en-30` 를 대신합니다 (rule-4 · §6).

**제안 gold label**: `recurring_context` — [evening] · bulk_safe

> **사용자** I work in two blocks, early morning and late evening, with the middle of the day gone.
>
> **assistant** I'll plan around the gap.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-314

`succ-durable-en-41` 를 대신합니다 (v4-kind-guide · §4.4).

**제안 gold label**: `occupation` — [catchment] · bulk_safe

> **사용자** Catchment modelling is my day job. I'm asking about the reporting side.
>
> **assistant** I'll focus on reporting.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-315

`succ-durable-en-56` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [brother] · bulk_safe / `recurring_context` — [month] · bulk_safe

> **사용자** My brother and I share an account for the flat, and we reconcile it at the end of every month.
>
> **assistant** I'll frame those as joint decisions.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-316

`succ-durable-en-57` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [artist] · bulk_safe / `constraint` — [space] · bulk_safe

> **사용자** I share a studio with four other artists, so anything that needs quiet or floor space is constrained.
>
> **assistant** I'll account for the shared space.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-317

`succ-durable-en-78` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `constraint` — [shoulder] · bulk_safe

> **사용자** I'm quite short, so anything stored above shoulder height is out for me.
>
> **assistant** I'll keep suggestions within reach.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-318

`succ-durable-en-79` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `relationship` — [youngest] · bulk_safe

> **사용자** I'm the youngest of five, which shapes most of how family things get decided.
>
> **assistant** Understood.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-319

`succ-durable-en-83` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `formatting` — [24-hour] · bulk_safe

> **사용자** Always give me times on the 24-hour clock. AM and PM slow me down.
>
> **assistant** I'll use the 24-hour clock throughout.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-320

`succ-durable-en-91` 를 대신합니다 (v4-kind-guide · §4.4).

**제안 gold label**: `expertise` — [diving] · bulk_safe / `explanation_depth` — [decompression] · bulk_safe

> **사용자** I hold a rescue diving certification, though I've never worked in the field — decompression tables can go in unexplained.
>
> **assistant** I'll use them as they are.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |


---

## batch 채택 결정

| 항목 | 값 |
|---|---|
| batch 채택 여부 | 채택 |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | 충분 |
| 검수 완료일 | 2026-08-27 |
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | 다름 (전건 검수) |

| 항목 | 값 |
|---|---|
| 판정 | 통과 |
| 승인일 | 2026-08-27 |

「초안 구성이 직전 batch와 같은가」가 `다름`이므로 표본이 아니라 **전건**을
판정했습니다 — 위 20건 전부에 판정란이 있습니다.

## batch 기록 (`docs/ops/memory-extraction-eval-dataset.md` §8)

| 항목 | 값 |
|---|---|
| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) |  |
| 검수자 (사람 · 최초의 권위 있는 판정) | @mposition |
| 재작성 회차 | 1 (최초 초안) |

**초안 생성자 칸은 비어 있고, 채울 수 있는 것은 운영자뿐입니다.** 이 저장소에
남기는 산출물에 에이전트가 자기 모델 식별자를 적지 않는다는 규칙이 있어서,
succ-2의 기록에서도 같은 이유로 사람이 적었습니다. §7.1의 일곱 조건 중
「초안 도구·모델·버전 기록」이 이 칸 하나에 걸려 있고,
`npm run check:memory-eval-freeze` 가 채워질 때까지 succ-3을 미충족으로
보고합니다.
