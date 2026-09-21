# AMUX Staging

이 문서는 AMUX staging 검증의 진입점이다. Source integration, staging deploy,
feature activation, production activation은 서로 다른 결정이다.

## Required order

1. `reference-baseline.md`에서 frozen identity와 source provenance를 확인한다.
2. 배포할 Tomverse commit과 clean build provenance를 고정한다.
3. `staging-readiness.md`의 local/preflight evidence를 확인한다.
4. staging이 실제로 서빙하는 전체 40자리 SHA를 확인한다.
5. 모든 AMUX feature flag가 OFF인 상태를 먼저 관측한다.
6. `staging-checklist.md`를 실행하고 새 record를
   `staging-verification-records/`에 남긴다.
7. 별도 승인 전에는 scheduler, classifier, execution을 활성화하지 않는다.

## Canonical material

- 검증 항목과 blocking 기준: `staging-checklist.md`
- 배포 전 확인된 local evidence: `staging-readiness.md`
- 실행 wrapper 계약: `executor-protocol.md`
- 실행별 immutable record 규칙: `staging-verification-records/README.md`
- 전체 verification 색인: `verification/README.md`
- 실패와 rollback 절차: `recovery.md`

현재 source가 저장소에 존재하거나 CI가 green이라는 사실만으로 activation을
승인하지 않는다. 특히 `TOMVERSE_AMUX_ENABLED`, `TOMVERSE_AMUX_EXECUTE`,
`TOMVERSE_AMUX_EXECUTION_API_ENABLED`는 명시적인 staging 단계와 승인 없이
켜지 않는다.
