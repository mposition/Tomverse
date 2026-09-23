# AMUX Staging Readiness

이 문서는 실제 staging verification record가 아니다.

실제 staging 배포 SHA가 생기기 전까지의 preflight evidence만 기록한다.
로컬 evidence는 WSL의 repository root에서
`npm run report:amux-staging-evidence`로 생성한다. 이 명령은 source HEAD SHA와
dirty diff/untracked content digest를 묶고 실제 Rust test enumeration을 계산한다.
dirty source identity는 deploy SHA가 아니며 staging 배포 증거를 대신하지 않는다.
스크립트의 `runtimeFlagsObserved=false`는 아래 flag 상태가 실행 환경 관측이
아니라 코드 기본값이라는 뜻이다.

## Current safety posture

- `TOMVERSE_AMUX_ENABLED`: 코드 기본값 off, 실제 runtime 값 미관측
- `TOMVERSE_AMUX_EXECUTE`: 코드 기본값 off, 실제 runtime 값 미관측
- `TOMVERSE_AMUX_EXECUTION_API_ENABLED`: 코드 기본값 off, 실제 runtime 값 미관측
- `TOMVERSE_AMUX_WORKER_CATALOG_JSON`: 실제 runtime 값 미관측
- local executor: production hard-disabled (`cfg(test)` process fixture only)
- server routing `execution_ready=false`

## 코드 계약과 로컬 증거 범위

- AMUX core/orchestrator test counts: read the generated source-bound evidence;
  do not reuse a historical number after tests change
- AMUX DB orchestration tests: the latest isolated PostgreSQL 17 preflight below
  passed for executable-code commit `7a4fc2a21`; this is not a staging deployment
  result or evidence for a later executable-code change
- admin audit tests: require a fresh source-bound test result before staging use
- execution start and durable delivery are written in one transaction; the
  `7a4fc2a21` executable-source AMUX DB regression below passed locally
- expired delivery receipt rotates
- stale/expired receipt ACK is fenced
- no separate delivery enqueue mutation surface
- test-only provider command fixture is shell-free; production command execution
  is unavailable regardless of configuration
- worker fence loss quarantines the worker without automatic re-registration
- board tick의 불명확한 결과는 같은 process run을 중단하고 read-back/사람 확인을 기다림
- worker register/heartbeat 및 owned queue는 execution API off에서 인증 후 409
- runtime 등록·권한 상태 전환·delivery receipt 발급은 canonical audit와 원자적;
  단순 heartbeat lease 갱신은 고빈도 telemetry 예외이며 권한 상태 전환은 예외가 아님
- execution heartbeat의 attempt lease 연장은 권한 유지 변경이므로 동일 transaction의
  canonical audit 대상이다. worker runtime의 단순 telemetry 예외와 다르다
- execute-off path precedes executor configuration
- internal service has no product DB credentials; app route DB work uses
  PostgreSQL-enforced statement/idle-in-transaction timeouts, an application
  Prisma-call ceiling and a DB-clock commit fence, not a claimed HTTP hard
  timeout or proven SQL statement-count cap. Prisma 한 호출이 복수 SQL을 만들 수
  있으므로 현재 call ceiling에서 유도한 transaction maximum은 앱 추정치이며
  DB 보증이 아니다. 현재 코드는 `transaction_timeout`을 설정하지 않으므로
  transaction 전체 점유 시간에 DB ceiling이 없다. PostgreSQL 17에서는 transaction
  내부에서 설정한 순간부터 점유 시간을 제한할 수 있지만 PostgreSQL 16에는
  그 설정이 없다. 설정하더라도 BEGIN→SET 구간과 COMMIT의 durable 단계는 제한 밖이다.
  `statement_timeout`과 `idle_in_transaction_session_timeout`은 각 값이
  `transaction_timeout`보다 짧거나 후자가 0일 때만 적용된다. 신규 activation 전에는
  늦은 실행이 성공으로 기록되지 않음을 DB가 강제한다는 통합 증거가 필요하다. 연결
  수준의 `transaction_timeout` 설정은 선택지이며 필수 구현 조건은 아니다. 실제 SQL 문장
  수 상한이나 전체 transaction 시간 상한 자체도 필수 조건이 아니다. Final SELECT와
  COMMIT 사이에 race가 있으므로 응답 유실/불명확한 COMMIT은 service가 성공으로
  추정하지 않고 정지한다. DB에는 state+audit 전부 또는 전무가 남을 수 있으며,
  특히 settle의 늦은 terminal COMMIT은 아직 배제되지 않았다. Future execution API는
  코드에서 production hard-disabled이며 DB 보증·staging 검증 전에는 flag만으로 활성화 불가

## 2026-09-21 isolated DB preflight

이 기록은 코드 커밋 `7ad58007fdd28c5ea59d787b60bf6d405d1755fb`의
로컬 검증이며 실제 staging 검증이 아니다. 전용 PostgreSQL 17 인스턴스의
`tomverse_test` 데이터베이스에서 세션 `TimeZone=Australia/Brisbane`을 확인하고
`AMUX_EXPECT_DB_TIMEZONE=Australia/Brisbane` assertion을 켰다. 운영 DB와
provider 자격증명은 사용하지 않았다.

- migration deploy: pass; schema drift: `No difference detected`
- `npm run test:db:integration` routing lane: 171/171 pass
- 같은 격리 DB의 AMUX orchestration 단독 실행: 37/37 pass
- 비UTC instant·DB clock, timeout rollback, DB-clock fence, delivery·execution·
  worker 경로가 위 AMUX suite에 포함됨
- 검증 후 격리 DB 서버는 중지했고, 데이터 디렉터리는 보존함

처음 만든 임시 DB는 테스트의 이름 제한을 충족하지 못해 AMUX 테스트가 0건 실행된
채 종료됐다. 허용된 전용 DB를 새로 만든 뒤 위 결과로 재실행했다. 이 결과는
실제 runtime flag, staging 배포 SHA, 늦은 terminal `COMMIT` 배제 또는
production activation을 입증하지 않는다.

## 2026-09-22 source-bound local recheck

코드 커밋 `4da8295a1`에서 worker-catalog 이름 검증을 응답의 machine-ID 계약과
일치시킨 뒤, 새 격리 PostgreSQL 17 `tomverse_test`에서 세션
`TimeZone=Australia/Brisbane`과 `AMUX_EXPECT_DB_TIMEZONE` assertion을 확인했다.
운영 DB·provider 자격증명은 사용하지 않았다.

- migration deploy: pass; schema drift: `No difference detected`
- `npm run test:db:integration` routing lane: 172/172 pass
- 같은 격리 DB의 AMUX orchestration 단독 실행: 38/38 pass
- `cargo test -p tomverse-orchestrator --locked`: 61/61 pass
- `cargo test -p amux-core --locked`: 234/234 pass
- `cargo build -p tomverse-orchestrator --locked`: pass (비테스트 빌드)
- 후속 Rust 포맷 전용 커밋 `5204cb073`에서 위 두 Rust test suite와 비테스트
  빌드를 다시 실행해 같은 결과를 확인했다. 이후 Rust 소스는 바뀌지 않았으나
  TypeScript 라우팅 코드는 아래 `7a4fc2a21`까지 변경됐다.
- 기존 `AmuxWorkItem_drag_check`는 DB 쓰기에서 0..8 외의 값을 거절한다.
  이 제약을 놓친 임시 회귀 시료는 실패했고, 불가능한 시료와 중복 방어 코드는
  최종 소스에서 제거한 뒤 위 DB lane을 다시 통과했다.
- 검증 뒤 격리 DB 서버를 중지하고 테스트 데이터 디렉터리는 보존했다.

같은 날짜의 후속 **실행 코드** 커밋 `7a4fc2a21`은 worker catalog가 등록 route와
동일한 `amuxMachineIdSchema`를 사용하도록 하고 검증된 이름을 그대로 보존한다.
그 정확한 실행 코드에서 별도 격리 PostgreSQL 17(`Australia/Brisbane`)에 migration
136/136을 적용한 뒤 schema drift 없음, AMUX DB 38/38, `npm run typecheck`
통과를 확인했다. 이어 공식 `DB_INTEGRATION_GROUP=routing`
`npm run test:db:integration` lane도 같은 실행 코드에서 155/155 + 3/3 +
14/14 = **172/172** 통과했다. 각 격리 DB 서버는 검증 후 중지했다.
Rust 61/61·234/234와 비테스트 빌드는 마지막 Rust 소스 커밋 `5204cb073`에
결속하고, 그 이후 Rust 소스가 바뀌지 않았음을 별도로 확인한다.

시간대 조건부 assertion이 공식 routing lane에서 켜졌는지 명시하지 않은
기록을 보완하기 위해, 실행 코드 `7a4fc2a21` 이후 실행 코드가 바뀌지 않은
문서 전용 A HEAD `b45b599b1`에서 **새 격리 PostgreSQL 17**을
`Australia/Brisbane`으로 기동해 다시 확인했다. 해당 서버의 `SHOW TIMEZONE`은
`Australia/Brisbane`, migration은 136/136, drift는 없었다. 동일한 검증 실행에서
`AMUX_EXPECT_DB_TIMEZONE=Australia/Brisbane`을 명시해 조건부 assertion을 켰고,
공식 routing lane의 155/155 + 3/3 + 14/14 = **172/172**가 통과했다. 서버는
검증 뒤 중지했다. 이는 앞의 실행 기록을 대체하지 않고 assertion 증거를 추가한다.

이 재검증도 실제 staging 배포·runtime flag 관측·늦은 terminal `COMMIT`
배제·production activation의 증거가 아니다.

## Production/staging boundary

이 문서만으로 activation을 승인하지 않는다.

공식 staging verification에는 최소 다음이 필요하다.

1. staging에 실제 배포된 40-character source SHA
2. 배포 시점 clean worktree / build provenance
3. feature-OFF observation
4. scheduler selection-only observation
5. no claim / no execution / no delivery mutation confirmation
6. rollback procedure
7. explicit activation decision

PR 확인·병합 전에는 `Credit Finance DB Integration`의 `routing` matrix lane이
해당 head SHA에서 녹색인지 운영자가 직접 확인한다. 이 DB integration lane은
현재 required branch-protection context가 아니므로 required `PR Fast Gate`가
녹색이어도 이 확인을 대신하지 못한다. 누락·실패·다른 SHA 결과면 Phase A 병합
판정을 보류한다. 이 문장은 CI 설정을 required로 변경했다는 뜻이 아니다.

## Rollback

현재 가장 강한 rollback은 feature-OFF다.

- `TOMVERSE_AMUX_EXECUTE` 제거 또는 `1` 이외 값
- `TOMVERSE_AMUX_EXECUTION_API_ENABLED` 제거 또는 `1` 이외 값
- 필요 시 `TOMVERSE_AMUX_ENABLED` 제거

`execution_ready=false`가 유지되는 동안 server-side claim lifecycle은 fail-closed 상태다.

실제 production activation 전에는 별도 canonical deployment/rollback procedure를
staging record에 기록한다.
