# AMUX Staging Readiness

이 문서는 실제 staging verification record가 아니다.

실제 staging 배포 SHA가 생기기 전까지의 preflight evidence만 기록한다.

## Current safety posture

- `TOMVERSE_AMUX_ENABLED`: off / unset
- `TOMVERSE_AMUX_EXECUTE`: off / unset
- `TOMVERSE_AMUX_EXECUTION_API_ENABLED`: off / unset
- `TOMVERSE_AMUX_WORKER_CATALOG_JSON`: unset
- `TOMVERSE_AMUX_EXECUTOR_COMMANDS_JSON`: unset
- server routing `execution_ready=false`

## Verified locally

- AMUX core tests: 234/234
- orchestrator tests: 32/32
- AMUX DB orchestration tests: 21/21
- admin audit integrity walk: 5/5
- admin audit core/key tests: 14/14
- execution start and durable delivery commit atomically
- expired delivery receipt rotates
- stale/expired receipt ACK is fenced
- no separate delivery enqueue mutation surface
- provider command is operator-configured and shell-free
- worker fence loss quarantines the worker without automatic re-registration
- execute-off path precedes executor configuration

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

## Rollback

현재 가장 강한 rollback은 feature-OFF다.

- `TOMVERSE_AMUX_EXECUTE` 제거 또는 `1` 이외 값
- `TOMVERSE_AMUX_EXECUTION_API_ENABLED` 제거 또는 `1` 이외 값
- 필요 시 `TOMVERSE_AMUX_ENABLED` 제거

`execution_ready=false`가 유지되는 동안 server-side claim lifecycle은 fail-closed 상태다.

실제 production activation 전에는 별도 canonical deployment/rollback procedure를
staging record에 기록한다.
