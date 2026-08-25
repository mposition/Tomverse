# general_question_answering-en-003 — `general_question_answering/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=general_question_answering-en-003`
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
| provider | `mistral` |
| modelId (Tomverse) | `mistral-large-3` |
| 요청한 api model | `mistral-large-latest` — **이동형 별칭** |
| 응답이 밝힌 version | `mistral-large-latest` — **요청의 에코입니다. 버전 정보가 아닙니다** |
| 별칭이 가리킨 실제 모델 | `mistral-large-2512` (2026-08-25T11:52:23Z 조회) |
| 생성 파라미터 | `{"max_tokens":8000}` |
| promptTemplate | `router-eval-draft-v1` (`e5a41a7216301745`) |
| generatorCommit | `1ca47b2` |
| draftedAt | 2026-08-25T11:59:40.380Z |

> **요청한 이름이 이동형 별칭입니다.** 제공자가 이 별칭 뒤의 모델을 바꿀 수 있으므로,
> 같은 wave의 ko·en batch가 서로 다른 version에서 나왔을 수 있습니다. 그렇다면 두 언어의
> 차이로 읽히는 것이 실은 두 모델의 차이일 수 있습니다.

> 대조는 「별칭이 가리킨 실제 모델」로 하십시오. wave의 다른 batch가 다른 값을 적고 있다면
> 그 wave는 한 모델의 산출물이 아닙니다.

*"A set drafted by a routable model measures how well that model handles its own
phrasing."* 초안 모델과 같은 계열이 라우팅 후보에 있다면, 그 계열에 유리한 문체·문제
구성이 아닌지 특히 보아 주세요.

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **좋은 prompt인가**만 보시면 됩니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| exact duplicate prompt | corpus 전체 52건 | 0건 |
| cell ↔ language 정합성 | batch 14건 | 전건 통과 |
| status: candidate | batch 14건 | 전건 candidate |

### near-duplicate 상위 10쌍 (corpus 52건 대상)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 cell 안에서만 비교합니다 — 다른 cell은 다르라고 나눠 놓은 것이라 유사도가 낮은 게
당연하고, 그 값은 아무것도 말해주지 않습니다.

**이 batch 안에서만이 아니라 이미 쌓인 corpus 전체와 비교했습니다.** batch마다 따로 보면
각 batch는 다양해 보이는데 corpus는 같은 틀을 반복하는 상태를 놓칩니다.

| token | shape | 쌍 | cell |
|---|---|---|---|
| 0.27 | 0.16 | `general-en-002` ~ `general-en-009` | general_question_answering/en |
| 0.26 | 0.08 | `general-en-007` ~ `general-en-012` | general_question_answering/en |
| 0.24 | 0.00 | `gen-en-002` ~ `general-en-010` | general_question_answering/en |
| 0.24 | 0.15 | `general-en-006` ~ `general-en-014` | general_question_answering/en |
| 0.23 | 0.05 | `general-en-003` ~ `general-en-013` | general_question_answering/en |
| 0.21 | 0.00 | `general-en-005` ~ `general-en-013` | general_question_answering/en |
| 0.20 | 0.03 | `gen-en-001` ~ `general-en-007` | general_question_answering/en |
| 0.20 | 0.03 | `general-en-009` ~ `general-en-012` | general_question_answering/en |
| 0.18 | 0.00 | `general-en-004` ~ `general-en-010` | general_question_answering/en |
| 0.18 | 0.00 | `general-en-004` ~ `general-en-013` | general_question_answering/en |

---

## 후보 — 판정할 14건

### general-en-001

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> How do fireworks get their different colors? Give me the simple version without too much science jargon.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-002

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> Why do some people sneeze when they look at bright light, and is there a name for that?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-003

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> What’s the best way to remove a red wine stain from a white cotton shirt if I don’t have any special cleaners?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-004

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> Can you explain how a microwave oven actually heats food? I know it uses microwaves, but what’s happening inside the food?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-005

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> I keep hearing about '5G' but I don’t get what’s different from 4G. What does it let me do that I couldn’t before?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-006

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> How do those motion-sensor lights work? Do they detect heat, movement, or something else?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-007

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> What’s the deal with airplane turbulence? Is it dangerous, and why does it feel so much worse than bumps in a car?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-008

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> How do I tell if a battery is really dead or just needs a recharge? I have a drawer full of AAs and I don’t want to waste good ones.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-009

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> Why do some songs get stuck in my head for days, and is there a trick to make them stop?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-010

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> What’s the difference between baking soda and baking powder, and can I swap one for the other in a recipe?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-011

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> How do those self-checkout machines at grocery stores know if I’m scanning the right item? Do they weigh everything?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-012

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> Why does my phone battery drain so much faster when it’s cold outside? Is there a way to protect it in winter?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-013

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> What’s the simplest way to keep my glasses from fogging up when I wear a mask? I’ve tried soap but it doesn’t last.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-en-014

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> How do those automatic soap dispensers work? Do they sense my hand, or is it just a timer?

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

