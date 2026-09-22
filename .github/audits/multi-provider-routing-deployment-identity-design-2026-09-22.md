# 멀티 공급자 라우팅 — deployment identity 설계 (v2.1 ADR 개정안)

- 작성일: 2026-09-22
- **개정 5** (2026-09-23). 개정 1–4 모두 독립 검토에서 `reject`. 이 판은 4차 검토의
  blocker 1건·major 3건과 **사실 오류 2건**, 그리고 개정 4가 스스로 만든 결함
  1건을 반영한 것입니다. 변경 요약은 §13.
- 상태: **제안. 5차 독립 검토 대기.**
- 선행 문서
  - [`.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`](./multi-provider-routing-adr-gap-analysis-2026-09-22.md)
  - [`docs/policy/tomverse-multi-provider-routing-v2.1.md`](../../docs/policy/tomverse-multi-provider-routing-v2.1.md) (ADR, 미채택)
  - [`docs/policy/tomverse-chat-routing.md`](../../docs/policy/tomverse-chat-routing.md) (현행)
  - [`docs/policy/tomverse-chat-router-score-policy.md`](../../docs/policy/tomverse-chat-router-score-policy.md) (현행)

## 0. 경위

갭 분석이 남긴 0단계 질문 — "하나의 논리 모델을 여러 공급자에 동시에 배치할
것인가?" — 에 소유자가 **전면 도입**으로 답했고, 이어서 identity 형태에 대한 결정이
내려졌습니다. 이 문서는 그 결정과, 결정에 딸려 나오는 기존 코드 영향을 기록합니다.

**이 문서의 사실 주장은 네 차례 독립 검토에서 각각 5·5·2·2건 정정됐습니다.** 그 이력은
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

## 4. Broker 경로와 residency

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

### 4.4 승인 자체가 저장돼야 합니다 (개정 5에서 추가)

§4.1은 "승인된 계약"에 eligibility를 걸었지만, **그 계약이 어디 사는지를 정하지
않았습니다.** `ProviderEndpoint`에는 가변 region·destination·digest만 있고,
`servingProvider`는 null일 수 있으며, 허용 recipient 집합이 없습니다. 그 상태로는
한 attempt에 대해 **"어떤 계약 버전과 recipient·destination 집합 때문에 dispatch가
허용됐는가"를 immutable join으로 재구성할 수 없습니다** — 법적 판정의 근거를 사후에
복원할 수 없다는 뜻이고, 그것이 §3이 막으려던 바로 그 상태입니다.

**`EndpointResidencyApproval`을 둡니다. append-only immutable version입니다.**

| 필드 | 의미 |
|---|---|
| `evidenceRef` | 승인 근거 (계약서·DPA·공급자 문서의 고정 식별자) |
| `allowedRecipients` | 허용된 recipient/provider 집합 |
| `allowedRegions` | 허용된 destination region 집합 |
| `enforcementMechanism` | 무엇으로 강제하는가 (endpoint URL, 요청 옵션, 계정 설정) |
| `effectiveFrom` / `effectiveTo` | 유효기간 |
| `approver` | 승인한 사람 |

- **운영자가 destination을 수정할 수 없습니다.** 바꾸려면 새 version입니다.
- **published manifest는 승인 version만 참조합니다.**
- **A-5와 attempt snapshot이 그 id와 digest를 결속합니다.**

가변 행으로 두면 "그때 무엇이 허용돼 있었나"에 답할 수 없고, 답할 수 없는 것에
법적 판정을 얹는 구조가 됩니다.

### 4.5 S1의 답: 검증된 공급자 없음

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

`reservedCost`에는 소비자가 **셋**입니다(`lib/chatSecurity.ts`) — 사용자 operational
guardrail, Tomverse provider hold, 그리고 구매 크레딧의 `fundedCostMicroUsd` 배분.
개정 2는 하나도 못 봤고, 개정 3은 둘만 찾았습니다.

**배선은 §7의 표 하나가 정하며 여기서 다시 정하지 않습니다.** 개정 4는 이 절에
`providerChargeEstimate`를 남겨 두어 §7·§13과 정면으로 모순됐습니다. 확정:

- 사용자 guardrail · Tomverse budget · 구매 크레딧 funded allowance →
  **`tomverseMarginalCost`**
- tie-break → `providerChargeEstimate`
- BYOK 외부 지출 → **별도 `byok-spend-*` namespace** (한도 주체는 T2)

그 위에 배선 작업 둘:

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

#### 두 identity는 남습니다 (개정 5에서 추가)

"전부 `deploymentId`로 바꾼다"는 잘못된 요약입니다. **사용자가 보고 고르는 것은
계속 logical model입니다.** `RoutingRun.selectedModelId`, sticky state, 사용자
설정, 메시지 badge, entitlement가 모두 제품 모델 ID이고, 그것을 deployment ID로
덮으면 사용자 설정 자리에 인프라 식별자가 저장됩니다. 반대로 놔두면 여러
deployment가 다시 하나로 합쳐집니다.

| 무엇 | 어느 identity |
|---|---|
| candidate identity | **`{ logicalModelId, deploymentId }` 쌍** |
| 사용자 설정 · 메시지 badge · entitlement | logical model |
| health · cost · endpoint tie-break · attempt | deployment |
| `RoutingRun` · `RoutingAttempt` | **둘 다, 별도 snapshot** |

그리고 **지속 상태 둘이 logical grain입니다** — `Conversation`의 sticky·recovery
model ID와 `ROUTER_SCORE_SNAPSHOT`. 백필하지 않습니다. resolver와 deployment-key
score snapshot 전환이 grain cutover의 **선행 작업**입니다(§14).

### 8.5 후보 판정 동결: `RoutingCandidateVerdict`

후보는 가변 런타임 DB 레지스트리에서 옵니다(`runtimeModels.filter(...)`). `enabled`·
`catalogDeleted`·`minimumPlan`·context window·backend readiness가 전부 움직이므로
**어떤 탈락 사유도 사후 재구성할 수 없습니다.** `lib/routingShadow.ts`의 "stable
catalogue information a reader can reconstruct"는 자기 전제에서 틀렸습니다.

형태를 확정합니다 — 개정 2는 "candidate id 또는 snapshot version"이라고 두 갈래로
열어 두었습니다.

- **`RoutingCandidateVerdict` 자식 테이블.** run당 후보마다 한 행.
- 원문·잔액·오류 문구는 저장하지 않습니다 — content-free가 유지됩니다.

개정 4의 필드(`deploymentId` + `reason` + `snapshotId`)는 **탈락한 후보만 표현할 수
있었습니다.** eligible 후보에는 rejection reason이 없고, 통과했는데 안 뽑힌 후보가
왜 밀렸는지도 담을 곳이 없습니다 — 그런데 "왜 이게 안 뽑혔나"는 애초에 이 테이블을
만든 질문입니다. 정정된 컬럼:

| 컬럼 | 의미 |
|---|---|
| `routingRunId`, `logicalModelId`, `deploymentId` | 누구에 대한 판정인가 (§8.4) |
| `verdict` | **`eligible` \| `rejected`** |
| `reason` | 고정 식별자. `eligible`이면 null — **nullable CHECK로 강제** |
| `rankBucket`, `rank` | 통과한 후보가 몇 번째였는가 |
| `decisionInputSnapshotId` | 그 순간의 health·cost 값. **config snapshot만으로는 재구성되지 않습니다** |

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
`errorClass`를 지웁니다(`lib/routingAttemptStore.ts`). `errorClass` 컬럼에도 이제
CHECK가 있습니다 — A-3b가 닫힌 vocabulary를 `NOT VALID`로 배포했으므로 신규·갱신
행에는 적용되고 과거 행만 미검증입니다. 정확한 서술은 **"writer와 failure-layer
CHECK가 `succeeded + model_output` 표현을 막는다"** 입니다.

원칙은 라우팅 밖에서 이미 구현돼 있었습니다 — `AI_EMPTY_RESPONSE` →
`MODEL_TRANSIENT` → `scope: "model"`, `PROVIDER_SCOPED`에서 제외. **A-3a에서 그
결정이 attempt 기록에 도달했습니다**(`model_output` layer).

남은 것: 잘림(`length`)·content_filter+본문·파싱 실패. 앞의 둘은 현재 `succeeded`로
기록되므로 옮기면 성공률이 바뀝니다 — 라벨이 아니라 점수 변경이고 별도 근거가
필요합니다.

## 10. 이미 착수한 항목의 결과

| # | 항목 | 상태 |
|---|---|---|
| A-1 | comparator 전순서 수정 | **구현·검증 완료. 2차 검토 `approve_with_changes` → 지적 5건 반영 완료** |
| A-2 | 빈 200 오분류 | 구현·검증 완료 |
| A-3a | `model_output` failure layer | 구현·검증 완료 |
| A-3b | `errorClass` 닫힌 vocabulary + CHECK | **writer 구현, `NOT VALID` CHECK 배포. production 조사 후 별도 `VALIDATE` 대기** |
| A-4a | `RATE_LIMIT` 등 분류 보존 | **구현 완료.** fallback 거절 경로까지 도달(개정 4), 연결 손실 오분류 수정(개정 5) |
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
(`lib/routingStreamFailure.ts`).

**그리고 scope를 살리는 것만으로는 부족합니다**(개정 5에서 정정). 연결 실패는
`classifyProviderFailure`를 **부르기 전에** 반환되므로 그 함수의 scope를 보존해도
답이 없습니다. 게다가 새 모델에는 `gatewayProvider`와 `servingProvider`가 둘 다
있는데, generic `provider` scope는 **어느 쪽인지 말하지 못합니다.**

필요한 것은 **canonical classifier 하나**가 다음을 함께 내는 것입니다.

```
scopeKind  (gateway | serving_endpoint | deployment | model | local)
scopeId    (그 scope의 식별자)
category   (ProviderFailureCategory)
version    (분류 규칙의 버전)
```

그리고 **user abort와 upstream timeout을 서로 다른 provenance로 판정**해야 합니다 —
개정 5가 `client_gone`/`provider_network`로 쪼갠 것이 그 첫 조각입니다.

canonical classification이 §11 표의 선행 조건이고, 그 전까지 fallback 규칙은 현행
그대로입니다.

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

## 13. 개정 4에서 바뀐 것

| 항목 | 개정 4 | 개정 5 |
|---|---|---|
| residency 승인 | "승인된 계약"에 의존 | **`EndpointResidencyApproval`** — append-only immutable version. evidence·recipient·region·enforcement·유효기간·approver를 저장하고 attempt snapshot이 결속 (§4.4) |
| BYOK guardrail | §7은 `tomverseMarginalCost`, §8.3은 `providerChargeEstimate` — **모순** | **§7 표 하나가 정함.** guardrail·budget·funded allowance는 전부 `tomverseMarginalCost` |
| identity grain | "decision plane 전체를 deploymentId로" | **둘 다 남음.** candidate는 `{logicalModelId, deploymentId}` 쌍, 사용자 설정·badge·entitlement는 logical (§8.4) |
| failure scope | `classifyProviderFailure().scope`를 살리면 됨 | **부족함.** 연결 실패는 그 함수 이전에 반환되고, generic `provider`는 gateway/serving을 구분 못 함. **canonical classifier**가 `scopeKind + scopeId + category + version`을 냄 |
| candidate verdict | `deploymentId + reason + snapshotId` | **`verdict` 컬럼 추가.** eligible 후보와 통과했는데 밀린 후보를 표현 못 했음. rank·decision-input snapshot 포함 |
| sticky·score snapshot | 언급 없음 | **logical grain임을 명시.** 백필 없이 resolver 전환이 cutover 선행 작업 |
| §9 `errorClass` CHECK | "없음" | **있음.** A-3b가 `NOT VALID`로 배포. 과거 행만 미검증 |
| §10 A-3b·A-4a | "미착수" | **구현 완료.** A-4a는 fallback 거절 경로까지 도달하고 연결 손실 오분류도 수정 |

## 13.1 개정 5가 고친 자기 결함

개정 4의 F1 수정이 **틀린 증거를 저장하고 있었습니다.** `TimeoutError`와
`ECONNRESET`은 `isAbortShaped` 분기에서 조기 반환되는데, 개정 4는 그 분기 전체에
`client_gone`이라는 이름을 붙였습니다. 그런데 그 코드의 주석이 바로 옆에서
**"they are not user cancellations"** 라고 적고 있습니다.

이름을 붙이기 전에는 그 분기에 class가 아예 없어서 부정확함이 보이지 않았습니다.
이름을 붙이는 순간 **보수적인 fallback 판정이 기록 속 거짓 주장이 됐습니다.**
그리고 provider health는 같은 사건을 `NETWORK`라고 부르므로, 두 하위 시스템이 한
사건에 대해 서로 다른 말을 하는 상태가 하나 더 생긴 것이었습니다 — 이 문서가 갭 4
에서 문제라고 지적한 바로 그 모양입니다.

`client_gone`(진짜 abort)과 `provider_network`(연결 손실)로 쪼갰습니다. 판정
(`cancelled`/`stream`)은 그대로입니다 — 바뀐 것은 이름뿐이고, 이름이 틀렸던 것이
문제였습니다.

`failureLayer`도 함께 전달하게 고쳤습니다. 그러지 않으면 rate limit이
`errorClass: provider_rate_limited` 옆에 generic 매핑의 `failureLayer: stream`을
달고 저장돼 **행 자체가 모순**됩니다.

## 14. 권장 작업 순서 (4차 검토 반영)

1. **T1·T2와 workspace/account 소유권 결정** — Privacy Owner·Backend owner의 승인
   행위이며 제가 할 수 없습니다
2. **canonical failure classification과 scope identity 확정** (§11) — 여러 항목이
   여기에 걸려 있습니다
3. versioned **residency approval과 recipient/destination 계약을 C schema에 포함**
4. 기존 A-3b CHECK를 **운영값 조사 후 별도 migration으로 `VALIDATE`**
5. C를 **additive/dark**로 배포하고 **즉시 A-5 manifest** 배포. A-5 이전에는
   identity config writer 활성화·canary 기록·eligibility 판정·deployment
   decision을 **모두 금지**
6. residency-safe **canary lane**과 canonical observation journal 구축
7. BYOK 비용·funded allowance·bucket key를 **versioned dual-read/write**로 전환
8. 완전한 candidate verdict와 **routing-snapshot ceiling** 구현
9. **sticky·score snapshot grain 전환** (선행), 그 뒤 shadow 검증
10. decision grain을 `deploymentId`로 **원자 전환**
11. scope·capacity가 준비된 뒤 2-attempt fallback 활성화
12. provider attestation이 입증되면 equivalence class 재검토

## 15. 되돌릴 수 없는 것

1. **해외 공개** — 나간 데이터는 회수되지 않습니다.
2. **요청 당시 저장하지 않은 증거** — serving·config·candidate 판정.
3. **근거 없이 백필해 오염시킨 과거 identity.**

비용·순위·fallback 정책 자체는 수정 배포로 되돌릴 수 있으므로 같은 수준의 릴리스
차단으로 취급하지 않습니다.

## 15.1 T1–T5의 답

- **T1 (region pin 공급자)** — **확인된 공급자 0개.** Azure·Vertex·Bedrock을
  추정 승인하지 않습니다. 공식 계약·endpoint enforcement 증거가 capability
  register에 들어오기 전까지 `unproven`입니다. OpenRouter constrained fallback은
  계속 불가.
- **T2 (BYOK 한도 주체)** — **workspace/account admin이 정합니다.** Tomverse의 abuse
  방어는 concurrency·rate·token 한도로 별도 집행합니다. 한도 없이 BYOK binding을
  활성화하는 것은 거부 — 탈취된 credential의 무제한 지출이 됩니다. **Workspace
  모델이 현재 schema에 없으므로** account와 workspace 중 소유권 결정이 선행입니다.
- **T3 (`unproven` bootstrap)** — **별도 synthetic canary lane만** 우회합니다.
  residency는 먼저 proven, 사용자 콘텐츠 없음, 별도 credential quota와 provider
  budget, 정상 routing candidate 아님, 최소 표본·관측 window 통과 후에만 eligible.
  사용자 트래픽 bootstrap과 `unknown` 임시 허용은 기각.
- **T4 (registry ceiling)** — **published routing deployment snapshot에만** 적용.
  새 모델은 staging registry에 들어갈 수 있고, 승인 snapshot을 넘으면 Auto에
  활성화되지 않을 뿐입니다. 전체 catalogue 중단은 routing과 무관한 기능까지
  막으므로 기각.
- **T5 (C와 A-5 순서)** — **C를 additive dark schema로만** 먼저 배포하면 허용.
  A-5 이전 금지 항목은 §14의 5번. 가능하면 **같은 release train**에 넣고 A-5가
  residency approval version까지 동결합니다.

## 15.2 5차 검토에 올리는 열린 질문

- **U1** — §4.4의 `EndpointResidencyApproval`을 누가 씁니까? 소유자 승인이
  선행인데, 승인 UI가 없는 상태에서 첫 행은 어떻게 생기는가?
- **U2** — §11의 canonical classifier가 `scopeKind`를 내려면 실패 시점에
  gateway/serving을 구분해야 합니다. broker 경로에서 serving이 null이면 scope는
  무엇인가?
- **U3** — §8.4의 `{logicalModelId, deploymentId}` 쌍이 tie-break 최종 기준이
  되면, 같은 logical model의 두 deployment는 무엇으로 갈립니까? deployment id는
  임의값이라 `model_id`가 그랬듯 안정성만 삽니다.
- **U4** — T3의 canary lane이 "정상 routing candidate 아님"이면 그 표본은 실제
  사용자 트래픽과 분포가 다릅니다. 그 표본으로 얻은 health가 사용자 트래픽에 대해
  유효하다고 말할 근거는 무엇인가?
- **U5** — Perplexity는 모든 모델이 search-backed라 기존 probe 대상에서 제외됩니다
  (`lib/providerProbe.ts`). 기존 probe 계약을 재사용하면 **Perplexity deployment는
  영구 `unproven`** 이고 Auto에서 영구 제외됩니다. canary가 별도 계약·예산을
  가져야 한다는 뜻인데, 그 비용은 누가 승인하는가?

## 16. 검토 이력

- ADR v2.1: C1–C15 → N1–N11 → R1–R6. **세 번 모두 그린필드 전제.**
- 갭 분석: 독립 검토 없음.
- 개정 1: Cursor 독립 검토 → **`reject`**. blocker 2, major 6, 사실 오류 5.
- 개정 2: Cursor 독립 검토 → **`reject`**. blocker 2, major 5, 사실 오류 5.
  round 1 findings 중 `closed` 2건, `partially closed` 3건, `not closed` 3건.
- 개정 3: Cursor 독립 검토 → **`reject`**. blocker 2, major 3, 사실 오류 2.
  round 2 findings 중 `not closed` 1건, `partially closed` 5건.
- 개정 4: Cursor 독립 검토 → **`reject`**. blocker 1, major 3, 사실 오류 2.
  round 3 findings 중 `closed` 1건, `partially closed` 3건, `not closed` 1건.
  그리고 개정 4의 수정 자체가 틀린 증거를 저장하고 있었습니다(§13.1).
- 개정 5: 5차 독립 검토 대기.
