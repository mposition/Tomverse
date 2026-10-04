# analysis_and_reasoning-ko-003 — `analysis_and_reasoning/ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=analysis_and_reasoning-ko-003`
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
| promptTemplate | `router-eval-draft-v2` (`5cf41fa8fc102528`) |
| generatorCommit | `7eb0f88` |
| draftedAt | 2026-08-26T00:52:07.422Z |

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
| 0.09 | 0.04 | `analysis-ko-005` ~ `analysis-ko-009` | analysis_and_reasoning/ko |
| 0.07 | 0.02 | `analysis-ko-009` ~ `analysis-ko-010` | analysis_and_reasoning/ko |
| 0.05 | 0.02 | `analysis-ko-007` ~ `analysis-ko-010` | analysis_and_reasoning/ko |
| 0.04 | 0.02 | `analysis-ko-011` ~ `analysis-ko-014` | analysis_and_reasoning/ko |
| 0.04 | 0.02 | `analysis-ko-009` ~ `analysis-ko-013` | analysis_and_reasoning/ko |
| 0.04 | 0.02 | `analysis-ko-007` ~ `analysis-ko-008` | analysis_and_reasoning/ko |
| 0.03 | 0.00 | `reason-ko-002` ~ `analysis-ko-011` | analysis_and_reasoning/ko |
| 0.03 | 0.00 | `analysis-ko-003` ~ `analysis-ko-005` | analysis_and_reasoning/ko |
| 0.03 | 0.00 | `analysis-ko-009` ~ `analysis-ko-011` | analysis_and_reasoning/ko |
| 0.03 | 0.00 | `reason-ko-002` ~ `analysis-ko-010` | analysis_and_reasoning/ko |

---

## 후보 — 판정할 14건

### analysis-ko-001

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 전세로 들어갈 집 등기부등본에 근저당이 3억 있고 집값이 5억인데 전세가가 3억 5천이면 내가 후순위라 위험한 건가요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-002

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 예산이 딱 500만 원 남았는데 다음 주까지 신제품 론칭 홍보를 해야 해. 인플루언서 마케팅이랑 메타 광고 중 하나만 골라야 한다면 어떤 기준으로 판단해서 어디에 몰빵해야 할까?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-003

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> NCS 준비하는데 모듈형이랑 국가직무능력표준 기반 문제가 섞여 나오잖아. 내가 수리 능력은 강한데 상황 판단이 약한데, 남은 한 달 동안 어떤 비율로 공부 시간을 배분하는 게 합리적일까?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-004

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 사설 업체에서 아이폰 배터리를 13만 원보다 싸게 교체할 때 정품 대비 감수해야 할 장기적 리스크와 이득의 균형을 어떻게 봐야 할까요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-005

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 우리 팀에 백엔드 개발자가 나랑 주니어 한 명밖에 없어서 MSA는 엄두도 못 내고 모놀리식으로 가고 있는데, 트래픽이 다음 달에 10배로 뛸 게 확실시되는 상황에서 DB 샤딩 없이 버틸 수 있는 아키텍처 대안이 뭐가 있을까?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-006

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 중소기업 재직자 소득세 감면 신청을 뒤늦게 하게 됐는데, 소급 적용이 안 되는 기간에 대한 세금 불이익을 최소화할 현실적인 방법이 있나요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-007

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 사내 워크숍 장소로 제주도를 보려 했는데 항공권이 이미 다 매진되었고, 예산은 1인당 50만 원으로 고정되어 있어. 이 조건에서 대체지로 가장 합리적인 국내 지역 두 곳과 그 선정 이유를 비교 분석해 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-008

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 올해 주식 양도소득세 대주주 요건이 10억 원으로 바뀌면서 연말에 일부러 매도하는 물량이 나올 텐데, 내가 보유한 중소형주도 이 영향에서 자유로울지 시나리오별로 따져보고 대응 전략을 짜고 싶어.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-009

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 간헐적 단식 16:8 유지 중 오후 3시 피로로 업무 효율이 떨어지는데 인슐린 스파이크 없이 이 시간대만 공복을 깨지 않고 버틸 수 있는 영양학적 대안이 뭔가요?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-010

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 공공기관 납품용 소프트웨어 입찰을 준비해야 하는데, 요구사항에 오픈소스 라이선스 중 GPL 계열은 절대 포함되면 안 된다는 조항이 있어. 이 제약 하에서 React 대신 쓸 수 있는 프론트엔드 프레임워크 후보들을 비교해 주고, 각 라이선스 리스크도 평가해 줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-011

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 수시 전형으로 의대랑 약대 동시 지원을 고려 중인데, 내신은 1.2등급이지만 비교과 활동이 전부 환경 봉사 위주라 의학적 적합성을 어필하기 애매해. 이 스토리를 어떻게 재구성해야 두 전공의 면접관 모두에게 통할 수 있을지 교집합을 찾아줘.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-012

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 중국발 요소수 대란 때처럼 이번 달에 핵심 원자재 납기가 3주 지연될 전망인데, 우리 공장 재고로는 10일치밖에 안 남아. 가동률을 70%로 줄여서 버티는 것과 대체 공급처에서 2배 비싼 값에 긴급 조달하는 것 중 재무적 타격이 적은 쪽은 어디야?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-013

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 키오스크 주문 화면에서 장년층의 이탈률이 유독 높은데, 글자 크기를 키우는 것 말고도 인지 부하를 줄일 수 있는 UI 흐름 개선안을 연령대별 디지털 리터러시 차이 관점에서 도출해 봐.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-ko-014

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 만약 내일 당장 기준금리가 1% 포인트 긴급 인상된다면, 변동금리 주택담보대출을 고정금리로 갈아타기 위한 골든타임과 손익분기점을 어떻게 계산해야 할까?

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

