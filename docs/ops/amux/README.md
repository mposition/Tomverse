# AMUX Operations

이 디렉터리는 Tomverse AMUX 운영 기록의 canonical location이다.

AMUX의 현재·미래 개발 source of truth는 이 저장소다. Frozen upstream
reference는 provenance와 semantic comparison에만 사용하며, Tomverse source
tree에 upstream Git history를 합치지 않는다.

포함 대상:

- staging 검증 결과
- rollout checklist
- rollback 절차
- scheduler decision samples
- incident / recovery 기록
- production activation 기록

Production mutation 전에는 다음을 확인한다.

1. source commit identity
2. clean worktree
3. targeted tests
4. scheduler feature flag 상태
5. classifier cadence 상태
6. rollback artifact / procedure

## Staging verification

- architecture와 repository boundary: `architecture.md`
- frozen reference provenance: `reference-baseline.md`
- legacy local branch migration audit: `local-branch-migration.md`
- staging 진입점과 activation 순서: `staging.md`
- checklist: `staging-checklist.md`
- preflight/local evidence: `staging-readiness.md`
- executor wrapper contract: `executor-protocol.md`
- immutable run records: `staging-verification-records/`
- verification index: `verification/README.md`
- recovery와 rollback: `recovery.md`

실제 run record는 staging이 실제로 서빙하는 전체 40자리 SHA를 확인한 뒤에만
생성한다.

## Canonical card read-back

`GET /api/admin/amux/card?sourceKey=<canonical-key>`는 인증된 Admin이 AMUX의
canonical private-workboard source의 현재 카드 한 건을 읽는 경계다. 조회는 board
import 계약의 고정 `sourceSystem`과 요청의 `sourceKey`를 함께 사용한다. `sourceKey`는
대소문자·공백을 정규화하지 않고 정확히 한 번만 받아야 하며, composite identity가
중복되면 임의로 한 건을 고르지 않고 `409`로 닫힌다. 다른 source system의 동명
카드는 이 endpoint의 대상이 아니다. 이 경로는 audit, rate bucket, preview,
transaction 또는 AMUX writer를 호출하지 않으며 모든 응답은 `private, no-store`다.

응답은 현재 status·priority, 불변 import metadata, accepted source revision,
dependency 상태만 포함한다. Source snapshot과 revision에는 원문 목표가 아니라
section·version·digest만 저장된다. 따라서 `remainingGoal.availability`은
`not_stored`, representation은 `detail_digest_only`다. 이는 목표가 비어 있거나
알 수 없다는 추정이 아니라, 이 스키마에 원문이 저장되지 않았다는 명시적 계약이다.
Accepted revision은 현재 카드 소유 여부까지 검증하며 dependency는 256개를 넘거나
source identity의 null 쌍·형식이 일관되지 않으면 응답 전체를 fail-closed 처리한다.
