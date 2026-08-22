# 메모리 추출 eval 프로그램 — 착수에 필요한 사람 결정

이 문서는 **결정을 요청하는 문서**입니다. 아무것도 승인하지 않고, 어떤 표본도
만들지 않으며, `docs/ops/memory-extraction-eval-dataset.md`의 세 기입 표를 채우지
않습니다. 그 표는 사람이 채우는 것이고, 이 문서는 그 표 앞에 무엇을 정해야 하는지를
모아 둔 것입니다.

작성 근거: `docs/policy/external-conversation-import-and-memory.md` §12.1~§12.6,
`docs/ops/memory-extraction-eval-dataset.md` §5~§7, 2026-08-22 트리 확인.

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
그 경로의 첫 관문이 1,600개 decision set입니다. 그래서 이 문서가 있습니다.

> 이 저장소에는 두 flag의 Admin 쓰기 경로가 없습니다. 그것은 누락이 아니라
> 기록된 결정이며(`tests/appSettingWriters.test.mjs`의 `READ_ONLY_KEYS`),
> 이번 작업에서도 유지했습니다. 이유는 §5에 적었습니다.

---

## 2. 사람이 정해야 하는 5가지

`docs/ops/memory-extraction-eval-dataset.md`의 「착수 승인 기록」 표가 요구하는
항목과 1:1로 대응합니다. 각 항목에 **무엇을 정하는지**와 **정해지지 않으면 무엇이
멈추는지**를 적었습니다.

### 결정 1 — 데이터셋 책임자와 8개 cell별 작성자

- 정하는 것: 전체 진행을 책임지는 1명, 그리고 범주 ①~④ × ko/en = 8개 cell 각각의
  작성자.
- 한 사람이 여러 cell을 맡아도 됩니다. 지침이 금지하는 것은 **같은 케이스의
  작성자와 검수자가 같은 사람인 것**이지, 한 사람이 여러 cell을 쓰는 것이
  아닙니다(§6.2).
- 정해지지 않으면: batch 작성이 시작되지 않습니다. 이것이 전체 프로그램의
  시작점입니다.

### 결정 2 — 검수자 (작성자와 동일인 불가)

- 정하는 것: 케이스 채택·수정·반려를 판정할 사람.
- 범주 ②③④는 **전건 독립 검수**입니다(§6.3). 1,600개 중 1,200개가 여기
  해당하므로, 검수는 작성 대비 부수 작업이 아니라 비슷한 규모의 작업입니다.
- 정해지지 않으면: 작성된 케이스가 전부 candidate pool에 머뭅니다. 정책 §12.6이
  "에이전트가 만든 것은 어떤 경우에도 candidate pool"이라고 못박은 것과 같은
  이유로, 검수 없는 사람 작성물도 decision set이 될 수 없습니다.

### 결정 3 — adjudicator (작성자·검수자 양쪽과 다른 사람)

- 정하는 것: 작성자와 검수자의 판정이 갈릴 때 확정할 사람.
- 동결 조건에 "adjudication 잔여 0건"이 있으므로(§7.1), 불일치가 한 건이라도
  나오면 이 역할 없이는 동결에 도달하지 못합니다.
- 정해지지 않으면: 동결이 불가능합니다. 작성·검수를 다 마쳐도 그렇습니다.

### 결정 4 — AI 초안 허용 범위와 기록 방식

- 정하는 것: (a) AI로 케이스 초안을 만들어도 되는가, (b) 된다면 어떤 도구까지,
  (c) 사용 사실을 어디에 어떤 형식으로 남기는가.
- 지침은 AI 초안을 허용하되 **어느 도구로 만들었는지 기록**하도록 요구하고,
  평가 대상 모델과 같은 계열로 만든 케이스는 검수자가 문체 편향을 특히 주의해
  보라고 합니다(§6.2). 즉 이 결정은 "허용/금지"가 아니라 **검수자에게 무엇을
  경고할지**를 정하는 것입니다.
- 첫 eval 대상이 `gpt-5-6-luna`이므로(정책 §12.5), OpenAI GPT-5 계열로 만든
  초안은 이 경고 대상입니다.
- 정해지지 않으면: 작성은 진행되지만 기록이 남지 않고, 동결 기록의 "작성 방식"
  칸을 사후에 재구성할 수 없습니다.

### 결정 5 — 이 지침 자체에 대한 사람 승인

- 정하는 것: `docs/ops/memory-extraction-eval-dataset.md` 맨 아래
  「승인 기록 — 이 지침 자체」의 검토자·합의일·수정 요청 사항.
- 이것이 마지막이 아니라 **첫 번째**입니다. 지침이 확정되지 않은 상태에서 쓴
  케이스는 지침이 바뀌면 다시 봐야 하고, §7.3의 재작업 규칙상 결과를 본 뒤의
  수정은 새 `datasetVersion`이 됩니다.
- 정해지지 않으면: 나머지 네 결정이 언제든 무효가 될 수 있는 상태로 진행됩니다.

---

## 3. 실제 차단 지점 — 역할 분리는 이 조직에서 자동으로 충족되지 않습니다

결정 2와 3이 이 프로그램의 진짜 관문입니다. 이 저장소는 1인 조직인데, 지침 §6.2는
세 역할이 **서로 다른 사람**일 것을 표로 요구하고, 거기에는 예외 조항이 없습니다.

릴리스 게이트 registry는 같은 문제를 이미 한 번 만나 명시적으로 답했습니다.

> `soleApproverAllowed: true` — "이 조직에는 책임자가 한 명이다. 서로 다른 두
> 사람을 요구하는 규칙은 여기서 엄격한 것이 아니라 충족 불가능하며, 모든 blocking
> gate가 영원히 승인 불가가 된다."
> (`docs/release-gates/tomverse-chat-v1.yaml`)

**eval 지침에는 이에 해당하는 조항이 없습니다.** 그러므로 현재 상태는 "허용된다"도
"금지된다"도 아니고, **결정된 적이 없다**입니다. 셋 중 하나를 골라야 합니다.

| 선택지 | 결과 | 대가 |
|---|---|---|
| **A. 외부 인력 확보** | 지침을 그대로 지킴 | 검수자·adjudicator 2명이 필요하고, 검수 대상은 critical negative 1,200건 전건 |
| **B. 지침에 sole-author 조항 추가** | 1인으로 진행 가능 | registry와 같은 수준의 근거와 **대체 보호 장치**를 함께 기록해야 함. 무엇이 두 사람 규칙을 대신하는지 적지 않으면 규칙을 없앤 것과 같음 |
| **C. 결정 보류** | 현 상태 유지 | #5·#6은 계속 무효 상태로 남고, MEMORY-01~04은 `applicability_unknown`에 머묾 |

B를 고른다면 registry의 답변 방식이 참고가 됩니다 — 그쪽은 "증거를 만든 주체(대개
자동화)와 승인자가 다르다"는 축을 남기는 것으로 두 사람 규칙을 대체했습니다.
eval 표본에서 그에 해당하는 축이 무엇인지는 정해진 바 없고, 이 문서는 그것을
제안하지 않습니다. **C도 유효한 답입니다.** 다만 그 경우 #5·#6은 "아직 안 켠
것"이 아니라 **"켤 수 없는 것"**으로 기록하는 편이 정확합니다.

---

## 4. 비용 — provider 지출은 이 프로그램의 제약이 아닙니다

정책 §12.5는 예산 승인을 요구하므로 금액을 산정했습니다.

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

**결론: 이 프로그램을 막고 있는 것은 돈이 아니라 §2의 사람 결정과 §3의 역할
분리입니다.** 예산 승인은 §9 실행 순서상 동결(3번) **뒤**이므로 지금 정할 항목도
아닙니다 — 아직 움직이는 표본에 돈을 배정하지 않기 위한 순서입니다.

산정 재현: `lib/memoryExtractionEvalFixtures.ts`의 `MEMORY_EVAL_CASES`를
`toExtractionPromptInput()` → `buildExtractionPrompt()`에 통과시키고 system·user를
합산했습니다. provider 호출은 하지 않았습니다.

---

## 5. 이번 작업에서 하지 않은 것과 그 이유

- **두 flag의 Admin 토글을 만들지 않았습니다.** `tests/appSettingWriters.test.mjs`
  의 `READ_ONLY_KEYS`가 두 키를 "의도적으로 쓰기 경로 없음"으로 등록하고 있고,
  그 근거는 §12.4 절차의 마지막 단계를 버튼 하나로 앞당기지 않는 것입니다.
  "승인 pair가 1건 이상인가"만 확인하는 토글도 충분하지 않습니다 — §12.4는
  그 외에 decision-grade 실행, artifact 보존, blind review, 독립 재실행, 승인
  서명, register 병합, staging 검증을 함께 요구합니다.
- **register를 건드리지 않았습니다.** `candidate` → `approved`는 사람의 행위이고
  (§12.4), 에이전트가 할 수 없습니다.
- **표본을 만들지 않았습니다.** §12.6이 명시적으로 금지합니다.
- **production flag는 OFF 그대로입니다.**

향후 Admin에서 활성화하고 싶다면 정책 개정이 먼저입니다. 그때도 일반 checkbox가
아니라 **동결된 검증 기록·승인 pair·서명된 승인 근거를 확인하는 activation
작업**이어야 합니다. 반대 방향 — OFF와 emergency revocation — 은 지금도 쉽게
실행 가능하며(`/api/admin/memory-extraction/revocations`), 그 비대칭은 의도된
것입니다.

---

## 6. 결정 후 순서

`docs/ops/memory-extraction-eval-dataset.md` §9가 정한 순서 그대로입니다.

1. §2의 다섯 결정 + 「착수 승인 기록」 기입 ← **현재 여기**
2. batch 작성·검수 (25~50개 단위, 8개 cell)
3. 동결 (§7.2) — `datasetVersion`·digest 기록
4. eval 실행 예산 승인 (§12.5) — 금액 참고치는 §4
5. decision-grade 실행 → blind review → 독립 재실행
6. §12.3 기준으로 판정 (축약·완화 없이)
7. register `approved` + 승인자 서명 (§12.4)
8. staging 검증 → `memoryExtractionEnabled` → `memoryInjectionEnabled`

8번의 staging 체크리스트는 아직 없습니다. 선행 단계가 무엇을 산출하는지 정해지기
전에 쓰면 "CI가 증명하지 못하는 것만 담는다"는 기준
(`docs/ops/assistant-knowledge-staging-verification-records/README.md`)을 적용할
대상이 없어 항목이 추측이 됩니다. 7번이 끝나는 시점에 씁니다.
