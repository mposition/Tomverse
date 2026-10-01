# Prompt Refiner runtime closure 정책 문서 동기화 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 중단된 자동 개발을 이어서
마무리하도록 요청했고, 앞선 지시에서 독립 검토가 필요하면 Claude에 요청하며
`--skip-preflight` 예외를 허용했다. 이 문서는 전자서명, 제품 실행 승인 또는 검토
통과 기록이 아니다.

## 적용 범위

이 승인은
[검토 task](prompt-refiner-durable-stage-writer-policy-doc-sync-v2.task.json)에 정의된
마지막 continuation exchange의 Claude 읽기 전용 독립 검토에만 적용한다. 앞선 두
exchange의 `on_hold` 기록과 finding은 그대로 보존한다.

## 유지되는 경계

- Claude는 저장된 Claude Max `claude.ai` 로그인으로 `claude --print --safe-mode
  --output-format json --tools Read,Grep,Glob --allowedTools Read,Grep,Glob
  --strict-mcp-config`를 사용한다. shell, write, 추가 MCP, 모델 override는 허용하지 않는다.
- review child 환경에서 `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고
  `claude auth status --json`이 `authMethod=claude.ai`, `subscriptionType=max`임을
  확인한다. 실패하면 API key 방식으로 전환하지 않는다.
- `--skip-preflight`만 허용하며 `--review-despite-check-failures`와 test/CI 우회는
  금지한다.
- 최초 검토와 actionable finding 대응 후 최대 두 번의 수정 검토만 허용한다.
- product database, provider/model 호출, external 또는 Railway API, credential 조회,
  stage mutation, flag/rollout, 유료 실행과 실제 지출은 승인하지 않는다.
- 이 기록의 작성·검증·커밋은 push, merge 또는 deploy 승인이 아니다.
