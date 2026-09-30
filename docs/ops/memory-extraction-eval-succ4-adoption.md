# `mem-eval-succ-4` 통합 채택 기록

docs/ops/memory-extraction-eval-dataset.md §7.1a. 승계 dataset은 tranche마다
batch 기록을 복제하지 않고 이 파일 하나를 씁니다.

> **관측 칸은 에이전트가 채웠고, 판정 칸은 운영자의 결정을 전사한 것입니다.**
>
> 버전·digest·건수·cell 분포·초안 도구·draft disagreement 수치는 실행 결과에서
> 그대로 옮겼고 지어낸 값이 없습니다. 각 줄에 재현 방법을 적었습니다.
>
> 4·6·7장의 검수자·tranche 판정·서명은 **2026-08-28 대화에서 운영자(@mposition)가
> 말한 결정을 전사**한 것입니다. AGENTS.md 「기록을 채우는 경계는 관측과
> 판정입니다」에 따라 판정은 사람의 것이고, 에이전트는 그것을 옮겨 적었습니다.
> 운영자가 각 줄을 확인한 뒤 commit 합니다.
>
> 채택은 사람의 판정입니다. 전환 manifest의 `movedBecause`나
> `settledByExistingContract`가 채워져 있다는 사실은 채택이 아닙니다 — 그것은
> 초안을 만든 주체가 남긴 provenance이고, 그것으로 채택을 갈음하면
> docs/ops/memory-extraction-eval-dataset.md §6.2의 역할
> 분리가 이 dataset에서만 사라집니다.

## 1. 정체성

| 항목 | 값 |
|---|---|
| datasetVersion | `mem-eval-succ-4` |
| schemaVersion | 3 |
| supersedes | `mem-eval-succ-3` |
| 케이스 수 | 1,150 = 상속 1,047 + 교체 103 |
| dataset digest | `0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0` |
| scoring contract | `mem-score-v3.3` · `19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777` |
| transition manifest digest | `44bc58bad215ed572f1accd74979b19b6708453f37e474734940953edf51a325` |
| 기록 commit | `bbbc332cd95d8809e2f54829da18e2e1b3c7346b` (#1161) |

세 digest 모두 `lib/memoryEvalSucc4Manifest.ts`의 `MEMORY_EVAL_SUCC4_MANIFEST`에
동결돼 있고, `tests/memoryEvalSucc4Manifest.test.mjs`가 매 실행마다 live tree에서
재계산해 대조합니다.

## 2. 상속분 — 1,047건

승계 원본 `mem-eval-succ-3`의 dataset digest는
`38468da0dce31a144d61d360189b4ce9e1d55e0e914ae66a2d61bfb1e793dc3b`이며, 그
**40개 adopted batch 기록이 상속분 전부를 덮습니다**. 기록은
`lib/memoryEvalSucc3Adopted/index.ts`가 가리키는
`docs/ops/memory-extraction-eval-batches/batch-*-succ3-*.md` 40개 파일입니다.

이 갈래에 대해 새로 채택할 것은 없습니다. 원 batch가 채택된 사실과 그때의
검수자·판정이 그대로 유효하고, 바뀐 것은 schema 3 재판독뿐입니다. 각 batch가
재판독 뒤 어떤 지문을 갖는지는 manifest의 `inheritedComponents[].schema3ComponentDigest`에
있고, 원 batch digest(`sourceBatchDigest`)는 그대로 보존됩니다.

## 3. 교체분 — 103건, 5개 tranche

| tranche | 건수 | cell | component digest |
|---|---|---|---|
| `succ4-tranche-1` | 8 | `durable_facts:en` 3 · `durable_facts:ko` 2 · `assistant_only:en` 2 · `assistant_only:ko` 1 | `ddd42336394442fcb5d7ad0d0f224997f3984e3e437e4daa12212a56734daddb` |
| `succ4-tranche-2` | 25 | `durable_facts:ko` 25 | `29cf1b9107189362316da1fe7233ea450fbf70aaf529f2031daeda3fcca15821` |
| `succ4-tranche-3` | 18 | `durable_facts:ko` 5 · `assistant_only:ko` 6 · `assistant_only:en` 5 · `injection_directives:en` 2 | `c120aa3541a925bd1779478513d14a944e3c522429ba5286914122ff4510cd29` |
| `succ4-tranche-4` | 26 | `durable_facts:en` 26 | `baa5844431e3503c53823526d496144152582a01f053ee48c0757f4a71a9084a` |
| `succ4-tranche-5` | 26 | `durable_facts:en` 26 | `a8b834ca464afef0b2483a11fbe4aeee8ba2366a28822b95e0be668bf3708e1c` |

합계 103건. 재현: `npm run report:memory-eval-succ4-tranche`.

### 3.1 전건 검수 증거

교체 103건은 표본이 아니라 **전건**이 검사를 통과했습니다. 검사는
`scripts/report-memory-eval-succ4-tranche.mjs`이며 케이스마다 다음을 확인합니다 —
원본이 이동 목록에 있을 것, cell·gold 개수·`goldCompleteness`·`criticalGoldMode`가
원본과 같을 것, 각 gold의 `expectedDisposition`이 원본 gold 중 하나에 있을 것,
evidence anchor가 user turn의 정확한 span이고 fact value를 덮을 것, case ID와
conversation ID가 기존 corpus·다른 tranche와 충돌하지 않을 것, 원본과의 overlap이
0.45 이하일 것, **corpus에 남는 다른 case와의 overlap도** 0.45 이하일 것.

`No problems.` — 103/103.

gold별 `polarity`·`evidenceMessageId`·`evidenceQuote`는 하나씩 명시 검수했습니다
(.github/audits/memory-eval-gold-contract-2026-08-27.md §12.11). 자동 선택은 후보
제안까지이고, 검수 기록이 없는 gold는 조립에서 거절됩니다.

### 3.2 초안 도구 · 모델 · 버전

| tranche | 초안 생성자 |
|---|---|
| `succ4-tranche-1` | `ai-draft:claude-code/claude/2026-08-27` |
| `succ4-tranche-2` | `ai-draft:claude-code/claude/2026-08-28` |
| `succ4-tranche-3` | `ai-draft:claude-code/claude/2026-08-28` |
| `succ4-tranche-4` | `ai-draft:claude-code/claude/2026-08-28` |
| `succ4-tranche-5` | `ai-draft:claude-code/claude/2026-08-28` |

docs/ops/memory-extraction-eval-dataset.md §6.5에 따라 비 OpenAI 계열입니다. 원본 corpus의 초안도 같은 계열이므로 이 dataset
안에서 계열이 섞이지 않습니다.

## 4. 역할 분리 (docs/ops/memory-extraction-eval-dataset.md §6.2)

| 역할 | 주체 |
|---|---|
| 작성 (초안) | AI — 위 3.2 |
| 검수 · 채택 판정 | @mposition |
| adjudicator | **해당 없음** — 검수자가 한 명인 동안 발생하지 않습니다 (docs/ops/memory-extraction-eval-dataset.md §6.4) |

시료를 만든 주체(AI)와 채택한 주체(사람)는 다릅니다
(docs/ops/memory-extraction-eval-dataset.md §6.2). 한 사람이 데이터셋
책임자와 검수자를 겸하는 것은 검수자가 한 명인 동안 허용되는 구조이고
(docs/ops/memory-extraction-eval-dataset.md §6.4), 릴리스 게이트 registry가
`approvalPolicy.soleApproverAllowed`로 남긴 축과 같습니다. 그때도 남는 분리는
**증거를 만든 주체와 승인한 주체가 다르다**는 것이며, 여기서는 초안이 AI이고
채택이 사람입니다.

## 5. draft disagreement

두 개의 다른 수치가 있고, 각자 이름으로 적습니다. 하나로 합치면 어느 쪽에
대해서도 틀립니다.

### 5.1 검수자와 초안의 불일치 (이 절의 본래 항목)

| 항목 | 값 |
|---|---|
| 판정 건수 | 103 — 5개 tranche 전건 |
| 반려 건수 | 0 |
| 비율 | 0% |
| 미결 | 0 |

@mposition이 2026-08-28에 다섯 tranche를 전건 검토하고 전부 `adopted`로
판정했습니다(6장). 반려가 없으므로 0%입니다.

### 5.2 계약 검사가 반려한 초안 (별개 측정)

사람에게 도달하기 **전에** 걸러진 것입니다. 위 0%와 같은 것을 재지 않으므로
합치지 않습니다.

집계는 `lib/memoryEvalSucc4DraftRejections.ts`의 21개 행에서 계산합니다. 행마다
어느 검사가 왜 반려했는지와 그 근거가 tranche 파일에 있는지 commit에 있는지를
적었습니다. 재현: `npm run report:memory-eval-succ4-rejections`.

| tranche | 반려 | 건수 | 비율 |
|---|---|---|---|
| `succ4-tranche-1` | 2 | 8 | 25.0% |
| `succ4-tranche-2` | 3 | 25 | 12.0% |
| `succ4-tranche-3` | 6 | 18 | 33.3% |
| `succ4-tranche-4` | 3 | 26 | 11.5% |
| `succ4-tranche-5` | 7 | 26 | 26.9% |
| **합계** | **21** | **103** | **20.4%** |

반려 사유는 세 가지입니다. 원본과의 overlap 초과 12건, **corpus에 남는 다른
case와의** overlap 초과 7건, under-specification 2건. 두 번째가 나온 것은 검사를
나중에 추가했기 때문이고, 그 검사가 이미 병합된 tranche에서도 3건을 찾아냈습니다.

반려된 21건은 전부 다시 쓰였고 재검사를 통과했으므로 미결은 0입니다. 검수자가
본 것은 그 재작성본입니다.

## 6. 채택 판정 (사람이 기입)

| tranche | 판정 | 근거 |
|---|---|---|
| `succ4-tranche-1` | adopted | 전건 검토 (@mposition, 2026-08-28) |
| `succ4-tranche-2` | adopted | 전건 검토 (@mposition, 2026-08-28) |
| `succ4-tranche-3` | adopted | 전건 검토 (@mposition, 2026-08-28) |
| `succ4-tranche-4` | adopted | 전건 검토 (@mposition, 2026-08-28) |
| `succ4-tranche-5` | adopted | 전건 검토 (@mposition, 2026-08-28) |

판정 값은 `adopted` 또는 `rejected`입니다. 하나라도 `adopted`가 아니면
docs/ops/memory-extraction-eval-dataset.md §7.1a의 5번에 따라 동결이 거부됩니다.

## 7. 서명 (사람이 기입)

| 항목 | 값 |
|---|---|
| 검토자 | @mposition |
| 승인일 | 2026-08-28 |
| 서명 | @mposition |

서명이 채워진 뒤에야 docs/ops/memory-extraction-eval-dataset.md §7.2의 세 줄 편집 — `MEMORY_EVAL_SUCC4_DATASET_FROZEN`을
`true`로, `..._PURPOSE`를 `decision`으로 — 이 가능합니다. 그 전까지 상수는
`false` · `development`이고, harness는 이 dataset으로 `--live`를 거부합니다.
