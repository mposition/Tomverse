# 고객 지원 답변이 조용히 사라지는 문제 — 원인과 설계 (2026-09-16)

상태: **v2 — Codex 설계 검토 round 0 `approve_with_changes`(blocker 2건) 반영**.
기준 commit: `origin/develop@705b65ad`. 검토 기록:
`.github/audits/support-reply-delivery-design-review-round0-2026-09-16.md`.
계기: 2026-09-15 운영자가 신고 1건을 해결 처리하며 답변을 적고 버튼을 눌렀으나
신고자가 메일을 받지 못했다.

## 1. 관측된 사실

운영자 화면(제공된 스크린샷)의 다이얼로그 상단에
"이 신고자는 이메일 알림을 받지 않습니다. 아무것도 발송하지 않고 상태만 바뀝니다"가
표시된 상태에서, 답변란에 글을 쓰고 "종료 상태로 변경"을 눌렀다.

코드 기준 사실:

- `isNotifiable = Boolean(email) && emailUpdatesConsent`
  (`components/admin/FeedbackInboxPanel.tsx:178`).
- 그 값이 false여도 **답변 textarea는 그대로 편집 가능**하고, 라벨은 여전히
  "신고자에게 보낼 답변(선택, 이메일에 포함)"이다(`:884`, 문구
  `lib/adminMessages/feedbackInbox.ts:102`). 10자 최소 길이 검사도 그대로 돈다.
- 확인 버튼 문구는 발송되는 경우와 **동일**하다(`:931`).
- 미리보기 상자만 사라진다(`:908`).
- 확인 시 답변은 조건 없이 전송된다(`:935`). 라우트는 이를 `Feedback.userReply`와
  lifecycle 이벤트에 저장한다(`app/api/admin/feedback/[feedbackId]/route.ts:133,158`).
- 큐 적재는 `stage && eventCreated && notifiable`일 때만 한다(`:181`).
- 토스트는 `not_notifiable`과 `no_stage`에 대해 **빈 문자열**을 돌려준다
  (`FeedbackInboxPanel.tsx:186`). 발송된 경우와 화면상 구분이 없다.

즉 결함은 "메일이 실패했다"가 아니라 **"보낼 계획이 없는데 보낼 것처럼 보였다"**이다.

## 2. 같은 경로의 부수 결함

| # | 결함 | 근거 |
|---|---|---|
| D1 | 동의가 없어도 `completed` lifecycle 이벤트가 생성된다. 나중에 주소·동의가 생겨 다시 해결 처리해도 `skipDuplicates` 때문에 `eventCreated=false` → **영구히 발송 불가**이며 응답은 "이미 안내함"이라고 답한다 | route `:149-165`, `:221` |
| D2 | 발송 실패·포기가 운영자에게 보이지 않는다. `/admin/email-delivery`는 standard lane의 `EmailDelivery`만 보여 주고 이 경로는 행을 만들지 않는다. `NotificationDelivery`를 읽는 admin 화면은 없다 | `lib/adminEmailDeliveries.ts`, grep 결과 |
| D3 | 게스트는 동의 체크를 해야만 주소 입력란이 나타난다(`components/chat/FeedbackButton.tsx:199`). 체크가 기본 해제이므로 대부분의 신고가 **답변 불가능한 상태**로 접수된다 | `:131`, `:199` |
| D4 | 신고 폼 어디에도 "체크하지 않으면 답변을 받지 못한다"는 문장이 없다 | `locales/*.ts` `feedback.emailUpdates*` |

## 3. 정책 판단

정책 `docs/policy/email-notifications.md` §3 분류 정의:

> **transactional**: 사용자가 시작한 특정 거래/요청에 대한 응답. 동의 불필요.

신고자 본인이 낸 신고에 대한 **처리 결과 답변**은 이 정의에 정확히 해당한다.
현재 구현은 정책이 요구하지 않는 동의를 요구하고 있었다. 접수·검토중 알림은
사용자가 시작한 요청에 대한 응답이 아니라 **중간 진행 통지**이므로 지금처럼 동의
기반으로 둔다.

운영자 결정(2026-09-16): **주소를 알고 있으면 처리 결과 답변은 보낸다.**
체크박스는 접수·검토중 알림만 좌우한다.

## 3a. round 0 발견 반영 (v2에서 바뀐 것)

| 발견 | v2 결정 |
|---|---|
| F1 (blocker) 이벤트 수정은 같은 idempotency key에 다른 본문을 붙임 | **이벤트는 절대 수정하지 않는다.** 애초에 복구가 필요한 상황이 거의 없다 — `Feedback.email`은 접수 이후 바뀌지 않으므로, 새 규칙에서 "보낼 수 없었다"는 곧 "주소가 없다"이고 나중에 주소가 생길 길이 없다. 이 변경 **이전에** 주소는 있으나 동의가 없어 닫힌 과거 건만 남는데, 이것은 운영자가 명시적으로 누르는 **"답변 다시 보내기"**로 처리한다. 그 동작은 기존 이벤트의 내용을 **그대로** 렌더하고, 별도 kind(`feedback_user_completed_resend`)로 큐에 넣는다. 이벤트는 불변이고 `(kind, referenceId)` unique가 1회를 보장한다 |
| F2 (blocker) 검증되지 않은 게스트 주소로 발송 확대 | **게스트 주소 수집 방식을 바꾸지 않는다.** §4.5의 "주소란 상시 노출"을 철회한다. 게스트는 지금처럼 연락을 원할 때만 주소를 남기므로, 그 주소는 "이 주소로 연락해 달라"는 본인의 요청이다. 로그인 계정 주소는 세션이 검증한다. 즉 이 변경으로 새로 메일을 받는 대상은 **로그인 계정으로 신고하고 체크박스를 켜지 않은 사람의 처리 결과 답변**뿐이다 |
| F3 suppression 판정 | 자체 조건문 대신 기존 `suppressionCheck({ classification: "transactional" })`를 쓴다. hard bounce·manual·privacy_request가 차단, complaint·unsubscribe는 통과라는 기존 판정을 그대로 따른다 |
| F4 `delivered` 과장 | 화면 문구를 "발송됨"이 아니라 "메일 제공자 접수됨"으로 적는다. 실제 도달은 이 모델이 알 수 없다 |
| F5 inline과 drain의 claim 불일치 | inline 첫 시도도 drain과 같은 조건부 claim을 거친다 |
| F6 미발송 사유 뭉개짐 | 렌더러가 구조화된 사유를 돌려준다: `no_address`, `contact_removed`, `suppressed(<reason>)`, `source_missing` |
| F7 bounded read | delivery 상태는 화면이 읽는 최신 N건과 `includeId` 경로에만 붙이고, 합계처럼 보이지 않게 한다 |

## 4. 설계

### 4.1 단계별 수신 규칙 (순수 함수)

`lib/feedbackLifecycleCore.ts`에 추가:

```
FEEDBACK_STAGE_CONSENT = { received: "consent", reviewing: "consent", completed: "transactional" }
feedbackStageRecipient({ stage, email, emailUpdatesConsent })
  -> { canSend: true } | { canSend: false, reason: "no_address" | "not_consented" }
```

- `completed`: 주소가 있으면 발송. 없으면 `no_address`.
- `received`·`reviewing`: 주소 + 동의. 동의가 없으면 `not_consented`.
- 서버 라우트, 큐 렌더러, Admin 화면이 **같은 함수**를 쓴다. 지금 세 곳이 각자
  `email && consent`를 쓰고 있고, 그 중복이 이 사고의 조건이었다.

### 4.2 라우트 (`app/api/admin/feedback/[feedbackId]/route.ts`)

- 큐 적재 조건: `stage && eventCreated && canSend` (지금과 같은 모양, `canSend`만 단계별 규칙으로 바뀐다). **이벤트는 만들지도 고치지도 않는 채로 둔다.**
- **D1**: 새 규칙에서는 `completed`를 보낼 수 없는 유일한 이유가 "주소 없음"이고,
  `Feedback.email`은 접수 후 바뀌지 않으므로 나중에 보낼 수 있게 되는 일이 없다.
  따라서 자동 복구는 두지 않는다. 이 변경 이전에 닫힌 과거 건만 §4.4의
  "답변 다시 보내기"로 처리한다.
- 응답 `userNotification.reason`을 `not_notifiable` 하나에서
  `no_address` / `not_consented`로 나눈다. 화면이 이유를 말할 수 있어야 한다.

### 4.3 큐 렌더러 (`lib/notificationDeliveries.ts`)

- `feedback_user_completed`: 주소만 있으면 렌더한다(동의 검사 제거).
- `feedback_user_received|reviewing`: 지금처럼 동의 필요.
- 발송 직전 기존 `suppressionCheck({ classification: "transactional" })`로 판정한다
  (hard bounce·manual·privacy_request는 차단, complaint·unsubscribe는 통과 —
  `lib/emailSuppressionCore.ts`의 기존 표를 그대로 쓴다). 차단이면 사유를 담아
  `unsendable`로 끝낸다.
- 미발송 사유를 구조화한다: `no_address`, `contact_removed`(주소가 지워짐),
  `suppressed:<reason>`, `source_missing`. 지금은 전부 `source_missing`이다.
- **`feedback_user_completed_resend`**: 과거에 답변을 저장했지만 발송된 적이 없는
  건을 운영자가 한 번 다시 보낼 수 있는 kind. 렌더는 **기존 lifecycle 이벤트의
  내용 그대로**이며(불변), `(kind, referenceId)` unique가 1회를 보장한다.

### 4.4 Admin 화면

- **다이얼로그**: 이 신고에 대해 무엇이 일어나는지 한 줄로 단언한다.
  - 보낼 수 있으면: "확인을 누르면 이 답변이 `<주소>`로 발송됩니다" + 미리보기.
  - 주소가 없으면: 답변란 라벨을 "내부 기록(발송되지 않음)"으로 바꾸고, 미리보기
    자리에 이유를 적으며, 버튼 문구를 "발송 없이 해결됨으로 표시"로 바꾼다.
  - 이미 안내된 건이면 지금처럼 그 사실을 말한다.
- **토스트**: 모든 경우에 이메일 결과를 말한다. `no_address`·`not_consented`·
  `already_notified`에 각각 문장을 둔다(현재는 빈 문자열).
- **D2 해소**: 수신함 행에 답변 메일 상태를 표시한다. `loadFeedbackRows`가 화면이
  읽는 최신 N건(그리고 `includeId`로 끌어온 1건)에 대해서만
  `NotificationDelivery`(kind `feedback_user_*`)를 함께 읽는다. 표시는
  **"메일 제공자 접수됨"**·"재시도 중(n회)"·"포기됨(사유)"·"미발송(사유)"이며,
  받은편지함 도달을 주장하지 않는다. 합계처럼 보이지 않게 한다.
- **답변 다시 보내기**: 완료 이벤트가 있고 주소가 있는데 발송 기록이 없으면
  버튼을 보여 준다. 누르면 저장된 답변 그대로 한 번 큐에 넣는다. 보낼 내용이
  화면에 먼저 보이고, 수정하려면 메일 앱 경로를 쓴다.

### 4.5 신고 폼

- 체크박스 의미가 바뀌므로 문구를 7개 locale에서 고친다: 체크는 "접수·검토 중
  알림"을 뜻하고, **로그인 계정은 처리 결과 답변을 계정 주소로 받는다**는 사실을
  명시한다.
- **게스트 주소 수집 방식은 바꾸지 않는다**(round 0 F2). 게스트는 지금처럼
  연락을 원할 때만 주소를 남기고, 그 주소가 곧 "여기로 답해 달라"는 요청이다.
  게스트가 주소를 남기지 않으면 답변을 받을 수 없다는 사실만 문구로 밝힌다.
- 공개 `/support` 페이지의 인라인 문구도 같은 의미로 맞춘다.

### 4.6 문서

- `docs/policy/email-notifications.md`: §3 분류에 따른 명확화로 개정 이력에 기록.
  "피드백 처리 결과 답변 = transactional(동의 불필요), 접수·검토중 = 동의 기반".
- `AGENTS.md` 이메일 절에 한 줄 추가.

## 5. 되돌릴 수 없는 것

- **나간 메일은 회수 불가**다. 그래서 이 변경으로 새로 발송되는 대상은 "자기
  신고에 대한 처리 결과" 하나뿐이고, 접수·검토중은 그대로 동의 기반으로 둔다.
  하드 바운스 억제 주소에는 보내지 않는다.
- 나머지(문구, 화면 표시, 이유 구분)는 고쳐서 배포하면 끝난다.

## 6. 이 변경으로 새로 메일을 받는 사람

**로그인 계정으로 신고했고, 체크박스를 켜지 않았으며, 주소가 남아 있고,
suppression 대상이 아닌 사람의 "처리 결과 답변" 한 통**뿐이다. 게스트의 수집
경로, 접수·검토중 알림, marketing은 모두 그대로다.

## 7. 이전 검토 요청 사항 (round 0에서 답을 받음)

1. `completed`를 transactional로 보는 §3 근거가 충분한가. 계정 삭제로 주소가
   비워진 경우, 게스트가 남긴 주소, 로그인 계정 주소 각각에 대해 문제가 없는가.
2. D1 해소 방식(미발송 이벤트의 내용 갱신)이 "이벤트는 불변 스냅샷" 계약을
   깨지 않는가. 더 안전한 대안이 있는가.
3. suppression 확인을 이 경로에 넣는 것이 다른 계약(§13.3 transactional은 하드
   바운스에서만 차단)과 맞는가.
4. 게스트 주소 입력란 상시 노출이 개인정보 최소수집 원칙과 충돌하는가.
