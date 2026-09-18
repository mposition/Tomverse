# Prompt Refiner durable stage writer Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 승인을 기록한다. 사용자 메시지의 시각은 기록하거나
추정하지 않는다. 이 문서는 전자서명, 검토 통과, 구현 승인, 커밋·푸시·병합·배포
또는 유료 실행 승인이 아니다.

## 승인 문구와 적용 범위

현재 대화에서 사용자는 다음과 같이 지시했다.

> 네 권장 순서로 자동으로 진행해주세요. 단, 독립 검토 필요시에는 꼭 Claude에 요청해주세요. --skip-preflight 예외 또한 승인합니다.

이 승인은
[검토 task](prompt-refiner-durable-stage-writer-v1.task.json)에 정의된 새 exchange의
Claude 읽기 전용 독립 검토에만 적용한다. author는 Codex, reviewer는 Claude이고
supersedes는 없다. exact base는
`c49d5a3606f259356612ddc5872f29f5fe465158`, 독립 검토에 제출할 구현 source는
`738e029efb9f7610dfafb9237453d7a821fa479a`다. writable scope는 base 대비 구현
변경 30개와 이 task/authorization 2개를 합친 exact 32개 경로이고
`generatedPaths`는 비어 있다.

승인 범위의 목표는 final runtime closure 186개가 TypeScript/JavaScript 177개와
고정 metadata/config/migration 9개로 정확히 구성되는지, fresh PostgreSQL 17에서
124 migrations·drift 0·DB integration 35개·audit contract 19개·route contract
6개가 통과하는지, stage가 default-off이며 provider·API·제품 caller·실제 지출
경로가 0인지 독립적으로 검토하는 것이다. 이 수치는 검토 요구사항이지 이 문서가
그 결과를 인증한다는 뜻이 아니다.

## 유지되는 경계

- Claude는 저장된 Claude Max `claude.ai` 로그인으로
  `claude --print --safe-mode --output-format json --tools Read,Grep,Glob
  --allowedTools Read,Grep,Glob --strict-mcp-config`를 사용한다. 모델 override,
  shell·write 도구 또는 추가 MCP 접근은 허용하지 않는다.
- review child 환경 복사본에서 모든 대소문자 표기의 `ANTHROPIC_API_KEY`와
  `ANTHROPIC_AUTH_TOKEN`을 제거하고 sanitized `claude auth status`가
  `authMethod=claude.ai`, `subscriptionType=max`임을 확인한다. 확인 실패 시 API
  key 방식으로 전환하지 않고 중단하며 parent 환경과 영구 설정은 바꾸지 않는다.
- `--skip-preflight`만 허용한다. 이는 쓰기 거부 probe를 실행하지 않은 사실을
  skip으로 기록하는 예외이며 preflight 통과나 쓰기 불가능성의 증거가 아니다.
  `--review-despite-check-failures`와 테스트·CI 우회는 금지한다.
- 최초 검토와 actionable finding 대응 후 최대 두 번의 수정 검토만 허용한다.
  상한에서 지적이 남으면 `on_hold`로 종결하고 새 exchange, supersedes 또는
  override로 revision 상한을 우회하지 않는다.
- 패키지와 guard가 모두 통과한 exact base-to-source diff만 검토한다. 30개 구현
  경로 또는 두 승인 기록을 diff에서 제외하지 않으며 package digest와 구현 source
  SHA가 일치하지 않으면 검토를 실행하지 않는다.
- provider/model 호출, external API 또는 Railway 관리 API 호출, credential 조회,
  제품 caller·flag·rollout 연결, 실제 reservation/receipt/dispatch, 유료 실행과
  실제 지출은 승인하지 않는다. stage는 `executionAdmitted=false` 및
  `productAdapterReady=false`인 default-off 상태를 유지한다.
- push·merge·deploy와 production/staging mutation은 승인하지 않는다. 이 두 기록의
  작성·검증·커밋은 독립 검토 실행이나 검토 결과를 뜻하지 않는다.
