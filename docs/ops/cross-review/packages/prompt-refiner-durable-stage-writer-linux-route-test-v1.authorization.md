# Prompt Refiner Linux route 테스트 수정 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 중단된 자동 개발을 이어서
마무리하도록 요청했고, 앞선 지시에서 독립 검토가 필요하면 Claude에 요청하며
`--skip-preflight` 예외를 허용했다. 이 문서는 전자서명, 제품 실행 승인 또는 검토
통과 기록이 아니다.

이 승인은
[검토 task](prompt-refiner-durable-stage-writer-linux-route-test-v1.task.json)에 정의된
Linux server-contract 테스트 로더 수정의 Claude 읽기 전용 독립 검토에만 적용한다.

- Claude는 저장된 Claude Max `claude.ai` 로그인과 `Read,Grep,Glob`만 사용한다.
- review child 환경에서 Anthropic API key 환경변수를 제거하고 Max 인증을 확인한다.
- `--skip-preflight`만 허용하며 test/CI 우회와 `--review-despite-check-failures`는 금지한다.
- 제품 route, database, provider/model, Railway, credential, stage, flag/rollout 및 유료
  실행은 승인하지 않는다.
- 최초 검토와 최대 두 번의 수정 검토만 허용한다.
