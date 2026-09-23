# AMUX Executor Wrapper Protocol v1

Tomverse AMUX는 Claude, Codex, Devin 등의 CLI command line을 추측하거나
하드코딩하지 않는다.

실제 agent 실행은 운영자가 명시적으로 설정한 wrapper command가 담당한다.

## Configuration

환경 변수:

`TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON`

형식 예:

    {
      "workers": [
        {
          "worker": "worker-a",
          "program": "/opt/tomverse/worker-a-wrapper",
          "args": ["--json"]
        }
      ]
    }

Tomverse는 shell을 사용하지 않는다. `program`과 `args`를
`tokio::process::Command`에 직접 전달한다.

이 설정에는 토큰이나 비밀번호를 넣지 않는다. wrapper가 필요한 인증 정보는
서비스의 기존 secret/environment mechanism으로 받아야 한다.

worker 이름은 server-side worker catalog와 같은 논리적 worker identity여야 한다.

## Agent 검토 app server 설정

Agent 작업 검토 승인은 executor lane이 아니라 app server 기능이다. 별도 승인
계약과 staging 기록에 서명하기 전에는 `TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED`를
off로 유지한다. 켜기 전에 app server에 `mposition/Tomverse` 한정 Metadata·Pull
requests·Contents 읽기 전용 `AMUX_REVIEW_GITHUB_READ_TOKEN`, 기존
`TOMVERSE_AMUX_SYNC_SECRET`, Admin-to-internal proxy의 `NEXTAUTH_URL`을
설정한다. 이 GitHub token은 orchestrator나 executor lane에 설치하지 않고,
값 자체를 증거에도 기록하지 않는다.

공개 origin이 Cloudflare Access 같은 identity-aware proxy 뒤에 있으면 app의
self-call도 로그인 redirect를 받는다. 이 경우에만
`TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN`을 같은 app service의 Railway private
origin(`http://<RAILWAY_PRIVATE_DOMAIN>:<port>`)으로 설정한다. 코드는 Railway가
주입한 `RAILWAY_PRIVATE_DOMAIN`과 hostname이 정확히 같은 경우만 허용하고,
다른 private service나 외부 host에는 Admin cookie·sync secret을 보내지 않는다.
`NEXTAUTH_URL`은 공개 로그인 origin으로 유지한다.

## stdin

wrapper는 stdin에서 JSON document 하나를 받는다.

`protocol_version`:

`tomverse-amux-agent-exec-v1`

전달 필드:

- `attempt_id`
- `task_id`
- `worker`
- `task_revision`
- `prompt`
- `receipt_id`
- `lease_expires_at`

`prompt`는 argv에 넣지 않는다.

## stdout

성공 exit code와 함께 stdout에는 JSON document 하나만 쓴다.

`protocol_version`:

`tomverse-amux-agent-result-v1`

허용 outcome:

    {"protocol_version":"tomverse-amux-agent-result-v1","outcome":"done"}

    {"protocol_version":"tomverse-amux-agent-result-v1","outcome":"review"}

    {"protocol_version":"tomverse-amux-agent-result-v1","outcome":"retry","reason":"bounded reason"}

    {"protocol_version":"tomverse-amux-agent-result-v1","outcome":"blocked","reason":"bounded reason"}

알 수 없는 protocol version, 알 수 없는 outcome, malformed JSON, 비정상 exit,
필수 reason 누락은 모두 fail-closed다.

`done`과 `review`에는 reason을 허용하지 않는다.

## stderr

wrapper stderr는 기본적으로 orchestrator log에 전달하지 않는다.

task 본문, provider 응답, secret이 운영 로그로 흘러가는 것을 방지하기 위해
현재 executor는 stderr를 폐기한다.

## Cancellation and fencing

executor child는 `kill_on_drop(true)`로 실행한다.

WorkerProtocol이 runtime lease 또는 execution fence loss를 감지해
`execute()` future를 drop하면 해당 child도 종료되어야 한다.

fence loss 뒤에는 stale worker가 settlement callback을 보내지 않는다.

## Delivery identity

delivery identity는 `attempt_id`다.

`receipt_id`는 pull lease identity이며 만료 후 rotate될 수 있다. 따라서 wrapper는
receipt를 durable execution identity로 저장하면 안 된다.

## Activation

이 adapter가 존재한다는 사실은 AMUX activation을 의미하지 않는다.

다음은 별도 activation 결정 전까지 유지한다.

- `TOMVERSE_AMUX_EXECUTE` off
- `TOMVERSE_AMUX_EXECUTION_API_ENABLED` off
- worker catalog unset unless explicitly staging-configured
- `execution_ready=false`

Production activation 전에는 `docs/ops/amux/README.md`의 source identity,
clean worktree, targeted tests, feature flags, cadence, rollback 요구사항을 모두
충족해야 한다.
