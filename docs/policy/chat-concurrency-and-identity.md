# 동시 실행 제한과 identity namespace

프로덕션에서 연속으로 보고된 두 오류의 후속 조치 문서입니다. 두 오류는 서로
독립적인 원인을 가지며, 각각 다른 층에서 고쳤습니다.

| Trace | 증상 | 근본 원인 |
|---|---|---|
| `24367791-…` | `POST /api/chat` 429 `CHAT_CONCURRENCY_EXCEEDED` | 게스트 동시 실행 lease가 **IP**로 묶여 있었다 |
| `7ad29764-…` | `GET /api/conversations/guest_*` 403 `CONVERSATION_FORBIDDEN` | 로그인 후에도 client가 **guest namespace의 대화 ID**를 들고 있었다 |

관련 파일을 바꾸기 전에 읽어 주세요.

- `lib/chatConcurrencyCore.ts` (순수 — scope·한도·문구·TTL)
- `lib/chatAdmissionCore.ts` (순수 — admission token)
- `lib/chatRequestLease.ts` (DB — lease 생성·claim·heartbeat·회수)
- `lib/chatSecurity.ts`의 `preflightChatComparisonAccess` / `acquireChatAccess`
- `lib/chatIdentityNamespace.ts` (순수 — client 상태 invariant)
- `app/(site)/(application)/chat/ChatPageClient.tsx`의 identity 전환 effect

## 1. 세 개의 층을 섞지 않는다

`docs/policy/credit-and-cost-limits.md`가 entitlement와 operational guardrail을
분리한 것과 같은 이유로, **동시 실행은 세 번째 층**입니다. "지금 이 순간 몇 개가
흐르고 있는가"를 제한할 뿐 크레딧·플랜·비용과 아무 관계가 없습니다.

| 층 | 무엇 | `limitLayer` | 오류 코드 |
|---|---|---|---|
| User entitlement | 플랜·구매 크레딧 | `entitlement` | `PLAN_ENTITLEMENT_EXHAUSTED` 등 |
| Operational guardrail | 비용 폭증·provider 사고 | `operational_guardrail` | `OPERATIONAL_COST_GUARDRAIL_TRIGGERED` 등 |
| **주체 동시 실행** | 이 사용자/게스트가 지금 돌리는 응답 수 | `concurrency` | `CHAT_CONCURRENCY_EXCEEDED` |
| **IP 집계 상한** | 익명 트래픽의 남용 천장 | `operational_admission` | `CHAT_IP_CONCURRENCY_EXCEEDED` |
| **주체 분당 요청 rate** | 이 사용자/게스트가 이번 분에 보낸 요청 수 | `rate_limit` | `CHAT_RATE_LIMITED` (`scope: *_rate_minute`) |
| **IP 분당 요청 rate** | 이 공인 IP가 이번 분에 보낸 요청 수 | `operational_admission` | `CHAT_RATE_LIMITED` (`scope: ip_rate_minute`) |

문구도 층마다 다릅니다. 크레딧이 없어서 막힌 사람과 자기 답변이 아직 돌고 있어서
막힌 사람과 옆자리 사람 때문에 막힌 사람에게 같은 문장을 보여 주면, 셋 중 둘은
할 수 있는 일이 없습니다.

## 2. 게스트 동시 실행은 쿠키 기준이다

**바뀐 것:** `acquireChatAccess`가 게스트 lease를 `access.ipKey`로 저장했습니다.
NAT 하나 뒤의 모든 게스트가 한도 3개를 나눠 썼고, 3모델 비교 한 번이 그 한도를
전부 소진했습니다. 보고된 사건이 정확히 이것입니다 — 같은 공인 IP, 서로 다른
기기·User-Agent, 서로 다른 guest cookie.

계약:

- 개별 게스트의 동시 실행 한도는 **signed guest cookie에서 파생된
  `access.subjectKey`**를 씁니다(`CHAT_GUEST_CONCURRENT`, 기본 3).
- 로그인 사용자는 계정 subjectKey를 씁니다(`CHAT_USER_CONCURRENT`, 기본 3).
  계정 자체가 책임 단위이므로 IP scope를 두지 않습니다.
- **IP 집계 상한은 별개 층으로 남깁니다**(`CHAT_IP_CONCURRENT`, 기본 24).
  guest subject는 쿠키를 지우면 새로 만들 수 있으므로, 상한이 없으면 스크립트
  하나가 무제한 스트림을 열 수 있습니다. 게스트에게만 적용합니다.
- **IP 상한은 게스트 한도 아래로 내려갈 수 없습니다.** 설정값이 더 낮으면 바닥까지
  올려 적용합니다(`ipCeilingClamped`). 그렇지 않으면 집계 scope가 다시 개인 한도가
  됩니다 — 이 분리가 없애려는 결함 그 자체입니다.
- **IP 기준 분당 rate limit, 일일 요청량, 토큰·비용 abuse protection은 그대로**
  입니다(`guest-ip-*`, `ip-tokens-*`, `ip-cost-*` 버킷). 동시 실행 scope를 나눈
  것이지 IP 보호를 없앤 것이 아닙니다.
- `CHAT_GUEST_CONCURRENT`를 올려서 덮지 않습니다. 기본값 3은 그대로입니다.

한 lease 행이 두 scope에서 세어집니다(`subjectKey` + `ipKey`). 행이 하나이므로
해제할 것도 하나입니다.

## 3. 다중 모델 admission은 전부 아니면 전무

3모델 비교는 사용자 행동 하나지만 `POST /api/chat` 세 개입니다. 각 요청이 도착
순서대로 슬롯을 잡으면, 한도가 3이고 다른 하나가 이미 돌고 있을 때 두 개는
시작하고 하나는 429가 됩니다 — 사용자에게는 "세 개 중 두 개만 답했다"입니다.

계약:

1. **aggregate preflight(`POST /api/chat/preflight`)가 한 transaction 안에서
   필요한 슬롯 수를 원자적으로 확인하고 예약합니다.** 게스트도 이 경로를 탑니다.
   승인되면 모델마다 `claimedAt IS NULL`인 lease 행이 하나씩 미리 만들어집니다.
2. **admission token**(`lib/chatAdmissionCore.ts`)이 발급됩니다. 앱 secret으로
   서명되고, 발급한 subjectKey에 묶이고, 짧은 만료(`CHAT_ADMISSION_TTL_SECONDS`,
   기본 60초)를 가집니다. 위조·수정·다른 guest session 재사용·만료 후 사용이
   모두 거부됩니다.
3. **각 모델 요청이 자기 슬롯을 claim**합니다. claim은 조건부 UPDATE
   (`claimedAt IS NULL AND expiresAt > NOW()`)이므로, 유효기간 안의 replay도
   두 번째 슬롯을 얻지 못합니다. token은 **어느 슬롯을 쓸지만** 정하며, 모델
   접근 권한·대화 소유권·플랜·크레딧·비용 guardrail은 요청마다 전부 다시
   검사합니다.
4. **중간 실패는 되감깁니다.** preflight transaction이 실패하면 슬롯도 함께
   사라지고, 승인 뒤 비교가 중단되면 `rollbackChatAdmission()`이 claim되지 않은
   슬롯을 즉시 반납합니다. 아무것도 오지 않아도 admission TTL이 스스로 회수합니다.
5. **token이 없거나 무효하면** 요청은 평소의 1슬롯 경로를 탑니다. 실패로 만들지
   않습니다 — admission은 UX 계약이지 보안 경계가 아닙니다.
6. preflight 자체가 인프라 사유로 응답하지 못하면(500/503) client는 한 번
   재시도한 뒤 **열어 둡니다**. 진짜 판정(429·403)은 그대로 막습니다.

## 3.1 분당 요청 rate도 같은 계약을 따른다

**바뀐 것:** 동시 실행 슬롯은 전부 아니면 전무로 예약했지만, **분당 요청
rate는 preflight에서 읽기만 하고 실제 증가는 모델 요청마다** 일어났습니다.
게스트는 그 읽기조차 없었습니다. `CHAT_GUEST_PER_MINUTE=5`에 이번 분 3회를
쓴 게스트가 3모델 비교를 보내면, preflight를 통과하고 두 패널이 버킷을 4·5로
올린 뒤 세 번째가 `chat_reservation` 단계에서 `CHAT_RATE_LIMITED` 429가
됐습니다 — 정확히 admission이 없애려던 부분 실행입니다(Trace `c7216139-…`).

계약:

- **preflight가 `모델 수`만큼의 분당 용량을 원자적으로 예약합니다.** 게스트도
  로그인 사용자도, 주체 버킷(`CHAT_GUEST_PER_MINUTE` / `CHAT_USER_PER_MINUTE`)과
  IP 버킷(`CHAT_IP_PER_MINUTE`) **양쪽 모두**입니다. 조건부 UPDATE 하나가 전량을
  올리거나 아무것도 올리지 않으므로, 확인과 사용 사이에 다른 탭이 끼어들어도
  일부만 실행되지 않습니다. 읽기 검사로 되돌리지 않습니다.
- **IP 분당 상한은 로그인 사용자에게도 적용합니다.** IP 동시 실행 상한(§2)은
  게스트 전용이지만, 분당 rate 상한은 `acquireChatAccess`가 늘 모든 요청에
  부과해 왔습니다. preflight에서 게스트만 검사하면 로그인 사용자의 비교가
  preflight를 통과하고 패널 하나를 IP 상한에 잃습니다.
- **슬롯을 claim한 모델 요청은 분당 버킷을 다시 올리지 않습니다.** claim은
  transaction 맨 앞에서 일어나고, 성공한 경우에만 주체·IP 분당 증가를
  건너뜁니다. claim에 실패한 요청(위조·재사용·만료·타 subject)은 평소대로 전액을
  스스로 부담하므로, admission token은 **슬롯만 정하고 rate를 면제하지
  않습니다**.
- **쓰지 않은 예약은 돌려줍니다.** preflight transaction이 실패하면 예약도 함께
  사라지고(두 scope 중 뒤쪽이 거절해도 앞쪽 차감이 남지 않습니다),
  `rollbackChatAdmission()`과 만료 lease sweep이 claim되지 않은 슬롯의 분당
  용량을 즉시 반납합니다. 슬롯이 어느 버킷을 얼마나 샀는지는 lease 행의
  `rateIpKey`·`rateMinuteStart`에 적혀 있어, 분이 넘어간 뒤 도착한 rollback도
  **자기가 차감한 그 버킷**을 되돌립니다.
- **거절 응답은 429 + `CHAT_RATE_LIMITED` + `Retry-After` ≥ 1 +
  `details.retryAfterSeconds`(같은 값) + 미래의 `resetAt`** 입니다. `scope`가
  주체(`guest_rate_minute`·`user_rate_minute`)와 IP(`ip_rate_minute`)를 가르고,
  `limitLayer`는 각각 `rate_limit`·`operational_admission`입니다 —
  `entitlement`로 기록하지 않습니다.
- **client는 자동으로 재시도하지 않습니다.** 현재 언어의
  `chat.tooManyRequestsRetry`에 서버가 준 초를 넣어 보여 주고 Trace ID를
  유지하며, 작성 중인 draft와 첨부는 그대로 둡니다. 500/503의 한 번 재시도는
  인프라 실패용이며 429에는 적용되지 않습니다.
- **한도 기본값(5 / 20 / 40)을 올려 덮지 않고, IP 보호를 제거하지 않습니다.**
  단일 모델 요청의 서버 측 검사도 그대로입니다.

## 4. lease 수명

**바뀐 것:** lease 만료가 고정 120초였습니다. 프로덕션에서 정상 응답이 125초까지
쓰고 있었고, 그 시점에 lease는 이미 만료돼 다른 요청이 슬롯을 가져갈 수 있었습니다.

상수를 키우는 것은 답이 아닙니다 — 10분짜리 정상 응답은 어떤 상수도 넘습니다.

- TTL은 짧게 두고(`CHAT_LEASE_TTL_SECONDS`, 기본 180초, 60–1800초로 clamp),
  **스트림이 돌면서 스스로 갱신**합니다(TTL의 1/3 간격 heartbeat).
- 죽은 프로세스는 갱신을 멈추므로 슬롯이 TTL 하나 안에 풀립니다.
- **completed · provider error · client cancellation · client disconnect ·
  stream construction failure · deep research 비동기 인계** 모두에서 결정적으로
  해제합니다. deep research는 요청이 끝나는 자리에서 소유권을 넘기므로 lease도
  그 자리에서 해제합니다.
- `releaseChatAccess()`는 멱등이며 실패 시 재시도합니다. 그래도 실패하면
  `chat_lease_release_failed` 구조화 이벤트와 operational incident로 남습니다 —
  `console.error`로 잃어버리지 않습니다.
- **orphan 정리 경로**: `reconcileExpiredChatRequestLeases()`가 15분 주기
  maintenance(`/api/internal/maintenance/credit-reservations`)에서 만료 행을
  제거하고 `chat_lease_reconciliation`으로 개수를 남깁니다. 일일 cleanup은 너무
  느립니다 — orphan 하나는 실제 사용자가 기다리는 슬롯 하나입니다.

## 5. Identity namespace (guest → account)

**바뀐 것:** guest→authenticated 전환에서 `currentChatId`/`currentChatIdRef`의
`guest_*` ID가 그대로 남았습니다. 그러면

- signed-in restore 로직이 `currentChatId`가 있다고 보고 복구를 건너뛰고,
- 대화 상세 조회·model settings 동기화·비교 패널 3개의 history 조회가 모두
  `guest_*`를 계정 API에 보내고,
- 서버가 DB row를 찾지 못해 `CONVERSATION_FORBIDDEN`을 반복해서 돌려줍니다.

### 상태 전환

```
                    session 미해결
                    ┌──────────────┐
                    │ unresolved   │   어떤 ID도 API로 보내지 않는다
                    └──────┬───────┘
                           │ 세션 확정 (initial: 아무것도 이월하지 않음)
              ┌────────────┴────────────┐
              ▼                         ▼
      ┌───────────────┐         ┌────────────────┐
      │ guest         │  sign in │ account(userId)│
      │ guest_* ID만  │────────▶│ 서버 ID만       │
      └───────────────┘         └────────────────┘
              ▲   ▲                    │      │
              │   └────── sign out ────┘      │ account switch (A→B)
              │                                ▼
              │                       ┌────────────────┐
              └───────────────────────│ account(other) │
                                      └────────────────┘

전환 시 하는 일 (useLayoutEffect — 모든 passive effect보다 먼저):
  1. identity epoch 증가 → 이전 namespace에서 시작한 작업은 기록하지 않는다
  2. guest→account이면 열려 있던 guest 대화 ID를 ref에 보관 (import modal 기본값)
  3. 새 namespace에 속하지 않는 currentChatId / currentChatIdRef 를 분리
  4. sessionStorage의 active chat ID 제거
  5. stale ID 집합 초기화, promptPayload 취소

전환 시 하지 않는 일:
  - guest 대화 데이터(localStorage) 삭제  ← import를 위해 반드시 보존
  - 서버 소유권 검사 완화
```

`selectionAfterIdentityTransition()`은 **account ID를 어떤 전환에서도 이월하지
않습니다.** 문자열만 보고는 어느 계정 것인지 알 수 없기 때문입니다. guest ID는
이 브라우저의 guest namespace만 만들 수 있으므로 sign out 후에도 유지됩니다.

### client invariant vs 서버 소유권

계정 API(`/api/conversations/:id`, `/api/chat/preflight`, `/api/chat`, model
settings·metadata)에는 **현재 identity namespace에 속한 서버 Conversation ID만**
전달합니다(`accountConversationId()`).

**이것은 보안 경계가 아닙니다.** `guest_` 접두사 검사로 접근 제어를 할 수는
없습니다. 소유권은 계속 서버가 row를 읽어 `userId`를 비교해 정합니다. client
검사는 **이미 틀린 줄 아는 요청을 보내지 않기 위한 상태 invariant**입니다.

### stale 대화 복구

`CONVERSATION_FORBIDDEN`이 오면:

- 서버의 403 계약은 그대로입니다. 실제 남의 대화는 열리지 않습니다.
- client는 그 ID를 **한 번만** stale로 표시하고 선택을 해제합니다. 재요청하지
  않으므로 세 패널이 같은 403을 반복하지 않습니다.
- 작성 중인 입력(draft)과 guest import snapshot은 삭제하지 않습니다.
- 사용자에게는 내부 소유권 문구 대신 중립적인 안내를 보여 줍니다
  (`chat.conversationUnavailableSwitched`).
- readiness는 어느 경로로 나가든 반드시 해결됩니다. skeleton이 영구히 멈추지
  않습니다.

## 6. 관측

- `chat_limit_decision` — `limitLayer`가 `concurrency` / `operational_admission`
  / `rate_limit`으로 기록됩니다. 동시 실행과 분당 rate를 entitlement로 오인
  기록하지 않습니다. `limitScope`로 주체·IP를 가릅니다.
- `chat_concurrency_rejected` — lease scope, active count, requested slots,
  concurrent limit, lease TTL, comparison ID. subject는 해시된 usage key이고
  **원시 IP·PII·lease key·내부 USD는 넣지 않습니다.**
- `chat_admission_rejected` / `chat_admission_claim_missed` — token 거부 사유와
  슬롯 claim 실패.
- `chat_lease_release_failed` / `chat_lease_reconciliation` — orphan 지표.
- `chat_conversation_id_namespace_violation` /
  `chat_stale_conversation_released` — client가 막은 잘못된 요청과 복구.

## 7. 바꾸기 전에

- `CHAT_GUEST_CONCURRENT`를 올려서 문제를 덮지 않습니다.
- lease TTL을 근거 없이 늘리지 않습니다. 긴 응답은 heartbeat가 담당합니다.
- IP rate limit·토큰·비용 abuse protection을 제거하거나 guest subject 한도로
  합치지 않습니다.
- IP 상한을 새로 추가한다면 고유한 환경변수·오류 코드·로그 필드·사용자 문구를
  씁니다.
- 서버 Conversation 소유권 검사를 약화하지 않습니다. `guest_*`를 DB Conversation
  ID로 인정하지 않습니다.
- 403을 무조건 재시도하거나 200으로 바꾸지 않습니다.
- 로그인 시 guest localStorage 전체를 삭제하지 않습니다.
- 분당 rate 예약을 읽기 전용 검사로 되돌리지 않습니다. admission token이 rate
  까지 면제하도록 확장하지 않습니다.
- 관련 테스트: `tests/chatConcurrencyCore.test.mjs`,
  `tests/chatAdmissionCore.test.mjs`, `tests/chatRateLimitCore.test.mjs`,
  `tests/chatIdentityNamespace.test.mjs`,
  `tests/integration/chat-concurrency.db.test.ts`,
  `tests/integration/chat-rate-limit.db.test.ts`,
  `tests/server-contract/chat-preflight-rate-limit.test.ts`,
  `tests/e2e/comparison-rate-limit.spec.ts`,
  `tests/e2e/guest-account-identity-transition.spec.ts`.
