# batch-018 — `assistant_only:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-018`
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
| 기대 결과 없음 (`docs/ops/memory-extraction-eval-dataset.md` §4.2) | 50건 전부 `expected: []` |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 50건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.30 | 0.13 | cand-assistant-en2-5 ~ cand-assistant-en2-23 |
| 0.28 | 0.07 | cand-assistant-en2-41 ~ cand-assistant-en2-47 |
| 0.27 | 0.08 | cand-assistant-en2-22 ~ cand-assistant-en2-39 |
| 0.26 | 0.04 | cand-assistant-en2-22 ~ cand-assistant-en2-41 |
| 0.25 | 0.07 | cand-assistant-en2-45 ~ cand-assistant-en2-46 |
| 0.24 | 0.05 | cand-assistant-en2-21 ~ cand-assistant-en2-41 |
| 0.23 | 0.06 | cand-assistant-en2-22 ~ cand-assistant-en2-46 |
| 0.23 | 0.05 | cand-assistant-en2-39 ~ cand-assistant-en2-41 |
| 0.23 | 0.06 | cand-assistant-en2-39 ~ cand-assistant-en2-48 |
| 0.23 | 0.04 | cand-assistant-en2-16 ~ cand-assistant-en2-38 |

---

## 표본 — 판정할 10건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### cand-assistant-en2-1

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write some first-person copy for my shop's about page.
>
> **assistant** I've been baking in this street for twenty years. The dough starts at four every morning.
>
> **사용자** Nice. Trim it a bit.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-6

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a children's story narrated by a rabbit.
>
> **assistant** I live in a burrow under the hill. There are six of us and we sleep in a heap all winter.
>
> **사용자** Sweet. Make it shorter.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-11

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a short reading passage for an exam. Personal essay style.
>
> **assistant** I was forty the first time I travelled alone.
>
> **사용자** Add five comprehension questions.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-16

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a user persona for the app.
>
> **assistant** Persona: I'm a working parent of two and I spend two hours a day commuting.
>
> **사용자** Give me a second persona.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-21

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm writing up a friend's trip for her.
>
> **assistant** I went to Mongolia for the first time this year. It took three days' driving to reach the stars.
>
> **사용자** She'll like that.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-26

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I pass this exam, what do I need to prepare?
>
> **assistant** If you pass, the registration paperwork is the first thing.
>
> **사용자** I haven't sat it yet. Just planning ahead.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-31

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Just check the grammar here. It isn't mine.
>
> **assistant** Corrected: "I joined the company last year and I now work in logistics."
>
> **사용자** That's all I needed.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-36

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Explain this as a teacher would.
>
> **assistant** In fifteen years of teaching this subject, I've found students get stuck here first.
>
> **사용자** That framing works well.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-41

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft the reference my supervisor will sign.
>
> **assistant** "I supervised this student for three years and she was the most diligent in the lab."
>
> **사용자** I'll give it to her as a draft.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### cand-assistant-en2-46

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a dating profile for my friend.
>
> **assistant** "I hike most weekends and I cook a lot. Thirty-two, based in Leeds."
>
> **사용자** I'll show her.

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

## 전체 50건 (참고용 — 판정 불필요)

| # | 제안 kind | 키워드 | 첫 사용자 발화 |
|---|---|---|---|
| 1 **←표본** | `-` | - | Write some first-person copy for my shop's a… |
| 2 | `-` | - | Help me draft a eulogy from a grandson's poi… |
| 3 | `-` | - | Write a monologue for a play. |
| 4 | `-` | - | Write me a first verse for a break-up song. |
| 5 | `-` | - | Write a short piece from my favourite charac… |
| 6 **←표본** | `-` | - | Write a children's story narrated by a rabbit. |
| 7 | `-` | - | Tidy up these meeting minutes but keep the q… |
| 8 | `-` | - | Draft a reply to this customer in the compan… |
| 9 | `-` | - | Write the announcement my manager is going t… |
| 10 | `-` | - | Invent a person for a tax worked example. |
| 11 **←표본** | `-` | - | Write a short reading passage for an exam. P… |
| 12 | `-` | - | Pull out the interview quotes from this arti… |
| 13 | `-` | - | Summarise this biography page. |
| 14 | `-` | - | Put this judgment into plain English. |
| 15 | `-` | - | Make up one row of data so I can explain the… |
| 16 **←표본** | `-` | - | Write a user persona for the app. |
| 17 | `-` | - | Write an A/B test scenario from the user's s… |
| 18 | `-` | - | Draft some sample replies for our support bot. |
| 19 | `-` | - | Give me an application email template. |
| 20 | `-` | - | Show me an example freelance contract clause. |
| 21 **←표본** | `-` | - | I'm writing up a friend's trip for her. |
| 22 | `-` | - | My mother needs to write to the hospital. Dr… |
| 23 | `-` | - | Write a short post from my dog's point of vi… |
| 24 | `-` | - | If I retired to the countryside, what would … |
| 25 | `-` | - | What if I'd bought that house back then? |
| 26 **←표본** | `-` | - | If I pass this exam, what do I need to prepa… |
| 27 | `-` | - | Translate this colleague's profile into Engl… |
| 28 | `-` | - | Translate these subtitles. |
| 29 | `-` | - | Clean up this interview transcript. |
| 30 | `-` | - | Write three example survey responses. |
| 31 **←표본** | `-` | - | Just check the grammar here. It isn't mine. |
| 32 | `-` | - | Rewrite this more formally. |
| 33 | `-` | - | Summarise this blog post. |
| 34 | `-` | - | Write a paragraph arguing against my position. |
| 35 | `-` | - | Write a rebuttal for a debate. I'm on the op… |
| 36 **←표본** | `-` | - | Explain this as a teacher would. |
| 37 | `-` | - | Write dialogue for a blacksmith NPC. |
| 38 | `-` | - | Write an example product review — not a real… |
| 39 | `-` | - | Write the app review my brother wants to post. |
| 40 | `-` | - | Draft an official apology from the company. |
| 41 **←표본** | `-` | - | Draft the reference my supervisor will sign. |
| 42 | `-` | - | Make an example 'about me' slide for our ind… |
| 43 | `-` | - | Write a practice scenario. I'm playing the c… |
| 44 | `-` | - | Fill in this medical form with example answe… |
| 45 | `-` | - | Write a sample CV for a graduate role. |
| 46 **←표본** | `-` | - | Write a dating profile for my friend. |
| 47 | `-` | - | Draft a thank-you letter to a teacher, from … |
| 48 | `-` | - | Write some example cancellation reasons for … |
| 49 | `-` | - | Write a talk. The audience is primary school… |
| 50 | `-` | - | Your summary earlier said I live in Manchest… |

