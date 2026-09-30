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
  halt하지 않는다. claim, recover, 그 밖의 상태 코드와 body는 전처럼 멈춘다.

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
