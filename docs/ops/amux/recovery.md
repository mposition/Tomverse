# AMUX Recovery and Rollback

## Immediate containment

AMUX runtime 이상 시 가장 먼저 execution surface를 닫는다.

1. `TOMVERSE_AMUX_EXECUTE`를 제거하거나 `1` 이외 값으로 바꾼다.
2. `TOMVERSE_AMUX_EXECUTION_API_ENABLED`를 제거하거나 `1` 이외 값으로 바꾼다.
3. 필요하면 `TOMVERSE_AMUX_ENABLED`도 제거한다.
4. `/api/internal/amux/health`와 serving SHA를 다시 확인한다.

Feature-OFF는 새 claim과 execution을 막는 containment다. 이미 남아 있는 durable
attempt, delivery, lease를 삭제하거나 성공으로 간주하지 않는다.

## Durable state recovery

- Claim, attempt, delivery receipt는 각 lifecycle의 generation/fence를 보존한다.
- Stale heartbeat나 ACK를 받아들이기 위해 fence를 낮추지 않는다.
- Orphan recovery는 canonical recovery API와 Tomverse DB transaction을 거친다.
- Worker가 Tomverse DB를 직접 수정하거나 수동 SQL로 상태를 건너뛰지 않는다.
- External action 재시도 전에는 approval과 audit evidence를 다시 확인한다.

## Code rollback boundary

애플리케이션 commit을 되돌리는 것과 schema를 되돌리는 것은 같은 작업이 아니다.
AMUX migration은 기존 durable state를 보존하도록 forward-compatible하게 다루며,
production schema를 수동으로 drop하지 않는다. 코드 rollback이 필요하면 먼저
feature를 OFF로 유지하고, 배포 플랫폼에서 직전 검증 commit으로 되돌린 뒤 serving
SHA와 health를 확인한다.

## Incident record

복구 회차에는 최소 다음을 남긴다.

- 발생 시각과 serving SHA
- 당시 feature flag 상태
- 영향을 받은 claim/attempt/delivery 범위
- containment와 recovery 동작
- fence/CAS가 거부한 stale mutation
- 최종 판정과 승인자

Staging 결과는 `staging-verification-records/`, 운영 incident와 recovery evidence는
이 디렉터리 아래 별도 날짜 문서로 남기고 `verification/README.md`에서 색인한다.

## Railway AMUX Orchestrator의 종료와 재시작

### 2026-09-29 queue 읽기 P2028 메모

아래 관측은 운영 로그에서 보고된 것이고, 이 메모를 쓴 사람이 직접 본 것이 아니다.

- 21:43 UTC 무렵 production web이 #1773(develop의 AMUX를 main으로) 빌드로 바뀌었다.
- 21:55:21 UTC orchestrator가 `execution_recover`의 "unsupported Tomverse internal
  response status"로 `AMUX_RECOVERY_OUTCOME_UNKNOWN`을 남기고 끝났다. Railway가 1초
  안에 다시 시작했다.
- 21:57 UTC web의 queue 읽기가 `withAmuxDbBoundary` 읽기 경계(maxWait 250 ms)에서
  Prisma `P2028`로 실패했다(`internal_route_failure operation=queue error_code=P2028`).
  route는 503 `amux_outcome_unknown`으로 답했고, orchestrator는 "unsupported Tomverse
  internal response status"와 `AMUX_INTERNAL_API_UNVERIFIED`로 끝난 뒤 CRASHED로 남았다.
  쓰기는 없었다.
- 22:50 UTC 운영자 승인 아래 다시 시작했다.

**원인.** `lib/amux/internalRoute.ts`는 `P2028`을 경계의 종류와 상관없이 결과 불명으로
답했다. 쓰기에는 맞는 규칙이지만 queue 읽기는 아무것도 쓰지 않는다.

**읽기가 결과 불명일 수 없는 이유.** 읽기 경계(`AMUX_DB_BOUNDARIES`의
`isolation: "read"`)는 카드, 감사, commit-deadline marker를 쓰지 않는다. 실패한 읽기의
COMMIT이 됐든 안 됐든 DB 상태는 같다. 결과 불명 규칙(정책 Phase A)은 쓰기의 규칙이고,
쓰기에서는 약해지지 않는다.

**지금의 동작.**

- 읽기 경계가 `P2024`, `P2028`, `57014`, 연결 오류(목록은
  `lib/amux/readFailureCore.ts`)로 실패하고, 그 route가 그때까지 쓰기 트랜잭션을 시작하지
  않았으면 503 `amux_database_busy`와 `Retry-After: 5`로 답한다. incident를 열지 않고
  WARN `internal_route_database_busy` 한 줄을 남긴다.
- 판정은 `amuxDbBoundaryFailure`(`lib/amux/dbBoundary.ts`) 한 곳에서 경계의
  `isolation`으로 한다. route 이름은 보지 않는다. 같은 route에서 쓰기 트랜잭션이 먼저
  시작됐으면(recover는 quota sweep을 쓴 뒤 읽는다) 전처럼 결과 불명이다. route 밖의 호출도
  전과 같다.
- 쓰기 경계는 그대로다. COMMIT 단계의 실패와 `P2028`은 `amux_outcome_unknown`,
  `AX001`은 `amux_database_deadline_exceeded`다.
- orchestrator는 queue와 routing snapshot의 이 답에 WARN(`verdict =
  "selection_skipped"`)을 남기고 그 tick을 건너뛴다. WSL bridge는 owned queue의 이 답에
  halt하지 않는다. claim, recover, 그 밖의 상태 코드와 body는 전처럼 멈춘다. (claim과
  recover는 아래 2026-09-30 메모에서 바뀌었다.)

**#1773 뒤에 처음 보인 이유.** 코드에서 확인한 사실과 확인하지 못한 가설을 나눈다.

- 사실: #1773 전 main의 queue, owned queue, routing snapshot 읽기는 트랜잭션 없는 Prisma
  쿼리였고 pool 대기에 한도가 없었다. `lib/prisma.ts`의 `new Pool`은 `max`와
  `connectionTimeoutMillis`를 정하지 않으므로 pg-pool 기본값(프로세스당 10개, 대기
  무제한, 유휴 연결은 10초 뒤 닫힘)이다. #1773이 이 읽기를 `withAmuxDbBoundary`의 읽기
  트랜잭션으로 옮겼고, 그 트랜잭션은 250 ms(`AMUX_DB_MAX_WAIT_MS`) 안에 pool 연결 획득,
  `BEGIN`, 격리 수준 설정을 마쳐야 한다.
- 가설: 배포 직후 새 인스턴스의 pool은 비어 있어 첫 연결마다 새 연결을 맺는다. 그 시간이나
  다른 web 요청과의 경합이 250 ms를 넘었을 수 있다. pool 사용량, 연결 수립 시간, event
  loop 지연을 남긴 지표가 없어 확인하지 못했다.
- 21:55의 recover 종료가 같은 원인인지는 확인하지 못했다. 그 실패는 이 변경 뒤에도 결과
  불명으로 멈춘다.

이 메모는 위 "Incident record"의 완결 기록이 아니다. serving SHA, 당시 flag 상태, 판정과
승인자는 운영자가 따로 남긴다.

### 2026-09-30 시작하지 못한 트랜잭션 메모

아래 관측은 운영 로그에서 보고된 것이고, 이 메모를 쓴 사람이 직접 본 것이 아니다.

- #1777(merge `38434294a`)은 약 02:22 UTC에 web에 올라갔다. orchestrator는 그보다 앞선
  약 01:44 UTC에 배포됐다.
- 01:50–02:03 UTC, #1777 이전 빌드 `9fb376b3`이 서빙한 web HTTP 로그에서 AMUX 실패는 모두
  총 소요 264–267 ms의 503이었다. queue 3건, 이어 execution/recover 3건이다. 709 ms의
  queue 500이 한 건 더 있었다.
- 264 ms는 250 ms `maxWait`이 끝난 시점이다. 트랜잭션이 pool 연결을 얻지 못했다. 거의 모든
  orchestrator 실행이 몇 분 안에 끝났다.
- orchestrator는 recover의 결과 불명 종료가 반복돼 재시작 한도에 닿은 뒤 다시 CRASHED가 됐다.

**원인 둘.**

1. 시작하지 못한 쓰기도 결과 불명으로 답했다. recover의 첫 트랜잭션은 quota sweep(쓰기)이다.
   그 트랜잭션이 `maxWait` 안에 연결을 얻지 못하면 Prisma가 콜백을 실행하기 전에 `P2028`을
   던진다. SQL은 하나도 실행되지 않았는데 route는 `amux_outcome_unknown`으로 답했다.
2. 250 ms는 web 요청과 함께 쓰는 프로세스당 10개 pool(pg-pool 기본값)에 너무 짧다.

**시작하지 못한 트랜잭션이 결과 불명이 아닌 이유.** Prisma는 pool 연결을 잡고 `BEGIN`을 보낸
뒤에만 콜백을 실행한다. `maxWait`이 먼저 끝나면 늦게 도착한 연결은 콜백 없이 롤백된다. 경계는
콜백의 첫 줄에서 phase를 `starting`에서 `running`으로 바꾼다. 그래서 `starting`에서 난
`P2024`·`P2028`은 경계의 SQL을 하나도 실행하지 않은 트랜잭션이다. 실제 Prisma 7과
adapter-pg로 돌린 테스트(`tests/server-contract/amux-commit-deadline-boundary.test.ts`)가
setup·콜백·fence SQL이 하나도 나가지 않았음을 확인한다. 같은 `P2028`이라도 콜백이 시작된
뒤(트랜잭션 자체의 timeout)는 전처럼 결과 불명이다.

**지금의 동작.** 판정표는 `amuxDbBoundaryFailure`의 주석에 있다.

| phase | 경계 | 오류 | route가 이미 썼나 | 답 |
|---|---|---|---|---|
| 어디서든 | 모두 | `AX001` | 상관없음 | `amux_database_deadline_exceeded` |
| committing | 쓰기 | 그 밖의 모두 | 상관없음 | `amux_outcome_unknown` |
| starting | 모두 | `P2024`, `P2028` | 아니오 | `amux_database_busy` (`AMUX_DB_NOT_STARTED`) |
| 어디서든 | 읽기 | transient | 아니오 | `amux_database_busy` (`AMUX_DB_READ_BUSY`) |
| 그 밖 | | | | 전과 같음 (쓰기의 running `P2028`은 `amux_outcome_unknown`) |

- route 밖의 호출은 "이미 썼다"로 본다.
- 쓰기의 route 표시는 그 콜백이 시작될 때 한다(#1777은 `BEGIN` 전에 했다). 시작하지 못한
  쓰기는 route를 표시하지 않는다.
- route별로 확인한 것: lifecycle route(register, worker heartbeat, pull, ack, start,
  execution heartbeat, settle)는 경계 하나만 쓰고 경계 밖 쓰기가 없다. 그래서 busy는 그 경계가
  시작하지 못했을 때뿐이다. claim은 읽기 다음에 claim 쓰기이고, 거절을 기록하는 쓰기는 기록한 뒤
  바로 답한다. 그래서 busy는 claim이 쓰기 전이다. recover는 quota sweep이 첫 트랜잭션이라 busy는
  sweep이 시작하지 못했을 때뿐이다. sweep이 시작된 뒤의 실패는 전처럼 결과 불명이다.
- WARN `internal_route_database_busy`에 `path`(`read` 또는 `not_started`),
  `connection_wait_ms`, 그 순간 pool의 `pool_total`·`pool_idle`·`pool_waiting`이 남는다.
  연결 문자열이나 호스트는 남기지 않는다. pool 포화 여부는 이 값으로 판단한다.
- orchestrator: claim busy는 WARN(`claim_skipped`) 후 tick을 건너뛰고, recover busy는
  WARN(`recovery_skipped`) 후 다음 30초 주기에 다시 부른다. 그 밖은 전처럼 끝난다.
- WSL bridge의 lifecycle 호출은 `wsl-execution-bridge.md`의 해당 절을 본다.

**maxWait.** `AMUX_DB_MAX_WAIT_MS`를 250에서 2,000으로 올렸다. route 안에서는
`amuxDbConnectionWaitMs`가 그 값을 "route의 남은 시간 − 이 트랜잭션의 예산"으로 줄인다.
대기는 route의 여유에서만 쓰이므로 route가 예산보다 늦게 답하지 않는다.

- 트랜잭션은 route 기한 − 예산보다 늦게 시작하지 않는다. Prisma는 시작 뒤 예산 + 300 ms에서
  트랜잭션을 닫는다. 그래서 서버의 답은 route 예산 + 300 ms 안에 나온다.
- 클라이언트 기한은 그대로 맞는다. lifecycle 15 s ≥ 12 + 1(연결) + 1(전송, 300 ms 포함),
  claim 18 s ≥ 12 + 1 + 1, 선택 읽기 5 s ≥ 2.8 + 1 + 1이다.
- 첫 트랜잭션이 기다릴 수 있는 시간: lifecycle 경계는 모두 2,000 ms다(가장 큰 execution
  start도 9,200 + 2,000 ≤ 12,000). claim의 clock 읽기는 2,000 ms다. queue는 800 ms, routing
  snapshot은 500 ms, owned queue는 1,700 ms다.
- 상한 없이 2,000을 쓰면 맞지 않는다. queue는 2,000 + 2,000 > 2,800, claim은 8,700 +
  3 × 2,000 > 12,000이다. 선택 읽기는 2.8 + 2.0 + 0.3 + 1(연결) = 6.1 s > 5 s여서 Rust가
  먼저 timeout한다.
- 자동 승격 tick은 자기 값(`AUTO_TICK_TRANSACTION_MAX_WAIT_MS` 1,000)을 쓰므로 바뀌지
  않았다. pool 크기는 바꾸지 않았다.

**남는 것.**

- recover가 sweep 뒤의 트랜잭션에서 연결을 얻지 못하면 여전히 결과 불명으로 끝난다. route가
  이미 썼기 때문이다. 대기 상향으로 드물어질 뿐 없어지지는 않는다.
- 쓰기가 `starting`에서 `P2024`·`P2028`이 아닌 연결 오류로 실패하면 전과 같은 답이다.
- 선택 읽기의 첫 트랜잭션 대기는 Rust의 5초 기한 때문에 800 ms와 500 ms로 제한된다.
- DB 통합 테스트(routing 레인)는 이 PC에서 돌리지 못했다. CI의 Linux Rust job이 기준이다.

### 재시작 정책

- 이 저장소에는 AMUX Orchestrator 서비스의 선언이 없다. `.railway/railway.ts`는 named
  partial `scheduled-jobs`로 cron 서비스 다섯만 소유하고, 이 서비스에는
  `apps/tomverse-orchestrator/Dockerfile`만 있을 뿐 `railway.json`이나 `railway.toml`이
  없다. 이 서비스를 partial에 넣으면 apply가 선언하지 않은 변수를 지우므로, 재시작 정책
  하나 때문에 넣지 않는다. 재시작 정책은 Railway 대시보드에서만 정한다.
- Railway 문서(docs.railway.com/deployments/restart-policy) 기준 기본값은 `On Failure`,
  최대 10회이고, `On Failure`는 0이 아닌 종료 코드면 다시 시작한다. 21:55에 1초 안에 다시
  시작된 것은 이 기본값과 맞는다. 21:57 뒤 다시 시작되지 않은 이유는 확인하지 못했다.
- orchestrator가 오류로 멈출 때는 종료 코드 1로 끝난다(`main`이 `Err`를 돌려준다). `TOMVERSE_AMUX_ENABLED`가 꺼져서 끝나는 경우는 `Ok`라 0이다. 결과
  불명 claim(`AMUX_CLAIM_OUTCOME_UNKNOWN`), 결과 불명 recover
  (`AMUX_RECOVERY_OUTCOME_UNKNOWN`), 그 밖의 내부 API 실패
  (`AMUX_INTERNAL_API_UNVERIFIED`)가 모두 같다. Railway는 종료 코드별로 가르지 못하므로
  `On Failure`는 쓰기의 결과 불명 뒤에도 사람의 확인 없이 다시 시작한다. 21:55의 recover
  종료가 그렇게 다시 시작됐다. 결과 불명 규칙(새 claim이나 재시도를 만들지 않고 사람에게
  넘긴다)과 WSL bridge의 `RestartPreventExitStatus=3`은 그 반대를 요구한다.
- 읽기 busy에는 도달 실패(`P1001`, `ENOTFOUND`, `ECONNREFUSED`)도 들어간다. 호스트 설정이 잘못돼 계속 실패해도 orchestrator는 incident 없이 매 tick을 건너뛰고, 로그의 `amux_database_busy` WARN이 반복되는 것으로만 드러난다. 그 WARN이 몇 분 넘게 이어지면 연결 설정을 확인한다. `08004`(서버가 연결 거절)와 `08P01`(protocol violation)은 busy가 아니라 500 incident다.
- 이번 사건의 원인인 읽기 busy는 이제 프로세스를 끝내지 않는다. 재시작 정책으로 덮을
  일이 아니다.

운영자 단계(대시보드, 읽기부터):

1. Railway 대시보드 → 프로젝트 `Tomverse` → 환경 `production` → 서비스
   `AMUX Orchestrator` → Settings의 Restart Policy에서 현재 정책과 최대 횟수를 읽는다.
   `staging`도 같은 자리에서 읽는다.
2. 값을 정한다. 이 문서는 정하지 않는다.
   - `Never`: 모든 종료가 사람의 재시작을 기다린다. 결과 불명 규칙과 맞는다. 결과 불명이
     아닌 종료(시작 설정 오류 등)도 사람이 다시 시작해야 한다.
   - `On Failure`(최대 N회): 지금 기본값과 같은 동작이며 쓰기의 결과 불명 뒤에도 자동으로
     다시 시작한다. 이 값을 명시적으로 고르는 것은 그 동작을 승인하는 것이므로
     `docs/policy/development-agent-orchestration.md`의 결정이 먼저다.
   - 결과 불명 종료만 다시 시작하지 않게 하려면 orchestrator의 종료 방식을 바꿔야 한다
     (예: 결과 불명은 0으로 끝내 `On Failure`가 다시 시작하지 않게 한다). CRASHED 표시가
     사라지는 대가가 있고, 정책 결정과 코드 변경이 함께 필요하다. 이 변경에는 없다.
3. 바꿨으면 같은 화면에서 값을 다시 읽고, 날짜와 값을 incident 기록에 적는다.
