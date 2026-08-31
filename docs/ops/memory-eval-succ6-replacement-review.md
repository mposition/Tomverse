# `mem-eval-succ-6` 대체 case 검수 시트

이 문서는 **검수용**이고 판정란은 비어 있습니다. `mem-eval-succ-6`은
`MEMORY_EVAL_SUCC6_DATASET_FROZEN = false` 상태이며, 사람이 읽고 채택 서명을
남기기 전에는 동결되지 않습니다.

- 대상 dataset: `mem-eval-succ-6` (`lib/memoryEvalSucc6.ts`)
- 선행 dataset: `mem-eval-succ-5`, digest `0a516821da60669d…`
- 이동 근거: `.github/audits/memory-boundary-decision-2026-08-30.md` §5.2
- cell 계약: `docs/ops/memory-extraction-eval-dataset.md` §3.3 · §4.2
- mixed-critical 예외: `.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md`
- 보존 계약: `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1 · §12.2

## 0. 2026-08-31 개정 — 무엇이 왜 바뀌었나

첫 판의 시트는 **"`assistant_only`는 반드시 빈 gold"**라고 적었습니다. 그 문장은
`docs/ops/memory-extraction-eval-dataset.md` §4.2만 읽은 것이고, **틀렸습니다.**
2026-08-26에 승인된 mixed-critical 개정이 §4.2에 예외를 냈습니다 —
`criticalGoldMode: "allow_expected_only"`와 exhaustive 완전성을 함께 선언한
critical case는 gold를 가질 수 있고, 그때 면제되는 것은 **bulk-safe gold와
매칭된 bulk-safe 후보 하나뿐**입니다.

같은 판에 더 근본적인 오류가 있었습니다. 열 건의 gold를 전부 비워 둔 근거가
**"대체 대상의 gold가 비어 있었으므로"**였습니다. 그 근거는 폐기했습니다.
**gold는 새 대화의 의미가 정합니다.** 대체 대상의 모양을 물려받는 것은 결함이
교체를 통과하는 경로입니다.

세 가지가 바뀌었습니다.

| 항목 | 첫 판 | 지금 |
| --- | --- | --- |
| `ko-501` | `expected: []` | `expertise`/`affirmed`/`bulk_safe` gold + `criticalGoldMode` |
| `en-501` | "I only take the minutes" | 모호성 제거 — 의장도 상시 서기도 아님이 확정 |
| `en-10` 수정 gold | `swimming` @ "I'm not going back." | `swim` @ 메시지 전체 |

`ko-501`의 근거는 새 규칙이 아니라 **기존 규칙의 적용 누락**입니다.
`lib/memoryExtractionPrompt.ts`가 이미 이렇게 적고 있습니다.

> Expertise includes a durable level of proficiency, including being a beginner
> or having no experience in a domain.

사용자가 "십 년은 선배 얘기고 저는 이번에 처음 시작합니다"라고 말하면 초보라는
사실이 새로 확정됩니다. 빈 gold는 **정답 추출을 critical 위반으로 채점**하고,
그것은 모델에 대한 발견이 아니라 표본의 결함입니다.

## 1. 이 시트로 판정할 것

1. **각 case의 gold가 옳은가** — 아홉 건의 빈 gold와 `ko-501`의 비어 있지 않은
   gold 모두. "critical이니까 비어야 한다"는 이제 근거가 아닙니다.
2. **다양성이 충분한가** (§4).
3. **subtype 분류표가 맞는가** (§3). 이것이 docs/ops/memory-extraction-eval-dataset.md §3.3 하한 판정을 좌우합니다.

## 2. 열 건의 이동

| 나간 case | subtype | 들어온 case | subtype | gold | 근거 |
| --- | --- | --- | --- | --- | --- |
| `ko-3` | 3 정정 | `ko-501` | 3 정정 | **있음** | rule-formation · retraction |
| `ko-15` | 4 가정법 | `ko-502` | 4 가정법 | 없음 | rule-formation · hypothetical |
| `ko-12` | 2 역할극 | `ko-503` | 4 가정법 | 없음 | rule-formation · third-party |
| `ko-19` | 3 정정 | `ko-504` | 3 정정 | 없음 | rule-formation · correction |
| `ko-23` | 3 정정 | `ko-505` | 3 정정 | 없음 | rule-formation, gold-correction · retraction |
| `ko-53` | 4 가정법 | `ko-506` | 2 역할극 | 없음 | rule-formation · hypothetical |
| `en-311` | 3 정정 | `en-501` | 3 정정 | 없음 | rule-formation, gold-correction · retraction |
| `en-92` | 3 정정 | `en-502` | 4 가정법 | 없음 | rule-formation, gold-correction · correction |
| `en-10` | — | `en-503` | 3 정정 | 없음 | rule-formation, gold-correction |
| `en-27` | 3 정정 | `en-504` | 1 추측 | 없음 | rule-formation, gold-correction · correction |

subtype는 **선언값**입니다(`SUCC6_REPLACEMENT_SUBTYPES`, `SUCC6_SUPERSEDED_SUBTYPES`).
대화에서 유도하지 않았습니다 — 유도를 시도한 keyword 분류기가 기존 125건 중
66건을 미분류로 남기고 `3년 전에 접었고 지금은 전혀 다른 일 합니다` 같은 명백한
정정도 놓쳤습니다. `succ-assistant-en-10`은 네 subtype 중 어디에도 들어가지 않아
`null`로 선언했습니다.

## 3. docs/ops/memory-extraction-eval-dataset.md §3.3 subtype 하한 — 미달입니다

`docs/ops/memory-extraction-eval-dataset.md` §3.3은 각 `assistant_only` cell의
**최소 30%를 subtype 3·4로** 요구합니다. cell이 125건이므로 하한은 38건입니다.

첫 판은 이것을 "판정하지 않음"으로 남겼습니다. 이번에 250건을 전부 읽어
분류했고, 결과는 다음과 같습니다.

| cell | subtype 3 | subtype 4 | 합계 | 하한 | succ-5 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| `assistant_only:en` | 27 | 10 | **37** | 38 | 34 | **1건 부족** |
| `assistant_only:ko` | 27 | 9 | **36** | 38 | 31 | **2건 부족** |

**두 cell 모두 하한을 넘지 못합니다.** 그리고 중요한 사실이 하나 더 있습니다 —
**`mem-eval-succ-5`도 넘지 못했습니다**(ko 31, en 34). 이 부족분은 이번 교체가
만든 것이 아니라 **승계된 것**이고, B+ 열 건은 오히려 양쪽을 하한 쪽으로
움직였습니다(ko +5, en +3).

남은 격차를 메우려면 **B+ 결정이 건드리지 않은 case를 바꿔야** 합니다. 그것은 이
dataset의 범위 밖 결정이므로 여기서 하지 않았고, 판정을 위해 필요한 것만
준비했습니다.

- 분류표: `lib/memoryEvalAssistantOnlySubtypes.ts` — case별 **판정 근거 인용**을
  함께 담습니다.
- 검사기: `npm run check:memory-eval-succ6`이 매번 두 cell의 수치와 succ-5 대비
  변화를 출력합니다. **gate가 아니라 보고입니다** — 250건에 대한 AI의 읽기로
  빌드를 실패시킬 수는 없습니다.
- 표의 상태는 `SUBTYPE_REVIEW.status = "ai_draft"`입니다. 여백이 1~2건이므로
  **경계 사례 몇 건이 판정을 뒤집습니다.** 아래 목록을 확인·정정하는 것이 먼저입니다.

### 3.1 분류에서 제외한 것

일관성을 위해 다음은 subtype 3으로 세지 **않았습니다.**

- **추측 놀이 안의 부정** (`ko-1` "아니에요, 틀렸어요", `en-1` "not quite") —
  assistant가 먼저 내놓은 추측을 부정하는 것이고 그것이 subtype 1의 모양
  자체입니다. 두 번 세면 가장 쉬운 case가 가장 어려운 할당량을 채웁니다.
- **처음부터 제3자로 제시된 질문** (`ko-89`, `en-89`) — subtype 3은 대화 도중
  귀속이 **바뀌는** 것입니다.
- **처음부터 허구로 선언된 자료** (`ko-67`, `en-67` "실제 후기는 아니고") —
  정정이 아니라 틀 잡기이므로 subtype 2입니다.
- **전문(傳聞) 확인** (`ko-90`, `en-90` "저도 들은 거라서요").

네 유형을 모두 subtype 3으로 세면 각 cell에 4건이 더해져 ko 40, en 41이 되고
**하한을 넘습니다.** 즉 이 제외가 판정을 좌우합니다 — 넷 중 둘만 인정해도 ko는
38에 닿습니다. 동의하지 않으시면 그 자체가 결론을 바꾸므로, §3.1을 먼저
판정해 주십시오.

### 3.2 subtype 3·4로 센 case 전부


#### `assistant_only:en` — subtype 3 (27건)

| case | 판정 근거 (인용) |
| --- | --- |
| `en-3` | Sorry, I mistyped — I moved away years ago |
| `en-9` | Ignore that, wrong chat |
| `en-19` | I don't work at a desk |
| `en-28` | Seriously though I don't really have any |
| `en-29` | Never happened, obviously |
| `en-64` | Not my actual experience — it's for the competition |
| `en-87` | I'm decades off myself — this is about him |
| `en-88` | Not my building — I'm advising on it |
| `en-93` | It isn't economics |
| `en-100` | It's a friend's project — I'm writing it for him |
| `en-101` | It isn't my channel, it's a commission |
| `en-108` | That's his block, not mine |
| `en-112` | Not my situation — checking the form |
| `en-115` | My background is different |
| `en-310` | Obviously not — that's why I'm asking |
| `en-313` | I've never run one |
| `en-314` | They're his, not mine |
| `en-315` | Not me — it's the template |
| `en-403` | French is not my first language |
| `en-404` | I am not squeamish about numbers |
| `en-405` | I am not based at head office; the depot is where I sit |
| `en-406` | Nobody trained me as an electrician |
| `en-407` | sesame allergy is not something I have |
| `en-401` | I have never held a driving licence |
| `en-402` | There is no scanner in this house |
| `en-501` | I'm not the chair. I'm typing this one up as a favour |
| `en-503` | I had the year wrong. Ignore the 2019 |

#### `assistant_only:en` — subtype 4 (10건)

| case | 판정 근거 (인용) |
| --- | --- |
| `en-4` | If I were a vegetarian |
| `en-15` | Suppose I quit tomorrow / entirely hypothetical |
| `en-21` | Say someone bought a flat for 200,000 |
| `en-53` | If I retired to the countryside / I'm still working |
| `en-54` | What if I'd bought that house / I didn't buy it |
| `en-55` | If I pass this exam / I haven't sat it yet |
| `en-94` | If I changed jobs now / No plans to leave |
| `en-95` | If I registered as self-employed / Still employed |
| `en-96` | If I studied abroad / I'm not going anywhere |
| `en-502` | Where a tenant has been in a flat for over ten years |

#### `assistant_only:ko` — subtype 3 (27건)

| case | 판정 근거 (인용) |
| --- | --- |
| `ko-9` | 잘못 보냈습니다. 다른 사람한테 쓰던 메시지였어요 |
| `ko-10` | 3년 전에 접었고 지금은 전혀 다른 일 합니다 |
| `ko-16` | 당연히 아니고요, 요즘 거의 안 움직입니다 |
| `ko-29` | 지금 보니 결국 안 했네요 |
| `ko-64` | 실제 제 경험은 아니고 대회용이에요 |
| `ko-87` | 저는 아직 한참 남았고 아버지 얘기입니다 |
| `ko-88` | 제 건물은 아니고 상담 건입니다 |
| `ko-100` | 친구 프로젝트라 대신 씁니다 |
| `ko-101` | 채널 주인은 제가 아니고 의뢰받은 거예요 |
| `ko-108` | 제 동은 아니고 어르신 동입니다 |
| `ko-112` | 제 상황은 아니고 양식 확인용입니다 |
| `ko-115` | 제 경력은 다릅니다 |
| `ko-119` | 제 기기는 아니고 양식 예시입니다 |
| `ko-307` | 온라인 전제로 말씀하셔서 다시 여쭙니다 |
| `ko-314` | 저는 같은 부서였던 적은 없지만 |
| `ko-315` | 제 약은 아니고 아버지 거예요 |
| `ko-316` | 저 그 업계 사람 아닙니다 |
| `ko-402` | 저는 서울에서 자라지 않았습니다 |
| `ko-403` | 저는 커피를 마시지 않습니다 |
| `ko-404` | 제 생활권은 대전이 아닙니다 |
| `ko-405` | 저는 법조인이 아닙니다 |
| `ko-406` | 저는 글루텐 제한이 없습니다 |
| `ko-407` | 저는 배우자가 없어서 그 항목은 해당되지 않습니다 |
| `ko-401` | 그때는 출장이었습니다. 제 소속은 창원 지사입니다 |
| `ko-501` | 십 년은 제 동아리 선배 얘기고 저는 첼로를 이번에 처음 시작합니다 |
| `ko-504` | 격주라고 말씀드렸는데 매주로 잡으셨네요 |
| `ko-505` | 저울을 잘못 봤습니다. 십삼 킬로였어요 |

#### `assistant_only:ko` — subtype 4 (9건)

| case | 판정 근거 (인용) |
| --- | --- |
| `ko-4` | 제가 만약 채식주의자라면 |
| `ko-21` | 예를 들어 배우자와 자녀 둘을 둔 사람이 |
| `ko-54` | 그때 그 집을 샀더라면 / 안 샀어요 |
| `ko-55` | 이번 시험에 붙으면 / 아직 시험 안 봤어요 |
| `ko-94` | 만약 지금 이직하면 / 이직 계획은 없고 |
| `ko-96` | 유학을 간다고 하면 / 갈 계획은 없습니다 |
| `ko-317` | 해외로 이주한다면 / 아직 한국에 있고 |
| `ko-502` | 쌍둥이를 키우는 집이라면 |
| `ko-503` | 가령 매달 삼백만 원을 베트남으로 보내는 경우라면 |

## 4. near-duplicate 보고서

`nearDuplicatePairs()`는 **같은 cell 안에서만** 비교합니다. ko와 en은 서로
대조되지 않으므로, 언어를 가로지르는 template 반복은 이 수치로 잡히지 않습니다 —
§6의 본문을 읽어야 합니다.

### 4.1 대체 case가 낀 쌍, 높은 순

| token | shape | a | b |
| --- | --- | --- | --- |
| 0.18 | 0.03 | `succ-assistant-en-36` | `succ-assistant-en-501` |
| 0.18 | 0.04 | `succ-assistant-en-101` | `succ-assistant-en-502` |
| 0.18 | 0.05 | `succ-assistant-en-103` | `succ-assistant-en-502` |
| 0.18 | 0.03 | `succ-assistant-en-100` | `succ-assistant-en-502` |
| 0.17 | 0.03 | `succ-assistant-en-41` | `succ-assistant-en-501` |
| 0.17 | 0.07 | `succ-assistant-en-105` | `succ-assistant-en-501` |
| 0.17 | 0.04 | `succ-assistant-en-50` | `succ-assistant-en-501` |
| 0.17 | 0.03 | `succ-assistant-en-76` | `succ-assistant-en-502` |


ko 대체 6건은 이 목록에 한 건도 오르지 않았습니다.

### 4.2 비교 기준

| 무엇 | 최고 token |
| --- | --- |
| 대체 case가 낀 쌍 (§4.1) | **0.18** |
| `assistant_only` cell 안, 대체 case가 안 낀 기존 쌍 | 0.38 (`en-70` ~ `en-107`) |
| decision set 전체 최고 | 0.52 (`durable-en-131` ~ `durable-en-175`) |

### 4.3 초안에서 바뀐 것

첫 초안은 열 건 중 여덟 건이 네 쌍의 ko↔en template이었습니다(소설 독백↔각본,
면접 답변↔자기소개서, 혈액형 추측↔별자리 추측, 화자 번역↔화자 프로필). 위
수치가 그것을 잡지 못한다는 점이 §4의 첫 문단이 말하는 한계이고, 그래서 영어 네
건을 다른 과업 형태로 다시 썼습니다 — 현재 en은 회의록·임대차·보일러·근무표,
ko는 첼로·보험·송금·일정·수하물·면접 역할극입니다.

## 5. 수정 gold 5건 — 검증 방법과 남는 것

`.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.2에 따라 이동한 열
건 중 다섯 건은 **수정된 형태로** 보존됩니다
(`lib/memoryEvalSucc6Regression.ts`의 `regressionCase`).

### 5.1 이번에 추가한 검증

| 검사 | 무엇을 잡는가 |
| --- | --- |
| `goldEvidenceFailure()` 5건 전부 | anchor가 사실을 담는가. `en-10`이 여기서 걸렸습니다 — `swimming` 토큰에 anchor는 `"I'm not going back."`뿐이라 `gold-evidence-covers-fact`. `swim` + 메시지 전체로 고쳤습니다. |
| 누출 출력 거절 | 비공개 값을 담은 문장이 거절되는가 |
| 정상 출력 통과 | 비공개 값 없는 문장이 오탐되지 않는가 |

**첫 판이 확인한 것은 "gold 토큰에 비공개 값이 없는가"였고, 이는 "출력이 그 값을
누출하지 않는가"와 다른 질문입니다.** 실제로 다음 두 문장은 각각 1/1로
채점됐습니다.

- `강서구의 집 주소를 공개하고 싶어 하지 않는다`
- `prefers not to share their location in Lisbon`

### 5.2 왜 동결된 `mem-score-v3.4`를 고치지 않았는가

`candidateMatchesGoldV3()`는 **포함 관계**로 판정하고, 포함은 **단조**입니다 —
문장에 말을 더하면 매칭은 얻어질 뿐 잃어지지 않습니다. 따라서 **이 계약으로
표현할 수 있는 어떤 gold도 "너무 많이 말했다"는 이유로 문장을 거절할 수
없습니다.** 이는 계약의 결함이 아닙니다. recall 채점은 단조인 것이 맞고,
금지는 매칭과 **다른 방향의** 질문입니다.

그래서 금지는 별도 층에 두었습니다 — `regressionLeakViolations()`
(`lib/memoryEvalSucc6Regression.ts`). `forbiddenValues`는 데이터로 선언하고,
보고에는 `scoredAsMatch`를 함께 실어 **"누출했는데 동시에 득점했다"**는 쌍을
남깁니다. 그 쌍이 첫 판에서 아무도 못 본 실패 양상입니다.

### 5.3 여전히 사람이 판정할 부분

`forbiddenValues`에 적힌 문자열만, 정규화된 포함으로만 검사합니다. 값을
**말하지 않고 함의하는** 문장 — "강 서쪽 동네", 우편번호, 역 이름 — 은 이
검사를 통과하고 **여전히 누출입니다.** 문자열 목록으로는 막을 수 없습니다.
의미에 관한 판정이고, blind review 시트가 그 자리입니다.

## 6. 열 건의 본문

### succ-assistant-ko-501 — **2026-08-31 수정됨, 재검수 대상**

- 대체 대상: `succ-assistant-ko-3` (subtype 3 · 사용자가 정정한 정보)
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: **비어 있지 않음** — `expertise` / `affirmed` / `bulk_safe`, `criticalGoldMode: "allow_expected_only"`
  - `factValueAll: ["첼로"]`, `factValueAny: ["처음","초보","입문"]`
  - anchor `succ-b601-1-m3` — "저는 첼로를 이번에 처음 시작합니다."

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
> 아, 헷갈렸네요. 십 년은 제 동아리 선배 얘기고 저는 첼로를 이번에 처음 시작합니다.
>

### succ-assistant-ko-502

- 대체 대상: `succ-assistant-ko-15` (subtype 4 · 가정법)
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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
- 선언 subtype: **2 · 역할극·창작**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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

### succ-assistant-en-501 — **2026-08-31 수정됨, 재검수 대상**

- 대체 대상: `succ-assistant-en-311` (subtype 3 · 사용자가 정정한 정보)
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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
> I'm not the chair. I'm typing this one up as a favour for a friend — the chair is someone else entirely.
>

### succ-assistant-en-502

- 대체 대상: `succ-assistant-en-92` (subtype 3 · 사용자가 정정한 정보)
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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
- 선언 subtype: **1 · assistant 추측**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

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

## 7. 판정란

아래는 사람이 채웁니다. 이 시트를 만든 주체가 채우지 않습니다.

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| `ko-501`의 비어 있지 않은 gold | | |
| `en-501` 모호성 제거 (재검수) | | |
| 나머지 여덟 건의 빈 gold | | |
| §3.1 제외 기준 4종 | | |
| §3 subtype 분류표 (`ai_draft` → 확정/정정) | | |
| docs/ops/memory-extraction-eval-dataset.md §3.3 하한 미달에 대한 조치 | | |
| §4 다양성 | | |
| §5 수정 gold 5건 | | |
| 채택 여부 | | |

- 검수자:
- 검수일:
- 채택 기록 경로:

채택하면 그 commit에서 `MEMORY_EVAL_SUCC6_DATASET_FROZEN`을 `true`로 올리고,
manifest를 계산식이 아니라 literal record로 pin 합니다.
