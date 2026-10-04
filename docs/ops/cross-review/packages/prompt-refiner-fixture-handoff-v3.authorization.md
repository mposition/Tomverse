# Prompt Refiner fixture handoff 최종 후속 Claude 검토 제한 승인

사용자는 권장 순서 자동 개발, 필요한 Claude 독립 검토, `--skip-preflight`
예외 및 지속적인 수정 작업을 승인했다. 이 문서는 그 지시를 기록한 것이며
사용자 서명, 검토 통과, 제품 실행, 유료 호출, 병합 또는 배포 승인은 아니다.

v1과 v2 exchange는 각각 `on_hold (revisions_exhausted)`로 종결됐고
재개·수정하지 않는다. [v3 task](prompt-refiner-fixture-handoff-v3.task.json)는
v2의 유일한 미해결 지적을 `supersedes`로 이어받는다. 이는
`MAX_SUPERSESSIONS=2`가 허용하는 마지막 후속 exchange다. 이후에도
지적이 남으면 새로운 task 이름으로 상한을 우회하지 않는다.

reviewer는 저장된 `claude.ai` Max 구독 CLI만 사용한다. review process의
`ANTHROPIC_*`, `CLAUDE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` 및
Bedrock/Vertex/Foundry 전환 변수는 제거한다. 인증 상태가 Max가 아니면
중단한다. `claude --print --safe-mode --output-format json --tools
Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`의
읽기 전용 제한과 사용자 승인 `--skip-preflight`만 적용한다. Anthropic API,
`--review-despite-check-failures`, 추가 유료 benchmark, provider 호출,
stage/run 승인, flag 전환, 실제 traffic 활성화, 자동 병합·배포는 금지한다.

v2 authorization의 Playwright JSON은 product source와 E2E spec이 현재와
같았을 때의 author 실행 결과다. 그 이후 v3에서는 독일어 금지어를 검사하는
React render test만 고쳤다. Claude가 브라우저를 직접 실행했다고 주장하지
않으며, 이 검토 패키지는 단위·렌더 테스트와 guard를 새 digest에 다시 실행한다.
