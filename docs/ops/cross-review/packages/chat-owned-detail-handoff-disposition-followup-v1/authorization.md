# Owned-detail handoff disposition 후속 독립 검토 승인 기록

- approvedBy: `mposition` (현재 대화의 자동 개발 및 독립 검토 지시)
- approvedAt: `2026-09-24` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `cursor-cli`
- maximumRevisionRounds: `2`
- task: [task.json](./task.json)

## 범위와 선행 기록

비교 base는 PR #1673의 현재 head
`5d2c109ab75784d73206c2f904088d84ff3aed13`이다. 이미 `passed`로 종결된
`chat-saved-undispatched-disposition-followup-v2` exchange와 그 records는 이
후속 작업에서 수정하거나 재개하지 않는다. 이 package는 그 승인 이후 별도 CI
검토에서 발견된 owned-detail surface handoff와 routing contract 두 경계만 다룬다.

허용된 제품·테스트 범위는 `ChatPageClient.tsx`,
`externalContinuationContracts.test.mjs`, 그 contract가 사용하는 AST helper
`tests/support/continuationRouting.mjs`와 이 package의 task/authorization/records다.
실제 provider 호출, 유료 실행, staging/production 접근, flag 또는 traffic 변경,
commit, push, merge 및 deploy는 승인 범위 밖이다. prompt, admission, context 또는
provider 재실행 권한을 새로 보존하지 않는다.

## Cursor 직접 검토 증거

운영자가 제공한 Cursor CLI 직접 검토 outer JSON을
`records/cursor-pr1673-ci-followup-review.captured.json`으로 그대로 보존한다.
원본은 3,528 bytes이며 SHA-256은
`06aaa16be89cd27769390d82c1985ff4ac340e697c45f68ec31ad31535dd5235`다.
검토 session은 `ee925073-ae6d-4fb6-80d0-6c7e1c6d8501`, request는
`bb7ca8f6-903f-483c-9cc4-07d7ab5c7140`, duration 및 API duration은 모두
924,935ms다. usage는 input 296,827, output 49,566, cache read 4,195,456,
cache write 0이다. supplied outer result에는 모델 필드가 없으므로 이 문서는 모델
이름을 추정하지 않는다. narration 뒤 JSON verdict가 포함된 success envelope이며,
이 자료는 새 exchange의 공식 verdict가 아니라 이 후속 task를 연 근거다.

직접 검토는 다음 두 결함을 `request_changes`로 보고했다.

1. post-boundary owned-detail lookup이 이미 같은 id를 current로 만든 뒤 다른
   surface로 push할 때 `commitConversationSelection`을 다시 거치지 않아 selection
   ticket 및 pending durable-undispatched promotion이 누락될 수 있었다.
2. contract harness는 requested URL id와 클릭 id가 다른 outstanding handoff와
   promotion identity/count/order를 실행하지 않아 inserted return, missing barrier,
   refused/stale lookup 전 조기 promotion을 거부하지 못했다.

## 구현과 검증

`commitConversationSelection(true)`는 id가 같더라도 실제 surface departure라면
pending durable-undispatched turn을 exact current identity로 promote하고 committed
selection ticket을 갱신한다. post-boundary owned-detail handoff는 `router.push` 전에
이 barrier를 실행한다. 또한 lookup을 시작할 때 캡처한 navigation attempt가 응답
시점의 `conversationNavigationAttemptRef`와 정확히 일치할 때만 barrier와 push를
허용한다. 더 새로운 locked/refused click은 committed conversation id를 바꾸지 않아도
이전 응답의 authority를 폐기하며, A→B→A로 id가 다시 같아져도 이전 A 응답은
commit, promotion 또는 push를 수행하지 않는다.

contract harness는 outstanding URL handoff settle 뒤 explicit selection 계속,
accepted lookup 뒤 promote-before-push, same-id cross-surface promotion, refused 및
locked target의 zero-promotion을 실행한다. 여섯 mutation은 handoff branch의 inserted
return, missing promotion, same-id force guard 회귀, lookup 전 조기 promotion,
trailing barrier 누락 및 push 뒤 늦은 barrier를 각각 거부한다.
후속 anti-review에서 post-boundary freshness 누락을 재현한 뒤, newer locked/refused
attempt와 A→B→A ABA를 별도 navigation state로 실행해 commit/promotion/push가 모두
0임을 고정했다. freshness guard 제거 mutation도 이 두 상태에서 실패한다.
후속 anti-review에서 그 제거 mutation이 exact source string에 의존한다는 취약성을
확인했다. AST helper는 strict equality의 두 operand를 의미로 식별해 괄호, operand
순서 및 AND conjunct 위치와 무관한 `trailingNavigationFreshness` anchor를 제공한다.
mutation은 이 AST conjunct를 제거하며, freshness가 first/middle/last에 있는 변형과
reversed/parenthesized equality 모두에서 실제 mutant 생성과 거부를 확인한다.

실행 결과는 다음과 같다.

- 신규 mutation 회귀: 6/6 통과
- `tests/externalContinuationContracts.test.mjs`: 106/106 통과
- identity/disposition unit: 13/13 통과
- 관련 desktop/mobile Chromium focused E2E: 22/22 통과
- `npm run typecheck`: 통과
- 변경 제품·계약·AST helper 세 파일 scoped ESLint: 통과
- `npm run build`: exit 0 (기존 NO_SECRET fallback 로그 및 dynamic filesystem tracing
  warning은 있었으나 compilation, TypeScript, static generation이 완료됨)
- `git diff --check 5d2c109ab75784d73206c2f904088d84ff3aed13`: 통과

새 package의 records만 exact `--out`과 `--diff-exclude`로 제외한다. author는
Codex, 독립 reviewer는 Cursor CLI이며 수정 round 상한은 2다. package 생성 후
reviewer는 새 digest에만 verdict를 결속해야 한다.
