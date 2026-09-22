# 멀티 공급자 라우팅 — deployment identity 설계 (v2.1 ADR 개정안)

- 작성일: 2026-09-22
- **개정 3** (같은 날). 개정 1·2 모두 독립 검토에서 `reject`. 이 판은 2차 검토의
  blocker 2건·major 5건과 **사실 오류 5건**을 반영한 것입니다. 변경 요약은 §13.
- 상태: **제안. 3차 독립 검토 대기.**
- 선행 문서
  - [`.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`](./multi-provider-routing-adr-gap-analysis-2026-09-22.md)
  - [`docs/policy/tomverse-multi-provider-routing-v2.1.md`](../../docs/policy/tomverse-multi-provider-routing-v2.1.md) (ADR, 미채택)
  - [`docs/policy/tomverse-chat-routing.md`](../../docs/policy/tomverse-chat-routing.md) (현행)
  - [`docs/policy/tomverse-chat-router-score-policy.md`](../../docs/policy/tomverse-chat-router-score-policy.md) (현행)

## 0. 경위

갭 분석이 남긴 0단계 질문 — "하나의 논리 모델을 여러 공급자에 동시에 배치할
것인가?" — 에 소유자가 **전면 도입**으로 답했고, 이어서 identity 형태에 대한 결정이
내려졌습니다. 이 문서는 그 결정과, 결정에 딸려 나오는 기존 코드 영향을 기록합니다.

**이 문서의 사실 주장은 두 차례 독립 검토에서 각각 5건씩 정정됐습니다.** 그 이력은
§9와 §13에 남깁니다 — 무엇이 틀렸는지가 무엇이 맞는지만큼 중요합니다.

## 1. 소유자 결정

| ID | 결정 | 효과 |
|---|---|---|
| D1 | multi-deployment **전면 도입** | 갭 1·6·7, 갭 4b가 범위 안 |
| D2 | credential은 deployment identity에 **넣지 않음** | health↔capacity scope 분리의 근거 |
| D3 | Azure 경계 사례는 **(a)** — region마다 별도 deployment | residency가 deployment에서 결정 가능 |
| D4 | `ProviderEndpoint`를 **독립 infrastructure identity로 신설** | 4계층 모델 |

D1이 승인하지 **않는** 것은 §11에 따로 적습니다.

## 2. 4계층 모델

```
LogicalModel
    │
    └── ModelDeployment          ← Tomverse가 라우팅하는 단위
           ├── logicalModelId
           ├── providerEndpointId
           ├── upstreamDeploymentName   ← 공급자가 부르는 이름
           ├── modelVersion / modelRevision
           ├── qualityTier / quantization / tokenizerRevision
           └── capabilities
                    │
                    ▼
        ProviderEndpoint          ← 인프라 identity
           ├── gatewayProvider   ← 요청을 받는 쪽
           ├── servingProvider   ← 실제로 서빙하는 쪽. 고정 불가면 null
           ├── region
           ├── endpointUrl
           ├── residencyClass    (확정값 | unknown — §4)
           ├── destinationRegions
           ├── routingPolicyDigest  ← 우리가 보낸 설정. 의도이지 사실이 아님 (§4)
           ├── resourceId
           └── cloud/account metadata
                    │
                    ▼
        CredentialBinding         ← 접근 권한
           ├── credentialId
           ├── providerEndpointId
           ├── workspaceId       (BYOK일 때)
           ├── billingOwner      (tomverse | workspace)
           ├── providerBudgetAccountId   ← §8.3
           └── quotaScopeId      (→ QuotaScope, §8.2)
```

**`gatewayProvider`와 `servingProvider`를 정본 계층에 둡니다.** 개정 2는 이 넷을
§4에만 두어 `provider`와의 관계가 불명확했습니다. Direct 경로에서는 둘이 같고,
broker 경로에서만 갈라집니다. 단일 `provider` 컬럼은 **없습니다** — 어느 쪽을
뜻하는지 읽는 사람이 알 수 없기 때문입니다.

### 2.1 identity 경계를 정하는 규칙

> **두 행을 바꿔 끼웠을 때 답이 달라지거나 위법이 되면 위쪽 계층, 청구서만
> 달라지면 credential.**

credential은 무엇이 나오는지를 바꾸지 않습니다. 넣었다면 quality gate·version
pin·health 표본이 키 개수만큼 쪼개졌을 것입니다.

### 2.2 예시

```
GPT-5.6
├─ ModelDeployment A → ProviderEndpoint(azure_openai/azure_openai, australiaeast)
└─ ModelDeployment B → ProviderEndpoint(azure_openai/azure_openai, eastus)
      둘 다 upstreamDeploymentName = gpt56-prod
```

하나의 Azure resource 안에 여러 Azure model deployment가 있을 수 있으므로
credential은 endpoint에 묶이고 Tomverse deployment마다 복제되지 않습니다.

### 2.3 명명과 로그

| 개념 | Prisma 모델 | 로그 필드 |
|---|---|---|
| Tomverse routing deployment | `ModelDeployment` | `tomverse_deployment_id` |
| Azure Resource / regional endpoint | `ProviderEndpoint` | `provider_endpoint_id` |
| 요청을 받는 쪽 | — (컬럼) | `gateway_provider` |
| 실제로 서빙한 쪽 | — (컬럼 + 응답 attestation) | `serving_provider` |
| 공급자가 부르는 이름 | — (컬럼) | `upstream_deployment_name` |
| 자격증명 | `CredentialBinding` | `credential_id` |

## 3. Hard invariant

> A **routing-eligible** deployment MUST fully identify its routable endpoint and
> data-region characteristics without resolving a credential. Credentials
> authorize access to a deployment/endpoint; they MUST NOT redefine its endpoint,
> region, residency, model version, or capability semantics.

요청 시점 순서:

```
Request → Workspace policy → Deployment/Endpoint region 검사 → eligible? → Credential 선택
```

credential을 먼저 고르고 "이 key가 어느 region이지?"를 역으로 알아내는 것은
금지입니다. 법적 판정이 secret resolution에 의존하면, 사후 감사에서 "이 요청이 어느
관할에서 처리됐는가"에 답하려면 그 시점의 binding 상태를 복원해야 합니다.

### 3.1 금지 필드

```
credential.endpointOverride / regionOverride / residencyOverride
```

만들지 않습니다. 강제 수단은 §12.

## 4. Broker 경로와 residency (개정 3에서 크게 바뀜)

개정 2는 `routingPolicyDigest`를 routing-eligible의 증거로 썼습니다. **거부됐습니다.**
digest는 **우리가 보낸 설정**을 증명할 뿐, broker가 실제로 어느 공급자·어느 region
에서 실행했는지를 증명하지 않습니다. broker가 upstream pool이나 fallback 의미를
바꿔도 digest는 그대로입니다.

### 4.1 digest는 의도, attestation은 사실

| 값 | 무엇인가 | 무엇에 쓰는가 |
|---|---|---|
| `routingPolicyDigest` | 우리가 건 pinning/fallback 설정 | **의도 기록.** 변경 감지, 재현 |
| 응답별 serving attestation | 공급자가 그 응답에 대해 보고한 실제 provider·region | **판정.** routing-eligible 여부 |

규칙:

1. **routing-eligible이 되려면 응답별 attestation이 pin과 일치해야 합니다.**
   attestation을 얻을 수단이 없는 broker 경로는 **제약 트래픽의 후보가 아닙니다.**
2. digest 일치만으로는 부족합니다. digest는 우리 쪽 사실이고 residency는 저쪽
   사실입니다.
3. **모르면 `unknown`입니다.** 추정하지 않습니다.

### 4.2 `unknown`은 "아무 데나 괜찮다"가 아닙니다

개정 2는 "요청에 residency 제약이 없으면 `unknown` endpoint도 후보"라고 했습니다.
**거부됐습니다.**

Tomverse는 **호주 법인**이고 APP 8(해외 공개)이 적용됩니다. 사용자가 제약을 명시하지
않았다는 것은 **조직이 어떤 해외 공개를 기본으로 허용하는가**에 대한 답이 아닙니다.
이 저장소는 같은 문제를 반대 방향으로 이미 결정해 두었습니다 —
`docs/policy/voice-input.md`는 destination을 이름 댈 수 없으면 고지가 참이 될 수
없다고 적습니다.

그러므로:

- `unknown` endpoint는 **사용자 제약과 조직 기본 해외 공개 정책을 모두** 통과해야
  합니다.
- 승인된 기본 destination 집합이 **없으면 fail-closed**입니다.
- 그 집합을 정하는 것은 Privacy Owner의 승인 행위이며 이 문서가 정하지 않습니다.

관측 사실 하나: `regionBlockedModelIds`는 현재 **입력만 존재하고 production producer가
없습니다**(`lib/routerCandidates.ts`). residency는 아직 아무것도 막고 있지 않습니다.

## 5. Scope 표

| 관심사 | scope |
|---|---|
| Availability health | **§8.1** — canonical observation 하나에서 멱등 파생, 라우팅 authority는 한 grain |
| Credential quota | ProviderEndpoint + Credential |
| Model-specific quota | ModelDeployment + Credential |
| Workspace budget | Workspace |
| Global provider outage | gatewayProvider / ProviderEndpoint |
| Quality gate 증거 | **deployment 단위** (§6) |

## 6. Quality: deployment 단위로 시작합니다 (개정 3에서 보류)

개정 2는 `servingContractDigest`를 키로 하는 equivalence class를 제안했습니다.
**보류합니다.**

2차 검토의 판정: **현재 pool에서 provider-attested immutable artifact를 입증한
공급자는 0개입니다.** 그러면 거의 모든 deployment가 singleton class가 되고, class
expiry·membership·attestation이라는 복잡성만 남은 채 절감은 생기지 않습니다.

그러므로:

- **quality gate는 deployment 단위**로 구현합니다. region마다 eval을 통과시켜야
  한다는 비용은 그대로 받습니다.
- equivalence class는 **attestation 조사가 실제 재사용 가능성을 증명한 뒤** 도입
  합니다. 그 조사 자체가 별도 작업 항목입니다.
- ADR §3.3의 "같은 equivalence group에서만 자동 fallback"은 그때까지 **deployment
  동일성**으로 읽습니다.

이것은 개정 2의 §6을 통째로 미루는 결정이며, 미루는 이유는 근거가 없어서입니다 —
설계가 틀렸다기보다 **전제가 조사되지 않았습니다.**

## 7. 비용은 실행 route의 속성입니다

BYOK에서는 같은 deployment가 credential에 따라 다른 비용을 갖습니다. 네 값을
분리합니다.

| 값 | 의미 | 쓰이는 곳 |
|---|---|---|
| `providerChargeEstimate` | 이 route가 공급자에게 청구될 금액 | **tie-break 비용 기준**, 사용자 operational guardrail |
| `tomverseMarginalCost` | Tomverse가 부담하는 금액 | Tomverse provider budget, COGS |
| `workspaceExternalCost` | workspace가 자기 계정으로 부담하는 금액 | workspace 리포트 |
| `billingOwner` | 분배를 정하는 라벨 | 귀속 |

tie-break는 `providerChargeEstimate`입니다. BYOK workspace도 그 외부 청구서를
부담하므로 "내지 않는 돈으로 순위가 정해진다"는 것은 사실이 아닙니다.
`tomverseMarginalCost`를 쓰면 BYOK 후보가 전부 0으로 동률이 되어 외부 비용이
무시됩니다.

> 개정 2의 실패 양상 서술을 정정합니다. BYOK 비용을 0으로 만들면 "가장 비싼 모델이
> 최선으로 보인다"가 아니라 **모든 후보가 비용 동률이 되어 이후 기준이 결정**합니다.
> 결론(비교가 무너진다)은 같지만 양상이 다릅니다.

### 7.1 요청 시점 순서

```
1. workspace credential 정책 해소   → BYOK 계열인가 managed 계열인가
2. hard gate                        → eligible deployments
3. binding 가용성 필터              → capacity 있는 binding을 가진 deployment만
4. deployment 점수                  → 비용은 providerChargeEstimate
5. credential 선택                  → 같은 deployment 안에서 capacity 균형
```

4와 5는 다른 종류의 결정입니다. 한 점수 함수에 접으면 "키가 한가하다"가 "모델이 더
좋다"와 같은 단위로 더해집니다.

### 7.2 BYOK → managed fallback

**묵시적 fallback 금지.** workspace opt-in, payer 변경 고지, credit authorization이
모두 있을 때만 허용합니다.

## 8. 기존 코드 영향

### 8.1 Router의 health 원본은 `ProviderProbeResult`입니다 (개정 3에서 정정)

개정 1은 `ProviderHealthState`의 PK를 바꾸자고 했고, 개정 2는 그것을 철회하면서
"기존 테이블과 새 projection이 동시에 라우팅에 영향을 주는 기간"을 열린 질문으로
남겼습니다. **그 전제가 틀렸습니다.**

- `ProviderHealthState`는 **공개 상태와 운영 복구용 durable heartbeat**입니다.
- **Router의 후보 필터는 `ProviderProbeResult`를 직접 읽습니다**
  (`lib/routerRuntimeSignals.ts`의 `readProbeHealth`), dispatch 신호는
  `RoutingAttempt`에서 읽습니다.

그러므로 deployment 단위 health가 향해야 할 대상은 `ProviderHealthState`가 아니라
**probe 기록과 attempt 기록**입니다.

설계:

1. **canonical append-only observation을 먼저 씁니다.** event id를 가집니다.
2. deployment·endpoint·provider rollup을 그 event id 기준으로 **멱등 적용**합니다.
   projection write가 중간에 실패해도 재실행이 같은 결과를 냅니다.
3. **라우팅 authority는 한 grain만 가집니다.** dual-write 관찰 기간은 허용하되,
   두 grain이 동시에 후보를 판정해서는 안 됩니다. 전환은 **atomic cutover**입니다.
4. `ProviderHealthState`는 그대로 둡니다. 과거 행을 추측 백필하지 않습니다.

### 8.2 `QuotaScope` registry

```
type QuotaScope =
  | "credential" | "endpoint_credential" | "deployment_credential"
  | "workspace"  | "provider";
```

- type별 **typed FK**와 "정확히 필요한 컬럼만 non-null" CHECK
- **type별 partial unique index** — CHECK와 FK만으로는 같은
  `(endpoint, credential)` scope가 둘 생기는 것을 막지 못합니다
- 이 5값 CHECK를 `scripts/check-enum-constraints.mjs`에 **등록**합니다
- provider scope에 실제 FK를 원하면 Provider registry가 선행합니다

### 8.3 BYOK 비용 배선 (개정 3에서 크게 바뀜)

**같은 `reservedCost`가 사용자 operational guardrail과 Tomverse provider hold 양쪽에
쓰입니다**(`lib/chatSecurity.ts`). 그러므로 BYOK에서 이 값을 0으로 만들면 **사용자
guardrail까지 함께 꺼집니다.** 개정 2는 이것을 보지 못했습니다.

- 사용자 guardrail에는 `providerChargeEstimate`를 전달합니다.
- Tomverse budget에는 `tomverseMarginalCost`를 전달합니다.
- `providerBudgetAccountId`를 **attempt cost snapshot에도 저장**합니다. settlement가
  bucket key에서 provider를 다시 파싱하고(`lib/chatSecurity.ts`),
  `ChatAttemptUsage`에는 provider account identity가 없습니다.
- 기존 bucket key에서 새 key로는 **versioned dual-read 전환**이 필요합니다.

BYOK 지출은 사용자 크레딧도, operational guardrail도, Tomverse provider 예산도 아닌
**네 번째 namespace**입니다.

### 8.4 후보 키 grain은 한 번에 자릅니다

`regionBlockedModelIds`, `unhealthyModelIds`, `degradedModelIds`, 모든 score signal,
그리고 최종 tie-break `model_id`가 전부 modelId 기준입니다. 같은 logical model의 두
deployment는 같은 tie-break 값을 가지므로 전순서를 만들지 못합니다.

**decision plane은 한 번에 `deploymentId`로 전환합니다.** observation shadow
dual-write는 가능하지만 두 grain이 동시에 라우팅해서는 안 됩니다 — 공존시키면 두
deployment가 modelId 하나로 합쳐져 health·비용이 오염되고 전순서를 잃습니다.

### 8.5 후보 판정 동결: `RoutingCandidateVerdict`

후보는 가변 런타임 DB 레지스트리에서 옵니다(`runtimeModels.filter(...)`). `enabled`·
`catalogDeleted`·`minimumPlan`·context window·backend readiness가 전부 움직이므로
**어떤 탈락 사유도 사후 재구성할 수 없습니다.** `lib/routingShadow.ts`의 "stable
catalogue information a reader can reconstruct"는 자기 전제에서 틀렸습니다.

형태를 확정합니다 — 개정 2는 "candidate id 또는 snapshot version"이라고 두 갈래로
열어 두었습니다.

- **`RoutingCandidateVerdict` 자식 테이블.** run당 후보마다 한 행.
- 컬럼: `routingRunId`, `deploymentId`, 고정 `reason` 식별자, 판정 입력의 snapshot id.
- **run당 후보 상한**을 둡니다. 행 크기·보존·replay 가능성을 최대 deployment 수에서
  측정한 뒤 정합니다.
- 원문·잔액·오류 문구는 저장하지 않습니다 — content-free가 유지됩니다.

## 9. 갭 4·5 확정 결과 (두 차례 정정 반영)

### 갭 4 — 429/quota와 가용성 장애 미분리

**분류 경로가 둘이고, 서로 다르게 답합니다.** 이것이 개정 2가 놓친 사실입니다.

```
provider health 경로:  recordProviderFailure()      ← 먼저 실행
                       → classifyProviderFailure()
                       → timeout·ECONN = NETWORK, scope "provider"
                       → ProviderHealthState.consecutiveFailures 증가

attempt 기록 경로:      classifyStreamFailure()      ← 나중에 실행
                       → timeout·ECONN = abort-shaped
                       → outcome "cancelled", layer "stream"
```

`app/api/chat/route.ts`에서 `recordProviderFailure`가 `attemptFallback`보다 **앞에**
있습니다. 따라서:

- **attempt 기록은** timeout·ECONN을 provider 실패에서 분리합니다.
- **provider health는** 분리하지 않습니다. `PROVIDER_SCOPED`가 `NETWORK`를 담습니다.
- 개정 2의 "뒤섞이는 것은 429·5xx 계열로 한정"은 **attempt 경로에만 참**이고 provider
  health에는 거짓입니다.

그리고 attempt 경로에서 소실되는 범위도 더 넓습니다 — `classifyStreamFailure`가 따로
다루는 provider category는 `PAYMENT_REQUIRED` 하나뿐이고, `AUTHENTICATION`·
`RATE_LIMIT`·`SERVER_ERROR`·`NETWORK`·`UNKNOWN`이 모두 `failureLayer: "provider"`로
접힙니다.

**같은 사건을 두 하위 시스템이 다르게 분류하고 있다는 것 자체가 발견 사항입니다.**
이 저장소가 "두 증거 계열이 서로 덮어쓰지 않는다"를 여러 곳에서 지키는 것과 어긋
납니다. 갭 4는 "429를 분리하라"보다 넓게 **"한 사건에 하나의 분류"** 로 다시
읽어야 합니다.

그 밖에 확인된 것:

- `Retry-After`는 채팅 추론 경로에서 읽히지 않습니다. 읽는 곳은 이메일 포트와
  OpenAI Costs API입니다.
- `deprioritize_until` 류 만료형 강등 없음. 라우팅 층의 token bucket·capacity
  admission 없음.
- `ProviderProbeResult.errorClassification`이 `"RATE_LIMIT"`을 담는데
  `readProbeHealth`가 읽지 않습니다. **정정**: 그 select는 `success` 하나가 아니라
  `provider`·`modelId`·`success`·`completedAt`·`latencyMs` 다섯 필드입니다.
  `errorClassification`이 빠졌다는 결론만 유효합니다.

### 갭 5 — 출력이 못 쓸 때의 분류

DB CHECK가 `succeeded`에 `failureLayer = 'none'`을 강제하고, 공통 writer가 성공 시
`errorClass`를 지웁니다(`lib/routingAttemptStore.ts`). **정정**: `errorClass` 컬럼
자체에는 CHECK가 없습니다. 정확한 서술은 **"현재 writer와 failure-layer CHECK가
`succeeded + model_output` 표현을 막는다"** 입니다.

원칙은 라우팅 밖에서 이미 구현돼 있었습니다 — `AI_EMPTY_RESPONSE` →
`MODEL_TRANSIENT` → `scope: "model"`, `PROVIDER_SCOPED`에서 제외. **A-3a에서 그
결정이 attempt 기록에 도달했습니다**(`model_output` layer).

남은 것: 잘림(`length`)·content_filter+본문·파싱 실패. 앞의 둘은 현재 `succeeded`로
기록되므로 옮기면 성공률이 바뀝니다 — 라벨이 아니라 점수 변경이고 별도 근거가
필요합니다.

## 10. 이미 착수한 항목의 결과

| # | 항목 | 상태 |
|---|---|---|
| A-1 | comparator 전순서 수정 | 구현·검증 완료, 2차 검토 진행 중 |
| A-2 | 빈 200 오분류 | 구현·검증 완료 |
| A-3a | `model_output` failure layer | 구현·검증 완료 |
| A-3b | `errorClass` 닫힌 vocabulary + CHECK | 미착수 |
| A-4a | `RATE_LIMIT` 등 분류 보존 | 미착수 |
| A-4b | capacity state·token bucket | C 이후 |
| A-5 | 원자적 config manifest | **C 이후로 이동** (§14) |

## 11. D1이 승인하지 않는 것

### 충돌 4 — 실행 예산 (유지, 개정 3에서 규칙 정정)

dispatched attempt 최대 2회를 유지합니다. 첫 fallback이 신뢰성 이득의 대부분을
가져가고, 세 번째 호출은 최악 비용·tail latency·예산을 모두 늘립니다.

**개정 2의 "fallback은 항상 다른 ProviderEndpoint를 요구한다"는 과교정이었습니다.**
현행은 다음 model id를 고르고 같은 provider로의 fallback을 명시적으로 지원합니다
(`lib/routingFallbackPolicy.ts`, `lib/chatProviderHolds.ts`). 무조건 요구하면
**같은 endpoint의 다른 모델로 가는 현행 유효 경로가 사라집니다.**

정정된 규칙 — **실패의 scope가 정합니다.**

| 실패 scope | fallback 규칙 |
|---|---|
| endpoint/provider-scoped (5xx, 연결, endpoint 포화) | **다른 endpoint를 요구** |
| model/adapter-scoped | 같은 endpoint의 다른 모델 허용 |

같은 장애 영역만 남았다면 세 번째 후보 대신 종료합니다.

### 충돌 5 — 두 번째 원장 (해소)

`routing_attempts.actual_cost`는 만들지 않습니다. `ChatAttemptUsage`가 이미 attempt
단위 원가를 같은 트랜잭션에 기록합니다.

### 충돌 1·2 — 목적함수와 콜드스타트 (어휘순 유지)

두 검토 모두 어휘순 유지를 권고했습니다. 후보 수 증가는 서로 다른 단위를 더할 근거가
아니며, 먼저 깨지는 것은 가중합 부재가 아니라 comparator의 비추이성과 tie-break
grain이었습니다 — 전자는 A-1에서 고쳤고 후자는 §8.4입니다.

콜드스타트는 현행 **기권**이 우선입니다.

### 충돌 3 — "shadow"의 의미

ADR Phase 2A의 `allocation_mode`는 **새 컬럼**입니다. `RoutingRun.mode`를 재사용하지
않습니다.

## 12. invariant 강제는 네 층입니다

1. **DB CHECK / FK / partial unique index**
2. **공통 writer validation** — 모든 생성 경로가 지나는 한 함수
3. **attempt의 immutable identity snapshot**
4. **정적 검사** — 금지 필드, 금지 import, enum registry 등록

과거 행은 추측 백필하지 않고 legacy/null로 남깁니다.

## 13. 개정 2에서 바뀐 것

| 항목 | 개정 2 | 개정 3 |
|---|---|---|
| broker 판정 | `routingPolicyDigest`가 증거 | **digest는 의도, 응답별 attestation이 판정** |
| `unknown` residency | 제약 없는 요청에는 후보 | **조직 기본 해외 공개 정책(APP 8)도 통과해야 함. 없으면 fail-closed** |
| quality equivalence class | `servingContractDigest` 도입 | **보류.** attestation 입증 provider 0개. deployment 단위로 시작 |
| health 대상 | `ProviderHealthState` 보존 + projection | **Router의 원본은 `ProviderProbeResult`**. canonical observation + event id, authority는 한 grain, atomic cutover |
| BYOK 비용 배선 | 4값 분리 | 분리 + **사용자 guardrail과 provider hold가 같은 `reservedCost`를 쓴다는 사실 반영** |
| quota scope | typed FK | + **type별 partial unique index**, enum registry 등록 |
| 후보 동결 | "candidate id 또는 snapshot version" | **`RoutingCandidateVerdict` 테이블 + run당 상한** |
| fallback endpoint | 항상 다른 endpoint | **실패 scope가 정함** |
| 갭 4 범위 | 429·5xx로 한정 | **분류 경로가 둘.** attempt는 분리, provider health는 안 함 |
| broker 필드 위치 | §4에만 | **§2 정본 계층과 §2.3 로그 명명에 반영** |
| BYOK 0의 실패 양상 | 비싼 모델이 최선 | **전 후보 비용 동률** |

## 14. 권장 작업 순서 (2차 검토 반영)

1. §4 residency·broker attestation 규칙과 APP 8 기본 destination 정책 — **Privacy
   Owner 승인 필요**
2. §8.1 single-authority cutover, §8.3 비용 변수·bucket key migration, §8.5 verdict
   저장 형태 확정
3. **A-3b와 A-4a를 한 migration에서** — `errorClass` 닫힌 vocabulary를 분류 보존과
   함께 맞춥니다
4. C의 identity schema를 **additive/nullable로 먼저** 도입. 과거 행 추측 백필 없음
5. **A-5 atomic config manifest는 C 이후** — deployment·endpoint·routing policy
   digest를 함께 동결해야 의미가 있습니다
6. projection shadow 검증 후 §8.4 방식으로 decision grain을 한 번에 전환
7. A-4b capacity state와 failure-scope별 fallback
8. provider attestation 조사 → 재사용 가능성이 입증되면 quality equivalence class

## 15. 3차 검토에 올리는 열린 질문

- **S1** — §4.1의 "응답별 serving attestation"을 실제로 제공하는 공급자가 있는가?
  없다면 broker 경로는 제약 트래픽에서 영구 제외이고, ADR §14의 OpenRouter 역할
  (emergency fallback)이 성립하는가?
- **S2** — §4.2의 "조직 기본 해외 공개 정책"이 정해지기 전까지 fail-closed면, 지금
  `residencyClass`를 모르는 기존 공급자 전체가 후보에서 빠집니다. 전환 규칙이
  필요한가, 아니면 현행 무제약 상태를 명시적 legacy로 두는가?
- **S3** — §6 보류가 D3(region별 deployment)와 충돌하지 않는가? region마다 eval을
  통과시키는 비용을 실제로 감당할 수 있는가?
- **S4** — §8.1의 atomic cutover 시점에 probe 표본이 deployment 단위로 충분한가?
  probe는 provider당 한 모델만 찌릅니다.
- **S5** — §8.5의 run당 후보 상한을 무엇으로 정하는가? 상한을 넘으면 무엇을
  버리는가 — 버리는 순간 "왜 밀렸는가"에 답할 수 없는 후보가 생깁니다.

## 16. 검토 이력

- ADR v2.1: C1–C15 → N1–N11 → R1–R6. **세 번 모두 그린필드 전제.**
- 갭 분석: 독립 검토 없음.
- 개정 1: Cursor 독립 검토 → **`reject`**. blocker 2, major 6, 사실 오류 5.
- 개정 2: Cursor 독립 검토 → **`reject`**. blocker 2, major 5, 사실 오류 5.
  round 1 findings 중 `closed` 2건, `partially closed` 3건, `not closed` 3건.
- 개정 3: 3차 독립 검토 대기.
