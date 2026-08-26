# analysis_and_reasoning-en-003 — `analysis_and_reasoning/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=analysis_and_reasoning-en-003`
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
| promptTemplate | `router-eval-draft-v3` (`32b63a57caf8c411`) |
| generatorCommit | `b6a6433` |
| draftedAt | 2026-08-26T03:58:33.413Z |

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
| 0.28 | 0.14 | `analysis-en-004` ~ `analysis-en-013` | analysis_and_reasoning/en |
| 0.15 | 0.01 | `analysis-en-006` ~ `analysis-en-010` | analysis_and_reasoning/en |
| 0.15 | 0.05 | `analysis-en-002` ~ `analysis-en-004` | analysis_and_reasoning/en |
| 0.14 | 0.02 | `analysis-en-013` ~ `analysis-en-014` | analysis_and_reasoning/en |
| 0.13 | 0.03 | `analysis-en-008` ~ `analysis-en-012` | analysis_and_reasoning/en |
| 0.13 | 0.03 | `analysis-en-005` ~ `analysis-en-010` | analysis_and_reasoning/en |
| 0.13 | 0.03 | `analysis-en-002` ~ `analysis-en-005` | analysis_and_reasoning/en |
| 0.13 | 0.00 | `analysis-en-007` ~ `analysis-en-008` | analysis_and_reasoning/en |
| 0.13 | 0.00 | `analysis-en-008` ~ `analysis-en-013` | analysis_and_reasoning/en |
| 0.13 | 0.00 | `analysis-en-012` ~ `analysis-en-013` | analysis_and_reasoning/en |

---

## 후보 — 판정할 14건

### analysis-en-001

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> If we only have a $5k monthly ad budget, should we put it all into LinkedIn or split it with Google Ads for our B2B SaaS launch?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-002

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> If our cloud provider doubles egress fees next month, what's the cheapest way to keep our backup strategy intact without losing data redundancy?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-003

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> Why would a serverless architecture end up costing more than containerized workloads despite having lower baseline traffic?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-004

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> Given that we can't use third-party cookies anymore, what's the best way to measure the attribution of our podcast ad spends?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-005

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> I need to migrate our database from Postgres to DynamoDB by Friday, but my initial attempt to bulk export the data failed because of timeout limits. What's the step-by-step workaround to get this done before the weekend without taking the production app offline?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-006

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> We need to route incoming API requests to either our high-cost low-latency endpoint or our low-cost batch endpoint. We don't have access to real-time user tracking, so we can't tell if a user is currently active. How should we dynamically route traffic to maximize cost efficiency while keeping active users from dropping?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-007

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> Compare the long-term maintenance burden of building a custom observability pipeline versus adopting an off-the-shelf solution. If we expect our microservice count to double in the next year, which approach prevents bottlenecks better, and what are the trade-offs of each?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-008

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> With a team of four engineers and exactly three months to launch a mobile app, should we hire contractors to use Flutter or stick to Swift and risk the deadline? Walk through the trade-offs.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-009

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> Our error logs show a spike in 401 Unauthorized errors exactly at 3 AM every Tuesday, but our automated token rotation runs at midnight and the tokens are valid for 24 hours. What could explain this discrepancy?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-010

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> Let's think through an API caching strategy: if we cache based on URL parameters but allow users to filter by 10 different attributes, how do we prevent cache invalidation from crushing our database while still ensuring users don't get stale data?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-011

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> I tried prompting our internal LLM to summarize 50-page legal contracts, but it keeps hallucinating clauses. If I can't increase the context window because of cost, how do I chunk the text to force the model to actually ground its summary in the provided text?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-012

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> Help me reason through whether to use push notifications or in-app messages for our new feature announcement. The catch is that 80% of our users only open the app once a week, but iOS limits push notifications to a few per week before they become annoying.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-013

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> What is the best way to deduplicate a mailing list of 100k entries when we can't use an external API for verification?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### analysis-en-014

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> I have to present two different scaling strategies to the board tomorrow: horizontal vs vertical scaling. We have a strict hard cap of $10k for infrastructure upgrades this quarter. Which strategy is more viable and why?

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

