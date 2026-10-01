# Prompt Refiner shadow execution runner 후속 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 이 문서는 전자서명, 제품 실행 승인,
비용 승인 또는 검토 통과 기록이 아니다.

## 승인 문구와 적용 범위

기존 exchange가 수정 상한을 소진해 `on_hold`로 종결된 뒤, Codex는 기존 기록을
보존하고 마지막 세 finding을 successor exchange에서 수정·검증·검토하겠다고
설명했다. 사용자는 현재 대화에서 다음과 같이 지시했다.

> 네 이어서 해주세요

사용자는 앞선 동일 자동개발 지시에서 독립 검토가 필요하면 Claude에 요청하고
`--skip-preflight` 예외를 허용했다. 이 승인은
[검토 task](prompt-refiner-shadow-execution-runner-followup-v2.task.json)에 정의된
successor exchange의 Claude 읽기 전용 독립 검토에만 적용한다. 기존 v1 exchange와
verdict는 수정하지 않는다.

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인으로 `claude --print
  --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools
  Read,Grep,Glob --strict-mcp-config`를 사용한다. shell, write, 추가 MCP, 모델
  override는 허용하지 않는다.
- review child 환경에서 대소문자와 무관하게 `ANTHROPIC_API_KEY`와
  `ANTHROPIC_AUTH_TOKEN`을 제거하고, `claude auth status --json`이
  `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`,
  `subscriptionType=max`임을 확인한다. 실패하면 API key 방식으로 전환하지 않는다.
- `--skip-preflight`만 허용하며 `--review-despite-check-failures`와 테스트·CI
  우회는 금지한다. 최초 검토와 actionable finding 대응 후 최대 두 번의 수정
  검토만 허용한다.
- Prompt Refiner provider/model 호출, external 또는 Railway API, credential 조회,
  stage/run mutation, flag/rollout, 유료 실행과 실제 지출은 승인하지 않는다.
- 이 기록의 작성·검증·커밋은 검토 통과, push, merge 또는 deploy 승인이 아니다.
