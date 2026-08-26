# RoutingRun 제품 귀속 — 결정 기록

제품 경계 결정 기록 v1.2 §5의 구현 결정입니다.
migration: `20260822093000_routing_run_product_attribution`.

## 1. 맥락

`BeginDispatchInput`은 `conversationId?: string | null`을 **받고 있었고**,
`prisma.routingRun.create({ data: ... })`는 그 값을 **쓰지 않았습니다.** `mode`와
`traceId`는 들어가는데 그것만 빠져 있었습니다.

그리고 `assistantMessageId`는 **성공한 실행에만** 생깁니다. 즉 실패한 run은 어느
대화의 것인지 알 방법이 아예 없었습니다. ROUTE-07이 `not_dispatched` 종료까지
분모에 넣으라고 요구하는데, 그 분자 쪽을 제품별로 쪼갤 수가 없었습니다.

## 2. 컬럼 둘, 서로 다른 일

| 컬럼 | 무엇 | 없으면 |
|---|---|---|
| `productKey` | 실행 시점 **스냅샷** | 대화가 지워지면 평가 세그먼트가 사라짐 |
| `conversationId` | **조인** | 운영 조회가 `traceId`로만 가능 |

스냅샷은 조인에서 유도할 수 없습니다. **조인은 끊어져도 되기 때문입니다** — 그게
다음 절의 요점입니다.

## 3. Cascade가 아니라 SetNull

지금 `RoutingRun`은 대화 삭제와 무관하게 살아남습니다 — FK가 아예 없으니까요.
FK를 Cascade로 붙이면 그 성질이 **조용히** 바뀝니다: 사용자가 대화를 지우는 순간
그 턴들의 평가 데이터가 사라지고, ROUTE-01의 표본과 ROUTE-07의 분모가 라우팅과
무관한 사용자 행동에 따라 줄어듭니다.

SetNull이면 **조인은 끊기고 스냅샷은 남습니다.** `ChatCreditReservation.userId`가
정확히 같은 패턴이고 같은 이유입니다 — 금융 행이 계정보다 오래 사는 것.

**계정 삭제는 바뀌지 않습니다.** `RoutingRun.userId → User`는 지금도
`onDelete: Cascade`이고 그대로 둡니다. 계정을 지우면 그 계정의 run 전체가 여전히
삭제됩니다. 데이터 도메인 정책이 그렇게 정한 것이며 이 결정은 그것을 바꾸지
않습니다 — **제품 귀속을 대화 삭제로부터만** 지킵니다.

## 4. `@@index([conversationId])`는 선택이 아닙니다

PostgreSQL은 PRIMARY KEY와 UNIQUE에는 인덱스를 만들지만, 외래 키가 **참조하는
쪽** 컬럼에는 만들지 않습니다. `ON DELETE SET NULL`은 참조 행을 찾아야 하므로,
인덱스가 없으면 **대화 하나를 지울 때마다 `RoutingRun` 전체를 순차 스캔**합니다.
그리고 그 테이블은 서비스하는 턴마다 커집니다.

## 5. 결정 — cutover 이후 `productKey` 필수를 무엇으로 강제할 것인가

과거 행이 NULL로 남아야 하므로 **컬럼 자체를 NOT NULL로 만들 수 없습니다.**
두 가지 방법을 비교했습니다.

### 안 A — 부분 CHECK (`createdAt > cutover → productKey IS NOT NULL`)

- 장점: DB가 강제하므로 writer가 몇 개든 새로 생겨도 뚫리지 않습니다.
- 단점 1: **cutover 시각을 SQL에 상수로 박아야 합니다.** 이 저장소의 어떤
  migration도 그렇게 하고 있지 않고, 배포가 밀리면 상수가 틀립니다. 상수를
  고치려면 CHECK를 DROP하고 다시 만들어야 하고, 그때마다 재검증이 붙습니다.
- 단점 2: **정당하게 NULL인 신규 run이 존재합니다.** 대화가 없는 턴 — 게스트
  turn — 은 읽어 올 `Conversation` 행 자체가 없습니다. 그런 run에 제품을 써 넣으면
  존재하지 않는 대화에 대한 주장이 됩니다. 부분 CHECK는 이 정상 경로를 실패시키므로
  예외 조건(`conversationId IS NULL OR ...`)이 붙고, 그 예외가 정확히 이 CHECK가
  막으려던 구멍이 됩니다.

### 안 B — writer coverage (**채택**)

> **정정 (2026-08-24).** 이 절은 원래 *"`RoutingRun`을 만드는 곳은
> `beginInstrumentedDispatch` **한 곳**"*이라고 썼습니다. **사실이 아니었고,
> 쓰인 시점에 이미 아니었습니다.** 아래에 실제 writer 둘을 적습니다. 채택안은
> 유지하되, 근거를 "하나뿐이라 안전하다"에서 "둘 다 덮었고 테스트가 고정한다"로
> 바꿉니다.

- `RoutingRun`을 만드는 곳은 **둘**입니다.

  | writer | 쓰는 행 | `conversationId`·`productKey` |
  |---|---|---|
  | `lib/routingDispatchInstrumentation.ts`의 `beginInstrumentedDispatch` | 디스패치된 turn | 채움 |
  | `lib/routingShadow.ts`의 `recordRoutingShadowRun` | shadow 평가 | 채움 (2026-08-24부터) |

- 두 곳 모두 호출부에서 두 값을 받습니다. `app/api/chat/route.ts`의 같은 스코프에
  `conversationId`와 `conversationProductKey`가 이미 있으므로, shadow 쪽이 그것을
  안 넘기고 있었을 뿐입니다.
- 테스트가 고정합니다 — `tests/routingShadow.test.mjs`가 두 값이 실려 나가는 것과,
  대화가 없을 때 **필드가 사라지지 않고 `null`로 남는** 것을 각각 봅니다.
  되돌리면 그 둘이 실패하는 것까지 확인했습니다.
- 허용값은 여전히 DB가 강제합니다 — `RoutingRun_product_key_check`가
  `Conversation_product_key_check`와 같은 목록을 NOT VALID로 들고 있으므로,
  `insight`나 `code`가 들어오면 거부됩니다. **막지 못하는 것은 누락이고, 누락은
  writer 수만큼의 검사 대상입니다.**

**근거**: 저장소 관례는 "제약은 잘못된 값을, 코드와 테스트는 누락을"입니다
(`docs/policy/conversation-product-key.md` §5). 안 A는 유지 비용이 상수 하나에
묶여 있고 정당한 NULL 때문에 예외를 요구하는데, 그 예외가 바로 구멍입니다.

### 이 결정이 어떻게 뚫렸는가

원래 "다시 볼 조건"은 *"두 번째 writer가 생기면 이 결정을 다시 읽는다"*였습니다.
**두 번째 writer는 생긴 것이 아니라 이미 있었습니다.** 조건이 미래형으로 쓰였기
때문에, 이미 충족돼 있다는 사실을 아무도 확인하지 않았습니다.

발견은 코드 리뷰가 아니라 **staging 실행**에서 나왔습니다. 한 turn 뒤에 행이 둘
쓰였고, `manual` 행은 대화를 담았는데 2초 뒤 `shadow` 행은 비어 있었습니다
(`docs/ops/product-boundary-v1-2-staging-verification-records/`의 2026-08-24 기록,
발견-1).

### 다시 볼 조건

**`RoutingRun`을 만드는 세 번째 writer가 생기면** 이 결정을 다시 읽습니다. 그때는
`Conversation`이 그랬듯 공통 서비스 + 정적 검사(`check:conversation-writers`에
해당하는 것)가 필요해집니다.

지금은 만들지 않았습니다. writer가 둘이고 둘 다 같은 호출부에서 같은 두 변수를
받으므로, 검사 하나를 더 유지하는 비용이 그것이 막는 위험보다 큽니다. **그 판단이
뒤집히는 지점이 세 번째 writer입니다** — 이 문단이 그 지점을 미래형이 아니라
**세는 방법**으로 적어 두는 이유입니다.

## 6. 과거 행을 추정하지 않습니다

기존 `RoutingRun`에 제품을 채워 넣지 않습니다. 근거가 없기 때문입니다 —
`Conversation.productKey` 백필이 `selectionMode`로 분류하기를 거부하는 것과 같은
이유입니다. NULL은 "이 실행의 제품이 기록되지 않았다"는 사실이고, 그것이 참입니다.

## 7. 아직 하지 않은 것

- `VALIDATE CONSTRAINT` — `RoutingRun_product_key_check`는 NOT VALID입니다.
- cutover 시각 확정과 그 시점 이후의 writer coverage 강제 테스트.
- 대화 없는 turn(게스트)의 제품 귀속. 결정 기록 §6은 화면의 제품
  (`surfaceProductKey`)과 실행 권한을 분리하고 **실제 dispatch에서
  surfaceProductKey fallback을 금지**합니다. 대화가 없는 turn을 어떻게 귀속할지는
  그 규칙 아래에서 별도로 결정합니다.
