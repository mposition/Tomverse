# document_and_attachment-ko-002 — `document_and_attachment/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=document_and_attachment-ko-002`
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
| promptTemplate | `router-eval-draft-v2` (`f21349bfb3763aef`) |
| generatorCommit | `7eb0f88` |
| draftedAt | 2026-08-26T00:59:40.757Z |

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
| 0.09 | 0.02 | `document-ko-005` ~ `document-ko-013` | document_and_attachment/ko |
| 0.06 | 0.00 | `document-ko-002` ~ `document-ko-013` | document_and_attachment/ko |
| 0.06 | 0.02 | `document-ko-007` ~ `document-ko-013` | document_and_attachment/ko |
| 0.06 | 0.00 | `document-ko-002` ~ `document-ko-008` | document_and_attachment/ko |
| 0.06 | 0.02 | `document-ko-005` ~ `document-ko-007` | document_and_attachment/ko |
| 0.05 | 0.00 | `doc-ko-001` ~ `document-ko-005` | document_and_attachment/ko |
| 0.05 | 0.00 | `document-ko-009` ~ `document-ko-014` | document_and_attachment/ko |
| 0.05 | 0.00 | `document-ko-009` ~ `document-ko-013` | document_and_attachment/ko |
| 0.04 | 0.00 | `document-ko-001` ~ `document-ko-004` | document_and_attachment/ko |
| 0.04 | 0.00 | `document-ko-005` ~ `document-ko-009` | document_and_attachment/ko |

---

## 후보 — 판정할 14건

### document-ko-001

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 이 카페 영수증 이미지보고 총 할인 금액이 얼마인지 딱 숫자만 알려줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-002

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 첨부한 PDF 공고문에 접수 마감일이랑 제출 서류 목록 어디에 나와 있어?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-003

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 붙여넣은 엑셀 가계부에서 이번 달 식비랑 교통비 합계 좀 뽑아줄래?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-004

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 이 오류 화면 캡처본 봐도 어떤 프로그램 충돌인지 감이 안 오는데 뭐가 문제일까?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-005

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 첨부한 PPT 기획안 내용 바탕으로 10장 내외의 발표 대본을 써줘. 근데 나 PPT 노트 기능 못 쓰니까 A4 용지에 인쇄해서 볼 수 있게 타임라인 형태로 정리해 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-006

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 이 여행 계획서 엑셀 파일에 적힌 숙박비랑 식비 다 더하면 50만 원 넘을까? 50만 원 안에서 맞춰야 하는데 초과하는 항목만 골라서 빼자.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-007

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 첨부한 병원 진료비 세부내역서 이미지로 실비 보험 청구서 쓰려고 하는데, 내가 직접 엑셀로 쳐보려다 질병코드 매핑하는 거 실패했어. 질병코드랑 비급여 항목만 추려서 CSV 포맷 텍스트로 바로 복사할 수 있게 뽑아줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-008

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 내일 오전 9시까지 제출해야 하는 국세청 연말정산 간소화 PDF 자료인데, 의료비랑 교육비 공제 한도 초과분만 빠르게 계산해서 알려줄 수 있어? 시간 없어서 전체 다 못 보겠어.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-009

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 첨부한 아파트 관리비 고지서 이미지에서 전기요금, 수도요금, 장기수선충당금은 내가 이미 장부에 적었어. 나머지 항목들만 이름이랑 금액 짝 맞춰서 마크다운 표로 만들어 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-010

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 제가 쓴 자기소개서 한글 파일 첨부했는데, 지원하려는 공공기관 직무 특성상 너무 주관적인 표현은 피하는 게 좋대요. 문장별로 너무 감성적인 단어 쓰인 부분 몇 군데만 집어서 어떻게 고치면 좋을지 조언 좀 해주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-011

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 첨부된 등기부등본 PDF 열어서 근저당권 설정 금액이랑 채권최고액이랑 비교해 보고, 만약 집주인이 이자까지 포함해서 설정해 놓은 게 맞는지 법적 상식 선에서 검토해 봐.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-012

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 이 계약서 스캔본 이미지 봤을 때 특약사항에 '원상복구'랑 관련된 문구가 애매하게 적혀 있는데, 세입자한테 불리하게 해석될 여지가 있는 건지 솔직하게 평가해 줄래?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-013

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 첨부한 사내 보안 지침 PDF 파일을 신입사원들도 한눈에 이해할 수 있게 핵심 금지 사항 위주로 3줄 요약해 줘. 이모티콘은 쓰지 말고 딱딱한 사내 메일 톤으로.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### document-ko-014

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted`

> 캡처로 붙여넣은 두 장의 인터넷 요금제 비교표 이미지에서, 약정 기간이랑 위약금 조건만 쏙 빼서 서로 뭐가 다른지 대조표로 만들어 줄 수 있니?

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

