---
status: draft
implementationBlockedUntilApproved: false
approvedScopes: []
approvedBy: null
approvedAt: null
approvalTicket: N/A
---

# 외부 대화 이어가기 (Tomverse에서 이어가기)

가져온 외부 대화(ChatGPT · Claude · Gemini)를 **읽기 전용 원본으로 보존한 채**,
사용자의 명시적 선택으로 새 Tomverse Conversation을 만들어 같은 화면에서 대화를
이어가는 기능의 계약입니다.

`docs/policy/external-conversation-import-and-memory.md` §6이 이 기능을 릴리스 A의
비목표로 두면서 방향만 예약해 두었습니다. 이 문서는 그 예약을 구현 계약으로
확정한 것이며, **§6을 대체하지 않고 그 위에 쌓입니다.** §6이 금지한 다섯 가지는
여기서도 그대로 금지입니다 — imported message의 `Message` 복제, 외부 assistant
message에 runtime model ID 부여, external conversation ID의 account chat API 전달,
viewer의 즉흥 bridge, 전체 transcript의 첫 요청 첨부.

**제품명은 "Tomverse에서 이어가기"입니다.** "복원"도 "일반 대화로 변환"도
아닙니다. 외부 메시지는 일반 `Message`로 복사되지 않으므로 그 두 표현은 사실이
아니고, 사용자가 원본이 옮겨졌다고 믿게 만듭니다.

관련 기존 계약 — 이 문서는 아래를 대체하지 않습니다.

- `AGENTS.md`
- `docs/policy/external-conversation-import-and-memory.md` (§4 저장 모델, §4.2
  immutable snapshot, §5.6 정규화, §6 예약, §7 lock, §9.1 prompt boundary,
  §13 삭제·export·share, §15 flag)
- `docs/policy/conversation-product-key.md`
- `docs/policy/chat-concurrency-and-identity.md`
- `docs/policy/credit-and-cost-limits.md`
- `docs/ui-contracts/mobile-chat-composer.md`
- `docs/ui-contracts/settings-navigation.md`

## 1. 릴리스 경계

| 범위 | 명시적 비목표 |
|---|---|
| 하나의 immutable snapshot을 지목하는 bridge, 새 `productKey=chat` Conversation, deterministic bounded context seed, source-backed timeline 화면, 삭제·lock·share·export 의미, 전용 feature flag | LLM 요약 seed, memory 연동, lineage 최신 snapshot 자동 추적, 공개 share, 게스트, 다중 모델 비교, 외부 첨부 복제, 외부 원문의 일반 export 포함 |

- 이 기능은 **memory 릴리스와 독립적으로 동작해야 합니다.** `memoryExtractionEnabled`
  · `memoryInjectionEnabled`가 모두 꺼진 상태에서 전 기능이 성립합니다. 승인되지
  않은 memory pair·candidate를 읽지 않고, extraction·review·injection 경로를
  호출하지 않습니다.
- Import 릴리스 A와도 flag가 다릅니다(§7).

## 2. 용어

| 용어 | 의미 |
|---|---|
| Source snapshot | 사용자가 지목한 하나의 immutable `ExternalConversation`(import 정책 §4.2) |
| Bridge | source snapshot과 새 Conversation을 잇는 provenance row |
| Continuation | bridge를 가진 Tomverse Conversation |
| Context seed | 이 대화의 각 turn이 싣는, source에서 결정적으로 뽑은 제한된 발췌 |
| Tombstone | source가 삭제된 뒤 continuation 화면이 그 사실을 말하는 상태 |

## 3. 데이터 모델

`ConversationContinuationBridge` — additive 리소스. migration은
`20260830090000_conversation_continuation_bridge`이며 기존 테이블·제약을 건드리지
않습니다.

- `conversationId`는 **UNIQUE**입니다. 대화 하나에 bridge 둘이면 "이 대화가 무엇을
  잇고 있는가"에 답이 둘이 되고, seed builder가 아무도 내리지 않은 결정을 하게
  됩니다.
- 하나의 source에 bridge 여럿은 **허용**합니다. 같은 원본에서 여러 갈래로 이어가는
  것은 정당한 사용이고, 각 갈래는 각자의 Conversation입니다.
- `conversationId` FK는 **Cascade**, `externalConversationId` FK는 **SetNull**
  입니다. 두 방향이 다른 이유는 §6입니다.
- `sourceDeletedAt`이 필요한 이유는 SetNull입니다. NULL FK 하나만으로는 "원본이
  애초에 없었다"와 "원본이 삭제됐다"가 구분되지 않고, 화면은 그 차이를 말해야
  합니다.
- **source의 제목과 본문은 bridge에 복사하지 않습니다.** 복사하면 source 삭제가
  닿지 않는 테이블에 외부 내용이 남습니다. bridge가 담는 것은 provider,
  import 시각, snapshot digest, seed 창(窓)의 숫자들뿐입니다.
- `sourceConversationDigest`는 snapshot 식별자이며 **접근 증명이 아닙니다.**
  응답에 싣지 않고 로그·telemetry에 남기지 않습니다(import 정책 §4.1).
- 계정 삭제는 `userId` FK Cascade로 함께 지워집니다.
- bridge가 없는 일반 Conversation은 이 변경의 영향을 받지 않습니다.

## 4. Context seed

### 4.1 무엇을 고르는가

`lib/externalContinuationSeedCore.ts`(순수)가 결정합니다.

- **user·assistant 텍스트 turn만.** `system`·`developer`·`tool`·알 수 없는 role은
  버립니다. import 정책 §5.6이 애초에 저장을 막지만 여기서 한 번 더 거절합니다.
- source의 **ordinal과 role을 보존**합니다. 다시 번호를 매기지 않습니다.
- **최신 쪽에서부터** 창을 넓히고, 다음 turn이 통째로 들어가지 않으면 멈춥니다.
  turn을 반으로 자르지 않습니다 — 문장 중간에서 끊긴 답변은 없는 것보다 나쁜
  context이고, "N개 사용" 고지를 거짓으로 만듭니다.
- **hard cap이 항상 걸립니다**(`CONTINUATION_SEED_TOKEN_BUDGET`). 중앙 상수
  하나이며, 두 번째 상한을 만들지 않습니다. 토큰 추정은 기존
  `lib/chatTokenEstimate.ts`의 `estimateTextTokens`를 씁니다 — 별도 계산기를
  만들지 않습니다.
- **잘림·누락 개수를 세어 metadata로 전달**합니다: cap 때문에 빠진 수, 잘린 수,
  role 때문에 빠진 수를 각각 따로 셉니다. 총합의 차이로 유도하면 세 사실이 하나로
  뭉개집니다.
- 첨부·이미지·오디오는 애초에 import되지 않았으므로 복제할 것이 없습니다. 화면이
  말하는 것은 그것이 **없다는 사실**입니다.
- `contextSeedVersion`을 bridge에 기록합니다. 선택 규칙이 바뀌면 올립니다.

### 4.2 LLM 요약을 쓰지 않는 이유

요약은 매 turn을 아무도 검토하지 않은 유료 호출에 의존하게 만들고, seed를
source의 말이 아니라 **source에 대한 주장**으로 바꿉니다. 그러면 틀린 요약이 틀린
memory와 구분되지 않으면서, memory 프로그램이 앞에 세워 둔 validator도 승인 절차도
없습니다.

### 4.3 Prompt boundary

`lib/externalContinuationSeedPrompt.ts`, `promptVersion = ext-continuation-seed-v1`.

**seed는 두 조각으로 나뉘며, 그 분리가 이 절의 핵심입니다.**

| 조각 | 무엇 | 허용 role |
|---|---|---|
| `rulesText` | Tomverse가 쓴 규칙. 외부 텍스트를 하나도 끼워 넣지 않음 | `system` |
| `transcriptText` | 가져온 turn들. fence 안 | **`system`·`developer` 금지** |

- **외부 내용을 system/developer 위치로 승격하지 않습니다.** `system`은 요청이
  가진 가장 높은 권한 자리이고, 제3자 transcript를 그 안에 넣는 것은 이 조항이
  금지하는 승격 **그 자체**입니다. 감싼 문장이 "아래는 데이터다"라고 말해도
  provider가 보는 role은 바뀌지 않습니다.

  v1이 정확히 이것을 틀렸습니다 — 한 덩어리를 만들어 `system` 하나로 보내면서
  wrapper 문장을 근거로 삼았습니다. fence·평탄화·invisible 제거는 **구조 위장**을
  줄일 뿐 **메시지 권한**을 낮추지 않습니다.
- **규칙은 발췌 앞에 옵니다.** 뒤에 놓으면 payload가 규칙보다 먼저 읽힙니다.
  순서는 `buildChatTurnPrelude()`가 고정하며, 그 함수가 돌려주는 최종
  `ModelMessage[]`에 대해 테스트가 "외부 payload의 role이 system/developer가
  아니다"를 검사합니다.
- 고정 marker로 fence하고, 내용 안의 marker는 무력화합니다. 규칙은 두 marker의
  이름을 대며 "그것은 Tomverse가 쓴 것"이라고 밝힙니다.
- 각 turn은 **한 줄로 평탄화**하고 invisible 문자(C0/C1·zero-width·bidi
  override)를 제거합니다.
- **외부 assistant 발언은 provider 이름을 단 label로 표시**합니다. 모델이 그것을
  자기 이전 답변으로 읽으면 옹호하고, persona를 이어가고, 하지 않은 말을 했다고
  주장합니다.
- 평탄화와 fence는 **진짜 방어가 아닙니다.** 저장된 텍스트가 *구조처럼 보이지*
  않게 할 뿐입니다. 실제 경계는 role입니다.
- **이 구조 수정 전에는 유료 prompt-injection 검증(§D)을 실행하지 않습니다.**
  낮출 수 있는 권한을 그대로 둔 채 모델이 버티는지 보는 것은 방어를 검증하는
  것이 아닙니다.

### 4.4 비용

seed는 입력 토큰이며 **기존 규칙대로 사용자 크레딧에 반영됩니다.**
`buildChatTurnSystemBlocks`의 `promptTokens`에 포함되므로 `/api/chat`과
`/api/chat/preflight`가 같은 숫자를 봅니다. 내부 USD는 사용자 응답에 노출하지
않습니다(`docs/policy/credit-and-cost-limits.md`).

## 5. Turn 동작

각 chat turn은 다음을 **모두** 만족할 때만 seed를 싣습니다.

1. `externalConversationContinuationEnabled`가 켜져 있음
2. 이 Conversation에 bridge가 있고, `userId`가 `where` 안에서 일치함
3. source snapshot이 아직 존재함(삭제되면 FK가 NULL)
4. snapshot이 잠겨 있다면 **이 요청**이 유효한 `external_conversation` grant를 가짐

하나라도 어긋나면 seed는 `null`이고, 그 turn은 seed 없는 평범한 turn으로
진행됩니다. **여러 경우를 하나의 답으로 두는 것이 규칙입니다** — 형태를 여럿으로
나누면 일부만 처리되고 하나가 잊힙니다.

**단, 그것은 제어 흐름의 규칙이지 관측의 규칙이 아닙니다.** `loadContinuationTurnSeed()`
는 `{ seed, outcome }`을 돌려줍니다 — 호출자는 `seed` 한 형태만 보고 분기할 수
없으며, `outcome`은 §12의 계수와 로그로만 갑니다. v1은 이 둘을 섞어 `null` 하나만
돌려주고 아무것도 기록하지 않았고, 그 결과 staging 체크리스트 C-3("잠근 뒤 사유가
`locked`인지 확인")이 **답을 읽을 자리가 없어 완료 불가**였습니다.

- seed가 없어도 새 Tomverse 메시지 기록과 일반 대화 조회는 그대로입니다.
- 클라이언트는 seed를 만들지도, 보내지도, 우회하지도 못합니다. `messages`에 외부
  텍스트를 실어 보내는 경로는 존재하지 않으며, seed는 서버가 만들고 서버가
  가격을 매깁니다.
- deep research turn은 system block 자체를 싣지 않으므로 seed도 없습니다.

## 6. 삭제

- **source 삭제가 continuation을 지우지 않습니다.** Conversation도, 사용자가 쓴
  `Message`도 그대로 남습니다. FK는 SetNull이고 `sourceDeletedAt`이 기록됩니다.
- 삭제 판정과 tombstone 기록은 **삭제 전에, 같은 transaction에서** 합니다. cascade가
  지나간 뒤에는 어떤 bridge가 영향을 받았는지 남지 않습니다 — import 정책 §13.1의
  memory 분류가 같은 이유로 같은 자리에 있습니다.
- 삭제 후 continuation 화면은 **원본을 더 이상 표시할 수 없다는 tombstone**을 보이고,
  seed는 주입되지 않습니다.
- source 내용·seed 접근·관련 memory evidence 제거는 기존 계약(import 정책 §13.1)이
  그대로 수행합니다. 이 문서는 그 경로를 재사용할 뿐 memory 판정 로직을 바꾸지
  않습니다.
- **"원본과 이어진 대화를 모두 삭제"는 별도의 명시적 동작**입니다. source 삭제의
  부작용으로 대화가 사라지지 않습니다.
- 계정 삭제는 bridge를 포함해 모두 cascade합니다.

## 7. Feature flag와 rollback

`feature.externalConversationContinuationEnabled` — AppSetting, 기본 `false`,
행이 없으면 `false`(fail-closed). import·memory flag와 **독립**입니다.

- Import flag를 공유하면 이미 production에서 켜진 flag가 검증되지 않은 기능을 같이
  열게 됩니다. Memory flag를 공유하면 memory 없이 동작해야 한다는 요구와
  모순됩니다.
- flag가 통제하는 것은 **둘뿐**입니다.

  | 능력 | flag off일 때 |
  |---|---|
  | bridge 생성(API·CTA) | fail-closed (`EXTERNAL_CONTINUATION_DISABLED`, 403) |
  | turn seed 주입 | 주입 없음 |
  | 기존 bridge 대화 열람·메시지 전송 | **그대로 동작** |

- 세 번째 줄이 rollback 계약입니다. 이미 만들어진 사용자의 새 Tomverse 메시지가
  사라지거나 접근 불가능해지면 안 됩니다.
- **활성화·롤백 경로는 Admin Console에 있습니다** — `GET`·`PATCH
  /api/admin/app-settings`의 `externalConversationContinuationEnabled`와
  Platform Settings의 전용 체크박스. 기존 audit-integrity 계약(`ops:write`,
  최근 재인증, `app_settings.update_started`/`update_completed`)을 그대로 탑니다.
  **호출부 없는 setter는 활성화 경로가 아닙니다.**
- Import flag와 같은 카드 안에 있되 **별도 스위치**입니다. 하나로 묶으면 import가
  이미 켜진 production에서 이 기능이 함께 열립니다.
- ordinary chat과 Review에는 영향이 없습니다. seed가 빈 문자열이면 system block이
  추가되지 않고 토큰도 0입니다.
- migration은 additive이고 flag off 상태에서 먼저 배포할 수 있습니다. baseline은
  수정하지 않습니다.
- Admin 변경은 기존 audit-integrity 계약을 따릅니다.
- **이 저장소는 production 값을 켜지 않습니다.** 코드만 추가합니다.

## 8. UI

### 8.1 진입

`components/imports/ExternalConversationViewer.tsx`의 하나뿐인 CTA. transcript
아래에 놓습니다 — 이 선택은 방금 읽은 대화에 관한 것이고, 고지가 가리키는
메시지보다 먼저 닿아서는 안 됩니다.

실행 전에 다섯 문장을 보여 줍니다: 새 대화가 만들어짐 · 원본은 읽기 전용 유지 ·
외부 메시지는 Tomverse 답변이 아님 · 첨부와 잘린 메시지가 있을 수 있음 · 선택한
일부만 AI context로 사용됨.

- 성공하면 새 Conversation workspace로 이동합니다.
- 실패해도 **중복 생성 없이 재시도**할 수 있습니다: idempotency key는 고지를 연
  시점에 한 번 만들어지고 그 시도 내내 재사용됩니다. 취소 후 다시 열면 새 key —
  그것이 두 번째 갈래이고 §3이 허용하는 것입니다.
- flag off(403)는 재시도 문구가 아니라 "지금 사용할 수 없습니다"입니다.

### 8.2 이어진 대화 화면

`/continuations/[conversationId]` (`lib/continuationRoutes.ts`).

`/chat`과 `/review`는 Tomverse Review workspace를 렌더합니다
(`lib/productSurfaceRoutes.ts`). continuation은 `productKey=chat`이므로 선택지는
둘이었습니다 — 외부 transcript를 모르는 Review shell에서 열거나, 전용 surface를
주거나. 후자를 택했고 그것은 additive입니다: 기존 route의 의미가 바뀌지 않고
Review를 재배선하지 않습니다. Tomverse Chat이 자기 surface를 갖는 날 옮길 자리는
`CONTINUATION_SURFACE_PATH` 한 곳입니다.

**재진입은 서버가 판정합니다.** 대화 목록·상세·검색 응답은 각 대화의
`surface`(`workspace` | `continuation`)를 싣고, 사이드바와 검색 결과는 그 값에
따라 `/continuations/[id]`로 이동합니다. 판정은 `lib/continuationRoutes.ts`의
`conversationSurface()` 하나이며 근거는 bridge row의 존재뿐입니다 —
`productKey`에서 유도하지 않습니다(그러면 앞으로의 모든 `chat` 대화가 여기로
옵니다).

v1에는 이것이 없었고, 그래서 **만든 직후에는 정상으로 보이고 목록에서 다시 열면
Review workspace로 열려 외부 원문·출처 구획이 사라졌습니다.** 결함이 가질 수 있는
가장 나쁜 모양입니다.

검색 결과는 자기 `surface`를 직접 싣습니다. 검색은 목록이 불러오지 않은 대화를
가리킬 수 있고, 그때 workspace로 되돌아가면 같은 결함이 됩니다.

화면 구성:

- source provider와 import 시점
- "외부 대화 · 읽기 전용" 구획 — 외부 user·assistant 메시지, assistant에는
  provider badge와 "외부 답변" 표시, 잘림 고지
- "여기부터 Tomverse에서 이어진 대화" divider
- 새 Tomverse 메시지
- composer

**외부 source를 일반 `Message` 배열에 합쳐 직렬화하지 않습니다.** 두 배열은 두
endpoint에서 오고, 수명·삭제 계약·provenance가 다릅니다. 하나로 합치면 그 차이가
CSS class의 속성이 되고, 그것을 잊은 첫 번째 refactor가 ChatGPT 답변을 Tomverse
답변으로 보여 줍니다.

composer는 mobile composer 계약의 형태를 따릅니다 — textarea가 전용 full-width
행을 갖고, 어떤 control도 그 행을 나눠 쓰거나 겹치거나 위에 뜨지 않습니다. 320px에서
가로 overflow가 없어야 합니다.

신규 accent 역할을 만들지 않고 neutral token을 씁니다.

## 9. Share와 export

- **bridged conversation의 공개 share는 첫 릴리스에서 거절합니다**
  (`CONTINUATION_SHARE_NOT_SUPPORTED`, 409). share snapshot은 `Message`를 싣기
  때문에, 공개하면 읽는 사람이 볼 수 없는 발췌를 가리키는 답변의 절반만 나갑니다.
  반대로 외부 절반을 실으면 계정 전용으로 보관하겠다고 약속한 제3자 transcript가
  공개됩니다. 어느 쪽도 "공유" 버튼의 기본값이 되어서는 안 됩니다.
- 판정은 `lib/continuationSharingPolicy.ts` 한 곳이며 route와 UI가 같은 함수를
  씁니다.
- **export에는 provenance를 넣습니다** — source provider, import 시점, 원본은 별도
  export 대상이라는 설명. 원본이 이미 삭제됐으면 그 사실을 씁니다.
- **외부 원문 전체를 일반 Conversation export에 복사하지 않습니다.** 그것이 이
  조항이 막는 조용한 확장입니다.

## 10. Lock과 권한

- 소유권은 **항상 서버 `userId`로** 판정하고, `where` 안에 넣습니다. 남의 것은
  "거절"이 아니라 "없음"이며, 차이를 보고할 분기가 존재하지 않습니다.
- 외부 ID나 URL prefix를 권한 증거로 쓰지 않습니다.
- 잠긴 snapshot은 유효한 `external_conversation` grant가 있어야 이어갈 수 있습니다.
  grant는 resource type과 resource ID 양쪽에 결속되므로(import 정책 §7) native
  conversation grant로는 열리지 않습니다 — 그것은 다른 HMAC key와 다른 cookie
  이름입니다.
- bridge 생성 후 Conversation 권한은 기존 Conversation 계약을 그대로 따릅니다.
  continuation timeline 조회도 native conversation lock을 먼저 확인합니다.
- **admission token·context bundle을 재사용하지 않습니다.** seed는 concurrency
  슬롯도 context bundle도 아니고, 그 둘의 검증을 대체하지 않습니다
  (`docs/policy/chat-concurrency-and-identity.md` §3).

## 11. 오류 코드

| code | HTTP | retry | 비고 |
|---|---|---|---|
| `EXTERNAL_CONTINUATION_DISABLED` | 403 | 불가 | flag off, fail-closed |
| `CONTINUATION_SHARE_NOT_SUPPORTED` | 409 | 불가 | §9 |

인증(401)·소유권(403/404)·not-found(404)·lock(423)·rate limit(429)은 기존 저장소
계약을 그대로 따르며 여기서 재정의하지 않습니다. 오류에 외부 원문·digest·내부
USD를 싣지 않습니다.

## 12. 관측

`lib/externalContinuationMetrics.ts`. content-free 집계만 남깁니다.

| outcome | 뜻 | 로그 |
|---|---|---|
| `seeded` | 발췌가 실림 | 없음(정상 경로) |
| `no_bridge` | 일반 대화 | 없음(분모의 나머지 절반) |
| `flag_off` | rollout flag off | 있음 |
| `source_deleted` | 원본 삭제 또는 조회 불가 | 있음 |
| `locked` | 잠긴 snapshot, 이 요청에 grant 없음 | 있음 |
| `empty_selection` | 읽히지만 고를 turn이 없음 | 있음 |

- 계수는 `ChatUsageBucket`의 `continuation:` namespace 일간 집계이고, 로그는
  `continuation_seed_skipped` 한 줄입니다.
- **정상 경로에는 로그를 남기지 않습니다.** 매 turn의 한 줄은 찾으려는 네 줄을
  묻습니다 — `billing_price_catalog_fallback`과 같은 판단입니다.
- **외부 원문·제목·digest·ordinal·conversation ID를 남기지 않습니다.** outcome은
  고정 enum이고 계수는 일간 총계이므로, 기록 전체가 "오늘 사유 R로 N turn이
  seed 없이 나갔다"입니다 — 가리는 것이 아니라 구조상 담을 수 없습니다.
- **기록은 `/api/chat`에서만 합니다.** preflight는 같은 turn을 견적낼 뿐이므로
  양쪽에서 세면 모든 수치가 두 배가 되고 comparison은 세 배가 됩니다.

## 13. 출시 차단 조건

다음 중 하나라도 있으면 staging·production 활성화 불가입니다.

- 외부 message가 일반 `Message`로 복제됨
- `sourceModelLabel`이 runtime `modelId`로 사용됨
- cross-account 또는 lock 우회
- source 삭제 후 원문·seed·memory evidence가 남음
- source 삭제가 새 Tomverse `Message`를 함께 삭제함
- 계정 삭제가 bridge를 남김
- imported prompt가 system/developer 경계를 넘음
- `productKey`가 `review`로 위장되거나 누락됨
- flag off가 ordinary chat을 깨뜨리거나 사용자 새 메시지를 숨김
- share·export를 통해 외부 원문이 사용자 동의 없이 공개됨

라벨 조정·breadcrumb·추가 모바일 polish는 데이터·보안 계약이 맞으면 비차단으로
기록할 수 있습니다.

## 14. 알려진 제약과 사람 판단이 필요한 항목

1. **`productKey=chat` 제품 surface.** Tomverse Chat은 아직 출시되지 않았고
   `/chat`은 Review를 렌더합니다. §8.2의 전용 surface는 그 사이를 메우는 것이며,
   Chat surface가 생기면 continuation을 그쪽으로 옮길지가 사람의 결정입니다.
2. **모델 선택.** continuation은 Conversation의 기본 모델 하나로 시작합니다.
   모델 선택 UI는 Chat surface의 문제이며 여기서 선점하지 않습니다.
3. **seed 예산 값.** `CONTINUATION_SEED_TOKEN_BUDGET`은 보수적인 시작값입니다.
   조정은 관측(§12) 뒤의 결정이고, 올리는 것은 매 turn 사용자가 부담하는 비용을
   올리는 일입니다.
4. **share 재개.** §9의 거절은 두 절반의 provenance를 담을 수 있는 share 형식이
   생기면 재검토합니다. 그 전까지 완화하지 않습니다.
5. **staging 검증.** `docs/ops/external-conversation-continuation-staging-checklist.md`
   의 차단 항목이 flag를 켜기 전 완료 조건입니다.
