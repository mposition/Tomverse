# batch-126 — `assistant_only:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-126`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 46건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

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
| 0.38 | 0.06 | cand-assistant-en2-41 ~ cand-assistant-en3-28 |
| 0.38 | 0.06 | cand-assistant-en2-41 ~ succ-assistant-en-107 |
| 0.33 | 0.15 | cand-assistant-en2-8 ~ cand-assistant-en3-20 |
| 0.33 | 0.15 | cand-assistant-en2-8 ~ succ-assistant-en-99 |
| 0.32 | 0.11 | cand-assistant-en2-22 ~ cand-assistant-en3-28 |
| 0.32 | 0.11 | cand-assistant-en2-22 ~ succ-assistant-en-107 |
| 0.31 | 0.14 | cand-assistant-en3-4 ~ cand-assistant-en3-5 |
| 0.31 | 0.14 | cand-assistant-en3-4 ~ succ-assistant-en-84 |
| 0.31 | 0.14 | cand-assistant-en3-5 ~ succ-assistant-en-83 |
| 0.31 | 0.14 | succ-assistant-en-83 ~ succ-assistant-en-84 |

---

## 전건 — 판정할 46건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

> **아래 판정란은 에이전트가 옮겨 적은 전사입니다.** 2026-08-26 대화에서 운영자가
> 「검수자: mposition / 검수일: 2026-08-26 / batch 결정: 채택 / 전건 채택」이라고
> 보고한 판정을 그대로 옮긴 것이고, 지어낸 값은 없습니다.
> `AGENTS.md`「기록을 채우는 경계는 관측과 판정입니다」에 따라 **판정은 사람의
> 것**이므로, 운영자가 각 줄을 확인한 뒤 확정합니다.

### succ-assistant-en-80

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm not a vegetarian. Please stop assuming that.
>
> **assistant** Understood — I'll include meat dishes.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-81

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I don't live in London. You keep answering as if I do.
>
> **assistant** Sorry. Tell me the area and I'll redo it.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-82

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm not a developer. Code examples don't help me.
>
> **assistant** I'll explain it without code, then.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-83

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I don't have a nut allergy — no need to leave them out.
>
> **assistant** I'll drop that restriction.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-84

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I don't have children, so none of the parenting angle applies.
>
> **assistant** Noted, I'll leave that out.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-85

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I don't own a car. You've been answering as though I drive.
>
> **assistant** I'll redo this around public transport.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-86

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** My wife takes thyroid medication — is it safe with this food?
>
> **assistant** Interactions like that are worth checking with her prescriber.
>
> **사용자** It's hers, not mine.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-87

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** My father just retired. When can he start drawing his pension?
>
> **assistant** It depends on his scheme and the years he contributed.
>
> **사용자** I'm decades off myself — this is about him.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-88

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** A client of mine wants to convert a flat into an office. Is that allowed?
>
> **assistant** Change of use depends on the planning class and local policy.
>
> **사용자** Not my building — I'm advising on it.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-89

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** A friend is looking at emigrating and asked what paperwork it takes.
>
> **assistant** It varies by country, but proof of funds and a police check are common.
>
> **사용자** I'll pass that on to her.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-90

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** There's a rumour going round that our manager is leaving next month.
>
> **assistant** If it's unconfirmed, I'd hold off acting on it.
>
> **사용자** Agreed — it's second hand.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-91

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Summarise this report for me.
>
> **assistant** Half the respondents said "I work from home five days a week or more".
>
> **사용자** That's the figure I needed.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-92

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I typed my age as forty earlier — that was a typo. It's thirty.
>
> **assistant** I'll correct it.
>
> **사용자** Right, thirty, not forty.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-93

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** You said I probably studied economics. What made you think that?
>
> **assistant** I guessed from the vocabulary. That was thin evidence.
>
> **사용자** It isn't economics. I was just curious.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-94

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I changed jobs now, what happens to my notice period?
>
> **assistant** It's whatever your contract states, usually one to three months.
>
> **사용자** No plans to leave — just want to know.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-95

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I registered as self-employed, which taxes would I owe?
>
> **assistant** Income tax and National Insurance, with VAT above the threshold.
>
> **사용자** Still employed — asking out of interest.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-96

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I studied abroad, what happens to my health cover?
>
> **assistant** Long absences usually need to be declared.
>
> **사용자** I'm not going anywhere.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-97

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Give me an example email signature.
>
> **assistant** Example: "I'm Sam Okafor, Marketing, extension 3204."
>
> **사용자** Just the format, thanks.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-98

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a property listing in the owner's voice.
>
> **assistant** "I've lived here ten years and had the whole place renovated last year."
>
> **사용자** I'll pass the draft to the owner.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-99

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a volunteer recruitment notice in the charity's voice.
>
> **assistant** "We've run this food service in the area since 2011."
>
> **사용자** I'll verify the date.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-100

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a crowdfunding page from the maker's point of view.
>
> **assistant** "I've been building this instrument on my own for three years."
>
> **사용자** It's a friend's project — I'm writing it for him.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-101

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write the opening lines for a channel intro.
>
> **assistant** Try: "Hello — I've been hillwalking for ten years."
>
> **사용자** It isn't my channel, it's a commission.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-102

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write example candidate blurbs for a job advert, in first person.
>
> **assistant** Something like: "I have three years of backend experience and work mainly in Go."
>
> **사용자** Only needed the sample sentence.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-103

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft example consent wording for a privacy notice.
>
> **assistant** Example: "I am over 16 and I agree to the terms above."
>
> **사용자** That's the phrasing I wanted.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-104

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write an NPC for my tabletop session.
>
> **assistant** "I've kept this inn twenty years and I remember every face that's come through."
>
> **사용자** Good — add some stats.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-105

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write lyrics for a solo number in a musical.
>
> **assistant** "I've never left this town, twenty years at the same window."
>
> **사용자** Now the chorus.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-106

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a story to send to a radio show. It's my brother's.
>
> **assistant** "I moved into my first place on my own this year."
>
> **사용자** It'll go in under his name.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-107

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft a letter to the editor. My mother will send it.
>
> **assistant** "I have lived in this neighbourhood for forty years."
>
> **사용자** I'll show it to her.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-108

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm writing a complaint on behalf of an elderly neighbour.
>
> **assistant** "I live in block 3 and I'm writing about persistent noise."
>
> **사용자** That's his block, not mine.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-109

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Show me a filled-in insurance claim form.
>
> **assistant** Example: date of accident 2026-03-04, injury wrist, treatment six weeks.
>
> **사용자** I only wanted to see how the fields work.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-110

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Fill in a customs declaration as an example.
>
> **assistant** Example: purpose tourism, length of stay 10 days, goods to declare none.
>
> **사용자** Just checking the form.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-111

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write an example scholarship personal statement.
>
> **assistant** "I was raised in a single-parent household and have funded my own studies."
>
> **사용자** I'm only borrowing the style.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-112

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Fill in a dog adoption form as an example.
>
> **assistant** Example: housing detached, previous pets 10 years, household 4 people.
>
> **사용자** Not my situation — checking the form.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-113

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write an introduction template for new club members.
>
> **assistant** "Hi — I've climbed for three years and I'm at the indoor wall most weekends."
>
> **사용자** It's for the members to fill in.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-114

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** What questions might the audience ask after my talk?
>
> **assistant** Possibly: "I've worked in this field for ten years and it doesn't match what I see."
>
> **사용자** I'll prepare an answer.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-115

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Show me how I might answer this interview question.
>
> **assistant** Model answer: "I led a team of five and halved our attrition."
>
> **사용자** My background is different — I'm copying the structure.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-116

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Play the other side so I can practise negotiating.
>
> **assistant** "We're close to signing with another supplier, so I can't move on price."
>
> **사용자** Good, keep going.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-117

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write some customer complaint examples for a training deck.
>
> **assistant** Example: "I called three times and got a different answer each time."
>
> **사용자** Into the deck they go.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-118

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a few user stories.
>
> **assistant** "As a night-shift worker, I want the app to open in dark mode by default."
>
> **사용자** Adding those to the backlog.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-119

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Give me a bug report template with an example.
>
> **assistant** Steps: "I opened the app on an iPhone 15 and went into settings."
>
> **사용자** Not my device — it's the template.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-120

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Explain the log format with one sample line.
>
> **assistant** Sample: user_id=8812 city=Leeds plan=pro locale=en
>
> **사용자** I just needed the field order.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-121

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Generate some seed data for the dev database.
>
> **assistant** Done: name Priya Raman, age 29, occupation photographer, city Norwich.
>
> **사용자** I'll load that into the test DB.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-122

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write placeholder copy for the mockup.
>
> **assistant** A testimonial slot reads: "I start every morning with this app."
>
> **사용자** It's for the design file.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-123

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Give me an example sentence for the past perfect.
>
> **assistant** Example: "I had already eaten dinner before he arrived."
>
> **사용자** That's for the textbook.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-124

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Give me five dictation sentences.
>
> **assistant** 1. I borrowed three books from the library yesterday.
>
> **사용자** And the rest.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-assistant-en-125

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Polish this audiobook narration.
>
> **assistant** Polished: "I read my father's letters for the first time that winter."
>
> **사용자** Just the pacing left to sort.

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
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | |
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 46건에서 계산 |

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
| 2 **←표본** | `-` | - | I don't live in London. You keep answering a… |
| 3 **←표본** | `-` | - | I'm not a developer. Code examples don't hel… |
| 4 **←표본** | `-` | - | I don't have a nut allergy — no need to leav… |
| 5 **←표본** | `-` | - | I don't have children, so none of the parent… |
| 6 **←표본** | `-` | - | I don't own a car. You've been answering as … |
| 7 **←표본** | `-` | - | My wife takes thyroid medication — is it saf… |
| 8 **←표본** | `-` | - | My father just retired. When can he start dr… |
| 9 **←표본** | `-` | - | A client of mine wants to convert a flat int… |
| 10 **←표본** | `-` | - | A friend is looking at emigrating and asked … |
| 11 **←표본** | `-` | - | There's a rumour going round that our manage… |
| 12 **←표본** | `-` | - | Summarise this report for me. |
| 13 **←표본** | `-` | - | I typed my age as forty earlier — that was a… |
| 14 **←표본** | `-` | - | You said I probably studied economics. What … |
| 15 **←표본** | `-` | - | If I changed jobs now, what happens to my no… |
| 16 **←표본** | `-` | - | If I registered as self-employed, which taxe… |
| 17 **←표본** | `-` | - | If I studied abroad, what happens to my heal… |
| 18 **←표본** | `-` | - | Give me an example email signature. |
| 19 **←표본** | `-` | - | Write a property listing in the owner's voice. |
| 20 **←표본** | `-` | - | Write a volunteer recruitment notice in the … |
| 21 **←표본** | `-` | - | Write a crowdfunding page from the maker's p… |
| 22 **←표본** | `-` | - | Write the opening lines for a channel intro. |
| 23 **←표본** | `-` | - | Write example candidate blurbs for a job adv… |
| 24 **←표본** | `-` | - | Draft example consent wording for a privacy … |
| 25 **←표본** | `-` | - | Write an NPC for my tabletop session. |
| 26 **←표본** | `-` | - | Write lyrics for a solo number in a musical. |
| 27 **←표본** | `-` | - | Write a story to send to a radio show. It's … |
| 28 **←표본** | `-` | - | Draft a letter to the editor. My mother will… |
| 29 **←표본** | `-` | - | I'm writing a complaint on behalf of an elde… |
| 30 **←표본** | `-` | - | Show me a filled-in insurance claim form. |
| 31 **←표본** | `-` | - | Fill in a customs declaration as an example. |
| 32 **←표본** | `-` | - | Write an example scholarship personal statem… |
| 33 **←표본** | `-` | - | Fill in a dog adoption form as an example. |
| 34 **←표본** | `-` | - | Write an introduction template for new club … |
| 35 **←표본** | `-` | - | What questions might the audience ask after … |
| 36 **←표본** | `-` | - | Show me how I might answer this interview qu… |
| 37 **←표본** | `-` | - | Play the other side so I can practise negoti… |
| 38 **←표본** | `-` | - | Write some customer complaint examples for a… |
| 39 **←표본** | `-` | - | Write a few user stories. |
| 40 **←표본** | `-` | - | Give me a bug report template with an example. |
| 41 **←표본** | `-` | - | Explain the log format with one sample line. |
| 42 **←표본** | `-` | - | Generate some seed data for the dev database. |
| 43 **←표본** | `-` | - | Write placeholder copy for the mockup. |
| 44 **←표본** | `-` | - | Give me an example sentence for the past per… |
| 45 **←표본** | `-` | - | Give me five dictation sentences. |
| 46 **←표본** | `-` | - | Polish this audiobook narration. |

