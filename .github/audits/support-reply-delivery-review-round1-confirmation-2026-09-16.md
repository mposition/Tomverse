## 1) 판정

**approve_with_changes**

다섯 항목은 모두 실질적으로 닫혔고, 새 release blocker는 발견하지 못했습니다. 다만 문서 상단의 개정 번호가 아직 `v11`로 남아 있어, 병합 전 `v12`로 맞추는 작은 수정이 필요합니다: [email-notifications.md](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:7).

## 2) 항목별 확인

1. **재발송 preview와 payload의 단일 source — 닫힘**

   - 콘솔 loader가 화면에 포함된 동일한 bounded feedback ID에 대해서만 `completed` lifecycle event를 읽습니다: [adminConsoleData.ts](/H:/Project/tomverse-support-reply-truth-20260916/lib/adminConsoleData.ts:126).
   - 버튼 노출 조건과 미리보기 모두 `completionSnapshot.userReply`를 사용하며 mutable `Feedback.userReply`를 사용하지 않습니다: [FeedbackInboxPanel.tsx](/H:/Project/tomverse-support-reply-truth-20260916/components/admin/FeedbackInboxPanel.tsx:718).
   - 실제 발송도 같은 `completed` lifecycle event에서 렌더링합니다.
   - 새 surface 테스트가 버튼 gating, preview source, bounded lifecycle-event read를 고정합니다: [feedbackReplyResendSurface.test.mjs](/H:/Project/tomverse-support-reply-truth-20260916/tests/feedbackReplyResendSurface.test.mjs:39).

   두 번째 close는 mutable feedback만 바꾸고 최초 event는 바꾸지 않으므로 preview와 payload가 함께 최초 snapshot에 남습니다. 동시 close도 `(feedbackId, stage)` 유일성과 `createMany(...skipDuplicates)` 때문에 하나의 완료 event만 남습니다.

2. **resend 테스트 fake claim — 닫힘**

   - fake에 `findUnique`와 production과 같은 `id + status + nextAttemptAt` CAS 조건의 `updateMany`가 추가됐습니다: [admin-feedback-resend-route.test.ts](/H:/Project/tomverse-support-reply-truth-20260916/tests/server-contract/admin-feedback-resend-route.test.ts:113).
   - 항상 성공시키는 fake가 아니라 실제 row 상태와 timestamp를 대조하므로 round-1의 허위 claim 문제를 해소합니다.

3. **inline-vs-drain race 테스트 — 닫힘**

   - inline attempt와 drain을 동시에 실행하고 외부 send 1회, 최종 attempt 1회, 최종 `delivered`를 확인합니다: [notification-delivery-queue.test.ts](/H:/Project/tomverse-support-reply-truth-20260916/tests/server-contract/notification-delivery-queue.test.ts:536).
   - production inline 경로도 drain과 동일하게 읽은 `nextAttemptAt`을 CAS 조건으로 사용합니다: [notificationDeliveries.ts](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:520).

4. **suppression 검사 범위 — 닫힘**

   - 검사는 `feedback_user_*`에만 적용됩니다: [notificationDeliveries.ts](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:469).
   - 따라서 support 운영 알림, refund, auto-fix 알림에는 이번 정책이 새로 적용되지 않습니다.
   - 현재 정책 문서가 정의한 scope와 일치합니다: [email-notifications.md](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:34).

5. **manual/privacy_request reporting — 닫힘**

   - 두 reason 모두 core에서 `suppressed_complaint`로 합쳐진다는 기존 한계를 문서가 명시합니다: [email-notifications.md](/H:/Project/tomverse-support-reply-truth-20260916/docs/policy/email-notifications.md:39).
   - 코드는 구별을 만들어내지 않고 받은 skip reason을 그대로 저장합니다: [notificationDeliveries.ts](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:478).
   - round-1이 허용한 “구별하거나, 구별 불가를 문서화” 중 후자를 충족합니다.

## 3) 새 결함

**기능상 새 결함은 발견하지 못했습니다.**

특히:

- **두 번째 close:** preview와 발송 모두 최초 immutable completion event를 사용하므로 갈라지지 않습니다.
- **동시 close:** 완료 event 하나만 생성되며, 화면과 발송이 그 동일 event를 읽습니다.
- **retention/deletion:** 현재 코드에는 feedback을 남긴 채 lifecycle event만 교체하는 경로가 없습니다. event가 없어지면 버튼이 노출되지 않거나 POST가 `NOT_COMPLETED`/발송 시 `source_missing`으로 거부되므로 다른 문구가 발송되지는 않습니다.
- **claim 후 crash:** claim은 `nextAttemptAt`을 5분 뒤로 옮길 뿐입니다. 기록 전에 중단돼도 row는 `pending`이고 이후 drain이 다시 가져옵니다. provider 호출 후 crash한 경우에도 동일 delivery ID가 idempotency key이므로 중복 발송 방어가 유지됩니다.
- **suppression:** 의도한 reporter-facing `feedback_user_*` 범위에만 적용되어 있습니다.

유일한 잔여 수정은 문서 상단 개정 표기의 `v11` → `v12` 정합성입니다. 이는 release blocker가 아닙니다.