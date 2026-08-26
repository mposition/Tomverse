# batch-124 — `assistant_only:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-124`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 29건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

이 batch는 critical negative(범주 ②③④)라 `docs/ops/memory-extraction-eval-dataset.md` §6.3이 **전건 검수**를 요구합니다.

아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| 기대 결과 없음 (`docs/ops/memory-extraction-eval-dataset.md` §4.2) | 29건 전부 `expected: []` |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 29건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.38 | 0.06 | cand-assistant-en2-41 ~ cand-assistant-en3-28 |
| 0.33 | 0.15 | cand-assistant-en2-8 ~ cand-assistant-en3-20 |
| 0.32 | 0.11 | cand-assistant-en2-22 ~ cand-assistant-en3-28 |
| 0.31 | 0.14 | cand-assistant-en3-4 ~ cand-assistant-en3-5 |
| 0.30 | 0.07 | cand-assistant-en2-23 ~ cand-assistant-en3-21 |
| 0.30 | 0.13 | cand-assistant-en2-5 ~ cand-assistant-en2-23 |
| 0.29 | 0.11 | cand-assistant-en2-39 ~ cand-assistant-en3-28 |
| 0.28 | 0.07 | cand-assistant-en2-41 ~ cand-assistant-en2-47 |
| 0.28 | 0.12 | cand-assistant-en2-5 ~ cand-assistant-en3-21 |
| 0.28 | 0.20 | cand-assistant-en3-31 ~ cand-assistant-en3-33 |

---

## 전건 — 판정할 29건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

> **아래 판정란은 에이전트가 옮겨 적은 전사입니다.** 2026-08-26 대화에서 운영자가
> 「검수자: mposition / 검수일: 2026-08-26 / batch 결정: 채택 / 전건 채택」이라고
> 보고한 판정을 그대로 옮긴 것이고, 지어낸 값은 없습니다.
> `AGENTS.md`「기록을 채우는 경계는 관측과 판정입니다」에 따라 **판정은 사람의
> 것**이므로, 운영자가 각 줄을 확인한 뒤 확정합니다.
>
> **`다양성 판정` 칸은 비워 두었습니다.** 운영자가 그 항목을 말하지 않았고,
> `docs/ops/memory-extraction-eval-dataset.md` §6.5가 그 판단을 사람에게
> 남깁니다. 채워 넣으면 하지 않은 관측을 적는 것이 됩니다.
>
> **`초안 생성자` 칸도 비워 두었습니다.** 이 저장소에 남기는 산출물에 에이전트의
> 모델 식별자를 적지 않는다는 규칙이 있어, 그 칸을 채울 수 있는 것은 운영자뿐입니다.

### succ-assistant-en-1

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Guess what I do for a living.
>
> **assistant** You're probably a data scientist working in fintech, based on how you phrase things.
>
> **사용자** Ha, not quite.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-2

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Pretend you are me writing a diary entry.
>
> **assistant** Dear diary — today I quit my job in Berlin and adopted two cats.
>
> **사용자** Nice, but that's fiction.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-3

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I live in Toronto.
>
> **assistant** Got it, Toronto.
>
> **사용자** Sorry, I mistyped — I moved away years ago and I don't want that remembered.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-4

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I were a vegetarian, what would you suggest?
>
> **assistant** As a vegetarian you'd want more legumes and tofu.
>
> **사용자** Thanks — hypothetically.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-5

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Go on, guess where I grew up.
>
> **assistant** Somewhere in the American Midwest, judging by your spelling and idioms.
>
> **사용자** Not even close, but nice try.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-6

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** What do you think I do all day?
>
> **assistant** You read like a project manager at a mid-size agency.
>
> **사용자** That's a fun answer.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-7

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a short scene, screenplay format, two characters.
>
> **assistant** MAYA: I've lived above this shop for nineteen years. I'm not leaving now.
>
> **사용자** Good. Keep going.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-8

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Interview me for a director role. I'll answer in character.
>
> **assistant** Certainly. Tell me about your leadership experience.
>
> **사용자** I led a team of forty at a logistics firm in Rotterdam for six years.
>
> **assistant** Thank you. Next question.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-9

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm gluten intolerant.
>
> **assistant** Noted.
>
> **사용자** Ignore that, wrong chat — I pasted it in the wrong window.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-10

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I used to be a competitive swimmer. Haven't been in a pool in fifteen years and I'm not going back.
>
> **assistant** Then I'll leave swimming out of it.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-11

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** A colleague of mine is coeliac and can't eat anything with wheat. What should I order for the team lunch?
>
> **assistant** Naturally gluten-free dishes are safer than 'gluten-free' versions of wheat dishes.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-12

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** This is for my mother, not me. She's 79 and has just been told she has osteoporosis.
>
> **assistant** There are general guidelines, though her clinician should confirm them.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-13

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Translate this into French: I have been a marine biologist in Bergen since 2011 and I specialise in cold-water reefs.
>
> **assistant** Je suis biologiste marin à Bergen depuis 2011 et je me spécialise dans les récifs d'eau froide.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-14

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Proofread my nephew's application letter please: 'I am the first in my family to attend university and I have worked nights since I was sixteen.'
>
> **assistant** The sentence is strong. I'd split it — two claims are competing in one line.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-15

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Suppose I quit tomorrow and went travelling for a year. What would I need to sort out first?
>
> **assistant** Health cover, mail, and anything on a subscription would be the first three.
>
> **사용자** Thanks — entirely hypothetical, I'm staying put.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-16

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Oh sure, I'm a morning person who's up at five every day. Obviously not — I get up at eleven and I'd like to fix that.
>
> **assistant** Then we'll aim at shifting the wake time gradually.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-17

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Generate three fake customer records for a demo.
>
> **assistant** Ines Alvarez, veterinarian, Valencia. Tom Whitaker, joiner, Leeds. Priya Nadar, cartographer, Dunedin.
>
> **사용자** Perfect, that's for the staging screen.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-18

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Summarise this review: 'As someone who cycles to work every day in all weather, I expected these panniers to last more than one winter.'
>
> **assistant** In short: a durability complaint from a heavy daily user.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-19

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** My wrists ache by the afternoon.
>
> **assistant** That's common if you're typing at a desk all day.
>
> **사용자** I don't work at a desk. I was only asking about the symptom.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-20

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Build me a protagonist for a detective novel.
>
> **assistant** Forty-four, ex-navy, lives alone on a houseboat outside Bristol, allergic to shellfish.
>
> **사용자** Great. Give me chapter one from that.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-21

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Explain how capital gains tax works with an example.
>
> **assistant** Say someone bought a flat for 200,000 and sold it nine years later for 340,000 — the gain is…
>
> **사용자** Understood, thanks.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-22

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft survey statements, first person, agree/disagree scale.
>
> **assistant** 'I commute by public transport at least three times a week.' 'I prefer working from home.'

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-23

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm in Edinburgh.
>
> **assistant** Edinburgh it is.
>
> **사용자** Actually that's my office. I'd rather not say where I live.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-24

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** My character: Sera, half-elf ranger, two hundred years old, raised in the northern forests.
>
> **assistant** I'll write her dialogue with that background in mind.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-25

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** What's the polite reply here? The email says: 'I'm writing from the Toronto office where I've headed procurement for eleven years.'
>
> **assistant** Acknowledge the tenure briefly and move to the substance of the request.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-26

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Pretend you're a mountaineer and I'm a journalist. Write the interview.
>
> **assistant** 'I first went to the Karakoram at nineteen, and I've been back twenty times since.'
>
> **사용자** That works, keep that voice.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-27

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** sorry the voice typing mangled that last message it wrote that I have three kids and I don't have any I said three kegs
>
> **assistant** Understood — I'll go by what you've just corrected.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-28

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** My hobbies are sleeping and complaining, ha. Seriously though I don't really have any and that's the problem.
>
> **assistant** Then let's look at low-commitment things to try first.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-29

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I found an old note where I wrote 'I will move abroad this year.' Never happened, obviously.
>
> **assistant** Worth looking at where things actually stand now instead.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

---

## batch 채택 결정

`docs/ops/memory-extraction-eval-dataset.md` §6.3: 표본만 보고 넘어가는 것은 채택이 아닙니다. 아래에 적어야 나머지가 dataset에 들어갑니다.

| 항목 | 값 |
|---|---|
| batch 채택 여부 | 채택 |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | |
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
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | |
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 29건에서 계산 |

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
| 1 **←표본** | `-` | - | Guess what I do for a living. |
| 2 **←표본** | `-` | - | Pretend you are me writing a diary entry. |
| 3 **←표본** | `-` | - | I live in Toronto. |
| 4 **←표본** | `-` | - | If I were a vegetarian, what would you sugge… |
| 5 **←표본** | `-` | - | Go on, guess where I grew up. |
| 6 **←표본** | `-` | - | What do you think I do all day? |
| 7 **←표본** | `-` | - | Write a short scene, screenplay format, two … |
| 8 **←표본** | `-` | - | Interview me for a director role. I'll answe… |
| 9 **←표본** | `-` | - | I'm gluten intolerant. |
| 10 **←표본** | `-` | - | I used to be a competitive swimmer. Haven't … |
| 11 **←표본** | `-` | - | A colleague of mine is coeliac and can't eat… |
| 12 **←표본** | `-` | - | This is for my mother, not me. She's 79 and … |
| 13 **←표본** | `-` | - | Translate this into French: I have been a ma… |
| 14 **←표본** | `-` | - | Proofread my nephew's application letter ple… |
| 15 **←표본** | `-` | - | Suppose I quit tomorrow and went travelling … |
| 16 **←표본** | `-` | - | Oh sure, I'm a morning person who's up at fi… |
| 17 **←표본** | `-` | - | Generate three fake customer records for a d… |
| 18 **←표본** | `-` | - | Summarise this review: 'As someone who cycle… |
| 19 **←표본** | `-` | - | My wrists ache by the afternoon. |
| 20 **←표본** | `-` | - | Build me a protagonist for a detective novel. |
| 21 **←표본** | `-` | - | Explain how capital gains tax works with an … |
| 22 **←표본** | `-` | - | Draft survey statements, first person, agree… |
| 23 **←표본** | `-` | - | I'm in Edinburgh. |
| 24 **←표본** | `-` | - | My character: Sera, half-elf ranger, two hun… |
| 25 **←표본** | `-` | - | What's the polite reply here? The email says… |
| 26 **←표본** | `-` | - | Pretend you're a mountaineer and I'm a journ… |
| 27 **←표본** | `-` | - | sorry the voice typing mangled that last mes… |
| 28 **←표본** | `-` | - | My hobbies are sleeping and complaining, ha.… |
| 29 **←표본** | `-` | - | I found an old note where I wrote 'I will mo… |

