# review-orchestrator

작업을 끝낸 앱(Claude Code, Codex, Cursor)이 **자기 이름만 밝히고** 독립 검토를
요청하면, Ubuntu 서버가 작성자와 **모델 공급사가 다른** reviewer를 부하에 따라
골라 실행하는 개발 도구입니다.

- 외부 게시, PR 코멘트, 앱 DB 쓰기, 병합을 하지 않습니다. 사람이 개발 세션에서
  부르는 도구이며, 결과는 서버 디스크에만 남습니다.
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
3. 순서: 진행 중 건수 → 최근 24시간 배정 수 → 가장 오래 쉰 provider → id.
   provider마다 동시 실행은 `maxConcurrent`(기본 1)까지이고, 모두 바쁘면 대기합니다.
   막힌 작업이 뒤의 작업을 막지 않습니다.
4. reviewer는 기본 1명입니다. 바뀐 파일이 `contractPaths`에 걸리면 서버가 2명으로
   올리며, 두 명은 반드시 서로 다른 공급사입니다. 집계는 reject 하나라도 있으면
   reject, 그다음 unknown, 모두 accept여야 accept입니다.

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

### 앱 지시 파일에 넣을 문장 (서버 가동 후)

> 작업을 마치고 독립 검토가 필요하면 `npm run -s review -- submit --author <claude|codex|cursor>`
> 를 실행하고(Cursor는 `--author-vendor`로 사용한 모델 공급사를 함께 적습니다),
> 결과가 나올 때까지 `npm run -s review -- wait <jobId>`를 반복합니다. reviewer를
> 직접 고르지 않습니다. `reject`는 지적을 고친 뒤 새로 submit하고, `unknown`은
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
- Devin CLI(2026-10-03 실측, v3000.11.3): `devin -p --prompt-file /dev/stdin
  --respect-workspace-trust false --permission-mode auto --model swe-2-high`. `auto`는 읽기 전용
  도구만 자동 승인하고, `-p`에서는 확인이 필요한 도구 호출을 거절합니다(쓰기 요청에서 파일이
  생기지 않음을 확인). 공급사는 모델로 정해지므로 Anthropic·OpenAI·xAI와 겹치지 않는 Cognition의
  SWE-2를 고정해 `vendor: "cognition"`으로 둡니다. 모델을 바꾸면 `vendor`도 같이 바꿉니다.
  설치 직후 `~/.local/share/devin/credentials.toml`이 644로 만들어지므로 `chmod 600`합니다.

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

## 알려진 한계

- `--author`와 `--author-vendor`는 요청자가 스스로 밝히는 값입니다. 세 앱이 같은 Windows
  계정에서 돌기 때문에 앱마다 키를 나눠도 강제할 수 없습니다. 잘못 밝히면 같은 공급사가
  검토할 수 있으므로, 지시 파일의 호출 규칙이 앱마다 자기 이름을 쓰게 합니다.

## 저장 위치

`stateDir/jobs/<jobId>/` 아래에 `job.json`(접수 내용), `slots/<n>.json`(배정·결과),
`reviews/<n>.txt`(reviewer 원문)가 남습니다. 검토마다 `stateDir/worktrees/`에 새
worktree를 만들고 끝나면 지웁니다. reviewer 프로세스는 daemon의 환경을 물려받지
않고 허용 목록(`PATH`, `HOME` 등과 provider별 `passEnv`)만 받습니다.
