# document_and_attachment-en-002 — `document_and_attachment/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=document_and_attachment-en-002`
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
| promptTemplate | `router-eval-draft-v3` (`64314b07ab594279`) |
| generatorCommit | `b6a6433` |
| draftedAt | 2026-08-26T04:09:12.003Z |

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
| 0.20 | 0.02 | `document-en-006` ~ `document-en-014` | document_and_attachment/en |
| 0.20 | 0.14 | `document-en-002` ~ `document-en-007` | document_and_attachment/en |
| 0.20 | 0.07 | `document-en-006` ~ `document-en-007` | document_and_attachment/en |
| 0.20 | 0.09 | `document-en-006` ~ `document-en-012` | document_and_attachment/en |
| 0.19 | 0.03 | `document-en-011` ~ `document-en-014` | document_and_attachment/en |
| 0.18 | 0.03 | `doc-en-001` ~ `document-en-011` | document_and_attachment/en |
| 0.18 | 0.08 | `document-en-011` ~ `document-en-012` | document_and_attachment/en |
| 0.17 | 0.03 | `doc-en-001` ~ `document-en-005` | document_and_attachment/en |
| 0.17 | 0.03 | `document-en-004` ~ `document-en-014` | document_and_attachment/en |
| 0.17 | 0.02 | `document-en-009` ~ `document-en-011` | document_and_attachment/en |

---

## 후보 — 판정할 14건

### document-en-001

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> Based on the attached PDF invoice, does the total amount due exceed our $5,000 departmental budget limit?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-002

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> Where is the emergency exit located on the attached image of this floor plan?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-003

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> I need to present the attached PDF slides tomorrow morning, but I don't have access to presentation software right now. Summarize the key talking points from the slides so I can present from my notes.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-004

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> I can't open the attached PDF schematic on my phone. Can you read the part numbers for the capacitors listed in the BOM table and tell me if any are obsolete?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-005

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> Does the attached spreadsheet contain a column for the shipping tracking number?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-006

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> I tried running the code shown in the attached image but keep getting a syntax error on line 14. What is causing the error and how do I fix it without using any external libraries?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-007

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> What is the voltage rating shown on the capacitor in the attached photo?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-008

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> We have a strict $500 budget for this event. Looking at the attached PDF catering menu, which appetizer options can we afford if we need to feed 50 people?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-009

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> I've attached an image of our competitor's pricing page. Extract the three tiers and their monthly costs, and note if any tier includes a free trial.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-010

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> Look at the attached PDF flowchart. Trace the path a user takes when they forget their password and list every email trigger that occurs during that flow.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-011

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> Please review the attached image of the restaurant receipt. I need to know the subtotal, the tax applied, and the final total, but specifically tell me if a service charge was already included.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-012

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> Translate the handwritten text in the attached image into English, but keep it under 100 words since I need to fit it into a character-limited tweet.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-013

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> Attached is a spreadsheet of our inventory. Tell me which items are currently listed as out of stock but have a reorder status of "pending".

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-en-014

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted`

> I already tried using an OCR tool on the attached photo of the serial number plate, but it failed to read it. Can you decipher the serial number and model number manually from the image?

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

