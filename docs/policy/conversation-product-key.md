# Conversation.productKey — 제품 정체성

제품 경계 결정 기록 v1.2 결정 2의 구현 계약입니다. 이 문서는 **컬럼의 의미와
전환 절차**를 정합니다. Auto의 제품 경계는 `docs/ui-contracts/auto-model-selection.md`,
Router 실행 기록은 `docs/policy/tomverse-chat-routing.md`가 소유합니다.

## 1. 두 축은 직교합니다

| 축 | 값 | 무엇인가 |
|---|---|---|
| `kind` | `chat` \| `image` | **서버 authorization·modality 경계** |
| `productKey` | `chat` \| `review` \| `studio` | 사용자가 수행하는 **제품 작업** |

`kind`는 UI 구분이 아닙니다. `lib/conversationKindGuard.ts`가 그 경계를 소유하고,
chat·비교·공유·export·제목 생성 endpoint가 이미지 대화를 거부하며 반대 방향도
거부합니다. 그 파일의 주석이 대가를 적어두었습니다 — *"UI non-exposure is not a
security boundary — every server endpoint checks."*

계획서 §5: **"Do not reuse Conversation.kind as product identity."**

`selectionMode`도 제품을 대신할 수 없습니다. Chat에서 사용자가 모델을 직접 골라도
그 대화는 여전히 Chat입니다. 더 강한 이유가 하나 더 있습니다 —
`selectionModeTransition`이 manual 복귀 시 sticky state를 지우므로
(`Conversation_manual_has_no_sticky_state_check`가 강제), **"Auto였던 적이 있나"를
나중에 물을 수조차 없습니다.** 즉 `selectionMode`는 제품을 유도하는 근거도,
백필의 근거도 될 수 없습니다.

## 2. `code`가 허용값에 없는 이유

전역 브랜드 축에는 Chat·Review·Studio·Code 넷이 있지만 이 컬럼은 셋만 받습니다.
Tomverse Code는 아직 `Conversation` 행을 쓰지 않으므로, 지금 `code`를 허용하면
**아무 실행 표면도 없는 행이 정상값으로 저장**됩니다 — 열 수 있는 화면이 없는
대화입니다. Code가 실제로 Conversation을 쓰기 시작하는 날
`lib/conversationProduct.ts`의 `CONVERSATION_PRODUCT_KEYS`와 DB CHECK에 **함께**
추가합니다. `npm run check:enum-constraints`가 둘의 어긋남을 잡습니다.

## 3. default가 없는 이유

저장소가 이미 같은 판단을 문장으로 남겨두었습니다
(`20260814170000_attempt_cost_accrual`):

> The default goes with the NOT NULL. A column that is nullable but defaults to
> 0 would answer "unknown" with "zero" for every writer that omits it, which is
> the exact substitution the nullability exists to prevent.

`review`를 default로 두면 **productKey를 빼먹은 writer가 Review를 의도한 writer와
구분되지 않습니다.** 전환 기간의 NULL은 "아직 안 정해짐"이고, 그것이 백필의
대상 목록입니다.

## 4. Expand and contract

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | **Expand** — nullable 컬럼 + NOT VALID 제약 3종 | `20260822090000_conversation_product_key_expand` |
| 2 | **Dual-write** — 모든 writer가 productKey 명시 (공통 생성 서비스) | 미착수 |
| 3 | **Dual-read** — NULL을 review로 임시 해석, 만료 있음 | 미착수 |
| 4 | **Backfill** — 분류된 행만, 미분류 0건 게이트 | 미착수 |
| 5 | **Verify** — NULL 0건 연속 2회, writer coverage | 미착수 |
| 6 | **Strict** — `PRODUCT_KEY_READ_MODE` 전환 + rollback rehearsal | 미착수 |
| 7 | **Enforce** — `VALIDATE CONSTRAINT` · `NOT NULL` | 미착수 |

**6·7단계를 expand migration에 넣지 마십시오.**
`tests/integration/conversation-product-key.db.test.ts`가 컬럼이 여전히 nullable
이고 제약 3종이 여전히 `convalidated = false`인지 검사하며, 조기 전환은 그 테스트를
실패시킵니다.

## 5. NOT VALID 제약이 하지 못하는 것

세 제약 모두 `productKey IS NULL`을 통과시킵니다 — 전환 기간에 그래야 하니까요.
**따라서 productKey를 빼먹은 writer가 만든 행은 제약을 전부 통과하고 NULL로
저장됩니다.**

제약은 **잘못된 조합**을 막고, 다음 셋이 **누락**을 막습니다. 셋은 제약과 별개로
계속 필요합니다.

1. 공통 생성 서비스 (`Prisma.TransactionClient`를 받고 자기 트랜잭션을 열지 않음)
2. production 코드의 직접 `conversation.create` 호출을 막는 정적 검사
3. writer coverage 테스트

## 5.1 생성 경로 (구현됨)

| 경로 | productKey | 비고 |
|---|---|---|
| `POST /api/products/review/conversations` | `review` | 서버 상수 |
| `POST /api/products/chat/conversations` | `chat` | 서버 상수. Chat 미출시이므로 **fail-closed** |
| `POST /api/conversations` | `review` | 호환 경로. URL이 Chat/Review를 구분하지 못하므로 Review로 고정 |
| `POST /api/conversations/import-guest` | `review` | 게스트 대화는 멀티 모델 비교였음. import는 소유권을 옮길 뿐 제품을 바꾸지 않음 |
| `lib/imageGenerationService.ts` | `studio` | 이미지 대화 |

**제품은 요청이 아니라 endpoint가 정합니다.** body 필드·`Referer`·임의 header는
"어느 화면에서 왔다"는 클라이언트의 주장이고, 주장에서 유도한 제품 정체성은
서버 파생이 아닙니다. `createConversationSchema`는 `.strict()`이므로 body가
`productKey`를 실어 보내면 무시가 아니라 **거부**됩니다.

`POST /api/products/chat/conversations`는 현재 `autoAvailabilityFor()`
(flag + cohort, 기본 off)가 `offered: false`면 **404**를 반환합니다. 403이 아니라
404이고 본문에 사유가 없는 이유는 거절이 내부 롤아웃 상태이기 때문입니다 —
어느 bucket인지, 비율이 얼마인지, 어떤 readiness gate가 남았는지는 UI 계약 §2가
서버에 두라고 한 것들입니다.

> **이 gate는 잠정입니다.** 결정 기록 §3은 표면 진입 · `offered` · 턴 라우팅
> 셋이 **하나의 공유 제품 판정 함수**를 쓰라고 요구합니다. 그 함수가 들어오면
> 위 호출을 대체합니다. 그때까지는 두 곳이 같은 availability를 읽으므로 최소한
> 서로 어긋나지는 않습니다.

## 5.2 공통 생성 서비스

`lib/conversationCreation.ts`의 `createConversation(tx, input)`.

- `Prisma.TransactionClient`를 받고 **자기 트랜잭션을 열지 않습니다.** 세 writer
  모두 대화와 함께 성립하거나 함께 없어져야 하는 작업을 갖고 있습니다 — capacity
  assertion, import된 메시지, 이미지 예약과 예산 행. 서비스가 자기 트랜잭션을
  열면 호출자가 롤백해도 대화만 남습니다.
- `productKey`는 **선택 인자가 아니라 필수 인자**입니다. optional로 두면 DB
  default를 두지 않은 이유와 같은 치환이 생깁니다 — 생각하지 않은 호출자가
  Review를 의도한 호출자처럼 보입니다.
- `kind`는 제품에서 유도되며(`PRODUCT_MODALITY`), 어긋나는 값을 넘기면 DB가 아니라
  이 함수가 거부합니다. DB 메시지는 제약 이름을 대지만 이 메시지는 호출 지점을
  댑니다.

검증: `npm run check:conversation-writers` (PR Fast Gate),
`tests/conversationWriters.test.mjs`(오탐 포함),
`tests/integration/conversation-writer-product.db.test.ts`.

정적 검사가 `conversation.createdAt`과 `conversation.createMany`를 잡지 않는
것은 의도입니다 — 결정 기록 v1이 `lib/guestImport.ts`와
`app/api/admin/users/[userId]/route.ts`를 writer로 셌던 것이 정확히 그 오독이었고,
두 파일은 대화를 만들지 않습니다.

## 6. 제약 셋

`Conversation_auto_only_chat_check`는 **허용 하나**로 씁니다. v1.1은
`review + auto`만 금지했고 `studio + auto`가 DB상 통과했습니다. "어느 제품이
허용되는가"로 쓴 규칙은 제품이 늘어나도 구멍이 생기지 않습니다.

`Conversation_product_modality_check`가 없으면 `productKey`와 `kind`가 독립
컬럼이라는 사실 때문에 `studio + kind='chat'`이 조용히 통과합니다 — 이미지
파이프라인이 절대 열지 않을 이미지 제품 행입니다.

## 7. 후속 migration 요구사항 (7단계)

**아래 조건이 전부 충족되기 전에는 작성하지 마십시오.**

### 7.1 `VALIDATE CONSTRAINT`

선례: `20260812070000_credit_lot_non_negative` →
`20260815012000_validate_credit_lot_non_negative`.

- production 리포트가 위반 행 **0건**을 보고한 뒤
- 별도 migration으로 실행. **production에서 손으로 validate하지 마십시오** —
  `scripts/compare-schema-to-migrations.mjs`가 `pg_get_constraintdef()`를
  비교하는데 그 출력에 `NOT VALID` 접미사가 실려 있어, 손으로 validate하면
  후속 migration이 없는 동안 내내 schema drift로 잡힙니다.

### 7.2 `NOT NULL`

제약 검증과 NOT NULL 전환은 **같은 것이 아니고 각각 별도 증거를 갖습니다.**

전환 조건 여섯 (결정 기록 §2 종료 조건):

1. NULL 행이 연속 검증 2회 이상 0건
2. 모든 Conversation 생성 경로의 명시적 write 테스트 통과
3. backfill 대상·제외 대상 보고서 보존
4. strict-read 전환 후 오류 0건
5. legacy-read rollback rehearsal 완료
6. `PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT`까지 strict-read 전환

그리고 **NOT NULL 전환 migration은 회귀 조합 8번을 함께 가져와야 합니다** —
같은 입력(NULL)이 전환 전에는 허용되고 전환 후에는 거부된다는 한 쌍이 통과해야
strict 전환이 실제로 일어났음이 증명됩니다. 7번은
`tests/integration/conversation-product-key.db.test.ts`에 이미 있고, 8번은 그
migration의 테스트가 소유합니다. **지금 8번을 작성해 통과하도록 만들지
마십시오** — 오늘 통과하는 8번은 잘못된 것을 검사하고 있는 것입니다.

## 7.3 RoutingRun 쪽

`RoutingRun.productKey`는 같은 허용값을 **실행 시점 스냅샷**으로 들고 있고
(`RoutingRun_product_key_check`, 역시 NOT VALID), 목록은 이 문서와 같은
`CONVERSATION_PRODUCT_KEYS` 하나입니다. 두 목록이 따로 있으면 어떤 대화도 가질 수
없는 제품을 run이 주장할 수 있게 됩니다.

cutover 이후 필수 강제 방식과 그 근거는
`docs/policy/routing-run-product-attribution.md` §5에 있습니다.

## 8. 데이터 수명

`productKey`는 `Conversation`의 평범한 컬럼이므로 별도 수명이 없습니다.

- **계정 삭제** — `Conversation`은 `User`에서 `onDelete: Cascade`이고 데이터 도메인
  registry의 `deletionAction: delete` · `deletionMechanism: cascade_from_user`가
  그대로 적용됩니다. 이 컬럼이 그것을 바꾸지 않습니다.
- **익명화** — 해당 없음. `Conversation`은 익명화 대상이 아니라 삭제 대상입니다.
- **통합 export** — `lib/accountDataExport.ts`의 명시적 allowlist select에
  포함됩니다. `kind`와 같은 부류이기 때문입니다: 서버가 정한 identity이고 제품
  화면에서 사용자가 볼 수 있으므로, 빠뜨리면 export가 화면보다 좁아집니다.
