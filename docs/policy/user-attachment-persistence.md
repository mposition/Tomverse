# 사용자 입력 첨부파일 영속화 정책

승인일: 2026-08-22. 이 문서는 **사용자가 보낸 파일**의 단일 기준이다. 무엇을
저장하고, 무엇을 클라이언트에 말하고, 어떤 id로 참조하고, 언제 지우는지를 모두
여기서 정한다. 코드의 출처는 `lib/messageAttachmentCore.ts`(순수)와
`lib/messageAttachmentStorage.ts`(server-only)이며, 이 계약을 어기는 변경은
릴리스 차단 사유다.

**이 기능은 "AI 생성 파일"과 다른 기능이다.** `docs/policy/generated-artifacts.md`
는 답변이 *만들어 낸* 파일을 다루고, 이 문서는 사람이 *보낸* 파일을 다룬다.
방향도, 권한도, 수명주기도 공유하지 않는다 — 생성 파일은 다운로드 대상이고,
입력 첨부는 이후 turn의 prompt를 만들기 위해 서버가 다시 읽는 대상이다.

## 1. 문제

첨부파일은 브라우저 메모리에만 존재했다. 업로드되고, 그 요청이 한 번 읽고,
새로고침하면 사라졌다. 그 결과 세 가지가 동시에 참이었다.

- **카드가 사라진다.** 대화를 다시 열면 첨부 카드가 없다.
- **파일명이 메시지가 된다.** 첨부만 있는 turn은 저장 시점에
  `content: trimmed || attachments.map((item) => item.name).join(", ")` 로
  기록됐다. `pre-save` schema가 `content`에 최소 1자를 요구했기 때문이다.
  그래서 그 메시지는 파일을 *가진* 것이 아니라 파일 이름"인" 것이 됐다.
- **이후 turn이 과거 파일을 못 읽는다.** 다음 요청의 transcript에 objectKey가
  없으므로 모델이 다시 참조할 방법이 없다.

세 번째가 가장 조용하다. 사용자는 "아까 그 계약서에서…"라고 묻고, 모델은 파일을
본 적이 없는 상태로 그럴듯하게 답한다.

## 2. 절대 규칙 — 클라이언트는 저장 위치를 말하지 않는다

**요청 본문의 storage key는 주장(claim)이고, 서버가 쓴 행은 사실(fact)이다.**

- 업로드 완료(`PATCH /api/chat`)는 **불투명한 upload id**를 발급하고 key는
  돌려주지 않는다.
- 이후 모든 참조는 `uploadId`(아직 메시지에 결속되지 않은 업로드) 또는
  `attachmentId`(이미 저장된 메시지의 `MessageAttachment`)다.
- `messageAttachmentReferenceSchema`는 `.strict()`이므로 `objectKey`·`data`·
  `bytes`·`path`가 실린 참조는 **파싱 단계에서 거절**된다.
- 두 조회 모두 `userId`를 **`where` 안에** 넣는다. 남의 id는 "거절"이 아니라
  "없음"이고, 차이를 보고할 분기 자체가 존재하지 않는다.
- 해석된 key가 호출자의 prefix(`accountAttachmentPrefix(email)`) 밖이면 거절
  한다. 구성상 도달할 수 없지만, 언젠가 다른 곳에서 key를 받게 될 때 남는 선이다.

**게스트는 예외이며, 그 예외가 규칙을 설명한다.** 게스트는 행을 걸 계정이
없으므로 id를 발급할 수 없다. 대신 key 자체가 게스트의 서명된 신원에서
유도되므로 key가 곧 권한이다(`isOwnGuestAttachmentKey`). 게스트 경로는 이
변경으로 바뀌지 않는다.

## 3. 데이터 모델

`MessageAttachment` — id, messageId, conversationId, userId, ordinal, name,
mediaType, size, kind, objectKey, uploadId, createdAt.

- `(messageId, ordinal)` unique — **멱등성 키**다. 재전송된 pre-save(재시도된
  fetch, 이중 제출)가 같은 쌍을 쓰므로 같은 파일의 카드가 두 개 생기지 않는다.
- `objectKey` unique — 한 객체는 한 행의 것이다. 두 메시지가 같은 객체를 주장
  하면 삭제가 모호해진다.
- `userId`·`conversationId`는 `message`를 거치지 않고 직접 들고 있다. 모든
  해석이 소유권 검사이고, 먼저 join해야 하는 검사는 403이 되어야 할 것을 500으로
  만든다.
- `kind`는 **서버가** 정한다. 업로드 완료 단계가
  `resolveChatAttachmentFormat()`으로 형식을 판정하고
  `attachmentKindForFormat()`이 그 판정에서 읽어 낸다
  (`lib/chatAttachmentFormats.ts`). 요청이 `.docx`를 "text"라고 불러도
  읽는 방식은 바뀌지 않는다.
- **`mediaType`만 보고 다시 유도하지 않는다.** 형식표는 이름을 먼저
  읽고 media type을 힌트로만 쓰므로, 확장자로 자리가 정해지는 형식에서
  두 번째 유도는 첫 번째와 어긋난다.
- `size`는 업로드 완료 시점에 **저장소가 보고한 값**이다. 선언값이 아니다.

`MessageAttachmentUpload` — 아직 메시지에 결속되지 않은 완료된 업로드.

- 결속 후에도 **소멸하지 않는다.** 같은 초안을 두 번 보낼 수 있고, 실패한 전송은
  같은 composer 상태로 재시도된다. 멱등성은 이 행이 아니라
  `(messageId, ordinal)`이 담당한다.

`MessageAttachmentCleanup` — DB-first 삭제 tombstone. `MessageArtifactCleanup`과
같은 모양이고 같은 이유다.

## 4. API 계약

| 단계 | 요청 | 응답 |
|---|---|---|
| 업로드 준비 | `PUT /api/chat` | `{ key, uploadUrl, uploadHeaders }` — 브라우저가 R2에 직접 PUT하기 위한 presigned URL. 여기서만 key가 보인다. |
| 업로드 완료 | `PATCH /api/chat` `{ key, name, mediaType, size }` | `{ uploadId, name, mediaType, size, kind }` — **key 없음** |
| Drive 가져오기 | `PUT /api/chat` `{action:"google-drive-import", ...}` | `{ uploadId, name, mediaType, size, kind }` — **key 없음** |
| 초안에서 제거 | `DELETE /api/chat` `{ uploadId }` | 204, 또는 이미 전송된 파일이면 `{ kept: true }` |
| 메시지 pre-save | `POST /api/conversations/{id}/messages` `{ messages:[{ id, content, attachmentUploadIds }] }` | `{ success, created, attachments:[{messageId, id, ordinal, name, mediaType, size, kind}] }` |
| 대화 조회 | `GET /api/conversations/{id}` | 각 메시지에 `attachments: [{id, attachmentId, ordinal, name, mediaType, size, kind}]`, 누락된 파일에는 `unavailableAt`·`unavailableReason`(§11) — 없으면 **키 자체가 없다** |
| 채팅 | `POST /api/chat` | 각 첨부는 `{attachmentId}` 또는 `{uploadId}`. 선택적으로 `acknowledgedUnavailableAttachmentIds`(§11.4) |

- **`content`는 비어 있을 수 있다.** pre-save schema는
  `content.length > 0 || attachmentUploadIds.length > 0`을 요구한다. 첨부만 있는
  메시지는 완전한 메시지이며, 파일명 문자열로 대체하지 않는다.
- **pre-save 응답은 echo가 아니라 read-back이다.** 이미 존재하던 행도 id를
  돌려줘야 재전송이 카드를 잃지 않는다.
- **`attachmentId`는 `id`를 요청이 쓰는 이름으로 한 번 더 보낸 것이다.** 카드는
  `id`로 key를 잡고, 다음 turn은 `attachmentId`로 파일을 지목한다. 한 필드를 두 번
  보내는 것이 클라이언트가 "둘은 같은 것"이라는 지식을 갖지 않게 하는 방법이다 —
  그 지식은 누군가 옮기기 전까지만 한 곳에 있다.
- **저장은 한 트랜잭션이다.** 메시지 행과 첨부 행이 함께 commit된다. 저장된 turn이
  나열할 수 없는 파일 수를 보여 주는 상태는 존재하지 않는다.

## 5. 무엇이 브라우저에 가지 않는가

`objectKey`, 첨부 바이트, data URL, 추출된 본문, 업로드된 아카이브 내부 경로,
서명 URL은 **어떤 경로로도** 클라이언트에 가지 않는다.

- 근거는 select이지 필터가 아니다. `PUBLIC_MESSAGE_ATTACHMENT_SELECT`는
  8개 필드(id, ordinal, name, mediaType, size, kind, unavailableAt,
  unavailableReason)만 이름 대며 — 뒤의 둘은 §11의 *판정*이고 위치가 아니다 —
  `include: { attachments: true }`는 쓰지 않는다 — include는 `objectKey`까지
  보낸다.
- 타입 `PublicMessageAttachment`에 `objectKey`가 **없으므로** spread가 생겨도
  새 필드가 새 응답 필드가 되지 않는다. 변환은 필드별이고 spread가 아니다.
- **입력 첨부에는 다운로드 route가 없다.** 생성 파일과 달리 사용자는 원본을 이미
  갖고 있고, route가 없다는 것은 서명 URL도, 그것을 만들 코드도 없다는 뜻이다.
- 서명 URL은 DB에 저장하지 않는다(애초에 만들지 않는다).

## 6. 모델이 보는 것 — turn handle

같은 turn에 첨부된 파일을 모델이 지목할 수 있어야 한다(§13의 template batch).
그러나 row id도 storage key도 모델에게 주지 않는다. 모델이 손에 쥔 것은 답변에
인용될 수 있기 때문이다.

그래서 **요청 범위의 handle**을 쓴다 — `att_1`, `att_2`. 요청마다 새로 만들고,
요청 밖에서는 아무 의미가 없으며, 어떤 route도 가리키지 않는다. 매핑은 서버
메모리에만 있고, 해석·소유권 검사가 끝난 뒤에 만들어진다.

## 7. 수명주기

R2 쓰기와 DB 쓰기는 한 트랜잭션이 아니다. 그래서 `generated-artifacts.md` §8과
같은 결정을 한다 — **객체 먼저, 행 나중. 삭제는 행 먼저, tombstone, 객체 나중.**

- **삭제되는 것**: 대화 삭제, 대화 일괄 삭제, 계정 삭제. 셋 다 같은 트랜잭션에서
  `MessageAttachmentCleanup`을 남긴다.
- **삭제되지 않는 것**: **한 모델의 assistant history 초기화.** 첨부는 비교의 세
  패널이 공유하는 *질문*에 속하고, 한 모델의 답변을 지우는 것은 질문을 지우는
  것이 아니다. `enqueueMessageAttachmentCleanupForMessages`는 기본 role을 갖지
  않는다 — 호출자가 무엇을 지우는지 말해야 한다.
- **계정 삭제는 보내지 않은 업로드까지 수거한다.** 어떤 대화도 그것을 이름 대지
  않으므로, 대화 모양의 sweep은 영원히 도달하지 못한다.
- **drain**: 15분 유지보수 cron이 queue를 비운다. DeleteObject는 이미 없는 key
  에도 성공하므로 겹친 sweep 둘이 같은 행에서 만나도 둘 다 "객체 없음, 행 완료"로
  수렴한다 — claim이 필요 없다.
- **재시도 한도는 5회**다. 넘긴 행은 `exhausted`로 보고하고 사람에게 남긴다.
  영원히 재시도하는 queue는 queue가 아니다.
- **모든 실패는 구조화 이벤트다** — `message_attachment_cleanup_failed`
  (cleanupId, reason, attempts, exhausted, error), `..._swept`(examined,
  deleted, failed, exhausted). 실패를 볼 수 없는 정리 queue는 조용히 정리 queue이길
  그만둔다.
- sweep은 절대 throw하지 않는다. 저장소 장애가 유지보수 run 전체를 실패시키면
  안 된다.

## 8. 재시도

- **재시도는 영속화된 첨부를 계속 쓴다.** composer가 들고 있는 참조가 그대로
  다시 실리고, 서버가 다시 해석한다.
- **"파일 없이 재시도"는 그 재시도에서만 참조를 뺀다.** 원본
  `MessageAttachment`는 손대지 않는다 — 저장된 turn은 자신이 보내진 그대로다.
  §11.4의 "파일 없이 계속하기"도 같은 규칙이며, 다른 점은 참조를 빼는 것이
  아니라 **서버에 특정 id를 승인해 보내고 prompt에 "읽지 못했다"는 표식이
  들어간다**는 것이다.
- **composer의 제거 버튼은 초안을 편집하는 것이다.** 이미 결속된 첨부는
  `discardUnboundUpload()`가 `kept: true`로 보고하고 객체를 지우지 않는다.

## 9. 게스트

게스트 대화의 기존 동작은 바뀌지 않는다. localStorage snapshot, 서명된 key,
TTL sweep, `/api/chat/guest-attachment`의 `{ key }` 삭제 계약이 모두 그대로다.
로그인 시 guest localStorage를 지우지 않는다는 §chat-concurrency 규칙도 그대로다.

## 10. 아직 하지 않은 것

- 대화 밖에서 자기 첨부를 다시 찾는 목록 화면.
- 첨부 원본 다운로드 route. 사용자는 원본을 갖고 있고, route가 없다는 것이
  §5의 보증을 구조적으로 만든다.
- 보내지 않은 업로드의 TTL sweep. 초안은 오래 살 수 있고, 임의의 기한을 정하면
  오래된 초안이 조용히 깨진다. 계정 삭제가 이 객체들을 수거하므로 영구 누수는
  아니지만, 활성 계정의 미사용 업로드는 현재 남는다 — 알려진 한계로 적어 둔다.
- 공유 대화 스냅샷과 대화 TXT 내보내기에는 첨부가 포함되지 않는다.

## 11. 객체가 사라졌을 때 — 가용성 계약

개정일: 2026-08-28. §7의 수명주기가 **애플리케이션의 삭제 경로만** 다뤘기
때문에 생긴 공백을 메운다.

### 11.1 무엇이 일어났는가

production release `16d98af8`, 대화 `cmtaqxy0g000202mncs315nym`. 로그인
사용자의 JPEG 첨부 2개 중 첫 번째의 R2 객체가 사라졌다. `MessageAttachment`
행은 남아 있었고, `MessageAttachmentCleanup` tombstone은 **없었으며**,
`MessageAttachmentUpload.boundAt`은 정상이었다. 즉 §7의 삭제 경로 중 어느
것도 이 객체를 지우지 않았다. 객체는 생성 약 26시간 뒤에 사라졌고 22시간 된
두 번째 객체는 남아 있었다 — **시간 기반 bucket lifecycle 규칙**의 서명이다.

증상은 저장소 오류로 나타나지 않았다. 이후 모든 turn이 그 파일을 다시 읽었고,
`HeadObject`가 `NotFound`를 던졌고, 그 오류가 route 최상위 catch까지 올라갔다.
그 시점에는 `dispatchProviderForLog`가 이미 설정돼 있었으므로 route는
`AI_REQUEST_FAILED.NotFound`를 만들어 **provider health에 기록**했다.

- trace `a4af8faf` — openai / gpt-5-4-mini
- trace `b0b63db3` — anthropic / claude-sonnet-5

서로 다른 두 provider가 자기와 무관한 장애로 기록됐고, 사용자는 "어떤 모델로
바꿔도 안 된다"를 경험했다. 네트워크 이쪽에서 난 오류였으니 당연했다.

**교훈은 좁고 기계적이다: 오류의 계층은 발생 지점에서 정해야 하며, catch 지점
에서 추론할 수 없다.** stack이 최상위 catch까지 풀리고 나면 scope에 남은 것은
"모든 경우에 scope에 있던 것"뿐이고, provider 이름이 scope에 있다는 사실은
provider가 호출됐다는 증거가 아니다.

### 11.2 보존 계약 (이것이 기준이다)

- **로그인 사용자의 입력 첨부파일은 대화 또는 계정이 삭제될 때까지 유지한다.**
  §7의 세 경로(대화 삭제, 대화 일괄 삭제, 계정 삭제)가 삭제의 전부다.
- **게스트 첨부파일만 임시 보존·TTL을 따른다.** 그 sweep은 애플리케이션 코드
  (`listExpiredR2Objects`)이지 bucket 규칙이 아니다.
- **DB가 참조하는 객체 prefix에 시간 기반 삭제 규칙을 두지 않는다.** 보호
  대상은 `attachments/`, `message-artifacts/`, `images/`,
  `assistant-knowledge/`이며 `scripts/check-r2-lifecycle-policy-core.mjs`의
  `PROTECTED_OBJECT_PREFIXES`가 목록이다. `npm run check:r2-lifecycle-policy`가
  live bucket을 읽어 fail-closed로 판정하고, `tests/r2LifecyclePolicy.test.mjs`
  가 빈 prefix·상위 prefix 탐지를 고정한다.
- 사용자에게 보이는 보존 문구는 이 계약과 **한 문장으로** 일치해야 한다.
  `locales/*.ts`의 `dataRetentionDescription`·`attachmentRetentionNotice`,
  개인정보 문구, `components/marketing/searchIntentContent.ts`가 대상이며
  `tests/messageAttachmentAvailability.test.mjs`가 "약 하루" 계열 문구의
  재등장을 막는다.

### 11.3 누락은 확정된 404로만 기록한다

`MessageAttachment`에 nullable 컬럼 셋을 추가했다(expand migration
`20260828090000_message_attachment_availability`).

| 컬럼 | 뜻 |
|---|---|
| `unavailableAt` | 저장소가 **404로 확정**한 시각 |
| `unavailableReason` | `MESSAGE_ATTACHMENT_UNAVAILABLE_REASONS`의 값 |
| `availabilityCheckedAt` | 답이 무엇이든 **확인한** 시각 |

- **403·5xx·timeout은 기록하지 않는다.** 셋 다 "모른다"는 뜻이고, 그것을
  404로 적으면 5분짜리 자격증명 장애가 "이 계정은 파일을 전부 잃었다"는 영구
  기록이 된다. 판정은 `classifyStorageError()`(`lib/storageObjectErrors.ts`)
  하나가 한다.
- **먼저 쓴 값이 이긴다.** `unavailableAt`은 NULL인 행에만 쓰므로 timestamp는
  *발견 시점*을 계속 말한다. 재확인은 `availabilityCheckedAt`이 받는다.
- **행도 메시지도 지우지 않는다.** 카드·파일명·크기가 남는 것이 요점이다.
  어떤 파일을 잃었는지 볼 수 없는 사람은 그 파일을 다시 첨부할 수 없다.
- **객체가 "돌아와도" 컬럼을 되돌리지 않는다.** key는 한 번 쓰이고 다시 쓰이지
  않으므로, 돌아온 객체는 사람이 볼 사실이지 코드가 조용히 뒤집을 값이 아니다.

### 11.4 요청은 fail-closed다

- 누락이 확인되면 `ATTACHMENT_UNAVAILABLE` / **410**으로 거절한다. 응답은
  attachment id, 표시용 파일명, trace id, scope(`current_turn` ·`past_turn`),
  `canContinueWithout`만 싣는다. objectKey·bucket·endpoint·서명 URL은 어떤
  경로로도 나가지 않는다(§5).
- 거절은 **가격 산정·크레딧 예약·provider 호출보다 앞**에서 일어난다. 누락된
  파일은 크레딧 0, provider 요청 0, health 변화 0이어야 한다.
- **한 번의 거절이 누락된 파일 전부를 이름 댄다.** 파일마다 왕복하면 같은
  lifecycle 규칙이 지운 두 파일이 서로 다른 두 사고처럼 보인다.
- **조용히 빼고 모델을 부르지 않는다.** 사용자가 명시적으로 `acknowledged
  UnavailableAttachmentIds`에 그 id를 담아 보낸 요청에서만 제외하며, 그때도
  prompt에 `unavailableAttachmentMarker()`가 만든 "이 파일은 읽지 못했고 내용을
  모른다" 블록을 넣는다. 승인은 **id 단위**이며 boolean이 아니다 — boolean은
  아직 보여 준 적 없는 파일까지 한 번에 승인한다.
- 승인은 삭제가 아니다. 행·메시지·카드는 그대로다(§8과 같은 규칙).
- 저장소가 답하지 못한 경우는 `ATTACHMENT_STORAGE_UNAVAILABLE` / **503**이며
  재시도가 옳은 조언이다. 두 코드는 조언이 반대이므로 절대 합치지 않는다.
- 게스트의 `GUEST_ATTACHMENT_EXPIRED` 계약은 그대로다(§9).

### 11.5 계층이 있는 오류

`lib/chatFailureLayer.ts`가 `validation` · `storage` · `application` ·
`provider_request` · `provider_stream`을 정의하고, 뒤의 둘만 provider health
증거다.

- 준비 단계의 실패는 `ChatLocalFailure`로 **타입이 말한다.** 진단 코드 root는
  `CHAT_STORAGE_FAILED` 등이며 `PROVIDER_CALL_DIAGNOSTIC_ROOTS`에 절대 넣지
  않는다 — 그래서 `classifyProviderFailure()`가 `LOCAL_REJECTION`/scope `none`
  으로 판정한다.
- provider 호출은 `beginProviderCall()` 안에서만 일어나고, 그 wrapper만
  `ProviderCallRecord`를 만들 수 있다. **boolean이 아니라 객체인 이유**는
  boolean은 세팅을 잊을 수 있고 그 부재가 false와 구별되지 않기 때문이다.
  최상위 catch는 "이 record가 있는가"라는 구조적 질문만 한다.
- `RoutingAttempt.failureLayer`에 `storage`·`application`을 추가했다
  (`20260828093000_routing_attempt_local_failure_layers`). 둘 다 fallback
  대상이 아니다 — 다른 모델도 같은 파일을 읽지 못한다.
- `TraceErrorEvidence`에 `failureLayer`·`storageStatus`를 추가했다. 신고된
  trace를 읽는 사람이 provider 404와 storage 404를 구분할 수 있어야 한다.

### 11.6 감사와 복구

- `npm run audit:message-attachments`가 read-only로 전수 조사한다. keyset
  cursor로 재개 가능하고, 동시성은 낮으며, 결과를 `available` ·`missing` ·
  `temporarily_unreachable` ·`metadata_mismatch`로 나눈다. 보고 행은 allowlist
  (`auditRow`)이며 objectKey·파일명·본문·이메일을 담지 않는다.
- `--apply`는 **확정된 404 행에만** `unavailableAt`을 쓴다. 행도 객체도
  지우지 않으며 티켓 인자를 요구한다.
- **사라진 bytes는 복구할 수 없다.** lifecycle 규칙을 고치는 것은 앞으로의
  손실만 막고 이미 사라진 것을 되돌리지 않는다. 특정 파일의 복구 경로는 사용자
  가 다시 첨부하는 것뿐이며, 운영 문서에도 그렇게 적는다
  (`docs/ops/r2-object-lifecycle.md`).
- **오염된 provider health는 소급 조작하지 않는다.** 감사 이벤트를 지우거나
  aggregate bucket을 직접 수정하지 않고, 기존의 검증된 recovery 절차
  (`/api/admin/provider-health/verify` → `/recover`)로만 해제하며, 실제 live
  verification이 성공한 뒤에만 해제한다.
