# 대화 초안은 신원별로 격리됩니다

**상태: 승인됨**(2026-09-02). 앞선 판은 "미결정"이었고, 결정과 구현이 함께
이루어졌습니다. 아래는 지켜야 하는 계약입니다.

관련 코드: `lib/conversationDraftStore.ts`, `components/chat/useConversationDrafts.ts`,
`components/chat/ChatInput.tsx`.

## 1. 고친 결함

**같은 탭에서 계정이 바뀌면 다음 계정이 이전 계정의 입력 중이던 글을 봤습니다.**

`draftKeyFor()`가 대화 id 하나만으로 key를 만들고 신원을 보지 않았습니다. 새 대화
초안은 어느 계정에서든 같은 key를 쓰므로, 계정 A가 쓰던 문장이 계정 B의 입력창에
그대로 남았습니다. 2026-09-01에 브라우저에서 재현했습니다(계정 전환 뒤 textarea
값 = `"계정 A가 쓰던 초안"`).

**노출은 파일 카드에 그치지 않았습니다.** `ChatAttachment.data`는 이미지의 로컬
미리보기(`data:`/`blob:` URL)이고 `ChatInput`이 그것을 실제 `<img>`로 그리므로,
계정 B는 카드 이름이 아니라 **계정 A의 이미지 썸네일 내용**을 봤습니다.

## 2. 계약

1. **초안 key는 대화와 사람을 함께 지목합니다.** `draftKeyFor(conversationId,
   identityKey)`이며 `identityKey`는 `identityNamespaceKey`(`account:` + user id)
   입니다.
2. **A → B 전환 즉시 B는 빈 입력창을 봅니다.** B의 composer는 한 번도 쓰인 적
   없는 key를 읽기 때문이고, 지우는 동작이 아닙니다.
3. **A의 text·attachment·image preview 어느 것도 B에서 접근할 수 없습니다.**
   pending·failed 업로드 목록도 같은 key로 걸러집니다.
4. **A로 돌아오면 A의 초안이 복원됩니다.** 삭제가 아니라 격리이므로 아무 글도
   버리지 않습니다.
5. **초안은 메모리에만 있고 탭과 함께 사라집니다.** localStorage에도 서버에도
   쓰지 않습니다. 이것이 4번의 보존이 무기한이 되지 않게 하는 경계입니다.
6. **서버 attachment 소유권은 그대로입니다.** 업로드 해석이 `where`에 `userId`를
   넣으므로(`lib/messageAttachmentStorage.ts`) B가 A의 `uploadId`를 제출해도
   해석되지 않습니다. 이 문서는 client 경계만 바꿉니다:
   docs/policy/user-attachment-persistence.md.

## 3. 왜 store를 나누지 않고 key에 넣었나

신원별로 store를 두고 "지금 로그인한 사람"으로 고르는 방식은 **매 render의
질문에는 맞고 다른 하나에는 틀립니다.**

쓰기가 전부 동기적이지 않습니다. `uploadOneFile()`은 업로드를 시작할 때 key를
붙잡아 파일이 끝난 뒤 되돌려주며, 그 사이에 탭의 주인이 바뀔 수 있습니다. 그
쓰기를 "지금 로그인한 사람" 기준으로 해석하면 **계정 A의 첨부가 계정 B의 초안에
떨어집니다.** key가 자기 namespace를 들고 다니면 그럴 수 없습니다 — 늦은 쓰기는
A의 초안으로 가고, B의 composer는 그 key를 읽지 않습니다.

`draftKeyFor()`가 **idempotent**인 것이 이 성질의 전부입니다. 이미 key인 값을 다시
넘기면 그대로 돌려주므로, 나중에 읽는 쪽이 그 key의 신원을 현재 신원으로 고쳐
쓰지 못합니다.

## 4. 아직 신원을 모를 때 (fail-closed)

`identityKey`는 session provider가 확정되기 전 `null`입니다. 그것은 "아무도
아님"이 아니고 **"모두"는 더더욱 아닙니다** — 공유 bucket을 주면 탭 안의 모든
신원이 번갈아 읽게 되고, 그것이 바로 이 key 형식이 막으려는 결함입니다.

그래서 `unresolved`는 **자기 segment**를 갖고, 확정된 어떤 신원도 그것을 읽지
않습니다. 대가는 session 확정 전에 친 글이 그 namespace에 남는다는 것이고,
대안은 **누가 썼는지 추측하는 것**입니다. 추측하지 않습니다.

`app/(site)/(application)/layout.tsx`가 session을 서버에서 확정해 넘기므로 이
화면에서 `status`는 `"loading"`이 되지 않습니다. 즉 오늘 이 경로는 실행되지
않지만, 규칙은 그것에 기대지 않습니다.

## 5. guest 보존 계약과의 관계

**별개입니다.** docs/policy/chat-concurrency-and-identity.md가 전환에서 보존하라고
말하는 것은 **열려 있던 guest 대화 ID**(import modal 기본값)와 **guest 대화
데이터·import snapshot**이며, 그중 어느 것도 이 변경이 건드리지 않습니다. 같은
문서의 "작성 중인 입력(draft)과 guest import snapshot은 삭제하지 않습니다"는
**stale 403 복구** 구획의 문장이지 guest→account import를 위해 composer draft를
보존한다는 계약이 아닙니다.

이 변경 뒤 guest의 unsent draft는 guest namespace에 남고, 로그인한 계정은 빈
입력창에서 시작합니다. import는 영향을 받지 않습니다.

## 6. 검증

- `tests/conversationDraftStore.test.mjs` — key 형식, idempotency, 신원 간 격리,
  unresolved namespace, 복원.
- `tests/e2e/conversation-draft-identity.spec.ts` — 브라우저에서 계정 전환 후 빈
  입력창, A로 돌아왔을 때 복원, 첨부 카드와 **이미지 썸네일**이 B에 보이지 않음.
  next-auth의 실제 refetch 경로를 씁니다.
- `tests/e2e/voice-input-composer.spec.ts` — 음성 세션의 신원 경계가 이 경계와
  함께 유지되는지.

**변형으로 확인했습니다.** `draftKeyFor()`가 신원을 무시하게 만들면 위 E2E 두
건이 모두 실패합니다.

## 7. 바꾸지 않은 것

- `ChatAttachment.data`의 존재와 렌더링. 미리보기는 계속 로컬 URL입니다.
- 서버의 어떤 것도. route·schema·소유권 검사 모두 그대로입니다.
- guest localStorage와 import snapshot.
