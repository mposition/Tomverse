# auto-rec agent runner

Auto router optimizer가 cycle마다 쌓는 `code` 권장안(예: "answer 호출 실패 시 같은 크레딧
대체 모델로 재시도")을 **한 시간에 하나씩** 받아, Claude Code headless로 구현하고 테스트와
독립 검토를 거쳐 **develop으로 가는 draft PR**을 여는 Ubuntu 서버 도구입니다.

### 일일 제품 개선 모드 (2026-11-13 운영자 요청)

로컬 PC/Codex 자동화와 별개로 Ubuntu의 systemd가 매일 **09:00 Australia/Brisbane**에 실행합니다.
`install.sh <검토된 commit SHA> daily-product`가 기존 runner/timer에 이 모드를 설치합니다.
설치 자체는 타이머를 켜거나 실행하지 않습니다. 기존 시간별 모드가 기본값으로 유지됩니다.

- 제품 리서치 → 라우팅 code 권장안 → 제품 리서치 안의 `memory.continuation.*` 합성 품질 권장안을
  한 건씩 순환합니다. 각 원천 안에서는 오래된 열린 항목부터 처리합니다. 라우팅은 기존 Admin의
  코딩 에이전트 스위치를 존중합니다. 설정 변경이나 Refiner 후보 승격은 하지 않습니다.
- 앱의 `DAILY_PRODUCT_AGENT_ENABLED=true`와 gateway의 root 소유 daily-product 모드가 모두
  있어야 확장 원천을 claim합니다. 공유 비밀과 GitHub 토큰은 기존 gateway 계정에만 남고,
  runner는 제품 DB 자격증명이나 관리자 브라우저 세션을 쓰지 않습니다.
  일일 모드는 `/api/internal/product-improvements/claim`과 `/result`만 사용합니다. 이전 앱의
  404나 스위치 꺼짐에서 기존 라우팅 API로 우회하지 않습니다.
- 최대 하루 24건(실패·무변경 포함), 새 작업 진입은 회차 시작 후 18시간, systemd 전체는 23시간입니다. 마지막 작업과 정리에 5시간을 남깁니다. 앱도 AEST 날짜의
  claim 상한을 직렬화해 강제하므로 같은 날 다시 시작해도 상한을 늘리지 않습니다. 게시 상한은
  기존의 24시간 24건 그대로입니다. 추가 API 모델 호출이나 유료 평가를 켜지 않습니다.
- 작업마다 최신 develop에서 독립 worktree/브랜치를 만듭니다. 이미 해결됐으면 근거를 로그에
  남기고 `no_change`, 막히면 사유 코드를 기록하고 다음 작업으로 갑니다. 관련 테스트·lint와
  기존 독립 검토를 통과한 변경만 게시합니다. 새 PR은 항상 **develop · draft · ci:hold**이며
  gateway가 라벨을 다시 읽어 확인해야 게시 성공입니다. 병합·배포·CI 보류 해제는 하지 않습니다.
- Scout의 claim·결과는 `AppSetting`의 `auto.dailyProductAgent.*` 행과 트랜잭션 감사에 남습니다.
  원래 카드에서 작업 중/PR 링크/실패 사유/결과 확인 필요를 읽을 수 있습니다. 원문 제안은 PR에
  복사하지 않습니다. PR 작성만으로 원래 제안을 완료 처리하지 않습니다.
- 만료·실패·손상된 claim도 자동으로 다시 가져오지 않습니다. publish/result 불명은 회차를
  중단하고 사람의 lookup을 기다립니다. 과제 자체의 무변경·범위·검증·검토 거절은 다음 항목으로
  넘어가지만 인증·설치·timeout·검토 불명·게시 장애는 첫 건을 기록하고 그날 회차를 멈춥니다.
  게시를 시도하기 전의 실패가 확실한 항목은 최근 재인증한 owner가 카드의 Retry coding agent로
  재예약하거나 기존 Send to AMUX로 넘길 수 있습니다. 재예약에도 일일 상한이 적용되고 새
  claimId를 발급합니다. 활성/만료 claim, 게시·검토 불명은 이 재예약 경로로 풀지 않습니다. AMUX로 보낸
  제안과 전달 예약도 제외하며, 같은 잠금으로 claim과 전달 예약의 중복 소유를 막습니다.
  AMUX 전달이 실패하거나 불명이면 예약을 보존하고, 같은 Send to AMUX를 다시 사용해 기존의
  결정적 request id로 결과를 읽어 마칩니다. 예약을 자동 삭제하거나 에이전트가 인수하지 않습니다.

### 일일 회차 중단 알림

운영자 2026-11-14 요청: 회차가 장애로 멈추면 기존 운영 알림 경로로 알립니다.
앱의 `DAILY_PRODUCT_AGENT_ALERTS_ENABLED=true`를 별도로 운영 활성화한 뒤 사용합니다.
배포 순서는 앱의 새 API 반영 → 알림 스위치 활성화 → Ubuntu 프로그램 갱신입니다. 구버전 앱에
새 서버를 먼저 연결하면 알림을 받을 수 없습니다.
runner는 한 회차의 중단을 gateway에 한 번만 보고하고, gateway는 기존 앱 공유 비밀로
`/api/internal/product-improvements/halt`에 닫힌 사유 코드·시도 수·확인된 PR 수·마지막 PR 링크만
보냅니다. 작업문·모델 출력·stderr·자격증명·임의 수신자·임의 URL은 받지 않습니다.

앱은 회차 id별로 Admin 알림과 감사를 먼저 함께 저장하고, 새 알림만 기존 운영 이메일·설정된
채팅 채널로 전달합니다. 같은 회차는 다시 발송하지 않고 새 회차 알림도 AEST 하루 24건 이하입니다.
Admin 알림 화면에서 확인하면 종 표시·미확인 건수·개요·대기 목록에서 함께 해제됩니다.
알림 전달의 응답이 없어도 재전송하거나 원래 작업을 재제출하지 않습니다. `no_change`·검증 거절 등
다음 작업으로 진행하는 결과와 정상적인 빈 대기열·일일 한도 도달은 중단 알림을 만들지 않습니다.
앱이나 gateway에 닿지 못하면 알림도 전달할 수 없고 로그에 남습니다. 호스트 강제 종료·부팅 실패는
이 runner 자체의 보고 경로 밖이며 별도의 호스트 감시가 필요합니다.

**운영 반영 순서 — Ubuntu 서버, sudo 가능한 관리자 계정의 bash, 임의 디렉터리.**
먼저 이 변경을 담은 앱 버전을 운영에 배포하고 앱의 `DAILY_PRODUCT_AGENT_ENABLED=true`를
설정해야 합니다. 이는 일일 에이전트 구현 PR 생성과 별도의 운영 배포 단계입니다. 기존
`AUTO_ROUTER_REC_AGENT_SECRET`과 gateway의 공유 비밀이 일치해야 합니다. 값은 출력하지 않습니다.
이미 설정된 root 전용 env, `autorec` Claude 구독 인증, mirror, 검토 서버 접속을 재사용합니다.

```bash
# SHA is the reviewed, immutable commit containing this implementation.
SHA=<reviewed-40-character-commit>
curl -fsSL "https://raw.githubusercontent.com/mposition/Tomverse/$SHA/tools/auto-rec-agent/deploy/install.sh" -o /tmp/autorec-install.sh
sudo bash /tmp/autorec-install.sh "$SHA" daily-product
sudo systemctl enable --now autorec-gateway.socket autorec-runner.timer
systemctl list-timers autorec-runner.timer --no-pager
# Optional first run, after the app and credentials are ready:
sudo systemctl start --no-block autorec-runner.service
journalctl -u autorec-runner.service -n 40 --no-pager
```

PC가 꺼져 있어도 Ubuntu 서버가 켜져 있으면 실행합니다. 첫 실행 완료의 증거는 timer 설치가
아니라 실제 claim→검증→draft/hold PR→앱 결과 기록입니다. 꺼진 서버의 회차는 `Persistent=true`로
다음 기동 때 한 번 처리합니다. 현재 회차가 실행 중이면 systemd가 겹쳐 실행하지 않습니다.
정지는 `sudo systemctl disable --now autorec-runner.timer`로 이후 회차만 막습니다. 실행 중인
작업을 강제 종료하면 결과가 불명일 수 있으므로 해당 claim을 확인한 뒤 재시도를 결정합니다.

- 운영자 승인(2026-10-20 채팅, 원문): "네 에이전트가 자율적으로 develop PR 작성하는거 승인합니다."
- **병합은 사람이 합니다.** PR은 draft와 `ci:hold`를 유지하고, merge train(`npm run merge-train`)은
  draft를 병합하지 않습니다. CI 보류 해제와 ready 전환도 운영자가 별도로 결정합니다.
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
4. **범위 검사** — commit된 것만 남기고(`reset --hard`, `clean`), 에이전트의 마지막 tree를 이번
   실행이 fetch한 develop 위의 **commit 하나**로 runner가 다시 만듭니다(`commit-tree`). push는 실린
   commit을 모두 공개하므로, 중간 commit에 넣었다 지운 내용이 이력에 남지 않게 하려는 것입니다. 그
   commit의 바뀐 경로를 검사합니다. 아래 "범위"를 벗어나면 `out_of_scope`, 바뀐 것이 없으면 `no_change`.
5. **테스트** — 바뀐 테스트 파일과, 바뀐 모듈을 import하는 `tests/*.test.*`·
   `tests/server-contract/`·`tests/client/` 파일을 저장소의 runner와 같은 플래그로 돌리고, 바뀐
   소스 파일에 eslint(`--max-warnings=0`)를 돌립니다. 관련 테스트가 하나도 없거나 실패하면 `tests`.
6. **독립 검토** — 검토 서버(`tools/review-orchestrator`)에 `submit --author claude --base <develop
   commit>` 후 `wait`. accept이고 job의 head가 이 commit, base가 이번 실행의 develop commit, focus가
   없을 때만 다음으로 갑니다. 검토 client는 worktree의 로컬 ref로도 base를 고르는데 그 ref는
   에이전트 코드가 옮길 수 있으므로, 검토 범위를 job 결과로 확인합니다. reject는 `review_reject`,
   그 밖은 `review_unknown`이며 다시 보내지 않습니다.
7. **publish** — gateway는 자기가 fetch한 develop과의 fork point 위 commit 하나인지 다시 확인하고
   (아니면 `runner_error`), 브랜치를 push한 직후 draft PR을 직접 열고 즉시 `ci:hold`를 붙입니다.
   Auto PR to Develop이 먼저 열었으면 해당 draft를 쓰며, 생성 요청이 겹치거나 응답이 없으면
   한 번 조회합니다. 기존 PR의 제목·본문 수정 전에도 먼저 보류 라벨을 확인합니다. 마지막으로
   draft·보류 라벨·검토한 head를 함께 확인하며, 하나라도 달라지면 게시 결과 불명으로 멈춥니다.
8. **result** — `POST /api/internal/auto-router/recommendations/result`로
   `{id, outcome: "pr_opened", prUrl}` 또는 `{id, outcome: "failed", reason}`을 보냅니다.
9. worktree와 로컬 브랜치를 지웁니다.

## 계정과 비밀의 경계

| 주체 | 무엇을 하나 | 가진 것 |
|---|---|---|
| `autorec` (runner, `autorec-runner.service`) | worktree, Claude Code, 테스트, 검토 요청 | Claude 로그인, 검토 서버용 SSH key. **앱 공유 비밀과 GitHub 토큰은 없음** |
| `autorec-gw` (gateway, 설치 script가 만드는 시스템 계정, `autorec-gateway@.service`) | claim, result, push, PR | `/etc/autorec/autorec.env`의 세 값 |

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
설치 script가 설치 폴더에 넣는 npm 10(`/usr/local/lib/autorec-agent/npm/bin/npm`, CI와 같은 버전대 —
Ubuntu의 npm 9는 이 저장소의 lockfile을 거부합니다), 검토 클라이언트와 그 ssh는 설치 폴더의 root 소유 복사본(`deploy/review-ssh`)과 root
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

Node 22.14 이상 또는 23.7 이상(`--disable-sigusr1`)과 git이 필요합니다(`/usr/bin/node --version`). TypeScript
지원은 필요 없습니다. Ubuntu의 `nodejs` 패키지는 TypeScript를 실행하지 못하므로, runner는 소유권 manifest의 JS
사본(`lib/agentAuthorityFiles.generated.mjs`, `npm run generate:auto-rec-authority`로 생성)을 읽습니다.
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
| `AUTOREC_APP_SECRET` | 앱의 recommendation route가 검사하는 공유 비밀(**32자 이상**, 짧으면 앱이 모든 요청을 404로 답합니다). 앱 쪽 Railway 웹 서비스의 `AUTO_ROUTER_REC_AGENT_SECRET`에 같은 값을 넣습니다 |
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
`systemctl start autorec-runner.service`로 실행했는지, gateway가 `systemctl show`를 부를 수 있는지 —
gateway를 systemd `DynamicUser`로 돌리면 시스템 D-Bus가 연결을 끊어 늘 이 코드가 납니다),
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
| `bin/autorec-gateway.mjs` | 비밀을 가진 gateway(`autorec-gw` 계정) |
| `lib/core.mjs` | 범위 검사, 관련 테스트 선택, 지시문, 결과 본문 등 순수 함수 |
| `lib/contract.mjs` | 앱 API, 저장소, 브랜치, 경로, 상한 상수 |
| `deploy/` | systemd unit 넷, env 견본, 검토용 ssh wrapper와 설정, `install.sh` |

테스트: `node --conditions=react-server --import tsx --test tests/agentAutoRec*.test.mjs`.
