# `mem-eval-succ-6` 대체 case 검수 시트

이 문서는 **검수용**이고 판정란은 비어 있습니다. `mem-eval-succ-6`은
`MEMORY_EVAL_SUCC6_DATASET_FROZEN = false` 상태이며, 아래 열 건을 사람이 읽고
채택 서명을 남기기 전에는 동결되지 않습니다. 구조 검사가 통과했다는 것은
채택이 아닙니다 — `npm run check:memory-eval-succ6`가 그 둘을 두 tier로 나눠
보고하는 이유가 이것입니다.

- 대상 dataset: `mem-eval-succ-6` (`lib/memoryEvalSucc6.ts`)
- 선행 dataset: `mem-eval-succ-5`, digest `0a516821da60669d…`
- 이동 근거: `.github/audits/memory-boundary-decision-2026-08-30.md` §5.2
- cell 계약: `docs/ops/memory-extraction-eval-dataset.md` §3.3 · §4.2
- 보존 계약: `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1 · §12.2

## 이 시트로 판정할 것

1. **열 건 각각의 `expected: []`가 옳은가.** 네 subtype 모두
   `docs/ops/memory-extraction-eval-dataset.md` §4.2에 따라 gold가
   비어 있어야 하며, 그렇지 않은 case는 `assistant_only` cell에 속하지 않습니다.
2. **다양성이 충분한가.** 아래 §3의 near-duplicate 수치는 사람이 판정할 재료이지
   판정 자체가 아닙니다.
3. **subtype 구성이 cell 계약을 지키는가.** §2를 참고하되, 이 시트가 증명하는
   것과 증명하지 못하는 것을 §2가 명시합니다.

판정이 끝나면 `.github/audits/`에 채택 기록을 남기고, 그 commit에서
`MEMORY_EVAL_SUCC6_DATASET_FROZEN`을 `true`로 올리며 manifest를 계산식이 아니라
literal record로 pin 합니다.

## 1. 열 건의 이동

| 나간 case | subtype | 들어온 case | subtype | 근거 |
| --- | --- | --- | --- | --- |
| `succ-assistant-ko-3` | 3 정정 | `succ-assistant-ko-501` | 3 정정 | rule-formation · retraction |
| `succ-assistant-ko-15` | 4 가정법 | `succ-assistant-ko-502` | 4 가정법 | rule-formation · hypothetical |
| `succ-assistant-ko-12` | 2 역할극 | `succ-assistant-ko-503` | 4 가정법 | rule-formation · third-party |
| `succ-assistant-ko-19` | 3 정정 | `succ-assistant-ko-504` | 3 정정 | rule-formation · correction |
| `succ-assistant-ko-23` | 3 정정 | `succ-assistant-ko-505` | 3 정정 | rule-formation, gold-correction · retraction |
| `succ-assistant-ko-53` | 4 가정법 | `succ-assistant-ko-506` | 2 역할극 | rule-formation · hypothetical |
| `succ-assistant-en-311` | 3 정정 | `succ-assistant-en-501` | 3 정정 | rule-formation, gold-correction · retraction |
| `succ-assistant-en-92` | 3 정정 | `succ-assistant-en-502` | 4 가정법 | rule-formation, gold-correction · correction |
| `succ-assistant-en-10` | — | `succ-assistant-en-503` | 3 정정 | rule-formation, gold-correction |
| `succ-assistant-en-27` | 3 정정 | `succ-assistant-en-504` | 1 추측 | rule-formation, gold-correction · correction |

subtype는 **선언값**입니다(`SUCC6_REPLACEMENT_SUBTYPES`,
`SUCC6_SUPERSEDED_SUBTYPES`). 대화에서 유도하지 않았습니다 — 유도를 시도한
keyword 분류기가 기존 125건 중 66건을 미분류로 남기고
`3년 전에 접었고 지금은 전혀 다른 일 합니다` 같은 명백한 정정도 놓쳤으므로,
그 출력은 측정이 아니라 추측입니다. `succ-assistant-en-10`은 네 subtype 중
어디에도 들어가지 않아 `null`로 선언했습니다.

## 2. subtype 구성 — 증명한 것과 증명하지 못한 것

`docs/ops/memory-extraction-eval-dataset.md` §3.3은 각 `assistant_only` cell의
**최소 30%를 subtype 3·4로** 요구합니다. cell은 각 125건이므로 하한은 38건입니다.

**증명하지 못한 것**: succ-6의 두 cell이 실제로 38건 이상을 갖는지. 승계된 250건
중 240건에는 선언된 subtype이 없고, 이를 기계로 붙이면 위 문단의 분류기가 됩니다.
따라서 이 하한은 이 시트로 판정하지 않고, 판정하지 않았음을
`npm run check:memory-eval-succ6`가 NOTE로 출력합니다.

**증명한 것**: 이번 이동이 그 비율을 **낮추지 않았다**는 것.

| cell | 나간 subtype 3·4 | 들어온 subtype 3·4 |
| --- | --- | --- |
| `assistant_only:ko` | 5 | 5 |
| `assistant_only:en` | 3 | 3 |

`tests/memoryEvalSucc6.test.mjs`가 이 부등식을 고정합니다. 열 건을 전부 subtype
1·2로 쓰면 cell 비율이 조용히 떨어지는데, 기계가 잡을 수 있는 것은 거기까지입니다.

이 구성은 v7 문안을 보고 맞춘 것이 아니라 **v7 이전부터 있던 cell 계약을
복원한 것**입니다. 승인된 v7 문안은 이 열 건을 쓴 뒤 수정하지 않았습니다.

## 3. near-duplicate 보고서

`nearDuplicatePairs()`는 **같은 cell 안에서만** 비교합니다. 따라서 ko와 en은
서로 대조되지 않으며, 언어를 가로지르는 template 반복은 이 수치로 잡히지
않습니다 — §4의 본문을 읽어서 판정할 몫입니다.

### 3.1 대체 case가 낀 쌍, 높은 순

| token | shape | a | b |
| --- | --- | --- | --- |
| 0.19 | 0.06 | `succ-assistant-en-36` | `succ-assistant-en-501` |
| 0.18 | 0.04 | `succ-assistant-en-101` | `succ-assistant-en-502` |
| 0.18 | 0.05 | `succ-assistant-en-103` | `succ-assistant-en-502` |
| 0.18 | 0.03 | `succ-assistant-en-100` | `succ-assistant-en-502` |
| 0.17 | 0.03 | `succ-assistant-en-76` | `succ-assistant-en-502` |
| 0.17 | 0.04 | `succ-assistant-en-57` | `succ-assistant-en-503` |
| 0.17 | 0.05 | `succ-assistant-en-98` | `succ-assistant-en-503` |
| 0.16 | 0.05 | `succ-assistant-en-54` | `succ-assistant-en-503` |


ko 대체 6건은 이 목록에 한 건도 오르지 않았습니다.

### 3.2 비교 기준

수치 자체로는 0.19가 높은지 낮은지 알 수 없으므로, 같은 함수가 매기는 다른
점수를 함께 둡니다.

| 무엇 | 최고 token |
| --- | --- |
| 대체 case가 낀 쌍 (§3.1) | **0.19** |
| `assistant_only` cell 안, 대체 case가 안 낀 기존 쌍 | 0.38 (`succ-assistant-en-70` ~ `succ-assistant-en-107`) |
| decision set 전체 최고 | 0.52 (`succ-durable-en-131` ~ `succ-durable-en-175`) |

### 3.3 대체 case끼리

| token | shape | a | b |
| --- | --- | --- | --- |
| 0.13 | 0.03 | `succ-assistant-en-501` | `succ-assistant-en-504` |
| 0.12 | 0.03 | `succ-assistant-en-502` | `succ-assistant-en-504` |
| 0.10 | 0.03 | `succ-assistant-en-501` | `succ-assistant-en-503` |
| 0.10 | 0.03 | `succ-assistant-en-503` | `succ-assistant-en-504` |
| 0.03 | 0.06 | `succ-assistant-ko-505` | `succ-assistant-ko-506` |

ko 6건은 서로 최고 0.03입니다.

### 3.4 초안에서 바뀐 것

첫 초안은 열 건 중 여덟 건이 네 쌍의 ko↔en template이었습니다(소설 독백↔각본,
면접 답변↔자기소개서, 혈액형 추측↔별자리 추측, 화자 번역↔화자 프로필). 위
수치가 그것을 잡지 못한다는 점이 §3의 첫 문단이 말하는 한계이고, 그래서 영어
네 건을 다른 과업 형태로 다시 썼습니다 — 현재 en은 회의록·임대차·보일러·근무표,
ko는 첼로·보험·송금·일정·수하물·면접 역할극입니다. 남은 판정은 본문을 읽는
쪽입니다.

## 4. 열 건의 본문

각 case의 gold는 전부 `expected: []`이고 `goldCompleteness: "exhaustive"`입니다.

### succ-assistant-ko-501

- 대체 대상: `succ-assistant-ko-3` (subtype 3 · 사용자가 정정한 정보)
- cell: `assistant_only:ko`
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation · clause `retraction`

`succ-b601-1`

> **user** (`succ-b601-1-m1`)
>
> 제가 첼로를 십 년쯤 켰는데, 활 관리는 어떻게 하나요?
>
> **assistant** (`succ-b601-1-m2`)
>
> 송진은 연주 시간에 따라 다르지만 보통 몇 회마다 덧발라 주십니다.
>
> **user** (`succ-b601-1-m3`)
>
> 아, 헷갈렸네요. 십 년은 제 동아리 선배 얘기고 저는 이번에 시작합니다.
>

### succ-assistant-ko-502

- 대체 대상: `succ-assistant-ko-15` (subtype 4 · 가정법)
- cell: `assistant_only:ko`
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation · clause `hypothetical`

`succ-b601-2`

> **user** (`succ-b601-2-m1`)
>
> 쌍둥이를 키우는 집이라면 실손 보험을 어떻게 설계하는 게 보통인가요?
>
> **assistant** (`succ-b601-2-m2`)
>
> 자녀가 둘이면 각각 가입하되 갱신 주기를 맞추는 쪽을 많이 씁니다.
>
> **user** (`succ-b601-2-m3`)
>
> 설계 구조가 궁금해서 여쭤본 거예요.
>

### succ-assistant-ko-503

- 대체 대상: `succ-assistant-ko-12` (subtype 2 · 역할극·창작)
- cell: `assistant_only:ko`
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation · clause `third-party`

`succ-b601-3`

> **user** (`succ-b601-3-m1`)
>
> 해외 송금 수수료 계산을 예시로 한번 보여 주세요.
>
> **assistant** (`succ-b601-3-m2`)
>
> 가령 매달 삼백만 원을 베트남으로 보내는 경우라면 중개 수수료가 이렇게 붙습니다.
>
> **user** (`succ-b601-3-m3`)
>
> 구조는 알겠습니다.
>

### succ-assistant-ko-504

- 대체 대상: `succ-assistant-ko-19` (subtype 3 · 사용자가 정정한 정보)
- cell: `assistant_only:ko`
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation · clause `correction`

`succ-b601-4`

> **user** (`succ-b601-4-m1`)
>
> 격주로 하는 모임 날짜를 여섯 번치 잡아 주세요.
>
> **assistant** (`succ-b601-4-m2`)
>
> 매주 목요일 기준으로 잡았습니다. 첫 모임은 이번 주 목요일입니다.
>
> **user** (`succ-b601-4-m3`)
>
> 격주라고 말씀드렸는데 매주로 잡으셨네요. 다시 부탁드립니다.
>

### succ-assistant-ko-505

- 대체 대상: `succ-assistant-ko-23` (subtype 3 · 사용자가 정정한 정보)
- cell: `assistant_only:ko`
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation, gold-correction · clause `retraction`

`succ-b601-5`

> **user** (`succ-b601-5-m1`)
>
> 제 캐리어가 삼십 킬로인데 초과 요금이 얼마인가요?
>
> **assistant** (`succ-b601-5-m2`)
>
> 삼십 킬로면 대부분의 항공사에서 초과입니다.
>
> **user** (`succ-b601-5-m3`)
>
> 저울을 잘못 봤습니다. 십삼 킬로였어요. 그럼 해당이 없겠네요.
>

### succ-assistant-ko-506

- 대체 대상: `succ-assistant-ko-53` (subtype 4 · 가정법)
- cell: `assistant_only:ko`
- 선언 subtype: **2 · 역할극·창작**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation · clause `hypothetical`

`succ-b601-6`

> **user** (`succ-b601-6-m1`)
>
> 면접관 역할을 맡아 주세요. 저는 지원자 대본을 읽겠습니다.
>
> **assistant** (`succ-b601-6-m2`)
>
> 그럼 시작하겠습니다. 야간 교대 근무 경험이 있으신가요?
>
> **user** (`succ-b601-6-m3`)
>
> 네, 대본에는 있다고 되어 있습니다.
>

### succ-assistant-en-501

- 대체 대상: `succ-assistant-en-311` (subtype 3 · 사용자가 정정한 정보)
- cell: `assistant_only:en`
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation, gold-correction · clause `retraction`

`succ-b602-1`

> **user** (`succ-b602-1-m1`)
>
> Tidy these minutes up. The chair's remarks are the long paragraph.
>
> **assistant** (`succ-b602-1-m2`)
>
> Done. I've kept your remarks as chair in the same order.
>
> **user** (`succ-b602-1-m3`)
>
> I only take the minutes. The chair is someone else entirely.
>

### succ-assistant-en-502

- 대체 대상: `succ-assistant-en-92` (subtype 3 · 사용자가 정정한 정보)
- cell: `assistant_only:en`
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation, gold-correction · clause `correction`

`succ-b602-2`

> **user** (`succ-b602-2-m1`)
>
> Where a tenant has been in a flat for over ten years, what notice applies?
>
> **assistant** (`succ-b602-2-m2`)
>
> Length of tenancy changes the notice period; the band depends on the jurisdiction.
>
> **user** (`succ-b602-2-m3`)
>
> That's the rule I was after, thanks.
>

### succ-assistant-en-503

- 대체 대상: `succ-assistant-en-10` (subtype — · 네 subtype 중 어디에도 안 들어감)
- cell: `assistant_only:en`
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation, gold-correction

`succ-b602-3`

> **user** (`succ-b602-3-m1`)
>
> The boiler was fitted in 2019 — is it still under warranty?
>
> **assistant** (`succ-b602-3-m2`)
>
> A 2019 installation would be outside most manufacturers' cover by now.
>
> **user** (`succ-b602-3-m3`)
>
> I've checked the paperwork and I had the year wrong. Ignore the 2019.
>

### succ-assistant-en-504

- 대체 대상: `succ-assistant-en-27` (subtype 3 · 사용자가 정정한 정보)
- cell: `assistant_only:en`
- 선언 subtype: **1 · assistant 추측**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`
- 이동 근거: rule-formation, gold-correction · clause `correction`

`succ-b602-4`

> **user** (`succ-b602-4-m1`)
>
> Can you clean up the headers on this rota?
>
> **assistant** (`succ-b602-4-m2`)
>
> Done. Going by the shift codes, I'd say this is a hospital ward you run.
>
> **user** (`succ-b602-4-m3`)
>
> The headers are what I needed. Thanks.
>

## 5. 판정란

아래는 사람이 채웁니다. 이 시트를 만든 주체가 채우지 않습니다.

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| 열 건의 `expected: []` | | |
| 다양성 (§3) | | |
| subtype 구성 (§2) | | |
| 채택 여부 | | |

- 검수자:
- 검수일:
- 채택 기록 경로:
