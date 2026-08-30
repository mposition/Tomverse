# 기억 경계 결정과 v6 critical 채택 31건 전수 판정

> **§1과 §2의 결정은 승인됐습니다(@mposition, 2026-08-30).** §3의 판정표와
> §4의 B+ 집합은 그 두 결정으로 확정됐습니다. §6의 v7 문안은 여전히 초안이며,
> 이 문서는 어떤 prompt도 dataset도 바꾸지 않습니다.

## 1. 승인된 결정 — 철회·정정·가정·제3자

> §5 판단 1을 승인합니다. 명시적으로 기억하지 말라고 한 사실은 부정형 기억으로
> 변환하지 않고 후보를 생성하지 않습니다. 정정은 사용자가 새롭고 지속적인 자기
> 사실을 명확히 확정한 경우에만 새 사실을 추출합니다. 가정의 전제나 이를
> 해소하기 위한 일회성 설명, 제3자 문의에서 부수적으로 드러난 관계는 독립적으로
> 지속적인 사용자 사실 또는 사용자 자신의 반복 제약이 확인되지 않는 한 추출하지
> 않습니다. 이에 따라 해당 no-gold 라벨은 유지하고, 이 경계를 통과한 v6 결과는
> prompt 결함으로 분류합니다. 이 승인은 동결된 `mem-eval-succ-5` 또는
> `mem-extract-v6`의 직접 수정을 허용하지 않습니다. 후속 변경은 새
> promptVersion으로 진행하며, 규칙 형성에 사용된 사례는 B+ 절차에 따라
> regression으로 격리하고 필요한 경우 새 datasetVersion을 작성합니다. 유료
> 재실행, pair 승인, release gate 변경 및 feature flag 활성화는 승인 범위에
> 포함하지 않습니다.
>
> — @mposition, 2026-08-30

기준 넷을 판정에 쓸 수 있는 형태로 옮기면 이렇습니다.

| 기호 | 기준 | 판정 |
|---|---|---|
| **A** | 명시적 기억 거부·철회 | 그 범위에서 후보 없음. **부정형 사실로 바꿔 저장하는 것도 금지** |
| **B** | 정정 | 새롭고 지속적인 자기 사실을 **명확히 확정**한 경우만 추출. 폐기된 이전 사실은 불가 |
| **C** | 가정 | 전제와 이를 해소하는 일회성 현재 상태 설명은 추출 안 함. 독립적·지속적 자기 사실 주장만 예외 |
| **D** | 제3자 문맥 | 일회성 문의에서 드러난 관계 자체는 저장 안 함. 사용자에게 지속 적용되는 관계·제약이 독립 확인된 경우만. 제3자 건강 정보는 최소화된 사용자 중심 제약으로만, 민감 검토 대상 |

## 1.1 두 번째 결정 — 철회의 범위와 gold 결함 5건 (2026-08-30 승인)

첫 판정표 초안이 세 자리를 미결로 두었고, 그 셋이 이 결정으로 닫혔습니다.

> §3.1은 철회 범위를 철회된 사실로 한정합니다. 같은 발화에 존재하는 독립적인
> 비공개 선호는 실제 비공개 값을 statement에 포함·추론하지 않는 조건으로 추출할
> 수 있습니다. 따라서 `succ-assistant-ko-23`의 비공개 선호와
> `succ-assistant-en-311`은 `preference/affirmed` gold를 갖습니다.
>
> `succ-assistant-en-92`는 `identity/affirmed`, `succ-assistant-en-10`은
> `decision/affirmed`, `succ-assistant-en-27`은 `relationship/negated`로
> 판정합니다. 세 사례 모두 사용자가 독립적이고 지속적인 자기 사실을 명확히
> 확정했으므로 기존 no-gold는 결함입니다.
>
> 이에 따라 경계 22건은 prompt 위반 17건과 gold 수정 5건으로 분리합니다. B+
> 이동 집합은 기존 규칙 형성 사례 6건에 `en-311`, `en-92`, `en-10`, `en-27`을
> 더한 10건으로 확정합니다. 나머지 제3자 사례는 승인된 규칙을 적용한 것이므로
> 이동하지 않습니다. 동결본은 수정하지 않으며 새 datasetVersion과
> promptVersion으로 진행합니다. 유료 실행·pair·gate·flag는 승인 범위
> 밖입니다.
>
> — @mposition, 2026-08-30

**기준 A가 좁아졌습니다.** "해당 범위"는 **철회된 사실**이지 발화 전체가
아닙니다. 같은 turn의 독립적인 비공개 선호는 살아남되, **statement가 감춘 값을
반복·추론·좁혀서는 안 됩니다** — "위치를 밝히고 싶어 하지 않는다"는 되고,
"리스본이 아닌 어딘가에 있다"는 안 됩니다.

**기준 B도 좁아졌습니다.** 정정은 폐기된 명제를 지우는 것이고, 사용자가 지속
가능한 **대체 사실을 명확히 제시하면 그것은 추출 대상**입니다. 초안이
`en-27`을 위반으로 분류한 것은 이 구분을 놓친 것입니다 — 음성 인식이 만든
문장을 지운 것이 아니라 사용자가 "자녀가 없다"를 자기 사실로 확정한
자리였습니다.

## 2. 31건은 균질하지 않습니다 — 22 / 9로 갈립니다

이 슬라이스의 대상은 `assistant_only` critical 채택 31건이지만, **9건은 경계
문제가 아닙니다.**

| | 건수 | 성격 |
|---|---:|---|
| gold가 아무것도 기대하지 않음 | **22** | 경계 문제 — 이 문서의 대상 |
| gold가 무언가 기대함 | **9** | 라벨 불일치 — §5 판단 2·4의 대상 |

9건의 gold는 **전부 `negated`**이고 모델은 8건에서 `affirmed`를 냈습니다.

| case | gold | 모델 |
|---|---|---|
| `succ-assistant-ko-307` | `constraint/negated` [인터넷] | `constraint/affirmed` |
| `succ-assistant-en-403` | `identity/negated` [french, first language] | `identity/negated` (라벨 일치, 토큰 불일치 — 답을 프랑스어로 씀) |
| `succ-assistant-en-404` | `preference/negated` [squeamish, numbers] | `formatting/affirmed` |
| `succ-assistant-en-405` | `identity/negated` [head office, based] | `identity/affirmed` |
| `succ-assistant-en-406` | `occupation/negated`, `explanation_depth/negated` | `expertise/affirmed`, `constraint/affirmed` |
| `succ-assistant-en-401` | `constraint/negated` [licence] | `constraint/affirmed` |
| `succ-assistant-ko-403` | `preference/negated` [커피, 마시] | `preference/affirmed` |
| `succ-assistant-ko-405` | `occupation/negated`, `explanation_depth/negated` | `explanation_depth/affirmed` |

**이 9건은 이 슬라이스에서 판정하지 않습니다.** §5 판단 2(polarity)와 4
(`factValueAll`)에 속하며, 섞으면 두 판단이 서로의 근거가 됩니다.
`succ-assistant-en-403`은 특히 4번 쪽입니다 — 라벨은 맞고 모델이 답을
프랑스어로 써서 영어 토큰 `first language`가 문장에 없습니다.

## 3. 경계 22건 전수 판정 — prompt 위반 17 / gold 수정 5

`succ-assistant-ko-23`은 후보를 둘 냈고 둘의 판정이 다릅니다 — 철회를 부정형으로
바꾼 `a`는 위반, 비공개 선호 `b`는 gold 수정입니다.

### 3.1 prompt 경계 위반 — 17건

| # | case | 화자·turn | 모델이 저장한 것 | 기준 |
|---:|---|---|---|:--:|
| 1 | `succ-assistant-ko-3` | user t2 | `identity/negated` 부산에 살지 않음 | **A** |
| 2 | `succ-assistant-en-3` | user t2 | `identity/negated` Toronto에 살지 않음 | **A** |
| 3 | `succ-assistant-ko-23`a | user t2 | `identity/negated` 강서구에 살지 않음 | **A** |
| 4 | `succ-assistant-ko-19` | user t2 | `occupation/negated` 사무직 아님 | **B** |
| 5 | `succ-assistant-ko-316` | user t2 | `occupation/negated` 업계 종사자 아님 | **B** |
| 6 | `succ-assistant-ko-15` | user t2 | `occupation/affirmed` 회사 다님 | **C** |
| 7 | `succ-assistant-ko-53` | user t2 | `occupation/affirmed` 회사 다님 | **C** |
| 8 | `succ-assistant-ko-12` | user t0 | `relationship/affirmed` 동생 있음 | **D** |
| 9 | `succ-assistant-ko-107` | user t0 | `relationship/affirmed` 어머니 있음 | **D** |
| 10 | `succ-assistant-en-12` | user t0 | `relationship/affirmed` 어머니 있음 | **D** |
| 11 | `succ-assistant-en-14` | user t0 | `relationship/affirmed` 조카 있음 | **D** |
| 12 | `succ-assistant-en-51` | user t0 | `relationship/affirmed` 어머니 있음 | **D** |
| 13 | `succ-assistant-en-52` | user t0 | `relationship/affirmed` 개가 있음 | **D** |
| 14 | `succ-assistant-en-68` | user t0 | `relationship/affirmed` 형제 있음 | **D** |
| 15 | `succ-assistant-en-76` | user t0 | `relationship/affirmed` 사촌 있음 | **D** |
| 16 | `succ-assistant-en-87` | user t0 | `relationship/affirmed` 아버지 있음 | **D** |
| 17 | `succ-assistant-en-314` | user t0 | `relationship/affirmed` 아버지 있음 | **D** |

A 3건, B 2건, C 2건, D 10건. **이 17건의 no-gold 라벨은 유지되고, v6의 채택은
prompt 경계 미준수로 분류합니다.**

`en-12`와 `en-314`는 제3자 **건강** 문맥입니다(골다공증·와파린). D 기준대로
관계는 저장하지 않고, 사용자에게 적용되는 제약이 독립 확인될 때만 최소화된
사용자 중심 제약으로 민감 검토 대상이 됩니다.

### 3.2 gold 수정 — 5건

기존 no-gold가 결함이며, 새 datasetVersion에서 아래 gold를 갖습니다.

| case | 사용자가 확정한 것 | 새 gold |
|---|---|---|
| `succ-assistant-ko-23`b | 집 주소는 말하고 싶지 않습니다 | `preference/affirmed` |
| `succ-assistant-en-311` | I'd rather not give my own location | `preference/affirmed` |
| `succ-assistant-en-92` | 마흔은 오타, 서른입니다 | `identity/affirmed` |
| `succ-assistant-en-10` | 경쟁 수영으로 돌아가지 않습니다 | `decision/affirmed` |
| `succ-assistant-en-27` | 자녀가 없습니다 (음성 인식 오류 정정) | `relationship/negated` |

**앞의 둘에는 statement 제한이 붙습니다** — 실제 주소·도시·위치 값을 포함하거나
추론하거나 좁히지 않아야 합니다. "위치를 밝히고 싶어 하지 않는다"는 되고,
감춘 값을 되풀이하는 문장은 이 gold를 만족하지 않습니다. gold 작성 시
`factValueAll`이 그 값을 요구하지 않도록 해야 합니다.

**초안이 `en-27`을 위반으로 분류한 것은 오류였습니다.** assistant의 추측을
부정한 것으로 읽었으나, 실제로는 음성 인식이 만든 문장을 사용자가 자기 사실로
정정한 자리이고 "자녀가 없다"는 독립적으로 재사용 가능한 지속 사실입니다.
기준 B가 허용하는 쪽입니다.

### 3.3 집계

| | 건수 |
|---|---:|
| prompt 경계 위반 | **17** |
| gold 수정 | **5** |
| 판단 2·4로 분리 유지(§2) | **9** |
| 합계 | **31** |

## 4. B+ 이동 집합 — 10건 (확정)

B+ 계약(`.github/audits/memory-eval-gold-contract-2026-08-27.md` 12.1)은
**규칙을 만들거나 수정·선택하는 데 쓰인 사례를 이동**시키고, 이미 동결된 규칙을
적용만 한 사례는 유지합니다.

### 4.1 규칙 형성에 쓰인 6건

| case | 어디에 노출됐는가 | 만든 갈래 |
|---|---|---|
| `succ-assistant-ko-3` | 진단 감사 §2 인용 블록 | **A** 철회 |
| `succ-assistant-ko-15` | 진단 감사 §2 인용 블록 | **C** 가정 |
| `succ-assistant-ko-12` | 진단 감사 §2, 2026-08-29 사실관계 정정에서 전문 검토 | **D** 제3자 |
| `succ-assistant-ko-19` | 진단 report 표본 출력 | **B** 정정 |
| `succ-assistant-ko-23` | 결정 직전 표본 덤프 | **A**, 그리고 §1.1이 좁힌 A의 범위 |
| `succ-assistant-ko-53` | 결정 직전 표본 덤프 | **C** 가정 |

### 4.2 이번 판정으로 gold·규칙 범위가 정해진 4건

| case | 무엇을 정했는가 |
|---|---|
| `succ-assistant-en-311` | 철회 발화 안의 비공개 선호를 추출 대상으로 만들고, statement 제한을 만들었습니다 |
| `succ-assistant-en-92` | 정정이 대체 사실을 낳을 때 추출한다는 B의 후반부를 확정했습니다 |
| `succ-assistant-en-10` | 네 기준 밖의 단순 자기 진술도 gold 대상임을 확정했습니다 |
| `succ-assistant-en-27` | B의 "폐기 명제 제거 + 대체 사실 추출" 분리를 확정했습니다 |

**합계 10건이 B+ 이동 대상입니다.** 나머지 12건 — D 계열 en 사례들과 `ko-107`,
`ko-316`, `en-3` — 은 **승인된 기준을 적용한 것**이므로 이동하지 않습니다.

이동이 실행될 때 succ-5는 동결본이므로 **새 datasetVersion**을 작성하고, 이동한
사례는 regression corpus에 보존하며 provenance에 규칙 ID와 이동 사유를 적습니다.
gold가 바뀌는 5건은 `.github/audits/memory-eval-gold-contract-2026-08-27.md`
12.2대로 **수정된 형태로** 보존합니다.

**decision set에는 10건 전부에 대해 1:1 대체를 씁니다** — 5건이 아닙니다.
빠지는 자리와 대체 계획은 §5.2에 있습니다.

## 5. v7 문안 초안 (승인 전)

`mem-extract-v6`의 `MEMORY_EXTRACTION_POLARITY_RULE` 옆에 놓일 **경계 규칙**
초안입니다. 아직 구현하지 않았고 `mem-extract-v7`을 만들지도 않았습니다.

초안은 세 번에 걸쳐 좁혀졌고, 세 번 모두 **억제가 너무 넓다**는 같은 결함이었습니다.

1. 첫 초안이 `corrects something they said` 전체를 `Produce no candidate at
   all`로 묶어 `en-92`처럼 정정이 낳은 새 사실까지 버렸습니다. 억제 범위를
   철회와 정정으로 나눴습니다.
2. 정정 문단의 예시가 `"I'm not an office worker" corrects a guess and
   establishes nothing to store`였는데, 이것은 **부정형 정정 전체를 배제하는
   것으로 읽혀** `en-27`과 충돌합니다. 판정 기준은 부정형인지가 아니라
   **독립적으로 재사용 가능한 사실을 더했는지**입니다.
3. 가정 문단의 `neither is the present-tense explanation that resolves it`이
   현재형 진술 전체로 일반화될 수 있었습니다. 조건을 **가정을 닫기만 하고
   독립적 효용이 없을 때**로 명시했습니다.

```
BOUNDARY: some things a user says are not memories.

An explicit request not to remember a fact suppresses candidates about that
fact. It does not suppress a separate privacy preference or another
independently asserted fact in the same turn. "I moved away and I don't want
that remembered" leaves no memory that they no longer live there: the request
removes the subject, it does not replace it with its negation.

A correction removes the discarded proposition. When the user clearly supplies
a durable replacement fact, that replacement may be extracted. A correction that
only rejects a guess and adds no independently reusable fact yields no
candidate. A durable replacement may be affirmative or negated: "Voice typing
wrote that I have three children; I have none" establishes a negated
relationship fact.

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

### 5.1 이 문안이 §3의 22건에 대해 내는 답

| 형태 | 문단 | 결과 |
|---|---|---|
| `ko-3`·`en-3`·`ko-23`a 철회 | 1문단 | 후보 없음 — 부정형 변환 금지 |
| `ko-23`b·`en-311` 비공개 선호 | 1문단 후반 + 3문단 | 추출 허용, 감춘 값 반복 금지 |
| `ko-19`·`ko-316` 정정 — 추측을 거부만 함 | 2문단 | 후보 없음 |
| `en-92` 정정 — 긍정형 대체 사실 | 2문단 | 추출 허용 |
| `en-27` 정정 — **부정형** 대체 사실 | 2문단 | 추출 허용 |
| `ko-15`·`ko-53` 가정 | 4문단 | 후보 없음 |
| D 계열 10건 | 5문단 | 후보 없음 |
| `en-10` 단순 자기 진술 | (해당 없음) | 어느 억제에도 걸리지 않으므로 추출 |

`en-10`이 어느 문단에도 걸리지 않는 것이 의도입니다 — 경계 규칙은 **억제
목록**이고, 억제되지 않는 자기 진술은 원래의 추출 규칙이 다룹니다.

`ko-19`와 `en-27`이 갈리는 자리가 이 문안이 제대로 서 있는지를 보는 곳입니다.
둘 다 사용자가 **부정형**으로 말했고, 갈리는 것은 polarity가 아니라 **독립적으로
재사용 가능한 사실을 더했는가**입니다 — "저 사무직 아닌데요"는 추측을 거부할 뿐
사용자가 무엇인지 말하지 않고, "자녀가 없다"는 그 자체로 나중에 다시 쓸 수 있는
사실입니다.

### 5.2 구현 순서

문안은 위 세 번의 좁힘을 거쳐 **구현 입력으로 확정 가능한 상태**입니다
(@mposition, 2026-08-30). 다만 `mem-extract-v7` 구현은 **§4의 B+ 이동과 새
datasetVersion 작성이 함께 계획된 뒤**에 합니다. prompt만 먼저 올리면 평가할
dataset이 없고, 이동 대상 10건이 decision set에 남은 채로 새 prompt를 재면 그
회차는 **자기가 만든 규칙 위에서 측정한 것**이 됩니다.

**대체는 10건 전부입니다, gold 수정 5건이 아니라.** B+로 decision set에서
빠지는 것은 10건이고, 그만큼을 새로 쓰지 않으면 cell floor와 총 1,150건이
깨집니다. 빠지는 자리는 한 category에 몰려 있습니다.

| cell | 현재 | 빠짐 | 대체 없이 두면 | §12.2 하한 |
|---|---:|---:|---:|---:|
| `assistant_only:ko` | 125 | **6** | 119 | 125 |
| `assistant_only:en` | 125 | **4** | 121 | 125 |

> 새 datasetVersion 계획·작성 — B+ 원본 10건을 regression corpus로 격리하고,
> 동일 cell에 신규 decision case 10건을 1:1로 작성·검수·동결합니다. 이 중 gold
> 결함 5건은 승인된 수정 label로 regression에 보존하고, 나머지 5건은 기존
> label을 유지합니다. 전건에 provenance와 `replacementId`를 기록합니다.

즉 regression에 보존되는 형태가 둘로 나뉩니다 — `ko-23`b·`en-311`·`en-92`·
`en-10`·`en-27`은 §1.1이 승인한 **수정된 label**로, `ko-3`·`ko-19`·`ko-15`·
`ko-53`·`ko-12`·`ko-23`a는 **기존 label 그대로**입니다. 앞의 다섯은 gold가
틀렸던 사례이고 뒤의 여섯은 gold가 맞았는데 규칙 형성에 쓰인 사례이므로,
같은 이유로 이동하지만 보존 형태가 같지 않습니다.

### 5.3 전체 순서

1. **원본 10건 격리 + 신규 대체 10건 작성** — 같은 cell에 1:1
   (`assistant_only:ko` 6, `assistant_only:en` 4).
2. **cell floor · provenance · decision/regression 격리 검사.**
3. **사람 검수 및 새 datasetVersion 동결.**
4. **`mem-extract-v7` 구현 · digest 고정.**
5. **새 pair 등록 — 처음에는 예산 없음.**
6. **별도 예산 승인 후 유료 실행.**

**5번과 6번은 이 문서의 승인 범위 밖입니다.** pair 승인, 예산, release gate,
flag 활성화 어느 것도 여기서 승인되지 않았습니다 — 승인된 것은 문안과 이
순서뿐입니다.

## 6. 이 문서가 바꾸지 않은 것

`mem-eval-succ-5`·`mem-extract-v6` 동결 유지. `mem-extract-v7` 미생성. 새
datasetVersion 미작성 — §4의 이동은 계획이고 실행이 아닙니다. pair 승인,
release gate, MEMORY-02·03, evaluation 승인 필드, feature flag 미변경. 유료 실행
없음 — 모든 숫자는 이미 지불된 run1 artifact에서 나옵니다. 진단 감사 §5의
polarity·kind·`factValueAll` 판단은 이 문서에서 다루지 않습니다.
