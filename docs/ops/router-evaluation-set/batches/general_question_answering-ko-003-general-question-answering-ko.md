# general_question_answering-ko-003 — `general_question_answering/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=general_question_answering-ko-003`
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
| promptTemplate | `router-eval-draft-v1` (`1d8171ee6fdd49d9`) |
| generatorCommit | `1ca47b2` |
| draftedAt | 2026-08-25T11:57:00.693Z |

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
| 0.26 | 0.14 | `general-ko-004` ~ `general-ko-013` | general_question_answering/ko |
| 0.20 | 0.08 | `general-ko-002` ~ `general-ko-009` | general_question_answering/ko |
| 0.18 | 0.07 | `general-ko-010` ~ `general-ko-014` | general_question_answering/ko |
| 0.15 | 0.00 | `general-ko-006` ~ `general-ko-011` | general_question_answering/ko |
| 0.14 | 0.03 | `general-ko-004` ~ `general-ko-014` | general_question_answering/ko |
| 0.13 | 0.09 | `general-ko-006` ~ `general-ko-009` | general_question_answering/ko |
| 0.13 | 0.04 | `general-ko-004` ~ `general-ko-006` | general_question_answering/ko |
| 0.12 | 0.06 | `general-ko-013` ~ `general-ko-014` | general_question_answering/ko |
| 0.12 | 0.08 | `general-ko-002` ~ `general-ko-006` | general_question_answering/ko |
| 0.12 | 0.00 | `general-ko-003` ~ `general-ko-010` | general_question_answering/ko |

---

## 후보 — 판정할 14건

### general-ko-001

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 지하철에서 핸드폰을 잃어버렸는데 어떻게 찾아야 하나요? 분실물센터 연락처랑 절차 좀 알려주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-002

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 한국에서 가장 인기 있는 김치 종류 다섯 가지를 알려주고, 각각 어떤 재료로 만드는지 간단히 설명해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-003

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아이가 초등학교 입학하는데 준비해야 할 필수품 목록을 알려주세요. 교복, 책가방, 학용품 등 구체적으로요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-004

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 집에서 간단하게 만들 수 있는 한식 반찬 세 가지 추천해 주세요. 재료도 쉽게 구할 수 있는 걸로요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-005

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 공공 와이파이 사용하다가 개인정보 유출 위험이 있다고 들었는데, 어떻게 안전하게 쓸 수 있나요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-006

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 겨울에 실내에서 키우기 좋은 식물 세 가지 알려주시고, 관리법도 간단히 설명해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-007

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 대학원 진학을 고민 중인데, 취업 시장에서 석사 학위가 실제로 도움이 되는 분야가 어떤 게 있나요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-008

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 집에서 에어컨 필터를 청소하려고 하는데, 어떤 도구가 필요하고 어떻게 해야 하는지 순서대로 알려주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-009

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 한국에서 외국인 등록증을 발급받으려면 어떤 서류가 필요하고, 어디서 신청해야 하나요? 절차도 간단히 설명해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-010

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아이가 갑자기 고열이 나고 목이 부었는데, 집에서 할 수 있는 응급처리법과 병원 갈 시점을 알려주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-011

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 서울에서 주말에 가족과 함께 가기 좋은 무료 또는 저렴한 문화 공간 세 군데 추천해 주세요. 교통편도 간단히 알려주시면 좋겠어요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-012

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 노트북 배터리가 빨리 닳는 것 같아요. 배터리 수명을 늘리기 위한 실용적인 팁 다섯 가지 알려주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-013

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 한국에서 직장인이 퇴근 후 자기계발을 위해 할 수 있는 활동 세 가지 추천해 주세요. 시간과 비용이 적게 드는 걸로요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### general-ko-014

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 집에서 라면 끓일 때 더 맛있게 만드는 비법 다섯 가지 알려주세요. 재료 추가 없이 할 수 있는 방법으로요.

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

