# 운영 알림 재처리 큐 (2026-08-01)

`.github/audits/feedback-modal-2026-08-01.md`에서 남은 위험으로 적어둔 항목을
없앤 기록입니다.

> 알림 이메일 재처리 큐 없음. DB 저장 성공 + 이메일 실패는 사용자에게 성공으로
> 보이지만, 실패한 알림은 로그(`support_notification_failed`)에만 남고 자동
> 재시도가 없습니다.

## 무엇이 문제였나

피드백이 DB에 저장된 뒤 운영팀 알림 메일 한 번이 실패하면, 로그 한 줄이
남고 끝이었습니다. **알림을 보내야 한다는 사실 자체를 기억하는 곳이 없었기**
때문에 재시도할 대상도, 조회할 대상도 없었습니다. 제품은 정상으로 보이고
팀은 그 제보를 영영 못 보는 상태입니다.

## 설계

### 저장하지 않는 것

큐는 **메일 본문을 저장하지 않습니다.** `kind` + `referenceId`로 원본 행을
가리키고, 보낼 때 다시 렌더링합니다. 제보자가 쓴 글이 두 테이블에 복제되지
않고 retention 정책도 하나로 유지됩니다.

`NotificationDelivery` 컬럼: `kind`, `referenceId`, `status`, `attempts`,
`nextAttemptAt`, `lastAttemptAt`, `lastErrorKind`, `deliveredAt`.
`lastErrorKind`는 `http_502` 같은 분류만 담습니다 — provider 응답 본문은
요청을 그대로 되비추므로(=제보자의 글) 절대 저장하지 않습니다.

### 손실이 불가능한 지점

큐 행은 **피드백과 같은 트랜잭션에서** 기록됩니다. 전송 실패 후에 기록하는
방식이면 전송 도중 프로세스가 죽었을 때 알림을 빚졌다는 사실조차 사라집니다 —
고치려던 바로 그 종류의 버그입니다.

대신 전달은 **at-least-once**입니다. 전송 성공 직후 행을 갱신하기 전에
프로세스가 죽으면 다시 보냅니다. 운영 알림에서는 중복이 유실보다 낫고,
재시도 메일은 몇 번째 시도인지와 "제보는 접수 시점에 이미 저장됐다"는 사실을
본문에 밝힙니다.

### 재시도 정책 (`lib/notificationRetryCore.ts`, 순수 함수)

| 시도 | 다음 시도까지 |
|---|---|
| 1 → 2 | 1분 |
| 2 → 3 | 5분 |
| 3 → 4 | 15분 |
| 4 → 5 | 1시간 |
| 5 → 6 | 4시간 |
| 6 실패 | 포기 |

총 약 5시간 20분. provider 장애는 넘기고, 설정이 잘못됐다면 같은 근무일 안에
드러나는 길이입니다.

즉시 포기하는 경우:

- **영구 실패** — 400/401/403/404/405/410/422. 같은 요청을 다시 보내도
  결과가 같습니다. 6번 시도해서 알아낼 일이 아닙니다.
- **보낼 것이 없음** — 수신자 미설정, 또는 원본 피드백이 retention으로 이미
  삭제됨(`source_missing`).

`not_configured`(RESEND_API_KEY 없음)는 일반 일시 실패처럼 재시도합니다.
창 안에 설정이 고쳐지면 알림이 도착하고, 아니면 포기 시점에 인시던트가
"메일이 설정되지 않아 제보 알림을 버렸다"고 알립니다.

### 배수(drain)

`drainNotificationDeliveries()`가 due 행을 **조건부 update로 한 건씩
claim**합니다. 두 배수가 겹쳐도 같은 알림을 두 번 보내지 않습니다.

두 경로에서 돕니다.

1. **기존 5분 크론에 편승** — `/api/internal/maintenance/credit-reservations`.
   `drainNotificationDeliveriesQuietly()`는 절대 throw하지 않으므로 크레딧
   정산 작업을 실패시킬 수 없습니다. **새 크론 등록 없이 즉시 동작합니다.**
2. **전용 엔드포인트** — `/api/internal/maintenance/notification-deliveries`
   (`MAINTENANCE_SECRET` 게이트, `npm run maintenance:notification-deliveries`).
   메일 설정을 고친 직후 다음 tick을 기다리지 않고 밀어넣는 용도입니다.

`notification_delivery_retry`로 scheduled job에 등록되어 Admin Console의
Scheduled Jobs 패널에 마지막 실행·처리 건수·지연 여부가 그대로 나옵니다.

### 눈에 띄게 만들기

포기는 아무도 눈치채지 못하는 유일한 결과이므로 두 곳에 남깁니다.

- 구조화 로그 `notification_delivery_abandoned` (deliveryId, kind,
  referenceId, attempts, errorKind — 본문 없음)
- `reportOperationalIncident({ code: "NOTIFICATION_DELIVERY_ABANDONED" })`,
  30분 쿨다운, 건수만 포함

`drainNotificationDeliveries()`는 `pending` 총계를 함께 반환하므로 큐 깊이가
매 실행의 job result에 기록됩니다.

### Retention

`delivered`/`abandoned` 행은 30일 후 정리합니다(`cleanupExpiredData`).
**`pending` 행은 절대 지우지 않습니다** — 아직 전달을 빚지고 있습니다.

## 부수 변경

운영 알림 메일 본문이 `app/api/feedback/route.ts` 안에 있었는데
`lib/supportNotificationEmail.ts`로 옮겼습니다. 이제 최초 전송과 재시도가
같은 렌더러를 쓰므로 재전송 메일이 원본과 달라질 수 없습니다.
`tests/typographyPolicy.test.mjs`의 이메일 템플릿 목록도 같이 옮겼습니다.

## 검증

- `tests/notificationRetryCore.test.mjs` 25건 — backoff, 영구/일시 실패 분류,
  오류 텍스트 비유출, 렌더러 escaping, 스키마·트랜잭션·retention 소스 가드
- `tests/server-contract/notification-delivery-queue.test.ts` 12건 — 실제
  라우트와 실제 배수를 인메모리 DB로 구동. 전송 실패 후 pending 유지, 이후
  배수에서 전달, 영구 실패 즉시 포기, 6회 후 포기 + 인시던트, 동시 배수
  중복 방지, 원본 삭제 시 루프 없이 종료, 큐·로그에 제보 원문 없음
- `test:unit` 842, `test:server-contract` 100, feedback E2E 86 (desktop+mobile)
- typecheck / eslint / build / security:regression 117 / encoding /
  accent-tokens 통과

## 배포 시 필요한 것

**마이그레이션 1건**: `20260801170000_add_notification_delivery_queue`.

환경변수 변경 없음. 새 크론 등록도 필요 없습니다(기존 5분 크론에 편승).
전용 엔드포인트를 별도 스케줄로 돌리고 싶다면 `MAINTENANCE_SECRET`을 쓰는
기존 방식 그대로입니다.

## 남는 위험

- **at-least-once**이므로 드물게 운영 알림이 중복 도착할 수 있습니다.
  의도된 트레이드오프이며 메일 본문이 몇 번째 시도인지 밝힙니다.
- 이 큐는 **support feedback 알림에만** 연결돼 있습니다. 계정·결제·로그인
  메일은 기존 동작 그대로입니다 — 로그인 코드처럼 뒤늦은 재전송이 오히려
  틀린 경우가 있어 일괄 적용하지 않았습니다. 다른 종류를 넣으려면
  `NOTIFICATION_KIND`와 `renderNotification()`에 추가하면 됩니다.
- 배수는 한 번에 25건까지 처리합니다. 대량 적체 시 여러 tick에 걸쳐
  빠지며, 큐 깊이는 매 실행 결과의 `pending`으로 확인할 수 있습니다.
