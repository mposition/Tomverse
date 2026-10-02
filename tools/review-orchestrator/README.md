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
서버에 접속할 수 있어야 하고, 이 창에서 `REVIEW_ORCH_HOST`가 설정돼 있어야 합니다.
자격증명은 SSH key뿐이며 production 자격증명은 필요 없습니다. 읽기 전용입니다:
로컬 저장소에는 임시 ref 하나를 만들었다 바로 지웁니다.

```powershell
$env:REVIEW_ORCH_HOST = "review@review-server"   # 이 창을 닫으면 사라집니다
npm run -s review -- submit --author codex --scope "무엇을 왜 바꿨는지 한두 줄"
npm run -s review -- wait r-20261002-061500-a1b2c3
```

- `-s`는 npm의 머리글 출력을 끄므로 stdout이 JSON 하나만 남습니다.
- `submit`은 바로 jobId를 돌려줍니다(종료 코드 3 = 대기 중).
- `wait`는 최대 9분 기다립니다. 아직이면 `"status": "pending"`과 종료 코드 3을
  돌려주므로 같은 명령을 다시 부릅니다.
- 종료 코드(submit·wait): 0 accept · 1 reject · 2 unknown · 3 pending · 64 요청 오류 · 65 서버 오류.
  `report`와 jobId 없는 `status`는 성공하면 0입니다(accept라는 뜻이 아닙니다).
- 검토 대상은 **commit된 것**뿐입니다. base 기본값은 `origin/develop`과의
  merge-base이며, base commit은 원격에 있어야 합니다(head는 push하지 않아도 됩니다).
- 원문은 `npm run -s review -- report <jobId> --slot 0`으로 봅니다.

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
sudo git clone https://github.com/mposition/ai-chat-hub.git /opt/review-orchestrator
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
  (`git diff --output=`으로 파일을 쓸 수 있으므로 git 명령도 열지 않습니다). 이 조합은
  새로 적은 것이라 아직 검증되지 않았습니다. 셋 다 Linux 버전에서 확인합니다.
- Devin CLI: 헤드리스 모드, 읽기 전용 보장, **실제로 쓰는 모델의 공급사**. 확인되면
  `config.json`에서 `vendor`를 적고 `enabled: true`로 바꿉니다. 그 전에는 배정되지 않습니다.

## 작성자가 reviewer에게 지시하지 못하게

reviewer CLI는 작업 디렉터리의 지시 파일(`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`,
`.cursor/`, `.cursorrules` 등)을 스스로 읽습니다. 그래서 이번 변경이 그 파일을 고쳤다면,
reviewer의 checkout에서는 **base 버전으로 되돌리고** 고친 내용은 diff로만 보여 줍니다.
그래도 diff 본문 속 문장이 reviewer를 흔들 수는 있으므로, 판정은 마지막 json 블록과
결정적 규칙으로만 하고 reviewer의 결론 문장을 그대로 믿지 않습니다.

## 저장 위치

`stateDir/jobs/<jobId>/` 아래에 `job.json`(접수 내용), `slots/<n>.json`(배정·결과),
`reviews/<n>.txt`(reviewer 원문)가 남습니다. 검토마다 `stateDir/worktrees/`에 새
worktree를 만들고 끝나면 지웁니다. reviewer 프로세스는 daemon의 환경을 물려받지
않고 허용 목록(`PATH`, `HOME` 등과 provider별 `passEnv`)만 받습니다.
