# translation_cross_language-ko-en-003 — `translation_cross_language/ko-en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=translation_cross_language-ko-en-003`
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
| promptTemplate | `router-eval-draft-v2` (`01ba29d3ee8751b1`) |
| generatorCommit | `7eb0f88` |
| draftedAt | 2026-08-26T01:12:33.909Z |

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
| 0.08 | 0.03 | `translation-ko-en-003` ~ `translation-ko-en-008` | translation_cross_language/ko-en |
| 0.08 | 0.00 | `translation-ko-en-002` ~ `translation-ko-en-013` | translation_cross_language/ko-en |
| 0.07 | 0.00 | `translation-ko-en-001` ~ `translation-ko-en-007` | translation_cross_language/ko-en |
| 0.07 | 0.00 | `translation-ko-en-002` ~ `translation-ko-en-007` | translation_cross_language/ko-en |
| 0.07 | 0.00 | `xlang-001` ~ `translation-ko-en-005` | translation_cross_language/ko-en |
| 0.07 | 0.04 | `translation-ko-en-003` ~ `translation-ko-en-014` | translation_cross_language/ko-en |
| 0.06 | 0.00 | `translation-ko-en-003` ~ `translation-ko-en-012` | translation_cross_language/ko-en |
| 0.05 | 0.01 | `translation-ko-en-008` ~ `translation-ko-en-014` | translation_cross_language/ko-en |
| 0.05 | 0.00 | `translation-ko-en-002` ~ `translation-ko-en-009` | translation_cross_language/ko-en |
| 0.05 | 0.00 | `translation-ko-en-012` ~ `translation-ko-en-014` | translation_cross_language/ko-en |

---

## 후보 — 판정할 14건

### translation-ko-en-001

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> '배송 출발 후 주소 변경은 불가능합니다'를 영어로 어떻게 쓰는 게 가장 자연스러울지 알려줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-002

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> '본인 확인을 위해 여권 사본을 제출해 주시기 바랍니다' 이 문장 영어로 번역 좀 해줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-003

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 모바일 앱 버튼에 들어갈 텍스트인데 '계정 삭제 및 모든 데이터 영구 삭제' 이걸 영어로 번역해 줘. 근데 버튼 너비 때문에 공백 포함 25자 안쪽으로 만들어야 해.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-004

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 해외 파트너사한테 보내는 이메일 초안 써줘. '귀사의 제안서 잘 받아보았습니다. 다만 현재 분기 예산이 소진되어 다음 분기에 다시 논의하고 싶습니다.' 이 내용을 영어로 옮기는데, 'budget'이나 'money' 같은 직접적인 돈 관련 단어는 안 쓰고 완곡하게 표현해 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-005

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 정기 점검 관계로 오늘 밤 12시부터 다음 날 새벽 4시까지 서비스 이용이 제한된다는 안내문 영어로 번역해.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-006

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 학회 발표 슬라이드에 넣을 불렛 포인트 3개로 나눠서 번역해 줘. 원문: '첫째, 기존 모델 대비 추론 속도가 40% 향상되었습니다. 둘째, 메모리 사용량을 절반으로 줄였습니다. 셋째, 멀티모달 입력을 기본으로 지원합니다.' 각 불렛은 동사로 시작하게 맞춰주고.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-007

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 주차장 만차 시 인근 공영 주차장을 이용해 주시기 바랍니다라는 문구를 영어로 뭐라고 안내하는 게 좋은지 추천해.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-008

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 사내 위키에 올릴 FAQ 답변인데, '비밀번호 재설정 이메일이 오지 않는 경우 스팸함 확인 후 24시간이 지나도 없으면 IT 지원팀에 티켓을 발급하세요.' 이걸 영어로 번역해. 근데 우리 티켓팅 시스템 링크를 넣을 자리가 마땅찮으니까 'IT 지원팀에 티켓을 발급하세요' 부분은 그냥 'contact the IT helpdesk' 정도로 뭉뚱그려서 번역해 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-009

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> '식물성 재료만 사용한 비건 인증 제품입니다.' 이걸 영어로 쓸 건데, 마케팅 배너에 쓸 거라 좀 임팩트 있는 버전이랑, 제품 뒷면 성분표 옆에 쓸 점잖은 버전 두 가지로 줘봐.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-010

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 트위터에 올릴 회사 공지야. '신규 입사자 대상 보안 교육 일정이 다음 주 월요일로 변경되었습니다. 반드시 사전에 배포된 교재를 읽어오세요.' 이걸 영어로 번역하되, 해시태그 2개를 포함해서 전체 280자 제한에 맞게 써줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-011

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 번역기 돌린 건데 너무 어색해서. 'The room is cleaned every day at 10 AM. If you do not want it, hang the sign.' 이거 호텔 객실 안내문 원문이 '매일 오전 10시에 객실 청소가 이루어집니다. 원치 않으실 경우 문고리에 표지를 걸어주세요'거든. 이 원문 느낌 살려서 자연스러운 영어로 고쳐줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-012

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 한국 추석 연휴 휴무 안내를 해외 지사 직원들에게 보내려고 해. '추석 연휴 관계로 9월 28일부터 30일까지 한국 오피스는 쉽니다. 긴급한 건은 온콜 번호로 연락 바랍니다.' 이걸 그냥 날짜만 바꾸는 게 아니라, 한국 명절이라 오피스가 쉰다는 뉘앙스를 살리면서 미국 본사 사람들이 이해하기 쉬운 비즈니스 영어로 다듬어 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-013

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 보행자 보호를 위해 캠퍼스 내에서는 시속 20km 이하로 서행해 주십시오라는 안내문을 영어로 바꿔.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### translation-ko-en-014

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> '사용자가 결제를 취소하면, 시스템은 자동으로 재고를 복구하고 관리자에게 알림을 보냅니다.' 이 아키텍처 문서 문장을 영어로 번역해 줘. 단, '재고'는 'inventory'가 아니라 우리 회사 내부 용어인 'stock pool'로, '관리자'는 'admin' 대신 'system operator'로 고정해서 써야 해.

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

