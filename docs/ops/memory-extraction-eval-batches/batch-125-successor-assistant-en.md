# batch-125 — `assistant_only:en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-125`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 50건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

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
| 0.38 | 0.06 | cand-assistant-en2-41 ~ cand-assistant-en3-28 |
| 0.38 | 0.06 | cand-assistant-en3-28 ~ succ-assistant-en-70 |
| 0.33 | 0.15 | cand-assistant-en2-8 ~ cand-assistant-en3-20 |
| 0.33 | 0.15 | cand-assistant-en3-20 ~ succ-assistant-en-37 |
| 0.32 | 0.11 | cand-assistant-en2-22 ~ cand-assistant-en3-28 |
| 0.32 | 0.11 | cand-assistant-en3-28 ~ succ-assistant-en-51 |
| 0.31 | 0.14 | cand-assistant-en3-4 ~ cand-assistant-en3-5 |
| 0.30 | 0.07 | cand-assistant-en2-23 ~ cand-assistant-en3-21 |
| 0.30 | 0.07 | cand-assistant-en3-21 ~ succ-assistant-en-52 |
| 0.30 | 0.13 | cand-assistant-en2-5 ~ cand-assistant-en2-23 |

---

## 전건 — 판정할 50건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### succ-assistant-en-30

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write some first-person copy for my shop's about page.
>
> **assistant** I've been baking in this street for twenty years. The dough starts at four every morning.
>
> **사용자** Nice. Trim it a bit.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-31

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Help me draft a eulogy from a grandson's point of view.
>
> **assistant** I was raised by my grandfather. Until I was nine we lived in his cottage.
>
> **사용자** Thank you, I'll read that out.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-32

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a monologue for a play.
>
> **assistant** I sailed that boat my whole life. My son never once came out with me.
>
> **사용자** Good tone. Keep going.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-33

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write me a first verse for a break-up song.
>
> **assistant** I put you on the last train out of Leeds, I was twenty-three and I said nothing at all.
>
> **사용자** Second verse too, please.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-34

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a short piece from my favourite character's point of view.
>
> **assistant** I have carried this sword for ten years. My teacher is long dead.
>
> **사용자** Keep going.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-35

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a children's story narrated by a rabbit.
>
> **assistant** I live in a burrow under the hill. There are six of us and we sleep in a heap all winter.
>
> **사용자** Sweet. Make it shorter.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-36

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Tidy up these meeting minutes but keep the quotes.
>
> **assistant** Done. Priya: "I object to this timeline. My team is two people."
>
> **사용자** Yes, that line matters.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-37

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft a reply to this customer in the company's voice.
>
> **assistant** We've run this service since 2015 and there are twelve of us.
>
> **사용자** I'll check those numbers before sending.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-38

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write the announcement my manager is going to send.
>
> **assistant** I'll be on parental leave from next month. Dan is covering my work.
>
> **사용자** I'll pass that to her.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-39

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Invent a person for a tax worked example.
>
> **assistant** Example: I'm a freelance designer and I earned £34,000 last year.
>
> **사용자** Now run the calculation on that.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-40

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a short reading passage for an exam. Personal essay style.
>
> **assistant** I was forty the first time I travelled alone.
>
> **사용자** Add five comprehension questions.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-41

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Pull out the interview quotes from this article.
>
> **assistant** Extract: "I've sold fish in this market for thirty years."
>
> **사용자** That's the one I needed.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-42

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Summarise this biography page.
>
> **assistant** In short: born in Dundee in 1948, she spent her whole career teaching.
>
> **사용자** Thanks.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-43

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Put this judgment into plain English.
>
> **assistant** The claimant said she had lived in the flat for ten years and renewed the tenancy twice.
>
> **사용자** Good — now just the issues.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-44

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Make up one row of data so I can explain the table.
>
> **assistant** Sample row: age 34, city Bristol, occupation pharmacist, monthly income £2,600.
>
> **사용자** Now use it to explain the average.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-45

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a user persona for the app.
>
> **assistant** Persona: I'm a working parent of two and I spend two hours a day commuting.
>
> **사용자** Give me a second persona.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-46

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write an A/B test scenario from the user's side.
>
> **assistant** Scenario A: I'm a first-time visitor and I want to browse without signing up.
>
> **사용자** Now scenario B.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-47

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft some sample replies for our support bot.
>
> **assistant** Sample: "I'm the 24-hour assistant for this store."
>
> **사용자** Make the tone warmer.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-48

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Give me an application email template.
>
> **assistant** Template: "I graduated in Economics from Leeds in 2019." Swap the course and year.
>
> **사용자** Right, I'll fill in mine.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-49

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Show me an example freelance contract clause.
>
> **assistant** Example: "I will work three days a week, remotely."
>
> **사용자** Add a few more clauses.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-50

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** I'm writing up a friend's trip for her.
>
> **assistant** I went to Mongolia for the first time this year. It took three days' driving to reach the stars.
>
> **사용자** She'll like that.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-51

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** My mother needs to write to the hospital. Draft it for her.
>
> **assistant** I'm seventy-two and I had a knee replacement two months ago.
>
> **사용자** I'll send it under her name.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-52

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a short post from my dog's point of view for social media.
>
> **assistant** I've lived here three years. Two walks a day, and the morning one is better.
>
> **사용자** Ha, perfect.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-53

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I retired to the countryside, what would I need to sort out?
>
> **assistant** Assuming a rural retirement, I'd start with how far the nearest hospital is.
>
> **사용자** Just curious — I'm still working.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-54

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** What if I'd bought that house back then?
>
> **assistant** Had you bought in 2018, it would be worth roughly double now.
>
> **사용자** I didn't buy it. Just running the numbers.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-55

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** If I pass this exam, what do I need to prepare?
>
> **assistant** If you pass, the registration paperwork is the first thing.
>
> **사용자** I haven't sat it yet. Just planning ahead.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-56

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Translate this colleague's profile into English.
>
> **assistant** Translation: "I'm an architect based in Berlin and I specialise in timber construction."
>
> **사용자** Thanks.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-57

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Translate these subtitles.
>
> **assistant** Line: "I was born in this village and I've never left it."
>
> **사용자** Keep the timecodes aligned.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-58

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Clean up this interview transcript.
>
> **assistant** Cleaned: Respondent — "My father fished too, and I went out at sixteen."
>
> **사용자** Leave it as it is.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-59

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write three example survey responses.
>
> **assistant** Example 1: "I commute by train every day and it takes fifty minutes each way."
>
> **사용자** And the other two.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-60

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Just check the grammar here. It isn't mine.
>
> **assistant** Corrected: "I joined the company last year and I now work in logistics."
>
> **사용자** That's all I needed.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-61

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Rewrite this more formally.
>
> **assistant** Rewritten: "I am relocating next month and would like to update my delivery address."
>
> **사용자** Thanks.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-62

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Summarise this blog post.
>
> **assistant** The author says he left a corporate job and now grows citrus on a small farm.
>
> **사용자** That's the gist, yes.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-63

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a paragraph arguing against my position.
>
> **assistant** Opposing view: "I worked from home for three years and my output dropped."
>
> **사용자** Good — now help me rebut it.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-64

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a rebuttal for a debate. I'm on the opposing side.
>
> **assistant** Rebuttal: "I was a direct beneficiary of this policy and I felt no difference."
>
> **사용자** Not my actual experience — it's for the competition.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-65

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Explain this as a teacher would.
>
> **assistant** In fifteen years of teaching this subject, I've found students get stuck here first.
>
> **사용자** That framing works well.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-66

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write dialogue for a blacksmith NPC.
>
> **assistant** "I've beaten iron in this village for forty years. I'll stop when my hands do."
>
> **사용자** Good. One more line.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-67

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write an example product review — not a real one, just for reference.
>
> **assistant** Example: "I have two young children and this vacuum has saved me hours."
>
> **사용자** I only need the format.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-68

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write the app review my brother wants to post.
>
> **assistant** "I log my workouts in this app every morning and have done for six months."
>
> **사용자** I'll send it to him.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-69

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft an official apology from the company.
>
> **assistant** "We identified an error in how we handled personal data in March."
>
> **사용자** I'll confirm the date before it goes out.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-70

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft the reference my supervisor will sign.
>
> **assistant** "I supervised this student for three years and she was the most diligent in the lab."
>
> **사용자** I'll give it to her as a draft.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-71

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Make an example 'about me' slide for our induction pack.
>
> **assistant** Example: "I'm from Sheffield and I spend my weekends climbing."
>
> **사용자** It's just the layout I need.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-72

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a practice scenario. I'm playing the counsellor.
>
> **assistant** Client line: "I haven't slept properly in six months and I've left my job."
>
> **사용자** I'll practise with that.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-73

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Fill in this medical form with example answers so I can check the layout.
>
> **assistant** Example: smoker — no; current medication — blood pressure tablets; surgery — appendix, 2019.
>
> **사용자** I only wanted to see the fields.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-74

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a sample CV for a graduate role.
>
> **assistant** Sample: "I studied computer science and completed two internships during my degree."
>
> **사용자** I'll swap in my own details.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-75

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a dating profile for my friend.
>
> **assistant** "I hike most weekends and I cook a lot. Thirty-two, based in Leeds."
>
> **사용자** I'll show her.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-76

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Draft a thank-you letter to a teacher, from a student. It's for my younger cousin.
>
> **assistant** "I spent three years in your class and that's where I chose my path."
>
> **사용자** I'll pass it on to him.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-77

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write some example cancellation reasons for our form.
>
> **assistant** Example: "I don't use this service any more and have moved to another app."
>
> **사용자** They'll be the dropdown options.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-78

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Write a talk. The audience is primary school parents.
>
> **assistant** Open with: "As a parent myself, I've thought about this for a long time."
>
> **사용자** I don't have children, but keep the line.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-assistant-en-79

**제안 gold label**: (없음 — 범주 ②③④는 빈 배열)

> **사용자** Your summary earlier said I live in Manchester.
>
> **assistant** I carried that over incorrectly. Let me correct it.
>
> **사용자** Right — I've never lived in Manchester.

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
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 50건에서 계산 |

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
| 2 **←표본** | `-` | - | Help me draft a eulogy from a grandson's poi… |
| 3 **←표본** | `-` | - | Write a monologue for a play. |
| 4 **←표본** | `-` | - | Write me a first verse for a break-up song. |
| 5 **←표본** | `-` | - | Write a short piece from my favourite charac… |
| 6 **←표본** | `-` | - | Write a children's story narrated by a rabbit. |
| 7 **←표본** | `-` | - | Tidy up these meeting minutes but keep the q… |
| 8 **←표본** | `-` | - | Draft a reply to this customer in the compan… |
| 9 **←표본** | `-` | - | Write the announcement my manager is going t… |
| 10 **←표본** | `-` | - | Invent a person for a tax worked example. |
| 11 **←표본** | `-` | - | Write a short reading passage for an exam. P… |
| 12 **←표본** | `-` | - | Pull out the interview quotes from this arti… |
| 13 **←표본** | `-` | - | Summarise this biography page. |
| 14 **←표본** | `-` | - | Put this judgment into plain English. |
| 15 **←표본** | `-` | - | Make up one row of data so I can explain the… |
| 16 **←표본** | `-` | - | Write a user persona for the app. |
| 17 **←표본** | `-` | - | Write an A/B test scenario from the user's s… |
| 18 **←표본** | `-` | - | Draft some sample replies for our support bot. |
| 19 **←표본** | `-` | - | Give me an application email template. |
| 20 **←표본** | `-` | - | Show me an example freelance contract clause. |
| 21 **←표본** | `-` | - | I'm writing up a friend's trip for her. |
| 22 **←표본** | `-` | - | My mother needs to write to the hospital. Dr… |
| 23 **←표본** | `-` | - | Write a short post from my dog's point of vi… |
| 24 **←표본** | `-` | - | If I retired to the countryside, what would … |
| 25 **←표본** | `-` | - | What if I'd bought that house back then? |
| 26 **←표본** | `-` | - | If I pass this exam, what do I need to prepa… |
| 27 **←표본** | `-` | - | Translate this colleague's profile into Engl… |
| 28 **←표본** | `-` | - | Translate these subtitles. |
| 29 **←표본** | `-` | - | Clean up this interview transcript. |
| 30 **←표본** | `-` | - | Write three example survey responses. |
| 31 **←표본** | `-` | - | Just check the grammar here. It isn't mine. |
| 32 **←표본** | `-` | - | Rewrite this more formally. |
| 33 **←표본** | `-` | - | Summarise this blog post. |
| 34 **←표본** | `-` | - | Write a paragraph arguing against my position. |
| 35 **←표본** | `-` | - | Write a rebuttal for a debate. I'm on the op… |
| 36 **←표본** | `-` | - | Explain this as a teacher would. |
| 37 **←표본** | `-` | - | Write dialogue for a blacksmith NPC. |
| 38 **←표본** | `-` | - | Write an example product review — not a real… |
| 39 **←표본** | `-` | - | Write the app review my brother wants to post. |
| 40 **←표본** | `-` | - | Draft an official apology from the company. |
| 41 **←표본** | `-` | - | Draft the reference my supervisor will sign. |
| 42 **←표본** | `-` | - | Make an example 'about me' slide for our ind… |
| 43 **←표본** | `-` | - | Write a practice scenario. I'm playing the c… |
| 44 **←표본** | `-` | - | Fill in this medical form with example answe… |
| 45 **←표본** | `-` | - | Write a sample CV for a graduate role. |
| 46 **←표본** | `-` | - | Write a dating profile for my friend. |
| 47 **←표본** | `-` | - | Draft a thank-you letter to a teacher, from … |
| 48 **←표본** | `-` | - | Write some example cancellation reasons for … |
| 49 **←표본** | `-` | - | Write a talk. The audience is primary school… |
| 50 **←표본** | `-` | - | Your summary earlier said I live in Manchest… |

