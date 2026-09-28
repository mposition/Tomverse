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

## Railway 별도 검증 서비스의 SHA fence

2026-09-21 별도 서비스 생성 시 source 설정은 AMUX 브랜치였지만 첫 deployment는
저장소 기본 `main` SHA로 시작됐다. source 설정이나 create 응답을 배포 SHA의
증거로 삼지 않는다. 새 서비스에는 공개 도메인을 만들지 않고, 처음에는 DB URL과
인증 비밀을 비운 채 pre-deploy migration도 두지 않는다. Railway deployment의
실제 `branch`·전체 `commitHash`를 확인한 뒤에만 staging DB 참조와 migration을
설정한다. 잘못된 SHA의 배포는 검증 기록에 합격 증거로 넣지 않는다.

같은 날 확인한 `redeploy`는 최신 source SHA를 유지했지만, 서비스 설정에서 바꾼
pre-deploy/start 명령의 실행 로그가 없었다. 재배포 성공만으로 새 명령이 실행됐다고
판정하지 않는다. 명령 변경을 검증할 때는 GitHub 브랜치 push로 새 source-trigger
배포를 만들고, 실제 deployment SHA와 migration·capture 로그를 함께 확인한다.

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
