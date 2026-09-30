# Prompt Refiner shadow evidence gate 후속 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 Tomverse Chat 개발율 100%까지
권장 순서에 따른 자동 진행, 독립 검토가 필요할 때 Claude 검토, 이 작업의
`--skip-preflight` 예외와 수정 round 상한 없음을 승인했다. 이 문서는 전자서명,
검토 통과, provider 실행, 비용 또는 배포 승인이 아니다.

## 적용 범위

- 대상은 [task](prompt-refiner-shadow-evidence-gate-followup-v2.task.json)가 정한
  exact diff와 후속 수정본의 Claude Code Max 읽기 전용 검토다.
- 선행 exchange의 `on_hold (revisions_exhausted)`와 원본 verdict는 그대로 보존한다.
  이번 successor는 두 open finding을 새 digest에서 닫기 위한 별도 기록이다.
- 새 exchange 상한에 닿아도 finding을 무시하지 않고 사용자의 지시에 따라 새 검토
  기록으로 계속한다.

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. child 환경에서
  `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 제거하고 `loggedIn=true`,
  `authMethod=claude.ai`, `apiProvider=firstParty`, `subscriptionType=max`를 확인한다.
- reviewer는 Read/Grep/Glob만 사용하고 shell, write, hook, plugin, skill, MCP를
  사용할 수 없다. 사용자 승인 `--skip-preflight`만 환경 제약 예외로 기록한다.
- test/guard 실패 우회, provider/model 호출, Railway 변경, database mutation,
  stage/run 승인, flag 활성화, 유료 shadow 실행, 제품 UI 또는 Router 활성화는
  이 검토에 포함하지 않는다.
