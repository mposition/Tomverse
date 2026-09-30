# Prompt Refiner shadow 운영 화면 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 권장 순서에 따른 자동 진행과
필요한 Claude 독립 검토를 요청했고, 이 작업에 `--skip-preflight` 예외를 명시적으로
승인했다. 이 문서는 전자서명, 제품 실행 승인, 배포 승인 또는 검토 통과 기록이 아니다.

## 적용 범위

이 승인은
[검토 task](prompt-refiner-shadow-operator-ui-v1.task.json)에 정의된 Prompt Refiner
shadow 운영 화면의 Claude 읽기 전용 독립 검토에만 적용한다. 최초 검토와 actionable
finding 대응 후 최대 두 번의 수정 검토에만 유효하다.

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. 실행 직전
  `claude auth status --json`이 `loggedIn=true`, `authMethod=claude.ai`,
  `apiProvider=firstParty`, `subscriptionType=max`임을 확인한다.
- child 환경에서 `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 대소문자와 무관하게
  제거한다. API key나 Anthropic API로 전환하지 않는다.
- reviewer는 `--print --safe-mode --output-format json --tools Read,Grep,Glob
  --allowedTools Read,Grep,Glob --strict-mcp-config`로만 실행한다. shell, write, hook,
  plugin, skill, MCP는 허용하지 않는다.
- `--skip-preflight`만 허용한다. 실패한 test/guard 우회, provider/model 호출,
  Railway 변경, database mutation, stage/run 승인, flag 활성화, 유료 shadow 실행,
  push·merge·deploy는 이 검토에 포함하지 않는다.
- 실제 shadow 실행은 별도로 동결된 16건·retry 0·US$0.398656 승인 경계와 owner의
  명시적 웹 조작을 따라야 한다. 이 검토 기록은 그 실행을 대신하지 않는다.
