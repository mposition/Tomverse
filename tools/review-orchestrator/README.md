# review-orchestrator

작업을 끝낸 앱(Claude Code, Codex, Cursor)이 **자기 이름만 밝히고** 독립 검토를
요청하면, Ubuntu 서버가 작성자와 **모델 공급사가 다른** reviewer를 부하에 따라
골라 실행하는 개발 도구입니다.

- 외부 게시, PR 코멘트, 병합을 하지 않고 앱 DB에 직접 쓰지 않습니다. 사람이 개발
  세션에서 부르는 도구이며, 결과는 서버 디스크에만 남습니다. 앱으로 나가는 것은
  설정했을 때의 **내용 없는 상태 보고 하나**뿐이고, 그것도 daemon이 아니라 별도 계정의
  sender가 보내며, 앱이 그 최신값 한 행을 씁니다(아래 "Agent office 상태 보고").
- 판정은 결정적 코드가 합니다. reviewer의 답은 마지막 ```json 블록 하나로만
  읽고, 형식이 맞지 않으면 `unknown`입니다. blocker·major 지적이 있으면 reviewer가
  accept라고 해도 reject입니다.
- **결과를 모르면 다시 보내지 않습니다.** timeout, 비정상 종료, 파싱 실패, 서버
  재시작은 모두 `unknown`으로 끝나고, 재요청은 사람이 정합니다.

## 배정 규칙

1. 작성자의 모델 공급사와 같은 공급사의 reviewer는 제외합니다. CLI 이름이
   아니라 `vendor`로 판정합니다. Cursor로 Claude 모델을 써서 작업했다면
   `--author cursor --author-vendor anthropic`이고, Claude reviewer는 제외됩니다.
2. `vendor`가 `unknown`이거나 `enabled: false`인 provider는 배정하지 않습니다.
   enabled인데 vendor를 모르면 설정 오류로 서버가 시작하지 않습니다.
   새 배정에는 해당 **서버 계정**의 사용 가능 잔액도 필요합니다. `quotaProbe`가 없거나
   조회가 실패한 계정, 소진된 계정은 대기시키고 이미 시작한 검토는 끝까지 진행합니다.
3. 순서: `priority`(기본 0, 작을수록 먼저) → 진행 중 건수 → 최근 24시간 배정 수 → 가장 오래 쉰
   provider → id. provider마다 동시 실행은 `maxConcurrent`(기본 1)까지이고, 모두 바쁘면 대기합니다.
   막힌 작업이 뒤의 작업을 막지 않습니다. 요청마다 credit을 쓰는 provider(Copilot, 검토 1건 약
   34 credit)는 `priority: 1`로 두어 **예비**로 씁니다 — 다른 공급사가 모두 상한이거나 독립성 규칙으로
   빠질 때만 배정되므로, 배정 수가 적다는 이유로 일을 끌어오지 않습니다(2026-10-03, 첫 50분에
   12건·412 credit을 쓴 뒤 도입).
4. reviewer는 기본 1명입니다. 바뀐 파일이 `contractPaths`에 걸리면 서버가 2명으로
   올리며, 두 명은 반드시 서로 다른 공급사입니다. 집계는 reject 하나라도 있으면
   reject, 그다음 unknown, 모두 accept여야 accept입니다.
5. 운영자가 예외로 특정 검토자를 요청한 경우 `--reviewer <providerId>`로 지정합니다.
   지정은 기본 배정 순서에 우선하지만 독립성·잔액·동시 실행 한도와 계약 검토자 수는
   그대로 적용합니다. 지정된 검토자가 대기하면 다른 검토자로 대체하지 않습니다.

## Windows에서 쓰기

**로컬 PC, 저장소 clone 폴더 안(PowerShell 또는 각 앱의 shell).** SSH key로
서버에 접속할 수 있어야 합니다. 접속 대상은 기본으로 아래의 SSH 별칭 `review-orch`이고,
다른 대상을 쓸 때만 `REVIEW_ORCH_HOST`를 설정합니다(환경변수가 필요 없으므로 앱을 다시
시작할 일도 없습니다).
자격증명은 SSH key뿐이며 production 자격증명은 필요 없습니다. 읽기 전용입니다:
로컬 저장소에는 임시 ref 하나를 만들었다 바로 지웁니다.

처음 한 번은 키와 SSH 별칭을 준비합니다(**로컬 PC의 PowerShell, 아무 폴더**).

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\review_orch -C windows-pc   # 암호 질문에는 Enter만 두 번
ssh-keygen -y -P "" -f $HOME\.ssh\review_orch > $null; "no-passphrase-exit=$LASTEXITCODE"   # 0이어야 합니다
notepad $HOME\.ssh\config   # 아래 블록을 추가
ssh -o StrictHostKeyChecking=accept-new review-orch   # 서버 지문 등록. rpc_missing JSON이 나오면 정상
```

```
Host review-orch
  HostName <서버 주소>
  User <CLI가 로그인된 계정>
  IdentityFile ~/.ssh/review_orch
  IdentitiesOnly yes
```

- `-N '""'`로 빈 암호를 주지 않습니다. PowerShell 7은 따옴표 두 글자를 암호로 넘기고,
  클라이언트는 `BatchMode`라 암호를 물을 수 없어 `Permission denied`가 납니다.
- 지문을 등록하지 않으면 같은 이유로 `Host key verification failed`가 납니다.
- 클라이언트는 이 도구가 들어 있는 checkout(현재 develop)에서만 `npm run review`로 부를 수
  있습니다. `npm run -s`는 "Missing script" 오류도 숨기므로 `$LASTEXITCODE`를 봅니다.

```powershell
npm run -s review -- submit --author codex --scope "무엇을 왜 바꿨는지 한두 줄"
npm run -s review -- wait r-20261002-061500-a1b2c3
```

- `-s`는 npm의 머리글 출력을 끄므로 stdout이 JSON 하나만 남습니다.
- `submit`은 바로 jobId를 돌려줍니다(종료 코드 3 = 대기 중).
- `wait`는 최대 9분 기다립니다. 아직이면 `"status": "pending"`과 종료 코드 3을
  돌려주므로 같은 명령을 다시 부릅니다.
- 종료 코드(submit·wait): 0 accept · 1 reject · 2 unknown · 3 pending · 64 요청 오류 · 65 서버 오류.
  `report`와 jobId 없는 `status`는 성공하면 0입니다(accept라는 뜻이 아닙니다).
- 검토 대상은 **commit된 것**뿐입니다. base는 `origin/develop`·`origin/main`(그리고 `--base`를
  줬다면 그것)과 HEAD의 분기점 중 **가장 가까운 것**이고, 원격에 있어야 합니다(head는 push하지
  않아도 됩니다). 먼 분기점은 이미 병합된 남의 변경을 diff에 끌고 와서 계약 경로 판정으로
  reviewer를 둘로 늘립니다.
- `--focus`가 **이 서버에서 검토를 마친 job의 head**이면 계약 경로 판정도 `focus..HEAD`로 합니다.
  검토받은 적 없는 focus는 base..HEAD 전체로 셉니다(focus 앞에 계약 변경을 숨길 수 없게).
- 원문은 `npm run -s review -- report <jobId> --slot 0`으로 봅니다.
- `--focus <rev>`: reviewer에게 `<rev>..HEAD`만 보여 줍니다. 같은 브랜치를 여러 round에 걸쳐
  검토할 때 지난 round 이후의 변경만 판정받는 용도입니다. base는 그대로 신뢰 이력의
  분기점이고, `<rev>`는 base와 HEAD 사이에 있어야 합니다(`focus_not_in_range`). 지시 파일
  diff와 계약 경로 판정은 범위를 좁히지 않고 base..HEAD 전체로 합니다 — checkout에 base
  버전이 들어 있으므로, 좁히면 그 이전의 지시 파일 변경이 보이지 않게 됩니다.

### 예외 상황에서 특정 검토자 지정

자동 배정이 기본입니다. 운영자가 특정 검토자를 요청한 경우 서버 설정의 provider ID를
`--reviewer`로 전달합니다. 옵션 반복 또는 쉼표로 최대 3명을 지정할 수 있고, 지정 순서대로
검토 슬롯에 연결됩니다. 지정 수보다 `--reviewers`나 계약 규칙의 최소 인원이 크면 나머지
슬롯은 자동 배정합니다. 예를 들어 계약 변경에 `--reviewer claude` 하나만 지정해도
검토자는 2명이며, 두 번째는 다른 공급사에서 자동으로 고릅니다.

**로컬 PC의 PowerShell, 저장소 clone 폴더 안.** Node 22 이상, 지정 기능이 포함된
클라이언트와 서버, `review-orch` SSH key가 필요합니다. production 자격증명은 필요 없습니다.
명령은 서버에 검토 작업을 만들고 배정 후 계정의 사용량을 소비할 수 있습니다. 대기 중인
작업을 취소하려면 운영자가 아래 서버 운영 절의 `cancel`을 사용합니다. 실행된 검토의
사용량은 되돌릴 수 없습니다.

```powershell
npm run -s review -- submit --author codex --reviewer claude --scope "운영자가 지정한 예외 검토"
npm run -s review -- submit --author codex --reviewer claude --reviewer copilot --scope "운영자가 지정한 두 검토자"
```

- ID는 `status`의 provider 목록에서 확인합니다. 없는 ID, 비활성 provider, 작성자와 같은
  공급사, 중복 ID 또는 같은 공급사의 검토자 두 명은 요청 오류로 거절합니다.
- 지정 계정이 동시 실행 한도에 도달했거나 잔액이 없거나 조회 결과를 확인할 수 없으면
  해당 슬롯은 대기합니다. 다른 작업은 계속 배정할 수 있습니다.
- `status <jobId>`와 `wait <jobId>`의 `reviewerProviders`·`requestedProvider`는 지정한
  검토자를, 슬롯의 `provider`는 실제 배정된 검토자를 보여 줍니다.
- 클라이언트와 서버를 모두 업데이트해야 합니다. 새 클라이언트는 서버의
  `reviewer-selection-v1` capability를 먼저 확인하고, 구버전 서버이면 작업을 보내기 전에
  거절합니다. 구버전 클라이언트는 이 옵션을 지원하지 않습니다.

### 앱 지시 파일에 넣을 문장 (서버 가동 후)

> 작업을 마치고 독립 검토가 필요하면 `npm run -s review -- submit --author <claude|codex|cursor>`
> 를 실행하고(Cursor는 `--author-vendor`로 사용한 모델 공급사를 함께 적습니다),
> 결과가 나올 때까지 `npm run -s review -- wait <jobId>`를 반복합니다. reviewer는
> 기본으로 서버가 고르고, 운영자가 특정 검토자를 명시한 경우에만 `--reviewer <providerId>`를
> 사용합니다. `reject`는 지적을 고친 뒤 새로 submit하고, `unknown`은
> 다시 보내지 말고 사람에게 알립니다.

## 서버 설치 (Ubuntu)

**Ubuntu 서버의 bash, 서비스 계정 `review`.** Node 22 이상과 git이 필요하고,
reviewer CLI(`claude`, `codex`, `cursor-agent`)가 그 계정으로 로그인돼 있어야
합니다. 저장소가 공개라 mirror는 자격증명 없이 받습니다.

```bash
sudo useradd --create-home --shell /bin/bash review
sudo git clone https://github.com/mposition/Tomverse.git /opt/review-orchestrator
sudo install -d -o review /var/lib/review-orchestrator /etc/review-orchestrator
sudo cp /opt/review-orchestrator/tools/review-orchestrator/config.example.json /etc/review-orchestrator/config.json
sudo cp /opt/review-orchestrator/tools/review-orchestrator/deploy/review-orchestrator.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now review-orchestrator
```

SSH는 key를 forced command로 묶어 이 도구 말고는 아무것도 실행하지 못하게 합니다.
`~review/.ssh/authorized_keys` 한 줄:

```
command="REVIEW_ORCH_CONFIG=/etc/review-orchestrator/config.json node /opt/review-orchestrator/tools/review-orchestrator/bin/review-orchestrator.mjs ssh-dispatch",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... windows-pc
```

forced command를 쓰면 클라이언트가 보낸 원격 명령은 무시되고 마지막 `rpc <token>`만
읽힙니다. 상태 확인은 서버에서 `node .../bin/review-orchestrator.mjs status`.

### 계정 잔액 확인과 배정 재개

`quotaProbe: "claude"`는 reviewer가 쓰는 OAuth 토큰으로 Claude 사용량의 5시간·7일
창을 조회합니다. `CLAUDE_CODE_OAUTH_TOKEN`을 `passEnv`로 전달하는 설정이면 그 토큰을
우선하고, 그렇지 않으면 `~review/.claude/.credentials.json`을 읽습니다.
`quotaProbe: "codex"`는 reviewer와 같은 `codex` 실행 파일의 app-server에서
`account/rateLimits/read`를 조회합니다. 각 창의 남은 비율이 0이면 배정하지
않습니다. 조회 실패·응답 형식 불명·설정 누락도 새 배정을 대기시킵니다.

`quotaProbe: "cursor"`는 Cursor CLI 2026.10.01의 [`/usage`](https://cursor.com/docs/cli/changelog)가
쓰는 `DashboardService/GetCurrentPeriodUsage`를 조회합니다. Ubuntu에서는
`~review/.config/cursor/auth.json`의 로그인 access token을 사용하며, `CURSOR_API_KEY`를
reviewer에게 전달하는 설정이면 저장된 토큰이 그 API key의 계정과 일치해야 합니다.
보고된 포함 사용량 pool 중 하나라도 소진됐으면 Cursor 배정을 보류합니다.
이 경로는 공개 Admin API가 아닌 CLI 내부 API이므로 응답이 바뀌거나 로그인 토큰이
만료되면 `unknown`으로 보류하며, probe는 로그인·토큰 갱신을 하지 않습니다.
추가 지출 한도가 남아 있어도 포함 사용량 소진 뒤 새 검토를 시작하지 않습니다.

`quotaProbe: "copilot"`는 reviewer와 같은 CLI를 `--headless --stdio`로 띄워 공식
SDK의 [`account.getQuota`](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing)를
호출합니다. 검토 세션이나 모델 호출 없이 같은 `COPILOT_GITHUB_TOKEN`으로 현재
계정의 남은 할당량을 읽습니다. `quotaKey`는 기본 `premium_interactions`이고,
서버의 실제 응답에서 다른 계정 quota key를 확인했다면 설정으로 지정할 수 있습니다.
남은 비율이 0이면 추가 과금이 허용된 계정도 새 배정을 보류합니다. 이 수치를 AI Credits
금액으로 변환하지 않으며, `--max-ai-credits 50`은 별도의 한 검토 제한입니다.
GitHub의 [AI Credit 사용량 REST 보고서](https://docs.github.com/en/rest/billing/usage?apiVersion=2026-03-10)는
별도 `Plan` 읽기 권한이 필요해 기존 reviewer 토큰의 권한을 넓히지 않았습니다.

자동 probe는 60초마다 갱신하고 `status`는 데몬의 최근 관측 파일만 읽습니다.
Cursor 내부 API와 Copilot CLI quota 응답은 운영 서버의 `review` 계정으로 실측한 뒤
가동합니다. 확인 불가한 계정은 `unknown`이 되어 대기하며 검토를 시험 호출하지 않습니다.

**Ubuntu 검토 서버의 관리 계정 bash, 저장소 clone 위치와 무관.** Node 22와
`review` 서비스 계정으로 실행할 권한이 필요합니다. production 앱 자격증명은
필요 없습니다. 아래 명령은 계정 사용량만 조회하며 검토 배정·모델 호출·설정 변경을
하지 않습니다. 변수는 이 셸에서만 유지됩니다.

```bash
RO="sudo -u review env REVIEW_ORCH_CONFIG=/home/review/.config/review-orchestrator/config.json /usr/bin/node /home/review/review-orchestrator/tools/review-orchestrator/bin/review-orchestrator.mjs"
$RO quota check cursor
$RO status
```

`quota check`는 비활성 provider도 읽기 전용으로 확인할 수 있으며 그 provider의
배정을 활성화하지 않습니다. Copilot 토큰을 systemd `EnvironmentFile`에서 받는
설정이면 같은 서비스 환경에서 실행해야 합니다. 토큰을 명령 인자에 붙이지 않습니다.

**Ubuntu 검토 서버의 관리 계정 bash, 저장소 clone 위치와 무관.** 위의 권한과 Node 22가
필요하며 production 앱 자격증명은 필요 없습니다. 현재 검토 서버의 Copilot 환경 파일을
읽는 일회성 서비스를 만들고 계정 사용량만 조회한 뒤 제거합니다. 계정·배정·설정은
변경하지 않으며 토큰 값은 인자나 출력에 넣지 않습니다.

```bash
sudo systemd-run --wait --pipe --collect \
  --property=User=review \
  --property=EnvironmentFile=/home/review/.config/review-orchestrator/copilot.env \
  --setenv=REVIEW_ORCH_CONFIG=/home/review/.config/review-orchestrator/config.json \
  --setenv=PATH=/home/review/.local/bin:/usr/local/bin:/usr/bin:/bin \
  /usr/bin/node /home/review/review-orchestrator/tools/review-orchestrator/bin/review-orchestrator.mjs quota check copilot
```

자동 조회가 없는 계정의 fallback은 `quotaProbe: "manual"`입니다. 그 설정을 먼저
지정한 provider에만 아래 명령을 쓰며, **review 서버에 로그인된 바로 그 계정**의
사용량 화면에서 확인한 잔액을 기록합니다.

**Ubuntu 검토 서버의 관리 계정 bash, 위의 `RO`를 설정한 같은 셸.** production 앱
자격증명은 필요 없습니다. 아래 명령은 `review` 계정의 상태 폴더에 관측값을 쓰며,
0으로 다시 기록하면 배정을 멈출 수 있습니다.

```bash
$RO quota record cursor 25 percent
$RO quota record copilot 100 credits
$RO status
```

수동 관측은 5분 동안만 유효하며 **한 번 기록하면 검토 한 건만** 시작합니다. 다음
배정 전에는 다시 확인해 기록해야 합니다. `status`의 provider별 `quota`와
`remaining`을 보되, 수동 기록을 사용한 뒤에는 `quota: "unknown"`으로 돌아갑니다.
대기열의 작업은 삭제되지 않으며 새 관측값이 들어오면 자동으로 배정됩니다.
`quota record`는 서버 로컬 명령이고 forced-command SSH RPC에는 열려 있지 않습니다.

### 설치 후 실측할 것

- 각 CLI가 **헤드리스로, stdin 프롬프트를 받아, 파일을 쓰지 않고** 끝나는지.
  `codex exec --sandbox read-only -`와 `cursor-agent --print --mode ask --trust`는
  Windows에서 쓰던 형태입니다. `claude -p`는 Read·Grep·Glob만 허용하고 Bash를 막습니다
  (`git diff --output=`으로 파일을 쓸 수 있으므로 git 명령도 열지 않습니다). subagent
  도구(`Agent`, `Task`)도 막습니다. `--strict-mcp-config`는 구독 계정에 붙은 claude.ai
  커넥터(결제·배포 도구 포함)를 검토 세션에 아예 싣지 않습니다. 2026-10-02 Ubuntu 서버에서
  세 CLI 모두 쓰기 요청을 거절하고 json 블록으로 끝나는 것을 확인했고, Codex는 stdout에
  최종 답만 냅니다.
- Claude 로그인: SSH 터미널에 붙여 넣기가 안 되면 브라우저가 있는 PC에서
  `claude setup-token`으로 1년짜리 토큰을 만들어 `CLAUDE_CODE_OAUTH_TOKEN`으로 줍니다
  (provider의 `passEnv`와 systemd `EnvironmentFile`). 1년 뒤 만료되면 Claude reviewer만
  `unknown`을 돌려주므로 같은 방법으로 갱신합니다. Codex는 `codex login --device-auth`로
  붙여 넣기 없이 로그인합니다.
- Devin CLI(2026-10-03 실측, v3000.11.3): `devin -p --prompt-file {promptFile}
  --respect-workspace-trust false --sandbox --permission-mode auto --model swe-2-high`.
  공급사는 모델로 정해지므로 Anthropic·OpenAI·xAI와 겹치지 않는 Cognition의 SWE-2를 고정해
  `vendor: "cognition"`으로 둡니다. 모델을 바꾸면 `vendor`도 같이 바꿉니다. 설치 직후
  `~/.local/share/devin/credentials.toml`이 644로 만들어지므로 `chmod 600`합니다.
  - **`/dev/stdin`을 쓰지 않습니다.** daemon이 띄운 프로세스의 stdin은 Linux에서 pipe가 아니라
    socket이라, 경로로 다시 열면 `ENXIO`로 실패합니다(셸 pipe로 한 시험은 통과했고 운영에서는
    모든 검토가 `reviewer_exit_1`이었습니다). `{promptFile}`을 쓰면 서버가 프롬프트를 상태 폴더의
    owner-only 파일로 넘기고 끝나면 지웁니다.
  - `auto`는 읽기 전용 도구만 승인하고, `-p`에서 거절된 도구 호출은 **그 자리에서 실행을 끝냅니다**
    (`no_verdict_block`). 그래서 Devin 쪽 사용자 설정(`~/.config/devin/config.json`)에 읽기용 셸
    명령만 `permissions.allow`로 열고(`Exec(grep)`, `Exec(rg)`, `Exec(git log)` 등 — `git diff`는
    `--output`으로 쓸 수 있어 제외), `sandbox.allowed_domains`를 존재하지 않는 도메인 하나로 두어
    네트워크를 막고, `promptNote`로 그 목록만 쓰라고 알립니다.
  - **경로별 읽기 deny(`Read(~/.config/**)`)는 지켜지지 않았습니다**(canary 파일이 읽혔음). 막히는 것은
    허용 목록 밖의 명령과 sandbox의 네트워크뿐이고, 읽기 범위의 경계는 reviewer 전용 계정입니다.
  - 브랜치의 `.devin/` 설정은 사용자 설정보다 우선하지만, 지시 파일로 취급되어 base 버전으로
    되돌려집니다.
  - **결과: 예시 설정에서 꺼 두었습니다.** 2026-10-02~03 서버에서 devin 검토 27건이 모두 판정 없이
    끝났습니다 — 11건은 `/dev/stdin`(ENXIO), 11건은 거절된 도구 호출, `--sandbox`와 허용 명령
    지시문을 넣은 뒤의 5건도 `no_verdict_block`. 다시 켜려면 서버의 실제 job 하나가 판정까지
    나오는 것을 먼저 확인합니다(셸 pipe로 한 시험은 운영과 달랐습니다).
- GitHub Copilot CLI(2026-10-03 실측, v1.0.91, Copilot Pro+): **Kimi K3**(`kimi-k3`, Moonshot)로
  고정해 `vendor: "moonshot"`으로 둡니다. GitHub 문서상 Kimi K3는 GitHub이 Fireworks AI에서 운영하고,
  데이터 미보관 계약이 있으며 프롬프트가 Moonshot에 가지 않습니다. Copilot의 GPT·Claude·Grok은
  기존 공급사와 겹칩니다.
  - 프롬프트는 `-p` 인자로만 받습니다. 인자 하나는 Linux에서 약 128KB가 한계라, `{promptFile}`에
    프롬프트를 쓰고 `-p`에는 그 파일을 읽으라는 지시만 주며 `--add-dir {promptDir}`로 그 job의 폴더
    하나만 읽게 합니다.
  - 인증은 **권한이 "Copilot Requests"(Read-only) 하나뿐인 fine-grained PAT**(`github_pat_`)을
    `COPILOT_GITHUB_TOKEN`으로 줍니다(systemd `EnvironmentFile` + provider `passEnv`). classic 토큰은
    지원되지 않습니다. `--disable-builtin-mcps`로 내장 GitHub MCP를 끕니다.
  - 실측: 허용한 `shell(grep)`은 실행, `bash`의 curl과 `web_fetch`는 `--deny-tool url`로 거절(JSON
    이벤트로 확인 — 응답 문장의 HTML은 모델이 지어낸 것이었습니다), 작업 폴더 밖 읽기는 기본 경로
    제한으로 거절, 쓰기는 `--deny-tool write`로 거절. **거절된 뒤에도 답을 마치고 판정 블록을 냅니다**
    (Devin과 다른 점). 첫 실제 검토 8건이 모두 판정(accept 6, reject 2)으로 끝났습니다.
  - **쓰지 않는 옵션**: `--allow-all`·`--yolo`·`--allow-all-tools`·`--allow-all-paths`·`--allow-all-urls`,
    `--share-gist`, 그리고 환경변수 `COPILOT_ALLOW_ALL=true` — 이 값은 작업 폴더를 신뢰해 그 폴더의
    hooks(셸 명령)까지 불러옵니다. 작업 폴더는 검토 대상 브랜치입니다. 그래서 `.github/hooks`·`skills`·
    `plugins`·`.copilot/`·`.mcp.json`도 base 버전으로 되돌립니다.
  - `--max-ai-credits 50`은 검토 한 건의 상한입니다. 월 credit(Pro+ 3,900, flex 포함 7,000)은
    GitHub의 Copilot 사용량 화면에서 봅니다.

## 서버 업데이트 (drain)

재시작하면 실행 중이던 검토는 `unknown`(`orchestrator_restarted`)으로 닫히고, 쓰는 사람이
많으면 서버가 비는 순간이 오지 않습니다. 그래서 **drain으로 새 배정을 멈추고, 실행 중인
검토가 끝난 뒤** 재시작합니다. drain 중에도 요청은 받아서 대기열에 쌓이고, 잃지 않습니다.
drain 표시는 상태 폴더의 파일이라 재시작해도 남으므로, 마지막에 직접 풉니다.

**서버의 관리 계정 bash.** 첫 줄은 이 창에서만 쓰는 변수입니다.

```bash
RO="sudo -u review env REVIEW_ORCH_CONFIG=/home/review/.config/review-orchestrator/config.json /usr/bin/node /home/review/review-orchestrator/tools/review-orchestrator/bin/review-orchestrator.mjs"
$RO drain on
$RO drain wait --timeout 3600        # 실행 중인 검토가 0이 되면 0으로 끝납니다. 시간 초과는 3
sudo -u review git -C /home/review/review-orchestrator pull --ff-only
sudo systemctl restart review-orchestrator
$RO drain off
```

다음 round가 이미 들어와 쓸모가 없어진 대기 작업은 `$RO cancel <jobId>...`로 닫습니다. 대기 중인
slot만 `unknown`(`cancelled_by_operator`)이 되고, 실행 중인 검토는 끝까지 갑니다. cancel된
검토는 검토로 치지 않으므로 이후 `--focus`의 계약 경로 판정을 좁히지 않습니다.

`drain`은 서버에서만 쓸 수 있고 SSH로 들어오는 요청에는 열려 있지 않습니다. 상태는
`$RO status`의 `draining`, `runningReviews`, `queuedReviews`로 봅니다.

## 작성자가 reviewer에게 지시하지 못하게

reviewer CLI는 작업 디렉터리의 지시 파일(`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`,
`.cursor/`, `.cursorrules` 등)을 스스로 읽습니다. 그래서 이번 변경이 그 파일을 고쳤다면,
reviewer의 checkout에서는 **base 버전으로 되돌리고** 고친 내용은 diff로만 보여 줍니다.
그래도 diff 본문 속 문장이 reviewer를 흔들 수는 있으므로, 판정은 마지막 json 블록과
결정적 규칙으로만 하고 reviewer의 결론 문장을 그대로 믿지 않습니다.

base는 `trustedBaseRefs`(기본 `develop`·`main`)의 이력 안에 있어야 합니다. 지시 파일이
base에서 오므로, 아무 브랜치에나 push한 commit을 base로 지정해 지시를 심을 수 없게
하는 장치입니다(`base_not_trusted`). 기본 base(`origin/develop`과의 분기점)와
`--base origin/main`은 항상 통과합니다.

## reviewer가 읽을 수 있는 것

reviewer CLI는 자기 계정이 읽을 수 있는 파일을 모두 읽을 수 있습니다. 주입된 지시가
그것을 검토 답에 담으면 유출이고, 유출은 되돌릴 수 없습니다. 그래서 **reviewer 전용
계정**으로 돌립니다. 그 계정에는 reviewer CLI의 로그인 세션만 두고, 다른 계정의 홈은
읽을 수 없게 둡니다. 같은 구독 계정으로 로그인해도 그 세션은 따로 해지할 수 있고,
SSH 키·다른 작업의 소스는 보이지 않습니다.

## 디스크와 대기열 상한

| 설정 | 기본값 | 넘으면 |
|---|---|---|
| `maxBundleBytes` | 50 MiB | 전송 중에 `bundle_too_large` |
| `maxChangeBytes` | 200 MiB (압축 해제 기준 새 객체 총량) | worktree를 만들기 전에 `change_too_large` |
| `maxPendingJobs` | 20 | `queue_full` |
| `maxOutputBytes` / `maxStderrBytes` | 8 MiB / 1 MiB | stdout은 `unknown`, stderr는 앞부분만 보관 |
| `retentionDays` | 30 | 끝난 작업과 `refs/review/<id>`를 daemon이 한 시간마다 지움 |

## Agent office 상태 보고

앱은 이 서버에 접속할 수 없으므로(SSH 뒤에 있음), 1분마다 앱의
`POST /api/internal/review-orchestrator/status`로 상태를 보냅니다. 운영자는 Admin의
Agent office "독립 검토실"에서 그것을 봅니다.

**보내는 일은 두 프로세스가 나눠 하고, 둘은 계정이 다릅니다.**

- **daemon(`review` 계정)은 자격증명을 갖지 않습니다.** reviewer CLI가 모두 같은 `review`
  계정으로 돌고, 검토 대상 변경은 reviewer에게 그 계정이 읽을 수 있는 파일이나 프로세스
  환경을 출력하라고 시킬 수 있습니다. 그래서 daemon은 `statusSnapshot.dir`에 내용 없는
  `snapshot.json` 하나만 씁니다(1분마다, 원자적 교체, 0644).
- **sender(`bin/review-status-sender.mjs`)는 systemd `DynamicUser`의 별도 계정으로 돕니다.**
  secret은 root만 읽는 파일에서 systemd가 이 서비스 환경에만 넣으므로, `review` 계정은 그
  파일도 그 프로세스 환경도 읽을 수 없습니다.
- **sender가 실행하는 코드는 `review` 계정이 고칠 수 없는 곳에 있습니다.** sender는 Node
  내장 모듈만 import하는 파일 하나이고, 운영자가 GitHub에서 root 소유 경로
  (`/usr/local/lib/review-status-sender/`)로 직접 받습니다. `review` 계정의 checkout을 실행하거나
  그곳에서 복사하지 않습니다 — 그 계정이 고친 코드가 재시작 때 secret을 가진 채 실행되기
  때문입니다. unit 파일도 같은 이유로 GitHub에서 받습니다.
- **보내는 것**: reviewer별 id·vendor·켜짐 여부·실행 중 건수/동시 실행 상한, 계정 quota
  (`quota check`와 같은 probe가 마지막으로 읽은 상태 하나와 남은 양 하나 — 퍼센트, credits 또는
  USD), reviewer를 기다리는 job 수, drain 여부, 최근 24시간 판정 수(accept·reject·unknown).
  **보내지 않는 것**: jobId, 작성자, 브랜치, scope, diff, 지적, reviewer 원문, probe가 읽은
  계정 정보. daemon이 그런
  값을 snapshot에 넣지 않고, sender는 review 설정·job·reviewer 원문을 읽지 않으며 파일을
  필드 단위로 다시 만들어 그 밖의 것은 버리고, 앱도 모르는 필드를 거절합니다.
- **`review` 계정이 할 수 있는 최악은 검토실 숫자를 틀리게 보이는 것입니다**(snapshot 파일을
  고쳐 쓰는 것). 앱에서 이 숫자로 결정되는 것은 없습니다.
- **검토에 영향을 주지 않습니다.** daemon은 작은 파일 하나를 쓸 뿐 네트워크를 기다리지
  않고, 쓰기에 실패해도 검토는 그대로 진행합니다. 로그는 결과가 바뀔 때만 한 줄입니다.
- **daemon이 멈추면 sender도 조용해집니다.** snapshot이 3분보다 오래되면(1분 쓰기 세 번
  누락) 보내지 않으므로, 앱은 마지막 보고 뒤 5분이 지나면 검토실을 "보고 없음"으로
  바꿉니다. 앱은 받은 시각을 **앱의 시계로** 적습니다. 이 시간들이 서로 맞물려 있으므로
  주기는 설정으로 바꾸지 않습니다.
- **기본은 꺼짐입니다.** config에 `statusSnapshot`이 없으면 파일을 쓰지 않고, sender
  서비스를 설치하지 않으면 아무것도 보내지 않습니다.

### 켜기

앱 쪽 route와 이 sender가 **main**에 들어가 production에 배포된 뒤에 합니다(sender 파일을
main에서 받습니다). 먼저 켜도 해는 없고, sender 로그에 `http_404` 한 줄이 남습니다. 아래
경로는 이 서버의 현재 배치(`/home/review/...`) 기준입니다.

**① Ubuntu 검토 서버의 관리 계정 bash, 아무 폴더.** secret을 root만 읽는 파일에 바로
씁니다. 값은 화면에 나오지 않습니다.

```bash
sudo install -d -m 0700 /etc/review-status
sudo sh -c 'umask 077; printf "REVIEW_ORCHESTRATOR_STATUS_SECRET=%s\n" "$(openssl rand -hex 32)" > /etc/review-status/secret.env'
```

**② Railway 대시보드, production 앱 서비스의 Variables.** 같은 값을
`REVIEW_ORCHESTRATOR_STATUS_SECRET`로 넣습니다. 값은 ①의 서버에서
`sudo cat /etc/review-status/secret.env`로 보고 대시보드에 직접 붙입니다(대화나 문서에
옮기지 않습니다). 변수 저장은 재배포를 일으킵니다.

**③ 같은 서버 bash.** snapshot 폴더를 만들고 daemon config에 적은 뒤, 코드 업데이트와
재시작을 위 "서버 업데이트 (drain)" 절차로 합니다.

```bash
sudo install -d -o review -m 0755 /var/lib/review-status
sudo -u review nano /home/review/.config/review-orchestrator/config.json
#   "statusSnapshot": { "dir": "/var/lib/review-status" }
```

`dir` 하나만 받습니다. 절대 경로여야 하고, URL·secret·주기 필드를 넣으면 설정 오류로
시작하지 않습니다. 재시작 뒤
`sudo journalctl -u review-orchestrator --since "5 min ago" | grep "status snapshot"`에
`status snapshot written`이 보이면 됩니다.

**④ 같은 서버 bash.** sender와 unit 파일을 GitHub의 main에서 root 소유로 받고 켭니다.
`review` 계정의 checkout에서 복사하지 않습니다.

```bash
RAW=https://raw.githubusercontent.com/mposition/Tomverse/main/tools/review-orchestrator
sudo install -d -m 0755 /usr/local/lib/review-status-sender
sudo curl -fsSL -o /usr/local/lib/review-status-sender/review-status-sender.mjs "$RAW/bin/review-status-sender.mjs"
sudo curl -fsSL -o /etc/systemd/system/review-status-sender.service "$RAW/deploy/review-status-sender.service"
sudo chmod 0644 /usr/local/lib/review-status-sender/review-status-sender.mjs /etc/systemd/system/review-status-sender.service
sudo systemctl daemon-reload && sudo systemctl enable --now review-status-sender
sudo journalctl -u review-status-sender --since "5 min ago"
```

`status sender started` 다음에 `status report ok`가 나오면 끝입니다.

- `http_401`: ①과 ②의 값이 다릅니다.
- `status snapshot is stale`: ③의 daemon이 파일을 쓰지 않습니다.
- `status snapshot unreadable: ENOENT`: ③의 `dir`과 unit의 `REVIEW_STATUS_SNAPSHOT`이
  다릅니다.
- `status sender not started: ...`: 그 줄이 말하는 설정이 빠졌습니다(종료 코드 64, 재시작하지
  않습니다).
- 서비스가 아예 시작하지 않고 `Failed to load environment files`가 보이면 ①의
  `/etc/review-status/secret.env`가 없습니다.

sender를 업데이트할 때는 ④의 `curl` 두 줄과 `chmod`를 다시 실행하고
`sudo systemctl daemon-reload && sudo systemctl restart review-status-sender`를 합니다.
끄려면 `sudo systemctl disable --now review-status-sender`입니다. 검토실은 5분 뒤 "보고
없음"이 됩니다.

## 알려진 한계

- `--author`와 `--author-vendor`는 요청자가 스스로 밝히는 값입니다. 세 앱이 같은 Windows
  계정에서 돌기 때문에 앱마다 키를 나눠도 강제할 수 없습니다. 잘못 밝히면 같은 공급사가
  검토할 수 있으므로, 지시 파일의 호출 규칙이 앱마다 자기 이름을 쓰게 합니다.

## 저장 위치

`stateDir/jobs/<jobId>/` 아래에 `job.json`(접수 내용), `slots/<n>.json`(배정·결과),
`reviews/<n>.txt`(reviewer 원문)가 남습니다. 검토마다 `stateDir/worktrees/`에 새
worktree를 만들고 끝나면 지웁니다. reviewer 프로세스는 daemon의 환경을 물려받지
않고 허용 목록(`PATH`, `HOME` 등과 provider별 `passEnv`)만 받습니다.
