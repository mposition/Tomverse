# AMUX Decision Maker S0: 계정 격리 실측

`docs/policy/amux-decision-maker.md` §12의 S0 가운데 **양방향 계정 격리 실측**을 하는 순서다. 정책 §5의 표와
오케스트레이션 정책 버전 27 §6이 요구하는 것을 그대로 잰다. S2는 이 실측 증거 없이는 시작하지 않는다.
이 문서와 스크립트는 정책을 바꾸지 않는다.

유료 turn은 없다. 두 공급사 모델의 가용성, 구조화 출력, 강제 종료, 재시도 형태처럼 유료 turn이 필요한 S0
항목은 보낼 내용을 운영자에게 먼저 보인 뒤 따로 한다.

## 운영자가 먼저 하는 것

worker 계정 `tommy`에는 sudo가 없다. 아래는 관리자 계정에서 운영자가 한다.

1. 계정 셋을 만든다.
   - broker 하나. 예: `amux-dm-broker`.
   - 공급사마다 DM 계정 하나. 예: `amux-dm-openai`, `amux-dm-anthropic`.
   - 다섯 주체(worker, bridge, broker, 두 DM 계정)는 서로 다른 UID다. worker와 bridge는 어느 DM 계정의
     그룹에도 들지 않는다.
2. 요청 디렉터리 상위(예: `/var/lib/amux-dm/requests`)를 broker 소유로 만든다.
   - broker는 두 DM 계정 그룹에 모두 들어 있어야 각 요청 디렉터리의 그룹을 그 공급사로 정할 수 있다.
   - 요청 디렉터리는 `0750`, 그 안의 파일은 `0640`이다(정책 §5).
3. 각 DM 계정 홈에 자기 공급사 CLI 하나만 설치하고, 그 계정으로 로그인한다.
   - `amux-dm-openai`에는 `codex`, `amux-dm-anthropic`에는 `claude`.
   - DM 계정과 broker에는 다음을 두지 않는다: GitHub 로그인, git credential helper, SSH 키, 다른 공급사·Cursor·Copilot
     로그인, 제품 DB·배포 자격증명, bridge 환경 파일.
4. 네트워크를 계정별로 막는다.
   - DM 계정은 자기 공급사 host로만 나간다.
   - broker는 GitHub 공개 host(`api.github.com`, `raw.githubusercontent.com`)로만 나간다.
   - 방식(UID별 방화벽 규칙 등)은 운영자가 고른다. 스크립트는 결과만 잰다.
5. DM 계정과 broker의 홈은 다른 계정이 읽을 수 없게 둔다. worker의 홈, clone, `~/.amux`도 마찬가지다.

## 실행

호스트에서, 관리자 계정의 bash로, 저장소 clone 안에서 실행한다. root 권한이 필요하다.
- 계정을 하나씩 바꿔 가며 시도하려고 `runuser`와 `setpriv`를 쓰기 때문이다.
- 자격증명은 필요 없다. 유료 호출도 없다.

```bash
cp scripts/amux-decision-maker-s0/isolation.conf.example /root/amux-dm-s0.conf
```

`/root/amux-dm-s0.conf`의 계정 이름, 경로, host를 이 호스트에 맞게 고친다.
- bridge 계정은 `systemctl show tomverse-bridge.service -p User`로 확인한다.
- bridge 환경 파일은 `-p EnvironmentFiles`로 확인한다.

설정 파일은 실행되지 않고 해석만 된다. 다음이 하나라도 있으면 아무것도 시도하지 않고 종료 코드 64로 끝난다:
- 목록에 없는 key나 중복 key
- 절대 경로가 아닌 경로나 `..`가 든 경로
- `host:port`가 아닌 항목

```bash
sudo bash scripts/amux-decision-maker-s0/measure-isolation /root/amux-dm-s0.conf > amux-dm-s0-isolation.json
```

### 호스트에 하는 일

다음은 모든 종료 경로에서 되돌린다.
- 공급사마다 probe 요청 디렉터리 하나를 `REQUEST_ROOT` 아래에 broker로 만들고 broker로 지운다. broker가 못 지우면
  root가 지운다. 이름은 `amux-dm-s0-<시각>-<pid>-<공급사>`다.
- broker와 두 DM 계정으로 `sleep` 프로세스를 하나씩 띄웠다가 끝에 죽인다. DM 프로세스 대신 worker가 읽거나
  ptrace할 수 있는지 재는 대상이다.

되돌릴 것이 없는 일도 한다.
- 각 계정과 root로 설정된 host에 TCP 연결을 연다.
- 각 계정의 CLI에 `--version`만 묻는다.
- 보호 경로(worker 홈, clone, `~/.amux`, bridge 환경 파일, 다른 DM 계정 홈)를 계정마다 세 가지로 잰다:
  - 목록 조회
  - 디렉터리 안으로 들어가기
  - root가 찾은 안쪽 파일 최대 다섯 개의 첫 바이트 읽기

  목록만 막히고 들어갈 수 있는 디렉터리(`0711` 등)는 이름을 아는 파일을 다 열어 주기 때문이다. 읽은 바이트는 버리고,
  파일은 번호로만 보고하며 이름은 남기지 않는다.
- root가 각 계정의 sudo 권한을 `sudo -l -U`로 조회한다. 계정 자신은 sudo를 실행하지 않으므로 auth log에 시도로
  남지 않는다.
- root가 DM 계정과 broker 홈의 자격증명 파일이 **있는지만** 본다. 내용은 읽지 않는다.
- git credential helper는 그 계정으로 `git config --includes --get-regexp`를 실행해 Git이 실제로 읽는 설정에서
  찾는다. 시스템 설정과 include된 파일도 포함한다.
  - 조건부 include(`includeIf "gitdir:..."`, `onbranch:` 등)는 그 저장소 안에서만 읽힌다. 그래서 여기서는 비어 보여도
    스냅샷 clone 안에서는 helper를 켤 수 있다. 하나라도 있으면 `unverifiable`이고 누출로 센다.
  - helper를 실행하지 않고 값을 출력하지 않는다.

### 결과 읽기

출력은 JSON 하나다. 비밀값, 파일 내용, 환경 변수는 들어가지 않는다. 증거로 묶을 수 있게 다음을 담는다:
- 스크립트의 SHA-256(`scriptSha256`)
- 설정 파일의 SHA-256(`configSha256`)

| 종료 코드 | `verdict` | 뜻 |
|---|---|---|
| 0 | `isolated` | 모든 control이 성공했고 모든 격리 검사가 막혔다 |
| 1 | `not_isolated` | control은 모두 성공했고, 격리 검사 중 하나 이상이 뚫렸다. `checks`에서 `pass: false`인 항목이 무엇이 새는지 말한다 |
| 2 | `incomplete` | 판정할 수 없다. `summary.reasons`가 이유다(계정·도구 없음, control 실패) |
| 64 | — | 설정 거부. 아무것도 시도하지 않았다 |
| 77 | — | root가 아님. 아무것도 시도하지 않았다 |

**control 실패가 있으면 `isolated`가 나오지 않는다.** 예를 들어 DM 계정이 자기 공급사 host에 닿지 못하는 호스트에서는
모든 연결이 막히므로 격리처럼 보이지만, 그 거부는 아무것도 증명하지 않는다.

그래서 거부를 보는 대상마다 그 대상이 실재한다는 control을 먼저 둔다.

| 대상 | control |
|---|---|
| 보호 경로, bridge 환경 파일, 요청 상위 디렉터리, 각 홈 | root가 보기에 존재한다 |
| 설정된 모든 host | root에서 연결된다 |
| DM 프로세스 읽기와 ptrace 검사 | root로는 된다 |

설정의 오타, DNS 실패, 동작하지 않는 검사는 이 control에서 걸려 `incomplete`가 된다.

`observations`는 판정하지 않고 기록만 한다.
- worker가 DM 프로세스의 command line을 읽을 수 있는지. `/proc`의 `hidepid`만 이것을 숨긴다.
- `kernel.yama.ptrace_scope` 값.
- `/proc`의 `hidepid` 설정.

## 증거로 남기기

1. `isolated`가 나온 JSON을 S0 기록에 첨부한다. 함께 적을 것:
   - 실행한 commit SHA. `scriptSha256`이 그 commit의 스크립트와 같은지 대조한다.
   - 호스트 이름.
   - 계정을 만든 방식과 네트워크를 막은 방식.
2. `not_isolated`나 `incomplete`면 고친 뒤 다시 잰다. 지난 결과는 지우지 않고 함께 남긴다.

이 실측은 정책 §12 S2 선행 조건 가운데 "S0의 양방향 계정 격리 실측 증거" 하나다. 다른 S0 항목과 S2 서버 반영은
따로다:
- 전용 launcher의 고정 argv, 설정 digest, 명령 실행을 끄는 모드
- 유료 turn이 필요한 항목
- 처리위탁 조건 검토
