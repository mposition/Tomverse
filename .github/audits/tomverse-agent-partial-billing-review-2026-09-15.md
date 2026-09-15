# Agent 부분 실패 과금 초안 검토 — 2026-09-15

상태: **수정 후 자문 백로그 채택 / 제품·청구 정책 미승인 / 구현 미착수**.

## 1. 결론·배치

“승인한 상한 안에서, 전달한 산출 단위만 청구하고 실패 원가는 운영 비용으로 분리한다”는
방향을 채택 후보로 권장합니다. `AGENT-BILL-01`을 **CREDIT-CAP-01 하위 세부 과제**로
등록합니다. 별도 대규모 결제 시스템 개발이 아니며 기존 항목과 공수를 중복 계산하지 않습니다.

- 포트폴리오 우선순위는 **후속 P2**입니다. 기존 Chat → Code 내부 대체 검증 → Native →
  Memory Release B → 제한형 MCP 순서와 안전·CONT-01·기존 P1 개선은 유지합니다.
- 다만 **유료 REVIEW-AGENT-01 출시에 앞서는 필수 완료 조건**입니다. Agent UI를 먼저
  유료로 열고 나중에 정산·재개를 붙이는 순서는 권장하지 않습니다.
- 지금 할 수 있는 것은 정책 선택지·산출 단위·상태/금액 대조표·무과금 테스트 시료 준비입니다.
  본 문서는 정책 편입, 가격 확정, schema 변경, 유료 호출 또는 production 활성화 승인이 아닙니다.

## 2. 조사 기준

원래 작업 폴더의 미커밋 변경·detached HEAD를 보존하고 이번 요청에서도 origin을 fetch했습니다.
최신 develop의 별도 clean worktree에서 코드/정책을 읽었습니다.

- develop: `3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6`
- main: `938816f2bcf56a2a289758f6bbb6353ee93ce1c6`
- 분석 폴더: `C:/Users/Vyper/AppData/Local/Temp/tomverse-agent-billing-review-e90fe978`
- 표적 비교한 Memory 사용자 정산·공급자 원가·실행 service, creditDebt/creditPurchase,
  imageGenerationService 파일은 두 ref 간 차이가 없었습니다. 실제 배포와는 구분합니다.
- Memory가 “운영 중”이라는 초안의 전제는 **이 회차에 독립 확인하지 않았습니다**.
  코드·locale·테스트의 존재를 runtime extraction flag나 정상 정산 증거로 바꾸지 않습니다.
- smart-explore의 구조 검색은 별도 폴더 접근 제한으로 실패하여 파일 검색으로 보완했습니다.
  정적 조사이며 DB·provider·결제 시스템을 실행하거나 유료 turn을 쓰지 않았습니다.

## 3. Memory 선례는 어디까지 재사용할 수 있는가

`settleExtractionRunCredits()`는 완료 chunk 수를 전체 수 범위로 제한한 뒤
`min(reservedCredits, floor(reservedCredits × chunksCharged / chunkTotal))`로 정산합니다.
전체 0개면 0입니다. 동일 단가 chunk를 전제로 한 비율 산식이며 **Agent의 모든 산출물에
가격이 같다는 근거는 아닙니다**. 단가가 다른 항목을 섞으면 승인 시 동결한 항목별 가격 합계가
필요하고, 반올림도 재개 횟수에 따라 달라지지 않아야 합니다.

또한 `completed chunk`는 “사용자가 유용한 기억 하나를 받아 승인했다”와 다릅니다.
정산은 후보 수·활성 Memory 수를 읽지 않습니다. worker는 정상적인 후보 0건 결과도 완료로
처리하며, **선택 원문이 전부 사라진 chunk도 호출 없이 completed로 돌려주는 분기**가 있습니다
(`memoryExtractionWorker.ts:271`). service는 completed 수를 과금에 넘깁니다.

따라서 “Memory가 이미 받은 산출물만 과금하는 문제를 전부 해결했다”는 문장은 고칩니다.
원문이 없어진 chunk의 정산 정합성은 Memory 별도 확인 후보이며, 운영 발생이나 실제 손해를
확인한 것은 아닙니다. 새 Agent 규칙을 소급 적용하거나 이 회차에 Memory 과금을 바꾸지 않습니다.

재사용 대상은 계정 잠금·예약/환급 primitive·동결 snapshot·durable 실행/attempt 구분입니다.
Memory 전용 테이블/도메인 필드를 Agent 데이터 저장소로 그대로 쓰는 것은 권장하지 않습니다.

## 4. 규칙별 판단

| 초안 규칙 | 판단 | 보정할 내용 |
| --- | --- | --- |
| 1. 받은 것만 청구 | 방향 채택, 정의 승인 필요 | “받음”은 화면을 열었는지가 아니라 계약상 결과가 정상 저장되고 소유자에게 이용 가능해진 시점. 저장 실패·깨진 파일·검색 실패는 분리 |
| 2. step 아닌 산출 단위 | 채택 | v1은 선택 검증 항목. 검색 횟수·추론 step은 청구 단위 아님. 근거 부족/상충 결과의 유료 조건·항목별 가격·완료 기준을 먼저 정함 |
| 3. provider 비용 별도 기록 | 채택·강화 | 실패·취소·stale worker 호출도 남김. 미확인 비용은 0이나 확정 실비로 꾸미지 않고 보수적 예약/추정과 대사 상태를 분리 |
| 4. 상한 초과 debt 금지 | 약속은 채택, 기존 debt 설명은 오류 | 이 Agent 실행의 초과 비용을 사용자 debt로 전가하지 않음. 기존 구매 환불·분쟁 채무와 차감/상계는 제거하지 않음 |
| 5. 예약 가격 동결 | 채택·두 층 구분 | 사용자 가격/정산은 승인 snapshot. provider 원가는 실제 호출 당시 요율·usage·출처를 별도로 추적; 과거 사용자 견적으로 실제 비용을 덮지 않음 |
| 6. 정산 멱등성 | 채택·구체화 필수 | 상태명만으로 exactly-once가 아님. 원자적 claim·ledger·최종 상태·rollback/reconcile 및 재조회 계약 필요 |
| 7. 유계 재시도/fencing | 채택·확대 | SDK 내부 retry·fallback·검색 subcall까지 포함. fencing은 결과 쓰기를 막되 이미 나간 호출의 원가 기록을 막지 않음 |

### 4.1 “확인 완료”와 과금 가능 결과의 정의

권장 방향은 **결론의 방향이 아니라 조사 결과의 제공**을 청구 단위로 삼는 것입니다.
“참이라고 확인됐을 때만 유료”는 근거 부족을 인정하는 대신 확답을 만들 유인을 줍니다.
아래는 승인 전 제안이며 현재 제품 가격 정책이 아닙니다.

- 지지/반박 근거를 담은 결과: 출처·대상 주장·확인 시각·한계를 갖춰 저장/열람 가능하면 유료 후보.
- 출처 상충 또는 근거 부족: 조사 범위와 한계가 설명된 정상 결과라면 유료 후보로 둘 수 있으나,
  **이 결과도 청구될 수 있다는 사실을 실행 전에 알려야** 합니다. 단순 status 문자열은 산출물이 아닙니다.
- timeout·모든 검색 실패·schema/저장 실패·미실행: 사용할 결과가 없으므로 비과금 후보.
- 취소와 완료가 경합하면 durable 결과 commit과 취소 판정의 선후를 서버에서 고정합니다.
  늦게 온 결과로 이미 확정한 환급을 뒤집거나 사용자의 승인 범위를 넓히지 않습니다.
- 사용자가 나중에 결과를 삭제하거나 열지 않았다는 이유만으로 자동 환급되는 구조는 아닙니다.
  제공 전 저장/권한 실패와 제공 후 사용자의 선택을 구분하고 오류 보상은 별도로 정합니다.

`unsupported`는 “거짓”의 동의어가 아닙니다. 실행 완료·근거 상태·청구 가능 상태를 각각 두고,
근거 부족을 장애와 합치거나 모든 처리 완료를 “미해결 0”으로 표시하지 않습니다.

### 4.2 CreditDebtEntry는 Agent 상한의 대체물이 아닙니다

`increaseCreditDebt()`의 증가 유형은 refund_unrecovered/dispute_unrecovered/admin_adjustment이며,
실제 `creditPurchase.ts:360` 호출은 구매 환불·분쟁 때 회수하지 못한 크레딧을 기록합니다.
**“debt는 상한 없는 단건 요청의 장치”라는 초안 설명은 현 코드와 맞지 않습니다.**

권장 문장: “이 작업의 승인 상한 초과분·실패 원가로 새 사용자 debt를 만들지 않는다.
구매 환불·분쟁 등에 따른 기존 계정 채무 및 그 처리 정책은 별개로 유지한다.”
상한 보장과 실패 무료는 독립된 약속입니다. 상한 안의 실패 비용 청구도 ‘실패 무료’ 약속에는
어긋날 수 있지만, 그것이 곧 상한 초과라는 뜻은 아닙니다.

### 4.3 상한에 도달한 뒤 멈추는 것으로는 부족합니다

새 호출 **전**에 확정 청구와 아직 실행 중인 약정/예약을 포함해 승인 상한을 검사합니다.
동시 항목이 같은 잔여액을 각각 써 버리지 않도록 판정·예약은 원자적이어야 합니다.
상한이 없으면 provider 호출도 나가지 않아야 하며 추가 예산은 새 승인을 받습니다.

원가는 별도 admission/예약을 적용합니다. 취소는 provider 청구 취소 보장이 아니고,
일/월 provider 한도도 **이미 발생한 원가의 사후 초과를 없애지는 못합니다**. Memory도
실제 원가가 예약을 넘으면 기록하고 다음 admission을 막습니다. 미확인 호출은 보수적으로
남기며 `usageConfirmed=false` 등을 통해 확정값과 구분합니다.

재시도 제한+전역 일/월 한도만으로 한 사용자의 반복 무료 실패가 다른 사용자 예산을
고갈시키는 것을 충분히 막았다고 보지 않습니다. Agent 실행별 호출/검색 수·시간·회사 손실
노출, 사용자 반복 시작/취소의 rate/concurrency 통제를 별도 운영 층에서 검토합니다.
숨은 사용자 USD entitlement를 만들거나 기존 guardrail 바닥을 임의로 낮추지 않습니다.
자체 검색을 선택하면 모델 provider뿐 아니라 `SEARCH_PROVIDER_*` 예산도 별도로 적용합니다.

### 4.4 멱등성은 세 수준에서 필요합니다

1. **작업 제출**: 동일 시작 요청 재전송이 새 예약/작업을 만들지 않습니다.
2. **산출 단위**: 동일 논리 항목·원문/Review 버전의 성공 결과와 청구는 한 번입니다.
   재개는 미완료만 대상으로 하고 완료분을 재호출/재과금하지 않습니다.
3. **실제 시도**: provider attempt마다 원가를 기록합니다. 실패 retry가 늘어도 사용자에게
   완료 산출 단위를 여러 번 청구하지 않습니다. 새 검색/다른 버전의 명시적 재실행은 별도 승인입니다.

이미지의 `retryIdempotencyKey`는 **ImageGeneration attempt**의 필드이며 target과 함께 unique입니다.
성공 target의 retry를 거절하는 service 선례와 함께 볼 대상이지, 그 키 하나로 Agent 전체
재개 과금이 해결되는 것은 아닙니다. 이미지 retry는 새 예약인 반면 Agent 자동 retry는
원래 승인 상한을 유지해야 합니다. **재개 시 재과금 금지 방법은 v1에서 확정해야 합니다.**

Memory 사용자 정산은 외부 I/O 없이 전달받은 transaction 안에서 reserved→settling→settled와
환급을 모두 처리하고, service가 terminal 전환도 같은 transaction에 묶습니다. 중간에 실패하면
전체 rollback합니다. claim만 먼저 commit한 뒤 “두 번째는 아무것도 안 함”으로 구현하면
영구 settling이 생길 수 있으므로, 별도 단계 설계라면 복구 가능한 claim/lease·reconciler가 필요합니다.
DB ledger의 중복 반영 방지와 외부 모델 호출의 exactly-once는 같은 보장이 아닙니다.

provider 원가도 독립적으로 동시 중복 정산을 검증해야 합니다. 현 Memory provider 정산은
`settledAt` 읽기 후 차액 반영이고 확인한 idempotency 테스트는 **순차 재호출**입니다.
worker/sweep 동시 진입에 대한 보장으로 확대하지 않습니다. 같은 패턴 재사용 전 원자적
claim/잠금과 DB 동시성 검증을 요구하며 운영 중복 발생을 확인한 것으로 기록하지 않습니다.

### 4.5 사용자 표시와 재개 후 금액

이전 CREDIT-UX-01은 **작업 중 모든 숫자 숨김**을 승인하지 않았습니다. 진행 화면을 간결하게
유지할 수는 있지만 승인 상한·예약/정산 상태·상세 접근·중단 제어는 유지해야 합니다.
작업 종료와 정산 완료도 분리하여 정산 중에 “환불 완료” 숫자를 확정 표시하지 않습니다.

사용/환급 수치는 실제 ledger 결과에서 읽습니다. “환불”이 카드 환불로 오해되지 않도록
“미사용 예약 크레딧 반환” 등 문구를 검토하고, 원래 플랜 기간·구매 lot·만료/환불/분쟁 상태별
반환을 따릅니다. 만료된 lot에 숫자를 돌려놓는 것과 지금 사용할 잔액이 늘어나는 것은 다릅니다.

초안의 18/22·32/8은 가격표가 없는 예시일 뿐입니다. 항목마다 가격이 다르면 “8개 완료”로
18크레딧을 유도할 수 없습니다. 승인 총액·단위별 가격·반환 합계가 맞는 예시를 승인 후 만듭니다.
재개 때 앞선 확정액+미완료분 새 예약이 원래 승인액을 넘지 않게 하고, 반환 후 재예약할 잔액이
부족하거나 승인 유효기간이 끝난 경우는 명시적으로 안내합니다. 가격/범위 변경은 재승인합니다.

게스트 제외 v1을 권장하되 서버에서도 명시적으로 거절하고 로그인 안내를 둡니다.
“게스트 과금 세부표 불필요”는 가능하지만 “게스트 정책/권한 경계 자체 불필요”는 아닙니다.

## 5. 완료 조건과 검증 후보

정책 결정: 청구 가능한 상태·완료/제공 시점, 균등/항목별 가격과 반올림, 취소/잠금/삭제 경합,
resume/new-run 관계와 승인 유효기간, 원래 lot/기간 반환, 회사 손실 운영 한도를 확정합니다.
사용자 콘텐츠는 결과 도메인에 두고 금융 증적에는 최소 ID/버전/금액만 남깁니다.
결과 삭제와 금융 증적 보존·계정 삭제 처리는 별도 계약입니다. Memory reservation의
SetNull/비FK와 providerCall의 cascade를 하나의 보존 정책으로 복사하지 않습니다.

무과금 우선 **12개 검증 구획**을 제안합니다. 시료·예상값·대조 스크립트는 에이전트가 준비합니다.
현재 실행한 테스트가 아니며 유료 호출 수는 0입니다.

1. 0/일부/전체 산출물의 청구·반환·상한 대조, 서로 다른 단가·반올림.
2. 근거 부족/상충의 정상 결과와 검색/파싱/저장 실패 구분.
3. 동일 제출·동시 제출의 단일 예약.
4. 병렬 항목의 상한 사전 예약과 초과 호출 미발생.
5. 완료 commit·취소·원문 삭제/잠금 경합, stale worker의 결과 쓰기 차단.
6. 정산 중 crash/rollback·동시 settle/sweep·응답 유실 뒤 조회 복구.
7. 8/12 중단 후 재개 시 기존 8개 결과·청구 보존 및 미완료만 실행.
8. 변경된 원문/견적/가격·만료 승인에 대한 재승인 또는 명시적 거절.
9. SDK retry/fallback/search subcall까지 포함한 유계 attempt·회사 비용 기록.
10. callIssued 후 timeout·비용 미확인·stale worker 비용·provider 동시 정산 대조.
11. 플랜 기간/구매 lot 만료·환불/분쟁과 예약 반환, 기존 debt 처리 비간섭.
12. 게스트/다른 사용자 접근 거부, 결과/금융 데이터 수명 및 실제 정산 기반 UI.

출시 차단은 복구 불가능한 정보 유출·타인 결과 접근·성공 결과 또는 과금 증적 유실처럼
근거를 이름 댈 수 있는 항목부터 구분합니다. Agent의 상한/중복 과금 방지 계약은 해당 유료
기능 출시의 필수 조건이지만 모든 금융 표시 문제를 전체 플랫폼 긴급 보안 차단으로 올리지는 않습니다.
실제 검색 품질의 유료 평가·승인은 REVIEW-AGENT-01에 남기며 여기서 중복 실행하지 않습니다.

## 6. 근거·변경 범위

- `lib/memoryExtractionCredits.ts:250` — 완료 chunk 비율·원자적 사용자 정산.
- `lib/memoryExtractionService.ts:716`, `:825` — terminal/cancel과 계정 잠금/정산.
- `lib/memoryExtractionWorker.ts:271`, `:424` — 원문 없음/정상 빈 결과와 completed 의미.
- `lib/memoryExtractionProvider.ts:20`, `:67` — SDK retry 비활성·abort 한계.
- `lib/memoryExtractionProviderCost.ts:135`, `:315`, `:385` — 원가 admission·정산·복구.
- `tests/integration/memory-extraction-provider-cost.db.test.ts:201` — 순차 재정산 테스트 범위.
- `lib/creditDebt.ts:42`, `lib/creditPurchase.ts:360` — debt 증가 유형과 구매 회수 경로.
- `lib/imageGenerationService.ts:1580`, `prisma/schema.prisma:1599` — failed target retry/attempt 키.
- `lib/creditLedger.ts:171` — 원래 lot으로 정산/반환.
- `docs/policy/credit-and-cost-limits.md` §2·§3·§4·§9 — 층 분리·가격 snapshot·잠금 순서.
- `docs/policy/external-conversation-import-and-memory.md` §11 — extraction durable 실행 계약.
- [통합 작업 목록](./tomverse-product-idea-backlog.md) ·
  [Review Agent 제품 축 검토](./tomverse-review-agent-strategy-review-2026-09-15.md) ·
  [크레딧 표시/상한 검토](./tomverse-credit-display-strategy-review-2026-09-15.md).

수정한 것은 이 보고서와 로컬 자문 목록뿐입니다. 제품 코드·승인 정책·DB/ledger·가격·flag·
작업 실행은 변경하지 않았고 commit/push하지 않았습니다.
