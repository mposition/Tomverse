# gold 작성·채점 계약 (초안 — 승인 대기)

**상태: 초안. 승인 전에는 코드에 반영하지 않습니다.**

`mem-eval-succ-4`부터 적용할 계약입니다. v5-run1이 드러낸 것은 모델 결함만이
아니라 **gold가 정답을 담지 못한다**는 사실이었고
(`.github/audits/memory-eval-v5-run1-2026-08-27.md` §4.1, 10건 확인), 그 상태로
prompt를 먼저 설계하면 모델 행동을 고친 것인지 채점 기준에 맞춘 것인지 다시
구분할 수 없습니다. 그래서 이것이 v6 규칙보다 먼저입니다.

## 0. 무엇이 실패했는가

gold는 지금 `kind + mustInclude[] (+ mustIncludeAny[])`이고, token은 **검토자가
상상한 표면 문자열**입니다. 모델은 같은 사실을 다른 문자열로 씁니다.

```
gold `twelve-hour`            모델 twelve hours          하이픈·복수
gold `육 개월`                 모델 6개월                  수사 표기·띄어쓰기
gold `새벽 세 시`              모델 새벽 3시               수사 표기
gold `여섯`                    모델 아침 6시               수사 표기
gold `2000`                    모델 $2,000                 천 단위 쉼표
gold `자세히`                  모델 자세하고               어형
gold `한양대에 다닌 적 없`     모델 한양대학교에 다닌 적이 없다   어형·조사
gold `쉽게`                    모델 쉬운 말로              어형
gold `no access to a printer`  모델 does not have access to a printer   부정 표현
gold `handwritten`             모델 writing notes by hand  합성어 ↔ 구
```

**열 건 모두 어떤 모델도 통과할 수 없습니다.** 그리고 한 번의 오류가 두 번
계산됩니다 — gold는 miss, 정답은 unmatched candidate.

2026-08-27 kind-boundary 개정 §4.1은 이 위험을 알고 있었고 "succ-3 gold 작성 시
**다시** 재검토하라"고 적었습니다. 재검토는 수행됐고 네 건을 잡았습니다. 그런데
**검토자가 만든 문장으로만 검사했습니다.** 방법 자체가 부족했고, 이 계약은 그
방법을 규칙으로 바꿉니다.

## 1. gold는 문장이 아니라 typed record입니다

**검토자가 쓴 자연어 문장을 정답으로 쓰지 않습니다.** 그것은 표면 표현 하나를
정답으로 승격시키는 일이고, 위 열 건이 그 결과입니다.

```ts
type ExpectedMemoryV3 = {
    id: string;
    kind: string;                       // ① exact 매칭, 변경 없음
    polarity: "affirms" | "denies";     // ② 명시 필드
    factValue: readonly string[];       // ③ 정규화된 사실값 (AND)
    factValueAny?: readonly string[];   //    표현 대안 (OR)
    anchor: string;                     // ④ 근거가 되는 사용자 메시지 label
    expectedDisposition: "bulk_safe" | "sensitive_review";
};
```

### ① exact kind 매칭은 유지합니다

완화하지 않습니다. 잘못된 자리에 저장된 기억을 정답으로 세면 다섯 규칙 전부가
재는 대상을 잃습니다. 2026-08-25 개정이 명시적으로 유지한 것이고 이 계약도
유지합니다.

### ② polarity를 token에서 꺼내 필드로 만듭니다

지금은 부정이 `mustIncludeAny` 논리합 안에 숨어 있고, 케이스마다 새로
발명됩니다. 그것이 `한양대에 다닌 적 없` 같은 과대적합 문자열의 출처입니다.

polarity가 필드가 되면 판정은 **승인된 언어별 부정 표지 목록**으로 하고, 목록은
한 번 검수돼 digest에 들어갑니다.

```
ko  않 · 없 · 아니 · 못
en  not · n't · never · no · without
```

**전역 스캔은 안 됩니다.** `사용자는 인천에 살며 이사 계획이 없다`는 gold의
반대를 주장하면서 `없`을 포함합니다. 그래서 **근접 조건**을 둡니다.

> 부정 표지는 `factValue`의 마지막 출현으로부터 정규화 후 **K자 이내**에 있어야
> 합니다.

K는 언어별 상수이며 digest에 포함됩니다. **승인이 필요한 값입니다** — 초안은
`ko: 12`, `en: 24`이고, succ-3의 실제 모델 출력 1,150건에 걸어 오탐·미탐을 세어
정하자고 제안합니다(그 측정은 채점을 바꾸지 않으므로 지금 해도 됩니다).

### ③ 사실값은 정규화된 형태로 씁니다

`canon()`은 고정 함수이며 digest에 포함됩니다.

```
1. NFC
2. 소문자
3. 숫자 런의 자릿수 구분자 제거          2,000 → 2000
4. 수사 → 아라비아 숫자 (고정 표, 토큰 경계)  여섯 → 6 · 세 → 3 · 육 → 6 · twelve → 12
5. 문장부호·기호 → 공백                  twelve-hour → twelve hour · $2,000 → 2000
6. 공백 정규화 후 trim
```

비교는 **공백까지 제거한 형태**로 합니다(`canonNS`). 한국어 띄어쓰기가
유동적이기 때문입니다 — `6 개월`과 `6개월`이 같아야 합니다.

```
match(cand, gold) =
    cand.kind === gold.kind
 && polarityOK(cand.statement, gold)
 && anchorOK(cand.evidence, gold.anchor)
 && every(gold.factValue,     t => canonNS(cand.statement).includes(canonNS(t)))
 && (gold.factValueAny === undefined
     || some(gold.factValueAny, t => canonNS(cand.statement).includes(canonNS(t))))
```

이것으로 위 열 건 중 **다섯 건(숫자)이 규칙만으로 해결**됩니다. 복수형은
substring이 흡수합니다 — gold `12 hour`는 `12 hours` 안에 있습니다.

### ④ anchor — 이 사실을 허락한 메시지

```
anchor: "m1"      // 사용자 메시지 label
```

후보의 `evidence`가 anchor를 포함해야 합니다. **규칙 2가 채점에 들어옵니다** —
assistant 메시지에서 온 사실은 사용자 사실일 수 없고, 지금은 그것을 gold가
아니라 prompt만 말합니다.

## 2. 한국어 어형

`자세히`/`자세하고`, `쉽게`/`쉬운`은 숫자 정규화가 닿지 않습니다. 어간 처리는
형태소 분석이고, 그것은 §4가 금지합니다.

**둘 중 하나만 허용합니다.**

1. **승인된 stem** — `lib/`에 검수된 목록을 두고 gold가 그 stem을 씁니다.
   `자세`, `쉬`처럼 어미를 잘라낸 형태이며, 목록에 없는 stem은 schema가
   거부합니다.
2. **`factValueAny` 대안** — stem이 없으면 표현 대안을 나열합니다.

**둘 다 아닌 gold는 schema가 거부합니다.** 지금처럼 검토자가 어형 하나를 골라
`factValue`에 넣는 것은 더 이상 유효하지 않습니다.

짧은 stem의 과대매칭은 stem 목록 검수에서 막습니다 — 길이 하한을 두지
않습니다. `없`이 그 반례이고, 개정 §7이 의도적으로 쓴 어간입니다.

## 3. 정규화가 할 수 있는 것과 없는 것

> **정규화는 토큰을 고정 표에 따라 표준형으로 다시 씁니다. 두 개의 다른 사실이
> 같다고 판단하지 않습니다.**

이 한 줄이 경계입니다. 수사 표를 적용하는 것은 표기 변환이고, 동의어·유의어·
의미 유사도는 판단입니다.

**금지**: 어떤 종류의 fuzzy 매칭, 편집 거리, 임베딩 유사도, LLM judge. 허용되는
것은 NFC · 소문자 · 공백 · 문장부호 · 위에 열거한 숫자 표뿐입니다.

이유는 재현성입니다. LLM judge는 같은 artifact에서 같은 답을 준다는 보장이
없고, 그러면 판정이 표본이 아니라 판정 시각에 붙습니다.

## 4. 검수와 digest

**대안 토큰과 polarity는 실행 전에 사람이 검수합니다.** batch 기록의 판정란에
gold의 네 요소가 함께 보이도록 검수 시트를 바꿉니다 — 지금 시트는 `kind`와
token만 보여 주고, polarity와 anchor는 검수 대상이 되지 않습니다.

digest 결속은 **이미 동작합니다.** `scoringContractDigest`(2026-08-27)가
`expectedDisposition` · `goldCompleteness` · `mustIncludeAny` ·
`criticalGoldMode`를 덮고 있고, 새 필드 셋과 `canon` 표·polarity 표지 목록·K
상수를 추가하면 계약 전체가 하나의 digest에 들어갑니다.

확인한 사실:

```
succ-assistant-en-307에 대안 1개 추가
  dataset digest 이동  : false
  contract digest 이동 : true   → manifest 재계산 실패 → 새 version 강제
```

## 5. 모델 출력을 본 뒤의 수정

> **실제 모델 출력을 보고 matcher 대안을 추가하면 새 dataset version과 새
> scoring-contract version으로 전환합니다. 기존 판정은 그 시점에 확정된
> 것으로 남습니다.**

이것이 "통과할 때까지 gold를 고치는" 경로를 닫습니다. §4에서 확인한 대로 강제는
이미 기계에 있습니다 — 대안을 더하면 contract digest가 움직이고 manifest가
어긋납니다.

**금지되는 것은 수정이 아니라 조용한 수정입니다.** succ-3의 열 건은 고쳐야
하고, 고치는 방법이 succ-4입니다.

## 6. 이 계약이 v5-run1의 열 건에 무엇을 하는가

| 결함 | 해결 |
|---|---|
| `twelve-hour` · `육 개월` · `새벽 세 시` · `여섯` · `2000` | §1③ 숫자 정규화 — 규칙만으로 |
| `자세히` · `쉽게` | §2 승인된 stem |
| `한양대에 다닌 적 없` · `no access to a printer` | §1② polarity 필드 — 부정을 토큰에서 분리 |
| `handwritten` | §2 `factValueAny` 대안 |

그리고 v5-run1이 드러낸 것 중 이 계약이 **해결하지 않는** 것도 적습니다.
`clause` 모순, `long_term_goal` ↔ `project`, 답변 형태 kind 3종, §5.1 미적용
범위는 전부 **prompt와 판정의 문제**이고 v6 규칙 1~5에서 다룹니다.

## 7. 비용

* schema v2 → v3, `MemoryEvalCaseV2` → `V3`. succ-3의 1,150건 gold 전체가
  `polarity`와 `anchor`를 새로 가져야 합니다 — 기계로 유도할 수 없습니다.
  `affirms`가 대부분이지만 **기본값을 두지 않습니다**(`expectedDisposition`이
  기본값을 거부한 것과 같은 이유).
* `scoringContractDigest` → `mem-score-v3`, `MEMORY_EVAL_SCORING_RULES` 문안
  갱신. succ-2·succ-3의 manifest는 옛 contract version을 유지하며
  `superseded`로 보고됩니다 — 이미 그렇게 설계돼 있습니다.
* 검수 시트 생성기 변경.
* succ-4는 어차피 새 dataset이므로 이 전환의 자연스러운 지점입니다.

## 8. 승인이 필요한 결정

1. **필드 이름** — `factValue`/`factValueAny`로 갈지, `mustInclude`/
   `mustIncludeAny`를 유지할지. 후자는 diff가 작고, 전자는 "문자열이 아니라
   사실값"이라는 계약을 이름이 말합니다. **`factValue` 권장.**
2. **polarity 근접 상수 K** — 초안 `ko: 12`, `en: 24`. succ-3 출력으로
   측정해 정하자고 제안합니다.
3. **stem 목록의 초기 내용** — 측정된 열 건에서 필요한 것만 넣고 시작할지,
   더 넓게 잡을지. **좁게 시작 권장** — 넓은 목록은 검수되지 않은 stem을
   들여옵니다.
4. **anchor를 채점에 넣을지, 기록만 할지.** 채점에 넣으면 규칙 2가 gold로
   내려오고, 동시에 succ-4의 1,150건에 anchor를 정확히 달아야 합니다.
   **채점에 넣기 권장** — 규칙 2 미적용이 v5의 가장 큰 실패였습니다.
