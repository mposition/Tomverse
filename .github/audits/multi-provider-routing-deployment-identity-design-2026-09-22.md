# 멀티 공급자 라우팅 — deployment identity 설계 (v2.1 ADR 개정안)

- 작성일: 2026-09-22
- **개정 2** (같은 날). 개정 1은 독립 검토에서 `reject`. 이 판은 그 검토의
  blocker 2건·major 6건과 사실 오류 5건을 반영한 것입니다. 변경 요약은 §12.
- 상태: **제안. 2차 독립 검토 대기.**
- 선행 문서
  - [`.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`](./multi-provider-routing-adr-gap-analysis-2026-09-22.md)
  - [`docs/policy/tomverse-multi-provider-routing-v2.1.md`](../../docs/policy/tomverse-multi-provider-routing-v2.1.md) (ADR, 미채택)
  - [`docs/policy/tomverse-chat-routing.md`](../../docs/policy/tomverse-chat-routing.md) (현행)
  - [`docs/policy/tomverse-chat-router-score-policy.md`](../../docs/policy/tomverse-chat-router-score-policy.md) (현행)

## 0. 경위

갭 분석이 ADR 채택 전에 답해야 할 0단계 질문을 남겼습니다 — "하나의 논리 모델을
여러 공급자에 동시에 배치할 것인가?" 소유자가 **전면 도입**으로 답했고, 이어서
identity 형태에 대한 결정이 내려졌습니다. 이 문서는 그 결정과, 결정에 딸려 나오는
기존 코드 영향을 기록합니다.

갭 분석 §5가 "확정되지 않았다"고 남긴 갭 4·5는 소스 확인으로 확정했으며(§9),
1차 독립 검토가 그중 일부를 다시 정정했습니다.

## 1. 소유자 결정

| ID | 결정 | 효과 |
|---|---|---|
| D1 | multi-deployment **전면 도입** | 갭 1·6·7, 갭 4b가 범위 안 |
| D2 | credential은 deployment identity에 **넣지 않음** | health↔capacity scope 분리의 근거 |
| D3 | Azure 경계 사례는 **(a)** — region마다 별도 deployment | residency가 deployment에서 결정 가능 |
| D4 | `ProviderEndpoint`를 **독립 infrastructure identity로 신설** | 4계층 모델 |

D1이 승인하지 **않는** 것은 §10에 따로 적습니다.

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
           ├── servingContractDigest    ← §6
           └── capabilities
                    │
                    ▼
        ProviderEndpoint          ← 인프라 identity
           ├── provider          (azure_openai, vertex_ai, bedrock, deepinfra …)
           ├── region
           ├── endpointUrl
           ├── residencyClass    (확정값 | unknown — §4)
           ├── resourceId
           └── cloud/account metadata
                    │
                    ▼
        CredentialBinding         ← 접근 권한
           ├── credentialId
           ├── providerEndpointId
           ├── workspaceId       (BYOK일 때)
           ├── billingOwner      (tomverse | workspace)
           └── quotaScopeId      (→ QuotaScope, §8.2)
```

### 2.1 identity 경계를 정하는 규칙

> **두 행을 바꿔 끼웠을 때 답이 달라지거나 위법이 되면 위쪽 계층, 청구서만
> 달라지면 credential.**

credential은 무엇이 나오는지를 바꾸지 않습니다. 넣었다면 quality gate·version
pin·health 표본이 키 개수만큼 쪼개져 각각 판정 불가 수준으로 얇아졌을 것입니다.

### 2.2 예시

```
GPT-5.6
├─ ModelDeployment A → ProviderEndpoint(azure_openai, australiaeast, azure-resource-au)
│     upstreamDeploymentName = gpt56-prod
└─ ModelDeployment B → ProviderEndpoint(azure_openai, eastus, azure-resource-us)
      upstreamDeploymentName = gpt56-prod
```

하나의 Azure resource 안에 여러 Azure model deployment가 있을 수 있으므로
credential은 endpoint에 묶이고 Tomverse deployment마다 복제되지 않습니다.

### 2.3 명명

Azure 자신이 "deployment"라는 말을 쓰므로 **로그와 스키마에서 넷을 분리**합니다.

| 개념 | Prisma 모델 | 로그 필드 |
|---|---|---|
| Tomverse routing deployment | `ModelDeployment` | `tomverse_deployment_id` |
| Azure Resource / regional endpoint | `ProviderEndpoint` | `provider_endpoint_id` |
| 공급자가 부르는 이름 | — (컬럼) | `upstream_deployment_name` |
| 자격증명 | `CredentialBinding` | `credential_id` |

## 3. Hard invariant

> A **routing-eligible** deployment MUST fully identify its routable endpoint and
> data-region characteristics without resolving a credential. Credentials
> authorize access to a deployment/endpoint; they MUST NOT redefine its endpoint,
> region, residency, model version, or capability semantics.

따라서 요청 시점 순서가 고정됩니다.

```
Request → Workspace policy → Deployment/Endpoint region 검사 → eligible? → Credential 선택
```

credential을 먼저 고르고 "이 key가 어느 region이지?"를 역으로 알아내는 것은
금지입니다. 법적 판정이 secret resolution에 의존하면, 사후 감사에서 "이 요청이 어느
관할에서 처리됐는가"에 답하려면 그 시점의 binding 상태를 복원해야 합니다 — 복원
불가능한 것에 법적 판정을 얹는 구조가 됩니다.

**"routing-eligible"이 개정 2에서 추가된 한정입니다.** 1차 검토가 지적한 대로,
모든 deployment가 이 조건을 만족할 수는 없습니다(§4).

### 3.1 금지 필드

```
credential.endpointOverride
credential.regionOverride
credential.residencyOverride
```

만들지 않습니다. 강제 수단은 §11.

## 4. Broker / aggregator 경로 (blocker 1 대응)

OpenRouter는 단일 endpoint가 **여러 실제 공급자·quantization·지역으로 동적
라우팅**합니다. 그러면 `ProviderEndpoint`가 실행 위치도 serving stack도 식별하지
못하고, §3의 invariant가 그대로는 거짓이 됩니다. DeepInfra·Together의 불투명
serverless 경로, Anthropic Direct의 계약 기반 residency도 정도가 다를 뿐 같은
문제입니다.

`ProviderEndpoint`에 다음을 둡니다.

| 필드 | 의미 |
|---|---|
| `gatewayProvider` | 요청을 받는 쪽 (openrouter) |
| `servingProvider` | 실제로 모델을 서빙하는 쪽. 고정 불가면 `null` |
| `routingPolicyDigest` | broker에 건 pinning/fallback 설정의 digest |
| `destinationRegions` | 이 endpoint가 닿을 수 있는 region 집합 |
| `residencyClass` | 확정값, 또는 **`unknown`** |

판정 규칙 셋:

1. **`residencyClass = unknown`인 endpoint는 residency 제약이 걸린 요청의 후보가
   아닙니다.** 제약 없는 요청에는 후보로 남습니다 — 모르는 것은 나쁜 것이 아니고,
   배제는 제약이 있을 때만 필요합니다.
2. **broker route가 routing-eligible이 되려면** `servingProvider`가 고정되고
   broker fallback이 꺼져 있어야 합니다. 그 상태가 `routingPolicyDigest`로 기록되고,
   digest가 바뀌면 그 deployment는 재검증 대상입니다.
3. **모르면 `unknown`입니다.** 추정하지 않습니다. 잘못된 residency 판정으로 나간
   데이터는 회수되지 않으므로, 이 항목은 릴리스 차단 사유입니다.

Vertex·Bedrock은 project/account와 region·inference profile을 endpoint/deployment
메타데이터로 복제하면 이 모델에 맞습니다.

## 5. Scope 표

| 관심사 | scope |
|---|---|
| Availability health | **ModelDeployment**에서 관측, ProviderEndpoint·Provider로 **멱등 파생 집계** (§8.1) |
| Credential quota | ProviderEndpoint + Credential |
| Model-specific quota | ModelDeployment + Credential |
| Workspace budget | Workspace |
| Global provider outage | Provider / ProviderEndpoint |
| Quality gate 증거 | **quality equivalence class** (§6) |

## 6. Quality equivalence class

D3에 따라 region마다 deployment가 갈라지면, ADR §3.2의 quality gate가 deployment
속성이므로 같은 모델에 대해 **region 수만큼 eval을 통과시켜야** 합니다. 바이트가
같은데 비용만 곱해집니다.

ADR §3.3은 이미 "같은 equivalence group에서만 자동 fallback"이라고 쓰면서 그 group이
어디 사는 엔터티인지는 정의하지 않았습니다. 여기가 그 자리입니다.

### 6.1 class 키 (개정 2에서 강화)

개정 1의 4-field 키(`upstreamModelRef`, `version/revision`, `quantization`,
`tokenizerRevision`)는 **거부됐습니다.** 같은 revision·quantization·tokenizer라도
runtime build, precision/kernel, prompt adapter, safety policy, tool contract,
context/output 상한이 다르면 결과가 달라지고, broker 경로는 실제 serving provider
조차 빠집니다.

```
qualityEquivalenceKey = servingContractDigest
```

`servingContractDigest`는 **공급자가 증명한 immutable artifact 식별자**와 위
4-field, 그리고 tool/structured-output contract와 출력 상한을 함께 덮습니다.
**하나라도 미확인이면 그 deployment는 singleton class**입니다 — 혼자만의 class이고,
증거를 상속하지도 물려주지도 않습니다.

### 6.2 class 품질과 deployment 적합성은 다른 검사입니다

- **class quality evaluation** — 이 serving contract가 품질 기준을 통과하는가.
  비싸고, class당 1회.
- **deployment conformance** — 이 deployment가 정말 그 class인가. 싸고, deployment
  마다 주기적. 출력 형식·tool 호출·stop/truncation parity 같은 구조 검사이며 품질
  점수가 아닙니다.

둘을 한 상태값으로 합치지 않습니다.

### 6.3 만료 (Q3)

| 대상 | 필드 | 의미 |
|---|---|---|
| class | `qualityGateExpiresAt` | 이 serving contract의 품질 증거 수명 |
| deployment | `equivalenceAttestationExpiresAt` | 이 deployment가 그 class라는 주장의 수명 |

한 region이 drift하면 **class 전체를 stale로 만들지 않고 그 deployment의 class
membership을 해제**합니다. class expiry만 두면 drift한 deployment가 통과를 계속
상속하고, deployment 단위 품질 expiry만 두면 같은 증거가 지역별 clock에 따라 다른
상태가 되면서 eval 중복이 돌아옵니다.

## 7. 비용은 deployment가 아니라 실행 route의 속성입니다

ADR §6은 `estimated_effective_cost`를 deployment 단위로 계산합니다. BYOK에서는 같은
deployment가 credential에 따라 다른 비용을 갖습니다.

**개정 1의 "BYOK면 Tomverse 원가 0"은 거부됐습니다.** 현행 비용 신호는 payer가 아니라
**같은 작업에 대해 모델이 청구하는 가격**입니다 — `lib/routerCostSignal.ts`가 자기
주석에 "It ranks candidates by what they charge for the same work"라고 적습니다.
BYOK라는 이유로 provider charge를 0으로 만들면 그 비교가 무너지고, 자기 키를 넣은
workspace에게 가장 비싼 모델이 항상 최선으로 보입니다.

네 값을 분리합니다.

| 값 | 의미 | 쓰이는 곳 |
|---|---|---|
| `providerChargeEstimate` | 이 route가 공급자에게 청구될 금액 | **tie-break 비용 기준** |
| `tomverseMarginalCost` | Tomverse가 실제로 부담하는 금액 | provider budget, COGS |
| `workspaceExternalCost` | workspace가 자기 계정으로 부담하는 금액 | workspace 리포트 |
| `billingOwner` | 위 둘의 분배를 정하는 라벨 | 귀속 |

### 7.1 요청 시점 순서

```
1. workspace credential 정책 해소   → BYOK 계열인가 managed 계열인가
2. hard gate                        → eligible deployments (quality/version/capability/residency)
3. binding 가용성 필터              → 그 계열에 capacity 있는 binding을 가진 deployment만
4. deployment 점수                  → 비용은 providerChargeEstimate, health는 deployment
5. credential 선택                  → 같은 deployment 안에서 capacity 균형
```

**4와 5는 다른 종류의 결정입니다.** deployment 선택은 품질·비용·health 결정이고,
credential 선택은 순수 capacity 결정입니다. 한 점수 함수에 접으면 "키가 한가하다"가
"모델이 더 좋다"와 같은 단위로 더해집니다 — 충돌 1에서 거부한 형태입니다.

### 7.2 BYOK → managed fallback (Q4)

**묵시적 fallback은 금지합니다.** 별도 workspace opt-in과 사용자에게 보이는 payer
변경 고지가 있을 때만 허용합니다. 허용하면 실패 하나가 누가 청구받는지를 조용히
바꾸고, provider budget과 credit의 의미까지 함께 바꿉니다. fail-closed는 가용성을
낮추지만 원인과 payer가 명확합니다.

## 8. 기존 코드 영향

### 8.1 `ProviderHealthState`는 provider 단위이고, **그대로 둡니다** (blocker 2 대응)

`prisma/schema.prisma`: `provider String @id`.

**개정 1의 "PK를 deployment로 변경"은 거부됐습니다.** 과거 provider 행을 어느
deployment에도 정직하게 백필할 수 없고, 이 저장소는 추측 백필을 여러 곳에서 금지합니다.

- 기존 테이블과 그 세 증거 계열(실트래픽 / 합성 probe / 관리자 검증)은 **보존**합니다.
- deployment·endpoint projection은 **새 테이블**로 추가합니다.
- 원시 observation은 **한 번만** 기록하고, deployment·endpoint·provider rollup을 같은
  event id에서 **멱등 파생**합니다. 독립 관측기를 만들지 않습니다 — 같은 사건이 두
  증거 stream에서 다른 상태가 됩니다.
- endpoint rollup은 **materialized**입니다. 조회 시점 파생만으로는 한 endpoint의 여러
  deployment에 실패가 분산됐을 때 각 임계값 아래로 희석돼 늦습니다(Q2).

### 8.2 `QuotaScope`는 polymorphic 문자열이 아니라 registry입니다

개정 1의 `(quotaScopeType, quotaScopeId)` 문자열 쌍은 **거부됐습니다.**
`check:enum-constraints`는 닫힌 문자열 목록의 일치만 확인하므로, 잘못 인코딩된 합성
id·삭제된 credential id·서로 충돌하는 id를 막지 못합니다.

`QuotaScope` 테이블 하나를 두고, scope 종류별 **typed FK**와 "정확히 필요한 컬럼만
non-null" CHECK를 겁니다. capacity state는 그 행을 FK로 참조합니다. state 테이블을
다섯 개로 쪼개지는 않습니다.

```
type QuotaScope =
  | "credential" | "endpoint_credential" | "deployment_credential"
  | "workspace"  | "provider";
```

이 5값은 첫날부터 DB CHECK를 가집니다.

### 8.3 BYOK가 Tomverse provider 예산을 잠식할 수 있습니다 — 조건부

`lib/chatProviderHolds.ts:42`: `providerBucketKey = (provider: string)`.

1차 검토의 정정: hold는 `reservedCost > 0`일 때만 생성되므로(`lib/chatSecurity.ts`),
BYOK를 `billingOwner=workspace` · `tomverseMarginalCost = 0`으로 **올바르게 연결하면**
버킷을 소비하지 않습니다. 정확한 서술은 **"기존 경로에 양수 원가로 잘못 연결하면
잠식한다"** 입니다.

그래도 scope는 바꿔야 합니다(Q5): Tomverse hold는 `provider`가 아니라 안정적인
`providerBudgetAccountId`로 묶습니다. key rotation이 같은 scope를 유지해야 하므로
credential id를 쓸 수 없고, provider만 쓰면 managed와 BYOK가 섞입니다. workspace 자체
quota가 필요하면 `(workspaceId, quotaAccountId)`의 **별도 namespace**입니다 — 사용자
크레딧도, operational guardrail도, Tomverse provider 예산도 아닌 네 번째 것입니다.

### 8.4 후보 키 grain이 전부 `modelId`입니다

`regionBlockedModelIds`, `unhealthyModelIds`, `degradedModelIds`, 모든 score signal,
그리고 **최종 tie-break `model_id`** 가 모두 modelId 기준입니다. 같은 logical model의
deployment별 region 차단·health·비용을 표현할 수 없고, 최종 기준이 두 deployment에
같은 값을 주므로 전순서를 만들지 못합니다.

전부 `deploymentId`(또는 실행 route id) 기준으로 전환해야 하며, 이것이 C 구간의
선행 항목입니다.

### 8.5 후보 동결 범위는 **전부**입니다

개정 1은 "재구성 불가능한 이유로 탈락한 후보만" 동결하자고 했습니다. **거부됐습니다.**

후보는 정적 카탈로그가 아니라 **가변 런타임 DB 레지스트리**에서 옵니다
(`app/api/chat/route.ts` — `runtimeModels.filter(...)`). `lib/routingShadow.ts`의
"stable catalogue information a reader can reconstruct"라는 근거는 자기 전제에서
틀렸습니다. `enabled`·`catalogDeleted`·`minimumPlan`·context window·backend readiness가
전부 움직입니다.

따라서 **재구성 불가능한 모든 후보 판정**에 candidate/deployment id 또는 immutable
registry snapshot version을 기록합니다.

## 9. 갭 4·5 확정 결과 (1차 검토 정정 반영)

### 갭 4 — 429/quota와 가용성 장애 미분리: 실재. 단 범위가 좁고 값이 쌉니다

- `classifyProviderFailure()`는 `RATE_LIMIT` 범주와 `scope`를 **이미 산출**
  (`lib/providerErrorClassification.ts:307`)
- 라우팅이 그것을 읽는 유일한 지점 `lib/routingStreamFailure.ts:233`이
  `PAYMENT_REQUIRED` 하나만 꺼내 쓰고 나머지를 버림
- **정정**: `timeout`·`ECONNRESET`은 provider 분류 **이전에** abort-shaped로 잡혀
  `cancelled`/`stream`이 됩니다(`lib/routingStreamFailure.ts:104`). 코드 주석이
  "conservative members of the 'do not substitute' set"이라고 이유까지 적습니다.
  따라서 뒤섞이는 것은 **429와 5xx 계열**이지 전부가 아닙니다.
- `PROVIDER_SCOPED`가 `RATE_LIMIT`를 담아 429가 `consecutiveFailures`를 올림. 예외도
  별도 카운터도 없음
- **정정**: `Retry-After`를 읽는 곳은 이메일 포트 **와 OpenAI Costs API**
  (`lib/providerUsageSync.ts`)입니다. 채팅 추론 경로가 읽지 않는다는 결론은 유지됩니다.
- `deprioritize_until` 류 만료형 강등 없음. 라우팅 층의 token bucket·capacity
  admission 없음 — 발견된 429는 전부 사용자 대상 별개 층
- 가장 값싼 지점: `ProviderProbeResult.errorClassification`이 이미 `"RATE_LIMIT"`을
  담는데 `lib/routerRuntimeSignals.ts:107`이 `success: boolean`만 select 합니다

**4a**(분류 보존)는 A 구간, **4b**(capacity state·token bucket·`Retry-After`)는 §2의
identity 위에서만 가능합니다. capacity state를 먼저 만들지 않습니다.

### 갭 5 — `malformed_output` 등가물: 실재

DB CHECK가 구조적으로 막습니다 — `succeeded`인 attempt는 `failureLayer = 'none'`이
강제되므로 "성공했는데 본문이 못 쓸 것"을 적을 수 없습니다.

원칙 자체는 라우팅 **밖에서** 이미 구현돼 있습니다: `AI_EMPTY_RESPONSE` →
`MODEL_TRANSIENT` → `scope: "model"`이고 `PROVIDER_SCOPED`가 이를 의도적으로 제외해
`ProviderHealthState`를 더럽히지 않습니다. 덮지 못하는 것은 잘림(`length`)·
content_filter+본문·파싱 실패입니다. 잘림 분류는 **`packages/chat-core`가 이미
계산**하는데 라우팅이 읽지 않습니다.

**정정**: 개정 1은 빈 응답이 Router 점수를 "사고로 깎는다"고 적었습니다. 틀렸습니다 —
빈 답은 사용자가 답을 받지 못한 것이므로 실패로 세는 것이 정책에 맞습니다. 결함은
`failed_post_token`·`stream`이라는 **이름**뿐이었고, 이름은 A-2에서 고쳤습니다.

## 10. D1이 승인하지 않는 것

### 충돌 4 — 실행 예산 (유지, Q6 보완)

기존: dispatched attempt 최대 2회, Context Builder 2회, reroute 1회, pass-through 1회.
ADR: `max_attempts` 기본 3.

**2회를 유지합니다.** 독립 실패 확률 10%라면 1→2회가 90%→99%, 3회가 99.9%입니다.
첫 fallback이 이득의 대부분을 가져가고, 세 번째 호출은 최악 비용·tail latency·
manifest/context 예산을 모두 늘립니다.

**보완**: fallback은 primary와 **다른 `ProviderEndpoint`** 를 요구하고, 가능하면 다른
provider를 요구합니다. 같은 장애 영역만 남았다면 세 번째 후보 대신 **종료**합니다.
`build_budget_exhausted` 실측이 유의미해지면 3회를 별도 정책으로 검토합니다.

### 충돌 5 — 두 번째 원장 (해소)

`routing_attempts.actual_cost`는 만들지 않습니다. `ChatAttemptUsage`가 이미 attempt
단위 원가를 같은 트랜잭션에 기록하므로 조회로 충족됩니다.

### 충돌 1·2 — 목적함수와 콜드스타트 (어휘순 유지)

1차 검토 권고: **어휘순 유지.** 후보 수 증가는 서로 다른 단위를 더할 근거가 아니며,
0.35/0.25/0.40은 교환비가 측정됐다는 거짓 정밀도를 만듭니다. 먼저 깨지는 것은 가중합
부재가 아니라 **부분 관측 comparator의 비추이성과 `modelId` tie-break grain**이었고,
전자는 고쳤으며(§13) 후자는 §8.4입니다.

콜드스타트도 현행 **기권**이 우선입니다. `prior_failure_risk=0.005, k=200`은 새
deployment에 근거 없는 99.5% 신뢰도를 부여합니다. 표본 부족은 제한된
probe/shadow/canary exploration으로 해결합니다.

### 충돌 3 — "shadow"의 의미

`RoutingRun.mode`는 "라우터 추천 vs 사용자 선택"에 쓰이고
`app/api/admin/routing-shadow/route.ts`와 `lib/routingShadowReport.ts`가 그 분모를
씁니다. ADR Phase 2A의 `allocation_mode`는 **새 컬럼**입니다.

## 11. invariant 강제는 네 층입니다

정적 검사 하나로는 부족합니다 — 금지 필드의 존재는 잡아도 DB 행의 region/residency
완전성, broker pinning, 런타임 binding 변경은 증명하지 못합니다.

1. **DB CHECK / FK** — residency·quota scope·class membership의 구조적 불변조건
2. **공통 writer validation** — 모든 생성 경로가 지나는 한 함수
3. **attempt의 immutable identity snapshot** — 그 요청이 실제로 무엇을 썼는지
4. **정적 검사** — 금지 필드, 금지 import

과거 행은 추측 백필하지 않고 legacy/null로 남깁니다.

## 12. 개정 1에서 바뀐 것

| 항목 | 개정 1 | 개정 2 |
|---|---|---|
| 계층 | 4계층 | 유지. broker 필드 4종 추가(§4) |
| invariant 적용 범위 | 모든 deployment | **routing-eligible deployment** |
| quality class 키 | 4-field | **`servingContractDigest`**, 미확인은 singleton |
| gate expiry | class 단위 | class + **deployment attestation** 2종 |
| endpoint health | 조회 시점 파생 | **materialized 멱등 파생** |
| `ProviderHealthState` | PK를 deployment로 변경 | **보존 + 새 projection 테이블** |
| quota scope | polymorphic 문자열 | **typed FK registry** |
| BYOK 비용 | Tomverse 원가 0 | **4값 분리**, provider charge는 0이 아님 |
| 갭 2 동결 범위 | 재구성 불가한 것만 | **전부** |
| 갭 4 서술 | timeout·ECONNRESET 포함 | **429·5xx 계열로 한정** |
| 갭 5 서술 | 점수를 사고로 깎음 | **이름만 결함** |
| 실행 예산 | 2회 유지 | 유지 + **다른 endpoint 요구** |

## 13. 작업 상태

| # | 항목 | 상태 |
|---|---|---|
| A-1 | comparator 전순서 수정 | **구현·검증 완료** (`8d3e0178e`) |
| A-2 | 빈 200 오분류 | **구현·검증 완료** (`dcd1184c2`) |
| A-3 | `model_output` layer + `errorClass` CHECK | 미착수 (`contract`, migration) |
| A-4 | `RATE_LIMIT` 분류 보존 | 미착수 (`contract`) |
| A-5 | 원자적 config manifest | 미착수 (`contract`) |
| B-1 | 설계 2차 개정 | **이 문서** |
| B-2 | 2차 독립 검토 | 대기 |
| C | deployment identity 구현 6건 | B-2 통과 후 |
| D | allocation_mode + rollout 2건 | |
| E | `packages/router-core` 추출 | |

## 14. 2차 검토에 올리는 열린 질문

- **R1** — §4의 broker 규칙 셋으로 OpenRouter를 안전하게 다룰 수 있는가? 특히
  `routingPolicyDigest`가 바뀌었음을 우리가 **실제로 관측할 수 있는가**?
- **R2** — §6.1의 `servingContractDigest`를 공급자가 증명해 주지 않는 pool이 대부분이면,
  거의 모든 deployment가 singleton class가 되어 §6의 비용 절감이 사라지는 것 아닌가?
- **R3** — §8.1의 "보존 + 새 projection"에서, 기존 provider health와 새 deployment
  health가 **동시에 라우팅 판정에 쓰이는 기간**의 규칙은 무엇인가?
- **R4** — §7의 `providerChargeEstimate`를 tie-break에 쓰면, BYOK workspace는 자기가
  내지도 않는 금액으로 순위가 정해집니다. 의도한 것인가?
- **R5** — §8.4의 grain 전환은 `ROUTER_SCORE_SNAPSHOT`의 모든 항목을 deployment 단위로
  다시 쓰는 일입니다. 전환 기간에 두 grain이 공존하는가, 한 번에 자르는가?
- **R6** — §10의 "다른 endpoint 요구"가 후보가 하나뿐인 logical model에서 fallback을
  완전히 없애는데, 그것이 의도인가?

## 15. 검토 이력

- ADR v2.1: C1–C15 → N1–N11 → R1–R6. **세 번 모두 그린필드 전제.**
- 갭 분석: 독립 검토 없음.
- 이 문서 개정 1: Cursor 독립 검토 → **`reject`**. blocker 2, major 6, 사실 오류 5.
- 이 문서 개정 2: 2차 독립 검토 대기.
