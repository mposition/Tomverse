# batch-020 — `assistant_only:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-020`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 10건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

이 batch는 critical negative(범주 ②③④)라 `docs/ops/memory-extraction-eval-dataset.md` §6.3이 **전건 검수**를 요구합니다.

아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| 기대 결과 없음 (`docs/ops/memory-extraction-eval-dataset.md` §4.2) | 46건 전부 `expected: []` |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 46건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.31 | 0.14 | cand-assistant-en3-4 ~ cand-assistant-en3-5 |
| 0.28 | 0.20 | cand-assistant-en3-31 ~ cand-assistant-en3-33 |
| 0.28 | 0.10 | cand-assistant-en3-21 ~ cand-assistant-en3-22 |
| 0.26 | 0.05 | assistant-en-3 ~ cand-assistant-en3-2 |
| 0.26 | 0.04 | cand-assistant-en3-27 ~ cand-assistant-en3-28 |
| 0.25 | 0.15 | cand-assistant-en3-2 ~ cand-assistant-en3-6 |
| 0.24 | 0.08 | cand-assistant-en-6 ~ cand-assistant-en3-3 |
| 0.23 | 0.15 | cand-assistant-en3-19 ~ cand-assistant-en3-20 |
| 0.23 | 0.11 | cand-assistant-en3-19 ~ cand-assistant-en3-28 |
| 0.22 | 0.06 | cand-assistant-en3-9 ~ cand-assistant-en3-29 |

---

## 표본 — 판정할 10건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### cand-assistant-en3-1

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm not a vegetarian. Please stop assuming that.
>
> **assistant** Understood — I'll include meat dishes.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-5

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I don't have children, so none of the parenting angle applies.
>
> **assistant** Noted, I'll leave that out.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-9

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** A client of mine wants to convert a flat into an office. Is that allowed?
>
> **assistant** Change of use depends on the planning class and local policy.
>
> **사용자** Not my building — I'm advising on it.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-13

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I typed my age as forty earlier — that was a typo. It's thirty.
>
> **assistant** I'll correct it.
>
> **사용자** Right, thirty, not forty.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-17

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I studied abroad, what happens to my health cover?
>
> **assistant** Long absences usually need to be declared.
>
> **사용자** I'm not going anywhere.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-21

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a crowdfunding page from the maker's point of view.
>
> **assistant** "I've been building this instrument on my own for three years."
>
> **사용자** It's a friend's project — I'm writing it for him.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-25

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write an NPC for my tabletop session.
>
> **assistant** "I've kept this inn twenty years and I remember every face that's come through."
>
> **사용자** Good — add some stats.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-29

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm writing a complaint on behalf of an elderly neighbour.
>
> **assistant** "I live in block 3 and I'm writing about persistent noise."
>
> **사용자** That's his block, not mine.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-33

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Fill in a dog adoption form as an example.
>
> **assistant** Example: housing detached, previous pets 10 years, household 4 people.
>
> **사용자** Not my situation — checking the form.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en3-37

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Play the other side so I can practise negotiating.
>
> **assistant** "We're close to signing with another supplier, so I can't move on price."
>
> **사용자** Good, keep going.

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
| 1 **←표본** | `-` | - | I'm not a vegetarian. Please stop assuming t… |
| 2 | `-` | - | I don't live in London. You keep answering a… |
| 3 | `-` | - | I'm not a developer. Code examples don't hel… |
| 4 | `-` | - | I don't have a nut allergy — no need to leav… |
| 5 **←표본** | `-` | - | I don't have children, so none of the parent… |
| 6 | `-` | - | I don't own a car. You've been answering as … |
| 7 | `-` | - | My wife takes thyroid medication — is it saf… |
| 8 | `-` | - | My father just retired. When can he start dr… |
| 9 **←표본** | `-` | - | A client of mine wants to convert a flat int… |
| 10 | `-` | - | A friend is looking at emigrating and asked … |
| 11 | `-` | - | There's a rumour going round that our manage… |
| 12 | `-` | - | Summarise this report for me. |
| 13 **←표본** | `-` | - | I typed my age as forty earlier — that was a… |
| 14 | `-` | - | You said I probably studied economics. What … |
| 15 | `-` | - | If I changed jobs now, what happens to my no… |
| 16 | `-` | - | If I registered as self-employed, which taxe… |
| 17 **←표본** | `-` | - | If I studied abroad, what happens to my heal… |
| 18 | `-` | - | Give me an example email signature. |
| 19 | `-` | - | Write a property listing in the owner's voice. |
| 20 | `-` | - | Write a volunteer recruitment notice in the … |
| 21 **←표본** | `-` | - | Write a crowdfunding page from the maker's p… |
| 22 | `-` | - | Write the opening lines for a channel intro. |
| 23 | `-` | - | Write example candidate blurbs for a job adv… |
| 24 | `-` | - | Draft example consent wording for a privacy … |
| 25 **←표본** | `-` | - | Write an NPC for my tabletop session. |
| 26 | `-` | - | Write lyrics for a solo number in a musical. |
| 27 | `-` | - | Write a story to send to a radio show. It's … |
| 28 | `-` | - | Draft a letter to the editor. My mother will… |
| 29 **←표본** | `-` | - | I'm writing a complaint on behalf of an elde… |
| 30 | `-` | - | Show me a filled-in insurance claim form. |
| 31 | `-` | - | Fill in a customs declaration as an example. |
| 32 | `-` | - | Write an example scholarship personal statem… |
| 33 **←표본** | `-` | - | Fill in a dog adoption form as an example. |
| 34 | `-` | - | Write an introduction template for new club … |
| 35 | `-` | - | What questions might the audience ask after … |
| 36 | `-` | - | Show me how I might answer this interview qu… |
| 37 **←표본** | `-` | - | Play the other side so I can practise negoti… |
| 38 | `-` | - | Write some customer complaint examples for a… |
| 39 | `-` | - | Write a few user stories. |
| 40 | `-` | - | Give me a bug report template with an example. |
| 41 | `-` | - | Explain the log format with one sample line. |
| 42 | `-` | - | Generate some seed data for the dev database. |
| 43 | `-` | - | Write placeholder copy for the mockup. |
| 44 | `-` | - | Give me an example sentence for the past per… |
| 45 | `-` | - | Give me five dictation sentences. |
| 46 | `-` | - | Polish this audiobook narration. |

