# batch-104 — `durable_facts:ko` 검수 시트

> **자동 생성 파일입니다.** `npm run make:memory-eval-review-sheet -- --batch=batch-104`
> 로 다시 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요 — 다시 생성하면 덮어씁니다.

## 당신이 해야 하는 일

**케이스 5건 판정 + batch 채택 결정 1건.** 그게 전부입니다.

이 batch는 범주 ①이라 `docs/ops/memory-extraction-eval-dataset.md` §6.3의 **20% 표본 검수**로 갈음됩니다 — 25건 중 5건.

표본에서 **반려가 한 건이라도 나오면 불일치율이 5%를 넘으므로 batch 전건 재검수**입니다
(5건 중 1건 = 20%). 더 보고 싶으시면 아래 전체 목록에서 골라 보셔도 됩니다.

아래 §표본에 케이스 전문이 그대로 들어 있습니다. **다른 파일을 열 필요가 없습니다.**

---

## 자동 검사 — 에이전트가 이미 돌렸습니다

형식 요건은 전부 기계로 확인했습니다. 검수자는 **케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| kind 분포 (한 kind가 40% 초과 금지) | 최대 `constraint` 4/25 = **16%** |
| kind 유효성 · 키워드 수 · 키워드의 사용자 발화 실재 · 턴 수 | 25건 전부 통과 |

### near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5)

**권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가 합니다.
같은 틀에 단어만 바꾼 쌍은 shape가 1.00에 가깝고, 같은 주제의 다른 문장은 0.1 안팎입니다.

| token | shape | 쌍 |
|---|---|---|
| 0.42 | 0.35 | cand-durable-ko4-22 ~ cand-durable-ko5-12 |
| 0.33 | 0.41 | cand-durable-ko3-17 ~ cand-durable-ko5-12 |
| 0.30 | 0.37 | cand-durable-ko2-14 ~ cand-durable-ko4-18 |
| 0.30 | 0.37 | cand-durable-ko3-36 ~ cand-durable-ko4-4 |
| 0.35 | 0.35 | cand-durable-ko3-23 ~ cand-durable-ko5-15 |
| 0.29 | 0.35 | cand-durable-ko3-17 ~ cand-durable-ko4-22 |
| 0.07 | 0.33 | cand-durable-ko4-16 ~ cand-durable-ko4-23 |
| 0.27 | 0.33 | cand-durable-ko4-35 ~ cand-durable-ko5-21 |
| 0.25 | 0.32 | cand-durable-ko-13 ~ cand-durable-ko2-47 |
| 0.25 | 0.32 | cand-durable-ko-13 ~ succ-durable-ko-72 |

---

## 표본 — 판정할 5건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은 없습니다** —
실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 분이 재검수합니다 (`docs/ops/memory-extraction-eval-dataset.md` §6.4).
오탈자처럼 내용을 바꾸지 않는 수정은 `채택`에 포함됩니다.

### succ-durable-ko-51

**제안 gold label**: `constraint` — 키워드 `고소공포`

> **사용자** 고소공포증이 심해서 높은 데는 아예 못 갑니다.
>
> **assistant** 높은 곳이 포함된 선택지는 제외하겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-56

**제안 gold label**: `decision` — 키워드 `자취`

> **사용자** 올해 안에 자취하기로 정했어요. 이건 번복 안 합니다.
>
> **assistant** 정하신 걸로 두고 이어가겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-61

**제안 gold label**: `relationship` — 키워드 `시부모`

> **사용자** 시부모님과 함께 살고 있어요. 집 구조 얘기할 때 그 부분이 걸립니다.
>
> **assistant** 동거 가족을 전제로 말씀드릴게요.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-66

**제안 gold label**: `communication_style` — 키워드 `비유`

> **사용자** 비유를 들어서 설명해 주시면 훨씬 잘 들어와요.
>
> **assistant** 그럼 비유를 섞어서 말씀드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

### succ-durable-ko-71

**제안 gold label**: `formatting` — 키워드 `목록`

> **사용자** 줄글보다 목록 형태가 읽기 편해요.
>
> **assistant** 목록으로 정리해 드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
|  |  |

---

## batch 채택 결정

`docs/ops/memory-extraction-eval-dataset.md` §6.3: 표본만 보고 넘어가는 것은 채택이 아닙니다. 아래에 적어야 나머지가 dataset에 들어갑니다.

| 항목 | 값 |
|---|---|
| batch 채택 여부 | |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | |
| 검수 완료일 | |

---

## batch 기록 (`docs/ops/memory-extraction-eval-dataset.md` §8)

`docs/ops/memory-extraction-eval-dataset.md` §7.1은 동결 조건으로 초안 도구·모델·버전, 검수자, 판정 근거, draft
disagreement 비율을 요구합니다. 케이스마다 여섯 칸을 채우는 대신 batch에 한 번
적습니다 — 초안 생성자와 검수자는 batch 전체가 같고, 케이스별 draft
disagreement는 위 판정에서 그대로 계산되며, 채택된 케이스의 gold label 근거는
제안 라벨 그 자체입니다.

| 항목 | 값 |
|---|---|
| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) | *(운영자 기입)* |
| 검수자 (사람 · 최초의 권위 있는 판정) | |
| 재작성 회차 | 1 (최초 초안) |
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | |
| draft disagreement 비율 (`docs/ops/memory-extraction-eval-dataset.md` §6.4) | 위 표본 5건에서 계산 |

「초안 구성이 직전 batch와 같은가」는 `같음` 또는 `다름`으로 적습니다.
`docs/ops/memory-extraction-eval-dataset.md` §6.3의 안전장치이고, 20% 표본이 성립하는 조건입니다 — 초안
도구·모델·버전이 바뀐 뒤의 첫 batch는 전건 검수로 돌아갑니다. `다름`이라고
적으면 이 batch는 표본이 아니라 전건을 판정해야 하며, 시트를
`--full`로 다시 생성하면 전건 판정란이 나옵니다. 칸이 비어 있으면 승격되지
않습니다 — 답을 안 한 것과 `같음`은 다릅니다.

초안 생성자 칸을 에이전트가 비워 두는 이유는 하나입니다 — 이 저장소에 남기는
산출물에 에이전트의 모델 식별자를 적지 않는다는 규칙이 있어서, 자기 이름을 적을
수 있는 것은 운영자뿐입니다.

---

## 전체 25건 (참고용 — 판정 불필요)

| # | 제안 kind | 키워드 | 첫 사용자 발화 |
|---|---|---|---|
| 1 **←표본** | `constraint` | `고소공포` | 고소공포증이 심해서 높은 데는 아예 못 갑니다. |
| 2 | `constraint` | `강아지` | 강아지를 혼자 오래 못 두는 편이라 네 시간 넘는 외출은 어렵습니다. |
| 3 | `constraint` | `무릎` | 무릎이 안 좋아서 계단이나 등산은 무리예요. 이건 나아지지 않는 조건입니다. |
| 4 | `constraint` | `저염` | 저염식을 해야 합니다. 의사 지시라 조절이 아니라 아예 지켜야 하는 거예요. |
| 5 | `decision` | `이직` | 고민 끝에 이직하기로 결정했습니다. 다음 달에 얘기 꺼낼 거예요. |
| 6 **←표본** | `decision` | `자취` | 올해 안에 자취하기로 정했어요. 이건 번복 안 합니다. |
| 7 | `decision` | `대학원` | 대학원은 안 가기로 했습니다. 대신 실무로 쌓기로요. |
| 8 | `decision` | `경차` | 차는 경차로 가기로 했어요. 유지비 때문에 그렇게 정했습니다. |
| 9 | `relationship` | `조카` | 조카 셋을 자주 봐요. 큰애가 초등학생이고 아래로 둘이 더 있습니다. |
| 10 | `relationship` | `남동생` | 남동생이 한 명 있고 같은 회사에 다닙니다. 부서는 다르고요. |
| 11 **←표본** | `relationship` | `시부모` | 시부모님과 함께 살고 있어요. 집 구조 얘기할 때 그 부분이 걸립니다. |
| 12 | `relationship` | `룸메이트` | 룸메이트랑 둘이 살아요. 공간을 반반 나눠 쓰는 구조입니다. |
| 13 | `recurring_context` | `새벽` | 새벽에 일하고 낮에 잡니다. 그래서 오후 연락이 어려워요. |
| 14 | `recurring_context` | `봉사` | 토요일 오전은 늘 봉사 활동이 있습니다. 몇 년째 고정이에요. |
| 15 | `recurring_context` | `격주` | 격주로 지방 출장을 갑니다. 이틀씩 자리를 비워요. |
| 16 **←표본** | `communication_style` | `비유` | 비유를 들어서 설명해 주시면 훨씬 잘 들어와요. |
| 17 | `communication_style` | `질문` | 애매하면 그냥 넘기지 말고 질문을 먼저 해주세요. 잘못 짚고 가는 게 더 손해라… |
| 18 | `tone` | `담백` | 칭찬이나 추임새 없이 담백하게 말해 주세요. |
| 19 | `verbosity` | `자세히` | 저는 자세히 받는 걸 좋아합니다. 길어도 괜찮아요. |
| 20 | `structure` | `단계` | 설명은 단계별로 나눠서 주세요. 한 덩어리로 오면 못 따라갑니다. |
| 21 **←표본** | `formatting` | `목록` | 줄글보다 목록 형태가 읽기 편해요. |
| 22 | `language` | `영어` | 한국어로 물어봐도 답은 영어로 주세요. 영어 감을 유지하려고요. |
| 23 | `explanation_depth` | `원리` | 방법만 알려주지 마시고 원리까지 같이 설명해 주세요. |
| 24 | `citation_preference` | `출처` | 사실 관계를 말할 때는 출처를 같이 달아 주세요. 확인하고 싶어서요. |
| 25 | `code_style` | `주석` | 코드 예시에는 주석을 촘촘히 달아 주세요. 나중에 다시 볼 때 필요해서요. |

