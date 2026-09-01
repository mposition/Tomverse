# 대화 초안은 신원별로 격리되지 않습니다 (미해결)

**상태: 미결정.** 이 문서는 승인된 계약이 아니라 **확인된 결함과 아직 내려지지
않은 결정**을 기록합니다. 여기 적힌 어떤 것도 구현 승인이 아닙니다.

발견: 2026-08-31, Voice Input F-2 브라우저 검증 중.
결함이 있는 코드: `lib/conversationDraftStore.ts`, `components/chat/useConversationDrafts.ts`.

## 1. 확인된 사실

**같은 탭에서 계정이 바뀌면 다음 계정이 이전 계정의 입력 중이던 글을 봅니다.**

`draftKeyFor()`가 대화 id 하나만으로 key를 만들고 신원을 보지 않습니다.
**확인된 충돌은 새 대화 초안입니다** — 어느 계정에서든 같은
`draft:new-conversation` key를 쓰므로, 계정 A가 쓰던 문장이 계정 B의 입력창에
그대로 남습니다. 대화 id를 가진 초안은 그 id가 한 신원에만 속하고 전환에서
선택이 해제되므로 같은 방식으로 충돌하지는 않습니다.

재현(브라우저, 유료 호출 없음):

1. 계정 A로 `/chat`을 열고 새 대화 입력창에 `"계정 A가 쓰던 초안"` 입력
2. 같은 탭에서 session이 계정 B로 바뀜(로그아웃 후 다른 계정 로그인)
3. 계정 B의 textarea 값 = `"계정 A가 쓰던 초안"`

현재 이 동작은 `tests/e2e/voice-input-composer.spec.ts`의
"another account signing in mid-recording ends it and says so"가 **관측된 값
그대로** 단언합니다. `""`를 단언하면 사실이 아닌 것을 통과시키게 되고,
관측값을 단언해 두면 이 문서의 결정이 내려지는 날 그 테스트가 실패합니다 —
그때 함께 고치라는 뜻입니다.

## 2. 왜 이것이 개인정보 경계인가

초안은 **아직 보내지 않은 글**입니다. 보낸 메시지와 달리 사용자가 지우거나
고칠 생각으로 남겨 둔 것이고, 무엇이 들어 있는지 저장소가 알 방법이 없습니다.
공용 기기의 한 탭에서 다음 사람이 그것을 읽는 것은 편의 문제가 아닙니다.

**첨부는 파일 카드에 그치지 않습니다.** `ChatAttachment.data`는 이미지의 로컬
미리보기(`data:` 또는 `blob:` URL)이고 `ChatInput`이 그것을 실제 `<img>`로
그립니다(`components/chat/ChatInput.tsx`, `attachment.data`를 `src`로).
초안이 신원을 건너 살아남으면 계정 B는 카드 이름만이 아니라 **계정 A의 이미지
썸네일 내용**을 봅니다.

## 3. Voice가 만든 것이 아니고 Voice가 고칠 것도 아닙니다

Voice의 경계는 **음성 세션**에 있습니다(docs/policy/voice-input.md §8.4). 계정이
바뀌면 세션을 끝내고 클립을 버리므로, Voice가 보장하는 것은 **A의 음성
transcript가 B의 입력창에 추가되지 않는다**이고 그것은 검증됐습니다. 타이핑한
초안은 그 경계 밖이며 Voice 이전부터 이랬습니다.

이 문서를 Voice 정책이 아니라 따로 두는 이유가 그것입니다. 결함은 초안 store에
있고, 그 파일을 고치는 사람은 Voice 정책을 읽지 않습니다.

## 4. 두 갈래, 그리고 권고

- **A. 신원이 바뀌면 초안을 지운다.** 간단하고 유출은 막지만, 계정 A로 돌아온
  사용자의 글이 사라집니다. 되돌릴 수 없는 손실입니다.
- **B. 신원 namespace별로 격리한다.**(권고) key에 `identityNamespaceKey()`를
  포함해 B는 빈 입력창을 보고, A로 돌아오면 A의 초안이 복원됩니다. 유출을
  막으면서 아무 글도 버리지 않습니다.

2026-08-31 검토에서 B가 적합하다고 지목됐습니다. **다만 아래가 정해지기
전에는 구현하지 않습니다.**

## 5. 정해야 하는 것

1. **`unresolved` 신원의 key.** session이 확정되기 전 입력한 글은 어느
   namespace에 속하는가. 확정 시점에 옮길 것인가, 아니면 확정 전에는 쓰기를
   막을 것인가. 잘못 정하면 첫 글자가 사라집니다.
2. **guest 보존 계약과 unsent draft를 구분해서 정합니다.**
   docs/policy/chat-concurrency-and-identity.md가 전환에서 보존하라고 말하는
   것은 **열려 있던 guest 대화 ID**(import modal 기본값)와 **guest 대화
   데이터·import snapshot**입니다. 같은 문서의 "작성 중인 입력(draft)과 guest
   import snapshot은 삭제하지 않습니다"는 **stale 403 복구**(`CONVERSATION_FORBIDDEN`)
   구획의 문장이지 guest→account import를 위해 composer draft를 보존한다는
   계약이 아닙니다. 두 가지는 별개이고, 초안 격리는 앞의 계약을 깨지 않으면서
   뒤의 unsent draft를 어떻게 다룰지 **따로** 정해야 합니다.
3. **초안의 수명.** 격리하면 A의 초안이 탭 안에 계속 남습니다. 그것이 의도한
   것인지, 아니면 유출 창구를 옮긴 것에 불과한지 — 특히 공용 기기에서.
   메모리에만 있는지 저장되는지도 함께 확인해야 합니다.
4. **첨부의 lifecycle.** **서버 소유권은 이미 격리돼 있습니다** —
   업로드 해석이 `where`에 `userId`를 넣으므로(`lib/messageAttachmentStorage.ts`)
   계정 B가 계정 A의 `uploadId`를 제출해도 해석되지 않습니다
   (docs/policy/user-attachment-persistence.md). 남은 것은 client 쪽입니다.
   신원이 바뀔 때 A의 local preview와 attachment record를 어떻게 가릴 것인가,
   preview URL(`blob:`)을 언제 해제할 것인가
   (`collectReleasablePreviewUrls()`), 그리고 A의 **미전송 upload**를 보존할
   것인가 정리할 것인가(`discardUnboundUpload()`).
5. **격리 실패 시 동작.** 신원을 모를 때 어느 초안을 보여 줄 것인가.
   Voice의 scope 조회처럼 fail-closed(아무것도 안 보여 줌)가 맞는지.

## 6. 증거

- 재현 절차: 위 §1
- Voice 쪽 기록: docs/policy/voice-input.md §8.4 "이 기능이 고치지 않은 것"
- 현재 동작을 고정한 테스트: `tests/e2e/voice-input-composer.spec.ts`
