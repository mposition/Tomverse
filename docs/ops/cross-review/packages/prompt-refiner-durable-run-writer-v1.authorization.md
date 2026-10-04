# Prompt Refiner durable run writer Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 권장 순서의 자동 진행,
필요한 Claude 독립 검토와 이 작업에 대한 `--skip-preflight` 예외를 승인했다.
이 문서는 전자서명, 제품 실행 승인, 비용 승인, push·merge·deploy 승인이 아니다.

## 적용 범위

이 승인은
[검토 task](prompt-refiner-durable-run-writer-v1.task.json)에 정의된 Codex 작성 변경의
Claude 읽기 전용 독립 검토에만 적용한다. 최초 검토와 actionable finding 대응 후
최대 두 번의 수정 검토를 허용한다.

## 유지되는 경계

- reviewer는 로컬 Claude Code CLI와 저장된 Claude Max `claude.ai` 로그인을 사용한다.
  child 환경에서 `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고,
  `claude auth status --json`이 `authMethod=claude.ai`, `subscriptionType=max`임을
  확인한다. 실패하면 API key 방식으로 전환하지 않는다.
- Claude는 `--print --safe-mode --output-format json --tools Read,Grep,Glob
  --allowedTools Read,Grep,Glob --strict-mcp-config`의 읽기 전용 경계만 사용한다.
- `--skip-preflight`만 허용한다. `--review-despite-check-failures`, 테스트·CI 우회,
  reviewer write·shell·MCP·hook 권한 확대는 허용하지 않는다.
- Prompt Refiner provider 호출, Railway 또는 외부 API 호출, credential 조회, 실제 stage/run
  승인, flag 활성화, 유료 실행과 제품 Chat 연결은 승인하지 않는다.
- 검토 기록은 package digest에 결속하고, 수정 라운드 상한 뒤 actionable finding이 남으면
  `on_hold`로 끝낸다.
