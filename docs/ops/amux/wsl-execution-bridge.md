# WSL execution bridge

상태: 코드 래치 `WSL_BRIDGE_CODE_LATCH`는 true다. 환경 변수 `TOMVERSE_AMUX_WSL_BRIDGE`가 정확히 `1`이 아니면 runner는 소켓을 열지 않는다. 이 문서는 그 변수를 설정하지 않는다.

정책: `docs/policy/development-agent-orchestration.md` 버전 14.

## 방향

Tomverse가 카드, 추천, 승격, 승인, 실행 원장, 감사의 정본이다. 운영자 워크스테이션의 WSL이 그 정본에서 승인된 작업을 가져온다. Tomverse 서버는 워크스테이션으로 접속하지 않고, 워크스테이션은 새 외부 수신 포트를 열지 않는다.

Rust runtime과 BoardDriver는 같은 WSL 프로세스에 둔다. 클라우드 scheduler와 로컬 runner를 이 단계에서 서로 다른 프로세스로 나누지 않는다. Railway의 `tomverse-orchestrator`는 선택 루프로 남고, `TOMVERSE_AMUX_EXECUTE`는 이 계약의 활성화가 아니다.

## 로컬 실행

Bridge는 이미 실행 중인 로컬 AMUX 세션에만 작업을 넘긴다. 세션이 없으면 새로 만들지 않는다. Codex나 Claude 프로세스를 하나 더 띄우지 않는다.

등록 직후 runtime은 `starting`이다. 서버는 `idle`이면서 dispatch-ready인 runtime에만 실행을 시작한다. 매 tick은 로컬 roster를 다시 읽고 worker heartbeat를 보낸다. 세션이 `waiting` 또는 `idle`이고 `agents_working`이 아니며, 그 worker의 진행 중인 attempt가 없을 때만 `idle`과 dispatch-ready를 알린다. 진행 중인 attempt, 작업 중 세션, roster에서 사라진 세션은 dispatch-ready가 아니다. heartbeat가 `active_execution`으로 거절되면 그 tick은 `busy`로 다시 알리고 새 실행을 시작하지 않는다. lease를 잃은 worker는 그 프로세스에서 다시 등록하지 않는다.

전송은 `POST /api/sessions/<기존 세션>/send` 하나다. 본문은 `text`, `no_board: true`, `msg_id`만 가진다. `msg_id`는 Tomverse execution attempt id다. `/api/board`로 카드를 만들지 않는다.

로컬 응답에 `no_board_refused`가 있으면 그 전송은 배정이 아니다. 로컬 보드가 같은 작업의 카드를 만들려 한 것이므로 재전송하지 않고, Tomverse attempt를 완료로 정산하지 않는다.

로컬 전송이 2xx로 끝나도 작업은 끝나지 않았다. 완료는 worker 결과를 Tomverse에 정산했을 때다. 허용 결과는 `succeeded` → `review`, `failed` → `todo`, `blocked` → `blocked`뿐이다. `done`, 병합, 배포 승인은 결과가 아니다.

응답이 사라지면 같은 `msg_id`로 조회한 뒤에만 다음을 정한다. 조회가 기존 전송을 찾으면 다시 보내지 않는다. 조회 자체가 실패하면 그 tick의 남은 worker에 `execution_start`를 호출하지 않고, 다음 tick은 halt 상태로 보드를 읽기 전에 거절한다.

## 자격증명

Bridge 프로세스는 Tomverse 내부 API를 부르는 인증을 가질 수 있다. 그 값과 제품 DB 자격증명은 worker에게 넘기는 본문에 넣지 않는다. 이 변경이 강제하는 것은 그 본문 제외다. 환경변수를 비우는 것은 격리의 증거가 아니다. 프로세스, 파일시스템, 네트워크가 나뉘었다는 실측은 이 계약에 없고, 래치가 꺼져 있는 동안 그 실측을 활성화로 대체하지 않는다.

## 단절

로컬 AMUX에 닿지 않거나 WSL이 멈추면 새 배정을 하지 않는다. generation이 바뀌었거나 execution lease가 지난 결과는 거절한다.

Tomverse 내부 호출에는 호출별 deadline이 있고 연결은 1초다. worker 등록·heartbeat·delivery·execution·recovery 같은 lifecycle 호출은 15초로 앱 route 예산 12초보다 길고, claim은 18초, queue·routing snapshot 읽기는 5초다. 쓰기 호출이 deadline을 넘으면 결과 불명이고, 재시도하지 않고 halt한다. 진행 중인 attempt의 execution heartbeat가 전송 오류나 deadline으로 끝나면 그 attempt는 pending에 남고 heartbeat를 계속한다. Tomverse가 명시적으로 거절한 heartbeat만 그 attempt를 pending에서 뺀다. 둘 다 새 배정을 멈춘다.

worker heartbeat가 `runtime_lease_lost`로 거절되면 다시 등록하지 않고 halt한다. 등록은 generation을 올리는데, 서버의 등록은 열린 attempt를 확인하지 않는다. ack는 됐지만 이 프로세스의 pending에 없는 attempt가 서버에 열려 있을 수 있으므로, 사람이 attempt 상태를 확인한 뒤 다시 시작한다.

## halt와 재시작

halt는 runner가 스스로 풀지 않는다. 원인은 사라진 전송, 거절된 heartbeat, 응답 없는 Tomverse 호출 같은 결과 불명이고, 다시 시작해도 되는지는 사람이 판단한다. halt한 runner는 진행 중인 attempt가 남지 않으면 종료 코드 3으로 끝나고 stderr에 한 줄을 남긴다. 종료 코드 0은 정상 종료, 1은 시작 실패다.

## 상시 실행

실행 위치: 운영자 PC의 WSL(Ubuntu) bash, Tomverse clone 폴더의 `apps/tomverse-orchestrator`. Rust toolchain이 필요하다. 이 단계는 Tomverse 쪽 상태를 바꾸지 않는다.

release 빌드:

```bash
cargo build --release --locked --bin tomverse-wsl-bridge
```

환경 파일은 `~/.config/tomverse-wsl-bridge.env`에 두고 권한은 `600`이다. 넣는 이름은 `TOMVERSE_AMUX_WSL_BRIDGE`, `TOMVERSE_AMUX_WSL_LOCAL_URL`, `TOMVERSE_INTERNAL_URL`, `TOMVERSE_AMUX_SYNC_SECRET`이다. 값은 이 문서와 대화에 적지 않는다.

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
