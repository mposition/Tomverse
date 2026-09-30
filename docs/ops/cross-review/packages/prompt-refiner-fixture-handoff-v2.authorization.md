# Prompt Refiner fixture handoff 후속 Claude 검토 제한 승인

Codex가 현재 대화의 사용자 지시를 기록한다. 이 문서는 사용자 전자서명이나
검토 통과, 제품 실행, commit, push, PR, 병합 또는 배포 승인이 아니다.

사용자는 권장 순서의 자동 개발과 필요한 Claude 독립 검토를 지시했고
`--skip-preflight` 예외 및 수정 round 상한 없는 지속 작업을 승인했다. 다만
control program의 v1 exchange는 `on_hold (revisions_exhausted)`로 종결되어
다시 열 수 없다. [v2 task](prompt-refiner-fixture-handoff-v2.task.json)는
`supersedes`로 그 결론·미해결 지적 6건을 이어받는 첫 후속 exchange다.
이 기록은 control program의 round/후속 chain 상한을 제거하지 않는다.

Claude reviewer는 저장된 `claude.ai` Max 구독 CLI만 사용한다. review child
환경에서 `ANTHROPIC_*`, `CLAUDE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` 및
Bedrock/Vertex/Foundry 전환 변수를 제거하고, 인증 상태가 Max가 아니면
중단한다. Read/Grep/Glob only, `--safe-mode`, `--strict-mcp-config`와
`--skip-preflight`만 허용한다. `--review-despite-check-failures`, test/CI
우회, API key fallback, 별도 Anthropic API, provider 호출은 허용하지 않는다.

fixture의 `accepted`는 제품 채택·전송 권한이 아닌 읽기 전용 미리보기
확인이다. 이 경계에서 composer와 durable draft는 사용자가 쓴 원문을
유지한다. 따라서 resolution의 `displayPrompt`는 실제 composer와 같은
원문이고, `executionPrompt`에만 합성 제안문을 둔다. caller는 `AGENTS.md`의
규칙대로 composer가 `displayPrompt`와 달라지는 즉시 resolution을 폐기한다.
scope/mode 변경도 폐기한다. 이 기록은 규칙을 바꾸거나 fixture를 제품에
노출하지 않는다.

유료 benchmark, stage/run 승인, flag 전환, 실제 사용자 traffic 활성화,
자동 PR 병합·배포는 이 검토 범위 밖이다. 검토 산출물은 추적되지 않는
`artifacts/cross-review/prompt-refiner-fixture-handoff-v2/`에 보존한다.

## round 2 브라우저 검증 기록

Codex 주 에이전트가 2026-09-21에 외부 네트워크를 차단한 loopback
`next dev --webpack --hostname 127.0.0.1 --port 3100` 서버에서 직접 실행했다.
명령은 `npx playwright test tests/e2e/prompt-refiner-chat-input.spec.ts
--project=desktop-chromium --workers=1 --retries=0 --reporter=json`이다.
`PLAYWRIGHT_JSON_OUTPUT_FILE`은 검토 산출물 디렉터리의
`playwright-round2.json`으로 지정했다. 해당 파일의 SHA-256은
`7cce7c6c395189b6988adf851c5d65b279fb43fe1b5f5c320b78c825f2ffbbf3`이다.
JSON `stats`는 expected 14, unexpected 0, skipped 0, flaky 0이고,
CLI 종료 코드는 0이다. 테스트 서버를 종료하고 port 3100 LISTEN 부재를
확인했다. 이 결과는 author의 직접 실행이며 Claude가 브라우저를 실행한
결과가 아니다. 서버 프로세스의 외부 네트워크 호출은 로컬 guard로
차단했고, fixture 경로는 공급자를 호출하지 않는다.

JSON에 기록된 14개 spec 제목은 순서대로 다음과 같다.

1. default-off server decision renders no disabled teaser
2. both explicit decisions return focus and never submit
3. accepted preview leaves authored draft intact and cannot be re-requested
4. restored accepted fixture draft cannot submit after a conversation switch
5. accepted fixture draft cannot seed the Image workspace
6. accepted preview never writes synthetic text to durable drafts or survives mode-off reload
7. editing during the fixture request discards the late result
8. the same draft in another conversation cannot inherit a ready proposal
9. starting a new chat aborts and discards a pending proposal
10. an invalid fixture response fails closed and retry recovers
11. a maximum-length legal draft receives a bounded proposal
12. IME composition blocks mutation without resizing the status copy
13. 320px and 200% text keeps proposal and actions inside the composer
14. 200% page zoom equivalent keeps proposal and actions inside the composer

기존 ChatApp의 last-prompt가 남은 상태에서 fixture mode로 전환해 retry를
클릭하는 특수 조합은 이 브라우저 14건에 없다. 해당 경계는 ChatApp의 retry·
follow-up·payload send 모두 `onBeforeSend`를 통과하는 코드 경로와
`ChatPageClient`의 fixture-only false 장벽으로 검토한다. 이 구조적 검토를
브라우저 실행으로 오인하지 않는다.
