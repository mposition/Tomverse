# current_information-ko-002 — `current_information/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=current_information-ko-002`
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
| 생성 파라미터 | `{"max_tokens":16000}` |
| promptTemplate | `router-eval-draft-v3` (`3ce3ebba59aabd2f`) |
| generatorCommit | `13b46e5` |
| draftedAt | 2026-08-26T05:29:32.173Z |

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
| 0.10 | 0.05 | `current-ko-004` ~ `current-ko-012` | current_information/ko |
| 0.09 | 0.00 | `current-ko-005` ~ `current-ko-014` | current_information/ko |
| 0.08 | 0.00 | `current-ko-004` ~ `current-ko-015` | current_information/ko |
| 0.08 | 0.00 | `current-ko-004` ~ `current-ko-008` | current_information/ko |
| 0.07 | 0.00 | `current-ko-008` ~ `current-ko-014` | current_information/ko |
| 0.06 | 0.00 | `current-ko-002` ~ `current-ko-010` | current_information/ko |
| 0.06 | 0.00 | `current-ko-001` ~ `current-ko-008` | current_information/ko |
| 0.06 | 0.00 | `current-ko-004` ~ `current-ko-014` | current_information/ko |
| 0.05 | 0.00 | `current-ko-005` ~ `current-ko-008` | current_information/ko |
| 0.05 | 0.00 | `current-ko-002` ~ `current-ko-006` | current_information/ko |

---

## 후보 — 판정할 14건

### current-ko-002

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 최근 개정된 노인장기요양보험 등급 산정 방식이 어떻게 바뀌었나요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-003

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 다음 달 초에 출국 예정이라 시간이 없는데, 여권법이 개정되면서 단기여권 발급 절차가 달라졌다고 들었어요. 온라인 예약 없이도 현장에서 당일 발급이 가능한가요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-004

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 2024년 청년도약계좌 가입 대상과 한도를 현재 기준으로 정리해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-005

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 국민건강보험공단 앱으로 건강검진 예약을 계속 시도했는데 오류만 떠요. 전화도 안 터지고. 최근에 시스템이 바뀐 건지, 다른 접수 창구가 있는지 알아봐 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-006

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 용도지역이 자연녹지인 땅에 간판을 설치하려고 합니다. 최근 건축법 시행령 개정으로 달라진 간판 규제 기준을 알려주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-007

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 월세 소득공제 한도가 최근에 바뀌었다던데, 세법 개정안에 명시된 구체적 수치와 적용 시기를 찾아주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-008

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 예산 50만 원 이내로 참여 가능한 정부지원 창업교육 프로그램을 서울에서 찾고 있어요. 현재 접수 중인 것만 추려 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-009

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 2024년부터 운전면허 갱신 주기가 달라졌다는데 구체적인 변경 내용을 알려주세요. 특히 고령 운전자 기준도 포함해서요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-010

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> K-전직훈련(K-MOVE) 사업 최신 신청 자격이 어떻게 되나요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-011

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아이폰이 고장나서 지금 안드로이드로밖에 접속을 못 하는데, 공인인증서를 안 쓰게 되면서 어떤 대체 인증 수단이 생겼는지 궁금합니다. 안드로이드 기기로 쓸 수 있는 방법이 뭔가요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-012

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 2025학년도 대학 수시 모집에서 학생부 교과 전형 비율을 높인 주요 대학들의 변화를 정리해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-013

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 올해 다자녀 양육기관 휴직 제도 개정안의 핵심 변경 사항이 뭐예요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-014

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 의료비 공제 신청할 때 가족 관계 서류가 계속 반려되어서 종합소득세 신고를 못 끝내고 있어요. 올해 세법 개정으로 바뀐 부분이 있는지, 현재 기준 서류 제출 기준이 어떻게 되는지 확인해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-015

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted`

> 올해부터 시행되는 플라스틱 일회용품 규제에서 컵 사용이 제한되는 업종과 예외 업종을 환경부 최신 발표 기준으로 구분해 주세요.

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

