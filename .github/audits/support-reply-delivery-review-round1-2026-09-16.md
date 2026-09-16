## 1) 판정

**reject**

F1·F2의 설계 방향과 F5의 inline claim은 구현됐습니다. 그러나 merge 전 반드시 막아야 할 새 blocker가 있습니다.

- resend 화면이 보여 주는 답변과 실제 발송되는 immutable lifecycle event 답변이 달라질 수 있습니다.
- 그러면 운영자가 확인하지 않은 과거 문구가 외부로 발송됩니다.
- 메일은 회수할 수 없으므로 AGENTS.md 기준 release blocker입니다.

또한 새 resend 계약 테스트가 실제 저장소 실행 방식에서 실패합니다.

---

## 2) Round 0 발견별 해소 여부

| 발견 | 판정 | 코드 근거 |
|---|---|---|
| F1 — 기존 event 수정으로 payload 변경 | **해소** | 기존 event는 생성만 하고 수정하지 않습니다. 최초 event는 `createMany(... skipDuplicates)`로 고정됩니다: [route.ts:147](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/route.ts:147). 렌더러는 lifecycle event의 `outcomeCode/userReply`를 읽습니다: [notificationDeliveries.ts:352](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:352). |
| F2 — guest 제3자 주소로 발송 범위 확대 | **해소** | guest 주소 입력 구조는 변경하지 않았습니다. 주소 안내 문구만 추가했습니다: [FeedbackButton.tsx:720](/H:/Project/tomverse-support-reply-truth-20260916/components/chat/FeedbackButton.tsx:720). 새 무동의 발송 확대는 주소가 이미 있는 signed-in completed에 한정됩니다. |
| F3 — suppression 계약 | **부분 해소** | 모든 attempt가 기존 `suppressionCheck(... transactional)`을 호출합니다: [notificationDeliveries.ts:462](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:462). hard bounce/manual/privacy는 차단되고 soft bounce/complaint/unsubscribe는 허용됩니다. 다만 manual과 privacy_request는 기존 core가 둘 다 `suppressed_complaint`로 반환하여 구별되지 않습니다: [emailSuppressionCore.ts:96](/H:/Project/tomverse-support-reply-truth-20260916/lib/emailSuppressionCore.ts:96). 설계 §3a의 `suppressed:<reason>`을 문자 그대로 구현하지 못했습니다. |
| F4 — `delivered` 과장 | **해소** | 콘솔은 DB의 `delivered`를 “메일 제공자 접수됨”으로 번역합니다: [adminConsoleData.ts:176](/H:/Project/tomverse-support-reply-truth-20260916/lib/adminConsoleData.ts:176), [feedbackInbox.ts:175](/H:/Project/tomverse-support-reply-truth-20260916/lib/adminMessages/feedbackInbox.ts:175). 받은편지함 도달을 주장하지 않습니다. |
| F5 — inline/drain claim 불일치 | **코드는 해소, 검증은 미완료** | inline도 발송 전에 조건부 `updateMany` claim을 합니다: [notificationDeliveries.ts:501](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:501). drain claim은 [notificationDeliveries.ts:631](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:631)입니다. 양쪽이 `nextAttemptAt`을 CAS 성격으로 변경하므로 동시에 이길 수 없습니다. 다만 테스트는 drain-vs-drain만 검증하며 inline-vs-drain 경합 테스트가 없습니다. |
| F6 — 미발송 사유 뭉개짐 | **대부분 해소** | event 없음은 `source_missing`, 주소가 사라지면 `contact_removed`, 진행 동의 없음은 `not_consented`, suppression은 `suppressed:*`가 됩니다: [notificationDeliveries.ts:370](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:370), [notificationDeliveries.ts:447](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:447). 단 manual/privacy의 실제 reason 분리는 위 F3처럼 미완료입니다. |
| F7 — bounded read | **해소** | 먼저 최신 `take`건과 선택된 `includeId` 한 건만 가져오고: [adminConsoleData.ts:85](/H:/Project/tomverse-support-reply-truth-20260916/lib/adminConsoleData.ts:85), 그 ID 목록에 한정해 delivery를 조회합니다: [adminConsoleData.ts:103](/H:/Project/tomverse-support-reply-truth-20260916/lib/adminConsoleData.ts:103). 전역 delivery 조회나 합계 표시는 없습니다. |

§3a에서 주장했지만 구현되지 않은 항목은 다음입니다.

- suppression을 실제 원인별 `suppressed:<reason>`으로 표시한다는 주장: manual과 privacy_request가 구별되지 않습니다.
- “보낼 내용이 화면에 먼저 보인다”는 resend 주장: 화면과 실제 발송 source가 다릅니다.
- F5에 대응하는 inline-vs-drain 경합 검증: 코드에는 claim이 있지만 해당 테스트는 없습니다.

---

## 3) 새 발견

### Blocker — resend가 운영자에게 보이지 않은 과거 답변을 발송할 수 있음

근거:

- terminal PATCH는 매번 현재 `Feedback.userReply`를 덮어씁니다: [route.ts:137](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/route.ts:137).
- lifecycle event는 최초 완료에서만 생성되고 이후에는 바뀌지 않습니다: [route.ts:147](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/route.ts:147).
- 콘솔은 현재 `Feedback.userReply`를 보여 주고 그 행에서 resend 버튼을 노출합니다: [FeedbackInboxPanel.tsx:711](/H:/Project/tomverse-support-reply-truth-20260916/components/admin/FeedbackInboxPanel.tsx:711).
- 실제 resend 렌더러는 현재 Feedback 답변이 아니라 최초 lifecycle event의 `userReply`를 보냅니다: [notificationDeliveries.ts:352](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:352).
- endpoint도 event의 존재만 확인하고 그 내용을 응답하거나 operator confirmation과 결속하지 않습니다: [resend route.ts:65](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/resend-reply/route.ts:65).

재현:

1. 주소와 답변 A가 있는 신고를 과거 규칙에서 완료하지만 메일은 enqueue되지 않게 합니다.
2. 같은 신고를 terminal 상태로 다시 저장하면서 답변 B로 바꿉니다.
3. 콘솔에는 B가 보입니다.
4. “이 답변 지금 보내기”를 누릅니다.
5. 실제 메일에는 최초 event의 A가 들어갑니다.

권장 수정:

- resend 가능 여부와 preview를 `FeedbackLifecycleEvent.userReply/outcomeCode`에서 직접 구성해 실제 발송 payload와 동일하게 보여 주십시오.
- POST 전에 preview용 GET을 추가하거나, bounded loader에서 완료 event snapshot을 함께 읽어 화면에 표시해도 됩니다.
- 버튼 문구도 “현재 답변”이 아니라 “아래에 표시된 최초 완료 답변”과 정확히 결속해야 합니다.
- `Feedback.userReply !== event.userReply`인 경우 명시적인 경고 또는 resend 거부가 안전합니다.

이 문제는 잘못된 내용을 외부로 보내면 회수할 수 없으므로 release blocker입니다.

### Major — resend server-contract 테스트가 현재 실패함

실제 저장소 실행기에서 다음 두 테스트가 실패했습니다.

- `it sends the stored reply and records the action`
- `an abandoned first attempt may be sent again, once`

원인은 새 inline claim이 `notificationDelivery.updateMany()`를 요구하지만 resend 테스트의 fake Prisma가 이를 구현하지 않았기 때문입니다. 예외가 `deliverNotificationNow()` 내부에서 흡수되어 `delivered:false`가 되고, 테스트가 기대한 메일도 생성되지 않습니다.

근거:

- production claim: [notificationDeliveries.ts:512](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:512)
- fake는 `upsert`와 `update`만 제공: [admin-feedback-resend-route.test.ts:126](/H:/Project/tomverse-support-reply-truth-20260916/tests/server-contract/admin-feedback-resend-route.test.ts:126)

권장 수정:

- fake Prisma에 production 조건을 반영한 `updateMany`를 구현하십시오.
- 단순히 항상 `{count: 1}`을 반환하지 말고 status, attempts, nextAttemptAt 조건을 검사해야 F5 회귀를 잡을 수 있습니다.
- inline attempt를 barrier에서 정지시키고 drain을 실행하여 실제 발송 호출이 정확히 한 번인지 검증하십시오.

### Major — suppression 검사가 피드백뿐 아니라 전체 notification queue에 적용됨

`attemptNotificationDelivery()` 공통 경로에 suppression을 추가했기 때문에 다음 종류에도 새 판정이 적용됩니다.

- 내부 support 운영 알림
- refund 알림
- auto-fix 운영 알림
- feedback lifecycle 알림

근거: kind 분기 후 공통 send 직전에 검사합니다: [notificationDeliveries.ts:433](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:433), [notificationDeliveries.ts:468](/H:/Project/tomverse-support-reply-truth-20260916/lib/notificationDeliveries.ts:468).

이는 새 메일을 잘못 보내는 문제는 아니지만, 설계의 “이 경로”보다 범위가 넓으며 기존 운영 알림이나 환불 알림을 manual/privacy suppression 때문에 영구 포기시킬 수 있습니다.

권장 수정:

- 각 kind에 올바른 classification/suppression 정책을 명시한 total mapping을 두거나,
- 이번 변경에서는 feedback-user kind에만 검사를 한정하십시오.
- 내부 운영자 주소 suppression이 실제로 어떤 의미인지 별도 정책 결정 없이 transactional로 가정하면 안 됩니다.

### Minor — resend 동시 요청의 응답이 정확하지 않음

동시 POST 두 건은 unique upsert와 inline claim 때문에 외부 발송은 한 번으로 제한됩니다. 그러나 둘 다 사전 조회를 통과하고 같은 delivery를 upsert할 수 있으며, claim을 잃은 요청도 HTTP 200과 “queued: true”를 받습니다: [resend route.ts:75](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/resend-reply/route.ts:75), [resend route.ts:107](/H:/Project/tomverse-support-reply-truth-20260916/app/api/admin/feedback/[feedbackId]/resend-reply/route.ts:107).

실제 중복 발송은 아니므로 blocker는 아니지만, audit log도 두 번 기록될 수 있습니다. enqueue가 새 row를 만들었는지 반환하거나 transaction 안에서 ownership을 판정하는 편이 정확합니다.

---

## 단계별 발송 판정

- guest + 주소: 현재 UI 구조상 체크를 켜야 주소를 남길 수 있으므로 received/reviewing/completed 모두 발송 대상입니다.
- guest + 주소 없음: 전 단계 미발송, `no_address`.
- signed-in + 체크: 전 단계 발송 대상입니다.
- signed-in + 체크 없음: received/reviewing은 `not_consented`; completed만 발송됩니다. 설계 의도와 일치합니다.
- enqueue 후 주소 scrub: 렌더 시 현재 주소를 다시 읽어 `contact_removed`로 abandoned됩니다.
- hard bounce: 차단, `suppressed:hard_bounce`.
- soft bounce: transactional이므로 허용.
- complaint: 허용. 다만 `raiseIncident` 결과를 이 호출부가 소비하지 않으므로 incident가 실제 생성되는지는 별도 기존 구현 확인이 필요합니다.
- unsubscribe: 허용.
- manual/privacy_request: 차단되지만 둘 다 `suppressed:suppressed_complaint`로 기록되어 실제 이유는 사라집니다.
- resend: 원래 completed가 delivered/pending이면 거부, 원래 completed가 없거나 abandoned면 resend kind를 한 번 생성합니다. 동일 resend kind의 재생성은 unique 제약으로 막습니다. 단 실제 발송 내용은 현재 화면의 답변이 아니라 최초 event snapshot입니다.

---

## 4) Merge 전 반드시 고칠 것 / 후속 가능

### Merge 전 반드시 고칠 것

1. resend preview와 실제 event payload를 동일 source로 만들고, 운영자가 실제 발송 문구를 확인하도록 할 것.
2. 실패 중인 resend server-contract 테스트의 fake claim을 production 동작과 맞출 것.
3. inline-vs-drain 경합 테스트를 추가해 F5를 실제로 고정할 것.
4. suppression 적용 범위를 feedback-only로 제한하거나, 모든 notification kind별 정책을 명시적으로 결정할 것.
5. manual/privacy_request의 운영 표시를 설계 주장대로 구별하거나 문서에서 구별 불가를 명시할 것.

### 후속으로 미뤄도 되는 것

- concurrent resend 중 claim을 잃은 요청의 200 응답과 중복 audit 정밀화.
- 내부 enum `delivered`를 `submitted/accepted`로 개명하는 작업. 현재 사용자 문구는 이미 정직합니다.
- 7개 locale의 문구는 의미상 서로 일치하며 merge blocker인 번역 오류는 찾지 못했습니다.
- bounded read 최적화 추가 작업. 현재 조회 범위는 최신 N + includeId로 제한되어 있습니다.