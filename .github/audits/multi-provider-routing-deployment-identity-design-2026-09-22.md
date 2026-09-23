# 멀티 공급자 라우팅 — deployment identity 설계 (v2.1 ADR 개정안)

- 작성일: 2026-09-22
- **개정 6** (2026-09-23). 개정 1–5 모두 독립 검토에서 `reject`. 이 판은 5차 검토의
  major 4건과 사실 오류 2건을 반영합니다. 변경 요약은 §13, 5차 결과는 §15.3.
- 상태: **제안. 소유자 결정 3건 대기** — 더 이상 검토로 진전되지 않습니다(§15.3).
- 선행 문서
  - [`.github/audits/multi-provider-routing-adr-gap-analysis-2026-09-22.md`](./multi-provider-routing-adr-gap-analysis-2026-09-22.md)
  - [`docs/policy/tomverse-multi-provider-routing-v2.1.md`](../../docs/policy/tomverse-multi-provider-routing-v2.1.md) (ADR, 미채택)
  - [`docs/policy/tomverse-chat-routing.md`](../../docs/policy/tomverse-chat-routing.md) (현행)
  - [`docs/policy/tomverse-chat-router-score-policy.md`](../../docs/policy/tomverse-chat-router-score-policy.md) (현행)

## 0. 경위

갭 분석이 남긴 0단계 질문 — "하나의 논리 모델을 여러 공급자에 동시에 배치할
것인가?" — 에 소유자가 **전면 도입**으로 답했고, 이어서 identity 형태에 대한 결정이
내려졌습니다. 이 문서는 그 결정과, 결정에 딸려 나오는 기존 코드 영향을 기록합니다.

**이 문서의 사실 주장은 다섯 차례 독립 검토에서 각각 5·5·2·2·2건 정정됐습니다.** 그 이력은
§9와 §13에 남깁니다 — 무엇이 틀렸는지가 무엇이 맞는지만큼 중요합니다.

## 1. 소유자 결정

| ID | 결정 | 효과 |
|---|---|---|
| D1 | multi-deployment **전면 도입** | 갭 1·6·7, 갭 4b가 범위 안 |
| D2 | credential은 deployment identity에 **넣지 않음** | health↔capacity scope 분리의 근거 |
| D3 | Azure 경계 사례는 **(a)** — region마다 별도 deployment | residency가 deployment에서 결정 가능 |
| D4 | `ProviderEndpoint`를 **독립 infrastructure identity로 신설** | 4계층 모델 |
| D5 | **destination을 댈 수 없으면 안 됩니다.** 그리고 Privacy 페이지에 **공급자별 개인정보 이동 고지**가 필요합니다 | §4.2 확정 + 새 산출물 §4.6 |
| D6 | BYOK 소유권은 **account**입니다 | `Workspace` 모델을 만들지 않습니다. §8.2·§8.3의 FK 대상이 `User` |
| D7 | 공급자 계약 조사는 **소유자가 진행 중** | T1의 답을 기다립니다. 그 전까지 모든 endpoint는 `unproven` |

D1이 승인하지 **않는** 것은 §11에 따로 적습니다.

### 1.1 D5가 만드는 산출물

D5는 §4.2를 확정하는 데 그치지 않고 **새 작업 항목**을 만듭니다. 현재 Privacy
페이지는 이렇게 적고 있습니다(`locales/*.ts`의 `providers`):

> "Providers may process or retain data under their own terms and privacy
> policies, **potentially in a different country**."

이것이 정확히 D5가 배제한 형태입니다 — destination을 대지 못하는 문장입니다.
`docs/policy/voice-input.md`가 voice input에 대해 이미 반대로 결정했고, Privacy
페이지는 그 결정을 PIPA 28-8(2)의 8개 항목 목록으로 렌더링하고 있습니다. 같은
기준이 AI 공급자 전송에도 적용돼야 합니다.

**목록은 하나여야 합니다.** 공급자별 고지와 §4의 residency 게이트는 **같은 사실**을
읽습니다 — 누가 받고, 어느 region으로 가고, 무슨 근거로 그렇게 말하는가.
두 목록을 만들면 고지와 게이트가 서로 다른 말을 하게 되고, 그때 사용자에게 보이는
쪽이 틀리면 그건 회수되지 않습니다.

### 1.2 D6이 닫는 것

`Workspace` 모델은 만들지 않습니다. 따라서:

- `CredentialBinding.workspaceId` → **`accountId`**(= `User`)
- `QuotaScope`의 `workspace` scope → **account scope**, FK 대상 `User`
- `byok-spend-*` namespace의 한도 주체 → **account admin** (T2의 답)

Provider registry는 여전히 필요합니다(§8.2의 `provider` scope FK 대상).

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

### 4.5 고지와 게이트는 한 목록을 읽습니다 (D5)

`lib/providerDataDestinations.ts` — 공급자별로 **누가 받고 어디로 가는가**를 적는
단일 registry입니다. 두 소비자가 있습니다.

| 소비자 | 무엇에 쓰는가 |
|---|---|
| Privacy 페이지의 공급자별 고지 | 사용자에게 보이는 문장 |
| §4.1의 routing-eligible 판정 | dispatch 전 게이트 |

한 행이 담는 것:

| 필드 | 의미 |
|---|---|
| `provider` | `AiProvider` |
| `recipientEntity` · `recipientCountryCodes` | 데이터를 받는 법인과 그 법인의 국가 |
| `customerContentStorage` · `processing` | 저장 지리와 처리 지리. 각각 `mode`(6값) · `countryCodes` · `macroRegions` · 근거 |
| `destinationRegions` | **저장 지리의 호환 alias**. 저장 필드와 다르면 거절됩니다 |
| `trainsOnCustomerContent` | 학습 여부. `null`은 미확인이지 "아니오"가 아닙니다 |
| `retention` | 내용·안전로그·캐시·기능 상태·system metadata 다섯 가지를 따로 |
| `zeroDataRetention` | 약관상 ZDR. strict route의 조건이며 고지 가능 여부의 조건은 아닙니다 |
| `independentCommercialUseProhibited` | 제3자의 독자적 상업 이용 제한. 학습 금지와 별개 질문 |
| `evidenceRef` | 그렇게 말할 수 있는 근거 (계약·DPA·공식 문서) |
| `status` | **`proven` \| `unproven`** |

처음 판에서는 `destinationRegions`를 "처리되는 region"이라고 적었습니다. 저장과
처리는 다른 답이고, 저장 위치로 처리 위치를 채우면 고지가 되돌릴 수 없는 방향으로
틀립니다. 2026-09-23에 두 지리를 나눴고, 어휘(`mode`의 여섯 값, 보관 다섯 항목,
`null`은 0이 아님)는 외부 공급자 개인정보 검토 인수본 v2.0의 schema를 그대로
씁니다. 그 인수본의 공급자별 V1 참고값은 재검증되지 않은 주장과 내부 권고를 담고
있어 이 공개 저장소에 옮기지 않았습니다. 이 목록의 행은 전부 `status: unproven`
이고, 각 사실은 `UNKNOWN` 또는 `null`에서 시작합니다.

다른 서비스(OpenRouter·Duck.ai·Poe)가 공개한 공급자 정책은 **그 서비스의 계약**을
설명합니다. 같은 endpoint를 불러도 그 조건을 승계하지 않으므로 `evidenceRef`가 될
수 없고, 이 공급자가 그런 조건을 제공하기는 한다는 단서로만 쓸 수 있습니다.

`ProviderEndpoint.destinationRegions` 컬럼(dark)은 **다른 필드**입니다. schema
주석은 "이 endpoint가 닿는 region"이고, 이 목록의 저장 alias와 같은 뜻이라고 읽으면
안 됩니다. 그 컬럼을 저장·처리로 나눌지는 migration이 필요한 별도 결정이며, 그때까지
아무 코드도 그 컬럼을 eligibility에 읽지 않습니다(`lib/routingIdentityManifest.ts`).

규칙 넷:

1. **`unproven`은 사용자에게 렌더링하지 않습니다.** 현재 문장이 모호하다는 이유로
   "destination 미확정"이라고 적힌 표를 내보내는 것은 더 나은 고지가 아닙니다.
   페이지는 D7의 조사 결과가 들어온 뒤에 바뀝니다.
2. **`unproven`은 제약 트래픽의 후보가 아닙니다**(§4.1 규칙 1).
3. **추정 금지.** `evidenceRef` 없이 `proven`이 될 수 없습니다.
4. **지금은 gate가 아니라 보고입니다.** 활성 공급자 전부가 `unproven`인 상태에서
   gate로 만들면 PR Fast Gate가 즉시 깨집니다. `report:model-credit-weights`와
   같은 위치 — 차이를 나열하되 막지 않습니다. D7이 채워지면 gate로 승격합니다.

이 registry가 §4.4의 `EndpointResidencyApproval`이 나중에 참조할 **사실의 출처**
이기도 합니다. 승인은 "이 사실을 근거로 이 endpoint를 허용한다"는 행위이고, 사실
자체는 여기 있습니다.

### 4.6 S1의 답: 검증된 공급자 없음

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

#### C-4·C-5 이후의 상태 (2026-09-23, 독립 검토에서 확인)

`QuotaCapacityState`와 `AvailabilityObservation`이 dark로 들어갔습니다. 두 커밋의
독립 검토가 물은 것은 **그래서 cutover에 얼마나 가까워졌는가**였습니다. 표로
적습니다 --- 테이블이 늘어난 것을 진척으로 읽는 것이 이 절이 막으려는
오독입니다.

검토는 다섯 모두 미충족이라 했고, **3번은 그렇지 않습니다.** 확인한 사실은
아래와 같습니다.

| 선행조건 | 상태 | 무엇이 남았나 |
|---|---|---|
| 1. probe·attempt에 nullable endpoint·deployment 컬럼 | **충족** (2026-09-23, `13af0bcfe`) | 두 테이블에 컬럼이 들어갔고 `AvailabilityObservation`이 가졌어야 할 FK 둘도 함께 들어갔습니다. 여전히 **아무것도 쓰지 않습니다** — 스키마 틈이 닫힌 것이고, 표본이 생긴 것이 아닙니다. |
| 2. deployment별 synthetic canary | 미충족 | `lib/providerProbe.ts`는 여전히 provider당 대표 모델 하나입니다. |
| 3. 분류 결과의 settlement 보존 | **코드상 충족, 4번에 가려짐** | `app/api/chat/route.ts`가 모든 종료 경로를 `completeInstrumentedDispatch()` 하나로 모으고, 거기에 `routingOutcomeForSettlement()`·`routingFailureLayerForSettlement()`의 결과를 넘깁니다. 다만 instrumentation mode가 `off`면 `beginInstrumentedDispatch()`가 `null`을 돌려주므로 **행이 하나도 생기지 않습니다.** 배선은 끝났고 표본이 없는 것입니다. |
| 4. 계측 활성화 후 최소 한 관측 window | 미충족 | 계측이 꺼져 있고, 켠 뒤에 세는 것이므로 시간이 조건입니다. |
| 5. 표본 없음 = `unproven` = routing-ineligible | 미충족 | `AVAILABILITY_ROLLUP_GRAINS`가 grain을 이름 대지만 rollup 테이블이 없고, 후보 필터는 그대로 `readProbeHealth`를 읽습니다. |

위 설계 2번의 "멱등 적용"도 아직 아닙니다. `AvailabilityObservation.eventId`의
unique index가 막는 것은 **같은 관측이 두 번 INSERT되는 것** 하나이고, rollup이
어떤 event를 이미 반영했는지 기록하는 테이블이 없으므로 **projection 재실행은
오늘 안전하지 않습니다**. `shouldApply()`는 그 규칙을 projection보다 먼저 적어
둔 것이지 projection이 아닙니다. grain별 적용 기록은 별도 작업이며, 그것 없이
2번을 충족했다고 적으면 3번 atomic cutover의 근거가 사라집니다.

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

**정정(개정 6)**: category는 이제 소실되지 않습니다. A-4a가 열 개 전부를
`errorClass`로 보존합니다. 지금도 소실되는 것은 **`scope`와 HTTP status** 둘이며,
그것이 §11 표를 아직 구현할 수 없는 이유입니다.

그리고 A-6이 **관측과 판정을 분리**했습니다. `outcome`은 "대체해도 되는가"에 답하는
보수적 판정이고, `observedOutcome`은 실제로 일어난 일입니다. 한 값이 둘을 겸하던
동안 기록은 **양쪽으로** 틀렸습니다 — 연결 손실이 `cancelled`로 기록돼 성공률
분모에서 빠지거나, generic 매핑이 진짜 사용자 취소를 `failed_post_token`으로 적어
모델 탓으로 셌습니다.

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

## 14.1 이 모듈이 어디에 있어야 하는가 (2026-09-23)

운영자 질문: **Tomverse Chat에서도 재활용할 수 있도록 repo 위치를 정할 것.**

답은 "라우터를 옮긴다"가 아닙니다. 다른 client가 실제로 필요로 하는 것은
라우터보다 작고, 그 경계는 **제품 결정이 있느냐 없느냐**입니다.

| 무엇 | 어디 | 이유 |
|---|---|---|
| 순위 정련 구성 — 분할 정련, group-scoped 기권, anchored epsilon, partitioner가 멤버를 잃지 않았는지 검사 | **언젠가** `packages/router-core`. 지금은 `lib/routerSelection.ts` | 이 제품에 관한 것이 하나도 없으므로 옮길 자리는 맞습니다. 옮기는 **시점**은 §14.1a입니다 — 두 번째 client가 생긴 뒤입니다. |
| 어떤 기준이 있고, 각각 무엇을 읽고, epsilon이 얼마인가 | `lib/routerScorePolicy.ts` | 제품 결정입니다. package가 import하는 순간 그것은 `packages/`에 사는 Tomverse Chat package이고, 다음 client는 자기가 내리지 않은 결정을 물려받습니다. |
| 카탈로그 enrolment(`ROUTER_SCORE_SNAPSHOT`), `AiProvider` | `lib/routerScorePolicy.ts` | 제품 데이터입니다. |
| deployment identity, quota scope, capacity, availability, cache affinity, allocation 축 | 앱 DB + `lib/` | 전부 Tomverse의 운영 사실이며 스키마를 가집니다. package는 스키마를 갖지 않습니다. |
| tie 안 배분(`allocateWithinTie`) | `lib/routingAllocation.ts` | 지금은 앱입니다. 순위와 seed만 받으므로 옮길 수 있지만, 옮길 근거는 두 번째 client가 생길 때 생깁니다. |

`4b0fefb02`이 첫 줄을 실행했다가 `481789520`이 되돌렸습니다. 옮길 때
re-export shim은 두지 않았습니다 — `docs/policy/shared-packages.md` §7이
금지하며, shim이 있으면 옛 import 경로가 계속 동작해 경계를 강제하는 것이
아무것도 없게 됩니다. 되돌릴 때도 같은 이유로 `lib/routerSelection.ts`가 구성을
다시 inline으로 갖습니다.

**PACKAGE-01의 승인은 그 package를 덮지 않습니다.** 그 승인이 덮는 범위는
2026-08-12 한 commit에서 package 둘이 framework-neutral했다는 것까지이고
(AGENTS.md), 세 번째는 새 사실입니다. 지금은 package가 둘이므로 그 승인이
현재 트리를 그대로 덮고, 재승인은 §14.1a의 시점까지 미룹니다.

### 14.1a 그래서 지금은 옮기지 않습니다 (2026-09-23, 독립 검토 후)

위 표의 첫 줄 — 순위 정련 구성을 `packages/router-core`로 — 는 한 번
실행했다가 되돌렸습니다. 두 번입니다. 한 번은 PR #1615에서 CI가 막아서,
한 번은 그 뒤 독립 검토(Grok 4.7 xHigh)가 **(b) 두 번째 client가 생길 때까지
`lib/routerSelection.ts`에 두라**고 권고해서.

#### 막는 것은 package가 아니라 workspace 열거입니다

Prompt Refiner의 runtime source closure는 **모든 workspace `package.json`**을
담습니다. refiner가 그 package를 import 하는지와 무관합니다 —
`apps/mobile/package.json`이 그 증거로, 아무도 import 하지 않는데 목록에
있습니다. 규칙이 "closure가 import하는 package"가 아니라 "모든 workspace"인
이유는 **`@tomverse/*` 이름이 늘어나면 resolver가 받아들이는 집합이 바뀌기**
때문입니다.

그래서 `packages/router-core`의 **소스는** closure에 들어가지 않습니다.
들어가는 것은 `package.json` 하나뿐이고, 그것으로 충분히 계약이 움직입니다.

#### 옮겼을 때 치르는 것

188이라는 수가 묶인 곳은 처음 센 네 곳이 아니라 **열 곳 이상**입니다.

| 어디 | 무엇 |
|---|---|
| `lib/promptRefinerStageAdmissionCore.ts` | 상수와 순서 있는 경로 배열 |
| `prisma/schema.prisma` | 주석 |
| `20260918130000` migration | `expected_paths` 187개 — **적용됨** |
| `20260921100000` migration | v3 wrapper, 그리고 stage 행의 exact JSON — **적용됨** |
| `docs/ops/prompt-refiner-durable-stage-writer-contract.md` | 파일 수, 경로 수, 178개 분할, "나머지 10개" |
| `docs/ops/prompt-refiner-durable-stage-writer-task.md` | |
| `docs/ops/tomverse-chat-progress.md` | |
| `docs/policy/prompt-refiner-durable-stage-writer-threat-model.md` | |
| `docs/ops/prompt-refiner-confirmatory-shadow-v4.md` | 총수와 "188개 중 178개" |
| `docs/policy/prompt-refiner-observability.md` | |

"나머지 10개"라는 문장은 어느 테스트도 잡지 않습니다. 세대를 올리면 12로
같이 고쳐야 하고, 잊으면 아무도 말해 주지 않습니다.

#### `fileCount: 188`은 역사 기록이 아닙니다

이것이 제가 틀렸던 부분이고, 검토가 정정했습니다.

`20260921100000`의 첫 줄이 "완료된 stage를 변경하지 않는다"고 적기에 그 행의
`fileCount`를 승인 당시의 기록으로 읽었습니다. **아닙니다.** admission이
TypeScript 상수를 그대로 execution manifest에 넣고, 저장된 행과 현재
checkout의 manifest가 다르면 reserve/consume이 **실패합니다**. 테스트가 SQL의
`fileCount`를 상수에 묶는 것은 과한 단언이 아니라 그 잠금입니다.

그 행의 `executionManifest` UPDATE는 trigger가 거절합니다. 그러므로 수를
올리는 방법은 그 행을 고치는 것이 아니라 **새 stage id**에 새 JSON을 두는
것입니다.

#### closure 스캔을 좁히는 우회는 쓰지 않습니다

workspace 열거를 "import 되는 package만"으로 바꾸거나, package를 workspace
밖에 두는 것 — 둘 다 같은 구멍을 다른 경로로 엽니다. `package.json`을 digest
밖에 두면 **import가 생기기 전까지 digest가 그대로**이고, 그 사이 resolver가
받아들이는 집합은 이미 달라져 있습니다.

#### 두 번째 client가 생기면, 이 순서로

한 변경 안에서 합니다.

1. 중간 상태를 만들지 않습니다. 상수만 올리고 SQL이 188인 트리에서는 검사를
   돌리지 않습니다 — 그 수는 아무것도 통과하지 못합니다.
2. **적용된 두 migration은 수정하지 않습니다.** 새 migration이 v4처럼 wrapper를
   더하고, v1의 187과 v2의 188 분기는 남깁니다. 새 수는 **새 stage id**의
   exact JSON에 둡니다.
3. `fixedNonImportPaths`와 `PROMPT_REFINER_RUNTIME_SOURCE_PATHS`에 새 migration
   경로와 `packages/router-core/package.json`을 넣습니다. 상수는 **190**입니다
   — package.json 하나와 migration 자신 하나. `packages/router-core/src/**`는
   import closure에 넣지 않습니다.
4. closure 테스트는 **새 migration 파일명을 직접** 가리키게 고칩니다. "최신
   migration"을 찾는 방식으로 바꾸지 않습니다 — 그러면 관계없는 다음
   migration이 권위가 됩니다. 경로 하드코딩은 봉인이지 실수가 아닙니다.
5. 위 표의 문서 전부와 "나머지 10개" 문장을 190과 metadata 12에 맞춥니다.
6. `docs/policy/shared-packages.md`에 **이미 공유된 코드가 아닌데 seed했다는
   예외**를 그 변경 안에 적습니다. §7은 이미 공유 중인 코드만 seed하라고
   합니다.

#### 지금 얻는 것과 잃는 것

얻을 것은 caller가 하나뿐인 코드에 대한 ESLint·tsconfig 경계입니다. 치를 것은
봉인된 stage 세대 하나, 새 migration, 그리고 위 표 전부입니다.

**그 교환은 지금 성립하지 않습니다.** `docs/policy/shared-packages.md` §7이
"이미 공유되는 코드를 옮겨서 seed 하라"고 적는 이유가 이것입니다.

## 14.2 남은 것은 소유자 결정입니다 (2026-09-23, A-5 이후 갱신)

§14의 권장 순서 중 저장소가 스스로 끝낼 수 있는 항목은 A-5까지입니다.

| 순서 | 항목 | 상태 |
|---|---|---|
| 1 | T1·T2와 workspace/account 소유권 | **소유자.** account로 결정됨(2026-09-23) |
| 2 | canonical failure classification과 scope identity | **완료** (A-2·A-3a·A-3b·A-4a, §10) |
| 3 | residency approval과 recipient/destination 계약을 C schema에 | **완료** (`EndpointResidencyApproval`, `lib/providerDataDestinations.ts`) |
| 4 | A-3b CHECK를 운영값 조사 후 `VALIDATE` | **소유자.** production 조사가 선행 |
| 5 | C를 dark로 배포하고 즉시 A-5 manifest | **코드 완료, 배포 0%.** dark table 12개·dark column 6개, migration이 어느 환경에도 적용되지 않음. A-5는 2라운드 검토를 거쳤습니다 — 1라운드가 reject였고, digest가 덮는 field 목록이 `model_deployment_gate_follows_identity()`보다 좁았던 것과 digest만으로는 재구성이 안 된다는 것 둘입니다. 후자가 `RoutingIdentityManifestEntry`를 만든 이유입니다 |
| 6 | residency-safe canary lane과 observation journal | observation은 완료(`AvailabilityObservation`), canary lane은 §8.1 선행조건 2 |
| 7 | BYOK 비용·funded allowance·bucket key를 versioned dual-read/write | 미착수. A-5 배포가 선행 |
| 8 | candidate verdict와 routing-snapshot ceiling | verdict 완료(`RoutingCandidateVerdict`), ceiling 미착수 |
| 9 | sticky·score snapshot grain 전환, 그 뒤 shadow 검증 | 미착수 |
| 10 | decision grain을 `deploymentId`로 원자 전환 | §8.1 선행조건 5개가 선행 |
| 11 | scope·capacity 준비 후 2-attempt fallback 활성화 | 미착수 |
| 12 | provider attestation 입증 시 equivalence class 재검토 | 미착수 |

막고 있는 것은 넷이고 전부 사람의 행위입니다.

| 남은 것 | 막는 것 | 누가 |
|---|---|---|
| exploration 켜기 (D-3) | `allocateWithinTie`는 tie 안에서만 배분하므로 품질/비용 trade는 필요 없지만, **어느 모델이 답하는지가 바뀝니다.** 켜는 것은 제품 결정입니다. | 소유자 |
| PACKAGE-01 재승인 | 세 번째 package가 새 사실입니다. `npm run check:shared-packages`가 셋 모두에 통과하는 것이 기계적 절반입니다. | 소유자 |
| Privacy 페이지 공급자별 데이터 이동 고지 (F-2) | 공급자 계약 조사 결과. `lib/providerDataDestinations.ts`의 12개 공급자가 전부 `unproven`이고, `providerDestinationIsEstablished()`가 fail-closed입니다. | 소유자 (조사 중) |
| §8.1 cutover 선행조건 2·4·5 | 1번(probe·attempt의 grain 컬럼)은 `13af0bcfe`에서 완료. 2번은 deployment별 canary이고 A-5 배포 이후에 착수 가능합니다. 4번은 계측을 켠 뒤의 시간 조건이고, 5번은 그 표본 위의 규칙입니다. | 혼합 |

### 이 라운드에서 registry가 잡은 것 (2026-09-23)

전체 유닛 스위트를 돌려 이 작업이 만든 실패 다섯을 찾았고, 셋은 게이트가
제대로 작동한 것이었습니다. 그중 하나는 privacy입니다.

`CredentialBinding`과 `QuotaScope`는 `User`에 cascade로 닿는데
data-domain registry에 없었습니다. **dark라는 것은 면제 사유가 아닙니다** —
등록되지 않은 채 행이 도착하면 그 행은 아무도 등급을 매기지 않은 것이고,
첫 행은 누군가 config writer를 켜는 날 도착합니다.

`RoutingCandidateVerdict`와 `DeploymentCacheAffinity`도 사람에게 닿지만
체커가 보지 못했습니다 — 체커는 `User` 관계나 `*userId` 컬럼을 봅니다. 손으로
등록하는 것은 불가능합니다(체커가 대칭이라, 스키마가 뒷받침하지 않는 등록을
거절합니다). 저장소는 이미 답을 갖고 있고 `RoutingAttempt`·`ContextManifest`
옆에 적어 두었습니다 — 자기 `userId`를 비정규화해 그 자체로 data domain이
되는 것. 두 테이블도 같게 했습니다.

**체커를 Conversation까지 따라가도록 넓히는 것은 이 변경이 할 일이 아닙니다.**
스키마의 모든 conversation-linked 테이블에 대한 질문이고, 체커의 주석이 그
규칙을 얼마나 조심스럽게 넓혀 왔는지 기록하고 있습니다. 그 틈은 누군가 볼
가치가 있습니다.

## 14.3 ADR 원문 재대조: 이 순서에 빠져 있던 것 (2026-09-23)

§14의 12단계는 갭 분석의 권장 순서를 옮긴 것이고, **ADR v2.1 원문
(커밋 `2621e051b`, `docs/policy/tomverse-multi-provider-routing-v2.1.md`)의 전 범위는
아닙니다.** 원문을 다시 읽고 대조한 결과를 적습니다. 원문과 갭 분석은 그 커밋이 있는
브랜치에만 있고 develop에는 들어오지 않았습니다. ADR의 상태도 여전히 "제안"입니다.

### Provider Pool (원문 §1, §14)

| 모델 계열 | Pool |
|---|---|
| OpenAI 호환 / Open-weight | 벤더 Direct, **DeepInfra**, **Sail Research**, **Together**, **OpenRouter** |
| Claude | Anthropic Direct, **DeepInfra**, **Google Vertex AI** |
| Gemini | Google Gemini API, **Google Vertex AI**, **DeepInfra** |
| OpenAI | OpenAI Direct, **Azure OpenAI** |

역할: DeepInfra는 범용 저비용 후보, Sail Research는 background·유연한 작업,
Together는 독립 fallback, OpenRouter는 **최종 emergency fallback이며 이전 attempt에서
실패한 공급자를 제외해야 합니다.**

이 여섯 호스트를 onboarding하는 단계가 §14에 없었습니다. D1("multi-deployment 전면
도입")이 승인한 범위 안의 일입니다.

두 가지를 덧붙입니다.

- **OpenRouter에는 실패 공급자 제외만으로 부족합니다.** open-weight 모델 요청은
  OpenRouter가 모델 개발사나 다른 관할의 호스트로 보낼 수 있으므로, 수신자
  allowlist가 함께 있어야 §4.5의 목적지 목록이 거짓말을 하지 않습니다.
- **DeepInfra의 Claude·Gemini는 재판매입니다.** DeepInfra 문서상 그 두 계열은 해당
  벤더로 전달되고 학습·공유 조건도 그쪽을 따릅니다. `gatewayProvider`와
  `servingProvider`가 갈라지는 broker 경로입니다.

### 원문 항목 중 이 순서에 없던 것

| 원문 | 항목 | 현재 |
|---|---|---|
| §1·§14 | 호스트 6곳 onboarding | 4곳 dark: DeepInfra, Together, OpenRouter, Sail (§14.4–§14.6, §14.11). Vertex·Azure는 등록하지 않음 |
| §14.1·Phase 1 | OpenRouter 실패 공급자 제외 (+ 수신자 allowlist) | 코드 (§14.6). 라우터는 호출하지 않음 |
| §3.3 | version gate: `version_pin_strength`, `allow_version_drift` | dark columns (§14.7). 라우터는 읽지 않음 |
| §3.2·§9 | quality gate 운영: benchmark version, 마지막 검증 시각, 만료 시 stale, deployment별 품질 benchmark, drift 감지 후 재검증 | 판정 (§14.9). 행 UPDATE는 없음. drift 숫자 임계값은 없음 |
| §3.5·§2.1 | pin hard gate (`pin_scope`, `pin_fallback_policy=error`)와 요청 시작 시 고정되는 account 정책 버전 | 판정 함수만 (§14.8). 요청 시작 시 버전 고정은 없음 |
| §7.1 | capacity 런타임: Retry-After, token bucket, deprioritize (A-4b) | `QuotaCapacityState` dark schema만 |
| §7.2·§7.3 | deployment 단위 health와 circuit breaker | 판정 (§14.10). trip 횟수는 호출자. prior는 쓰지 않음 |
| §8.5 | load guard | 판정 (§14.12). softmax는 없음. 감쇠 계수는 호출자. 완료로 세지 않음 |
| §11.2 | 401/403/billing에서 credential scope 비활성화와 알림 | 확인 필요 |
| §12 | secret 참조, credential resolver, billing owner (§14의 7번과 겹침) | `CredentialBinding` dark schema만 |
| §13 | deployment별 `pricing_snapshots` | 없음. `docs/policy/credit-and-cost-limits.md` 계약에 닿아 별도 승인 (§15.3) |
| §15.2·§15.3·§15.5 | counterfactual replay, fault injection 확장, draft→shadow→canary→active 승격 절차 | 일부 |
| Phase 1 | health·capacity·quality 운영 대시보드 | 없음 |
| 부록 R1·R3·R6 | affinity epoch·hold-down, `request_deadline_ms`, fallback chain의 장애 영역 | 없음 (R6은 `lib/failureDomain.ts` 일부) |
| §10.2 | pre-commit buffer | 없음, 선택 항목 |

의도적으로 제외한 것은 그대로입니다: §5 가중합 목적함수(어휘순 유지), §7.2의 prior
shrinkage(관측이 부족하면 판단 보류), malformed 같은 deployment 재시도와
`max_attempts` 3(시도 예산 2회), 두 번째 원장, `RoutingRun.mode` 재사용.

### 진행률에 미치는 영향

지금까지의 보고(구현 19/21)는 착수한 단위만 분모로 셌고, §14의 6·9·10·11·12번과 위
표가 빠져 있었습니다. 이 절을 분모에 넣으면 약 50단위이고 완료는 19, **약 38%
(추정)**입니다. 단위의 크기는 고르지 않습니다 — 호스트 하나와 BYOK 전체가 같은 1입니다.

## 14.4 DeepInfra (2026-09-23)

첫 호스트로 고른 이유: 5곳 가운데 가중치가 공개된 세 모델(DeepSeek-V4 Pro·Flash,
Kimi K3, MiniMax M3)을 **하나의 호스트가 모두** 서빙합니다. 데이터는 개발사에 가지
않습니다.

이 단계에서 한 것은 **dark 등록**뿐입니다. `AiProvider`에 `deepinfra`, OpenAI 호환
endpoint와 키 이름, 목적지 목록의 `unproven` 행. **이 공급자로 라우팅되는 카탈로그
모델은 없습니다** — 호스팅된 사본은 새 카탈로그 id가 아니라 `ModelDeployment`
행이어야 하고, 그 전환(§14의 10번)이 선행입니다. `/api/ready`의 공급자 예산 검사는
활성 모델이 있는 공급자만 보므로 이 등록은 readiness를 바꾸지 않습니다.

확인한 사실 (2026-09-23 조회, 증거 목록에는 아직 넣지 않음):

- DeepInfra 문서: 입력은 디스크에 저장하지 않고 출력은 전송 후 삭제, 학습·제3자
  공유 없음(Google·Anthropic 모델 제외), 요청 본문은 기록하지 않으나 디버깅·보안
  목적의 일부 기록 권리를 유보. 처리 지역과 DPA는 문서에 없음.
- 공개 모델 목록(`/v1/openai/models`, 인증 불필요)의 id:
  `deepseek-ai/DeepSeek-V4-Pro`, `deepseek-ai/DeepSeek-V4-Flash`,
  `moonshotai/Kimi-K3`, `MiniMaxAI/MiniMax-M3`. Kimi는 K2.6까지이고 K2.7은 없음.

**같은 이름이 같은 모델이 아닙니다.** OpenRouter가 표시한 DeepInfra 값 기준(공식 확인
전): DeepSeek-V4 Pro와 Kimi K3의 최대 출력 16,384, MiniMax M3의 context 524,288
(카탈로그는 1,000,000), 양자화 fp8(Kimi K3만 bf16). §3.1 capability gate 없이 같은
모델로 취급하면 긴 답이 잘립니다.

**원가가 오르는 모델이 있습니다.** DeepSeek-V4 Pro는 직접 연결 대비 약 3배(입력 0.435
→ 1.30, 출력 0.87 → 2.60 USD/1M, OpenRouter 표시 기준)입니다. 가격 profile은
`lib/modelPricing.ts`의 계약 영역이라 DeepInfra 공식 가격을 확인한 뒤 contract
역할로 따로 올립니다.

## 14.5 Together (2026-09-23)

ADR §14.1의 독립 open-weight fallback입니다. DeepInfra와 같은 형태의 dark
등록만 합니다. 공식 OpenAI 호환 문서의 base는 `https://api.together.ai/v1`이고
키 이름은 `TOGETHER_API_KEY`입니다. 지원 문서에 남아 있는 `api.together.xyz`는
쓰지 않습니다.

목적지 행은 `unproven`입니다. 정산 모델은 `unknown`입니다. 카탈로그 모델은
없고, 호스팅된 사본은 `ModelDeployment`입니다. 가격 profile은 넣지 않습니다.
운영자 콘솔 링크는 문서가 말하는 Settings → Billing
(`https://api.together.ai/settings/billing`)입니다.

이 등록이 코드로 들어가면 호스트 onboarding 6곳 중 2곳(DeepInfra, Together)이
dark로 있습니다. §14.3의 약 50단위 분모에서 완료는 21, **약 42%(추정)**입니다.
검증·독립 검토·병합·배포는 이 수에 들어 있지 않습니다. production 배포는 0%입니다.

## 14.6 OpenRouter (2026-09-23)

ADR §14.1의 최종 emergency fallback입니다. dark 등록에 더해, 수신자
allowlist와 실패 공급자 제외가 호출 조건입니다. 둘 다
`lib/modelRegistryShared.ts`에 있습니다. 채팅 어댑터는 그 파일을 이미
import하므로, Prompt Refiner runtime closure에 파일을 더하지 않고 admission
없이 클라이언트를 만들지 않습니다.

허용 목록은 요청 필드가 아닙니다. 운영자 환경변수
`OPENROUTER_RECIPIENT_ALLOWLIST`이고, 비어 있거나 slug가 하나라도 잘못되면
거절입니다. 저장소는 수신자 목록을 지어 넣지 않습니다. 호출자가 수신자와
목록을 같은 인자로 넘기면 목록은 자기 자신과만 맞으므로, 어댑터는 그 필드를
읽지 않습니다.

통과한 요청의 본문에는 `provider.only`(slug 하나)와 `allow_fallbacks: false`가
실리며, 이미 있던 `provider` 객체는 합치지 않고 바꿉니다. `only`는 허용
목록입니다. 목록 밖으로 넘어가는 것은 `order`의 동작이고, `allow_fallbacks`의
기본값이 true인 것은 그 hop을 위한 것입니다. 둘을 같이 거는 이유는 `only`가
목록을 탈출해서가 아니라, 교체된 본문에 그 기본값이 남지 않게 하기
위해서입니다. 앞선 attempt가 쓴 slug는 `ignore`에 실리고, 그 slug를 수신자로
고르면 거절입니다. 계정 설정의 허용·무시 목록은 요청 목록과 합쳐져 더 좁아질
수 있고, 넓히지는 못합니다.

base slug는 그 공급자의 모든 endpoint(지역·variant)와 맞습니다. `deepinfra`는
`deepinfra/turbo`까지 포함합니다. 서비스 티어 endpoint(`openai/fast`,
`google-vertex/flex`)는 예외로, base slug가 맞추지 않으므로 suffix가
필요합니다. 지역을 고정하려면 `google-vertex/us-east5` 같은 variant slug
자체가 allowlist에 있어야 하고, 게이트는 그 형태를 받습니다.

DeepInfra와 Together는 카탈로그 어댑터에서 클라이언트를 만들기 전에 거절합니다.
관리자 카탈로그 쓰기도 이 세 공급자를 거절합니다. 호스팅된 사본은
카탈로그 행이 아닙니다.

목적지 행은 `unproven`, 정산은 `unknown`, 카탈로그 모델은 없습니다. base는
문서의 `https://openrouter.ai/api/v1`, 키는 `OPENROUTER_API_KEY`입니다.

이 등록까지가 호스트 6곳 중 3곳이고, 빠져 있던 OpenRouter 제외·allowlist
항목이 코드로 있습니다. §14.3의 약 50단위에서 완료는 23, **약 46%(추정)**입니다.
검증·독립 검토·병합·배포는 별도입니다. production 배포는 0%입니다.

2026-09-23 재검토는 Windows Claude Code CLI(opus, commit `b7b52d6e3`)가
approve로 돌려줬습니다. blocker와 major는 없습니다. minor 넷은 기록만
합니다. 완료 수는 바꾸지 않습니다.

- `failedProviders`는 slug를 그대로 비교합니다. base slug가 variant를
  포함한다는 주석과 어긋나, 실패한 `deepinfra` 뒤에 `deepinfra/turbo`를
  고르면 로컬 거절 대신 `only`와 `ignore`가 같이 나갑니다.
- 관리자 모델 폼의 select는 `AI_PROVIDERS` 전체를 그리고, 거절은 저장 뒤
  Zod 문장으로 옵니다.
- 거절 코드를 409로 매핑하는 곳은 채팅 route뿐입니다. 다른
  `getActiveAiModel` 호출은 Zod가 행을 막는 동안 닿지 않습니다.
- 카탈로그 거절 테스트는 update schema의 실패 이유까지 확인하지 않습니다.

## 14.7 Model version gate (2026-09-23)

ADR §3.3의 필드가 `ModelDeployment`에 있습니다. dark입니다. 라우터는
읽지 않습니다. 발행된 manifest는 그 값을 복사하고, digest가 덮습니다.
enabled인 행의 pin과 benchmark 이름을 identity trigger가 고정합니다.

- `versionPinStrength`는 `strong`, `weak`, `alias_only`입니다. 기본은 `strong`입니다.
- `allowVersionDrift`의 기본은 false입니다.
- 판정은 `versionMayDrift()` 한 곳입니다. `strong`은 플래그가 켜져 있어도
  다른 revision으로 가지 않습니다. `weak`와 `alias_only`는 플래그가 켜져
  있을 때만 움직입니다.
- `qualityBenchmarkVersion`은 그 pass가 어떤 benchmark인지입니다. enabled인
  동안 바꾸면 trigger가 거절합니다.
- `qualityLastVerifiedAt`은 같은 benchmark를 다시 잰 시각입니다. enabled인
  채로 갱신할 수 있습니다. manifest에는 들어가서 발행 시점의 시각이 남습니다.

이 필드가 §14.3의 version gate 항목입니다. pin의 요청 경로 연결과, 만료를
`stale`로 돌리는 운영 전환은 아직입니다. 판정 함수는 §14.8입니다.

§14.3의 약 50단위에서 완료는 24, **약 48%(추정)**입니다. 직전 OpenRouter
등록 보고는 23, 약 46%였습니다. 검증·독립 검토·병합·배포는 별도입니다.
production 배포는 0%입니다.

## 14.8 Pin hard gate의 판정 (2026-09-23)

ADR §3.5의 판정이 `lib/routingPinGate.ts`에 있습니다. 요청 경로는
import하지 않습니다. 후보를 고르는 코드는 아직 이 함수를 부르지 않습니다.

- scope는 `provider`와 `deployment`입니다.
- pin이 있으면 explore rate는 0입니다.
- fallback의 기본은 `error`입니다. `allow`만, 그리고 pin이 거절한 후보에
  한해서, 일반 pool로 나갈 수 있습니다.
- 철자가 다른 fallback 값은 `error`로 읽습니다.
- capability·quality·version·residency·credential gate는 그대로 적용됩니다.
  이 함수는 그 답을 대신하지 않습니다.
- `pinPolicyVersionHeld()`는 요청 시작 때 잡은 정책 버전과 현재 버전이
  같을 때만 참입니다. 그 버전을 요청에 저장하는 곳은 아직 없습니다.

이 줄은 §14.3의 pin 항목을 완료로 세지 않습니다. 완료 수는 24, **약 48%(추정)**
그대로입니다.

## 14.9 Quality gate의 만료와 drift 예약 (2026-09-23)

ADR §3.2와 §9.2의 판정이 `lib/qualityGateOperations.ts`에 있습니다.
요청 경로는 import하지 않습니다. 행을 고치지 않습니다.

- `passed`는 `at`이 만료 시각보다 엄격히 앞일 때만 그대로입니다. 만료 시각
  자신은 `stale`입니다. `pending`·`failed`·`stale`은 시계로 바뀌지 않습니다.
- 만료 시각이 없는 pass는 `stale`로 다시 쓰지 않습니다. 만료된 것이 아닙니다.
  production 자격은 그 행에 없습니다. 자격은 요구 tier와 deployment tier가
  같고, 유효한 pass일 때입니다.
- 만료 write는 `qualityGateStatus = stale`과 `enabled = false`를 같이
  냅니다. 저장된 status가 `passed`가 아니면 그 write는 없습니다.
- drift는 이름이 있는 신호가 넘었다고 보고될 때 재검증을 예약합니다.
  모르는 신호 이름도 예약합니다. 임계값 숫자는 이 함수에 없습니다.

이 줄이 §14.3의 quality gate 항목입니다. 직전 보고는 24, 약 48%였습니다.
§14.3의 약 50단위에서 완료는 25, **약 50%(추정)**입니다. 검증·독립 검토·
병합·배포는 별도입니다. production 배포는 0%입니다.

## 14.10 Deployment availability (2026-09-23)

ADR §7.2와 §7.3의 판정이 `lib/deploymentAvailability.ts`에 있습니다.
요청 경로는 import하지 않습니다. provider health 카운터를 읽지 않습니다.

- 5xx, 연결 실패, pre-commit timeout, transport corruption만 availability입니다.
  429와 malformed output은 제외입니다.
- raw risk는 문서의 가중치 `(1.0 * n5xx + 1.2 * nTimeout + 1.0 * nConnection) / nEligible`입니다.
  표본이 없거나 수가 성립하지 않으면 `insufficient`입니다. shrinkage prior는
  쓰지 않습니다.
- breaker는 `closed → open → half_open → closed`입니다. 몇 번 실패에
  열리는지는 호출자의 `trip`입니다. 이 모듈은 그 횟수를 정하지 않습니다.
  open은 probe를 허용하기 전까지 닫히지 않습니다.

이 줄이 §14.3의 deployment health 항목입니다. 직전 quality 보고는 25, 약 50%였습니다.
§14.3의 약 50단위에서 완료는 26, **약 52%(추정)**입니다. 검증·독립 검토·
병합·배포는 별도입니다. production 배포는 0%입니다.

## 14.11 Sail Research (2026-09-23)

ADR §14.1의 background·유연한 작업 호스트입니다. DeepInfra와 같은 형태의
dark 등록만 합니다. 공식 quickstart의 OpenAI 호환 base는
`https://api.sailresearch.com/v1`이고 키 이름은 `SAIL_API_KEY`입니다.
같은 origin의 Anthropic Messages base(`/v1` 없음)는 beta로 적혀 있어 이
연결에 쓰지 않습니다.

목적지 행은 `unproven`입니다. 정산 모델은 `unknown`입니다. 카탈로그 모델은
없고, 호스팅된 사본은 `ModelDeployment`입니다. 가격 profile은 넣지 않습니다.
`DEPLOYMENT_ONLY_PROVIDERS`에 들어 있어 카탈로그 쓰기와 카탈로그 어댑터가
거절합니다. 운영자 콘솔 링크는 usage 문서가 대시보드로 가리키는
`https://app.sailresearch.com`입니다. 그 문서가 billing path를 따로
적지 않으므로 `/billing`을 붙이지 않습니다.

Vertex AI와 Azure OpenAI는 이 등록에 없습니다. Vertex는 지역 endpoint이고
Azure는 리소스마다 base가 다릅니다. T1은 region-pin 공급자가 확인된 곳이
0개라고 하므로, 하나의 base URL을 지어 넣지 않습니다.

위 표의 호스트 칸과 OpenRouter 제외 칸은 코드와 어긋나 있어 이 절에서
고쳤습니다. OpenRouter 제외는 §14.6에서 이미 세었으므로 여기서 다시 세지
않습니다. Sail 한 곳만 더합니다.

이 등록이 코드로 들어가면 호스트 6곳 중 4곳(DeepInfra, Together, OpenRouter,
Sail)이 dark로 있습니다. §14.3의 약 50단위 분모에서 완료는 27, **약 54%(추정)**
입니다. 직전 availability 보고는 26, 약 52%였습니다. 검증·독립 검토·병합·
배포는 이 수에 들어 있지 않습니다. production 배포는 0%입니다.

## 14.12 Load guard (2026-09-23)

ADR §8.5의 판정이 `lib/loadGuard.ts`에 있습니다. 요청 경로는 import하지
않습니다. softmax를 계산하지 않습니다.

- 포화 신호는 credential capacity와 deployment load 둘입니다. 둘 다 꺼져
  있으면 weight는 그대로입니다.
- 하나라도 켜져 있으면 호출자가 넘긴 감쇠 계수를 곱합니다. 계수는 (0, 1)
  안의 유한한 수여야 합니다. 0은 후보를 지우고, 1은 감쇠가 아닙니다. 이
  모듈은 계수를 고르지 않습니다. 쓸 수 없는 계수면 null이고, 0으로 바꾸지
  않습니다.
- `allocationHerds`는 양수이던 provider가 둘 이상인데 남은 양수 몫이
  provider 하나로 모이고, 빠지는 provider의 weight가 0이 된 경우입니다.
  감쇠만 하고 양수를 유지하면 이 판정이 아닙니다.
- phase 이름은 `before_softmax`와 `after_softmax` 둘 다 있어야 확인된
  것입니다. 이름만 있고 softmax 계산은 없습니다. `lib/routingAllocation.ts`가
  softmax를 두지 않는 이유는 온도가 품질과 비용의 교환이고, 그 교환은
  정해지지 않았기 때문입니다. 그 온도를 여기 넣지 않습니다.

이 줄은 §14.3의 load guard 항목을 완료로 세지 않습니다. softmax 전후라는
문장의 계산이 없고, 감쇠 계수도 정해져 있지 않습니다. 완료 수는 27,
**약 54%(추정)** 그대로입니다. 직전 Sail 보고와 같습니다.

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

## 15.3 5차 검토가 남긴 것, 그리고 이 문서가 멈추는 곳

5차 검토도 `reject`입니다. 다만 **발견의 성격이 바뀌었습니다** — 설계 모순이 아니라
**구현 선행 조건**입니다.

코드로 고친 것(A-6, 커밋 `3e203051d`):

- 관측과 판정이 한 값이었고 **양쪽으로 틀렸습니다.** `observedOutcome`을 분리
- fallback 거절이 연결 손실을 `cancelled`로 보고 → `connection_lost` 신설

문서에 남긴 것:

| 발견 | 처리 |
|---|---|
| `EndpointResidencyApproval`과 가변 `ProviderEndpoint.region`이 **두 source of truth** | eligibility는 **approval만 읽습니다.** DB에서 결속하거나 endpoint의 region을 파생값으로 만듭니다 |
| §14에 **instrumentation 활성화 단계가 없음** (현재 `off`) | C/A-5 배포 후 `observe`로 coverage 축적 → constrained dispatch 전에 `enforce` |
| 가격이 `model.id`로 해석됨 | deployment/provider-account별 요율이 가능하면 **pricing profile과 snapshot key도 그 grain**으로. `docs/policy/credit-and-cost-limits.md` 계약에 닿으므로 별도 승인 |
| fallback 활성화 전 **서로 다른 endpoint에 proven deployment 2개 이상** 필요 | 아니면 endpoint-scoped 실패의 후보가 항상 0개 |
| Perplexity canary 비용 (U5) | **별도 예산 불요.** residency 증명 후 수동 dispatch의 `RoutingAttempt`를 증거로 쓰고, 표본이 모자라면 Auto에서 계속 제외. 그때만 canary 예산 승인 요청 |

### 이 문서가 더 나아가지 못하는 이유

개정 1→5의 발견 수는 blocker 2·6 → 2·5 → 2·3 → 1·3 → 0·4로 줄었고, 5차의 넷은
전부 **무엇을 만들기 전에 정해야 할 것**입니다. 순환이 아니라 수렴입니다.

그런데 **남은 차단 항목이 전부 사람의 결정입니다.** 세 차례 검토가 모두 같은 것을
1번으로 적었습니다:

1. **조직의 기본 해외 공개 정책** (§4.2) — Privacy Owner 승인. 없으면 residency는
   fail-closed이고, 그러면 미기록 endpoint 전체가 후보에서 빠집니다.
2. **`Workspace` 모델이 스키마에 없습니다** — BYOK의 소유권이 account인지
   workspace인지가 §8.2·§8.3·T2 전체의 선행 조건입니다.
3. **계약상 강제 가능한 region pin을 제공하는 공급자** (T1) — 확인된 곳 **0개**.
   추정 승인은 금지이고, 조사는 공급자 계약 문서 접근이 필요합니다.

이 셋이 정해지기 전에 C의 스키마를 쓰면 **뒤집힐 전제 위에 씁니다.** 개정 6을 쓰는
것은 답이 아니고, 결정을 올리는 것이 답입니다.

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
- 개정 5: Cursor 독립 검토 → **`reject`**. 새 blocker 0, major 4, 사실 오류 2.
  발견이 설계 모순에서 **구현 선행 조건**으로 옮겨 갔습니다 — 수렴 신호입니다.
- 개정 6: 5차 검토 반영 완료. **6차 검토를 돌리지 않습니다** — 남은 차단 항목이
  전부 사람의 결정이고, 검토를 한 번 더 도는 것으로는 풀리지 않습니다(§15.3).
