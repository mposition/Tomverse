# Prompt Refiner 동일 인스턴스 fixture 후속 검토 승인 기록

- approvedBy: `mposition` (대화의 권장 순서 자동 개발 및 필요한 Claude 독립 검토 승인)
- approvedAt: `2026-09-22` (Australia/Brisbane, 후속 작업 시점)
- author: `codex`
- independentReviewer: `claude-code-max`
- task: [task.json](./task.json)

원 `prompt-refiner-same-instance-fixture-v1` exchange는 round 2에서 `approve`와
재현 가능한 nit 두 건을 남겼다. 두 건 모두 `unresolved_on_hold`이므로 control
program의 통과를 차단해 `on_hold(revisions_exhausted)`로 종료됐다. 원본
exchange와 review record의 바이트·상태는 수정하지 않는다. 두 로컬 checkpoint
commit 중 두 번째 `1f2115c6173b5ca2fb5e023f6a750243b0385cb1`을 후속
작업의 정확한 base로 고정한다. 이 successor는 원 exchange를 재개하거나
수정 round 상한을 초기화해 같은 기록을 덮는 것이 아니라, control program의
`supersedes` lineage에 결속된 별도 작업이다.

승인 범위는 E2E fixture 테스트 한 파일의 두 nit 수정, 로컬 무과금 검증,
새 package와 Claude Code Max 구독 CLI의 읽기 전용 독립 검토다. 사용자가
이번 작업에도 `--skip-preflight` 예외를 허용했다. Anthropic API 또는
provider 호출, 제품 mode·Router·flag 전환, stage/run 승인, 유료 실행,
실제 사용자 traffic, PR 자동 병합·배포는 승인 범위 밖이다.

검토 package는 정확한 base 뒤의 E2E 테스트와 이 task/authorization을
포함한다. 새 `records/`는 package 명령의 동일한 exact `--out` 및
`--diff-exclude` 경로로만 제외하며 `generatedPaths`에는 넣지 않는다.
Claude는 요구사항·diff를 먼저, 작성자 검증 기록을 다음에 검토한다. 저장된
Max 구독 CLI의 Read/Grep/Glob 제한과 사용자 승인 `--skip-preflight`
예외만 사용하며 API-key 환경 변수 fallback은 금지한다.
