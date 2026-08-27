# batch-162 — `durable_facts:ko` 대체 케이스 (`mem-eval-succ-3`)

> **자동 생성 파일입니다.** `npm run make:memory-eval-succ3-records` 로 다시
> 만들 수 있습니다. 판정란 외에는 손으로 고치지 마세요.

## 이 batch가 무엇인가

`mem-eval-succ-3`을 위해 **새로 쓴 29건**입니다. 규칙을 쓴 케이스가
`lib/memoryEvalRegressionCorpus/` 로 빠지면서 `durable_facts:ko` 이 §12.2 하한
아래로 내려가므로, 같은 경계를 재되 **상황을 바꿔** 그 자리를 채웁니다.

바꾼 것은 문장이 아니라 상황입니다. 명사만 갈아 끼운 대체는 `mem-extract-v5`가
자기가 쓰여진 문장에 답하게 두는 것이고, 원본이 decision set을 떠나므로 기계로는
잡히지 않습니다. `tests/memoryEvalReplacementPlan.test.mjs` 가 succ-2의 어떤
케이스와도 token 유사도 0.45를 넘지 않도록 잡습니다.

## 전건 — 판정할 29건

판정은 `채택` / `반려(재작성)` / `반려(폐기)` 중 하나입니다.

> **아래 판정란은 에이전트가 옮겨 적은 전사입니다.** 2026-08-27 대화에서
> 운영자가 「판정결과: 통과 / 승인자: mposition / 승인일자: 2026-08-27」이라고
> 보고한 판정을 그대로 옮긴 것이고, 지어낸 값은 없습니다.
> `AGENTS.md`「기록을 채우는 경계는 관측과 판정입니다」에 따라 **판정은 사람의
> 것**이므로, 운영자가 각 줄을 확인한 뒤 확정합니다.

### succ-durable-ko-301

`succ-durable-ko-105` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `recurring_context` — [여섯] · bulk_safe

> **사용자** 아버지가 새벽 시장에 나가셔서 저희 집은 아침 여섯 시면 다들 깨어 있습니다.
>
> **assistant** 이른 시간대를 전제로 보겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-302

`succ-durable-ko-106` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [토끼] · bulk_safe

> **사용자** 토끼를 한 마리 키웁니다. 집 온도 얘기할 때 그거 감안해 주세요.
>
> **assistant** 반려동물이 있는 집 기준으로 보겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-303

`succ-durable-ko-107` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [이모] · bulk_safe

> **사용자** 이모와 한집에 삽니다. 살림은 같이 꾸리고요.
>
> **assistant** 그 구성으로 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-304

`succ-durable-ko-116` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `structure` — [예시] · bulk_safe

> **사용자** 예시를 먼저 보여주고 설명은 그 뒤에 붙여 주세요.
>
> **assistant** 예시를 앞에 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-305

`succ-durable-ko-133` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `constraint` — [관절염] · sensitive_review

> **사용자** 손목 관절염이 있어서 오래 타이핑하는 건 어렵습니다.
>
> **assistant** 입력을 적게 요구하는 쪽으로 안내드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-306

`succ-durable-ko-134` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `identity` — [영주권] · bulk_safe

> **사용자** 영주권자라서 체류 관련 서류는 늘 별도로 챙겨야 합니다.
>
> **assistant** 그 부분을 함께 짚겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-307

`succ-durable-ko-145` 를 대신합니다 (rule-5 · §6).

**제안 gold label**: `expertise` — [용접] · 택1 [처음, 초보, 기초, 입문, 배우기 시작, 시작한 지] · bulk_safe

> **사용자** 용접은 이번 달에 처음 배우기 시작했습니다. 아직 기초도 모릅니다.
>
> **assistant** 기초부터 잡아 드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-308

`succ-durable-ko-15` 를 대신합니다 (rule-4 · §3).

**제안 gold label**: `recurring_context` — [재고] · bulk_safe

> **사용자** 격주 금요일마다 재고 조사를 해서 그날은 오후가 통째로 나갑니다.
>
> **assistant** 그 날짜는 비워 두고 잡겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-309

`succ-durable-ko-156` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `recurring_context` — [주말] · 택1 [가게, 돕, 도우, 일손] · bulk_safe

> **사용자** 주말마다 아버지 가게 일을 도우러 갑니다.
>
> **assistant** 주말은 비어 있지 않은 것으로 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-310

`succ-durable-ko-157` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `recurring_context` — [일주일] · bulk_safe

> **사용자** 장모님이 매달 초에 저희 집에 일주일씩 머무십니다.
>
> **assistant** 그 기간을 감안하겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-311

`succ-durable-ko-158` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [삼촌] · bulk_safe / `recurring_context` — [지출] · 택1 [상의, 함께, 같이, 공동] · bulk_safe

> **사용자** 삼촌과 함께 삽니다. 큰 지출은 늘 상의해서 정합니다.
>
> **assistant** 공동 결정으로 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-312

`succ-durable-ko-163` 를 대신합니다 (rule-5 · §6).

**제안 gold label**: `formatting` — [각주] · bulk_safe / `explanation_depth` — [약어] · 택1 [풀이, 설명, 풀어, 한 줄] · bulk_safe

> **사용자** 약어는 본문에 그대로 쓰시고 각주로 한 줄씩 풀어 주세요. 약어 자체를 익혀야 해서요.
>
> **assistant** 본문은 약어로 두고 각주를 달겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-313

`succ-durable-ko-175` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `constraint` — [배송] · bulk_safe

> **사용자** 섬에 살아서 당일 배송이 되는 물건이 거의 없습니다.
>
> **assistant** 배송 가능 여부를 먼저 보고 고르겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-314

`succ-durable-ko-189` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `recurring_context` — [매일] · 택1 [걷, 산책, 저녁] · bulk_safe

> **사용자** 아버지랑 매일 저녁에 삼십 분씩 걷습니다. 그게 하루 마무리예요.
>
> **assistant** 저녁 시간대는 그 일정으로 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-315

`succ-durable-ko-190` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [누나] · bulk_safe / `occupation` — [공방] · bulk_safe / `recurring_context` — [주문] · 택1 [매달, 매월, 달마다] · bulk_safe

> **사용자** 누나랑 둘이 공방을 운영합니다. 재료 주문은 매달 같이 정합니다.
>
> **assistant** 두 분 공동 운영으로 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-316

`succ-durable-ko-2` 를 대신합니다 (rule-4 · §3).

**제안 gold label**: `occupation` — [관제] · bulk_safe / `recurring_context` — [교대] · bulk_safe

> **사용자** 항공 관제사입니다. 4조 2교대라 근무가 주마다 달라집니다.
>
> **assistant** 교대 주기를 알려주시면 반영하겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-317

`succ-durable-ko-21` 를 대신합니다 (rule-2 · §3).

**제안 gold label**: `citation_preference` — [링크] · bulk_safe

> **사용자** 설명할 때마다 근거 링크를 같이 붙여 주세요
>
> **assistant** 출처를 함께 달겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-318

`succ-durable-ko-23` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [친구] · bulk_safe / `occupation` — [카페] · bulk_safe

> **사용자** 친구랑 둘이서 카페를 합니다. 지분은 반반이고요.
>
> **assistant** 두 분이 반반이시군요.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-319

`succ-durable-ko-28` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `constraint` — [선반] · bulk_safe

> **사용자** 키가 작아서 위쪽 선반에 두는 물건은 저한테 안 맞습니다.
>
> **assistant** 손이 닿는 높이 기준으로 골라 드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-320

`succ-durable-ko-29` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `relationship` — [의붓형] · bulk_safe

> **사용자** 재혼 가정에서 자랐고 의붓형이 하나 있습니다.
>
> **assistant** 가족 구성을 그렇게 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-321

`succ-durable-ko-47` 를 대신합니다 (rule-4 · §6).

**제안 gold label**: `recurring_context` — [합창] · bulk_safe

> **사용자** 화요일 저녁마다 합창단 연습에 나갑니다. 올해로 오 년째예요.
>
> **assistant** 화요일 저녁은 고정으로 두겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-322

`succ-durable-ko-59` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [손주] · bulk_safe

> **사용자** 손주를 가끔 봅니다. 큰애가 이제 막 걷기 시작했어요.
>
> **assistant** 그 연령대를 감안해서 말씀드릴게요.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-323

`succ-durable-ko-61` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [할아버지] · bulk_safe

> **사용자** 명절 계획을 짜는 중입니다. 할아버지를 모시고 살아서 이동 없이 집에서 하려고요.
>
> **assistant** 집에서 치르는 쪽으로 보겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-324

`succ-durable-ko-62` 를 대신합니다 (rule-4 · §5).

**제안 gold label**: `relationship` — [하숙] · bulk_safe

> **사용자** 하숙을 하고 있어서 주인집 가족과 같이 지냅니다.
>
> **assistant** 공유 공간 기준으로 이어가겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-325

`succ-durable-ko-76` 를 대신합니다 (rule-3 · §3).

**제안 gold label**: `identity` — [대전] · bulk_safe

> **사용자** 이사 얘기가 나올 때마다 말씀드리는데, 저는 대전 토박이입니다.
>
> **assistant** 그 지역 기준으로 안내드릴게요.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-326

`succ-durable-ko-78` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `constraint` — [저시력] · sensitive_review

> **사용자** 저시력이라 작은 글씨로 된 표는 읽지 못합니다.
>
> **assistant** 표 대신 문장으로 풀어 드리겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-327

`succ-durable-ko-79` 를 대신합니다 (rule-3 · §4.3).

**제안 gold label**: `relationship` — [막내] · bulk_safe

> **사용자** 삼형제 막내로 자랐습니다. 위로 형이 둘이에요.
>
> **assistant** 형제 순서가 필요한 이야기면 반영하겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-328

`succ-durable-ko-83` 를 대신합니다 (rule-4 · §6).

**제안 gold label**: `recurring_context` — [카페] · bulk_safe

> **사용자** 글 쓰는 일은 전부 동네 카페에서 합니다. 사무실에서는 한 줄도 못 써요.
>
> **assistant** 작업 환경은 그쪽 기준으로 보겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |

### succ-durable-ko-329

`succ-durable-ko-99` 를 대신합니다 (rule-4 · §6).

**제안 gold label**: `project` — [번역] · bulk_safe

> **사용자** 작년부터 소설 한 권을 번역하고 있습니다. 아직 절반쯤 왔어요.
>
> **assistant** 그 작업을 전제로 하겠습니다.

| 판정 | 사유 (반려일 때만) |
|---|---|
| 채택 |  |


---

## batch 채택 결정

| 항목 | 값 |
|---|---|
| batch 채택 여부 | 채택 |
| 다양성 판정 (`docs/ops/memory-extraction-eval-dataset.md` §6.5) | 충분 |
| 검수 완료일 | 2026-08-27 |
| 초안 구성이 직전 batch와 같은가 (`docs/ops/memory-extraction-eval-dataset.md` §6.3) | 다름 (전건 검수) |

| 항목 | 값 |
|---|---|
| 판정 | 통과 |
| 승인일 | 2026-08-27 |

「초안 구성이 직전 batch와 같은가」가 `다름`이므로 표본이 아니라 **전건**을
판정했습니다 — 위 29건 전부에 판정란이 있습니다.

## batch 기록 (`docs/ops/memory-extraction-eval-dataset.md` §8)

| 항목 | 값 |
|---|---|
| 초안 생성자 (`ai-draft:<도구>/<모델>/<버전>`) |  |
| 검수자 (사람 · 최초의 권위 있는 판정) | @mposition |
| 재작성 회차 | 1 (최초 초안) |

**초안 생성자 칸은 비어 있고, 채울 수 있는 것은 운영자뿐입니다.** 이 저장소에
남기는 산출물에 에이전트가 자기 모델 식별자를 적지 않는다는 규칙이 있어서,
succ-2의 기록에서도 같은 이유로 사람이 적었습니다. §7.1의 일곱 조건 중
「초안 도구·모델·버전 기록」이 이 칸 하나에 걸려 있고,
`npm run check:memory-eval-freeze` 가 채워질 때까지 succ-3을 미충족으로
보고합니다.
