1) 판정: approve_with_changes

핵심 진단—“메일 실패가 아니라, 애초에 발송 대상이 아닌데 UI가 발송처럼 보였다”—은 맞습니다. 그러나 §4.2의 기존 lifecycle event 갱신 방식은 현재 큐의 불변 payload 계약을 깨며, 동시 실행 시 실제로 서로 다른 본문이 같은 idempotency key로 전송될 수 있습니다. 또한 게스트가 임의의 제3자 주소를 입력하는 경로와 “provider가 요청을 수락했을 뿐인데 delivered로 표시하는 문제”가 빠졌습니다.

이 두 문제를 고치기 전에는 구현 승인으로 보기 어렵습니다.

## 2) 진단 정확성

### 맞는 부분

분석의 직접 원인과 D1~D4는 코드와 일치합니다.

- 화면의 발송 가능 판정은 `email && emailUpdatesConsent`입니다: [FeedbackInboxPanel.tsx:177](/H:/Project/tomverse-support-reply-truth-20260916/components/admin/FeedbackInboxPanel.tsx:177)
- 회신 입력과 서버 저장은 발송 가능 여부와 무관합니다: [FeedbackInboxPanel.tsx:884](/H:/Project/tomverse-support-reply-truth-20260916/components/admin/FeedbackInboxPanel.tsx:884), [route.ts:133](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/route.ts:133)
- 이벤트를 처음 만들고 주소와 동의가 모두 있을 때만 큐에 넣습니다: [route.ts:143](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/route.ts:143), [route.ts:180](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/route.ts:180)
- 후속 시도에서 event 중복 때문에 `already_notified`로 끝나는 D1도 맞습니다: [route.ts:221](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/route.ts:221)
- 게스트 주소 입력란은 현재 opt-in 이후에만 나타납니다: [FeedbackButton.tsx:698](/H:/Project/tomverse-support-reply-truth-20260916/components/chat/FeedbackButton.tsx:698), [FeedbackButton.tsx:723](/H:/Project/tomverse-support-reply-truth-20260916/components/chat/FeedbackButton.tsx:723)

### 분석이 놓친 “입력한 회신이 사라지는” 경로

1. 큐 생성 후 주소 또는 동의가 바뀌면 재시도에서 회신이 폐기됩니다.

   구체적 시퀀스:

   1. 운영자가 완료 회신을 입력합니다.
   2. `FeedbackLifecycleEvent`와 `NotificationDelivery`가 생성됩니다.
   3. 첫 발송이 일시 실패하여 `pending`이 됩니다.
   4. 재시도 전에 계정 삭제가 실행되어 `Feedback.email=null`, `emailUpdatesConsent=false`가 됩니다: [accountDeletion.ts:164](/H:/Project/tomverse-support-reply-truth-20260916/lib/accountDeletion.ts:164)
   5. 렌더러가 현재 Feedback 행을 다시 읽고 `null`을 반환합니다: [notificationDeliveries.ts:327](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:327), [notificationDeliveries.ts:347](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:347)
   6. 큐는 이를 `source_missing`으로 영구 포기합니다: [notificationDeliveries.ts:410](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:410), [notificationRetryCore.ts:140](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationRetryCore.ts:140)

   계정 삭제 후 보내지 않는 결과 자체는 맞지만, 이유가 `source_missing`으로 뭉개져 운영자에게 “주소 삭제/연락 철회”가 보이지 않습니다. completed에서 동의 검사를 제거하면 동의 철회만으로는 더 이상 막히지 않으므로, 어떤 철회가 marketing/status opt-out이고 어떤 것이 `privacy_request`인지 명확히 분리해야 합니다.

2. 재시도 소진 또는 영구 오류로 회신이 포기됩니다.

   `400/401/403/404/405/410/422`는 즉시 abandoned, 나머지도 6회 후 abandoned입니다: [notificationRetryCore.ts:78](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationRetryCore.ts:78), [notificationRetryCore.ts:154](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationRetryCore.ts:154). D2가 가시성 부재는 말하지만, 이것 역시 “입력한 회신이 실제로 사라지는 경로”로 진단에 명시해야 합니다.

3. 현재 `delivered`는 받은편지함 도달이 아닙니다.

   `sendTransactionalEmail()`이 provider 요청을 수락하면 즉시 `delivered`로 기록합니다: [notificationDeliveries.ts:422](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:422), [notificationDeliveries.ts:428](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:428). `NotificationDelivery`에는 provider message ID나 webhook 기반 delivered 상태도 없습니다: [schema.prisma:2080](/H:/Project/tomverse-support-reply-truth-20260916/prisma/schema.prisma:2080).

   따라서 사고가 “큐가 없어서 아무 요청도 하지 않은 경우”였다는 증거는 충분하지만, 일반적으로 “provider가 수락했으나 bounce/drop된 경우”까지 배제한 완전한 진단은 아닙니다. §4.4 UI도 `발송됨`보다 `메일 제공자에 제출됨` 또는 `전송 요청 성공`이라고 표시해야 정직합니다.

4. 게스트 주소는 소유권이 검증되지 않습니다.

   현재 guest가 입력한 주소는 Turnstile과 rate limit만 거칩니다. Turnstile은 주소 소유권 검증이 아닙니다: [feedback route.ts:198](/H:/Project/tomverse-support-reply-truth-20260916/app/api/feedback/route.ts:198), [feedback route.ts:210](/H:/Project/tomverse-support-reply-truth-20260916/app/api/feedback/route.ts:210).

   §4.5대로 주소를 항상 수집하고 completed를 무조건 transactional로 보내면 다음이 가능합니다.

   1. 공격자가 제3자 주소를 입력합니다.
   2. 동의 체크는 하지 않습니다.
   3. 운영자가 정상적으로 답변을 작성하고 완료합니다.
   4. 제3자가 요청하지 않은 Tomverse 메일을 받습니다.

   사용자가 시작한 요청에 대한 transactional이라는 분류는 맞아도, 해당 주소의 소유자가 요청자라는 사실은 증명되지 않습니다.

## 3) §6의 네 질문

### 1. completed를 transactional로 보는 것이 충분한가

처리 결과만 담고 판촉을 섞지 않는다면 맞습니다. 정책 정의가 “사용자가 시작한 특정 요청에 대한 응답”을 transactional로 규정합니다: [email-notifications.md:396](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:396). primary purpose가 기준이므로 홍보 CTA를 넣으면 결론이 바뀝니다: [email-notifications.md:405](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:405).

대상별 판정은 다음과 같습니다.

| 주소 상태 | 판정 |
|---|---|
| 게스트가 남긴 주소 | 내용 분류는 transactional. 다만 주소 소유권이 검증되지 않았으므로 “그 주소의 소유자가 요청했다”는 전제가 부족함 |
| 로그인 계정 주소 | 서버가 검증된 세션의 계정 주소를 선택하므로 transactional 발송 근거가 가장 강함: [feedback route.ts:205](/H:/Project/tomverse-support-reply-truth-20260916/app/api/feedback/route.ts:205) |
| 계정 삭제로 scrub된 주소 | 발송하면 안 됨. 주소가 이미 null이며 삭제가 연락 철회를 명시적으로 구현함: [accountDeletion.ts:164](/H:/Project/tomverse-support-reply-truth-20260916/lib/accountDeletion.ts:164) |
| 이후 동의를 철회한 주소 | marketing 또는 중간 상태 알림 동의 철회만으로 completed transactional을 막지는 않음. 다만 manual/privacy-request suppression이나 주소 삭제라면 막아야 함 |
| local suppression 주소 | hard bounce는 반드시 차단. manual/privacy_request도 현재 승인된 코드 계약상 transactional을 차단. complaint/unsubscribe는 completed transactional을 막지 않음 |

unsubscribe, marketing jurisdiction allowlist, double opt-in v9~v11은 marketing에 대한 규칙이므로 순수 completed 회신과 충돌하지 않습니다. transactional에는 unsubscribe 링크와 헤더를 넣지 않아야 합니다: [email-notifications.md:1078](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:1078).

발신자도 설계와 맞습니다. feedback lifecycle은 `support` 역할이어야 합니다: [email-notifications.md:2286](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:2286), [email-notifications.md:2345](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:2345), [notificationDeliveries.ts:94](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:94).

### 2. 미발송 event를 갱신하는 §4.2는 안전한가

안전하지 않습니다.

스키마와 렌더러는 lifecycle event를 “insert-only immutable snapshot”으로 명시합니다: [schema.prisma:2045](/H:/Project/tomverse-support-reply-truth-20260916/prisma/schema.prisma:2045), [notificationDeliveries.ts:322](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:322). 같은 delivery ID는 provider idempotency key가 되고, 모든 시도가 같은 payload를 제공한다는 전제가 있습니다: [notificationDeliveries.ts:403](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:403).

“delivery 행이 아직 없다”는 것만으로 event 수정이 안전하다고 할 수 없습니다.

- 동시 PATCH A와 B가 각각 서로 다른 회신으로 같은 event를 갱신할 수 있습니다.
- 둘 중 하나가 delivery를 만들고 transaction을 커밋한 직후 다른 transaction이 event를 다시 바꿀 수 있습니다.
- inline send 또는 drain이 event를 읽는 시점에 따라 A 또는 B 본문이 전송됩니다.
- 첫 attempt가 실패하거나 타임아웃된 동안 event가 바뀌면 같은 idempotency key의 후속 attempt가 다른 payload를 갖습니다.
- drain claim은 `nextAttemptAt`만 바꾸며 source event를 잠그거나 snapshot하지 않습니다: [notificationDeliveries.ts:554](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:554)

더 안전한 대안은 다음 중 하나입니다.

- 권장: `NotificationDelivery.referenceId`가 immutable lifecycle-event ID를 가리키게 하고, 완료 회신용 새 immutable event/dispatch record를 만듭니다. `(feedbackId, stage)`를 “상태가 한 번 발생함”의 키로 유지하되, 실제 회신 발송은 별도의 immutable communication attempt/version으로 모델링합니다.
- delivery 생성 시 수신 주소, 언어, outcome, reply 또는 암호화된 render input snapshot을 delivery에 고정하고 이후 retry는 그 snapshot만 렌더합니다. 주소 삭제·privacy request는 별도의 send gate로 차단하되 본문은 변경하지 않습니다.
- 과거 orphan event 복구를 일회성으로 지원하려면, 명시적인 `completion_reply_v2`/generation을 원자적으로 생성하고 그 generation의 delivery만 큐에 넣습니다. 기존 event를 덮어쓰지 않습니다.

동시에 하나의 발송 generation만 만들도록 DB unique constraint 또는 feedback 행 잠금/CAS가 필요합니다. 애플리케이션에서 “delivery가 없었는지 조회 후 update”만 하는 것은 충분하지 않습니다.

### 3. suppression 검사는 계약과 맞는가

검사 추가 자체는 맞고 필요합니다. 다만 “hard bounce만 차단”으로 구현하면 현재 코드 계약과 불완전하게 맞습니다.

현재 suppression 판정은 다음과 같습니다.

- hard bounce: transactional도 차단
- soft bounce: transactional 허용
- complaint: transactional 허용, transactional/unknown 출처면 incident
- unsubscribe: transactional 허용
- manual 또는 privacy_request: transactional도 차단

근거: [emailSuppressionCore.ts:65](/H:/Project/tomverse-support-reply-truth-20260916/lib/emailSuppressionCore.ts:65), [emailSuppressionCore.ts:77](/H:/Project/tomverse-support-reply-truth-20260916/lib/emailSuppressionCore.ts:77), [emailSuppressionCore.ts:92](/H:/Project/tomverse-support-reply-truth-20260916/lib/emailSuppressionCore.ts:92), [emailSuppressionCore.ts:96](/H:/Project/tomverse-support-reply-truth-20260916/lib/emailSuppressionCore.ts:96).

따라서 새 경로는 자체 조건문을 만들지 말고 `suppressionCheck({ classification: "transactional" })`를 사용해야 합니다. suppressed를 단일 사유로 뭉개지 말고 최소한 `hard_bounce`, `privacy_request/manual`, provider suppression을 운영 화면에서 구분해야 합니다.

### 4. 게스트 주소 상시 노출이 개인정보 최소수집과 충돌하는가

선택 입력이고, “답변을 받기 위한 목적”과 사용 방식을 입력 전에 명확히 말한다면 상시 노출 자체가 최소수집 원칙과 충돌한다고 보기는 어렵습니다. 현재 `/support`는 이미 주소를 필수로 받습니다: [SupportPageContent.tsx:621](/H:/Project/tomverse-support-reply-truth-20260916/components/marketing/SupportPageContent.tsx:621).

다만 더 나은 형태는 다음과 같습니다.

- 필드 라벨: “답변 받을 이메일 주소(선택)”
- 바로 옆 설명: “입력하면 이 신고의 최종 처리 답변을 보내며, 아래 체크박스는 접수·검토 중 상태 알림만 제어합니다.”
- 주소가 비어 있으면: 내부 기록만 가능하다는 사실을 제출 전 표시
- guest 주소가 있으면: `emailUpdates=false`여도 recipient rate limit 적용
- 제3자 오발송 방지: 주소 확인 절차 또는 최소한 명시적 “이 주소로 최종 답변 받기” 확인을 둠. 보안성이 필요한 경우 verified guest contact token을 보고서에 묶는 편이 낫습니다.
- 운영자 화면에는 전체 주소를 불필요하게 반복 노출하지 말고 마스킹하되, 실제 대상 확인이 필요한 지점에서만 보여 줍니다.

## 4) 발견 목록

### F1 — blocker: 기존 lifecycle event를 수정하면 동일 idempotency key의 payload가 바뀜

- 근거: [schema.prisma:2045](/H:/Project/tomverse-support-reply-truth-20260916/prisma/schema.prisma:2045), [notificationDeliveries.ts:215](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:215), [notificationDeliveries.ts:403](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:403)
- 확인 방법: 서로 다른 reply를 가진 동시 PATCH 두 건과 drain/inline attempt를 barrier로 교차 실행하고, 동일 delivery ID에서 렌더된 payload hash가 달라지는지 확인
- 권장 수정: lifecycle event는 수정하지 말고 immutable communication generation 또는 delivery snapshot을 새로 생성. DB uniqueness/CAS로 generation 하나만 생성
- 차단 이유: 서로 다른 내용의 메일이 외부로 나가면 회수할 수 없음

### F2 — blocker: 검증되지 않은 guest 주소로 unsolicited transactional 메일을 보낼 수 있음

- 근거: [feedback route.ts:205](/H:/Project/tomverse-support-reply-truth-20260916/app/api/feedback/route.ts:205), [feedback route.ts:210](/H:/Project/tomverse-support-reply-truth-20260916/app/api/feedback/route.ts:210), [FeedbackButton.tsx:723](/H:/Project/tomverse-support-reply-truth-20260916/components/chat/FeedbackButton.tsx:723)
- 확인 방법: 비로그인 상태에서 제3자 주소, `emailUpdates=false`로 신고한 뒤 완료 처리하고 실제 큐 대상 확인
- 권장 수정: verified guest contact를 보고서에 결속하거나, 최소한 명시적 최종 답변 요청 + 주소별 rate limit을 적용. threat model과 abuse test 추가
- 차단 이유: 잘못된 수신자에게 신고 내용과 운영자 답변이 노출되면 회수 불가능한 개인정보 유출

### F3 — major: §4.3이 manual/privacy_request suppression을 빠뜨림

- 근거: [emailSuppressionCore.ts:96](/H:/Project/tomverse-support-reply-truth-20260916/lib/emailSuppressionCore.ts:96), [email-notifications.md:2101](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:2101), [AGENTS.md:1030](/H:/Project/tomverse-support-reply-truth-20260916/AGENTS.md:1030)
- 확인 방법: 각 suppression reason별 `suppressionCheck(classification="transactional")` 표 기반 테스트
- 권장 수정: hard-bounce 전용 조건문 대신 기존 `suppressionCheck` 사용. complaint incident도 보존

### F4 — major: `delivered` 표시는 실제 도달을 과장함

- 근거: [notificationDeliveries.ts:422](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:422), [schema.prisma:2086](/H:/Project/tomverse-support-reply-truth-20260916/prisma/schema.prisma:2086)
- 확인 방법: provider API 성공 후 bounce webhook이 발생하는 fixture에서 admin 행이 계속 delivered로 보이는지 확인
- 권장 수정: 현 모델에서는 `submitted/sent`라고 표시. 실제 `delivered`를 주장하려면 providerMessageId와 webhook 상태를 연결

### F5 — major: inline attempt와 drain 사이에 단일 claim이 없음

- 근거: inline은 바로 attempt 후 attempts=0으로 기록합니다: [notificationDeliveries.ts:443](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:443). drain만 CAS claim을 수행합니다: [notificationDeliveries.ts:554](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:554)
- 확인 방법: enqueue 직후 inline send를 정지시키고 drain을 병렬 실행
- 권장 수정: inline과 drain 모두 동일 claim primitive 사용. 현재는 identical payload와 provider idempotency가 피해를 줄이지만, §4.2의 mutable event와 결합하면 안전장치가 무너짐

### F6 — minor: 미발송 이유가 `source_missing`으로 잘못 기록됨

- 근거: [notificationDeliveries.ts:410](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:410), [accountDeletion.ts:172](/H:/Project/tomverse-support-reply-truth-20260916/lib/accountDeletion.ts:172)
- 확인 방법: queued 상태에서 계정 삭제 후 drain
- 권장 수정: renderer가 `no_address`, `contact_removed`, `privacy_suppressed`, `source_missing`을 구별하도록 구조화된 결과 반환

### F7 — minor: Admin 목록에 delivery를 붙일 때 bounded-read 계약을 명시해야 함

- 근거: [adminConsoleData.ts:31](/H:/Project/tomverse-support-reply-truth-20260916/lib/adminConsoleData.ts:31), [AGENTS.md:1260](/H:/Project/tomverse-support-reply-truth-20260916/AGENTS.md:1260)
- 확인 방법: 최신 20개 외 항목과 `includeId` 경로에서 delivery 상태가 정확히 함께 로드되는지 확인
- 권장 수정: feedback 20건에 대한 relation/select 또는 제한된 batched query만 사용하고 화면에 “최신 20건” 범위를 유지. 전역 합계처럼 표시하지 않기

## 릴리스 차단 판단

이번 변경에서 차단해야 할 것은 두 가지입니다.

- guest 주소의 소유권/명시적 최종 답변 요청을 정리하지 않은 채 동의 없는 completed 발송을 확대하는 것
- immutable event를 수정하여 동일 idempotency key에 다른 본문이 결합될 수 있는 것

둘 다 잘못된 메일 또는 잘못된 본문이 외부로 나가면 회수할 수 없으므로 AGENTS.md의 “되돌릴 수 없는 것” 기준상 release blocker입니다. 문구, 토스트, 목록 상태 표시 자체는 고쳐 배포할 수 있으므로 차단 사항이 아닙니다.