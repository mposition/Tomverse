# Prisma Postgres 운영비 절감 분석 (2026-09-01)

Tomverse Chat·Tomverse Code가 합류하기 전에 DB 운영비의 구조를 확인하고,
줄일 수 있는 선택지를 비용·리스크·작업량과 함께 정리합니다.

**이 문서는 보고서이지 게이트가 아닙니다.** 어느 선택지를 실행할지는 사람이
정합니다. 다만 §1의 과금 구조와 §3의 측정값은 어느 선택을 하든 먼저 알아야
하는 사실입니다.

---

## 0. 요약

세 문장으로 줄이면 이렇습니다.

1. **Prisma Postgres는 "쿼리 1건 = 과금 1건"입니다.** 이 앱은 채팅 한 턴에
   **약 45~70개의 DB 연산**을 씁니다. 즉 DB 비용이 사용자 수가 아니라
   **턴 수 × 60**에 비례해서 자랍니다. Chat·Code가 붙으면 이 계수가 그대로
   곱해집니다.
2. **가장 비싼 흐름은 채팅이 아니라 Deep Research입니다.** 5초 고정 폴링이라
   20분짜리 요청 하나가 **약 1,700 ops** — 일반 턴의 25배 — 를 씁니다.
   백오프만 넣어도 이 흐름에서 70%가 사라집니다.
3. **구조적으로는 per-operation 과금이 이 제품 모양과 맞지 않습니다.**
   같은 워크로드를 고정 인스턴스 과금(Railway Postgres 등)으로 옮기면 사용량이
   늘어도 요금이 선형으로 늘지 않습니다. 그리고 이 저장소는 **PostgreSQL 확장
   의존이 0건**이라 이전 자체는 기술적으로 막히는 곳이 없습니다.

권장 순서는 §7입니다. **§5-A~C(코드 최적화)는 이전 여부와 무관하게 이득**이고,
이전을 하더라도 CPU·메모리 사용량을 그대로 줄이므로 먼저 합니다.

---

## 1. 지금 무엇에 돈을 내고 있는가

`lib/infrastructureMonitoring.ts:533`이 이미 Prisma Management API에서 읽고 있는
그대로, Prisma Postgres의 과금 축은 **operations**와 **storage** 둘입니다.

2026년 9월 기준 공개 요금([Prisma pricing](https://www.prisma.io/pricing) 기반
공개 정리):

| 플랜 | 월 정액 | 포함 ops | 포함 storage | ops 초과 | storage 초과 |
|---|---|---|---|---|---|
| Free | $0 | 100K | 500 MB | — | — |
| Starter | $10 | 1M | 10 GB | $0.08 / 10K = **$8/M** | $2 / GB |
| Pro | $49 | 10M | 50 GB | $0.02 / 10K = **$2/M** | $1.5 / GB |
| Business | $129 | 50M | 100 GB | $0.01 / 10K = **$1/M** | $1 / GB |

여기서 바로 읽어야 할 두 가지가 있습니다.

- **초과 단가가 플랜마다 8배 차이입니다.** 같은 1M ops 초과가 Starter에서는
  $8, Business에서는 $1입니다. 사용량이 이미 플랜을 넘고 있다면, 코드를 한 줄도
  안 고치고 **상위 플랜으로 올리는 것만으로 초과분 단가가 1/8~1/2**이 됩니다.
  이것이 가장 먼저 확인할 항목입니다.
- **ops 할당량은 데이터베이스가 아니라 계정 단위**입니다. Tomverse Chat과 Code를
  별도 DB로 분리해도 같은 계정이면 같은 통에서 빠집니다. "분리하면 각자
  무료 티어" 같은 절감은 없습니다.

---

## 2. 추정 이전에 실측을 먼저 봅니다

아래 §3의 숫자는 **코드에서 센 정적 추정**입니다. 실제 청구는 실측으로만
답할 수 있고, 이 저장소에는 이미 읽는 경로가 둘 있습니다.

**(a) Admin Console** — `/admin` 인프라 패널이
`GET /api/admin/infrastructure`로 `operationsUsed`, `operationsLimit`,
`storageGiB`, 청구 기간을 그립니다(`lib/infrastructureMonitoring.ts:533`).
`PRISMA_MANAGEMENT_API_TOKEN`·`PRISMA_DATABASE_ID`가 이미 production에
설정돼 있습니다.

**(b) Management API 직접 호출** — 같은 값을 손으로 읽습니다.

```
curl -sS -H "Authorization: Bearer $PRISMA_MANAGEMENT_API_TOKEN" \
  "https://api.prisma.io/v1/databases/$PRISMA_DATABASE_ID/usage?startDate=2026-09-01T00:00:00Z&endDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

**(c) 턴당 ops 실측** — `lib/prisma.ts`가 이미 `PRISMA_CLIENT_LOG`를 읽습니다.
staging에서 `PRISMA_CLIENT_LOG=query`로 배포하고 요청 하나를 보낸 뒤 그 요청의
`query` 로그 줄 수를 세면, §3의 표를 실측으로 대체할 수 있습니다.
production에서는 켜지 마세요 — 로그 자체가 비용이고 쿼리 본문이 남습니다.

이 세 값(월 ops, storage GB, 턴당 ops)을 확보한 뒤에 §5의 선택지를 고르면,
"몇 % 줄어드는가"를 추측이 아니라 계산으로 말할 수 있습니다.

---

## 3. ops는 어디서 나오는가 (정적 측정)

### 3.1 채팅 한 턴 — 로그인 사용자, 단일 모델, 첨부·검색 없음

| 단계 | 위치 | ops |
|---|---|---|
| 세션 보안 스냅샷 (15초 TTL 캐시, 미스 시) | `lib/sessionSecurity.ts:78` | 0–1 |
| `getUserBillingPlan` | `lib/billingEntitlements.ts:22` | 1 |
| `getRuntimeModels` — **캐시 없음**, 매번 42행 `findMany` | `lib/modelRegistry.ts:276` | 2–4 |
| 대화 · 이전 메시지 · provider context 조회 | `app/api/chat/route.ts:1244,1692,1846` | 3 |
| **`acquireChatAccess`** — 한 interactive transaction 안 | `lib/chatSecurity.ts:2318` | **18–24** |
| `reserveAttemptProviderBudget` | `lib/chatSecurity.ts:4658` | 4 |
| RoutingRun · RoutingAttempt · ContextManifest 기록 | `lib/routingAttemptStore.ts` | 3 |
| lease heartbeat (TTL/2 주기, 스트리밍 중 반복) | `app/api/chat/route.ts:4149` | 1 × N |
| user·assistant 메시지 + MessageProviderContext 저장 | `app/api/chat/route.ts` | 3 |
| `ChatAttemptUsage` | `lib/chatAttemptCostLedger.ts` | 1 |
| `settleChatUsage` | `lib/chatSecurity.ts:3612` | 5–7 |
| `recordProviderSuccess` + `recordModelSuccess` | `lib/providerMonitoring.ts:887,904` | 5 |
| `releaseChatAccess` | `lib/chatRequestLease.ts:239` | 1 |
| `ChatLimitDecisionEvent` | `lib/chatLimitDecisions.ts` | 1 |
| `ProductAnalyticsEvent` | `lib/productAnalyticsServer.ts:149` | 1 |
| **합계** | | **≈ 45–70** |

`acquireChatAccess` 하나가 전체의 40%입니다. 내역은 credit account 잠금,
advisory lock, 만료 lease 청소, billing risk 조회, 월 비용 버킷 조회,
`incrementUsage` 7~9회(분·일·월 요청, IP 분, 비용 일·월, provider 일·월),
`readUsageCount` 1~2회, 크레딧 lot 예약, lease insert, reservation create,
limit decision 기록입니다.

**이것은 낭비가 아니라 계약입니다.** `docs/policy/credit-and-cost-limits.md`가
잠금 순서를, `docs/policy/chat-concurrency-and-identity.md`가 admission 원자성을
요구합니다. 줄일 수 있는 것은 **호출 횟수가 아니라 왕복 횟수**입니다 — §5-C.

### 3.2 비교(멀티 모델) 턴

aggregate preflight(`preflightChatComparisonAccess`, `lib/chatSecurity.ts:1707`)
약 6 ops + 모델 수만큼의 §3.1. 3모델 비교 = **약 140–210 ops**.

### 3.3 Deep Research — 가장 비싼 흐름

`components/chat/ChatApp.tsx:501`이 **5초 고정 간격**으로 폴링하고, 백오프가
없습니다. 폴 1회의 비용:

| 항목 | 위치 | ops |
|---|---|---|
| `consumeApiRateLimit` (interactive tx + 4 upsert) | `lib/apiSecurity.ts:88` | 5 |
| `perplexityAsyncJob.findUnique` | `.../deep-research/status/route.ts:81` | 1 |
| `conversation.findUnique` | 같은 파일 `:88` | 1 |
| **폴 1회 합계** | | **7** |

| 요청 길이 | 폴 수 | ops |
|---|---|---|
| 5분 | 60 | 420 |
| 10분 | 120 | 840 |
| 20분 | 240 | **1,680** |

**일반 턴의 25배**입니다. 그리고 rate limit이 `minute: 30`이라 5초 간격은
허용치의 정확히 40%를 상시 소모합니다. 이미지 생성도 같은 5초 고정 폴링입니다
(`components/images/ImageGenerationWorkspace.tsx:100`).

### 3.4 트래픽과 무관한 고정 바닥

| 작업 | 주기 | 회/일 | 회당 ops(추정) | 월 ops |
|---|---|---|---|---|
| Provider Probe (12개 provider) | 10분 | 144 | ~60 | **~260K** |
| Credit Reconciliation (18개 sweep) | 15분 | 96 | ~40 | ~115K |
| Maintenance cleanup (40+ step) | 매일 03:00 | 1 | ~120 | ~4K |
| Provider Usage Sync / Model Catalog | 매일 | 2 | ~50 | ~3K |
| **합계** | | | | **≈ 380K** |

사용자가 0명이어도 매달 38만 ops가 나갑니다. Starter(1M)라면 **할당량의 38%가
아무도 안 쓰는 상태에서 소모**됩니다. Pro(10M) 기준으로는 4%이므로, 플랜이
Pro 이상이면 여기는 손대지 않아도 되는 크기입니다.

### 3.5 페이지 로드

공개 페이지는 DB를 치지 않습니다 — `/api/app-settings`와 `/api/models/catalog`가
`lib/publicSnapshotCache.ts`의 10초 TTL + single-flight + ETag 뒤에 있고,
`app/(site)`의 서버 컴포넌트 중 `prisma`를 부르는 것은 admin 화면뿐입니다.
**이 부분은 이미 잘 돼 있습니다.**

로그인 후 대화 목록은 요청당 약 8 ops(`app/api/conversations/route.ts`)입니다.

### 3.6 규모 환산

턴당 60 ops를 기준으로:

| 월 채팅 턴 | 월 ops(고정 바닥 포함) | 최적 플랜 | 월 DB 요금 |
|---|---|---|---|
| 10,000 | 1.0M | Starter $10 | $10 |
| 50,000 | 3.4M | Pro $49 | $49 |
| 165,000 | 10M | Pro $49 | $49 (한도 도달) |
| 500,000 | 30.4M | Pro $49 + 20.4M×$2 | **$90** |
| 1,000,000 | 60.4M | Business $129 + 10.4M×$1 | **$139** |
| 5,000,000 | 300M | Business $129 + 250M×$1 | **$379** |

여기에 Deep Research·이미지 폴링과 Code 제품의 워크로드가 더해집니다.
**Deep Research가 전체 턴의 2%만 돼도 ops는 1.5배가 됩니다**(0.02 × 1,680 ≈ 34,
평균 턴 비용 60 → 94).

---

## 4. storage는 어디서 나오는가

storage 쪽은 **이미 상당히 잘 관리되고 있습니다.** `lib/retentionPolicyCore.ts`가
정책과 sweep을 한 목록으로 묶고 있고, `npm run report:unswept-tables`가
게이트 없는 보고로 빈틈을 계속 지적합니다. 오늘 실행 결과:

```
113개 model 중 109개에 행을 만들고 44개에서 지웁니다.
bounded 13 / retained 22
26개 — 부모가 지워질 때만 사라짐 (cascade)
3개  — 아무것도 지우지 않고 경계도 없음: MessageArtifactCleanup,
       MessageAttachmentCleanup, EmailCampaign
3개  — 보존 결정이 3일 초과: ChatCreditReservation,
       ImageCreditReservation, MemoryExtractionCreditReservation
```

- **벡터 컬럼이 없습니다.** 검색은 `searchTerms` 배열 + GIN(built-in
  `array_ops`)이고 임베딩 테이블이 없어서, 보통 storage를 폭발시키는 원인이
  이 스키마에는 없습니다.
- **파일 본체는 R2에 있습니다.** DB에는 메타데이터와 텍스트만 남습니다.
- 가장 큰 텍스트는 `Message.content`, `ExternalMessage.content`,
  `AssistantKnowledgeChunk.content`입니다. 셋 다 사용자 데이터라 **비용을 이유로
  지울 수 있는 대상이 아닙니다.**
- **인덱스가 263개 + unique 37개**입니다. Postgres에서 인덱스는 종종 테이블보다
  큽니다. 미사용 인덱스 정리는 storage와 write 비용을 동시에 줄이는 몇 안 되는
  수단입니다 — §5-F.

**"26개 cascade 전용" 목록이 Chat·Code 합류 시의 위험입니다.** cascade는 계정이
사라질 때 행이 따라간다는 뜻일 뿐, 계정이 살아 있는 동안 테이블이 멈춘다는
뜻이 아닙니다. `RoutingRun`·`RoutingAttempt`·`ContextManifest`·`ChatAttemptUsage`는
**턴마다 행이 생기고 아무도 지우지 않습니다.**

---

## 5. 선택지

각 항목은 **효과 / 리스크 / 작업량**으로 적습니다. 효과는 §3의 비율 기준이며,
실측(§2)이 나오면 절대값으로 바꿔야 합니다.

### A. Deep Research·이미지 폴링에 지수 백오프 — 즉시, 무해

**효과: 해당 흐름 ops의 60~75% 감소.** 5초 고정 → 3초에서 시작해 30초 상한으로
증가시키면, 20분 요청의 폴 수가 240 → 약 50으로 줄고 1,680 ops → 350 ops가
됩니다. 응답 인지 지연은 최대 30초로 늘지만, **이미 5분이 넘으면 "더 오래
걸리고 있습니다" 문구가 뜨는 흐름**이라 사용자 기대와 충돌하지 않습니다.

**리스크: 낮음.** 서버 계약이 바뀌지 않습니다. 클라이언트 루프 하나
(`ChatApp.tsx:501`, `ImageGenerationWorkspace.tsx:100`)의 대기 계산만 바뀝니다.
완료 직후 지연을 줄이려면 상한을 15초로 두는 절충도 가능합니다.

**작업량: 반나절.** 폴링 간격을 순수 함수로 빼고 테스트를 붙이면 회귀도 막힙니다.

### B. `getRuntimeModels()`에 TTL 캐시 — 즉시, 무해

**효과: 턴당 2~4 ops, 전체의 3~6%.** 여기에 대화 목록·설정·프로필 등 다른
경로의 호출까지 더하면 실제 절감은 더 큽니다(호출 지점 39곳).

지금은 **캐시가 전혀 없습니다.** `lib/modelRegistry.ts:276`이 호출마다
42행 전체를 `findMany`하고, `getRuntimeModel(id)`은 그 결과를 받아 배열에서
찾습니다 — 즉 모델 하나를 확인할 때마다 카탈로그 전체를 읽습니다.

**리스크: 낮음.** 이 저장소에 이미 정답 패턴이 있습니다 —
`lib/publicSnapshotCache.ts`의 10초 TTL + single-flight + generation fence.
`/api/models/catalog`는 이미 그 캐시 뒤에 있으므로, **내부 호출만 밖에 남아
있는 상태**입니다. 같은 모듈에 `model-registry` 키를 추가하고 admin의
`PUT /api/admin/models`가 무효화하면 됩니다.

주의: **관리자 편집이 즉시 반영돼야 합니다.** generation fence 없이 TTL만
넣으면 편집이 최대 10초 되돌아가 보입니다 — `publicSnapshotCache.ts`가 그
버그를 이미 고쳐 두었으니 그 구현을 재사용합니다.

**작업량: 반나절.**

### C. `acquireChatAccess`의 왕복 줄이기 — 중간, 신중하게

**효과: 턴당 8~12 ops, 전체의 15~20%.** 가장 큰 단일 절감이지만 가장 조심할
곳이기도 합니다.

핵심은 **검사를 없애는 것이 아니라 한 문장으로 합치는 것**입니다. 지금은
`incrementUsage`가 7~9번의 독립 왕복입니다. 같은 트랜잭션 안에서 같은 테이블
(`ChatUsageBucket`)에 같은 형태의 조건부 upsert를 반복하므로, 다중 행
`INSERT ... VALUES (...), (...), ... ON CONFLICT DO UPDATE ... RETURNING key, count`
한 문장으로 묶고 결과를 코드에서 판정할 수 있습니다.

**절대 조건 — 이건 협상 대상이 아닙니다:**

- `lockCreditAccount(tx, userId)`는 **여전히 트랜잭션의 첫 작업**이어야
  합니다(`docs/policy/credit-and-cost-limits.md` §9). 배치로 묶으면서 순서를
  바꾸면 잔액이 음수가 되는 경로가 열립니다.
- `ChatUsageBucket.count`는 **BigInt를 유지**합니다.
  `lib/usageBucketRange.ts:138`이 이를 강제하고, 새 SQL이 `int4`로 바인딩하면
  8,590 크레딧 이상 플랜에서 22003이 뜹니다.
- 조건부 upsert의 `WHERE "count" <= limit - amount`가 **한도 판정 그 자체**입니다.
  배치에서 이 술어를 잃으면 한도가 사라집니다.
- **거절은 어떤 write보다 먼저**여야 하고, 부분 승인이 남아서는 안 됩니다.

**리스크: 중간.** 크레딧·한도 경로는 이 저장소에서 가장 되돌리기 어려운
코드입니다. 착수한다면 raw SQL을 순수 함수로 분리하고, 기존
`tests/integration/**`의 동시성 테스트를 **먼저** 통과시킨 뒤 바꿉니다.

**작업량: 2~3일 + 통합 테스트.**

### D. provider health 계측을 DB 밖으로 — 중간

**효과: 턴당 5~6 ops, 전체의 8~10%.**

`recordProviderSuccess`(`lib/providerMonitoring.ts:887`)가 성공한 턴마다
`ChatUsageBucket`에 4번 쓰고 `recordModelSuccess`가 한 번 더 씁니다. 이 다섯 개는
**과금·한도가 아니라 관측**입니다 — 5분 창의 성공/실패 카운터로 알림 임계값을
판단하는 용도입니다.

세 가지 방향이 있습니다.

1. **프로세스 내 집계 후 주기적 flush** — 인스턴스마다 메모리로 세고 30초에
   한 번 합계를 upsert. 5 ops → 사실상 0.16 ops/턴. 인스턴스가 죽으면 마지막
   30초를 잃지만, **잃는 것이 알림 카운터라 허용 가능한 손실**입니다.
   과금 버킷에는 절대 적용하지 않습니다.
2. **성공은 세지 않고 실패만 센다** — 임계값이 실패 기반이면 성공 카운터는
   비율 계산에만 쓰입니다. 그 비율을 provider probe(10분)로 대체할 수 있는지
   확인이 필요합니다.
3. **Sentry/Slack 지표로 이관** — 이미 둘 다 붙어 있습니다.

**리스크: 낮음~중간.** 알림 민감도가 바뀝니다.
`lib/infrastructureAlertPolicy.ts`의 임계값과 함께 검토합니다.

**작업량: 1~2일.**

### E. rate limit을 DB에서 분리 — 큰 효과, 새 의존성

**효과: rate-limit이 걸린 모든 요청에서 5 ops → 0.** `consumeApiRateLimit`은
호출 지점이 **211곳(157개 route 파일)**이고, 매번 interactive transaction 하나와 upsert 4개를
씁니다(사용자 분·일, IP 분·일).

폴링 흐름에서 특히 큽니다 — §3.3의 폴 1회 7 ops 중 **5가 rate limit**입니다.
백오프(§5-A)와 함께 적용하면 Deep Research 요청 하나가 1,680 → 약 100 ops가
됩니다.

**선택지:**

- **Redis / Upstash** — 정확하고 다중 인스턴스에서 공유됩니다. 월 $0~10 수준.
  대신 **새 인프라 의존이 하나 늘고**, 다운됐을 때의 동작(fail-open/closed)을
  정해야 합니다. abuse 방어이므로 fail-open은 위험하고, fail-closed는 Redis
  장애가 곧 서비스 장애입니다.
- **인스턴스 로컬 카운터 + DB는 상위 한도만** — 분 단위는 메모리로, 일 단위만
  DB로. 인스턴스가 N개면 분 한도가 실질 N배가 되지만, **분 한도는 abuse 완화이지
  entitlement가 아닙니다**(일·월 한도와 크레딧이 진짜 경계). 새 의존성이
  없다는 것이 장점입니다.
- **읽기 우선 판정** — 한도의 절반도 안 쓴 사용자는 쓰기를 건너뜁니다. 절감은
  절반 이하이고 정확도가 떨어집니다.

**절대 조건:** `CHAT_*` 한도(크레딧·동시성·비용 guardrail)는 여기서 건드리지
않습니다. `consumeApiRateLimit`은 그와 **별개 층**인 일반 API abuse 방어입니다.
`docs/policy/chat-concurrency-and-identity.md`의 층 구분을 섞지 않습니다.

**작업량: 2~3일(Redis) / 1일(로컬 카운터).**

### F. storage 정리 — 작지만 계속 이득

- **미사용 인덱스 정리.** 263개 인덱스 중 실제로 쓰이는 것을 확인합니다.
  ```sql
  SELECT schemaname, relname, indexrelname, idx_scan,
         pg_size_pretty(pg_relation_size(indexrelid)) AS size
  FROM pg_stat_user_indexes
  WHERE idx_scan = 0
  ORDER BY pg_relation_size(indexrelid) DESC;
  ```
  `idx_scan = 0`은 "지워도 된다"가 아니라 "왜 있는지 물어보라"입니다 — unique
  제약을 뒷받침하거나 아직 안 온 트래픽을 위한 것일 수 있습니다.
- **테이블별 크기 확인.**
  ```sql
  SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total,
         pg_size_pretty(pg_relation_size(relid)) AS table_only
  FROM pg_catalog.pg_statio_user_tables
  ORDER BY pg_total_relation_size(relid) DESC LIMIT 25;
  ```
- **§4의 3개 미결 테이블**(`MessageArtifactCleanup`, `MessageAttachmentCleanup`,
  `EmailCampaign`)에 결정을 내립니다.
- **`RoutingRun`·`RoutingAttempt`·`ContextManifest`·`ChatAttemptUsage`의 보존
  기간**을 정합니다. 턴마다 자라고 cascade로만 사라집니다.

**하지 않는 것:** 크레딧 예약 3종
(`ChatCreditReservation`·`ImageCreditReservation`·`MemoryExtractionCreditReservation`)의
삭제. 보고서가 기한 초과라고 말하지만, **hold의 내용은 "승인 전 삭제 금지"이고
그것은 그대로 유효합니다.** 지난 것은 결정하겠다는 약속이지 삭제 허가가
아닙니다. `AdminAuditLog`도 마찬가지입니다 — 해시 체인이라 중간을 지우면
이후 링크가 전부 깨집니다.

### G. 제공자 이전 — 구조적 해결

**per-operation 과금을 고정 인스턴스 과금으로 바꾸는 것**이 유일한 구조적
해결입니다. 코드 최적화는 계수를 2~3배 낮추지만, 과금 축 자체는 여전히
사용량에 비례합니다.

| 사용량 | Prisma Postgres | Railway Postgres(추정) | Neon Launch(추정) | Supabase Pro |
|---|---|---|---|---|
| 1M ops / 5 GB | $10 | ~$20 | ~$15 | $25 |
| 10M ops / 20 GB | $49 | ~$25 | ~$20 | $25 |
| 60M ops / 50 GB | $139 | ~$40 | ~$30 | $25 + compute |
| 300M ops / 100 GB | $379 | ~$70 | ~$60 | $25 + compute |
| 1B ops / 200 GB | ~$1,079 | ~$120 | ~$120 | $25 + compute |

Railway는 $20/vCPU·월, $10/GB RAM·월, $0.15/GB 볼륨, $0.05/GB egress이고
**쿼리 수 과금이 없습니다**. Neon은 $0.106/CU-hour + $0.35/GB-월로 역시 쿼리
과금이 없고 scale-to-zero가 있습니다. Supabase Pro는 $25에 8 GB DB + $10
compute 크레딧입니다.

**이 저장소가 이전에 유리한 조건:**

- **PostgreSQL 확장 의존 0건.** 마이그레이션 88개 전체에 `CREATE EXTENSION`이
  없습니다. GIN 인덱스 2개도 built-in `array_ops`입니다. 순수 PostgreSQL 16이면
  어디든 갑니다.
- **연결이 이미 표준 `pg` 어댑터**입니다(`lib/prisma.ts`). Accelerate도
  Data Proxy도 안 씁니다. `DATABASE_URL` 하나로 대상이 바뀝니다.
- **이미 Railway에 6개 서비스가 있습니다.** 같은 project에 Postgres를 두면
  private networking으로 붙어 **egress 요금이 붙지 않고 지연도 줄어듭니다**
  (지금은 앱→외부 DB 왕복이고, §3.1의 60번 왕복이 전부 그 지연을 탑니다).
- **복원 drill 절차가 이미 준비돼 있습니다** —
  `docs/ops/railway-restore-drill.md`, `scripts/railway-restore-preflight.mjs`,
  `scripts/railway-restore-verify.mjs`. 문서는 "아직 실행하지 않았습니다"라고
  적고 있고, **이전을 고려한다면 이 drill이 그 전제조건이자 리허설**입니다.

**이전의 진짜 비용은 요금이 아니라 운영입니다.** 1인 조직에서 이것이
결정적입니다.

- 백업·PITR·페일오버가 **관리 대상이 됩니다.** Railway는 2026년 3월 Patroni
  기반 HA Postgres와 PITR을 제공하지만, PITR은 별도 요금이 없는 대신 WAL·베이스
  백업의 버킷 저장과 업로드 egress를 사용자가 냅니다. 설정·검증은 사람 몫입니다.
- **연결 풀링**을 직접 챙겨야 합니다. 지금 6개 서비스가 각자 `pg.Pool`을
  들고 있고, Prisma Postgres가 그 뒤를 대신 처리해 왔습니다. 자체 Postgres로
  가면 `max_connections`와 PgBouncer가 우리 문제가 됩니다.
- **버전 업그레이드·확장·튜닝**이 우리 일이 됩니다.
- **이전 그 자체의 리스크** — 실제 결제 이력과 대화가 든 DB를 옮기는 작업입니다.
  `docs/ops/railway-restore-drill.md`의 A절(승인·범위)과 B절(격리)이 그대로
  적용됩니다.

**판단 기준을 하나로 줄이면:** 월 DB 요금이 **$150을 넘기 시작하면** 이전의
요금 절감이 운영 부담을 정당화하기 시작합니다. 그 아래에서는 §5-A~D의 코드
최적화가 더 싸고 위험이 훨씬 작습니다.

### H. 워크로드 분리 — Chat·Code 합류 시

**이벤트·계측 테이블을 OLTP DB에서 빼는 것**이 세 제품이 합쳐질 때 가장 큰
구조적 절감입니다.

`ProductAnalyticsEvent`, `RoutingRun`, `RoutingAttempt`,
`TokenEstimateShadowSample`, `ProviderProbeResult`, `ChatLimitDecisionEvent`는
전부 **append-only 관측 데이터**입니다. 트랜잭션 보장이 필요 없고, 사용자
요청이 이들을 읽지 않으며, 분석에서만 읽힙니다. 이런 데이터는 ops당 과금하는
OLTP DB에 있을 이유가 없습니다.

- **단기:** 요청 경로에서 쓰기를 떼어내고(fire-and-forget이 아니라 큐),
  배치로 flush합니다. 턴당 3~4 ops가 배치당 1 ops가 됩니다.
- **중기:** R2에 JSONL로 적재하고 분석은 별도로 합니다. 이미 R2를 쓰고 있고,
  Cloudflare 요금은 ops 기반이 아닙니다.

**절대 조건:** `AdminAuditLog`, `CreditLedgerEntry`, `BillingTransaction`,
`ConsentRecord`, `EmailEvent`는 **관측이 아니라 기록**입니다. 여기서 옮기는
대상이 아닙니다.

---

## 6. Chat·Code가 합류하면 무엇이 바뀌는가

- **ops 할당량은 계정 단위이므로 DB를 나눠도 합산됩니다.** 제품별 분리는
  격리·운영에는 좋지만 요금에는 도움이 되지 않습니다.
- **Code 제품은 아마 턴당 ops가 더 큽니다.** 도구 호출 루프가 있으면 한 요청이
  여러 번의 예약·정산·계측을 돌게 됩니다. 지금의 `acquireChatAccess`를
  그대로 재사용하면 **요청 하나에 20~24 ops가 도구 호출마다** 붙을 수 있습니다.
  Code를 설계할 때 예약을 요청 단위로 한 번만 잡고 도구 호출은 그 안에서
  정산하는 형태를 잡아 두는 것이, 나중에 고치는 것보다 훨씬 쌉니다.
- **§4의 "cascade 전용 26개"가 3배로 자랍니다.** Chat·Code가 각자
  `RoutingRun`류 테이블을 만들면 보존 정책 없는 테이블이 늘어납니다.
  **새 테이블마다 보존 결정을 같이 넣는 규칙**을 지금 세워 두면
  `report:unswept-tables`가 계속 지켜 줍니다.
- **`Conversation.productKey`가 이미 `chat`·`review`·`studio` 셋뿐이고 `code`가
  없습니다**(`docs/policy/conversation-product-key.md`). Code가 Conversation을
  쓰기 시작할 때 `lib/conversationProduct.ts`와 DB CHECK에 함께 추가해야
  합니다 — 비용 분석과 별개지만, 제품별 ops를 나눠 보려면 이 컬럼이
  분류 축이 됩니다.

---

## 7. 권장 순서

| # | 항목 | 효과 | 리스크 | 작업량 |
|---|---|---|---|---|
| 0 | **§2의 실측 3개 확보** (월 ops, storage, 턴당 ops) | — | 없음 | 1시간 |
| 1 | **플랜 초과 단가 확인** — 초과 중이면 상위 플랜으로 | 초과분 단가 1/8~1/2 | 없음 | 즉시 |
| 2 | **폴링 백오프** (§5-A) | Deep Research·이미지 흐름 −70% | 낮음 | 반나절 |
| 3 | **`getRuntimeModels` 캐시** (§5-B) | 전체 −3~6% | 낮음 | 반나절 |
| 4 | **provider health 계측 배치화** (§5-D) | 전체 −8~10% | 낮음~중 | 1~2일 |
| 5 | **rate limit 분리** (§5-E) | 폴링·API 경로 대폭 | 중 | 1~3일 |
| 6 | **인덱스·보존 정리** (§5-F) | storage | 낮음 | 1일 |
| 7 | **`acquireChatAccess` 배치화** (§5-C) | 전체 −15~20% | 중 | 2~3일 |
| 8 | **이벤트 테이블 분리** (§5-H) | Chat·Code 합류 대비 | 중 | 1주+ |
| 9 | **제공자 이전** (§5-G) | 구조적 | 높음 | 2~4주 |

**0~3번만 해도 턴당 ops가 60 → 약 45로 줄고, Deep Research 흐름은 1/3이
됩니다.** 그리고 이 넷은 전부 되돌리기 쉽습니다.

9번은 **월 DB 요금이 $150을 넘고 나서** 다시 봅니다. 그 전에 준비만 해 둘 수
있는 것은 `docs/ops/railway-restore-drill.md`의 drill을 실제로 한 번 실행해
보는 것입니다 — 이전 결정과 무관하게 **복구 가능성 자체가 아직 실측되지
않았습니다.**

---

## 8. 비용을 이유로 건드리면 안 되는 것

`AGENTS.md`와 `docs/policy/**`가 이미 정한 것들입니다. 최적화 과정에서
자연스럽게 손이 가는 곳이라 여기 모아 둡니다.

- **`lockCreditAccount(tx, userId)`의 위치와 순서** — 크레딧을 예약·환급하는
  트랜잭션의 첫 작업. 배치화하면서 뒤로 밀면 잔액이 음수가 됩니다.
- **`ChatUsageBucket.count`의 BigInt** — 좁히는 마이그레이션은
  `lib/usageBucketRange.ts`가 거부합니다.
- **`AdminAuditLog`** — 해시 체인. 중간 삭제 불가.
- **크레딧 예약 3종의 보존** — 승인 전 삭제 금지. 기한이 지난 것은 결정 약속이지
  삭제 허가가 아닙니다.
- **`CreditLedgerEntry`·`BillingTransaction`·`CreditPurchase`·`CreditLot`** —
  청구 증거. ops를 아끼려고 쓰기를 건너뛰지 않습니다.
- **`ConsentRecord`·`EmailPolicyVersion`·`EmailEvent`** — 규제 답변의 근거.
- **동시성 admission의 원자성** — 다중 모델 비교는 전부 승인되거나 전부
  거절됩니다. 쿼리를 줄이려고 모델별 개별 승인으로 되돌리지 않습니다.
- **`/api/ready`의 provider 예산 검사** — production에서 예산 없는 활성
  provider는 실패해야 합니다.

---

## 부록. 이 분석의 한계

- **§3의 ops 수는 정적 추정입니다.** 코드 경로를 읽어 센 것이고, 분기·재시도·
  실패 경로에 따라 달라집니다. §2의 (c) 방법으로 staging에서 실측하면
  대체할 수 있습니다.
- **현재 실제 사용량·요금은 확인하지 못했습니다.** production 환경변수 값은
  이 세션에서 읽을 수 없었습니다(OAuth 토큰은 변수 이름만 반환).
  `PRISMA_OPERATIONS_LIMIT`의 실제 값과 현재 플랜을 확인하면 §3.6의 표에서
  현재 위치를 짚을 수 있습니다.
- **§5-G의 타 제공자 요금은 2026년 9월 시점의 공개 정보**이고, 실제
  Railway/Neon 비용은 워크로드의 CPU·메모리 프로파일에 달려 있습니다.
  §7의 9번을 실제로 검토할 때는 staging에서 한 달 측정이 필요합니다.

**출처**

- [Prisma Postgres pricing](https://www.prisma.io/pricing) ·
  [Operations-Based Billing](https://www.prisma.io/blog/operations-based-billing)
- [Railway pricing](https://railway.com/pricing) ·
  [Point-in-Time Recovery | Railway Docs](https://docs.railway.com/volumes/point-in-time-recovery) ·
  [Best PostgreSQL Hosting 2026](https://blog.railway.com/p/best-postgresql-hosting-2026)
- [Neon pricing calculator (2026)](https://makerkit.dev/pricing-calculator/neon) ·
  [Supabase vs Neon pricing (2026)](https://makerkit.dev/pricing-calculator/supabase-vs-neon)
