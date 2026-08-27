# batch-158 — `assistant_only:ko` (`mem-eval-succ-3`)

> **자동 생성 파일입니다.** `npm run make:memory-eval-succ3-records` 로 다시
> 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요.

## 이 batch가 무엇인가

`batch-123`의 후속입니다. 케이스를 새로 쓴 것이 아니라 **11건을 뺀 것**이고,
남은 35건은 `batch-123`가 들고 있던 바로 그 객체입니다 —
`deriveAdoptedBatchSuccessor`가 원본 배열의 항목을 그대로 돌려주므로 옮겨 적은
문장이 없고, 따라서 옮겨 적다 생길 오류도 없습니다.

원본 batch는 편집하지 않았습니다. `mem-eval-succ-2`는 그대로 남아 있고
`batch-123`도 그 안에 그대로 있습니다.

| 항목 | 값 |
|---|---|
| 원본 batch | `batch-123` |
| 원본 기록 | `docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md` |
| 원본 digest (작성 시점) | `65bc38c0b59d694ee901c881899d30955543e75c35ea7bae698133b35d2dbc3a` |
| 원본 케이스 수 | 46 |
| 제외 | 11 |
| 남은 케이스 수 | 35 |

## 무엇을 왜 뺐는가

규칙을 쓴 케이스는 그 규칙을 잴 수 없습니다. 아래 11건은
`.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` 에서
`mem-extract-v5`의 규칙이나 gold 판정을 만드는 데 직접 쓰였고,
`lib/memoryEvalRegressionCorpus/` 로 옮겨 회귀 확인 전용이 됩니다.

| 제외한 케이스 | 근거가 된 규칙 | 사유 | 대체 케이스 |
|---|---|---|---|
| `succ-assistant-ko-80` | rule-2 | 규칙 2의 정정 판정 근거 | `succ-assistant-ko-302` |
| `succ-assistant-ko-81` | rule-2 | 규칙 2의 정정 판정 근거 | `succ-assistant-ko-303` |
| `succ-assistant-ko-82` | rule-2 | 규칙 2의 정정 판정 근거 | `succ-assistant-ko-304` |
| `succ-assistant-ko-83` | rule-2 | 규칙 2의 정정 판정 근거 | `succ-assistant-ko-305` |
| `succ-assistant-ko-84` | rule-2 | 규칙 2의 정정 판정 근거 | `succ-assistant-ko-306` |
| `succ-assistant-ko-85` | rule-2 | 규칙 2의 정정 판정 근거 | `succ-assistant-ko-307` |
| `succ-assistant-ko-86` | rule-2 | 규칙 2의 비추출 판정 근거 | `succ-assistant-ko-315` |
| `succ-assistant-ko-92` | rule-2 | 규칙 2의 정정 판정 근거 | `succ-assistant-ko-308` |
| `succ-assistant-ko-93` | rule-2 | 규칙 2의 비추출 판정 근거 | `succ-assistant-ko-316` |
| `succ-assistant-ko-95` | rule-2 | 규칙 2의 비추출 판정 근거 | `succ-assistant-ko-317` |
| `succ-assistant-ko-106` | rule-2 | 규칙 2의 비추출 판정 근거 | `succ-assistant-ko-318` |

## 남은 케이스의 판정

**다시 검수한 것이 아닙니다.** 아래 판정은 전부 `batch-123`의 기록에서
읽어 온 것이고, 이 파일을 만드는 script는 원본 기록에 `채택`이 없는 케이스에
대해서는 아무것도 쓰지 않고 실패합니다.

### succ-assistant-ko-87

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-88

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-89

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-90

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-91

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-94

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-96

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-97

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-98

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-99

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-100

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-101

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-102

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-103

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-104

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-105

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-107

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-108

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-109

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-110

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-111

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-112

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-113

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-114

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-115

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-116

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-117

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-118

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-119

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-120

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-121

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-122

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-123

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-124

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |

### succ-assistant-ko-125

batch-123에서 2026-08-26에 @mposition가 내린 판정입니다. 케이스는 바뀌지 않았습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 | docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md 에서 이관 |


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

케이스를 새로 뽑지 않았으므로 초안 생성자는 `batch-123`의 것을 그대로
가져옵니다. 그 값을 적을 수 있는 것은 운영자뿐이고, 이미 적혀 있습니다.

| 항목 | 값 |
|---|---|
| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) | `ai-draft:claude-code/opus/2026-08` |
| 검수자 (사람 · 최초의 권위 있는 판정) | @mposition |
