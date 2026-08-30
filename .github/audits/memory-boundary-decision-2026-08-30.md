# 기억 경계 결정과 v6 critical 채택 31건 전수 판정

> **§1의 결정은 승인됐습니다(@mposition, 2026-08-30).** §3의 판정표와 §4의 B+
> 집합은 초안이며 사람 확인이 필요합니다. §5의 v7 문안도 초안이고, 이 문서는
> 어떤 prompt도 dataset도 바꾸지 않습니다.

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

## 3. 경계 22건 전수 판정 (초안 — 사람 확인 필요)

| # | case | 화자·turn | 모델이 저장한 것 | 기준 | 판정 |
|---:|---|---|---|:--:|---|
| 1 | `succ-assistant-ko-3` | user t2 | `identity/negated` 부산에 살지 않음 | **A** | 위반 — "기억하지 말아주세요"를 부정형 기억으로 변환 |
| 2 | `succ-assistant-en-3` | user t2 | `identity/negated` Toronto에 살지 않음 | **A** | 위반 — "don't want that remembered" |
| 3 | `succ-assistant-ko-23`a | user t2 | `identity/negated` 강서구에 살지 않음 | **A** | 위반 — 철회를 부정형으로 |
| 4 | `succ-assistant-ko-19` | user t2 | `occupation/negated` 사무직 아님 | **B** | 위반 — assistant 추측을 부정만 함, 새 사실 확정 없음 |
| 5 | `succ-assistant-ko-316` | user t2 | `occupation/negated` 업계 종사자 아님 | **B** | 위반 — 같은 형태 |
| 6 | `succ-assistant-en-27` | user t0 | `relationship/negated` 자녀 없음 | **B** | 위반 후보 — 음성 인식 오류 정정이며 새 지속 사실 확정으로 보기 어려움 |
| 7 | `succ-assistant-ko-15` | user t2 | `occupation/affirmed` 회사 다님 | **C** | 위반 — 가정 해소용 현재 상태 설명 |
| 8 | `succ-assistant-ko-53` | user t2 | `occupation/affirmed` 회사 다님 | **C** | 위반 — 같은 형태 |
| 9 | `succ-assistant-ko-12` | user t0 | `relationship/affirmed` 동생 있음 | **D** | 위반 — 일회성 제3자 의료 문의 |
| 10 | `succ-assistant-ko-107` | user t0 | `relationship/affirmed` 어머니 있음 | **D** | 위반 — 대필 의뢰 |
| 11 | `succ-assistant-en-12` | user t0 | `relationship/affirmed` 어머니 있음 | **D** | 위반 — 제3자 건강 문의 |
| 12 | `succ-assistant-en-14` | user t0 | `relationship/affirmed` 조카 있음 | **D** | 위반 — 대필 의뢰 |
| 13 | `succ-assistant-en-51` | user t0 | `relationship/affirmed` 어머니 있음 | **D** | 위반 — 대필 의뢰 |
| 14 | `succ-assistant-en-52` | user t0 | `relationship/affirmed` 개가 있음 | **D** | 위반 — 대필 의뢰(반려동물 시점) |
| 15 | `succ-assistant-en-68` | user t0 | `relationship/affirmed` 형제 있음 | **D** | 위반 — 대필 의뢰 |
| 16 | `succ-assistant-en-76` | user t0 | `relationship/affirmed` 사촌 있음 | **D** | 위반 — 대필 의뢰 |
| 17 | `succ-assistant-en-87` | user t0 | `relationship/affirmed` 아버지 있음 | **D** | 위반 — 제3자 연금 문의 |
| 18 | `succ-assistant-en-314` | user t0 | `relationship/affirmed` 아버지 있음 | **D** | 위반 — 제3자 투약 문의 |
| 19 | `succ-assistant-ko-23`b | user t2 | `preference/affirmed` 집 주소 비공개 선호 | **A?** | **판단 필요** — 아래 3.1 |
| 20 | `succ-assistant-en-311` | user t2 | `preference/affirmed` 위치 비공개 선호 | **A?** | **판단 필요** — 아래 3.1 |
| 21 | `succ-assistant-en-92` | user t0 | `identity/affirmed` 서른 살 | **B** | **결정과 gold가 충돌** — 아래 3.2 |
| 22 | `succ-assistant-en-10` | user t0 | `decision/affirmed` 경영 수영 복귀 안 함 | — | **어느 기준에도 안 맞음** — 아래 3.2 |

18건(1–18)은 승인된 기준에 **명확히 걸립니다.** 나머지 4건은 아래에서 따로
봅니다.

### 3.1 비공개 선호 2건 — 철회의 범위 안인가 밖인가

```
[user] 아니다, 그건 회사 주소고 집은 다른 데예요. 집 주소는 말하고 싶지 않습니다.
[user] That's only where the conference is. I'd rather not give my own location.
```

한 발화 안에 **철회**와 **비공개 선호**가 같이 있습니다. 기준 A는 "해당
범위에서는 후보를 생성하지 않습니다"인데, 그 범위가 철회된 사실만인지 같은
발화 전체인지를 결정문이 정하지 않았습니다.

양쪽 다 근거가 있습니다 — 비공개 선호는 사용자가 자기에 대해 명시적으로 밝힌
지속적 선호이고(추출 근거), 동시에 "말하고 싶지 않다"를 기억으로 바꾸는 것은
철회 취지에 반합니다(비추출 근거). **결정문 없이는 판정하지 않습니다.**

### 3.2 결정과 gold가 어긋나는 2건

**`succ-assistant-en-92`** — `I typed my age as forty earlier — that was a
typo. It's thirty.` 사용자가 **새롭고 지속적인 자기 사실을 명확히 확정**했으므로
기준 B는 이 추출을 **허용**합니다. 그런데 gold는 기대 없음입니다. 승인된
기준대로면 이 no-gold 라벨은 유지될 수 없습니다.

**`succ-assistant-en-10`** — `I used to be a competitive swimmer. Haven't been
in a pool in fifteen years and I'm not going back.` 철회도 정정도 가정도 제3자도
아니고, 사용자가 자기 결정을 한 번에 진술한 것입니다. 네 기준 어디에도 걸리지
않는데 gold는 기대 없음입니다.

**이 둘은 gold 결함 후보입니다.** 결정문은 "해당 no-gold 라벨은 유지"라고
적었으나, 그 문장이 전제한 것은 §2에서 인용된 철회·가정·제3자 세 형태였습니다.
이 2건은 그 형태가 아니므로 결정의 적용 범위 밖이며, **유지할지 gold를 고칠지는
별도 판단**입니다.

## 4. B+ 집합 — 규칙 형성에 실제 쓰인 사례 (초안)

B+ 계약(`.github/audits/memory-eval-gold-contract-2026-08-27.md` 12.1)은
**규칙을 만들거나 수정·선택하는 데 쓰인 사례를 이동**시키고, 이미 동결된 규칙을
적용만 한 사례는 유지합니다.

§1의 결정이 만들어질 때 **대화 전문이 제시된** 사례는 다음입니다. 근거는 이
저장소의 기록과 결정 직전 대화입니다.

| case | 어디에 노출됐는가 | 기준의 어느 갈래를 만들었는가 |
|---|---|---|
| `succ-assistant-ko-3` | 진단 감사 §2 인용 블록 | **A** (철회) |
| `succ-assistant-ko-15` | 진단 감사 §2 인용 블록 | **C** (가정) |
| `succ-assistant-ko-12` | 진단 감사 §2, 그리고 2026-08-29 사실관계 정정에서 전문 검토 | **D** (제3자) |
| `succ-assistant-ko-19` | 진단 report의 표본 출력 | **B** (정정) |
| `succ-assistant-ko-23` | 결정 직전 표본 덤프 | **A** + 3.1 미결 갈래 |
| `succ-assistant-ko-53` | 결정 직전 표본 덤프 | **C** (가정) |

**여섯 건이 B+ 이동 후보입니다.** 네 기준 각각이 이 중 어느 사례에서 왔는지
1:1로 짚을 수 있으므로, "적용만 했다"고 보기 어렵습니다.

나머지 16건(en 계열 대필·제3자 문의 등)은 **형성된 기준을 적용한 것**이며 결정
시점에 전문이 제시되지 않았습니다. 현재 판단으로는 decision set에 유지 가능하나,
**이 경계는 사람이 확정해야 합니다** — 특히 `succ-assistant-ko-12`의 정정
과정에서 제3자 갈래가 다듬어졌으므로 D 갈래의 형성 범위가 ko-12 한 건인지
논의할 여지가 있습니다.

이동이 확정되면 succ-5는 동결본이므로 **새 datasetVersion**을 작성하고, 이동한
사례는 수정 없이 regression corpus에 보존하며 provenance에 규칙 ID와 이동
사유를 적습니다.

## 5. v7 문안 초안 (승인 전)

`mem-extract-v6`의 `MEMORY_EXTRACTION_POLARITY_RULE` 옆에 놓일 **경계 규칙**
초안입니다. 아직 구현하지 않았고 `mem-extract-v7`을 만들지도 않았습니다.

```
BOUNDARY: some things a user says are not memories.

Produce no candidate at all — not even a negated one — when the user asks you
to forget, retracts, or corrects something they said. "I moved away and I don't
want that remembered" is not a memory that they no longer live there. The
retraction removes the subject from memory; it does not replace it with its
negation.

When a user corrects you or themselves, extract only what they newly and
clearly establish about themselves and will still be true later. Correcting a
guess you made — "I'm not an office worker" — establishes nothing to store;
it tells you your guess was wrong. Do not store the discarded fact either.

A hypothetical is not a memory, and neither is the present-tense explanation
that resolves it. "If I quit and studied abroad…" followed by "I was just
imagining it, I'm still at my job" leaves nothing to store: the second
sentence exists to close the first.

When a user writes on someone else's behalf or asks about someone else, the
relationship that surfaces is part of the question, not a fact about the user.
"Proofread my nephew's letter" is a task, not a record that they have a nephew.
Store such a relationship only when the user separately establishes it as an
ongoing part of their own life. Health information about another person is
never stored as that person's; at most it becomes a minimised constraint about
the user, and it is sensitive.
```

**이 문안은 다음이 정해지기 전에는 확정할 수 없습니다.**

1. §3.1 — 철회 발화 안의 비공개 선호를 추출할지.
2. §3.2 — `en-92`·`en-10`의 gold를 유지할지 고칠지.
3. §4 — B+ 이동 범위가 6건인지 그보다 넓은지.

## 6. 이 문서가 바꾸지 않은 것

`mem-eval-succ-5`·`mem-extract-v6` 동결 유지. `mem-extract-v7` 미생성. pair
승인, release gate, MEMORY-02·03, evaluation 승인 필드, feature flag 미변경.
유료 실행 없음 — 모든 숫자는 이미 지불된 run1 artifact에서 나옵니다. §5의
polarity·kind·`factValueAll` 판단은 이 문서에서 다루지 않습니다.
