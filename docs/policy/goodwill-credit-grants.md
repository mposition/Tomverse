# Goodwill credit grants

- Status: design, nothing built
- Gate: BILLING-04 `duplicate_goodwill_refunds eq 0` (blocking, owner finance-ops)
- Reads on top of: `docs/policy/credit-and-cost-limits.md` (§2 두 층으로 분리, §9 Canonical lock order)

## 1. 무엇이 없어서 이 문서가 있는가

BILLING-04는 "goodwill refund가 멱등해야 한다"고 요구하지만, **goodwill 지급
경로 자체가 없습니다.** 저장소에서 `goodwill`은 문서 네 곳에만 나옵니다.

지금 있는 두 가지는 이것이 아닙니다.

| 있는 것 | 무엇인가 | 왜 이것이 아닌가 |
|---|---|---|
| `lib/refundSagaCore.ts` | Stripe 환불 saga | **돈**이 카드로 돌아갑니다. 크레딧을 주지 않습니다 |
| `lib/creditPurchase.ts`의 credit pack 환불 | 구매 취소 | 기존 구매를 되돌립니다. 새 크레딧을 만들지 않습니다 |

goodwill 지급은 세 번째 것입니다 — **구매도 환불도 아닌, 지원 담당자가 재량으로
만드는 크레딧.** 대응하는 결제가 없으므로 되돌릴 구매도, 조회할 Stripe 객체도
없습니다. 그래서 멱등성을 남에게서 빌려올 수 없고 자기 것을 가져야 하며, 그것이
게이트가 요구하는 바입니다.

## 2. 왜 멱등성이 문제인가

게이트의 근거는 "운영상 재시도될 수 있다"입니다. 구체적으로 이렇게 두 번 지급됩니다.

1. 담당자가 저장을 눌렀는데 응답이 늦어 다시 누릅니다.
2. 요청은 성공했는데 네트워크가 끊겨 실패로 보이고, 재시도합니다.
3. 티켓 두 개가 같은 사건을 다루고 두 담당자가 각각 지급합니다.
4. 승인 대기 항목이 두 번 소비됩니다.

1~2는 요청 단위 키로 막습니다. **3은 키로 막히지 않습니다** — 서로 다른 요청이고
의도도 다릅니다. 그래서 아래 §5는 키(중복 실행 방지)와 사건 단위 중복 감지(같은
사유로 두 번 주는 것)를 **분리**합니다. 하나로 합치면 정당한 두 번째 지급까지
막거나, 아무것도 못 막습니다.

## 3. 절대 조건 (기존 정책에서 상속)

- **goodwill 크레딧은 entitlement입니다.** `docs/policy/credit-and-cost-limits.md`
  §2의 분리를 그대로 따릅니다 — 사용 권한은 크레딧으로 표현하고, operational
  guardrail(`CHAT_COST_GUARDRAIL_*`, `op-cost-*`)과 이름도 코드도 섞지 않습니다.
  goodwill 지급이 guardrail 한도를 올려서는 안 됩니다.
- **`lockCreditAccount(tx, userId)`를 트랜잭션 첫 문장으로 잡습니다**(§9). 지급은
  증가만 하므로 그 자체로는 안전해 보이지만, 정책 문서가 이미 환급에 대해 적어둔
  이유가 그대로 적용됩니다 — 동시 예약의 *읽기와 차감 사이*에 끼면 그 예약이
  존재하지 않던 잔액을 근거로 판정합니다.
- **소급 가격 적용 금지**와 마찬가지로, goodwill 지급은 **과거 reservation이나
  settlement snapshot을 수정하지 않습니다.** 이미 청구된 것은 그대로 두고 새
  크레딧을 얹습니다.
- **사용자 응답에 내부 USD를 노출하지 않습니다.** 지급된 크레딧 수는 사용자에게
  보이지만 `fundedCostMicroUsd`는 Admin Console과 구조화 로그에만 남깁니다.

## 4. 원장 표현

새 테이블을 만들지 않습니다. 기존 `CreditLot` + `CreditLedgerEntry`로 표현합니다.

```
CreditLot {
  source: "goodwill"          // 새 값. "purchase"·"credit_pack"과 나란히
  purchaseId: null            // 대응 결제 없음 -- 이것이 goodwill의 정의
  originalCredits: N
  remainingCredits: N
  originalFundedCostMicroUsd: 0   // 아무도 이 크레딧에 돈을 대지 않았다
  remainingFundedCostMicroUsd: 0
  expiresAt: <정책상 만료>
}

CreditLedgerEntry {
  type: "goodwill_grant"      // 새 값
  creditsDelta: +N
  fundedCostMicroUsdDelta: 0
  metadata: { grantId, reason, grantedByEmail, incidentKey }
}
```

두 가지가 설계상 중요합니다.

**`fundedCostMicroUsd`는 0입니다.** 이 컬럼은 "이 크레딧을 위해 실제로 들어온
돈"이고, goodwill에는 그런 돈이 없습니다. 여기에 값을 넣으면 fallback 가격 지표와
정산 대비 예약 비율이 존재하지 않는 수익을 계산에 넣습니다. 0은 회피가 아니라
사실입니다.

**`purchaseId`가 `NULL`인 것이 goodwill의 식별자입니다.** `source: "goodwill"`은
읽기 편의이고, 결제와의 무관함은 관계의 부재로 표현됩니다.

만료(`expiresAt`)는 결정이 필요한 항목입니다 — §8에 남깁니다.

## 5. 멱등성: 두 층

### 5.1 실행 키 (기계적 중복)

`GoodwillGrant.idempotencyKey`에 unique 제약. 키는 **클라이언트가 만들어 보내고**
서버가 생성하지 않습니다 — 서버가 만들면 재시도마다 새 키라 아무것도 막지 못하는
것이, `MemoryExtractionAttempt` 설계에서 이미 확인된 실패입니다.

```
UNIQUE (idempotencyKey)
```

같은 키의 두 번째 요청은 **새 지급을 만들지 않고 첫 지급의 결과를 그대로
반환합니다.** 오류가 아닙니다 — 재시도가 성공으로 보여야 담당자가 또 누르지
않습니다.

키 충돌 시 payload가 다르면 그때는 거부합니다(`GOODWILL_GRANT_PAYLOAD_MISMATCH`).
같은 키로 다른 금액을 주려는 것은 재시도가 아니라 실수입니다. 비교는
`approvalPayloadHash()`를 재사용합니다 — 이미 `AdminActionApproval.payloadHash`가
같은 문제를 같은 방식으로 풀고 있습니다.

### 5.2 사건 키 (사람의 중복)

`incidentKey`(예: 지원 티켓 ID). unique가 아니라 **경고 대상**입니다.

같은 `incidentKey`에 이미 지급이 있으면 요청을 거부하지 않고
`requiresDuplicateAcknowledgement`를 돌려줍니다. 담당자가 기존 지급을 보고
`acknowledgeDuplicateOf: <grantId>`를 실어 다시 보내야 통과합니다.

unique로 만들지 않는 이유: 같은 티켓에서 두 번 보상해야 하는 경우가 실제로
있습니다(추가 장애, 1차 보상 부족). 이것을 DB 제약으로 막으면 담당자는 티켓
번호를 조작해서 우회하고, 그러면 감사 기록이 거짓이 됩니다.

`duplicate_goodwill_refunds` 지표는 **5.1 위반 건수**로 셉니다 — 승인 없이
같은 사건에 두 번 지급된 건이 아니라, 같은 실행이 두 번 원장에 들어간 건수입니다.
게이트가 `eq 0`을 요구하는 것은 후자입니다.

## 6. 권한과 승인

새 정책을 만들지 않고 **환불이 이미 쓰는 것을 그대로 씁니다.**

- 권한: `billing:write`. `approvalPermissionForAction()`에 `goodwill.` 접두사를
  추가하면 기존 매핑이 그대로 받습니다.
- 이중 승인: 금액이 임계값을 넘으면 `runWithAdminApproval()`. 환불의
  `ADMIN_REFUND_APPROVAL_THRESHOLD_CENTS`와 **별도 환경변수**를 씁니다 —
  goodwill은 크레딧 단위이고 환불은 센트 단위라, 같은 숫자를 공유하면 한쪽을
  조정할 때 다른 쪽이 따라 움직입니다. 이는 accent token 정책의 "역할이 다르면
  값이 같아도 분리한다"와 같은 이유입니다.
- 감사: `writeAdminAuditLog()`. 지급자·사유·금액·사건 키·승인 항목 ID.
- 선조건: 환불 route가 쓰는 `expectedRemainingCredits` 패턴을 따릅니다. 담당자가
  화면에서 본 잔액과 서버 잔액이 다르면 거부합니다.

승인 항목의 `consumedAt`은 이미 단일 소비를 보장하므로, 승인 경로를 탄 지급은
5.1의 키와 **두 겹**으로 보호됩니다.

## 7. 실패 경계

게이트가 "early-failure threshold tests"를 함께 요구합니다. 지급은 한 트랜잭션
안에서 끝나므로 Stripe saga 같은 중간 상태가 없고, 실패는 전부 지급 전이어야
합니다.

```
lockCreditAccount(tx, userId)          ← 첫 문장
  → 멱등 키 조회 (있으면 기존 결과 반환, 여기서 종료)
  → 계정 상태 확인 (삭제 예정·정지 계정에 지급하지 않는다)
  → 한도 확인 (1회 상한, 기간 누적 상한)
  → 승인 항목 소비
  → CreditLot 생성 + CreditLedgerEntry 기록
  → GoodwillGrant 기록
```

`lockCreditAccount`가 첫 문장인 것은 §9 규칙 그대로입니다. **멱등 키 조회를 잠금
앞으로 옮기지 않습니다** — 잠금 밖에서 조회하면 동시 재시도 둘이 모두 "없음"을
읽고 둘 다 지급합니다. 이것이 이 설계에서 가장 쉽게 잘못 만들어지는 지점입니다.

## 8. 사람이 정해야 하는 것

설계로 정할 수 없고 finance-ops의 결정이 필요한 항목입니다. 이것들이 정해지기
전에는 구현하지 않습니다.

1. **1회 지급 상한과 기간 누적 상한.** 상한 없는 재량 지급은 계정 하나를 통해
   무제한으로 원가가 나가는 경로입니다.
2. **이중 승인 임계값.** 어느 크레딧 수부터 두 사람이 필요한가.
3. **만료.** 구매 크레딧과 같은 기간인가, 더 짧은가. `CreditLot.expiresAt`은
   nullable이 아니므로 "만료 없음"은 표현할 수 없습니다.
4. **소진 순서.** goodwill lot이 구매 lot보다 먼저 쓰이는가. 먼저 쓰이면 사용자가
   유리하고, 나중에 쓰이면 환불 계산이 단순합니다.
5. **환불 상호작용.** goodwill로 받은 크레딧이 남아 있는 계정이 구매를 환불할 때
   goodwill lot을 건드리는가. 기본은 건드리지 않는 것입니다.
6. **사용자 가시성.** 지급 사유를 사용자에게 보여주는가. 보여준다면 사유 문구는
   `locales/*.ts`를 타야 하고, 담당자가 쓴 내부 사유를 그대로 노출하지 않습니다.

## 9. 게이트 증거로 무엇을 낼 것인가

BILLING-04의 evidence는 "refund idempotency and early-failure threshold tests"
입니다. 구현 시 아래를 냅니다.

- 같은 멱등 키의 동시 요청 두 개가 lot 하나와 원장 항목 하나만 만든다 (DB 통합,
  실제 동시성)
- 같은 키에 다른 payload는 거부된다
- 같은 `incidentKey`는 확인 없이는 거부되고, 확인과 함께는 통과한다
- 각 실패 경계(정지 계정, 상한 초과, 승인 미소비)가 **행도 크레딧도 남기지
  않는다** — 이미지 생성 정책의 "거절은 행도 비용도 남기지 않는다"와 같은 형태
- 잠금 없이 실행하면 실패하는 테스트 (§7의 순서가 계약임을 고정)

`docs/release-gates/tomverse-chat-v1.yaml`은 이 문서가 승인 상태를 바꾸지
않습니다. 게이트 승인은 registry에 기록되는 사람의 행위입니다.
