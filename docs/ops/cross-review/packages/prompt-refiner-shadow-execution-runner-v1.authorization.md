# Prompt Refiner shadow execution runner v1 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 승인을 기록한다. 사용자 메시지의 시각은 기록하거나
추정하지 않는다. 이 문서는 전자서명, 검토 통과, 유료 실행 승인, stage/run 생성,
provider 호출, flag 변경, push·병합·배포 승인이 아니다.

## 승인 문구와 적용 범위

현재 대화에서 사용자는 다음과 같이 지시했다.

> 권장 순서로 자동으로 진행해주세요. 단, 독립 검토 필요시에는 꼭 Claude에 요청해주세요. --skip-preflight 예외 또한 승인합니다.

작업이 중단된 뒤에는 다음과 같이 재개를 지시했다.

> 작업이 중단되었습니다. 이어서 자동개발해주세요.

이 승인은 같은 디렉터리의 task가 정의한 새 exchange에서 Claude Code Max 읽기 전용
독립 검토를 수행할 때 `--skip-preflight`를 쓰는 것에만 적용한다. 최초 검토와
actionable finding 대응 후 최대 두 번의 수정 검토까지다.

## 유지되는 경계

- 같은 child process에서 모든 대소문자 표기의 `ANTHROPIC_API_KEY`와
  `ANTHROPIC_AUTH_TOKEN`을 제거하고, 설치된 Claude Code의
  `claude auth status --json`이 `authMethod=claude.ai`, `subscriptionType=max`,
  `loggedIn=true`일 때만 실행한다. 실패하면 API key 방식으로 전환하지 않는다.
- Claude는 `--print --safe-mode --output-format json --tools Read,Grep,Glob
  --allowedTools Read,Grep,Glob --strict-mcp-config`만 사용한다.
- `--skip-preflight`는 쓰기 거부 probe를 실행하지 않은 사실을 기록하는 예외다.
  테스트·CI 실패 우회나 미해결 finding 무시가 아니다.
- provider/API/model 호출, credential 조회, stage·run·reservation·receipt mutation,
  유료 shadow/benchmark, 제품 flag·Router·UI 연결과 실제 지출은 승인하지 않는다.
- 패키지 digest와 source SHA가 일치하지 않으면 검토하지 않는다. revision 상한에서
  actionable finding이 남으면 `on_hold`로 끝내며 새 exchange로 우회하지 않는다.
