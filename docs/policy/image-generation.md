# 이미지 생성 가격·과금·수명주기 정책

승인일: 2026-08-03. 이 문서는 이미지 생성 기능의 가격, 크레딧, 환급, 자산
수명주기, 운영 gate의 단일 기준이다. 코드 상수의 출처는
`lib/imageGenerationPricing.ts`와 `lib/imageGenerationAccess.ts`이고,
`npm run check:image-pricing`이 PR Fast Gate에서 fail-closed로 강제한다.
이 계약을 어기는 변경은 릴리스 차단 사유다.

## 1. 범위 (v1)

- 모델: `gpt-image-2` 하나. `AVAILABLE_MODELS`·`ModelRegistry` 밖의 이미지
  전용 계층에서만 관리한다(`lib/providerModelCatalogCore.ts`의 catalogue
  필터는 그대로 둔다).
- text-to-image 전용, 요청당 1장, 품질 3종(Draft/Standard/Final)과 크기
  3종(1024×1024, 1536×1024, 1024×1536)만. `size=auto`·`quality=auto`·부분
  스트리밍·투명 배경·편집·참조 이미지는 범위 밖이다.
- 3개 크기는 provider 제약이 아니라 **Tomverse 제품 제한**이다. gpt-image-2는
  임의 해상도를 지원한다.
- Pro·Max 전용. Free·Guest는 `PLAN_FEATURE_NOT_INCLUDED`로 차단한다.
- 이미지 대화(`Conversation.kind = "image"`)의 공유, `/api/chat` 전송, 비교,
  AI Review, Web Search, Deep Research는 UI와 서버 양쪽에서 차단한다.

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
- 동시 실행은 entitlement·guardrail과 별개인 concurrency 층이다:
  `IMAGE_USER_CONCURRENT`(기본 1), 채팅 한도와 분리, `limitLayer` 의미
  (`concurrency`/`operational_admission`)는 기존 계약과 동일. lease는
  heartbeat로 유지하고 모든 종료 경로에서 결정적으로 해제한다.
- v1에 분산 글로벌 큐는 없다. gpt-image-2의 IPM 한도는 **조직 단위
  공유**이므로(project 분리는 지출 귀속·키 격리용) 출시 전 실조직 tier를
  검증하고, 포화율·429율이 기준을 넘으면 큐 도입을 재검토한다.

## 8. Provider budget

- namespace: `IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_{DAY|MONTH}` — 채팅
  budget과 분리한다.
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
