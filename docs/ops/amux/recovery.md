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
