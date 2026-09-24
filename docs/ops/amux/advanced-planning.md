# AMUX Advanced Planning and Evidence

상태: `planning/routing implementation complete; agent resolution implemented behind disabled flag; independent review and v1.3 policy approval complete; CI and staging evidence pending`

이 문서는 AMUX 고도화 10개 항목의 개발 분모와 순서를 고정한다. 구현 완료와
staging activation은 별개이며, Agent escalation resolve는 DB/CI·staging 검증
전까지 구현 완료로 보고하지 않는다. 코드와 자동 검증이 완료돼도 실제 비용 한도,
프로젝트 용량, incident 선언은 운영자가 설정하기 전까지 비활성 상태다.

## 권장 순서

| 순서 | 기능 | 완료 기준 |
|---|---|---|
| 0a | task attempt budget | terminal attempt를 append-only로 세고, 상한 소진 시 재큐하지 않고 `blocked`로 전환한다. `expired`는 worker 실패율에 넣지 않는다. |
| 0b | server-authoritative scheduler score | queue와 claim이 같은 DB 사실과 순수 scorer를 사용하고, claim은 caller 숫자가 아니라 서버 재계산 값을 저장한다. |
| 1 | incident mode override | 새 claim/start를 즉시 멈추되 이미 시작돼 durable delivery가 생긴 작업과 heartbeat/settle/recovery는 drain한다. 선언과 해제는 append-only audit에 남고 자동 해제하지 않는다. |
| 2 | richer explainability UI, 기존 증거 | 신규 metric 전에 현재 append-only route evidence와 미측정 상태를 Admin Routing 화면에 표시한다. prompt는 표시하지 않는다. |
| 3 | canonical due/deadline parser와 urgency score | 모호한 날짜를 거부하고 human planning escalation을 열며, UTC instant와 출처를 저장한 뒤 versioned scheduler evidence에 사용한다. |
| 4 | project WIP / concurrency limit | project identity를 명시하고 예약+실행 WIP를 claim transaction 안의 project lock 아래 강제한다. |
| 5 | project/team capacity planning | hard WIP와 분리된 계획 관측으로 처리량·남은 용량·표본 부족을 표시한다. |
| 6 | quota telemetry confidence model | 출처 신뢰도와 freshness를 분리하고, 신뢰도 높은 exhaustion만 hard gate로 사용한다. unknown/stale은 0으로 바꾸지 않는다. |
| 7 | historical success/rework/latency calibration | terminal attempt만 사용하고, 작은 표본과 오래된 표본을 neutral prior 쪽으로 축소하며 표본 수·신뢰도를 함께 노출한다. |
| 8 | cost budget guard | append-only micro-USD 관측과 reservation을 합산한다. finance가 정한 한도가 있을 때만 fail-closed admission을 활성화한다. |
| 9 | human escalation / review specialist routing | human escalation과 model review routing을 분리하고, 명시적 specialty·idempotency·사람 SLA를 보존한다. 작업 검토 resolve는 별도 계약·불변 제안/결정 원장·PR 원문 결속·권한/step-up·staging 검증 뒤 독립 flag로만 연다. 외부 행위 승인은 제외한다. |
| 10 | richer explainability UI, 신규 metric | 앞 단계의 urgency·capacity·quota·calibration·cost·escalation provenance를 같은 화면에 추가한다. |
| 11 | automatic staging evidence capture | serving SHA를 직접 확인하고 secret·prompt·사용자 데이터를 제외한 JSON capture와 digest를 자동 생성한다. 사람의 판정·서명은 채우지 않는다. |

0a는 실패→재큐→같은 worker 재선택의 무한 비용 loop를 먼저 닫고, 0b는 이후 모든
scheduler 입력을 서버 권위로 만든다. Incident brake와 기존 증거 UI를 먼저 두어
새 자동 판단을 추가하기 전에 멈출 수 있고 볼 수 있게 한다. Capacity는 hard WIP와
분리하고, historical·quota confidence가 생긴 뒤에 cost와 specialist 정책을 연결한다.
마지막 UI와 capture는 앞 단계의 같은 evidence DTO를 읽는다.

## 권한과 저장 경계

- due/project/review/cost처럼 admission을 바꾸는 task 사실은 nullable explicit
  column과 revision CAS로 보존한다. `classification`은 분류 근거이지 영구 정책
  identity의 대체물이 아니다.
- worker capability는 `TOMVERSE_AMUX_WORKER_CATALOG_JSON`에서 엄격히
  검증한다. quota 관측은 인증된 internal API로 append-only 저장하되, 관측의
  worker/provider 조합이 같은 catalog와 일치해야 한다.
- incident 현재 상태는 `AppSetting`, 전이는 append-only audit chain이 소유한다.
- project/team window와 budget은 durable policy row가 소유한다. 숫자가 정해지지
  않은 필드는 NULL이며, NULL을 임의 default로 해석하지 않는다.
- ledger evidence가 생긴 budget window는 같은 경계로만 계속 사용한다. 다른
  window로 전환할 때 기존 evidence window와 겹치면 승인된 admin 변경도 거절해
  경계 변경으로 사용액이 0처럼 보이는 일을 막는다.
- provider가 실제 micro-USD를 보고하지 않은 terminal attempt는 예약 추정액을 그
  window의 보수적 사용액으로 유지한다. 관측하지 않은 실제 비용이나 환급을
  발명하지 않으며, 확인된 실제 비용이 들어온 경우에만 append-only settlement
  delta로 정정한다.
- claim 때 사용한 계산 결과는 append-only `AmuxRouteDecision.signals`에 snapshot으로
  남긴다. 이후 설정 변경으로 과거 결정을 재해석하지 않는다.
- 성공·rework·latency는 terminal `AmuxExecutionAttempt`에서만 계산한다.
- 설정 부재는 `unconfigured`로 표시한다. Hard guard가 필요하다고 선언된 scope에서
  값이 없거나 malformed이면 실행을 허용하지 않는다.
- orchestrator는 활성화 중 30초마다 canonical execution-recovery endpoint를 호출한다.
  expired execution·owner claim 회수와 90일 quota observation sweep은 이 주기에서
  구동된다. execution API가 꺼져 있으면 execution mutation은 비활성 응답을 내지만
  selection-only 동안 수집된 quota 관측의 90일 sweep은 계속한다.

## Agent 승인 경계

`docs/policy/development-agent-orchestration.md`의 현재 계약은 Agent 승인을 2인
`AdminActionApproval`로 대신하는 것을 금지한다. 별도 작업 검토 계약은
`docs/policy/amux-agent-approval-contract.md`에 있으며, 기본 꺼짐인
`TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED` 뒤에 구현돼 있다. flag가 꺼져 있으면
`approve`·`retry`·`block` resolve 요청은 `AMUX_AGENT_APPROVAL_UNAVAILABLE`로
fail-closed 거절한다. v1.3 정책은 2026-09-21 승인됐지만 staging 판정과 별도
flag 활성화 승인 전에는 flag를 켜지 않으며,
외부 행위·PR 병합·배포 승인을 이 결정으로 대신하지 않는다.

## 점수와 hard gate

점수는 선호도를 정하고 hard gate는 실행 가능성을 정한다. 둘을 섞지 않는다.

- urgency와 capacity headroom은 scheduler 설명 점수다.
- worker/project/team WIP, cost budget, high-confidence quota exhaustion,
  human/specialty requirement, incident freeze는 hard gate다.
- 새 소유권을 얻는 선택 worker 자체가 실행 중 `idle`이고 recognized dispatch
  boundary가 있어야 한다. 다른 worker의 readiness로 대체하지 않으며 busy·stopped·
  isolated·paused·blocked worker는 선택 대상에서 제외한다. 이미 소유된 task의
  `stopped` worker 기동은 별도의 board driver 경로가 맡는다.
- stale quota와 작은 historical sample은 neutral prior로 수축하며 exhaustion이나
  성공 증거로 취급하지 않는다.
- 큐에서 우선순위가 가장 높은 task가 hard gate나 현재 specialist 부재로
  실행되지 않으면 같은 tick에서 다음 task로 내려간다. 한 tick의 routing 조회는
  최대 16개이며 전부 실행 불가하면 다음 tick에서 다음 16개로 순환하여 뒤쪽
  작업의 기아를 막는다. snapshot/claim 오류로 tick이 중단돼도 그 다음 후보에서
  다시 시작한다. 성공한 새 claim은 tick당 하나이고, 다음 tick에는 다시
  최상위부터 살핀다. selection-only는 종전처럼 최상위 후보 하나만 관측한다.
- rolling deploy 중에는 신·구 server와 orchestrator가 모두 교체될 때까지
  `TOMVERSE_AMUX_EXECUTE`를 끈 selection-only로 유지한다. 실행 활성화는
  staging 증거와 사람의 승인을 마친 후에만 한다.

## 운영 결정이 필요한 값

코드는 아래 값을 발명하지 않는다.

- project/team capacity와 WIP limit
- project/team cost budget과 budget window
- task별 cost estimate와 provider quota 관측 출처
- incident reason, ticket, actor와 명시적 해제 승인
- human review가 필요한 task와 review specialty

이 값이 설정되지 않았다는 사실은 Admin UI와 staging capture에 `unconfigured`로
표시한다. 개발 완료율에는 구현·검증 가능한 contract를 포함하고, 실제 운영값과
activation 승인·staging 서명은 배포 상태로 따로 보고한다.

Task metadata sync와 quota telemetry는 각각 task source와 provider wrapper가
인증된 internal API에 보내는 ingress 계약이다. 해당 upstream producer가 아직
배포되지 않은 환경에서는 값을 합성하지 않고 `unconfigured`로 남기며, staging
기록에는 `n/a — producer not deployed`로 범위를 명시한다. Worker가 실제 비용을
보고하지 않은 경우도 동일하게 숫자를 만들지 않고 claim reservation을 보수적으로
유지한다.

롤링 배포 동안에는 `TOMVERSE_AMUX_EXECUTE`를 끈다. 새·구 queue/claim 형식을
모두 이해하는 orchestrator binary와 DB migration·Next.js server를 배포한 뒤
양쪽 버전을 대조한다. 새 orchestrator는 구 server가 advanced signal을 주지 않으면
v1 evidence를 만들고, 새 server가 v2 queue를 주면 v2 evidence를 만든다. 그러나
서로 다른 worker readiness 규칙의 버전이 공존하는 동안에는 claim을 시작하지
않는다. staging 검증과 활성화 승인 후 실행 flag를 켠다.

## 자동 staging evidence

자동 캡처는 집계된 관측 사실만 기록한다. task id·prompt·description·사용자 데이터는
포함하지 않고, project/team key는 SHA-256 fingerprint로만 남긴다. 캡처 프로세스의
Railway/Vercel 전체 40자리 SHA와 실행자가 지정한 예상 SHA가 다르면 파일을 만들지
않는다. 이는 별도 HTTP probe가 아니라 캡처가 실행되는 배포 프로세스의 revision
대조라는 범위를 필드명에도 그대로 기록한다.
파일은 exclusive-create이므로 기존 증거를 덮어쓰지 않는다. 캡처는 사람 판정이나
서명을 만들지 않으며, 해당 칸은 명시적으로 `null`이다. 관측 artifact 전체 digest와
함께 capture 시각·quota age를 제외한 stable state digest도 기록한다.

스테이징 서비스 shell의 bash, 배포된 Tomverse 폴더 안. 배포 환경변수와 staging DB
읽기 권한이 필요하며 production 자격증명은 필요하지 않습니다. DB는 읽기 전용이고,
지정한 새 JSON 파일 하나만 생성됩니다. 잘못 만든 파일은 증거로 채택하지 않은 뒤
그 파일만 삭제하면 되며, 기존 파일은 덮어쓰지 않습니다.

```bash
npm run capture:amux-staging-evidence -- --expected-deploy-sha FULL_40_CHARACTER_SHA --output ./evidence/amux-staging.json
```
