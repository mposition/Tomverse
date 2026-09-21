# Prompt Refiner confirmatory shadow v4 구현·검토 승인 기록

- approvedBy: `mposition`
- approvedAt: `2026-09-21` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `claude-code-max`

사용자는 Tomverse Chat 개발율 100%까지 권장 순서에 따라 자동 개발을 계속하도록
승인했고, 독립 검토가 필요할 때 Claude Code Max 검토를 받도록 지시했다. 이번 작업은
완료된 합성 shadow v3의 후속인 confirmatory v4 계약과 content-free evidence writer를
구현하는 범위다. Claude 검토의 `--skip-preflight` 예외와 수정 round 상한 없음도 승인됐다.

이 승인은 소스·migration·테스트·운영 문서 구현과 읽기 전용 독립 검토에만 적용한다.
provider 호출, Railway flag 변경, stage/run 승인, 유료 shadow 실행, 제품 Prompt Refiner
노출, Router 결합, rollout 또는 merge 권한으로 해석하지 않는다. 실제 v4 실행은 exact
배포·비용표와 별도 운영 승인을 다시 결속해야 한다.

Claude 호출은 저장된 `claude.ai` Max 구독만 사용한다. 호출 직전
`ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고 `loggedIn=true`,
`authMethod=claude.ai`, `apiProvider=firstParty`, `subscriptionType=max`를 확인한다.
reviewer는 Read/Grep/Glob 전용이며 source를 수정하지 않는다.
