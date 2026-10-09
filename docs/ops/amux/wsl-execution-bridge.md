# WSL execution bridge

상태: 코드 래치 `WSL_BRIDGE_CODE_LATCH`는 true다. 환경 변수 `TOMVERSE_AMUX_WSL_BRIDGE`가 정확히 `1`이 아니면 runner는 소켓을 열지 않는다. 이 문서는 그 변수를 설정하지 않는다.

정책: `docs/policy/development-agent-orchestration.md` 버전 14, 결과 정산과 claim은 버전 15.

## 방향

Tomverse가 카드, 추천, 승격, 승인, 실행 원장, 감사의 정본이다. 운영자 워크스테이션의 WSL이 그 정본에서 승인된 작업을 가져온다. Tomverse 서버는 워크스테이션으로 접속하지 않고, 워크스테이션은 새 외부 수신 포트를 열지 않는다.

Rust runtime과 BoardDriver는 같은 WSL 프로세스에 둔다. Railway의 `tomverse-orchestrator`는 선택 루프이고, 버전 15의 claim 전용 모드(`TOMVERSE_AMUX_CLAIM`이 정확히 `1`)에서는 owner 없는 Todo를 서버가 execution_ready로 판정한 WSL runtime에 claim한다. claim 전용 모드는 Railway에서 runtime이나 명령 실행기를 시작하지 않는다. `TOMVERSE_AMUX_EXECUTE`는 이 계약의 활성화가 아니며, 두 변수가 함께 설정되면 orchestrator는 시작하지 않는다. 같은 orchestrator가 5분마다 자동 승격 tick(`POST /api/internal/amux/auto-promotion/tick`)을 부른다. 판정은 전부 서버가 한다.

## 로컬 실행

Bridge는 이미 실행 중인 로컬 AMUX 세션에만 작업을 넘긴다. 세션이 없으면 새로 만들지 않는다. Codex나 Claude 프로세스를 하나 더 띄우지 않는다.

등록 직후 runtime은 `starting`이다. 서버는 `idle`이면서 dispatch-ready인 runtime에만 실행을 시작한다. 매 tick은 로컬 roster를 다시 읽고 worker heartbeat를 보낸다. 세션이 `waiting` 또는 `idle`이고 `agents_working`이 아니며, 그 worker의 진행 중인 attempt가 없을 때만 `idle`과 dispatch-ready를 알린다. 진행 중인 attempt, 작업 중 세션, roster에서 사라진 세션은 dispatch-ready가 아니다. heartbeat가 `active_execution`으로 거절되면 그 tick은 `busy`로 다시 알리고 새 실행을 시작하지 않는다. lease를 잃은 worker는 그 프로세스에서 다시 등록하지 않는다.

전송은 `POST /api/sessions/<기존 세션>/send` 하나다. 본문은 `text`, `no_board: true`, `record_history: true`, `msg_id`만 가진다. 로컬 AMUX는 command history에 기록된 owner 전송에서만 카드를 만들고, `record_history`가 없으면 전달은 되지만 `no_board_refused`만 답하고 카드는 생기지 않는다(2026-09-29 첫 claim-only 운행에서 확인). `msg_id`는 Tomverse execution attempt id다. `/api/board`로 카드를 만들지 않는다.

로컬 AMUX는 실질적인 작업 메시지에 대해 `no_board`를 거절하고 로컬 카드를 만든 뒤 메시지를 전달한다(AMUX-3071). 버전 15부터 응답의 `no_board_refused`는 "전달됨, 로컬 카드 발급"이고, 그 카드가 attempt의 로컬 실행 영수증이다. Bridge는 로컬 보드에 쓰지 않고 `GET /api/board`와 `GET /api/board/{id}`만 읽는다.

로컬 전송이 2xx로 끝나도 작업은 끝나지 않았다. 완료는 결과를 Tomverse에 정산했을 때다. 매 tick은 heartbeat 뒤에 진행 중인 attempt마다 영수증을 확인한다.

- 연결: 같은 worker 세션의 카드 가운데, 전송 시각 이후에 생성됐고, 그 카드 자신에게 연결된 메시지에 `Execution attempt: <attempt id>` 줄이 있는 카드 하나다. 에픽의 메시지를 표시만 하는 하위 카드는 세지 않는다. 둘 이상이면 `blocked`(`local_card_ambiguous`), 30분 안에 없으면 `blocked`(`local_card_unlinked`)로 정산한다.
- 정산: 연결된 카드가 `done` 또는 `verified`이면 `succeeded` → `review`, `discarded`·`cancelled`·`quarantined`이면 `blocked` → `blocked`다. 그 밖의 상태는 진행 중이다. 로컬 상태로 `failed` → `todo`를 만들지 않는다.
- 카드의 제목, 설명, `last_result`, evidence는 Tomverse로 보내지 않는다. `review`일 때 evidence와 `last_result`에서 `https://github.com/mposition/Tomverse/pull/<n>`의 첫 번호 하나만 `review_pr_number`로 보내고, 서버가 GitHub에서 확인한다.
- 승격된 카드는 서버가 `done`을 받지 않고 `review`와 사람 escalation으로 바꾼다. `review`에서 `done`은 사람 Review뿐이다. 병합과 배포 승인은 결과가 아니다.
- 정산 응답이 사라지면 attempt를 남기고 다음 tick에 다시 보낸다. 서버는 끝난 attempt와 task revision으로 재전송을 막으므로, 먼저 커밋된 정산은 두 번째에 not-settled로 답하고 그때 attempt를 빼고 halt한다. 로컬 보드 읽기 실패는 결과가 아니므로 다음 tick에 다시 읽는다.

응답이 사라지면 같은 `msg_id`로 조회한 뒤에만 다음을 정한다. 조회가 기존 전송을 찾으면 다시 보내지 않는다. 조회 자체가 실패하면 그 tick의 남은 worker에 `execution_start`를 호출하지 않고, 다음 tick은 halt 상태로 보드를 읽기 전에 거절한다.

## 자격증명

Bridge 프로세스는 Tomverse 내부 API를 부르는 인증을 가질 수 있다. 그 값과 제품 DB 자격증명은 worker에게 넘기는 본문에 넣지 않는다. 이 변경이 강제하는 것은 그 본문 제외다. 환경변수를 비우는 것은 격리의 증거가 아니다. 프로세스, 파일시스템, 네트워크가 나뉘었다는 실측은 이 계약에 없고, 래치가 꺼져 있는 동안 그 실측을 활성화로 대체하지 않는다.

## 단절

로컬 AMUX에 닿지 않거나 WSL이 멈추면 새 배정을 하지 않는다. generation이 바뀌었거나 execution lease가 지난 결과는 거절한다.

Tomverse 내부 호출에는 호출별 deadline이 있고 연결은 1초다. worker 등록·heartbeat·delivery·execution·recovery 같은 lifecycle 호출은 15초로 앱 route 예산 12초보다 길고, claim은 18초, queue·routing snapshot 읽기는 5초다. 쓰기 호출이 deadline을 넘으면 결과 불명이고, 재시도하지 않고 halt한다. 진행 중인 attempt의 execution heartbeat가 전송 오류나 deadline으로 끝나면 그 attempt는 pending에 남고 heartbeat를 계속한다. Tomverse가 명시적으로 거절한 heartbeat만 그 attempt를 pending에서 뺀다. 둘 다 새 배정을 멈춘다.

lifecycle 호출이 503 `amux_database_busy`의 정확한 body로 답하면 그 호출은 시작되지 않았고 아무것도 쓰이지 않았다. bridge는 halt하지 않고 다음 tick에 같은 식별자로 다시 보낸다. worker 등록은 시작 때 만든 같은 instance id로 다시 등록하고, 이미 등록된 이름은 다시 등록하지 않는다. execution start는 그 tick에 배정하지 않으며 owned Todo가 다음 tick에 같은 revision으로 다시 시작된다. delivery pull·ack는 그 attempt를 기억했다가 다음 tick에 새 배정보다 먼저 다시 pull한다(서버는 살아 있는 receipt를 그대로 돌려주고, 만료됐으면 새 receipt를 준다). execution heartbeat와 정산은 attempt를 pending에 남긴다. worker heartbeat의 실패는 전부터 halt가 아니었다. stderr에는 `amux wsl bridge warn:` 한 줄이 남는다. 그 밖의 503과 5xx는 전처럼 결과 불명이다.

worker heartbeat가 `runtime_lease_lost`로 거절되면 다시 등록하지 않고 halt한다. 등록은 generation을 올리는데, 서버의 등록은 열린 attempt를 확인하지 않는다. ack는 됐지만 이 프로세스의 pending에 없는 attempt가 서버에 열려 있을 수 있으므로, 사람이 attempt 상태를 확인한 뒤 다시 시작한다.

Railway orchestrator의 claim 전용 루프는 서버가 답한 claim 결과를 알려진 결과로 본다. 닫힌 사유 목록의 거절과 CAS 패배는 소유권을 바꾸지 않았으므로 같은 창의 다음 후보로 넘어간다. queue나 routing snapshot이 409 `board_capacity_exceeded`로 답하면(카드 512장 또는 응답 512KB 초과, main에는 없던 상한) 아무것도 쓰이지 않았으므로 WARN(`verdict = "selection_skipped"`)을 남기고 그 tick만 건너뛴다. 503 `amux_database_busy`(정확한 body `{"error":"AMUX database is busy.","reason":"amux_database_busy"}`, `Retry-After: 5`)도 같다. 읽기 트랜잭션이 DB를 잠시 얻지 못한 경우(pool, `maxWait` 안의 트랜잭션 시작, statement timeout, 연결 오류)이고, 읽기는 아무것도 쓰지 않으므로 결과 불명이 아니다. 서버는 그 route가 쓰기 트랜잭션을 시작하기 전의 읽기, 그리고 연결을 얻지 못해 시작하지 못한 트랜잭션(쓰기 포함)에만 이 답을 준다(`amuxDbBoundaryFailure`, `lib/amux/dbBoundary.ts`). 그래서 2026-09-30부터 claim과 recover도 이 정확한 body를 받으면 멈추지 않는다. claim은 WARN(`verdict = "claim_skipped"`)을 남기고 그 tick을 건너뛰고, recover는 WARN(`verdict = "recovery_skipped"`)을 남기고 다음 30초 주기에 다시 부른다. 복구와 자동 승격 주기는 그대로 돈다. 전송 오류, 예상 밖 상태 코드·본문 같은 결과 불명 claim과 queue·routing snapshot·recover 호출의 그 밖의 실패는 프로세스를 0이 아닌 종료 코드로 끝낸다. 다시 시작한 프로세스는 queue를 새로 읽는다. 재시작 정책은 `recovery.md`의 "Railway AMUX Orchestrator의 종료와 재시작"을 본다.

## Wire compatibility

`POST /api/internal/amux/queue`와 `POST /api/internal/amux/owned-queue`의 응답 모양은 호환 기간에 있다.

- main 7724fd683부터 develop AMUX 이식 전까지 빌드한 Rust는 queue의 `title`·`status`·`dependencies`와 owned queue의 `title`·`kind`·`priority`·`created_at`을 필수로 읽는다. 없으면 orchestrator tick이 실패하고 bridge는 halt한다(종료 코드 3). 그 Rust의 API 구조체에는 `deny_unknown_fields`가 없고(executor.rs에만 있다), `Option` 필드는 키가 없으면 `None`이다.
- 서버는 그 필수 필드를 보내고 그 밖의 호환 필드는 보내지 않는다. queue 행은 14개 키(main이 보내던 `owner`는 뺀다), owned queue 행은 7개 키(main이 보내던 `description`·`claimed_at`는 뺀다. description은 최대 50,000자의 자유 텍스트라 512KB 상한을 채울 수 있다)다. 스키마는 `lib/amux/wireContract.ts`, 기준 본문은 `tests/fixtures/amux-queue-wire-compat-v1.json`이다.
- 저장된 카드 id나 owner가 정규 machine id 규칙에 맞지 않는 행은 두 queue 모두 그 행만 빼고 200으로 답한다. 구조화 WARN `queue_rows_rejected`에 개수만 남기고 id는 남기지 않는다. 그런 카드는 claim·routing snapshot·실행 시작 요청에서도 거절되므로 어차피 이 앱으로는 진행되지 않는다.
- 이 트리에서 빌드한 Rust는 main 서버의 모양, 이 서버의 모양, `id`·`owner`·`revision`만 가진 최소 모양을 모두 받고, 그 밖의 필드는 거절한다. 호환 필드는 읽지 않는다.
- 배포 순서: 서버 먼저가 안전하다. 옛 바이너리와 새 바이너리가 모두 이 서버의 모양을 읽는다. bridge를 먼저 다시 빌드해도 안전하다. 새 바이너리는 배포 전 main 서버의 모양도 읽는다.
- 새 상한: 서버는 카드 512장이나 응답 512KB를 넘으면 queue·owned queue·routing snapshot을 409 `board_capacity_exceeded`로 답한다. 옛 orchestrator는 그 tick을 실패로 로그하고 계속 돌고, 새 orchestrator는 그 tick을 건너뛴다. 새 bridge는 owned queue의 이 답(route가 보내는 정확한 body `{error, reason: "board_capacity_exceeded"}`)을 받으면 stderr에 `amux wsl bridge warn:` 한 줄을 남기고 그 tick의 새 배정만 건너뛴다. halt하지 않고, 진행 중인 attempt의 heartbeat와 정산은 계속한다. owned queue가 503 `amux_database_busy`(위와 같은 정확한 body)로 답해도 같다. stderr 줄은 `amux wsl bridge warn: owned queue answered 503 amux_database_busy; no new assignment this tick, not halted`다. owned queue의 다른 409(`execution_api_disabled`)와 그 밖의 5xx는 전처럼 halt다. 옛 bridge는 이 답에서도 halt한다. owned queue는 worker마다 열린 카드가 하나라 worker 수를 넘기 어렵다. 병합 전에 운영 queue의 크기를 읽기 전용으로 확인한다.
- 호환 필드를 빼는 것은 별도 변경이다. WSL bridge와 Railway orchestrator가 모두 이 트리 이후의 바이너리로 돈다는 것을 확인한 뒤, 스키마, 기준 본문, `tests/amuxWireContract.test.ts`, `lib/amux/store.ts`, 이 절을 함께 바꾼다.

## halt와 재시작

halt는 runner가 스스로 풀지 않는다. 원인은 사라진 전송, 거절된 heartbeat, 응답 없는 Tomverse 호출 같은 결과 불명이고, 다시 시작해도 되는지는 사람이 판단한다. halt한 runner는 진행 중인 attempt가 남지 않으면 종료 코드 3으로 끝나고 stderr에 한 줄을 남긴다. 종료 코드 0은 정상 종료, 1은 시작 실패다.

## 상시 실행

실행 위치: 운영자 PC의 WSL(Ubuntu) bash, Tomverse clone 폴더의 `apps/tomverse-orchestrator`. Rust toolchain이 필요하다. 이 단계는 Tomverse 쪽 상태를 바꾸지 않는다.

release 빌드:

```bash
cargo build --release --locked --bin tomverse-wsl-bridge
```

환경 파일은 `~/.config/tomverse-wsl-bridge.env`에 두고 권한은 `600`이다. 넣는 이름은 `TOMVERSE_AMUX_WSL_BRIDGE`, `TOMVERSE_AMUX_WSL_LOCAL_URL`, `TOMVERSE_INTERNAL_URL`, `TOMVERSE_AMUX_SYNC_SECRET`이다. 선택으로 `TOMVERSE_AMUX_WSL_SESSIONS`에 쉼표로 세션 이름을 적으면 그 세션만 등록한다. 범위를 좁히기만 하며, 한 세션만 두면 한 번에 한 attempt만 돈다. 값은 이 문서와 대화에 적지 않는다.

systemd user unit `~/.config/systemd/user/tomverse-wsl-bridge.service`의 핵심은 셋이다. `After=amux-server.service`로 로컬 AMUX 뒤에 시작하고, `Restart=on-failure`와 `RestartSec=60`으로 시작 실패만 다시 시도하며, `RestartPreventExitStatus=3`으로 halt는 다시 시작하지 않는다.

```ini
[Unit]
Description=Tomverse AMUX WSL execution bridge
After=amux-server.service

[Service]
EnvironmentFile=%h/.config/tomverse-wsl-bridge.env
ExecStart=%h/.local/bin/tomverse-wsl-bridge
Restart=on-failure
RestartSec=60
RestartPreventExitStatus=3

[Install]
WantedBy=default.target
```

halt 뒤에는 로그(`journalctl --user -u tomverse-wsl-bridge`)와 Tomverse의 attempt 상태를 확인한 다음 사람이 `systemctl --user restart tomverse-wsl-bridge`로 다시 시작한다.

## 활성화

버전 14가 코드 래치를 켰다. `tomverse-wsl-bridge`는 `TOMVERSE_AMUX_WSL_BRIDGE`가 정확히 `1`이고 `TOMVERSE_AMUX_WSL_LOCAL_URL`이 loopback일 때만 `run_from_env`로 들어간다. 그 함수는 `bridge_tick_sourced`를 호출하고, 실행 attempt의 전달 본문은 Tomverse의 delivery pull로 받는다. `bridge_tick`은 고정 본문을 받는 테스트용 진입점이다. 세션이 없으면 `start_for_dispatch`가 실패하고 프로세스를 만들지 않는다. 환경 변수가 없으면 바이너리와 `scripts/amux-wsl-bridge.mjs`는 소켓을 열지 않고 끝난다.

이 버전은 두 환경 변수를 설정하지 않는다. `TOMVERSE_AMUX_EXECUTE`를 켜지 않는다.

## 검증

래치가 꺼져 있던 `fff30f8dd`의 독립 검토는 Codex `gpt-5.6-sol` pass다. 버전 14의 래치 변경은 그 판정 대상이 아니다. 배포된 staging에서 runner를 실행하지 않았다.

## 전용 Ubuntu 서버 이전 절차 (정책 v23 승인, 운영 활성화 대기)

이 절은 `docs/policy/development-agent-orchestration.md` v23의 실행 절차다. 운영자 `mposition`이 2026-10-01 승인했고 Claude 독립 검토에서 정책 문구 차단 사항이 없음을 확인했다. 아래 운영 게이트를 통과하기 전에는 새 호스트의 bridge를 켜지 않는다. 위 WSL 사용자 서비스 예시는 기존 호스트의 기록이며, 새 호스트에 그대로 적용하지 않는다. Linux 세션 이전과 8개 worker 자동 시작은 이미 끝났지만 제품 bridge는 꺼져 있다. v23 승인은 그 사전 작업을 소급 승인하지 않는다.

1. 새 서버의 worker 계정에서 AMUX 서버와 8개 worker를 Linux native worktree로 운행한다. `amux-worker-start.service`가 재부팅 후 8개를 시작했는지 각 세션의 실제 프로세스와 작업 디렉터리로 확인한다. 새 서버의 옛 `tomverse-wsl-bridge.service` **사용자** unit은 disabled/inactive로 둔다. AMUX invariant 관측은 승인된 v24 정정 계약으로 판정한다.
2. 기존 WSL AMUX 서버·bridge의 systemd뿐 아니라 Windows Task Scheduler·시작 프로그램·`wsl.conf` boot 명령 등 자동 시작 경로를 읽어 끈다. 새 등록 전에 제품 DB에서 이전 worker **각각**의 열린 attempt 0건, 소유된 Todo 0건, 미해결 `AmuxOrchestratorWrite` 영수증 0건, lease·generation을 read-back한다. 종료되지 않은 로컬 카드 중 `Execution attempt:`를 담은 카드는 원래 Tomverse attempt에 모두 대응시킨다. 해소된 attempt의 로컬 작업은 claim을 열기 전에 멈춘다. 남은 건은 기존 app route의 lease expiry/recover 또는 사람 Review·escalation으로 해소하고 다시 읽는다. 직접 SQL로 고치거나 로컬 카드 상태를 제품 상태로 추정하지 않는다.
3. 유출 가능성이 있는 기존 `TOMVERSE_AMUX_SYNC_SECRET`을 교체하고 옛 값이 거부됨을 확인한다. 새 서버 worker 홈·AMUX DB·백업·shell 기록에 비밀 사본이 남았는지 값 출력 없이 검사한다. 기존 WSL 인증 파일은 원본 기록으로만 보존한다. bridge 값은 worker 계정에 다시 복사하지 않는다.
4. 운영자 권한으로 worker와 별도의 무권한 Linux 계정과 **system** unit을 준비한다. 운영자 계정은 worker와 분리한다. 이전된 `tommy`는 현재 `sudo`·`docker`·`lxd` 그룹에 있으므로 worker로 계속 쓰려면 이 세 권한을 제거하고 `NOPASSWD`·공유 sudo 캐시도 없앤다. 별도 운영자 로그인 경로를 먼저 확보한다. 그룹 제거 뒤 worker의 user systemd manager·tmux·AMUX 서버·8개 세션을 재시작하고 각 프로세스의 `/proc/<pid>/status` `Groups`를 확인한다. 이전 root 동등 권한으로 만들어졌을 수 있는 sudoers·system unit/timer·root cron·setuid 파일·docker/lxd 컨테이너와 이미지를 점검한 뒤 bridge를 설치한다. 승인된 commit에서 빌드한 bridge 바이너리와 unit은 root 소유로 설치해 worker 쓰기를 막는다. 인증 파일은 bridge 계정만 읽는다. 필요한 변수는 `TOMVERSE_INTERNAL_URL`, 새 `TOMVERSE_AMUX_SYNC_SECRET`, loopback `TOMVERSE_AMUX_WSL_LOCAL_URL`이며, AMUX API가 토큰을 요구하면 별도 bridge 토큰도 이 파일에 둔다. `TOMVERSE_AMUX_WSL_BRIDGE=1`은 활성화 결정 때에만 넣는다. `TOMVERSE_AMUX_EXECUTE`는 켜지 않는다. system unit에는 `User=`와 `NoNewPrivileges`, 적절한 `ProtectHome`·`ProtectSystem`, `Restart=on-failure`, `RestartSec=60`, `RestartPreventExitStatus=3`을 둔다. AMUX 서버는 **사용자** unit이므로 `After=amux-server.service`로 두 unit을 순서화할 수 없다. bridge 시작 전에 loopback AMUX readiness를 별도로 기다리며 실패 시 재시도한다.
5. AMUX 수신 주소를 loopback으로 제한하거나 방화벽에서 운영자 SSH 외 접근을 막고 외부 호스트에서 포트가 닫혔는지 확인한다. 전용 계정의 AMUX loopback API 접근과 Tomverse 내부 route 호출, `record_history` owner 전송 시 로컬 카드 생성 가능성을 실측한다. worker가 bridge 인증 파일·프로세스 환경에 접근하거나 root 소유 바이너리·unit을 바꾸지 못하고, bridge가 worker 자격증명을 읽지 못하는지 확인한다. 제품 DB·GitHub 쓰기·배포 인증은 bridge 계정에 없다. 비밀값과 내부 URL은 로그에 출력하지 않는다.
6. 승인된 정책 SHA, bridge 바이너리 SHA, 서버·CLI 버전, 제품 실행 API 게이트, 시간 동기화, AMUX DB `quick_check`와 복사 digest, 8개 worktree SHA, Git origin, 이전·새 서비스 상태를 기록한다. **Railway claim 루프가 꺼지거나 orchestrator가 halt한 상태**, 소유된 Todo 0건, `TOMVERSE_AMUX_WSL_SESSIONS`를 worker 하나로 제한한 상태에서 등록·heartbeat를 관측한다. bridge에는 register-only 모드가 없으므로 이 창에서는 실행이 없었다는 증거를 확인한다. 그 다음 운영자가 claim을 열어 제한 실행을 관측한다.
7. 오류·결과 불명·lease 충돌·감사 누락·비밀 접근이 보이면 새 **system** unit을 중지한다. bridge의 exit 3 halt는 자동 재시작하지 않는다. 제품 DB에서 attempt와 영수증을 대조하고 운영자가 재개 또는 fallback을 결정한다. 새 unit의 재개는 `systemctl`의 system scope를 사용한다. WSL 원본 파일은 보존하되 old bridge를 무조건 재시작하지 않는다. 제품 DB를 로컬 백업으로 덮어쓰지 않는다.

이 절은 승인 후에도 운영값을 기록하는 곳이 아니다. 호스트명, 내부 URL, 인증값, 계정별 접근 증거와 실제 활성화 판단은 운영 기록에 남긴다.

### v24 관측 게이트 정정 (2026-10-02 승인, 활성화 대기)

v23 절차 1의 `confidence=healthy` 요구는 승인된 정책 v24의 관측 계약으로 대체한다. `unknown`을 pass로 세지 않고, 관련 unknown의 표본 부재를 면제 사유로 삼지 않는다. 작성자와 다른 provider의 독립 reviewer 또는 운영자가 컬럼별 관련성·증거를 확인한다. 제품 claim 전에 관련 안전 조건을 코드·테스트와 격리된 직접 관측 양쪽으로 증명하고, worker 보고 hook은 제품 카드가 아닌 로컬 합성 AMUX 작업으로 확인한다. v23 계정·그룹 정리와 AMUX 재시작 뒤, claim을 막은 관측 창 직전·사람의 claim 해제 직전·첫 제한 실행 중·후에 정책 v24의 상태·invariant·write probe와 두 유효 예산값을 재확인한다. 새 unknown·실패·예산 초과나 값 변경이 있거나 연속 관측이 불가능하면 bridge를 중지하고 claim을 막는다. 100만 행 예산은 v24 승인 시점 이후의 운영값이며 그 전 0 fail 관측은 게이트 증거가 아니다. 예산 80% 초과와 행 수·증가율·보존 종료 시점 추정치를 운영자에게 알린다. 실패가 재발하면 예산을 다시 올리는 대신 원인을 조사한다. v24 승인만으로 bridge·claim·제품 실행이 활성화되지는 않는다.
