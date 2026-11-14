# AMUX 실행 bridge 감시

전용 Ubuntu 호스트의 AMUX 실행 bridge가 멈추면 Slack과 이메일로 알리는 장치와, 알림을 받은 뒤의
순서다. bridge 자체의 계약과 재시작 규칙은 `wsl-execution-bridge.md`가 정한다. 5절의 자동 재시작은 운영자가
2026-10-14에 승인한 좁은 예외이고, 그 밖의 재시작은 여전히 사람이 판단한다.

## 왜 있는가

bridge는 결과를 모르면 종료 코드 3으로 halt하고, systemd는 이를 다시 시작하지 않는다(`RestartPreventExitStatus=3`).
재시작 여부는 사람이 판단한다는 설계다. 문제는 아무도 halt를 몰랐다는 것이다. 알림이 생긴 뒤에도 재시작을 기다린
시간이 길어서, 아무것도 남기지 않았음이 확인되는 두 원인만 5절이 자동으로 다시 시작한다.

| halt (UTC) | 재시작 (UTC) | 멈춰 있던 시간 | journal에 남은 원인 |
|---|---|---|---|
| 2026-10-05 08:37 | 2026-10-06 21:52 | 37시간 | 없음 |
| 2026-10-07 02:02 | 2026-10-08 08:07 | 30시간 | 없음(app 로그로 409 `runtime_lease_lost` 확인) |
| 2026-10-08 12:01 | 2026-10-08 12:56 | 55분 | 없음(app 로그로 owned queue 500 확인) |
| 2026-10-09 03:37 | 2026-10-10 00:59 | 21시간 | 없음 |
| 2026-10-12 03:44 | 2026-10-12 04:26~04:32 | 42~48분 | 없음(production 배포 중 앱이 응답하지 않음. bridge 5개가 함께 halt) |

bridge는 하나가 아니다. worker마다 `tomverse-amux-bridge@<worker>`가 하나씩 돌고(정책 버전 55, 2026-10-20 기준 codex 셋과
claude 셋), v22 worker는 그 옆에 `tomverse-amux-v22-sidecar@<worker>`가 하나씩 돈다. 2026-10-12에는
`tomverse-bridge.service`(codex 세션)와 `tomverse-amux-v22-bridge@<worker>`였고, S4에서 지웠다.

## 신호 셋

| | 어디서 | 무엇을 보는가 | 잡는 것 | 알림 |
|---|---|---|---|---|
| 1. box watchdog | Ubuntu 호스트의 systemd timer, 5분마다 | bridge·sidecar unit 전부의 `systemctl is-active` | 어느 하나의 halt·정지, 호스트 꺼짐, 네트워크 끊김 | Healthchecks.io → Slack·이메일 |
| 2. lease 판정 | 앱의 15분 인프라 감시 | `AmuxWorkerRuntime.leaseExpiresAt` | **모든** lease가 끊긴 경우 — 호스트·네트워크·전체 halt, 그리고 프로세스는 살아 있지만 heartbeat가 앱에 닿지 않는 경우. bridge 일부만 멈춘 것은 1이 잡는다 | 앱 운영 알림 → Slack·운영자 이메일·Sentry |
| 3. halt 원인 줄 | bridge 자신 | 처음 halt한 이유 | — | 알림이 아니라 journal 한 줄 |

1과 2는 서로 독립이다. 1은 앱이 죽어도 동작하고, 2는 호스트에 아무것도 설치하지 않아도 동작한다.
Decision Maker relay는 6절이 따로 본다.

## 1. box watchdog

파일: `scripts/amux-bridge-watchdog/`. 테스트: `tests/amuxBridgeWatchdog.test.mjs`.

한 번 실행할 때 bridge unit 전부의 상태를 읽고 본문 없는 요청 하나를 보낸다. 대상은 로드된
`tomverse-amux-bridge@*`(정책 버전 55의 worker별 bridge, `wsl-execution-bridge.md`의 `--worker` 절)와
`tomverse-amux-v22-sidecar@*` 인스턴스 전부다. 옛 이름(`tomverse-bridge.service`, `tomverse-amux-v22-bridge@*`)은
S4부터 보지 않는다. 시작하지 않은 인스턴스는 보통 로드되지 않으므로 템플릿을 설치만 한 동안에는 대상이
아니다. 다만 `systemctl status tomverse-amux-bridge@<이름>`처럼 이름으로 조회하면 그 인스턴스가 잠시 로드되어
`inactive`로 읽히고 down 신호가 나갈 수 있다.

- 로드된 `tomverse-amux-bridge@*`가 **하나도 없으면** down이다. sidecar만 있어도 down이다. 재부팅 뒤 아무 bridge도
  켜지지 않은 상태를 빈 "전부 정상"으로 보내지 않는다. 목록을 읽지 못한 실행은 이 판정 없이 신호를 보내지 않는다.

| 상태 | 보내는 것 | monitor |
|---|---|---|
| 전부 `active` | ping URL | up 유지 |
| 하나라도 `failed`, `inactive` | ping URL + `/fail` | 즉시 down 알림 |
| 그 밖(`activating` 등, 읽기 실패) | 없음 | 유예 시간이 지나면 down 알림 |

어느 unit이 왜 그런지는 watchdog의 journal에 unit마다 한 줄로 남는다. 상태를 읽지 못하면 `systemctl`의 오류 첫 줄을
함께 적는다(`journalctl -u tomverse-bridge-watchdog.service -n 20`). 이 내용은 호스트 밖으로 나가지 않는다.

- ping URL은 systemd credential(`LoadCredential=ping-url`)로만 전달되고 unit의 전용 시스템 계정 `tomverse-bridge-watchdog`(로그인 셸 없음, 자기 그룹만)만 읽는다. 설치 스크립트가 이 계정을 만들고, 이미 있으면 셸과 그룹을 확인만 한다. 동적 사용자(`DynamicUser=`)는 쓰지 않는다 — 이 호스트의 system bus가 동적 사용자의 연결을 끊어 `systemctl`이 매번 "Transport endpoint is not connected"로 실패했다(2026-10-12 첫 설치). curl에도
  인자가 아니라 stdin 설정으로 넘긴다 — 프로세스 인자는 `/proc/<pid>/cmdline`으로 다른 사용자가 읽을 수 있고, 이
  호스트의 `/proc`에는 `hidepid`가 없다. 그래서 worker 계정 `tommy`는 이 값을 읽을 수도, 성공 신호를 위조할 수도
  없다. 스크립트와 설치 스크립트는 값을 출력하지 않는다.
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
- 설치는 watchdog을 한 번 실행하고, 그 실행이 신호(`sent up` 또는 `sent down`)를 보냈는지 그 실행의 journal로
  확인한다. URL이 답하지 않거나 bridge 상태를 읽지 못해 아무것도 보내지 않았으면 설치가 실패하고 timer를 끈다.
  (첫 버전은 아무것도 보내지 않은 실행도 성공으로 보고했다.) 마지막 줄이 `TOMVERSE_BRIDGE_WATCHDOG_INSTALLED`이고
  Healthchecks 대시보드에 첫 ping이 보이면 끝이다.
- 이미 설치돼 있으면 같은 명령을 새 SHA로 다시 실행한다. URL은 다시 묻지 않는다.
- 바꾸는 것: 위 파일 세 개와 credential 파일, timer 활성화. 되돌리기는 1.4절.

확인(읽기 전용, `tommy`로도 된다):

```bash
systemctl list-timers tomverse-bridge-watchdog.timer --no-pager
journalctl -u tomverse-bridge-watchdog.service -n 5 --no-pager -o short-iso
```

**탐지 실험(선택, 운영자):** 실제 경로로 알림을 받아 보려면, bridge가 처리 중인 attempt가 없을 때
`sudo systemctl stop tomverse-amux-bridge@<worker>.service`로 하나를 멈추고 5분 안에 Slack과 이메일이 오는지 본다. 그 뒤
`sudo systemctl start tomverse-amux-bridge@<worker>.service`. 20분 넘게 멈춰 두면 앱 쪽 신호(2절)도 알린다.

### 1.3 의도적으로 멈출 때

bridge를 일부러 멈추기 전에 Healthchecks 대시보드에서 check를 **Pause**한다. 다시 켠 뒤 첫 ping이 오면 자동으로
풀린다. 앱 쪽 신호에는 끄는 스위치가 없다. 멈춰 있는 동안 3시간마다 다시 알리고, lease가 끝난 지 48시간이
지나면 그 bridge를 폐기된 것으로 보고 더 알리지 않는다. 그때 복구 알림도 보내지 않는다 — 복구는 살아 있는 lease가
실제로 보일 때만 알린다.

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

판정 대상은 worker bridge와 같은 `readAmuxWorkerBridgeScope` 목록이다. 운영자가 pause·retire했거나 stop latch로
빠진 worker의 예전 runtime은 제외한다. 2026-11-14에는 이미 pause된 `cursor-chore`와 `copilot-chore`의 lease가
장애로 집계됐다. 목록을 읽지 못하면 `AMUX_EXECUTION_BRIDGE_CHECK_FAILED`이고, 빈 목록이나 꺼진 scope는
`unwatched`다. 이를 정상 복구로 알리지 않는다.

bridge가 돌리지 않는 runtime은 판정에서 뺀다(`AMUX_NON_BRIDGE_WORKERS`). 지금은 `engineering-runner` 하나다 —
engineering Agent가 30분마다 실행할 때 앱이 직접 90초짜리 runtime을 등록한다. 2026-10-12 밤 bridge가 모두 멈춘
동안 이 lease가 세 번 "복구"로 읽혀 거짓 복구 알림과 재알림이 나갔다. 앱 코드에 runtime을 등록하는 곳이 새로
생기면 `tests/amuxBridgeLivenessCore.test.mjs`가 실패하므로, 그 worker를 이 목록에 넣는다.

**runtime마다 따로 판정한다.** 처음에는 lease가 **전부** 끝나야 `lost`였다. 2026-10-13에 `claude-impl`이
02:45Z, `claude-review`가 04:22Z에 멈췄지만, 다른 bridge의 lease가 살아 있어서 마지막 bridge가 멈춘 05:32Z까지
아무 알림도 나가지 않았다.

| 상태 | 조건 | 알림 |
|---|---|---|
| `unwatched` | 48시간 안의 lease가 없음 — 이 환경에 bridge가 없거나 폐기됨 | 없음(복구 알림도 없음) |
| `live` | 모든 runtime의 lease가 유효 | 직전이 `lost`였으면 복구 알림 |
| `lapsing` | 끝난 lease가 있지만 모두 5분 미만 | 없음(복구 알림도 없음) |
| `lost` | 끝난 지 5분 이상인 runtime이 하나라도 있음 | 새 runtime이 이 목록에 들어오면 즉시, 같은 목록이면 3시간마다 |

- 알림은 기존 운영 알림 경로(`reportOperationalDependencyStatus`)다. production에는 Slack
  (`OPS_ALERT_SLACK_WEBHOOK_URL`)과 운영자 이메일(`OPS_ALERT_EMAIL`)이 설정돼 있다(2026-10-12에 이름만 확인).
  새 환경변수는 없다.
- 이메일이 안 보이면 먼저 Resend의 발송 기록을 본다. 제목은 `[Tomverse Operations] AMUX execution bridge stopped
  heartbeating`, 발신은 `alerts@mail.tomverse.app`이다. `delivered`는 받는 쪽 메일 서버가 받았다는 뜻일 뿐이고
  받은편지함에 들어갔다는 뜻이 아니다. 2026-10-13에 세 통이 `delivered`였지만 운영자는 받은 메일이 없었다.
  그러면 받는 메일함의 정크·필터를 확인한다.
- 알림 내용: 코드 `AMUX_EXECUTION_BRIDGE_LOST`, 멈춘 worker 이름과 각 lease가 끝난 시각, 살아 있는 runtime 수,
  `/admin/office`, 각 bridge unit의 halt 줄을 먼저 보라는 문장. 이름은 어느 unit을 볼지 알려 주므로 싣는다
  (정책 버전 55 S3 뒤로는 모두 `tomverse-amux-bridge@<이름>`). 평범한 식별자가 아닌
  이름은 `unnamed-runtime`으로 바꾼다. 카드와 멈춘 이유는 싣지 않는다.
- 폐기한 worker의 lease는 48시간 동안 `lost`로 남아 3시간마다 다시 알리고, 그동안 복구 알림도 나가지 않는다.
  worker를 폐기할 때는 이 점을 감안한다.
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

원인은 처음 halt한 이유 하나이고, 닫힌 어휘다. 그와 별도로 bridge는 원인을 기록할 때마다
`amux wsl bridge halt noted: cause=<원인>` 한 줄을 남긴다. 처음 것 뒤에 기록된 원인도 남으므로, 5절의 자동
재시작은 이 줄로 그 실행에서 기록된 원인을 모두 본다.

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

5절이 설치돼 있으면 `worker_runtime_lease_lost`와 "0 result(s) already committed"가 남은 `tick_failed_*`는 2분 안에
자동으로 다시 시작되고, 알림 뒤 복구 알림이 따라온다. 그 밖의 원인은 자동으로 다시 시작하지 않는다. 순서는
`wsl-execution-bridge.md` "halt와 재시작"과 같다.

1. 어느 unit인지 본다(읽기 전용, `tommy`로 된다): `journalctl -u tomverse-bridge-watchdog.service -n 12 --no-pager -o cat`.
   그 unit의 원인 줄을 읽는다: `journalctl -u <unit> -n 20 --no-pager -o short-iso`
2. `/admin/office`의 AMUX 방과 Tomverse의 attempt 상태를 확인한다.
3. 다시 시작해도 된다고 판단하면 관리자 계정에서 `sudo systemctl restart <unit>`.
4. 5분 안에 Healthchecks가 up으로 돌아오고, 다음 인프라 감시에서 앱이 복구 알림을 보낸다.

## 5. 자동 재시작 (승인된 원인만)

코드: `scripts/amux-bridge-autorestart/`. 테스트: `tests/amuxBridgeAutorestart.test.mjs`.

**승인:** 운영자, 2026-10-14. 2026-10-13 하루 동안 bridge가 열 번 넘게 halt했고, 대부분 아무것도 저장되지 않은
원인이었는데도 사람이 재시작할 때까지 몇 시간씩 멈춰 있었다. 외부에 있으면 호스트에 들어갈 수 없어 그대로 장애가
된다. 승인 범위는 아래 두 원인이고, **횟수 제한은 두지 않는다**(운영자 결정).

| halt 원인 | 자동 재시작 | 근거 |
|---|---|---|
| `worker_runtime_lease_lost` | 한다 | 앱이 이미 그 runtime을 버렸다. 다시 시작하면 새 generation으로 등록한다 |
| `tick_failed_<class>`, 같은 실행에 `after 0 result(s) already committed this tick` 줄이 있을 때 | 한다 | 실패한 tick이 아무것도 저장하지 않았다 |
| `tick_failed_<class>`, 저장된 결과가 1개 이상 | 하지 않는다 | |
| `dispatch_outcome_unknown`, `settle_outcome_unknown`, `pending_session_missing`, `settle_session_missing`, `execution_heartbeat_*` | 하지 않는다 | 결과를 모른다. 사람이 확인한다 |
| halt 줄이 없거나 읽을 수 없음 | 하지 않는다 | |

동작:

- systemd timer가 2분마다 실행한다. 대상은 `tomverse-amux-bridge@*`(정책 버전 55의 worker별 bridge) 중 `failed`이고
  종료 코드가 3인 unit뿐이다. 목록을 읽지 못하면 아무것도 재시작하지 않는다. 종료 코드 1(시작 실패)은 unit의 `Restart=on-failure`가 이미 다시
  시작하고, 손으로 멈춘 unit은 `inactive`라 건드리지 않는다. sidecar도 건드리지 않는다.
- 원인은 그 실패한 실행(invocation)의 journal만 읽는다. 이전 실행의 줄이 섞이지 않는다.
- halt 줄은 처음 원인만 적고, halt 뒤에 결과를 모르게 된 작업(예: 열린 채 남은 읽기 전용 API attempt)은 다른 줄을
  남기지 않을 수 있다. 그래서 그 실행의 `halt noted: cause=` 줄이 **모두** 승인된 원인이고, halt 줄이 그중 첫
  번째를 가리키고, 나머지 줄이 모두 알려진 무해한 줄일 때만 재시작한다. 그 밖의 줄이 하나라도 있으면 멈춘 채 둔다.
- **이 줄을 남기는 bridge 바이너리가 있어야 동작한다.** 그 전의 바이너리가 남긴 halt는 기록된 원인을 알 수 없어
  모두 멈춘 채 둔다. codex bridge(`/usr/local/libexec/tomverse-wsl-bridge`)와 v22 bridge
  (`/opt/tomverse-amux-v22/tomverse-wsl-bridge`) 둘 다 이 절이 들어 있는 commit 이후로 빌드해 교체해야 한다
  (운영자 승인, `wsl-execution-bridge.md`의 전용 Ubuntu 서버 절차).
- 다시 시작하기 전에 로컬 AMUX 서버 `/health`와 Tomverse `/api/health`가 답해야 한다. 답하지 않으면 다음
  실행에서 다시 본다.
- bridge는 진행 중인 attempt가 하나도 남지 않았을 때만 종료 코드 3으로 끝난다. 그래서 다시 시작해도 넘겨받을
  작업이 없다.
- 판정은 매 실행 한 줄씩 이 unit의 journal에 남는다: `… halted with cause=…; restarted` 또는 `… left halted`.
  1·2절의 알림은 그대로 나가고, 다시 붙으면 복구 알림이 따라온다.
- 전용 시스템 계정 `tomverse-bridge-autorestart`로 돈다. polkit 규칙
  (`/etc/polkit-1/rules.d/50-tomverse-bridge-autorestart.rules`)이 그 계정에 bridge unit의 **restart만** 허용한다.
  stop·start·다른 unit·sidecar는 허용하지 않는다. journal은 unit이 주는 `systemd-journal` 보조 그룹으로 읽는다.

### 5.1 설치 (운영자)

실행 위치: Ubuntu 호스트(192.168.0.7)의 bash, **관리자 계정 `tomverse-admin`**. sudo가 필요하고, production
자격증명은 필요 없다. `<SHA>`는 이 절이 들어 있는 병합 commit의 전체 40자리 SHA다.

```bash
sha=<SHA>
d=$(mktemp -d)
for f in install.sh tomverse-bridge-autorestart tomverse-bridge-autorestart.service tomverse-bridge-autorestart.timer 50-tomverse-bridge-autorestart.rules; do
  curl -fsSL --proto '=https' -o "$d/$f" "https://raw.githubusercontent.com/mposition/Tomverse/$sha/scripts/amux-bridge-autorestart/$f"
done
sudo bash "$d/install.sh" "$d"
```

- 설치는 polkit에 직접 물어 규칙의 범위를 확인한다: bridge restart(`tomverse-amux-bridge@` 인스턴스 포함)는 허용,
  bridge stop, `tomverse-amux-bridge@` 인스턴스의 stop·start, ssh restart, sidecar restart는 거절이어야 한다.
  하나라도 어긋나면 실패하고 timer를 켜지 않는다.
- 그 뒤 한 번 실행하고 timer를 켠다. 마지막 줄이 `TOMVERSE_BRIDGE_AUTORESTART_INSTALLED`이면 끝이다.
- 바꾸는 것: 시스템 계정 하나, 실행 파일과 unit 둘, polkit 규칙 하나, timer 활성화. 되돌리기는 5.3절.

확인(읽기 전용, `tommy`로도 된다):

```bash
systemctl list-timers tomverse-bridge-autorestart.timer --no-pager
journalctl -u tomverse-bridge-autorestart.service -n 10 --no-pager -o short-iso
```

### 5.2 잠시 끌 때

bridge를 손으로 확인하는 동안 자동 재시작을 막으려면 timer만 끈다.

```bash
sudo systemctl disable --now tomverse-bridge-autorestart.timer
```

다시 켤 때는 `sudo systemctl enable --now tomverse-bridge-autorestart.timer`.

### 5.3 제거

```bash
sudo systemctl disable --now tomverse-bridge-autorestart.timer
sudo rm -f /etc/systemd/system/tomverse-bridge-autorestart.service /etc/systemd/system/tomverse-bridge-autorestart.timer /usr/local/libexec/tomverse-bridge-autorestart /etc/polkit-1/rules.d/50-tomverse-bridge-autorestart.rules
sudo systemctl daemon-reload
sudo userdel tomverse-bridge-autorestart
```

## 6. Decision Maker relay

relay(`tomverse-amux-dm-relay.service`, `scripts/systemd/tomverse-amux-dm-relay.service`)는 worker bridge가 아니라
따로 도는 unit 하나다. 30초마다 `POST /api/internal/amux/decision-maker/v22-questions/sync`를 불러 worker 질문, 결과
검토, T2 draft를 DM 카드로 옮기고 확정된 답을 적용한다. 2026-11-09 10:30 AEST부터 이 호출이 끊겼고, 그 사이 worker
질문 3건이 DM에 가지 못했는데 5일 동안 아무 알림도 없었다. 위 1~5절은 relay를 보지 않았다.

**11-09의 원인:** relay unit에 `[Install]` 절이 없어(`static`) 재부팅 뒤 다시 켜지지 않았다. 박스에서
`Active: inactive (dead)`, journal에는 halt·exit 줄 없이 11-08 10:08 UTC의 정상 처리 줄이 마지막이었다. 이제 unit에
`WantedBy=multi-user.target`이 있고(worker bridge와 같은 운영자 결정, 2026-11-14), enable한 relay는 부팅 때 켜진다.

relay는 halt해도 **프로세스가 끝나지 않는다.** `amux dm relay halt: <cause>; …` 한 줄을 남기고 `active`인 채로
local marker만 풀며 아무 일도 하지 않는다. 그래서 systemd 상태만으로는 halt를 알 수 없고, 앱의 호출 기록이 주
신호다.

| | 어디서 | 무엇을 보는가 | 잡는 것 | 알림 |
|---|---|---|---|---|
| 앱의 호출 기록 | 앱의 15분 인프라 감시 | relay의 마지막 sync 호출 시각(`AppSetting` `amuxDmRelayLastSyncAt`) | halt, 프로세스 정지, 호스트·네트워크 끊김 | `AMUX_DM_RELAY_SILENT` → Slack·운영자 이메일·Sentry |
| box watchdog(1절) | Ubuntu 호스트, 5분마다 | relay unit의 `systemctl is-active` | `failed`·`inactive` | Healthchecks.io → Slack·이메일 |
| 자동 재시작(6.2절) | Ubuntu 호스트, 2분마다 | relay 현재 실행의 halt 줄, 이번 부팅의 시작 여부 | 두 읽기 halt와 부팅 뒤 한 번도 안 켜진 relay만 시작 | 알림이 아니라 journal 한 줄 |

### 6.0 relay unit 갱신과 부팅 시 시작 (운영자)

실행 위치: Ubuntu 호스트(192.168.0.7)의 bash, 관리자 계정 `tomverse-admin`. sudo가 필요하고 production 자격증명은 필요
없다. `<SHA>`는 이 절이 들어 있는 병합 commit의 전체 40자리 SHA다. 바이너리와 env 파일은 바꾸지 않는다.

```bash
sha=<SHA>
d=$(mktemp -d)
curl -fsSL --proto '=https' -o "$d/tomverse-amux-dm-relay.service" "https://raw.githubusercontent.com/mposition/Tomverse/$sha/scripts/systemd/tomverse-amux-dm-relay.service"
sudo install -o root -g root -m 0644 "$d/tomverse-amux-dm-relay.service" /etc/systemd/system/tomverse-amux-dm-relay.service
sudo systemd-analyze verify /etc/systemd/system/tomverse-amux-dm-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now tomverse-amux-dm-relay.service
systemctl is-enabled tomverse-amux-dm-relay.service
```

마지막 줄이 `enabled`이면 끝이다. 부팅 때 켜지지 않게 되돌리려면 `sudo systemctl disable tomverse-amux-dm-relay.service`.

같은 문제가 있는지 다른 unit도 훑었다(2026-11-14, 저장소 기준). 상시 실행되면서 `[Install]`이 없는 것은 relay와
`amux-v22-read-only-api-sidecar@.service`뿐이고, 뒤의 것은 키·동의 절차를 거친 인스턴스만 손으로 시작하도록 일부러
뺐다. DM broker와 launcher는 socket(`WantedBy=sockets.target`)으로, recovery controller·inspector·v4 analysis·retention·
v19 session cycle은 timer(`WantedBy=timers.target`)로 켜진다. worker bridge(`tomverse-amux-bridge@`)와 CLI monitor는
`multi-user.target`이다. `tomverse-amux-v22-sidecar@`의 unit 파일은 저장소가 아니라 박스 번들에 있어 여기서 볼 수
없다. 박스에서 한 번 확인한다(읽기 전용):

```bash
systemctl list-unit-files 'tomverse-amux-*' 'amux-*' --no-pager
```

`static`이면서 상시 실행돼야 하는 unit이 있으면 알린다.

### 6.1 알림

- sync route는 sync token이 맞으면 라우팅 스위치를 보기 전에 호출 시각을 기록한다(`lib/amux/dmRelayHeartbeat.ts`, 쓰는
  곳은 이 route 하나). 기록에 실패해도 relay의 tick은 실패하지 않는다.
- 감시는 **production 배포에서 `TOMVERSE_AMUX_DM_ROUTING=enabled`일 때만** 본다. 전용 Ubuntu relay는 production을
  부른다. dev·staging에 라우팅 스위치가 켜져 있어도 그 환경에 relay가 설치됐다는 뜻이 아니므로 감시하거나 복구를 알리지
  않는다. 배포 환경은 `resolveDeploymentEnvironment`로 판정하며 `NODE_ENV=production`만으로 dev를 production으로 보지
  않는다. 마지막 호출이 **5분**(idle tick 10번)보다 오래됐거나
  기록이 없으면 `AMUX_DM_RELAY_SILENT`를 보내고, 같은 상태는 3시간마다 다시 알린다. 다시 호출하면 `…_RECOVERED`가 간다.
  감시가 15분마다 돌므로 멈춘 뒤 알림까지는 5~20분이다. 기록을 읽지 못하면 `AMUX_DM_RELAY_CHECK_FAILED`를 따로 보낸다.
- 예외 하나: relay는 DM 질문 하나를 broker에 맡기면 그 답을 최대 34분(`DM_BROKER_RESPONSE_DEADLINE`, 그 앞의 배정
  창 2분) 기다리고, 그동안 sync를 부르지 않는다. 그래서 sync가 5분 넘게 없어도 **40분 안에 만들어진 DM 요청**
  (`AmuxDecisionMakerRequest.createdAt`)이 있으면 "질문 중"으로 보고 아무것도 보내지 않는다(정상이라고도 하지 않는다).
  질문 중에 relay가 죽었다면 알림은 그 요청 뒤 40분이 지나서 간다.
- heartbeat 쓰기는 sync route의 예산(15초) 안에서 맨 먼저 돌고, 연결 대기 0.5초·transaction 1.5초·문장 1초·잠금 0.5초로
  묶여 있다. 넘으면 버리고 sync는 그대로 진행한다.
- 알림을 받으면 호스트에서 relay의 journal을 먼저 읽는다(읽기 전용, `tommy`로도 된다).

```bash
systemctl status tomverse-amux-dm-relay.service --no-pager
journalctl -u tomverse-amux-dm-relay.service -n 50 --no-pager -o short-iso
```

  `amux dm relay halt: <cause>` 줄이 있으면 그 원인의 요청을 Admin에서 읽은 뒤 `sudo systemctl restart
  tomverse-amux-dm-relay.service`. 종료 코드 2로 `failed`면 relay token 설정 오류다(`dm-relay.env`). 그 밖의 종료는
  unit의 `Restart=on-failure`가 60초 뒤 다시 시작한다.
- box watchdog은 relay unit 파일이 설치된 호스트에서만 relay를 본다(`systemctl show -p LoadState`가 `not-found`면
  보지 않는다). relay를 일부러 멈추면 `inactive`라 down 신호가 나가므로, 멈추기 전에 1.3절처럼 check를 Pause한다.
  relay는 bridge로 세지 않는다. relay만 있고 bridge가 없으면 여전히 down이다. watchdog을 이미 설치했다면 1.2절 명령을
  새 SHA로 다시 실행하면 relay도 보기 시작한다.

### 6.2 자동 재시작 (설치해야 켜짐)

코드: `scripts/amux-dm-relay-autorestart/`. 테스트: `tests/amuxDmRelayAutorestart.test.mjs`.

**승인:** 운영자, 2026-11-14(대화에서 "승인, 병합 후 설치"). 범위는 아래 표의 두 읽기 halt와 이번 부팅에 한 번도 켜지지
않은 relay의 시작, 한 시간에 한 번까지다. 범위를 넓히려면 다시 승인을 받는다.

자율 장치에 relay 재시작 권한을 새로 주는 일이라 **설치가 곧 켜는 것**이고, 운영자가 병합 뒤 직접 설치한다. 설치하지
않으면 아무것도 하지 않는다. relay의 halt 원인은 `apps/tomverse-orchestrator/src/dm_relay/`의 `flow.rs`와
`delivery.rs`에 있고, 테스트가 그 목록 전체가 아래 표 어디엔가 있는지 확인한다(새 원인이 생기면 테스트가 실패한다).

| halt 원인 | 자동 재시작 | 근거 |
|---|---|---|
| `unsettled_read_unreadable` | 한다 | 시작할 때 "정리 안 된 delivery" 목록을 **읽은** 답을 해석하지 못함. 그 단계가 첫 단계이고 아무것도 쓰기 전에 끝난다 |
| `delivery_read_unreadable` | 한다 | 다음 확정 답을 **읽은** 답을 해석하지 못함. 같은 이유 |
| `assignment_*`, `transmit_intent_*`, `transmit_outcome_*`, `result_unknown_*`, `cleanup_unknown_report_unconfirmed` | 하지 않는다 | 질문 흐름의 쓰기(배정, 전송 의도, 전송 결과, 결과 unknown 기록, 정리 보고)의 답을 잃었거나 거절됐거나 읽지 못함. 결과를 모른다 |
| `delivery_decision_outcome_unknown`, `delivery_unknown_pause_unconfirmed`, `delivery_not_sent_*`, `delivery_card_record_failed`, `delivery_recovered_card_record_unconfirmed` | 하지 않는다 | 확정 답 적용 쪽 쓰기의 결과를 모른다. 사람이 Admin에서 요청을 읽는다 |

재시작해도 남는 것이 없는 이유: halt한 relay가 들고 있던 것은 새 프로세스가 시작할 때 모두 다시 만든다. 남은 marker는
목록으로 다시 읽어 풀고, 정리 안 된 delivery는 local 기록으로 정리하고(다시 보내지 않음), cursor는 처음부터 다시 걷는다.
한 프로세스는 halt를 한 번만 한다(halt한 tick은 halt할 수 있는 단계 앞에서 돌아온다). 그래서 bridge와 달리
`halt noted:` 줄을 따로 두지 않아도 halt 줄의 원인이 그 실행의 유일한 원인이다.

동작:

- timer가 2분마다 돈다. relay가 `active`/`running`이고 **현재 실행**(invocation)의 journal에 halt 줄이 정확히 하나,
  원인이 위 두 읽기 halt 중 하나일 때만 본다. halt 줄 뒤에는 그 tick이 마저 남길 수 있는 v22 질문 요약 줄
  (`amux dm relay: v22 questions: …`, 키마다 idempotent하고 halt하지 않는다)만 있어야 한다.
- **한 시간에 한 번까지만** 재시작한다. 이 unit의 journal에 지난 60분 안의 `…; restarted` 줄이 있으면 멈춘 채 둔다.
  앱이 relay가 읽지 못하는 모양으로 계속 답하면(배포 중 계약 불일치) 새 프로세스도 곧 halt하는데, `delivery_read_unreadable`의 halt tick은
  sync를 한 번 부르므로 2분마다 재시작하면 앱의 침묵 알림이 영영 울리지 않는다. 두 번째 halt는 그대로 두어 6.1절 알림이 울린다.
- 로컬 AMUX `/health`와 Tomverse `/api/health`가 답해야 하고, 재시작 직전에 unit의 실행이 판정한 그 실행인지 다시 읽는다.
- **이번 부팅에서 한 번도 켜진 적 없는** relay(`inactive`/`dead`, `ActiveEnterTimestampMonotonic=0`, unit 파일 있음, 그리고
  이번 부팅의 relay journal `journalctl -u tomverse-amux-dm-relay.service -b 0`에 줄이 하나도 없음)는
  시작한다(`not_started_since_boot`). timestamp만으로는 부족하다: enable되지 않은 unit은 사람이 멈춘 뒤 systemd가 상태를
  비우면 다시 0으로 읽힌다. journal에는 systemd의 Started·Stopped 줄이 남으므로 사람이 멈춘 relay는 그대로 둔다. journal을
  읽지 못하면 시작하지 않는다. 11-09에 재부팅이 남긴 상태다. enable한 relay는 systemd가 부팅 때 켜므로, 이것은
  enable되지 않은 호스트를 덮는다. 한 시간 제한, health check, 직전 재확인은 같다. relay 스위치가 꺼져 있으면 relay는
  바로 0으로 끝나고 다시 시작되지 않는다.
- 이번 부팅에 한 번이라도 켜졌다가 `inactive`인 relay(사람이 멈춤)와 `failed`인 relay는 건드리지 않는다(종료 코드 2는
  사람, 그 밖은 systemd의 `Restart=on-failure`).
- 전용 시스템 계정 `tomverse-dm-relay-autorestart`로 돈다. polkit 규칙
  (`/etc/polkit-1/rules.d/50-tomverse-dm-relay-autorestart.rules`)이 그 계정에 `tomverse-amux-dm-relay.service`의
  **restart만** 허용한다. stop·start·bridge·broker·다른 unit은 허용하지 않는다. journal은 `systemd-journal` 보조 그룹으로 읽는다.

#### 설치 = 켜기 (운영자)

실행 위치: Ubuntu 호스트(192.168.0.7)의 bash, **관리자 계정 `tomverse-admin`**. sudo가 필요하고, production
자격증명은 필요 없다. `<SHA>`는 이 절이 들어 있는 병합 commit의 전체 40자리 SHA다.

```bash
sha=<SHA>
d=$(mktemp -d)
for f in install.sh tomverse-dm-relay-autorestart tomverse-dm-relay-autorestart.service tomverse-dm-relay-autorestart.timer 50-tomverse-dm-relay-autorestart.rules; do
  curl -fsSL --proto '=https' -o "$d/$f" "https://raw.githubusercontent.com/mposition/Tomverse/$sha/scripts/amux-dm-relay-autorestart/$f"
done
sudo bash "$d/install.sh" "$d"
```

- 설치는 polkit에 직접 물어 범위를 확인한다: relay restart는 허용, relay stop·start, bridge·broker·watchdog·ssh restart는
  거절이어야 한다. 어긋나면 실패하고 timer를 켜지 않는다. 마지막 줄이 `TOMVERSE_DM_RELAY_AUTORESTART_INSTALLED`이면 끝이다.
- 바꾸는 것: 시스템 계정 하나, 실행 파일과 unit 둘, polkit 규칙 하나, timer 활성화.

확인(읽기 전용):

```bash
systemctl list-timers tomverse-dm-relay-autorestart.timer --no-pager
journalctl -u tomverse-dm-relay-autorestart.service -n 10 --no-pager -o short-iso
```

끄기: `sudo systemctl disable --now tomverse-dm-relay-autorestart.timer`. 다시 켤 때는 `enable --now`.

제거:

```bash
sudo systemctl disable --now tomverse-dm-relay-autorestart.timer
sudo rm -f /etc/systemd/system/tomverse-dm-relay-autorestart.service /etc/systemd/system/tomverse-dm-relay-autorestart.timer /usr/local/libexec/tomverse-dm-relay-autorestart /etc/polkit-1/rules.d/50-tomverse-dm-relay-autorestart.rules
sudo systemctl daemon-reload
sudo userdel tomverse-dm-relay-autorestart
```
