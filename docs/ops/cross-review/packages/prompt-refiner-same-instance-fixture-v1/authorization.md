# Prompt Refiner 동일 인스턴스 fixture 회귀 독립 검토 제한 승인 기록

- approvedBy: `mposition` (대화에서 권장 순서 자동 진행·필요한 Claude 독립 검토·`--skip-preflight` 예외 승인)
- approvedAt: `2026-09-21` (Australia/Brisbane, 해당 대화의 승인 기록 기준)
- author: `codex`
- independentReviewer: `claude-code-max`
- task: [task.json](./task.json)

이 기록은 사용자 지시의 **검토 범위**를 명시한다. 사용자 전자서명이나 검토 통과,
제품 출시, 공급자 과금, commit·push·PR 병합·배포, stage/run 승인으로 해석하지 않는다.
이 작업은 이미 종결된 fixture handoff exchange를 재개하거나 revision 상한을
우회하지 않는 **별개의 동일 인스턴스 브라우저 회귀**다. cross-review control
program의 고정 수정 round 상한과 digest 검증은 그대로 적용한다.

검토 대상은 base commit `96a6990ee82cfa624affefac43e711a5244cd9ae` 이후
변경된 다섯 구현·테스트·UI 계약 파일 및 이 디렉터리의 task/authorization이다.
생성된 `records/`만 정확한 `--out` 경로로 package diff에서 제외한다.
`records/`는 `generatedPaths`에 중복 선언하지 않아 package 작성 뒤 생긴
기록 파일을 사전 snapshot drift로 오판하지 않는다. 이 범위 밖 파일 변경이나
source/test 제외, 실패한 검사 우회는 허용하지 않는다. 검토자는 package digest에
결속된 판정을 남겨야 한다.

Claude 독립 검토에는 저장된 `claude.ai` Max 구독 CLI만 사용한다. 검토 child에서
`ANTHROPIC_*`, `CLAUDE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` 및
Bedrock/Vertex/Foundry 전환 변수를 제거하고 Max 로그인 상태가 확인되지 않으면
중단한다. `claude --print --safe-mode --output-format json --tools
Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`의 읽기 전용
제한을 유지한다. Claude가 쓰기 도구를 갖지 않아 사전 검사 probe를 수행할 수
없는 이 검토에 한해 사용자가 승인한 `--skip-preflight` 예외를 기록한다.
Anthropic API fallback과 `--review-despite-check-failures`는 금지한다.

author의 loopback fixture 브라우저 실행은 desktop·mobile 신규 4건 모두
통과했다. 해당 두 Chromium 프로젝트 외에는 실행 시 명시적으로 skip한다.
fixture on에서는 Chat POST 0건이고, off positive control에서 원문을 포함하고
fixture 합성문을 포함하지 않는 POST 1건은 브라우저가 서버 전송 전에 중단한다.
서버의 loopback·cookie 게이트 아래에서만 Client loader가 렌더되고, 실제
refresh 버튼은 loader 안에서 동적 import한다. 이는 코드 경계이며 측정 없는
production bundle 크기·chunk 제외 주장으로 해석하지 않는다.
author가 처음에 unit과 render를 잘못 같은 React-server 조건으로
실행한 혼합 명령은 unit 11건이 각각 통과했지만 render import 실패로 **명령
전체가 실패**했다. 이후 올바른 조건의 별도 render 명령은 10/10 통과했다.
독립 검증 담당은 unit-only 11/11과 render-only 10/10을 각각 성공한 명령으로
다시 실행했다. 실패한 author 혼합 명령을 이 성공 기록으로 덮어쓰지 않는다.
prompt-injection 검사는 위반 0, 변경 파일 ESLint 및 `git diff --check`는
통과했다. author의 로컬 TypeScript 실행에는 변경 밖의 기존
`tests/integration/marketing-automation-schema.db.test.ts:742`의
`factsDigest` TS2339 한 건이 나왔다. 독립 검증 담당의 최종
`next typegen` + `tsc`에는 그 오류와 별도로
`.next/dev/types/app/api/assistant-profiles/route.ts`의 기존
`assistantProfileErrorResponse` export 오류도 나와 **총 두 baseline 오류**가
관측됐다. 검토 package의 신규 검사 기록은 두 실행 환경의 차이를 숨기거나
전체 typecheck 통과로 표현하지 않아야 한다.

제품 Prompt Refiner mode·provider·Router·flag 전환, stage/run 승인, 유료 실행,
실제 사용자 traffic, 자동 PR 병합·배포는 승인 범위 밖이다.
