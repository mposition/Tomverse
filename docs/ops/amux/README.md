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
