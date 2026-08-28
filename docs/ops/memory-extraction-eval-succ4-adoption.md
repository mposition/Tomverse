# `mem-eval-succ-4` 통합 채택 기록

docs/ops/memory-extraction-eval-dataset.md §7.1a. 승계 dataset은 tranche마다
batch 기록을 복제하지 않고 이 파일 하나를 씁니다.

> **이 문서는 에이전트가 채운 초안입니다.** 아래에서 **관측 칸** — 버전, digest,
> 건수, cell 분포, 초안 도구 — 은 실행 결과에서 그대로 옮긴 것이고 지어낸 값이
> 없습니다. 각 줄에 재현 방법을 적었습니다. **판정 칸** — 검수자, draft
> disagreement, tranche별 `adopted`, 승인일, 서명 — 은 **비어 있으며 사람이
> 채웁니다.** AGENTS.md 「기록을 채우는 경계는 관측과 판정입니다」와 §7.1a의 4·5번
> 조건에 따른 것이고, 채워지기 전에는 `npm run check:memory-eval-freeze`가 succ-4에
> 대해 `MISS`를 보고합니다.
>
> 채택은 사람의 판정입니다. 전환 manifest의 `movedBecause`나
> `settledByExistingContract`가 채워져 있다는 사실은 채택이 아닙니다 — 그것은
> 초안을 만든 주체가 남긴 provenance이고, 그것으로 채택을 갈음하면 §6.2의 역할
> 분리가 이 dataset에서만 사라집니다.

## 1. 정체성

| 항목 | 값 |
|---|---|
| datasetVersion | `mem-eval-succ-4` |
| schemaVersion | 3 |
| supersedes | `mem-eval-succ-3` |
| 케이스 수 | 1,150 = 상속 1,047 + 교체 103 |
| dataset digest | `0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0` |
| scoring contract | `mem-score-v3.2` · `8d6dfef8537cf910a40d175e0bb315bdfaa4e47fa5e89ea3c4bfbc032d9b6e1b` |
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

§6.5에 따라 비 OpenAI 계열입니다. 원본 corpus의 초안도 같은 계열이므로 이 dataset
안에서 계열이 섞이지 않습니다.

## 4. 역할 분리 (§6.2)

| 역할 | 주체 |
|---|---|
| 작성 (초안) | AI — 위 3.2 |
| 검수 · 채택 판정 | *(사람이 기입)* |
| adjudicator | **해당 없음** — 검수자가 한 명인 동안 발생하지 않습니다 (§6.4) |

시료를 만든 주체와 채택한 주체는 다릅니다. 이 표의 두 번째 줄이 비어 있는 동안
그 분리는 성립하지 않으며, 검사는 그 상태를 `MISS`로 보고합니다.

## 5. draft disagreement

| 항목 | 값 |
|---|---|
| 판정 건수 | *(사람이 기입)* |
| 반려 건수 | *(사람이 기입)* |
| 비율 | *(사람이 기입)* |
| 미결 | *(사람이 기입 — §7.1a는 0을 요구합니다)* |

에이전트가 스스로 반려한 초안은 여기에 적지 않습니다. 그것은 작성 과정이지 검수
결과가 아닙니다. 참고로 그 내역은 각 tranche 파일의 `differsBy`와 commit 본문에
남아 있습니다 — tranche 3에서 6건, tranche 5 단계에서 9건이 overlap 또는
under-specification으로 다시 쓰였습니다.

## 6. 채택 판정 (사람이 기입)

| tranche | 판정 | 근거 |
|---|---|---|
| `succ4-tranche-1` | *(사람이 기입)* | |
| `succ4-tranche-2` | *(사람이 기입)* | |
| `succ4-tranche-3` | *(사람이 기입)* | |
| `succ4-tranche-4` | *(사람이 기입)* | |
| `succ4-tranche-5` | *(사람이 기입)* | |

판정 값은 `adopted` 또는 `rejected`입니다. 하나라도 `adopted`가 아니면 §7.1a의
5번에 따라 동결이 거부됩니다.

## 7. 서명 (사람이 기입)

| 항목 | 값 |
|---|---|
| 검토자 | *(사람이 기입)* |
| 승인일 | *(사람이 기입)* |
| 서명 | *(사람이 기입)* |

서명이 채워진 뒤에야 §7.2의 세 줄 편집 — `MEMORY_EVAL_SUCC4_DATASET_FROZEN`을
`true`로, `..._PURPOSE`를 `decision`으로 — 이 가능합니다. 그 전까지 상수는
`false` · `development`이고, harness는 이 dataset으로 `--live`를 거부합니다.
