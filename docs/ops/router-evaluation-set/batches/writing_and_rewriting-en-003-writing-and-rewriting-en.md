# writing_and_rewriting-en-003 — `writing_and_rewriting/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=writing_and_rewriting-en-003`
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
| provider | `zhipu` |
| modelId (Tomverse) | `glm-5.2` |
| 요청한 api model | `glm-5.2` |
| 응답이 밝힌 version | `glm-5.2` — **요청의 에코입니다. 버전 정보가 아닙니다** |
| 별칭이 가리킨 실제 모델 | *확정되지 않음 — no-alias-recorded* |
| 생성 파라미터 | `{"max_tokens":8000}` |
| promptTemplate | `router-eval-draft-v3` (`78577c97e7272ca1`) |
| generatorCommit | `9e03234` |
| draftedAt | 2026-08-26T03:24:28.568Z |

*"A set drafted by a routable model measures how well that model handles its own
phrasing."* 초안 모델과 같은 계열이 라우팅 후보에 있다면, 그 계열에 유리한 문체·문제
구성이 아닌지 특히 보아 주세요.

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **좋은 prompt인가**만 보시면 됩니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| exact duplicate prompt | corpus 전체 234건 | 0건 |
| cell ↔ language 정합성 | batch 14건 | 전건 통과 |
| status: candidate | batch 14건 | 전건 candidate |

### near-duplicate 상위 10쌍 (corpus 234건 대상)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 cell 안에서만 비교합니다 — 다른 cell은 다르라고 나눠 놓은 것이라 유사도가 낮은 게
당연하고, 그 값은 아무것도 말해주지 않습니다.

**이 batch 안에서만이 아니라 이미 쌓인 corpus 전체와 비교했습니다.** batch마다 따로 보면
각 batch는 다양해 보이는데 corpus는 같은 틀을 반복하는 상태를 놓칩니다.

| token | shape | 쌍 | cell |
|---|---|---|---|
| 0.17 | 0.00 | `write-en-001` ~ `writing-en-010` | writing_and_rewriting/en |
| 0.17 | 0.04 | `writing-en-009` ~ `writing-en-011` | writing_and_rewriting/en |
| 0.14 | 0.00 | `write-en-001` ~ `writing-en-012` | writing_and_rewriting/en |
| 0.13 | 0.03 | `writing-en-007` ~ `writing-en-011` | writing_and_rewriting/en |
| 0.13 | 0.02 | `write-en-001` ~ `writing-en-007` | writing_and_rewriting/en |
| 0.12 | 0.01 | `writing-en-004` ~ `writing-en-012` | writing_and_rewriting/en |
| 0.12 | 0.00 | `writing-en-007` ~ `writing-en-009` | writing_and_rewriting/en |
| 0.12 | 0.02 | `writing-en-009` ~ `writing-en-010` | writing_and_rewriting/en |
| 0.12 | 0.01 | `write-en-001` ~ `writing-en-003` | writing_and_rewriting/en |
| 0.12 | 0.02 | `write-en-001` ~ `writing-en-014` | writing_and_rewriting/en |

---

## 후보 — 판정할 14건

### writing-en-001

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Make this fit 280 characters without losing the statistic: "Our new report shows that 73% of remote workers feel more productive at home, but 45% also report feeling more isolated, and these trends have significant implications for workplace policy going forward."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-002

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Rewrite this in a warmer tone: "Per my last email, the deliverables were due yesterday. Please advise on status."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-003

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> I need to rewrite our FAQ page so a 6th grader could understand it. I can't use any screenshots or diagrams—text only. Take this section and simplify it: "Our cloud infrastructure leverages distributed computing nodes across multiple availability zones to ensure 99.9% uptime SLA compliance."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-004

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Help me write a project update for stakeholders that says we're two weeks behind schedule but have a recovery plan, without sounding like I'm making excuses. This goes out at 5pm today.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-005

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Cut this down to under 100 words for the executive summary, keep the dollar amounts: "After conducting a thorough analysis of our Q3 expenditures, we have determined that operational costs have risen by 18% year-over-year, primarily driven by increased software licensing fees totaling $340,000 and additional headcount in the engineering department amounting to $1.2M in new salaries."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-006

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> I've already tried writing this layoff announcement three times and each version came off as either too cold or too apologetic. The facts: 12 positions are being eliminated in the support team, effective March 1, with 8 weeks severance. Write a version that's direct but human.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-007

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Write a product description for our handmade ceramic mug. It needs to be under 50 words for the Amazon listing and must include the words "dishwasher safe" and "12 oz"—Amazon will reject the listing otherwise.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-008

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Turn this bullet point list into a short paragraph with the same information: "- Revenue up 22% YoY - New enterprise customers: 14 - Churn down to 3.1% - Expanded into DACH region"

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-009

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> I'm writing a LinkedIn post about leaving my company after 6 years. I want it to sound genuine, not like the typical "bittersweet announcement" everyone posts. Keep it under 200 words and don't use the word "journey."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-010

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Make this sound like it was written by a real person, not corporate PR: "We are committed to fostering a culture of innovation and continuous improvement across all organizational touchpoints."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-011

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Draft a tough email to a vendor who's missed their last three delivery dates. It needs to go out within the hour and I want it under 150 words. Don't threaten legal action, but make it clear we're evaluating alternatives.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-012

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Condense this into a single Slack message: "Hi team, I wanted to let everyone know that we've decided to move the weekly sync to Thursdays at 2pm instead of Mondays at 10am. This change will take effect starting next week. Please update your calendars accordingly and let me know if you have any conflicts."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-013

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Take this technical changelog and rewrite it for non-technical users. They don't need to know the implementation details, just what changed and how it affects them: "Refactored the auth middleware to use JWT instead of session cookies. Token expiry reduced to 15min with refresh token rotation. Deprecated the /v1/auth endpoint."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-en-014

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Can you rewrite this to avoid the words "synergy" and "leverage" anywhere: "Our goal is to leverage the synergy between marketing and sales teams to drive greater operational efficiency and cross-functional alignment."

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

