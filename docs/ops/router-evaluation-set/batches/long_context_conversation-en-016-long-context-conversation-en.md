# long_context_conversation-en-016 — `long_context_conversation/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=long_context_conversation-en-016`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**후보 14건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

아래 §후보에 prompt 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **「수정 후 채택」은 없습니다** — 
반려된 prompt는 고쳐서 채택하지 않고 **새 id로 다시 씁니다**. 그래야 반려 기록이 실제로
반려된 것을 계속 가리킵니다.

채택은 이 시트로 확정되지 않습니다. `status: adopted`와 `adoptedBy`·`adoptedAt`은 사람이
기입하는 값이고, 에이전트 산출물은 어떤 경우에도 `status: candidate`입니다.

---

## 초안 출처

| 항목 | 값 |
|---|---|
| provider | `qwen` |
| modelId (Tomverse) | `qwen3.7-max` |
| 요청한 api model | `qwen3.7-max` |
| 응답이 밝힌 version | `qwen3.7-max` — **요청의 에코입니다. 버전 정보가 아닙니다** |
| 별칭이 가리킨 실제 모델 | *확정되지 않음 — no-alias-recorded* |
| 생성 파라미터 | `{"max_tokens":8000}` |
| promptTemplate | `router-eval-draft-v2` (`57040f0721513a79`) |
| generatorCommit | `7eb0f88` |
| draftedAt | 2026-08-26T01:08:13.191Z |

*"A set drafted by a routable model measures how well that model handles its own
phrasing."* 초안 모델과 같은 계열이 라우팅 후보에 있다면, 그 계열에 유리한 문체·문제
구성이 아닌지 특히 보아 주세요.

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **좋은 prompt인가**만 보시면 됩니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| exact duplicate prompt | corpus 전체 150건 | 0건 |
| cell ↔ language 정합성 | batch 14건 | 전건 통과 |
| status: candidate | batch 14건 | 전건 candidate |

### near-duplicate 상위 10쌍 (corpus 150건 대상)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 cell 안에서만 비교합니다 — 다른 cell은 다르라고 나눠 놓은 것이라 유사도가 낮은 게
당연하고, 그 값은 아무것도 말해주지 않습니다.

**이 batch 안에서만이 아니라 이미 쌓인 corpus 전체와 비교했습니다.** batch마다 따로 보면
각 batch는 다양해 보이는데 corpus는 같은 틀을 반복하는 상태를 놓칩니다.

| token | shape | 쌍 | cell |
|---|---|---|---|
| 0.17 | 0.01 | `long-en-017` ~ `long-en-023` | long_context_conversation/en |
| 0.14 | 0.02 | `long-en-016` ~ `long-en-019` | long_context_conversation/en |
| 0.14 | 0.01 | `long-en-017` ~ `long-en-026` | long_context_conversation/en |
| 0.14 | 0.02 | `long-en-017` ~ `long-en-024` | long_context_conversation/en |
| 0.14 | 0.01 | `long-en-023` ~ `long-en-026` | long_context_conversation/en |
| 0.14 | 0.04 | `long-en-022` ~ `long-en-025` | long_context_conversation/en |
| 0.13 | 0.02 | `long-en-016` ~ `long-en-027` | long_context_conversation/en |
| 0.13 | 0.03 | `long-en-023` ~ `long-en-025` | long_context_conversation/en |
| 0.13 | 0.01 | `long-en-016` ~ `long-en-024` | long_context_conversation/en |
| 0.13 | 0.03 | `long-en-016` ~ `long-en-025` | long_context_conversation/en |

---

## 후보 — 판정할 14건

### long-en-016

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> We spent the last three sessions building a custom woodworking jig for cutting dovetail joints, relying heavily on a router table and a specific brass guide bushing. I just dropped my router and the motor is completely burnt out, and I won't have the budget to buy a new one for at least two months.
> 
> How can I adapt the jig design to work with a handheld circular saw and a straight edge instead?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-017

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> We've been outlining the plot for a mystery novel where the detective is colorblind and the crucial clue relies on distinguishing between red and green wires.
> 
> Since we established he can't tell those colors apart, what other sensory detail could he use to identify the cut wire in the dark?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-018

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> Goal: Remove a stripped screw from the laptop chassis.
> - Tried: Rubber band method (slipped).
> - Tried: Super glue on the screwdriver tip (broke off).
> - Tried: Drilling it out (drill bit broke).
> 
> I only have a soldering iron and some basic hand tools left in my apartment, so what's my next move to get this thing open without damaging the motherboard?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-019

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> Earlier we mapped out a week-long meal prep menu focusing on high-protein, low-carb dinners using chicken, tofu, and salmon.
> 
> My fridge just died and I'm relying on a mini-cooler with ice packs for the next three days; which of those proteins should I cook first?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-020

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> In our previous chats, we designed a DIY backyard water feature using a 50-gallon stock tank, a solar-powered pump, and stacked slate rocks. We agreed the total cost needed to stay under $150.
> 
> I just priced out the slate rocks at the local quarry and they are $200 alone, so what cheaper alternative material can we use for the waterfall cascade that still looks natural?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-021

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> We've been analyzing the character arc of the protagonist in the screenplay, specifically how her fear of deep water prevents her from saving her brother in act one.
> 
> Keeping in mind she hasn't overcome this phobia yet, how should she realistically react when the villain traps her on a sinking boat in the climax?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-022

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> Okay so we finally finalized the guest list for the outdoor wedding, seated 120 people across 15 tables, and chose a family-style Italian menu. The caterer needs the final seating chart and dietary restriction breakdown by 8 AM tomorrow.
> 
> I just got a text from the groom's aunt saying she's now strictly vegan and allergic to nuts, so how do I adjust the menu and seating without messing up the already printed place cards?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-023

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> We've been going over the chord progressions for my acoustic song, settling on a verse in E minor and a chorus in G major.
> 
> My pinky finger is currently injured, so what voicing should I use for the transition chord on a standard-tuned guitar?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-024

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> 1. We picked a mid-century modern aesthetic for the living room.
> 2. We selected a low-profile velvet sofa in emerald green.
> 3. We agreed on a large abstract rug to anchor the space.
> 
> My apartment is on the fourth floor with no elevator, and the sofa I ordered won't fit up the stairwell. What type of modular or flat-pack seating alternatives fit the mid-century vibe but can actually be carried up in boxes?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-025

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> Over the last few days we've been building a Python script to automate my freelance invoicing, pulling hours from a CSV and generating PDFs with ReportLab. We got the text alignment working perfectly and added the company logo to the header.
> 
> The client just emailed me asking for the invoices to be strictly in HTML format so they can parse them directly into their accounting software, so how do I refactor the PDF generation logic?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-026

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> We spent the whole afternoon planning a stealth section for my tabletop RPG campaign, where the party has to sneak past a sleeping dragon using only shadows and silence spells.
> 
> The rogue just rolled a critical fail on their stealth check and knocked over a suit of armor; what is the most immediate consequence that doesn't result in a total party kill?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-027

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> I've been trying to get my smart TV to connect to the hidden 5GHz network we set up last week. I tried forgetting the network, restarting the router, changing the SSID to remove spaces, and even factory resetting the TV. Nothing works, and I absolutely refuse to pay for a tech support call or buy a new streaming stick right now.
> 
> What obscure network setting or workaround on the router side can force the TV to see the hidden SSID without compromising my security?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-028

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> In our study session, we broke down the causes of the 1970s oil crisis, focusing on the OAPEC embargo, the devaluation of the dollar, and the peak oil theory. We also outlined how this led to the creation of the Strategic Petroleum Reserve.
> 
> If I need to write a 500-word essay comparing this event to the 2022 energy crisis in Europe, which two specific economic indicators should I focus on to show the strongest parallel?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-029

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> We've been designing a custom terrarium for a dart frog, selecting sphagnum moss, a false bottom with LECA clay, and a background of cork bark.
> 
> The glass enclosure I bought lacks a pre-drilled hole for the misting system tubing, so how can I route the water line without compromising the seal?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

---

## batch 채택 결정

**20%를 보고 아무 말도 하지 않는 것은 채택이 아닙니다.** 판정을 채우신 뒤 아래를 기입해 주세요.

| 항목 | 값 |
|---|---|
| 검수자 | |
| 검수일 | |
| 채택 건수 | |
| 반려 건수 | |
| batch 결정 | <!-- 채택 / 전건 재검수 / 폐기 --> |

반려가 나오면 그 항목은 새 id로 다시 씁니다. cell 목표는 **채택본** 기준이므로, 반려분은
목표 수에 포함되지 않습니다.

