# 메모리 추출 eval 프로그램 — 착수에 필요한 사람 결정

이 문서는 **결정을 요청하는 문서**입니다. 아무것도 승인하지 않고,
`docs/ops/memory-extraction-eval-dataset.md`의 세 기입 표를 채우지 않습니다.
그 표는 사람이 채웁니다.

**2026-08-23 개정**: AGENTS.md에 「사람에게 남기는 것은 사람만 할 수 있는
것뿐입니다」가 추가되면서 이 문서를 다시 읽었습니다. 초판은 1,600개 케이스
작성을 사람 몫으로 적었는데, 그것은 새 규칙이 금지하는 **준비 떠넘기기**입니다.
작성은 에이전트 몫으로 옮겼고, 사람에게 남은 것은 §3의 네 범주에 드는 것만
입니다. 사람에게 남긴 항목마다 왜 에이전트가 못 하는지 한 줄로 적었습니다.

작성 근거: `docs/policy/external-conversation-import-and-memory.md` §12.1~§12.6,
`docs/ops/memory-extraction-eval-dataset.md` §5~§9, AGENTS.md 「사람에게 남기는
것은 사람만 할 수 있는 것뿐입니다」, 2026-08-22~23 트리 확인.

---

## 1. 왜 이 결정이 지금 필요한가

정책 §15.1의 활성화 순서 #5 `memoryExtractionEnabled`, #6 `memoryInjectionEnabled`
를 켜는 작업을 하려다 확인한 사실입니다. **두 flag는 지금 켜도 아무 동작을 켜지
않습니다.**

| 확인한 것 | 위치 |
|---|---|
| register의 pair 2건이 모두 `status: "candidate"`, `evaluation: null`, `evalBudget: null` | `lib/memoryExtractionEvalRegister.ts` |
| extraction의 모든 진입점이 승인 pair를 요구하고, 없으면 403 `MEMORY_EXTRACTION_PAIR_UNAVAILABLE` | `resolveEffectiveExtractionPair()`, `lib/memoryExtractionService.ts` |
| injection이 `hasApprovedExtractionPair`를 flag 바로 다음에 판정하고, 없으면 `no_approved_pair`로 거절 | `decideMemoryInjection()`, `lib/memoryInjectionGate.ts` |
| 착수·동결·지침 승인 기록 세 표가 모두 공란 | `docs/ops/memory-extraction-eval-dataset.md` |

즉 `memoryExtractionEnabled=true`는 사용자에게 "메모리 추출 시작" 화면을 열어
주고 **모든 실행을 403으로 거절**하며, `memoryInjectionEnabled=true`는 주입 판정을
한 단계 더 진행시킨 뒤 **같은 자리에서 조용히 멈춥니다**. 정책 §12.4가 말하는
fail-closed가 정확히 이 상태이므로 안전하지만, **켠 사실이 제품에 아무 변화도
만들지 않습니다.**

flag를 의미 있게 만드는 유일한 경로는 register pair를 `approved`로 올리는 것이고,
그 경로의 첫 관문이 decision set입니다. 그래서 이 문서가 있습니다.

> 이 저장소에는 두 flag의 Admin 쓰기 경로가 없습니다. 그것은 누락이 아니라
> 기록된 결정이며(`tests/appSettingWriters.test.mjs`의 `READ_ONLY_KEYS`),
> 유지했습니다. 이유는 §7에 적었습니다.

---

## 2. 지금 남은 양 — 셈은 에이전트가 했습니다

AGENTS.md가 "셈과 대조는 에이전트가 합니다"라고 정한 대로, 사람에게 "몇 개
필요한지 세어 보세요"라고 하지 않고 세었습니다.

`lib/memoryExtractionEvalFixtures.ts`의 `MEMORY_EVAL_CASES`를 범주 × 언어로 집계하고,
`lib/memoryExtractionEvalRegister.ts`의 `MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM`
(=200)과 대조한 결과입니다.

| 범주 | ko | en | cell당 부족분 |
|---|---|---|---|
| `durable_facts` | 4 | 4 | 196 · 196 |
| `assistant_only` | 4 | 4 | 196 · 196 |
| `sensitive_secrets` | 4 | 4 | 196 · 196 |
| `injection_directives` | 4 | 4 | 196 · 196 |

- 현재 `datasetVersion`은 `mem-eval-seed-1`, purpose `development`, `frozen: false`
- 8개 cell, 보유 **32건**, 하한 총계 **1,600건**, 부족 **1,568건**
- `MEMORY_EVAL_DATASET_FROZEN`이 `false`인 동안 harness는 `--live`를 거부합니다
  (`docs/ops/memory-extraction-eval-dataset.md` §7.2). 동결은 문서상의 약속이 아니라 코드가 강제하는 상태입니다.

---

## 3. 무엇이 에이전트 몫이고 무엇이 사람 몫인가

AGENTS.md는 사람만 할 수 있는 것을 네 가지로 한정합니다. 이 프로그램에 그대로
대보면 이렇습니다.

| 범주 | 이 프로그램에 해당하는가 |
|---|---|
| 1. 실기기·실제 OS | **해당 없음.** eval은 브라우저도 파일 선택기도 지나지 않습니다. |
| 2. 이 컨테이너가 만들 수 없는 시료 | **해당 없음.** 지침(`docs/ops/memory-extraction-eval-dataset.md`) §3.1이 케이스를 **synthetic**으로 못박고 실데이터를 금지하므로, 만들 수 없는 시료라는 것이 성립하지 않습니다. |
| 3. 유료 turn과 그 답의 판정 | **해당.** decision-grade 실행과 blind 정성 검토(§12.4). |
| 4. 판정과 서명 | **해당.** 역할 지정, 케이스 채택·반려 판정, adjudication, 동결 승인, 지침 승인, register 서명. |

### 에이전트가 하는 것

- **케이스 초안 작성.** 지침(`docs/ops/memory-extraction-eval-dataset.md`) §6.2가 AI 초안을 허용하고, 정책 §12.6이 "에이전트가
  만든 것은 어떤 경우에도 candidate pool"이라고 이미 정해 뒀습니다. 즉 규칙은
  에이전트가 **만드는 것**을 막은 적이 없고, 만든 것을 **스스로 승인하는 것**을
  막았습니다.
- **셈·대조·기록 파일.** cell별 개수, `findDuplicateCases()` 통과 여부, dataset
  digest, 동결 기록 초안, batch별 불일치율 집계.
- **정답지 동봉.** 지침 §8의 케이스별 기록 항목 — gold label과 그 근거, 범주
  판정 이유, 초안 도구 —— 을 케이스마다 채워서 냅니다. AGENTS.md의 "시료에는
  정답지를 같이 냅니다"가 여기서는 이것입니다. 근거 없는 케이스 목록은 검수자에게
  판정할 재료를 주지 않은 것입니다.

### 정직하게 말해 두는 한계

1,568건을 **서로 다르게** 만드는 것이 이 작업의 어려운 부분이고, 지침이 이미 그
경계를 그어 뒀습니다.

> **한 cell 안에서 문장 구조를 반복하지 않습니다.** 같은 틀에 단어만 바꾼 200개는
> 200개가 아니라 1개입니다. `findDuplicateCases()`는 내용이 완전히 같은 것만
> 잡으므로, 경미 변형은 검수자가 잡아야 합니다.
> (`docs/ops/memory-extraction-eval-dataset.md` §3.1)

즉 자동 검사는 **객관적 하한**이지 다양성의 보증이 아니며, 지침 스스로 그 판정을
검수자에게 맡깁니다. 대량 생성물이 실패하는 지점이 정확히 여기입니다. 그러므로
검수자의 일은 형식 확인이 아니라 실질 판단이고, 이것을 줄여 말하면
`docs/ops/memory-extraction-eval-dataset.md` §6.3의 전건 독립 검수가 요식이 됩니다.

---

## 4. 사람이 정해야 하는 것

`docs/ops/memory-extraction-eval-dataset.md`의 「착수 승인 기록」 표에 대응합니다.
초판의 다섯 항목 중 **작성자 지정이 빠졌습니다** — 작성은 에이전트 몫이 됐기
때문입니다.

### 결정 1 — 데이터셋 책임자

- 정하는 것: 이 프로그램 전체를 책임지는 1명.
- **왜 에이전트가 못 하는가**: 책임 소재의 지정이고, 범주 4(판정과 서명)입니다.
- 정해지지 않으면: 이후 모든 승인에 서명할 주체가 없습니다.

### 결정 2 — 검수자

- 정하는 것: 케이스 채택·수정·반려를 판정할 사람. 범주 ②③④는 전건 독립
  검수이므로(`docs/ops/memory-extraction-eval-dataset.md` §6.3) 1,200건이 대상입니다.
- **왜 에이전트가 못 하는가**: 자기가 만든 초안을 스스로 채택하는 것이 정확히
  §12.6이 막은 것입니다. 범주 4.
- 정해지지 않으면: 초안이 전부 candidate pool에 머뭅니다.

### 결정 3 — adjudicator, 그리고 이 역할이 필요한지 자체

- 정하는 것: (a) 작성자와 검수자의 판정이 갈릴 때 확정할 사람, **그리고 그보다
  먼저** (b) 작성자가 사람이 아닐 때 `docs/ops/memory-extraction-eval-dataset.md` §6.4의 adjudication이 성립하는지.
- (b)가 새로 생긴 질문입니다. `docs/ops/memory-extraction-eval-dataset.md` §6.4는 "작성자와 검수자의 판정이 다르면"을
  전제하는데, 에이전트 초안에는 맞서 세울 **판정**이 없습니다 — 초안일 뿐입니다.
  검수자가 고치거나 반려하는 것을 불일치로 볼 것인지, 아니면 초안에 대한 통상의
  검수로 볼 것인지에 따라 필요한 사람 수가 **2명에서 1명으로** 바뀝니다.
- **왜 에이전트가 못 하는가**: 지침의 해석을 정하는 일이고, 범주 4입니다. 이
  문서는 (b)를 제기할 뿐 답하지 않습니다 — 자기에게 유리한 해석을 스스로 고르는
  것이 되기 때문입니다.
- 정해지지 않으면: 동결 조건의 "adjudication 잔여 0건"(§7.1)을 판정할 기준이
  없습니다.

### 결정 4 — AI 초안 허용 범위와 기록 방식

- 정하는 것: (a) 어떤 도구까지 허용하는가, (b) 사용 사실을 어디에 어떤 형식으로
  남기는가.
- **이것이 에이전트 작성을 여는 열쇠입니다.** `docs/ops/memory-extraction-eval-dataset.md` §6.2는 AI 초안을 허용하되 어느
  도구로 만들었는지 기록하도록 요구하고, 평가 대상 모델과 같은 계열로 만든
  케이스는 검수자가 문체 편향을 특히 주의해 보라고 합니다. 첫 eval 대상이
  `gpt-5-6-luna`이므로(정책 §12.5) **OpenAI GPT-5 계열로 만든 초안은 그 경고
  대상**이고, 이 문서를 쓰는 에이전트도 그 판단의 대상입니다.
- **왜 에이전트가 못 하는가**: 자기 산출물의 허용 범위를 스스로 정하는 것이므로
  범주 4입니다.
- 정해지지 않으면: 에이전트가 작성을 시작할 수 없습니다.

### 결정 5 — 이 지침 자체에 대한 사람 승인

- 정하는 것: `docs/ops/memory-extraction-eval-dataset.md` 맨 아래
  「승인 기록 — 이 지침 자체」의 검토자·합의일·수정 요청 사항.
- **왜 에이전트가 못 하는가**: 범주 4.
- **이것이 첫 번째입니다.** 지침이 확정되지 않은 상태에서 만든 케이스는 지침이
  바뀌면 다시 봐야 하고, `docs/ops/memory-extraction-eval-dataset.md` §7.3상 결과를 본 뒤의 수정은 새 `datasetVersion`이
  됩니다. 1,568건을 두 번 만들지 않으려면 여기가 먼저입니다.

### 나중에 필요한 것 (지금 아님)

- **eval 실행 예산 승인** — 범주 3(유료 turn). §9 순서상 동결 **뒤**입니다.
  금액 참고치는 §6.
- **blind 정성 검토** — 범주 3. 모델 답을 사람 눈으로 봅니다.
- **§12.3 판정과 register 서명** — 범주 4.

---

## 5. 남은 차단 지점 — 역할 분리

결정 2와 3이 관문입니다. 다만 **초판보다 좁아졌습니다.** 작성이 에이전트 몫이
되면서, 필요한 사람 수가 지침 해석에 따라 달라지기 때문입니다.

| 결정 3(b)의 답 | 필요한 사람 |
|---|---|
| 에이전트 초안에 adjudication이 성립하지 않는다 | **1명** — 검수자 겸 책임자 |
| 성립한다 (에이전트를 작성자로 본다) | **2명** — 검수자 + adjudicator |
| 작성자는 초안을 채택한 사람이다 | **3명** — 초판과 같음 |

릴리스 게이트 registry는 인접한 문제를 이미 명시적으로 답했습니다.

> `soleApproverAllowed: true` — "이 조직에는 책임자가 한 명이다. 서로 다른 두
> 사람을 요구하는 규칙은 여기서 엄격한 것이 아니라 충족 불가능하며, 모든 blocking
> gate가 영원히 승인 불가가 된다."
> (`docs/release-gates/tomverse-chat-v1.yaml`)

그쪽은 "증거를 만든 주체(대개 자동화)와 승인자가 다르다"는 축을 남기는 것으로
두 사람 규칙을 대체했습니다. **eval 표본에서 그 축은 이제 실제로 존재합니다** —
초안은 에이전트가 만들고 채택은 사람이 합니다. 그것이 `docs/ops/memory-extraction-eval-dataset.md` §6.2의 분리를 대신하기에
충분한지는 사람이 정할 일이고, 이 문서는 정하지 않습니다.

**결정을 보류하는 것도 유효한 답입니다.** 그 경우 #5·#6은 "아직 안 켠 것"이
아니라 **"켤 수 없는 것"**으로 기록하는 편이 정확하고, MEMORY-01~04은
`applicability_unknown`에 머뭅니다.

---

## 6. 비용 — provider 지출은 이 프로그램의 제약이 아닙니다

정책 §12.5는 예산 승인을 요구하므로 금액을 산정했습니다. 사람에게 "얼마인지
계산해 보세요"라고 하지 않기 위해서입니다.

- 대상 pair: `gpt-5-6-luna::mem-extract-v1`
- 가격: US$0.20 / 1M input, US$1.20 / 1M output
  (`lib/modelPricing.ts`, `pricingVersion: openai-gpt-5.6-luna-2026-08-01`)
- 입력 크기: seed fixture 32건의 실제 extraction prompt를 `estimatePromptTokens()`
  로 재어 평균 571 토큰 / 최대 629 토큰

| 시나리오 | 1건당 | 1,600건 1회 | 독립 재실행 포함 2회 |
|---|---|---|---|
| seed 평균 크기, 출력 700 토큰 | US$0.00095 | **US$1.53** | **US$3.05** |
| seed의 3배 크기, 출력 900 토큰 | US$0.00142 | US$2.28 | US$4.55 |

decision set의 케이스는 seed보다 클 수 있으므로 3배 행을 함께 뒀습니다. 10배로
잡아도 2회 실행이 US$25 수준입니다.

**이 프로그램을 막고 있는 것은 돈이 아니라 §4의 결정과 §5의 역할 분리입니다.**

산정 재현: `MEMORY_EVAL_CASES`를 `toExtractionPromptInput()` →
`buildExtractionPrompt()`에 통과시키고 system·user를 합산했습니다. provider
호출은 하지 않았습니다.

---

## 7. 하지 않은 것과 그 이유

- **케이스를 아직 만들지 않았습니다.** 새 규칙상 작성은 에이전트 몫이지만,
  결정 4(초안 허용 범위)와 결정 5(지침 승인)가 그 앞에 있습니다. 지침이
  확정되기 전에 1,568건을 만들면 `docs/ops/memory-extraction-eval-dataset.md` §7.3의 재작업 규칙에 따라 통째로 다시
  만들게 됩니다. **금지되어 있어서가 아니라 순서 때문에 기다립니다.**
- **두 flag의 Admin 토글을 만들지 않았습니다.** `READ_ONLY_KEYS`가 두 키를
  "의도적으로 쓰기 경로 없음"으로 등록하고 있고, 그 근거는 §12.4 절차의 마지막
  단계를 버튼 하나로 앞당기지 않는 것입니다. "승인 pair가 1건 이상인가"만 보는
  토글도 충분하지 않습니다 — §12.4는 그 외에 decision-grade 실행, artifact 보존,
  blind review, 독립 재실행, 승인 서명, register 병합, staging 검증을 함께
  요구합니다.
- **register를 건드리지 않았습니다.** `candidate` → `approved`는 §12.4의 사람
  행위입니다.
- **production flag는 OFF 그대로입니다.**

반대 방향 — OFF와 emergency revocation — 은 지금도 쉽게 실행 가능하며
(`/api/admin/memory-extraction/revocations`), 그 비대칭은 의도된 것입니다.

---

## 8. 결정 후 순서

`docs/ops/memory-extraction-eval-dataset.md` §9의 순서에 누가 하는지를 붙였습니다.

| # | 단계 | 누구 |
|---|---|---|
| 1 | §4의 결정 + 「착수 승인 기록」 기입 | **사람** ← 현재 여기 |
| 2 | 케이스 초안 작성 (25~50개 batch, 8개 cell) | 에이전트 |
| 3 | 검수 · adjudication | **사람** |
| 4 | cell별 개수·중복 검사·digest·동결 기록 초안 | 에이전트 |
| 5 | 동결 승인 (`docs/ops/memory-extraction-eval-dataset.md` §7.2) | **사람** |
| 6 | eval 실행 예산 승인 (§12.5) | **사람** |
| 7 | decision-grade 실행 · 결과 집계 | 에이전트 |
| 8 | blind 정성 검토 · 독립 재실행 판정 | **사람** |
| 9 | §12.3 기준 판정 + register 서명 (§12.4) | **사람** |
| 10 | staging 검증 → `memoryExtractionEnabled` → `memoryInjectionEnabled` | **사람** |

10번의 staging 체크리스트는 아직 없습니다. 선행 단계가 무엇을 산출하는지 정해지기
전에 쓰면 "CI가 증명하지 못하는 것만 담는다"는 기준
(`docs/ops/assistant-knowledge-staging-verification-records/README.md`)을 적용할
대상이 없어 항목이 추측이 됩니다. 9번이 끝나는 시점에 씁니다.
