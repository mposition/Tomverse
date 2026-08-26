# batch-106 — `durable_facts:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-106`
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
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `constraint` 6/25 = **24%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 25건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.52 | 0.38 | cand-durable-en4-6 ~ cand-durable-en5-4 |
| 0.46 | 0.41 | cand-durable-en4-22 ~ cand-durable-en5-12 |
| 0.44 | 0.21 | cand-durable-en3-16 ~ cand-durable-en4-21 |
| 0.43 | 0.19 | cand-durable-en2-1 ~ cand-durable-en3-1 |
| 0.42 | 0.17 | cand-durable-en2-1 ~ cand-durable-en4-6 |
| 0.42 | 0.39 | cand-durable-en3-1 ~ cand-durable-en4-6 |
| 0.41 | 0.19 | cand-durable-en3-23 ~ cand-durable-en4-27 |
| 0.41 | 0.32 | cand-durable-en3-1 ~ cand-durable-en5-4 |
| 0.41 | 0.19 | cand-durable-en4-21 ~ cand-durable-en5-11 |
| 0.39 | 0.24 | cand-durable-en2-17 ~ cand-durable-en5-12 |

---

> **아래 판정란은 에이전트가 옮겨 적은 전사이고, 운영자가 확정했습니다.**
> 2026-08-26에 운영자가 「1. 배치 시트 승인합니다」라고 보고한 판정을 옮긴 뒤,
> 같은 날 「검수자: mposition / 검수일: 2026-08-26 / batch 결정: 채택 / 전건
> 채택」으로 32개 시트 전체를 확인했습니다. 지어낸 값은 없습니다.
>
> **`초안 생성자` 칸은 비워 두었습니다.** 이 저장소에 남기는 산출물에 에이전트의
> 모델 식별자를 적지 않는다는 규칙이 있어, 그 칸을 채울 수 있는 것은 운영자뿐입니다.


## 표본 — 판정할 5건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### succ-durable-en-51

**제안 gold label**: `decision` — 키워드 `renting`

> **사용자** We decided to keep renting rather than buy. It's a deliberate choice, not a temporary one.
>
> **assistant** I'll stop framing options around ownership.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-56

**제안 gold label**: `relationship` — 키워드 `co-founder`

> **사용자** I have a co-founder, and any decision about equity or hiring goes through both of us.
>
> **assistant** I'll frame those as joint decisions.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-61

**제안 gold label**: `constraint` — 키워드 `30 minutes`

> **사용자** I have about 30 minutes a day for this and no more. Plans that assume two hours are useless to me.
>
> **assistant** I'll size everything to that.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-66

**제안 gold label**: `communication_style` — 키워드 `disclaimer`

> **사용자** Please drop the disclaimers. Just tell me what you think and I'll decide what to do with it.
>
> **assistant** I'll answer directly.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-71

**제안 gold label**: `formatting` — 키워드 `table`

> **사용자** Use tables when you're comparing things. Prose comparisons are hard for me to follow.
>
> **assistant** I'll put comparisons in a table.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

---

## batch 채택 결정

`docs/ops/memory-extraction-eval-dataset.md` §6.3: 표본만 보고 넘어가는 것은 채택이 아닙니다. 아래에 적어야 나머지가 dataset에 들어갑니다.

| 항목 | 값 |
|---|---|
| batch 채택 여부 | 채택 |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | 충분 |
| 검수 완료일 | 2026-08-26 |

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
| 검수자 (사람 · 최초의 권위 있는 판정) | @mposition |
| 재작성 회차 | 1 (최초 초안) |
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | 같음 |
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
| 1 **←표본** | `decision` | `renting` | We decided to keep renting rather than buy. … |
| 2 | `decision` | `car` | We got rid of the car last year and decided … |
| 3 | `decision` | `supplier` | After the last mess we decided to consolidat… |
| 4 | `constraint` | `gluten` + `home` | My daughter is coeliac, so anything I cook a… |
| 5 | `relationship` | `mother` + `japan` | My mother lives in Japan and I visit twice a… |
| 6 **←표본** | `relationship` | `co-founder` | I have a co-founder, and any decision about … |
| 7 | `relationship` | `flatmate` | I live with three flatmates, so anything inv… |
| 8 | `constraint` | `internet` | My internet at home is barely faster than di… |
| 9 | `constraint` | `shellfish` | Severe shellfish allergy here. Please never … |
| 10 | `constraint` | `windows` | I'm on Windows only. No Mac, no Linux box, s… |
| 11 **←표본** | `constraint` | `30 minutes` | I have about 30 minutes a day for this and n… |
| 12 | `constraint` | `phone` | I can't take phone calls at work, so anythin… |
| 13 | `recurring_context` | `monday` | Every Monday morning I'm in a two-hour revie… |
| 14 | `recurring_context` | `quarter` | We close the books at the end of each quarte… |
| 15 | `recurring_context` | `school run` | I do the school run at half three every week… |
| 16 **←표본** | `communication_style` | `disclaimer` | Please drop the disclaimers. Just tell me wh… |
| 17 | `communication_style` | `clarifying` | If my question is ambiguous, ask me one clar… |
| 18 | `tone` | `formal` | Keep it formal, please. I often paste your a… |
| 19 | `verbosity` | `short` | Short answers. A paragraph at most unless I … |
| 20 | `structure` | `conclusion` | Give me the conclusion first and the reasoni… |
| 21 **←표본** | `formatting` | `table` | Use tables when you're comparing things. Pro… |
| 22 | `language` | `german` | Answer me in German even when I write in Eng… |
| 23 | `explanation_depth` | `trade-off` | Don't just give me the recommendation — walk… |
| 24 | `citation_preference` | `primary` | When you cite something, point me at primary… |
| 25 | `code_style` | `test` | Any code example you give me should come wit… |

