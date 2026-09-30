# coding-en-003 — `coding/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=coding-en-003`
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
| promptTemplate | `router-eval-draft-v2` (`1fb7b029ccccc56c`) |
| generatorCommit | `fde8f05` |
| draftedAt | 2026-08-26T00:48:13.904Z |

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
| 0.15 | 0.02 | `coding-en-002` ~ `coding-en-006` | coding/en |
| 0.13 | 0.01 | `coding-en-004` ~ `coding-en-008` | coding/en |
| 0.12 | 0.03 | `coding-en-002` ~ `coding-en-011` | coding/en |
| 0.11 | 0.03 | `coding-en-002` ~ `coding-en-009` | coding/en |
| 0.11 | 0.01 | `coding-en-002` ~ `coding-en-004` | coding/en |
| 0.11 | 0.02 | `code-en-002` ~ `coding-en-009` | coding/en |
| 0.11 | 0.01 | `coding-en-006` ~ `coding-en-008` | coding/en |
| 0.11 | 0.00 | `coding-en-006` ~ `coding-en-009` | coding/en |
| 0.11 | 0.00 | `code-en-001` ~ `coding-en-014` | coding/en |
| 0.11 | 0.02 | `coding-en-008` ~ `coding-en-009` | coding/en |

---

## 후보 — 판정할 14건

### coding-en-001

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Why does my React useEffect infinite loop when I put an object in the dependency array?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-002

`coding/en` · prompt `en` → answer `en` · source `drafted`

> I need to parse a 5GB CSV file and aggregate sales by region. The server only has 512MB of RAM and I'm not allowed to install pandas or any third-party packages. Write a Python script that handles this without crashing.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-003

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Rewrite this recursive tree traversal to use an explicit stack instead.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-004

`coding/en` · prompt `en` → answer `en` · source `drafted`

> I'm trying to use fetch with AbortController to cancel requests in our web app. It throws an "AbortController is not defined" error because we still have to support IE11. Give me a polyfill or workaround that actually works in that browser without using axios.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-005

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Here is a Django model for a blog post. Add a custom manager method that returns only posts published in the last 7 days, ordered by view count descending.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-006

`coding/en` · prompt `en` → answer `en` · source `drafted`

> We need to add a unique constraint on the email column in our production PostgreSQL database. The table has 50 million rows and we cannot afford any downtime or table locks. Write the exact SQL migration steps to do this safely using a concurrent index.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-007

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Fix the memory leak in this C++ linked list destructor.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-008

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Implement a rate limiter using the token bucket algorithm in Redis. You can only use a single Lua script to ensure atomicity since we don't have Redis transactions enabled in our cluster.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-009

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Can you write a regular expression that validates a password? It needs to require at least one uppercase letter, one number, and one special character, but explicitly reject the word "password" in any case.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-010

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Convert this monolithic Express route handler into three separate middleware functions.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-011

`coding/en` · prompt `en` → answer `en` · source `drafted`

> I tried using json_normalize to flatten a nested JSON API response into a DataFrame, but it completely drops the arrays inside the "tags" key. Write a custom Python function to flatten this specific JSON structure into a flat dictionary list without losing the array data.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-012

`coding/en` · prompt `en` → answer `en` · source `drafted`

> What is the exact time complexity of the std::map::insert operation in C++ when the map already contains N elements? Also, explain why it differs from std::unordered_map.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-013

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Please debug this AWS CloudFormation template. It keeps failing with a "Circular dependency" error between the IAM role and the S3 bucket policy.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### coding-en-014

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Figure out why this SQL query returns duplicate rows when joining the users and orders tables.

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

