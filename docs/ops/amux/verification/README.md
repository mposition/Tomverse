# AMUX Verification Index

이 디렉터리는 AMUX 검증 자료의 색인이다. 같은 실행 결과를 두 위치에 복제하지
않는다.

| Evidence | Canonical location |
|---|---|
| frozen upstream identity와 regression | `../reference-baseline.md` |
| local/preflight 결과 | `../staging-readiness.md` |
| staging checklist | `../staging-checklist.md` |
| 실행별 staging record와 template | `../staging-verification-records/` |
| runtime wrapper contract | `../executor-protocol.md` |
| rollback/recovery | `../recovery.md` |

새 staging 실행 기록은 repository-wide record validator가 추적하는
`staging-verification-records/`에만 생성한다. 이 index에는 실제로 존재하고
검증된 evidence만 연결하며, 실행하지 않은 관측을 작성하지 않는다.
