# Development Agent Orchestration

상태: **승인됨.** 운영자 `mposition`이 2026-09-22에 버전 2 본문을 승인했다. 같은 운영자가 2026-09-24에 버전 3의 수동 promotion pilot 절을 승인했다. 같은 운영자가 2026-09-24에 버전 4의 소스 reconciliation 적용 경로를 승인했다. 그 경로의 코드 래치는 꺼진 채로 출고했다. 같은 운영자가 2026-09-24에 버전 5로 그 코드 래치를 켰다. 그 승인은 운영 revision을 쓰지 않고, `amux_authority`로 넘어가지 않는다. 같은 운영자가 2026-09-24에 버전 6으로 promotion pilot의 코드 래치를 켰다. 그 승인은 카드를 승격하지 않고, 환경 변수를 켜지 않으며, worker 실행과 `amux_authority`를 열지 않는다. 같은 운영자가 2026-09-24에 버전 7로 추천 풀과 카드별 승인, 보류, 거절을 승인했다. 그 승인은 코드 래치를 끈 채로 두고, 자동 승격을 열지 않으며, 환경 변수를 설정하지 않고, worker 실행을 열지 않는다. 버전 7의 구현은 이 절에 대한 독립 검토 뒤에만 시작한다. 같은 운영자가 2026-09-25에 버전 8로 제한 자동 승격의 졸업 조건, 비용 상한, worker 격리, 승인 유효기간, kill switch를 승인했다. 그 승인은 자동 승격 코드 래치를 끈 채로 두고, 환경 변수를 설정하지 않으며, 용량 행을 넣지 않고, worker 실행을 열지 않는다. 버전 8의 구현은 이 절에 대한 독립 검토 뒤에만 시작한다. 같은 운영자가 2026-09-27에 버전 9로 자동 승격 코드 래치를 켰다. 요청 스키마의 policyVersion은 8로 남는다. 그 승인은 사람 결정 20건을 만들지 않고, 용량 행을 넣지 않으며, 추천 풀 코드 래치를 켜지 않고, 환경 변수를 설정하지 않으며, worker 실행을 열지 않는다. 같은 운영자가 2026-09-28에 버전 10으로 추천 풀 코드 래치를 켰다. 요청 스키마의 policyVersion은 7로 남는다. 그 승인은 사람 결정 20건을 만들지 않고, 용량 행을 넣지 않으며, 환경 변수를 설정하지 않고, worker 실행을 열지 않는다. 자동 승격 코드 래치는 버전 9의 true로 남는다. 같은 운영자가 2026-09-28에 버전 11로 추천 용량 행 writer를 승인했다. 요청은 `policyVersion` 11이고, `active`와 1 이상 10000 이하의 정수 `wipLimit`만 담는다. 그 승인은 한도를 고르지 않고, 사람 결정 20건을 만들지 않으며, 카드 status를 바꾸지 않고, 환경 변수를 설정하지 않으며, worker 실행을 열지 않는다. 같은 운영자가 2026-09-28에 버전 12로 앱 내부 engineering adapter를 두 번째 앱 경계로 인정하는 Authority 절을 승인했다. 그 승인은 adapter의 코드 래치를 끈 채로 두고, worker 실행, 환경 변수, 용량 행, 자동 승격을 바꾸지 않는다. 같은 운영자가 2026-09-28에 버전 13으로 개발용 WSL runner 예외를 승인했다. 그 승인은 코드 래치를 끈 채로 두고, Railway 실행 원칙을 삭제하지 않으며, worker 실행과 환경 변수를 켜지 않는다. 같은 운영자가 2026-09-28에 버전 14로 그 코드 래치를 켰다. 환경 변수 `TOMVERSE_AMUX_WSL_BRIDGE`가 정확히 `1`일 때만 runner가 열린다. 그 승인은 환경 변수를 설정하지 않고, `TOMVERSE_AMUX_EXECUTE`를 켜지 않으며, worker 프로세스를 시작하지 않는다. 같은 운영자가 2026-09-29에 버전 15로 WSL 실행 루프의 연결을 승인했다. claim 전용 모드, 로컬 카드를 실행 영수증으로 쓰는 결과 정산, 승격 카드의 사람 Review 강제, backlog 카드 메타데이터 writer, 자동 승격의 항목 결속·시스템 소비·비용 장부·만료·halt와 사람 재개다. 그 승인은 새 환경 변수를 설정하지 않고, 병합·배포·활성화를 포함하지 않는다. 같은 운영자가 2026-09-29에 버전 16으로 역할 판정(결정적 기준값과 LLM의 상향 신호)과 `design → develop → test → review` 단계 사이클, 실제 실행 provider에 기반한 교차 검토를 승인했다. 그 승인은 단계 사이클 코드 래치를 끈 채로 두고, 환경 변수를 설정하지 않으며, worker catalog와 WSL 세션을 바꾸지 않는다. 같은 운영자가 2026-09-29에 버전 17로 버전 7의 추천 풀 Admin 화면 위치 문장을 개정했다. 화면은 owner에게만 AMUX 내비게이션에 나타나고, 다른 역할에게는 광고하지 않는다는 원래 취지는 유지한다. 같은 운영자가 2026-09-29에 버전 18로 실행 API 게이트를 코드 래치(true로 출고)와 환경 변수 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`의 결합으로 정하고, Phase A 절의 비활성 문장을 개정했다. 그 승인은 환경 변수를 바꾸지 않고, late COMMIT 성공 기록 방지가 증명됐다고 주장하지 않으며, `develop`의 AMUX를 `main`으로 옮기는 병합에 그 증명 테스트를 조건으로 둔다. 같은 운영자가 2026-09-29에 버전 19로 버전 18의 활성화 증거 절을 갱신했다. late COMMIT을 DB가 COMMIT 시점에 거부하는 장치와 그 테스트가 `develop`에서 `routing` 레인을 통과했다는 사실을 run 링크와 head SHA로 기록하고, 남는 구간을 적는다. 그 승인은 `main` 이식 조건의 2와 3을 면제하지 않고, 환경 변수를 바꾸지 않는다. 같은 운영자가 2026-09-30에 버전 20으로 orchestrator 정지와 재시작을 승인했다. 알려진 답만 지금처럼 처리하고, 결과 불명 쓰기와 그 밖의 응답에서는 프로세스를 끝내지 않고 앱 DB에 기록하는 정지로 들어가며, 쓰기 접수와 영수증으로 기록 전 종료도 잡는다. 해제는 owner와 최근 step-up의 사람 조작뿐이다. 그 승인은 환경 변수와 Railway 재시작 정책을 바꾸지 않고, 외부 알림을 만들지 않으며, WSL bridge와 실행 모드를 바꾸지 않는다. 같은 운영자가 2026-09-30에 버전 21로 버전 20 절 5의 데이터 도메인 레지스트리 문장을 개정했다. 레지스트리에는 사람의 id를 가진 `AmuxOrchestratorHalt`만 등록한다. 그 승인은 동작, 테이블, 보존 규칙을 바꾸지 않는다. 공개 저장소에 버전 2 본문이 기록되기 전에는 공개 v1이 저장소상의 승인 정책으로 남는다.
상태(v22 이력): **v22 설계 승인, 구현·운영 활성화 별도.** 2026-09-30 운영자 `mposition`이 아래 v22 절을 승인했다. 이전 상태 문단은 v1~v21의 이력이다.
상태(v23 이력): **v23 전용 Ubuntu runner 실행 위치 승인, 운영 활성화 별도.** 2026-10-01 운영자 `mposition`이 아래 v23 절을 승인했다. Claude의 독립 검토에서 정책 문구 승인 차단 사항이 없음을 확인했다. 이전 v22 상태 줄은 이력이다.
상태(v24 이력): **v24 Ubuntu AMUX invariant 관측 게이트 정정 승인.** 2026-10-02 운영자 `mposition`이 아래 v24 절을 승인했다(그 절의 승인 기록). v23 활성화 게이트 2의 “AMUX invariant confidence가 healthy” 문장은 v24 절의 계약으로 대체됐다. 이전 v23 상태 줄은 이력이다.
상태(v25 이력): **v25 engineering adapter 코드 래치 승인.** 2026-10-07 운영자 `mposition`이 아래 v25 절을 승인했다. `ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH`는 true가 된다. engineering 운영 mode는 `off`로 남으므로 이 승인 자체로 어떤 adapter 호출도 AMUX에 닿지 않는다. 이전 v24 상태 줄은 이력이다.
상태(v27 이력): **v27 전용 Ubuntu runner worker 목록·Decision Maker 실행 주체 승인, 운영 활성화 별도.** 2026-10-09 운영자 `mposition`이 아래 v27 절을 승인했다. 이전 v25 상태 줄은 이력이다. 아래 v27 절은 전용 Ubuntu runner의 worker 목록을 바꾸고(Devin 제거, Cursor·GitHub Copilot worker 여섯 추가) Decision Maker 실행 주체 둘을 더하는 후보다. 운영자가 승인을 기록하기 전에는 효력이 없고 `상태(최신)`은 v25로 남는다. 이 후보는 코드, 래치, 환경 변수를 바꾸지 않는다.
상태(최신): **v28 AMUX Orchestrator의 Railway 선언을 `Tomverse Agents` project의 IaC로 승인, 이전은 운영자 단계.** 2026-10-09 운영자 `mposition`이 아래 v28 절을 승인했다. 그 절의 이전 절차를 마치기 전에는 버전 20 9·10항대로 `Tomverse` project의 대시보드가 이 서비스의 설정을 정한다. 이전 v27 상태 줄은 이력이다.
approvedBy: mposition · approvedAt: 2026-09-22 · 정책 버전: 2
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 3
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 4
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 5
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 6
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 7
approvedBy: mposition · approvedAt: 2026-09-25 · 정책 버전: 8
approvedBy: mposition · approvedAt: 2026-09-27 · 정책 버전: 9
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 10
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 11
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 12
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 13
approvedBy: mposition · approvedAt: 2026-09-28 · 정책 버전: 14
approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 15
approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 16
approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 17
approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 18
approvedBy: mposition · approvedAt: 2026-09-29 · 정책 버전: 19
approvedBy: mposition · approvedAt: 2026-09-30 · 정책 버전: 20
approvedBy: mposition · approvedAt: 2026-09-30 · 정책 버전: 21
approvedBy: mposition · approvedAt: 2026-09-30 · 정책 버전: 22
approvedBy: mposition · approvedAt: 2026-10-01 · 정책 버전: 23
approvedBy: mposition · approvedAt: 2026-10-02 · 정책 버전: 24
approvedBy: mposition · approvedAt: 2026-10-07 · 정책 버전: 25
approvedBy: mposition · approvedAt: 2026-10-09 · 정책 버전: 28

버전 22는 아래의 포트폴리오→Task DAG→worker→운영자 완료 판정 계약을 승인한다. **설계 승인이지 현재 코드·migration·운영 스위치·자동 병합/배포 활성화의 증거가 아니다.** 버전 16의 한 카드 단계 순환은 v22 신규 Task에 더 이상 적용하지 않으며, 기존 카드의 기록과 안전한 이행 전 상태는 보존한다.

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-21 mposition | 최초 승인. 병합 당시 본문에 두 가지를 더한 상태를 승인한다 — Agent 승인은 2인 승인(`AdminActionApproval`)이 아니라는 공통 기반 §0 결정(PR #1583)과, 개별 Agent 정책과의 경계(PR #1586) |
| 2 | 2026-09-22 mposition | Phase A selection-only 경계와 stage-C 비실행 catalog import 계약을 추가한다. 같은 운영자의 prepared row self-approval을 1인 조직 예외로 승인한다. v1의 2인 승인과 sole-approver 경계를 유지한다. |
| 3 | 2026-09-24 mposition | 사람이 고른 1~3개 backlog 카드의 수동 promotion pilot. 코드 래치는 끈 채로 둔다. 자동 승격, worker 실행, 유료 호출, 사용자 크레딧, 현황판 cutover는 열지 않는다. |
| 4 | 2026-09-24 mposition | 카드별 accept 또는 reject만 받는 append-only source reconciliation 적용 경로. 코드 래치는 끈 채로 둔다. source 컬럼 overwrite, revision delete, lifecycle 변경, 현황판 cutover는 열지 않는다. |
| 5 | 2026-09-24 mposition | #1662 배포 `4265e173422915516eee0e4b9dda3bc519ca47c3` 뒤, J의 운영 read-back을 위해 reconciliation 코드 래치를 켠다. 환경 값이 정확히 `enabled`일 때만 apply가 열린다. 이 버전은 revision을 쓰지 않고 `amux_authority`와 현황판 동결을 열지 않는다. |
| 6 | 2026-09-24 mposition | 운영자가 2026-09-24에 적은 E pilot 세 카드(`OPS-JOBS-DELAYED-01`, `MOBILE-HEADER-NARROW-01`, `STARTER-LAYOUT-01`)를 위해 promotion 코드 래치를 켠다. 환경 변수 `TOMVERSE_AMUX_BOARD_PROMOTE`가 정확히 `enabled`일 때만 apply가 열린다. 이 버전은 카드를 승격하지 않고, 환경 변수를 설정하지 않으며, worker 실행과 `amux_authority`를 열지 않는다. |
| 7 | 2026-09-24 mposition | backlog 추천 풀과 카드별 사람 승인, 보류, 거절. 풀은 새 카드 status가 아니다. 코드 래치는 끈 채로 둔다. 용량 행을 넣지 않고, 자동 승격과 worker 실행을 열지 않는다. |
| 8 | 2026-09-25 mposition | 제한 자동 승격의 졸업 조건과 꺼진 게이트. 사람 결정 20건과 14일, 1회 US$5·24시간 US$15·30일 US$100, 자동 경로의 전역 3과 worker당 1, 사전 승인 7일, 카드 하나당 트랜잭션 하나, 중대 위반 1건 또는 15분 안 결과 불명 2건. 코드 래치는 끈 채로 둔다. 용량 행을 넣지 않고 worker 실행을 열지 않는다. |
| 9 | 2026-09-27 mposition | 자동 승격 코드 래치를 켠다. 요청 스키마의 policyVersion은 8로 남는다. 환경 변수 `TOMVERSE_AMUX_BOARD_AUTO_PROMOTE`가 정확히 `enabled`일 때만 grant와 소비가 열린다. 이 버전은 사람 결정 20건과 용량 행을 만들지 않고, 추천 풀 래치와 worker 실행을 열지 않는다. |
| 10 | 2026-09-28 mposition | 추천 풀 코드 래치를 켠다. 요청 스키마의 policyVersion은 7로 남는다. 환경 변수 `TOMVERSE_AMUX_BOARD_RECOMMEND`가 정확히 `enabled`일 때만 prepare와 승인, 보류, 거절이 열린다. 이 버전은 사람 결정 20건과 용량 행을 만들지 않고, 환경 변수를 설정하지 않으며, worker 실행을 열지 않는다. 자동 승격 코드 래치는 true로 남는다. |
| 11 | 2026-09-28 mposition | 추천 용량 행 writer. owner와 최근 step-up이 `id` `queue` 한 행을 upsert한다. 요청의 `policyVersion`은 11이고 `wipLimit`는 1 이상 10000 이하의 정수다. 이 버전은 한도를 고르지 않고, 카드 status를 바꾸지 않으며, 환경 변수를 설정하지 않고, worker 실행을 열지 않는다. |
| 12 | 2026-09-28 mposition | Authority 절: 개별 Agent 정책이 승인한 앱 내부 adapter를 두 번째 앱 경계로 인정한다. 허용 동작은 worker 등록·heartbeat, claim, execution start·heartbeat·settle(결과는 `review`·`todo`·`blocked`뿐), delivery pull·ack, review 대상 PR 번호, settle 시점 비용 원장뿐이다. recover, 승격, 승인, 카드 수정, `done`은 열지 않는다. 승인된 adapter는 `engineering` 하나다. adapter 코드 래치는 끈 채로 둔다. |
| 13 | 2026-09-28 mposition | 개발용 WSL runner를 명시적 예외로 둔다. Agent별 Railway 실행 원칙은 그대로다. 코드 래치는 끈 채로 둔다. 연결 계약은 `docs/ops/amux/wsl-execution-bridge.md`다. worker 실행과 환경 변수는 켜지 않는다. |
| 14 | 2026-09-28 mposition | 개발용 WSL runner의 코드 래치를 켠다. 환경 변수 `TOMVERSE_AMUX_WSL_BRIDGE`가 정확히 `1`일 때만 runner가 `bridge_tick`에 들어간다. 이 버전은 그 환경 변수를 설정하지 않고, `TOMVERSE_AMUX_EXECUTE`를 켜지 않으며, worker 프로세스를 시작하지 않는다. 자격증명 격리의 실측을 이 승인이 대신하지 않는다. |
| 15 | 2026-09-29 mposition | WSL 실행 루프 연결. 로컬 AMUX가 만든 카드를 실행 영수증으로 허용하고 그 종료 상태를 `review`·`blocked` 정산 신호로 쓴다. claim 전용 모드(`TOMVERSE_AMUX_CLAIM`), 승격 카드의 사람 Review 강제, settle의 review PR 번호, backlog 카드 메타데이터 writer(`TOMVERSE_AMUX_BACKLOG_METADATA`), 자동 승격 grant의 항목 결속·시스템 소비·비용 장부·만료·halt와 사람 재개. 새 환경 변수를 설정하지 않고 병합·배포·활성화를 포함하지 않는다. |
| 16 | 2026-09-29 mposition | 역할 판정과 단계 사이클. 결정적 기준값(`chore`·`implementation`·`contract`)에 LLM 신호는 상향만 한다. LLM 호출은 제품 DB 자격증명 없는 AMUX Orchestrator가 전용 키로 하고, 모델은 owner가 Admin에서 고른다(기본 `gpt-6-sol`). 단계 카드는 `design → develop → test → review`를 지나며 chore는 `develop → review`다. review는 develop의 확인된 실행 provider와 다른 provider가 맡는다. 버전 15의 완료 신호를 review 단계에서만 개정한다. 단계 사이클 코드 래치는 끈 채로 둔다. 환경 변수, worker catalog, WSL 세션은 바꾸지 않는다. |
| 17 | 2026-09-29 mposition | 버전 7의 추천 풀 Admin 화면 문장 개정. 화면은 owner 전용 `/admin/amux-promotion?tab=recommendation`이고 owner에게만 내비게이션에 나타난다. owner가 아닌 역할의 내비게이션, 검색, 탭에는 나타나지 않는다. 옛 경로는 redirect로 유지한다. 권한, 래치, 환경 변수는 바꾸지 않는다. |
| 18 | 2026-09-29 mposition | 실행 API 게이트. 코드 래치 `AMUX_EXECUTION_API_CODE_LATCH`(true로 출고)와 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`(trim 후 `1`)가 모두 참일 때만 실행 API가 열리며 `NODE_ENV`와 무관하다. Phase A 절의 비활성 문장을 이 조건으로 개정한다. local process executor 금지와 engineering adapter 래치는 그대로다. late COMMIT 성공 기록 방지 테스트가 아직 없음을 기록하고, `develop` AMUX의 `main` 병합은 그 테스트가 `routing` 레인에서 head SHA 녹색일 때만 한다. 환경 변수는 바꾸지 않는다. |
| 19 | 2026-09-29 mposition | 버전 18의 활성화 증거 절 갱신. late COMMIT을 deferred constraint trigger가 COMMIT 시점에 `AX001`로 거부하는 장치(migration `20260929200000_amux_commit_deadline_check`)와 그 DB 테스트가 #1765 head `4339769bf`에서 `routing` 레인을 통과했음을 run 링크와 함께 기록한다. 남는 구간을 적는다. `main` 이식 PR은 자기 head SHA에서 같은 레인을 다시 통과해야 한다. 환경 변수는 바꾸지 않는다. |
| 20 | 2026-09-30 mposition | orchestrator 정지와 재시작. 알려진 답만 지금처럼 처리하고, 그 밖의 응답·무응답과 선택 읽기 61번째 연속 실패에서 프로세스를 끝내지 않고 앱 DB `AmuxOrchestratorHalt`에 기록하는 정지로 들어간다. 쓰기 호출은 처리 전에 접수를 커밋하고 쓰기와 같은 트랜잭션에 영수증을 남겨, 기한이 지난 뒤 영수증이 없으면 롤백 확정, 있으면 사람 확인으로 가른다. 해제는 owner와 최근 step-up의 Admin 조작과 사람 감사로만 하며 원래 작업을 다시 하지 않는다. 구현 배포 뒤 Railway 재시작 정책을 `On Failure`로 명시한다. 환경 변수, 외부 알림, WSL bridge, 실행 모드는 바꾸지 않는다. |
| 21 | 2026-09-30 mposition | 버전 20 절 5의 데이터 도메인 레지스트리 문장 개정. 사람의 id를 가진 `AmuxOrchestratorHalt`만 레지스트리에 운영 기록으로 등록하고, 사용자 데이터가 없는 `AmuxOrchestratorWrite`와 `AmuxOrchestratorWriteReceipt`는 레지스트리 대상이 아니다. 세 테이블 모두 고객 export에 넣지 않는다. 동작, 테이블, 보존 규칙, 해제 조건은 바꾸지 않는다. |
| 22 | 2026-09-30 mposition | 전략적 계층·점수와 자동 실행 풀 편입, 별도 Task DAG·실행 등급, 병행/SEV1 예약, develop과 main의 PR·배포 권한 분리, 운영자 최종 완료, 실패 복구·결과 환류, 전 worker CLI 토큰 계측, Admin Kanban·계층 목록을 승인한다. 기존 v16 단계 순환은 새 카드에 적용하지 않는다. 이 승인 자체로 migration·flag·Publisher 권한·자동 병합/배포를 켜지 않는다. |
| 23 | 2026-10-01 mposition | 운영자 워크스테이션 WSL runner를 전용 Ubuntu 서버로 이전하는 실행 위치 예외. 아래 v23 절의 격리·중복 실행 방지·활성화 검증을 충족한 경우에만 적용한다. 이 승인 자체로 제품 bridge·claim·실행 API를 켜지 않는다. |
| 24 | 2026-10-02 mposition | v23의 AMUX invariant confidence 일괄 `healthy` 요구를 실패 0건·unknown 사유별 증거 계약으로 정정한다. 다른 활성화 게이트와 권한은 바꾸지 않는다. 이 승인 자체로 bridge·claim·제품 실행을 켜지 않는다. |
| 25 | 2026-10-07 mposition | engineering adapter의 코드 래치 `ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH`를 켠다. adapter의 모든 AMUX writer 호출은 이 래치, 버전 18의 실행 API 게이트, `off`가 아닌 engineering 운영 mode가 모두 참일 때만 열린다(Authority 절). 버전 12의 허용 동작 목록, 환경 변수, worker catalog, 용량 행, 자동 승격, Railway 서비스, 게시 App, engineering mode는 바꾸지 않는다. |
| 27 | 2026-10-09 mposition | 전용 Ubuntu runner의 worker 목록 변경. 2026-10-09 운영자 지시로 제거한 `devin-worker`를 기록하고 `cursor-chore`·`cursor-impl`·`cursor-worker`·`copilot-chore`·`copilot-impl`·`copilot-worker`를 더해 13개로 한다. 새 로그인 둘의 권한 목록, 실행마다의 실제 모델·공급사 기록, v22의 사용량 사건이 확인되고 운영자가 따로 활성화하기 전에는 여섯이 제품 claim·dispatch 대상이 아니며, v16 교차 검토와 Decision Maker 라우팅에는 별도 버전 전까지 들지 않는다. Decision Maker 실행 주체 둘을 docs/policy/amux-decision-maker.md §5의 격리 조건 그대로 더한다. 이 버전 자체로 bridge·claim·실행 API·DM 스위치를 켜지 않는다. |
| 28 | 2026-10-09 mposition | Railway 서비스 `AMUX Orchestrator`를 `Tomverse` project의 대시보드 관리에서 `Tomverse Agents` project의 IaC 선언(`.railway/agent-runners.ts`)으로 옮긴다. 버전 20 9항의 재시작 정책(`On Failure`, 최대 10회)과 10항의 `checkSuites: false`를 그 선언이 정한다. 변수 목록은 다섯 이름이며 명령 실행을 여는 이름은 없다. orchestrator 코드, 정지·재시작 동작, claim·실행 API·worker catalog 값은 바꾸지 않는다. |

v1 행은 역사적 승인 기록으로 남는다. v2는 이 표의 행과 상태 줄이 공개 저장소 파일에 함께 기록되어야 저장소상 효력을 가진다. 개별 Agent의 승인 정책을 이 문서의 승인으로 간주하지 않는다.

공통 Agent 기반 원칙 1은 승인된 정책 버전과 `approvedBy`·`approvedAt`이 기록되기 전에 구현을 시작하지 못한다고 정한다. 이 후보가 공개 저장소에 병합되더라도 그 셋이 기록되기 전에는 구현 권한이 생기지 않는다.

## Scope

Tomverse의 개발 Agent 팀은 `tomverse-orchestrator`를 통해 실행한다. 버전 13은 그 원칙 아래의 개발용 예외다. 운영자 워크스테이션의 WSL runner가 승인된 작업을 밖으로 나가지 않는 연결로 가져온다. Railway 실행 원칙을 지우지 않는다. 버전 14가 그 예외의 코드 래치를 켠다. 환경 변수가 정확히 `1`이 아니면 runner는 열리지 않고, 이 버전이 그 변수를 설정하지는 않는다.

이 문서는 **모든** 개발 Agent worker의 실행 제어를 정한다. 우선순위, 소유권,
선택과 실행의 분리, 실행 권한, 승인과 감사의 경계가 여기 있다.

**개별 Agent의 권한은 여기 적지 않는다.** 어떤 입력을 작업으로 인정하는지,
그 결과물이 공개 저장소와 쓰기 가능 자격증명에 어디까지 닿는지는 그 Agent의
정책 문서가 정한다. engineering Agent는 `docs/policy/engineering-agent.md`다.
intake Agent의 승인된 설계와 v4 신규 경로는 `docs/policy/amux-intake.md`다.
한 Agent의 규칙을 여기 올리면 다른 팀의 worker가 그 규칙에 묶인다.

두 문서가 충돌하면 적용 범위가 좁은 쪽이 이긴다.

## Authority

Tomverse 애플리케이션이 작업 상태의 최종 authority다.

Agent worker는 production 데이터베이스를 직접 수정하지 않는다.
모든 작업 claim, 상태 전환, 승인, 감사 기록은 앱 경계를 통한다. 앱 경계는 둘뿐이다.

1. `/api/internal/amux/*` route.
2. **개별 Agent 정책이 승인한 앱 내부 adapter.** 그 Agent의 내부 route가 받은 요청을 AMUX의 writer 함수에 같은 프로세스·같은 트랜잭션으로 넘기는 코드다. 이 경로를 쓰는 Agent의 서비스는 AMUX 내부 route의 자격증명을 갖지 않는다.

adapter는 다음을 지킨다.

- **worker identity는 adapter가 서버에서 정한다.** 한 adapter는 한 worker identity에 고정되며, 요청 본문이 worker를 말하지 않는다.
- **AMUX writer의 규칙을 그대로 지난다.** CAS, lease, fencing, 시도 상한, halt, 결과 불명 처리, 감사는 `/api/internal/amux/*` route가 같은 동작을 할 때와 같다. adapter 전용 전이, 예외, 우회 writer는 없다.
- **허용 동작은 목록뿐이다**: worker 등록과 heartbeat, claim, execution start·heartbeat·settle, delivery pull·ack, review 대상 PR 번호의 기록, settle 시점의 비용 원장 기록. execution settle의 결과 상태는 `review`, `todo`, `blocked`뿐이다. 카드 승격, 승인, 카드 내용 수정, `done`으로의 settle과 작업 검토(`review` → `done`)는 열지 않는다. 만료 실행 회수와 만료 claim 회수는 `/api/internal/amux/*`의 recover route만 하며, adapter는 그 동작을 열지 않는다.
- **잠금 부분 순서.** admission·incident·resource-policy 잠금처럼 기존 AMUX 코드가 execution 행보다 먼저 잡는 선행 잠금은 그대로 둔다. 한 트랜잭션이 execution 행을 둘 이상 잠글 때는 `AmuxWorkerRuntime` → `AmuxExecutionAttempt` → `AmuxWorkItem` → `AmuxWorkDelivery`의 부분 순서를 지킨다. 잠그지 않는 행(INSERT만 하는 attempt 등)은 순서에 넣지 않으며, 잠근 행들의 상대 순서만 지키고, 뒤 행을 잡은 뒤 앞 행으로 돌아가지 않는다. adapter가 같은 트랜잭션에서 Agent 자신의 행을 잠글 때는 AMUX 행 **뒤에** 잠근다. AMUX가 이 순서를 바꾸는 변경은 부착된 adapter의 잠금 순서와 대조한 테스트를 함께 바꾼다.
- **감사**는 AMUX 행과 같은 트랜잭션에서 같은 canonical `AdminAuditLog` chain에 남기며, 아래 Audit 절의 서명 키·연결 검증 규칙이 그대로 적용된다. worker identity는 adapter의 서버 코드 상수이며 요청 본문에서 받지 않는다. AMUX 행의 actor·action· metadata 계약은 AMUX writer가 소유하고 route와 adapter에서 같다. Agent 자신의 행의 actor만 그 Agent 정책이 정한 서버 코드 상수다.
- **worker 등록.** worker registration writer는 외부 트랜잭션 client를 받고, 등록 또는 status·readiness 변경과 canonical system audit를 같은 트랜잭션에서 하는 공통 writer다. 기존 route와 adapter가 모두 이 writer를 쓴다. 순수 lease·heartbeat 갱신만 Audit 절의 telemetry 예외를 따른다.
- **비용**: settle 때 그 Agent의 LLM 사용액을 AMUX 비용 원장에 AMUX writer로 기록한다. 사용자 크레딧과 섞지 않고, execution의 예약·정산 차액이나 admission 합계에 넣지 않는다. 그 금액을 admission에 쓰는 것은 별도 버전이다.
- adapter route의 secret과 AMUX 내부 route의 secret은 서로 다르고, 어느 쪽도 다른 쪽 route를 통과하지 못한다.

승인된 adapter는 `engineering` 하나다(worker identity `engineering-runner`, `docs/policy/engineering-agent.md` §8). adapter를 더하거나 허용 동작을 넓히는 것은 이 문서의 개정이다.

이 개정은 adapter를 켜지 않는다. adapter가 AMUX writer를 부르는 경로는 코드 래치(출고 값 false)와 그 Agent 정책의 운영 mode가 함께 열 때만 동작한다. 래치를 켜는 것은 별도 버전이다. 이 개정은 worker 실행, 환경 변수, 용량 행, 자동 승격을 바꾸지 않는다.

## Scheduling

Global Priority Scheduler는 opt-in 방식으로 운용한다.

Priority ordering은 최소 다음 원칙을 보존한다.

- explicit priority
- starvation prevention through task age
- deterministic tie breaking
- dependency-aware critical-path prioritisation
- human overrides where available

Worker-local pickup 정책과 global scheduling 정책은 별도로 유지한다.

## Concurrency

Task ownership 변경은 compare-and-set 형태여야 한다.

이미 다른 actor가 task ownership 또는 lifecycle state를 변경했다면
router는 해당 변경을 덮어쓰지 않는다.

## Execution boundary

Scheduler의 task 선택은 실행 시작과 분리한다.

선택 자체가 다음 동작을 자동으로 의미하지 않는다.

- task status transition
- lease creation
- attempt creation
- irreversible operation
- external delivery

## Approval

외부 시스템 변경, 배포, 이메일 발송 등 irreversible/high-risk action은
사람의 승인을 통과해야 한다.

Agent 승인은 2인 승인(`AdminActionApproval`)을 쓰지 않는다.
2인 승인은 "관리자 두 사람이 한 action에 동의한다"를 표현하며,
"사람 한 명이 시스템이 만든 초안을 승인한다"를 표현하지 못한다.
Agent 승인은 별도 계약이고, sole-approver 예외 목록은 건드리지 않는다.

v1은 그 별도 계약이 아직 없다고 정했다. 이 v2 후보는 Phase A와 stage-C catalog
import에 한정해 아래 두 절에서 그 공백을 구체화한다. 이것은 기존 2인 승인의
우회도, 새 sole-approver 예외도 아니다. `AdminActionApproval`의 예외 목록과
`docs/policy/admin-sole-approver.md`는 변경하지 않는다.

계약이 승인되고 구현되기 전까지 AMUX의 어떤 경로도 승인을 받았다고 기록하지
않으며, 승인이 필요한 action을 수행하지 않는다. 승인 전 코드가 존재하거나
테스트가 통과해도 그 사실만으로 승인과 활성화를 대체하지 않는다.

## Audit

Scheduler, claim, refusal, approval 결과는 measured/verdict를 포함한
구조화된 audit event로 남긴다.

사람 감사와 시스템 감사는 같은 canonical `AdminAuditLog` chain에 남긴다.
현재 `writeAdminAuditLog`와 `writeSystemAuditLog`는
`adminAuditIntegrityKeys(process.env)[0]`가 없으면 `entryHash=null`로 행을
만들 수 있다. 따라서 Phase A 또는 stage C의 상태 변경은 그 일반 동작에 맡기지
않는다. 구현은 두 기존 함수만 사용하고 감사 테이블에 직접 쓰지 않는다. 서명
키가 하나도 없으면 함수 호출과 트랜잭션 시작 전에 실패한다. 호출 뒤에도 반환된
audit ID의 actor·action·target·비어 있지 않은 `entryHash`와 직전 hash 연결이
검증되지 않으면 전체 변경을 rollback한다.

그 함수는 canonical chain advisory lock을 잡고, 서명 키가 있을 때 `createdAt`을
chain head보다 뒤로 조정할 수 있다. 현재 AMUX boundary의 200ms statement
timeout과 100ms idle timeout 아래에서 이 잠금과 카드 쓰기가 함께 완료된다는
증거는 없다. stage C는 그 DB 통합 증거가 생기기 전에 현재 AMUX boundary를
import transaction에 재사용한다고 가정하지 않는다. 필요한 timeout boundary는
구현 시 측정해 정책 개정 또는 코드 계약으로 확정한다.

이 정책은 매 쓰기마다 전체 과거 chain을 검증한다고 주장하지 않는다. 트랜잭션
안의 검사는 linked row와 직전 연결에 한정한다. 전체 chain 검증은 별도의
verifier가 수행한다. 결속된 행이 없어도 `entryHash`가 비어 있어도 성공으로
기록하지 않는다.

## Phase A selection-only boundary

Phase A에서 검증 가능한 AMUX 능력은 queue read와 routing snapshot의 결정적
선택 판단뿐이다. Tomverse 앱은 task ownership, lifecycle, execution, audit의
최종 authority다. 선택은 작업 소유권 변경, lease·attempt·delivery 생성, Agent
실행, 외부 시스템 변경을 뜻하지 않는다.

`claim`과 그 뒤의 worker 등록·heartbeat, owned queue, execution, delivery,
settlement(이하 실행 API)는 코드 래치 `AMUX_EXECUTION_API_CODE_LATCH`가 true이고,
환경 변수 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`가 trim 후 정확히 `1`일 때만 열린다(버전 18).
판정은 `NODE_ENV`와 무관하다. 둘 중 하나라도 아니면 실행 API는 `execution_api_disabled`로 거절한다. local process executor는
production에서 실행할 수 없으며 환경변수만으로 그 금지를 해제하지 못한다.
이후 실행 허용은 Agent별 승인 정책, 격리된 실행 서비스, 비용·보존·감사 계약과
별도 검증·활성화 결정을 요구한다. 선택 전용 route의 production 활성화도 별도
승인이며, 이 정책 문안만으로 활성화되지 않는다.

DB timeout은 실제 PostgreSQL 버전과 세션에서 읽은 설정값으로만 말한다.
2026-09-22 `develop`의 AMUX DB boundary는 트랜잭션 첫 SQL에서 `set_config(...,
true)`로 다음만 설정한다.

- `statement_timeout`: 200 milliseconds
- `idle_in_transaction_session_timeout`: 100 milliseconds
- session-local deadline marker: `tomverse.amux_deadline`

같은 코드는 `transaction_timeout`을 설정하지 않는다. 마지막 SQL은
`clock_timestamp()`를 deadline과 비교하는 commit fence다. 이것은 COMMIT 완료
시각의 증명이 아니다. 앱의 Prisma timeout, pool 대기, Prisma 호출 수에서 유도한
예산도 PostgreSQL이 강제하는 end-to-end 트랜잭션 상한이 아니다. Prisma 호출
수를 SQL 문장 수로 부르지 않는다.

PostgreSQL 17의 `transaction_timeout` 기본값은 0이고, 0은 비활성이다. 설정값이
`statement_timeout` 또는 `idle_in_transaction_session_timeout`보다 짧으면 더
긴 설정이 무시된다. 같은 값이면 그 비활성 규칙이 적용된다고 말하지 않는다.
PostgreSQL 16에는 이 설정이 없다. 현재 코드가
이 설정을 추가하기 전에는 전체 트랜잭션 점유 상한을 제공한다고 말하지 않는다.
`SET`/`SET LOCAL`의 timer 시작점, SAVEPOINT, pool checkout 대기, durable
`COMMIT`, prepared transaction의 예외를 해당 구현과 같은 DB 버전에서 측정하기
전에도 같은 제한이 적용된다.

응답 유실, timeout, 또는 `COMMIT` 결과가 불명확하면 `outcome_unknown`이다.
앱은 새 claim·실행·재시도를 만들지 않는다. 식별 가능한 request, task, attempt와
canonical audit를 권위 있는 앱 DB에서 다시 읽고 사람에게 판정을 넘긴다.
timeout만으로 미기록을 단정하거나 blind retry하지 않는다. 현재 코드의 fence는
COMMIT 전의 DB-clock 검사이므로, 그 fence만으로 late-success 방지가 증명됐다고
말하지 않는다. 실행 경로 활성화 전에는 같은 DB 통합 테스트가 late COMMIT의
성공 기록 방지와 read-back 식별·멱등을 증명해야 한다.

heartbeat의 필수 계약은 실행 경로를 활성화하는 승인이 아니다. 실행 attempt의
lease를 연장하는 heartbeat는 상태 변경이며 canonical system audit와 같은
트랜잭션에서 처리한다. `AmuxWorkerRuntime`의 고빈도 lease refresh는 worker
status와 dispatch readiness가 모두 변하지 않을 때만 telemetry 예외다. worker
등록과 status·readiness 변경은 예외가 아니다.

이 절은 Agent 결과물 승인, 외부 PR 게시·병합, 배포, 이메일 발송, 유료 provider
호출, 사용자 크레딧 사용, 자동 승격·삭제를 승인하지 않는다.

## Workboard catalog import

Catalog import는 Agent 실행 권한을 부여하지 않는 별도 Admin 동작이다. 아래
정본 설명은 **최초 import 당시의 역사적 상태**다: source board가 제품 작업의
Outstanding 여부와 투자·배정 우선순위의 정본이고, AMUX 카드는 실행
projection이었다. 이후 2026-09-24 별도 운영자 승인과 reconciliation 소비로
`amux_authority` 전환이 이뤄져 현재 상태·우선순위의 정본은 AMUX다. 이 문서의
v22 승인이나 최초 catalog import가 그 cutover를 수행한 것은 아니다.

### Initial population

최초 적용은 적용 시각에 다시 계산한 source의 활성 고유 ID 전부만 대상으로 한다.
추천 순서 참조는 카드가 아니다. 2026-09-22의 65건과 6건은 측정값이며 앞으로
고정하는 승인 개수가 아니다. source가 바뀌면 그 측정값과 digest를 재사용하지
않는다.

최초 이관의 모든 신규 카드는 다음 현재 DB 상태를 만족해야 한다.

- `status=backlog`
- owner와 `claimedAt`이 null
- attempt, delivery, route decision이 없음
- `sourceSystem`, `sourceKey`, `sourceVersion`, `sourceDigest`,
  `sourceSnapshot`이 현재 provenance CHECK의 다섯 필드를 함께 만족함
- `sourceSystem`과 `sourceKey`만 현재 unique pair다. 기존 pair는 재사용하지
  않는다
- `sourceVersion`과 `sourceDigest`는 provenance이며 unique identity의 일부가
  아니다
- `description`은 null

현재 `AmuxWorkItem`에는 `mode`, `executionBrief`, `catalog_only`,
`dispatch_candidate`, `exclude` 컬럼이 없다. 최초 이관은 이 다섯 값을 다른
기존 컬럼의 의미로 저장하지 않는다. 여기에는 `classification`, `kind`,
`priority`, `description`, `sourceSnapshot`이 포함된다. 이 값들은 제출
manifest의 분류일 뿐이며, 최초 제출은 catalog-only 분류, null brief,
exclude 0건, dispatch-candidate 0건이 아니면 쓰기 전에 거절한다. 해당 컬럼이
나중에 필요하면 이 정책의 개정과 migration이 먼저다.

queue read, routing snapshot, claim, priority scoring은 `backlog`를 실행
후보로 읽지 않는다. 현재 scheduler·routing·claim은 literal `todo`와 owner null,
archive null, dependency-ready 조건만 읽는다. 이 기존 조건에 의존해도 되지만,
구현은 DB constraint와 API 회귀로 backlog 제외를 계속 증명해야 한다. 최초
이관은 `todo` 승격, claim, worker 시작, execution flag 활성화, provider 호출,
사용자 크레딧 사용을 만들지 않는다.

현재 schema는 카드 `title`을 nullable이 아닌 `String`으로 요구한다. 그러나 최초
이관은 자유 텍스트 title, status summary, detail Markdown, local path, URL,
credential을 복제하지 않는다. 구현은 안정적인 source key에서 결정적으로 만든
비식별 placeholder title만 저장한다. `sourceSnapshot`도 자유 텍스트를 담지
않고 source key, section code, detail digest, manifest digest, policy version만
담는다. placeholder가 원문 단어나 순번에서 내용을 재구성할 수 있으면 거절한다.
자유 텍스트 저장이 필요하면 data-domain validator의 명시적 예외, 보존·삭제
계약, 정책 테스트가 먼저 승인돼야 하며 가짜 `User` FK는 추가하지 않는다.

### Preview, prepare, and approval

Preview, prepare, approval, apply는 서로 다른 동작이다.

- Preview는 계산과 표시만 한다. 앱 DB domain state, approval row, card, audit
  row를 만들지 않는다. 비공개 manifest를 받으므로 외부에 열지 않는다. 현재
  public permission에는 `amux:import:read`가 없다. 따라서 최초 구현의 preview
  권한은 기존 `owner` Admin role이다. 세션은 `resolveAdminSessionAccessState`
  기준 authorized이고, `isRecentAdminAuthentication` 기준의 최근 step-up을
  통과해야 한다. 전용 permission 이름이 필요하면 `AdminPermission`과 role map,
  route test에 함께 추가하는 별도 정책 개정 뒤에만 사용한다.
- 무쓰기는 앱 DB에 상태 행이 없다는 뜻이다. reverse proxy, APM, access log,
  PostgreSQL error log, browser memory, backup에 본문 흔적이 없다는 뜻이 아니다.
  payload와 거절 원문이 그 경로에 남지 않는다는 증거 없이는 활성화하지 않는다.
- Preview는 계정당 분당 10회를 넘지 않는다. 이 제한은 replay oracle을 줄이기
  위한 제품 제한이며 DoS 방어의 완전한 증명은 아니다. 초과와 scan 거절은 서로
  구별되는 오류 코드만 반환한다.
- Prepare는 명시적 쓰기다. 같은 `owner`, authorized session, 최근 step-up을
  요구한다. prepared row와 canonical human audit는 같은 트랜잭션에 생성한다.
  전용 `amux:import:approve` permission이 role map에 추가되기 전에는 그 이름만
  권한 부여의 근거로 사용하지 않는다.
- Approval은 같은 `owner`가 자신이 만든 prepared row를 승인할 수 있다. 이
  예외는 운영자 `mposition`이 2026-09-22에 이 정확한 v2 본문과 함께 승인했다.
  승인 세션은 authorized이고 최근 step-up을 통과해야 한다. 이것은 v1이 이미
  정한 규칙이 아니라, 1인 운영자 조직에 대한 새 Agent 승인 예외다. 기존 2인
  `AdminActionApproval` 규칙과 sole-approver 목록은 변경하지 않는다.
- Reject, expire, apply, approval consumption도 각각 상태 변경과 canonical
  audit를 같은 트랜잭션에 기록한다. 사람의 전이는 human actor, 자동 expire만
  등록된 system actor를 사용한다.

승인 모델의 제안명은 `AmuxBoardImportApproval`다. 구현 전 이름 변경은 정책
개정 없이는 하지 않지만, 이 문장만으로 schema 이름이 승인된 것은 아니다. 행은
`actorUserId`와 unique `authorizationAuditLogId`를 가진다. `actorUserId`에는
`User` FK를 만들지 않는다. 계정 삭제가 승인 증거를 다시 쓰거나 null로 바꾸면
안 되기 때문이다. 현재 registry 검사는 `userId` 또는 `approvedBy` 형태의 식별
컬럼을 사용자 데이터로 본다. 따라서 이 모델은 registry에 actor row로 등록하고
`subjectReference.kind=none`을 명시한다. 고객에 관한 행이 아니기 때문이다.

account-data export domain에도 등록하되 state는 `excluded`이고 exclusion
reason은 "operator approval evidence, not customer data"다. `included` 또는
`included_filtered`로 등록해 고객 export fetcher를 요구하지 않는다. 운영자의
접근·정정·삭제 요청은 수동 PrivacyRequest 경로로 다루고 legal hold가 purge보다
우선한다.

현재 registry의 관리 감사 `retentionPeriod`와 `retentionPolicyRef`는 `TBD`다.
`legalBasis` 문장은 이미 적혀 있으므로 근거 자체가 비어 있다고 말하지 않는다. 따라서 24시간, 30일,
7년, archive 후 특정 기간 삭제 중 어느 것도 법률상 보존 기간이라고 부르지 않는다.
카드·승인 행·snapshot·log·backup·staging copy의 목록과 security-privacy 및 필요한
법률 검토가 production apply 전에 끝나야 한다. 그 전에는 production apply를
활성화하지 않는다.

### Approval binding and transitions

승인 snapshot은 다음 필드를 한 목록으로 결속한다. 정책, schema, UI, audit는
서로 다른 목록을 사용하지 않는다.

- canonical manifest SHA-256과 canonicalizer version
- source commit SHA와 board digest
- source verification mode와 DB-clock confirmation time
- active item count와 section count
- recommendation-reference count
- create, no-op, conflict, exclude의 source-key list와 count
- 각 execution-brief digest. 최초 이관은 모두 null
- planner, validator, scanner version과 scanner ruleset digest
- policy version
- approver actor ID와 approval row ID
- raw request-body SHA-256. 원문은 감사에 넣지 않는다.

감사 metadata에는 digest, count, version, verification mode, DB timestamp만
남긴다. 제목, 상태 한 줄, brief, secret, URL, local path, scan finding은 감사
summary와 metadata에 넣지 않는다. 현재 `safeSummary`는 500자만 자르므로 구현은
그것만으로 최소화를 대체하지 않는다. audit `targetId`는 approval row ID다.

최초 이관의 source verification mode 값은 `operator_attested`다. 이 v2 본문이
승인되기 전에는 그 필드명도 승인된 구현 계약이 아니다. 서버가 비공개 Git 원격
tip 또는 운영자 PC의 fetch를 독립 검증했다고 기록하지 않는다.

상태 전이는 다음이 전부다.

- `prepared -> approved`
- `prepared -> rejected`
- `prepared -> expired`
- `approved -> consumed`
- `approved -> rejected`
- `approved -> expired`

모든 전이는 compare-and-set이며 같은 트랜잭션의 audit 없이는 완료하지 않는다.
consume는 apply transaction이 카드를 만들거나 정확히 no-op임을 확인한 뒤에만
일어난다. 다른 전이는 없다. 자동 expire는 prepared 또는 approved 시각부터 15분
뒤 DB clock 기준이다. step-up 신선도는 별도이며, 기본 `ADMIN_RECENT_AUTH_MINUTES`
값이나 운영 환경의 실제 값을 expire 기간으로 재사용하지 않는다.

결정적 검증 실패에는 `rejected`를 사용한다. conflict, exclude, schema mismatch,
digest mismatch, scanner mismatch는 카드 쓰기 전에 같은 트랜잭션에서 approval을
`rejected`로 바꾸고 human 또는 system audit를 남긴다. reject된 approval ID는
재실행할 수 없다. 원인을 고친 뒤에는 새 preview와 새 approval이 필요하다.
timeout, connection loss, 또는 commit 결과가 불명확하면 reject도 retry도 하지
않고 `outcome_unknown`으로 유지한다. 이 상태가 지속되는 동안 15분 자동 expire는
적용하지 않는다. DB read-back으로 결과가 확정된 뒤에만 consume, reject,
expire 중 하나를 기록한다.

Prepare 이후 source commit, board digest, manifest digest, item count, scanner
version, ruleset digest 중 하나라도 바뀌면 기존 approval row를 폐기하고 새
preview부터 시작한다. 폐기 전 행으로 apply하지 않는다.

Apply 직전 서버는 현재 DB를 다시 읽어 create, no-op, conflict를 계산한다.
현재 durable identity는 `(sourceSystem, sourceKey)`다. `sourceDigest`는 그
unique key의 일부가 아니다. 같은 pair가 이미 있고 backlog이며 owner와
`claimedAt`이 null이고 digest, version, snapshot digest가 승인 snapshot과
같으면 no-op이다. pair가 같지만 digest, lifecycle, owner, attempt, delivery가
다르면 update가 아니라 conflict다. pair가 없으면 create다. 최초 이관에서
conflict 또는 exclude가 하나라도 있으면 카드를 쓰지 않고 approval을 `rejected`로
마친다. timeout이나 응답 유실은 성공·실패로 추정하지 않는다. approval ID와
body digest로 DB를 다시 읽고, 불명확하면 `outcome_unknown`으로 사람에게 넘기며
blind retry하지 않는다.

### Source attestation

최초 이관의 확인 주체와 시점은 다음으로 고정한다.

1. Preview 뒤, prepare 전에 운영자는 source `main`의 fetch를 성공시킨다.
2. 운영자는 planner가 코드에 명시적으로 검사하는 8개 경로만 clean한지 확인한다.
   공개 정책은 그 비공개 경로를 열거하지 않는다. planner 출력의 clean 결과가
   전체 worktree cleanliness를 뜻하지 않는다.
3. 같은 운영자는 최근 step-up을 통과한 Admin 세션에서 source SHA, board digest,
   manifest digest, item count, scanner version, ruleset digest를 명시적으로
   확인한다.
4. Prepare transaction은 그 값을 `operator_attested`와 DB-clock
   `sourceAttestedAt`으로 승인 snapshot에 결속한다.
5. 서버는 비공개 Git 원격을 조회하지 않는다. fetch 실패, remote mismatch,
   planner mismatch는 확인을 거부하고 새 preview를 요구한다.
6. 확인 이후의 remote move 또는 force-push는 서버가 탐지하지 못할 수 있다.
   따라서 이 snapshot은 최초 비실행 backlog 이관에만 유효하다. 후속 import,
   reconciliation, promotion은 새 preview와 새 승인이 필요하다.

`server_verified` mode는 이 정책에 없다. 저장소 한정 read-only credential,
보관 위치, 접근 감사, 외부 전송 검토를 별도로 승인하기 전에는 추가하지 않는다.

### Input and scanner contract

모든 import 요청은 `application/json`, UTF-8, 알려진 schema만 받는다. 디코드
전에 원시 body가 1,048,576 UTF-8 bytes를 넘으면 거절한다. JSON 이후의 제한은
다음과 같다.

- 활성 항목: 최대 256개
- source system: 현재 DB CHECK의 lowercase pattern. 공개 정책은 비공개 저장소
  이름을 값으로 적지 않는다
- source key: 현재 DB CHECK의 uppercase pattern을 먼저 만족해야 한다. 첫 글자는
  대문자 또는 숫자이고, 이후에는 대문자·숫자·점·밑줄·콜론·하이픈만 허용된다.
  최초 제출은 여기에 더해 점·밑줄·콜론 없이 대문자·숫자·하이픈만 사용하고
  전체 1~64 bytes여야 한다. 이 제품 제한은 DB CHECK의 상위 집합이 아니다.
  중복은 거절한다
- source version: 현재 DB CHECK의 printable non-whitespace pattern. 최초
  이관 값은 정확한 source commit SHA다. unique identity에는 들어가지 않는다
- placeholder title: 64 UTF-8 bytes 이하이며 원문 title에서 생성하지 않음
- section code: 닫힌 ASCII 목록
- detail digest와 manifest digest: lowercase hex SHA-256
- execution brief: 최초 catalog import에서 null. 후속 정책에서만 최대 8,192 UTF-8 bytes
- 알 수 없는 필드, NUL, 잘못된 UTF-8, 지원하지 않는 version: 거절

숫자 제한은 JavaScript UTF-16 string length가 아니라 검증된 UTF-8 byte 수다.
현재 planner의 20,000 string-unit brief 검사는 이 서버 제한과 다르며 서버
scanner를 대체하지 않는다.

Scanner 이름 `amux-board-content-scan-v1`는 구현과 불변 ruleset digest,
고정 양성·음성·오탐 fixture가 함께 있을 때만 유효하다. 검사 대상은 known-token
pattern, private/local path, raw URL, high-entropy secret pattern이다. 40-hex
Git commit SHA와 64-hex digest는 지정 필드에서 오탐으로 거절하지 않는다. 다른
위치의 같은 형태는 맥락 없이 허용하지 않는다.

검사는 preview 표시 전, prepare 저장 전, apply 시작 전 각각 수행한다. apply는
승인 snapshot의 raw-body digest, scanner version, ruleset digest가 모두 같을
때만 계속한다. scanner 부재, 실행 실패, version mismatch, ruleset mismatch,
탐지는 fail-closed다. 거절 원문과 탐지 문자열은 DB, HTTP response, audit,
structured application log에 남기지 않고 허용된 오류 코드와 count만 남긴다.
proxy, APM, PostgreSQL error log, backup, staging sample에 raw payload가 남지
않는다는 설정을 검증하기 전에는 활성화하지 않는다. scanner 통과는 개인정보
부재나 공개 안전의 보증이 아니다.

### Apply gate

Apply는 기본 비활성인 별도 server-side gate 아래에서만 동작한다. 환경변수 하나만
존재한다고 활성으로 해석하지 않는다. 최초 production apply는 이 정책 승인,
구현, 작성자와 다른 독립 검토, staging 증거, 그리고 별도 운영자 승인이 모두
필요하다.

단일 writer는 card insert, explicit dependency insert, approval consumption,
canonical human audit를 한 트랜잭션에 기록한다. 최초 이관은 dependency를 만들지
않는다. Markdown link를 dependency로 추론하지 않으며 투자 순위를 p0~p3으로
산술 변환하지 않는다. source row removal, digest drift, operator edit, active
attempt는 overwrite나 delete가 아니라 conflict다.

Apply 성공 후 staging 또는 production에서 증명해야 하는 불변식은 다음과 같다.

- 신규 카드 status는 모두 backlog
- owner, claimedAt, attempt, delivery, route decision 증가량은 0
- worker execution과 provider call은 0
- user credit 사용량은 0
- approval consume count는 적용한 approval 1건
- 같은 body digest의 재실행은 추가 카드 0건

## Out of scope

이 v2 후보는 다음을 승인하거나 구현하지 않는다.

- staging 또는 production 배포
- import/apply flag의 실제 활성화
- 운영 DB card 생성
- backlog에서 todo로의 promotion
- worker 실행, 유료 provider 호출, 사용자 credit 사용
- 자동 promotion
- Markdown 현황판 정본의 AMUX cutover
- 후속 reconciliation의 overwrite 또는 delete
- `server_verified` private-Git integration
- legal retention period의 확정

각 항목은 해당 단계의 별도 정책·독립 검토·운영자 승인이 필요하다.
버전 3은 그중 수동 1~3개 promotion pilot만 연다. 버전 7은 추천 풀과 카드 하나의 사람 결정만 연다. 버전 8은 제한 자동 승격의 졸업 조건과 꺼진 게이트만 정하고 그 게이트를 켜지 않는다. 나머지 항목은 그대로다.

## Manual promotion pilot

버전 3은 catalog import가 만든 `backlog` 카드 가운데 운영자가 한 요청에 적은 1~3개만 `todo`로 바꾸는 별도 Admin 동작이다. 이 절은 그 카드를 고르지 않고, 실행 brief를 쓰지 않으며, apply 래치를 켜지 않는다. 래치가 꺼진 구현이 병합돼도 카드 status는 바뀌지 않는다.

요청은 `amux-json-v1`로 정규화한다. 항목은 1개 이상 3개 이하다. 각 항목은 기존 카드 id, 기대 revision, 저장된 `sourceDigest`, 명시적 `kind`, 명시적 `priority`, routing `classification`, execution brief를 함께 가진다. `kind`는 현재 `AmuxWorkItem_kind_check`의 값 가운데 `unknown`을 뺀 것이다. `priority`는 `p0`~`p3` 중 요청에 적힌 값이다. classification은 `task_kind`, `complexity`, `risk`, `files_expected`만 가진다. `task_kind`는 현재 worker router가 이름을 가진 값만 허용한다. brief는 1~8,192 UTF-8 byte다.

Brief와 요청 전체는 catalog scanner(`amux-board-content-scan-v1`)를 통과해야 한다. 그 scanner는 URL, path separator, 토큰, 비공개 문서 경로를 거절하므로 brief는 저장소 경로를 담지 못한다. 목표, 포함과 제외, 완료 증거는 경로 없이 적는다.

대상 카드는 `backlog`이고 owner와 `claimedAt`과 `archivedAt`이 null이며, attempt, delivery, route decision이 0이고, 의존성이 있으면 그 의존성은 `done`이며 archive되지 않았다. source identity가 없거나 digest가 다르면 거절한다. 하나라도 거절이면 배치 전체를 쓰지 않는다.

Apply는 환경 변수 `TOMVERSE_AMUX_BOARD_PROMOTE`가 정확히 `enabled`이고 코드 래치가 true일 때만 열린다. 버전 3이 출고한 코드 래치는 false였다. 버전 6이 출고하는 코드 래치는 true다. 요청 스키마의 `policyVersion`은 3으로 남는다. HTTP route는 래치를 인자로 받지 않는다. 승인 계약은 catalog import와 같다. 준비한 운영자가 최근 step-up 후 같은 행을 승인하고, 창은 15분이며, 소비는 한 번이다. 감사 metadata에는 brief 원문, 제목, source key를 넣지 않는다. 환경 값이 `enabled`가 아니면 코드 래치가 켜져 있어도 트랜잭션을 열지 않는다.

성공한 apply는 그 카드의 status를 `todo`로 바꾸고, 요청의 kind, priority, classification, brief, brief digest를 기록하고, revision을 1 올린다. owner를 세팅하지 않고 attempt, delivery, route decision을 만들지 않는다. `TOMVERSE_AMUX_EXECUTE`를 바꾸지 않는다. queue는 계속 literal `todo`와 owner null만 읽는다. 승격된 카드는 그 조건에 들어가 선택 대상이 될 수 있으나, 선택은 실행이 아니다.

버전 3의 승인만으로는 운영 DB의 카드를 승격하지 않았다. 카드를 적은 별도 요청은 그 뒤에 있었고, 버전 6은 래치를 켜는 승인이다. 버전 6은 그 요청을 실행하지 않고 환경 변수를 설정하지 않는다. 환경 값이 정확히 `enabled`인 배포에서 최근 step-up을 가진 운영자가 apply하기 전에는 status가 바뀌지 않는다. 적용 순서는 한 장, 그 결과의 read-back, 이어서 두 장이다. 이 순서는 운영 절차이고 코드가 강제하지 않는다.

## Source reconciliation apply

버전 4는 이미 가져온 카드의 source revision을 카드마다 한 결정으로 추가하는 별도 Admin 동작이다. 버전 4는 운영 DB에 revision을 쓰지 않고 코드 래치를 끈 채로 출고했다. 버전 5는 그 코드 래치만 켠다. 이 절은 운영 DB에 revision을 쓰지 않고, 현황판 정본을 AMUX로 바꾸지 않는다. 래치를 켜는 것은 현황판 cutover가 아니다.

요청은 `amux-json-v1`이다. catalog scanner(`amux-board-content-scan-v1`)를 통과해야 한다. 항목 정체성은 source key, section code, detail digest다. manifest digest는 run의 속성이고 카드 drift를 만들지 않는다. source version은 catalog scanner가 commit으로 읽는 40자리 hex다.

item drift인 source key마다 `accept_new_source_revision` 또는 `reject`가 정확히 하나 필요하다. 두 카드를 한 결정으로 묶지 않는다. no-op, missing, extra에는 revision을 만들지 않는다. 결정이 빠지거나 drift가 아닌 키를 결정하면 preview는 거절하고 writes는 0이다.

Preview는 아무것도 쓰지 않는다. `applyPermitted`는 환경 변수 `TOMVERSE_AMUX_RECONCILIATION_APPLY`가 정확히 `enabled`이고 코드 래치가 true일 때만 true다. 버전 5가 출고하는 코드 래치는 true다. HTTP route는 래치를 인자로 받지 않는다. Apply는 그 판정이 false이면 트랜잭션을 열기 전에 `apply_disabled`로 거절한다. 환경 값이 `enabled`가 아니면 코드 래치가 켜져 있어도 트랜잭션을 열지 않는다.

래치가 열린 뒤의 한 트랜잭션은 consumed run, 사람 감사, revision insert, accept인 카드의 pointer 갱신만 한다. revision은 append-only다. accept는 새 accepted revision을 넣은 뒤에 pointer만 옮긴다. reject는 rejected revision만 추가하고 pointer를 유지한다. 어느 쪽도 `sourceVersion`, `sourceDigest`, `sourceSnapshot`, status, kind, priority, owner, `claimedAt`을 바꾸지 않는다. attempt, delivery, route decision, provider cost, 사용자 크레딧을 만들지 않는다. 감사 metadata에는 제목과 source key를 넣지 않고 digest와 개수만 남긴다.

overwrite와 delete는 여전히 없다. 코드 래치를 켜는 것은 현황판 cutover가 아니다.

## Recommendation pool

버전 7은 backlog 카드의 추천 풀과, 그 풀에 있는 카드 하나에 대한 사람의 승인, 보류, 거절이다. 추천 풀은 `AmuxWorkItem.status`가 아니다. 카드는 승인 소비 전까지 `backlog`다. 보류와 거절도 `backlog`를 유지한다. 이 버전은 자동 승격을 정의하지 않고 실행하지 않는다. `TOMVERSE_AMUX_EXECUTE`, `TOMVERSE_AMUX_EXECUTION_API_ENABLED`, worker catalog, executor command를 읽거나 쓰지 않는다. 사용자 크레딧, Chat, Memory, 결제, 외부 게시를 건드리지 않는다. 버전 3의 수동 pilot 요청 경로는 그대로다.

구현은 이 절의 독립 검토가 끝난 뒤에만 시작한다. 이 파일에 승인을 적은 것은 그 검토 기록이 아니다.

### Capacity

용량의 분모는 코드 상수가 아니다. 테이블 `AmuxRecommendationCapacity`의 단일 행 `queue`가 있고 `active`가 true이며 `wipLimit`이 null이 아닐 때만 그 `wipLimit`이 분모다. 행이 없거나 `active`가 false이거나 `wipLimit`이 null이면 용량은 미설정이고 남은 자리는 0이다. 이 버전은 그 행을 넣지 않는다. `wipLimit`은 1 이상 10000 이하다. 10000은 기존 `AmuxResourcePolicy_wip_limit_check`와 같은 저장 상한이지 용량의 기본값이 아니다. 3은 용량이 아니다.

분자는 `archivedAt`이 null이고 status가 `todo` 또는 `doing`인 카드 수다. owner가 null인 `todo`도 분자에 들어간다. claim 경로의 WIP 분자는 `doing`과 owner가 있는 `todo`만 센다. 이 버전은 그 함수와 `AmuxResourcePolicy`의 `project`·`team` scope를 바꾸지 않는다.

시점은 둘이다. snapshot 트랜잭션이 advisory lock을 잡은 뒤의 분자와, 승인 트랜잭션이 같은 lock을 잡은 뒤 카드 쓰기 전의 분자다. snapshot의 남은 자리는 표시다. 승인을 허용하는 값은 승인 트랜잭션의 재계산뿐이다. 남은 자리는 `max(0, wipLimit - 분자)`다. 승인은 `분자 + 1 <= wipLimit`일 때만 카드를 쓴다.

per-worker 용량은 이 버전에 없다. worker catalog가 없어도 사람의 승인을 막지 않는다. 승인은 실행이 아니다. snapshot은 `worker_capacity: closed`를 기록한다. per-classification 용량도 없다. classification은 승인 요청이 버전 3과 같은 객체로 내는 값이고 남은 자리를 늘리지 않는다. snapshot은 `classification_capacity: closed`를 기록한다.

유계 batch는 결정 1건에 카드 1장이다. 버전 3의 1~3장은 수동 pilot의 요청 모양이고 이 용량이 아니다. 동시에 들어온 추천 결정들은 advisory lock `tomverse-amux-recommendation:queue` 아래에서 분자를 다시 센다. 합이 분모를 넘으면 넘는 요청은 카드를 쓰지 않는다. 이 합산은 그 lock을 잡는 추천 결정 사이에서만 성립한다. 버전 3 수동 pilot은 이 lock을 잡지 않으므로 그 경로의 `todo`는 이 분모를 넘을 수 있다. 버전 7은 그 경로를 바꾸지 않는다.

한 snapshot의 저장 행 수는 그때의 backlog 행 수와 같다. 10000행을 넘으면 snapshot을 쓰지 않고 `snapshot_backstop`으로 거절한다. 잘리지 않는다. 10000은 용량이 아니다.

### Candidate filter

포함은 아래를 모두 통과한 카드뿐이다. 하나라도 실패하면 제외 행이고, 제외는 fail-closed다.

- status가 `backlog`다
- owner, `claimedAt`, `archivedAt`이 null이다
- attempt, delivery, route decision이 0이다
- 의존성이 있으면 그 의존성은 `done`이고 archive되지 않았다
- `sourceDigest`가 있고, 승인 시점에 snapshot에 묶인 값과 같다
- `executionBriefDigest`가 snapshot에 기록된 값과 같다. 둘 다 null인 것은 같다. 하나만 바뀌면 `brief_digest_changed`다
- incident가 admission을 막지 않는다. 입력은 `amux.incidentMode`를 `parseAmuxIncidentSetting`으로 읽은 값이고, claim 경로와 같다. `blocks_admission`이 true이면 포함 행은 0이고 사유는 `incident_blocked`다
- 용량이 설정돼 있고 남은 자리가 1 이상이다. 아니면 `capacity_unconfigured` 또는 `capacity_full`이다
- `reviewAfter`가 아직 미래인 보류 또는 거절이 없다. 있으면 `review_waiting`이다

제외 코드는 `not_backlog`, `owner_set`, `claimed`, `archived`, `lifecycle_present`, `dependency_open`, `source_unbound`, `brief_digest_changed`, `incident_blocked`, `capacity_unconfigured`, `capacity_full`, `review_waiting`뿐이다.

score는 `scoreAmuxScheduler`와 `amux-global-priority-v2`다. capacity weight는 0이고 incident bonus는 넘기지 않는다. 포함 행의 순서는 score 내림차순이고, 같으면 card id 오름차순이다. 포함 행 수는 남은 자리 이하다. LLM은 추천, 제외, 승인을 판정하지 않는다. 카드 제목, brief, source key는 모델 입력으로 나가지 않는다.

### Decisions

preview는 아무것도 쓰지 않는다. 계산된 포함, 제외, `applyPermitted`만 반환한다.

prepare와 승인, 보류, 거절은 환경 변수 `TOMVERSE_AMUX_BOARD_RECOMMEND`가 정확히 `enabled`이고 코드 래치가 true일 때만 쓴다. 버전 7이 출고하는 코드 래치는 false다. 래치가 꺼져 있거나 환경 값이 `enabled`가 아니면 그 네 쓰기 모두 트랜잭션을 열기 전에 `apply_disabled`로 거절한다. 이미 쓴 snapshot의 읽기는 남는다. 이 버전은 그 환경 변수를 설정하지 않는다. HTTP route는 래치를 인자로 받지 않는다. 용량 행의 insert와 update writer도 이 버전에 없다.

preview는 위 조건과 무관하게 아무것도 쓰지 않는다.

승인, 보류, 거절은 준비한 운영자가 최근 step-up 뒤 같은 snapshot 항목을 한 번 결정한다. 15분 창의 시작은 snapshot `preparedAt`이고, 그 시각은 DB 시계다. 창은 catalog import와 같다. 스위치가 꺼져 있으면 트랜잭션을 열지 않으므로 `expired` 행도 쓰지 않는다. 스위치가 열린 요청이 만료된 snapshot을 가리키면, 같은 advisory lock 안에서 status를 다시 읽기 전에 `expired` decision 행을 기록하고 카드를 쓰지 않는다. 카드가 더 이상 `backlog`가 아니어도 그 `expired` 행은 쓴다. 그 actor는 그 요청을 보낸 사람이다. 만료를 돌리는 sweeper job은 없다.

승인 요청은 카드 정확히 하나다. 버전 3의 1~3장 parser를 그대로 받아 여러 장을 허용하지 않는다. 그 카드가 그 snapshot의 포함 행이 아니면 거절한다. 보류와 거절은 그 snapshot의 행이면 기록할 수 있다. 승인, 보류, 거절은 같은 advisory lock을 잡고 카드 status를 다시 읽는다. status가 `backlog`가 아니면 결정 행을 쓰지 않는다.

승인 요청의 항목 필드는 버전 3의 카드 하나와 같다. `kind`는 `unknown`이 아니다. priority, classification, execution brief, expected revision, `sourceDigest`가 있다. brief는 1~8192 UTF-8 byte다. brief만이 아니라 요청 전체가 catalog scanner `amux-board-content-scan-v1`을 통과한다.

성공한 승인은 한 트랜잭션이다. 그 트랜잭션이 lock, 필터 재검사, 용량 재검사, decision `consumed`, 버전 3과 같은 카드 쓰기, 사람 감사 `amux.recommendation.consumed`를 함께 한다. 승인과 소비 사이에 따로 두는 상태는 없다. 카드 쓰기는 status `todo`, 요청의 kind, priority, classification, brief, brief digest, revision + 1이다. owner, attempt, delivery, route decision을 만들지 않는다.

보류와 거절도 각각 한 트랜잭션이고 카드 상태를 쓰지 않는다. reason code는 `capacity`, `dependency`, `cost`, `risk`, `scope`, `not_now` 중 하나다. `reviewAfter`는 `YYYY-MM-DDTHH:mm:ss.sssZ`이고, 그 문자열은 `new Date(value).toISOString()`과 같아야 한다. 그 시각은 트랜잭션 시계보다 미래이고, 그 시계로부터 366일을 넘지 않는다. 366일은 용량이 아니라 시각 상한이다. 감사 metadata의 `reviewAfter`는 그 정규화된 시각만 담는다. 자유 텍스트 사유는 없다.

같은 snapshot 항목의 두 번째 결정은 거절한다. 같은 decision id의 재전송은 기존 행을 반환한다. 결과를 잃으면 `outcome_unknown`으로 멈추고 DB read-back으로만 확정한다. blind retry는 없다. revision 또는 status의 CAS가 실패하면 트랜잭션은 rollback하고 카드 쓰기는 0이다.

kill switch는 환경 값이 정확히 `enabled`가 아니거나 코드 래치가 false인 것이다. 그때 새 snapshot과 새 결정은 열리지 않고, 이미 쓴 snapshot의 읽기는 남는다. 사람의 재개는 환경 값을 다시 `enabled`로 두는 별도 운영 조작이다. 래치를 다시 켜는 것도 별도 버전이다. 이 버전은 그 조작을 하지 않는다.

### Audit, storage, and checklist

감사 action은 `amux.recommendation.prepared`, `amux.recommendation.held`, `amux.recommendation.rejected`, `amux.recommendation.expired`, `amux.recommendation.consumed`, `amux.recommendation.outcome_unknown`이다. actor는 사람이다. metadata에는 brief, 제목, source key를 넣지 않는다. 허용 값은 decision id, snapshot id, digest, 개수, reason code, `reviewAfter`, 용량의 분자와 분모뿐이다.

저장은 본 앱 DB다. Admin 화면은 owner 전용이며 `/admin/amux-promotion?tab=recommendation`에 있다(버전 17). owner가 아닌 역할의 내비게이션, 검색, 탭에는 나타나지 않는다. 옛 경로 `/admin/amux-board-recommendation`은 redirect로 유지한다. GitHub issue, label, comment는 상태 저장소가 아니다. 보존 기간은 이 버전이 정하지 않는다. 법적 보존이 미정인 동안 행을 지우는 job을 만들지 않는다.

판정은 본 앱 route에 있다. LLM과 외부 텍스트 실행이 없으므로 별도 Railway 서비스, 서비스와 앱의 hard timeout 쌍, Publisher, GitHub 쓰기는 없다. 추천 경로가 제품 DB credential을 새로 받지 않는다. 중국 본토 전송과 고객에게 보이는 자동 결정 표시는 없다. Admin 문구는 추천을 더 나은 실행이나 최적 선택이라고 말하지 않는다.

설계 체크리스트는 이렇게 닫는다.

1. 조합 대상은 AMUX 카드의 backlog 추천과 사람 결정뿐이다. Chat, Memory, 금융, 사용자 크레딧, attempt, delivery, route decision은 비접촉이다.
2. 고객 `platformProductKey`는 없다. 시스템 actor는 없다. 권한은 기존 owner와 최근 step-up이다.
3. 되돌릴 수 없는 외부 게시, 삭제, 결제는 없다. 이 경로에서 `backlog`에서 `todo`로의 전이는 사람의 승인 소비에서만 일어난다. 버전 3 수동 pilot은 별도 경로다. 자율 졸업은 이 버전에 없다.
4. Guard 입력은 위 필터, snapshot digest, brief digest, 용량 재계산, 운영 스위치, 코드 래치다. 값은 거절, 사람 결정 필요, 승인 소비 뒤의 허용이다. LLM 판정은 없다.
5. 모델 입력 경로는 없다.
6. 새 자격증명은 없다. 로그와 감사에 brief, 제목, source key를 넣지 않는다.
7. 테이블은 `AmuxRecommendationCapacity`, snapshot, snapshot 항목, decision이다. 용량 행의 insert와 update writer는 이 버전에 없다. 추천 서비스는 snapshot과 decision만 쓴다. 카드 status enum에 값을 추가하지 않는다. 보존 기간은 미정이고 삭제 job은 없다.
8. 추천 비용 namespace는 열지 않는다. provider 호출이 없으므로 상한은 0건이다. 사용자 크레딧과 섞지 않는다.
9. 스위치는 `TOMVERSE_AMUX_BOARD_RECOMMEND`가 정확히 `enabled`인 것과 코드 래치다. 출고 래치는 false다. 자동 정지는 환경 값이 더 이상 `enabled`가 아니거나 래치가 false일 때다. 환경 값의 해제는 사람의 조작이고, 래치를 다시 켜는 것은 별도 버전이다.
10. 멱등 키는 decision id다. `outcome_unknown` 뒤에는 read-back만 한다.
11. 외부 worker와 모델이 없으므로 S0 실측과 DPA 행은 없다.
12. 위 감사 action은 전부 사람이다.
13. 고객 개인정보를 새로 저장하지 않는다. 국외 이전을 추가하지 않는다. 중국 본토 경로를 만들지 않는다.
14. 이 버전의 차단 기준은 승인 없는 `todo` 증가, attempt·delivery·route 증가, 실행 스위치 변경, 용량 행의 자동 삽입이다.
15. 계산은 본 앱 route다. LLM과 외부 텍스트를 다루지 않는다. 별도 서비스와 게시 권한은 없다.
16. 대기열과 승인 기록은 위 테이블과 `/admin/amux-board-recommendation`이다. 승인은 snapshot digest, card revision, source digest, brief digest에 묶인다. 코드 변경 PR을 승인 증거로 쓰지 않는다.

완료로 세려면 구현이 다음을 테스트로 보여야 한다. 용량 미설정과 가득 참의 거절, 풀 밖 카드와 바뀐 brief digest와 의존성 미충족의 fail-closed, snapshot이 카드 status를 만들지 않음, 승인만 `todo`가 되고 보류와 거절은 `backlog`와 사유와 `reviewAfter`를 남김, 추천 결정의 병렬 요청이 분모를 넘기지 않음, CAS 실패와 rollback, 감사 사슬, `outcome_unknown` read-back, 승인 없는 `todo` 증가 0, attempt·delivery·route 증가 0.

버전 7은 자동 승격의 graduation 기준, 비용 상한, worker 격리, 자동 승격 kill switch를 정하지 않는다. 그 항목이 없는 동안 자동 승격은 닫혀 있다.

## Limited automatic promotion

버전 8은 사전 승인된 카드 하나의 제한 자동 승격 게이트다. 자동 승격은 `AmuxWorkItem.status`가 아니다. 카드는 소비 전까지 `backlog`다. 이 버전은 그 소비를 실행하지 않는다. `TOMVERSE_AMUX_EXECUTE`, `TOMVERSE_AMUX_EXECUTION_API_ENABLED`, worker catalog, executor command를 읽거나 쓰지 않는다. 사용자 크레딧, Chat, Memory, 결제, 외부 게시를 건드리지 않는다. 버전 3 수동 pilot과 버전 7 사람 결정 경로는 그대로다. 버전 7의 추천 코드 래치를 이 버전이 켜지 않는다.

구현은 이 절의 독립 검토가 끝난 뒤에만 시작한다. 이 파일에 승인을 적은 것은 그 검토 기록이 아니다.

### Graduation

졸업은 두 조건을 함께 요구한다. 사람 결정이 20건 이상이고, 그 결정들의 `createdAt` 최댓값에서 최솟값을 뺀 간격이 14일 이상이다. 14일은 `14 * 24`시간이고 경계는 포함한다. 20건이어도 간격이 14일보다 짧으면 거절한다. 간격이 14일 이상이어도 20건보다 적으면 거절한다. 거절 코드는 `graduation_unmet`이다.

사람 결정은 `AmuxRecommendationDecision` 가운데 `decision`이 `approve`이고 `status`가 `consumed`인 행만 센다. 보류, 거절, 만료, `outcome_unknown`은 세지 않는다. 버전 3 수동 pilot의 `AmuxBoardPromotionApproval`은 세지 않는다. 자동 승격 소비 행은 세지 않는다. 이 버전은 그 20건을 만들지 않는다.

### Cost caps

비용은 자동 승격 경로의 운영 USD다. 사용자 크레딧이 아니고, 버전 7 추천 경로의 0건 provider 예산이 아니며, `CHAT_COST_GUARDRAIL_*`와 섞지 않는다. 단위는 USD cent 정수다.

- 1회 상한은 500 cent, 곧 US$5.00이다. 한 자동 승격 트랜잭션이 기록할 수 있는 금액은 이 값 이하다.
- 24시간 상한은 1,500 cent, 곧 US$15.00이다. 창은 DB 시계로부터 뒤로 24시간이고 경계는 포함이다.
- 30일 상한은 10,000 cent, 곧 US$100.00이다. 30일은 `30 * 24`시간이다. 달력의 월이 아니다.

상한을 넘는 제안은 카드를 쓰기 전에 `cost_exceeded`로 거절한다. 그 사전 거절 자체는 저장된 중대 위반이 아니다. 이미 기록된 합이 상한을 넘는 read-back은 중대 위반 `cost_exceeded`다. 이 버전은 provider를 호출하지 않고 비용 행을 쓰지 않는다. 기록된 합은 0이다.

### Worker isolation

자동 경로의 전역 상한은 3이다. 세는 카드는 `archivedAt`이 null이고 status가 `todo` 또는 `doing`이며 자동 승격 소비 행이 있는 카드다. 이미 3장이면 다음 제안은 카드를 쓰기 전에 `auto_wip_full`로 거절한다. 그 사전 거절은 중대 위반이 아니다. 이 3은 `AmuxRecommendationCapacity.wipLimit`이 아니다. 버전 7의 용량 분모, 분자, 시점은 그대로다. `evaluateLockedAmuxWip`은 바꾸지 않는다. 용량 행이 없거나 비활성이거나 `wipLimit`이 null이면 자동 경로도 `capacity_unconfigured`로 거절한다. `분자 + 1 <= wipLimit`이 아니면 `capacity_full`로 거절한다. 그 두 거절은 중대 위반이 아니다. 이 버전은 용량 행을 넣지 않는다.

worker당 상한은 1이다. 이 버전은 owner를 세팅하지 않고 worker catalog를 읽지 않는다. worker id가 있는 요청은 `worker_not_admitted`로 거절한다. 그 사전 거절은 중대 위반이 아니다. 이 상한은 worker 슬롯을 만들지 않는다. read-back에서 같은 owner의 자동 활성 카드가 2장 이상이면 중대 위반 `worker_cap_exceeded`다. read-back에서 자동 활성 카드가 4장 이상이면 중대 위반 `global_wip_exceeded`다.

### Grant, audit, and one card

사전 승인은 버전 7의 승인 소비가 아니다. grant는 카드 status, owner, attempt, delivery, route decision을 바꾸지 않는다. 한 grant는 카드 하나다. 같은 카드의 active grant가 이미 있으면 두 번째는 거절한다. `expiresAt`은 DB 시계의 `grantedAt`에 7일을 더한 값이다. 7일은 `7 * 24`시간이다. 자동 소비는 `status`가 `active`이고 `expiresAt`이 트랜잭션 시계보다 미래인 grant가 있을 때만 가능하다. 없거나 만료면 `grant_missing`이다. 소비는 그 grant를 같은 트랜잭션에서 `consumed`로 바꾼다.

자동 소비는 카드 하나와 트랜잭션 하나다. 그 트랜잭션이 advisory lock `tomverse-amux-recommendation:queue`, 버전 7 필터 재검사, 용량 재검사, 졸업 재검사, grant 재검사, 비용 재검사, 전역 상한 재검사, halt 재검사, 카드 쓰기, grant 소비, 소비 행, 사람 감사를 함께 한다. 버전 7과 같은 카드 쓰기만 허용한다. owner, attempt, delivery, route decision을 만들지 않는다. 카드 둘을 한 요청에 넣으면 거절한다.

grant를 남기는 요청의 step-up 창은 15분이다. 그 15분은 grant의 7일 수명과 다른 시계다.

감사 action은 `amux.auto_grant.prepared`, `amux.auto_grant.expired`, `amux.auto_promotion.consumed`, `amux.auto_promotion.outcome_unknown`, `amux.auto_promotion.halted`다. actor는 요청을 보낸 사람이다. 시스템 actor는 없다. metadata에는 brief, 제목, source key, 자유 텍스트를 넣지 않는다. 허용 값은 grant id, consumption id, snapshot id, digest, cent 금액, 개수, 위반 코드뿐이다.

### Kill switch

출고 스위치는 둘이다. 환경 변수 `TOMVERSE_AMUX_BOARD_AUTO_PROMOTE`가 정확히 `enabled`인 것과 코드 래치가 true인 것이다. 버전 8이 출고하는 코드 래치는 false다. 이 버전은 그 환경 변수를 설정하지 않는다. 래치가 꺼져 있거나 환경 값이 `enabled`가 아니면 grant 쓰기와 자동 소비 모두 트랜잭션을 열기 전에 `apply_disabled`로 거절한다. HTTP route는 래치를 인자로 받지 않는다.

추가 정지는 저장된 halt다. `clearedAt`이 null인 halt가 있으면 카드를 쓰기 전에 `auto_halted`로 거절한다. halt를 여는 조건은 둘 중 하나다. 저장된 중대 위반이 1건 이상이거나, 자동 경로의 `outcome_unknown`이 DB 시계로부터 뒤로 15분 안에 2건 이상인 것이다. 15분은 `15 * 60`초이고 경계는 포함한다. 결과 불명 1건은 halt를 열지 않는다. 간격이 15분을 넘는 2건은 halt를 열지 않는다.

중대 위반 코드는 `cost_exceeded`, `worker_cap_exceeded`, `global_wip_exceeded`, `unapproved_todo`, `lifecycle_write`뿐이다. `unapproved_todo`는 grant 소비 없이 `todo`가 된 자동 경로 카드다. `lifecycle_write`는 이 경로가 attempt, delivery, route decision을 만든 것이다. 졸업 미달, 용량 미설정, 용량 가득 참, grant 없음, 사전 비용 거절은 중대 위반이 아니다. 사람의 재개 writer는 이 버전에 없다.

### Storage and checklist

테이블은 `AmuxRecommendationAutoGrant`, `AmuxRecommendationAutoConsumption`, `AmuxRecommendationAutoCostEntry`, `AmuxRecommendationAutoHalt`다. 이 버전의 공개 route는 네 테이블에 쓰지 않는다. 공개 route가 `apply_disabled`로 거절한 뒤의 트랜잭션 본문은 테스트가 직접 부를 수 있다. 그 본문 호출은 공개 route의 래치 판정을 대신하지 않는다. 카드 status enum에 값을 추가하지 않는다. 보존 기간은 미정이고 삭제 job은 없다. 고객 export에 넣지 않는다.

설계 체크리스트는 이렇게 닫는다.

1. 조합 대상은 사전 승인된 backlog 카드 하나의 제한 자동 승격뿐이다. Chat, Memory, 금융, 사용자 크레딧, attempt, delivery, route decision은 비접촉이다.
2. 고객 `platformProductKey`는 없다. 시스템 actor는 없다. 권한은 기존 owner와 최근 step-up이다.
3. 되돌릴 수 없는 외부 게시, 삭제, 결제는 없다. `backlog`에서 `todo`로의 전이는 졸업, grant, 용량, 비용, 격리, halt를 같은 트랜잭션에서 통과한 소비에서만 일어난다. 이 버전은 그 소비의 공개 경로를 열지 않는다.
4. Guard 입력은 졸업 20건과 14일, grant 만료, 버전 7 필터, 용량 재계산, USD cent 상한, 전역 3, worker id 거절, halt, 운영 스위치, 코드 래치다. LLM 판정은 없다.
5. 모델 입력 경로는 없다.
6. 새 자격증명은 없다. 로그와 감사에 brief, 제목, source key를 넣지 않는다.
7. 위 네 테이블만 추가한다. 용량 행의 insert와 update writer는 없다. 추천 분자는 바꾸지 않는다.
8. 비용 namespace는 자동 경로의 USD cent다. 상한은 500, 1,500, 10,000이다. 사용자 크레딧과 섞지 않는다. 이 버전은 비용 행을 쓰지 않는다.
9. 스위치는 `TOMVERSE_AMUX_BOARD_AUTO_PROMOTE`가 정확히 `enabled`인 것과 코드 래치다. 출고 래치는 false다. 중대 위반 1건 또는 15분 안 결과 불명 2건은 halt다. 환경 값의 해제는 사람의 조작이고, 래치를 다시 켜는 것과 halt를 닫는 것은 별도 버전이다.
10. 멱등 키는 consumption id다. `outcome_unknown` 뒤에는 read-back만 한다.
11. 외부 worker와 모델이 없으므로 S0 실측과 DPA 행은 없다.
12. 위 감사 action의 actor는 사람이다.
13. 고객 개인정보를 새로 저장하지 않는다. 국외 이전을 추가하지 않는다. 중국 본토 경로를 만들지 않는다.
14. 이 버전의 차단 기준은 졸업 증거를 만들지 않은 `todo` 증가, attempt·delivery·route 증가, 실행 스위치 변경, 용량 행의 자동 삽입, 비용 상한을 넘는 기록이다.
15. 계산은 본 앱 route다. LLM과 외부 텍스트를 다루지 않는다. 별도 서비스와 게시 권한은 없다.
16. 기록은 위 네 테이블이다. 코드 변경 PR을 졸업 증거로 쓰지 않는다. 사람 결정 20건과 14일은 DB의 소비 행으로만 센다.

완료로 세려면 구현이 다음을 테스트로 보여야 한다. 출고 래치가 false여서 공개 경로의 grant, 소비, 비용, halt, 카드 쓰기가 0인 것. 사람 결정 19건의 거절, 20건이어도 14일보다 짧은 간격의 거절, 20건이고 간격이 14일 이상일 때만 졸업 판정이 통과하는 것. 501 cent의 거절, 24시간과 30일 합산 상한의 거절. 자동 활성 3장에서 다음 카드의 거절. worker id가 있는 요청의 거절. grant가 없거나 만료된 카드의 거절과, grant가 카드 status를 바꾸지 않는 것. 한 요청의 카드 둘의 거절. 중대 위반 1건의 halt, 15분 안 결과 불명 2건의 halt, 결과 불명 1건은 halt가 아닌 것. 열린 halt의 카드 쓰기 거절. 버전 7 추천 래치는 false로 남는 것. attempt, delivery, route decision의 증가 0. `TOMVERSE_AMUX_EXECUTE`를 읽거나 쓰지 않는 것.

버전 8은 사람 결정 20건과 14일을 측정된 사실로 만들지 않는다. 그 행이 없는 동안 졸업 판정은 거절이다. 코드 래치를 켜는 것은 별도 버전이다.

## 버전 9 — 자동 승격 코드 래치

요청 스키마의 `policyVersion`은 8로 남는다. 버전 8의 졸업, 비용, 전역 상한, grant, halt, 용량 판정은 바꾸지 않는다.

버전 9가 출고하는 `AUTO_PROMOTION_CODE_LATCH`는 true다. 환경 변수 `TOMVERSE_AMUX_BOARD_AUTO_PROMOTE`가 정확히 `enabled`일 때만 grant와 자동 소비가 트랜잭션을 연다. 이 버전은 그 환경 변수를 설정하지 않는다. HTTP route는 래치를 인자로 받지 않는다. 상수가 false이면 route는 서비스 전에 `apply_disabled`를 반환한다.

이 버전은 사람 결정 20건을 만들지 않는다. 그 행이 없는 동안 소비는 `graduation_unmet`이다. 용량 행을 넣지 않는다. 그 행이 없는 동안 소비는 `capacity_unconfigured`다. 추천 풀 코드 래치는 false로 남는다. grant는 카드 status를 바꾸지 않는다. `TOMVERSE_AMUX_EXECUTE`와 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`를 읽거나 쓰지 않는다. worker를 시작하지 않는다.

래치를 다시 끄는 것은 별도 버전이다.

## 버전 10 — 추천 풀 코드 래치

요청 스키마의 `policyVersion`은 7로 남는다. 버전 7의 포함 조건, 용량 판정, 승인, 보류, 거절은 바꾸지 않는다. 버전 9의 자동 승격 코드 래치는 true로 남는다.

버전 10이 출고하는 `RECOMMENDATION_CODE_LATCH`는 true다. 환경 변수 `TOMVERSE_AMUX_BOARD_RECOMMEND`가 정확히 `enabled`일 때만 prepare와 승인, 보류, 거절이 트랜잭션을 연다. 이 버전은 그 환경 변수를 설정하지 않는다. HTTP route는 래치를 인자로 받지 않는다. 상수가 false이면 route는 서비스 전에 `apply_disabled`를 반환한다.

이 버전은 사람 결정 20건을 만들지 않는다. 용량 행을 넣지 않는다. 그 행이 없는 동안 포함 행은 `capacity_unconfigured`다. `TOMVERSE_AMUX_EXECUTE`와 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`를 읽거나 쓰지 않는다. worker를 시작하지 않는다.

래치를 다시 끄는 것은 별도 버전이다.

## 버전 11 — 추천 용량 행 writer

결정 요청의 `policyVersion`은 7로 남는다. 용량 요청의 `policyVersion`은 11이다. 버전 7의 포함 조건과 용량 판정, 버전 9의 자동 승격 코드 래치, 버전 10의 추천 풀 코드 래치는 바꾸지 않는다.

용량 요청은 `canonicalizationVersion`, `policyVersion`, `active`, `wipLimit`만 가진다. `wipLimit`는 1 이상 10000 이하의 정수다. 카드 id, 기본 한도, 자동 경로의 전역 3은 이 요청에 없다. owner와 최근 step-up이 있어야 하고, 쓰기는 사람 감사 `amux.recommendation_capacity.updated` 뒤에 `id`가 `queue`인 행 하나를 upsert한다. 감사 metadata는 `active`와 `wipLimit`만 담는다. 같은 요청을 다시 보내면 감사를 다시 남긴다. 저장한 행을 읽어 요청과 다르면 거절한다.

이 writer는 추천 풀 코드 래치와 `TOMVERSE_AMUX_BOARD_RECOMMEND`보다 앞에서 동작한다. 래치를 나중에 꺼도 용량 행을 비활성화하는 경로는 남는다. 카드 status를 바꾸지 않는다. 환경 변수를 읽거나 쓰지 않는다. `TOMVERSE_AMUX_EXECUTE`와 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`를 읽거나 쓰지 않는다. worker를 시작하지 않는다. 사람 결정 20건을 만들지 않는다.

행이 없거나 `active`가 아니거나 `wipLimit`이 비어 있으면 소비는 계속 `capacity_unconfigured`다.

## 버전 12 — 앱 내부 engineering adapter

버전 12는 Authority 절만 바꾼다. 앱 경계는 `/api/internal/amux/*` route와, 개별 Agent 정책이 승인한 앱 내부 adapter 둘이다. adapter의 규칙은 Authority 절에 있다. 승인된 adapter는 `engineering` 하나이고(`docs/policy/engineering-agent.md` §8), 그 코드 래치는 false로 출고한다. 래치를 켜는 것은 별도 버전이다. 이 버전은 worker 실행, 환경 변수, 용량 행, 자동 승격, 추천 풀을 바꾸지 않는다.

## 버전 13 — 개발용 WSL runner 예외

공통 기반의 Agent별 Railway 실행 원칙은 유지한다. 버전 13은 그 원칙을 삭제하지 않고, 개발용 runner 하나를 예외로 적는다. 예외의 실행 위치는 운영자 워크스테이션의 WSL이다. Tomverse 서버는 그 워크스테이션으로 접속하지 않는다. WSL이 Tomverse의 승인된 작업을 HTTPS로 가져가고, heartbeat와 결과를 다시 보낸다. 워크스테이션에 새 외부 수신 포트나 터널을 열지 않는다.

Tomverse의 카드, 추천, 승격, 승인, 실행 원장, 감사는 정본이다. 로컬 AMUX는 이미 떠 있는 worker에게 그 작업을 전달하는 실행기다. 로컬 보드에 같은 작업의 카드를 만들거나, 같은 attempt를 두 번 배정하지 않는다. 로컬 전송이 성공했다는 응답은 작업 완료가 아니다.

예외에서도 다음 경계는 유지한다.

- WSL worker에게 제품 DB 자격증명이나 Tomverse 내부 API 인증값을 넘기지 않는다. Bridge 프로세스가 그 인증을 가질 수 있으나 worker 입력에는 넣지 않는다.
- Bridge와 worker의 자격증명 접근은 분리한다. 환경변수를 비우는 것만으로 격리를 충족했다고 하지 않는다.
- PC 절전, WSL 종료, 통신 단절에서는 새 배정을 멈추고, 이전 generation의 뒤늦은 결과는 거절한다.
- 실행 결과로 허용하는 카드 상태는 `review`, `todo`, `blocked`뿐이다. 작업 완료를 PR 병합이나 배포 승인으로 확대하지 않는다.
- 승인된 `executionBrief`와 그 digest가 worker 입력에 들어간다. digest가 없거나 다르면 실행을 시작하지 않는다.

코드 래치 `WSL_BRIDGE_CODE_LATCH`는 false로 출고한다. `TOMVERSE_AMUX_WSL_BRIDGE`를 설정하지 않는다. `TOMVERSE_AMUX_EXECUTE`를 켜지 않는다. 래치와 활성화는 별도 버전이다. 연결 계약은 `docs/ops/amux/wsl-execution-bridge.md`다.

## 버전 14 — WSL runner 코드 래치

버전 13의 예외와 경계는 유지한다. 이 버전은 `WSL_BRIDGE_CODE_LATCH`를 true로 바꾼다. runner는 그 래치와 환경 변수 `TOMVERSE_AMUX_WSL_BRIDGE`의 값이 정확히 `1`인 것이 함께 있을 때만 `bridge_tick`에 들어간다. 로컬 AMUX 주소는 loopback만 허용한다. 세션이 이미 실행 중이 아니면 프로세스를 만들지 않는다.

이 버전은 `TOMVERSE_AMUX_WSL_BRIDGE`와 `TOMVERSE_AMUX_WSL_LOCAL_URL`을 설정하지 않는다. `TOMVERSE_AMUX_EXECUTE`를 켜지 않는다. worker 프로세스를 시작하지 않는다. 환경변수를 비운 것을 자격증명 격리의 실측으로 세지 않는다. 연결 계약은 `docs/ops/amux/wsl-execution-bridge.md`다.

## 버전 15 — WSL 실행 루프 연결

승인자 mposition, 승인일 2026-09-29. 버전 13의 예외와 경계, 버전 14의 래치는 유지한다. 이 버전은 owner 없는 Todo가 runner에 닿는 경로와, runner가 결과를 Tomverse에 돌려주는 경로를 연다. 새 환경 변수를 설정하지 않는다. 병합, 배포, 환경 변수의 활성화는 운영자가 따로 한다.

### 로컬 카드는 실행 영수증이다

버전 13의 "로컬 보드에 같은 작업의 카드를 만들지 않는다"를 이 절로 대체한다. 로컬 AMUX는 실질적인 작업 메시지에 대해 `no_board`를 거절하고 로컬 카드를 만든 뒤 메시지를 worker에게 전달한다(AMUX-3071). 그 카드를 그 attempt의 로컬 실행 기록으로 허용한다. 정본은 여전히 Tomverse다. 로컬 카드의 상태는 Tomverse 카드의 상태가 아니다.

- Bridge는 `/api/board`에 쓰지 않는다. 읽기는 `GET /api/board`와 `GET /api/board/{id}`뿐이다.
- 전송 응답의 `no_board_refused`는 거절이 아니라 "전달됨, 로컬 카드 발급"이다. 그 attempt는 진행 중이다.

### 연결과 완료 신호

- 연결: 같은 worker 세션의 카드 가운데, 생성 시각이 전송 시각 이후이고 카드에 연결된 메시지 원문에 `Execution attempt: <attempt id>` 줄이 있는 카드 하나다. 후보가 둘 이상이면 연결하지 않고 `blocked`(`local_card_ambiguous`)로 정산한다. 30분 안에 연결하지 못하면 `blocked`(`local_card_unlinked`)로 정산한다.
- 완료: 연결된 카드의 status가 `done` 또는 `verified`이면 `succeeded` → `review`다. `discarded`, `cancelled`, `quarantined`이면 `blocked` → `blocked`다. 그 밖의 status는 진행 중이다. 로컬 카드 신호로 `failed` → `todo`를 만들지 않는다. 다시 배정하는 것은 사람 Review의 retry다.
- 로컬 카드의 제목, 설명, `last_result`, evidence는 신뢰하지 않는 입력이다. Tomverse로 복사하지 않는다. 예외는 `https://github.com/mposition/Tomverse/pull/<n>` 형식의 첫 PR 번호 하나다. 서버는 그 번호를 GitHub 읽기로 검증한다.
- runtime lease를 잃은 세션은 다시 등록하지 않고 halt한다. 등록은 열린 attempt를 보지 않고 generation을 올리기 때문이다.

### settle의 review PR 번호

`execution/settle`은 `succeeded` → `review`에서만 선택적 `review_pr_number`(1 이상 2147483647 이하 정수)를 받는다. 서버는 그 번호를 카드의 `reviewPrNumber`에 같은 트랜잭션으로 기록한다. 다른 결과에 번호가 있으면 거절한다.

### 사람 Review 강제

승인된 execution brief digest가 있는 카드, 또는 `requiresHumanReview`가 true인 카드는 `done` 요청을 `review`로 바꾸고, `review`에서 사람 escalation을 연다. `review`에서 `done`으로 가는 경로는 사람 Review route뿐이다(`TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED`).

### claim 전용 모드

코드 래치 `CLAIM_ONLY_CODE_LATCH`는 true로 출고하고, 환경 변수 `TOMVERSE_AMUX_CLAIM`이 정확히 `1`일 때만 연다. 이 모드는 claim만 하고 RuntimeService와 명령 실행기를 시작하지 않는다. claim은 서버가 execution_ready로 판정한 runtime에만 간다. `TOMVERSE_AMUX_EXECUTE`와 `TOMVERSE_AMUX_CLAIM`이 함께 설정되면 orchestrator는 시작하지 않는다.

### backlog 카드 메타데이터 writer

owner와 최근 step-up이 backlog 카드 하나의 `kind`, `priority`, `estimatedCostMicrousd`만 고친다. 대상은 `backlog`, owner null, brief 없음, 보관되지 않은 카드다. revision + 1과 사람 감사를 같은 트랜잭션에 쓴다. status는 바꾸지 않는다. `estimatedCostMicrousd`는 0 이상 5,000,000 이하다. 코드 래치 true, 환경 변수 `TOMVERSE_AMUX_BACKLOG_METADATA`가 정확히 `enabled`일 때만 연다.

### 자동 승격 개정

버전 8의 졸업(사람 결정 20건, 14일), 비용 상한, 전역 3, worker당 1, grant 7일, 한 트랜잭션 한 카드는 그대로다. 바뀌는 것은 다음이다.

- grant는 승격 항목(kind, priority, classification, execution brief와 그 digest)과 비용 cent를 grant 시점에 결속한다. 사람의 사전 승인은 그 항목에 대한 것이다.
- 버전 8의 "시스템 actor는 없다"를 이 절로 바꾼다. 시스템 actor `amux-auto-promoter`가 내부 route로 소비할 수 있다. 호출자는 Railway AMUX Orchestrator이고 주기는 5분이다. 시스템 소비는 grant에 결속된 항목만 쓰고, 같은 트랜잭션 안에서 같은 필터로 만든 system snapshot을 쓴다. 사람 owner route의 소비도 남는다.
- 소비 트랜잭션은 비용 장부 행을 함께 쓴다.
- 만료된 grant는 소비 시도와 주기 호출에서 `expired`로 바꾸고 감사를 남긴다.
- 자동 경로의 결과 불명은 기록하고, 버전 8의 halt 조건에 따라 halt 행을 연다. owner와 최근 step-up의 재개 writer를 둔다.
- Admin 화면은 `/admin/amux-board-auto-promotion`이다.

## 버전 16 — 역할 판정과 단계 사이클

승인자 mposition, 승인일 2026-09-29. 버전 13~15의 예외, 래치, 로컬 카드 영수증, 사람 Review 강제는 이 절이 명시적으로 바꾸는 문장을 빼고 유지한다. 이 버전은 세 가지를 더한다.

1. 카드마다 실행 역할(`chore`, `implementation`, `contract`)을 정한다. 서버의 결정적 규칙이 기준값을 정하고, LLM 신호는 그 값을 올릴 수만 있다.
2. 한 카드가 `design → develop → test → review` 단계를 차례로 지난다.
3. review 단계는 develop을 실행한 provider와 다른 provider의 worker가 맡는다.

새 환경 변수를 설정하지 않는다. 병합, 배포, 환경 변수 활성화, worker catalog와 WSL 세션 변경은 운영자가 따로 한다.

### Authority 허용 목록 개정

Authority 절의 앱 경계 1(`/api/internal/amux/*`)에 내부 route 둘을 더한다. `role-judgement/pending`(판정 입력과 남은 일일 한도 조회)과 `role-judgement/signal`(신호 기록)이다. 호출자는 Railway AMUX Orchestrator이며, 이 서비스는 제품 DB 자격증명을 갖지 않는다. 앱 route는 모델을 호출하지 않는다.

### 적용 범위와 스위치

- 코드 래치 `STAGE_CYCLE_CODE_LATCH`는 false로 출고한다. 켜는 것은 별도 버전이다.
- 래치가 열리고 환경 변수 `TOMVERSE_AMUX_STAGE_CYCLE`이 정확히 `enabled`일 때 승격되는 카드만 `stageCycle` true로 승격한다. 이런 카드를 **단계 카드**라 부른다. 래치와 환경 변수는 서버가 읽으며, 어떤 route도 요청 본문으로 받지 않는다.
- `stageCycle`이 false인 카드(이 버전 전의 카드 포함)에는 이 절의 어떤 규칙도 적용되지 않는다. 역할 판정, 역할·제외 검사, 시도 상한 변경이 모두 없고, 버전 15의 한 단계 흐름과 시도 상한 5를 그대로 따른다.
- 스위치가 켜진 뒤 꺼지면, 단계 카드는 현재 단계를 끝낸 뒤 다음 단계로 가지 않고 lifecycle `review`(사람)로 간다.

### 역할 판정

역할의 순서는 `chore < implementation < contract`다.

**결정적 기준값(base).** 서버 순수 함수 `deriveAmuxRoutingBase()`가 계산한다. 입력은 저장된 `classification`(task_kind, complexity, risk, files_expected 개수)과 `expectedPaths`뿐이다. 제목, 설명, execution brief는 입력이 아니다.

- `contract`: 다음 가운데 하나라도 해당하면. `expectedPaths`가 없거나 비었다. 경로 하나라도 정규화에 실패한다. 정규화한 경로가 **contract 경로 목록**과 일치하거나 그 아래에 있다. task_kind가 `architecture`, `migration`, `security`다. risk가 3이다.
- `chore`: contract가 아니고, task_kind가 `iteration`, `dependency_upgrade`, `tests` 가운데 하나이며, complexity ≤ 2, risk = 1, files_expected ≤ 2, `expectedPaths` 개수 ≤ 2다.
- `implementation`: 그 밖의 모든 카드다.

**경로 정규화.** 저장소 상대 경로여야 한다. 앞의 `./` 하나만 제거하고, 그 뒤 `/`로 나눈 조각에 `.`, `..`, 빈 조각이 하나라도 있으면 거절한다. 역슬래시, 절대경로, 드라이브 문자, 제어 문자도 거절한다. 거절된 경로가 하나라도 있으면 base는 contract다. contract 경로 목록과의 비교는 양쪽을 소문자로 바꾼 뒤 한다. 대소문자만 다른 경로로 목록을 피하지 못하게 하기 위해서다.

**contract 경로 목록**(코드 상수 `AMUX_CONTRACT_PATHS`, 이 문서의 개정으로만 바꾼다): `lib/modelPricing.ts`, `lib/credit`, `lib/chatCostGuardrails.ts`, `lib/models.ts`, `lib/billingPriceCatalog.ts`, `lib/planChange`, `lib/conversationProduct.ts`, `lib/billingPromotionAdminPolicy.ts`, `lib/email`, `lib/amux/`, `prisma/`, `docs/policy/`, `docs/ui-contracts/`, `apps/tomverse-orchestrator/`, `.github/`. 끝이 `/`인 항목은 디렉터리 접두사다. 그 밖의 항목은 파일 이름 접두사다.

**LLM 신호.**

- 입력: 제목, 설명, execution brief, `classification`, `expectedPaths`. 모두 데이터이며, 구분된 JSON 한 덩어리로 모델에 넣는다.
- 출력: `{ role, reasons }`만 받는다. `role`은 세 값 가운데 하나이고, `reasons`는 고정된 코드 목록의 부분집합이다. 형식이 다르면 신호가 없는 것으로 본다.
- 최종값 = max(base, 신호). **LLM은 base보다 낮은 값을 만들지 못한다.** 신호가 없으면 최종값은 base다. 외부 텍스트가 바꿀 수 있는 것은 더 높은 역할, 곧 더 긴 파이프라인뿐이다.

**시각과 상태.**

- 단계 카드의 승격 트랜잭션은 `promotedAt`을 `clock_timestamp()`로 쓰고, `routingRole`, `stage`, `requiredRoutingRole`은 null로 둔다. `stageCycle`이 true이고 `routingRole`이 null인 카드는 **판정 대기**이며, 라우터와 claim이 모두 거절한다.
- `signal` route는 role, reasons, 호출에 쓴 모델 id, 모델이 보고한 입력·출력 토큰 수만 받는다. 서버는 base를 저장값으로 다시 계산하고, 최종값을 정하고, 판정 행을 추가한다. `routingRole IS NULL`인 조건부 update 한 번으로 `routingRole`, 첫 `stage`, `requiredRoutingRole`, `stageEnteredAt`을 쓴다.
- 신호의 유효 창은 `promotedAt`부터 DB 시계로 10분이다. 창이 지나면 기존 recover 주기가 판정 대기 카드에 신호 없는 판정(base)을 같은 조건부 update로 쓴다. 창 뒤에 도착한 신호는 판정 행만 추가하고 카드를 바꾸지 않는다.
- 판정 결과는 시스템 감사 `amux.role.judged`로 남는다. owner는 최근 step-up 후 `routingRole`을 더 높은 값으로만 바꿀 수 있고(사람 감사 `amux.role.raised`), 그때 첫 단계와 담당도 다시 쓴다. 이 변경은 카드가 아직 claim된 적이 없을 때만 받는다.

**모델.**

- 기본값은 `gpt-6-sol`이다. 설정은 `AppSetting` 한 행이며, owner가 최근 step-up 후 Admin AMUX › Promotion의 **역할 판정 모델** 설정에서 바꾼다. 이 설정은 카드 승격 route와 별개의 route이고, 변경은 사람 감사 `amux.role_model.changed`로 남는다.
- 고를 수 있는 모델은 세 조건을 모두 만족해야 한다. 운영 모델 레지스트리에서 활성이다. `resolveModelPricing()`의 `costSource`가 `conservative_fallback` 계열이 아니다. provider가 orchestrator adapter가 구현한 provider(이 버전에서는 `openai`)다. 저장된 모델이 나중에 이 조건을 잃으면, 그 뒤의 판정은 신호 없이 base로 한다.
- 호출 키는 orchestrator 서비스에만 있는 전용 변수이며, 앱의 Chat provider 키와 다르다.
- `pending` route는 판정 입력, 남은 일일 한도와 함께 **호출할 모델 id**를 돌려준다. 저장된 모델이 세 조건을 통과할 때만 id를 주고, 아니면 `call: false`를 준다. orchestrator는 `call: false`이거나 전용 키가 없으면 모델을 부르지 않고, 그 카드는 신호 없음(base)이 된다. 모델 id를 orchestrator의 설정이나 기본값에서 정하지 않는다.
- `signal` route는 호출에 쓴 모델 id를 함께 받는다. 서버는 그 id가 판정 시점의 저장 모델과 같고 세 조건을 통과할 때만 신호를 쓴다. 다르면 신호를 버리고, 비용은 그 id의 단가로 판정 행에 남긴다.

**비용과 한도.**

- 판정 비용은 서버가 보고된 토큰 수와 판정 시점의 `resolveModelPricing()` 단가로 계산해 판정 행에 microusd로 쓴다. 판정 행은 attempt가 없는 별도 원장이며, 버전 12 비용 namespace의 일부이다. 사용자 크레딧, 플랜, Chat provider 예산과 섞지 않는다.
- 일일 한도는 DB 시계 UTC 일 기준 US$5다. `pending` route가 남은 한도를 함께 돌려주고, 한도가 0 이하이면 orchestrator는 모델을 부르지 않는다. 한도를 넘긴 뒤 도착한 신호는 판정 행에 비용만 남기고 신호 없음으로 처리한다.
- 호출 하나는 출력 512 토큰 이하, 60초이며, 서비스가 마감에 강제 종료한다.

### 단계

| 단계 | 담당 역할(`requiredRoutingRole`) | 산출물 |
|---|---|---|
| design | `contract` | 설계 메모를 담은 draft PR |
| develop | `routingRole` 값 | 같은 PR의 구현 커밋 |
| test | `tests` | 같은 PR의 테스트 커밋 |
| review | `review` | 로컬 카드 종료 상태로 전하는 판정 |

- `routingRole`이 contract 또는 implementation이면 첫 단계는 `design`이고 네 단계를 모두 지난다. chore이면 첫 단계는 `develop`이고 다음은 `review`뿐이다.
- `requiredRoutingRole`은 현재 단계의 담당만 담는다. 원래 역할은 불변 `routingRole`에 있다.
- 라우터의 `execution_ready`와 후보 `dispatch_ready`, 그리고 claim 트랜잭션이 같은 역할·제외 판정을 한다. claim은 카드 행 CAS 전에 트랜잭션 안에서 다시 한다.

### 단계 전진

단계 카드의 settle이 `succeeded`이고 현재 단계가 마지막이 아니면, 그 settle 트랜잭션의 update 한 번에서 다음을 한다.

- status `todo`, owner null, `stage`를 다음 단계로, `requiredRoutingRole`을 다음 단계 담당으로, `stageEnteredAt`을 `clock_timestamp()`로 쓰고, revision을 1 올린다.
- PR 번호가 있으면 `reviewPrNumber`, `requiresHumanReview` true, `reviewSpecialty` `code-review`를 함께 쓴다.
- 시스템 감사는 `amux.stage.advanced`다. 사람 escalation은 lifecycle status가 `review`가 될 때만 연다.

마지막 단계(review)의 `succeeded`는 버전 15대로 lifecycle `review`로 가고 사람 Review를 기다린다. 이중 전진은 attempt의 `endedAt` 조건부 update와 카드 revision CAS가 막는다.

### 버전 15의 완료 신호 개정 (단계 카드에만)

- delivery pull 응답에 `stage` 필드를 `prompt`와 분리해 둔다. 서버가 카드 행에서 복사한 값이며, 단계 카드가 아니면 null이다.
- 브리지는 로컬 카드 status를 `blocked`로 접기 전에 `stage`를 읽는다. `stage`가 `review`이고 로컬 status가 `discarded` 또는 `cancelled`일 때만, 사유 `review_changes_requested`로 `blocked` 정산한다. 이 사유를 `AMUX_BRIDGE_SETTLE_REASONS`에 더한다. 그 밖의 경우는 버전 15 그대로다(`quarantined`, `local_card_unlinked`, `local_card_ambiguous`는 `blocked`).
- 서버는 그 사유이고 카드의 **저장된** `stage`가 `review`일 때만, 같은 settle 트랜잭션에서 되감는다. 되감기는 status `todo`, owner null, `stage` `develop`, `requiredRoutingRole` = `routingRole`, `stageRound` + 1, `stageEnteredAt` 갱신, revision + 1이다. 시스템 감사는 `amux.stage.review_rejected`다.
- 증가 후 `stageRound`가 2 이상이면 되감지 않고 lifecycle `blocked`로 두고 escalation(`stage_review_rounds_exhausted`)을 연다.
- 로컬 신호로 `failed → todo`를 만들지 않는다는 버전 15 규칙은 그대로다. 사람 Review의 retry는 단계 카드를 `develop`으로 되돌리고 `stageRound`를 1 올린다.

### 실제 실행 provider

- 브리지는 runtime 등록과 heartbeat에 로컬 AMUX 세션 목록의 `provider` 값을 선택 필드로 싣는다. 서버는 값과 catalog provider를 둘 다 소문자로 바꾸고 `claude-code`를 `claude`로 접은 뒤 비교한다. 다르면 등록 또는 heartbeat를 `provider_mismatch`로 거절한다.
- **확인된 provider**는 값이 있고 일치하며, 허용 목록 `AMUX_VERIFIED_PROVIDERS`(이 버전에서는 `claude`, `codex`)에 드는 것이다. 로컬 AMUX는 목록 밖의 provider를 claude 바이너리로 실행하므로, `devin`이나 `cursor` 같은 값은 로컬 AMUX에 그 provider의 실행 adapter가 생긴 뒤 이 문서의 개정으로만 목록에 들어간다.
- 필드가 없는 등록은 버전 15처럼 받는다. 그 runtime의 provider는 **미확인**이다. 미확인 runtime은 단계 카드를 claim하지 못하고, `stageCycle`이 false인 카드만 받는다. 그래서 이 검사는 단계 래치가 꺼진 버전 15 세션을 멈추지 않는다.
- runtime 행에 확인된 provider 컬럼을 둔다. 제외 판정은 이 컬럼만 읽는다.

### 공급자 교차 검토와 대기

- develop 단계의 `succeeded` settle은 같은 트랜잭션에서 append-only `AmuxStageRun`에 worker와 runtime의 확인된 provider를 쓴다.
- review 단계 claim은 가장 최근 develop 성공 행의 provider와 **다른 확인된 provider**의 worker에게만 간다. 그 행이 없으면 거절한다.
- test 단계 claim은 가장 최근 develop 성공 행과 **다른 worker**에게만 간다. 다른 provider가 가능하면 그쪽을 먼저 고른다.
- 대기 시작은 그 단계의 `stageEnteredAt`(DB 시계)이다. 24시간 이상 claim되지 않으면, 기존 recover 주기의 새 스캔이 escalation을 연다. 사유는 `review_provider_unavailable`, `test_worker_unavailable`이다.
- escalation은 카드당 열린 행이 하나다. 같은 사유의 열린 행이 있으면 새로 열지 않는다. 다른 사유의 열린 행이 있으면 그 행을 두고 새 사유는 감사에만 남긴다. 사람은 이미 그 카드를 보고 있다.
- escalation 사유 allowlist에 `review_provider_unavailable`, `test_worker_unavailable`, `stage_review_rounds_exhausted`, `stage_cost_exceeded`, `stage_attempts_exhausted`를 더한다.

### 시도와 비용 상한 (단계 카드에만)

- attempt start는 시도 행에 `stage`와 `stageRound`를 쓴다. 상한은 `(stage, stageRound)`별 2회, 카드 전체 10회이고, 넘으면 `blocked`와 escalation(`stage_attempts_exhausted`)이다. `stageCycle`이 false인 카드는 상한 5 그대로다.
- 비용: 이 절이 버전 12가 미뤄 둔 비용 원장의 admission 사용이다. 합은 카드의 attempt마다 정산액 하나(미정산이면 그 attempt의 예약액 하나, project와 team scope에 중복된 예약은 한 번만)와 그 카드의 판정 행 비용이다. 합이 `estimatedCostMicrousd`의 3배를 넘으면 다음 claim과 같은 단계의 다음 attempt start를 `stage_cost_exceeded`로 거절하고 escalation을 연다. `estimatedCostMicrousd`가 null이면 기존 `cost_estimate_missing`이다.

### 승격 입력

- 수동 승격 항목 스키마와 자동 승격 grant의 결속 항목에 `expectedPaths`를 더한다. 단계 카드로 승격되는 요청에서만 필수이고, 1개 이상 50개 이하, 항목당 300자 이하다.
- 단계 카드가 아닌 행의 `expectedPaths`는 null이다. 기존 행은 바꾸지 않는다.

### 저장

- `AmuxWorkItem`: `stageCycle`(boolean, 기본 false), `promotedAt`, `routingRole`(null 또는 세 값, CHECK), `stage`(null 또는 네 값, CHECK), `stageRound`(null 또는 0 이상, 컬럼 기본값 없음; 단계 카드를 만드는 트랜잭션이 0을 쓴다), `stageEnteredAt`, `expectedPaths`(text[] 또는 null). CHECK: `stageCycle`이 false이면 앞의 단계 컬럼은 모두 null이다.
- `AmuxExecutionAttempt`: `stage`, `stageRound`(단계 카드에서만 non-null).
- `AmuxWorkerRuntime`: `verifiedProvider`(null 또는 허용 목록 값).
- `AmuxRoleJudgement`(append-only): taskId, base, 신호 role, reasons, 모델 id, 입력·출력 토큰, 비용 microusd, 창 안 여부, 한도 초과 여부, 최종 적용 여부, createdAt. 제목·설명·brief와 모델 출력 원문은 저장하지 않는다.
- `AmuxStageRun`(append-only): taskId, stage, round, worker, provider, attemptId(unique), outcome, prNumber, createdAt.
- 두 append-only 테이블에는 UPDATE와 DELETE를 막는 trigger를 둔다.

### 이 버전이 하지 않는 것

PR 병합, `review` → `done`, 배포, worker catalog 변경, WSL 세션 추가, 자동 승격의 조건 변경을 하지 않는다. 로컬 AMUX의 새 provider adapter(예: Cursor)는 이 저장소 밖의 일이며, 생긴 뒤에도 `AMUX_VERIFIED_PROVIDERS` 개정 전에는 단계 카드를 받지 못한다.

## 버전 18 — 실행 API 게이트

승인자 mposition, 승인일 2026-09-29. 버전 13~17은 유지한다. 이 버전은 「Phase A selection-only boundary」 절의 한 문단과, 두 브랜치가 서로 다르게 구현한 실행 API 게이트를 하나로 정한다.

### 무엇이 달랐나

- `develop`의 `lib/amux/executionGate.ts`는 `NODE_ENV`가 `test`일 때만 실행 API를 연다. 배포된 빌드는 환경 변수로 열 수 없다.
- `main`의 같은 파일은 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`가 trim 후 정확히 `1`이면 연다. 버전 13~15의 WSL 실행 루프는 이 경로로 운영 중이다.
- 「Phase A selection-only boundary」 절은 "claim과 그 뒤의 worker 등록·heartbeat, owned queue, execution, delivery, settlement은 Phase A production에서 비활성이다"라고 적는다. 버전 15는 claim 전용 모드와 실행 루프를 승인했지만, 이 문장을 명시적으로 개정하지 않았다.

### 개정

「Phase A selection-only boundary」 절의 두 번째 문단 첫 문장을 다음으로 바꾼다.

> `claim`과 그 뒤의 worker 등록·heartbeat, owned queue, execution, delivery, settlement(이하 **실행 API**)는 코드 래치 `AMUX_EXECUTION_API_CODE_LATCH`가 true이고, 환경 변수 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`가 trim 후 정확히 `1`일 때만 열린다. 판정은 `NODE_ENV`와 무관하다. 둘 중 하나라도 아니면 실행 API는 `execution_api_disabled`로 거절한다.

같은 문단의 나머지는 유지한다. 특히 다음은 바뀌지 않는다.

- local process executor는 production에서 실행할 수 없으며, 환경 변수만으로 그 금지를 해제하지 못한다.
- 실행 API가 열려도 worker 실행은 버전 13의 WSL runner 예외와 버전 12의 승인된 adapter(그 자신의 래치 포함)를 통해서만 일어난다.
- `queue`와 `routing-snapshot` 같은 선택 전용 route의 production 활성화, 그리고 개별 Agent의 실행 허용은 각자의 승인이다.

### 코드 래치

- `AMUX_EXECUTION_API_CODE_LATCH`는 `lib/amux/executionGate.ts`의 코드 상수이고, 이 버전은 **true로 출고**한다. 버전 15가 이미 운영 중인 실행 루프를 승인했기 때문이다.
- 게이트는 래치와 환경 변수를 인자로 받는 순수 함수 하나로 판정하고, 공개 함수는 그 함수에 출고 상수와 환경 값을 넘긴다.
- 테스트가 고정하는 것: 출고 상수가 true다. 래치가 false이면 환경 값이 `1`이어도 닫힌다. 래치가 true이고 환경 값이 `1`이면 `NODE_ENV`가 `production`이어도 열린다. 환경 값이 비었거나 `1`이 아니면 닫힌다.
- 기존 단위 테스트 `tests/amuxClaimContractParity.test.mjs`의 "a production build cannot activate future execution with an environment flag"는 위 동작으로 바꾼다. 환경 변수를 비우면 `execution_api_disabled`인 기존 DB 통합 테스트는 유지한다.
- 래치를 false로 되돌리는 것은 닫는 변경이며, 이 문서의 개정 없이 할 수 있다. 여는 변경(false → true)은 이 문서의 개정이다.
- `lib/amux/dbBoundary.ts`의 "Future execution stays hard-disabled until the DB is proven…" 주석은 게이트를 바꾸는 같은 커밋에서 이 버전과 맞게 고친다.

### 활성화 증거

같은 절의 "실행 경로 활성화 전에는 같은 DB 통합 테스트가 late COMMIT의 성공 기록 방지와 read-back 식별·멱등을 증명해야 한다"는 문장은 유지한다. 이 버전은 다음을 사실로 적는다.

- **late COMMIT의 성공 기록 방지는 버전 19부터 DB가 강제하고, 테스트가 그것을 증명한다.** 모든 AMUX mutation 트랜잭션은 fence에서 기한 `D`(트랜잭션·route·lease 기한 가운데 가장 이른 것에서 commit 예비시간을 뺀 값)를 `AmuxCommitDeadline` 행으로 남긴다. `DEFERRABLE INITIALLY DEFERRED` constraint trigger가 COMMIT 시점에 DB 시계로 `D`를 넘었으면 SQLSTATE `AX001`로 트랜잭션 전체를 거부한다(migration `20260929200000_amux_commit_deadline_check`). 증거는 `tests/integration/amux-orchestration.db.test.ts`의 late COMMIT 테스트 여섯 개다. #1765의 head `4339769bfa71164d30ff7a62fb40dd331ef65f92`에서 `Credit Finance DB Integration`의 `routing` 레인이 녹색이었다(https://github.com/mposition/Tomverse/actions/runs/36571093799/job/109415331084). 핵심은 "a settle whose COMMIT lands after its commit deadline is refused by the database"와 "a COMMIT whose recorded deadline has passed is refused at COMMIT, not at the insert"다. commit fence rollback, statement timeout rollback, HTTP 응답 유실 뒤 read-back, delivery pull·ack 멱등은 여전히 그 증명이 아니다.
- DB가 막지 못하는 구간은 남는다. trigger 검사 뒤의 commit record 기록과 flush, BEGIN부터 첫 문장까지, 기한이 없는 owner 자동 승격 트랜잭션과 catalog `tasks` upsert다. COMMIT 단계에서 `AX001`이 아닌 오류(`57014` 포함)는 롤백 확정이 아니라 결과 불명으로 분류한다.
- 버전 15의 운영 활성화는 운영자가 환경 변수를 켠 결정이며, 그 시점에 위 증명은 없었다. 이 버전과 버전 19는 그 결정을 소급해 증명된 것으로 만들지 않는다. `main`의 코드는 이 장치를 `develop`의 AMUX가 옮겨질 때 갖게 된다.
- `develop`의 AMUX를 `main`으로 옮기는 병합은 다음을 모두 만족할 때만 한다.
  1. deadline이 지난 뒤 COMMIT된 실행이 성공으로 기록되면 **실패하는** 새 DB 통합 테스트가, `Credit Finance DB Integration` 워크플로의 matrix `routing` 레인에 들어 있다.
  2. 그 레인이 병합 대상 PR의 **head SHA**에서 녹색이다. 기존 테스트만의 녹색이나 PR Fast Gate의 녹색은 이 조건을 충족하지 않는다.
  3. PR 본문에 그 run의 링크와 head SHA를 적는다.

  1은 버전 19 시점에 `develop`에서 충족됐다. 2와 3은 `main`으로 옮기는 PR 자체의 head SHA에 대해 다시 충족해야 한다.
- 이 레인은 required branch protection이 아니다. 위 조건은 병합하는 사람이 확인하는 규칙이다.

### 이 버전이 하지 않는 것

환경 변수를 설정하거나 바꾸지 않는다. 운영 중인 루프의 동작을 바꾸지 않는다. `main`의 현재 조건 "환경 변수 `1`"에 "래치 true"가 더해질 뿐이다. worker catalog, WSL 세션, 자동 승격, engineering adapter 래치, 단계 사이클 래치를 바꾸지 않는다.

## 버전 20 — orchestrator 정지(halt)와 재시작

승인자 mposition, 승인일 2026-09-30. 버전 13~19는 유지한다.

### 무엇이 문제였나

- AMUX Orchestrator(`apps/tomverse-orchestrator`, Railway 서비스)는 결과 불명 claim(`AMUX_CLAIM_OUTCOME_UNKNOWN`), 결과 불명 recover(`AMUX_RECOVERY_OUTCOME_UNKNOWN`), 그 밖의 내부 API 실패(`AMUX_INTERNAL_API_UNVERIFIED`)에서 모두 종료 코드 1로 끝난다.
- Railway 재시작 정책은 종료 코드를 가르지 못한다. 서비스에 정책이 명시돼 있지 않아 기본값 `On Failure`(최대 10회)가 적용되고, 결과 불명 쓰기 뒤에도 사람의 확인 없이 다시 시작한다. 공통 기반의 결과 불명 규칙(재시도하지 않고, 대상을 멈추고, 확인하고, 사람에게 넘긴다)과 "사람의 정지는 사람이 푼다"에 어긋난다.
- `Never`로 두면 일시적인 종료도 사람을 기다린다. 2026-09-30 05:51Z와 05:58Z의 종료(웹 배포 중 routing snapshot의 전송 실패와 500)가 그랬고, 두 번째 뒤에는 다시 시작되지 않았다.
- 멈춘 사실은 Railway의 CRASHED 표시와 로그로만 드러난다. 서버가 결과 불명 응답에 싣는 `incident_id`는 로그의 상관 id이고 DB 행이 아니다. 프로세스가 죽으면 결과 불명이었다는 사실도 함께 사라진다.

### 용어

- **쓰기 호출**: orchestrator의 claim, recover, 자동 승격 tick. 셋 다 route 기한 안에서 버전 19의 commit fence를 지난다. fence는 기한 뒤의 COMMIT을 `AX001`로 거부하지만, 버전 19가 남긴 구간(trigger 통과 뒤의 commit record flush)의 실패는 롤백 확정이 아니며 서버는 503 `amux_outcome_unknown`으로 답한다. 그 답은 ack하지 않는다. 이 구간은 4의 접수 행 잠금이 덮는다.
- **알려진 답**: 아래 1의 목록. 쓰기가 일어나지 않았거나, 일어난 쓰기를 응답이 확정하는 답이다.

### 개정

**1. 알려진 답은 지금처럼 처리한다.** 다음만 알려진 답이다. 그 밖의 모든 응답과 무응답은 2에 따라 정지한다.

- claim: 본문이 계약과 맞는 2xx(CAS 패배의 200 `{claimed:false}` 포함), 닫힌 거절의 409(현재 파서가 인정하는 reason).
- recover: 본문이 계약과 맞는 2xx, 409 `execution_api_disabled`(현재 파서가 `Ok`로 받는 형태).
- 자동 승격 tick: 본문이 계약과 맞는 200(reason과 무관하다. 현재 `autoTickHttpStatus`가 결정적 거절, `no_grant`, `route_budget_exhausted`, `auto_halted`를 모두 200으로 준다), 409 `apply_disabled`. 409 `outcome_unknown`·`expiry_outcome_unknown`은 알려진 답이 아니다.
- 모든 내부 호출: 503 가운데 와이어 reason이 정확히 `amux_database_busy`, `amux_database_deadline_exceeded`, `amux_database_call_ceiling_exceeded`인 것. 서버는 **그 요청에서 영수증(4)이 하나라도 커밋된 뒤에는 이 셋을 보내지 않고** 503 `amux_outcome_unknown`으로 답한다. 따라서 이 셋은 "이 요청은 아무것도 커밋하지 않았다"는 답이다. orchestrator가 이 답으로 ack할 때 서버는 영수증 수를 다시 세고, 영수증이 있으면 ack를 거절한다. 거절된 ack는 `unacked_write_receipt` 정지다.
- 선택 읽기(queue, routing snapshot): `board_capacity_exceeded`와 위 503 셋. 이것들은 그 tick을 claim 없이 끝내고, 실패로 세지 않으며, 횟수를 되돌리지도 않는다. 그리고 전송 실패, 404, 위 503 셋이 아닌 5xx, 429. 뒤의 것들은 실패로 센다. 단위는 실패한 queue 또는 routing snapshot 응답 하나이고, 그 실패에서 tick을 끝낸다. 60번째 연속 실패까지 tick만 건너뛰고 61번째에 2의 `selection_read_failures`로 정지한다. 횟수는 tick이 끝난 뒤 그 tick의 선택 읽기가 모두 성공했을 때, 그리고 정지가 풀려 재개할 때 0이 된다.

**2. 정지 사유는 닫힌 목록이다.** 다음에서 orchestrator는 **정지(halt)** 한다. 프로세스는 끝내지 않는다. 정지는 응답을 처리하는 그 자리에서, 다음 쓰기 호출 전에 일어난다.

| 사유 코드 | 조건 | 접수(4)가 있는가 |
|---|---|---|
| `claim_outcome_unknown` | claim이 1에 없는 응답을 받았거나 응답을 받지 못했다 | 있다(서버에 닿았다면) |
| `recovery_outcome_unknown` | recover가 위와 같다 | 있다(서버에 닿았다면) |
| `promotion_outcome_unknown` | 자동 승격 tick이 위와 같다. 409 `outcome_unknown`·`expiry_outcome_unknown`은 여기다 | 있다(서버에 닿았다면) |
| `unacked_write_receipt` | 4의 판정에서 사람 확인이 필요하거나, 1의 503 셋에 대한 ack가 거절됐다 | 있다 |
| `contract_violation` | 쓰기가 아닌 호출(선택 읽기, ack, 정지 기록·상태 읽기)이 본문이 계약과 다른 2xx·400·409를 받았거나, 401·403을 받았다 | 없다 |
| `selection_read_failures` | 1의 선택 읽기 연속 실패가 61번째에 이르렀다 | 없다 |

저장되지 않는 대기 상태가 셋 있다. `ack_pending`(4, ack가 아직 성공하지 않음), `halt_unreadable`(6), `awaiting_deadline`(6). 이 셋 동안에도 쓰기 호출과 선택 읽기를 하지 않는다. 정지 상태의 orchestrator는 쓰기 호출과 선택 읽기를 하지 않는다. 30초마다 정지 상태 읽기(5) 하나만 하고, 5분마다 ERROR 한 줄(사유 코드 또는 대기 상태 이름, 정지 id)을 남긴다. 자격증명, URL, 응답 본문은 남기지 않는다.

**3. 종료는 다음에만 남는다.** 시작 설정 오류(필수 환경 변수 부재·형식 오류, `TOMVERSE_AMUX_EXECUTE`와 `TOMVERSE_AMUX_CLAIM`이 함께 켜진 충돌, 시작 시 정지 상태 읽기의 401·403), panic, 그리고 `TOMVERSE_AMUX_EXECUTE`가 켜진 실행 모드의 `AMUX_WORKER_POLL_UNVERIFIED`·`AMUX_BOARD_TICK_UNVERIFIED`다. 실행 모드는 production에서 쓰지 않으며 이 버전이 바꾸지 않는다. `TOMVERSE_AMUX_ENABLED`가 꺼져 끝나는 경우는 지금처럼 0이다. 어느 종료든 재시작은 6을 먼저 지난다.

**4. 쓰기 접수와 영수증.** 쓰기 호출의 결과 불명이 프로세스와 함께 사라지지 않게 한다.

- orchestrator는 프로세스 시작마다 새 인스턴스 id(UUID)를 만들고, 쓰기 호출마다 새 요청 id(UUID)를 보낸다.
- **접수.** 서버는 쓰기 호출을 처리하기 전에 짧은 별도 트랜잭션으로 `AmuxOrchestratorWrite`(요청 id PK, 인스턴스 id, 호출 종류, `admittedAt`, `deadlineAt`, `ackedAt`, `resolvedAt`, `resolution`)를 커밋한다. `admittedAt`은 그 트랜잭션의 `clock_timestamp()`이고 `deadlineAt`은 거기에 그 route의 예산을 더한 값이다(Node 시계를 쓰지 않는다). 접수를 커밋하지 못하면 쓰기를 시작하지 않고 503 `amux_database_busy`로 답한다. 같은 요청 id의 두 번째 접수는 409 `duplicate_request`로 거절한다. 이 답은 알려진 답이 아니다.
- **영수증과 잠금.** 그 요청에서 상태를 바꾸는 모든 트랜잭션(카드의 owner·revision·status, claim 결정, attempt, 자동 승격 grant·소비, quota 관측 삭제)은 변이 전에 자기 접수 행을 `FOR UPDATE`로 잡고 커밋까지 유지한다. 접수가 이미 해결됐으면(`resolvedAt`이 있으면) 변이 없이 롤백한다. 같은 트랜잭션에서 `AmuxOrchestratorWriteReceipt`(요청 id, 대상 종류, 대상 id 또는 null, 행 수, `committedAt` DB 시계)를 남긴다. 대상 종류는 닫힌 목록(작업 카드, claim 결정, attempt, 자동 승격 grant, 자동 승격 소비, quota 관측 묶음)이다. 제목, brief, 본문은 넣지 않는다. 쓰기가 롤백되면 영수증도 없다. 거절 감사만 남기는 트랜잭션(예: `amux.claim.refused`, CAS 패배의 거절 감사)은 영수증을 남기지 않는다. 그 트랜잭션은 소유권과 상태를 바꾸지 않으므로, 응답 전에 죽은 보통 거절은 4의 판정에서 롤백 확정과 같이 `no_commit`으로 닫힌다. 이때 `no_commit`은 "상태 변경 없음"이며 감사 행의 부재를 뜻하지 않는다.
- **ack.** orchestrator는 1의 알려진 답을 받으면 그 요청 id를 ack한다. ack의 종류는 둘이다. `definite`는 2xx와 409 거절에 대한 것이며 영수증이 있어도 성공한다(응답이 그 커밋을 확정했다). `no_commit`은 503 셋에 대한 것뿐이며, 서버는 접수 행을 `FOR UPDATE`로 잡은 뒤 영수증을 세어 1 이상이면 거절한다. 거절된 ack는 그 자리에서 `unacked_write_receipt` 정지다. ack는 멱등이다.
- **ack가 끝나기 전에는 다음 쓰기를 하지 않는다.** 이번 요청의 ack가 성공하거나, 그 요청의 정지 행이 커밋되기 전에는 orchestrator는 다음 쓰기 호출을 하지 않는다. ack가 무응답·전송 실패·5xx이면 ack만 30초마다 다시 보낸다(쓰기의 재시도가 아니다). 그 사이 프로세스가 죽으면 4의 판정이 그 접수를 찾는다. 결과 불명이면 ack하지 않는다.
- **판정(서버, DB 시계).** ack되지 않고 해결되지 않은 접수 각각에 대해 그 접수 행을 `FOR UPDATE`로 잡은 뒤 영수증을 센다. 잠금이 진행 중인 쓰기 트랜잭션과 판정을 직렬화한다.
  - `deadlineAt` + 5초 이전이면 **미정**이다.
  - 그 뒤이고 영수증이 0이면 **롤백 확정**이다. 잠금을 잡은 시점에 진행 중인 쓰기 트랜잭션은 없고, 이후의 쓰기 트랜잭션은 해결된 접수를 보고 롤백하며, 버전 19의 fence가 `D` 뒤의 커밋을 거부한다. 서버는 `resolution = no_commit`, `resolvedAt`을 쓰고 시스템 감사 `amux.orchestrator.write_resolved`를 같은 트랜잭션에서 남긴다. 결과 불명을 DB의 증거로 확정한 것이며 쓰기의 재시도가 아니다.
  - 그 뒤이고 영수증이 1 이상이면 **사람 확인 필요**다.
- 판정은 인스턴스 id와 무관하다. 단 이 프로세스가 지금 응답을 기다리는 요청은 판정 밖이다.

**5. 정지 기록과 정지 상태 읽기.**

- 새 테이블 `AmuxOrchestratorHalt`: `id`, `haltKey`(unique), `reasonCode`(2의 닫힌 목록, DB CHECK), 관련 요청 id(있으면), `openedAt`(DB 시계), `clearedAt`, `clearedByUserId`, `clearAuditLogId`(unique). 행은 삭제하지 않는다. DB trigger가 `clearedAt`·`clearedByUserId`·`clearAuditLogId`를 한 번만 쓸 수 있게 하고 다른 갱신을 거절한다.
- `haltKey`는 요청 id가 있는 사유면 그 요청 id, 그 밖은 orchestrator가 만든 UUID다.
- 여는 쓰기는 내부 route `POST /api/internal/amux/orchestrator/halt`(기존 내부 route 인증) 하나다. 같은 `haltKey`의 재전송은 기존 행을 돌려준다. 이 route는 insert만 하고 해제를 받지 않는다. 시스템 감사 `amux.orchestrator.halted`를 같은 트랜잭션에서 `writeSystemAuditLog`로 남긴다. actor는 기존 `tomverse-amux-orchestrator`다.
- 기록이 실패하면 orchestrator는 메모리의 정지를 유지하고 30초마다 같은 `haltKey`로 다시 기록한다.
- **기록 전에 프로세스가 죽으면**: 접수가 있는 사유(표의 앞 네 줄)는 접수가 남아 있으므로 6의 시작 판정이 그 요청을 다시 찾는다. 접수가 없는 사유(`contract_violation`, `selection_read_failures`)는 사라진다. 이 둘은 쓰기의 결과 불명이 아니며, 새 프로세스는 같은 조건을 다시 만나면 다시 정지한다(선택 읽기 횟수는 0부터 다시 센다). 이것을 이 버전의 알려진 한계로 둔다.
- 정지 상태 읽기 `GET /api/internal/amux/orchestrator/halt`는 판정을 먼저 적용한 뒤 열린 정지 목록, 미정 접수 수와 가장 늦은 `deadlineAt`, 사람 확인이 필요한 요청 목록을 돌려준다.
- 감사 metadata 허용 값: `systemActor`, 정지 id, `haltKey`, 요청 id, 사유 코드, 호출 종류, resolution. 카드 제목, brief, source key, 자유 텍스트, 오류 본문은 넣지 않는다.
- `AmuxOrchestratorHalt`는 사람의 id(`clearedByUserId`)를 가지므로 데이터 도메인 레지스트리에 운영 기록으로 등록하고 고객 export에 넣지 않는다(버전 8의 `AmuxRecommendationAutoHalt`와 같은 모양). `AmuxOrchestratorWrite`와 `AmuxOrchestratorWriteReceipt`는 사용자 데이터가 없어 레지스트리 대상이 아니며, 고객 export에도 넣지 않는다(버전 8의 결과 불명·비용 장부 테이블과 같다). 이 문장은 버전 21(2026-09-30)이 개정했다. ack되거나 해결된 접수와 그 영수증은 90일 보존 뒤 지울 수 있다. 그렇지 않은 것은 지우지 않는다.

**6. 시작과 재개.**

- 시작 직후, 다른 어떤 호출보다 먼저 정지 상태 읽기를 한다.
  - 읽기가 전송 실패, 5xx, busy, 404(웹이 아직 이 버전을 배포하지 않음)이면 `halt_unreadable`로 기다리며 30초마다 다시 읽는다. 401·403은 종료다(3).
  - 미정 접수가 있으면 `awaiting_deadline`으로 기다린다. 가장 늦은 `deadlineAt` + 5초 뒤에 다시 읽는다.
  - 사람 확인이 필요한 요청이 있으면 각각에 대해 `unacked_write_receipt` 정지를 기록하고 정지 상태로 들어간다.
  - 열린 정지가 있으면 정지 상태로 들어간다.
- `halt_unreadable`과 `awaiting_deadline`은 저장된 정지가 아니며 메모리 정지나 저장된 정지를 덮어쓰지 않는다. 로그로만 드러나고 badge에는 나오지 않는다.
- **스케줄 시작·재개 조건(한 문장):** 메모리의 정지가 없고, 성공한 정지 상태 읽기에서 열린 정지가 0, 미정 접수가 0, 사람 확인이 필요한 요청이 0이며, 이 프로세스가 기록한 모든 정지 행에 사람 감사 `amux.orchestrator.halt_cleared`가 있을 때만 스케줄을 시작하거나 다시 시작한다. 다른 프로세스가 연 열린 정지는 그 읽기가 막는다.
- 메모리의 정지는 그 정지가 기록되고 사람이 해제한 것을 읽었을 때만 사라진다. 빈 목록을 읽었다는 사실만으로는 사라지지 않는다.
- 재배포, 재시작, Railway의 자동 재시작은 **저장된** 정지와 해결되지 않은 접수를 풀지 않는다. 기록되지 않은 비쓰기 정지는 5의 한계대로 사라질 수 있다.


**7. 해제는 사람이 한다.**

- 화면은 `/admin/amux-execution?tab=halts`다. 열린 정지와 해제된 정지, 사람 확인이 필요한 요청과 그 영수증의 대상(종류와 id, 카드·attempt·grant·소비 행으로 가는 링크)을 보여 준다. 탭과 Execution 항목에 열린 정지 개수 badge(`amuxOrchestratorHalts`)를 단다. 개수를 모르면 badge를 그리지 않는다. 항목의 badge는 기존 escalation 수와 이 수의 합이다.
- 해제는 owner 역할과 최근 step-up이 필요하다. step-up이 오래됐으면 `adminRecentAuthenticationHref()` 링크를 보여 준다. 해제 요청은 정지 id와, 사람이 입력한 `haltKey`의 앞 8자를 받는다. 틀리면 거절한다.
- 해제는 사람 감사 `amux.orchestrator.halt_cleared`를 `writeAdminAuditLog`로 같은 트랜잭션에서 남기고, 관련 요청 id가 있으면 그 접수를 `resolution = human_confirmed`로 닫는다(그 요청의 모든 영수증이 함께 닫힌다).
- 해제는 원래 작업을 다시 하지 않는다. 결과 불명의 확정은 사람이 영수증의 대상을 읽고 한다.

**8. 알림은 이 버전에서 정하지 않는다.** 정지를 사람이 알아채는 경로는 Admin badge와 로그다. 외부 알림은 별도 결정이며, 두게 되면 링크만 싣는다.

**9. Railway 재시작 정책.** 이 버전의 구현이 웹과 orchestrator 양쪽에 배포된 뒤, 운영자가 대시보드(Tomverse → production → AMUX Orchestrator → Settings → Restart Policy)에서 `On Failure`를 명시한다. 최대 횟수는 운영자가 정한다. staging도 같다. 구현 전에는 바꾸지 않는다.

**10. 배포 순서.** 웹(migration과 route)이 먼저, orchestrator가 나중이다. 운영 기록: 2026-09-30에 Railway 서비스 설정을 읽은 값으로 AMUX Orchestrator는 `checkSuites: false`여서 CI를 기다리지 않고 병합 즉시 배포된다(이 값은 저장소에 없다). orchestrator가 먼저 떠도 6의 `halt_unreadable`로 기다리므로 claim하지 않는다. 옛 웹은 접수를 쓰지 않으므로, 새 orchestrator는 정지 상태 읽기가 성공하기 전에는 쓰기 호출을 하지 않는다. orchestrator 서비스를 CI 대기 배포로 바꾸는 것은 운영자의 별도 결정이다.

**11. WSL bridge는 바꾸지 않는다.** bridge는 지금처럼 종료 코드 3과 `RestartPreventExitStatus=3`으로 사람을 기다린다. orchestrator 정지 동안 claim이 없으므로 새 배정은 오지 않고, 진행 중인 attempt의 heartbeat와 정산은 계속된다. recover도 멈추므로 lease가 끝난 attempt의 회수는 해제 뒤로 미뤄진다.

### 이 버전과 버전 8·19

- 버전 8의 `AmuxRecommendationAutoHalt`는 자동 승격 경로의 정지이고, 이 버전의 정지는 orchestrator의 정지다. 서로를 열거나 닫지 않는다. 자동 승격의 결과 불명은 버전 8의 조건(15분 안 2건)을 그대로 따르고, 그와 별개로 orchestrator를 `promotion_outcome_unknown`으로 멈춘다. 버전 8 halt가 열려 tick이 `auto_halted`를 답하는 것은 1의 알려진 답이다.
- 4의 롤백 확정은 접수 행 잠금과 버전 19의 commit fence에 기댄다. 버전 19가 남긴 구간(trigger 검사 뒤의 commit record 기록과 flush)은 잠금이 덮는다. 쓰기 트랜잭션이 커밋을 끝내기 전에는 판정이 접수 행을 잡지 못하기 때문이다. 5초 유예는 시계 오차의 여유이며 정확성을 그것에 기대지 않는다. 기한이 없는 트랜잭션(owner 자동 승격, catalog `tasks` upsert)은 orchestrator의 쓰기 호출이 아니므로 이 판정에 들어오지 않는다.

### 완료 조건 (구현이 테스트로 보여야 하는 것)

- 1의 답 각각에서 정지하지 않는다. 특히 tick의 409 `apply_disabled`와 200 거절 reason, recover의 409 `execution_api_disabled`, claim 409, 503 세 reason. 선택 읽기의 전송 실패·404·5xx·429는 60번째 연속까지 건너뛰고 61번째는 정지, busy는 세지 않음, 전부 성공한 tick과 재개가 횟수를 0으로.
- 1에 없는 응답(예: claim의 500 `incident_id`, 503 `amux_commit_check_missing`, tick의 500 `audit_unbound`, 쓰기의 429, 무응답)이 다음 쓰기 호출 전에 정지를 연다.
- 접수가 쓰기보다 먼저 별도 트랜잭션으로 커밋되고, 접수 실패면 쓰기가 0이다. 영수증은 쓰기와 같은 트랜잭션에만 있고 롤백된 쓰기에는 없다.
- ack: 2xx·409 거절의 `definite` ack는 영수증이 있어도 성공(recover의 409 `execution_api_disabled`가 quota 삭제 뒤에 와도, claim 거절 감사 뒤에도 정지하지 않음). `no_commit` ack는 503 셋에만, 영수증이 있으면 거절과 정지. ack가 성공하거나 정지 행이 커밋되기 전에는 다음 쓰기 호출이 0이며, ack 실패는 ack만 다시 보낸다. 거절 감사만 있는 트랜잭션은 영수증을 남기지 않는다.
- 선택 읽기의 503 `amux_database_deadline_exceeded`·`amux_database_call_ceiling_exceeded`가 busy와 같이 tick을 claim 없이 끝내고 세지 않는다.
- 서버는 한 요청에서 영수증이 커밋된 뒤 503 세 reason을 보내지 않는다(recover의 sweep 뒤 기한 초과, tick의 grant 만료 뒤 기한 초과가 `amux_outcome_unknown`이 된다). 영수증이 있는 요청에 "커밋 없음" 종류의 ack가 오면 거절되고 정지가 열린다.
- 판정: `deadlineAt`은 접수 트랜잭션의 `clock_timestamp()` 기준. 기한 전 미정, 기한+5초 뒤 영수증 0은 롤백 확정과 시스템 감사, 영수증 1 이상은 사람 확인 필요. 인스턴스 id와 무관. 접수 행을 잡은 채 커밋 중인 쓰기 트랜잭션이 있으면 판정은 그 커밋 뒤에 영수증을 센다. 해결된 접수에 영수증을 넣으려는 쓰기는 롤백된다.
- 프로세스가 요청 후 응답 전에 죽은 경우: 재시작한 프로세스가 `awaiting_deadline`으로 기다린 뒤, 커밋이 없었으면 스케줄을 시작하고 커밋이 있었으면 정지한다. 이 사이에 쓰기 호출과 선택 읽기가 0이다.
- 정지 기록: `haltKey` 멱등, 사유 코드 CHECK, 해제 외 갱신 거절 trigger, 시스템 감사 같은 트랜잭션, 내부 route가 해제를 받지 않는다.
- 기록 실패와 404에서 메모리 정지 유지와 재기록. 빈 목록 읽기가 메모리 정지를 풀지 않는다.
- 6의 시작·재개 조건 문장의 각 항이 거짓일 때 스케줄이 시작하지 않는다. 다른 프로세스가 연 정지를 사람이 닫은 뒤에는 시작한다.
- 해제: owner가 아니면 거절, step-up이 오래되면 거절과 링크, `haltKey` 앞 8자가 틀리면 거절, 사람 감사 같은 트랜잭션, 관련 접수를 닫음, 원래 작업을 호출하지 않는다.
- 3의 목록 밖에서는 0이 아닌 종료가 없다.
- 접수가 없는 정지(`contract_violation`, `selection_read_failures`)가 기록 전 종료로 사라지는 것은 알려진 한계이며, 새 프로세스가 같은 조건에서 다시 정지함을 보인다.
- 세 테이블과 감사 metadata에 사용자 콘텐츠·자유 텍스트가 없다. 데이터 도메인 레지스트리 등록.

### 이 버전이 하지 않는 것

환경 변수를 설정하거나 바꾸지 않는다. Railway 재시작 정책을 바꾸지 않는다(9는 구현 배포 뒤의 운영자 단계). 외부 알림을 만들지 않는다. 영수증이 있는 결과 불명의 확정을 자동화하지 않는다. WSL bridge, 실행 모드, worker catalog, 자동 승격, 단계 사이클, engineering adapter의 래치와 동작을 바꾸지 않는다. 새 시스템 audit actor를 만들지 않는다.

## 버전 22 — 전략적 포트폴리오에서 운영자 완료 판정까지

승인자 `mposition`, 승인일 2026-09-30. 이는 앞으로 구현할 **v22 경로의 정책 계약**이며 v7~v21의 이력·현재 코드 상태를 소급 변경하지 않는다. 새 schema, scoring, UI, CLI telemetry, Publisher, worker 라우팅과 모든 활성화 스위치는 별도 착수 지시·구현·독립 검토·검증 대상이다. 기존 `AmuxWorkItem`을 자동 변환하거나 기존 승인·attempt를 지우지 않는다. 2026-09-24 별도 승인된 `amux_authority`를 전제로 읽으며, **이 버전 자체가 정본 cutover를 승인하거나 수행하지 않는다.**

### 1. 전략 계층·점수·실행 풀

- Initiative(Project)→Epic→Feature는 영구 저장하는 **비실행 계층**이고, User Story는 범위·진행률 집계 카드, Task는 worker 실행 카드다. Bug는 문제 해결 Story의 subtype, Error는 그 근거 기록이다. Task는 Story의 하위 또는 `parentStoryCardId = null`인 Feature 직속일 수 있다. 부모·자식·의존성은 서로 다른 관계다. 부모가 같다는 이유로 실행 선후를 추정하지 않는다.
- 점수는 카드 한 장만 보지 않는다. 모델이 상위 Initiative/Epic의 플랫폼 전략 가치, Story의 효과, Task의 기여·위험·노력·의존성·worker 용량을 근거와 함께 제안하고, 버전 있는 결정적 계산이 최종 실행 추천 점수와 그 사유를 남긴다. 모델 제안은 승인, SEV1 판정 또는 전이 권한이 아니다. 운영자 override는 이유·이전값·새값을 감사한다. 활성 포트폴리오는 7일, 전체 기준선은 28일마다 재평가하며 중대 사건은 조건부 조기 재평가한다. 재평가 실패 또는 근거 만료는 새 자동 승격을 보류하지만 진행 중 실행을 삭제하지 않는다.
- `ready`는 새 lifecycle status가 아니라 계산된 자격이다: 운영자가 등록할 때 **실행 brief 원문·digest·Task 역할·실행 등급·예상 경로·비용 상한까지 확인한 Task**가 허용 scope와 완료 조건, 승인된 부모 경로, 명시적 dependency, 비용·권한·worker 조건을 갖추고 정지 상태가 아니다. Story는 승인된 backlog 카드로 남아 점수·진행률을 집계하지만 직접 worker가 claim하지 않으며, 실행하려면 독립 Task로 분해한다. 이 판정은 승격 직전 DB 현재값에서 다시 계산한다. 승인 뒤 brief 또는 그 결속 필드가 달라지면 `ready`가 풀리고 운영자가 새 digest를 확인해야 한다.
- 운영자가 아이디어·계층·카드의 `backlog` 등록을 승인한 뒤에는 **카드별 backlog→todo 승격 승인 요구를 제거한다.** `ready`이고 최신 점수가 높은 카드부터 현재 용량에서 자동으로 실행 풀(`todo`, worker 미배정)에 편입한다. 모델의 점수만으로 밀어 넣지 않고 결정적 Guard, CAS, 감사와 kill switch를 통과한다. 운영자가 앞서 승인한 한 아이디어 전체를 한번에 `todo`로 보내지 않는다. 작업 풀은 검증된 worker 수의 최대 3배라는 운영 상한을 넘지 않게 설계하고, 정확한 분모·예약 슬롯과 경합 계산은 구현 전 테스트로 고정한다. 기존 v7/v8의 추천 풀·사전 승인 subset·래치는 이 새 경로의 암묵적 허가가 아니며 별도 전환 전까지 현행 규칙대로 남는다.
- **새 자동 편입의 졸업과 상한.** v22 경로를 켜기 전에도 v8의 측정된 사람 결정 **20건/14일**과 운영자 활성화 판정을 요구한다. 자동 편입 판단의 Agent 원가 상한은 v8보다 넓지 않게 **1회 US$5·24시간 US$15·30일 US$100**이다. 새 `todo` 대기열은 설정된 `wipLimit`과 `검증된 worker 수 × 3`을 모두 넘지 않는다. 동시 실행은 **전역 3, worker당 1**을 넘지 않고, 대기열 수와 동시 실행 수를 혼동하지 않는다. 중대 위반 1건 또는 15분 내 결과 불명 2건은 기존 v8의 자동 승격 정지보다 약하게 만들지 않는다. 수치·분모·병행/SEV1 예약의 원자적 합산 테스트와 새 경로 전용 off switch가 없으면 v22 자동 편입은 닫혀 있다. v2가 자동 등록한 카드와 v1~v3의 과거 카드는 운영자의 새 hierarchy·brief 확인과 명시적 opt-in 전에는 v22 `ready`가 아니다. 이 재확인은 **현재 카드와 결속한 새로운 사람 source 승인 ID**를 만들며, 과거 자동 등록 기록을 사람 승인으로 바꿔 해석하지 않는다. 이 조건은 평상시 카드별 승격 승인을 부활시키지 않고 **활성화 전 졸업과 source 자격**을 정한다.
- **승인 없는 `todo`의 정의.** v8 grant 소비는 v22 경로의 증거가 아니다. 새 경로는 카드마다 `source 승인 ID + 승인된 hierarchy/brief digest + scoring snapshot/version + capacity 판단 + policy version`에 묶인 **자동 편입 영수증**을 `backlog→todo`·canonical system audit과 같은 트랜잭션에 기록한다. 이 영수증이 없거나, source 승인/brief가 현재 카드와 다르거나, 졸업·용량·스위치가 닫혔는데 `todo`가 된 카드가 v22의 `unapproved_todo`다. 기존 v8 카드에는 기존 grant 증거를 계속 적용한다. 한쪽 경로의 영수증을 다른 쪽에 요구하거나 면제하지 않는다. 새 테이블·DB 불변식·fault injection으로 두 경로를 분리하기 전에는 v22 편입을 활성화하지 않는다.

### 2. Task DAG, 배정, 긴급·병행 용량

- 새 v22 카드는 한 카드 안에서 `design → develop → test → review`를 순환하지 않는다. **Story의 설계·구현·테스트·독립 리뷰·검증은 각각 독립 Task**로 제안·저장하고, 선행 edge를 명시한다. v16의 `stageCycle`과 stage round는 과거 카드에만 적용하며, v22 Task 생성 시 사용하지 않는다. 기존 stage 카드의 미완료 이행 방법과 중복 실행 방지는 migration 전에 승인·검증한다.
- Task별로 작업 역할과 **실행 등급**을 미리 triage한다. 등급은 능력·위험·맥락 크기 요구를 뜻하며 Luna/Sol/Astra나 Fable/Opus 같은 모델 이름이 아니다. claim 시점의 검증된 worker catalog가 공급자·모델·도구 능력과 현재 quota를 대조한다. 구현 작성자와 독립 리뷰 작성자는 달라야 하며, 실제 확인된 provider가 다를 수 있으면 다른 provider를 우선한다. 실행 등급 미기록·worker 미준비·선행 미완료면 claim하지 않는다.
- **병행 슬롯 하나와 SEV1 슬롯 하나**를 별도 예약한다. 병행 슬롯은 핵심 Initiative에 모든 자원이 묶여도 승인된 다른 플랫폼 개선이 계속 진행될 자리를 지킨다. 실제 운영 장애인 `AMUX SEV1`은 일반 `p1`과 다른 명시적 표시이며 운영자 선언·감사·해제가 필요하다. SEV1은 적합한 worker가 사용 가능해지는 즉시 일반 후보보다 먼저 claim한다. 실행 중인 worker를 강제 선점하지 않고, worker가 없으면 대기한다. 두 예약은 존재하지 않는 worker를 만들거나 전역 WIP·비용·권한·kill switch를 우회하지 않는다. worker 수가 모자랄 때의 정확한 점유·대여 계산은 활성화 전 별도 용량 계약으로 고정한다.

### 3. Git 충돌, PR, 배포, 완료

이 절은 **공통 실행 제어의 최대 허용 범위**다. 개별 Agent의 더 좁은 승인 정책이 권한을 실제로 부여해야 한다. 특히 현재 `engineering-agent.md`는 미승인 초안이며 무인 병합과 main PR 생성을 금지한다. 그 Agent 정책의 별도 개정·운영자 승인, Publisher와 저장소 보호 설정의 검증 전에는 아래 develop 자동 병합·staging 배포·worker 작성 main PR이 **허용되지 않는다**. 이 문서 하나로 그 금지를 우회하지 않는다.

- 각 Task는 고정한 base SHA에서 별도 브랜치·worktree로 작업하고, 파일 범위와 변경 목적을 기록한다. 첫 원격 push 전 최신 원격·base/head/diff digest·허용 경로·크기·secret scan을 다시 확인한다. 병합 직전 base가 움직이면 검증과 독립 리뷰의 결속을 다시 만든다. 비겹침 변경은 갱신 후 재검증할 수 있지만, 같은 계약·정책·데이터 의미를 다르게 바꾸는 충돌은 자동 덮어쓰기·force push 대신 통합 Task 또는 운영자 주의로 보낸다. 원래 변경과 검토 이력은 보존한다.
- worker는 `develop` PR을 작성할 수 있다. **졸업된 정확한 파일 허용 목록**, base 커밋의 정책 테스트, CI·독립 리뷰, push 결과의 digest 일치, off switch, 저장소 ruleset과 별도 최소 권한 Publisher가 모두 준비된 경로만 Publisher를 통해 **develop 병합과 staging 배포**까지 자동 진행할 수 있다. worker 생성 프로세스에는 GitHub write·배포 자격증명을 주지 않는다. 게이트 파일(`docs/policy/**`, workflow, 규칙·정책 테스트 등)은 자동 허용 목록에 들어가지 않는다. Railway IaC 설정 적용은 기존대로 운영자만 한다.
- `main` PR은 worker가 검증·게시할 수 있지만 **main 병합과 production 배포는 운영자만** 한다. PR 생성 능력은 main merge 권한이 아니다. PR의 review/검사 승인과 제품 작업의 완료 판정도 다른 행위다. GitHub PR은 허용된 코드 변경 초안의 예외일 뿐, AMUX 카드 상태·승인·감사의 정본이 아니다.
- 최종 `review → done`은 **운영자 판정만** 허용한다. 운영자는 완료 조건, PR head/base/diff, 독립 리뷰, 테스트, staging 또는 production의 해당 완료 단위 증거를 보고 `완료 / 재작업 / 중단`을 결정한다. 개발·병합·배포 성공이나 worker의 자체 검토가 `done`을 자동 생성하지 않는다. 거절·재작업 시 어떤 완료 조건이 부족한지 기록한다.

### 4. 실패 복구와 결과 환류

- **새 실행 전 read-back.** claim 응답 유실, worker heartbeat 중단, PR push/병합·배포 응답 유실을 같은 `failed`로 뭉개지 않는다. 각 쓰기는 요청 id, 대상 id, base/head SHA 또는 배포 id와 digest를 가진다. 실제 결과를 DB·GitHub·배포 기록에서 확인하기 전에는 재claim·재push·재병합·재배포하지 않는다. 판정할 수 없으면 `outcome_unknown`으로 기존 v20 orchestrator 정지 계약에 넘긴다. 사람 해제는 원래 작업의 재실행이 아니다.
- **worker 중단.** lease·heartbeat·fencing으로 이전 worker의 늦은 쓰기를 막고, 브랜치·산출물·완료된 Task와 부분 증거를 보존한다. 이전 시도가 멈췄고 중복 외부 행위가 없음을 확인한 뒤 제한된 새 attempt를 만든다. 테스트 실패는 정해진 횟수 안에서 수정·재검증한다. 시도·비용·시간 상한이나 독립 리뷰의 의미상 충돌을 넘으면 운영자 주의로 보낸다.
- **PR·배포 결과 불명 예.** PR 작성 직후 통신이 끊기면 같은 브랜치/head SHA의 PR을 먼저 조회한다. 이미 있으면 그 PR을 이어 관측하고 두 번째 PR을 만들지 않는다. 배포도 대상 commit과 deployment id를 대조하며, 단순한 HTTP timeout을 미배포로 단정하지 않는다. 이미 승인·완료한 Task를 재실행해 이중 작업·이중 원가로 세지 않는다.
- **환류.** 운영자 완료·재작업·중단 때마다 예상과 실제의 기간, 시도 수, CLI 토큰/캐시 토큰, API 환산 비용, 검사·독립 리뷰 발견 사항, 배포 뒤 회귀와 사용자 결과를 Task에 결속한다. Task→Story→Feature→Epic→Initiative 또는 **Feature 직속 Task→Feature→Epic→Initiative**로 합산해 이후 분해·실행 등급·점수·자원 배분을 조정한다. Story의 진행률은 하위 Task에서 계산하지만 Story 자체의 `done` 판정은 운영자에게 남긴다. 수정된 추정과 그 이유를 버전·근거로 남기며, 빠른 완료만 보상해 품질을 낮추지 않는다. 운영자 결정의 축적은 제안 정확도를 높이는 자료이지 모델이 새 정책·승인 권한을 얻는 학습이 아니다.

### 5. 모든 worker의 CLI 토큰 원장

- 아이디어 분석 Agent뿐 아니라 **모든 로컬 Ubuntu worker의 Codex/Claude CLI 호출**을 공통 실행 래퍼에서 계측한다. 정규화된 사용량 사건에는 card/Task/run/attempt/worker, 공급자·실제 모델·CLI 버전·인증 방식, 호출 시작/종료, 상태, 보고된 입력·출력·캐시 읽기·캐시 쓰기 토큰과 사용량 출처/완전성, 멱등 turn id를 둔다. 프롬프트 원문·비밀값은 사용량 원장과 감사에 넣지 않는다. 누락·크래시·도구가 보고하지 않는 필드는 **0이 아니라 unknown**이다. 재개된 세션의 누적 사용량은 turn별 delta/고유 id로 중복 합산하지 않는다.
- 버전 있는 공급자별 API 가격표로 계산한 숫자는 **향후 API 키 전환 시 예상액**이며 현재 구독료·실제 API 청구액·사용자 credit와 분리해 표시한다. 보고된 캐시·reasoning 토큰의 가격 구분을 지원하고, 가격 미확인 모델은 금액을 임의 계산하지 않는다. 실제 provider/API 호출이 생기면 그 실제 원가도 별도 칸에 기록한다. 실패 호출의 토큰도 비용 예측에서 제외하지 않는다.
- 사용량 수집 실패가 실행 성공이나 0원임을 뜻하지 않는다. 회차·worker·모델별 누락률을 Admin에서 볼 수 있어야 한다. Task의 승인된 비용 상한이나 API 실제 예산을 사용량으로 판정하는 경우 `unknown`이 생기면 read-back으로 복구하기 전까지 해당 비용 범위의 새 attempt·claim을 보류한다. 읽어도 복구되지 않아 운영자가 해제하면 호출 전 예약한 최악의 상한을 예산에서 계속 점유한 채 재개하며, 이를 실제 청구액으로 표시하지 않는다. 강제 가능한 호출 전 상한이나 예약액이 없으면 운영자 해제로도 자동 실행하지 않는다. 장차 API로 전환할 때는 CLI 예상액과 실제 청구액을 비교·보정하고, 개별 Agent 예산과 전체 worker 예산을 혼합하지 않는다.

### 6. Admin의 한 장부, 두 작업 보기

| Kanban 열 | 같은 AMUX 장부에서의 의미 |
|---|---|
| Tomverse Backlog | 승인·등록됐으나 실행 풀에 들지 않은 `backlog` |
| AMUX Backlog | `todo`이며 worker 미배정. `Todo without worker`라는 설명을 함께 표시 |
| Todo | `todo`이며 worker가 배정·claim했지만 실행 시작 전 |
| In Progress | 실행 중인 `doing` |
| In Review | 독립 검증 근거가 모여 운영자 완료 판정을 기다리는 `review` |
| Need owner's attention | 결과 불명·열린 escalation·충돌·정지·운영자 선택이 필요한 카드의 **projection**. 원래 lifecycle을 덮어쓰는 새 status가 아님 |

`done`·`blocked`·`cancelled`는 숨겨진 손실이 되지 않도록 이력/보관 필터에서 조회한다. Kanban 열 이동은 단순 드래그가 DB 전이 권한을 주지 않는다. 모든 쓰기는 해당 Guard·승인·감사를 지나야 한다. DevOps형 계층 목록은 Initiative/Epic/Feature/User Story(Task 직속 포함)/Bug/Error/Task를 펼쳐 보이고, 점수·근거·dependency·실행 등급·worker·SEV1 표시·완료율을 같은 원장에서 읽는다. 단순 `owner` 문자열 하나를 worker 배정 증거로 추정하지 않고 claim/assignment 계약을 명시적으로 둔다. 큰 backlog는 서버 페이지네이션과 계층별 지연 로딩으로 읽으며 현재 목록의 고정 개수만으로 전체라고 표시하지 않는다.

### 7. 도입 경계

순서는 공통 기반과 intake v4의 실행 위치·CLI 계약 정합성, hierarchy/Task DAG·점수·capacity·usage schema와 정책 테스트, 합성 데이터·동시성/결과 불명 검증, Admin preview, staging 비실행 관측, staging 제한 실행, 별도 production 승인이다. 기존 v16 단계 카드의 전환/종료 계획 없이는 v22 Task를 같은 카드에 중복 부착하지 않는다. source 유출, 무승인 카드·노드 write, 무승인 실행·PR push/병합·배포, provider 비용 폭주, 사용자 데이터·승인 이력 소실, 감사 누락은 차단한다. UI 문구·정렬은 복구 가능한 비차단 항목이다. 이 버전은 flag·환경 값·계정/Publisher 권한·Railway 설정을 변경하지 않는다.

## 버전 23 — 전용 Ubuntu 서버의 개발용 runner

승인자 `mposition`, 승인일 2026-10-01. 작성자 Codex와 다른 provider인 Claude의 독립 검토를 거쳤다. v13~15의 WSL 예외에서 **실행 위치만** 전용 Ubuntu 서버로 옮긴다. 기존 `tomverse-wsl-bridge` 바이너리와 `TOMVERSE_AMUX_WSL_*` 이름은 호환 이름이며, 이름만으로 WSL 또는 Ubuntu 실행 권한을 판단하지 않는다. v13의 승인 brief 원문·digest 결속과 자격증명·결과 경계, v15의 로컬 실행 영수증과 사람 Review, v16의 실제 provider 교차 검토, v12 engineering adapter의 꺼진 래치, v18 실행 API 게이트와 v22의 미구현 경계는 유지한다. v20 정지·영수증 계약은 Railway orchestrator의 것이며 bridge에 적용됐다고 주장하지 않는다. 이 절은 v22 §7과 intake v4의 실행 위치·CLI 계약 정합성 전체를 완료한 것으로 세지 않는다. 이 승인 자체는 bridge 환경 변수, 제품 실행 API, claim, 자동 승격, Publisher, 병합 또는 배포를 켜지 않는다.

이번 이전에서 Linux worktree와 AMUX 세션의 복사·자동 시작, 기존 WSL 서비스 중지는 v23 승인 전에 이미 이뤄졌다. 제품 bridge는 새 호스트에서 활성화되지 않았고 제품 카드의 새 dispatch도 이 이전의 승인으로 열리지 않았다. 이후의 v23 승인은 그 사전 작업에 소급 권한을 부여하지 않는다. v22가 설계 범위에서 부른 “로컬 Ubuntu worker”는 v13의 현행 WSL bridge 실행 위치를 먼저 바꾼 승인이 아니었다.

### 실행 위치와 단일 소유권

- 대상은 운영자가 지정한 독립 Ubuntu 호스트 한 대다. worker 8개는 Linux 파일시스템의 독립 Git worktree에서 실행하며 실제 경로는 운영 기록에 둔다. Windows 드라이브 mount와 WSL 경로는 실행 작업 디렉터리가 될 수 없다. 재부팅 후 worker 자동 시작은 **세션 시작**만 허용하며 제품 카드의 새 배정은 별도 bridge 활성화 게이트를 통과해야 한다.
- 기존 WSL bridge·AMUX 서버는 중지·비활성화하고 새 호스트와 동시에 실행하지 않는다. systemd뿐 아니라 Windows Task Scheduler·시작 프로그램·WSL boot 명령 등 옛 bridge를 시작할 수 있는 경로를 확인한다. 새 등록 전에 **이전 worker identity 각각의 열린 attempt 0건, 소유된 Todo 0건, 미해결 `AmuxOrchestratorWrite` 영수증 0건**을 제품 DB에서 read-back한다. 로컬 AMUX에서 종료되지 않았고 `Execution attempt:`가 있는 카드도 모두 열거해 원래 Tomverse attempt에 대응시킨다. 해소된 attempt에 대응하는 로컬 작업은 claim을 열기 전에 AMUX에서 멈춘다. 어느 항목이든 남으면 새 등록·claim·전송을 보류한다. 해소는 기존 app route의 lease expiry/recover 또는 사람 Review·escalation만 사용하며 직접 SQL로 상태를 고치지 않는다. 로컬 SQLite 복사는 제품 DB의 attempt와 승인 원장을 대체하지 않는다.
- Tomverse 앱은 새 호스트로 인바운드 접속하지 않는다. bridge가 outbound HTTPS로 승인된 내부 route에 접속하고, 같은 호스트 AMUX에는 loopback 주소로만 접속한다. AMUX 수신도 loopback에만 묶거나 방화벽으로 운영자 SSH 외 접근을 차단한다. 기존 delivery digest, `msg_id` 멱등성, 로컬 카드 연결, heartbeat·lease fencing, `review`/`blocked` 정산, 사람 완료 판정을 유지한다. bridge의 결과 불명은 v15 연결 계약에 따라 halt(exit 3)하고 자동 재시작을 막은 뒤 사람이 read-back하여 재개한다. v20 orchestrator halt를 bridge의 보호 장치로 간주하지 않는다.

### 자격증명과 실행 계정

- bridge는 worker의 `tommy` 계정과 다른 권한 없는 OS 계정과 system 서비스로 실행한다. **root 소유이며 worker가 고칠 수 없는** 승인된 SHA의 바이너리·unit과, bridge 계정만 읽는 환경 파일을 사용한다. 여기서 격리할 인증값은 `TOMVERSE_AMUX_SYNC_SECRET`과 제품 DB 자격증명이다. worker 자신의 Codex/Claude/GitHub 로그인은 WSL에서 쓰던 범위 이하로 유지하고 목록과 권한을 운영 기록에 적는다. worker의 환경, 홈, AMUX 세션 파일, 프롬프트, 로그, 백업, 공용 Git worktree에는 bridge 인증값과 제품 DB 자격증명을 두지 않는다. worker 계정이 읽을 수 있는 파일에 mode `600`을 주는 것만으로는 격리가 아니다.
- bridge 서비스 계정에는 제품 DB, GitHub 쓰기/Publisher, 배포, worker 홈 읽기 권한을 주지 않는다. AMUX loopback API 접근과 승인된 Tomverse 내부 route 호출에 필요한 권한만 준다. AMUX가 loopback API에 별도 토큰을 요구하면 bridge 전용 토큰을 격리 계정의 환경 파일에 두고 worker 홈에서 읽지 않는다. worker가 bridge 환경 파일·바이너리·unit을 고칠 수 있는지, bridge 프로세스 환경을 읽을 수 있는지, bridge가 worker 자격증명을 읽을 수 있는지를 실제 UID와 파일 권한으로 검사한다. 운영자 sudo는 worker 계정과 분리한다. worker 계정에서 `sudo`, `docker`, `lxd` 등 root와 동등한 권한의 그룹, `NOPASSWD`, 공유 sudo 인증 캐시를 제거한다. 현재 이전된 `tommy`가 이 세 그룹에 속해 있으므로 이를 바꾸기 전에는 격리 게이트가 통과하지 않는다. 그룹 제거 후에도 기존 프로세스의 보조 그룹은 남으므로 worker의 user systemd manager·tmux·AMUX 서버·8개 세션을 재시작하고, 각 프로세스의 `/proc/<pid>/status` `Groups`에 root 동등 그룹이 없는지 확인한다. worker가 root 동등 권한을 가졌던 기간의 sudoers·system unit/timer·root cron·setuid 파일·docker/lxd 컨테이너와 이미지를 점검한 **뒤에** 새 bridge 파일을 root 소유로 설치한다.
- 이전 중 bridge secret의 사본이 worker 계정에 들어갔으므로 **기존 `TOMVERSE_AMUX_SYNC_SECRET`을 교체하고 옛 값이 거부됨을 확인**한 뒤에만 활성화한다. 이전 과정의 새 호스트 사본은 제거하고, AMUX DB·백업·shell 기록에도 값이 남았는지 비밀을 출력하지 않고 검사한다. WSL 원본 파일은 보존하되 fallback용 활성 자격증명으로 사용하지 않는다. 새 인증은 격리 계정에만 배치한다. 비밀값과 내부 URL은 정책·작업 로그·대화에 출력하지 않는다.

### 활성화와 복구 게이트

1. 승인된 이 정책 버전과 독립 리뷰, 개별 Agent 정책의 허용 범위, 제품 실행 API의 실제 게이트 상태를 확인한다. 미승인 자동 병합·배포·유료 분류 기능은 이 이전으로 켜지지 않는다.
2. 새 호스트의 AMUX DB 무결성·원본 digest, 여덟 세션의 native 경로·프로세스·인증, Git origin과 worktree 기준 SHA, 시간 동기화, systemd 자동 시작을 관측한다. AMUX invariant confidence가 healthy이고 치명적 실패가 없는지도 확인한다. worker가 떠 있다는 사실과 제품 dispatch가 가능하다는 판정을 분리한다.
3. WSL의 모든 재시작 경로가 꺼진 것과 새 호스트 bridge가 아직 꺼진 것을 확인한다. 위의 worker별 0건 조건과 로컬 카드 대응을 read-back한다. 이전 런타임의 늦은 결과가 거절되는 계약은 generation read-back과 코드·테스트 근거로 확인하며 옛 bridge를 실행해 시험하지 않는다.
4. Railway claim 전용 루프를 끄거나 orchestrator를 명시적으로 halt하여 **새 claim이 불가능한 관측 창**을 만든다. 소유된 Todo가 0건인 상태에서 허용된 한 worker만 등록·heartbeat하여 실행이 일어나지 않음을 확인한다. bridge에는 register-only 모드가 없으므로 이를 독립적인 비실행 기능으로 부르지 않는다. 사람의 별도 활성화 결정 뒤 claim을 열고 제한 실행을 관측한다. 예상 밖 카드 전이·감사 누락·비밀 노출·중복 attempt·결과 불명은 차단하고 bridge를 중지한다. 각 작업의 유료 호출은 승인된 Agent 예산과 기존 전역 상한을 따른다.
5. 되돌릴 때는 새 bridge부터 중지하고 제품 DB의 attempt·lease를 확인한다. WSL 원본은 보존하지만, 세대와 소유권을 재검증하기 전에는 WSL bridge를 다시 켜지 않는다. DB 스냅샷을 제품 정본 위에 덮어써서 rollback하지 않는다.

운영 절차의 초안은 `docs/ops/amux/wsl-execution-bridge.md`의 Ubuntu 이전 절에 둔다. 이 절은 새 Agent나 새 제품 데이터 writer를 만들지 않으며, 기존 Agent의 카드·승인·감사·비용 namespace와 보존 규칙을 변경하지 않는다.

## 버전 24 — Ubuntu AMUX invariant 관측 게이트 정정

승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-02`. 작성자 Codex와 다른 provider인 Claude의 독립 검토에서 정책 문구 차단 사항이 없었다. v23 활성화 게이트 2의 “AMUX invariant confidence가 healthy” 문장만 다음 계약으로 대체한다. `/health`의 `status=ok`, `store=ok`, board mapper `ok`, `reconciled=true`, disk `ok`, 완료된 write probe가 **기록한 유효** `probe_budget_ms` 안에 있는 것과 `/api/health/invariants`의 `fail=0`을 요구한다. `unknown`은 `pass`로 취급하지 않는다. 각 unknown의 invariant ID·측정 불가 이유·제품 dispatch, lease fencing, 감사, 비밀 격리, 비용 판정과의 관련성을 운영 기록에 남긴다. 관련/무관 분류는 작성자와 다른 provider의 독립 검토 또는 운영자 확인을 받는다. `schema.timestamp_units_declared`는 컬럼마다 분류하고 lease·heartbeat·attempt·감사·비용 컬럼은 관련으로 본다. **관련 unknown은 표본 부재만으로 허용하지 않는다.** 코드·테스트 근거와 별도의 직접 관측 **모두**로 같은 안전 조건을 claim 전에 증명한다. 운영 데이터에 표본이 없으면 격리된 로컬 fixture에서 해당 경로와 timestamp 단위를 실제 실행·관측할 수 있지만 제품 claim이나 제품 DB 쓰기로 표본을 만들지 않는다. 사전 증명이 불가능하면 claim을 열지 않는다. 관련이 없고 표본이 없거나 해당 플랫폼에서 측정할 수 없는 unknown만 이유와 근거를 남기고 허용한다. 이 분류와 검사는 v23의 계정·그룹 정리, AMUX 재시작 **이후**, claim을 막은 관측 창 직전에 다시 하고, 사람의 claim 해제 직전과 첫 제한 실행 중·후에도 다시 한다. 각 재검사에 새 unknown이 있으면 재분류·독립 확인 전까지 claim을 막는다. 관측 중 `fail>0`, 새 unknown, write probe 예산 초과, 유효 예산값 변경이 보이면 bridge를 중지하고 claim을 다시 막아 원인을 확인한다. 이 연속 관측을 수행할 수 없다면 claim을 열지 않는다.

근거: 새 Ubuntu AMUX의 저장소·board probe는 `ok`였고 첫 관측에서 505개 invariant 중 462 pass·0 fail·43 unknown이었다. 후속 관측은 461 pass·0 fail·44 unknown으로 `hooks.reports_are_attributed`가 더해졌다. unknown 40개는 최신 500행에 값이 없는 컬럼의 `schema.timestamp_units_declared`로, 테이블 전체가 비었다는 뜻이 아니다. 나머지는 `host.memory_not_critical`, `schedules.cost_title_matches_kind`, `session.self_reports_landing` 및 후속 `hooks.reports_are_attributed`이다. worker 보고 hook의 두 unknown은 표본 부족이므로 한 worker 제한 실행 전에 **제품 카드가 아닌 로컬 합성 AMUX 작업**으로 실제 self-report와 attribution 도착을 관측한다. 호스트 메모리는 8개 worker 부하에서 `/proc/meminfo`로 별도 확인한다. 이 수치는 진단 스냅샷이지 앞으로 유지된다는 가정이 아니다.

`AMUX_INVARIANT_RESULT_BUDGET` 변경은 실패를 숨기는 면제가 아니다. 기존 50만 행 기준에서 7일 보존되는 `unknown` 약 75만 건 때문에 `store.result_log_bounded`가 실패했고, **v24 승인 전에** 운영 설정을 100만 행으로 조정한 뒤 0 fail이 됐다. **2026-10-02 승인 시점 이후에 한해** 유효 예산 100만 행의 지속 사용을 허용한다. 승인 전 0 fail은 진단 기록으로만 쓰고, 승인 후 같은 설정을 다시 읽고 invariant를 재실행해야 게이트 증거가 된다. 과거 설정 변경을 소급 승인하지 않는다. 활성화 전후에 유효 result 예산과 write `probe_budget_ms`, 설정 파일의 소유자·권한·digest·변경 이력, 상태별 행 수·가장 오래된 시각·증가율·DB 크기·write probe 지연과 disk 여유를 대조한다. worker가 고칠 수 있는 user unit 파일의 값만으로 게이트를 통과시키지 않고 분리된 운영자 확인과 관측 기록을 요구한다. 두 예산값의 임의 변경은 기존 판정을 무효화하고 bridge 중지·claim 차단·재검토를 요구한다. 예산의 80%를 넘으면 증가율과 보존 종료 시점의 예상 행 수를 운영자에게 알린다. 실제 보존 한도 초과나 지연·디스크 압박이 있으면 예산값을 더 올려 통과시키지 않고 원인을 고친다. v23의 계정·비밀 교체·중복 실행 방지·사람 활성화 결정은 이 정정으로 완화되지 않는다. **v24 승인 자체는 bridge·claim·제품 실행을 켜지 않는다.**

## 버전 25 — engineering adapter 코드 래치

승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-07`. 작성자는 Claude이고, 작성자와 다른 provider인 Codex(OpenAI)와 Cursor(xAI)의 독립 검토가 문안을 accept했다. 이 승인과 같은 변경에서 래치 상수를 true로 바꾼다.

이 버전은 버전 12가 false로 출고한 `ENGINEERING_AGENT_AMUX_ADAPTER_CODE_LATCH`(`lib/engineeringAgentAmuxAdapter.ts`)를 true로 바꾼다. Authority 절의 adapter 규칙은 그대로다.

- **열리는 조건.** Authority 절대로, adapter가 AMUX writer를 부르는 **모든** 호출 — worker 등록·heartbeat, claim, delivery pull·ack, execution start·heartbeat·settle, 비용 원장, review 대상 PR 번호 — 은 이 래치, 버전 18의 실행 API 게이트(코드 래치 `AMUX_EXECUTION_API_CODE_LATCH`와 환경 변수 `TOMVERSE_AMUX_EXECUTION_API_ENABLED`), 그리고 `off`가 아닌 engineering 운영 mode가 **모두** 참일 때만 열린다. mode는 실효 값이다. kill switch가 켜졌거나 설정을 읽지 못하면 `off`다. 이 판정은 각 호출이 AMUX에 닿기 전에 한다(`lib/engineeringAgentAmuxAdapter.ts`의 `adapterPermittedNow()`, 그것을 쓰는 `requireOpen()`). 닫혀 있으면 호출은 `adapter_closed`로 거절된다. 예외는 publisher가 보고한 pull request 결과 하나다. 그 PR은 이미 존재하므로 버리지 않는다. AMUX에는 닿지 않고, engineering 쪽에서 항목을 정산·결속하며 `docs/policy/engineering-agent.md` §11의 state mismatch(`adapter_closed`)를 사람에게 연다. AMUX가 번호를 거절할 때와 같은 경로다. 이 항목은 열려 있는 동안 halt이고, 처리는 `docs/policy/engineering-agent.md` §11의 절차를 따른다. 이 버전은 그 절차를 바꾸지 않으며, mode를 다시 여는 것만으로 이 항목은 닫히지 않는다.
- **mode는 `off`로 남는다.** 그러므로 이 버전을 배포해도 어떤 adapter 호출도 AMUX에 닿지 않는다. `off`에서 `shadow`로 가는 것은 `docs/policy/engineering-agent.md` §12의 armed gate와 §14의 `shadow` 진입 조건을 지난 운영자의 Admin 조작뿐이다. 이 버전은 그 조건 어느 것도 대신하지 않는다.
- **mode를 `off`로 내리면** 진행 중이던 실행의 heartbeat·settle도 닫힌다. runner는 실행 heartbeat가 한 번이라도 거절되면 그 실행의 lease를 잃은 것으로 고정하고 settle 없이 끝낸다(`scripts/engineering-agent-runner-core.mjs`). 그러므로 `off` 동안 heartbeat가 거절된 실행은 mode를 다시 열어도 이어지지 않고, runner가 deadline에 강제 종료된 경우와 같은 경로를 탄다.
  - worker heartbeat도 닫히므로 runtime의 `dispatchReady`는 그 runtime lease가 끝날 때까지 마지막 값으로 남는다. 그 runtime이 idle이고 `dispatchReady`가 참이었다면 그 사이 AMUX가 이 worker에게 카드를 claim할 수 있다. 실행 start가 닫혀 있으므로 attempt는 생기지 않고, 그 claim은 AMUX의 recover route가 푼다.
  - 그 attempt는 lease 만료 뒤 AMUX의 recover route가 회수하고, 카드는 AMUX 규칙대로 돌아간다. engineering run은 `active`로 남는다.
  - attempt가 끝난 `active` run은 그 순간부터 halt 판정의 `orphanedRuns`로 센다(`readEngineeringAgentHaltState()`). halt가 있는 동안 새 실행은 AMUX start 트랜잭션 안의 admission(`requireEngineeringAgentRunAdmission()`)에서 거절되고 그 트랜잭션 전체가 되돌려진다. 그래서 돌아간 카드를 이 adapter가 다시 시작하지 못한다.
  - mode가 `off`인 동안에는 engineering Agent 자신의 정비도 멈춘다(`docs/policy/engineering-agent.md` §12, `maintenanceAllowed`). mode가 다시 열린 뒤 첫 worker heartbeat가 §11 state mismatch 항목(`attempt_ended_run_active`)을 열어 사람에게 넘긴다. 이 정리는 자동 재시도가 아니라 사람의 판단이다.
  - 그 실행의 비용은 adapter가 AMUX 비용 원장에 기록하지 않는다. LLM 지출의 상한은 여전히 그 Agent 전용 key의 공급자 측 한도다(`docs/policy/engineering-agent.md` §12).
- **허용 동작은 버전 12의 목록 그대로다**: worker 등록과 heartbeat, claim, execution start·heartbeat·settle(결과는 `review`·`todo`·`blocked`뿐), delivery pull·ack, review 대상 PR 번호, settle 시점 비용 원장. recover, 승격, 승인, 카드 내용 수정, `done`은 열지 않는다. worker identity는 서버 상수 `engineering-runner`이고 요청 본문에서 받지 않는다.
- **바꾸지 않는 것.** 환경 변수, worker catalog, 용량 행, 자동 승격, 추천 풀, Railway 서비스와 IaC, 게시 GitHub App, engineering mode를 이 버전이 설정하거나 켜지 않는다. AMUX 비용 원장의 금액을 admission에 쓰는 것은 여전히 별도 버전이다.
- **구현.** mode까지 읽는 판정과 publisher 결과의 닫힌 경로는 승인된 Authority 절의 구현이다. 이 버전과 별개의 변경으로 먼저 병합하며, 이 버전의 승인은 그 병합이 `develop`에 들어간 뒤에만 기록한다. 그 뒤 남는 것은 래치 상수를 true로 바꾸고 `tests/engineeringAgentAmuxAdapter.test.mjs`의 출고 값 기대를 이 버전으로 옮기는 것뿐이다.
- **사고 대응.** 이상이 보이면 먼저 `docs/policy/engineering-agent.md` §12의 정지·mode `off`를 쓴다. 래치를 다시 false로 내리는 것은 그다음 코드 변경이다.

## 버전 27 — 전용 Ubuntu runner의 worker 목록과 Decision Maker 실행 주체

상태: **승인됨.** `approvedBy: mposition`, `approvedAt: 2026-10-09`. 2026-10-09 작성, 작성자 Claude. 작성자와 다른 공급사인 Codex의 독립 검토가 accept였다(r-20261009-005341-7cc18f). 같은 요청의 Cursor 검토는 결과 불명(`reviewer_exit_1`)이었고 다시 보내지 않았다. 이 승인 자체로 아래 활성화 게이트 2~7은 충족되지 않는다. 번호: `develop`의 다음 빈 번호는 26이지만 `main`을 대상으로 한 draft PR #1888(2026-10-04 이후 갱신 없음)이 같은 문서에 다른 내용(CLI 사용량 보존·집계)의 v23~v26을 적고 있어 27을 쓰며, 두 번호 체계의 정리는 운영자가 한다.

이 버전은 v23 실행 위치 절의 “worker 8개”를 아래 목록으로 대체하고, Decision Maker(이하 DM)의 실행 주체 둘을 더한다. v13의 자격증명·결과 경계, v15의 로컬 실행 영수증과 사람 Review, v16의 확인된 provider(`AMUX_VERIFIED_PROVIDERS`는 `claude`, `codex` 그대로)와 교차 검토, v18 실행 API 게이트, v22의 미구현 경계, v23의 격리·활성화 게이트, v24의 invariant 관측 계약은 그대로다. 이 승인 자체로 bridge 환경 변수, 제품 claim, 실행 API, worker catalog, 자동 승격, Publisher, 병합, 배포, DM 스위치를 켜거나 바꾸지 않는다.

### 1. worker 목록과 역할

| provider | 세션 | 수 |
|---|---|---|
| `claude` | v23의 기존 세션 | 4 |
| `codex` | v23의 기존 세션 | 3 |
| `cursor`(Cursor CLI) | `cursor-chore`, `cursor-impl`, `cursor-worker` | 3 |
| `copilot`(GitHub Copilot CLI) | `copilot-chore`, `copilot-impl`, `copilot-worker` | 3 |

- runner의 상주 worker 세션은 이 13개다. 목록 밖의 세션을 더하거나 제거한 세션을 다시 세우는 것은 이 문서의 새 버전이다.
- 2026-10-09 운영자 지시로 `devin-worker`를 runner에서 제거했다. 제거 전에 그 worker에 묶인 열린 카드 0건을 read-back했고, Linux worktree는 보존했다. v23 범위를 좁히는 변경이므로 기록만 한다. 그 read-back이 v23의 identity별 제품 DB 조건(열린 attempt·소유 Todo·미해결 `AmuxOrchestratorWrite` 영수증 0건)까지 덮었는지는 활성화 게이트 2에서 따로 확인한다. 보존한 worktree는 실행 디렉터리가 아니다.
- 새 여섯은 각자 Linux 파일시스템의 독립 Git worktree에서 v23의 규칙(Windows mount·WSL 경로 금지, 재부팅 자동 시작은 세션 시작만)으로 돈다.
- `-chore`는 AGENTS.md “작업을 어느 모델에 보낼지” 표의 `chore`, `-impl`은 `impl`이다. v16 역할로는 각각 `chore`, `implementation`까지다.
- `-worker`는 운영자가 역할을 정하지 않아 이 버전이 정한다. `impl`이 맡을 수 있는 범위 안의 일반 작업(구현, 조사, 재현, 문서 초안)이며 `impl`보다 넓지 않다. v16 역할로는 `implementation`까지다.
- 여섯 모두 `contract`와 `review`를 맡지 않는다. AGENTS.md의 `contract` 대상이나 v16의 `AMUX_CONTRACT_PATHS` 경로를 바꾸는 작업도 맡지 않는다.

### 2. 로그인과 자격증명 목록

- 여섯은 worker 계정 `tommy`에 로그인 둘을 더한다. Cursor CLI 계정 로그인 하나와 GitHub Copilot CLI 로그인 하나(GitHub OAuth device flow)다. Copilot 로그인은 운영자가 2026-10-09, 이 버전 전에 이미 했다. v23이 사전 작업을 다룬 것처럼 이 승인은 그 로그인에 소급 권한을 주지 않는다.
- 여섯 세션이 무엇이든 실행하기 전에(세션 시작과 로컬 카드 포함) 새 자격증명마다 발급 주체, 계정, 저장 위치와 파일 권한, scope, 실제로 닿는 범위를 운영 기록에 적는다. 비밀값은 적지 않는다. device flow가 준 것은 GitHub 토큰이므로 그 GitHub 권한도 적는다. worker 계정에 Devin CLI 로그인이 남아 있으면 쓰는 세션이 없는 자격증명이므로 남은 여부와 남긴 이유를 같은 목록에 적는다.
- 다음 가운데 하나라도 닿으면 먼저 고치고(권한 축소, 재발급, 로그아웃) 다시 적는다. 제품 DB, 배포 권한, v23이 worker 계정에 이미 허용한 범위를 넘는 GitHub 쓰기, bridge 환경 파일·`TOMVERSE_AMUX_SYNC_SECRET`·bridge 프로세스 환경을 읽는 경로. v23의 실제 UID·파일 권한 검사는 새 자격증명에도 양쪽 방향(bridge가 그 자격증명을 읽지 못함 포함)으로 다시 한다.
- 저장소의 `vendor/amux` 소스는 자동 승인 모드의 두 provider를 `--yolo`로 시작한다(`--yolo`는 Cursor에서 `--force`의 별칭이고, Copilot에서 도구·경로·URL을 모두 허용하는 `--allow-all`과 같다). 그러므로 CLI가 묻지 않고 할 수 있는 범위는 계정 경계와 이 목록이 정하며, CLI의 승인 화면을 격리로 세지 않는다.

### 3. 실제 모델과 공급사

- Cursor와 Copilot은 한 CLI로 여러 공급사의 모델을 돌리고, `vendor/amux` 소스는 두 provider의 기본 모델을 서비스가 고르는 `auto`로 둔다. provider 이름은 공급사를 정하지 않는다.
- 여섯 세션의 CLI 호출마다 실제 모델 id, 그 공급사, 값의 출처(CLI 보고 또는 unknown)를 기록한다. 요청한 모델을 실제 모델로 적지 않는다.
- 그 기록이 실행마다 실제 값을 남기는지 확인하고 이 문서와 DM 정책의 별도 버전이 승인되기 전에는 `cursor`·`copilot`을 `AMUX_VERIFIED_PROVIDERS`에 넣지 않는다. 여섯은 v16 교차 검토의 어느 쪽(develop 성공 행의 provider, review 담당)도 되지 않고 v22의 작성자·독립 리뷰 provider 쌍에도 들지 않는다. v16의 비교는 runtime 하나의 provider를 보지만 이 두 CLI는 실행마다 공급사가 달라질 수 있으므로, 편입은 비교 단위를 바꾸는 개정이다.
- 여섯의 질문은 DM으로 가지 않고 운영자에게 간다(docs/policy/amux-decision-maker.md §3, §7).

### 4. CLI 사용량

- 두 provider의 모든 CLI 호출은 v22 절 5의 공통 사용량 사건을 같은 공통 실행 래퍼에서 남긴다. v22 절 5의 “Codex/Claude CLI 호출”은 이 runner에서 Cursor·Copilot CLI 호출을 포함한다.
- CLI가 보고하지 않는 토큰·캐시 필드, 누락, 크래시는 0이 아니라 unknown이다. 실제 모델이 unknown이면 API 환산 예상액을 계산하지 않는다(v22 절 5의 가격 미확인 규칙).
- unknown이 Task 비용 판정에 주는 효과는 v22 절 5 그대로다. 비용 상한을 사용량으로 판정하는 경우 read-back 전까지 그 범위의 새 attempt·claim을 보류하고, 운영자 해제는 최악 상한을 계속 점유한 채 재개하며, 강제 가능한 호출 전 상한이나 예약액이 없으면 운영자 해제로도 자동 실행하지 않는다.
- 이 사건은 DM namespace(`amux-decision-maker`)가 아니다. 사용량의 보존·집계 규칙은 이 버전이 바꾸지 않는다.

### 5. 제품 dispatch 전까지

- 이 버전으로 여섯은 제품 claim·dispatch 대상이 되지 않는다. v16이 미확인 provider runtime에 남긴 비단계 카드 claim도 여섯에게는 열리지 않는다.
- 그 전까지 허용되는 것은 절 2의 목록을 기록하고 고친 뒤 운영자가 직접 지시한 로컬 AMUX 카드뿐이다. 그 카드는 Tomverse 카드가 아니고 `Execution attempt:` 줄을 갖지 않으며 v15의 실행 영수증으로 연결되지 않는다. 결과는 v23의 worker 권한 안에 머문다.
- 여섯을 worker catalog(`TOMVERSE_AMUX_WORKER_CATALOG_JSON`)에 넣지 않는다. 다른 worker를 위해 bridge를 켤 때는 `TOMVERSE_AMUX_WSL_SESSIONS`에 여섯을 뺀 허용 세션만 적는다. 이 변수를 설정하지 않으면 실행 중인 모든 세션이 runtime으로 등록되기 때문이다(apps/tomverse-orchestrator/src/wsl_bridge.rs).
- 여섯의 제품 dispatch는 절 2·3·4가 확인되고 아래 게이트를 지나 운영자가 따로 활성화를 기록한 뒤에만 연다. 그 활성화는 절 3의 교차 검토·DM 편입을 포함하지 않는다.

### 6. Decision Maker 실행 주체

DM 정책(docs/policy/amux-decision-maker.md §5, §7, §12)의 두 인스턴스 `decision-maker-openai`(`codex`)와 `decision-maker-anthropic`(`claude`)을 이 runner의 실행 주체로 더한다. 조건은 그 정책 절 5 그대로이며 하나도 빼지 않는다.

- 공급사마다 권한 없는 별도 OS 계정 하나와, 그 계정에 자기 공급사 CLI 인증 하나만 둔다. worker 계정 `tommy`의 로그인을 쓰거나 그 홈에서 읽지 않으며, Cursor·Copilot 로그인은 DM 계정에 두지 않는다.
- broker는 worker, bridge, 두 공급사 계정과 다른 UID로 돌고 공급사 CLI 인증과 bridge 자격증명을 갖지 않는다. DM 계정과 broker에는 GitHub 로그인, git credential helper, SSH 키, 제품 DB·배포 자격증명, bridge 환경 파일이 없다.
- 일반 worker launcher가 아니라 전용 launcher가 질문마다 비대화형 프로세스 하나를 고정 argv와 고정 환경(허용 목록)으로 시작하고, 시작 전에 설정 digest를 대조한다. 하나라도 기록과 다르면 시작하지 않는다.
- 질문당 30분 hard timeout에 강제 종료한다.
- 양방향 격리. worker는 요청 디렉터리, DM 프로세스, broker를 읽거나 ptrace하지 못한다. DM 계정과 broker는 worker 홈, 저장소 clone, 다른 공급사 계정, AMUX 상태 파일, bridge 환경 파일을 읽지 못한다.
- 네트워크는 공급사 계정이 자기 공급사 API host만, broker가 GitHub 공개 host와 bridge 로컬 소켓만이다.
- DM 정책의 S2 전에 S0의 양방향 계정 격리 실측 증거가 있어야 한다.

두 주체는 상주 tmux worker 세션이 아니고, bridge가 runtime으로 등록하지 않으며, worker catalog에 없고, claim할 수 없다. 절 1의 13개, v22의 “검증된 worker 수”, 동시 실행 상한 어디에도 세지 않는다. 위 조건 가운데 하나라도 빠진 배치는 이 버전이 허락한 DM 주체가 아니다. worker 목록에 DM 이름을 더하거나, 일반 세션·launcher·`tommy`의 로그인으로 DM을 돌리는 것으로는 이 절을 충족하지 못한다. DM 인스턴스 스위치는 `off` 그대로다.

### 활성화 게이트

1. 이 버전의 승인 기록과, 작성자 Claude와 다른 공급사의 독립 검토.
2. `devin-worker` identity의 v23 제품 DB 0건 조건을 read-back한다.
3. 절 2의 자격증명 목록을 기록하고 넓은 범위를 고친다. 여섯 세션의 어떤 실행보다 먼저다.
4. 절 3의 실제 모델 기록과 절 4의 사용량 사건을 여섯 세션 각각의 로컬 카드 실행으로 확인한다. 제품 dispatch보다 먼저다.
5. v23 활성화 게이트 2·3과 v24 관측을 13개 세션으로 다시 한다. v24가 8개 부하로 적은 호스트 메모리는 13개 세션과 DM 프로세스를 함께 띄운 부하에서 다시 본다. `scripts/verify-amux-ubuntu-reboot.mjs`의 기대 목록은 아직 `devin-worker`를 포함한 8개이므로, 그 코드를 고치는 별도 변경 전에는 그 검사가 13개 목록의 증거가 되지 않는다.
6. 여섯의 제품 dispatch는 운영자의 별도 활성화 기록 뒤, v23 활성화 게이트 4의 claim 차단 관측 창과 제한 실행 순서로만 연다.
7. DM 주체는 S0 증거와 DM 정책 S2의 다른 선행 조건을 갖춘 뒤에만 설치·시작한다.

### 이 버전이 하지 않는 것

환경 변수, bridge·claim·실행 API, worker catalog, `AMUX_VERIFIED_PROVIDERS`, 동시 실행·대기열 상한, 용량 행, 자동 승격, Publisher, 병합, 배포, DM 스위치와 DM 정책, CLI 사용량의 보존·집계를 바꾸지 않는다. 위 검증 script를 포함해 어떤 코드도 바꾸지 않는다.

## 버전 28 — AMUX Orchestrator의 Railway 선언을 `Tomverse Agents` project의 IaC로

승인 기록: `approvedBy: mposition`, `approvedAt: 2026-10-09`. 작성자는 Claude이고, 작성자와 다른 provider인 Codex(OpenAI)와 Copilot의 독립 검토가 2차에서 accept였다(r-20261009-090255-583689). 1차의 reject(되돌리기 중 두 orchestrator가 함께 도는 순서, 잘못된 버전 인용)는 고친 뒤 다시 받았다. 번호: `develop`의 다음 빈 번호는 26이지만 버전 27의 번호 기록대로 draft PR #1888이 v26까지 쓰므로 28을 쓴다.

이 버전은 Railway 서비스 `AMUX Orchestrator`를 `Tomverse` project의 대시보드 관리에서 `Tomverse Agents` project의 IaC 선언(`.railway/agent-runners.ts`, `.railway/agents-railway.ts`)으로 옮긴다.

- **왜.** orchestrator는 제품 DB 자격증명을 갖지 않고(버전 16), 앱의 내부 route를 공개 URL로 부른다. `Tomverse Agents`에는 DB 서비스도 공유 변수도 없어서 DB 참조 변수가 해석될 대상이 없고, 그 project의 IaC는 project 전체를 소유하므로 손으로 추가한 것은 apply가 지운다. 다른 Agent 서비스와 같은 자리다.
- **버전 20 9항을 이렇게 바꾼다.** 재시작 정책은 IaC가 선언한다. `On Failure`, 최대 10회다(운영자 결정, 2026-10-09). 대시보드에서 바꾼 값은 다음 apply가 되돌리므로, 바꾸는 것은 그 파일을 고치는 PR과 운영자의 apply다. 9항의 "staging도 같다"는 staging에 orchestrator 서비스가 없으므로 해당이 없다. staging에 orchestrator를 두는 것은 별도 결정이다.
- **버전 20 10항의 운영 기록을 저장소로 옮긴다.** `checkSuites: false`(병합 즉시 배포)는 그대로이고 이제 선언에 있다. CI 대기 배포로 바꾸는 것은 여전히 운영자의 별도 결정이며, 그 변경도 같은 파일을 고치는 PR이다.
- **변수 목록이 계약이다.** `TOMVERSE_AMUX_ENABLED`, `TOMVERSE_AMUX_SYNC_SECRET`, `TOMVERSE_INTERNAL_URL`, `TOMVERSE_AMUX_WORKER_CATALOG_JSON`, `TOMVERSE_AMUX_CLAIM`(버전 15의 claim 전용 모드). 목록 밖의 이름은 apply가 지운다. 명령 실행을 여는 이름(`TOMVERSE_AMUX_EXECUTE`, `TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON`, `TOMVERSE_AMUX_WSL_*`)은 선언하지 않으며, 이 문서의 개정 없이 더하지 않는다. 명령 실행 위치는 버전 23·27의 전용 Ubuntu runner다.
- **빌드와 배치는 그대로다.** `apps/tomverse-orchestrator/Dockerfile`, watch pattern 넷(`apps/tomverse-orchestrator/**`, `crates/amux-core/**`, `Cargo.toml`, `Cargo.lock`), 시작 명령 `/usr/local/bin/tomverse-orchestrator`, production 전용, `main` 브랜치, 지역 `asia-southeast1-eqsg3a`에 복제 1.

### 이전 절차 (한 번)

두 orchestrator가 함께 claim하지 않는 것이 이 절차의 요점이다. 운영자가 로컬 PC의 PowerShell, 이 선언이 들어간 `main` clone 폴더 안에서 한다.

1. `npm run railway:agents:use-production` → `npm run railway:agents:plan`. `AMUX Orchestrator` 추가만 있어야 한다. 맞으면 `npm run railway:agents:apply`. 새 서비스에는 `TOMVERSE_AMUX_ENABLED`가 없으므로 시작하자마자 종료 코드 0으로 끝나고(`docs/ops/amux/recovery.md`의 재시작 정책 절), `On Failure`는 0을 다시 시작하지 않는다.
2. 옛 서비스(`Tomverse` project)의 변수 값을 새 서비스에 옮긴다. `TOMVERSE_AMUX_ENABLED`만 아직 넣지 않는다.
3. 옛 서비스에서 `TOMVERSE_AMUX_ENABLED`를 지우고 Deploy해 멈춘다. 로그에서 프로세스가 끝났음을 본다.
4. 새 서비스에 `TOMVERSE_AMUX_ENABLED`를 넣고 Deploy한다. 로그에서 인스턴스 id 줄과 `verdict = "scheduling"`(또는 정지·대기 줄)을 본다. 3과 4 사이에는 claim과 recover가 멈추고, 진행 중인 attempt의 heartbeat와 정산은 계속된다(버전 20 11항과 같다).
5. 옛 서비스를 `Tomverse` project의 대시보드에서 지운다. 어떤 IaC 파일도 그 서비스를 소유하지 않으므로 apply는 지우지 않는다.
6. `npm run railway:agents:plan`이 변경 없음을 보이는지 보고, `npm run railway:iac:use-staging`으로 CLI 연결을 되돌려 둔다.

되돌리기도 두 orchestrator가 함께 돌지 않게 한다. 항상 **켜져 있는 쪽을 먼저 멈추고, 끝났음을 로그로 본 뒤** 다른 쪽을 켠다.

- 5 전: 새 서비스에서 `TOMVERSE_AMUX_ENABLED`를 지우고 Deploy해 끝났음을 본 뒤, 옛 서비스에 넣고 Deploy해 4와 같은 로그를 본다.
- 5 뒤:
  1. 이 선언을 되돌리는 PR이 `main`에 들어간 뒤, `Tomverse` project에 대시보드로 같은 설정의 서비스를 다시 만들고 값을 넣는다. `TOMVERSE_AMUX_ENABLED`만 아직 넣지 않는다.
  2. 새 서비스(`Tomverse Agents`)에서 `TOMVERSE_AMUX_ENABLED`를 지우고 Deploy해 끝났음을 본다.
  3. 다시 만든 서비스에 `TOMVERSE_AMUX_ENABLED`를 넣고 Deploy해 4와 같은 로그를 본다.
  4. `npm run railway:agents:use-production` → `npm run railway:agents:plan`이 `AMUX Orchestrator` 삭제만 보일 때 apply하고, CLI 연결을 staging으로 되돌린다.

### 이 버전이 하지 않는 것

orchestrator 코드, 버전 20의 정지·재시작 동작(1~8항, 11항), claim·실행 API·worker catalog의 값, 자동 승격, 역할 판정, 웹 서비스, 다른 Agent 서비스를 바꾸지 않는다.
