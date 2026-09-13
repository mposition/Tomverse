# Chat 영속 초안·응답 복구 Claude 독립 검토 제한 승인

Codex가 2026-09-14 현재 대화의 사용자 승인을 읽고 기록했다. 이 날짜는
사용자 메시지의 전자서명이나 독립 검토 실행 시각이 아니며, 이 문서 자체도
검토 통과·커밋·푸시·병합·배포를 뜻하지 않는다.

## 승인 문구와 적용 범위

Codex가 사용자에게 다음과 같이 물었다.

> 이번 Chat 영속 초안·응답 복구 작업의 Claude 읽기 전용 독립 검토에 한해
> `--skip-preflight` 예외를 허용하시겠습니까? 최초 검토와 최대 2회 수정
> 검토에만 적용하며, Read·Grep·Glob 제한과 테스트 게이트는 유지하고 API
> 과금·실제 공급자 호출·실패 우회는 포함하지 않습니다.

사용자는 다음과 같이 답했다.

> 네 허용합니다

이 승인은
[검토 task](chat-durable-recovery-v1.task.json)에 정의된 새 exchange의 Claude
읽기 전용 검토에만 적용한다. author는 Codex, reviewer는 Claude이며, 정확한
base는 `c91a7c74a8e00e54fb8aeb73901116604f950cc5`다. 출력은
git이 추적하지 않는 `artifacts/cross-review/chat-durable-recovery-v1/`에 두고
해당 출력 디렉터리만 검토 diff에서 제외한다. 독립 검토가 종결된 뒤의 영구 기록
반영은 검토 대상 source와 분리한다. 기존 exchange를 재개하거나 revision 상한을
초기화하지 않는다.

## 유지되는 경계

- Claude는 `--print --safe-mode --output-format json --tools Read,Grep,Glob
  --allowedTools Read,Grep,Glob --strict-mcp-config`로 실행한다. shell·write 도구,
  모델 override, 추가 MCP 접근은 허용하지 않는다.
- `--skip-preflight`는 Claude의 도구 목록으로 쓰기 거부 probe를 입증할 수 없다는
  사실을 기록하는 예외일 뿐, preflight 통과나 쓰기 불가능성의 증거가 아니다.
  `--review-despite-check-failures`와 테스트·CI 우회는 금지한다.
- review child 환경에서만 모든 대소문자 표기의 `ANTHROPIC_API_KEY`를 제거하고
  저장된 claude.ai 로그인을 사용한다. 로그인 확인 실패 시 API key 방식으로
  전환하지 않고 중단한다. parent 환경과 영구 설정은 바꾸지 않는다.
- 최초 검토와 actionable finding 수정 후 최대 두 번의 수정 검토만 허용한다.
  상한에서 지적이 남으면 `on_hold`로 종결하고 새 exchange나 override로 우회하지
  않는다.
- 실제 provider·R2·Railway staging/production 호출, 유료 benchmark, flag 변경,
  배포, model score·품질 band 변경은 이 승인에 포함되지 않는다.
- 검토 패키지의 테스트와 guard가 하나라도 실패하면 검토를 실행하지 않는다.
  독립 검토 승인도 Linux CI·운영 DB·실제 provider 검증이나 사람의 출시 승인을
  대신하지 않는다.
