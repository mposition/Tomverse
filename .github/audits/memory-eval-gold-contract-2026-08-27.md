# gold 작성·채점 계약

**상태: 승인됨 (2026-08-27, @mposition). 결정 1·2·3·4 전부.**

결정 2(polarity 판정 방법)는 §9의 calibration이 거리 방식의 불성립을 보인 뒤
**A안 — 출력 schema의 필드 대 필드 비교**로 확정됐습니다 (§9.3). 거리 상수 `K`는
계약에 **들어가지 않습니다.** `mem-score-v3`는 2026-08-27에 동결됐습니다(§11).
남은 것은 succ-4 gold와 evidence 작성·검수, 그다음 v6 prompt 설계입니다.

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
    kind: string;                        // ① exact 매칭, 변경 없음
    polarity: "affirmed" | "negated";    // ② 명시 필드, 필수
    factValueAll: readonly string[];     // ③ 정규화된 사실값 — 전부 필요 (AND)
    factValueAny?: readonly string[];    //    표현 대안 — 하나면 충분 (OR)
    evidence: EvidenceAnchor;            // ④ 기계 검증 가능한 provenance, 필수
    expectedDisposition: "bulk_safe" | "sensitive_review";
};
```

**이름이 배열의 의미를 말합니다.** `factValue`가 배열이면 전부 필요한지 하나면
되는지 이름이 답하지 못합니다. `mustInclude`의 논리곱을 계승하므로 `All`이
붙습니다.

**값 이름은 `affirmed`/`negated`입니다** (2026-08-27 확정). `positive`/
`negative`는 감정 극성으로 읽힙니다 — 기억 추출에서 "부정적인 사실"과 "부정된
사실"은 전혀 다른 것이고, 필드 이름이 그 둘을 구분하지 못하면 gold 작성자와
prompt 작성자가 서로 다른 것을 뜻하면서 같은 단어를 씁니다.

**`polarity`와 `evidence`는 각 `ExpectedMemory`에서 필수이고, `expected: []`인
negative case에는 아무것도 요구하지 않습니다.** 기대하는 기억이 없으면 그 둘을
달 대상이 없습니다. 가짜 placeholder를 요구하면 "아무것도 뽑지 말라"는 케이스에
뽑을 것이 있는 것처럼 보이는 필드가 생깁니다.

### ① exact kind 매칭은 유지합니다

완화하지 않습니다. 잘못된 자리에 저장된 기억을 정답으로 세면 다섯 규칙 전부가
재는 대상을 잃습니다. 2026-08-25 개정이 명시적으로 유지한 것이고 이 계약도
유지합니다.

### ② polarity를 token에서 꺼내 필드로 만듭니다

지금은 부정이 `mustIncludeAny` 논리합 안에 숨어 있고, 케이스마다 새로
발명됩니다. 그것이 `한양대에 다닌 적 없` 같은 과대적합 문자열의 출처입니다.

polarity가 필드가 되면, 판정은 **모델이 낸 `polarity` 필드와 gold의 `polarity`
필드를 그대로 비교**하는 일이 됩니다 (A안 채택, 2026-08-27 — §9.3).

**모델 문장에서 polarity를 읽어내지 않습니다.** 처음 설계는 승인된 부정 표지
목록과 근접 조건(`K`자 이내)으로 문장에서 polarity를 추론하는 것이었고, §9의
calibration corpus가 그 방법이 **성립하지 않는다**는 것을 보였습니다 — 영어에는
가능한 `K`가 존재하지 않고 한국어는 `7..7` 한 값뿐입니다 (§9.2).

그래서 polarity는 gold에서만이 아니라 **v6 출력에서도 필드**가 됩니다. 추론할
것이 없으면 추론의 정확도도 없습니다. 계약은 §10입니다.

`K`와 거리 판정은 `mem-score-v3`에 **들어가지 않습니다.** 부정 표지 목록과 거리
계산은 진단 도구로만 남습니다 (§9.4).

### ②-1 거리를 재기 전에 고정한 것 — 채점에서 빠졌습니다 (2026-08-27)

> **이 절은 채점 계약이 아닙니다.** A안 채택으로 거리 판정이 `mem-score-v3`에서
> 빠졌습니다 (§9.3). 아래 정의는 §9의 진단 도구가 지금도 쓰는 정의이며, 그
> 측정이 어떤 조건에서 이뤄졌는지 읽을 수 있도록 남깁니다.

corpus를 만들기 전에 정의가 먼저입니다. 정의가 움직이면 측정은 과녁을 잃습니다.

**측정 문자열** — 매칭에 쓰는 것과 같은 문자열, 즉 `canonNS`(§1③의 `canon`
뒤 공백 제거)입니다. 다른 문자열에서 잰 거리는 매칭된 위치로 되돌릴 수
없습니다. 한국어 12자는 12음절, 영어 24자는 대략 네다섯 낱말입니다.

**거리 정의** — `factValueAll` 토큰의 출현 구간과 부정 표지 구간 **사이의
간격**이며, 문자 수입니다. 표지가 사실값보다 앞에 와도 같은 방식으로 재고,
순서는 묻지 않습니다. 여러 출현이 있으면 **최솟값**을 씁니다 — 묻는 것은
"사실 가까이에 표지가 있는가"이지 "모든 표지가 가까운가"가 아닙니다.

**경계** — 포함입니다. `gap <= K`.

**기준점** — `factValueAll`만 씁니다. `factValueAny`는 polarity가 필드로
빠져나온 뒤에는 순수한 표현 변형이므로 기준점이 되지 않습니다.

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

### ④ evidence — 기계가 대조할 수 있는 provenance (2026-08-27 확정)

**자연어 설명형 anchor는 규칙 2를 재지 못합니다.** 검토자가 "사용자가 말했음"이라
적어 두는 것은 기록이지 검증이 아닙니다.

```ts
type EvidenceAnchor = {
    evidenceMessageIndex: number;   // 대화 안에서 안정적인 메시지 참조
    evidenceQuote: string;          // 그 메시지 안의 exact 부분 문자열
};
```

이름은 v6 출력 schema와 **같습니다** (§10). gold 쪽과 출력 쪽이 다른 이름을 쓰면
채점 코드가 둘을 옮겨 적으며 짝을 맞춰야 하고, 그 옮겨 적기가 계약의 두 번째
사본이 됩니다.

`evidenceMessageIndex`는 대화 안에서 안정적인 정수 index이며, 재현할 수 없는
runtime id가 아닙니다 — 같은 artifact를 나중에 다시 채점해도 같은 메시지를
가리켜야 합니다.

**작성 시점 검증** — schema가 셋을 봅니다.

1. `evidenceMessageIndex`가 그 대화에 실재할 것
2. 그 메시지의 role이 **반드시 `user`**일 것
3. `evidenceQuote`가 그 메시지 본문에 **그대로** 있을 것

**채점 시점 검증** — §10의 계약이 그대로 적용됩니다. 근거를 대지 못하는 추출과
근거를 지어낸 추출은 채점에서 같습니다.

이것으로 **규칙 2가 prompt에서 gold로 내려옵니다.** v5-run1에서 assistant 발화를
사용자 사실로 저장한 13건은, evidence가 채점에 들어 있었다면 gold를 맞힐 수
없었습니다 — 근거로 댈 사용자 메시지가 없기 때문입니다.

## 2. 한국어 어형

`자세히`/`자세하고`, `쉽게`/`쉬운`은 숫자 정규화가 닿지 않습니다. 어간 처리는
형태소 분석이고, 그것은 §4가 금지합니다.

**둘 중 하나만 허용합니다.**

1. **승인된 stem** — `lib/`에 검수된 목록을 두고 gold가 그 stem을 씁니다.
   `자세`, `쉬`처럼 어미를 잘라낸 형태이며, 목록에 없는 stem은 schema가
   거부합니다.
2. **`factValueAny` 대안** — stem이 없으면 표현 대안을 나열합니다.

**둘 다 아닌 gold는 schema가 거부합니다.** 지금처럼 검토자가 어형 하나를 골라
`factValueAll`에 넣는 것은 더 이상 유효하지 않습니다.

짧은 stem의 과대매칭은 stem 목록 검수에서 막습니다 — 길이 하한을 두지
않습니다. `없`이 그 반례이고, 개정 §7이 의도적으로 쓴 어간입니다.

### 2.1 stem 목록은 좁게 시작합니다 (2026-08-27 확정)

**범용 형태소 사전으로 키우지 않습니다.** 검수되지 않은 stem을 들여오는 순간
목록은 gold가 아니라 언어 모델이 됩니다.

* `succ-4`가 실제로 필요로 하는 stem만 등록합니다.
* 언어별로 목록을 분리합니다.
* 각 stem에 **양성 예제와 음성 예제**를 붙여 검수합니다 — 무엇을 잡아야 하고
  무엇을 잡으면 안 되는지가 목록 안에 있어야 합니다.
* 목록 자체가 `scoringContractDigest`에 들어갑니다.
* 동결 뒤의 추가·완화는 **새 scoring contract version**입니다. 실행 중에
  stem 하나를 더하는 것은 §5가 닫은 경로와 같은 것입니다.

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

## 8. 결정 (2026-08-27)

| | 결정 |
|---|---|
| 1. 필드 이름 | **`factValueAll` / `factValueAny`.** 배열의 AND/OR 의미를 이름이 말합니다. 기존 이름은 버립니다. |
| 2. polarity 판정 | **A안 — 출력 schema의 필드 대 필드 비교** (§9.3, §10). 거리 판정과 상수 `K`는 계약에서 제외. `ko:12`·`en:24` candidate는 폐기. |
| 3. stem 목록 | **좁게 시작** (§2.1). |
| 4. evidence | **채점에 포함**, 기계 검증 가능한 provenance로 (§1④, §10). `evidenceMessageIndex` + `evidenceQuote`. |

## 9. polarity calibration corpus

**succ-3로 K를 고르지 않습니다.** decision set의 출력으로 scoring parameter를
고르면 그 사례들은 규칙을 만든 사례가 되고, B+ 계약상 succ-4에 남을 근거를
잃습니다. 1,150건으로 튜닝하면 그 근거를 전부 잃습니다.

대신 K만을 위한 corpus를 따로 만듭니다.

* **ko·en 각각**, 다섯 형태를 모두 담습니다 — 긍정 · 부정 · **이중부정** ·
  **정정** · **조건문**.
* 각 항목은 `factValueAll`과 의도한 polarity를 갖고, **사람이 사전 판정한
  정답**을 함께 갖습니다: 이 문장은 그 사실을 그 polarity로 주장하는가.
* 상한을 정하는 것은 **표지가 있지만 다른 것에 걸린 문장**입니다 —
  `사용자는 인천에 살며 이사 계획이 없다`가 그 형태입니다.
* 하한을 정하는 것은 **표지가 정당하게 멀리 있는 문장**입니다.
* 거리 단위·정규화·경계는 §②-1에서 이미 고정했습니다. corpus는 그 정의
  **뒤에** 만듭니다.

K는 이 corpus에서 오탐과 미탐의 합을 최소화하는 값으로 고르고, **근거를
기록합니다** — 선택된 값, 그 값에서 틀리는 항목, 왜 그것을 감수하는지.

**선택 후 succ-3 출력에는 변경 금지 진단으로만 적용합니다.** succ-3의 열 건이
새 계약에서 어떻게 되는지는 볼 수 있고, 그 결과로 K를 다시 고르지는
않습니다.

### 9.1 첫 실행 — 정의를 고쳐야 했던 두 곳 (2026-08-27)

`npm run report:polarity-calibration` (corpus 60건, ko 30 · en 30, K 0..40).

§②-1은 corpus를 만들기 **전에** 정의를 고정했고 그 순서는 지켰습니다. 다만
첫 실행이 드러낸 것은 K가 몇이냐가 아니라 **정의 자체의 결함 둘**이었고,
그것은 점수가 낮다는 문제가 아니라 규칙이 없는 표지를 읽는다는 문제입니다.
값을 조용히 바꾸지 않고 여기 적습니다.

1. **`canonNS`는 한국어 전용입니다.** 한국어는 띄어쓰기가 불안정해 공백을
   지워야 하지만, 영어는 낱말을 공백으로 나눕니다. 공백을 지우면 **없던
   표지가 생깁니다** — `The user lives in Ottawa.`는
   `theuserlivesinottawa`가 되고 그 안에 `in`+`ot`가 붙어 만든 `not`이
   사실값에 붙어 있습니다. 첫 실행에서 영어 긍정문 6건 중 5건이 *모든* K에서
   오답이었고 원인은 전부 이것이었습니다. 영어는 `canon`에서 잽니다.
2. **`n't`는 매칭될 수 없는 표지였습니다.** `canon`이 apostrophe를 공백으로
   바꾼 뒤라 `doesn't`는 `doesn t`가 됩니다. 목록에 처음부터 있었고 한 번도
   걸릴 수 없었습니다. `canon`에 `n't` → ` not` 한 줄을 넣었습니다.

이어서 두 가지가 따라왔습니다. 표지는 **낱말 단위**로 맞춥니다(`know` 안의
`no`는 부정이 아닙니다). 그러자 `cannot`이 `not`에 걸리지 않게 되어 목록에
넣었습니다 — 이 추가는 corpus를 **더 어렵게** 만듭니다(`cal-en-aff-4`의
상한을 새로 만듭니다). 사실값에는 경계를 적용하지 **않습니다**: §2.1의 좁은
stem 목록은 접두 매칭이고, 경계 검사는 그것을 없앱니다.

### 9.2 측정 결과 — 이 규칙으로는 K를 고를 수 없습니다

corpus 전체 정확도는 답이 아닙니다. 60건은 무엇의 표본도 아니므로 `17/30`은
규칙에 대한 사실이 아니라 형태별로 몇 문장을 썼는지에 대한 사실입니다.
K를 정하는 조건은 그보다 좁고 정확합니다. gold가 기댈 수 있는 형태 —
**평서 긍정과 평서 부정** — 만 놓고 보면 요구는 양쪽에서 옵니다.

* 부정문은 전부 잡혀야 합니다 → `K >= gap`
* 긍정문은 하나도 잡히면 안 됩니다 → `K < gap`

즉 가능한 창은 `[부정 gap 최대, 긍정 gap 최소 - 1]`입니다.

| | 하한 (정한 항목) | 상한 (정한 항목) | 창 |
|---|---|---|---|
| ko | 7 (`cal-ko-neg-3`, `cal-ko-neg-6`) | 7 (`cal-ko-aff-2`) | `7..7` — **여유 0** |
| en | 18 (`cal-en-neg-5`) | 5 (`cal-en-aff-5`) | **비어 있음** |

**영어에는 K가 존재하지 않습니다.** `The user does not have access to a
printer.`는 표지와 사실값 사이가 18자이고, `The user has two siblings and no
children.`은 6자입니다. 앞을 잡는 K는 뒤를 반드시 오판합니다. 이것은 값을 더
찾아보면 되는 문제가 아니라 **거리라는 도구가 영어에서 답을 못 낸다**는
결과입니다. 초안값 `en:24`는 평서 긍정문을 전부 부정으로 읽습니다.

**한국어의 `7..7`은 통과가 아닙니다.** 창이 한 값뿐이라는 것은 여유가 없다는
뜻이고, 다음에 쓰는 문장 하나가 창을 없앨 수 있습니다. 초안값 `ko:12`는 이미
상한 밖입니다.

형태별로, 하나의 K가 동시에 맞힐 수 있는 최대치입니다.

| 형태 | ko | en | 계약 안 |
|---|---|---|---|
| 긍정 | 6/6 | 6/6 | 예 |
| 부정 | 6/6 | 6/6 | 예 |
| 이중부정 | 6/6 (K가 작을 때) | 6/6 (K가 작을 때) | 아니오 |
| 정정 | 3/6 | 3/6 | 아니오 |
| 조건문 | 2/6 | 2/6 | 아니오 |

긍정 6/6과 부정 6/6은 **같은 K에서** 성립해야 의미가 있고, 그것이 위의 창
계산입니다. 이중부정·정정·조건문은 설계할 때 예상한 대로 어떤 K도 다루지
못합니다 — corpus에 넣은 이유가 그것을 보이기 위해서였습니다.

### 9.3 결정 — A안 채택 (2026-08-27, @mposition)

> **A안을 채택한다. v6 Structured Output에 `polarity`와 검증 가능한 user
> evidence reference를 필수로 추가한다. `mem-score-v3`는 polarity를 필드 대
> 필드로 채점하며 거리 기반 판정과 `K` 상수를 포함하지 않는다. 기존 거리
> corpus와 `assertsGold`는 미검수 진단 자료로만 보존한다.**

근거는 §9.2입니다. 거리는 **prose에서 polarity를 읽어내려는** 도구였고, 그 도구가
영어에서 답을 못 냅니다. 추론을 더 정교하게 만드는 대신 추론할 필요를
없앱니다 — polarity가 gold의 필드이므로 출력의 필드이기도 하면, 채점은 두 필드의
비교입니다. §1④가 이미 evidence reference를 출력 schema에 넣기로 했으므로 같은
변경 한 번에 들어갑니다.

계약 본문은 §10입니다.

**B안(절 범위)과 C안(거리 유지)은 채택하지 않습니다.** B는 언어별 절 분리 목록을
새로 고정해야 하고 그것은 거리가 피하려던 문법이며, 이중부정·조건문은 여전히
다루지 못합니다. C는 한국어만 성립합니다.

### 9.4 거리는 진단으로만 남습니다

`lib/memoryEvalPolarityCalibration/**`와 `npm run report:polarity-calibration`은
지웁니다가 아니라 **강등**됩니다. 모델이 쓴 문장과 모델이 쓴 `polarity`가
어긋나는 건을 사람 검수로 올리는 용도입니다.

* **`K`는 `mem-score-v3`에도 `scoringContractDigest`에도 들어가지 않습니다.**
* **pass/fail 판정에 쓰지 않습니다.** 어떤 게이트도 이 거리를 읽지 않습니다.
* 보고는 `K` 하나가 아니라 **거리 histogram과 사례 목록**입니다. 단일 임계값을
  출력하는 것 자체가 그 값이 계약이라는 인상을 만듭니다.
* **`assertsGold` 60건은 `unreviewed diagnostic draft`입니다.** 문서와 코드
  양쪽에 그렇게 적혀 있습니다.
* **그 라벨을 근거로 품질·정확도 주장을 하지 않는 한** `mem-score-v3` 동결 전
  검수는 필요 없습니다. 주장을 하려면 그때 검수합니다.

§9.2의 창 계산은 그대로 유효한 관측입니다 — 그것이 A안을 고른 근거이므로,
corpus나 표지 목록이 바뀌어 영어에 창이 생기면 그것은 **근거가 바뀐 것**이고
보이게 실패해야 합니다. `tests/memoryEvalPolarityDistance.test.mjs`가 고정합니다.

## 10. v6 출력 schema와 evidence 결속 (2026-08-27 확정)

### 10.1 필수 필드

후보 하나마다:

| 필드 | 값 |
|---|---|
| `polarity` | `"affirmed"` \| `"negated"` |
| `evidenceMessageIndex` | 대화 안에서 안정적인 message reference |
| `evidenceQuote` | 그 메시지의 exact span |

셋 다 **필수**입니다. 선택 필드로 두면 모델이 어려운 건에서 생략하고, 생략된
건은 검사를 통과하는 것이 아니라 검사를 받지 않게 됩니다.

### 10.2 채점·검증 계약

1. evidence가 **실제 `user` 메시지**를 가리켜야 합니다.
2. `evidenceQuote`가 그 메시지의 **exact span**이어야 합니다.
3. 출력 `polarity`와 gold `polarity`를 **필드 대 필드**로 비교합니다.
4. **assistant 메시지 · 존재하지 않는 span · role 불일치는 adoption 불인정**
   입니다.
5. **조건문 · 해소되지 않은 정정 · 이중부정처럼 단순 polarity로 확정할 수 없는
   근거에서는 후보를 출력하지 않습니다.**
6. **명확한 최종 정정절이 별도로 존재하면 그 평서절만 anchor로 사용 가능**
   합니다.

5·6이 §9.2가 어떤 K로도 못 한다고 보인 세 형태를 처리하는 방식입니다. 거리로
읽어내려 하지 않고, **그런 근거에서는 후보를 내지 않게** 합니다. 6은 그
예외입니다 — `전주가 아니라 정읍이다`에서 정정이 이미 해소돼 있으면 평서절
`정읍이다`가 anchor가 됩니다.

같은 제약이 gold 작성에도 걸립니다. gold의 `evidenceQuote`는 평서 긍정이거나
평서 부정이어야 하고, 조건절·미해소 정정·이중부정을 span으로 삼은 gold는
검수에서 반려합니다.

### 10.3 Structured Outputs는 절반만 보장합니다

Structured Outputs는 출력이 **JSON schema를 지킨다**는 것을 보장합니다. 모델이
고른 `polarity`가 맞는지, `evidenceQuote`가 실재하는 사용자 발화인지는
보장하지 않습니다 — schema는 문자열이 있는지를 보지 그 문자열이 참인지를 보지
않습니다.

**그러므로 서버와 scorer의 evidence 결속 검사가 반드시 함께 있어야 합니다.**
schema 준수를 근거 검증으로 읽는 것이 이 계약이 막는 실패이고, v5-run1에서
assistant 발화를 사용자 사실로 저장한 13건이 그 실패의 모습입니다.

결속 검사는 **채점 시점**에 원본 대화를 다시 읽어 수행합니다. 모델이 낸 index와
span을 그 대화의 메시지와 대조하며, 모델이 낸 어떤 값도 검사의 입력이지 근거가
아닙니다.

참조: OpenAI API Structured Outputs —
<https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses>

## 11. mem-score-v3 동결 (2026-08-27 승인)

`MEMORY_EVAL_SCORING_CONTRACT_VERSION = "mem-score-v3"`.
descriptor digest `0ff454d61bb41b640465bc77aad39f590f09413d9e46e32f1a8ba66fc2cd26dc`,
`lib/memoryEvalDatasetManifests.ts`의 `MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS`에
고정돼 있습니다.

### 11.1 digest에 들어간 것

| 항목 | 출처 |
|---|---|
| schema version과 required·optional 필드 | `lib/memoryEvalDatasetSchemaV3.ts` |
| `polarity` enum과 **각 값의 의미** | 같은 파일 |
| evidence 구조와 검증 규칙 4개 | `MEMORY_EVAL_EVIDENCE_RULES` |
| `factValueAll` / `factValueAny` 판정 | rule `v3-gold-match` |
| canonicalization 표와 **적용 순서** | `lib/memoryEvalCanonicalisation.ts` |
| 언어별 stem 목록 | `APPROVED_STEMS` — **비어 있음** |
| exact kind·polarity 매칭 | rule `v3-gold-match` |

**enum 이름만이 아니라 의미가 들어갑니다.** 이름만 넣으면 `negated`를 "감정이
부정적인 사실"로 재정의해도 digest가 움직이지 않고, 그 혼동이 이름을 이렇게 고른
이유입니다.

**canonicalization은 표와 순서가 **둘 다** 들어갑니다.** `2,000`은 구두점이
공백이 되기 **전에** 구분자를 잃어야 하고, 같은 항목을 다른 순서로 적용하는 표는
다른 matcher입니다. 반대로 조회표의 **키 순서**는 표현이므로 정렬 후 해시합니다 —
literal을 재배열한 merge에서 실패하면서 채점에 대해서는 아무것도 말하지 않는
digest는 쓸모가 없습니다.

### 11.2 들어가지 않은 것

거리 계산 코드, `K`, 미검수 `assertsGold`, 진단 통계. `tests/memoryEvalScoringContractDigest.test.mjs`의
「the distance diagnostic cannot reach the digest」가 descriptor에서 이들의 부재를
검사하고, `tests/memoryEvalPolarityDistance.test.mjs`가 digest 모듈이 calibration
모듈을 **참조하기만 해도** 실패시킵니다.

### 11.3 stem 목록이 비어 있는 것은 기록입니다

`mem-score-v3`로 작성된 dataset이 아직 없으므로 검수된 stem도 없습니다. 빈 목록은
placeholder가 아니라 **그 사실의 기록**이고, 첫 stem을 등록하면 digest가
움직입니다 — §2.1대로 그것은 새 scoring contract version입니다. succ-4 gold 작성
(실행 순서 5번)에서 stem이 필요해지면 `mem-score-v3.1`이 됩니다.

### 11.4 미구현 규칙 하나를 안고 동결했습니다

`v3-unfixable-evidence-emits-nothing`(§10.2의 5·6)은 v6 prompt와 gold 검수의
규칙이고 둘 다 아직 없습니다. **계약은 미구현 규칙을 안고 동결할 수 있고,
dataset은 그 아래에서 동결될 수 없습니다** — 아무도 적용하지 않은 기준을 적용한
것처럼 인용하게 되기 때문입니다.

`memoryEvalScoringContractReadiness()`가 미구현 규칙을 이름으로 보고하고,
`npm run check:memory-eval-freeze`의 여덟 번째 조건이 **schema 3 dataset에
한해** 그것을 차단합니다. seed-11·succ-2·succ-3은 이전 계약에서 동결됐으므로
해당하지 않습니다 — 끝난 뒤에 쓰인 규칙을 요구하면 역사적 사실이 실패하는
검사가 됩니다.

### 11.5 계약 자체의 manifest

dataset manifest는 자기 계약 digest를 고정하되, **live 버전일 때만** 재계산합니다.
그래서 계약을 동결한 날에는 모든 dataset entry가 이전 버전을 가리키고 **저장소의
어떤 것도 새 계약의 digest를 재계산하지 않습니다.** 조항이 가장 손보기 쉽고 가장
눈에 안 띄는 시기가 정확히 그때입니다.

그래서 계약은 **무언가가 그 아래에서 채점될 때가 아니라 동결될 때** 고정합니다.
`verifyScoringContractManifest()`가 descriptor를 재계산해 대조하고,
`tests/memoryEvalDatasetManifests.test.mjs`가 상수를 글자 그대로 검증합니다.

### 11.6 기존 dataset은 그대로입니다

seed-11·succ-2·succ-3의 **dataset digest 세 개와 succ-2·succ-3의 계약 digest 두
개는 한 글자도 바뀌지 않았습니다.** 두 entry는 이제 `superseded`로 보고되며 계약
digest를 재계산하지 않습니다 — 재계산하면 각 manifest가 자기 run이 본 적 없는
계약을 기술하게 됩니다. 계약에 의존하지 않는 것(개수, cell 수, batch digest,
dataset digest)은 전과 똑같이 정확히 검사됩니다.

### 11.7 이번 단계에서 하지 않은 것

succ-4 dataset 동결, pair 등록, 예산 승인. 전부 이후 단계입니다.

## 12. succ-4 gold 판독 결정 (2026-08-28 승인, @mposition)

121건 판독 보고에 대한 네 결정입니다. **353건 배정보다 먼저** 기록합니다 —
기준이 사례를 따라가면 그것은 기준이 아닙니다.

### 12.1 B+는 계약 규칙 형성에도 적용합니다

**scorer·gold 작성 의미를 decision case에서 도출하면 평가기가 그 사례에
맞춰진 것입니다.** 모델 prompt에 직접 노출되지 않았다는 이유로 독립성이
회복되지는 않습니다. §11 이전의 읽기 — B+가 모델을 향한 규칙만 덮는다는 —
는 기각됐습니다.

경계는 **형성과 적용**입니다.

| | |
|---|---|
| 규칙을 **만들거나 수정·선택**하는 데 쓰임 | **B+ 이동** |
| **이미 동결된** 규칙으로 polarity만 배정 | 유지 가능 |

### 12.2 수정된 일곱 건은 정정 후 이동합니다

match target이나 evidence anchor가 달라진 gold는 decision set에 그대로 남기지
않습니다. 수정된 gold는 regression corpus에 **수정된 형태로** 보존하고,
provenance에 수정 사유와 규칙 ID를 적고, decision set에는 1:1 대체를 씁니다.

### 12.3 stem과 `factValueAny`는 용도로 나눕니다

| 상황 | 도구 |
|---|---|
| 같은 lexeme의 **생산적인 활용형** 차이 | 승인된 stem |
| **유한하게 열거 가능한** 철자·표기·어휘 대안 | `factValueAny` |
| 의미가 넓어지는 동의어 · polarity 차이 · 추상화 수준 차이 | **둘 다 아님 — gold 재작성** |

`알레르기`/`알러지`는 표기 대안이므로 `factValueAny`가 맞습니다. 활용형을
케이스마다 나열하는 것은 stem이 할 일입니다.

**version bump를 피하려는 것은 선택 근거가 되지 않습니다.** §11.3에서 제가
`allerg` 대신 `factValueAny`를 고른 이유 중 하나가 그것이었고, 그 부분은
근거로 인정되지 않습니다. `succ-assistant-en-305`는 `allergy`/`allergic`이
활용형이 아니라 열거 가능한 어휘 대안이므로 결과적으로 `factValueAny`가
맞지만, 이유는 다시 씁니다.

### 12.4 원인·결과가 섞이면 결과로 좁힙니다

**한 gold는 하나의 atomic proposition과 하나의 polarity만 갖습니다.**
`constraint`라면 실제 제약인 결과 쪽으로 좁힙니다.

원인을 따로 두는 것은 그것이 **저장 적격이고, 앞으로 쓸모 있고, 독립된 kind와
evidence를 가질 때**뿐입니다.

**`exhaustive`는 모든 절을 저장한다는 뜻이 아닙니다.** 저장 적격인 독립
기억을 모두 열거한다는 뜻입니다. 이 구분이 없으면 좁히기가 gold를 빠뜨리는
것처럼 보입니다.

`succ-durable-ko-12`(휠체어 → 계단)와 `succ-durable-en-19`(deaf → audio)의
결과 쪽 좁히기는 승인됐습니다.

### 12.5 121건은 형성 101 + 적용 20이 아닙니다

보고서의 121건을 §12.1 경계로 다시 나눈 결과입니다. 판정은 **그 gold를 볼
당시 규칙이 이미 동결돼 있었는가**입니다.

**형성 — 이동 (99 케이스)**

* **negation marker가 quote에 있던 93 케이스 전부.** polarity 배정 규칙
  (`mem-score-v3.2`)이 쓰이기 전에 101건 gold 전부가 눈앞에 있었고, 규칙은
  그것들을 보고 쓰였습니다. 「야간 운전은 못 합니다」의 양가성이 규칙을 쓰게
  만들었고, `succ-durable-en-3`(oven 하나 있음)와 `succ-durable-en-110`(oven
  없음)의 대비가 polarity를 *factValueAll이 성립하는가*로 정하게 했으며,
  `aisle`·`penicillin`이 「표지가 있다고 negated가 아니다」를 정했습니다.
  나머지를 "그저 적용했다"고 주장할 수 없습니다 — 규칙이 아직 동결되지
  않은 상태에서 읽었습니다.
* **marker가 없던 20건 중 6 케이스**:
  * `succ-durable-en-20` — `gold-evidence-covers-fact`(v3.1)를 만든 사례.
  * `succ-assistant-ko-301` — `한양대에 다닌 적 없`은 §1②가 이미 인용한
    결함이며, 그 규칙을 만든 사례입니다.
  * `succ-assistant-ko-305` — under-specification 조항의 worked example.
  * `succ-assistant-en-305` — §12.3(stem 대 `factValueAny`)을 만든 사례.
  * `succ-durable-ko-301`, `succ-assistant-ko-308` — 규칙 형성은 아니지만
    §12.2에 따라 gold가 수정됐으므로 이동.

**적용 — 유지 (13 케이스)**

```
succ-durable-ko-25     succ-durable-ko-72     succ-durable-ko-193
succ-durable-ko-307    succ-durable-ko-309    succ-durable-ko-311
succ-durable-ko-312    succ-durable-ko-314    succ-durable-ko-315
succ-durable-en-306    succ-assistant-ko-307  succ-assistant-en-306
succ-assistant-en-307
```

전부 `mem-score-v3.2` 동결 **뒤에** 읽혔고, 동결된 규칙으로 polarity만
배정했으며, gold도 anchor도 바뀌지 않았습니다.

`succ-assistant-en-304`는 두 목록에 걸쳐 보이지만 한 케이스입니다 — `g1`은
marker 집합, `g2`는 아닙니다. 케이스 단위로 이동합니다.

### 12.6 합집합

**단순 합산이 아닙니다.** 기존 99건은 이미 succ-3에서 빠졌으므로 이번 99건과
겹치지 않고, 합집합은 198입니다.

| | |
|---|---|
| 기존 regression corpus (succ-2 → succ-3) | 99 |
| 이번 이동 (succ-3 → succ-4) | 99 |
| **합집합 (겹침 0)** | **198** |

이번 99건의 cell 분포이며, 그대로 대체 케이스 수입니다.

| cell | 이동 |
|---|---|
| durable_facts:en | 53 |
| durable_facts:ko | 32 |
| assistant_only:ko | 7 |
| assistant_only:en | 5 |
| injection_directives:en | 2 |

이동 케이스 중 일부는 그 자체가 기존 99건의 대체본입니다
(`succ-durable-ko-301`은 batch-162 소속). ID가 다르므로 합집합은 그대로
198이고, **두 번 대체되는 자리**가 있다는 사실은 provenance가 기록합니다.

### 12.7 `spoken for`·`constrained` 판정 (2026-08-28 승인, @mposition)

| gold | 이전 | 확정 |
|---|---|---|
| `succ-durable-en-129:e1` (`weekend`) | affirmed | **negated** |
| `succ-durable-ko-129:e1` (`주말`) | negated | negated (유지) |
| `succ-durable-en-316:g2` (`space`) | affirmed | **negated** |

**`spoken for`와 `constrained`는 문법적으로 긍정형이지만 canonical proposition
— 주말과 공간의 가용성 — 을 부정합니다.** 의미가 같은 사실의 polarity가 표현
방식에 따라 갈리면 **paraphrase에 따라 채점이 바뀝니다.** 그것은 추출을 재는
것이 아닙니다.

제가 batch 8에서 en-129를 affirmed로 읽은 것은 §12.5의 배정 규칙을 「주 서술의
문법적 극성」으로만 좁게 적용한 결과였고, 규칙이 명시한 *"factValueAll을
사용자에 대해 주장하는가"* 는 문법형이 아니라 명제를 묻습니다. 배정 규칙 자체는
바뀌지 않았습니다.

**label만 뒤집어 decision set에 두지 않습니다.** 세 gold는 §12.5의
under-specification 조항에도 걸립니다 — `["weekend"]`와 `["space"]`는 predicate가
아니라 topic만 이름 붙이므로, 반대 polarity의 문장도 같은 token을 전부 담을 수
있습니다. 그래서 **case 단위로 regression corpus에 이동하고**, predicate가 명확한
사례로 교체합니다.

**새 규칙이 아니라 동결된 규칙의 적용입니다.** 그래서 이동 사유는
`gold-corrected-under-specified`이며, 규칙을 만든 케이스를 뜻하는
`contract-under-specification`과 구분합니다.

### 12.8 B+ 합집합 정정 — 99 → 101

`ko-129`는 이미 목록에 있었습니다(polarity 배정 규칙으로 이동). 새로 더해지는
것은 **`en-129`와 `en-316` 둘**뿐입니다.

| | |
|---|---|
| 기존 corpus (succ-2 → succ-3) | 99 |
| succ-3 → succ-4 이동 | **101** (121 판독 99 + batch 판독 2) |
| **합집합** | **200** |

| cell | 이동 |
|---|---|
| durable_facts:en | **55** (53 + 2) |
| durable_facts:ko | 32 |
| assistant_only:ko | 7 |
| assistant_only:en | 5 |
| injection_directives:en | 2 |

succ-4 조립은 **교체 101건 + schema 3 relabelling 1,049건**입니다.

`Succ4Move`에 `from` field를 넣어 두 출처를 구분합니다. 넣지 않으면 「99건이
이동하고 13건이 남았다」가 무엇에 대해서도 검사되지 않는 문장이 됩니다 — 나중에
이동한 케이스는 121 판독의 대상이 아니었으므로 그 산술에 섞이면 안 됩니다.

**`en-316`은 case 전체가 이동하므로 `g1`(`artist`)도 함께 갑니다.** 잘못 읽힌
것은 `g2`뿐이지만 §12.2는 case 단위입니다. 그리고 `en-316`은 그 자체가 rule-4로
`succ-durable-en-57`을 대체하려고 쓴 케이스이므로 provenance는
**`en-57 → en-316 → 새 replacement`**로 보존하고, 새 대체 사례는 가능하면 기존의
두-gold 구조를 유지합니다.
