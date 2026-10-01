# Chat 완료 Message 메타데이터 복구 Claude 독립 검토 제한 승인

Codex가 2026-09-14 현재 대화에서 받은 사용자 승인을 기록한다. 이 문서는
사용자 메시지의 전자서명, 검토 통과, 커밋·푸시·병합·배포 또는 출시 승인이 아니다.

## 승인 문구와 적용 범위

Codex가 사용자에게 다음과 같이 물었다.

> 이번 `chat-durable-message-metadata-recovery-v1` Claude 읽기 전용 검토에 한해
> `--skip-preflight` 예외를 허용하시겠습니까? Read·Grep·Glob 제한과 테스트
> 게이트는 유지하며, 공급자 호출·과금·배포는 포함하지 않습니다.

사용자는 다음과 같이 답했다.

> 네 허용합니다

이 승인은
[검토 task](chat-durable-message-metadata-recovery-v1.task.json)에 정의된 새
exchange의 최초 검토와 actionable finding 대응 후 최대 두 번의 수정 검토에만
적용한다. author는 Codex, reviewer는 Claude이고 base는
`ec043cf79e3a044973e5f6466483710ef4969ea2`다. 출력은 git이 추적하지 않는
`artifacts/cross-review/chat-durable-message-metadata-recovery-v1/`에 둔다.

## 유지되는 경계

- Claude는 `--print --safe-mode --output-format json --tools Read,Grep,Glob
  --allowedTools Read,Grep,Glob --strict-mcp-config`로 실행한다. shell·write 도구,
  모델 override와 추가 MCP 접근을 허용하지 않는다.
- `--skip-preflight`는 Claude의 허용 도구로 쓰기 거부 probe를 입증할 수 없다는
  사실을 skip으로 기록하는 예외다. preflight 통과나 쓰기 불가능성의 증거가 아니며
  `--review-despite-check-failures`와 테스트·CI 우회를 허용하지 않는다.
- review child 환경에서만 모든 대소문자 표기의 `ANTHROPIC_API_KEY`를 제거하고
  저장된 claude.ai 로그인을 사용한다. 로그인 확인 실패 시 API key 방식으로
  전환하지 않으며 parent 환경과 영구 설정을 바꾸지 않는다.
- 최초 검토와 최대 두 번의 수정 검토만 허용한다. 마지막 라운드에 재현 가능한
  actionable finding이 남으면 `on_hold`로 종결하고 같은 exchange를 다시 열지 않는다.
- 실제 provider·R2·Railway 호출, API 과금, 유료 benchmark, flag·Router·가격·품질
  band 변경, push·merge·deploy는 이 승인에 포함되지 않는다.
- 패키지 테스트나 guard가 실패하면 Claude 검토를 실행하지 않는다. 독립 검토도
  Linux CI, staging·production 검증 또는 사람의 출시 승인을 대신하지 않는다.
