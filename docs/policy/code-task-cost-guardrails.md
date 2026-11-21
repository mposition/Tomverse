# Code 관리형 태스크의 크레딧 예약과 비용 guardrail

**구현 상태 (2026-10-22):** 단일 태스크 서버 경로를 구현했으며,
`CODE_MANAGED_EXECUTION_ENABLED=true`를 명시하지 않으면 꺼져 있습니다. 운영 추론 활성화와
migration 적용은 별도입니다. 구현한 A1 범위와 확정 값은 10절에 있고 Fleet은 비활성입니다.

`docs/policy/credit-and-cost-limits.md`가 정본입니다. 이 문서는 그 규칙을 **코딩
태스크라는 다른 모양의 사용에 어떻게 적용하는가**만 정하고, 그 문서의 어떤 계약도
완화하지 않습니다. 둘이 어긋나 보이면 그 문서가 맞습니다.

동시 실행은 별개 층이며 [code-concurrency.md](./code-concurrency.md)에 있습니다.

## 1. 무엇이 채팅과 다른가

채팅은 **사용자 행동 하나 = provider 요청 하나**(비교면 모델 수만큼)입니다. 예약과
정산이 요청마다 끝납니다.

코딩 태스크는 **사용자 승인 하나 = provider 요청 수십 개**입니다. 계획 → 계획 검토 →
서브태스크별 구현 → 검증 실패 시 수정 → 결과 검토가 한 태스크 안에서 일어나고, 중간에
사용자 승인 게이트가 있어 태스크 하나가 몇 분에서 몇 시간 걸립니다. 요청마다 독립적으로
예약하면 두 가지가 틀립니다.

- **사용자가 승인한 것은 태스크이지 요청이 아닙니다.** 요청 단위로만 막으면 태스크가
  중간(예: 구현 절반)에서 크레딧 부족으로 멈추고, 그 상태는 사용자가 되돌려야 하는
  반쯤 바뀐 작업 트리입니다.
- **요청 단위 한도는 태스크 전체를 보지 못합니다.** 요청 하나하나는 정상인데 합이
  비정상인 경우(수정 루프 폭주)를 잡을 자리가 없습니다.

## 2. 층은 셋 그대로다

| 층 | 코딩에서 무엇 | 어디 |
|---|---|---|
| User entitlement | **같은** 플랜 크레딧 + 구매 크레딧. 코딩 전용 크레딧 풀을 만들지 않는다 | credit ledger, §3 태스크 예약 |
| Operational guardrail | **같은** plan-derived 비용 guardrail(`op-cost-*`) + 태스크 단위 호출 천장(§4) | `lib/chatCostGuardrails.ts`와 같은 유도 규칙 |
| Concurrency | 코딩 전용 scope | [code-concurrency.md](./code-concurrency.md) |

- **코딩이 크레딧에 숨은 두 번째 한도를 만들지 않습니다.** credit-and-cost-limits.md §1의
  사고(숨은 USD 한도가 entitlement 역할을 한 것)와 §2 "로그인 계정에는 누적 토큰 한도가
  없다"가 그대로 적용됩니다. 코딩 태스크를 따로 막고 싶어지면 그것은 guardrail(§4)이거나
  동시 실행이어야 하며, 이름·오류 코드·지표를 entitlement와 섞지 않습니다.
- **채팅과 코딩은 같은 `op-cost-*` 버킷을 씁니다.** 둘 다 같은 크레딧을 쓰므로 계정 단위
  비용 폭주의 판정도 하나여야 합니다. 코딩 전용 `op-cost` 버킷을 따로 두면 한 계정이 두 배를
  쓸 수 있게 됩니다.
- **provider 예산(`provider-cost-*`)도 같습니다.** 전역 상한은 제품을 가리지 않습니다.

## 3. 예약은 태스크 단위, 정산은 호출 단위

**[제안] 계약:**

1. **태스크 예약.** 사용자가 Code에서 첫 유료 호출 전 상한 크레딧을 승인하는 순간, Code 제품 서비스가 그
   태스크의 **상한 크레딧**을 예약합니다. 상한은 사용자가 승인 카드에서 본 값입니다(Code
   쪽 `TaskBudget` 상한). 크레딧이 모자라면 **태스크가 시작하기 전에** 거절합니다 — 중간에
   멈추는 것보다 시작 전에 멈추는 것이 사용자에게 싸다.
2. **호출별 정산.** 태스크 안의 관리형 호출은 매번 그 예약에서 실제 사용량만큼 정산합니다.
   정산은 이 저장소의 가격 profile(`lib/modelPricing.ts`)과 크레딧 환산을 그대로 씁니다.
   **Code가 보낸 금액을 믿지 않습니다** — 서버가 직접 provider를 호출하고 응답의 검증된 사용량으로
   정산합니다. Desktop은 사용량이나 청구액을 제출하지 않습니다.
3. **예약 잔액이 호출 하나를 감당하지 못하면 그 호출을 보내기 전에 거절**하고, 거절 사유가
   "태스크 상한"임을 돌려줍니다. 계정 크레딧 부족과 구별합니다(사용자가 할 수 있는 일이
   다르다 — 하나는 상한을 올리고, 하나는 크레딧을 산다).
4. **종료 시 해제.** 태스크가 완료·거부·취소·중단(Code의 `INTERRUPTED`)으로 끝나면 남은
   예약을 해제합니다.
5. **정산을 모르면 예약만큼 쓴 것으로 칩니다.** 호출 결과를 모르는 상태(응답 유실,
   `outcome_unknown` 성격)에서 예약을 0으로 해제하지 않습니다. 이 규칙은 TomverseCode가
   자기 Fleet 예산에서 실측한 결함("조회 실패를 0으로 접으면 예산에 자리가 열린다")과 같은
   뿌리입니다. **사용자에게 청구하는가**는 별개이며, 증거 없이 청구하지 않는다는 이 저장소의
   현행 방향(reconciler 환급)을 따릅니다.
6. **orphan 예약 정리.** 태스크 예약은 lease처럼 heartbeat로 유지하고, Code Desktop이
   heartbeat를 멈추면 TTL 뒤 `interrupted`로 확정해 해제합니다. 정리는 기존 15분 주기
   maintenance(`/api/internal/maintenance/credit-reservations`)에 붙입니다. 자동으로 태스크를
   재개하지 않습니다 — Code도 비정상 종료한 태스크를 자동 재개하지 않습니다.

**잠금 순서.** 태스크 예약·호출 정산·해제는 전부 credit-and-cost-limits.md §9의 순서를
따릅니다 — `lockCreditAccount(tx, userId)`를 **가장 먼저**, 그 다음 workflow 잠금
`code-task:<userId>` **[제안: 이름]**, 그 다음 버킷, 마지막에 reservation/lot. 구현하면
§9의 "현재 잠그는 곳" 표에 행을 더하고 `tests/creditLockOrder.test.mjs`의 caller 목록에
넣습니다. 판정과 예약을 다른 트랜잭션으로 나누지 않습니다.

## 4. 태스크 단위 호출 천장 (operational guardrail)

§3은 **돈**을 막습니다. 같은 태스크가 상한 안에서 비정상적으로 많은 호출을 하는 것(수정
루프 폭주, 클라이언트 결함)은 별도의 운영 장치로 막습니다.

- **천장은 손으로 고르지 않고 유도합니다.** Code는 모든 루프에 상한이 있고(명확화 ≤2, 수정
  ≤2, 수정 루프 ≤3, provider 재시도 ≤3, 계획 라운드·서브태스크 수 상한), 그 상한들의 곱이
  태스크 하나가 정당하게 할 수 있는 최대 호출 수입니다. **[미결정] 값** — TomverseCode의
  상한 정의(`TaskLoopLimits`)에서 유도하는 식을 이 문서에 적고, 그 값에 여유 배수를 곱합니다.
  credit-and-cost-limits.md §2의 "guardrail은 entitlement에서 유도한다"와 같은 이유입니다.
- **환경변수 override는 유도값 아래로 내려갈 수 없습니다**(같은 문서 §2의 clamp 규칙).
- 층은 `operational_guardrail`, 오류 코드는 코딩 전용 **[제안]
  `CODE_TASK_CALL_CEILING_REACHED`**입니다. `OPERATIONAL_COST_GUARDRAIL_TRIGGERED`를 재사용하지
  않습니다 — 비용이 아니라 호출 수가 원인이고, 운영자가 볼 곳이 다릅니다.
- 천장에 걸리면 Code는 태스크를 멈추고 그 사실을 사용자에게 말합니다. 조용히 다른 모델로
  바꾸지 않습니다.

## 5. 분당 요청 rate

채팅의 분당 rate(`CHAT_USER_PER_MINUTE` 등)는 **사람이 입력하는 속도**를 전제로 합니다. 코딩
태스크는 사람의 입력 없이 짧은 시간에 호출이 몰리므로 그 한도를 그대로 쓰면 정상 태스크가
걸립니다.

- 코딩은 **별도 rate scope** **[제안] `code_rate_minute`**와 별도 환경변수를 씁니다.
  `CHAT_USER_PER_MINUTE`를 올려서 코딩을 통과시키지 않습니다 — 그러면 채팅의 남용 방어가
  약해집니다.
- 층은 `rate_limit`이며 entitlement로 기록하지 않습니다(chat-concurrency-and-identity.md §3.1과
  같은 규칙). 값은 **[미결정]**.

## 6. 가격과 모델 자격

- **관리형 코딩 모델은 명시적이고 검증된 가격을 가집니다.** 가격은 동적 카탈로그 행
  (`ModelCatalogEntry` coding, `profile.pricing`: 단가·`creditWeight`·확인일·공식 출처)에 있고,
  판정 함수(`judgeCodingModel`, `lib/modelCatalogCore.ts`)가 공식 도메인이 아닌 출처를 거절합니다.
  가격이 없거나 검증되지 않은 행은 켤 수 없습니다(운영자 결정 2026-10-19: 코딩 모델을 배포 없이
  추가할 수 있게 `lib/modelPricing.ts` profile을 필수로 두지 않음).
- **약관 근거가 없는 모델은 코딩 카테고리에서 거절합니다.** provider의 재판매·코딩 에이전트
  용도 허용 근거(출처 URL·확인일)와 데이터 보존 정책 근거가 기록되지 않은 모델은 판정
  함수가 거절합니다. 비어 있는 근거를 "허용"으로 읽는 기본값을 두지 않습니다.
  같은 판정이 `providerDataDestinations`의 해당 provider 행이 established(proven)인지도 봅니다.
- **Code에 내려주는 카탈로그는 불변 스냅샷**(`version`·`contentHash`·`coverageUntil`)이며,
  **목록은 허가가 아닙니다** — 권한은 호출마다 서버가 다시 판정합니다.
  발행은 Admin `/admin/models?tab=coding`(코딩 카탈로그 탭, 2026-11-20에 이미지 카탈로그
  `?tab=catalog`에서 분리), 조회는 `GET /api/code/model-catalog`
  (`?version=N`이면 바뀌지 않았을 때 `unchanged`), coverage가 지난 스냅샷은 503입니다.
  태스크 예약 행은 그 태스크가 견적받은 스냅샷 `version`을 기록하고, 정산은 그 버전의 가격으로 합니다.

### 6.1 코딩 카탈로그의 두 가지 행 (운영자 결정 2026-11-20)

- **코딩 전용 행**(`profile.source`가 없거나 `dedicated`): 채팅에 없는 모델입니다. 위 6절대로
  행이 이름·공급자·단가·능력·출처를 모두 갖고, LLM 초안(`draft`)으로 채웁니다.
- **채팅 모델 연결 행**(`profile.source: "chat"`, `registryModelId` = 행의 `modelId`):
  이름·공급자·API 모델 id·단가·컨텍스트·최대 출력·이미지 입력을 **복사하지 않고 읽을 때마다**
  채팅 레지스트리(`ModelRegistryEntry`)에서 가져옵니다. 단가는 채팅 가격 해석
  (`resolveModelPricing`)이 컨텍스트 전체 크기에서 내는 값(장문 구간)이고, 확인 근거는 채팅
  가격표의 `pricingVersion`입니다. 대체 가격(conservative fallback)이면 판정이 거절합니다.
  행에는 코딩 전용 값만 저장합니다: `toolCalling`·`structuredOutput`(LLM 초안, 운영자가 수정
  가능), `minimumPlan` 덮어쓰기(없으면 채팅 플랜, Guest는 Free), `creditWeight`(없으면 채팅
  가중치, 하한 미만이면 켤 수 없음), 노출 채널 `channels`.
- 연결한 채팅 모델이 비활성·삭제되면 판정이 거절합니다(`chat_model_disabled`·`chat_model_deleted`).
  채널에 `code`가 있으면 추론 토큰 별도 과금 모델과 관리형 경로가 부르지 않는 공급자도 판정에서
  거절합니다(관리형 경로의 같은 거절을 활성화 전에 보입니다).
- 스냅샷 행은 해석된 값(상속 값 포함)과 `source`·`channels`를 담습니다. 이전에 발행한 행에는
  둘이 없고, 읽을 때 `dedicated`·`["code"]`로 읽습니다. `POST /api/code/managed`는 스냅샷 행과
  지금 해석한 행을 canonicalJson으로 비교하므로, 채팅에서 단가·상한이 바뀐 연결 행은 다시 발행할
  때까지 `CODE_MODEL_UNAVAILABLE`입니다. `channels`에 `code`가 없는 행도 같은 거절입니다.
  `GET /api/code/model-catalog`는 스냅샷을 그대로 내려주며(목록은 허가가 아님), 클라이언트는
  `channels`에 `code`가 있는 행만 보여야 합니다.
- 이 변경 뒤 처음 계산한 해시는 `source`·`channels`가 들어가 이전 스냅샷의 `contentHash`와 다릅니다.
  정기 갱신(`renewCodingSnapshotIfUnchanged`)은 이전 스냅샷의 행을 지금 schema로 다시 읽은 해시
  (`normalizedSnapshotContentHash`)도 비교하므로, 내용이 같으면 사람이 발행하지 않아도 갱신합니다.
  다시 읽을 수 없는 행이 있거나 내용이 실제로 다르면 갱신하지 않고 사람의 발행을 기다립니다.

### 6.2 공급자 조건 (공급자 단위)

- 약관(재판매·코딩 에이전트 허용, URL), 보존(URL), 처리 리전, 확인일, 출처는 공급자마다 한 행
  (`CodingProviderTerms`)입니다. 판정은 연결 행과 전용 행 모두 이 행을 읽습니다.
- 공급자 행이 없는 **전용 행은 자기 행의 terms·retention·processingRegion을 대체 값으로 씁니다.**
  배포만으로 지금 활성인 행이 거절되지 않게 하려는 것입니다(데이터 이전 없음). 공급자 행을
  적용하면 그때부터 그 공급자의 모든 행이 공급자 행을 씁니다. 연결 행에는 대체 값이 없어 공급자
  행이 없으면 거절합니다(`provider_terms_missing`).
- **유효기간 90일**: 확인일부터 90일이 지나면 "다시 확인 필요"입니다. 그 공급자의 모델은 **새로
  활성화할 수 없고**(`provider_terms_expired`), **이미 활성인 모델은 경고만 띄우고 계속 씁니다.**
  90일은 재확인 주기이지 약관이 바뀌었다는 근거가 아니며, 거절로 두면 다음 발행·정기 갱신에서
  활성 모델이 빠져 Code 관리형 작업이 끊기기 때문입니다. 약관이 실제로 바뀌었으면 다시 확인
  초안을 적용하는 순간 판정이 바뀌어 다음 발행에서 빠집니다.
- "다시 확인"은 공급자 공식 문서를 읽는 LLM 초안(`MODEL_CATALOG_DRAFT_LLM_MODEL_ID`, 호출 1회)이며
  가져오는 URL과 답의 URL 모두 `isOfficialSourceUrl`로 검사합니다. 초안은 운영자가 지금 값과
  비교한 뒤 적용하고, 저장·적용·버리기는 각각 감사 기록과 함께 씁니다.

### 6.3 코딩 API (기본 꺼짐)

외부 API는 주소로 둘로 나뉩니다(운영자 결정 2026-11-21, docs/policy/external-api.md). 일반 API
(`/api/v1`, `/api/anthropic`)는 Aside 같은 앱용이고 항상 채팅 레지스트리를 씁니다. 코딩 API
(`/api/code/v1`, `/api/code/anthropic`)는 Claude Code·Codex·Cursor·tomverse CLI용입니다.
User-Agent로 채널을 나누지 않습니다.

- 노출 채널은 `code`(Code 관리형 경로)와 `api`(코딩 API) 둘입니다. 예전에 저장된 `cli`는
  읽을 때 코딩 API로 봅니다(`onCodingApi`). 저장된 행과 스냅샷을 다시 쓰지 않으므로 스냅샷 해시와
  관리형 경로의 canonicalJson 비교가 그대로입니다. Admin은 "Code / 코딩 API" 둘만 보이고, 저장할 때
  `api`를 씁니다. 전용 행도 코딩 API 채널을 고를 수 있습니다(전용 행에서 바꿀 수 있는 설정은 채널
  하나이며, 새 초안을 적용해도 채널은 유지됩니다).
- `CODING_CATALOG_EXTERNAL_CHANNELS_ENABLED`가 `true`가 아니면 코딩 API는 일반 API와 똑같이 채팅
  레지스트리를 보여 주고 실행합니다(코딩 카탈로그를 읽지 않음). 클라이언트가 새 주소로 옮겨도
  깨지지 않게 하려는 것입니다.
- 켜면 최신 코딩 스냅샷에서 코딩 API 채널이 있는 행(채팅 연결 행과 전용 행 모두)만 코딩 API의
  모델 목록, Smart Adaptive 후보, 코딩 앱 설정, 네이티브 프로토콜(Anthropic Messages·Responses)에
  남습니다. 스냅샷에 있는 것만으로는 부족하고 **지금도 판정을 통과해야** 합니다(켜짐·보류 아님·지금
  행에도 코딩 API 채널이 있음·공급자 조건 허용). 보류나 거절로 바뀐 다시 확인은 다음 발행을 기다리지
  않고 바로 빠집니다. 발행된 행이나 지금 행의 `minimumPlan`이 계정 플랜보다 높아도 빠집니다.
- **채팅 연결 행**은 채팅 레지스트리 경로 그대로 실행·과금합니다(가격·크레딧은 채팅 모델의 것).
  연결 행의 `creditWeight` 덮어쓰기는 Code 관리형 경로에만 쓰입니다.
- **전용 행**은 발행된 자기 행으로 실행합니다(`lib/codingRowRuntime.ts`, 관리형 경로와 같은 변환).
  단가는 행의 입력·출력 단가이며, 외부 API의 기존 예약·정산(`acquireChatAccess`·`settleChatUsage`,
  공급자 비용 예산, 동시성, 키 상한, 계정 크레딧)을 그대로 탑니다.
- **전용 행의 코딩 API 크레딧**은 채팅과 같은 규칙입니다(운영자 결정 2026-11-21). 코딩 API는 모든
  모델의 입력을 `chatUserMaxInputTokens()`로 제한하고 채팅 예약·정산(입력 크기별 배수 포함)을 타므로,
  전체 컨텍스트를 최악의 입력으로 보는 Code 기준 하한(`codingCreditFloor`)은 여기서 과합니다.
  - 기본값은 채팅 규칙 하한입니다: `suggestCreditFloor`(채팅 레지스트리 화면·`modelAdoptionDraft`와
    같은 함수)에 행의 입력·출력 단가, 레지스트리 공급자 상한으로 묶은 최대 출력, Anthropic은 입력
    1.25배를 넣되, 입력 배수 구간(`INPUT_CREDIT_MULTIPLIERS`: 16k까지 ×1, 50k까지 ×1.5, 100k까지 ×2,
    그 위 ×3)마다 그 구간의 가장 큰 입력(상한 `chatUserMaxInputTokens()`까지)과 최대 출력으로 계산한
    값 중 가장 큰 것입니다. 출력 단가가 큰 모델은 짧은 입력 구간(×1)에서 하한이 정해집니다(검토
    r-20261121-013001-f5a5e7). 1,000(덮어쓰기 상한)을 넘는 하한은 계산할 수 없는 것으로 봅니다.
    `suggestCreditFloor` 자체는 바꾸지 않았습니다. 저장하지 않고 과금할 때 계산하므로
    `apiCreditWeight`가 없는 행과 스냅샷의 canonicalJson·해시는 그대로입니다. 그래서 이 값은
    `CHAT_USER_MAX_INPUT_TOKENS` 같은 런타임 값을 따라 달라집니다(채팅 모델 과금과 같은 성질).
  - 운영자가 더 받고 싶으면 전용 행에 `apiCreditWeight`(1~1,000 정수)를 넣습니다. 하한 이상이면 그 값을
    받고, 하한 미만이거나 하한을 계산할 수 없으면(가격·출력 상한을 모르거나 모든 등급을 넘음) 코딩
    API는 그 행을 노출하지 않습니다(`api_credits_below_floor:<N>`, `api_credit_floor_unbounded`).
    Code 노출은 그대로입니다. `apiCreditWeight`는 행의 일부라 바꾸면 다음 발행 뒤 적용됩니다.
  - `pricing.creditWeight`는 Tomverse Code(관리형) 크레딧으로 그대로이며, 판정의 Code 하한도 그대로입니다.
  - 예약 payload와 정산 `pricingSnapshot`에 `creditBasis: { basis: "chat_rule_floor" | "api_override",
    credits, floorCredits }`가 남습니다(새 컬럼 없음). `/api/code/v1/models`의 `credits_per_request`와
    Smart Adaptive의 크레딧도 같은 값입니다. Admin 코딩 행 상세는 두 크레딧을 나눠 보여 줍니다.
- 전용 행 실행의 그 밖의 규칙: 검증되지 않은 캐시 할인은 정가로, Anthropic 행의 캐시 쓰기는 자기
  입력 단가의 1.25배로 예약합니다. 예약과 정산 스냅샷에 `pricingVersion: coding_catalog_snapshot:<version>:<hash>`와
  `costSource: coding_catalog_snapshot`이 남아 어떤 카탈로그 버전으로 과금했는지 보입니다(새 컬럼
  없음). 지금 판정이 허용하는 행이 발행된 행과 정확히 같을 때만 노출합니다 — 바뀐 값은 다음 발행
  뒤에 과금합니다. 상한이 없는 공급자(`CODE_MANAGED_UNBOUNDED_PROVIDERS`)는 코딩 API 채널을 켠
  전용 행에서 판정이 거절하고(`provider_cost_unbounded`) 실행 직전에도 거절합니다. Code 크레딧
  (`pricing.creditWeight`)이 Code 하한 아래인 행은 판정이 이미 거절합니다.
- 플랜 검사(Free는 API·CLI 불가)는 두 API 모두 그대로입니다.
- 스냅샷이 없거나 coverage가 지났으면 코딩 API는 아무 모델도 내놓지 않습니다(채팅 레지스트리
  전체로 되돌아가지 않음). 로그 `coding_catalog_external_channels_no_snapshot`을 남깁니다. 발행 뒤
  바뀌었거나 실행할 수 없는 전용 행은 `coding_api_dedicated_rows_refused`로 남깁니다.

## 7. 제품 귀속

- 관리형 코딩 호출은 **Conversation 행을 만들지 않습니다.** `Conversation.productKey`에 `code`를
  넣지 않습니다(docs/policy/conversation-product-key.md — `code`는 Code가 Conversation을 쓰기
  시작할 때 추가하는 값이며, 관리형 추론은 그 조건이 아닙니다).
- 사용량·예약 행의 제품 귀속은 **서버가 Code 자격증명에서 유도한** `code`입니다. Code가 보낸
  값을 믿지 않습니다. 저장 필드는 **[미결정]** — routing-run-product-attribution.md의 스냅샷
  원칙(귀속은 조인이 아니라 실행 시점 스냅샷)을 따릅니다.

## 8. 관측

- `code_task_reservation` — 예약·정산·해제·orphan 정리. 태스크 id는 해시, 원시 코드·프롬프트·
  파일 경로는 넣지 않습니다.
- `chat_limit_decision`과 같은 모양의 **코딩용 한도 결정 로그**에 `limitLayer`를 기록합니다.
  태스크 상한 소진(entitlement 쪽), 호출 천장(`operational_guardrail`), rate(`rate_limit`)를
  섞지 않습니다.

## 9. 바꾸기 전에

- 코딩 전용 크레딧 풀이나 숨은 코딩 USD 한도를 만들지 않습니다.
- 태스크 예약을 요청 단위 예약으로 바꾸지 않습니다(§1).
- 정산 불명 상태를 0으로 해제하지 않습니다(§3-5).
- 채팅의 rate·동시 실행 한도를 올려 코딩을 통과시키지 않습니다.
- 이 문서의 **[제안]·[미결정]** 값은 구현 PR에서 정하고, 그 PR이 이 문서를 함께 고칩니다.

## 10. 구현한 A1 서버 계약

- `POST /api/code/managed`는 엄격한 `reserve | complete | heartbeat |
  release | status` action을 받습니다. 세션 인증, 명시한 같은 출처 `Origin`,
  `X-Tomverse-Code: 1`이 필요합니다. provider 주소와 자격증명 별칭은 코드가 정하며
  클라이언트가 제출하지 않습니다.
- 크레딧 상한 승인은 첫 유료 계획 호출보다 앞섭니다. 파일 변경 계획 승인은 뒤의 별도
  게이트입니다. 예약은 불변 카탈로그 버전/hash와 실제 공급자가 다른 실행자·검토자를
  고정합니다. 새 호출마다 현재 카탈로그 자격과 플랜을 다시 확인합니다.
- coding 카탈로그 전용 동적 행은 Chat 정적 모델이나 `modelPricing.ts` 항목 없이도
  실행됩니다. snapshot의 단가·상한·creditWeight가 정본이고, 같은 공급자/API의 기존
  profile이 있으면 검증한 추가 상한을 사용합니다. 미검증 캐시 할인은 일반 입력 단가,
  Anthropic 캐시 쓰기는 기존 1.25 상한을 적용합니다. 지원하지 않는 중계나 상한 없는
  검색 비용은 전송 전에 거절합니다. 도구나 캐시 marker는 활성화하지 않습니다.
- Code verified 루프는 `3*(2*2+1+8)+1+2+3+(3+3)=51` 의미 호출이며,
  네 번의 provider 시도와 여유 배수 2를 곱해 **태스크당 408회**입니다.
  `CODE_TASK_CALL_CEILING`은 이 아래로 내려가지 않습니다. 별도 계정 분당 rate는
  `호출 천장 * 태스크 슬롯`으로 기본 **3264회**, scope는 `code_rate_minute`입니다.
  동기 출력은 카탈로그 상한과 **16000토큰** 중 작은 값이며, SDK가 정규화한 유료
  reasoning 토큰을 포함합니다.
- 태스크 TTL **120초**, 권장 heartbeat **30초**, provider timeout **60초**이며 SDK
  재시도는 꺼져 있습니다. 호출 UUID와 요청 HMAC으로 의미 시도를 고정하며, 전송한 UUID의
  재요청·변조는 다시 전송하지 않습니다. 상태 영수증에는 생성 텍스트가 없고 보관하지 않습니다.
- 호출 입력 예약은 검증한 프롬프트·schema의 UTF-8 바이트 수에 framing 4096을 더한
  보수적 tokenizer 상한입니다. 모델의 전체 context를 매번 예약하지 않습니다. 이 상한과
  출력 상한을 호출 가격 snapshot에 고정하고, 실제 사용량이 넘으면 unknown hold를 보존합니다.
- `CodeTaskReservation`과 `CodeManagedCall` 모두 서버가 정한 `productKey=code`를
  저장합니다. `lib/codeManagedService.ts`는 기존 구매 크레딧 ledger와 공용 운영·provider
  버킷을 사용합니다. 계정 잠금 → 공용 usage subject → `code-task:<userId>` → 버킷 → provider 버킷 순서이며,
  플랜·entitlement의 금전 판정은 계정 잠금 후 같은 transaction에서 재조회합니다.
  사용자 시간대 변경은 같은 계정·subject 잠금 아래 현재 day/token/plan-cost/전체-cost 버킷과
  그 버킷을 참조하는 Code 태스크의 `dayStart`를 함께 이동합니다. 과거 날짜·월·provider UTC
  버킷과 카탈로그/호출 가격 snapshot은 변경하지 않습니다.
- 과금 영수증은 원래 `reservedCredits`, 누적 `settledCredits`, `releasedCredits`, 현재
  `heldCredits`, `unknownHeldCredits`, 즉시 사용 가능한 `availableCredits`를 구분합니다.
  호출별 `callCredits`는 별도입니다. 사용량이 확인된 schema 실패는 provider 비용과 사용량을
  보존하고 기존 규칙대로 사용자 크레딧은 환급합니다.
- 해제와 기존 maintenance는 쓰지 않았음이 확인된 몫만 환급합니다. 결과를 모르는 호출은
  hold를 유지하고, 사용량 없이 청구하거나 같은 호출을 다시 보내지 않습니다.
  **unknown hold의 해소에는 provider 증거와 수동 운영 대사가 필요합니다. A1은 이를
  기한만으로 환급하지 않으며 운영 대사의 자동 완료를 구현했다고 주장하지 않습니다.**
- 한도 거절은 기존 `recordChatLimitDecision`의 `code_reservation` phase와 해시 주체를
  사용해 entitlement·운영 guardrail·동시 실행·rate를 구분합니다. 프롬프트·생성 JSON·소스·
  파일 경로·자격증명은 태스크/호출 행과 진단에 저장하지 않습니다.
- 로컬 검증은 `npm run test:code-managed`, `npm run test:code-managed-db`입니다.
  DB 검증은 test 이름 표식이 있는 migration 완료 loopback `TEST_DATABASE_URL`을 명시하며,
  운영 추론을 활성화하지 않습니다. migration은 `20261022000000_code_managed_execution`입니다.

## 11. unknown hold의 증거 기반 운영 대사

- `POST /api/admin/code/managed-reconciliation`은 별도
  `CODE_MANAGED_RECONCILIATION_ENABLED=true`가 필요한 기본 비활성 경로입니다.
  기존 owner 권한·최근 재인증·같은 출처·rate 제한을 사용합니다.
- `callId`, 대사 UUID, 제한된 메타데이터 `evidenceRef`, `no_provider_usage | known_usage`를
  받고 unknown 호출 하나만 처리합니다. known 사용량은 입력·출력·캐시·reasoning 상한과
  동결 가격을 검증합니다. 범위 밖 사용량은 거절하며 hold를 줄이지 않습니다.
- 원래 호출이 결과를 전달하지 못했으므로 새 사용자 청구는 0입니다. 검증한 provider 비용만
  확정하며 다른 진행 중·unknown hold는 보존합니다. 원래 태스크는 종료해 자동 재개하지 않습니다.
- 같은 대사 UUID와 내용은 멱등이며 내용이나 대상 변경은 409입니다. 상태·환급·기존
  hashchain 감사행을 같은 transaction으로 쓰고 늦은 provider 응답은 이를 덮어쓰지 못합니다.
- 계정 삭제는 lot/purchase 연결을 지우고 비개인 금전 합계만 남깁니다. 삭제된 계정의 대사는
  전역 provider hold와 보존한 금전 합계만 정리하며 wallet이나 고객 식별자를 복원하지 않습니다.
  운영자가 provider 증거를 확인하는 절차를 자동 증명으로 대신하지 않습니다.
