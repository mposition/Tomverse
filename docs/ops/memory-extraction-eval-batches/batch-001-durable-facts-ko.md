# batch-001 — `durable_facts:ko` 첫 batch (검수 대기)

`docs/ops/memory-extraction-eval-dataset.md` §8의 케이스별 기록입니다. 판정란은
검수자가 채웁니다. **에이전트는 판정란을 기입하지 않습니다** — 초안 생성자가 자기
초안을 채택하는 것이 `docs/ops/memory-extraction-eval-dataset.md` §6.2가 막는 것입니다.

## batch 정보

| 항목 | 값 |
|---|---|
| batch id | `batch-001` |
| cell | `durable_facts:ko` |
| 케이스 수 | 25 (`docs/ops/memory-extraction-eval-dataset.md` §6.1의 25~50 범위) |
| 상태 | **검수 대기** — candidate pool, dataset 아님 |
| 초안 위치 | `lib/memoryExtractionEvalCandidates/batch001DurableKo.ts` |
| 초안 도구 | Claude Code (Anthropic) |
| 초안 모델·버전 | **미기입** — `docs/ops/memory-extraction-eval-dataset.md` §6.5는 모델·버전 기록을 요구하고, 이 에이전트는 저장소에 남기는 산출물에 모델 식별자를 쓰지 않도록 설정돼 있습니다. 운영자가 기입해 주세요. |
| 초안 계열이 평가 대상과 같은가 | **아니오.** 평가 대상은 `gpt-5-6-luna`(OpenAI), 초안은 Anthropic 계열이므로 `docs/ops/memory-extraction-eval-dataset.md` §6.5의 "비 OpenAI 계열 우선"을 만족합니다 |
| 작성일 | 2026-08-23 |
| 검수자 | @mposition *(전사 — 확인 필요)* |
| 검수 완료일 | |
| batch 채택 여부 | |

## 이 batch가 왜 25건인가

`docs/ops/memory-extraction-eval-dataset.md` §6.5는 cell마다 첫 batch를 사람이 검수한 뒤 나머지를 생성하라고 합니다. 8개 cell의
첫 batch를 한꺼번에 내면 200건이 한 번에 검수 대상이 되고, 초안에 체계적 결함이
있으면 그 결함이 200번 복제된 상태로 발견됩니다. **한 cell만 먼저 낸 것은 지침보다
더 좁게 잡은 것이고, 의도한 것입니다** — 이 25건에 대한 판정이 나머지 7개 cell의
초안 방향을 정합니다.

나머지 7개 cell의 첫 batch를 기다리지 않고 바로 받고 싶으시면 그렇게 하겠습니다.

## 자동 검사 결과 (에이전트가 수행 — `docs/ops/memory-extraction-eval-dataset.md` §6.5)

사람이 셈이나 대조를 하지 않도록, 형식 요건은 전부 기계로 확인했습니다. 검수자는
**케이스가 좋은 케이스인가**만 보면 됩니다.

| 검사 | 결과 |
|---|---|
| exact duplicate (`findDuplicateCases`) | 0건 |
| kind 분포 (`docs/ops/memory-extraction-eval-dataset.md` §3.2, 한 kind가 40% 초과 금지) | 최대 `constraint`·`preference` 각 3/25 = **12%** |
| kind 유효성 (`docs/ops/memory-extraction-eval-dataset.md` §8.2 목록) | 25건 전부 유효 |
| `expected` 개수 (`docs/ops/memory-extraction-eval-dataset.md` §4.1, 1~3개) | 전부 1개 |
| `mustInclude` 키워드 수 (`docs/ops/memory-extraction-eval-dataset.md` §4.1, 2개 이하 권장) | 전부 1~2개 |
| 키워드가 **사용자 발화**에 실재하는가 (`docs/ops/memory-extraction-eval-dataset.md` §3.2) | 25건 전부 확인 — assistant 발화에만 있는 키워드 없음 |
| 턴 수 · 사용자 발화 (`docs/ops/memory-extraction-eval-dataset.md` §3.1, 각 ≥2 / ≥1) | 전부 충족 |
| near-duplicate 상위 쌍 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | 이 cell 최고 token 0.25 / shape 0.14 — 아래 참조 |

near-duplicate 보고서 실행:

```
npm run report:memory-eval-near-duplicates -- --candidates --top=15
```

**이 보고서는 권고입니다.** 통과·불통과를 정하지 않으며, 다양성 판정은 검수자가
합니다(`docs/ops/memory-extraction-eval-dataset.md` §6.5). 참고로 검출기는 같은 틀에 단어만 바꾼 쌍에서 shape 1.00, 같은 주제의
다른 문장에서 0.10을 냅니다(`tests/memoryEvalNearDuplicates.test.mjs`가 고정).

## `docs/ops/memory-extraction-eval-dataset.md` §3.1 분산 — 무엇을 의도적으로 섞었는가

검수자가 "고르게 분산됐는가"를 판정할 때 볼 지점입니다.

- **길이**: 한 줄 요청(3, 5, 10, 21번)부터 긴 배경 설명(2, 19번)까지
- **오탈자**: 21번("말해주고"의 마침표 없음), 25번("급한거", "안받습니다")
- **이모지**: 4번
- **문체**: 존댓말 정중체와 반말체에 가까운 구어체를 섞음
- **주제**: 의료·세무·용접·법조·농업·육아·주거·여행·개발 등 서로 다른 생활 영역
- **턴 구조**: 2턴과 3턴을 섞음

## 케이스별 판정 (검수자 기입)

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다. **`수정 후 채택`은
없습니다** — 실질 수정은 반려 사유를 남기면 에이전트가 재작성하고 같은 사람이
재검수합니다(`docs/ops/memory-extraction-eval-dataset.md` §6.4). 내용을 바꾸지 않는 표기 수정은 `채택`에 포함됩니다.

`draft disagreement`는 제안과 채택된 판정이 다른 경우 `Y`입니다. adjudication이
아니며(`docs/ops/memory-extraction-eval-dataset.md` §6.4), batch별 비율만 집계합니다.

| # | 제안 kind | 제안 키워드 | 사용자 발화 발췌 | 판정 | 사유 / draft disagreement |
|---|---|---|---|---|---|
| 1 | `constraint` | `갑각류` | 저 갑각류 알레르기 있어서 새우나 게 들어간 건 빼주세요. | | |
| 2 | `occupation` | `간호사` | 제가 종합병원 간호사인데 3교대라 수면 패턴이 계속 깨져요. 야간 근무 … | | |
| 3 | `verbosity` | `짧게` | 앞으로 짧게 대답해 주세요. 길면 안 읽게 돼요. | | |
| 4 | `project` | `가계부` + `앱` | 요즘 가계부 앱을 혼자 만들고 있어요. 주말에만 붙잡고 있는데 벌써 넉 … | | |
| 5 | `identity` | `부산` | 부산 살아요. 근처에 갈 만한 데 있을까요? | | |
| 6 | `expertise` | `통계` | 통계는 대학원에서 전공해서 어느 정도 압니다. 기초 설명은 건너뛰고 바로… | | |
| 7 | `long_term_goal` | `변호사` | 최종 목표는 변호사가 되는 거예요. 지금은 직장 다니면서 준비 중이고요. | | |
| 8 | `relationship` | `쌍둥이` | 쌍둥이 아들 둘 키우고 있어요. 이제 여섯 살이요. | | |
| 9 | `code_style` | `탭` | 코드 예시 줄 때 들여쓰기는 탭으로 해주세요. 스페이스는 안 씁니다. | | |
| 10 | `preference` | `창가` | 비행기 예약할 때는 늘 창가 자리로 잡아요. | | |
| 11 | `decision` | `postgres` | 고민 끝에 postgres 쓰기로 정했습니다. 이제 안 바꿀 거예요. | | |
| 12 | `constraint` | `휠체어` | 어머니가 휠체어를 쓰셔서 계단 있는 곳은 아예 못 갑니다. 이거 꼭 감안… | | |
| 13 | `language` | `한국어` | 영어로 물어봐도 답은 한국어로 주세요. | | |
| 14 | `occupation` | `세무사` | 세무사로 일한 지 12년 됐습니다. | | |
| 15 | `recurring_context` | `월요일` + `회의` | 매주 월요일 아침에 팀 회의가 있어서 그때는 답장이 늦어요. | | |
| 16 | `expertise` | `용접` | 용접은 현장에서 20년 했습니다. 기본기 설명은 필요 없어요. | | |
| 17 | `preference` | `표` + `정리` | 비교할 게 여러 개면 표로 정리해 주는 게 제일 편해요. | | |
| 18 | `identity` | `1986` | 1986년생이에요. | | |
| 19 | `project` | `논문` + `기후` | 지금 기후 변화 관련 논문을 쓰고 있는데 자료 정리가 안 되네요. 인터뷰… | | |
| 20 | `constraint` | `예산` + `300` | 예산이 300만원을 못 넘습니다. 이 선은 절대 못 넘어요. | | |
| 21 | `communication_style` | `결론` | 결론 먼저 말해주고 이유는 뒤에 붙여주세요 | | |
| 22 | `decision` | `전세` | 고민하다가 매매 말고 전세로 가기로 결정했어요. | | |
| 23 | `relationship` | `동업자` | 동업자랑 둘이서 운영하는 가게예요. 지분은 반반이고요. | | |
| 24 | `long_term_goal` | `귀농` | 언젠가는 귀농할 생각이에요. 아직 시기는 안 정했지만 방향은 확실합니다. | | |
| 25 | `preference` | `전화` + `싫` | 전화 통화는 싫어해서 되도록 문자나 메일로 처리해요. 급한거 아니면 전화… | | |

## batch 집계 (검수 완료 후 기입)

| 항목 | 값 |
|---|---|
| 채택 | |
| 반려(재작성) | |
| 반려(폐기) | |
| draft disagreement 비율 | |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | |

## 다음 단계

1. 위 판정란 기입 → **batch 채택 여부** 기록 (`docs/ops/memory-extraction-eval-dataset.md` §6.3: 표본 검수는 명시적 batch
   채택으로 이어집니다)
2. `반려(재작성)`이 있으면 에이전트가 재작성 → 같은 검수자가 재검수
3. 채택된 케이스를 `lib/memoryExtractionEvalFixtures.ts`로 이동하고
   `MEMORY_EVAL_DATASET_VERSION`을 올림
4. 이 cell의 나머지 171건 생성 (200 − 4(기존 seed) − 25)
