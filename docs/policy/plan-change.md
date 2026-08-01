# 플랜 변경 정책

Pro ↔ Max 플랜 변경에 관한 승인된 정책입니다. **아직 구현되지 않았습니다.**
이 문서는 구현 전에 합의된 계약과, 구현을 시작하기 전에 반드시 확정해야 하는
미결 항목을 기록합니다.

관련 파일을 바꾸기 전에 읽어 주세요.

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
됩니다. 아래 5절의 미결 항목이 전부 확정되기 전까지 이 세 분기는 그대로
둡니다.

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

참고: [Stripe 구독 변경](https://docs.stripe.com/billing/subscriptions/change)

## 2. Max → Pro (다운그레이드)

- 현재 결제기간이 끝날 때까지 **Max를 유지**합니다.
- **즉시 환불도, 일할 크레딧도 없습니다.**
- 기간 말에 Pro를 적용합니다.
- 예정된 변경과 적용일을 UI에 표시합니다.
- 기간 말 전까지 사용자가 **다운그레이드를 취소**할 수 있어야 합니다.
- Subscription Schedule 또는 이에 준하는 서버 예약 상태를 사용합니다. 기간 말에
  동작하는 예약이 서버에 남아 있어야 하며, 클라이언트 타이머나 웹훅 도착에만
  의존해서는 안 됩니다.

Stripe Customer Portal도 기간 말 다운그레이드를 지원하지만, 대상 가격들이 **같은
Stripe Product에 속해야 한다**는 제한이 있습니다. Portal을 쓸지 결정하기 전에
현재 Pro · Max의 Product 구성을 확인해야 합니다(5절 참조).

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

## 5. 구현 전에 확정해야 하는 것

1. **Pro → Max 크레딧 제공 정책.** 업그레이드 시점에 Max 월 크레딧을 어떻게
   줄지 정해지지 않았습니다. 결정해야 할 것: 남은 기간에 대한 차액만 줄지, 전량을
   줄지, 다음 갱신일부터 적용할지. proration으로 돈은 일할 계산되는데 크레딧은
   그렇지 않으면 사용자가 실제로 받는 것과 지불한 것이 어긋납니다. **이 결정이
   나오기 전에는 서버 차단을 풀 수 없습니다.**
2. **Stripe Product 구성 확인.** Pro와 Max 가격이 같은 Product에 속하는지 확인해야
   Customer Portal 사용 가능 여부가 정해집니다.
3. **다운그레이드 예약 중의 크레딧.** Max→Pro 예약이 걸린 기간 동안 월 갱신이
   오면 Max 크레딧을 주는지 Pro 크레딧을 주는지.

## 6. 구현 순서

앞 단계가 끝나기 전에 뒤 단계를 시작하지 않습니다.

1. **크레딧 경제성 결정** (5절 1·3번)
2. **서버 변경 상태기계** — 허용/거부 판정, 예약 상태, 실패 시 원복
3. **Stripe 결제 · 예약** — proration preview, `always_invoice`, Subscription Schedule
4. **웹훅 · 재동기화** (4절)
5. **CTA 변경** — `resolvePlanCtaState()`의 `manage_plan` 분기를 실제 변경 흐름으로
   교체

`resolvePlanCtaState()` 수정은 **마지막 UI 단계**입니다. 이 함수를 먼저 바꾸면
동작하지 않는 CTA가 다시 생깁니다.
