# 채팅 피드백 모달 개선 (2026-08-01)

Tomverse Insight 채팅의 "피드백 보내기" 모달과 `/api/feedback` 제출 경로를
점검하고 고친 기록입니다. **최소 5자 정책은 제품 결정으로 확정된 값이며 이번
작업에서 변경하지 않았습니다.** 아래 1항이 그 근거이고, 2항이 정책이 그대로
남아 있다는 증거입니다.

## 1. 기존 버튼 비활성화 조건

변경 전 `components/chat/FeedbackButton.tsx`:

```ts
const canSubmit = isErrorReport
  ? !isSending
  : message.trim().length >= 5 && !isSending;
```

즉 일반 피드백은 **`trim()` 후 5자 이상 + 전송 중 아님**일 때만 활성화됐고,
오류 신고 모드는 전송 중이 아니면 항상 활성화됐습니다. 사용자에게는 버튼
비활성화 외에 아무 설명도 없었습니다.

## 2. 최소 5자 정책 유지 근거

- 서버 스키마는 손대지 않았습니다: `app/api/feedback/route.ts`의
  `message: z.string().trim().min(5).max(2_000)` 그대로.
- 클라이언트 판정은 `lib/feedbackPolicy.ts` 한 곳으로 모았고 상수는
  `FEEDBACK_MESSAGE_MIN_LENGTH = 5`, `FEEDBACK_MESSAGE_MAX_LENGTH = 2_000`
  입니다. 판정 기준은 서버와 동일하게 `trim()` 후 길이입니다.
- `tests/feedbackPolicy.test.mjs`는 상수 값 자체를 검증하고, 라우트 소스에서
  `trim().min(5).max(2_000)` 패턴이 사라지면 실패합니다.
- `tests/server-contract/feedback-route.test.ts`는 4자, 공백 포함 4자, 공백만,
  2,001자를 모두 400으로 확인합니다.

## 3. 추가된 사용자 안내

textarea 아래에 항상 표시되는 `role="status"` 안내 문구와 글자 수 표시를
넣었습니다.

| 상태 | 문구 |
|---|---|
| 입력 전 | "피드백을 5자 이상 입력해 주세요." |
| 1~4자 | "전송하려면 N자를 더 입력해 주세요." |
| 5자 이상 | "이제 전송할 수 있습니다." |
| 상한 초과 | "피드백은 최대 2,000자까지 입력할 수 있습니다." |
| 항상 | "현재 글자 수 / 2,000자" |

- 공백만 입력하면 0자로 계산합니다(클라이언트·서버 모두 `trim` 기준).
- 안내와 글자 수는 textarea의 `aria-describedby`이자 전송 버튼의
  `aria-describedby`입니다. 색이 아니라 문장 자체가 상태를 전달합니다.
- placeholder에는 5자 조건을 넣지 않았습니다. 규칙은 항상 보이는 문구에만
  있습니다.
- 7개 locale(`ko`, `en`, `zh`, `fr`, `de`, `es`, `pt`) 전부에 문구를
  추가했고, key 누락은 unit test로 막습니다.

## 4. 게스트 Turnstile 흐름

`/api/feedback`는 비로그인 호출자마다 `ensureGuestVerified()`를 실행하는데,
채팅 모달은 token을 요청하지도 전송하지도 않았습니다. 게스트 피드백은 사실상
전달되지 않는 상태였습니다.

- 게스트일 때만 `useTurnstile(isGuest && open, "support_request", siteKey)`로
  검증합니다. action은 SupportPageContent와 같은 `support_request`이므로
  서버 계약은 그대로입니다.
- 로그인 사용자는 token을 요청하지 않습니다.
- 유효한 grant cookie가 있으면 서버가 challenge를 건너뜁니다(기존 동작).
- widget container는 모달 안에 있고, challenge가 필요할 때만 화면 자리를
  차지합니다. 닫힌 상태는 `display: none`이 아니라 화면 밖 1px 컨테이너입니다
  — `display: none`에서는 Cloudflare가 challenge를 띄울 수 없습니다.
  같은 이유로 SupportPageContent의 `className="hidden"` container도 고쳤습니다.
- 실패는 `cancelled`/`expired`/`timeout`/`unavailable`/`failed`로 구분해
  현지화 문구를 보여줍니다. 매핑은 `guestVerificationCopy.ts` 한 곳입니다.
- token은 상태·toast·오류 문구·로그 어디에도 넣지 않습니다.
- 사이트 key는 채팅 페이지가 요청 시점에 확인한 값을
  `GuestVerificationProvider` context로 공유합니다. `NEXT_PUBLIC_*`는 빌드
  시점에 인라인되므로, 배포 시점에 주입되는 값은 이 경로로만 도달합니다.

## 5. 제출·중복 요청·오류 처리

- 실제 `<form onSubmit>` + `type="submit"` 구조입니다. textarea의 Enter는
  줄바꿈이며 제출하지 않습니다(Shift 여부 무관).
- 동기 `useRef` 가드로 중복 제출을 막습니다. 연속 클릭·Enter를 섞어도 요청은
  한 번입니다.
- 전송 중에는 `<fieldset disabled>`로 유형 선택·textarea·Trace ID·진단 복사가
  한꺼번에 잠깁니다.
- 오류는 status/code에서 닫힌 집합으로 분류합니다: 400 `invalid`,
  401·403·`TURNSTILE_*` `verification`, 413 `tooLarge`, 429 `rateLimited`,
  5xx `server`, fetch 실패 `network`, 나머지 `unknown`. 응답 본문의 임의
  문자열은 절대 문구가 되지 않습니다.
- `unknown`/`server`에는 참조 번호를 함께 보여주고, 같은 값을 구조화 client
  로그에 남깁니다.
- 실패하면 모달과 작성 내용이 그대로 남고 같은 초안을 다시 보낼 수 있습니다.
  성공했을 때만 초기화하고 닫습니다.
- 요청은 30초 후 abort되므로 모달이 영구히 잠기지 않습니다.

## 6. 성공 확인과 알림 이메일 분리

- API가 `feedbackId`와 8자 `reference`를 반환합니다(DB 스키마 변경 없음,
  `Feedback.id`에서 파생).
- 성공 toast: "피드백이 접수되었습니다. 접수 번호 XXXXXXXX".
- DB 저장 성공 후 알림 이메일 실패는 200을 유지합니다. 두 결과는 응답이 아니라
  로그(`support_notification_failed`, `notificationDelivered:false`)로
  구분합니다.

## 7. Trace ID

선택 입력 그대로입니다. localStorage 자동 입력은 비어 있을 때만 하고 사용자가
고친 값을 덮어쓰지 않습니다. 형식이 명백히 이상하면 안내만 띄우고 제출은
막지 않으며, 메시지의 5자 조건과 무관합니다.

## 8. 오류 신고 모드

추가 설명 없이도 제출할 수 있습니다. 서버 계약을 우회하지 않고
`feedback.errorReportDefaultMessage`(모든 locale에서 5자 이상)를 본문으로
씁니다. 1~4자만 쓴 경우에는 기본 문구로 갈아치우지 않고 남은 글자 수를
안내합니다.

원본 오류 상세는 전송 전에 `sanitizeFeedbackDiagnostics()`로
authorization·cookie·API key·JWT·Stripe/Slack/GitHub/AWS key 패턴을 가립니다.
합친 본문은 2,000자 안에서 사용자가 쓴 문장을 먼저 보존하고 진단 부분만
잘라냅니다 — 예전에는 긴 provider 오류가 붙으면 전체가 400으로 거절됐습니다.

## 9. 접근성

`role="dialog"` + `aria-modal="true"`, 제목·설명 연결, 열면 textarea로 focus
이동, focus trap, Escape 닫기(뒤의 drawer까지 함께 닫히지 않도록 capture 단계
에서 전파 차단), 닫은 뒤 트리거로 focus 복귀, 현지화된 닫기 accessible name,
배경 스크롤 차단, safe-area 패딩과 `max-h-[calc(100dvh-…)]` 스크롤, 200% 텍스트
확대에서 잘림 없음 — 모두 E2E로 검증합니다.

## 10. 관측 가능성

`user_feedback` 구조화 로그: `feedbackId`, `subject`(user/guest), `userId`,
`type`, `status`, `turnstile`(not_required/existing_grant/verified),
`notificationDelivered`, `hasTraceId`, `hasModelId`, `hasAttachments`,
`attachmentCount`, `at`.

로그에 남기지 않는 것: 메시지 원문, rawErrorDetails 원문, Trace ID 값,
Turnstile token, session cookie, user agent. 500 경로도 error name과 code만
남깁니다(Prisma 오류 메시지는 파라미터를 포함할 수 있습니다).
server-contract test가 이 누출을 직접 검사합니다.
