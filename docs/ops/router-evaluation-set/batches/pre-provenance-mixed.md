# pre-provenance — `general_question_answering/ko`, `general_question_answering/en`, `writing_and_rewriting/ko`, `writing_and_rewriting/en`, `coding/ko`, `coding/en`, `analysis_and_reasoning/ko`, `analysis_and_reasoning/en`, `translation_cross_language/ko-en`, `current_information/ko`, `current_information/en`, `document_and_attachment/ko`, `document_and_attachment/en`, `long_context_conversation/ko`, `long_context_conversation/en` 검수 시트

> **자동 생성 파일입니다.** `npm run make:router-eval-review-sheet -- --batch=pre-provenance`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**후보 24건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

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
| provider | `unrecorded` |
| modelId (Tomverse) | `unrecorded` |
| 요청한 api model | `unrecorded` |
| 응답이 밝힌 version | *제공자가 반환하지 않음 — 추측하지 않았습니다* |
| 별칭이 가리킨 실제 모델 | *확정되지 않음 — 기록 없음* |
| 생성 파라미터 | `{}` |
| promptTemplate | `unrecorded` (`unrecorded`) |
| generatorCommit | *기록 없음* |
| draftedAt | unrecorded |

> **이 batch의 초안 생성자를 재구성할 수 없습니다.** provider가 `unrecorded`입니다.
> 절차 문서는 초안 생성 모델을 검수자가 저울질해야 할 교란 요인으로 규정하는데,
> 이 항목들은 그 저울질을 할 수 없습니다. 그 사유만으로 반려하셔도 됩니다.

*"A set drafted by a routable model measures how well that model handles its own
phrasing."* 초안 모델과 같은 계열이 라우팅 후보에 있다면, 그 계열에 유리한 문체·문제
구성이 아닌지 특히 보아 주세요.

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **좋은 prompt인가**만 보시면 됩니다.

| 검사 | 범위 | 결과 |
|---|---|---|
| exact duplicate prompt | corpus 전체 234건 | 0건 |
| cell ↔ language 정합성 | batch 24건 | 전건 통과 |
| status: candidate | batch 24건 | 전건 candidate |

### near-duplicate 상위 10쌍 (corpus 234건 대상)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 cell 안에서만 비교합니다 — 다른 cell은 다르라고 나눠 놓은 것이라 유사도가 낮은 게
당연하고, 그 값은 아무것도 말해주지 않습니다.

**이 batch 안에서만이 아니라 이미 쌓인 corpus 전체와 비교했습니다.** batch마다 따로 보면
각 batch는 다양해 보이는데 corpus는 같은 틀을 반복하는 상태를 놓칩니다.

| token | shape | 쌍 | cell |
|---|---|---|---|
| 0.24 | 0.00 | `gen-en-002` ~ `general-en-010` | general_question_answering/en |
| 0.20 | 0.03 | `gen-en-001` ~ `general-en-007` | general_question_answering/en |
| 0.18 | 0.03 | `doc-en-001` ~ `document-en-011` | document_and_attachment/en |
| 0.17 | 0.00 | `write-en-001` ~ `writing-en-010` | writing_and_rewriting/en |
| 0.17 | 0.03 | `doc-en-001` ~ `document-en-005` | document_and_attachment/en |
| 0.15 | 0.06 | `doc-en-001` ~ `document-en-013` | document_and_attachment/en |
| 0.15 | 0.00 | `gen-en-002` ~ `general-en-004` | general_question_answering/en |
| 0.14 | 0.00 | `write-en-001` ~ `writing-en-012` | writing_and_rewriting/en |
| 0.14 | 0.00 | `gen-en-002` ~ `general-en-003` | general_question_answering/en |
| 0.14 | 0.03 | `gen-en-001` ~ `general-en-012` | general_question_answering/en |

---

## 후보 — 판정할 24건

### gen-ko-001

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 전세와 월세의 차이를 처음 자취하는 사람에게 설명해 주세요. 보증금이 어떻게 다르게 쓰이는지도 알려주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### gen-ko-002

`general_question_answering/ko` · prompt `ko` → answer `ko` · source `drafted`

> 커피를 내릴 때 물 온도가 맛에 어떤 영향을 주나요? 온도별로 어떤 차이가 나는지 간단히 정리해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### gen-en-001

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> Why does bread go stale faster in the fridge than on the counter? Explain it for someone with no chemistry background.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### gen-en-002

`general_question_answering/en` · prompt `en` → answer `en` · source `drafted`

> What actually happens to a package between 'out for delivery' and 'delivered'? I want to understand the scanning steps.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### write-ko-001

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 아래 문장을 고객에게 보낼 안내문으로 다듬어 주세요. 사과는 하되 변명처럼 들리지 않게 해 주세요.
> 
> "서버 문제로 어제 결제가 두 번 된 분들이 있는데 환불은 알아서 해드릴 예정입니다."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### write-ko-002

`writing_and_rewriting/ko` · prompt `ko` → answer `ko` · source `drafted`

> 팀 회고에서 쓸 짧은 글을 써 주세요. 이번 분기에 배포 실패가 세 번 있었고, 원인은 매번 달랐습니다. 책임을 묻지 않으면서도 넘어가지 않는 톤으로 다섯 문장 이내.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### write-en-001

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Rewrite this so it stops sounding like a threat, without dropping the deadline: "If we do not receive your documents by Friday your application will be closed and you will need to start over."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### write-en-002

`writing_and_rewriting/en` · prompt `en` → answer `en` · source `drafted`

> Write three subject lines for an email telling existing users that a feature they use is moving to a paid tier. No exclamation marks.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### code-ko-001

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> 다음 파이썬 함수가 빈 리스트를 받으면 ZeroDivisionError를 냅니다. 호출하는 쪽을 바꾸지 않고 고쳐 주세요. 왜 그 선택을 했는지도 한 줄로 설명해 주세요.
> 
> def average(values):
>     return sum(values) / len(values)

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### code-ko-002

`coding/ko` · prompt `ko` → answer `ko` · source `drafted`

> PostgreSQL에서 특정 사용자의 행만 남기고 나머지를 지우는 마이그레이션을 쓰려고 합니다. 외래 키가 여러 테이블에 걸려 있을 때 순서를 어떻게 잡아야 하나요? SQL 예시를 포함해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### code-en-001

`coding/en` · prompt `en` → answer `en` · source `drafted`

> This TypeScript compiles but throws at runtime for some inputs. Find the bug and fix it.
> 
> const firstMatch = (rows: string[], prefix: string) =>
>   rows.find((row) => row.startsWith(prefix))!.toUpperCase();

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### code-en-002

`coding/en` · prompt `en` → answer `en` · source `drafted`

> Write a shell one-liner that finds every file larger than 100MB under the current directory, excluding node_modules, and prints size and path sorted largest first. Explain each part.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### reason-ko-001

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> 구독 서비스의 이번 달 해지율이 지난달보다 2배로 뛰었습니다. 같은 기간에 가격 인상, 앱 업데이트, 경쟁사 프로모션이 모두 있었습니다. 어느 것이 원인인지 가려내려면 무엇을 확인해야 하나요? 확인 순서까지 정해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### reason-ko-002

`analysis_and_reasoning/ko` · prompt `ko` → answer `ko` · source `drafted`

> A/B 테스트에서 실험군 전환율이 3.1%, 대조군이 2.9%였고 각 군 표본은 1,200명입니다. 이 결과로 기능을 전체 출시해도 되나요? 판단 근거를 숫자로 보여 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### reason-en-001

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> A team reports that their p50 latency improved 20% after a change, but users complain the app feels slower. Give the three most likely explanations and how you would tell them apart from the data they already have.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### reason-en-002

`analysis_and_reasoning/en` · prompt `en` → answer `en` · source `drafted`

> Two departments each report saving $40k with the same headcount reduction. Finance says total savings were $40k, not $80k. Who is likely right, and what would you ask to settle it?

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### xlang-001

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> 다음 릴리스 노트를 영어로 번역해 주세요. 개발자 대상이고, 존댓말은 필요 없습니다.
> 
> "이번 업데이트부터 첨부 파일 용량 제한이 20MB에서 50MB로 늘어납니다. 기존에 업로드 실패로 남아 있던 파일은 자동으로 재시도되지 않으니 다시 올려 주세요."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### xlang-002

`translation_cross_language/ko-en` · prompt `ko` → answer `en` · source `drafted`

> Translate this support reply into natural Korean for a customer, keeping the refund window exact: "We've issued a full refund. It usually reaches your card within 5 to 10 business days, depending on your bank."

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-ko-001

`current_information/ko` · prompt `ko` → answer `ko` · source `drafted` · **웹 검색 필요**

> 지금 한국에서 시행 중인 전자상거래 반품 규정에서, 단순 변심일 때 소비자가 부담하는 비용은 무엇인가요? 근거 조항을 함께 알려 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### current-en-001

`current_information/en` · prompt `en` → answer `en` · source `drafted` · **웹 검색 필요**

> What is the current recommended way to authenticate a server-side application to Google Cloud without a downloaded service-account key? Cite the documentation you used.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### doc-ko-001

`document_and_attachment/ko` · prompt `ko` → answer `ko` · source `drafted` · 첨부 `application/pdf`

> 첨부한 계약서에서 자동 갱신 조항과 해지 통보 기한만 찾아서 정리해 주세요. 없으면 없다고 말해 주세요.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### doc-en-001

`document_and_attachment/en` · prompt `en` → answer `en` · source `drafted` · 첨부 `image/png`

> The attached screenshot is a build failure. Tell me which step failed and what to change, and say so plainly if the screenshot does not contain enough to tell.

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-ko-001

`long_context_conversation/ko` · prompt `ko` → answer `ko` · source `drafted`

> 앞에서 정한 규칙 세 가지를 다시 확인하고, 그중 두 번째 규칙이 이번 요청과 충돌하는지 판단해 주세요. 충돌한다면 어느 쪽을 따라야 하는지도 말해 주세요.

*초안 메모: Collection note: the adopted version must carry a real prior turn history long enough to reach Pass 2. This prompt alone does not.*

**판정**: <!-- 채택 / 반려(재작성) / 반려(폐기) -->

**사유**: <!-- 반려일 때만 -->

### long-en-001

`long_context_conversation/en` · prompt `en` → answer `en` · source `drafted`

> Summarise every decision we have made so far in this conversation, and flag any that we later reversed without saying so.

*초안 메모: Collection note: same as long-ko-001 — needs a real long history attached before adoption.*

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

