네, 이해했습니다. **Chat·Review·Code·Studio를 서로 잇는 중앙 뇌**라는 의미라면 방향성이 훨씬 명확합니다.

제 결론은 다음과 같습니다.

> Tomverse의 핵심 자산은 단일 `llm-core` 패키지가 아니라 **Tomverse Intelligence Platform**이 되어야 합니다.  
> `llm-core`는 그 플랫폼의 추론 커널 역할을 맡는 것이 가장 안전하고 확장성이 높습니다.

## 권장 구조

```text
┌────────┐ ┌─────────┐ ┌──────┐ ┌────────┐ ┌──────────────┐
│ Chat   │ │ Review  │ │ Code │ │ Studio │ │ External API │
└───┬────┘ └────┬────┘ └──┬───┘ └───┬────┘ └──────┬───────┘
    └────────────┴──────────┴─────────┴─────────────┘
                         │
                 Product Adapters
          (productKey, prompt, tools, context policy)
                         │
       ┌─────────────────▼──────────────────┐
       │ Tomverse Intelligence Control Plane│
       │ API Key · tenant · model registry  │
       │ routing policy · quota · entitlement│
       └──────────┬───────────────┬─────────┘
                  │               │
       ┌──────────▼───────┐  ┌────▼────────────────┐
       │ LLM Gateway      │  │ Memory Fabric       │
       │ inference plane  │  │ product connections │
       └──────────┬───────┘  └─────────────────────┘
                  │
       ┌──────────▼─────────────────────────┐
       │ @tomverse/llm-core                 │
       │ providers · streams · tools        │
       │ usage · errors · routing primitives│
       └──────────┬─────────────────────────┘
                  │
        OpenAI · Anthropic · Google · etc.
```

핵심은 **중앙화해야 하는 것과 분리해야 하는 것을 구분하는 것**입니다.

| 구성요소 | 책임 |
|---|---|
| `llm-core` | Provider adapter, 표준 요청/응답, 스트리밍, tool calling, structured output, usage/error 정규화 |
| Gateway | 실제 모델 호출, 재시도, timeout, failover, trace, idempotency |
| Control Plane | API Key, tenant, 권한, quota, 모델 정책, routing policy, API 상품 |
| Memory Fabric | 제품 간 공유 가능한 기억, 출처, 권한, 만료, 삭제 |
| Product Adapter | Chat/Review/Code/Studio 각각의 프롬프트, 도구, 데이터 접근 규칙 |
| 각 제품 | 사용자 경험과 제품별 workflow, 최종 크레딧·업무 상태 |

`llm-core`에 API Key, 메모리 DB, 과금, 제품 프롬프트까지 모두 넣으면 빠르게 “거대 공용 모듈”이 됩니다. 그 결과 한 제품의 변경이 다른 모든 제품의 릴리스를 막게 됩니다.

## “서로 잇는” 방법

모든 호출과 기억에 다음 식별자를 명시적으로 포함하는 방식을 권장합니다.

```text
tenantId
subjectId
productKey       chat | review | code | studio
workspaceId
agentId
conversationId
traceId
sharingPolicy
```

현재 Chat도 `Conversation.productKey`를 제품 경계의 명시적 기준으로 사용하고 있습니다. 이 원칙을 중앙 플랫폼까지 확장하는 것이 자연스럽습니다: [conversation-product-key.md](H:/Project/ai-chat-hub/docs/policy/conversation-product-key.md:1)

제품 간 연결은 다음처럼 동작할 수 있습니다.

- Chat에서 확정한 사용자 선호를 Studio가 활용
- Review에서 발견한 품질 정책을 Code agent가 참조
- Code에서 사용자가 승인한 기술 결정을 Review가 검증
- Studio에서 생성한 브랜드 지침을 Chat과 Review가 공유
- 업무 Agent가 여러 제품의 기능을 하나의 실행 계획으로 조합

다만 **원본 대화 전체를 자동으로 공유하거나 기억으로 간주하면 안 됩니다.** 기억은 별도의 승인된 객체여야 합니다.

```text
kind: preference | decision | fact | task_state | policy
source: 원본 제품과 원본 객체
scope: local-only | product-only | cross-product | organization
sensitivity: public | internal | confidential | restricted
confidence
expiresAt
createdBy
```

## Code에는 연합형 메모리가 필요합니다

Tomverse Code는 현재 local-first/BYOK이며 소스 코드가 Tomverse 서버를 경유하지 않는다는 약속을 갖고 있습니다. [README](https://github.com/mposition/TomverseCode/blob/main/README.md)와 [제품 전략](https://github.com/mposition/TomverseCode/blob/main/docs/design/product-strategy.md)의 중요한 차별점입니다.

따라서 Code를 중앙 뇌에 연결할 때도 다음 경계를 지켜야 합니다.

- 소스 코드, diff, workspace snapshot: 로컬에 유지
- Code 전용 업무 기억: 기본적으로 로컬 저장
- 사용자가 승인한 기술 결정·선호·요약: 중앙 Memory Fabric에 선택적으로 동기화
- 중앙 서비스 장애 시에도 Code의 기본 기능은 계속 동작
- 공유 전에 어떤 데이터가 전송되는지 사용자에게 표시

즉, **하나의 메모리 계약과 여러 저장소 구현**을 사용합니다.

```text
Memory Contract
├── Server Memory Store: Chat / Review / Studio
└── Local Memory Store: Code
        └── Approved Summary Sync → Server
```

## 저장소 구성도 변경하는 편이 좋습니다

이 목표라면 이전의 “TomverseCode 안에 `packages/llm-core`를 둔다”는 선택은 **초기 추출 단계**로는 괜찮지만 최종 구조로는 부족합니다. 이제 네 제품과 외부 API가 공동 소유하는 자산이기 때문입니다.

최종적으로는 독립적인 플랫폼 저장소를 권장합니다.

```text
tomverse-intelligence/
├── packages/
│   ├── llm-core/
│   ├── contracts/
│   ├── memory-contracts/
│   └── sdk-typescript/
├── services/
│   ├── gateway/
│   ├── control-plane/
│   └── memory/
└── conformance/
    ├── provider-tests/
    └── product-adapter-tests/
```

TomverseCode와 ai-chat-hub는 이를 버전이 고정된 패키지로 사용합니다.

현재 Chat 저장소의 `packages/*` 정책은 외부 의존성, Node 내장 모듈, 서버 코드를 제한하고 있기 때문에, `llm-core`를 이 저장소 안으로 복사하는 구조는 적합하지 않습니다: [shared-packages.md](H:/Project/ai-chat-hub/docs/policy/shared-packages.md:1)

## API Key 판매 가능성

가능합니다. 다만 **단순한 Provider API 재판매**로 포지셔닝하면 가격 경쟁에 빠집니다. 판매해야 하는 것은 다음과 같은 Tomverse Intelligence API입니다.

- 여러 Provider를 하나의 API로 호출
- 목적별 모델 routing과 fallback
- 제품·조직별 memory
- tool calling과 structured output
- 비용·사용량·근거·감사 기록
- agent run 추적
- 데이터 보존 및 공유 정책
- BYOK와 Tomverse-managed inference 선택

초기 상품 구성은 다음이 적절합니다.

1. **BYOK Platform API**
   - 고객이 Provider Key를 제공
   - Tomverse는 routing, memory, observability, agent orchestration에 과금
   - 초기 원가 위험이 가장 낮음

2. **Managed Intelligence API**
   - Tomverse API Key 하나로 모델 사용
   - 사용량 기반 과금
   - Provider 비용과 실패·재시도 비용을 Tomverse가 관리

3. **Enterprise**
   - 월간 사용 약정 + 초과 사용량
   - 전용 보존 정책, 조직 memory, SLA, 감사 로그, 모델 allowlist

가격은 당장 단일 숫자로 정하기보다는 `기본 플랫폼 요금 + 사용량` 형태의 하이브리드가 적합합니다. 모델별 원가뿐 아니라 재시도, 웹 검색, tool 실행, 캐시, memory 저장·검색 비용까지 측정된 후 가격 구간을 확정해야 합니다.

## 권장 개발 순서

1. **플랫폼 경계 확정**
   - `llm-core` 책임과 금지 책임
   - 제품별 데이터 및 memory 공유 정책
   - Code의 local-first 예외

2. **`llm-core` 추출**
   - Provider adapter
   - 공통 stream/error/usage/tool 계약
   - Provider conformance test

3. **내부 Gateway**
   - 먼저 Tomverse 제품들만 사용
   - 모든 요청에 trace, usage, pricing snapshot 기록

4. **Control Plane**
   - tenant, API Key, scope, quota, rotation/revocation
   - 제품별 모델 및 데이터 접근 정책

5. **Memory Fabric**
   - Chat·Review·Studio부터 적용
   - 출처·삭제·만료·공유 권한 구현

6. **Code 연합형 연결**
   - 로컬 memory adapter
   - 승인된 요약만 중앙 동기화

7. **외부 API 비공개 베타**
   - 내부 제품에서 충분히 검증된 동일한 API를 외부에 제공
   - 이후 Managed API와 Enterprise 상품화

따라서 제안은 한 문장으로 정리됩니다.

> **“`llm-core`를 모든 것을 담는 중앙 뇌로 만들지 말고, Tomverse Intelligence Platform의 추론 커널로 만든다. 중앙 뇌는 Control Plane·Gateway·Memory Fabric·Product Adapter가 함께 구성한다.”**

이 구조라면 Chat·Review·Code·Studio의 사용 경험이 실제 플랫폼 성숙도로 누적되고, 외부 고객에게도 같은 기능을 API Key로 판매할 수 있습니다. 동시에 Code의 로컬 우선 약속과 Chat의 기존 크레딧·비용 통제 자산도 훼손하지 않습니다.
