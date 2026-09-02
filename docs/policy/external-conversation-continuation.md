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

**이어진 대화는 Review 대화입니다**(`productKey = "review"`, `kind = "chat"`).
가져온 원본을 여러 모델에게 같은 자리에서 다시 물어보는 것이 이 기능이 답하는
질문이고, 그것이 Review가 하는 일입니다. 2026-09-01 개정 이전의 v1은 이어가기를
단일 모델 Chat으로 정의하면서 모델 선택을 "Chat surface의 문제"로 미뤘고, 그
결과 Review와 같은 화면 계약을 쓰면서 제품만 `chat`으로 기록된 행이 만들어졌습니다.
이 개정은 정책과 구현을 같은 변경에서 함께 고칩니다 — 제품 정체성은 §3.1, turn은
§5.1, 화면은 §8.2, 기존 행의 교정은 §15입니다.

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
| 하나의 immutable snapshot을 지목하는 bridge, 새 `productKey=review` Conversation, **선택한 모델마다 같은 seed로 답하는 다중 모델 비교**, deterministic bounded context seed, source-backed timeline 화면, 삭제·lock·share·export 의미, 전용 feature flag | LLM 요약 seed, memory 연동, lineage 최신 snapshot 자동 추적, 공개 share, 게스트, 외부 첨부 복제, 외부 원문의 일반 export 포함 |

- 이 기능은 **memory 릴리스와 독립적으로 동작해야 합니다.** `memoryExtractionEnabled`
  · `memoryInjectionEnabled`가 모두 꺼진 상태에서 전 기능이 성립합니다. 승인되지
  않은 memory pair·candidate를 읽지 않고, extraction·review·injection 경로를
  호출하지 않습니다.
- Import 릴리스 A와도 flag가 다릅니다(§7).
- **다중 모델 비교는 더 이상 비목표가 아닙니다**(2026-09-01 개정). 다만 이 기능이
  가져오는 것은 Review의 **기존** 모델 선택·entitlement·비교 계약이며, 여기서 새
  모델 선택 규칙이나 새 상한을 만들지 않습니다(§3.1, §8.2).

## 2. 용어

| 용어 | 의미 |
|---|---|
| Source snapshot | 사용자가 지목한 하나의 immutable `ExternalConversation`(import 정책 §4.2) |
| Bridge | source snapshot과 새 Conversation을 잇는 provenance row |
| Continuation | bridge를 가진 Tomverse Review Conversation(`productKey = "review"`) |
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

### 3.1 제품 정체성 — `productKey = "review"`, `kind = "chat"`

**continuation은 Review 대화입니다.** 생성 경로는 공통 생성 서비스
`createConversation()`에 서버 상수 `REVIEW_PRODUCT_KEY`를 **행과 같은
statement로** 넘깁니다 — docs/policy/conversation-product-key.md §5.2.
요청 본문이 제품을 실어 보내는 경로는 없고, 앞으로도 만들지 않습니다.

- **bridge는 provenance이지 제품이 아닙니다.** bridge가 있다는 사실이 정하는 것은
  둘 — 이 대화가 어느 snapshot에서 시작됐는가, 그리고 어느 surface에서 열리는가
  (§8.2의 `conversationSurface()`). `productKey`는 그 둘 중 어느 쪽에서도
  유도되지 않고, 반대로 `productKey`에서 surface를 유도하지도 않습니다. 후자를
  하면 앞으로의 모든 `review` 대화가 continuation surface로 갑니다.
- **`kind`는 `chat`으로 남습니다.** `kind`는 서버 authorization·modality
  경계이고(`docs/policy/conversation-product-key.md` §1), Chat과 Review는 둘 다
  `chat` modality입니다. `PRODUCT_MODALITY`가 이 조합을 애플리케이션에서 먼저
  거부하고 `Conversation_product_modality_check`가 뒤를 받칩니다.
- **`selectionMode`는 `manual`입니다.** Auto는 Chat 전용이므로
  (`AUTO_SELECTION_PRODUCT`) Review 제품에서는 제공되지 않습니다. 이것은 거절이
  아니라 부재이며 `product_not_chat`으로 관측됩니다
  (`docs/ui-contracts/auto-model-selection.md`). `Conversation_auto_only_chat_check`
  가 `review + auto` 행 자체를 막습니다.
- **`selectedModels` 개수·`selectionMode`·제목·route로 제품을 유도하지
  않습니다.** 모델 하나만 고른 Review 대화도 여전히 Review이고, 모델을 셋 고른
  Chat 대화가 Review가 되지도 않습니다. 이것이 §15가 마이그레이션 기준에서 그
  넷을 명시적으로 배제하는 이유입니다.

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
`/api/chat/preflight`가 같은 숫자를 봅니다.

**모델을 N개 고르면 seed 입력 비용도 N번 발생합니다.** preflight가 모델마다 따로
견적을 내고(`budgets = models.map(...)`) 실제 예약도 모델 요청마다 따로
일어나므로, 견적과 예약이 같은 seed를 같은 횟수로 셉니다. 사용자에게 보이는
예상 크레딧은 **모델별 값의 합계**이며 한 모델의 값을 곱해 유도하지 않습니다 —
모델마다 가격도 검색 surcharge도 다릅니다. 이 절은 크레딧 계약을 새로 만들지
않고 `docs/policy/credit-and-cost-limits.md`를 그대로 가리킵니다.

내부 USD는 사용자 응답에 노출하지 않습니다
(`docs/policy/credit-and-cost-limits.md`).

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

### 5.1 선택한 모델마다 같은 seed

한 번의 사용자 입력은 **선택된 모델 수만큼의 assistant Message/attempt**를
만듭니다. Review의 비교 turn과 같은 구조이고, 이어가기가 더하는 것은 seed
하나뿐입니다.

- **seed는 서버가 각 모델 요청에 따로 적용합니다.** 클라이언트가 보내는 것은
  자기가 쓴 문장과 모델 id이며, 발췌는 `/api/chat`이 요청마다
  `loadContinuationTurnSeed()`로 다시 만들어 `buildChatTurnSystemBlocks()`에
  넣습니다. **클라이언트 요청 본문에 외부 원문이 실리는 경로는 존재하지
  않습니다.** 모델이 셋이면 그 판정도 셋 다 서버에서 따로 일어납니다.
- **네 관문은 모델마다 독립으로 지나갑니다**(§5의 1–4). 한 요청은 seed를 얻고
  다른 요청은 못 얻는 상태는 그 사이에 원본이 잠기거나 지워졌을 때만 생기며,
  그때는 그것이 정확한 답입니다. 한 요청이 만든 seed를 다른 요청에 복사해 넣지
  않습니다 — 복사하는 순간 lock·삭제 판정이 요청마다 다시 일어난다는 §5의
  약속이 깨집니다.
- **같은 turn의 모든 모델은 같은 발췌를 받습니다.** seed는
  `contextSeedVersion`과 source snapshot에서 결정적으로 파생되므로, 같은 turn의
  N개 요청은 같은 창(窓)을 봅니다. 모델별로 발췌를 달리 자르지 않습니다 —
  그러면 비교가 답이 아니라 입력의 차이를 재게 됩니다.
- **한 모델의 실패가 다른 모델에 닿지 않습니다.** 예약·정산·환급은 모델 요청
  단위이고, 실패한 요청의 환급은 성공한 요청의 정산과 무관합니다(§4.4).
- **원본은 각 패널의 timeline 맨 앞에 놓입니다**(2026-09-02 2차 개정). 그 전에는
  divider 위에 구획 하나를 두고 "화면 전체에서 한 번만" 그렸습니다. 그것이
  틀렸던 이유는 개수가 아니라 자리입니다 — 패널이 각자 스크롤하므로 구획은
  자기 스크롤 영역을 하나 더 만들었고, 화면에 대화가 둘 있는 모양이 됐습니다.
  이어가기 화면에서 원본은 **이 대화의 앞부분**이지 옆에 붙은 자료가 아닙니다.
  그래서 패널마다 자기 message list 앞에 붙이고, 패널이 이미 가진 스크롤
  container 하나를 그대로 씁니다.
  **패널 N개면 원본도 N번 그려집니다.** 일반 비교에서 사용자의 질문이 패널마다
  보이는 것과 같습니다 — 비교는 모든 모델에게 같은 history를 보여 주는 것이고,
  가져온 history라고 달라질 이유가 없습니다. 금지되는 것은 **한 패널 안에서**
  원본이 두 번 나오는 것(구획 하나 + timeline 앞 하나)입니다.
  외부 message를 `Message` **행으로** 복제하지 않는다는 금지는 그대로입니다 —
  아래 §8.2의 view model 규칙을 봅니다.
- **Deep Research는 기존 제약을 유지합니다** — system block을 싣지 않으므로
  가져온 seed가 전달되지 않습니다. 이 개정이 그 제약을 풀지 않습니다.
- **이미지 생성은 이 대화에서 실행되지 않습니다.** 별도 이미지 대화 draft로
  넘기며, 그 draft에 원본 transcript를 전달하지 않습니다
  (`docs/policy/image-generation.md`).
- **Web Search · 첨부 · Assistant profile · Memory는 기존 Review 계약을 그대로
  따릅니다.** 이 문서는 그 계약들을 다시 쓰지 않고, 이어가기라는 이유로 완화하지도
  않습니다.

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

### 7.1 flag를 끄면 **모든 인스턴스에서** 즉시 멈춥니다

**snapshot 캐시는 rollback이 아닙니다.** `isExternalContinuationEnabledCached()`
는 `lib/publicSnapshotCache.ts`의 프로세스 내부 `Map`이고 TTL은 10초이며,
`invalidatePublicSnapshot()`은 **admin write를 처리한 그 프로세스의 Map만**
비웁니다. 나머지 인스턴스는 자기 항목이 만료될 때까지 계속 "켜짐"이라고
답합니다.

2026-08-31 리뷰가 이것을 재현했습니다 — 두 인스턴스를 모의 실행하니 변경한 쪽은
`false`, 다른 쪽은 여전히 `true`였고, 최대 10초간 외부 원문이 더 나갈 수 있었습니다.
위 표의 "주입 없음"은 그 상태에서 **한 대에서만** 참이었습니다.

그래서 판정을 두 단계로 나눕니다.

| 단계 | 읽는 함수 | 역할 |
|---|---|---|
| 사전 필터 | `isExternalContinuationEnabledCached()` | bridge 조회를 hot path에서 걷어내기 위한 것. **판정이 아닙니다.** |
| 판정 | `isExternalContinuationEnabled()` (uncached) | `loadContinuationTurnSeed()`가 bridge를 찾은 **뒤** 행을 다시 읽습니다. 발췌를 만들기 전입니다. |

- 비용은 **bridge가 있는 대화에만** 붙습니다. 일반 대화는 그 앞에서
  `no_bridge`로 끝나므로 추가 질의가 없습니다.
- 비대칭은 의도된 것이고 안전한 방향입니다. 캐시는 기능을 **켜는** 것을 최대
  TTL만큼 늦출 수 있지만, **끄는** 것은 더 이상 늦추지 못합니다.
- 생성 경로(`assertExternalContinuationEnabled`)는 처음부터 uncached이므로
  바뀐 것이 없습니다.
- 이 판정이 실제로 동작했다는 증거는 §12의 `flag_off_stale_cache`입니다.
  `flag_off`와 합치지 않습니다 — 앞은 "변경한 그 인스턴스에서 rollback이
  유지된다", 뒤는 "아직 못 들은 인스턴스까지 도달했다"이고, 후자만이 이
  절이 존재하는 이유를 관측 가능하게 만듭니다.
- **읽기는 어느 단계에서도 flag를 보지 않습니다.** 위 표 세 번째 줄이 그대로
  유지되며, 통합 테스트가 flag off 상태에서 bridge·timeline·사용자 메시지가
  전부 남아 있음을 고정합니다.
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

실행 전에 여섯 문장을 보여 줍니다: 새 대화가 만들어짐 · 원본은 읽기 전용 유지 ·
외부 메시지는 Tomverse 답변이 아님 · 첨부와 잘린 메시지가 있을 수 있음 · 선택한
일부만 AI context로 사용됨 · **여러 모델이 답하며 모델마다 크레딧이 든다**.

여섯 번째는 이 개정이 추가한 것이고 다른 다섯과 성격이 다릅니다 — 앞의 다섯은
무엇이 보존되는지에 대한 고지이고, 이것은 **비용이 몇 배가 되는지**에 대한
고지입니다(§4.4). 계정의 새 대화 기본 조합이 모델 셋이면 첫 turn부터 세 번
청구되므로, 그 사실을 만들기 전에 말합니다.

- 성공하면 새 Conversation workspace로 이동합니다.
- 실패해도 **중복 생성 없이 재시도**할 수 있습니다: idempotency key는 고지를 연
  시점에 한 번 만들어지고 그 시도 내내 재사용됩니다. 취소 후 다시 열면 새 key —
  그것이 두 번째 갈래이고 §3이 허용하는 것입니다.
- flag off(403)는 재시도 문구가 아니라 "지금 사용할 수 없습니다"입니다.

### 8.2 이어진 대화 화면

`/continuations/[conversationId]` (`lib/continuationRoutes.ts`).

`/chat`과 `/review`는 Tomverse Review workspace를 렌더합니다
(`lib/productSurfaceRoutes.ts`). **continuation도 같은 workspace를 렌더합니다**
(2026-09-02 개정). route만 다르고 화면은 하나입니다 — 같은 사이드바, 같은
timeline, 같은 composer이며, continuation이 더하는 것은 **timeline 위의 읽기
전용 prelude 하나**뿐입니다.

이 개정 전에는 이 route가 자기 화면을 갖고 있었습니다 — 자기 textarea, 모델
전체를 버튼으로 늘어놓은 격자, 자기 message list, 사이드바 없음. divider 아래
전부가 chat surface의 두 번째 구현이었고, 그 둘의 차이는 결정이 아니었습니다:
첨부 없음, web search 없음, 중단 없음, 재시도 없음, 아무도 확인한 적 없는 IME
처리, 그리고 목록에서 다시 찾아 들어갈 방법 없음. continuation에 **고유한 것은
가져온 transcript 하나뿐**이므로, 고유하지 않은 나머지는 공용 shell이 맡습니다.

**원본은 shell이 한 번 읽어 패널마다 넘깁니다.** 읽기는
`useContinuationSource()` 하나이고, 대화가 하나이므로 요청도 하나입니다 —
패널마다 읽으면 선택한 모델 수만큼 같은 bridge를 조회하게 됩니다. 패널은 받은
것을 자기 message list 앞에 붙입니다(§5.1).

**그래서 판정 근거가 `productKey`가 아니라는 것이 이 개정 이후 더 중요해졌습니다.**
`conversationSurface()`가 읽는 것은 bridge row의 존재 하나뿐이고, `productKey`에서
유도하면 이제 **모든 Review 대화**가 여기로 옵니다 — 개정 전에는 모든 `chat`
대화였고 그때도 틀렸지만, 오늘은 그 집합이 저장소의 거의 모든 대화입니다.
**route가 남는 이유는 이제 화면이 아니라 URL의 의미입니다.** 가져온 원본은 이
대화가 무엇인지의 일부이고, 사이드바와 검색이 bridge를 근거로 이 경로로
보냅니다. 옮길 자리는 여전히 `CONTINUATION_SURFACE_PATH` 한 곳입니다.

**mount된 surface와 다른 surface의 대화를 고르면 이동합니다.** 두 화면이 같은
컴포넌트가 된 뒤로 방향이 둘입니다 — `/chat`에서 continuation을 고르면
`/continuations/[id]`로, `/continuations/[id]`에서 일반 대화를 고르면 workspace
경로로. 뒤쪽을 제자리 전환으로 두면 continuation의 URL과 그 prelude가 다른
대화를 설명하게 됩니다.

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

**가져온 원본은 timeline 안에 있습니다**(2026-09-02 2차 개정). 별도 구획도,
별도 disclosure도, 별도 scroll 영역도 아닙니다. 각 패널의 message list는 위에서
아래로 이렇게 읽힙니다.

```
[provenance 한 줄]  {provider}에서 가져온 대화 · 2026-07-02 · 읽기 전용
[이전 가져온 메시지 N개 보기]        (원본이 한 페이지보다 길 때만)
imported user      점선 bubble
imported assistant 점선 bubble, provider 아이콘과 원본 model 라벨
──────── 여기부터 Tomverse에서 이어진 대화 ────────   role="separator"
native user        일반 bubble
native assistant   일반 bubble
```

그리고 그 아래는 **일반 Tomverse composer**입니다 — 첨부·web search·전송·중단·
재시도·모델 picker·IME 처리가 전부 일반 대화의 것과 같은 컴포넌트입니다.

**허용되는 시각적 차이는 넷뿐입니다.**

1. 사이드바 항목의 provider 아이콘(§8.4)
2. 가져온 bubble의 점선 border — shape·padding·font·정렬은 일반 bubble과 같습니다
3. divider 한 줄
4. 위 provenance 한 줄과, 가져온 assistant의 provider·원본 model 라벨

그 밖의 shell·header·timeline·model rail·composer·간격·scroll 동작은 일반 Chat과
같아야 합니다. **중첩 scrollbar를 만들지 않습니다** — 대화 영역의 세로 스크롤은
패널의 것 하나입니다.

**이 개정 전에는 원본이 patch 위의 prelude 구획이었습니다.** 접혀 있었고, 자기
heading과 자기 `max-h`/`overflow-y` scroller를 갖고 있었습니다. 그 화면에서
사용자가 본 것은 대화 하나가 아니라 둘이었고, 이어가기의 존재 이유인 transcript는
구석의 control 뒤에 있었습니다. 접어 둔 이유였던 "composer를 밀어낸다"는 문제는
timeline 안에서는 발생하지 않습니다 — 원본이 스크롤 영역 **안**에 있으므로 고정
높이를 먹지 않고, 길이는 timeline의 pagination이 감당합니다.

**긴 원본은 timeline 안에서 페이지로 읽습니다.** 첫 페이지는 divider 바로 위,
즉 **원본의 끝**입니다(`offset=end`). 그 위로는 "이전 가져온 메시지 N개 보기"가
한 페이지씩 거슬러 올라갑니다. 별도 화면으로 숨기지 않습니다.

**삭제·잠금 상태도 timeline 안입니다.** 가져온 bubble 자리에 한 줄짜리
tombstone 또는 lock 안내가 들어가고, divider·native message·composer·사이드바
이동은 그대로입니다. seed는 주입되지 않습니다(§6, §7).

### 8.3 모델 선택

**일반 Chat composer의 모델 picker를 그대로 씁니다.** 이 화면은 자기 규칙도,
자기 control도 만들지 않습니다 — 2026-09-02 개정 전에는 모델 전체를 버튼 격자로
늘어놓고 선택을 스스로 저장했고, 그것이 상한·가용성·교체·크레딧 견적을 이미
소유한 composer 옆에 두 번째 답을 만들었습니다.

- **상한·가용성·entitlement 판정은 서버가 합니다.** 화면은
  `PATCH /api/conversations/[conversationId]`에 `selectedModels`를 보내고,
  그 route가 `clampRuntimeSelectedModels()`로 가용성을,
  `effectivePlanModelLimit()`로 플랜 상한을 판정합니다. 상한 초과는
  `modelLimitResponse()`이고, 이어가기 전용 상한이나 전용 오류 코드를 만들지
  않습니다.
- **초기 `selectedModels`는 일반 새 Review 대화와 같은 규칙으로 정합니다** —
  `resolveNewConversationModels()`(계정의 새 대화 기본 조합, `NULL`이면
  `[defaultModel]`) → `clampRuntimeSelectedModels()` → 플랜 상한. 이어가기 전용
  기본 조합을 두지 않습니다.
- **읽기 경로는 저장값을 다시 쓰지 않습니다.** 비활성 모델이 저장돼 있어도
  `effective` 상태만 보여 주고 저장값은 보존합니다
  (`docs/policy/default-model-luna-migration.md` §1.2).
- **상한이 찼을 때 새 모델을 고르면 교체를 확인받습니다.** 조용히 바꾸지도,
  아무 일도 일어나지 않은 것처럼 두지도 않습니다 — 어느 모델을 뺄지 사람이
  고릅니다. Review picker와 같은 절차입니다.
- **기존 continuation의 `selectedModels`는 migration이나 배포로 자동
  확장되지 않습니다**(§15). 모델이 하나인 채로 만들어진 대화는 사용자가 직접
  더하기 전까지 하나입니다.
- **예상 크레딧은 제출 전에 모델별로, 그리고 합계로 보여 줍니다**(§4.4).

**외부 source는 렌더링 시점의 view model에서만 합쳐집니다**(2026-09-02 2차 개정).

그 전 문장은 "일반 `Message` 배열에 합치지 않는다"였고, 근거는 두 배열의 수명·
삭제 계약·provenance가 다르다는 것 — 합치면 그 차이가 CSS class의 속성이 되고,
그것을 잊은 첫 번째 refactor가 ChatGPT 답변을 Tomverse 답변으로 보여 준다 —
였습니다. 그 위험은 그대로이므로, 합치는 자리와 그것을 막는 것을 여기에 적습니다.

- **합쳐지는 것은 화면에 그릴 배열 하나뿐이고, 그 자리는
  `continuationTimelineMessages()`입니다.** 두 endpoint는 그대로 둘이고, 원본은
  여전히 자기 route(`GET /api/conversations/[id]/continuation`)에서 옵니다.
- **차이를 들고 다니는 것은 CSS class가 아니라 `Message.imported`입니다.**
  점선 border·provider 헤더·읽기 전용 접근성 설명·숨겨지는 action이 전부 그
  field의 유무로 갈립니다. class를 지워도 field는 남고, field가 없으면 아무것도
  imported로 그려지지 않습니다.
- **`imported`가 있으면 곧 읽기 전용입니다.** `surface` + `readOnly` 두 field가
  아니라 하나인 이유가 이것입니다 — "imported이지만 쓸 수 있음"을 표현할 수
  있는 모양이면 언젠가 누군가 그것을 씁니다.
- **DB에는 아무것도 합쳐지지 않습니다.** 외부 message는 `Message` 행으로
  복제되지 않고(§4, import 정책 §6), `lib/chatMessageSerialization.ts`는
  allowlist이므로 `imported`를 실은 message는 요청 본문·저장 transcript·
  localStorage 어디에도 실리지 않습니다.
- **다음 turn의 seed는 화면에서 오지 않습니다.** `/api/chat`이 요청마다
  `loadContinuationTurnSeed()`로 snapshot에서 다시 만듭니다(§5.1). 패널이 무엇을
  그리고 있든 seed는 바뀌지 않으며, 이 규칙이 "화면의 배열이 곧 모델의 입력"이
  되는 것을 구조적으로 막습니다.
- **imported bubble은 native를 수정하는 action을 갖지 않습니다** — 재생성·재시도·
  수정·삭제·provider 전환·오류 신고. 복사처럼 읽기 전용 자료에도 안전한 action은
  유지합니다.

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
| `flag_off` | rollout flag off (이 프로세스의 캐시 기준) | 있음 |
| `flag_off_stale_cache` | DB는 off인데 이 프로세스 캐시는 on — seed loader의 재확인이 잡음(§7.1) | 있음 |
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
- **계수의 단위는 사용자 turn이 아니라 모델 요청입니다.** 모델 셋짜리 turn 하나는
  `/api/chat` 요청 셋이고 outcome도 셋 기록됩니다. 이것이 맞는 단위인 이유는 §5.1이
  네 관문을 요청마다 독립으로 지나가게 하기 때문입니다 — 셋 중 하나만 lock에
  걸리는 상태가 실제로 가능하고, turn 단위로 접으면 그 사실이 사라집니다. 지표를
  읽을 때 "오늘 사유 R로 N**개 모델 요청**이 seed 없이 나갔다"로 읽습니다.
- **rollback 중에는 `flag_off_stale_cache`가 잠깐 올랐다가 0으로 돌아오는 것이
  정상입니다.** 계속 0이면 아직 아무 인스턴스도 캐시가 만료되지 않았거나 그
  경로를 지나는 turn이 없었다는 뜻이고, 계속 0이 아니면 어떤 인스턴스가 flag
  변경을 못 읽고 있다는 뜻입니다. 두 해석이 다르므로 `flag_off`와 합치지
  않습니다.

## 13. 출시 차단 조건

다음 중 하나라도 있으면 staging·production 활성화 불가입니다.

- 외부 message가 일반 `Message`로 복제됨
- `sourceModelLabel`이 runtime `modelId`로 사용됨
- cross-account 또는 lock 우회
- source 삭제 후 원문·seed·memory evidence가 남음
- source 삭제가 새 Tomverse `Message`를 함께 삭제함
- 계정 삭제가 bridge를 남김
- imported prompt가 system/developer 경계를 넘음
- `productKey`가 `review`가 아니거나 누락됨(§3.1), 또는 bridge·`selectedModels`
  개수·`selectionMode`·제목·route에서 `productKey`가 유도됨
- 가져온 원본이 모델 패널마다 복제되거나 `Message`로 복제됨(§5.1)
- 같은 turn의 모델들이 서로 다른 발췌를 받거나, 한 요청이 만든 seed가 다른
  요청에 복사됨(§5.1)
- 클라이언트 요청 본문에 외부 원문이 실림(§5.1)
- 표시된 모델 · preflight가 견적낸 모델 · 실제 요청 모델이 어긋남
- 다중 모델 예상 크레딧이 실제 예약·정산과 어긋남(§4.4)
- 한 모델의 실패가 다른 모델의 답변·예약·정산·환급을 손상시킴(§5.1)
- migration이 기존 continuation의 `selectedModels`를 바꿈(§15)
- flag off가 ordinary chat을 깨뜨리거나 사용자 새 메시지를 숨김
- share·export를 통해 외부 원문이 사용자 동의 없이 공개됨

라벨 조정·breadcrumb·추가 모바일 polish는 데이터·보안 계약이 맞으면 비차단으로
기록할 수 있습니다.

## 14. 알려진 제약과 사람 판단이 필요한 항목

1. **전용 surface의 수명.** continuation은 `productKey=review`이면서도 Review
   workspace가 아니라 `/continuations/[id]`에서 열립니다(§8.2). Review workspace가
   외부 transcript·provenance·tombstone·lock을 다룰 수 있게 되는 날 두 화면을
   합칠지는 사람의 결정이며, 그때 옮길 자리는 `CONTINUATION_SURFACE_PATH`
   한 곳입니다.
2. **기본 조합의 크기.** 새 continuation은 계정의 새 대화 기본 조합으로
   시작하므로(§8.3), 그 조합이 셋이면 첫 turn부터 세 번 청구됩니다. 이어가기만
   더 작은 기본값을 쓸지는 제품 결정이고, 지금은 **일반 Review와 같게** 두는 쪽을
   택했습니다 — 이어가기에만 다른 기본값을 두면 사용자가 저장한 조합이 화면마다
   다르게 해석됩니다.
3. **seed 예산 값.** `CONTINUATION_SEED_TOKEN_BUDGET`은 보수적인 시작값입니다.
   조정은 관측(§12) 뒤의 결정이고, 올리는 것은 매 turn 사용자가 부담하는 비용을
   올리는 일입니다.
4. **share 재개.** §9의 거절은 두 절반의 provenance를 담을 수 있는 share 형식이
   생기면 재검토합니다. 그 전까지 완화하지 않습니다.
5. **staging 검증.** `docs/ops/external-conversation-continuation-staging-checklist.md`
   의 차단 항목이 flag를 켜기 전 완료 조건입니다.

## 15. 기존 continuation 교정 migration

개정 이전에 만들어진 continuation은 `productKey = "chat"`으로 저장돼 있습니다.
그 행들은 **틀린 제품을 기록한 것**이므로 교정합니다.

### 15.1 대상 — bridge 존재 **그리고** `productKey = 'chat'`

```sql
UPDATE "Conversation" AS c
SET "productKey" = 'review'
FROM "ConversationContinuationBridge" AS b
WHERE b."conversationId" = c."id"
  AND c."productKey" = 'chat'
  AND c."selectionMode" <> 'auto';
```

앞의 두 조건이 대상을 정하고, 세 번째는 안전장치입니다.

- **bridge 존재**가 continuation임을 말하는 유일한 사실입니다. §3.1이 정한 그대로,
  provenance는 bridge가 답하고 제품은 컬럼이 답합니다.
- **`productKey = 'chat'`** 조건이 없으면 이 문장은 이미 옳은 행과 아직 결정되지
  않은 `NULL` 행까지 건드립니다. `NULL`은 "아직 안 정해짐"이고 그 해석은
  `docs/policy/conversation-product-key.md` §3이 소유합니다 — 이 migration이
  그것을 대신 결정하지 않습니다.
- **일반 chat 대화에는 닿지 않습니다.** bridge가 없는 행은 `FROM` 절이 걸러냅니다.
- **`selectionMode = 'auto'`인 행은 건드리지 않습니다.** continuation은 `manual`로
  만들어지므로 그런 행은 있을 수 없지만, 있다면 `review + auto`는
  `Conversation_auto_only_chat_check`가 금지하는 조합이라 이 문장이 그 행을
  제약 위반으로 만들게 됩니다. 가정 대신 `WHERE`에 적어 두고, 남은 행은 사람이
  봅니다.

### 15.2 기준으로 쓰지 않는 것

**`selectedModels` 개수 · `selectionMode` · 제목 · route를 판정에 넣지
않습니다.**

- `selectedModels`가 하나라는 것은 그 계정의 기본 조합이 하나였다는 뜻일 뿐이고,
  일반 Review 대화도 그렇습니다.
- `selectionMode`는 manual 복귀가 sticky state를 지우므로 "Auto였던 적이 있나"를
  나중에 물을 수조차 없습니다(`docs/policy/conversation-product-key.md` §1).
- 제목(`Continued from an imported chat`)은 사용자가 언제든 바꿀 수 있는
  값이고, 바꾼 사람의 대화만 교정에서 빠지는 기준은 기준이 아닙니다.
- route는 행에 없습니다.

### 15.3 이 migration이 바꾸지 않는 것

**`productKey` 한 컬럼만 씁니다.**

- **`selectedModels`를 확장하지 않습니다.** 모델 하나로 만들어진 대화는 하나인
  채로 남습니다. 배포가 사용자의 모델 선택을 늘리는 것은 다음 turn마다 몇 배의
  크레딧을 사용자 동의 없이 쓰는 일이고, 되돌릴 수 있는 종류가 아닙니다
  (`AGENTS.md`의 되돌릴 수 없는 것 규칙).
- `selectionMode` · `title` · `kind` · `disabledPanels` · bridge · `Message`를
  건드리지 않습니다. `kind`는 이미 `chat`이고 Review도 `chat`이므로
  `Conversation_product_modality_check`가 교정 후에도 통과합니다.
- **surface가 바뀌지 않습니다.** `conversationSurface()`는 bridge만 읽으므로
  교정 전후로 같은 답을 냅니다. 사용자가 보는 화면은 그대로입니다.

### 15.4 되돌리기

`productKey`를 `chat`으로 되돌리는 문장이 정확한 역연산이며, bridge와
`selectedModels`가 그대로이므로 잃는 정보가 없습니다. 되돌린 뒤에도 화면은 같은
자리에서 열립니다.
