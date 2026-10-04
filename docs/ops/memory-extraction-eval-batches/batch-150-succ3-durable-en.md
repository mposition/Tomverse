# batch-150 — `durable_facts:en` (`mem-eval-succ-3`)

> **자동 생성 파일입니다.** `npm run make:memory-eval-succ3-records` 로 다시
> 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요.

## 이 batch가 무엇인가

`batch-109`의 후속입니다. 케이스를 새로 쓴 것이 아니라 **4건을 뺀 것**이고,
남은 21건은 `batch-109`가 들고 있던 바로 그 객체입니다 —
`deriveAdoptedBatchSuccessor`가 원본 배열의 항목을 그대로 돌려주므로 옮겨 적은
문장이 없고, 따라서 옮겨 적다 생길 오류도 없습니다.

원본 batch는 편집하지 않았습니다. `mem-eval-succ-2`는 그대로 남아 있고
`batch-109`도 그 안에 그대로 있습니다.

| 항목 | 값 |
|---|---|
| 원본 batch | `batch-109` |
| 원본 기록 | `docs/ops/memory-extraction-eval-batches/batch-109-successor-durable-en.md` |
| 원본 digest (작성 시점) | `6f9a3584f3d747abc10b470b68f6e9edb272ef52778ab24dc380d914d5073714` |
| 원본 케이스 수 | 25 |
| 제외 | 4 |
| 남은 케이스 수 | 21 |

## 무엇을 왜 뺐는가

규칙을 쓴 케이스는 그 규칙을 잴 수 없습니다. 아래 4건은
`.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` 에서
`mem-extract-v5`의 규칙이나 gold 판정을 만드는 데 직접 쓰였고,
`lib/memoryEvalRegressionCorpus/` 로 옮겨 회귀 확인 전용이 됩니다.

| 제외한 케이스 | 근거가 된 규칙 | 사유 | 대체 케이스 |
|---|---|---|---|
| `succ-durable-en-78` | rule-3 | 규칙 3의 kind 경계 판정 근거 | `succ-durable-en-317` |
| `succ-durable-en-79` | rule-3 | 규칙 3의 kind 경계 판정 근거 | `succ-durable-en-318` |
| `succ-durable-en-83` | rule-3 | 규칙 3의 kind 경계 판정 근거 | `succ-durable-en-319` |
| `succ-durable-en-91` | v4-kind-guide | v4 KIND_GUIDE의 occupation 정의에 따른 gold 정정 근거 | `succ-durable-en-320` |

## 남은 케이스의 판정

**다시 검수한 것이 아닙니다.** 아래 판정은 전부 `batch-109`의 기록에서
읽어 온 것이고, 이 파일을 만드는 script는 원본 기록에 `채택`이 없는 케이스에
대해서는 아무것도 쓰지 않고 실패합니다.

### succ-durable-en-76

batch-109에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-109-successor-durable-en.md 에서 이관 |

### succ-durable-en-81

batch-109에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-109-successor-durable-en.md 에서 이관 |

### succ-durable-en-86

batch-109에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-109-successor-durable-en.md 에서 이관 |

### succ-durable-en-96

batch-109에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-109-successor-durable-en.md 에서 이관 |


---

## batch 채택 결정

2026-08-27에 결정된 것은 **제외가 옳은가**이지 케이스를 다시 본 것이 아닙니다.

| 항목 | 값 |
|---|---|
| batch 채택 여부 | 채택 |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | 충분 |
| 검수 완료일 | 2026-08-27 |
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | 같음 |

| 항목 | 값 |
|---|---|
| 판정 | 통과 |
| 승인일 | 2026-08-27 |

## batch 기록 (`docs/ops/memory-extraction-eval-dataset.md` §8)

케이스를 새로 뽑지 않았으므로 초안 생성자는 `batch-109`의 것을 그대로
가져옵니다. 그 값을 적을 수 있는 것은 운영자뿐이고, 이미 적혀 있습니다.

| 항목 | 값 |
|---|---|
| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) | `ai-draft:claude-code/opus/2026-08` |
| 검수자 (사람 · 최초의 권위 있는 판정) | @mposition |
