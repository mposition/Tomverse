# Prompt Refiner shadow 운영 화면 최종 정리 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 권장 순서에 따른 자동 진행과
필요한 Claude 독립 검토를 요청했고, 이 작업에 `--skip-preflight` 예외를 승인했다.
이 문서는 전자서명, 제품 실행 승인, 배포 승인 또는 검토 통과 기록이 아니다.

## 적용 범위

이 승인은 round 상한으로 `on_hold`가 된
`prompt-refiner-shadow-operator-ui-v1`의 단일 비차단 문구 nit와 EOF whitespace를
닫는 [후속 task](prompt-refiner-shadow-operator-ui-final-v2.task.json)의 Claude
읽기 전용 독립 검토에만 적용한다.

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. child 환경에서
  `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 대소문자와 무관하게 제거한다.
- reviewer는 Read/Grep/Glob만 사용하고 shell, write, hook, plugin, skill, MCP를
  사용할 수 없다. 사용자가 승인한 `--skip-preflight`만 기록한다.
- 실패 test/guard 우회, provider/model 호출, Railway 변경, database mutation,
  stage/run 승인, flag 활성화, 유료 shadow 실행, push·merge·deploy는 이 검토에
  포함하지 않는다.
