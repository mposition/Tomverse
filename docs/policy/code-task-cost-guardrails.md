# Code 관리형 태스크의 크레딧 예약과 비용 guardrail

**상태: 설계 정책입니다. 코드는 아직 없습니다.** TomverseCode(Windows 데스크톱 코딩
어시스턴트)에 관리형 모델 카탈로그 경로가 생기기로 했고([TomverseCode product-strategy 17절](https://github.com/mposition/TomverseCode/blob/main/docs/design/product-strategy.md) — 2026-09-30 결정), 그 과금을 맡는 **Code 제품
서비스**를 이 저장소에 두기로 했습니다. 이 문서는 그 서비스가 구현될 때 지켜야 할
크레딧·비용 계약을 **구현보다 먼저** 적어 둡니다.

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

1. **태스크 예약.** 사용자가 Code에서 태스크 계획을 승인하는 순간, Code 제품 서비스가 그
   태스크의 **상한 크레딧**을 예약합니다. 상한은 사용자가 승인 카드에서 본 값입니다(Code
   쪽 `TaskBudget` 상한). 크레딧이 모자라면 **태스크가 시작하기 전에** 거절합니다 — 중간에
   멈추는 것보다 시작 전에 멈추는 것이 사용자에게 싸다.
2. **호출별 정산.** 태스크 안의 관리형 호출은 매번 그 예약에서 실제 사용량만큼 정산합니다.
   정산은 이 저장소의 가격 profile(`lib/modelPricing.ts`)과 크레딧 환산을 그대로 씁니다.
   **Code가 보낸 금액을 믿지 않습니다** — Code는 사용량을 보고할 수 있어도 가격을 정하지
   않습니다.
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

- **관리형 코딩 모델은 전부 `lib/modelPricing.ts`에 명시적 가격 profile을 가집니다.**
  `npm run check:model-pricing`의 fail-closed 규칙이 그대로 적용됩니다.
- **약관 근거가 없는 모델은 코딩 카테고리에서 거절합니다.** provider의 재판매·코딩 에이전트
  용도 허용 근거(출처 URL·확인일)와 데이터 보존 정책 근거가 기록되지 않은 모델은 판정
  함수가 거절합니다. 비어 있는 근거를 "허용"으로 읽는 기본값을 두지 않습니다.
- **Code에 내려주는 카탈로그는 불변 스냅샷**(`version`·`contentHash`·`coverageUntil`)이며,
  **목록은 허가가 아닙니다** — 권한은 호출마다 서버가 다시 판정합니다.

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
