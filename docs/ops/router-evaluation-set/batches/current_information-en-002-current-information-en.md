# current_information-en-002 — `current_information/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=current_information-en-002`
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
| promptTemplate | `router-eval-draft-v2` (`fc934b606e7320d6`) |
| generatorCommit | `7eb0f88` |
| draftedAt | 2026-08-26T00:56:22.469Z |

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
| 0.13 | 0.03 | `current-en-002` ~ `current-en-013` | current_information/en |
| 0.12 | 0.03 | `current-en-008` ~ `current-en-011` | current_information/en |
| 0.12 | 0.00 | `current-en-006` ~ `current-en-010` | current_information/en |
| 0.12 | 0.00 | `current-en-006` ~ `current-en-014` | current_information/en |
| 0.11 | 0.04 | `current-en-008` ~ `current-en-009` | current_information/en |
| 0.11 | 0.02 | `current-en-001` ~ `current-en-011` | current_information/en |
| 0.11 | 0.01 | `current-en-006` ~ `current-en-008` | current_information/en |
| 0.11 | 0.00 | `current-en-009` ~ `current-en-011` | current_information/en |
| 0.10 | 0.02 | `current-en-014` ~ `current-en-015` | current_information/en |
| 0.10 | 0.00 | `current-en-002` ~ `current-en-004` | current_information/en |

---

## 후보 — 판정할 14건

### current-en-002

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> What are the current 30-year fixed mortgage rates in the US today?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-003

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> Tell me the exact price of Bitcoin in USD right now.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-004

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> Did any spacecraft successfully land on the moon this year?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-005

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> I need the latest stable release version of the Rust programming language.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-006

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> My budget is strictly under $400 for a flight from New York to London next weekend, and I can only fly out of JFK, so what are my options?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-007

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> Since my company blocks Yahoo Finance, find the top three trending tech stocks on the NASDAQ this week using alternative sources and format the output as a markdown table.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-008

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> I've been trying to use the standard pip install for the new PyTorch update but it keeps failing with a CUDA mismatch on my Ubuntu 22.04 machine; I need this fixed by tomorrow morning for a presentation, so please provide the exact workaround posted in the last 48 hours.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-009

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> Apple rejected my build when I tried downgrading to iOS 17.2 to fix the React Native Hermes crash, meaning I'm stuck on 17.4, so what official patch or community workaround was published this month to resolve this?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-010

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> With a strict budget of $25,000 and a 50-mile pickup radius around Chicago, show me the current dealership listings for used electric vehicles from the current model year.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-011

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> I'm writing a blog post about the recent changes to the EU AI Act, so could you summarize the key amendments that were voted on in the last parliamentary session?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-012

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> List the box office numbers for the top 5 movies this past weekend in North America.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-013

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> If the Federal Reserve raised rates at their most recent meeting, what was the exact basis point increase and what did the chair say in the press conference?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-014

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> Our Kubernetes cluster just threw a bunch of CVE alerts for the latest containerd update, so which specific CVEs were published this week and are there patched versions available yet?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-015

`current_information/en` · prompt `en` → answer `en` · source `drafted`

> Compare the battery life and camera specs of the newest iPhone and the latest Samsung Galaxy based exclusively on tech reviews published in the last thirty days.

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

