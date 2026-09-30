# long_context_conversation-ko-009 — `long_context_conversation/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=long_context_conversation-ko-009`
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
| promptTemplate | `router-eval-draft-v3` (`89b8eb9a3e93c7cd`) |
| generatorCommit | `b8014a9` |
| draftedAt | 2026-08-26T06:29:26.252Z |

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
| 0.10 | 0.03 | `long-ko-010` ~ `long-ko-012` | long_context_conversation/ko |
| 0.10 | 0.02 | `long-ko-010` ~ `long-ko-011` | long_context_conversation/ko |
| 0.07 | 0.00 | `long-ko-002` ~ `long-ko-010` | long_context_conversation/ko |
| 0.07 | 0.00 | `long-ko-011` ~ `long-ko-012` | long_context_conversation/ko |
| 0.06 | 0.00 | `long-ko-003` ~ `long-ko-010` | long_context_conversation/ko |
| 0.06 | 0.00 | `long-ko-009` ~ `long-ko-015` | long_context_conversation/ko |
| 0.06 | 0.00 | `long-ko-008` ~ `long-ko-011` | long_context_conversation/ko |
| 0.06 | 0.00 | `long-ko-003` ~ `long-ko-012` | long_context_conversation/ko |

---

## 후보 — 판정할 7건

### long-ko-009

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 이전에 해외송금 서류로 사업자등록증과 통장 사본 필요하다고 하셨죠. 그런데 지금 4시 20분인데 동네 은행 마감이 4시 반이에요. 집에 프린터가 없는데 파일을 카톡으로 보내면 은행에서 출력해 줄까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-010

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아까 도배는 해주신다고 하셨죠, 이번 주말에 이미 이사를 가거든요, 그럼 그냥 도배 없이 넘어가는 게 나을까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-011

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 위에서 떡볶이 떡 미리 불려놓는 게 좋다고 하셨죠. 근데 물에 불렸다가 전자레인지에 돌릴까 했는데, 지금 전자레인지가 고장났어요. 그럼 그냥 냄비에 찬물이랑 같이 바로 끓여도 괜찮을까요? 떡이 터지거나 덜 익진 않을까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-012

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 전에 월세 세액공제 안 받으면 주택마련저축 비과세도 못 받는다고 하셨죠, 그럼 5월 연말정산 때 소급해서라도 청구하는 게 이득일까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-013

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 처음에 말씀하신 상황판단 문제 결론부터 쓰는 방식대로 풀어봤는데, 문제당 1분 안에 끝나야 할 걸 3분씩 넘기거든요. 시간 단축을 위해 생략해도 되는 단계가 있을까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-014

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 방금 중고거래는 무조건 직거래하고 당일 송금 받으라고 하셨잖아요. 근데 저는 지방이라 직거래가 불가능하고 택배로만 보내야 해요. 이 경우 안전거래로 묶어서 발송하는 것 외에 판매자가 보호받을 수 있는 다른 수가 있을까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-015

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아까 플러터로 안드로이드 앱 빌드하는 법 따라서 에뮬레이터까지는 돌렸어요. 그런데 애플 앱스토어 등록하려면 맥북이 꼭 필요하다고 하셨죠? 제가 맥북이 없어서 우분투 VM을 쓰려고 하는데, 여기서 iOS 빌드 우회하는 방법이 있을까요?

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

