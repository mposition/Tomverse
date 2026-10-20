# auto-rec agent runner

Auto router optimizer가 cycle마다 쌓는 `code` 권장안(예: "answer 호출 실패 시 같은 크레딧
대체 모델로 재시도")을 **한 시간에 하나씩** 받아, Claude Code headless로 구현하고 테스트와
독립 검토를 거쳐 **develop으로 가는 draft PR**을 여는 Ubuntu 서버 도구입니다.

- 운영자 승인(2026-10-20 채팅, 원문): "네 에이전트가 자율적으로 develop PR 작성하는거 승인합니다."
- **병합은 사람이 합니다.** PR은 draft로 남아 CI가 돌지 않고, merge train(`npm run merge-train`)은
  draft를 병합하지 않습니다. 사람이 `gh pr ready <번호>`로 바꿀 때 CI가 시작합니다.
- 권한 범위: develop PR만 엽니다. 병합·auto-merge·main PR·force push·브랜치 삭제는 하지 않습니다.
  GitHub 토큰은 이 저장소 하나의 Contents·Pull requests 쓰기뿐입니다.
- **결과를 모르면 다시 하지 않습니다.** push나 결과 보고의 성공 여부를 모르면 로그에 남기고
  끝냅니다. 앱은 lease가 끝난 권장안을 `needs_lookup`으로 둡니다.

## 한 번의 실행

1. **claim** — gateway가 앱의 `POST /api/internal/auto-router/recommendations/claim`을
   부릅니다. 204면 할 일이 없으므로 종료합니다.
2. **worktree** — `autorec`의 mirror에서 develop을 받고
   `claude/to-develop/auto-rec-<id 요약>-<hash>` 브랜치로 새 worktree를 만듭니다.
   `node_modules`는 mirror의 것을 symlink로 씁니다(lockfile이나 Prisma schema가 바뀌었을 때만
   `npm ci`).
3. **에이전트** — `~/.local/bin/claude -p`. 지시문은 고정 머리말(`lib/core.mjs`의
   `INSTRUCTION_PREAMBLE`: AGENTS.md를 따른다, 작고 테스트된 변경만, 정책·게이트·권한·workflow
   파일 금지, 비밀값 금지, 공개 저장소이므로 사용자 내용 복사 금지, 끝나면 commit) 뒤에 권장안의
   `instruction`을 붙입니다. 권한은 `--permission-mode dontAsk`에 읽기·편집 도구와 git·node 테스트·
   tsc·eslint 명령만 허용하고, MCP는 싣지 않습니다(`--strict-mcp-config`). 30분을 넘기면 `timeout`.
4. **범위 검사** — commit된 것만 남기고(`reset --hard`, `clean`), 바뀐 경로를 검사합니다. 아래
   "범위"를 벗어나면 `out_of_scope`, 바뀐 것이 없으면 `no_change`.
5. **테스트** — 바뀐 테스트 파일과, 바뀐 모듈을 import하는 `tests/*.test.*`·
   `tests/server-contract/`·`tests/client/` 파일을 저장소의 runner와 같은 플래그로 돌리고, 바뀐
   소스 파일에 eslint(`--max-warnings=0`)를 돌립니다. 관련 테스트가 하나도 없거나 실패하면 `tests`.
6. **독립 검토** — 검토 서버(`tools/review-orchestrator`)에 `submit --author claude` 후 `wait`.
   accept이고 검토한 head가 이 commit일 때만 다음으로 갑니다. reject는 `review_reject`, 그 밖은
   `review_unknown`이며 다시 보내지 않습니다.
7. **publish** — gateway가 브랜치를 push하고, Auto PR to Develop이 여는 draft PR을 최대 5분
   기다렸다가 제목과 본문(권장안, cycle 링크, 검토 job id, "자동 생성, 병합은 사람")을 바꿉니다.
   5분 안에 열리지 않으면 gateway가 draft로 직접 엽니다.
8. **result** — `POST /api/internal/auto-router/recommendations/result`로
   `{id, outcome: "pr_opened", prUrl}` 또는 `{id, outcome: "failed", reason}`을 보냅니다.
9. worktree와 로컬 브랜치를 지웁니다.

## 계정과 비밀의 경계

| 주체 | 무엇을 하나 | 가진 것 |
|---|---|---|
| `autorec` (runner, `autorec-runner.service`) | worktree, Claude Code, 테스트, 검토 요청 | Claude 로그인, 검토 서버용 SSH key. **앱 공유 비밀과 GitHub 토큰은 없음** |
| `autorec-gw` (gateway, systemd `DynamicUser`, `autorec-gateway@.service`) | claim, result, push, PR | `/etc/autorec/autorec.env`의 세 값 |

`autorec`은 에이전트가 쓴 코드(테스트)를 실행합니다. 같은 uid의 프로세스는 서로의
`/proc/<pid>/environ`을 읽을 수 있으므로, 비밀은 다른 uid인 gateway에만 둡니다(검토 서버의
`review-status-sender`와 같은 분리).

**gateway는 runner 본체에만 답합니다.** 소켓은 `autorec`만 열 수 있지만, 에이전트와 그 테스트가
띄운 프로세스도 `autorec`입니다. 그래서 gateway는 연결한 PID(systemd가 `Accept=yes` 인스턴스
이름에 넣어 주는 값)가 `autorec-runner.service`의 MainPID일 때만 claim·result·publish를 처리하고,
그 밖에는 `peer_not_runner`로 거절합니다. 자식 프로세스가 runner에 ptrace로 붙지 못하도록
`kernel.yama.ptrace_scope`가 1 이상이어야 하며(Ubuntu 기본값 1), 아니면 `ptrace_scope_unsafe`로
아무것도 하지 않습니다. 같은 uid의 코드가 SIGUSR1로 runner의 Node inspector를 열어 그 안에서 코드를
실행하는 길도 막습니다: runner unit은 `node --disable-sigusr1`로 시작하고, runner는 그 플래그 없이
시작되면 실행을 거부하며(`runner_refused`), gateway도 runner의 `/proc/<pid>/cmdline`에서 그 플래그를
확인합니다(`peer_inspector_signal`). 그래서 에이전트가 쓴 코드는 권장안을 가로채거나, 결과를
위조하거나, 검토 없이 publish할 수 없습니다.

**runner가 믿는 도구는 `autorec`이 바꿀 수 없는 경로에 있습니다.** `git`은 `/usr/bin/git`, `npm`은
`/usr/bin/npm`, 검토 클라이언트와 그 ssh는 설치 폴더의 root 소유 복사본(`deploy/review-ssh`)과 root
소유 설정(`/etc/autorec-ssh/config`, host key 고정)입니다. `~/.local/bin`이나 `~/.ssh/config`에 가짜
`ssh`를 두어 검토 서버 대신 "accept"를 답하게 할 수 없습니다.

gateway는 runner가 무엇을 보내든 스스로 지킵니다.

- 브랜치는 그 권장안 id에서 나온 `claude/to-develop/auto-rec-*` 하나뿐이고, push는 **새 브랜치
  생성만** 합니다(`--force-with-lease=<ref>:`). 기존 브랜치를 덮거나 지우지 않습니다.
- 바뀐 경로를 **자기가 GitHub에서 받은 develop 기준으로** 다시 검사합니다.
- 24시간에 publish는 최대 24번(타이머가 요청할 수 있는 최대)입니다.
- 앱 결과는 계약의 필드(`id`, `outcome`, `prUrl` 또는 사유 코드)만 보냅니다. 자유 문장은 없습니다.
- 토큰은 git의 argv가 아니라 환경으로만 넘깁니다(argv는 다른 계정도 `/proc`에서 읽습니다).
- gateway와 runner 코드는 root 소유 경로(`/usr/local/lib/autorec-agent/`)에서 실행됩니다.
  `autorec`의 mirror에서 복사하지 않습니다.

**남는 위험(알고 받아들이는 것).**
- 에이전트가 쓴 코드는 실행 중인 runner를 종료시킬 수 있습니다(같은 uid의 signal). 그러면 그
  권장안은 결과 없이 lease가 끝나 `needs_lookup`이 됩니다.
- Claude 구독 로그인과 검토 서버용 SSH key(`~/.ssh/review_orch`)는 `autorec` 계정에서 읽힙니다(검토
  서버의 reviewer 계정과 같은 조건). 그 key는 forced command라 검토 요청 말고는 할 수 없지만, 검토
  할당량을 쓸 수는 있습니다. 그 계정에는 다른 로그인, 다른 SSH key, 제품 DB·배포 자격증명을 두지
  않습니다.
- 브랜치 push는 Auto PR to Develop workflow를 실행합니다. 그 workflow가 실행하는 저장소 파일
  (`scripts/**`, `.github/**`)은 범위 검사가 막습니다.

## 범위

`lib/agentAuthorityFiles.ts`(엔지니어링 에이전트와 같은 소유권 manifest)가 `product`로 분류하는
경로만 바꿀 수 있습니다. 거기에 운영자가 승인 때 이름을 든 경로는 manifest와 별도로도 막습니다:
`.github/workflows/**`, `AGENTS.md`, `docs/policy/**`, `scripts/*policy*`, `prisma/migrations/**`,
`lib/adminAuditSystemActors.ts`, `tools/auto-rec-agent/**`. symlink와 submodule 변경도 거절합니다.
그래서 루트 파일(`package.json`, `CLAUDE.md`), `.claude/`, `scripts/`, `tools/`, `prisma/`, 가격 파일
(`lib/modelPricing.ts`, `lib/models.ts`), `app/api/internal/**`도 바꿀 수 없습니다.

## 운영자 순서

계정 `autorec`(비권한, sudo 없음, 셸 `/bin/bash`, 비밀번호 잠금, 접근은 `sudo -iu autorec`)은 이미
있다고 봅니다. 그 계정에 Claude Code가 공식 native installer로 설치돼 있어야 합니다
(`~/.local/bin/claude`).

**아래는 모두 Ubuntu 서버(AMUX runner 호스트)의 관리자 계정 bash에서 합니다. 폴더는 상관없습니다.**
production 앱 자격증명은 필요 없습니다. 앱의 공유 비밀과 GitHub 토큰만 다룹니다.

### 1. GitHub 토큰 발급 (브라우저, github.com)

Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token.

- Resource owner: `mposition`
- Repository access: **Only select repositories** → `Tomverse`
- Repository permissions: **Contents: Read and write**, **Pull requests: Read and write**
  (Metadata: Read-only는 자동). **Workflows 권한은 주지 않습니다** — 없으면 GitHub이
  `.github/workflows` 변경 push를 거절합니다. 그 밖의 권한은 모두 No access.
- 만료일은 운영자가 정합니다. 만료되면 publish가 `push_failed`가 됩니다.

토큰은 아래 3단계의 파일에만 넣습니다. `autorec` 계정, mirror의 URL, 대화, 문서에 넣지 않습니다.

### 2. 설치

Node 22.14 이상 또는 23.7 이상(`--disable-sigusr1`과 타입 제거)과 git이 필요합니다(`/usr/bin/node --version`).
설치 script는 공개 저장소를
root 소유 임시 폴더에 받아 코드와 unit을 복사하고, 빈 env 파일을 만들 뿐 아무것도 켜지 않습니다.
다시 실행해도 됩니다(업데이트도 같은 명령입니다).

```bash
curl -fsSL -o /tmp/autorec-install.sh https://raw.githubusercontent.com/mposition/Tomverse/develop/tools/auto-rec-agent/deploy/install.sh
sudo bash /tmp/autorec-install.sh develop
```

마지막 줄에 설치한 commit이 나옵니다(`/usr/local/lib/autorec-agent/INSTALLED_FROM`에도 남습니다).

### 3. 비밀 파일

```bash
sudo nano /etc/autorec/autorec.env
sudo stat -c '%U:%G %a %n' /etc/autorec /etc/autorec/autorec.env   # root:root 700, root:root 600
```

| 변수 | 값 |
|---|---|
| `AUTOREC_APP_URL` | 앱 origin, https, 경로 없음(예: `https://tomverse.app`) |
| `AUTOREC_APP_SECRET` | 앱의 recommendation route가 검사하는 공유 비밀(16자 이상). 앱 쪽 Railway 변수에 같은 값을 넣습니다 |
| `AUTOREC_GITHUB_TOKEN` | 1단계의 토큰 |

공유 비밀은 `openssl rand -hex 32`로 만들 수 있습니다. 값은 파일과 Railway 대시보드에만 붙이고
대화나 문서에 옮기지 않습니다. 파일을 고친 뒤 재시작할 것은 없습니다(gateway는 요청마다 새로
시작합니다).

### 4. mirror clone (토큰 없이)

```bash
sudo -iu autorec git clone https://github.com/mposition/Tomverse.git /home/autorec/mirror/Tomverse
```

저장소가 공개라 자격증명 없이 받습니다. URL에 토큰을 넣지 않습니다. runner는 origin URL에 `@`가
있으면 `setup_failed`로 멈춥니다. 첫 실행 때 runner가 mirror에서 `npm ci`를 합니다(수 분).

### 5. Claude 로그인 (`autorec` 계정)

```bash
sudo -iu autorec /home/autorec/.local/bin/claude
```

`/login`으로 구독 계정에 로그인하고 나옵니다. SSH 터미널에 붙여 넣기가 안 되면 브라우저가 있는
PC에서 `claude setup-token`으로 토큰을 만들어 root만 읽는 파일에 둡니다. runner unit이 이 파일을
있으면 읽어 Claude에만 넘깁니다.

```bash
sudo sh -c 'umask 077; nano /etc/autorec/claude.env'   # CLAUDE_CODE_OAUTH_TOKEN=...
```

### 6. 검토 서버 접근 (`autorec` → `review`)

`autorec`이 같은 서버의 검토 서버에 `tools/review-orchestrator/README.md`의 Windows PC와 같은
방식(forced command SSH)으로 요청합니다. 클라이언트는 설치 폴더의 root 소유 복사본
(`/usr/local/lib/autorec-agent/tools/review-orchestrator/client/review.mjs`)이고, ssh 설정은 설치
script가 만든 root 소유 `/etc/autorec-ssh/config`(호스트 `review-orch` → `review@127.0.0.1`)와
`/etc/autorec-ssh/known_hosts`(이 서버 sshd의 ed25519 key)입니다. `~/.ssh/config`는 쓰지 않습니다.
검토 대상은 그 commit뿐입니다.

```bash
sudo -iu autorec sh -c 'install -d -m 700 ~/.ssh && ssh-keygen -t ed25519 -N "" -C autorec -f ~/.ssh/review_orch'
sudo cat /home/autorec/.ssh/review_orch.pub
```

검토 서버 계정의 `~review/.ssh/authorized_keys`에 있는 기존 `command="..."` 줄을 복사해 새 줄로
붙이고, 끝의 키만 위 공개 키로 바꿉니다(forced command와 `no-port-forwarding` 등 옵션은 그대로).
확인:

```bash
sudo -u autorec /usr/local/lib/autorec-agent/tools/auto-rec-agent/deploy/review-ssh review-orch   # rpc_missing JSON이 나오면 정상
```

`Host key verification failed`이면 `/etc/autorec-ssh/known_hosts`가 비어 있거나 sshd가 22번이 아닌
것입니다. `sudo sh -c 'ssh-keyscan -t ed25519 127.0.0.1 > /etc/autorec-ssh/known_hosts'`로 다시
만듭니다(포트가 다르면 `/etc/autorec-ssh/config`의 `Port`도 함께 고칩니다. 설치 script를 다시
실행하면 config는 저장소 것으로 돌아갑니다).

`sysctl kernel.yama.ptrace_scope`가 1 이상인지도 봅니다(설치 script가 0이면 경고합니다).

### 7. 한 번 수동 실행

권장안이 있으면 **실제로 하나를 처리하고 PR을 엽니다**(승인된 동작입니다).

```bash
sudo systemctl start autorec-gateway.socket
sudo systemctl start autorec-runner.service      # 끝날 때까지 기다립니다(최대 몇십 분)
journalctl -u autorec-runner -u 'autorec-gateway@*' --since "1 hour ago" -o cat
```

권장안이 없으면 `no_recommendation` 한 줄로 끝납니다. 첫 publish는 gateway가 develop을 처음
받느라 오래 걸립니다.

### 8. 타이머 켜기

```bash
sudo systemctl enable --now autorec-gateway.socket autorec-runner.timer
systemctl list-timers autorec-runner.timer
```

### 끄기

| 하려는 것 | 명령 |
|---|---|
| 새 실행만 멈춤 | `sudo systemctl disable --now autorec-runner.timer` |
| 진행 중인 실행도 멈춤 | 위에 더해 `sudo systemctl stop autorec-runner.service` (claim한 권장안은 lease가 끝나면 앱에서 `needs_lookup`) |
| 권한 회수 | 위에 더해 `sudo systemctl disable --now autorec-gateway.socket`, GitHub에서 토큰 revoke, `/etc/autorec/autorec.env`의 값 삭제 |

## 실패 사유 코드

앱의 `reason`에는 아래 코드만 갑니다. PR이 생기는 것은 `pr_opened`뿐입니다.

| 코드 | 단계 | 뜻 |
|---|---|---|
| `setup_failed` | 준비 | develop fetch, worktree, `npm ci`, gateway mirror·bundle 처리 실패. mirror URL에 자격증명이 있을 때도 |
| `agent_error` | 에이전트 | Claude Code가 0이 아닌 코드로 끝남 |
| `timeout` | 에이전트 | 30분 초과 |
| `no_change` | 범위 | commit된 변경이 없음(에이전트가 할 수 없다고 판단한 경우 포함) |
| `out_of_scope` | 범위 | 위 "범위" 밖의 경로를 바꿈. runner와 gateway가 각자 검사 |
| `tests` | 테스트 | 관련 테스트가 없거나, 테스트·lint 실패, 15분(lint 5분) 초과 |
| `review_reject` | 검토 | 검토 서버가 reject |
| `review_unknown` | 검토 | unknown, 제출 실패, 60분 안에 판정 없음, 다른 head를 검토함 |
| `lease_expired` | publish 전 | lease가 5분 미만 남아 push하지 않음 |
| `rate_limited` | publish | gateway의 24시간 24회 상한 |
| `push_rejected` | publish | GitHub이 push를 거절(같은 이름의 브랜치가 이미 있음, 보호 규칙 등) |
| `push_failed` | publish | push가 실패했고, 확인해 보니 브랜치가 없음 |
| `pr_failed` | publish | 브랜치는 push됐지만 PR을 찾지도 열지도 못함. 브랜치는 GitHub에 남습니다 |
| `runner_error` | 어디서나(publish 전) | 예상하지 못한 오류 |

**gateway가 요청을 받지 않는 경우**(`claim_failed`의 `code`로 보입니다. 권장안은 claim되지 않았습니다):
`gateway_config_missing`(3단계 값 없음), `peer_not_runner`(요청한 프로세스가 runner 본체가 아님 —
`systemctl start autorec-runner.service`로 실행했는지, gateway가 `systemctl show`를 부를 수 있는지),
`peer_unknown`(systemd가 연결한 쪽의 PID를 주지 못함), `ptrace_scope_unsafe`(위 6단계),
`peer_inspector_signal`(runner unit의 `ExecStart`에 `--disable-sigusr1`이 없음 — 설치 script를 다시
실행해 unit을 바꿉니다).

**보고하지 않는 경우**(종료 코드 1, 로그 `outcome_unknown` 또는 `result_no_answer`): publish 요청에
답이 없거나 gateway가 `unknown`이라고 답한 경우, 결과 보고가 실패한 경우. 앱은 lease가 끝나면
`needs_lookup`으로 둡니다. 운영자는 GitHub에서 `auto-rec-` 브랜치와 PR을, 서버에서 아래 로그를
봅니다.

## 로그

- `journalctl -u autorec-runner`: 이벤트 한 줄씩(코드, id, 개수만).
- `journalctl -u 'autorec-gateway@*'`: 요청마다 op, status, code 한 줄.
- `/home/autorec/logs/<시각>-<id>.log`: 위 이벤트와 에이전트 마지막 출력, 테스트·lint 출력 끝부분.
  30일 지난 파일은 runner가 지웁니다.

## 앱 API 계약

이름과 헤더는 `lib/contract.mjs` 한곳에 있습니다. 앱 쪽 route가 바뀌면 거기만 고칩니다.

- `POST /api/internal/auto-router/recommendations/claim`, `authorization: Bearer <AUTOREC_APP_SECRET>`.
  200 `{id, recommendation, findings, target, instruction, leaseUntil}`(선택: `cycleUrl`), 없으면 204.
- `POST /api/internal/auto-router/recommendations/result`, 같은 헤더.
  `{id, outcome: "pr_opened", prUrl}` 또는 `{id, outcome: "failed", reason}`.

## 파일

| 파일 | 역할 |
|---|---|
| `bin/autorec-runner.mjs` | runner(`autorec`). 외부 호출은 주입 가능한 `deps` |
| `bin/autorec-gateway.mjs` | 비밀을 가진 gateway(`DynamicUser`) |
| `lib/core.mjs` | 범위 검사, 관련 테스트 선택, 지시문, 결과 본문 등 순수 함수 |
| `lib/contract.mjs` | 앱 API, 저장소, 브랜치, 경로, 상한 상수 |
| `deploy/` | systemd unit 넷, env 견본, 검토용 ssh wrapper와 설정, `install.sh` |

테스트: `node --conditions=react-server --import tsx --test tests/agentAutoRec*.test.mjs`.
