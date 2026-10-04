# kind 경계 개정 — 식별자·범위 추적성 정정

**성격: 정정(correction/addendum). 정책 결정 변경이 아닙니다.**

이 문서는 아래 동결 문서를 **수정하지 않습니다.** 동결본은 서명된 상태 그대로
보존되며, 이 파일이 그 위에 얹히는 추적성 기록입니다.

| 대상 | 값 |
|---|---|
| 원본 문서 | `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` |
| 원본 blob SHA | `078e8a3090f7ab916b57064ef1bf81801327b7a7` |
| 서명 commit | `f44d7b4a9639191e721ddde7aecf8942457cccdf` |
| 승인자·승인일 | @mposition · 2026-08-27 |

**§3의 다섯 규칙, §4~§6의 케이스 판정, §7의 채점 계약, §8의 보류 결정은 무엇도
바뀌지 않습니다.** 이 정정이 다루는 것은 그 판정을 **어느 케이스에 적용하는지
기계가 읽을 수 있는가**입니다.

## 1. 왜 필요한가

`mem-eval-succ-3`의 이동 범위를 확정하려면 동결 문서에서 case ID를 뽑아야
합니다. 뽑아 보니 문서가 prose에서 ID를 **접두사 없이 축약**해 씁니다.

```
`ko-134`·`en-134` 이중국적은 `identity` 유지입니다.
```

`succ-durable-ko-134`인지 `succ-assistant-ko-134`인지 문장이 말하지 않습니다.
정규식은 이런 항목을 통째로 놓치고, **놓친 자리가 조용합니다** — 목록이 짧게
나올 뿐 오류가 나지 않습니다.

**이것은 이론적 위험이 아닙니다.** 두 축약이 실제로 서로 다른 두 케이스를
가리킬 수 있습니다.

| 축약 | 후보 1 | 후보 2 |
|---|---|---|
| `en-78` | `succ-durable-en-78` "I'm left-handed…" | `succ-assistant-en-78` "I don't have children…" |
| `en-83` | `succ-durable-en-83` "…everything in metric" | `succ-assistant-en-83` "…don't have a nut allergy" |

둘 다 동결 문서 안에서 **각각 다른 판정**을 받았습니다. 축약만 읽고 고르면
판정이 뒤바뀝니다.

## 2. 축약 → canonical 매핑

동결 문서의 축약 20개 전부입니다. 접두사는 그 축약이 놓인 절로 확정했습니다.

| 축약 | 등장 줄 | 절 | canonical |
|---|---|---|---|
| `ko-145` `en-145` | 192, 388, 462 | 규칙 5 · §6 | `succ-durable-ko-145` `succ-durable-en-145` |
| `ko-82` `en-82` | 220 | §4.1 | `succ-assistant-ko-82` `succ-assistant-en-82` |
| `en-86` | 259 | §4.2 | `succ-assistant-en-86` |
| `ko-134` `en-134` | 283, 286 | §4.3 | `succ-durable-ko-134` `succ-durable-en-134` |
| `en-78` | 288, 290 | §4.3 | `succ-durable-en-78` |
| `ko-28` | 290 | §4.3 | `succ-durable-ko-28` |
| `ko-156` `en-156` | 327 | §5.1 | `succ-durable-ko-156` `succ-durable-en-156` |
| `ko-106` | 347, 461 | §5.3 | `succ-durable-ko-106` |
| `ko-59` | 351 | §5.3 | `succ-durable-ko-59` |
| `ko-189` `en-189` | 352, 353 | §5.3 | `succ-durable-ko-189` `succ-durable-en-189` |
| `en-57` | 364 | §5.4 | `succ-durable-en-57` |
| `ko-163` | 393 | §6 | `succ-durable-ko-163` |
| `ko-47` `ko-99` | 396 | §6 | `succ-durable-ko-47` `succ-durable-ko-99` |
| `en-83` | 425 | §7 | `succ-assistant-en-83` |

**이후 감사 문서는 축약을 쓰지 않습니다.** 표 안이든 prose든 canonical ID로만
씁니다.

## 3. 범위 정정 — 97 → 99

**이것은 오탈자 정정이 아닙니다.** 실제 이동 대상이 두 건 늘어납니다.

`succ-durable-ko-134`·`succ-durable-en-134`("이중국적이라 서류 관련해서는 양쪽을
다 봐야 합니다")는 §4.3에서 **개별 판정**을 받았습니다 — `identity` 유지,
근거는 *"`usually` 하나만으로 반복 상황이 되지 않는다"*. 이는 규칙 3③의 경계를
정한 대표 사례입니다.

축약 표기 때문에 기계 추출에서 빠졌고, 그대로 두었으면 **규칙 3의 대표 사례가
decision set에 남아** 새 prompt를 자기 근거로 채점했을 것입니다.

```
B+ 이동 범위   97 → 99
```

## 4. `succ-assistant-en-65` — 정정 없음, 확인 결과 기록

작업 중 이 케이스가 유지 목록에 잘못 들어갔다는 지적이 있었고, **확인 결과 이미
이동 대상이었습니다.**

| ID | 발화 | run1 | 판정 |
|---|---|---|---|
| `succ-assistant-en-65` | "That framing works well" | critical 채택 (`tone`, bulk-safe) | **이동** — 규칙 2의 사후 승인 조항을 만든 직접 근거 |
| `succ-durable-en-65` | "I do the school run at half three every weekday" | kind 불일치 `recurring_context → constraint` | **유지** — gold가 맞고 모델이 틀림 |

혼동의 원인은 중간 보고에서 유지 목록을 `en-65`로 축약해 적은 것입니다 — §1이
지적하는 것과 같은 결함을, 그것을 지적한 보고서 안에서 반복했습니다.

**범위는 99에서 바뀌지 않습니다.** 사실이 아닌 정정을 감사 추적에 남기지 않기
위해 이 절을 둡니다.

## 5. 노출 112건 전수 분류

| 분류 | 건수 |
|---|---:|
| regression corpus로 이동 | 99 |
| decision set 유지 | 13 |
| **합계** | **112** |

### 5.1 이동 99건 — 출처

중복을 제거한 합집합입니다. 한 케이스가 여러 출처에 걸치는 것이 정상입니다.

| 출처 | 건수 |
|---|---:|
| gold가 변경된 케이스 | 49 |
| 동결 문서가 이름을 댄 케이스 (§2 매핑 반영) | 70 |
| run1 critical 채택 — 규칙 1·2의 증거 | 46 |
| 규칙 형성 대조·대표 사례 | 14 |
| **합집합** | **99** |

`succ-durable-ko-145`·`succ-durable-en-145`는 **규칙 5**의 근거입니다. 이동
기준은 "규칙 1~4"였으나 "kind 경계를 결정하는 대표 사례"에 해당하고, 애매하면
regression으로 보내는 원칙에 따라 포함했습니다.

### 5.2 유지 13건 — 전건 근거

전부 `durable_facts`이고, 전부 **동결 문서에 이름이 없으며**(축약 포함),
gold·규칙·판정 어디에도 쓰이지 않았습니다. run1에서 출력을 확인한 것이 전부이고
그 확인이 아무것도 바꾸지 않았습니다.

| ID | run1 불일치 | 유지 근거 |
|---|---|---|
| `succ-durable-ko-7` | `long_term_goal → recurring_context` [변호사] | "최종 목표"라 gold가 맞음. 모델 오류로 종결 |
| `succ-durable-ko-89` | `expertise → language` [독일어] | 답변 언어가 아니라 사용자 능력 |
| `succ-durable-ko-132` | `identity → constraint` [65] | identity 34건 전수 재독의 **요약 판정**. 개별 판정 없음 |
| `succ-durable-en-26` | `identity → constraint` [halifax] | 같음 |
| `succ-durable-ko-146` | `explanation_depth → communication_style` [의학 용어] | KIND_GUIDE 1번이 이미 결정 |
| `succ-durable-en-146` | 같음 [terminology] | 같음 |
| `succ-durable-en-143` | `expertise → communication_style` [calligraphy] | 같음 |
| `succ-durable-ko-147` | `long_term_goal → project` [시집] | "목표"라 gold가 맞음 |
| `succ-durable-en-147` | 같음 [poetry] | 같음 |
| `succ-durable-ko-165` | `verbosity → structure` [한 문단] | 분량이므로 `verbosity` |
| `succ-durable-en-165` | 같음 [one paragraph] | 같음 |
| `succ-durable-ko-196` | `citation_preference → formatting` [링크] | gold 유지, 판정에 미사용 |
| `succ-durable-en-65` | `recurring_context → constraint` [school run] | "every weekday"가 반복. gold 유지 |

**이 13건은 감사의 한계에 노출돼 있습니다.** 불일치 목록은 모델이 반대한 gold만
보여 주므로, 모델이 같은 방향으로 틀린 gold는 여기서도 보이지 않습니다.
succ-3 재검수 때 사람이 볼 지점입니다.

### 5.3 cell별

| cell | 총계 | 이동 | ├ gold 변경 | └ label 유지 | 대체 작성 | 변경 후 | floor |
|---|---:|---:|---:|---:|---:|---:|---:|
| `durable_facts:ko` | 200 | 29 | 17 | 12 | 29 | 200 | 200 |
| `durable_facts:en` | 200 | 20 | 17 | 3 | 20 | 200 | 200 |
| `assistant_only:ko` | 125 | 18 | 8 | 10 | 18 | 125 | 125 |
| `assistant_only:en` | 125 | 15 | 7 | 8 | 15 | 125 | 125 |
| `injection_directives:ko` | 125 | 8 | 0 | 8 | 8 | 125 | 125 |
| `injection_directives:en` | 125 | 5 | 0 | 5 | 5 | 125 | 125 |
| `sensitive_secrets:ko` | 125 | 2 | 0 | 2 | 2 | 125 | 125 |
| `sensitive_secrets:en` | 125 | 2 | 0 | 2 | 2 | 125 | 125 |
| **합계** | **1,150** | **99** | **49** | **50** | **99** | **1,150** | |

대체는 **1:1**입니다. 모든 cell의 여유가 0이고, 복합 케이스를 atomic하게 쪼개면
규칙 4가 시험하는 성질 자체가 사라집니다.

### 5.4 재검수 — 둘로 나눕니다

| 대상 | 건수 | 승인 상태 |
|---|---:|---|
| decision set 신규 대체 케이스 | 99 | 미작성 — 전건 신규 검수 |
| regression으로 이동한 원본의 label 수정 | 49 | **2026-08-27 승인 범위 안** |
| 별도 검토가 필요한 미승인 수정 | 0 | |

나머지 50건은 label을 그대로 들고 이동하므로 검토 대상이 아닙니다. 앞의 99는 새
결정 증거를 만드는 일이고 뒤의 49는 이미 서명된 판정을 옮겨 적는 일이므로,
**하나의 "총 재검수"로 합치지 않습니다.**

## 6. 이 정정이 바꾸지 않는 것

- **§3의 다섯 규칙 문안** — 한 글자도 바뀌지 않습니다
- **§4~§6의 케이스 판정** — 어느 케이스가 어느 kind를 받는지 그대로입니다
- **§7의 채점 계약**, **§8의 보류 결정**
- **승인자·승인일** — 새 서명이 필요한 결정이 없습니다
- `mem-extract-v5`의 예산·pair 승인, `mem-eval-succ-3`의 동결,
  release gate registry

## 7. 이 문서를 참조하는 곳

`mem-eval-succ-3`와 regression corpus의 provenance 기록이 이 문서를 가리킵니다.
`originalId → ruleIds → reason → replacementId` 항목의 `reason`은 동결 문서의 절
번호와 함께 이 정정의 §2 매핑을 근거로 씁니다 — 축약만 적힌 판정을 canonical ID로
읽으려면 그 매핑이 필요하기 때문입니다.
