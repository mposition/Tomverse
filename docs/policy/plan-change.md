# 플랜 변경 정책

Pro ↔ Max 플랜 변경에 관한 승인된 정책입니다. **정책은 확정됐고, 서버 · Stripe ·
웹훅 구현이 끝났습니다. 남은 것은 UI(7절 5단계)입니다.** 이 문서가 구현의
계약입니다.

관련 파일을 바꾸기 전에 읽어 주세요.

- `lib/planChangeStateMachine.ts` — 허용 판정 · preview 유효성 · 예약 상태기계
- `lib/planChangeService.ts` — Stripe 실행과 `PlanChangeRequest` 기록
- `app/api/billing/plan-change/**`
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

### Customer Portal은 실행 주체가 아닙니다 (정정)

이전 판에서는 "Pro와 Max가 같은 Product면 Portal로 기간 말 다운그레이드가
가능하다"고 적었습니다. **절반만 맞습니다.** Portal은 하나의 Product에 **같은
recurring interval을 가진 Price를 여러 개** 두지 못하게 제한합니다. 승인된
다운그레이드는 정의상 동일 interval(월간→월간, 연간→연간)이므로, **Product를
어떻게 나누든 Portal에는 담기지 않습니다.**

따라서 Pro↔Max 변경은 **Tomverse 서버가 Stripe를 직접 호출**해 수행합니다.
Portal은 결제수단 · 청구서 · 단순 구독 해지 용도로 계속 씁니다. 상태 모델이
Portal을 전제해서는 안 되며, `lib/planChangeStateMachine.ts`의 실행 모드는
Stripe 화면이 아니라 **Tomverse가 하는 일**로 이름 붙였습니다
(`immediate_upgrade` · `scheduled_downgrade`).

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

### 상태기계 구현 완료 (2026-08-01)

`lib/planChangeStateMachine.ts`. Stripe client도 Prisma도 시계도 갖지 않는 순수
모듈이라, 운영에서만 드러나는 중복 · 역순 경우까지 전부 test로 고정됩니다
(`tests/planChangeStateMachine.test.mjs`, 30개).

- **판정.** `resolvePlanChange()`가 방향(`upgrade`/`downgrade`)과 실행 모드
  (`immediate_upgrade`/`scheduled_downgrade`)를 정합니다. preview와 confirm이
  **같은 함수**를 쓰므로 preview가 제시하지 않은 변경을 confirm이 실행할 수
  없습니다.
- **거부 코드.** 전부 409입니다(요청이 아니라 계정 상태와의 충돌이므로).

  | 코드 | 상황 |
  |---|---|
  | `NO_ACTIVE_SUBSCRIPTION` | 구독 없음 — 변경이 아니라 신규 구매 |
  | `SUBSCRIPTION_NOT_CHANGEABLE` | 변경 불가 상태 · 통화/기간 불명 · 저장 플랜 불일치 |
  | `PLAN_CHANGE_NOT_SUPPORTED` | 동일 플랜 |
  | `BILLING_INTERVAL_CHANGE_NOT_SUPPORTED` | interval 불일치 또는 불명 |
  | `SUBSCRIPTION_NOT_SINGLE_ITEM` | item이 1개가 아님 |
  | `PLAN_CHANGE_ALREADY_PENDING` | 결제 · 인증 대기 중인 변경이 있음 |
  | `PLAN_CHANGE_ALREADY_SCHEDULED` | 이미 예약된 변경이 있음 |
  | `SUBSCRIPTION_SCHEDULE_CONFLICT` | 우리가 만들지 않은 schedule이 구독을 몰고 있음 |
  | `PLAN_CHANGE_BLOCKED_BY_CANCELLATION` | 기간 말 해지 예약 상태에서의 다운그레이드 |

- **`past_due`는 변경 불가.** `/api/billing/checkout`은 `past_due`를 "활성"으로
  세지만(두 번째 구독을 막기 위해) 여기서는 아닙니다. 직전 청구가 실패한 계정에
  업그레이드 invoice를 발행하면 실패 invoice가 하나 더 생기고 권한 상태를 아무도
  설명할 수 없게 됩니다. 미납 해소가 먼저입니다.
- **`cancel_at_period_end` 자동 해제 없음.** 상태기계에는 "업그레이드했으니
  해제한다"는 값 자체가 없습니다. 업그레이드 확인은 플랜 변경에 대한 동의이지
  갱신 재개에 대한 동의가 아닙니다. 해제는 별도 label을 가진 별도 control에서 온
  `resumeRenewal`이 있을 때만
  (`cancellation_cleared_by_explicit_consent`) 일어납니다.
- **해지 예약 중 다운그레이드는 거부.** 구독이 기간 말에 끝나는데 그 다음 기간에
  Pro를 예약하면 해지된 구독을 조용히 되살립니다. 요청한 것보다 큰 변경입니다.
- **preview 만료 · stale.** `planChangeStateFingerprint()`가 견적이 의존하는
  구독 사실을 전부 담고, `checkPlanChangePreview()`가 TTL(10분) · 소유자 · 대상 ·
  fingerprint를 확인합니다. 나이가 음수면(앞선 시계가 쓴 record) 영원히 신선한
  것으로 보지 않고 만료로 처리합니다.
- **confirm 멱등성.** `planChangeIdempotencyKey(previewId)`. 더블클릭 · 재시도 ·
  뒤로 가기 재전송이 같은 key를 들고 갑니다. **실패한** 결제의 재시도는 새 preview
  부터 시작해 새 key를 받습니다 — 실패 원인이 견적을 바꿨을 수 있기 때문입니다.
- **예약 상태기계.** `pending → applied | cancelled | expired | failed`, terminal
  상태는 되돌아가지 않습니다. 중복 전달은 `already_in_state`로 따로 보고해서
  경보 대상과 구분합니다.
- **예약 취소.** `checkPlanChangeCancellation()`. 기준은 웹훅 도착이 아니라 적용
  경계 시각입니다. `appliesAt` 이후에는 Stripe가 이미 옮겼을 수 있으므로 거부하고
  웹훅이 정리하게 둡니다.
- **감사 · Support.** `PLAN_CHANGE_AUDIT_ACTIONS`와
  `describePlanChangeForSupport()`. 조회용 식별자만 담고 이메일 · 이름 · 금액은
  담지 않습니다.

### Stripe 실행 · 엔드포인트 구현 완료 (2026-08-01)

`lib/planChangeService.ts`가 Stripe와 이야기하는 유일한 곳이고 `PlanChangeRequest`를
쓰는 유일한 곳입니다. 상태기계와 분리한 덕분에 판정 전체를 네트워크 없이 test할 수
있습니다.

| 엔드포인트 | 역할 |
|---|---|
| `POST /api/billing/plan-change/preview` | 견적. 아무것도 바꾸지 않음 |
| `POST /api/billing/plan-change/confirm` | 견적을 실행. `requestId` 필수 |
| `GET /api/billing/plan-change` | 진행 중인 변경(계정 화면용) |
| `DELETE /api/billing/plan-change` | 예약된 다운그레이드 취소 |
| `/api/billing/checkout` | **변경 없음.** 409 세 분기 그대로 |

- **업그레이드.** `subscriptions.update`에 `proration_behavior: "always_invoice"` +
  `payment_behavior: "pending_if_incomplete"`. 이 두 parameter가 "결제 전 Max 없음"의
  전부입니다 — 이 파일의 실행 순서가 아니라 Stripe가 변경을 *pending update*로
  세워 두고 invoice가 결제될 때까지 적용하지 않습니다. 카드 실패나 미완료 SCA는
  Pro로 남습니다.
- **다운그레이드.** `subscriptionSchedules.create({from_subscription})` 후 phase 2개로
  update — 현재 phase는 기간 말까지 Max 그대로, 다음 phase가 Pro,
  `proration_behavior: "none"`. 마지막 phase에 `duration` 1주기를 주고
  `end_behavior: "release"`로 되돌려줍니다. 열어 두면 구독이 영원히 schedule 아래
  남아 이후 모든 변경이 `SUBSCRIPTION_SCHEDULE_CONFLICT`가 됩니다.
- **취소는 `release`이지 `cancel`이 아닙니다.** `cancel`은 구독까지 해지합니다.
- **금액은 Stripe가 계산합니다.** `invoices.createPreview`의 `amount_due`를 그대로
  보여줍니다. 실제 구독에는 전부 promotion discount가 붙어 있어 자체 계산은 invoice와
  어긋납니다.
- **대상 Price는 (Product, interval, 통화, tax behavior)로 조회**합니다. 정확히 1개가
  아니면 fail-closed(`PLAN_CHANGE_PRICE_UNAVAILABLE`, 503). tax behavior를 맞추는
  이유는 Stripe가 혼합을 거부하기 때문이고, 그걸 confirm 시점에 알게 되면 사용자가
  이미 승인한 뒤입니다.
- **권한은 여기서 올리지 않습니다.** 계정의 plan은 오직
  `stripeWebhookProcessing.ts`의 `syncSubscription()`이, Stripe에서 다시 읽은 구독으로
  옮깁니다.
- **plan 판정 근거를 metadata에서 price로 옮겼습니다.** `syncSubscription()`은 이제
  price → product → metadata 순으로 봅니다. metadata는 구독 생성 시점에 적어 둔
  메모라, 플랜 변경이 item price를 바꿔도 그대로 "pro"입니다. metadata를 먼저 읽으면
  **업그레이드한 계정이 예전 플랜에 머뭅니다.** (schedule phase의 metadata도 함께
  설정하지만, 판정은 청구되는 price를 따릅니다.)
- **정산은 웹훅에서.** `resyncSubscriptionFromStripe()`가 계정을 동기화한 뒤
  `settlePlanChangesForSubscription()`을 같은 구독 객체로 호출합니다. 판정은
  `resolvePlanChangeSettlement()`(순수)가 하고, 쓰기는 `status = 'pending'`인 행만
  matching하는 조건부 update라 재전달은 두 번째부터 아무것도 바꾸지 않습니다.
- **confirm 직후 10분은 "없음"으로 실패를 단정하지 않습니다**
  (`PLAN_CHANGE_SETTLEMENT_GRACE_MS`). invoice 생성이나 schedule 부착이 아직일 수
  있고, 그걸 실패로 읽으면 성공하려던 변경을 무너뜨립니다. 단
  `pending_update_expired`는 Stripe가 직접 폐기했다는 뜻이므로 즉시 실패입니다.
- **계정당 진행 중 변경은 1건.** `PlanChangeRequest(userId) WHERE status='pending'`
  부분 unique index입니다. 응용 계층 검사만으로는 confirm 두 개가 경합할 때 둘 다
  통과할 수 있고, 그러면 같은 구독에 경쟁하는 변경이 둘 생깁니다. Prisma schema로는
  표현할 수 없어 migration SQL에만 있고, `tests/integration/plan-change-reservation.db.test.ts`가
  존재를 증명합니다.

## 6. Stripe 구성 확인 결과 (2026-08-01, 읽기 전용)

Stripe MCP는 이 계정의 **live key**에 연결돼 있습니다(`acct_1Trz6uCqxdHJo2tM`,
Tomverse). 조회 결과는 전부 `livemode: true`였습니다. **test mode는 이 연결로
조회할 수 없어 미확인 상태입니다** — 별도 test key 연결이 필요합니다.

### 구독 Product · Price (live)

| 플랜 | Product | interval | Price (USD) | 그 외 통화 |
|---|---|---|---|---|
| Pro | `prod_UrluLVYli6IfRH` "Tomverse Pro" | month | `price_1Ts2MJCqxdHJo2tMB7ZxI6HY` $15.00 | aud · cny · eur · krw 각 1개 |
| Pro | 〃 | year | `price_1Ts2MmCqxdHJo2tMdYo6So4t` $144.00 | aud · cny · eur · krw 각 1개 |
| Max | `prod_UrlvgqTdnuv1H0` "Tomverse Max" | month | `price_1Ts2NxCqxdHJo2tMlydhPsIU` $25.00 | aud · cny · eur · krw 각 1개 |
| Max | 〃 | year | `price_1Ts2OCCqxdHJo2tMtCoU8mbK` $240.00 | aud · cny · eur · krw 각 1개 |

- **Pro와 Max는 별개 Product입니다.** 2절의 정정과 합치면 결론은 하나입니다 —
  Portal은 쓸 수 없고, 서버가 직접 Price를 교체하고 Schedule을 관리합니다.
- 모든 구독 Price가 `active: true`, `tax_behavior: "exclusive"`,
  `recurring.interval_count: 1`, `billing_scheme: "per_unit"`,
  `usage_type: "licensed"`로 **일관**합니다. 교체 시 tax behavior 불일치 문제는
  없습니다.
- 통화는 플랜당 interval마다 usd · aud · cny · eur · krw 5종입니다. 교체 대상
  Price는 **현재 구독의 통화와 interval에 맞는 것 하나**로 정해집니다.
  `resolvePlanChange()`가 통화 불명이면 거부하는 이유입니다.
- 크레딧 팩은 별개 Product 3개(`prod_Ut3gUosDx9GkoH` ·
  `prod_Ut3hoW5WcwGCJ4` · `prod_Ut3i15xlY1yc81`), 전부 `type: "one_time"`이라
  구독 변경과 무관합니다.

### 실제 구독 (live, 3건)

- 전부 **item 1개**입니다(`total_count: 1`). `SUBSCRIPTION_NOT_SINGLE_ITEM`은
  방어용이며 현재 위반 사례는 없습니다.
- 전부 `schedule: null`, `pending_update: null`입니다. 기존 schedule과의 충돌은
  현재 없습니다.
- 3건 중 **2건이 `cancel_at_period_end: true`**입니다. 해지 예약 상태는 예외가
  아니라 흔한 경우이므로, 자동 해제 금지와 해지 중 다운그레이드 거부가 실제로
  자주 걸립니다.
- 모두 `billing_mode.type: "flexible"`(`proration_discounts: "included"`)입니다.
- 모두 promotion code discount가 붙어 있습니다. **proration preview에 할인이
  반영되므로 금액을 자체 계산하지 말고 Stripe preview 값을 그대로 보여줘야
  합니다.**
- 구독 item의 Price는 위 표의 catalogue Price와 일치합니다
  (`price_1Ts2MJCqxdHJo2tMB7ZxI6HY`).

### Customer Portal configuration (live)

- **설정된 configuration이 없습니다**(`/v1/billing_portal/configurations`가 빈
  목록). 따라서 `subscription_update`나 `schedule_at_period_end` 설정도 없습니다.
  Portal을 플랜 변경 경로로 쓰지 않기로 한 결정과 충돌하지 않습니다.

### 확인 중 드러난 별건

`app/api/billing/checkout/route.ts`의 `buildCheckoutLineItem()`은 catalogue
Price ID가 아니라 `price_data`(+ `product: plan.stripeProductId`)로 구독을
만듭니다. `BillingPlanConfig`에는 `stripePriceId` ·
`stripeAnnualPriceId` 필드가 있지만 구독 Checkout이 쓰지 않습니다. 플랜 변경은
**Price ID를 지정해 item을 교체**해야 하므로, 3단계에서 대상 Price를 어떻게
고르는지(플랜 · interval · 통화 → Price ID) 명시적으로 정해야 합니다. 이번
변경 범위 밖이라 손대지 않았습니다.

### 남은 확인

- **test mode 동일 항목 재확인.** 위 표와 같은 Product · Price 구성이 test
  mode에도 있는지, Price ID가 무엇인지 확인해야 3단계를 test mode에서 검증할 수
  있습니다.

## 7. 구현 순서

앞 단계가 끝나기 전에 뒤 단계를 시작하지 않습니다. 웹훅 보강(4절)은 2 · 3절보다
먼저 끝냈습니다 — 순서 역전 방지가 없는 상태에서 플랜 변경을 붙이면 첫 번째
pending update부터 "결제는 됐는데 권한이 되돌아간" 상태가 나옵니다.

1. ~~**크레딧 경제성 결정**~~ — 확정. `lib/planChangeCredits.ts`에
   `planCreditsAfterPlanChange()`로 인코딩했고 `tests/planChangeCredits.test.mjs`가
   양방향 경계를 고정합니다.
2. **서버 변경 상태기계** — 판정 · preview 유효성 · 예약 상태기계는
   `lib/planChangeStateMachine.ts`로 완료(5절). preview · confirm **엔드포인트는
   아직**이며, 3단계의 Stripe 호출과 함께 붙입니다.
3. ~~**Stripe 결제 · 예약**~~ — 완료(5절). proration preview, `always_invoice` +
   `pending_if_incomplete`, Subscription Schedule, preview · confirm · 조회 ·
   예약 취소 엔드포인트, 웹훅 정산.
4. ~~**웹훅 · 재동기화**~~ (4절) — 완료
5. **CTA · 변경 화면** — `resolvePlanCtaState()`의 `manage_plan` 분기를 전용 변경
   화면으로 교체. **다음 단계.** 화면이 갖춰야 할 것: preview 금액 표시, 갱신 재개
   별도 opt-in(체크 하나로 두 가지에 동의시키지 않기), 예약된 다운그레이드와 적용일
   표시, 예약 취소 버튼, 거부 코드별 문구.

`resolvePlanCtaState()` 수정은 **마지막 UI 단계**입니다. 이 함수를 먼저 바꾸면
동작하지 않는 CTA가 다시 생깁니다.
