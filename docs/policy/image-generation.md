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
  (§12)에서만 관리한다. 등록 현황(2026-08-05): `gpt-image-2`·
  `grok-imagine-image-quality-20260403`(활성) 2개,
  `gemini-3.1-flash-image`·`gemini-3.1-flash-lite-image`·
  `gemini-3-pro-image`(등록-비활성) 3개.
  미등록 평가 후보는 §12.1에 있다. 비교 그룹의 모델 수 상한은
  `IMAGE_GROUP_MAX_MODELS`(출시 기본 2)이며 UI·데이터 모델에 상한값을
  하드코딩하지 않는다. **UI는 이 값을 서버에서 전달받는다**
  (`imageGroupMaxModels()`, `lib/imageGroupLimits.ts` — admission과 같은
  함수). client가 자기 사본을 계산하면 build-time 값이 되어 배포로 상한이
  바뀐 뒤에도 옛 값을 계속 제시하고, **서버가 거절할 수밖에 없는 요청을
  유효한 요청처럼 보여준다.** 2026-08-16에 활성 모델 3개 · 상한 2에서 이
  상태가 실제로 발생했다.
- **`IMAGE_GROUP_MAX_MODELS`와 `IMAGE_INLINE_MODEL_DISCOVERY_LIMIT`는 서로
  다른 결정이며 어느 쪽도 다른 쪽에서 유도하지 않는다.** 전자는 한 요청이
  실제로 시작할 수 있는 provider 작업량이고, 후자는 picker를 열지 않고
  발견되는 모델 수(UI 한 줄의 정보 밀도)다. 오늘 두 값이 3으로 같더라도
  합치지 않는다 — 합치면 실행 상한이 composer를 재배치하거나 레이아웃
  결정이 provider 지출을 승인하게 된다.
- **활성 모델 수가 상한보다 많은 구성은 정상이며 UI가 안전하게 처리해야
  한다.** 초과 선택은 거절하되 선택을 바꾸지 않고, 이유를 남기며, 이미
  선택된 모델의 해제는 계속 허용한다. 계약은
  `docs/ui-contracts/image-generation-workspace.md`의 "Selection limit".
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
- **정산은 예약 snapshot의 원가를 쓴다. 현재 가격표를 다시 조회하지 않는다.**
  재조회는 예약과 정산 사이에 가격 코드가 배포되면 이미 가격이 정해진 요청의
  기록을 덮어쓰고, 멀티 모델에서는 다른 provider가 만든 이미지에 gpt-image-2
  표를 적용한다. snapshot이 원가를 주지 못하면 **0으로 완화하지 않는다** —
  0은 비용 장부를 축소 기록하면서 provider budget을 과다 환급하고, 두 오류
  모두 자기가 망가뜨린 숫자 안에서는 보이지 않는다. 예약된 최악 원가
  (`reservedCostMicroUsd`)를 쓰고 `image_settlement_snapshot_cost_missing`으로
  보고한다.
- **표현 구조 변경은 `IMAGE_PRICING_VERSION`을 올리지 않는다.** 이 버전은 가격
  계약을 가리킨다. `pricingSnapshot`에는 조회 key가 아니라 숫자
  (`credits`·`outputCostMicroUsd`·`maxRequestCostMicroUsd`·`promptTokenLimit`)만
  들어가고 품질·크기는 별도 컬럼에 동결되므로, 코드 내부 조회 key가 바뀌어도
  감사 자료의 의미는 동일하다. 금액이 그대로인데 버전을 올리면 "가격 계약이
  달라졌다"는 관측 노이즈만 만든다. snapshot의 **직렬화 구조**가 바뀌면 가격
  버전이 아니라 snapshot 안의 `schemaVersion`으로 구분하고, 부재는 `1`로
  해석한다.
- **예약이 동결하는 버전은 모델별이다** (`ImageModelProfile.pricingVersion`).
  전역 `IMAGE_PRICING_VERSION` 하나를 쓰면 xAI 가격을 추가할 때 OpenAI 가격이
  그대로인데도 모든 OpenAI 지표가 새 버전으로 갈라진다. 명명은
  `lib/modelPricing.ts`와 같은 `provider-model-date-vN` 형식이다.
  - `gpt-image-2`만 예외로 `2026-08-03-v1`을 유지한다. 이미 그 문자열로 기록된
    예약이 있고, 이 모델의 가격은 한 푼도 바뀌지 않았으므로 이력에 경계를
    만들지 않는다.
  - 이 값을 `IMAGE_PRICING_VERSION`에서 유도하지 않는다. 유도하면 상한 변경 같은
    전역 사유가 모델 가격 버전을 끌고 올라가 같은 잡음이 반대 방향으로 생긴다.
  - `npm run check:image-pricing`이 enabled 모델의 버전 존재와 **전 모델 간
    유일성**을 강제한다. 두 모델이 한 문자열을 쓰면 동결된 예약이 어느 가격표를
    가리키는지 판정할 수 없다.
  - 전역 `IMAGE_PRICING_VERSION`은 v1 flat 가격표(`lib/imageGenerationPricing.ts`)
    와 상한 정책의 버전으로 남는다. 예약 기록에는 더 이상 쓰지 않는다.

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
- **`settling`은 회수 가능해야 한다.** generation의 `settling` claim은 정산
  transaction **밖**에서 이루어지므로, transaction이 rollback되면(deadlock,
  connection 유실, 재배포) 행은 크레딧이 예약된 채 `settling`에 남는다.
  회수 경로가 `pending|processing`만 보면 이 상태는 **누구도 도달하지 못하는
  덫**이다 — 환급도, terminal 상태도, 폴링 종료도 영원히 오지 않는다.
  - reconciliation은 `settling`을 **별도의 더 긴 창**
    (`STALE_IMAGE_SETTLING_AFTER_MS`)으로 함께 회수한다. 창을 분리하는 이유는
    `pending|processing` 회수는 아무것도 쓰지 않은 행을 되돌리는 것이지만
    `settling` 회수는 열려 있을 수 있는 크레딧 write와 경합하기 때문이다.
  - 회수를 안전하게 만드는 것은 창이 아니라 **예약 자신의
    `reserved → settling` claim**이다. 이 claim은 정산 transaction 안에 있고
    generation을 종결시키는 것과 같은 transaction이므로, 이미 커밋된 정산은
    두 번째 시도를 거부한다.
  - 자기 정산 transaction이 실패한 실행자는 이미 claim을 소유하므로 창을
    기다리지 않고 즉시 회수한다.
  - **`settlement_failed`는 `provider_failed`와 다른 실패 단계다.** 전자는
    이미지가 도착했고 그 장부 기록을 잃은 것이고, 후자는 이미지가 오지
    않은 것이다. 둘을 합치면 운영자가 공급자 상태 페이지를 보러 간다.
    회수된 stranded 정산은 `IMAGE_SETTLEMENT_STRANDED`로 보고하고 Admin
    Console의 invariant 줄에 별도 수치로 노출한다.
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
- **`after()`의 실행 시간은 그 route의 max duration이다**(Next `after`
  레퍼런스). proxy timeout이 아니라 이쪽이 실제 제약이므로 실행자를
  구동하는 route는 예산을 명시한다. 값은
  `IMAGE_EXECUTOR_MAX_DURATION_SECONDS`이고, provider timeout·재시도
  backoff·그룹 상한·provider job 하한에서 유도한다
  (`lib/imageGenerationStateCore.ts`). 잘린 실행자는 지연이 아니다 —
  `pending` 생성을 다시 구동하는 것은 없고 sweep은 환급만 하므로 요청
  자체가 사라진다. stale 임계값이 한 시도의 최악 소요보다 크다는 조건과
  함께 `npm run check:image-executor-budget`이 PR Fast Gate에서 강제한다.
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
  - **"최악 크레딧당 원가"는 provider별 값이 아니라 활성 이미지 상품 전체의
    최대값**이다(`worstImageCostPerCreditMicroUsd()` — 현재 864µ/credit,
    `gpt-image-2` Final 정사각에서 나온다). 따라서 floor는 특정 공급자의
    실원가가 아니라 **전체 이미지 상품을 포괄하는 entitlement 안전 바닥**이다.
    xAI budget의 floor를 "Grok 실원가"로 설명하면 틀린다.
  - **가격표는 두 개이고 유도는 둘 다 읽는다.** `IMAGE_GENERATION_PRICING`은
    `gpt-image-2`의 원래 표이고, 이후 추가된 모델은 registry profile의
    `prices`에 값을 싣는다. 2026-08-12까지 유도는 앞의 표만 순회했고, 결과
    864µ는 **우연히** 맞았다 — `gpt-image-2` Final이 마침 가장 비싼
    크레딧이었기 때문이다. 그 사이 xAI는 enabled 상태로 유도에 한 번도
    들어가지 않았고, 더 비싼 모델을 추가해도 floor가 따라 오르지 않았을
    것이다. `worstImageCostPerCreditFrom()`이 두 목록을 함께 읽고,
    **worst case가 미확정인 enabled 모델은 건너뛰지 않고 throw**한다 —
    건너뛰면 floor가 존재하는 이유인 바로 그 모델을 뺀 채 계산된다.
    `tests/imageProviderBudget.test.mjs`가 "더 비싼 모델을 추가하면 floor가
    오른다"를 고정한다.
  - **floor는 바닥이지 권고치가 아니다.** 초기 production 승인값은
    일 $50 / 월 $500(2026-08-05). staging은 일·월 모두 floor $10.80으로,
    총 staging 지출을 캡하는 것이 의도다.
- **`월 ≥ 일`만으로는 충분하지 않다.** 둘이 같으면 하루치 상한을 한 번
  소진하는 순간 그달 예산도 끝나므로 월 창이 두 번째 bound가 되지 못한다.
  `resolveImageProviderBudget`이 `month <= day`를 `month_not_above_day`
  **advisory**로 보고한다 — `problems`와 달리 readiness를 막지 않는다.
  단지 이상한 예산 때문에 기동을 거부하는 것이 그 예산보다 나쁘기 때문이고,
  staging의 동일값 설정은 의도된 것이기 때문이다.
- **예약액과 정산액을 구분한다.** provider budget은 예약 시 최악값으로 잡고
  성공 정산에서 실비로 true-up하며 차액을 환급한다. Grok 1K는 예약
  55,000µ(출력 50,000 + 공통 프롬프트 안전예산 5,000), 정산 50,000µ,
  차액 5,000µ 환급이다 — xAI는 프롬프트 길이와 무관한 장당 정액 과금이라
  `inputTokens`가 0이다. 용량을 셀 때 두 기준을 섞지 않는다: **미정산 예약
  기준**은 동시에 승인 가능한 건수이고, **성공 정산 기준**은 이론상 완료
  가능한 장수다(일 $50 → 909건 승인 / 1,000장 완료).
- production에서 env 부재 시 `/api/ready` 실패. 조용한 fallback 기본값
  금지(`providerMonitoring`의 기존 silent fallback 모순은 budget 추가 전에
  정리). env를 먼저 배포하고 코드를 나중에 배포한다.
- **readiness 검사가 던지면 not ready다.** flag-off로 예산이 없어도 되는
  합법 상태는 `getImageProviderBudgetReadiness()` **안에서** `ready: true`로
  판정된다. 따라서 예외는 그 상태일 수 없고, 유도 자체가 실패했다는 뜻이다.
  route는 2026-08-12까지 `status?.ready ?? true`로 읽어 **가장 시끄러운
  실패를 가장 조용한 신호로** 바꿨다 — env 하나가 비면 fatal인데, 그 env를
  찾는 검사가 터지면 healthy였다. 지금은 `?? false`이고 예외 메시지를
  `IMAGE_PROVIDER_COST_BUDGET_NOT_READY`의 `error`로 싣는다.
  `scripts/security-regression-check.mjs`가 이 기본값을 고정한다.

## 9. 자산 수명주기

- 원본은 provider가 준 바이트를 **무변형 저장**한다. `normalizeImageSafely`,
  sharp 재인코딩, 포맷 변환을 원본에 적용하지 않는다 — C2PA·SynthID
  provenance 보존을 위해서다. UI에는 "AI로 생성된 이미지" 표시를 별도로
  둔다(시각 + accessible text). 썸네일만 파생 자산으로 생성하고, 썸네일
  실패는 원본 성공을 되돌리지 않는다(배경 재시도).
- **배경 재시도는 15분 maintenance sweep의 `repairFailedImageThumbnails`다.**
  - **원본을 절대 건드리지 않는다.** 재시도는 저장된 원본을 **비파괴 읽기**
    (`readOwnR2ObjectBytes`)로 읽는다. `readR2Object`는 metadata 불일치 시
    객체를 삭제하는데 — 신뢰할 수 없는 업로드에는 옳지만 — 사용자가 결제했고
    재생성할 수 없는 원본에 쓰면 복구가 복구 대상을 파괴한다.
  - **실패 행은 썸네일이 놓일 실제 key를 기록한다.** 존재하지 않는 객체를
    가리키는 sentinel key를 만들지 않는다. sentinel은 대화 삭제 시 쓰인 적
    없는 객체의 tombstone을 남기고, 재시도가 채워 넣을 행을 없앤다 —
    generation당 썸네일 행은 하나여야 한다.
  - 시도 상한은 `IMAGE_THUMBNAIL_MAX_RETRIES`이며 cleanup 상한보다 **낮다**.
    cleanup은 언젠가 성공할 삭제를 재시도하지만 썸네일 실패는 대개 결정적
    (파생이 그 바이트를 거부)이고 매 시도가 원본을 다시 내려받는다.
  - 상한 초과 행은 Admin invariant에 `thumbnailsExhausted`로 노출한다. 대기
    중인 backlog는 issue로 세지 않는다 — sweep이 가져갈 것이고 카드는 그동안
    원본을 렌더링한다.
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

### 9.1 저장은 이 앱의 origin에서만 한다 (2026-08-25)

`Content-Type`은 **바이트가 무엇인지**를 말하고 `Content-Disposition`은
**그것으로 무엇을 할지**를 말한다. 둘은 다른 질문이며, 서명 URL이 답할 수
있는 것은 앞의 하나뿐이다.

생성 결과의 "다운로드"는 서명된 R2 URL에 `<a download>`를 건 것이었다.
`download` 속성은 **same-origin 전용**이므로 브라우저는 그것을 무시하고 링크를
따라갔고, 올바른 `image/png`를 받아 올바르게 처리했다 — 새 탭에 렌더링했다.
저장소 설정에 잘못된 것은 없었고, 저장된 metadata를 무엇으로 바꿔도 고쳐지지
않는다. 첨부로 달라는 말은 응답만 할 수 있고, 그 응답은 이 앱의 것이어야 한다.

- **저장 경로는 `GET /api/images/generations/{generationId}/download` 하나다.**
  소유권은 조회 자체를 `userId`로 범위 잡아 정하고, 성공하지 않은 generation·
  스윕된 원본·남의 행은 모두 404다 — 구분할 분기가 존재하지 않는다.
- **파일 이름은 저장된 `mimeType`에서 만든다.** `imageAssetR2Key()`는 원본을
  언제나 `original.png`로 이름 짓지만 provider가 전부 PNG를 주는 것은 아니다
  (adapter는 `image/jpeg`·`image/webp`도 파싱한다). key는 저장 경로라 고정
  접미사가 무해하지만, 같은 문자열을 **파일 이름**으로 쓰면 JPEG를 PNG라고
  말하게 된다. 규칙은 `lib/imageAssetDownload.ts` 한 곳이다.
- **바이트는 proxy하고 redirect하지 않는다.** redirect는 결과를 다시 브라우저
  손에 넘기고 거기에는 실패도 포함된다 — 402·404가 workspace를 떠나는 navigation이
  된다. 페이지에서 fetch해 blob으로 저장하면 거절은 그것을 요청한 페이지에
  남는다(`lib/browserDownload.ts`).
- **읽기는 `readOwnR2ObjectBytes`다.** `readR2Object`는 metadata 불일치 시
  객체를 삭제하며, 사용자가 결제했고 재생성할 수 없는 원본에 그 경로를 쓰지
  않는다(§9의 썸네일 재시도와 같은 이유).
- **서명 URL은 표시용으로 남는다.** `<img src>`와 "원본 보기"는 그대로
  `IMAGE_ASSET_URL_TTL_SECONDS` 서명 URL을 쓴다. 저장 경로만 앱 origin으로
  옮긴 이유는 두 번째 결함 때문이다 — 서명 URL은 5분이면 만료되고, `<img>`는
  `onError`로 다시 minting하지만 링크에는 그런 것이 없어서 6분 열어 둔 카드의
  다운로드는 S3 오류 문서로 가는 navigation이었다. 이 route는 클라이언트가
  보관할 것을 만들지 않으므로 카드는 한 시간 뒤에도 저장된다.
- **egress 계산은 §9의 문장이 덮지 않는다.** R2 직접 egress는 무료지만 이
  경로의 바이트는 R2 → 앱 → 사용자로 흐르므로 앱의 전송 비용이다. 사용자가
  누르는 만큼만 발생하고 상한은 `IMAGE_ORIGINAL_MAX_READ_BYTES`이며, 표시
  경로(썸네일·`<img>`)는 계속 R2가 직접 서빙한다.

### 9.2 만료는 알리고, 만료된 클릭은 받지 않는다 (2026-08-25)

**"원본 보기"는 계속 서명된 R2 URL입니다.** §9.1이 옮긴 것은 저장 경로 하나이며,
표시(`<img src>`)와 원본 보기는 R2가 직접 서빙합니다 — 보기용 바이트까지 앱으로
통과시키면 R2 직접 egress의 이점을 버립니다.

그 대신 서명 URL의 수명을 **사용자가 알 수 있게 하고, 만료된 클릭을 앱이
받습니다.**

- **`ImageAssetPayload`가 `urlExpiresAt`을 함께 실어 보냅니다.** URL과 만료를 서로
  다른 곳에서 정하면 어긋날 수 있는 두 사실이 되고, 클라이언트가 행동에 쓰는 쪽이
  틀린 쪽이 됩니다. 그래서 minter가 URL과 만료를 **함께** 반환하고,
  `serializeImageAssets()`에는 그것 없이 asset을 내보내는 분기가 없습니다.
- **timestamp는 서명 전에 찍습니다.** `getSignedUrl()`은 실행 시점 시계로 서명하므로
  먼저 찍은 값은 실제 만료보다 이르기만 합니다. 이르게 말하면 불필요한 refresh 한
  번이고, 늦게 말하면 이 필드가 막으려는 오류 페이지입니다.
- **TTL 상수는 `lib/imageAssetPayload.ts`가 소유합니다.** `imageGenerationRead.ts`는
  `server-only`라 workspace가 import할 수 없고, 화면에 적는 숫자와 서명하는 숫자가
  각각 존재하면 언젠가 한쪽만 바뀝니다. read 경로는 re-export합니다.
- **만료 판정에는 몇 초의 여유를 둡니다**(`IMAGE_ASSET_URL_EXPIRY_GUARD_MS`).
  T-1초의 클릭은 navigation과 서명 만료 사이의 경주이고, 두 결과는 이미지와 오류
  문서로 전혀 다릅니다.
- **`urlExpiresAt`이 없으면 만료가 아닙니다.** 배포 전에 열려 있던 탭의 payload가
  그렇습니다. 이 필드의 역할은 **죽은 것이 확실한** 클릭을 막는 것이지 추측으로
  살아 있는 링크를 끊는 것이 아닙니다.
- **만료된 클릭은 navigation을 취소하고 토스트로 답한 뒤 URL을 새로 minting합니다.**
  다시 열어 주지는 않습니다 — await 뒤의 `window.open()`은 popup이라 브라우저가
  막습니다. `<img>`의 `onError` 복구는 이 경우를 덮지 못합니다: 살아 있을 때 로드된
  이미지는 캐시에서 계속 그려지므로 error가 나지 않고, 따라서 아무것도 다시
  minting하지 않습니다.
- **href는 그대로 둡니다.** 평소 경로는 평범한 링크(새 탭, `rel="noreferrer"`)이고,
  가로채는 것은 죽은 것이 확실한 클릭 하나뿐입니다.

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
- **폴링은 그룹 단위 endpoint 하나로 그룹·target·attempt 상태를 함께
  반환한다** — `GET /api/images/groups/{groupId}`. generation별 폴링은
  비교 관찰 비용을 모델 수에 비례시키며, client는 거절된 폴링을 "변화 없음"
  으로 읽으므로 status rate limit 소진이 **조용히 갱신을 멈춘 화면**으로
  나타난다. `GET /api/images/generations/{generationId}`는 만료된 signed
  asset URL을 다시 발급받는 단일 카드 복구용이며 폴링 경로가 아니다.
- **어느 attempt가 target의 현재 상태인지는 한 곳에서 정한다**
  (`currentImageAttempt`, `deriveImageGroupStatusFromTargets` —
  `lib/imageGenerationStateCore.ts`). 전체 attempt를 파생 함수에 넘기면
  이미 재시도된 실패가 재시도 진행 중에도 `partial_success`를 보고한다.

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
  요약·제3자 출처로 대체하지 않는다. 제품 책임자가 알려 준 수치도 마찬가지다 —
  근거로 기록할 수는 있어도 `verified`로 승격하지 않는다.
- adapter는 provider가 반환한 원본 bytes와 MIME을 무변형 저장하고(PNG
  가정 금지), 정규화된 usage(input/thinking/output)·moderation 분류·
  provider request ID·provenance 종류를 공통 형태로 보고한다.

### 12.1 후보 등록부와 검증 상태 (2026-08-04)

가격 검증 결과는 `.github/audits/image-model-verification-worksheet.md`에
공식 URL·확인일·원문 발췌와 함께 있다. **가격 검증이 끝났다는 사실과 실행
준비가 끝났다는 사실은 서로 다른 gate다.**

| 후보 | 상태 | 검증된 이미지 출력가 | 남은 조건 |
|---|---|---|---|
| `gpt-image-2` | **활성** | 표 §3 | — |
| `grok-imagine-image-quality-20260403` | **활성 (2026-08-05)** | 1K $0.05 · 판매가 75크레딧 | 1K 정사각만. 2K(승인 100크레딧)는 크기 체계 확장 후 |
| `gemini-3.1-flash-image` | 등록-비활성 (`worst_case_cost_unbounded`) | 0.5K $0.045 / 1K $0.067 / 2K $0.101 / 4K $0.151 | **thinking 상한** — 아래 참조 |
| `gemini-3.1-flash-lite-image` | 등록-비활성 (`worst_case_cost_unbounded`) | 1K $0.0336 (1K 전용) | 동일. Draft 후보이며 두 번째 비교 자리를 Google로 채우지 않는다 |
| `gemini-3-pro-image` | 등록-비활성 (`worst_case_cost_unbounded`) | 1K·2K $0.134 / 4K $0.24 | 동일 + 제품 판단 보류(`gpt-image-2` Final과 중복) |
| `qwen-image-2.0-pro-2026-06-22` | 미등록 | 미확인 | 별도 endpoint·리전·한국어 글자 정확도 검증 |
| Ideogram 4.0 | 미등록 | Turbo $0.03 / Default $0.06 / Quality $0.10 (미검증) | 신규 공급자 전체 온보딩 |

**`disabledReason` 세 값은 서로 다른 사실을 말하며 `check:image-pricing`이
각각을 강제한다.** `price_unverified`는 `verifiedAt`이 비어 있어야 하고,
`worst_case_cost_unbounded`는 `thinkingCapMicroUsd`가 `null`이어야 하며,
`operational_hold`는 `verifiedAt`·`thinkingCapMicroUsd`·`sources`가 모두
채워져 있어야 한다. 세 값을 교체 가능한 라벨로 쓰면 관리자 화면이 실제
차단 원인이 아닌 것을 보고하게 된다.

#### Google 3종의 미결 쟁점 — thinking 상한

thinking은 **API에서 끌 수 없고**(`"enabled by default and cannot be disabled
in the API"`), `thinking_level`의 `minimal`·`high`는 수준 선택이지 토큰 상한이
아니다. 따라서 요청에서 우리가 상한을 거는 방법은 없다.

2026-08-04 워크시트는 대안으로 **모델 카드의 `Output token limit` 전체가
과금 가능한 thinking·text 토큰이라고 가정하는 보수적 유도**를 제시한다.

| 모델 | 최대 출력 토큰 | text·thinking 단가 | 유도된 상한 | 유도된 최소 크레딧 |
|---|---:|---:|---:|---:|
| Flash Image | 32,768 | $3.00/1M | 98,304µUSD | 1K 190 / 2K 228 / 4K 283 |
| Flash Lite | 4,096 | $1.50/1M | 6,144µUSD | 1K 50 |
| Pro Image | 32,768 | $12.00/1M | 393,216µUSD | 1K·2K 592 / 4K 710 |

**결정(2026-08-04): 이 유도를 채택하지 않는다. 공급자 확인을 받는다.**

결정적인 근거는 GenerateContent API 스키마다. `totalOutputTokens`와
`totalThoughtTokens`가 **별도 필드**이고 `maxOutputTokens`는 response
candidate의 한도로 설명된다. 즉 hidden thinking이 32,768 안에 포함된다는
결론은 그럴듯할 뿐이고, **포함되지 않는다면 A-2는 "지나치게 보수적인 상한"이
아니라 상한 자체가 아닌 계산이 된다.** 그 경우 유도값을
`thinkingCapMicroUsd`에 기록하는 것은 안전한 과대 추정이 아니라 잘못된 값을
증명된 값으로 기록하는 일이다.

제품 근거도 같은 방향이다. 유도 상한을 쓰면 Flash Image 1K가 최소
190크레딧으로 `gpt-image-2` Standard 정사각(70)의 약 2.7배가 되어 비교
모델로서 가격을 설명하기 어렵고, Pro Image의 592/710은 확인을 받더라도
보류가 합리적이다.

따라서 Google 3종의 상태는 **가격 확인 완료 / 요청당 상한 조건부**로
분리해 유지한다.

#### 2026-08-05 문서 재조사 — 상한은 **확인된 부재**다

공식 문서를 다시 훑은 결과, 이 쟁점은 "아직 안 읽은 페이지"가 아니라
**읽었고 그 문장이 없다**로 확정한다.

- Interactions API reference는 `generation_config.max_output_tokens`를
  "응답에 포함할 최대 토큰 수"로 정의하고, 사용량을
  `usage.total_output_tokens`·`usage.total_thought_tokens`·`usage.total_tokens`
  로 **분리 보고**한다. 둘의 합이 상한 이하라는 연결 문장은 없다.
  (`https://ai.google.dev/api/interactions-api`)
- thinking 문서도 비용을 output + thinking의 합으로 설명하고 두 사용량을
  별도 필드로 보고할 뿐, `max_output_tokens`가 그 합을 제한한다고 명시하지
  않는다. (`https://ai.google.dev/gemini-api/docs/thinking`)
- 모델 카드의 출력 한도(Flash Image 32,768 / Flash Lite 4,096 /
  Pro Image 32,768)는 **같은 미정의 수량에 대한 한도**이므로 연결을 대신
  제공하지 못한다.
- 포럼 답변·검색 요약·제품 책임자 전언은 §12의 공식 본문 요건을 충족하지
  않으므로 근거에서 제외한다.

> **판정**: 공식 페이지는 `max_output_tokens`와 thinking 사용량을 각각
> 설명하지만 `total_output_tokens + total_thought_tokens`가 해당 상한 이하라고
> 보장하지 않는다.

**2026-08-14 실측이 이 질문을 부정으로 닫았다.** `gemini-3.1-flash-lite-image`에
`max_output_tokens: 2048`을 보낸 요청이 output 1,602 + thinking 931 = **2,533**을
과금 대상 usage로 보고하고 완성된 이미지를 반환했다. 이 파라미터는 요청 파라미터
이지 비용 천장이 아니다. 아래 "staging 실측 계획"은 그 실행의 절차 기록으로
남기며, **해소 경로가 아니다** — 실행됐고 답은 부정이다. 전체 결과와 표본은
`.github/audits/image-model-verification-worksheet.md` §I.

세 모델은 `worst_case_cost_unbounded`를 유지한다. 재검토 조건은 Google이 thinking
토큰 상한을 거는 요청 파라미터를 제공하거나, 공식 문서가 과금 대상의 상한을
명시하는 경우다.

#### 남은 증거는 산문이 아니라 과금 신호다 — staging 실측 절차 (2026-08-14 실행 완료, 판정 부정)

`npm run measure:google-image-thinking-cap`이 이 절차를 수행한다. **매 실행이
실제 유료 이미지 생성**이므로 `--i-accept-the-cost` 없이는 아무것도 보내지
않고, §15의 eval 예산 승인이 선행돼야 한다.

1. 모델별로 `1K`·`1:1`·image-only 요청을 실행한다.
2. `max_output_tokens`를 **명시**한다.
3. 지원 모델은 `thinking_level: "high"`로 thinking 발생 가능성을 높인다.
4. 각 응답에서 `usage.total_output_tokens + usage.total_thought_tokens`를
   계산한다.
5. 그 값이 요청한 `max_output_tokens` 이하인지 확인한다.
6. 복잡한 프롬프트 여러 개와 **둘 이상의 상한값**으로 반복한다.
7. **낮은 상한에서 실제 제한 동작(`incomplete` 등)이 한 번 이상 나타나야
   한다.** 항상 상한보다 한참 낮게 쓴 표본만으로는 상한 강제를 입증할 수
   없다 — 스크립트는 이 경우를 `inconclusive_limit_never_bound`로 보고하며
   통과로 세지 않는다. 카드 한도가 가장 낮은 `gemini-3.1-flash-lite-image`
   (4,096)가 첫 측정 대상으로 가장 유용하다.
8. 요청 JSON·원본 응답·모델 ID·응답 ID·실행 일시를 감사 증거로 보존한다.

**이미지가 없는 응답도 표본이다.** 상한이 실제로 물린 표본은 정의상 완성된
이미지가 없다. production parser(`parseGoogleImageResponse`)는 "정확히 한 장"이
아니면 fail-closed로 거절하는데 — 과금할 대상이 없으니 옳다 — 측정을 그 parser
하나로만 읽으면 **가장 비싸게 산 최고의 증거를 버린다.** 두 질문을 분리한다:
과금 가능한 이미지인가(`parseGoogleImageResponse`)와 무엇이 과금됐고 왜
멈췄는가(`readGoogleImageInteraction`). 후자는 이미지를 요구하지도 반환하지도
않으므로 전자의 우회로가 될 수 없고, production 경로가 후자로 응답을 승격해서는
안 된다.

**한 프롬프트의 반복은 한 프롬프트의 증거다.** 모델이 얼마나 생각하는지는
무엇을 물었는지의 함수이므로, `--repeats`를 올려도 §12의 "복잡한 프롬프트
여러 개"는 충족되지 않는다. 스크립트는 서로 다른 비용 축(조밀한 라벨 기하 /
다국어 문자 렌더링)을 가진 내장 프롬프트 2종을 `--prompts`로 제공하고,
한 프롬프트의 표본만으로는 긍정 판정(`consistent_with_limit_bounding_billable_output`)
을 내지 않는다 — `consistent_but_single_prompt`로 보고한다. 반증은 한
프롬프트로도 성립하므로 이 제약은 긍정 판정에만 적용한다.

**첫 반증 또는 첫 판독 불능에서 즉시 멈춘다.** 상한을 넘긴 표본 하나가 질문을
끝내고, 두 번째 표본이 그것을 더 참으로 만들지 못한다. 판독 불능·usage 미보고
이후의 숫자도 신뢰할 수 없다. 스크립트가 `stoppedEarly`와 `sentCalls`를
보고한다.

**스크립트는 금액을 집행하지 않는다.** 호출 수(`--prompts x --repeats`)만
제한하며, §15의 예산은 인자를 고르는 사람이 지킨다. "도구가 막아 줄 것"에
기대지 않는다.

**스크립트는 adapter와 같은 request builder·같은 registry helper를 통해서만
요청을 만든다.** 측정 대상은 production이 실제로 과금당하는 요청이므로, 한쪽만
바뀐 요청으로 얻은 수치는 근거가 되지 않는다. 실제로 한 번 어긋난 적이 있다 —
adapter가 Google의 delivery MIME(`image/jpeg`)을 반영한 뒤에도 스크립트는 자체
표현식으로 PNG를 요청해 같은 HTTP 400을 다시 냈다. 지금은 delivery MIME을
`imageDeliveryMimeType()` 한 곳에서 정하고,
`scripts/security-regression-check.mjs`가 두 호출부 모두 그 helper를 쓰는지
검사한다.
   API key와 사용자 프롬프트는 로그에 남기지 않는다(스크립트는 프롬프트를
   sha256 앞자리로만 기록한다).

**`usage.total_tokens`는 입력 토큰까지 포함하므로 `max_output_tokens`와 직접
비교하지 않는다.** 코드에서는 `googleBillableOutputTokens()`가 비교 대상
수량을 이름으로 고정한다.

#### adapter는 선행하고 활성화는 하지 않는다

Interactions API adapter(`lib/googleImageRequest.ts`,
`imageProviderAdapter.ts`의 `generateWithGoogle`)는 **비활성 상태에서 선행
구현**한다. `generateImageWithProvider`가 `disabledReason`이 있는 모델을
dispatch 전에 거부하므로 실행 경로가 없고, 위 실측 자체가 이 코드를 통해야
하기 때문이다. **adapter 구현은 활성화 승인도 판매가 확정도 아니다.**

- 요청·응답 어휘는 **Interactions API 하나만** 쓴다. GenerateContent는 같은
  요청을 다른 이름으로 표현하며(`generationConfig.maxOutputTokens`,
  `candidates[].content.parts[].inlineData.data`,
  `usageMetadata.thoughtsTokenCount`) `imageConfig`는 deprecated다. 두 어휘를
  섞은 body는 그럴듯해 보이면서 틀린다 — security regression check가 강제한다.
- 인증은 `x-goog-api-key`이며 OpenAI식 bearer token이 아니다.
- **`model_output` step만 읽는다.** thinking 과정에서 중간 이미지가 나올 수
  있고, 완성본 요금을 받으면서 습작을 저장하는 실패는 둘 다 그럴듯한 그림이라
  아무도 눈치채지 못한다. 전달된 이미지가 1장이 아니면 fail-closed다.
- `thinking_level`은 **모델별 profile**에 둔다. 지원 여부가 균일하지 않으므로
  값이 없으면 필드를 아예 보내지 않는다.
- `ImageModelProfile.maxOutputTokens`는 **비용 상한이 아니다.** 모델 카드가
  공표한 수치이자 매 요청이 보내는 값일 뿐이고, 상한 성립 여부는 여전히
  `priceVerification.thinkingCapMicroUsd`(현재 `null`)가 답한다. 이 둘을
  혼동하지 않도록 unit test와 regression check가 함께 고정한다.

#### 판매 크레딧은 별도 승인이다

위 수치는 전부 `minimumCreditsForImageOption()`이 내는 **수학적 바닥값**이다.
마진·가격 drift·환불 위험을 반영한 판매 크레딧은 제품 책임자가 승인한다.

**승인 이력**

| 모델·옵션 | 바닥값 | 승인 판매가 | 원가/크레딧 | 900µ 상한 대비 여유 | 승인일 |
|---|---:|---:|---:|---:|---|
| Grok Imagine 1K | 62 | **75** | 733µUSD | 18.5% | 2026-08-04 |
| Grok Imagine 2K | 84 | **100** | 750µUSD | 16.7% | 2026-08-04 |

1K 75크레딧은 `gpt-image-2` Standard 정사각(70)보다 7%만 높아 비교 화면에서
설명 가능한 차이다. 운영 데이터가 쌓인 뒤(예: 30일 또는 성공 500건) 실패·
환불률이 낮으면 70/95로 낮추는 재검토가 가능하다.

**승인된 가격은 `operational_hold` 상태에서도 `prices`에 기록한다.** 가격
질문이 끝났다는 것이 이 사유의 의미이고, `check:image-pricing`이 비활성
상태에서도 바닥값을 검사한다. 승인 수치를 주석에 두었다가 출시일에 손으로
옮기는 것이 더 위험하다. 나머지 두 사유(`price_unverified`,
`worst_case_cost_unbounded`)는 여전히 `prices`가 비어 있어야 한다.

Grok 활성화(2026-08-05)가 이 규칙의 결과다: hold 해제는 `disabledReason`
한 줄 변경이었고 가격을 다시 입력하지 않았다. 현재 `operational_hold`를 쓰는
모델은 없지만 사유와 그 검사는 그대로 유지한다.

#### xAI 활성화 순서 (2026-08-05, 실행 기록)

1. adapter(`lib/xaiImageRequest.ts`) 구현 — 활성화와 별개 결정.
2. **환경변수를 코드보다 먼저 배포**: Railway `Tomverse` 서비스,
   production `IMAGE_PROVIDER_XAI_COST_MICROUSD_PER_DAY=50000000` /
   `_PER_MONTH=500000000`, staging 둘 다 floor `10800000`.
   `disabledReason`이 `null`이 되는 순간 xAI가 활성 provider가 되므로,
   flag가 켜진 환경에 예산이 없으면 `/api/ready`가 그때부터 실패한다.
3. registry `disabledReason: null` 배포. production flag는 OFF 유지(§15).
4. staging flag ON → 1K 정사각 1회 생성 + gpt-image-2와 2-모델 비교 1회.

#### 등록-비활성은 사용자에게 보인다

카탈로그 이미지 탭은 등록된 모델을 전부 표시하므로(§13,
`docs/ui-contracts/image-generation-workspace.md`), 현재 이미지 탭에는 활성
1개와 "준비 중" 4개가 함께 보인다. 이는 의도된 노출이다 — 제품이 결정한
모델은 부재가 아니라 명시된 보류로 읽히는 편이 낫다. 보류가 많아지는 상태가
바람직하지 않다면 그것은 registry에서 후보를 빼는 결정이지 탭에서 숨기는
결정이 아니다.

#### 크기 체계 — 단계적 확장 (2026-08-04 결정)

`ImageSize`는 `1024x1024`·`1536x1024`·`1024x1536` 세 값이며, **제품 옵션과
OpenAI의 실제 픽셀 문자열을 한 값에 섞고 있다.** Google의 0.5K·2K·4K와 xAI의
2K는 표현할 수 없고, **Google의 1K landscape는 `1536x1024`와 픽셀 규격이
다르다** — 문자열 치환으로는 해결되지 않는다.

결정: **xAI는 1K 정사각만 먼저 출시한다.** 1024×1024는 현재 OpenAI 정사각과
정확히 같아 cross-provider 비교가 가장 공정하다. Google 또는 xAI 2K를 열기
전에 아래 구조로 확장한다.

- 제품 선택은 `resolutionTier` + `aspectRatio` 두 축으로 표현한다.
- provider adapter가 이를 provider별 `size` 또는 `resolution`·`aspect_ratio`로
  변환한다.
- 결과에는 실제 디코딩된 `width`·`height`를 기록한다.
- 감사 snapshot에 provider로 전송한 실제 파라미터를 보존한다.
- 기존 `size` 값은 과거 기록으로 유지하고 **소급 치환하지 않는다.** 그 컬럼의
  의미는 "실제 픽셀 규격"이므로, `1k|16:9` 같은 새 제품 옵션 의미를 그 컬럼에
  넣어 재사용하지 않는다. 새 옵션은 snapshot 안에 별도로 보존한다.

비교 가능 여부는 같은 `resolutionTier + aspectRatio`로 판정하되, 결과 화면에는
실제 픽셀 크기를 표시한다.

**진행 상황(2026-08-04)**

| 단계 | 상태 |
|---|---|
| tier·aspect 어휘와 provider 변환 (`lib/imageResolution.ts`) | 완료 |
| 실제 디코딩된 `width`·`height` 기록 (`ImageGeneration.outputWidth/Height`) | 완료 |
| 전송 파라미터 감사 snapshot (`ImageGeneration.providerRequestParams`) | 완료 |
| 정산을 예약 snapshot에 고정 | 완료 (2026-08-04) |
| 가격표를 (tier, aspect) key로 이전 | **미착수 — 첫 다중 해상도 모델 도입과 함께. `pricingVersion`은 올리지 않는다** |
| UI 크기 선택지 두 축 분리 | 미착수 |

**감사 snapshot에 prompt는 넣지 않는다.** prompt는 이미 같은 행에 있고, JSON
blob에 사본을 두면 삭제 경로가 찾아야 할 곳이 하나 더 생긴다. snapshot이
답해야 하는 질문은 "무엇을 요청했는가"이지 "사용자가 무엇을 입력했는가"가
아니다. 실패한 시도에도 기록한다 — 무엇을 보냈는지 알아야 하는 순간이 바로
실패했을 때다.

**어휘와 변환 계층이 `lib/imageResolution.ts`에 들어갔다.** tier·aspect 정의, 기존 `ImageSize`와의 양방향 매핑, provider별
요청 변환(OpenAI 픽셀쌍 / xAI `resolution`+`aspect_ratio` / Google
`imageSize`+`aspectRatio`)이 있고 xAI adapter가 이를 쓴다. 판매 가능한
조합은 `SELLABLE_IMAGE_OPTIONS` 3종 그대로이며, **가격표 key와
`ImageGeneration.size` 컬럼은 아직 legacy 문자열이다** — 그 둘은 migration과
새 `pricingVersion`이 함께 움직이는 별도 변경이다.

`legacyImageSizeForOption()`이 2K·4K에 `null`을 돌려주는 것은 표의 빈칸이
아니라 계약이다. 값을 채워 근처 픽셀쌍으로 매핑하면 1K 가격으로 2K 이미지를
청구하게 되고, 사용자는 그 차이를 볼 방법이 없다.


## 13. 진입점과 노출 정책 (v2)

이 절이 정하는 것을 화면 단위로 옮긴 UI 계약은
`docs/ui-contracts/image-generation-workspace.md`에 있다. 렌더링 세부(테스트
ID, 상태 매트릭스, 릴리스 차단 기준)는 그쪽이 정본이고, 두 문서가 어긋나면
이 정책이 우선한다.

- 진입점은 다섯 곳이다: ① 데스크톱 사이드바 **split-button**(기본 클릭 =
  새 채팅, 펼침 메뉴에 이미지 생성), ② 모바일 **"새로 만들기" bottom
  sheet**(split-button을 축소하지 않는다), ③ 채팅 컴포저 도구 메뉴의
  **이미지 생성**(서버 행 없이 image draft로 전환), ④ 모델 카탈로그의
  **`채팅 | 이미지` 분리 탭**, ⑤ 채팅 컴포저의 **이미지 요청 인계 제안
  칩**(아래). v1의 별도 "새 이미지" 버튼은 대체·제거한다.
- **⑤ 제안 칩은 진입점이지 실행이 아니다.** 사용자가 명백한 raster 이미지
  생성을 요청하는 중이라고 판정되면 컴포저 위에 한 줄로 제안을 띄우되,
  다음을 절대 조건으로 한다.
  - **사용자가 눌러야** image draft로 이동한다. 확인 없는 자동 draft 전환은
    금지다.
  - **확인 없는 generation 제출은 금지**다. 가격·모델 선택은 계속 제출 전에
    표시한다(§3·§11).
  - 칩이 떠 있어도 **일반 채팅 제출을 막지 않는다**. 제안은 무시할 수 있어야
    한다.
  - **Guest·Free 잠금 조건은 클릭 전에 칩 안에서 표시**한다(아래 잠금 노출
    규칙과 동일).
  - flag가 꺼져 있으면 칩은 **존재하지 않는다**.
  - 텍스트 밀집 도표·인포그래픽 요청, 첨부 이미지 편집·참조 요청, 첨부 이미지
    분석 요청은 **칩 대상이 아니다**. 이 셋을 이미지 workspace로 자동
    안내하지 않는다.
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

## 16. 모델 소유자와 추론 공급자는 다른 질문이다 (2026-08-14)

`gemini-3.1-flash-image`(Nano Banana 2)를 Google에 직접 호출하는 경로는
**영구히 닫혔다.** §12.1의 실측이 `max_output_tokens`가 과금 대상 합계를
bound하지 않음을 보였고, 유한한 최악 원가가 없으면 고정 가격을 붙일 수 없다.
같은 모델을 **성공 이미지 단위로 파는 gateway**를 통해 사면 변동 부분이 그것을
사업으로 하는 쪽으로 넘어가고, Tomverse는 다른 이미지 모델과 같은
`bounded_fixed` 계약을 유지한다.

### 16.1 두 필드를 분리한다

| 필드 | 답하는 질문 | 따라오는 것 |
|---|---|---|
| `provider` | 누구를 호출하고 누가 우리에게 청구하는가 | 예산 `IMAGE_PROVIDER_{P}_COST_*`, credential, readiness, 재시도 정책, 장애 귀속 |
| `modelOwner` | 누가 만든 모델인가 | 모델 카드 브랜딩, 마케팅 문구 |

- **`modelOwner`가 없으면 `provider`와 같다는 뜻이다.** 직접 연동은 전부 그렇고,
  필드가 생기기 전과 의미가 같다. 해석은 `imageModelOwner()` 한 곳에서만 한다.
- **fal로 호출하면서 `IMAGE_PROVIDER_GOOGLE_*` 예산을 차감하지 않는다.** 그 숫자는
  여전히 더해지지만 돈이 없는 봉투에 더해지고, 그동안 fal의 실제 지출은 아무도
  보지 않는다. 모든 하위 지표가 그럴듯한 채로 틀린다.
- `lib/imageProviderBudget.ts`는 `modelOwner`를 읽지 않는다.
  `scripts/security-regression-check.mjs`가 강제한다.
- 장애 관측은 **모델 장애와 gateway 장애를 구분**한다. 한 필드로는 구분할 수 없다.
- 사용자에게는 소유자 브랜드를 보여주되 **상세에 gateway를 명시한다.** 숨기지
  않는다.

### 16.2 gateway 경유 모델의 활성화 조건

`fal-ai/nano-banana-2`는 `price_unverified`로 등록돼 있다. **아래를 모두 충족하기
전에는 어느 환경에서도 활성화하지 않는다.**

1. **가격 원문 확인.** fal이 공표한 성공 이미지당 가격을 §12의 요건대로 공식
   본문에서 확인하고 `priceVerification.sources`·`verifiedAt`를 채운다.
   2026-08-14 현재 이 저장소의 실행 환경에서 `fal.ai`는 egress proxy에 차단돼
   있어 확인하지 못했다. **읽지 않은 URL을 `sources`에 적지 않는다** — 적는 순간
   그것은 "이 근거로 검증했다"는 진술이 된다.
2. **요청 고정.** 1K, 정확히 1장, web search 비활성, **high thinking 고정(사용)**.
   각각이 별도 과금 항목이므로 최악 원가는 이 넷이 고정된 상태에서만 유한하다.
   high thinking만 유일하게 **끄는 것이 아니라 켜는** 고정이며, 그 2,000µUSD가
   바닥값 97의 구성요소다(§16.4·§16.5).
3. **재시도·저장 헤더.** gateway 기본값이 서버 오류에 재시도하고 입출력을
   보관한다면, 우리 요청은 그 둘을 명시적으로 끈다. 자동 재시도는 고정가 계약에서
   원가를 배수로 만들고, 입출력 보관은 우리가 통제하지 않는 곳에 사용자 프롬프트를
   남긴다.
4. **자산 즉시 복사.** gateway가 돌려주는 CDN URL은 만료 전 공개 접근 가능하다고
   보고, 즉시 사설 저장소로 복사한 뒤 짧은 만료를 적용한다. 그 URL을 저장하거나
   클라이언트에 그대로 넘기지 않는다.
5. **예산.** `IMAGE_PROVIDER_FAL_COST_MICROUSD_PER_DAY`·`_PER_MONTH`를 배포보다
   **먼저** 설정한다. production에 활성 모델이 있는데 예산이 없으면 `/api/ready`가
   실패한다.
6. **가격 drift 차단.** 배포 전 승인 가격과 공급자 현재 가격을 대조하고, 응답이
   과금 단위를 보고하면 저장한다. 실단가가 승인 snapshot과 다르면 즉시 차단한다.
   "가격은 변경될 수 있다"고 공표된 공급자에 고정가를 붙이는 것이므로, 이 대조가
   그 격차를 메우는 유일한 장치다.
7. **판매 크레딧 승인.** `minimumCreditsForImageOption()`이 내는 수학적 바닥값은
   승인가가 아니다(§3·§4).

### 16.3 확인된 원문 (2026-08-14)

fal.ai와 ai.google.dev를 이 저장소의 실행 환경에서 직접 읽었다. 아래 인용은
**본문 그대로**이며 요약이 아니다.

**가격** — `https://fal.ai/models/fal-ai/nano-banana-2`

> Your request will cost **$0.08** per image. For $1.00, you can run this model
> 12 times. 2K and 4K outputs will be charged at 1.5 times and 2 times the
> standard rate, respectively. 0.5K (512px) resolution outputs will be charged
> at 0.75 times the standard rate. If web search is used, an additional $0.015
> will be charged. If high thinking is used, an additional $0.002 will be
> charged. **Note: Pricing is subject to change.**

같은 페이지가 모델을 이렇게 설명한다.

> Google's Gemini 3.1 Flash Image architecture

**과금 방식** — `https://fal.ai/docs/documentation/model-apis/pricing`

> You pay only for successful outputs, and you are never charged for server
> errors or time spent waiting in the queue.

> Server errors are never billed. If a request fails with an HTTP 500 or higher
> status code, no charge is incurred.

같은 페이지가 **가격 조회 API**를 제공한다. §16.2-6의 drift 대조는 스크래핑이
아니라 이것으로 한다.

> `curl "https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/flux/dev" -H "Authorization: Key $FAL_KEY"`
> … The response includes the billing unit and unit price for each endpoint:
> `{"prices":[{"endpoint_id":"...","unit_price":0.025,"unit":"image","currency":"USD"}]}`

**재시도** — `https://fal.ai/docs/documentation/model-apis/common-parameters`

> X-Fal-No-Retry — Disable automatic retries for this request. **By default,
> queue-based requests are retried for up to 10 total attempts on server errors
> (503, 504, connection errors).** … Values `"1"`, `"true"`, `"yes"` to disable

**재시도가 원가를 배수로 만든다는 서술은 정확하지 않다.** 재시도는 서버 오류에
일어나고 서버 오류는 과금되지 않는다. 끄는 진짜 이유는 다른 것이다 — **성공한
생성의 응답이 유실된 뒤의 재시도는 두 번째 이미지를 만들고 두 번 과금된다.**
고정가 계약에서 사용자는 한 번 냈는데 우리는 두 번 낸다. 그래서 끈다.

**입출력 보관** — 같은 페이지

> X-Fal-Store-IO … **This only prevents storage of the JSON payloads. CDN files
> generated during processing are still accessible (subject to media expiration
> settings).**

**자산 수명** — 같은 페이지

> X-Fal-Object-Lifecycle-Preference — Control how long generated files are
> stored on fal's CDN and who can access them. **Default: Your account setting
> (forever and publicly readable if not configured)** … Format JSON:
> `{"expiration_duration_seconds": <seconds>, "initial_acl": {...}}`

**이것이 §16.2-4를 권고에서 필수로 만든다.** 기본값이 "영구 보관, 공개 접근"이다.
`X-Fal-Store-IO: 0`은 JSON payload만 막고 **CDN 파일은 막지 않는다**고 같은 문서가
명시한다. 따라서 요청마다 `X-Fal-Object-Lifecycle-Preference`로 짧은 만료를
지정하고 자산을 즉시 사설 저장소로 복사한다. 둘 중 하나만 하면 사용자 이미지가
공개 CDN에 남는다.

**Google 종료 일정** — `https://ai.google.dev/gemini-api/docs/deprecations`

| 모델 | 종료일 | 권고 대체 |
|---|---|---|
| `imagen-4.0-generate-001` · `-ultra-` · `-fast-` | **August 17, 2026** | `gemini-3.1-flash-image` |
| `gemini-2.5-flash-image` | **October 2, 2026** | `gemini-3.1-flash-image-preview` |
| `gemini-3.1-flash-image` | **No shutdown date announced** | — |
| `gemini-3-pro-image` | **No shutdown date announced** | — |

- **Imagen 4 경로는 폐기한다.** 3일 뒤 종료이고, Google 자신이 권고하는 대체가
  `gemini-3.1-flash-image` — 즉 이 문서가 fal을 통해 사려는 바로 그 모델이다.
- **`gemini-2.5-flash-image`(원본 Nano Banana) 브리지는 채택하지 않는다.** 남은
  기간이 7주다. adapter·가격·크레딧 승인·UI를 갖춰 7주 쓰고 버리는 비용이 fal
  연동을 기다리는 비용보다 크다. 마케팅 공백이 실제로 문제가 되면 그때 다시
  판단하되, 기본은 만들지 않는 것이다.
- **`gemini-3.1-flash-image`는 종료 예정이 없다.** fal 경로가 단명할 위험은 모델
  쪽에는 없다.

### 16.4 요청당 최악 원가와 크레딧 바닥값

| 항목 | µUSD | 근거 |
|---|---:|---|
| fal 1K 이미지 | 80,000 | 위 인용, 성공 시에만 |
| Tomverse 프롬프트 예산 | 5,000 | `IMAGE_PROMPT_BUDGET_MICRO_USD`. **fal의 과금 항목이 아니라 다른 모델과 같은 방식으로 얹는 여유분**이다 |
| high thinking | 2,000 | 위 인용의 $0.002. **요청이 `thinking_level: "high"`를 보내므로 매번 발생시키기로 한 비용**이다 |
| web search | — | 요청이 켤 수 없으므로 제외. 숫자가 아니라 **adapter가 지켜야 할 성질**이다 |
| **최악 요청 원가** | **87,000** | |
| **수학적 최소 크레딧** | **97** | `ceil(87,000 / 900)` |

`thinkingCapMicroUsd`가 2,000인 이유는 안전 여유가 아니라 **요청이 실제로 그것을
쓰기 때문**이다. `thinking_level`은 생략하면 비활성이므로(fal 스키마: "Omit to
disable"), `"high"`를 보내는 것은 매번 $0.002를 발생시키겠다는 결정이다. 이
숫자와 요청은 하나의 결정이어야 하고, 그래서 고정 필드 목록이 adapter가 아니라
§16.5에 있다. 생략했다면 최악은 85,000, 바닥은 95다.

**판매 크레딧은 별도 승인이다.** 바닥값 97은 승인가가 아니다. Grok 1K가 바닥값
62에 승인가 75(여유 21%)인 것과 같은 비율이면 후보는 115~120이고, 이는 결정안에
올릴 범위이지 결정이 아니다. `prices`는 승인 전까지 비워 둔다.

### 16.5 승인과 요청 계약 (2026-08-14)

**승인 (제품 책임자, 2026-08-14)**

> `fal-ai/nano-banana-2`, 1K, 1장, High thinking, Web Search 비활성 조건에서
> 최대 원가 87,000µUSD, 정책 바닥 97크레딧을 확인하고 판매가 120크레딧을
> 승인한다. 옵션 확대는 별도 가격 검증과 승인을 요구한다.

120은 크레딧당 725µUSD다. Grok Imagine 1K가 55,000 ÷ 75 = 733µUSD이므로 두
이웃 모델이 같은 여유를 갖는다. 115였다면 757µUSD로 여유가 줄고 화면에서
설명하기도 어렵다.

**바닥값 97은 설정에 딸린 숫자다.** `thinking_level`을 생략하면 최대 원가는
85,000µUSD, 바닥은 95다. 가격을 97로 잡고 요청 모드를 적지 않으면 감사 산식과
코드가 어긋난다. 그래서 아래 필드 목록이 가격 결정의 일부이지 구현 세부가
아니다.

#### 고정 요청 필드 — fal 공식 스키마에서 확인 (2026-08-14)

`https://fal.ai/models/fal-ai/nano-banana-2/api`

| 필드 | 고정값 | 스키마가 말하는 기본값 | 고정하는 이유 |
|---|---|---|---|
| `num_images` | `1` | `1` | 고정가는 한 장에 대한 것이다 |
| `resolution` | `"1K"` | `"1K"` | 2K·4K는 1.5배·2배로 별도 가격·별도 승인 |
| `aspect_ratio` | `"1:1"` | **`"auto"`** | **`auto`는 "let the model decide based on the prompt"** — 검증된 가격과 `sizes: ["1024x1024"]` 계약이 모델 판단에 달리게 된다 |
| `thinking_level` | `"high"` | 없음(생략 시 비활성) | 승인된 원가 산식의 2,000µUSD가 이 값이다 |
| `enable_web_search` | `false` | 문서에 명시 없음 | $0.015 별도 과금. 기본값에 기대지 않는다 |
| `limit_generations` | `true` | `true` | 프롬프트가 여러 장을 지시해도 무시하고 중간 이미지도 버린다 |
| `system_prompt` | `""` | `""` | 우리가 넣지 않은 지시가 결과와 원가에 개입하지 않게 한다 |
| `output_format` | 명시 | `"png"` | 저장 MIME은 응답이 말한 것을 기록하되, 요청은 가정하지 않는다 |
| `safety_tolerance` | 명시 | `"4"` (1이 가장 엄격, 6이 가장 느슨) | moderation 기본값을 조용히 물려받지 않는다 |

**`aspect_ratio`는 제시된 목록에 없었고, 빠지면 계약이 깨진다.** 스키마 기본값이
`auto`이므로 명시하지 않으면 1:1이 아닌 이미지가 올 수 있다.

추가 요구사항:

- **서버가 위 값을 사용자 입력으로 덮어쓸 수 없다.** 프롬프트만 사용자 것이다.
- 반환 이미지가 정확히 1장이 아니면 실패 처리한다(직접 Google 경로와 같은 규칙).
- 다운로드 URL은 host allowlist로 제한하고, MIME·파일 크기·실제 해상도를
  저장 전에 검증한다.
- `X-Fal-No-Retry`를 보낸다. 이유는 원가 배수가 아니라 **성공 후 응답 유실 뒤의
  재시도가 두 번째 이미지를 만들고 두 번 과금**하기 때문이다(§16.3).
- `X-Fal-Store-IO: 0`과 `X-Fal-Object-Lifecycle-Preference`를 **둘 다** 보낸다.
  전자는 JSON payload만 막고 CDN 파일은 막지 않는다.
- `sync_mode: true`는 검토 대상이다. 스키마상 "the media will be returned as a
  data URI and the output data won't be available in the request history"이므로
  공개 CDN 의존을 줄인다. 1K 이미지 크기가 서버 처리에 무리가 없을 때만 쓰고,
  쓰더라도 `X-Fal-Store-IO: 0`은 유지한다.

#### 가격 drift 검사의 범위

fal이 "Pricing is subject to change"라고 공표하므로 대조가 유일한 안전장치다.
다만 **fail-closed의 대상은 이 모델이지 서비스 전체가 아니다.**

- 배포 전 `GET /v1/models/pricing?endpoint_id=fal-ai/nano-banana-2`로 승인
  가격($0.08 + high $0.002)과 정확히 대조한다.
- 불일치하면 **Nano Banana 2만** 활성화하지 않는다.
- 런타임 billable unit을 정산 snapshot에 저장하고, 승인값을 넘으면 신규 fal
  요청을 차단하고 경고한다.
- **fal pricing API 장애가 `/api/ready`를 503으로 만들지 않는다.** 채팅과
  OpenAI·xAI 이미지까지 함께 멈추면 그것은 안전장치가 아니라 단일 장애점이다.

#### 활성화 순서

승인이 필요한 금액은 판매가 하나가 아니다.

1. 판매가 120크레딧 승인 — **완료 (2026-08-14)**
2. adapter·테스트 구현. 모델은 `operational_hold` 유지
3. **fal credential, prepaid 충전액과 자동충전 여부, 일간·월간 provider budget
   승인** → 환경변수 **선배포**
4. 가격 drift 대조 통과
5. registry 활성화

3번은 아직 승인되지 않았다. 2번은 그것과 무관하게 진행할 수 있다.

### 16.6 운영 예산 승인 (2026-08-14)

**승인 (제품 책임자, 2026-08-14)**

> Fal 초기 production canary 예산을 일 $12(`12000000`µUSD), 월
> $50(`50000000`µUSD), prepaid $50, 자동충전 비활성으로 승인한다. 잔액·가격·
> 성공률을 관측한 뒤 별도 승인으로 확대한다.

| 항목 | 값 | 환경변수 |
|---|---:|---|
| 일간 | 12,000,000µUSD ($12) | `IMAGE_PROVIDER_FAL_COST_MICROUSD_PER_DAY` |
| 월간 | 50,000,000µUSD ($50) | `IMAGE_PROVIDER_FAL_COST_MICROUSD_PER_MONTH` |
| prepaid 충전액 | $50 | fal 대시보드 |
| 자동충전 | **비활성** | fal 대시보드 |

근거:

- 저장소가 강제하는 이미지 예산 바닥은 현재 **$10.80/일**(플랜 크레딧에서 유도)
  이므로 $12는 그 위이고 정상 적용된다. 이보다 낮게 설정하면 유도값으로 올려
  강제된다.
- 최악 원가 87,000µUSD 기준 하루 약 137건, 월 약 574건.
- **월 예산 $50과 prepaid $50을 일치시킨다.** 사람이 수동으로 추가 충전하더라도
  앱 쪽 월 예산이 그 이상의 지출을 막는다. 두 층이 같은 숫자를 말하므로 어느
  한쪽만 올리는 것은 실수가 아니라 결정이 된다.
- **자동충전은 끈다.** prepaid 잔액이 바닥나면 요청이 막히는 것이 초기 canary에
  원하는 동작이다. 자동충전은 그 바닥을 없애서, 비용 사고를 "차단"이 아니라
  "청구서"로 바꾼다.

관측: 잔액을 fal billing API로 보고 **$15 경고 / $10 긴급**. 2주 또는 성공
300건 후 문제가 없으면 월 예산과 prepaid를 각각 $120로 올리는 것을 별도 승인
안건으로 올린다.

**자동충전을 나중에 켠다면 "활성"만 정하는 것으로는 부족하다.** 충전 금액,
발동 잔액, 월간 자동충전 상한을 함께 승인해야 한다 — 세 값이 없는 자동충전은
상한 없는 지출과 같다.

### 16.7 high thinking은 끄는 것이 아니라 켜는 고정이다

2026-08-14에 문서와 코드가 하루 만에 어긋났다. adapter는
`thinking_level: "high"`를 보내고 `thinkingCapMicroUsd`는 2,000인데, §16.2와
registry의 `disabledNote`는 "high thinking 비활성"이라고 적고 있었다. 세 진술 중
둘이 틀렸고 그 사이에 아무 검사도 없었다.

**고정 네 가지 중 셋은 끄는 고정이고 하나는 켜는 고정이다.**

| 고정 | 방향 |
|---|---|
| 1K | 값 지정 |
| 정확히 1장 | 값 지정 |
| web search | **끔** |
| high thinking | **켬** |

이 숫자와 이 필드는 하나의 결정이다. 87,000µUSD 최악값 중 2,000이 이 필드에
달려 있고, 생략하면 정직한 상한은 0, 바닥은 95다. 이제
`tests/falImageRequest.test.mjs`가 두 파일을 가로질러 이 일치를 강제하고,
`scripts/security-regression-check.mjs`가 필드 자체를 고정한다.


### 16.8 활성화 기록 (2026-08-14)

`fal-ai/nano-banana-2`의 `disabledReason`을 `null`로 바꿨다. §16.2가 요구한 네
조건이 모두 충족됐고, 각각이 무엇으로 충족됐는지 아래에 적는다 — 활성화는
"준비됐다는 판단"이 아니라 **조건별로 지목 가능한 증거**여야 한다.

| §16.2 조건 | 충족 근거 |
|---|---|
| 가격 검증 | fal 공표 원문(§16.3) + `check:fal-image-pricing`이 live API에 대해 `matched` (`0.08 USD per images`) |
| adapter | `lib/imageProviderAdapter.ts`의 `generateWithFal`, 실제 요청 1건으로 증명 |
| 재시도·저장 헤더 | `X-Fal-No-Retry: 1`, `X-Fal-Store-IO: 0`, lifecycle 900초 — 실행 기록에 그대로 남음 |
| 예산 | `IMAGE_PROVIDER_FAL_COST_*` 배포 및 prepaid 충전(§16.6) |

증거는 `.github/audits/evidence/fal-nano-banana-2-smoke/`에 있고,
`npm run check:fal-smoke-evidence`가 PR Fast Gate에서 결론을 **다시 계산한다.**

#### 실측이 확정한 것

`x-fal-billable-units: 1.025` → `1.025 × 80,000 = 82,000µUSD`. §16.4 표의 fal
측 두 항목(80,000 이미지 + 2,000 high thinking)과 정확히 일치한다. 0.025 단위가
곧 $0.002 할증이다. `check:fal-image-pricing`은 fal pricing API가 단가 하나만
답하므로 이 할증을 비교하지 못한다고 스스로 적어 두는데, 그 공백을 이 실측이
메웠다.

배달 이미지는 실제로 1024×1024였다. `aspect_ratio` 기본값이 `"auto"`이므로
§16.5에서 고정하지 않았다면 팔린 크기와 다른 모양이 조용히 배달됐을 것이다.

#### 활성화가 켜는 것과 켜지 않는 것

**켜지 않는 것.** 이미지 생성 전체는 여전히 `feature.imageGenerationEnabled`
(`AppSetting`, 값이 정확히 `"true"`일 때만 참) 뒤에 있다. registry 행을 켠 것만으로
사용자에게 노출되는 것은 없고, `/api/ready`도 이 flag가 켜져 있을 때만 이미지
예산 부재를 실패로 취급한다(`lib/imageProviderBudgetReadiness.ts`).

**켜는 것.** `listActiveImageProviders()`에 `fal`이 들어간다. 이때부터 fal은
예산·동시성·readiness가 적용되는 provider이고, `check:fal-image-pricing`이
`skipped`에서 **fail-closed**로 바뀐다 — 활성 상태에서 가격을 읽지 못하면 실패다.

#### 남은 구멍 (의도적으로 기록)

`check:fal-image-pricing`은 `FAL_KEY`가 필요해 **어느 workflow에서도 실행되지
않는다.** `check:openai-model-access`와 같은 취급이며, 배포 전 사람이 돌린다.
그 결과 고정가가 기대는 유일한 drift 장치가 자동으로는 돌지 않는다. 오늘의
가격은 확인됐으므로 활성화를 막을 사유는 아니지만, **"검사가 존재한다"와 "검사가
돌아간다"는 다른 사실이므로** 여기에 적는다. 자동화하려면 저장소 secret으로
`FAL_KEY`가 필요하고, 그것은 별도 결정이다.

`disabledNote`는 제거했다. 이 필드는 disabled 모델용인데 admin panel이 조건 없이
렌더링하므로, 남겨 두면 이미 해제된 hold를 계속 설명한다 — 그것을 확인하러 오는
바로 그 화면에서. `tests/imageModelRegistry.test.mjs`가 활성 모델의 note를
금지한다.
