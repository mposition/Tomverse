# long_context_conversation-ko-002 — `long_context_conversation/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=long_context_conversation-ko-002`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**후보 7건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

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
| 생성 파라미터 | `{"max_tokens":16000}` |
| promptTemplate | `router-eval-draft-v3` (`c9d6575639ae1177`) |
| generatorCommit | `b8014a9` |
| draftedAt | 2026-08-26T06:25:33.442Z |

*"A set drafted by a routable model measures how well that model handles its own
phrasing."* 초안 모델과 같은 계열이 라우팅 후보에 있다면, 그 계열에 유리한 문체·문제
구성이 아닌지 특히 보아 주세요.

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **좋은 prompt인가**만 보시면 됩니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| exact duplicate prompt | corpus 전체 234건 | 0건 |
| cell ↔ language 정합성 | batch 7건 | 전건 통과 |
| status: candidate | batch 7건 | 전건 candidate |

### near-duplicate 상위 10쌍 (corpus 234건 대상)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 cell 안에서만 비교합니다 — 다른 cell은 다르라고 나눠 놓은 것이라 유사도가 낮은 게
당연하고, 그 값은 아무것도 말해주지 않습니다.

**이 batch 안에서만이 아니라 이미 쌓인 corpus 전체와 비교했습니다.** batch마다 따로 보면
각 batch는 다양해 보이는데 corpus는 같은 틀을 반복하는 상태를 놓칩니다.

| token | shape | 쌍 | cell |
|---|---|---|---|
| 0.12 | 0.00 | `long-ko-006` ~ `long-ko-010` | long_context_conversation/ko |
| 0.10 | 0.03 | `long-ko-002` ~ `long-ko-014` | long_context_conversation/ko |
| 0.10 | 0.03 | `long-ko-001` ~ `long-ko-006` | long_context_conversation/ko |
| 0.07 | 0.00 | `long-ko-002` ~ `long-ko-010` | long_context_conversation/ko |
| 0.07 | 0.00 | `long-ko-003` ~ `long-ko-006` | long_context_conversation/ko |
| 0.06 | 0.00 | `long-ko-003` ~ `long-ko-010` | long_context_conversation/ko |
| 0.06 | 0.00 | `long-ko-008` ~ `long-ko-011` | long_context_conversation/ko |
| 0.06 | 0.00 | `long-ko-003` ~ `long-ko-012` | long_context_conversation/ko |
| 0.05 | 0.03 | `long-ko-002` ~ `long-ko-005` | long_context_conversation/ko |
| 0.05 | 0.00 | `long-ko-002` ~ `long-ko-006` | long_context_conversation/ko |

---

## 후보 — 판정할 7건

### long-ko-002

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아까 전세 보증금 3억에 강남권 알아보고 있고, HUG 전세자금대출 한도 2억이라고 하셨잖아요. 상황이 바뀌어서 보증금을 2억 5천으로 낮추려고 해요. 그럼 방금 말씀하신 대출 한도 안에서 자기자본 없이 가능할까요? 남은 5천은 HUG 말고 다른 대출로 끼울 수 있는 수도 있을까? 근데 이번 주 안에 직방에 올라오는 매물 기준으로 보고 싶어요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-003

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아까 부모님 부양가족 공제를 형제가 나눠 받는다고 하셨잖아요, 그럼 저랑 형이 반반으로 나누면 기본 공제 150에서 각각 75씩 들어가는 거죠?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-004

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 앞서 만두 만들 때 김치 물기 짜는 법이랑 고기는 앞다리살 쓴다고 했잖아요. 근데 집에 찜기가 없어요. 냄비에 채반 올려서 찌면 되나요, 아니면 프라이팬에 지지는 게 나을까요? 전자레인지로 익혀도 괜찮은지도 알려주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-005

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 앞에서 청약통장 2년 납입으로 서울 1순위 조건 됐다고 확인하셨죠. 근데 제가 6월까지 해외 출장이라 현장 방문이 안 되거든요. 그럼 그 자격으로 올해 분양 중에 인터넷으로만 청약할 수 있는 거 다 찾아주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-006

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아, 그럼 아까 말하신 두 번째 프로세스는 이번 달부터 바로 적용되는 건가요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-007

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 방금 수능 과학탐구 물리학 표준점수 유리하다고 하셨는데, 제 학교에서는 화학Ⅰ이랑 생명과학Ⅰ밖에 안 열어요. 방과 후 학원에서 물리Ⅰ을 들을 수는 있는데 내신 반영 비율이 높거든요. 수시만 노리고 있는데 이 상황에서는 어떻게 선택하는 게 맞을까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-008

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 처음에 물어본 등본 발급 방법 말인데요, 범죄이력 조회도 같이 해야 하거든요. 근데 지금 여권이 만료돼서 운전면허증밖에 없어요. 이거로 인터넷 발급 가능한가요? 금요일인데 오늘 오후까지 끝내야 해서요.

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

