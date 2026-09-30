# Prompt Refiner secret-scan 후속 수정 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 승인을 기록한다. 사용자 메시지의 시각은 기록하거나
추정하지 않는다. 이 문서는 전자서명, 검토 통과, 구현 승인 또는 제품 실행 승인이
아니다.

## 승인 문구와 적용 범위

현재 대화에서 사용자는 다음과 같이 지시했다.

> 네 권장 순서로 자동으로 진행해주세요. 단, 독립 검토 필요시에는 꼭 Claude에 요청해주세요. --skip-preflight 예외 또한 승인합니다.

이 승인은
[검토 task](prompt-refiner-durable-stage-writer-secret-scan-fix-v1.task.json)에 정의된
새 exchange의 Claude 읽기 전용 독립 검토에만 적용한다. author는 Codex,
reviewer는 Claude이며 exact base는
`757c608f02fba306e454b07accdc14c977704557`, 검토할 구현 source는
`cb68d4da`이다. writable scope는 secret-scan 수정 2개 경로와 이 task 및
authorization 2개 경로인 exact 4개이고 generated paths는 비어 있다.

Round 0 digest
`sha256:668f656c0ff38991d310246ae9b2ae0299455d5f9cb4645df271c1cabaa4f679`은
`approve`였지만 재현 함수와 exact command를 주석에 직접 쓰라는 nit 1건이 열려
controller가 `awaiting_revision`으로 기록했다. Round 1은 그 문서성 지적만
보완하며 원래 사용자 승인과 검토 경계를 바꾸지 않는다.

## 유지되는 경계

- Claude는 저장된 Claude Max `claude.ai` 로그인으로 `claude --print
  --safe-mode --output-format json --tools Read,Grep,Glob --allowedTools
  Read,Grep,Glob --strict-mcp-config`를 사용한다. shell, write, 추가 MCP, 모델
  override는 허용하지 않는다.
- review child 환경에서 `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고
  `claude auth status --json`이 `authMethod=claude.ai`,
  `subscriptionType=max`임을 확인한다. 실패하면 API key 방식으로 전환하지 않는다.
- `--skip-preflight`만 허용하며 `--review-despite-check-failures`와 test/CI 우회는
  금지한다.
- 최초 검토와 actionable finding 대응 후 최대 두 번의 수정 검토만 허용한다.
- Prompt Refiner provider/model 호출, external 또는 Railway API, credential 조회,
  stage mutation, flag/rollout, 유료 실행과 실제 지출은 승인하지 않는다.
- 이 기록의 작성·검증·커밋은 검토 통과, push, merge 또는 deploy 승인이 아니다.
