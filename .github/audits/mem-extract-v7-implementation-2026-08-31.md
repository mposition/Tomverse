# `mem-extract-v7` 구현 기록

**상태: 구현 완료 (2026-08-31).** 유료 실행·pair 승인·예산·release gate·flag는
포함하지 않습니다.

- 승인 1: `mem-extract-v7` 구현 (prompt 코드·테스트·prompt digest·구현 증거)
- 승인 2: 예시 두 개의 합성 교체 + `gpt-5-6-luna::mem-extract-v7` pair 등록
- 기준: `.github/audits/memory-boundary-decision-2026-08-30.md` §5,
  동결된 `mem-eval-succ-6`, `mem-score-v3.4`

## 1. 최종 문안

**이 블록이 배포된 문안입니다.** `tests/memoryExtractionPromptRules.test.mjs`가
prompt와 이 블록을 직접 대조하므로, 한쪽만 바뀌면 실패합니다.

```
BOUNDARY: some things a user says are not memories.

An explicit request not to remember a fact suppresses candidates about that
fact. It does not suppress a separate privacy preference or another
independently asserted fact in the same turn. "I once trained for triathlons;
please do not retain that" leaves no memory that they trained and none that
they no longer do: the request removes the subject, it does not replace it
with its negation.

A correction removes the discarded proposition. When the user clearly supplies
a durable replacement fact, that replacement may be extracted. A correction that
only rejects a guess and adds no independently reusable fact yields no
candidate. A durable replacement may be affirmative or negated: "The
registration form lists two dependants; I have no dependants" establishes a
negated relationship fact.

A privacy preference may be extracted only if the statement does not repeat,
infer, or narrow the location or value the user withheld.

A hypothetical is not a memory. A present-tense statement yields no candidate
when it only closes the hypothetical and does not independently establish a
durable, future-useful fact. "If I quit and studied abroad…" followed by "I was
just imagining it, I'm still at my job" leaves nothing to store: the second
sentence exists to close the first.

When a user writes on someone else's behalf or asks about someone else, the
relationship that surfaces is part of the question, not a fact about the user.
"Proofread my nephew's letter" is a task, not a record that they have a nephew.
Store such a relationship only when the user separately establishes it as an
ongoing part of their own life. Health information about another person is
never stored as that person's; at most it becomes a minimised constraint about
the user, and it is sensitive.
```

**prompt digest: `7ec5e591628ad719be7f13faf850a537c6f77cfcb22cc50471a245bee7beb912`**

## 2. 2026-08-30 문안에서 바뀐 것

**규범적 의미는 바뀌지 않았습니다.** eval case에서 유래한 예시 두 개만
합성 문장으로 교체했습니다. 문단 수, 문단별 규칙, 억제 범위 모두 동일하고 새
규칙이나 예외를 넣지 않았습니다.

| 문단 | 원래 예시 | 교체 | 유래 |
| --- | --- | --- | --- |
| 철회 | `"I moved away and I don't want that remembered"` | `"I once trained for triathlons; please do not retain that"` | `succ-assistant-en-3` — **동결 decision set** |
| 정정 | `"Voice typing wrote that I have three children; I have none"` | `"The registration form lists two dependants; I have no dependants"` | `succ-assistant-en-27` — regression corpus |

원래 예시들은 case의 발화를 거의 그대로 옮긴 것이었고, 문단이 답까지 함께
적으므로 그 case는 아무것도 측정하지 못하게 됩니다. `en-3`은 B+ 10건에 들지
않아 동결된 decision set에 그대로 있었습니다.

철회 예시는 문장 하나로 두 금지를 모두 보이도록 썼습니다 — 철회된 사실(트라이애슬론
훈련)도, 그 부정형(더 이상 하지 않는다)도 저장하지 않습니다. 정정 예시는 폐기된
명제(부양가족 둘)를 제거하면서 독립적으로 재사용 가능한 **부정형** 대체 사실
(부양가족 없음)이 남는 형태를 유지합니다 — `ko-19`와 `en-27`을 가르는 자리가
polarity가 아니라 독립적 재사용성이라는 점이 이 예시의 요점입니다.

교체본은 **동결 decision set·regression corpus·succ-3 fixture 세 pool 모두에서**
5-gram 충돌이 없습니다.

## 3. 구현

| 항목 | 내용 |
| --- | --- |
| `MEMORY_EXTRACTION_BOUNDARY_RULE` | `lib/memoryExtractionPrompt.ts`. `MEMORY_EXTRACTION_POLARITY_RULE` **옆에** splice |
| 제거·수정한 기존 문장 | 없음 |
| `MEMORY_EXTRACTION_PROMPT_VERSION` | `mem-extract-v7` |
| 규칙 구현 선언 | `v3-unfixable-evidence-emits-nothing` — polarity rule을 그대로 싣고 있으므로 v6와 같은 근거로 계속 구현 |
| 테스트 | 문단별 8건 + §1 블록과의 대조 1건 |

대조 테스트가 §1을 읽으므로, prompt를 고치고 이 문서를 안 고치면 실패하고 그
반대도 실패합니다.

## 4. pair 등록

`gpt-5-6-luna::mem-extract-v7`을 승인된 조건으로 등록했습니다.

| field | 값 |
| --- | --- |
| `status` | `candidate` |
| `evalBudget` | `null` |
| `evaluation` | `null` |
| dataset | `mem-eval-succ-6` (동결) |
| scoring contract | `mem-score-v3.4` |
| prompt digest | `7ec5e591…` |

**v6의 예산·승인·실행 이력은 이전하지 않았습니다.** v6 pair는 그대로 있고,
그 예산은 여전히 v6의 digest에 결속돼 있습니다 — v7은 그 예산으로 실행할 수
없고, 그것이 의도된 동작입니다.

`gpt-5-4-mini::mem-extract-v7`은 **등록하지 않았습니다.** 이번 승인에
없습니다.

## 4.1 버전 bump가 강제한 테스트 수정 3건

shipped version이 v7이 되면서 세 테스트가 v6를 전제하고 있었음이 드러났습니다.
**어느 것도 가드를 약화시키지 않았고, 하나는 강해졌습니다.**

| 테스트 | 전제 | 수정 |
| --- | --- | --- |
| `memoryEvalBudgetBinding` | v6 tuple = tree가 조립하는 것 | **역전**. 이제 불일치를 **요구**하고, 불일치가 `promptVersion`·`promptDigest` 정확히 둘뿐임을 확인합니다. 오늘 `[]`를 단언하는 것은 "v7 실행이 v6 승인으로 진행돼도 된다"를 단언하는 것입니다 |
| `memoryEvalSchema3DryRun` | shipped pair = 취소된 pair | `revoked` 단언을 **v6에 이름으로 고정**. shipped version의 pair가 어느 버전이든 `live`가 될 수 없다는 검사를 별도로 추가 |
| `memoryExtractionEvalBoundary` | shipped version의 `gpt-5-4-mini` pair가 등록돼 있음 | pair가 **없을 수도** 있음을 허용. 없으면 register miss로 더 일찍 거절되므로 더 안전하며, 있을 경우 실행 불가는 그대로 단언 |

## 5. 변경하지 않은 것

- `mem-eval-succ-6`: dataset `2ffc8c09…`, subtype `89e10d0d…`, manifest
  `b1904682…`
- `mem-score-v3.4`와 그 digest
- `.github/audits/memory-eval-succ6-adoption-2026-08-31.md`
- `.github/audits/memory-boundary-decision-2026-08-30.md` §5의 서명된 블록 —
  §2의 교체는 이 문서에 기록하고 그 문서는 서명된 채로 둡니다
- v6 register 항목과 예산
- `feature.memoryExtractionEnabled`, `feature.memoryInjectionEnabled` — 꺼짐

## 6. 남은 단계 (이번 승인 밖)

- `gpt-5-4-mini::mem-extract-v7` pair 등록
- pair 승인 · eval budget 승인
- 유료 decision-grade 실행
- release gate 전환 · production 활성화 · flag 변경
