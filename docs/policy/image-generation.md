# 이미지 생성 가격·과금·수명주기 정책

승인일: 2026-08-03 (v1). **v2 개정: 2026-08-03 — 멀티 모델 비교를 이미지
기능의 핵심 계약으로 재정의.** v2 결정은 제품 책임자가 UX 결정안(세션
채팅 기록)으로 승인했으며, §11–§15가 그 기록이다. 단 두 항목은 조건부다:
Google 모델 활성화는 공식 가격·thinking 상한의 수동 검증 통과가 선행돼야
하고(§12), 모델별 판매 크레딧은 그 검증 후 별도 승인한다.

이 문서는 이미지 생성 기능의 가격, 크레딧, 환급, 자산
수명주기, 운영 gate의 단일 기준이다. 코드 상수의 출처는
`lib/imageGenerationPricing.ts`와 `lib/imageGenerationAccess.ts`이고,
`npm run check:image-pricing`이 PR Fast Gate에서 fail-closed로 강제한다.
이 계약을 어기는 변경은 릴리스 차단 사유다.

## 1. 범위 (v2)

- **핵심 계약은 멀티 모델 비교다**: 한 프롬프트를 여러 이미지 모델에 동시에
  보내고 결과를 나란히 비교한다(§11). 단일 모델 요청은 1-모델 그룹이라는
  특수한 경우일 뿐 별도 경로가 아니다.
- 모델은 `AVAILABLE_MODELS`·`ModelRegistry` 밖의 **이미지 모델 registry**
  (§12)에서만 관리한다. 초기 등록: `gpt-image-2`(활성),
  `gemini-3.1-flash-image-preview`(Nano Banana 2 — 등록하되 §12의 가격
  검증 통과 전까지 **비활성**), `gemini-3.1-flash-lite-image`(3순위 평가
  후보). 비교 그룹의 모델 수 상한은 `IMAGE_GROUP_MAX_MODELS`(출시 기본 2)
  이며 UI·데이터 모델에 상한값을 하드코딩하지 않는다.
- text-to-image 전용, 모델당 요청 1장. `size=auto`·`quality=auto`·부분
  스트리밍·투명 배경·편집·참조 이미지는 여전히 범위 밖이다. 크기·품질
  선택지는 모델별 profile이 정의하되 provider 제약이 아니라 **Tomverse
  제품 제한**이다.
- Pro·Max 전용. Free·Guest는 서버에서 `PLAN_FEATURE_NOT_INCLUDED`로
  차단하고, UI 노출 정책은 §13을 따른다(잠금 노출 — UI 비노출은 보안
  경계가 아니다).
- 이미지 대화(`Conversation.kind = "image"`)의 공유, `/api/chat` 전송,
  채팅 비교, AI Review, Web Search, Deep Research는 UI와 서버 양쪽에서
  계속 차단한다. 이미지 결과의 나란한 비교(§11)는 채팅 비교 계약
  (`ComparisonActionRail`·admission token)과 무관한 별도 기능이다.

## 2. 게이트 두 층

1. **운영 flag** `feature.imageGenerationEnabled` — 기존 `feature.*` 키와
   달리 **명시적 opt-in**이다. 행이 없거나 값이 `"true"`가 아니면 꺼진다
   (`imageGenerationEnabledFromValue`). default-on helper
   (`enabledFromValue`)를 이 키에 재사용하지 않는다.
2. **플랜 entitlement** `BillingFeature`의 `imageGeneration` — 코드 기본값
   (`planAllowsImageGeneration`: Pro·Max만 true)이며 v1에서는 DB 컬럼을 두지
   않는다. admin override가 필요해지면 스키마 PR에서 컬럼을 추가하고 NULL은
   코드 기본값 상속을 뜻한다.

`/api/images/generations`는 첫 커밋부터 두 gate를 서버에서 강제해야 하며,
gate 없이 노출되는 배포 창은 금지된다. UI 비노출은 보안 경계가 아니다.

## 3. 가격표와 크레딧

| 프리셋 | provider quality | 1024×1024 | 1536×1024 | 1024×1536 |
|---|---|---:|---:|---:|
| Draft | `low` | 15 | 15 | 15 |
| Standard | `medium` | 70 | 60 | 60 |
| Final | `high` | 250 | 200 | 200 |

- **고정 성공 가격**이다. 성공한 생성은 표시된 크레딧 전액으로 정산하고,
  짧은 프롬프트라고 일부를 환급하지 않는다. 실제 provider 원가는 내부
  장부(`settledCostMicroUsd`)에만 별도 기록한다.
- 최종 provider prompt(사용자 입력 + 서버 프리셋 문구)는 최대
  **1,000 토큰**이며, 이 입력비($5/1M tokens = 5,000µUSD)가 위 크레딧에
  이미 포함돼 있다.
- 토큰 수 판정: `estimatePromptTokens` heuristic은 UI의 "약 N/1,000" 표기와
  서버 1차 거절에 쓰되, **실제 모델 토큰 수를 보장하지 않는다.** 정산 시
  provider가 보고한 `input_tokens`를 기록하고, 베타에서 heuristic 오차
  분포를 측정해 안전 계수를 재조정한다.
- **이미지도 일일·월간 플랜 크레딧을 소비한다.** `dailyMessageLimit`은
  이름과 달리 일일 플랜 크레딧 entitlement이며(`lib/providerCostBudget.ts`,
  `lib/usageBucketRange.ts`가 `dailyCreditLimit`으로 매핑), 이미지를 여기서
  제외하는 것은 entitlement 확장이므로 이 문서의 개정 없이는 하지 않는다.
  구매 크레딧은 기존 규칙대로 일일 플랜 한도 밖에서 계속 사용할 수 있다.
- 크레딧 배분은 기존 `getChatCreditAllocation` 규칙을 따른다: 플랜 크레딧
  우선, 부족분만 구매 크레딧(`remainingFundedCostMicroUsd` ledger invariant
  적용).

## 4. `900µUSD/credit` 정책 상한

상수: `IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD = 900`
(`lib/imageGenerationPricing.ts`). OpenAI가 정한 값도, 채팅의
`COST_PER_CREDIT_CEILING_MICRO_USD`(40,000)도 아니다.

- **유도식**: 크레딧 팩의 최저 funded-cost 예산은 1,500µUSD/credit
  (Starter·Power)이다. 이미지의 크레딧당 최악 원가(출력비 + 1,000토큰
  입력비, 올림)를 900 이하로 유지하면 최저 lot에서도 예산의 40% 이상이
  남는다. 현재 최악값은 Final 정사각 864µUSD/credit — 여유는 4.2%뿐이며,
  provider 가격이 그 이상 오르면 검사가 **의도적으로** 실패한다.
- 검사 실패 시 조용히 완화·배포하지 않는다. 다음 중 하나를 명시적으로
  승인해야 한다:
  1. 해당 프리셋의 크레딧 인상
  2. 해당 품질·크기 비활성화(`enabled: false`)
  3. 공급자·포맷·입력 한도 변경
  4. 목표 잔여율 재평가 후 상한 변경 — 이 경우 새 `IMAGE_PRICING_VERSION`
     필수
- **외부 가격 drift 감시**: `PRICE_VERIFICATION.verifiedAt`에 공식 가격
  확인일과 출처 URL을 기록한다. 검사는 90일 경과 시 경고, **180일 경과 시
  실패**한다 — 아무도 재확인하지 않은 가격표로 기능을 계속 운영하지
  않는다. 운영 중에는 실제 정산 원가가 850/875/900µ에 접근할 때 Admin
  경고를 단계적으로 발생시킨다(관측 PR).
- 가격 변경은 소급 적용하지 않는다. `pricingVersion`·`costSource`·품질·
  크기·예약 크레딧을 예약 snapshot에 동결한다.

두 비율을 혼용하지 않는다: **판매가 기준 마진**은 `priceCents`가 분모이고
(Starter 91.3% / Project 87.0% / Power 82.7%, 구독 56.8~82.7%),
**funded-cost 잔여율**은 `fundedCostMicroUsd`가 분모다(42.4~48.2%). 후자를
"마진"이라고 부르거나 크레딧 팩을 저마진 cohort로 결론짓지 않는다.

## 5. 예약·정산·환급

- 예약 레코드는 **`ImageCreditReservation`**(별도 테이블, 스키마 PR)이다.
  `ChatCreditReservation`처럼 대화 삭제에 cascade되지 않고 금융 감사
  snapshot(pricingVersion, provider request ID, lot별 예약 내역
  `reservationPayload`)을 보존한다. 대화 삭제 시 prompt·자산 연결만 끊는다.
- ledger idempotency key: `image-credit-reservation:{generationId}:v1` + DB
  unique constraint. 사용자 요청 idempotency는 `(userId, idempotencyKey)`
  unique — race의 패자는 오류가 아니라 승자의 현재 상태를 멱등 반환한다.
- **정산은 exactly-once**: `pending|processing → settling`(조건부 claim)
  `→ succeeded|failed`. handler와 15분 reconciliation이 같은 generation을
  중복 정산·환급하지 않는다.
- 전액 환급 조건: provider 거절, moderation 차단, provider 오류, 원본 저장
  실패, 처리 시간 초과, stale 작업 reconciliation. 크레딧과 funded cost를
  ledger 규칙(`settleAddOnCredits`)대로 함께 복원하고 플랜 사용량도
  되돌린다.
- 원본 저장이 성공했으면 응답 전달 실패만으로는 환급하지 않는다 — 저장된
  결과를 다시 보여준다.
- 연결 끊김은 취소가 아니다. 시작된 생성은 서버 소유 작업으로 완주하고
  정상 정산한다. v1에 취소 버튼은 없다.
- **provider budget은 경로별 실발생 원가로 정산한다**: 성공 = 실비,
  moderation 차단·provider 오류 = 발생한 원가를 budget에 기록(사용자는
  전액 환급, 차액은 Tomverse 부담), provider 미호출 실패 = 예약 전액 해제.
- 사용자 응답에 원시 내부 USD를 노출하지 않고, 모든 limit 오류의
  `resetAt`은 생성 시점보다 미래여야 한다.

## 6. 지연 생성과 빈 작업 미저장 invariant

- 이미지 모드 진입·옵션 변경은 클라이언트 draft일 뿐이며 서버 행을 만들지
  않는다.
- `kind = "image"` Conversation은 **첫 생성 요청이 lease·budget admission을
  통과하고 과금 예약 트랜잭션이 성공할 때** 같은 트랜잭션에서
  ImageGeneration과 함께 원자 생성된다. `/api/conversations`로는 만들 수
  없다(생성 스키마는 `kind`를 받지 않는다 — 유지).
- flag·plan·validation·소유권·lease·budget 거절과 크레딧 부족 rollback은
  행을 남기지 않는다(`preflight_rejected`는 지표로만 관측).
- generation이 0개인 image Conversation은 정상 흐름이 아니라 invariant
  위반으로 보고한다.
- **`selectedModels` invariant**: image 대화는 생성 시 `"[]"`를 명시
  저장하고 어떤 서버 경로도 이를 읽지 않는다. 이미지 모델은 이미지 생성
  계층의 고정 allowlist에서만 결정된다. 소비처 감사 결과 공용 경로는 전부
  `safeParse(..., fallback)` 또는 `|| []` 방어가 있어 빈 배열에 안전하다
  (`components/chat/ChatSidebar.tsx`의 모델 수 계산 포함).

## 7. 실행 방식과 동시 실행

- 실행 모델은 **claim 기반 비동기 처리**다: POST는 원자 생성 후 즉시
  202와 `conversationId`·`generationId`를 반환하고, 실행자는 `pending`을
  조건부 claim(`pending → processing`)해 provider 호출·저장·정산을
  수행하며, UI는 상태 조회로 렌더링한다. 동기 handler 완주 방식은
  Cloudflare proxy read timeout(기본 125초)과 OpenAI 최대 ~2분 생성
  시간이 겹쳐 채택하지 않는다.
- **v1 실행자는 응답 후 같은 프로세스에서 실행되는 `after()` 훅**이다.
  202가 이미 전송된 뒤 실행되므로 proxy timeout의 영향을 받지 않고,
  claim이 조건부라서 15분 reconciliation sweep이나 미래의 전용 worker
  서비스와 안전하게 공존한다(저장소에 장기 실행 worker 선례가 없어 별도
  Railway 서비스 신설은 운영 PR에서 실측 후 결정). 프로세스 종료로 죽은
  실행은 정확히 stale 케이스이며 sweep이 `failed` 처리 후 전액 환급한다.
- 배포·프로세스 종료로 회수 불가능해진 stale 작업은 reconciliation이
  `failed` 처리하고 전액 환급한다. Railway graceful shutdown 유예
  (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`)를 함께 설정한다.
- 동시 실행은 entitlement·guardrail과 별개인 concurrency 층이며 v2에서
  **두 층으로 분리한다**. 그룹 하나 = lease 하나로 끝내면 모델 fan-out이
  작업량 증폭 통로가 되기 때문이다.
  - **workflow concurrency**: 사용자당 동시 활성 비교 그룹 수
    (`IMAGE_USER_CONCURRENT_GROUPS`, 기본 1).
  - **execution concurrency**: 그룹 내부에서 실제로 실행되는 provider job
    수와 provider별 상한(`IMAGE_PROVIDER_{P}_CONCURRENT_JOBS`).
  예: 2-모델 그룹은 workflow 슬롯 1개를 소비하고 OpenAI job 1 + Google
  job 1을 동시에 실행한다. `limitLayer` 의미
  (`concurrency`/`operational_admission`)는 기존 계약과 동일. lease는
  heartbeat로 유지하고 모든 종료 경로에서 결정적으로 해제한다.
- v1에 분산 글로벌 큐는 없다. gpt-image-2의 IPM 한도는 **조직 단위
  공유**이므로(project 분리는 지출 귀속·키 격리용) 출시 전 실조직 tier를
  검증하고, 포화율·429율이 기준을 넘으면 큐 도입을 재검토한다.

## 8. Provider budget

- **budget은 모델별이 아니라 provider별 총액이다.** namespace:
  `IMAGE_PROVIDER_{OPENAI|GOOGLE|...}_COST_MICROUSD_PER_{DAY|MONTH}` — 채팅
  budget과 분리한다. 모델별 비용은 budget이 아니라 관측·경보 차원으로만
  분해한다.
- `/api/ready`는 flag가 켜진 동안 **활성 이미지 모델이 존재하는 모든
  provider**의 budget 설정을 fail-closed로 검사한다.
- floor는 채팅의 산식을 재사용하지 않는다:
  `일·월 floor = Max 월 크레딧 × 최악 크레딧당 원가 × headroom`
  (참고치: headroom 25%에서 약 $10.80). 한 Max 계정이 월 크레딧을 하루에
  소진할 수 있으므로 일 floor = 월 floor다.
- production에서 env 부재 시 `/api/ready` 실패. 조용한 fallback 기본값
  금지(`providerMonitoring`의 기존 silent fallback 모순은 budget 추가 전에
  정리). env를 먼저 배포하고 코드를 나중에 배포한다.

## 9. 자산 수명주기

- 원본은 provider가 준 바이트를 **무변형 저장**한다. `normalizeImageSafely`,
  sharp 재인코딩, 포맷 변환을 원본에 적용하지 않는다 — C2PA·SynthID
  provenance 보존을 위해서다. UI에는 "AI로 생성된 이미지" 표시를 별도로
  둔다(시각 + accessible text). 썸네일만 파생 자산으로 생성하고, 썸네일
  실패는 원본 성공을 되돌리지 않는다(배경 재시도).
- R2 키 namespace에는 **이메일 해시를 쓰지 않는다**(변경 가능·추측 가능).
  opaque `userId` 또는 HMAC subject key 기반 prefix를 사용한다.
- 삭제 순서는 **DB-first tombstone**이다: 트랜잭션에서 대상 자산을
  `deleting`으로 표시해 접근을 끊고 → cleanup이 R2를 idempotent하게 삭제
  → 성공 후 행 삭제/완료 처리. 실패는 같은 tombstone으로 재시도하고 15분
  reconciliation이 회수한다. R2를 먼저 지우고 DB 삭제가 실패하는 순서는
  금지한다.
- v1 retention: 대화가 존재하는 동안 무기한 보존. 숨은 TTL·사용자별 용량
  상한 금지. 저장량·전송량 지표를 상시 관측하고, 비용 임계 초과 시 고지된
  retention 등 대안을 이 문서 개정으로 결정한다.
- R2 비용 계산 시 egress를 비용으로 잡지 않는다(R2 직접 egress 무료) —
  저장($/GB-month)과 Class A/B 연산, 연계 서비스 비용을 계산한다.

## 10. 로그와 privacy

- 구조화 로그·metric label·trace·error detail에 prompt 원문(부분 포함)을
  남기지 않는다. `promptHash`(HMAC), generationId, provider request ID,
  size, quality, 상태, 실패 단계, 오류 코드, 비용 snapshot만 기록한다.
- presigned URL, R2 credential, 이미지 base64, 다운로드 URL도 로그 금지.
- prompt 원문 열람은 권한 있는 Admin 경로 + 감사 로그로만 한다.
- moderation 내부 분류는 사용자·사이드바 제목·analytics label에 노출하지
  않는다.

## 11. 멀티 모델 비교 계약 (v2)

- **요청은 `modelIds`를 포함한 단일 POST다.** 한 DB 트랜잭션에서 비교
  그룹(`ImageGenerationGroup`), 모델별 논리 슬롯(`ImageGenerationTarget`,
  `(groupId, modelId)` unique), 실행 attempt(`ImageGeneration`), 금융
  예약(attempt당 `ImageCreditReservation` 1개), workflow admission,
  provider별 budget 예약을 전부 생성한다. 어느 하나라도 사전 승인에
  실패하면 **행도 비용도 남기지 않는다**(§6 invariant의 그룹 확장).
  채팅 비교의 admission token은 재사용하지 않는다 — 이미지는 이미 202
  비동기라 단일 원자 트랜잭션이 그 역할을 대신한다.
- **실행이 시작된 뒤에는 모델별 독립 성공·실패다.** 실패한 attempt의
  예약만 환급하고(§5 규칙 그대로), 성공 결과를 되돌리거나 그룹 전체
  재실행을 강요하지 않는다.
- **그룹 상태는 저장 컬럼이 아니라 각 target의 최신 attempt에서 파생하는
  read-model이다**(dual-write drift 방지). 파생 규칙: 전부 succeeded →
  `succeeded` / 전부 failed → `failed` / 전부 terminal이고 혼재 →
  `partial_success` / 하나라도 비terminal → 진행 중. 실패 target 재시도가
  시작되면 성공 결과를 유지한 채 그룹은 다시 진행 중이다. 저장 컬럼
  도입은 목록 조회 성능이 실측으로 요구할 때만 이 문서 개정으로 결정한다.
- **재시도는 새 그룹이 아니라 같은 target 아래 새 attempt다**
  (`attemptNumber`, `retryOfGenerationId`). idempotency는 두 층이다:
  최초 생성 `(userId, groupIdempotencyKey)`, 재시도
  `(targetId, retryIdempotencyKey)`. 새 재시도 예약과 target의 현재
  attempt 갱신은 같은 트랜잭션이며, succeeded target의 재실행은 거부한다
  (이중 과금 금지). UI는 target의 최신 attempt를 현재 상태로 보여주고
  과거 attempt는 감사 기록으로 보존한다.
- 폴링은 그룹 단위 endpoint 하나로 그룹·target·attempt 상태를 함께
  반환한다.

## 12. 이미지 모델 registry와 가격 검증 (v2)

- 이미지 모델은 채팅 catalogue와 분리된 **이미지 모델 registry**로
  관리한다. 모델 profile: provider, API model ID, stable/preview 상태,
  지원 해상도·화면비, 기능(문자 렌더링 등), 크레딧 표, latency 등급,
  provenance 종류(C2PA/SynthID), MIME 처리.
- **가격 검증은 텍스트 모델의 `PENDING_VERIFIED_PRICE_REGISTER`를
  재사용하지 않는다.** 이미지 전용 pending-price register를 신설한다
  (담당자·검증 티켓·기한 구조는 동일 철학, 계층은 분리). 텍스트·이미지
  공통 registry로의 일반화는 세 번째 이미지 provider가 등장할 때
  재평가한다.
- **고정 성공 가격 유지 조건** — 모델을 활성화하려면 전부 충족해야 한다:
  1. 입력·thinking·이미지 출력 등 모든 과금 요소를 포함한 **최악 요청
     원가가 유한하게 계산 가능**해야 한다.
  2. 서버가 그 최대를 벗어나는 요청 parameter를 허용하지 않아야 한다
     (예: thinking 상한 고정, response modality를 이미지로 제한).
  3. 최악 조건에서 `maxRequestCostMicroUsd / chargedCredits ≤ 900µUSD`
     (§4 상한 유지).
  4. 모델별 크레딧은 최소 `ceil(maxRequestCostMicroUsd / 900)` 이상.
  5. 위 값은 정책상 **수학적 최소 크레딧**일 뿐이며, **판매 크레딧**은
     목표 잔여율·환불 위험·가격 drift 여유를 반영해 별도 승인한다.
  6. thinking 비용은 평균이 아니라 provider가 허용하는 상한·최악 조건으로
     계산한다. 공식 문서에서 상한을 확인할 수 없으면 **고정 가격 산정
     불가 — 모델 활성화 보류**다.
  7. 성공 후 사용자에게 추가 청구하지 않는다. 실측 원가는 내부 정산·관측
     전용이다.
- **공식 도메인 본문을 직접 읽고 기록한 가격만 `verified`다.** 검색
  요약·제3자 출처로 대체하지 않는다. 2026-08-03 기준
  `gemini-3.1-flash-image-preview`(Nano Banana 2)는 preview 상태이며 가격·
  thinking 상한이 미검증이므로 **등록-비활성**이다. 수동 검증 통과와 판매
  크레딧 승인 후에만 활성화한다.
- adapter는 provider가 반환한 원본 bytes와 MIME을 무변형 저장하고(PNG
  가정 금지), 정규화된 usage(input/thinking/output)·moderation 분류·
  provider request ID·provenance 종류를 공통 형태로 보고한다.

## 13. 진입점과 노출 정책 (v2)

- 진입점은 네 곳이다: ① 데스크톱 사이드바 **split-button**(기본 클릭 =
  새 채팅, 펼침 메뉴에 이미지 생성), ② 모바일 **"새로 만들기" bottom
  sheet**(split-button을 축소하지 않는다), ③ 채팅 컴포저 도구 메뉴의
  **이미지 생성**(서버 행 없이 image draft로 전환), ④ 모델 카탈로그의
  **`채팅 | 이미지` 분리 탭**. v1의 별도 "새 이미지" 버튼은 대체·제거한다.
- 카탈로그의 기존 `이미지 입력` 필터(`modelSupportsImageInput` — 입력
  능력)와 이미지 **생성** 모델 목록을 같은 목록에 혼합하지 않는다.
- 컴포저에서 전환 시 작성 중 텍스트는 이미지 prompt 초안으로 가져오고,
  취소하면 원래 채팅 draft(텍스트·첨부·모델·도구 상태)를 복원한다.
  첨부는 조용히 버리지 않는다 — 채팅 draft에 보존하고 이미지 생성이
  텍스트 전용임을 1회 안내한다.
- **Guest·Free는 전 위치 잠금 노출이다**: 항목은 보이되 LockKeyhole과
  필요 플랜을 표시하고, 클릭 시 Guest는 로그인 안내, Free는 Pro·Max
  업그레이드 안내로 연결한다(카탈로그·Deep Research 행의 기존 잠금
  관례와 동일). 마지막 단계 차단은 금지 — 진입 전에 상태를 명시한다.
  서버 entitlement 검사는 독립적으로 유지된다.
- 이미지 결과 비교 UI는 `comparison-action-rail` 계약의 **원칙만**
  차용한다(상태 기반 노출을 순수 predicate로 결정, 셸 분기 금지, 정상
  완료 상태 문장은 sr-only, 액션별 자기 가격·자기 사유를
  `aria-describedby`로). `ComparisonActionRail`·`shouldShowVisualStatus()`
  자체를 재사용하지 않으며, 이미지 비교를 이유로 AI Review·요약을
  활성화하지 않는다.
- 시각 역할은 `accent-image-*` 토큰만 사용한다. AI Review 전용 gradient
  조합은 이미지 UI에 쓰지 않는다.

## 14. v1 데이터 backfill (v2)

- 기존 v1 `ImageGeneration` 행은 **1행당 그룹 1개 + target 1개로
  backfill**해 read path를 하나로 유지한다. nullable `groupId`를 장기
  병행하는 legacy 경로는 두지 않는다.
- v1이 단일 모델·단일 provider였다는 사실로 기존 `ImageCreditReservation`
  의 `provider="openai"`, `modelId="gpt-image-2"`를 추론해 보강할 수
  있다. 추론값은 감사 기록에서 실측값과 구분되도록 표시한다.
- generation과 연결이 끊긴 orphan 금융 기록도 같은 규칙으로 보강하되,
  알 수 없는 `pricingVersion`이나 모순된 행은 파괴하지 않고 별도
  보고한다.
- migration 전에 read-only audit을 실행한다: generation 총수·상태 분포,
  예약 없는 generation 수, orphan 예약 수, provider/modelId 분포 확인.
  migration 후 검증: 그룹 수 = 기존 generation 수, target unique 위반 0.
  복구는 rollback이 아니라 forward repair로 한다.
- status·timestamp·자산 관계·기존 idempotency 의미는 backfill이 변경하지
  않는다.

## 15. v2 릴리스 게이트

- **v1 flag는 staging 내부 검증 전용이다.** 멀티 모델 UX(§11–§13)가
  구현·검증되기 전에 production에서 flag를 켜 공개 베타로 활성화하지
  않는다. flag-off 코드 배포는 허용된다.
- Google 모델은 §12의 수동 가격 검증과 판매 크레딧 승인 전까지 어떤
  환경에서도 활성화하지 않는다(등록-비활성 유지).
- 유료 eval(동일 프롬프트 benchmark: prompt fidelity·구도·문자 렌더링·
  인물/손 일관성·한국어 이해·latency·moderation 오탐·포맷 안정성·실측
  원가)은 별도 예산 승인 후 실행하고, 결과를 모델 활성화 결정에
  인용한다.
