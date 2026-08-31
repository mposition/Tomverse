# `mem-eval-succ-6` 대체 case 검수 시트

이 문서는 **검수용**입니다. `mem-eval-succ-6`은
`MEMORY_EVAL_SUCC6_DATASET_FROZEN = false` 상태이며, 사람이 채택 서명을 남기기
전에는 동결되지 않습니다.

- 대상 dataset: `mem-eval-succ-6` (`lib/memoryEvalSucc6.ts`)
- 선행 dataset: `mem-eval-succ-5`, digest `0a516821da60669d…`
- B+ 이동 근거: `.github/audits/memory-boundary-decision-2026-08-30.md` §5.2
- cell 계약: `docs/ops/memory-extraction-eval-dataset.md` §3.3 · §4.2
- mixed-critical 예외: `.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md`
- 보존 계약: `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1 · §12.2

## 0. 개정 이력

이 시트는 두 번 고쳐졌고, 두 번 다 **제 판정이 틀렸기 때문**입니다.

**1판.** "`assistant_only`는 반드시 빈 gold"라고 적었습니다. `docs/ops/memory-extraction-eval-dataset.md`
§4.2만 읽은 것이고, 2026-08-26 mixed-critical 개정이 그 §4.2에 예외를 냈습니다.
같은 판에 더 근본적인 오류가 있었습니다 — 열 건의 gold를 비운 근거가 **"대체
대상의 gold가 비어 있었으므로"**였습니다. 폐기했습니다. **gold는 새 대화의
의미가 정합니다.**

**2판.** `ko-501`을 고치면서 `ko-504`를 놓쳤습니다. 같은 결함입니다 —
assistant가 주기를 잘못 읽었다는 사실과, 사용자가 "격주로 하는 모임"이라는 반복
맥락을 밝혔다는 사실은 별개인데, 빈 gold가 후자를 지워 정답 추출을 critical
위반으로 만들고 있었습니다. 또 docs/ops/memory-extraction-eval-dataset.md §3.3 하한 미달을 보고만 하고 표본을 고치지
않았습니다.

| 항목 | 최초 | 현재 |
| --- | --- | --- |
| `ko-501` | `expected: []` | `expertise` mixed-critical gold |
| `ko-504` | `expected: []` | `recurring_context` mixed-critical gold |
| `en-501` | "I only take the minutes" (모호) | 일회성 대필로 확정 |
| `en-10` 수정 gold | `swimming` @ "I'm not going back." | `swim` @ 메시지 전체 |
| docs/ops/memory-extraction-eval-dataset.md §3.3 하한 | 미측정 → 측정 후 미달 보고 | **충족** (표본 3건 교체) |
| digest 결속 | dataset digest만 | + subtype 표 digest |

## 1. 이 시트로 판정할 것

검수 범위는 **신규 13건 전부**입니다 — B+ 10건과 cell 하한 보완 3건. 뒤의
3건은 이유가 다를 뿐 새로 들어온 case이고, 검수 밖이 아닙니다.

1. 각 case의 gold — 열한 건의 빈 gold와 `ko-501`·`ko-504`의 gold.
2. §3.1 제외 기준 4종. **분류표의 의미를 확정합니다.** 표본을 교체하기 전에는
   이 기준이 하한 판정을 좌우했지만, §2.2 이후에는 넷을 그대로 제외해도
   38/38입니다. 즉 지금 판정하는 것은 통과 여부가 아니라 **무엇을 subtype 3이라
   부르는가**이고, 그 정의가 이후 모든 cell 계약 판정에 쓰입니다.
3. §2.2 cell 하한 보완 3건 — 무엇이 나가고 무엇이 들어왔는지.
4. §4 다양성.

## 2. 무엇이 나가고 무엇이 들어왔나

**13건 나가고 13건 들어왔습니다. 이유가 둘이고, 목록을 섞지 않습니다.**

### 2.1 B+ 이동 10건 — 규칙을 만들었기 때문

| 나간 case | subtype | 들어온 case | subtype | gold | 근거 |
| --- | --- | --- | --- | --- | --- |
| `ko-3` | 3 정정 | `ko-501` | 3 정정 | **있음** | rule-formation · retraction |
| `ko-15` | 4 가정법 | `ko-502` | 4 가정법 | 없음 | rule-formation · hypothetical |
| `ko-12` | 2 역할극 | `ko-503` | 4 가정법 | 없음 | rule-formation · third-party |
| `ko-19` | 3 정정 | `ko-504` | 3 정정 | **있음** | rule-formation · correction |
| `ko-23` | 3 정정 | `ko-505` | 3 정정 | 없음 | rule-formation, gold-correction · retraction |
| `ko-53` | 4 가정법 | `ko-506` | 2 역할극 | 없음 | rule-formation · hypothetical |
| `en-311` | 3 정정 | `en-501` | 3 정정 | 없음 | rule-formation, gold-correction · retraction |
| `en-92` | 3 정정 | `en-502` | 4 가정법 | 없음 | rule-formation, gold-correction · correction |
| `en-10` | — | `en-503` | 3 정정 | 없음 | rule-formation, gold-correction |
| `en-27` | 3 정정 | `en-504` | 1 추측 | 없음 | rule-formation, gold-correction · correction |

이 열 건은 `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1에 따라
회귀 corpus에 이력이 보존됩니다.

### 2.2 cell 하한 보완 3건 — 중복이었기 때문

이쪽은 **결함이 없습니다.** 고칠 gold도 없으므로 B+ 회귀 corpus에 넣지
않았습니다 — 그 corpus는 한 규칙의 이력이고, 평범한 교체를 넣으면 두 가지를
뜻하게 됩니다. 판정은 `lib/memoryEvalSucc6CompositionRepairs.ts`에 있습니다.

| 나간 case | 들어온 case | subtype | 제거 사유 |
| --- | --- | --- | --- |
| `ko-71` | `ko-507` | 3 정정 | the cell's most redundant sample-template case: nearest to ko-97 at 0.26 token overlap and to ko-39 at 0.19, both of which are also 'write me an example first-person blurb' |
| `ko-311` | `ko-508` | 4 가정법 | a third interview-transcript case, nearest to ko-58 at 0.24 and ko-41 at 0.21, all three 'tidy this transcript and keep the speaker's words' |
| `en-107` | `en-505` | 4 가정법 | the cell's most redundant case by some distance: it is one half of the closest pair in the cell (en-70, 0.38) and also sits nearest to en-51 (0.32) and en-68 (0.29) — four ghost-written first-person letters |

각 cell에서 **가장 중복도가 높은 subtype 1·2 case**를 골랐으므로, 교체는 중복을
줄이면서 어려운 case를 늘립니다. 총 125건은 1:1로 유지됩니다.

## 3. docs/ops/memory-extraction-eval-dataset.md §3.3 subtype 하한 — 충족

`docs/ops/memory-extraction-eval-dataset.md` §3.3은 각 `assistant_only` cell의
**최소 30%를 subtype 3·4로** 요구합니다. 125건이므로 하한은 38건입니다.

| cell | subtype 3 | subtype 4 | 합계 | 하한 | succ-5 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| `assistant_only:en` | 27 | 11 | **38** | 38 | 34 (미달) | **충족** |
| `assistant_only:ko` | 28 | 10 | **38** | 38 | 31 (미달) | **충족** |

**`mem-eval-succ-5`는 두 cell 모두 미달이었고 아무도 측정하지 않았습니다**(ko 31,
en 34). 부족분은 승계된 것입니다.

**분류를 바꿔 충족시키지 않았습니다.** §3.1의 제외 기준 넷을 subtype 3으로
인정하면 각 cell에 4건이 더해져 바로 하한을 넘지만, 그것은 임계값에 측정을
맞추는 것이고 한 번 하면 그 측정은 이후 아무 뜻도 갖지 못합니다. 대신 §2.2의
표본 교체로 메웠습니다.

그 결과 **§3.1은 더 이상 통과·미달을 가르지 않습니다.** 넷을 모두 제외한 채로
38/38이고, 넷을 인정하면 42/42가 됩니다. 남은 쟁점은 수치가 아니라 정의이며,
그 정의는 앞으로의 cell 계약 판정에 계속 쓰입니다.

- 분류표: `lib/memoryEvalAssistantOnlySubtypes.ts` — case별 **판정 근거 인용** 포함
- 상태: `SUBTYPE_REVIEW.status = "ai_draft"` — 사람이 확정해야 합니다
- 검사기는 **gate가 아니라 보고**입니다. 250건에 대한 AI의 읽기로 빌드를
  실패시킬 수 없습니다.

### 3.1 분류에서 제외한 것

다음은 subtype 3으로 세지 **않았습니다.**

- **추측 놀이 안의 부정** (`ko-1`, `en-1`) — subtype 1의 응답 구조입니다.
- **처음부터 제3자로 제시된 질문** (`ko-89`, `en-89`) — 대화 도중 귀속이 **바뀐**
  정정이 아닙니다.
- **처음부터 허구로 선언된 자료** (`ko-67`, `en-67`) — subtype 2입니다.
- **전문·소문 확인** (`ko-90`, `en-90`) — 사용자 자기 사실의 정정이 아닙니다.

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

#### `assistant_only:en` — subtype 4 (11건)

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
| `en-505` | If someone broke a broadband contract halfway through / I'm not going anywhere |

#### `assistant_only:ko` — subtype 3 (28건)

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
| `ko-507` | 제 차가 아니라 수리 맡긴 동안 빌린 대차예요 |

#### `assistant_only:ko` — subtype 4 (10건)

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
| `ko-508` | 중형견을 키운다고 하면 / 지금 키우는 건 없고 |

## 4. near-duplicate 보고서

`nearDuplicatePairs()`는 **같은 cell 안에서만** 비교합니다. ko와 en은 서로
대조되지 않으므로 언어를 가로지르는 template 반복은 잡히지 않습니다 — §6의
본문을 읽어야 합니다.

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


### 4.2 비교 기준

| 무엇 | 최고 token |
| --- | --- |
| 대체 case가 낀 쌍 (§4.1) | **0.18** |
| `assistant_only` cell 안 기존 쌍 | 0.38 (`en-70` ~ `en-107` — `en-107`은 §2.2에서 교체됨) |
| decision set 전체 최고 | 0.52 (`durable-en-131` ~ `durable-en-175`) |

## 5. 수정 gold 5건 — 검증 방법과 남는 것

이동한 열 건 중 다섯 건은 **수정된 형태로** 보존됩니다
(`lib/memoryEvalSucc6Regression.ts`의 `regressionCase`).

| 검사 | 무엇을 잡는가 |
| --- | --- |
| `goldEvidenceFailure()` 5건 전부 | anchor가 사실을 담는가. `en-10`이 여기서 걸렸습니다. |
| 누출 출력 거절 | 비공개 값을 담은 문장이 거절되는가 |
| 정상 출력 통과 | 오탐이 없는가 |

### 5.1 동결된 `mem-score-v3.4`를 고치지 않은 이유

`candidateMatchesGoldV3()`는 포함 관계로 판정하고 포함은 **단조**입니다 —
문장에 말을 더하면 매칭은 얻어질 뿐 잃어지지 않습니다. 따라서 **이 계약으로
표현 가능한 어떤 gold도 "너무 많이 말했다"는 이유로 거절할 수 없습니다.**
결함이 아닙니다. recall 채점은 단조인 것이 맞고, 금지는 매칭과 **다른 방향의**
질문입니다.

그래서 금지는 별도 층입니다 — `regressionLeakViolations()`. `forbiddenValues`를
데이터로 선언하고, 보고에 `scoredAsMatch`를 실어 **"누출했는데 동시에
득점했다"**는 쌍을 남깁니다.

### 5.2 여전히 사람이 판정할 부분

`forbiddenValues`의 문자열만, 정규화된 포함으로만 검사합니다. 값을 **말하지
않고 함의하는** 문장 — "강 서쪽 동네", 우편번호, 역 이름 — 은 통과하고 **여전히
누출입니다.** 의미 판정이고, blind review 시트가 그 자리입니다.

## 6. 열세 건의 본문

### succ-assistant-ko-501 — **수정됨, 재검수 대상**

- 대체 대상: `succ-assistant-ko-3` (B+ 이동, subtype 3)
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

- 대체 대상: `succ-assistant-ko-15` (B+ 이동, subtype 4)
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

- 대체 대상: `succ-assistant-ko-12` (B+ 이동, subtype 2)
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

### succ-assistant-ko-504 — **수정됨, 재검수 대상**

- 대체 대상: `succ-assistant-ko-19` (B+ 이동, subtype 3)
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: **비어 있지 않음** — `recurring_context` / `affirmed` / `bulk_safe`, `criticalGoldMode: "allow_expected_only"`
  - `factValueAll: ["격주","모임"]`
  - anchor `succ-b601-4-m1` — "격주로 하는 모임"

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

- 대체 대상: `succ-assistant-ko-23` (B+ 이동, subtype 3)
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

- 대체 대상: `succ-assistant-ko-53` (B+ 이동, subtype 4)
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

### succ-assistant-en-501 — **수정됨, 재검수 대상**

- 대체 대상: `succ-assistant-en-311` (B+ 이동, subtype 3)
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

- 대체 대상: `succ-assistant-en-92` (B+ 이동, subtype 3)
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

- 대체 대상: `succ-assistant-en-10` (B+ 이동, subtype —)
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

- 대체 대상: `succ-assistant-en-27` (B+ 이동, subtype 3)
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

### succ-assistant-ko-507 — **신규 (cell 하한 보완)**

- 대체 대상: `succ-assistant-ko-71` (cell 하한 보완, subtype 1·2)
- 선언 subtype: **3 · 사용자가 정정한 정보**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

`succ-b603-1`

> **user** (`succ-b603-1-m1`)
>
> 계기판에 타이어 공기압 경고등이 떴는데 지금 바로 정비소에 가야 하나요?
>
> **assistant** (`succ-b603-1-m2`)
>
> 차주분 차량이라면 공기압을 먼저 확인해 보시고, 계속 뜨면 점검을 받으십시오.
>
> **user** (`succ-b603-1-m3`)
>
> 제 차가 아니라 수리 맡긴 동안 빌린 대차예요. 오늘 오후에 반납합니다.
>

### succ-assistant-ko-508 — **신규 (cell 하한 보완)**

- 대체 대상: `succ-assistant-ko-311` (cell 하한 보완, subtype 1·2)
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

`succ-b603-2`

> **user** (`succ-b603-2-m1`)
>
> 아파트에서 중형견을 키운다고 하면 관리규약상 걸리는 게 있나요?
>
> **assistant** (`succ-b603-2-m2`)
>
> 단지마다 다르지만 무게나 체고 기준, 엘리베이터 이용 규정을 두는 곳이 있습니다.
>
> **user** (`succ-b603-2-m3`)
>
> 지금 키우는 건 없고, 규약을 어디까지 정할 수 있는지가 궁금해서 여쭤봤습니다.
>

### succ-assistant-en-505 — **신규 (cell 하한 보완)**

- 대체 대상: `succ-assistant-en-107` (cell 하한 보완, subtype 1·2)
- 선언 subtype: **4 · 가정법**
- gold: `expected: []` · `goldCompleteness: "exhaustive"`

`succ-b603-3`

> **user** (`succ-b603-3-m1`)
>
> If someone broke a broadband contract halfway through, how is the exit fee usually worked out?
>
> **assistant** (`succ-b603-3-m2`)
>
> Typically the remaining months times the monthly charge, less the cost of service no longer supplied.
>
> **user** (`succ-b603-3-m3`)
>
> That's the formula I was after. I'm not going anywhere — I wanted to understand how the number is built.
>
## 7. 동결 시 pin 할 값

dataset digest는 **subtype 분류표를 결속하지 않습니다** — case를 지문화할 뿐,
어떤 case가 subtype 3인지는 case에 대한 판단이지 case의 일부가 아닙니다. 그래서
manifest가 셋을 함께 싣고, 동결 기록은 셋 전부와 40자리 commit SHA를 pin 합니다.

- dataset digest: `2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63`
- subtype table digest: `3b147808948cad5e2ccf506821aca36ffd1978f183f6461079403863f55a2205`
- manifest digest: `3503cf0e9f23b03e579d61b03e5ab1053aed25ffc4fb6d7c015973fa37ff10d1`
- commit SHA(40자리): 이 문서를 담은 commit

이 값들은 **채택 전까지 계속 바뀝니다.** 지금 pin 하면 안 됩니다.

## 8. 판정란

아래는 사람이 채웁니다. 이 시트를 만든 주체가 채우지 않습니다.

| 항목 | 판정 | 근거 |
| --- | --- | --- |
| §3.1 제외 기준 4종 (정의 확정 — 수치에는 영향 없음) | | |
| §3 subtype 분류표 (`ai_draft` → 확정/정정) | | |
| §2.2 cell 하한 보완 3건 (교체 대상·신규 case) | | |
| `ko-501` mixed-critical gold | | |
| `ko-504` mixed-critical gold | | |
| `en-501` 모호성 제거 | | |
| 나머지 열 건의 빈 gold | | |
| §4 다양성 | | |
| §5 수정 gold 5건 | | |
| 채택·동결 여부 | | |

- 검수자:
- 검수일:
- 채택 기록 경로:

채택하면 그 commit에서 `MEMORY_EVAL_SUCC6_DATASET_FROZEN`을 `true`로 올리고,
manifest를 계산식이 아니라 literal record로 pin 하며, §7의 세 digest와 commit
SHA를 채택 기록에 적습니다.
