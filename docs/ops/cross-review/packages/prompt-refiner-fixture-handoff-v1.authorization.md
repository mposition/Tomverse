# Prompt Refiner fixture handoff Claude 독립 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 이 문서는 사용자 전자서명이나
검토 통과, 제품 실행, 커밋, push, PR, 병합 또는 배포 승인이 아니다.

## 승인 문구와 적용 범위

사용자는 현재 작업을 권장 순서로 자동 진행하되, 독립 검토가 필요할 때 반드시
Claude에 요청하고 `--skip-preflight` 예외를 허용한다고 지시했다. 이 승인은
[검토 task](prompt-refiner-fixture-handoff-v1.task.json)의 fixture-only 변경에
대한 Claude 읽기 전용 독립 검토에만 적용한다. author는 Codex, reviewer는
Claude Code Max 구독 CLI이며 exact base는
`59e77abc8452bd30160e974752b2687cbc030a2d`다. 최초 검토와 필요한
후속 수정 검토의 동일한 읽기 전용 경계에 적용한다.

## 유지되는 경계

- Claude는 저장된 `claude.ai` Max 로그인을 사용한다. review child 환경에서
  대소문자와 관계없이 `ANTHROPIC_API_KEY` 및 `ANTHROPIC_AUTH_TOKEN`을 제거하고,
  로그인 확인 실패 시 API key 방식으로 전환하지 않는다.
- 실행 도구는 `claude --print --safe-mode --output-format json --tools
  Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`로 제한한다.
  shell·write·추가 MCP·hook·model override는 허용하지 않는다.
- `--skip-preflight`는 쓰기 거부 probe가 이 도구 제한에서 증명 불가능하다는
  예외 기록이다. `--review-despite-check-failures`나 test/CI 우회는 허용하지 않는다.
- fixture 밖의 제품 provider/R2/Railway 호출, credential 조회, 유료 벤치마크,
  stage/run 승인, flag 변경, 실제 Chat traffic 활성화는 포함하지 않는다.
- 산출물은 추적되지 않는 `artifacts/cross-review/prompt-refiner-fixture-handoff-v1/`
  에 두고 검토 diff에서 그 정확한 디렉터리만 제외한다. source/test의 제외는 없다.
- `AGENTS.md`의 채택 후 `displayPrompt` 초안 수명 규칙은 제안문이 실제 제품
  composer에 적용되는 미래 제품 caller의 불변 조건이다. 현재 fixture의
  `accepted` decision은 제품 채택·전송 권한이 아니라 읽기 전용 미리보기 확인이며,
  composer는 `persistedUserPrompt` 원문을 유지한다. 따라서 fixture preview는
  원문이 바뀌면 폐기한다. 이 차이를 제품 caller의 규칙 변경이나 제품 노출
  승인으로 해석하지 않는다. 이 기록은 `AGENTS.md`를 수정하지 않는다.

## 검증 기록과 관측 한계

- 패키지 controller가 순수 validator 11/11 및 React render 10/10 테스트를
  두 Node condition으로 분리해 직접 실행했다. `git diff --check`와 변경 source·test
  경로의 targeted ESLint도 controller guard로 직접 통과했다.
- 구현 담당자는 loopback webpack dev 서버에서
  `tests/e2e/prompt-refiner-chat-input.spec.ts` 전체 14/14 통과와 서버 종료를
  보고했다. 별도 검증자는 `test-results/.last-run.json`의
  `status=passed`, `failedTests=[]`를 직접 읽고 해당 spec의 14개 test 목록을
  확인했지만 브라우저 E2E 자체는 재실행하지 않았다. 원 실행 명령과 전체 로그는
  보존되지 않았으므로 독립 실행 결과로 주장하지 않는다.
- round 0 지적 수정 뒤 같은 loopback webpack dev 환경의 첫 전체 E2E는
  13/14였다. 실패한 한 건은 변경된 submit assertion 이전의 기존 `ready`
  5초 대기에서 cold compile 중 시간 초과했고, 그 테스트의 단독 재실행은
  1/1 통과했다. 워밍된 서버의 전체 재실행은 14/14 통과했으며 담당자가
  서버를 종료했다. 이는 담당자 실행 기록이고 별도 검증자의 독립 E2E 실행은 아니다.
- round 1 지적 수정 뒤 Codex 주 에이전트가 외부 네트워크를 차단한 loopback
  `next dev --webpack` 서버에서 `npx playwright test
  tests/e2e/prompt-refiner-chat-input.spec.ts --project=desktop-chromium
  --workers=1 --retries=0`를 직접 실행했다. cold 전체 실행은 기존 `ready`
  5초 대기에서 13/14였고, 해당 대기를 30초로 한정해 고친 뒤 warm 전체
  재실행은 14/14였다. `test-results/.last-run.json`은 `status=passed`,
  `failedTests=[]`이며 서버를 종료하고 3100 LISTEN 부재를 확인했다.
- Windows 로컬 `tsc`는 변경 경로 밖의 Next 생성 assistant-profiles export
  오류가 base에서도 재현되어 통과 증거로 기록하지 않는다. exact base
  `59e77abc8452bd30160e974752b2687cbc030a2d`의 Linux GitHub Admin Console
  E2E check는 성공했고 워크플로에 `npm run build` 단계가 있지만, 이는 새
  미커밋 diff 자체의 Linux build 검증을 대신하지 않는다.
