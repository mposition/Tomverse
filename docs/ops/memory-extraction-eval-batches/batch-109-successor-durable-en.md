# batch-109 — `durable_facts:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-109`
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
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `identity` 4/25 = **16%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 25건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.52 | 0.38 | cand-durable-en4-6 ~ cand-durable-en5-4 |
| 0.46 | 0.41 | cand-durable-en4-22 ~ cand-durable-en5-12 |
| 0.44 | 0.21 | cand-durable-en3-16 ~ cand-durable-en4-21 |
| 0.44 | 0.21 | cand-durable-en4-21 ~ succ-durable-en-91 |
| 0.43 | 0.19 | cand-durable-en2-1 ~ cand-durable-en3-1 |
| 0.43 | 0.19 | cand-durable-en2-1 ~ succ-durable-en-76 |
| 0.42 | 0.17 | cand-durable-en2-1 ~ cand-durable-en4-6 |
| 0.42 | 0.39 | cand-durable-en3-1 ~ cand-durable-en4-6 |
| 0.42 | 0.39 | cand-durable-en4-6 ~ succ-durable-en-76 |
| 0.41 | 0.19 | cand-durable-en3-23 ~ cand-durable-en4-27 |

---

> **아래 판정란은 에이전트가 옮겨 적은 전사이고, 운영자가 확정했습니다.**
> 2026-08-26에 운영자가 「1. 배치 시트 승인합니다」라고 보고한 판정을 옮긴 뒤,
> 같은 날 「검수자: mposition / 검수일: 2026-08-26 / batch 결정: 채택 / 전건
> 채택」으로 32개 시트 전체를 확인했습니다. 지어낸 값은 없습니다.
>
> **`초안 생성자` 칸은 운영자가 2026-08-26에 채웠습니다** — 이 저장소에 남기는
> 산출물에 에이전트의 모델 식별자를 적지 않는다는 규칙이 있어, 그 칸을 채울 수
> 있는 것은 운영자뿐입니다.


## 표본 — 판정할 5건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### succ-durable-en-76

**제안 gold label**: `identity` — 키워드 `glasgow`

> **사용자** I'm in Glasgow and I've no plans to leave.
>
> **assistant** I'll keep things local to there.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-81

**제안 gold label**: `preference` — 키워드 `walking`

> **사용자** I'd rather have a walking meeting than sit in a room for an hour.
>
> **assistant** I'll suggest those where the format allows.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-86

**제안 gold label**: `occupation` — 키워드 `air traffic`; `recurring_context` — 키워드 `shift`

> **사용자** I work in air traffic control. The shift pattern is brutal and it rules everything else.
>
> **assistant** I'll plan around a rotating shift pattern.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-91

**제안 gold label**: `expertise` — 키워드 `first aid`; `explanation_depth` — 키워드 `clinical`

> **사용자** I'm a qualified first aid trainer, so you can use the clinical terms directly.
>
> **assistant** I'll use them as-is.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-en-96

**제안 gold label**: `project` — 키워드 `board game`

> **사용자** I'm designing a board game. It's been in playtesting for about a year.
>
> **assistant** I'll treat that as the ongoing project.

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
| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) | `ai-draft:claude-code/opus/2026-08` |
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
| 1 **←표본** | `identity` | `glasgow` | I'm in Glasgow and I've no plans to leave. |
| 2 | `identity` | `1995` | I was born in 1995 if any of this is age dep… |
| 3 | `identity` | `left-handed` | I'm left-handed, which matters more than peo… |
| 4 | `identity` | `only child` | I'm an only child, so anything about sibling… |
| 5 | `preference` | `audiobook` | I get through books as audiobooks. I almost … |
| 6 **←표본** | `preference` | `walking` | I'd rather have a walking meeting than sit i… |
| 7 | `preference` | `tea` | I don't drink coffee at all. It's tea, all d… |
| 8 | `preference` | `metric` | Please give me everything in metric. Imperia… |
| 9 | `occupation` | `veterinary` | I'm a veterinary nurse at a small animal pra… |
| 10 | `occupation` | `locksmith` | I've been a locksmith for eighteen years, mo… |
| 11 **←표본** | `occupation` | `air traffic` | I work in air traffic control. The shift pat… |
| 12 | `occupation` | `copy editor` | I'm a copy editor. I work on academic manusc… |
| 13 | `expertise` | `photography` | I've done photography professionally for yea… |
| 14 | `expertise` | `knitting` | I've been knitting since I was six. Cable ch… |
| 15 | `expertise` | `invest` | I've never invested in anything. I don't kno… |
| 16 **←표본** | `expertise` | `first aid` | I'm a qualified first aid trainer, so you ca… |
| 17 | `long_term_goal` | `smallholding` | The plan, eventually, is a smallholding. Eve… |
| 18 | `long_term_goal` | `phd` | I want to end up doing a PhD. I'm still a fe… |
| 19 | `long_term_goal` | `atlantic` | Crossing the Atlantic under sail is the thin… |
| 20 | `long_term_goal` | `gallery` | I want to open a small gallery for local art… |
| 21 **←표본** | `project` | `board game` | I'm designing a board game. It's been in pla… |
| 22 | `project` | `memoir` | I'm writing a memoir about my years at sea. … |
| 23 | `project` | `treehouse` | I'm building a treehouse for my nephews. Wee… |
| 24 | `project` | `newsletter` | I run a fortnightly newsletter about urban w… |
| 25 | `decision` | `freelance` | I decided to stay freelance rather than take… |

