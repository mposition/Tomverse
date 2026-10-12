# AMUX 실행 bridge 감시

전용 Ubuntu 호스트의 `tomverse-bridge.service`가 멈추면 Slack과 이메일로 알리는 장치와, 알림을 받은 뒤의
순서다. bridge 자체의 계약과 재시작 규칙은 `wsl-execution-bridge.md`가 정하고, 이 문서는 그것을 바꾸지 않는다.

## 왜 있는가

bridge는 결과를 모르면 종료 코드 3으로 halt하고, systemd는 이를 다시 시작하지 않는다(`RestartPreventExitStatus=3`).
재시작 여부는 사람이 판단한다는 설계이며 이 문서도 그대로 둔다. 문제는 아무도 halt를 몰랐다는 것이다.

| halt (UTC) | 재시작 (UTC) | 멈춰 있던 시간 | journal에 남은 원인 |
|---|---|---|---|
| 2026-10-05 08:37 | 2026-10-06 21:52 | 37시간 | 없음 |
| 2026-10-07 02:02 | 2026-10-08 08:07 | 30시간 | 없음(app 로그로 409 `runtime_lease_lost` 확인) |
| 2026-10-08 12:01 | 2026-10-08 12:56 | 55분 | 없음(app 로그로 owned queue 500 확인) |
| 2026-10-09 03:37 | 2026-10-10 00:59 | 21시간 | 없음 |

## 신호 셋

| | 어디서 | 무엇을 보는가 | 잡는 것 | 알림 |
|---|---|---|---|---|
| 1. box watchdog | Ubuntu 호스트의 systemd timer, 5분마다 | `systemctl is-active tomverse-bridge.service` | halt, 정지, 호스트 꺼짐, 네트워크 끊김 | Healthchecks.io → Slack·이메일 |
| 2. lease 판정 | 앱의 15분 인프라 감시 | `AmuxWorkerRuntime.leaseExpiresAt` | 위 전부, 그리고 프로세스는 살아 있지만 heartbeat가 앱에 닿지 않는 경우 | 앱 운영 알림 → Slack·운영자 이메일·Sentry |
| 3. halt 원인 줄 | bridge 자신 | 처음 halt한 이유 | — | 알림이 아니라 journal 한 줄 |

1과 2는 서로 독립이다. 1은 앱이 죽어도 동작하고, 2는 호스트에 아무것도 설치하지 않아도 동작한다.

## 1. box watchdog

파일: `scripts/amux-bridge-watchdog/`. 테스트: `tests/amuxBridgeWatchdog.test.mjs`.

한 번 실행할 때 bridge unit의 상태를 읽고 본문 없는 요청 하나를 보낸다.

| `is-active` | 보내는 것 | monitor |
|---|---|---|
| `active` | ping URL | up 유지 |
| `failed`, `inactive` | ping URL + `/fail` | 즉시 down 알림 |
| 그 밖(`activating` 등, 읽기 실패) | 없음 | 유예 시간이 지나면 down 알림 |

- ping URL은 systemd credential(`LoadCredential=ping-url`)로만 전달되고 unit의 동적 사용자만 읽는다. worker 계정
  `tommy`는 이 값을 읽을 수도, 성공 신호를 위조할 수도 없다. 스크립트와 설치 스크립트는 값을 출력하지 않는다.
- 호스트 밖으로 나가는 것은 그 요청 하나뿐이다. journal 줄, worker 이름, 카드, 종료 코드는 나가지 않는다.
  monitor가 기록하는 것은 수신 시각, 호스트의 공인 IP, curl의 User-Agent다.

### 1.1 Healthchecks.io에 check 만들기 (운영자, 대시보드)

과금·재무 Agent의 dead-man monitor와 같은 Healthchecks.io 계정을 쓴다(`docs/ops/billing-finance-ops-deadman-monitor.md`).

1. 새 check. 이름은 `amux-bridge-production`(호스트와 환경만, 다른 값을 넣지 않음).
2. Schedule: Simple, **Period 5분, Grace 5분.** 마지막 신호 뒤 최대 약 10분이면 down이 된다.
3. Integrations: **Email**(운영자 주소)과 **Slack**을 이 check에 켠다. Slack은 Integrations › Add Integration › Slack에서
   채널을 고른다. 운영 알림이 가는 채널과 같은 곳을 권한다.
4. 이메일이 정크로 분류된 이력이 있다(위 문서 §3). 설치 뒤 2절의 탐지 실험에서 실제 받은편지함 도착을 확인한다.
5. check의 ping URL을 복사해 둔다. 대화·문서·저장소에 붙이지 않는다.

### 1.2 호스트에 설치 (운영자)

실행 위치: Ubuntu 호스트(192.168.0.7)의 bash, **관리자 계정 `tomverse-admin`**. worker 계정 `tommy`에서는 하지 않는다.
sudo가 필요하고, production 자격증명은 필요 없다. `<SHA>`는 이 문서가 들어 있는 병합 commit의 전체 40자리 SHA다.

```bash
sha=<SHA>
d=$(mktemp -d)
for f in install.sh tomverse-bridge-watchdog tomverse-bridge-watchdog.service tomverse-bridge-watchdog.timer; do
  curl -fsSL --proto '=https' -o "$d/$f" "https://raw.githubusercontent.com/mposition/Tomverse/$sha/scripts/amux-bridge-watchdog/$f"
done
sudo bash "$d/install.sh" "$d"
```

- 고정 commit에서 받아 관리자만 들어갈 수 있는 `mktemp -d` 디렉터리에 둔다. 설치 스크립트는 worker 소유이거나
  그룹·다른 사용자에게 열린 디렉터리를 거절한다.
- ping URL을 물으면 붙여 넣는다. 화면에 보이지 않는다. `/etc/tomverse-bridge-watchdog/ping-url`(root, 0600)에 저장된다.
- 설치는 watchdog을 한 번 실행하고 끝난다. URL이 답하지 않거나 bridge 상태를 읽지 못하면 설치가 실패한다.
  마지막 줄이 `TOMVERSE_BRIDGE_WATCHDOG_INSTALLED`이고 Healthchecks 대시보드에 첫 ping이 보이면 끝이다.
- 바꾸는 것: 위 파일 세 개와 credential 파일, timer 활성화. 되돌리기는 1.4절.

확인(읽기 전용, `tommy`로도 된다):

```bash
systemctl list-timers tomverse-bridge-watchdog.timer --no-pager
journalctl -u tomverse-bridge-watchdog.service -n 5 --no-pager -o short-iso
```

**탐지 실험(선택, 운영자):** 실제 경로로 알림을 받아 보려면, bridge가 처리 중인 attempt가 없을 때
`sudo systemctl stop tomverse-bridge.service`로 멈추고 5분 안에 Slack과 이메일이 오는지 본다. 그 뒤
`sudo systemctl start tomverse-bridge.service`. 20분 넘게 멈춰 두면 앱 쪽 신호(2절)도 알린다.

### 1.3 의도적으로 멈출 때

bridge를 일부러 멈추기 전에 Healthchecks 대시보드에서 check를 **Pause**한다. 다시 켠 뒤 첫 ping이 오면 자동으로
풀린다. 앱 쪽 신호에는 끄는 스위치가 없다. 멈춰 있는 동안 3시간마다 다시 알리고, lease가 끝난 지 48시간이
지나면 그 bridge를 폐기된 것으로 보고 알리지 않는다.

### 1.4 URL 교체와 제거

실행 위치: Ubuntu 호스트의 bash, `tomverse-admin`. sudo가 필요하다.

- URL 교체: `sudo rm /etc/tomverse-bridge-watchdog/ping-url` 뒤 1.2절을 다시 실행한다.
- 제거:

```bash
sudo systemctl disable --now tomverse-bridge-watchdog.timer
sudo rm -f /etc/systemd/system/tomverse-bridge-watchdog.service /etc/systemd/system/tomverse-bridge-watchdog.timer /usr/local/libexec/tomverse-bridge-watchdog
sudo rm -rf /etc/tomverse-bridge-watchdog
sudo systemctl daemon-reload
```

제거한 뒤에는 Healthchecks check도 지운다. 그대로 두면 down 알림이 온다.

## 2. 앱의 lease 판정

코드: `lib/amux/bridgeLivenessCore.ts`(판정), `lib/infrastructureThresholdMonitor.ts`(읽기와 알림).
테스트: `tests/amuxBridgeLivenessCore.test.mjs`, `tests/server-contract/infrastructure-threshold-monitor.test.ts`.

bridge는 세션마다 `AmuxWorkerRuntime` lease(90초)를 약 31초마다 갱신한다. `Credit Reconciliation` cron(15분)이
부르는 인프라 감시가 최근 48시간 안에 끝난 lease를 읽고 판정한다.

| 상태 | 조건 | 알림 |
|---|---|---|
| `unwatched` | 48시간 안의 lease가 없음 — 이 환경에 bridge가 없음 | 없음 |
| `live` | 하나라도 아직 유효 | 직전이 `lost`였으면 복구 알림 |
| `lapsing` | 전부 끝났고 5분 미만 | 없음 |
| `lost` | 전부 끝난 지 5분 이상 | 처음 발견하면 즉시, 그 뒤 3시간마다 |

- 알림은 기존 운영 알림 경로(`reportOperationalDependencyStatus`)다. production에는 Slack
  (`OPS_ALERT_SLACK_WEBHOOK_URL`)과 운영자 이메일(`OPS_ALERT_EMAIL`)이 설정돼 있다(2026-10-12에 이름만 확인).
  새 환경변수는 없다.
- 알림 내용: 코드 `AMUX_EXECUTION_BRIDGE_LOST`, lease가 끝난 시각과 분, `/admin/office`, journal을 먼저 보라는 문장.
  worker 이름, 카드, 멈춘 이유는 싣지 않는다.
- lease를 읽지 못하면 `AMUX_EXECUTION_BRIDGE_CHECK_FAILED`로 따로 알리고, 실행 기록에는 `amuxBridge: null`을 남긴다.
- 탐지까지 최대 약 20분(cron 15분 + 5분). 이 cron이 늦게 돌면 그만큼 늦는다. 빠른 쪽은 1절이다.
- 상태는 웹 프로세스 메모리에 있으므로 배포 직후 bridge가 여전히 멈춰 있으면 한 번 더 알린다.
- 판정은 develop → main release로 production에 간다. 배포 전에는 1절만 동작한다.

## 3. halt 원인 줄

코드: `apps/tomverse-orchestrator/src/wsl_bridge.rs`의 `bridge_error_class`·`note_halt`·`halt_line`.

halt하면 journal에 다음 한 줄이 남는다. 앞부분은 예전과 같아서 같은 검색어로 찾힌다.

```text
amux wsl bridge halted: no new assignments; cause=<원인>; restart only after checking Tomverse and the local AMUX
```

원인은 처음 halt한 이유 하나이고, 닫힌 어휘다.

| 원인 | 뜻 |
|---|---|
| `worker_runtime_lease_lost` | worker heartbeat가 409 `runtime_lease_lost`. 앱 쪽 lease가 먼저 끝났다(2026-10-07) |
| `tick_failed_<class>` | owned queue·claim·delivery 등 tick의 호출이 결과 불명으로 끝났다 |
| `execution_heartbeat_<class>` | 진행 중 attempt의 heartbeat가 결과 불명 |
| `execution_heartbeat_refused` | 앱이 그 attempt의 heartbeat를 거절했다 |
| `dispatch_outcome_unknown` | 로컬 AMUX로 보낸 작업의 결과를 확인하지 못했다 |
| `settle_outcome_unknown` | 정산 결과를 모른다(바로 위에 attempt id가 적힌 줄이 따로 있다) |
| `pending_session_missing`, `settle_session_missing` | 진행 중 attempt의 로컬 세션이 사라졌다 |

`<class>`는 `http_<상태 코드>`, `amux_database_busy`, `amux_database_deadline_exceeded`,
`amux_database_call_ceiling_exceeded`, `timeout`, `connect`, `transport`, `other` 중 하나다. 오류의 원문은
내부 URL이나 응답 본문을 담을 수 있어 출력하지 않는다. 예를 들어 2026-10-08의 halt는 이제
`cause=tick_failed_http_500`으로 남는다.

이 변경은 bridge 바이너리를 바꿔야 효과가 있다. 바이너리 교체는 운영자 승인 대상이며
`wsl-execution-bridge.md`의 전용 Ubuntu 서버 절차를 따른다.

## 4. 알림을 받으면

자동 재시작은 없다. 순서는 `wsl-execution-bridge.md` "halt와 재시작"과 같다.

1. 호스트에서 원인 줄을 읽는다(읽기 전용, `tommy`로 된다):
   `journalctl -u tomverse-bridge.service -n 20 --no-pager -o short-iso`
2. `/admin/office`의 AMUX 방과 Tomverse의 attempt 상태를 확인한다.
3. 다시 시작해도 된다고 판단하면 관리자 계정에서 `sudo systemctl restart tomverse-bridge.service`.
4. 5분 안에 Healthchecks가 up으로 돌아오고, 다음 인프라 감시에서 앱이 복구 알림을 보낸다.
