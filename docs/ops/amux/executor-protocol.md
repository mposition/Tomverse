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
          "args": ["--json"],
          "env_passthrough": ["PATH", "WORKER_A_PROVIDER_KEY"]
        }
      ]
    }

Tomverse는 shell을 사용하지 않는다. `program`과 `args`를
`tokio::process::Command`에 직접 전달한다.

이 설정에는 토큰이나 비밀번호를 넣지 않는다. `env_passthrough`는 **이름만**
담으며 값은 서비스의 기존 secret/environment mechanism에 남는다. 그래야 한
lane의 자격증명을 다른 lane의 설정에서 읽어낼 수 없다.

worker 이름은 server-side worker catalog와 같은 논리적 worker identity여야 한다.

## Lane environment

Agent 작업 검토 승인은 executor lane이 아니라 **app server** 기능이다. 별도 승인
계약과 staging 기록에 서명하기 전에는 `TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED`를
off로 유지한다. 켜기 전에 app server에 `mposition/Tomverse` 한정 Metadata·Pull
requests·Contents 읽기 전용 `AMUX_REVIEW_GITHUB_READ_TOKEN`, 기존
`TOMVERSE_AMUX_SYNC_SECRET`, Admin-to-internal proxy의 `NEXTAUTH_URL`을
설정한다. 이 GitHub token은 orchestrator나 executor lane에 설치하지 않고,
값 자체를 증거에도 기록하지 않는다.

**lane은 빈 환경에서 시작한다.** orchestrator는 `env_clear()` 뒤 그 lane이
`env_passthrough`로 선언한 이름만 주입한다. 선언하지 않으면 아무것도 받지
않으므로, `PATH`로 찾는 program 이름을 쓰려면 `PATH`를 선언하거나 절대 경로를
쓴다.

기본이 상속이 아니라 **빈 환경**인 이유: orchestrator의 환경에는
`TOMVERSE_AMUX_SYNC_SECRET`이 있고, 그 secret 하나가 `/api/internal/amux/*`
전체를 인증한다. 내부 route는 secret만 검사하고 worker 이름은 요청 본문이
말하므로, 그 secret을 가진 lane은 **다른 worker인 척 register·heartbeat·settle을
할 수 있다.** 상속이 기본이면 모든 lane이 그 권한을 갖는다.

다음 이름은 `env_passthrough`에 넣을 수 없고, 넣으면 설정 파싱이 실패한다
(orchestrator가 시작하지 않는다).

- `TOMVERSE_AMUX_ENABLED`
- `TOMVERSE_AMUX_EXECUTE`
- `TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON`
- `TOMVERSE_AMUX_SYNC_SECRET`
- `TOMVERSE_INTERNAL_URL`

wrapper는 작업을 stdin으로 받고 결과를 stdout으로 돌려주므로 내부 route를
직접 부르지 않는다. 위 다섯 개가 필요한 wrapper가 있다면 그것은 설정 문제가
아니라 설계 문제다.

한 lane이 32개를 넘는 이름을 선언할 수 없다. 이름은
`[A-Za-z_][A-Za-z0-9_]*` 형식이어야 하고 중복될 수 없다.

판정과 회귀 검사는 `apps/tomverse-orchestrator/src/executor.rs`에 있다.
`a_lane_does_not_inherit_the_orchestrator_environment`가 실제로 자식 프로세스를
띄워 환경을 확인한다.

### 이것이 하지 않는 것

**빈 환경은 lane 격리가 아니다.** 상속 경로 하나를 막을 뿐이다. lane은 여전히
오케스트레이터의 자식 프로세스이므로 같은 uid, 같은 PID namespace, 같은
파일시스템, 같은 네트워크 위치를 쓴다. 같은 uid의 자식은 부모의
`/proc/<ppid>/environ`을 읽을 수 있고, 거기에 `TOMVERSE_AMUX_SYNC_SECRET`이 있다.

그러므로 **lane을 신뢰 경계로 쓰지 않는다.** 서로 다른 자격증명을 가져야 하는
역할은 서로 다른 서비스로 배포한다. 한 오케스트레이터 아래에 두려면 lane별
container·uid·PID namespace·파일시스템·네트워크 정책을 두고, 부모 환경이 보이지
않음을 **실측해 기록**한 뒤에야 그렇게 부를 수 있다.

`env_clear()`가 하는 일은 셋이다 — 실수로 새는 것을 막고, lane이 무엇을 받는지
설정에 적히게 하고, control plane 이름을 아예 선언할 수 없게 한다. 그 이상을
주장하지 않는다.

### lane 자격증명 표 (activation 전에 채운다)

Stage 2 activation 전에 lane마다 아래 표를 채우고 날짜와 함께 기록한다.
표가 없으면 lane 분리를 증명할 방법이 없다. **표가 있어도 위 문단의 실측 기록이
없으면 서로 다른 신뢰 수준의 역할을 같은 오케스트레이터에 두지 않는다.**

| lane (worker) | program | 선언한 이름(`env_passthrough`) | 그 이름이 주는 권한 | 이 lane이 갖지 **않아야** 하는 것 |
|---|---|---|---|---|
| (예) engineering-runner | (wrapper 경로) | `PATH`, `ENGINEERING_RUNNER_LLM_KEY` | 모델 호출 | GitHub 쓰기 자격증명, 내부 route secret |
| (예) engineering-publisher | (wrapper 경로) | `PATH`, `ENGINEERING_PUBLISHER_APP_KEY` | Publisher GitHub App 쓰기 | LLM key, 내부 route secret |

두 lane이 같은 이름을 선언하면 그것은 공유 자격증명이며, 분리를 주장할 수
없다. 공유가 의도된 것이라면 그 이유를 표에 적는다.

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
