# AMUX Operations

이 디렉터리는 Tomverse AMUX 운영 기록의 canonical location이다.

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

- frozen reference provenance: `reference-baseline.md`
- checklist: `staging-checklist.md`
- preflight/local evidence: `staging-readiness.md`
- executor wrapper contract: `executor-protocol.md`
- immutable run records: `staging-verification-records/`

실제 run record는 staging이 실제로 서빙하는 전체 40자리 SHA를 확인한 뒤에만
생성한다.
