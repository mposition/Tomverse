# Prompt Refiner shadow evidence gate v1 Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 사용자는 Tomverse Chat 개발율 100%까지
권장 순서에 따른 자동 진행을 요청했고, 독립 검토가 필요할 때 Claude 검토를 반드시
받도록 지시했다. 이 작업의 `--skip-preflight` 예외와 수정 round 상한 없음도 승인했다.
이 문서는 전자서명, 검토 통과, provider 실행, 비용 또는 배포 승인이 아니다.

## 적용 범위

- 대상은 [task](prompt-refiner-shadow-evidence-gate-v1.task.json)가 정한 exact diff와
  그 후속 수정본의 Claude Code Max 읽기 전용 검토다.
- control program 한 exchange의 고정 상한에 닿아도 사용자의 지시는 미해결 finding을
  무시하라는 뜻이 아니다. 새 digest를 새 검토 기록으로 계속 검토하되, 통과 전에는
  원격 push·병합·배포하지 않는다.
- `--skip-preflight`는 Claude reviewer가 shell/write tool을 갖지 않아 probe path의
  쓰기 거부를 자체 증명할 수 없는 환경 제약만 우회한다.

## 유지되는 경계

- Claude는 저장된 Claude Code Max `claude.ai` 로그인만 사용한다. child 환경에서
  `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`을 대소문자와 무관하게 제거하고,
  `loggedIn=true`, `authMethod=claude.ai`, `apiProvider=firstParty`,
  `subscriptionType=max`를 호출 직전에 확인한다.
- reviewer는 Read/Grep/Glob만 사용하고 shell, write, hook, plugin, skill, MCP를
  사용할 수 없다. verdict는 package digest와 결속한다.
- test/guard 실패 우회, provider/model 호출, Railway 변경, database mutation,
  stage/run 승인, flag 활성화, 유료 shadow 실행, 제품 UI 또는 Router 활성화는
  이 검토에 포함하지 않는다.
