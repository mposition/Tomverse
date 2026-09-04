# `mem-extract-v8` 구현 기록

**상태: 구현 완료 (2026-09-04).** pair 등록·승인, 예산, 유료 실행, release gate,
두 feature flag는 **포함하지 않습니다.**

- 승인: `mem-extract-v8` 구현 — EN/KO 완결형 negated 예시 추가, prompt
  version·digest 고정, parser·evidence·오염 방지 테스트, 이 기록
- 승인이 명시적으로 제외한 것: pair 등록·승인, 예산, 유료 실행, release gate,
  `memoryExtractionEnabled`·`memoryInjectionEnabled`
- 기준: 동결된 `mem-eval-succ-8`(2026-09-04 서명), `mem-score-v3.5`

**prompt digest: `cadb45a497eda079acbd70f99b82d72d1e3cb52460e4b768a80853306d1d90e5`**

## 1. 추가된 문안

`MEMORY_EXTRACTION_NEGATED_EXAMPLES`. polarity 규칙 **다음에** 놓이며, 규칙
자체는 건드리지 않았습니다(§2).

**완결형의 의미는 "완결된 구조화 출력"입니다.** 필수 7개 필드
(`kind`·`polarity`·`statement`·`confidence`·`sensitivity`·`expiresAt`·`evidence`)를
모두 갖춘 candidate 객체 그대로이고, evidence도 `messageLabel`·`quote` 구조를
그대로 씁니다. 첫 초안은 statement와 polarity만 산문으로 설명했는데, 그러면
나머지 다섯 필드를 모델이 별도로 제시된 schema에서 추론해야 하고 그 추론이야말로
예시가 없애려는 것입니다.

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

A user message labelled m0: 코드 예시는 의사코드로 주지 말아 주세요. 바로 돌려볼 수 있어야 합니다.
{
  "candidates": [
    {
      "kind": "code_style",
      "polarity": "negated",
      "statement": "사용자는 코드 예시를 의사코드로 받는 것을 원하지 않습니다",
      "confidence": 0.9,
      "sensitivity": "standard",
      "expiresAt": null,
      "evidence": [ { "messageLabel": "m0", "quote": "코드 예시는 의사코드로 주지 말아 주세요" } ]
    }
  ]
}
```

- **quote는 메시지 전체가 아니라 그 안의 span**입니다. prompt가 "복사한 짧은
  span"을 요구하므로, 전체를 인용하는 예시는 반대를 가르칩니다.
- **KO statement는 인용한 근거의 언어**로 씁니다. 기존 language 규칙을 negated
  case 위에서 보여 주는 것이 두 번째 예시의 값입니다.

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

## 3. 오염 — 두 번 틀렸고, 두 번째는 문자열 검사로 안 잡혔습니다

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

### 3.3 채택 — cell을 측정해서 고릅니다

그래서 소재를 그럴듯함이 아니라 **(language, kind, polarity) cell**로 골랐습니다.
예시가 corpus가 채점하는 cell에 앉으면 채점되는 판정을 가르치는 것입니다.

- **EN — `relationship` / negated.** boundary 규칙이 *이미* "The registration
  form lists two dependants; I have no dependants"를 negated relationship
  fact라고 부르고 있으므로, 승인된 prompt가 하지 않던 mapping을 새로
  도입하지 않습니다. `en|relationship|negated`는 succ-4~8에서 **0건**입니다.
- **KO — `code_style` / negated.** 같은 사실을 쓸 수 없었습니다.
  `ko|relationship|negated`가 **5건**이기 때문입니다. 사실 계열 kind는 전부
  한국어 negated case를 갖고 있어서, 답변 방식 kind로 갔습니다.
  `ko|code_style|negated`는 **0건**이고 `code_style`은 `polarity44` 44건에
  **한 번도** 등장하지 않습니다.

어휘 검사(대소문자 접기 후): `dependants`·`의사코드` 모두 corpus에 없음.
`낚시`·`philately`·`spreadsheet`는 있음(검사기 동작 확인).

**남는 위험을 적어 둡니다.** `en|relationship|affirmed`는 45건이고
`ko|code_style|affirmed`는 20건이므로, 두 예시 모두 채워진 affirmed cell의
polarity 반대편입니다. 어떤 negated 예시를 써도 이는 피할 수 없습니다 — corpus가
negated durable fact를 의도적으로 많이 담고 있기 때문입니다. 선택 기준은 "채점되는
cell을 피한다"이지 "flip을 피한다"가 아니며, 그 기준은 검사로 강제됩니다.

## 4. 테스트

`tests/memoryExtractionPromptExamples.test.mjs` (신규, 13건)

**구조화 출력과 parser**

- 각 예시가 필수 7개 필드를 **정확히** 갖는다
- quote가 message의 span이고 전체가 아니다
- **실제 `parseExtractionOutput()`으로 파싱된다** — 진짜 label map을 만들고
  거기에 결속해 통과시킵니다. pipeline이 거절할 예시는 거절당할 출력을
  가르치는 예시입니다

**evidence — 복사되어도 안전한가**

- 예시는 `m0`를 인용하고, `toExtractionPromptInput()`은 1부터 번호를 매기므로
  `m0`는 만들어질 수 없습니다. 메시지 1·2·5·20개에 대해 확인합니다
- 예시를 **그대로 복사한 candidate는 parser가 버립니다** — label이 아무것도
  가리키지 않기 때문. 라벨 규칙을 읽는 대신 결과로 확인합니다
- prompt가 "예시에서 본 label은 인용하지 말라"고 명시하는지도 확인

**오염**

- 등록 term이 어떤 corpus에도 없다(대소문자 접기, NFC). corpus 길이 하한 포함
- **red-before-green 양방향**: `낚시`는 잡히고, `Philately`도 잡힙니다(대소문자
  접기가 실제로 적용되는지)
- 등록됐지만 예시에 없는 term은 실패(죽은 항목)
- **양쪽 언어**에서, 예시 본문의 content word가 (1) 등록 term이 덮거나
  (2) 어떤 corpus에도 없거나 (3) 검토된 allowlist에 있어야 합니다. (2)가
  일반성을 줍니다 — 새 예시가 어떤 어휘든 쓸 수 있되, corpus에 있는 단어는
  근거가 있어야 합니다
- **구조 검사**: 두 예시의 cell이 corpus가 채점하는 cell이 아니다
- **holdout 검사**: 두 예시가 `polarity44` 대체본의 (language, kind, polarity)
  형태를 재현하지 않는다

마지막 두 검사가 3.2를 잡습니다. 되돌려서 확인했습니다 — KO 예시를
`decision`/negated로 되돌리면 두 검사가 실패하고, 현재 값에서는 통과합니다.

**이미 있던 gate도 걸렸습니다.** `tests/memoryEvalPromptDatasetSeparation.test.mjs`가
초안 문구의 `at the end of the`가 `succ-injection-en-70`의 발화와 겹친다고
거절했습니다. 문구를 고쳤습니다(case는 건드리지 않았습니다). 이 gate는 n-gram
수준의 겹침을 이미 보고 있었고, 이번에 추가한 것은 그 위의 cell 수준 검사입니다.

기존 파일 갱신: prompt digest 표, 버전 단언, rule 구현 표(v8이 같은 규칙을 다시
주장).

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

- 전체 unit 파일 직접 실행: **7,188건 중 18건 실패**. develop에서 같은 명령으로
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
