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
| 대화 조회 | `GET /api/conversations/{id}` | 각 메시지에 `attachments: [{id, attachmentId, ordinal, name, mediaType, size, kind}]` — 없으면 **키 자체가 없다** |
| 채팅 | `POST /api/chat` | 각 첨부는 `{attachmentId}` 또는 `{uploadId}` |

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
  6개 필드(id, ordinal, name, mediaType, size, kind)만 이름 대며,
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
