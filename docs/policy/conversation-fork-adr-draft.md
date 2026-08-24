# 제품 전환 fork — ADR 초안 (미확정)

> **상태: 초안. 구현하지 마십시오.**
> 제품 경계 결정 기록 v1.2 결정 4는 "제품 전환은 기존 대화를 바꾸지 않고
> fork한다"를 확정했지만, **"사용자 문맥"이 무엇인지는 아직 정의되지 않았습니다.**
> 이 문서는 그 정의를 내리기 위해 답해야 할 질문들을 열거하고, 이미 확정된
> 원칙과 아직 열려 있는 결정을 구분합니다.
>
> 이 문서만 보고 fork를 구현하지 마십시오. 열린 항목이 남아 있는 동안의 구현은
> 추측입니다.

## 1. 이미 확정된 것

### 1.1 PATCH가 아니라 fork

Review 대화를 Chat으로 바꾸는 PATCH는 **제공하지 않습니다.** 저장된
`Conversation.productKey`가 권위값이고, 제품을 바꾸는 PATCH는 존재하지 않습니다.
`app/api/conversations/[conversationId]` 의 PATCH는 `selectionMode`만 다루며,
요청 본문은 `productKey`를 실을 수 없습니다(`.strict()` 스키마).

### 1.2 복사하지 않는 것 — 이 목록은 확정입니다

| 항목 | 복사 안 함 |
|---|---|
| `RoutingRun` | 같은 실행이 두 제품에 계상되면 ROUTE-01 세그먼트가 오염됩니다 |
| `RoutingAttempt` | 위와 같음 |
| `ContextManifest` | 실행 증거는 그 실행의 것입니다 |
| `ChatCreditReservation` | 턴 단위라 옮길 것이 없습니다 |
| provider usage · 정산 기록 | 과금은 소급되지 않습니다 |
| Router sticky / recovery 상태 | 새 대화는 자기 이력에서 시작합니다 |
| 기존 AI Review 실행 결과 | 다른 제품의 산출물입니다 |

**새 대화의 실행 기록은 0에서 시작합니다.**

### 1.3 provenance 3필드

```
forkedFromConversationId
forkedFromMessageId
forkReason = "product_switch"
```

`lib/externalConversationLineage.ts`는 "원본을 변경하지 않고 새 객체와 계보를
만든다"는 **정책 선례**로는 좋지만, `ExternalConversation` snapshot을 묶는 UI
함수이므로 **직접 재사용할 구현이 아닙니다.** Conversation self-lineage는 별도로
설계합니다.

### 1.4 전역 제품 스위처로 제공

같은 화면의 작은 토글이 아닙니다. 토글로 만들면 사용자는 모델 선택 방식만
달라지는 것으로 이해하는데, 실제로는 결과 구조·비용·작업 목적이 다릅니다.

## 2. 열린 결정 — 이것들이 정해지기 전에는 구현하지 않습니다

### 2.1 메시지 복사 범위와 새 Message ID

- 사용자가 선택한 지점**까지의 가시적 메시지**만 복사한다는 것은 정해졌습니다.
- **"가시적"의 경계가 미정입니다.** 실패한 assistant 메시지, 취소된 스트림,
  `status`가 pending인 행, 시스템이 삽입한 안내는 사용자 문맥인가?
- 새 `Message` ID를 쓴다는 것은 정해졌지만, **원본 ID와의 연결을 남길지**가
  미정입니다. 남기면 삭제 수명이 두 대화에 걸치고, 남기지 않으면 "이 메시지가
  어디서 왔는가"를 물을 수 없습니다.

### 2.2 첨부파일 — 복사인가 참조인가 끊기인가

**세 선택지가 각각 다른 비용과 삭제 수명을 갖습니다.**

| 방식 | 저장 비용 | 원본 삭제 시 | 권한 |
|---|---|---|---|
| 복사 | 두 배 | 새 대화는 무사 | 새 대화가 자기 객체를 소유 |
| 참조 | 없음 | **새 대화가 깨짐** | 두 대화가 한 객체를 공유 — 소유권 판정 필요 |
| 끊기 | 없음 | 해당 없음 | 문맥이 손실됨 |

`lib/imageAssetLifecycle.ts`의 tombstone queue와 orphan sweep이 이미 객체 수명을
소유하고 있으므로, 어떤 선택이든 그 계약 안에서 정의해야 합니다.
**미정입니다.**

### 2.3 project 지침

`Conversation.projectId`를 이어받는가? 프로젝트는 제품 축이 아니므로 이어받는
것이 자연스러워 보이지만, 프로젝트 지침이 Review를 전제로 쓰여 있으면 Chat
대화에 잘못된 지침이 적용됩니다. **미정입니다.**

### 2.4 assistant profile

`assistantProfileVersionId`는 §14의 **pin**입니다 — "이 대화가 어떤 revision
아래에서 돌았는가". fork는 새 대화이므로 그때의 current를 새로 pin하는 것이
맞아 보이지만, 그러면 사용자가 보고 있던 답변의 profile과 이어지는 대화의
profile이 달라집니다. **미정입니다.**

### 2.5 memory 관련 상태

`Conversation.memoryMode`(`inherit`/`on`/`off`)를 이어받는가? 그리고 원본
대화에서 **추출된 memory item**은 fork와 어떤 관계인가 — 이미 계정 범위이므로
아무것도 하지 않아도 되는가, 아니면 출처(`MemoryItem` source) 관점에서 원본만을
가리켜야 하는가. **미정입니다.**

### 2.6 원본 삭제 시 provenance 처리

`forkedFromConversationId`가 가리키던 대화가 삭제되면:

- `SetNull` — 계보는 끊기고 fork는 남습니다. `RoutingRun.conversationId`가
  방금 채택한 패턴입니다.
- `Cascade` — 사용자가 원본을 지우면 fork도 사라집니다. 거의 확실히 틀렸습니다.
- 유지 + 삭제된 원본 표시 — 삭제된 대화의 ID를 계속 들고 있게 되는데, 그것이
  삭제 요청과 어떤 관계인지 데이터 도메인 정책이 답해야 합니다.

**미정이며, `docs/policy/tomverse-chat-data-domain-registry.yaml`이 함께
갱신되어야 합니다.**

### 2.7 크레딧

fork 자체가 크레딧을 소비하는가? 메시지를 복사하는 것은 provider 호출이 아니므로
0이 자연스럽지만, 복사된 문맥이 다음 턴의 입력 토큰을 늘립니다. 그것은 다음 턴의
비용이지 fork의 비용이 아닙니다. **거의 정해졌지만 finance-ops 확인 필요.**

## 3. 문맥 전환 동작 (제품 결정, 구현 아님)

| 출발 | 동작 |
|---|---|
| Chat 답변에서 | "다른 모델 답변과 비교하기" → Review로 fork |
| Review 결과에서 | "이 답변으로 Chat 계속하기" → Chat으로 fork |
| Chat에서 이미지 요청 | "Studio에서 만들기" |

## 4. 선행 조건

이 ADR이 확정되기 전에 제품 전환 기능을 공개하지 않습니다. 그리고 이 ADR이
확정돼도, 결정 기록 §7의 합류 조건(Auto readiness + productKey strict 전환 +
제품별 생성 경계)이 모두 끝나기 전에는 전역 제품 스위처를 공개하지 않습니다.

## 5. 이 문서를 확정할 때 함께 할 일

- `Conversation`에 provenance 3필드를 더하는 migration과 그 인덱스·정리 정책
- 데이터 도메인 registry 갱신 (§2.6)
- fork endpoint의 제품별 경계 — `POST /api/products/{chat,review}/conversations`의
  fork 변형인지 별도 endpoint인지
- 복사하지 않는 목록(§1.2)을 강제하는 테스트
