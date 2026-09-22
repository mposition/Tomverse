# 멀티 공급자 라우팅 — deployment identity 설계 (v2.1 ADR 개정안)

- 작성일: 2026-09-22
- **개정 4** (같은 날). 개정 1·2·3 모두 독립 검토에서 `reject`. 이 판은 3차 검토의
  blocker 2건·major 3건과 **사실 오류 2건**을 반영한 것입니다. 변경 요약은 §13.
- 상태: **제안. 4차 독립 검토 대기.**
- 선행 문서
  - [`.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`](./multi-provider-routing-adr-gap-analysis-2026-09-22.md)
  - [`docs/policy/tomverse-multi-provider-routing-v2.1.md`](../../docs/policy/tomverse-multi-provider-routing-v2.1.md) (ADR, 미채택)
  - [`docs/policy/tomverse-chat-routing.md`](../../docs/policy/tomverse-chat-routing.md) (현행)
  - [`docs/policy/tomverse-chat-router-score-policy.md`](../../docs/policy/tomverse-chat-router-score-policy.md) (현행)

## 0. 경위

갭 분석이 남긴 0단계 질문 — "하나의 논리 모델을 여러 공급자에 동시에 배치할
것인가?" — 에 소유자가 **전면 도입**으로 답했고, 이어서 identity 형태에 대한 결정이
내려졌습니다. 이 문서는 그 결정과, 결정에 딸려 나오는 기존 코드 영향을 기록합니다.

**이 문서의 사실 주장은 세 차례 독립 검토에서 각각 5·5·2건 정정됐습니다.** 그 이력은
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

## 4. Broker 경로와 residency (개정 4에서 다시 바뀜)

개정 2는 `routingPolicyDigest`를 routing-eligible의 증거로 썼고, 거부됐습니다 —
digest는 **우리가 보낸 설정**을 증명할 뿐 broker가 어디서 실행했는지를 증명하지
않기 때문입니다.

개정 3은 그것을 **응답별 serving attestation**으로 대체했습니다. **그것도
거부됐습니다. 이유가 더 근본적입니다** — 응답 attestation은 **데이터가 이미 전송된
뒤에 도착합니다.** 불일치를 발견했을 때는 사용자 데이터가 이미 잘못된 관할에 가
있습니다. 사후 증거는 사전 게이트가 될 수 없습니다.

### 4.1 판정은 사전에, 증거는 사후에

| 값 | 언제 | 무엇에 쓰는가 |
|---|---|---|
| endpoint/region pin + 승인된 계약 | **dispatch 전** | **routing-eligible 판정.** 강제 가능해야 함 |
| `routingPolicyDigest` | dispatch 전 | 우리가 건 설정. 의도이지 저쪽 사실이 아님 |
| 응답별 serving attestation | dispatch 후 | **이 요청의 사후 감사**, 그리고 **이후 요청의 quarantine 신호** |

규칙:

1. **routing-eligible은 계약으로 정합니다** — 공급자가 계약상 보장하고 요청 옵션으로
   강제할 수 있는 endpoint/region pin. 그것이 없으면 제약 트래픽의 후보가 아닙니다.
2. **attestation 불일치는 그 요청을 되돌리지 못합니다.** 할 수 있는 것은 기록과,
   그 endpoint를 이후 제약 트래픽에서 격리하는 것뿐입니다. 이 한계를 문서에
   적는 것이 이 절의 요점입니다.
3. **모르면 `unproven`입니다** (§4.3).

### 4.2 `unknown`은 "아무 데나 괜찮다"가 아닙니다

Tomverse는 **호주 법인**이고 APP 8(해외 공개)이 적용됩니다. 사용자가 제약을
명시하지 않았다는 것은 **조직이 어떤 해외 공개를 기본으로 허용하는가**에 대한 답이
아닙니다. 이 저장소는 같은 문제를 반대 방향으로 이미 결정했습니다 —
`docs/policy/voice-input.md`는 destination을 이름 댈 수 없으면 고지가 참이 될 수
없다고 적습니다.

### 4.3 전환 순서 (S2)

즉시 fail-closed는 **후보 전체를 탈락시켜 게이트를 도로 풀게 만드는 실패 양상**을
가집니다. "explicit legacy"라는 라벨만 붙이는 것도 허용되지 않습니다. 순서:

1. 기존 endpoint·recipient·destination **인벤토리** 작성
2. **Privacy Owner가 기본 해외 공개 집합 승인**
3. 기존 endpoint를 **근거 있는 값으로 분류**
4. 그 후 fail-closed 활성화

3단계 이전의 예외는 **기한·소유자·만료·신규 트래픽 확장 금지를 가진 승인된 예외**
라야 합니다. 라벨이 아니라 승인입니다.

관측 사실: `regionBlockedModelIds`는 현재 입력만 존재하고 **production producer가
없습니다**(`app/api/chat/route.ts`). residency는 아직 아무것도 막고 있지 않습니다.

### 4.4 S1의 답: 검증된 공급자 없음

3차 검토 시점에 **serving attestation을 제공한다고 확인된 공급자는 0개**입니다.
이 저장소가 읽는 것은 OpenAI의 `serviceTier` 하나뿐이고(`lib/servedProcessingTier.ts`),
현재 provider 목록에 OpenRouter는 아예 없습니다(`lib/models.ts`).

그러므로 **ADR §14의 "OpenRouter = emergency fallback" 역할은 제약 트래픽에 대해
성립하지 않습니다.** 명시적으로 적습니다. digest만으로 허용하면 broker가 upstream을
바꿔도 탐지하지 못합니다.

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

### 6.1 class는 품질 증거 재사용에만 씁니다 (개정 4에서 정정)

개정 3은 ADR §3.3의 "같은 equivalence group에서만 자동 fallback"을 그때까지
**deployment 동일성**으로 읽자고 했습니다. **그것은 §11과 정면으로 모순됩니다** —
§11은 endpoint/provider scope 실패에서 다른 endpoint를 요구하는데, 같은 deployment는
정의상 하나의 endpoint를 가리킵니다. 두 조건을 동시에 만족하는 후보는 존재하지
않으므로, 그대로 읽으면 **fallback 자체가 사라집니다.**

정정:

- **equivalence class는 품질 증거를 재사용해도 되는가**에만 답합니다.
- **fallback 대상은 자기 deployment gate를 독립적으로 통과한 deployment**면
  충분합니다. class가 없다는 것이 fallback을 금지하지 않습니다.

두 질문은 애초에 다른 질문이었고, 하나의 개념으로 답하려 한 것이 잘못이었습니다.

이것은 개정 2의 §6을 통째로 미루는 결정이며, 미루는 이유는 근거가 없어서입니다 —
설계가 틀렸다기보다 **전제가 조사되지 않았습니다.**

## 7. 비용은 실행 route의 속성입니다

BYOK에서는 같은 deployment가 credential에 따라 다른 비용을 갖습니다. 네 값을
분리합니다.

| 값 | 의미 | 쓰이는 곳 |
|---|---|---|
| `providerChargeEstimate` | 이 route가 공급자에게 청구될 금액 | **tie-break 비용 기준만** |
| `tomverseMarginalCost` | Tomverse가 부담하는 금액 | **사용자 operational guardrail, Tomverse provider budget, 구매 크레딧 funded allowance**, COGS |
| `workspaceExternalCost` | workspace가 자기 계정으로 부담하는 금액 | **별도 `byok-spend-*` namespace**, workspace 한도 |
| `billingOwner` | 분배를 정하는 라벨 | 귀속 |

**개정 3은 guardrail에 `providerChargeEstimate`를 쓰자고 했습니다. 정정합니다.**
`reservedCost`에는 소비자가 **셋** 있고, 개정 3은 그중 둘만 찾았습니다 — 세 번째는
구매 크레딧의 `fundedCostMicroUsd` 배분입니다(`lib/chatSecurity.ts`,
`addOnReservedCost = ceil(reservedCost * addOnReservedCredits / usageCredits)`).
BYOK에 `providerChargeEstimate`를 쓰면 **사용자가 자기 돈으로 낸 지출이
Tomverse-funded allowance를 소진**합니다.

그리고 guardrail 자체가 코드 주석에서 "internal cost safety"입니다. Tomverse가 한
푼도 안 내는 지출에 Tomverse의 운영 보호 한도를 적용하는 것은 **사용자가 자기 돈을
쓴다는 이유로 조이는 일**입니다. BYOK 지출에는 자기 namespace와 명시적 workspace
한도가 필요합니다 — 사용자 크레딧도, operational guardrail도, Tomverse provider
예산도 아닌 **네 번째 것**입니다.

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

#### 표본이 없으면 자를 수 없습니다 (S4, 개정 4에서 추가)

**지금 cutover하면 health filter가 조용히 사라집니다.** 현재:

- probe는 **provider당 대표 모델 하나**이고 Perplexity는 표본이 아예 없습니다
  (`lib/providerProbe.ts`)
- probe 행에 **endpoint·deployment 컬럼이 없습니다**(`prisma/schema.prisma`)
- `RoutingAttempt` 계측은 **기본이 꺼져 있습니다**(`lib/routerRuntimeSignals.ts`)

표본 없이 deployment grain으로 자르면 모든 deployment가 `unknown`이 되고, 현행
정책상 `unknown`은 **아무도 제외하지 않습니다**. 필터가 있는 척하며 통과시킵니다.

cutover 전에 필요한 것:

1. probe·attempt에 **nullable `providerEndpointId`·`modelDeploymentId`**
2. **deployment별 synthetic canary**
3. §9 분류 결과가 **settlement까지 보존**될 것 (A-4a의 남은 절반 — §10)
4. 계측 활성화 후 **최소 한 관측 window** 축적
5. 표본 없음은 `unknown`이 아니라 **`unproven` = routing-ineligible**

5번이 개정 4의 규칙 변경입니다. `unknown`(아무도 제외 안 함)은 probe가 성긴
provider grain에서는 옳았지만, deployment grain에서는 "아직 아무 증거도 없다"가
기본 상태가 되므로 같은 규칙이 필터를 무효로 만듭니다.

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
- 원문·잔액·오류 문구는 저장하지 않습니다 — content-free가 유지됩니다.

**run당 상한은 두지 않습니다** (S5, 개정 4에서 정정). 개정 3은 행 크기를 위해 상한을
두자고 했습니다. 어떤 절단선을 잡아도 **버려지는 것은 하위 순위이거나 특정 rejection
reason이고, 그것이 정확히 "왜 이 deployment는 안 뽑혔는가"라는 질문의 답**입니다.
새로 추가된 deployment가 가장 먼저 잘립니다 — 그 답이 가장 필요한 대상입니다.

대신 **활성 registry 자체에 승인된 ceiling**을 둡니다. 상한을 넘는 config는
publish를 거절하고 마지막 승인 snapshot을 유지합니다. 런타임에서 예상 밖 초과가
나면 overflow 사건으로 기록합니다. 크기는 config 승인 시점에 통제하지 실행 시점에
증거를 버려 통제하지 않습니다.

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

- **provider health는** timeout·`ECONNRESET`을 분리하지 않습니다. `PROVIDER_SCOPED`가
  `NETWORK`를 담습니다.
- **`classifyStreamFailure`는** 분리합니다 — 그러나 **그 결과가 행에 도달하는지는
  별개 문제였습니다**(아래).
- 정확한 표현은 `ECONN`이 아니라 **`ECONNRESET`** 하나입니다. `ECONNREFUSED`·
  `ETIMEDOUT`·`EPIPE`는 abort-shaped 분기에 들어가지 않습니다
  (`lib/routingStreamFailure.ts`).

#### 분류가 행에 도달하지 않고 있었습니다 (F1, 개정 4에서 정정)

개정 3은 "attempt 기록은 timeout·ECONN을 provider 실패에서 분리한다"고 적었습니다.
**코드에 대해 거짓이었습니다.**

`attemptFallback`이 분류를 계산하지만, **fallback이 거절되면**(기본값 —
`AUTO_ROUTER_FALLBACK_ENABLED`가 꺼져 있음) 그 결과는 버려지고
`settleSafely("failed")`가 instrumentation 없이 호출됩니다. 저장되는 것은 generic
매핑의 `failed_post_token` / `stream` / `errorClass = NULL`입니다. 분류가 행에
도달하는 유일한 경로는 **fallback이 성공한 경우**뿐이었습니다.

A-4a가 분류를 보존하도록 고쳤지만, 그 절반만 고쳤던 것입니다. 나머지 절반은
개정 4와 함께 고쳤습니다 — 이제 fallback이 거절돼도 `errorClass`가 행에 실립니다.

**`errorClass`만 전달합니다.** `classifyStreamFailure`의 `outcome`은 "대체해도
되는가"에 답하며 그 목적으로 provider timeout을 `cancelled`라고 부르는데,
`DISPATCH_OUTCOMES_COUNTED`는 `cancelled`를 "사용자가 마음을 바꿨다"는 뜻으로
제외합니다. outcome까지 옮기면 provider timeout이 성공률 분모에서 빠집니다 —
이름이 아니라 점수 변경입니다. **한 값이 두 질문에 쓰이고 있다는 것 자체가 갭 4가
가리키는 문제의 또 다른 사례입니다.**

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

**이 표는 아직 구현할 수 없습니다** (개정 4에서 추가). `classifyStreamFailure`는
scope를 반환하지 않고, `classifyProviderFailure().scope`를 읽고 나서 버립니다
(`lib/routingStreamFailure.ts`). `PROVIDER_SCOPED`는 이미 provider-scoped와
model-scoped를 구분하고 있으므로 **없는 것을 만드는 일이 아니라 또 한 번 버려지는
것을 살리는 일**입니다 — A-4a가 `errorClass`에 대해 한 것과 같은 모양입니다.
scope 보존이 §11 표의 선행 조건이고, 그 전까지 fallback 규칙은 현행 그대로입니다.

그리고 **fallback 대상은 class 소속이 아니라 자기 gate를 통과한 deployment**입니다
(§6.1). class 부재가 fallback을 금지하지 않습니다.

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

## 13. 개정 3에서 바뀐 것

| 항목 | 개정 3 | 개정 4 |
|---|---|---|
| broker 판정 | 응답별 attestation이 판정 | **계약·강제 가능한 pin이 사전 판정.** attestation은 사후 감사와 이후 quarantine — 데이터는 이미 나간 뒤 도착하므로 게이트가 될 수 없음 |
| OpenRouter | 제약 트래픽 제외 가능성 | **attestation 공급자 0개 확인. 제약 트래픽에 대해 ADR §14의 역할 불성립**을 명시 |
| residency 전환 | 열린 질문(S2) | **4단계 순서 확정.** 라벨이 아니라 기한·소유자·만료를 가진 승인된 예외 |
| equivalence group | "당분간 deployment 동일성"으로 읽음 | **철회.** §11의 다른 endpoint 요구와 모순돼 fallback이 사라짐. class는 **품질 증거 재사용 전용**, fallback 대상은 자기 gate를 통과한 deployment |
| guardrail 비용 | `providerChargeEstimate` | **`tomverseMarginalCost`.** `reservedCost`의 **세 번째** 소비자(구매 크레딧 funded allowance)를 놓쳤음. BYOK는 별도 `byok-spend-*` namespace |
| health cutover | atomic cutover | + **표본 전제 5건.** 표본 없음은 `unknown`이 아니라 **`unproven` = routing-ineligible** |
| 후보 동결 | run당 상한 | **상한 없음.** 자르면 신규 deployment의 판정부터 사라짐. **활성 registry ceiling을 config publish에서** 강제 |
| §11 fallback 표 | 실패 scope가 정함 | 유지 + **지금은 구현 불가**를 명시. `classifyStreamFailure`가 scope를 버림 |
| 갭 4 서술 | attempt 기록은 분리함 | **거짓이었음.** fallback 거절 시 분류가 행에 도달하지 않았음(F1). 고쳤고, `errorClass`만 전달 |
| `ECONN` | 넓게 서술 | **`ECONNRESET` 하나**로 정정 |

## 14. 권장 작업 순서 (3차 검토 반영)

1. **S1·S2, workspace/account 소유권, BYOK namespace, §6/§11 관계를 먼저 결정** —
   대부분 소유자·Privacy Owner의 승인 행위입니다
2. 현재 stream 분류 결과가 settlement와 attempt 행까지 도달하게 고침 —
   **개정 4와 함께 완료** (§10)
3. A-3b/A-4a는 하나의 vocabulary로 설계하되 **한 migration으로 뭉개지 않음**:
   expand CHECK → writer 배포 → 운영값 조사 → **별도 validation**
4. C identity schema를 **additive/nullable**로 도입. 과거 행 추측 백필 없음
5. **C 직후 A-5 config manifest** — multi-deployment decision 전환보다 **반드시
   먼저**여야 합니다
6. canonical observation journal과 deployment canary 구축, 표본 축적
7. BYOK 비용·funded allowance·bucket key를 **versioned dual-read/write**로 전환
8. 모든 후보 verdict 저장과 **registry ceiling** 구현
9. shadow 비교 후 decision grain을 한 번에 `deploymentId`로 전환
10. failure scope와 capacity state가 갖춰진 뒤 2-attempt fallback 활성화
11. provider attestation이 재사용 가능성을 입증한 뒤 equivalence class 재검토

## 15. 되돌릴 수 없는 것

3차 검토의 판정을 그대로 받습니다. 비가역적인 것은 셋입니다.

1. **해외 공개** — 나간 데이터는 회수되지 않습니다.
2. **요청 당시 저장하지 않은 증거** — serving·config·candidate 판정. 나중에
   재구성할 수 없습니다.
3. **근거 없이 백필해 오염시킨 과거 identity** — 틀린 값을 지운 자리에 진짜 값이
   없습니다.

비용·순위·fallback 정책 자체는 **수정 배포로 되돌릴 수 있으므로** 같은 수준의
릴리스 차단으로 취급하지 않습니다. 이것이 AGENTS.md "검증 범위는 되돌릴 수 없는
것에 비례합니다"의 적용입니다.

## 15.1 4차 검토에 올리는 열린 질문

- **T1** — §4.1의 "계약상 보장되고 요청 옵션으로 강제 가능한 region pin"을 실제로
  제공하는 공급자는 어디인가? Azure·Vertex·Bedrock은 그럴 것으로 보이지만
  확인되지 않았습니다. 확인되지 않으면 §4는 또 실행 불가입니다.
- **T2** — §8.3의 `byok-spend-*` namespace에 한도를 정하는 주체는 누구인가?
  workspace가 자기 한도를 정한다면 그것은 abuse 방어가 아니고, Tomverse가 정한다면
  왜 남의 돈에 한도를 거는지 답해야 합니다.
- **T3** — §8.1의 `unproven`이 routing-ineligible이면, deployment 도입 직후 **모든
  deployment가 ineligible**입니다. 첫 표본은 어떻게 얻는가 — canary가 ineligible
  deployment로 트래픽을 보내야 하는데 그것이 허용되는가?
- **T4** — §8.5의 registry ceiling을 넘는 config를 거절하면, 공급자가 모델을
  늘릴 때 **승인 없이는 카탈로그가 멈춥니다.** 의도한 것인가?
- **T5** — §14의 5번(A-5를 C 직후)은 A-5가 deployment·endpoint·routing policy
  digest를 함께 동결해야 한다는 뜻입니다. 그러면 A-5 이전의 C 작업은 **동결되지
  않은 config 위에서** 이루어집니다. 그 구간의 재현성은 포기하는가?

## 16. 검토 이력

- ADR v2.1: C1–C15 → N1–N11 → R1–R6. **세 번 모두 그린필드 전제.**
- 갭 분석: 독립 검토 없음.
- 개정 1: Cursor 독립 검토 → **`reject`**. blocker 2, major 6, 사실 오류 5.
- 개정 2: Cursor 독립 검토 → **`reject`**. blocker 2, major 5, 사실 오류 5.
  round 1 findings 중 `closed` 2건, `partially closed` 3건, `not closed` 3건.
- 개정 3: Cursor 독립 검토 → **`reject`**. blocker 2, major 3, 사실 오류 2.
  round 2 findings 중 `not closed` 1건, `partially closed` 5건.
- 개정 4: 4차 독립 검토 대기.
