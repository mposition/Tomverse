# IDEA-A1 실행 orchestrator·IDEA-A2 추가 제안 검토

- 검토일: 2026-09-15
- 결론: **A1은 제한형 Review task 기반으로 수정 후 등록, A2는 기존 다섯 ART 과제에 병합.**
- A1 ID: TASK-ORCH-01, REVIEW-AGENT-01 하위 P2. 범용화는 별도 후속 P3 검토입니다.
- 상태: 자문 후보 등록. 구현/데이터 정책/가격/유료 실행/배포 승인이 아닙니다.
- [통합 작업 목록](./tomverse-product-idea-backlog.md)

## 1. 분석 기준

이번 턴에도 원격 최신 소스를 fetch했습니다. 미커밋 자료가 있는 detached checkout은
보존하고, HEAD가 최신 develop과 일치하며 깨끗한 별도 worktree에서 분석했습니다.

- develop: `3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6`
- main: `938816f2bcf56a2a289758f6bbb6353ee93ce1c6`
- `smart-explore`는 별도 폴더 접근 제한으로 실패하여 `rg`/표적 파일 읽기로 보완했습니다.
- 코드 구현과 production 상태를 구분합니다. 운영 flag, dispatcher 실행/성공률, 배포 SHA,
  실제 사용자 과금/복구, 경쟁 제품의 실제 성능은 이번에 확인하지 않았습니다.
- 표적 main/develop 비교에서 Memory worker 일부, Deep Research settlement handoff,
  ComparisonReviewRun 기록 코드 등에 차이가 있습니다. develop의 관측 필드를 production
  활성화로 설명하지 않습니다. 기존 이미지·Memory 전 경로를 재감사한 것은 아닙니다.

## 2. A1 문제 정의 — 어디까지 맞는가

| 초안 | 코드 기반 판단 |
| --- | --- |
| artifact 4 step, app-managed search 8 step | 상수와 실제 route에서 확인했습니다. 두 기능을 같이 등록하면 큰 값(8)을 사용합니다. |
| stopWhen을 올려서는 재개가 해결되지 않음 | 채택합니다. 한 요청의 loop 제한과 영속 실행/복구는 다른 문제입니다. |
| 스트림 안에서는 중간 비용 통제가 안 됨 | 보정합니다. 앱 검색은 호출 전에 counter를 선점하며 최대 backend 호출 수를 강제합니다. task 전체/재시도 간 영속 예산이 별도로 필요한 것입니다. |
| 모든 작업이 HTTP 스트림 안에서 끝나며 Deep Research가 유일한 예외 | 사실이 아닙니다. MemoryExtractionRun/Chunk에는 영속 실행·lease fencing·고아 작업 재구동 코드가 있습니다. |
| Deep Research는 provider 폴링뿐 | provider 내부 실행은 위탁하지만, 앱에도 job/result·메시지 확정·정산 복구 handoff가 있습니다. 다만 임의 step 재개 엔진은 아닙니다. |
| 기존 재료 위에 task 예산만 추가하면 됨 | 불충분합니다. 작업 발견/재구동, checkpoint·입력 버전, 취소·삭제 경합, 외부 요청 불명 상태, 결과 저장·정산 복구를 연결해야 합니다. |

권장 문제 문장:

> 일반 Chat/도구 실행에는 승인된 여러 작업 단위를 HTTP 연결과 독립적으로 실행하고,
> 완료 결과·비용을 보존하면서 남은 단위를 재개하는 공통 제품 계약이 없다.

이 문장은 이미 있는 특화 비동기 기능을 지우거나 일반 Chat을 전부 task로 바꾸지 않습니다.
완료된 단위부터 이어가는 재개를 의미하며, 중단된 모델의 내부 추론/토큰을 정확히 그 위치에서
재현하는 약속도 아닙니다.

근거: [Chat 도구 결합/step 한도](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/app/api/chat/route.ts#L3777),
[검색 호출 선점](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/appManagedWebSearchCore.ts#L95),
[Memory dispatcher](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/memoryExtractionWorker.ts#L592),
[Deep Research 결과/정산 handoff](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/prisma/schema.prisma#L1774).

## 3. 재사용할 패턴과 그대로 복사하면 안 되는 것

| 선례 | 재사용 가치 | 대체하지 못하는 것 |
| --- | --- | --- |
| MemoryExtractionRun/Chunk/ProviderCall | 실행권 세대, 원자적 claim, attemptCount, 재시도 제한, 취소/정산, 고아 run의 재구동 | Agent 산출 단위 정의·원문 삭제/권한 계약·일반 task API. Memory 테이블/flag를 공유할 이유는 없음 |
| ImageGenerationGroup/Target/Generation | 논리 산출 슬롯과 실행 시도 분리, 동일 슬롯의 retry, 집계 상태 파생 | 모든 실행 상태를 저장하지 않는 설계. 개별 Generation 상태는 저장됨 |
| ChatRequestLease | 동시성 입장·heartbeat·결정적 해제·만료 정리 | 15분 sweep은 lease 행 삭제이며 미완료 업무 재실행이 아님 |
| RoutingRun/Attempt·manifest | 실제 요청의 출처·모델·시도·최종 manifest 경계 | 사용자 작업/남은 단위의 checkpoint. 특히 finalized manifest 실패는 dispatch 차단이므로 단순 best-effort 로그로 낮추지 않음 |
| PerplexityAsyncJob | provider job ID와 완료 결과, 정산용 근거의 durable handoff | provider 내부 검색/추론 step의 임의 중단·재개 |
| Chat 예약/정산·guardrail·provider 예산 | 기존 금융 primitive와 운영 경계 | 승인한 task 가격·산출 단위별 재개/부분 실패 정산 자체 |

이미지의 “거절 시 행/비용 없음”은 입장 transaction의 작업·예약을 rollback하는 계약입니다.
접수 후 provider가 실행/거절/실패한 모든 경우의 원가·감사 이력까지 0으로 지우는 규칙이
아닙니다. Agent가 이미 호출한 뒤 실패한 기록은 남겨야 합니다.

Memory 구현은 현재 코드의 좋은 선례지만 운영 검증 보증은 아닙니다. 특히 기존
MEM-SOURCE-DELETE-01의 삭제/추출 경합을 해결된 것으로 가정해 재사용하지 않습니다.
신규 작업은 독립적인 삭제·재개·쓰기 경계를 검증하고, 이를 위해 Memory Release B를
활성화할 필요는 없습니다. 기존 금융 잠금 순서도 유지합니다.

근거: [Memory 실행권 claim](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/memoryExtractionService.ts#L548),
[chunk 선점](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/memoryExtractionService.ts#L664),
[Chat lease sweep](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/chatRequestLease.ts#L333),
[이미지 입장 transaction](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/imageGenerationService.ts#L270),
[routing manifest의 fail-closed 계약](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/routingAttemptStore.ts#L3).

## 4. 첫 범위에 필요한 계약

다음은 구현 계획 확정이 아니라 **착수 전 정할 범위와 출시 시 증명할 경계**입니다.
DB/queue 제품 선정, 테이블/enum, 유료 단가를 이 보고서로 승인하지 않습니다.

### 4.1 하나의 제한된 사용자 작업

첫 소비자는 REVIEW-AGENT-01의 사용자가 선택한 Review 항목 일괄 확인입니다. 입력/출처
버전·선택 항목·허용 도구·산출 단위·승인 금액을 고정합니다. 범위나 비용을 늘릴 때는 새
승인이 필요하고, Agent가 스스로 작업 목표·도구 권한·상한을 늘리지 않습니다.

Task(사용자 작업), Run(실행 차수), 내부 step/외부 attempt, 이용 가능한 산출 단위를
개념적으로 구분하되 각각의 이름으로 범용 테이블부터 만들지는 않습니다. 내부 검색 단계는
과금 단위가 아니며, 완료 결과와 실행 상태·정산 상태도 같은 boolean으로 합치지 않습니다.

### 4.2 브라우저와 무관한 실행 및 복구

- 접수/승인/예약이 성립한 작업을 프로세스 종료 후에도 찾을 수 있어야 합니다. durable
  pending 기록과 재구동 경로 또는 그에 준하는 검증된 전달 계약을 둡니다.
- 응답 후 kick은 지연을 줄일 수 있지만 내구성 근거가 아닙니다. 기존 Memory도 이를
  명시적으로 구분합니다. 15분 주기를 그대로 복사하면 사용자 기대를 만족한다는 근거는
  없으므로 복구 지연·대기열 규모·처리 시간의 기준선을 측정합니다.
- 조회/재접속은 실행을 새로 제출하지 않습니다. resume는 확정 완료 단위를 건너뛰며,
  처음부터 rerun하는 요청과 달리 중복 결과/재과금을 만들지 않습니다.
- worker가 외부 호출 후 결과 저장 전에 죽을 수 있습니다. provider가 요청을 받았는지
  알 수 없으면 `unknown`에 해당하는 복구 절차를 두고, provider 조회/지원되는 멱등성으로
  대조하거나 운영 확인/명시적 재시도로 넘깁니다. 무조건 재호출하면서 exactly-once라 하지 않습니다.
- 실행권 세대(fencing)로 오래된 worker의 결과 쓰기를 막습니다. 이것이 이미 실행 중인
  외부 요청을 물리적으로 취소한다는 뜻은 아니며 그 호출의 원가 기록은 별개로 남깁니다.

### 4.3 취소·상한·실제 비용

사용자 승인 상한과 실제 provider/search 원가는 두 장부로 유지합니다. 다음 dispatch 전에
완료 청구·진행 중 약정/예약·남은 작업 예산을 원자적으로 확인합니다. 상태나 상한 확인이
불명확할 때 새 유료 호출을 열지 않습니다. provider가 이미 쓴 비용을 승인액에 맞춰 잘라
기록하지 않으며, 사용자 상한을 초과 원가의 debt로 바꾸지 않습니다.

취소는 후속 호출을 막고 반환/완료 결과를 정리하는 절차입니다. 원격 호출의 취소 지원에
따라 이미 제출한 요청은 비용이 남을 수 있으므로 “중단 즉시 원가 0”을 약속하지 않습니다.
단위 retry, 숨은 SDK retry/fallback, 전체 호출/시간, 계정·전역 동시성, 운영 kill switch를
묶어서 검토합니다. 전역 provider 예산만으로 한 task의 손실 노출이 충분히 제한되지는 않습니다.

정산 구현/가격은 기존 [AGENT-BILL-01 검토](./tomverse-agent-partial-billing-review-2026-09-15.md)에
연결하고 중복 개발로 세지 않습니다. 기존 entitlement와 운영 guardrail의 구분·바닥 및
`lockCreditAccount` 우선 잠금 계약을 유지합니다. 사용자 task 상한은 승인된 작업 한도이지
플랜 권한 위에 몰래 추가한 USD 한도가 아닙니다.

### 4.4 데이터·권한·제품 정체성

- MVP는 로그인한 소유자의 기존 Review 대화/항목에 결속합니다. Task가 Conversation과
  별도라는 것은 실행 상태를 분리한다는 뜻이지 소유권·잠금·삭제 관계를 없앤다는 뜻이 아닙니다.
- 출처가 잠기거나 삭제되거나 계정 권한이 바뀌면 새 step 진입/결과 확정에서 다시 판정합니다.
  삭제 후 worker가 snapshot으로 결과를 부활시키지 않도록 취소·fencing·삭제를 연결합니다.
- step ledger에는 재개에 필요한 구조화 입력/출처 참조·결과·시도 근거를 최소 보존합니다.
  본문/명세/외부 응답·내부 추론을 무조건 복제하지 않고, 새 데이터는 domain registry,
  export·retention·계정/대화/모델 이력 삭제와 연결합니다. 금융 근거와 사용자 본문 보존도 분리합니다.
- Review pilot은 기존 `productKey=review`를 유지하는 방향을 권장합니다. `agent`는 실행
  방식을 가리킬 수 있으므로 새 제품값 추가가 필수는 아닙니다. 별도 제품 정체성을 실제로
  승인할 때만 코드 allowlist·DB CHECK·writer/권한·읽기 경로를 함께 개정합니다.
- 새 Task/Run 테이블과 재개 API도 승인 전 제안입니다. 기존 이미지/Memory 경로를 공통
  엔진으로 일괄 이전하거나 일반 Chat을 강제로 task화하지 않습니다.

근거: [post-response kick과 복구 dispatcher의 차이](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/memoryExtractionWorker.ts#L62),
[제품 정체성 정책](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/docs/policy/conversation-product-key.md#L8).

## 5. A2 추가안 — 중복 등록하지 않고 정교화

기존 [A2 상세 검토](./tomverse-artifact-workspace-strategy-review-2026-09-15.md)의 다섯 작업과
P2/P3 구분을 유지합니다. 이번 요약안으로 D5 승인, 버전별 삭제/권한, turn당 생성 상한,
일반 Chat/Agent 과금 구분을 완화하지 않습니다.

보완은 세 가지입니다.

1. **부분 수정의 대상 식별**: “3페이지의 표”는 렌더러·폰트·문서 수정에 따라 달라질 수
   있습니다. 기준 artifact 버전과 블록/표/셀의 안정적인 식별, 미리보기 선택 위치의 대응이
   필요합니다. 새 결과를 새 버전으로 만들며 이전 버전을 덮어쓰지 않습니다.
2. **대조 모듈의 실제 역할**: `sourceGrounding.ts`는 기존 검증 통계를 표시 값으로 바꾸는
   경계입니다. 실제 인용 대조는 `comparisonReview.ts`의 정규화 후 포함 여부 검사입니다.
   문자열 일치가 주장 전체의 의미적 지지·정확성을 뜻하지 않는 기존 교정은 유지합니다.
3. **crossProvider의 의미**: 두 reviewer provider 식별자가 다른지를 계산합니다.
   `secondary.status`가 completed인지 보는 `dualReviewCompleted`와 별개이므로
   crossProvider=true만으로 두 검토가 성공했다고 말할 수 없습니다. 서로 다른 공급자도
   같은 잘못된 자료·프롬프트 영향을 공유할 수 있습니다. 완료 상태·실제 모델/출처·검토
   순서의 영향을 분리해서 평가하고, 항상 독립된 두 번째 의견이라고 보증하지 않습니다.

다중 답변 비교의 일부 검증 primitive를 재사용할 수 있지만, 단일 파일+원문 검토에는
새 입력/출처/위치·형식 정규화·평가 계약이 필요합니다. 기존 엔진에 파일을 넣기만 하면
동일하게 검증된다는 주장은 하지 않습니다. 제한된 단일 대조는 Task 실행 기반과도 독립적입니다.

근거: [정규화 인용 대조](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/comparisonReview.ts#L139),
[통계 표시 경계](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/sourceGrounding.ts#L1),
[crossProvider/완료 상태 별도 계산](https://github.com/mposition/Tomverse/blob/3cd6fc1e823e2ffcae0bc42cebb3f65d671666b6/lib/comparisonReviewRunCore.ts#L275).

## 6. 경쟁 근거와 차별화 표현

Genspark는 공식 안내에서 브라우저를 닫고 돌아오는 장기 작업 경험을 설명합니다.
이것은 지속 실행 수요의 참고 사례이지만 내부 예산/정산/복구 품질의 비교 증거는 아닙니다.
[Super Agent 공식 안내](https://www.genspark.ai/helpcenter/super-agent).

또 AI Slides에는 업로드 파일/웹을 바탕으로 내용·수치·출처를 확인하고 검증 근거를 표시하는
기능이 안내되어 있습니다. 따라서 “단일 파이프라인 경쟁사는 산출물 검토를 구조적으로 할 수
없다”는 표현은 채택하지 않습니다. 공식 기능 설명은 독립 성능 평가나 내부 multi-provider
구현을 확인한 증거도 아닙니다. [AI Slides 공식 안내](https://www.genspark.ai/helpcenter/ai-slides).

권장 차별화 가설은 **한국어 실무 산출물에 대해 실제 검토 모델·출처·서로 다른 의견·남은
불확실성과 작업별 승인 비용을 투명하게 보여주는 것**입니다. 비용 폭주가 Agent 실패 원인
1위라는 주장이나, Tomverse가 대부분의 경쟁사보다 앞섰다는 주장은 비교 실측 없이는
사용하지 않습니다. 수동/단일 검토 대비 품질·개입·완료 시간·비용의 개선을 검증합니다.

## 7. 우선순위·검증 범위

- 기존 주 투자: Chat → Code 내부 대체 검증 → Native → Memory → MCP를 유지합니다.
- 작은 A2 미리보기 P2를 먼저 하되 A1의 계약/시료는 병행 가능합니다. A2의 전체 Office/
  명세 저장/부분 편집을 A1의 선행 조건으로 두지 않습니다.
- TASK-ORCH-01은 REVIEW-AGENT-01 하위 P2, CREDIT-CAP-01/AGENT-BILL-01과 맞물리는
  실행 범위입니다. 기능 세 개를 독립 과금 엔진/중복 task 엔진으로 계산하지 않습니다.
- 첫 유료 workflow의 사용자 가치와 안전한 복구가 확인된 뒤 다른 실제 소비처의 공통점을
  보고 범용화를 P3에서 판단합니다. 브라우저·코드 sandbox·전화·영상·외부 쓰기·공개 발행은 제외합니다.

향후 검증은 **8개 무과금 구획**부터 준비합니다. 이번에는 아래 검증이나 유료 실행을 하지
않았습니다. 시료/정답지·fake adapter·집계/기록은 에이전트가 준비하고, 실제 호출은 목적·
횟수·예산을 따로 승인받습니다.

1. 접수 transaction 전/후·worker 시작 전 강제 종료: 미접수 작업에 예약 잔존 없음, 접수 작업 재발견.
2. 브라우저 종료/재접속: 동일 task 조회와 완료 단위 보존, 조회가 새 호출/청구를 만들지 않음.
3. lease 만료·worker 중복·늦은 응답: stale 결과 차단, 실제 발생 원가/불명 상태는 유실되지 않음.
4. 호출 직후/결과 저장 전 장애: 외부 실행 불명 상태를 구분하고 자동 무한 replay 방지.
5. 승인 상한·provider/search 예산·병렬 dispatch·취소/완료 경합: 한도 선점과 정산/중단 기준 검증.
6. 원문/대화/계정 삭제·잠금·권한 철회 중 재개: 유출·데이터 부활·다른 사용자 실행 방지.
7. 완료 결과 확정 후 정산 실패·retry/resume: 결과 보존, 원자성 또는 durable handoff와 정산 복구.
8. 대기열 누적·중독 작업·실행 시간 상한: 무한 점유 없이 다음 작업 진행, 복구 지연·누락률 계측.

차단은 데이터 소실·무단 노출/전송·삭제 후 부활·유계성 없는 실제 provider 호출 등 복구
불가 위험부터입니다. 단순 라벨·진행률은 비차단이지만 공개 범위/승인액을 잘못 전달하는 UI는
같은 범주로 면제하지 않습니다. 새 기능의 해당 출시 범위에 적용하며 현재 서비스 전체의
출시를 일괄 차단하는 체크리스트로 확대하지 않습니다.

이번 변경은 통합 자문 목록과 이 검토 문서뿐입니다. 제품 코드·정식 정책·DB·운영 flag는
변경하지 않았고 commit/push·유료 호출·새 작업 생성도 하지 않았습니다.
