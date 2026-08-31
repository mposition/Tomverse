# `mem-extract-v7` 구현 기록 — **미완결 (차단 2건)**

**상태: 구현은 작성됐으나 병합 불가.** 승인 범위 밖 결정 두 건이 필요합니다.

- 승인: `mem-extract-v7` 구현 (prompt 코드·테스트·prompt digest·구현 증거)
- 승인 범위 밖: pair 등록·승인, eval budget, 유료 실행, release gate, flag
- 기준: `.github/audits/memory-boundary-decision-2026-08-30.md` §5 문안,
  `mem-eval-succ-6` 동결 계약

## 1. 작성한 것

| 항목 | 내용 |
| --- | --- |
| `MEMORY_EXTRACTION_BOUNDARY_RULE` | 승인 문안 6문단. 감사 문서에서 **추출**했고 옮겨 적지 않았습니다 — markdown의 hard wrap만 공백이 됐습니다 |
| system prompt | `MEMORY_EXTRACTION_POLARITY_RULE` **옆에** splice. 제거·수정한 문장 없음 |
| `MEMORY_EXTRACTION_PROMPT_VERSION` | `mem-extract-v6` → `mem-extract-v7` |
| prompt digest | `4a0988274388a681cc6ce79aad4dfe60429f8d9ed405013f8006829765a57bba` |
| 규칙 구현 선언 | `mem-extract-v7`이 `v3-unfixable-evidence-emits-nothing`을 계속 구현 |
| 테스트 | 문단별 8건 + 승인 문안과의 대조 1건 |

문안 대조 테스트는 감사 문서를 **읽어서** 비교합니다. 문안이 바뀌면 실패하고,
prompt만 바뀌어도 실패합니다.

## 2. 차단 1 — 승인 문안이 동결된 decision set을 오염시킵니다

`tests/memoryEvalPromptDatasetSeparation.test.mjs`가 잡았습니다. prompt가
eval case의 발화를 담으면 그 case는 아무것도 측정하지 못합니다.

| case | 위치 | 겹치는 5-gram |
| --- | --- | --- |
| `succ-assistant-en-3` | **decision set (동결)** | `and i don t want` |
| `succ-durable-en-17` | **decision set (동결)** | `and i don t want` |
| `succ-assistant-en-27` | regression corpus | `wrote that i have three` |

**`succ-assistant-en-3`이 실질적 오염입니다.**

- 승인 문안: `"I moved away and I don't want that remembered"`
- `en-3` 사용자 발화: `Sorry, I mistyped — I moved away years ago and I don't want that remembered.`

거의 그대로이고, 문안은 답까지 함께 적습니다 — "leaves no memory that they no
longer live there". `en-3`은 B+ 10건에 **들어가지 않아** 동결된 decision set에
그대로 있습니다.

`succ-assistant-en-27`도 문안의 예시(`"Voice typing wrote that I have three
children; I have none"`)가 그 case에서 나왔지만, **B+로 decision set을 떠나**
regression corpus에 있으므로 decision 표본을 오염시키지는 않습니다. 다만 그
regression case를 blind 측정으로 다시 쓸 수는 없습니다.

`succ-durable-en-17`은 `That's settled and I don't want to reopen it.`이며,
겹치는 것은 평범한 영어 관용구뿐입니다. 5-gram 검사가 구분하지 못하는 쪽입니다.

**해결에는 승인 문안 수정이 필요하고, 그것은 이번 승인 범위 밖입니다.**
동결된 case를 고치는 것은 어느 경우에도 금지입니다 — 분리 검사 자신이
`Never edit the frozen case to make this pass.`라고 적고 있고, `mem-eval-succ-6`은
서명된 동결본입니다.

## 3. 차단 2 — shipped version에 pair가 없습니다

버전을 올리면 register에 `mem-extract-v7` pair가 없어 **11건이 실패**합니다.

| 테스트 | 사유 |
| --- | --- |
| `memoryEvalBudgetBinding` ×1 | 승인된 예산이 `mem-extract-v6`와 그 digest에 결속. tree가 v7이라 tuple 불일치 |
| `memoryEvalSchema3DryRun` ×2 | `No register entry for gpt-5-6-luna::mem-extract-v7` |
| `memoryExtractionEvalBoundary` ×4 | `the pair this test relies on is not registered` 외 |
| `memoryEvalDevelopmentProbe` ×1, `memoryEvalProbeDetail` ×3 | 같은 사유 |

**이는 결함이 아니라 가드가 작동한 것입니다.** 예산은 v6의 digest에 묶여 있고,
v7은 그 예산으로 실행될 수 없습니다 — 정확히 의도된 동작입니다.
`.github/audits/memory-boundary-decision-2026-08-30.md` §5.3의 5단계(pair 등록,
예산 없음)가 이 실패를 해소하지만, 그 단계는 이번 승인에 포함되지 않았습니다.

## 4. 확인한 불변

- `mem-eval-succ-6`: dataset `2ffc8c09…`, subtype `89e10d0d…`, manifest
  `b1904682…` — 모두 변경 없음
- `mem-score-v3.4` 및 그 digest — 변경 없음
- 채택 기록 `.github/audits/memory-eval-succ6-adoption-2026-08-31.md` — 변경 없음
- v6 register 항목·예산 — 변경 없음
- `feature.memoryExtractionEnabled`, `feature.memoryInjectionEnabled` — 꺼진 상태

## 5. 필요한 결정

1. **승인 문안의 예시 두 개를 다시 쓸 것인가.** `en-3`·`en-27`에서 나온 예시를
   dataset에 없는 문장으로 교체하면 규칙의 뜻은 유지되고 오염이 사라집니다.
   문안 변경이므로 승인이 필요하고, 변경 시 prompt digest도 바뀝니다.
2. **`mem-extract-v7` pair를 예산 없이 등록할 것인가** (§5.3 5단계).

두 결정 전까지 이 브랜치는 병합할 수 없습니다.
