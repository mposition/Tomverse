# `mem-extract-v8` 구현 기록

**상태: 구현 완료 (2026-09-04).** pair 등록·승인, 예산, 유료 실행, release gate,
두 feature flag는 **포함하지 않습니다.**

- 승인: `mem-extract-v8` 구현 — EN/KO 완결형 negated 예시 추가, prompt
  version·digest 고정, parser·evidence·오염 방지 테스트, 이 기록
- 승인이 명시적으로 제외한 것: pair 등록·승인, 예산, 유료 실행, release gate,
  `memoryExtractionEnabled`·`memoryInjectionEnabled`
- 기준: 동결된 `mem-eval-succ-8`(2026-09-04 서명), `mem-score-v3.5`

**prompt digest: `a1d804c6b9359b722c60b1309c7324176f72c54008d2a616fa78dd520a6b44ae`**

## 1. 추가된 문안

`MEMORY_EXTRACTION_NEGATED_EXAMPLES`. polarity 규칙 **다음에** 놓이며, 규칙
자체는 건드리지 않았습니다(§2).

**완결형의 의미는 "완결된 구조화 출력"입니다.** 필수 7개 필드
(`kind`·`polarity`·`statement`·`confidence`·`sensitivity`·`expiresAt`·`evidence`)를
모두 갖춘 candidate 객체 그대로이고, evidence도 `messageLabel`·`quote` 구조를
그대로 씁니다.

```
A user message labelled m0: The registration form lists two dependants; I have no dependants.
{
  "candidates": [
    {
      "kind": "relationship",
      "polarity": "negated",
      "statement": "The user has no dependants",
      "confidence": 0.9,
      "sensitivity": "standard",
      "expiresAt": null,
      "evidence": [ { "messageLabel": "m0", "quote": "I have no dependants" } ]
    }
  ]
}

A user message labelled m0: 가입 서류에는 부양가족이 둘로 적혀 있는데, 저는 부양가족이 없습니다.
{
  "candidates": [
    {
      "kind": "relationship",
      "polarity": "negated",
      "statement": "사용자는 부양가족이 없습니다",
      "confidence": 0.9,
      "sensitivity": "standard",
      "expiresAt": null,
      "evidence": [ { "messageLabel": "m0", "quote": "저는 부양가족이 없습니다" } ]
    }
  ]
}
```

세 가지가 의도적입니다.

- **한 문장, 한 candidate.** 문장 수는 사실 수를 보장하지 않습니다 — 한 문장이 독립적으로 유용한 사실 둘을 담을 수 있습니다. 이것은 **필요조건**이고, 실제 사실이 하나라는 것은 검토된 판단입니다 — 세미콜론 앞 절은 서류를 설명할 뿐 사용자에 대한 사실이 아닙니다. `KIND_GUIDE`는 독립적으로 유용한 사실
  둘을 담은 문장은 candidate 둘을 낳는다고 말합니다. 초안은 두 문장·두 사실
  메시지에 candidate 하나를 보여, 둘째 사실을 버리라고 가르치고 있었습니다.
  완결하지 않은 "완결 출력 예시"는 없느니만 못합니다.
- **두 예시는 같은 kind.** 언어 외에는 다른 것이 없으므로 mapping 하나를 두 번
  가르치고, 그래서 분리되는 것이 "진술은 인용한 근거의 언어로 쓴다"는 규칙입니다.
- **quote는 메시지 전체가 아니라 그 안의 span**입니다.

## 2. 바꾸지 않은 것

`MEMORY_EXTRACTION_POLARITY_RULE`은 **byte 단위로 v7과 같습니다.**

```
polarity rule digest  6351bec6f5892552882aaf43dbe8fa0797d47b9b42753b2539d1ed31cf8ed23e
```

v7 트리(`0209776d`)에서 같은 상수를 읽어 `===`로 대조했습니다. 예시를 규칙 안에
끼워 넣지 않고 **별도 상수**로 둔 이유가 이것 — 규칙이 안 바뀌었다는 말을 사람이
diff로 확인하는 대신 테스트가 말할 수 있게 됩니다.

scorer 기준(`MEMORY_EVAL_SCORING_RULES`, `scoreCaseV3`)은 손대지 않았고
`mem-score-v3.5` descriptor digest는 `2d4bcb69…` 그대로입니다.

## 3. 오염과 분류 — 다섯 번 틀렸습니다

**예시는 모델이 입력보다 먼저 읽는 텍스트입니다.** 규칙은 판정하는 법을 적지만
예시는 이미 판정된 사례를 건네므로, 그 사례가 채점 대상 dataset에서 왔다면
모델에게 답을 준 것이 됩니다.

### 3.1 1차 — 어휘

동결된 `mem-eval-succ-8`에 이 규칙이 가장 어려워하는 사실(해 보다 그만둔 취미)이
있고 gold token이 `낚시`입니다. 한국어 negated 예시를 쓸 때 처음 떠올리는
소재입니다.

### 3.2 2차 — 구조. **문자열 검사가 통과시켰습니다**

소재를 `kitesurfing`·`드론`으로 바꿔 두 토큰 모두 corpus에 없음을 확인했는데,
**시나리오가 그대로였습니다** — 활동을 해 보다 그만둠.

| | kind / polarity |
| --- | --- |
| 1차 수정본 EN 예시 | decision / negated |
| `succ-durable-en-608` (philately) | **decision / negated** |
| 1차 수정본 KO 예시 | decision / negated |
| `succ-durable-ko-602` (낚시) | **decision / negated** |

두 case 모두 전환표의 **`polarity44` 대체본**입니다. 원래 44건을 B+로 퇴역시킨
목적이 이 규칙에 대한 독립 holdout 확보였는데, 예시가 그 대체본의 핵심 판정
방향을 되돌려 주고 있었습니다.

### 3.3 3차 — negated가 아니었고, 완결도 아니었습니다

cell로 고른 2차 수정본(EN `relationship`, KO `code_style`)은 세 가지가 틀렸습니다.

1. **KO 예시가 negated가 아니었습니다.** polarity 규칙은 두 문단 위에서
   "The user dislikes open-plan offices"를 **affirmed**라고 정합니다 — 싫어함이
   그 사람에게 성립하므로. 그런데 "의사코드로 받는 것을 원하지 않습니다"는
   바로 그 부정적 선호이므로 affirmed입니다. **예시가 바로 위 규칙과 반대를
   가르치고 있었습니다.** 답변 방식 kind는 전부 같은 함정입니다 — 그것들의
   자연스러운 부정은 모두 "무엇을 원하지 않는다"이기 때문입니다.
2. **완결 출력이 둘째 사실을 빠뜨렸습니다.** KO 메시지가 두 문장·두 사실
   (의사코드 금지, 바로 실행 가능)인데 candidate는 하나였습니다.
3. **EN과 KO의 kind가 갈라 진술 설계가 깨졌습니다.** 쌍이 mapping 하나를 두 번
   가르치는 것이 아니라 mapping 둘을 한 번씩 가르치게 돼, 언어 규칙을 분리해
   보여 주는 값이 사라졌습니다.

### 3.4 4차 — 빈 cell은 kind 판정의 근거가 아닙니다

3.3을 고치면서 `long_term_goal`을 골랐는데, 근거가 **"그 cell이 0건이다"**
하나였습니다. 그것은 안전 측정이지 분류 판정이 아닙니다. 승인된 prompt는
`long_term_goal`의 negated mapping을 **어디에도 적지 않았고**, 그런데도 예시가
그 mapping을 새 정책으로 도입하고 있었습니다. 게다가 "목표를 가지지 않음"은
`decision`과도 모호하고, `decision|negated`는 바로 퇴역된 holdout 형태입니다.

**예시가 승인되지 않은 분류 규칙을 도입하는 것이, 측정된 case 위에 앉는 것보다
나쁜 실패입니다.**

### 3.5 5차 — 이름 붙인 예외는 B+ 이동을 대신하지 못합니다

kind를 prompt에서 가져오고 나서, 남는 중복 1건을
`MEMORY_EXTRACTION_EXAMPLE_CELL_EXCEPTIONS`에 id로 적어 둔 판이 있었습니다.
**그것은 오염을 기록할 뿐 제거하지 않습니다.** 제거하는 확립된 수단은 B+
이동이고, succ-7이 v8 문안 선택에 쓰인 44건에 그여한 것이 바로 그것입니다.

그리고 **1건이 아니라 5건입니다.** kind를 고른 것은 개별 case가 아니라
`relationship` 1건 대 `expertise` 4건이라는 **집계 비교**였으므로, 진 쪽 4건도
그 결정의 일부입니다 — 진 쪽이 있어야 이긴 쪽이 선택이 됩니다.

| 이동 대상 gold | cell |
| --- | --- |
| `succ-assistant-ko-407#g1` | ko relationship/negated |
| `succ-assistant-en-603#g1` | en expertise/negated |
| `succ-assistant-en-608#g1` | en expertise/negated |
| `succ-durable-en-423#e1` | en expertise/negated |
| `succ-durable-ko-422#e2` | ko expertise/negated |

### 3.6 `mem-eval-succ-9`

위 5건을 regression으로 옮기고 1:1 대체한 successor입니다.

```
caseCount        1150  (succ-8과 같음 — 1:1)
datasetDigest    affb41e18e788db2265ad36bbefb1c4728954c67cdbba36ea7722acba7976ac2
manifestDigest   07edb04eaeccdfbaf5549545bed2e6597fcdfa99ef32df0e919b2264ff7d4e9f
transitionDigest 066bec67f99d21592f90d788f54fbbfcd7a4ef6c340a04975c2fc2f678f9b857
scoringContract  mem-score-v3.5  2d4bcb69…  (변경 없음)
frozen           false  — 서명 대기
```

| 퇴역 | 대체 | 소재 교체 |
| --- | --- | --- |
| succ-assistant-ko-407 | succ-assistant-ko-701 | 배우자 → 사촌 |
| succ-assistant-en-603 | succ-assistant-en-701 | bees → welding |
| succ-assistant-en-608 | succ-assistant-en-702 | houseplant → sourdough |
| succ-durable-en-423 | succ-durable-en-701 | code → soldering |
| succ-durable-ko-422 | succ-durable-ko-701 | 오픈워터·바다 → 백두대간·빙벽 |

- **경계는 그대로, 소재만 바뀝니다.** 같은 category·language·kind·polarity이며
  `succ9Problems()`가 네 가지를 전부 대조합니다. case가 틀려서 나가는 것이
  아니라 **선택에 쓰였기 때문에** 나가므로, 판단은 보존됩니다.
- **ko-422는 gold가 둘**이라 대체본도 둘을 집니다. affirmed 쪽을 버렸으면
  1:1이라고 보고하면서 case를 좀히는 것이 됩니다.
- **소재는 전부 corpus·prompt 대조를 거쳤습니다** — 사촌·welding·sourdough·
  soldering·백두대간·빙벽·야산 모두 succ-4~8, succ-7 regression, 배포된 prompt에
  없습니다.
- **succ-8은 손대지 않습니다.** 동결·서명된 역사본이고, 거기서 case를 빼면
  두 digest가 움직여 그 서명이 무효가 됩니다. 검사가 이것을 직접 단언합니다.
- **harness는 아직 succ-8입니다.** 서명 후에 옴기는 것이 순서이고, succ-9는
  이름으로 해석만 됩니다. 그동안 v8 예시는 live target(succ-8)과 겹치지만,
  pair가 등록되지 않아 유료 실행 자체가 `unknown_pair`로 거절됩니다.

## 4. 테스트

`tests/memoryExtractionPromptExamples.test.mjs` (신규, 18건)

**구조화 출력과 parser**

- 각 예시가 필수 7개 필드를 **정확히** 갖는다
- quote가 message의 span이고 전체가 아니다
- **실제 `parseExtractionOutput()`으로 파싱된다** — 진짜 label map을 만들고
  거기에 결속해 통과시팝니다
- **메시지가 한 문장이다** — 두 사실을 담은 메시지에 candidate 하나를 보이는
  불완전 예시를 구조적으로 막습니다. 사실을 세는 것은 기계적이지 않지만
  "한 문장에 candidate 하나"는 기계적입니다

**polarity가 진짜 negated인가**

- 예시의 kind가 **답변 방식 kind가 아니어야** 합니다. 그들의 부정은 부정적
  선호이고, polarity 규칙이 그것을 affirmed로 정하기 때문입니다. 문구를 읽는
  대신 kind를 열거합니다 — 초안을 속인 것이 바로 문구였습니다
- 규칙이 실제로 그렇게 말하는지도 단언해, 그 선례가 바뀌면 조용히 어긋나지
  않고 실패합니다
- **두 예시가 같은 kind**이고 언어만 다르다

**evidence — 복사되어도 안전한가**

- 예시는 `m0`를 인용하고, `toExtractionPromptInput()`은 1부터 번호를 매기므로
  `m0`는 만들어질 수 없습니다. 메시지 1·2·5·20개에 대해 확인합니다
- 예시를 **그대로 복사한 candidate는 parser가 버립니다**
- prompt가 "예시에서 본 label은 인용하지 말라"고 명시하는지도 확인

**오염**

- 등록 term이 어느 corpus에도 없다(대소문자 접기, NFC). corpus 길이 하한 포함
- **red-before-green 양방향**: `낚시`는 잡히고, `Philately`도 잡힙니다
- 등록됐지만 예시에 없는 term은 실패(죽은 항목)
- **양쪽 언어**에서, 예시 본문의 content word가 (1) 등록 term이 덮거나
  (2) 어느 corpus에도 없거나 (3) 검토된 allowlist에 있어야 합니다
- **kind 근거 검사**: 예시의 kind가 **prompt가 명시한 mapping**인지 확인합니다.
  boundary 규칙과 `KIND_GUIDE`의 문장을 직접 단언하므로, 그 문장이 사라지면
  예시가 mapping의 유일한 출처가 되는 대신 실패합니다
- **B+ 검사**: kind 선택에 쓰인 gold 5건이 succ-9의 채점 집합에서 **빠졌고**
  regression에 **보존됐는지**를 확인합니다. 이름 붙인 예외를 대신한 검사이며,
  기록하는 것과 제거하는 것은 다른 일입니다
- **succ-8 불변 검사**: 그 5건이 succ-8에는 그대로 있어야 합니다. 동결·서명된
  역사본이므로 편집은 서명을 무효로 만듭니다
- **holdout 검사**: 두 예시가 `polarity44` 대체본의 형태를 재현하지 않는다

**되돌려서 확인했습니다.**

| 되돌린 것 | 실패하는 검사 |
| --- | --- |
| kind → `long_term_goal` | kind 근거 검사 |
| kind → `code_style` | kind 근거, 같은 kind, 답변 방식 kind 금지 |
| 5건 중 하나를 succ-9에 남김 | B+ 검사 |
| KO 메시지 → 두 문장 | 한 문장 검사, 미등록 content word |

**이미 있던 gate도 걸렸습니다.** `tests/memoryEvalPromptDatasetSeparation.test.mjs`가
초안 문구의 `at the end of the`가 `succ-injection-en-70`의 발화와 겹친다고
거절했습니다. 문구를 고쳤습니다(case는 건드리지 않았습니다).

기존 파일 갱신: prompt digest 표, 버전 단언, rule 구현 표.

## 5. smoke 경로를 막고 있던 것

버전을 올리자 **smoke run까지 실패**했습니다. harness가 mode를 정하기 **전에**
register entry를 요구하고 있었기 때문입니다.

`decideEvalRunMode()`는 `live`가 아니면 register를 보기도 전에 `smoke`를
반환하고, live인데 entry가 없으면 `unknown_pair`로 거절합니다. 즉 이 이른 종료는
**live 경로에는 아무것도 더하지 않으면서 smoke 경로를 같이 죽이고 있었습니다.**
smoke run은 provider에 닿지 않고 한 푼도 쓰지 않으므로 거절해서 지키는 예산이
없습니다.

이른 종료를 `live`일 때로 좁혔습니다. 메시지는 고칠 파일 이름을 대므로
`unknown_pair`보다 낫고, 그래서 남겼습니다. 요약 출력의
`registerEntry.evalBudget` 접근도 optional로 바꿨습니다 — 같은 이유로 smoke run
끝에서 터지고 있었습니다.

**이것은 pair 등록이 아닙니다.** register는 비어 있고, live 실행은 여전히
`unknown_pair`로 거절됩니다.

## 6. 버전 bump가 강제한 테스트 수정

| 테스트 | 무엇이 바뀌었나 |
| --- | --- |
| `memoryEvalBudgetBinding` — v7 instrument | tuple의 **모든** field가 v7과 다릅니다. prompt까지 움직였으므로 같다고 단언할 항목이 남지 않았고, 그 자체가 "v7 승인은 이 트리의 어떤 부분도 설명하지 않는다"는 진술입니다 |
| `memoryEvalSchema3DryRun` — 배포 pair | `pair`가 없을 수 있게 하고 `unknown_pair`를 단언합니다. entry가 있어야 한다고 요구하면 이 테스트가 지키려는 상태(등록 안 됨) 자체가 실패가 됩니다 |
| `memoryExtractionEvalBoundary`, `memoryEvalDevelopmentProbe` | 거절 메시지 목록에 `No register entry` 추가. 두 테스트 모두 "어느 gate가 먼저 말하는지는 register의 사정"이라고 이미 적혀 있습니다 |
| smoke 헤더 | `mem-extract-v7` → `mem-extract-v8` |

## 7. 검증

- 전체 unit 파일 직접 실행: **7,191건 중 18건 실패**. develop에서 같은 명령으로
  받은 baseline도 **정확히 같은 18건**(목록 diff 공집합). 이 변경이 만든 실패는
  **0건**입니다.
- `npm run test:unit` wrapper는 이 Windows 기계에서 출력 없이 exit 1입니다.
  develop worktree에서도 같으므로 **환경 문제이지 이 변경과 무관**하며, 그래서
  검증은 `node --test`를 직접 실행해 했습니다.
- policy-section 4,026/30, encoding, release-gate coverage, ESLint 통과.
- smoke run: `gpt-5-6-luna::mem-extract-v8`, `mem-eval-succ-8 (decision, frozen)`,
  485/485, exit 0, network 미접촉.

## 8. 이번 승인 밖 — 다음 단계

- **pair 등록**: `gpt-5-6-luna::mem-extract-v8` entry가 없습니다. 없는 동안
  live 실행은 `unknown_pair`로 거절됩니다.
- **예산·유료 실행**: 등록 후에도 승인된 eval budget, 깨끗한 named commit,
  쓰이지 않은 run ordinal이 각각 따로 필요합니다.
- **release gate**, **`memoryExtractionEnabled`·`memoryInjectionEnabled`**:
  변경 없음.
- **§4.14 부분 문자열 잔여**: matcher 차원의 열린 질문으로 그대로입니다.
