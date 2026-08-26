# writing_and_rewriting-ko-003 — `writing_and_rewriting/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=writing_and_rewriting-ko-003`
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
| promptTemplate | `router-eval-draft-v2` (`2312b923ccd98bd9`) |
| generatorCommit | `fde8f05` |
| draftedAt | 2026-08-26T00:44:08.168Z |

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
| 0.08 | 0.00 | `writing-ko-001` ~ `writing-ko-005` | writing_and_rewriting/ko |
| 0.07 | 0.00 | `write-ko-002` ~ `writing-ko-009` | writing_and_rewriting/ko |
| 0.06 | 0.00 | `writing-ko-001` ~ `writing-ko-010` | writing_and_rewriting/ko |
| 0.06 | 0.02 | `writing-ko-005` ~ `writing-ko-012` | writing_and_rewriting/ko |
| 0.05 | 0.00 | `writing-ko-001` ~ `writing-ko-013` | writing_and_rewriting/ko |
| 0.05 | 0.00 | `writing-ko-001` ~ `writing-ko-011` | writing_and_rewriting/ko |
| 0.05 | 0.00 | `writing-ko-001` ~ `writing-ko-012` | writing_and_rewriting/ko |
| 0.05 | 0.05 | `writing-ko-002` ~ `writing-ko-010` | writing_and_rewriting/ko |
| 0.05 | 0.00 | `writing-ko-010` ~ `writing-ko-013` | writing_and_rewriting/ko |
| 0.04 | 0.05 | `write-ko-001` ~ `writing-ko-009` | writing_and_rewriting/ko |

---

## 후보 — 판정할 14건

### writing-ko-001

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 당근마켓에 올릴 텐데 “직거래만 되고 택배 안 됨, 사용감 좀 있음” 이걸 정중하게 다듬어 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-002

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 모바일 청첩장 문구 좀 써줘. 신랑 신부가 30대 후반이라 너무 오글거리는 시적인 말은 빼고, 하객들이 읽기 편하게 300자 이내로 담백하게 부탁해. 화환은 정중히 거절하는 문장도 꼭 넣어줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-003

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 내일 연차 쓰려고 팀장님께 슬랙 드리는데 “급한 건 대리한테 물어보세요”라는 뉘앙스를 업무용 예의 갖추어 한 문장으로 어떻게 표현해야 할까?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-004

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아파트 관리실 안내문 작성해 줘. 지난달에 엘리베이터 CCTV 교체 예산이 부족해서 못 했거든. 이번 달 관리비 고지서에 포함해서 다음 주에 무조건 교체한다는 내용으로, 입주민들이 항의하지 않게 정중하고 명확하게 써줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-005

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 내가 쓴 맛집 리뷰 초안인데 좀 건조해. “음식이 빨리 나오고 맛있었다. 직원도 친절했다. 재방문 의사 있음.” 이걸 네이버 블로그 맛집 리뷰 특유의 이모티콘이랑 느낌표 팍팍 들어가는 과장된 톤으로 바꿔봐.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-006

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 동아리 신입생 모집 포스터에 들어갈 카피 라이팅 5개만 뽑아줘. 디자인 툴을 못 다뤄서 텍스트만 크게 넣을 거라, 글자 수 10자 이내의 강렬한 한 줄 문장들로만 구성해 줘. 내일까지 인쇄소 넘겨야 하니까 MZ세대 타겟이라는 핑계로 너무 추상적인 영어 단어는 쓰지 마.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-007

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 동료 아버지상 부의금 보낼 때 카톡으로 같이 보낼 짧은 위로의 말 좀 적어줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-008

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 룸메이트 구하는 글 써줘. 전에 올렸을 때 ‘소음 민감’이라고 썼더니 너무 예민해 보인다는 댓글만 달려서 실패했어. 이번엔 “서로 생활 패턴 존중하며 조용히 지내실 분” 정도로 순화하되, 반려동물은 절대 안 된다는 조건은 확실하게 박아줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-009

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> “귀사의 노고에 감사드립니다. 금번 프로젝트 납기일을 오는 15일까지 준수하여 주시기를 바랍니다.” 이 문장, 파트너십을 강조하는 부드러운 비즈니스 메일 톤으로 다듬어 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-010

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 카페 내일 휴무인데 인스타 스토리에 올릴 감성적인 공지 문구 좀 지어줘. 개인 사정 때문에 쉰다는 사실만 자연스럽게 녹이면 돼.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-011

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 공공기관 자기소개서 ‘직무 관련 경험’ 항목 써줘. 분량은 정확히 500자 공백 포함이야. 인턴 경험은 없고 아르바이트 경험밖에 없는데, 이걸 데이터 분석 역량과 억지로라도 연결해서 논리적으로 포장해 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-012

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 유튜브 쇼츠 오프닝 대본 고쳐줘. “오늘은 서울 시내 교통 통제 구간에 대해 알아보겠습니다.” 이걸 20대 유튜버가 카메라 보며 친구한테 말하듯 반말하고 추임새 팍팍 들어가는 스타일로 만들어 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-013

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> “내일 소풍 버스비가 안 걷힌 집은 아이를 못 보냅니다” 유치원 학부모 단톡방에 올릴 건데, 미납 시 참여 불가라는 사실은 유지하되 교육적이고 정중한 안내문 톤으로 순화해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### writing-ko-014

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 트윗 스레드로 영화 리뷰 올리려는데, 본문을 4개로 쪼개야 해. 각 트윗은 공백 포함 140자 이내여야 하고, 첫 번째 트윗 맨 앞에는 시선 끌 만한 훅(Hook) 문장이 들어가게 써줘. 스포일러는 절대 포함하지 마.

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

