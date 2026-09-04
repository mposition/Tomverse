# `mem-extract-v8` 구현 기록

**상태: 구현 완료 (2026-09-04).** pair 등록·승인, 예산, 유료 실행, release gate,
두 feature flag는 **포함하지 않습니다.**

- 승인: `mem-extract-v8` 구현 — EN/KO 완결형 negated 예시 추가, prompt
  version·digest 고정, parser·evidence·오염 방지 테스트, 이 기록
- 승인이 명시적으로 제외한 것: pair 등록·승인, 예산, 유료 실행, release gate,
  `memoryExtractionEnabled`·`memoryInjectionEnabled`
- 기준: 동결된 `mem-eval-succ-8`(2026-09-04 서명), `mem-score-v3.5`

**prompt digest: `bb54b6a69fcfb26e7424accb6142256b946130d8b87c8e68e230c80d4c8531f2`**

## 1. 추가된 문안

`MEMORY_EXTRACTION_NEGATED_EXAMPLES`. polarity 규칙 **다음에** 놓이며, 규칙
자체는 건드리지 않았습니다(§2).

```
Two complete examples of a negated candidate, one in each language, because
`negated` is the half of this field that goes wrong. Each shows the whole unit:
the span you cite, the statement you write from it, and the polarity that
follows from that statement.

The user wrote "I gave kitesurfing a proper go for two summers and it never
clicked, so I stopped." The statement is "The user no longer does kitesurfing",
and the polarity is negated, because that statement asserts something is not so
of them. It is negated for what the statement claims, not because the evidence
happens to contain "never".

The same shape in Korean, where the statement is written in the language of the
evidence you cited. The user wrote "드론은 자격증까지 땄는데 결국 손을
뗐습니다." The statement is "사용자는 더 이상 드론을 하지 않습니다", and the
polarity is negated.
```

**완결형인 이유.** 인용할 span, 그로부터 쓰는 statement, 거기서 따라오는
polarity — 셋을 한 단위로 보여 줍니다. 조각만 주면 모델이 셋 중 무엇을 틀렸는지
드러나지 않습니다.

**KO 예시가 번역이 아닌 이유.** 두 번째 예시는 "진술은 인용한 근거의 언어로
쓴다"는 기존 규칙을 negated case 위에서 보여 줍니다. 영어 예시를 옮긴 것이라면
그 값은 없습니다.

**kind를 적지 않은 이유.** 예시의 주제는 polarity입니다. kind를 적으면
`KIND_GUIDE`의 판정과 겹치고, 동결된 case의 답을 가르칠 위험이 다시 생깁니다.

## 2. 바꾸지 않은 것

`MEMORY_EXTRACTION_POLARITY_RULE`은 **byte 단위로 v7과 같습니다.**

```
polarity rule digest  6351bec6f5892552882aaf43dbe8fa0797d47b9b42753b2539d1ed31cf8ed23e
```

v7 트리(`0209776d`)에서 같은 상수를 읽어 대조했고 `===`로 동일했습니다. 예시를
규칙 안에 끼워 넣지 않고 **별도 상수**로 둔 이유가 이것입니다 — 규칙이 안
바뀌었다는 말을 사람이 diff로 확인하는 대신 테스트가 말할 수 있게 됩니다
(`tests/memoryExtractionPromptExamples.test.mjs`).

scorer 기준(`MEMORY_EVAL_SCORING_RULES`, `scoreCaseV3`)은 손대지 않았습니다.
`mem-score-v3.5` descriptor digest는 `2d4bcb69…` 그대로입니다.

## 3. 오염 — 왜 `낚시`가 아니라 `드론`인가

**예시는 모델이 입력보다 먼저 읽는 텍스트입니다.** 규칙은 판정하는 법을 적지만
예시는 이미 판정된 사례를 건네므로, 그 사례가 채점 대상 dataset에서 왔다면
모델에게 답을 준 것이 됩니다. eval은 그때부터 prompt가 자기 예시를 얼마나 잘
기억하는지를 재게 됩니다.

이 위험은 가상이 아닙니다. 동결된 `mem-eval-succ-8`에 **이 규칙이 가장 어려워
하는 바로 그 사실** — 해 보다 그만둔 취미 — 이 있고 gold token이 `낚시`입니다.
한국어 negated 예시를 쓸 때 누구나 처음 떠올리는 소재이고, 그대로 썼다면
`succ-durable-ko-*`는 무엇의 증거도 되지 못했을 것입니다.

그래서 소재는 그럴듯함이 아니라 **검사**로 골랐습니다.

| 후보 | 결과 |
| --- | --- |
| `낚시` | **corpus에 있음** — 사용 불가 |
| `spreadsheet` | corpus에 있음 |
| `드론` | 없음 — 채택 |
| `kitesurfing` | 없음 — 채택 |

검사 범위는 `mem-eval-succ-4`~`succ-8`의 모든 conversation title·message
content·`factValueAll`·`factValueAny`·`evidenceQuote`와 succ-7 regression
corpus입니다(847,682자).

## 4. 테스트

`tests/memoryExtractionPromptExamples.test.mjs` (신규, 10건)

- **규칙 불변**: polarity 규칙의 digest가 v7 값과 같고, 예시가 규칙 안으로
  접혀 들어가지 않았다
- **문안**: EN/KO 두 예시가 prompt에 도달하고, 각각 negated라고 적혀 있으며,
  "negation word가 결정하지 않는다"를 예시가 다시 말한다
- **위치**: 예시는 system prompt에 있고 content fence **밖**에 있다 — fence
  안이면 prompt가 스스로 "설명하라"고 지시한 내용이 됩니다
- **citation**: 예시에 label 모양 토큰이 없어, 존재하지 않는 label을 인용할
  거리가 없다
- **오염**: 등록된 term이 어떤 corpus에도 없다. corpus 길이 하한을 함께
  단언해, 빈 haystack이 통과하지 않습니다
- **red-before-green**: 같은 검사가 `낚시`는 잡는다
- **역방향**: 등록됐지만 prompt에 없는 term은 실패(죽은 항목 방지)
- **일반형**: 예시 안의 한글 content word가 등록되지 않은 채 들어올 수 없다.
  허용 목록은 조사·서술 어휘뿐이며, 명사는 등록해야 하므로 검사를 받습니다.
  **이것이 `낚시`가 조용히 들어올 수 있었던 경로를 막는 절반입니다.**

기존 파일 갱신: prompt digest 표(`memoryExtractionPromptFingerprint`), 버전
단언(`memoryExtractionPromptRules`), rule 구현 표
(`memoryEvalPromptRuleImplementations` — v8이 같은 규칙을 다시 주장).

## 5. smoke 경로를 막고 있던 것

버전을 올리자 **smoke run까지 실패**했습니다. harness가 mode를 정하기 **전에**
register entry를 요구하고 있었기 때문입니다.

```
No register entry for gpt-5-6-luna::mem-extract-v8.
```

`decideEvalRunMode()`는 `live`가 아니면 register를 보기도 전에 `smoke`를
반환하고, live인데 entry가 없으면 `unknown_pair`로 거절합니다. 즉 이 이른 종료는
**live 경로에는 아무것도 더하지 않으면서 smoke 경로를 같이 죽이고 있었습니다.**
smoke run은 provider에 닿지 않고 한 푼도 쓰지 않으므로, 거절해서 지키는 예산이
없습니다.

그래서 이른 종료를 `live`일 때로 좁혔습니다. 메시지는 고칠 파일 이름을 대므로
`unknown_pair`보다 낫고, 그래서 남겼습니다. 요약 출력의
`registerEntry.evalBudget` 접근도 optional로 바꿨습니다 — 같은 이유로 smoke run
끝에서 터지고 있었습니다.

**이것은 pair 등록이 아닙니다.** register는 비어 있고, live 실행은 여전히
`unknown_pair`로 거절됩니다. 승인 범위에서 pair 등록이 빠져 있었기 때문에
harness를 쓸 수 있게 만드는 방법이 이쪽이었습니다.

## 6. 버전 bump가 강제한 테스트 수정

| 테스트 | 무엇이 바뀌었나 |
| --- | --- |
| `memoryEvalBudgetBinding` — v7 instrument | 이제 tuple의 **모든** field가 v7과 다릅니다. prompt까지 움직였으므로 같다고 단언할 항목이 남지 않았고, 그 자체가 "v7 승인은 이 트리의 어떤 부분도 설명하지 않는다"는 진술입니다 |
| `memoryEvalSchema3DryRun` — 배포 pair | `pair`가 없을 수 있게 하고 `unknown_pair`를 단언합니다. entry가 있어야 한다고 요구하면, 이 테스트가 지키려는 상태(등록 안 됨) 자체가 실패가 됩니다 |
| `memoryExtractionEvalBoundary`, `memoryEvalDevelopmentProbe` | 거절 메시지 목록에 `No register entry` 추가. 두 테스트 모두 주석에 "어느 gate가 먼저 말하는지는 register의 사정"이라고 이미 적혀 있고, 버전 bump마다 옮겨 온 자리입니다 |
| smoke 헤더 | `mem-extract-v7` → `mem-extract-v8` |

## 7. 이번 승인 밖 — 다음 단계

- **pair 등록**: `gpt-5-6-luna::mem-extract-v8` entry가 없습니다. 없는 동안
  live 실행은 `unknown_pair`로 거절됩니다.
- **예산·유료 실행**: 등록 후에도 승인된 eval budget, 깨끗한 named commit,
  쓰이지 않은 run ordinal이 각각 따로 필요합니다.
- **release gate**, **`memoryExtractionEnabled`·`memoryInjectionEnabled`**:
  변경 없음.
- **§4.14 부분 문자열 잔여**: matcher 차원의 열린 질문으로 그대로입니다.
