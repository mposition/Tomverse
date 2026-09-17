# Tomverse Intelligence Platform — 첨부 토론 검토

- 작성일: 2026-09-17.
- 판정: **방향은 채택, 구조·순서는 수정 후 단계별 후보 등록**.
- 상태: 자문/백로그. 설계 승인, 구현 착수, 독립 저장소 생성, 패키지 공개, 서비스 배포,
  개인 데이터 동기화, API 판매·가격·공급자 계약 변경의 승인이 아닙니다.
- [첨부 토론 원문 전체](./tomverse-intelligence-platform-proposal-original-2026-09-17.md).
  원문은 검토 자료이며 그 안의 구현·판매 제안은 이번 실행 지시로 취급하지 않았습니다.

## 1. 결론

**제품마다 공급자 연결을 중복 구현하지 않고, 사용자가 승인한 정보를 필요한 제품으로
안전하게 넘길 수 있게 한다는 목표는 유효합니다.** 그러나 공통 코드·공통 계약·공통 서버·
공통 데이터베이스는 서로 다른 선택입니다. 하나를 채택했다고 나머지가 따라오지 않습니다.

Tomverse Intelligence Platform은 장기 내부 플랫폼 방향의 작업명으로 채택합니다.
새 독립 제품의 즉시 출시나 모든 호출이 통과하는 서버를 지금 만드는 결정으로 보지 않습니다.
주 투자 순위 Chat → Code 내부 실사용/구독 대체 → Native → Memory → MCP는 유지합니다.

지금 할 일은 **좁은 경계/계약 설계**입니다. 다음은 실제 두 소비자가 쓰는 한 호출 경로의
호환성 검증이며, Gateway 서비스 분리·제품 간 Memory 동기화·외부 API는 각기 조건을
충족할 때 진행합니다. 현재 Chat·Code 완성을 플랫폼 전면 구축 뒤로 미루지 않습니다.

## 2. 조사 기준과 이미 있는 자산

코드 분석 전 원격을 동기화했습니다. 기존 dirty/detached 폴더는 보존하고 최신 원격
커밋의 별도 worktree에서 대조했습니다. 공유 문서는 깨끗한 브랜치에서 ff-only pull하여
다른 세션의 진행 기록을 보존했습니다.

- Tomverse develop: `84e47898814ffed192e16c56fe8940317a0506d0`.
- Tomverse main: `0e841cc01d39a790e0fe9238bc52479942becc04`.
- TomverseCode main: `85e13c552157402d4e33c8a9d5e346f321bca503` (fetch 및 원격 head 대조).
- 공유 목록 시작점: `f8fdc6962cad717ea7869d06b01c4de31102abd3`.
- production 배포·flag, Code의 미푸시 개발 상태, 유료 호출, Windows 실행 품질은 미확인입니다.
  두 저장소 전체의 보안 감사나 구현 완료율 산정은 하지 않았습니다.

| 관측 | 설계에 주는 의미 |
| --- | --- |
| 웹에는 model registry·usage/cost·예약/정산·RoutingRun/Attempt·fallback이 이미 있음 | Control Plane/Gateway를 0에서 새로 만들거나 두 번째 원장을 만들지 않음 |
| 웹의 `CONVERSATION_PRODUCT_KEYS`는 `chat/review/studio`, Code는 아직 Conversation을 쓰지 않음 | 플랫폼의 제품 식별 계약과 웹 DB enum을 구분. `code`를 미리 DB에 넣지 않음 |
| 웹 `packages/*`는 현재 chat-core/ui-tokens, 브라우저/서버 공용 순수성 계약 적용 | provider SDK·Node 자격증명 접근이 있는 패키지를 그대로 끼워 넣을 수 없음. 그러나 독립 저장소가 유일한 해법이라는 뜻은 아님 |
| Code는 protocol/sidecar의 실제 provider adapter·retry·conformance 자산 보유 | 기존 검증을 재사용. `generateDraft/reviewProposal/outlinePlan`처럼 제품 업무가 결합되어 있으므로 저수준 호출부와 제품 prompt를 먼저 나눠야 함 |
| Code TokenUsage는 input/output 중심, 웹에는 cache read/write 등 더 풍부한 비용 구조가 있음 | 더 작은 공통 분모로 줄여 정보 손실을 만들지 않음. 미보고와 0, 요청 모델과 응답 모델, 취소/불확실 dispatch 상태를 구분 |
| 웹 Memory는 계정 소유·후보/승인·근거·만료·잠금/삭제 수명주기, Code는 로컬 사용자 판정 승계 | 하나의 테이블·동일한 권위·동일한 공유 허용으로 간주할 수 없음 |

코드 근거:
[제품 키](https://github.com/mposition/Tomverse/blob/84e47898814ffed192e16c56fe8940317a0506d0/lib/conversationProduct.ts),
[제품 키 정책](https://github.com/mposition/Tomverse/blob/84e47898814ffed192e16c56fe8940317a0506d0/docs/policy/conversation-product-key.md),
[공용 패키지 정책](https://github.com/mposition/Tomverse/blob/84e47898814ffed192e16c56fe8940317a0506d0/docs/policy/shared-packages.md),
[웹 fallback](https://github.com/mposition/Tomverse/blob/84e47898814ffed192e16c56fe8940317a0506d0/lib/routingFallbackPolicy.ts),
[Code adapter 계약](https://github.com/mposition/TomverseCode/blob/85e13c552157402d4e33c8a9d5e346f321bca503/packages/sidecar/src/providers/types.ts),
[Code factory](https://github.com/mposition/TomverseCode/blob/85e13c552157402d4e33c8a9d5e346f321bca503/packages/sidecar/src/providers/factory.ts),
[Code usage 계약](https://github.com/mposition/TomverseCode/blob/85e13c552157402d4e33c8a9d5e346f321bca503/packages/protocol/src/common.ts).

## 3. 원안의 채택·보정

### 3.1 llm-core는 추론 연결부, 도구 실행기나 권한 주체가 아님

채택: provider 요청/응답·stream 이벤트·usage/error 정규화, 지원 capability, 취소,
structured output/tool-call 표현, 공통 적합성 테스트.
제품 prompt, 모델 선택의 사업 정책, 사용자 entitlement, 결제 원장, Memory DB,
자격증명 저장, 파일/셸/MCP 실행 권한은 포함하지 않습니다.

tool calling은 **요청의 표현/파싱**과 **실제 실행**을 분리합니다. Code의 Rust Policy Gate를
공통 모듈이 우회하지 않으며 웹의 승인/권한 경계도 그대로 둡니다. Studio의 이미지/비동기
작업을 chat-token 스트림에 억지로 맞추지 않고 modality별 capability/port로 분리합니다.

추출의 첫 후보는 Code 내부의 provider transport·metadata/error 경계입니다. 코딩 prompt와
DraftProposal은 Code adapter에 남깁니다. OpenAI/Anthropic 등 **실제로 두 소비자가 사용할
최소 조합**으로 가짜 공급자/기록된 비민감 fixture 적합성을 확인합니다. 실사용 소비자가
하나뿐이면 로컬 모듈로 남기는 선택도 허용하며 네 제품 전체 이관을 완료 조건으로 잡지 않습니다.

### 3.2 공통 Gateway가 모든 재시도를 소유하면 안 됨

웹은 사용자가 첫 토큰을 본 뒤 자동 fallback을 금지하고, 취소·권한/과금 준비 실패도
다른 모델로 우회하지 않습니다. Code는 dispatch 여부와 실패 중 남은 usage를 별도로
보존합니다. `retryable: true` 하나로 이 차이를 없애면 재호출·원가·사용자 결과가 바뀝니다.

제품 adapter는 재시도 허용 조건/상한을 결정하고 실행 계층은 승인된 계획 안에서만
attempt를 수행하도록 책임을 나눕니다. SDK·core·Gateway·제품이 제각각 재시도 횟수를
곱하지 않도록 총 시도 예산을 하나로 관리합니다. provider 요청의 실행 여부가 불명확하면
무조건 재전송하지 않으며, 분산 호출에 end-to-end exactly-once를 약속하지 않습니다.

실제 모든 provider attempt 원가와 사용자 산출물 과금은 별개입니다. 기존 credit ledger가
정산 권위로 남고 Gateway의 usage receipt는 근거이지 두 번째 청구가 아닙니다. 이식 시
가격 snapshot/version·잠금 순서·멱등성·환급·reconciliation을 보존합니다. entitlement,
동시 실행 제한, operational guardrail도 하나의 quota 숫자로 합치지 않습니다.

### 3.3 제품 키와 tenant 필드만으로 권한이 생기지 않음

`productKey`는 작업 분류입니다. `tenantId/subjectId/workspaceId/sharingPolicy`를 클라이언트가
보내는 것만으로 접근을 허용해서는 안 됩니다. 인증된 주체·소유권/멤버십·대상 리소스 권한을
서버 또는 로컬 신뢰 경계에서 확인하고 그 결과를 호출 문맥에 결속해야 합니다.

모든 호출에 organization/agent/conversation ID를 강제하지 않습니다. 로컬 Code·게스트·
비대화 이미지 작업에 없는 ID를 지어내지 않고, 실제 실행 유형별 필수/선택 필드를 정합니다.
trace ID와 idempotency key는 인증 수단이 아니며 사용 범위/원본 request를 결속합니다.

현재 개인 계정 모델을 organization tenant 모델로 바꾸는 것은 별도 설계입니다. 웹
`ConversationProject`와 Code 파일 workspace도 이름이 비슷하다고 같은 권한 scope가 아닙니다.
API key에는 필요한 scope만 부여하고, inference key가 Memory 읽기/쓰기까지 자동 획득하지 않게 합니다.

### 3.4 Memory·작업 상태·실행 정책은 세 갈래

공통 provenance·버전·소유자·승인·소비 제품·만료·삭제/철회 계약은 검토할 가치가 있습니다.
그러나 원안의 `preference | decision | fact | task_state | policy`를 모두 현재 MemoryItem
kind에 추가하지 않습니다.

- 선호·근거 있는 사실/사용자 결정: 승인된 서술형 참고 문맥.
- `task_state`: TASK-ORCH-01의 실행/재개 원장. 요약 Memory가 실제 작업 상태를 대체하지 않음.
- `policy`: 누가 승인/발행하는지 분리된 버전 관리 규칙. Review가 생성한 제안은 실행 정책이 아님.

공유 동의와 진실성/권위는 다릅니다. 높은 confidence·민감도 label·사용자의 공유 허용만으로
모델의 제안이 system 지시나 Code의 테스트 기준이 되지 않습니다. 현재 사용자 요청과 충돌한
기억의 처리, 후보 승격, 잠금/삭제된 source 처리도 기존 Memory 정책보다 약해져서는 안 됩니다.

기존 계정 Memory를 product-only로 자동 백필하거나 cross-product로 자동 확대하지 않습니다.
현행 사용 범위·사용자 동의·회귀 영향을 조사한 뒤 migration 범위와 호환 전략을 별도 승인합니다.
첫 유스케이스는 “사용자가 고른 저민감 선호 한 건을 지정된 다른 제품에서 명시적으로 사용”
같은 좁은 연결입니다. 모든 제품의 모든 Memory를 합치는 작업이 아닙니다.

근거: [Memory 정책](https://github.com/mposition/Tomverse/blob/84e47898814ffed192e16c56fe8940317a0506d0/docs/policy/external-conversation-import-and-memory.md),
[Code 사용자 판정 승계](https://github.com/mposition/TomverseCode/blob/85e13c552157402d4e33c8a9d5e346f321bca503/apps/desktop/src-tauri/core/src/session_memory.rs).

### 3.5 Code는 기본 직접 연결, 중앙 동기화는 선택

Code README의 로컬 우선/BYOK를 유지합니다. **Tomverse 서버가 코드를 중계하지 않는다는
뜻이지, 사용자가 선택한 모델 공급자에도 코드가 절대 전송되지 않는다는 뜻은 아닙니다.**
기본 모델 호출은 로컬 runtime → provider이며 중앙 Gateway를 필수 경유시키지 않습니다.

승인된 요약도 비밀·소스 조각·개인정보를 담을 수 있으므로 “요약만이면 안전”하지 않습니다.
공유 전 실제 전송 내용·수신 제품·목적·수명·철회 한계를 보여 주고, 중앙 동기화를 거절해도
기본 로컬 업무가 계속되어야 합니다. 중앙 서비스 장애 중에도 기존 로컬 키/모델 경로를 유지합니다.

동기화에는 항목 revision·멱등키·삭제 tombstone·오래된 기기의 재업로드 방지·충돌 선택이
필요합니다. **오프라인 기기에 이미 내려간 사본의 즉시 회수는 보장할 수 없습니다.** 연결 시
철회 반영과 만료/신선도 제한을 설계하고, 그 보장이 필요한 정보는 오프라인 복제를 허용하지
않는 선택도 제시해야 합니다. 로컬 원본을 사용자가 편집/유지하는 것과 중앙 공유본 철회도 구분합니다.

근거: [Code README](https://github.com/mposition/TomverseCode/blob/85e13c552157402d4e33c8a9d5e346f321bca503/README.md),
[제품 전략 §8.3](https://github.com/mposition/TomverseCode/blob/85e13c552157402d4e33c8a9d5e346f321bca503/docs/design/product-strategy.md).

### 3.6 독립 저장소·서비스는 후속 선택

현재 웹 shared-packages 정책은 브라우저 순수성 목적이므로 서버용 SDK/키 접근을 끼워 넣지
않는다는 원안은 맞습니다. 그러나 **그 제약 하나가 독립 플랫폼 저장소를 강제하지는 않습니다.**
순수 contracts와 서버/로컬 runtime adapter를 분리하고, 초기 소유 저장소·배포 방법·버전 pin·
호환성 검사를 결정하면 됩니다. 검토된 정책 개정과 별도 서버 전용 package 범위도 비교 후보입니다.

우선 기존 배포 안의 명확한 모듈/port로 시작할 수 있습니다. 독립 배포가 실제로 필요한
소비자·팀/릴리스 수명·보안/부하 격리·운영 담당이 확인될 때 서비스 분리를 결정합니다.
공통화가 장애·provider 예산 소진·지연을 모든 제품으로 전파하지 않도록 제품/사용자별 격리가
필요합니다. 이는 점진 이관과 장애 격리 원칙을 Tomverse에 적용한 판단이며, 특정 cloud나
새 인프라 도입 권고는 아닙니다. [Microsoft 점진 이관 패턴](https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig),
[Microsoft 장애 격리 패턴](https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead).

### 3.7 외부 API는 가능성 검증, 가격·판매 승인 아님

API로 기능을 제공할 기술적 방향은 열어 두되, 외부 고객 수요·지원 부담·관측된 단위 원가·
공급자별 계약/데이터 처리 조건을 검토하기 전 상품성을 확정하지 않습니다. 이번에 공급자
재판매/중계 허용 여부를 검증하지 않았고 특정 가격 구조를 승인하지 않았습니다.

BYOK도 중앙 서버가 고객 키를 받는다면 키 보관/해지/로그 마스킹/침해 대응 책임이 생깁니다.
고객이 provider 토큰 비용을 낸다는 것과 플랫폼의 계산·저장·지원·남용 비용이 없다는 것은
다릅니다. 로컬 키 방식과 hosted BYOK를 구분하며 기존 Code 구독 대체와 API 사업 수익을 합산하지 않습니다.

내부 API의 네트워크 공개만으로 외부 상품이 되지 않습니다. 인증/scopes/rotation/revocation,
버전/호환·한도/남용·사용량 분쟁·삭제/보존·지원 책임을 별도로 확정해야 합니다. 이것들은
외부 베타 **이전** 조건입니다. 내부 Gateway라도 인증·권한을 나중 단계로 미루지 않습니다.
Enterprise 조직 Memory·SLA·사용 약정·가격은 첫 베타 범위가 아닙니다.

## 4. 등록 작업과 순서

| ID | 우선순위·상태 | 다음 완료 단위·선행 조건 |
| --- | --- | --- |
| INT-BOUNDARY-01 | **작은 병행 P1, 설계 후보** | 두 저장소의 실제 호출/권한/과금/Memory 책임표 → 필수/선택 식별자와 데이터 흐름 → 실제 재사용 한 경로 → ADR 승인 요청. 전체 플랫폼 구현은 아님 |
| INT-CORE-01 | **조건부 P2**, CODE-01·CHAT-01 연계 | 경계 승인 후 제품 prompt와 transport 분리, 최소 provider 계약/취소/usage/error 적합성, 두 실제 소비자의 버전 고정 시험. CODE-01 완료를 전면 추출에 종속시키지 않음 |
| INT-GATEWAY-01 | **조건부 P2**, 내부 실행 경계 | 두 소비자 재사용 가치 확인 후 기존 예약·정산·routing/trace를 adapter로 연결. 공통 호출 경로 한 개의 failure/중복/비용/지연·rollback 증거. 프로세스 분리와 새 Control Plane 서비스는 선택 사항 |
| INT-MEMORY-01 | **조건부 P2**, MEMORY-01 연계 | provenance·권위·동의·소비 제품·철회 계약부터. Release B 안전 근거와 제품 간 정책 승인 후 저민감 항목 한 건 연결. 기존 기억 전체 자동 공유/이관 금지 |
| INT-CODE-SYNC-01 | **후속 P3** | Code 내부 실사용 및 INT-MEMORY-01 계약 후 승인된 항목만 opt-in 동기화. 로컬 실행 독립·철회/오프라인/충돌 시험. 소스/diff/workspace 자동 전송 없음 |
| INT-API-01 | **후속 P3, 사업 검증** | 먼저 실제 API 고객 업무·내부 사용 증거·원가/권리/지원 조건. 충족 후 한 기능의 비공개 베타 범위 결정. Managed/Enterprise 즉시 개발 아님 |

지금 병행 권고는 **INT-BOUNDARY-01 하나**입니다. 이는 신규 거대 P1이 아니라 추출 전에
필요한 작은 설계 작업이며 CHAT-01/Code 내부 효용을 앞지르지 않습니다. 다음 순서는 계약 →
최소 core 적합성 → 내부 호출 adapter입니다. Memory 계약은 읽기 전용 설계로 병행할 수 있지만
동기화 구현은 별도이며 Gateway 전체 완성이나 외부 API가 선행 조건인 것도 아닙니다.

## 5. 기존 작업과 중복 방지

- CODE-01: Astra 실행/Claude 검토로 내부 업무·구독 축소 가능액 검증은 그대로 진행.
  추론 플랫폼 전체 완성이나 API 상품 수익을 그 작업의 완료 조건으로 추가하지 않음.
- CACHE-01/CHAT-LATENCY-01: 이미 완료한 계측 조사를 공통 usage/trace 계약의 입력으로 사용.
  같은 보고서·측정기를 새 플랫폼 이름으로 다시 개발하지 않음.
- MEMORY-01: 기존 삭제/잠금/추출·주입 게이트를 INT-MEMORY-01이 대체하지 않음.
- CREDIT-CAP-01/AGENT-BILL-01/TASK-ORCH-01: 지출 상한·정산·내구 실행 소유권 유지.
  Gateway를 범용 업무 agent로 확대하거나 task_state를 Memory로 저장해 재개하지 않음.
- NATIVE-01: UI 재사용용 chat-core/chat-ui/api-client 경계와 서버 inference 경계는 별개.
- MCP-01: 공통 tool-call 형식은 커넥터 권한·실행 sandbox·토큰 보관을 완성하지 않음.
- HELP-NAV-01: 도움말 안내 registry는 고객지원 기능이며 중앙 추론 플랫폼의 대체물도 선행 조건도 아님.

## 6. 향후 완료 증거와 이번 검증 범위

각 단계에서 에이전트가 fixture/정답지와 회귀를 준비합니다. 원문/키가 로그에 없는지,
계정·제품 권한 교차 거부, 취소/첫 토큰 후 실패/불확실 dispatch, 가격 snapshot 및 미보고 usage,
동일 요청의 중복 정산, Memory 철회 뒤 구버전 재등장, Code 중앙 장애 독립성을 확인합니다.
유료 적합성 시험은 필요한 공급자·호출 수·예산을 먼저 승인받고 실제 Windows/오프라인 기기
관측과 합성 fixture를 구분합니다. provider 모의 응답 통과를 실제 모델 품질로 쓰지 않습니다.

이번에는 코드/정책의 표적 읽기, 첨부안 대조, 공식 아키텍처 자료 확인과 문서 링크/차이
검사만 수행했습니다. 제품 테스트 재실행·DB 조회·유료 turn·배포는 하지 않았습니다.
Smart Explore는 분석 worktree가 도구의 허용 경로 밖이라 일반 검색과 직접 코드 대조로
보완했습니다. 원문 및 검토·백로그만 공유 브랜치에 기록하며 제품 정책을 직접 개정하지 않습니다.
