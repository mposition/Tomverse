# 플랜 변경 정책

Pro ↔ Max 플랜 변경에 관한 승인된 정책입니다. **정책은 확정됐고, 아직 구현되지
않았습니다.** 이 문서가 구현의 계약입니다.

관련 파일을 바꾸기 전에 읽어 주세요.

- `lib/planChangeCredits.ts`의 `planCreditsAfterPlanChange()`
- `lib/purchaseIntent.ts`의 `resolvePlanCtaState()`
- `app/api/billing/checkout/route.ts`의 플랜 변경 차단 분기
- `app/api/billing/cancel-subscription/route.ts`
- `lib/stripeWebhookProcessing.ts`의 `syncSubscription()`

## 0. 현재 상태 — 온라인 플랜 변경은 지원하지 않습니다

제품에는 구독 **변경** 흐름이 없습니다. `/api/billing/*`에는 신규 Checkout
생성과 기간 말 해지만 있습니다. 따라서 지금은 다음을 유지합니다.

- 요금 페이지의 Pro↔Max CTA는 결제가 아니라 **고객지원 문의**로 연결합니다.
  온라인 변경이 아직 지원되지 않는다는 사실을 문구로 명시합니다.
- 서버는 계속 차단합니다. **이 차단을 UI보다 먼저 풀지 않습니다.**

| 요청 | 응답 | 코드 |
|---|---|---|
| 동일 플랜 재구매 | 409 | `PLAN_CHANGE_NOT_SUPPORTED` |
| 상위 → 하위 (다운그레이드) | 409 | `PLAN_CHANGE_NOT_SUPPORTED` |
| 활성 Stripe 구독 상태에서 상위 플랜 | 409 | `ACTIVE_SUBSCRIPTION_EXISTS` |

차단이 없으면 두 번째 구독이 생성되어 한 계정이 두 플랜을 동시에 결제하게
됩니다. 이 세 분기는 플랜 변경이 구현된 뒤에도 그대로 둡니다 — 변경은 전용
엔드포인트로 하고, Checkout을 통한 우회는 계속 막습니다(5절).

## 1. Pro → Max (업그레이드)

- **같은 billing interval끼리만 허용합니다.** Pro 월간 → Max 월간, Pro 연간 →
  Max 연간. interval이 다르면 거부합니다.
- 변경을 확정하기 전에 **Stripe proration invoice preview를 표시**합니다.
  사용자가 실제 추가 결제액 · 세금 · 적용 시점을 보고 확인해야 합니다.
- 확인 후 **즉시 결제**합니다. Stripe는 즉시 청구에 `always_invoice`를
  안내합니다.
- **결제가 성공한 뒤에 Max 권한을 적용합니다.** 결제 실패 또는 추가 인증(SCA)이
  필요한 상태에서는 **Pro를 유지**합니다. 권한을 먼저 올리고 결제를 기다리지
  않습니다.
- 기존에 `cancel_at_period_end=true`인 구독이라면 **자동 갱신을 몰래 복원하지
  않습니다.** 사용자가 갱신 재개에 별도로 동의한 경우에만 취소 예약을
  해제합니다. 업그레이드 확인 하나로 두 가지(플랜 변경 + 갱신 재개)에 동의한
  것으로 취급하지 않습니다.

### Stripe 호출 파라미터 (필수)

확정 요청은 반드시 다음을 사용합니다.

```
proration_behavior = always_invoice
payment_behavior   = pending_if_incomplete
```

`pending_if_incomplete`가 없으면 결제 실패나 SCA 대기 중에 구독이 먼저 Max로
바뀝니다. 즉 **돈을 받기 전에 권한이 올라갑니다.** 이 두 파라미터가 "결제 성공
후에만 Max 적용"을 실제로 강제하는 장치이며, 애플리케이션 코드의 순서 제어가
아닙니다.

참고: [Stripe Pending Updates](https://docs.stripe.com/billing/subscriptions/pending-updates)
· [Stripe 구독 변경](https://docs.stripe.com/billing/subscriptions/change)

### 크레딧 (확정)

결제 성공 시:

- 플랜과 모델 · 기능 권한을 **즉시 Max**로 변경합니다.
- 현재 UTC 월의 플랜 한도를 3,000 → 10,000으로 바꿉니다.
- **이미 사용한 플랜 크레딧을 초기화하지 않습니다.**
- **10,000크레딧을 따로 추가 지급하지 않습니다.**
- 남은 크레딧은 `lib/planChangeCredits.ts`의 `planCreditsAfterPlanChange()`가
  계산합니다.

```
남은 플랜 크레딧 = max(0, Max 월 한도 10,000 - 이번 UTC 월 플랜 크레딧 사용량 - 크레딧 debt)

예) Pro에서 2,500 사용 후 Max 업그레이드 → 7,500
```

- 다음 UTC 월초에는 Max 기준 10,000으로 정상 초기화됩니다.
- **구매한 추가 크레딧은 변동 없습니다.** 별도 잔액이며 만료일도 그대로입니다.
- 결제 실패 또는 SCA 진행 중에는 **계속 Pro**입니다. SCA 완료와 `invoice.paid`
  확인 후에 Max를 적용합니다.

**의도적으로 수용하는 점:** Stripe 일할 결제액과 무관하게 현재 월 한도가 Max
전체 한도로 올라갑니다. 월 중간에 업그레이드해도 남은 기간에 비례한 몫이 아니라
10,000 기준으로 계산됩니다. 설명하기 쉽고 검증하기 쉬우며 사용자에게 유리한
방향이므로, 결함이 아니라 선택입니다.

## 2. Max → Pro (다운그레이드)

- 현재 결제기간이 끝날 때까지 **Max를 유지**합니다.
- **즉시 환불도, 일할 크레딧도 없습니다.**
- 기간 말에 Pro를 적용합니다.
- 예정된 변경과 적용일을 UI에 표시합니다.
- 기간 말 전까지 사용자가 **다운그레이드를 취소**할 수 있어야 합니다.
- Subscription Schedule 또는 이에 준하는 서버 예약 상태를 사용합니다. 기간 말에
  동작하는 예약이 서버에 남아 있어야 하며, 클라이언트 타이머나 웹훅 도착에만
  의존해서는 안 됩니다.

### 크레딧 (확정)

- 적용 예정일까지 **Max 플랜과 Max 크레딧 정책을 유지**합니다.
- 예약 기간 중 UTC 월초가 오면 **Max 10,000을 정상 제공**합니다. 다운그레이드가
  예약돼 있다는 이유로 미리 줄이지 않습니다.
- 결제기간 종료 시 Pro로 변경합니다.
- **이미 사용한 Max 크레딧을 회수하거나 debt로 만들지 않습니다.**
- 적용 시점이 UTC 월 중간이면 남은 Pro 크레딧은 같은 함수로 계산합니다.

```
남은 플랜 크레딧 = max(0, Pro 월 한도 3,000 - 이번 UTC 월 플랜 크레딧 사용량)

예) 이번 달 Max로 6,000 사용 후 Pro 적용 → 0 (음수가 되지 않고, 상계도 없음)
```

- 다음 UTC 월초부터 Pro 3,000을 정상 제공합니다.
- 추가 구매 크레딧은 유지됩니다.

업그레이드와 다운그레이드가 **같은 함수 하나**를 쓴다는 점이 중요합니다. 방향별로
식을 따로 두면 경계 동작이 서로 어긋납니다.

Stripe Customer Portal도 기간 말 다운그레이드를 지원하지만, 대상 가격들이 **같은
Stripe Product에 속해야 한다**는 제한이 있습니다. Portal을 쓸지 결정하기 전에
현재 Pro · Max의 Product 구성을 확인해야 합니다(6절 참조).

참고: [Stripe Customer Portal 설정](https://docs.stripe.com/customer-management/configure-portal)

## 3. 월간 ↔ 연간 변경 — 첫 버전에서는 지원하지 않습니다

플랜 tier 변경과 결제주기 변경을 한 번에 처리하면 다음이 모두 동시에
복잡해집니다.

- billing cycle anchor
- 할인 및 프로모션
- proration
- 세금
- 다음 갱신일
- 월 크레딧 제공 주기

동일 interval 변경이 안정화된 뒤 별도 정책으로 다룹니다. 그때까지 interval이
다른 변경 요청은 거부하고 고객지원으로 안내합니다.

## 4. 웹훅 보강 — 플랜 변경의 선행 조건

현재 `lib/stripeWebhookProcessing.ts`는 exact event ID 기준 중복 방지는 하지만,
`syncSubscription()`이 **전달받은 이벤트의 snapshot을 그대로 DB에 적용**합니다.
Stripe는 웹훅 전달 순서를 보장하지 않으므로, 오래된 이벤트가 늦게 도착하면 최신
플랜을 되돌릴 수 있습니다.

참고: [Stripe Webhook 이벤트 순서](https://docs.stripe.com/webhooks#event-ordering)

플랜 변경을 지원하기 전에 다음이 필요합니다.

- 이벤트 처리 시 **Stripe에서 최신 Subscription을 재조회**합니다. 이벤트 payload를
  신뢰의 근거가 아니라 트리거로만 씁니다.
- **오래된 상태가 최신 DB 상태를 덮어쓰지 못하게 막습니다.** 재조회 결과와 저장된
  상태를 비교할 수 있는 단조 증가 기준(예: Stripe의 갱신 시각 또는 자체 revision)이
  필요합니다.
- 다음 이벤트를 처리합니다.
  - `invoice.paid`
  - `invoice.payment_failed`
  - `invoice.payment_action_required`
  - `customer.subscription.updated`
  - `customer.subscription.pending_update_expired`
  - `subscription_schedule.*`
- 자동 billing resync와 **관리자 수동 재동기화** 경로를 제공합니다.

이 보강 없이 플랜 변경을 열면, 결제는 성공했는데 권한이 되돌아가거나 그 반대인
상태를 사람이 손으로 고쳐야 합니다.

### 구현 완료 (2026-08-01)

- **재조회.** `resyncSubscriptionFromStripe()`가 이벤트마다 Stripe에서 구독을 다시
  읽습니다. 이벤트 payload는 트리거일 뿐입니다. 재조회 실패는 삼키지 않고
  throw해서 route가 500을 반환하고 Stripe가 재전송하게 합니다 — 실패 시 payload로
  대체하면 제거하려던 동작이 그대로 남습니다.
- **순서 역전 방지.** `User.subscriptionSyncedAt`에 **조회 시각**을 기록하고, 그보다
  이전에 읽은 snapshot은 거부합니다. 시각은 Stripe 요청 **전에** 찍습니다. 응답은
  Stripe가 응답을 만든 시점의 상태만 보장하므로, 도착 시각으로 찍으면 느린
  요청(오래된 데이터)이 빠른 요청(최신 데이터)보다 최신인 척할 수 있습니다.
  비교와 쓰기는 `updateMany` 조건 한 문장이라 두 handler가 동시에 "최신 아님"을
  읽고 둘 다 쓰는 일이 불가능합니다.
- **처리 이벤트.** `lib/stripeWebhookSyncCore.ts`의
  `SUBSCRIPTION_RESYNC_EVENT_TYPES`. `invoice.*`가 중요한 이유는
  `pending_if_incomplete`로 만든 변경이 invoice가 결제되기 전까지 구독 객체에
  나타나지 않기 때문입니다 — SCA 대기 중에는 구독이 여전히 Pro로 읽힙니다.
- **invoice의 구독 위치.** 이 SDK 버전에서는 `invoice.subscription`이 아니라
  `invoice.parent.subscription_details.subscription`입니다. 옛 필드를 읽으면
  `undefined`가 나와 resync가 조용히 no-op이 됩니다.
- **자동 · 수동 재동기화.** 자동은 웹훅 자체(모든 이벤트가 재조회)이고, 수동은
  `POST /api/admin/billing/resync`입니다. 전달되지 않은 이벤트나 Stripe 대시보드에서
  직접 한 변경은 웹훅이 고쳐 주지 못하므로 별도 경로가 필요합니다. 관리자 resync는
  현재 시각으로 찍혀 늦게 오는 웹훅보다 항상 우선합니다.
- **검증.** `tests/stripeWebhookSyncCore.test.mjs`(판정 · 이벤트 추출),
  `tests/integration/subscription-sync-ordering.db.test.ts`(실제 PostgreSQL에서
  조건부 UPDATE).

## 5. 엔드포인트 구조 — 기존 409를 제거하지 않습니다

플랜 변경은 **전용 엔드포인트 두 개**로 만듭니다. `/api/billing/checkout`의 차단
분기는 **그대로 둡니다.**

| 엔드포인트 | 역할 |
|---|---|
| 플랜 변경 preview | Stripe proration invoice preview를 조회해 추가 결제액 · 세금 · 적용 시점을 반환. 아무것도 변경하지 않음 |
| 플랜 변경 confirm | preview에서 사용자가 확인한 내용을 실제로 실행 |
| `/api/billing/checkout` | **변경 불가.** 동일 플랜 · 다운그레이드 · 활성 구독 상태 상위 플랜을 계속 409로 거부 |

기존 409를 살려두는 것이 핵심입니다. 신규 구독 Checkout으로 플랜 변경을
우회하면 두 번째 구독이 생겨 한 계정이 두 플랜을 동시에 결제합니다. 변경 경로가
따로 생겨도 그 우회로는 계속 막혀 있어야 합니다.

`resolvePlanCtaState()`는 서버 · 웹훅 구현이 **전부 끝난 뒤에** 전용 변경 화면으로
연결합니다.

## 6. 아직 확인이 필요한 것

크레딧 정책은 확정됐습니다(1 · 2절). 남은 것은 하나입니다.

- **Stripe Product 구성 확인.** Pro와 Max 가격이 같은 Product에 속하는지 확인해야
  Customer Portal을 다운그레이드에 쓸 수 있는지 정해집니다. 별개 Product라면
  Subscription Schedule을 직접 다뤄야 합니다.

## 7. 구현 순서

앞 단계가 끝나기 전에 뒤 단계를 시작하지 않습니다. 웹훅 보강(4절)은 2 · 3절보다
먼저 끝냈습니다 — 순서 역전 방지가 없는 상태에서 플랜 변경을 붙이면 첫 번째
pending update부터 "결제는 됐는데 권한이 되돌아간" 상태가 나옵니다.

1. ~~**크레딧 경제성 결정**~~ — 확정. `lib/planChangeCredits.ts`에
   `planCreditsAfterPlanChange()`로 인코딩했고 `tests/planChangeCredits.test.mjs`가
   양방향 경계를 고정합니다.
2. **서버 변경 상태기계** — 허용/거부 판정(같은 interval인지, 방향이 무엇인지),
   예약 상태, 실패 시 원복. preview · confirm 엔드포인트. **다음 단계.**
3. **Stripe 결제 · 예약** — proration preview, `always_invoice` +
   `pending_if_incomplete`, Subscription Schedule
4. ~~**웹훅 · 재동기화**~~ (4절) — 완료
5. **CTA 변경** — `resolvePlanCtaState()`의 `manage_plan` 분기를 전용 변경 화면으로
   교체

`resolvePlanCtaState()` 수정은 **마지막 UI 단계**입니다. 이 함수를 먼저 바꾸면
동작하지 않는 CTA가 다시 생깁니다.
