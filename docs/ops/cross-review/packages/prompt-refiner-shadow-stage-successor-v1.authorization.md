# Prompt Refiner immutable stage successor v1 독립 검토 승인 기록

- approvedBy: `mposition`
- approvedAt: `2026-09-28` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `claude-code-max`
- reviewedHead: `401643f926a2651e0d74df39c06d656ffca62738`
- baseCommit: `b840c817a505da0bf4e54b279d9bba09b95999c7`

사용자는 CHAT-01을 완료할 때까지 권장 순서로 자동 개발하고 독립 검토가 필요할 때
Claude 검토를 받도록 지시했다. 이 작업의 Claude 검토에 `--skip-preflight` 예외도
승인했다. 이 문서는 전자서명, 검토 통과, provider 실행, 비용 지출, 배포 또는 제품
노출 승인이 아니다.

## 적용 범위

이번 승인은 immutable `prompt-refiner-shadow-v2` stage가 downstream run·execution flag가
꺼진 배포에서 먼저 만들어진 뒤 flag 활성화 재배포로 exact deployment 결속이 달라져
재사용할 수 없게 된 순서 오류를 닫는 successor 변경의 읽기 전용 검토에만 적용한다.
기존 v2 기록은 audit evidence로 보존하고, 새 v3 stage/v5 run identity와 두 flag의
선행 conjunction gate를 검증한다.

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. child 환경에서
  `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 대소문자와 무관하게 제거하고,
  `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`,
  `subscriptionType=max`를 호출 직전에 확인한다. 실패하면 API 방식으로 전환하지 않는다.
- reviewer는 Read/Grep/Glob만 사용하고 shell, write, hook, plugin, skill, MCP를 사용할
  수 없다. `--skip-preflight`는 이 도구 제한 때문에 write-refusal probe를 증명할 수 없는
  환경 제약만 우회하며 test·guard 실패를 우회하지 않는다.
- 독립 검토는 provider/model 호출, Railway 변경, database mutation, stage/run 승인,
  flag 활성화, 유료 shadow 실행, 제품 Prompt Refiner 노출, Router 결합, push·merge·deploy를
  포함하지 않는다.
