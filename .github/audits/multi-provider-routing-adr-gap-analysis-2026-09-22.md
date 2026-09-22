# 멀티 공급자 라우팅 ADR v2.1 — 기존 구현 대조 분석

- 작성일: 2026-09-22
- 대상 문서: [`docs/policy/tomverse-multi-provider-routing-v2.1.md`](../../docs/policy/tomverse-multi-provider-routing-v2.1.md) (제안, 미채택)
- 대조 대상: [`docs/policy/tomverse-chat-routing.md`](../../docs/policy/tomverse-chat-routing.md),
  [`docs/policy/tomverse-chat-router-score-policy.md`](../../docs/policy/tomverse-chat-router-score-policy.md),
  `prisma/schema.prisma`, `lib/router*.ts`, `lib/routing*.ts`
- 결론: **ADR을 그대로 구현 지시로 쓸 수 없습니다.** 전제가 틀렸고, 정면 충돌 5건이 미해소입니다.

## 0. 이 문서가 나온 경위

ADR v2.1은 세 차례 리뷰(C1–C15 → N1–N11 → R1–R6)를 거쳤으나, **세 번 모두 그린필드
설계라는 전제** 위에서 이루어졌습니다. 실제로는 Tomverse에 이미 가동 중인 라우팅
시스템이 있으며, ADR이 "Phase 0에서 맨 먼저 구현하라"고 지시하는 항목 상당수가
**이미 프로덕션에 존재**합니다.

따라서 ADR의 가치는 "무엇을 만들 것인가"가 아니라 **"기존 시스템에서 무엇을 바꿀
것인가"** 로 다시 읽혀야 합니다.

## 1. 이미 구현되어 있는 것

ADR이 신규 구축을 지시하지만 기존 시스템에 등가물이 있는 항목입니다.

| ADR 항목 | 기존 구현 | 비고 |
|---|---|---|
| §10.1 streaming commit point | `RoutingAttempt.firstVisibleTokenAt`, outcome `failed_pre_token` / `failed_post_token`, `lib/routingStreamFailure.ts` | **기존이 더 엄격.** 자동 fallback은 첫 visible token 이전 + 논리 응답당 최대 1회 |
| §10.3 attempt-level ledger | `RoutingAttempt` + `ChatAttemptUsage` + `ChatAttemptUsageAdjustment` | attempt 종료와 **동일 트랜잭션**에 원가 기록. ADR이 요구하는 "실패 attempt도 과금 기록" 이미 충족 |
| §11 failure 분류 | `failureLayer` (planner / adapter / manifest / billing / process / provider / stream / none) + `outcome` 6종 + `errorClass` | **분류축이 다름.** ADR은 원인축(429/5xx/malformed), 기존은 레이어축 |
| §13 routing_events / routing_attempts | `RoutingRun` / `RoutingAttempt` | |
| §15.3 fault injection | `lib/routingFaultInjection.ts` | |
| §16 shadow mode | `RoutingRun.mode = "shadow"`, `lib/routingShadow.ts`, `lib/routingShadowReport.ts` | **의미가 다름** — §4 충돌 3 참조 |
| §6.4 estimator calibration | `TokenEstimateShadowSample` (control/candidate 추정기 버전 병행 비교) | ADR보다 정교함. 샘플 코호트·토크나이저 계열까지 분리 |
| §3 hard gate | health · policy · region · capability · context limit · attachment · credit 하드 필터 (`lib/routerCandidates.ts`) | |
| §8 stickiness / hysteresis | `ROUTER_STICKY_SWITCH_MARGIN_BANDS`, `ROUTER_STICKY_HYSTERESIS_TURNS`, `switchReason`, `recoveryCandidateModelId`, `fallbackHealthEvidence` | 신뢰도 약한 프로파일에 턴 수를 더하는 규칙까지 있음 |
| §7.2 health | `ProviderHealthState` — 실트래픽 / 합성 프로브 / 관리자 검증 **3계열 분리** | ADR은 이 분리를 다루지 않음. 기존이 앞섬 |
| §2.1 config 버전 기록 | `taskProfileVersion`, `candidateFilterVersion`, `selectionVersion`, `estimatorVersion`, `selectionPolicyVersion` | 버전은 기록되나 **원자적 manifest는 아님** — §3 갭 3 참조 |

## 2. ADR이 실제로 추가하는 것 (진짜 갭)

### 갭 1 — deployment 개념 부재 (가장 큰 델타)

기존은 `modelId` + `provider`(문자열)가 **1:1**입니다. `ProviderHealthState`는
`provider String @id`로 **provider 단위**이며 deployment 단위가 아닙니다.

즉 **같은 모델을 여러 공급자에 동시에 두는 구조 자체가 없습니다.** ADR의 핵심 전제인
"OpenAI-compatible 모델을 Direct / DeepInfra / Sail / Together / OpenRouter에 동시
배치"가 현재 데이터 모델로는 표현 불가능합니다.

ADR의 다음 항목이 **전부 이 갭에 딸려** 있습니다.

- §3.2 quality tier / quantization gate (C7)
- §3.3 model version pin / drift policy (C8)
- §7.1 credential 단위 capacity (N3)
- §5 deployment별 penalty
- §6.3 deployment별 cache affinity

**이 갭을 메우지 않기로 하면 ADR의 70% 이상이 불필요합니다.** 따라서 이것이
첫 번째로 결정해야 할 사항입니다.

### 갭 2 — 후보별 평가 기록 없음 (N2)

`RoutingRun.rejectedByReason`는 **이유별 카운트**(`Json`)입니다. 어떤 후보가 어떤
이유로 탈락했는지, 통과한 후보들의 상대 순위가 어땠는지는 남지 않습니다.
`eligibleCount`, `selectedModelId`, `selectionReason`, `selectionMargin`만 있습니다.

결과적으로 **"왜 이 모델이 밀렸는가"를 사후 재현할 수 없습니다.** ADR의
`candidate_evaluations` 동결 기록이 메우는 갭이고, deployment 도입 여부와 무관하게
지금도 가치가 있습니다. **저비용·고가치 항목.**

### 갭 3 — 원자적 config manifest 없음 (N10)

버전 컬럼 5개가 각각 독립적으로 읽힙니다. 요청 처리 중 한쪽이 승격되면 **실제로는
공존한 적 없는 조합**이 기록될 수 있고, 그 조합으로는 결정을 재현할 수 없습니다.

`selectionPolicyVersion`의 스키마 주석이 이미 같은 문제를 지적하고 있습니다 —
"a run recorded with only one of the two can be attributed to neither". 그 논리를
5개 버전 전체로 확장한 것이 ADR의 `control_plane_version`입니다. **deployment 도입
여부와 무관하게 유효.**

### 갭 4 — 429/quota와 가용성 장애 미분리 (C5 / N3)

`ProviderHealthState.consecutiveFailures`는 단일 카운터입니다. rate limit과 장애가
같은 신호로 집계되면, 피크 시간에 정상 공급자를 차단하고 트래픽을 fallback으로
몰아 연쇄를 만듭니다. `Retry-After` 처리, 토큰 버킷, `deprioritize_until` 등
capacity 경로가 보이지 않습니다.

### 갭 5 — `malformed_output` 등가물 없음 (N8)

`failureLayer`에 "HTTP 200인데 본문이 깨진 경우"가 없습니다. 현재는 `stream` 또는
`provider`로 흡수될 가능성이 높고, 그러면 **품질 문제가 가용성 지표를 오염**시킵니다.
기존 시스템이 세 evidence 계열을 애써 분리한 설계 철학과 일관되게, 이것도 분리되어야
합니다. **저비용·고가치.**

### 갭 6 — cache 경제성 없음 (C4 / N1)

기존 stickiness는 **모델 선택의 안정성**이지 **캐시 경제성**이 아닙니다.
`docs/policy/anthropic-prompt-caching.md`가 있으나 라우팅 결정과 연결되어 있지
않습니다. deployment 도입 시에만 의미가 커집니다.

### 갭 7 — BYOK / credential 스코프 없음 (N3 / C14)

workspace별 자체 키, `billing_owner`, quota scope 개념이 없습니다. 엔터프라이즈
요구가 실재할 때만 필요합니다.

## 3. 정면 충돌 (해소 없이는 채택 불가)

### 충돌 1 — 목적함수의 형태 ★ 가장 중요

| | ADR v2.1 §5 | 기존 `routerScorePolicy.ts` |
|---|---|---|
| 형태 | 가중합 penalty 최소화 | **어휘순(lexicographic) tie-break** |
| 순서 | `w_cost 0.35 + w_latency 0.25 + w_health 0.40` | `quality_band → health_degraded → expected_total_cost → recent_success_rate → ttft_p95 → model_id` |
| 품질 | 가중치에 섞이지 않음(하드 게이트) | **밴드 1\|2\|3, 점수 아님** |
| 동률 | `near_best_delta` | epsilon 임계값 (cost 5%, success 1%p, TTFT 250ms) |

기존 설계는 점수화를 **의도적으로 거부**했고 문서에 근거가 있습니다 —
"A six-point scale would look like a measurement and would be read as one",
그리고 "cost, health and latency are measured, and quality is not".

ADR의 가중합은 측정되지 않은 축과 측정된 축을 하나의 실수로 합산합니다. 이건
스타일 차이가 아니라 **인식론의 차이**입니다. ADR §5를 채택하려면 "측정 안 된 것을
수치화하지 않는다"는 기존 원칙을 어떻게 지킬지 먼저 답해야 합니다.

> 참고: ADR 리뷰 C2에서 fixed anchor를 요구한 이유(가중치 의미의 안정성)는
> 어휘순 비교에서는 **애초에 발생하지 않는 문제**입니다. 어휘순은 정규화가
> 필요 없습니다. 즉 기존 설계가 C1·C2를 다른 방식으로 이미 회피하고 있습니다.

### 충돌 2 — 미측정 신호의 처리

| ADR | 기존 |
|---|---|
| §7.3 shrinkage: `prior_failure_risk = 0.005`, `k = 200`으로 **값을 만들어 넣음** | **기권(abstain).** 관측치가 임계 미만이면 항목 자체를 건너뛰고 다음 기준이 결정 |

기존 코드의 명시적 근거: "A missing entry means *unknown*, not zero and not best…
Treating an absent success rate as 100% would rank a model nobody has ever called
above one with a measured record." 관측 임계도 근거와 함께 정해져 있습니다
(success rate 30회, TTFT p95 50회).

ADR의 prior 0.005 역시 같은 종류의 발명입니다. **콜드스타트 처리 방식을 둘 중
하나로 통일해야 합니다.**

### 충돌 3 — "shadow"라는 단어의 의미

| ADR §16 Phase 2A | 기존 `RoutingRun.mode = "shadow"` |
|---|---|
| dynamic allocation **vs** sequential 실행 경로 비교 | 라우터 추천 **vs 사용자 선택** 비교 |

같은 컬럼에 다른 의미를 넣으면 기존 shadow 리포트(`lib/routingShadowReport.ts`,
`.github/workflows/router-eval-pilot.yml`)의 분모가 오염됩니다. **새 축은 새
컬럼이어야 합니다.**

### 충돌 4 — 실행 예산

기존은 논리 응답당 **dispatched attempt 최대 2회**(primary + fallback 1회), full
Context Builder 실행 최대 2회, context-limit reroute 최대 1회, pass-through 최대 1회로
예산이 고정되어 있습니다.

ADR의 후보 리스트 순회형 sequential fallback(`max_attempts` 기본 3)과 §11.1의
malformed 동일 deployment 1회 재시도는 이 예산을 초과합니다. 예산은 비용·지연
상한이자 사용자 체감 SLO이므로 **ADR 쪽이 양보해야 할 가능성이 높습니다.**

### 충돌 5 — "두 번째 원장 금지"

기존 불변조건: *"Existing credit reservation, settlement, reconciliation, and refund
infrastructure remains the financial source of truth. Routing does not introduce a
second ledger."*

ADR §10.3의 `routing_attempts.actual_cost`를 새로 만들면 원장이 둘이 됩니다. 다만
`ChatAttemptUsage`가 이미 attempt 단위이므로, **ADR 요구사항은 기존 테이블로 이미
충족**되어 있습니다. 새 컬럼이 아니라 기존 테이블 조회로 해결하면 충돌이 사라집니다.

## 4. 권장 채택 순서

### 0단계 — 먼저 답할 질문

**"하나의 논리 모델을 여러 공급자에 동시에 배치할 것인가?"**

이 답에 따라 ADR의 70%가 필요하거나 불필요해집니다. 답이 "아니오"라면 아래 1단계만
하고 ADR의 나머지는 보류하는 것이 옳습니다.

### 1단계 — deployment 도입 여부와 무관하게 지금 가치 있는 것

비용이 낮고 기존 설계 철학과 충돌하지 않습니다.

1. **갭 2** — `RoutingRun`에 후보별 평가 동결 기록 추가 (카운트 → 후보별 레코드)
2. **갭 3** — 5개 버전을 원자적 manifest 하나로 고정
3. **갭 5** — `malformed_output`을 `failureLayer`와 분리된 품질 신호로 분류
4. **갭 4** — 429/quota를 가용성 실패와 분리

### 2단계 — multi-deployment로 가기로 한 경우에만

5. deployment 엔터티 도입 (`ProviderHealthState`를 deployment 단위로 확장)
6. quality tier / quantization / model version gate
7. credential 단위 capacity + BYOK
8. cache affinity를 비용 모델에 반영

### 3단계 — 충돌 해소 후에만

9. 목적함수 (충돌 1·2 해소 선행)
10. traffic allocation / exploration (충돌 3·4 해소 선행)

**ADR §16의 Phase 0 → 1 → 2A → 2B → 2C 순서는 이 레포에 적용되지 않습니다.**

## 5. 검증 범위와 한계

직접 읽고 확인한 것:

- `prisma/schema.prisma` — `RoutingRun`, `RoutingAttempt`, `ProviderHealthState`,
  `TokenEstimateShadowSample` 전문, 모델/enum 목록 전체
- `docs/policy/tomverse-chat-routing.md` §1–5
- `lib/routerScorePolicy.ts` (전체 중 정책 상수·비교자 부분)
- `lib/routingFallbackPolicy.ts`, `lib/routingStreamFailure.ts`,
  `lib/chatAttemptCostLedger.ts` — 각 파일의 설계 근거 주석
- `lib/router*.ts` / `lib/routing*.ts` 파일 목록과 규모

읽지 않은 것:

- `lib/routerSelection.ts`, `lib/routerDecision.ts`, `lib/routerCandidates.ts`,
  `lib/routingDispatchInstrumentation.ts`, `lib/routingAttemptSequence.ts`의 본문
- `app/api/admin/routing-shadow/route.ts` 등 API 레이어
- `.github/workflows/router-*.yml` 평가 파이프라인
- 테스트

따라서 **갭 4·5(429 분리, malformed 분류)는 "보이지 않았다"이지 "없다"가 확정된
것은 아닙니다.** 채택 결정 전에 해당 파일들을 확인해야 합니다.

## 6. 독립 검토 이력

**없음.** 이 분석과 ADR v2.1 모두 독립 검토를 받지 않았습니다. 원격 세션에서는
cursor CLI를 사용할 수 없었습니다 — 네트워크 정책이 `cursor.com`을 차단하고
(`connect_rejected: 403`), `CURSOR_API_KEY`도 설정되어 있지 않았습니다.

이 레포의 `.github/audits/*-independent-review-prompt-*.md` 관행에 따라 독립 검토를
받을 것을 권장합니다. 특히 **충돌 1(목적함수 형태)** 은 설계 철학이 걸린 문제라
제3자 판단이 필요합니다.
