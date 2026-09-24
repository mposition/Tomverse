# CHAT-01 canonical AMUX card read-back 독립 검토 승인 기록

- approvedBy: `mposition` (현재 대화의 CHAT-01 자동 개발 및 Cursor CLI 독립 검토 지시)
- approvedAt: `2026-09-25` (Australia/Brisbane)
- author: `codex`
- independentReviewer: `cursor-cli`
- maximumRevisionRounds: `2`
- task: [task.json](./task.json)

## 목적과 범위

governance v1.1은 현재 작업 상태와 우선순위를 canonical AMUX authority에서 읽도록
요구하고 역사 기록에서 현재 상태를 추정하지 못하게 한다. 그런데 기존 Admin 표면에는
특정 canonical 카드의 상태·우선순위·검증된 revision/dependency metadata를 읽는
bounded GET 계약이 없어 CHAT-01 다음 작업 선택이 fail-closed 상태였다. 이 변경은 그
read-back blocker만 해소한다.

비교 base는 `e768b1bea649acbdf6f0fb42beb531b6ead55192`, 검토할 source commit은
`a95c63f63df7a9b5602f6604fc8a7b8abc5bfb9a`다. 제품 범위는 task에 열거한 route,
read service/core, 기존 board-import canonical source identity, 운영 계약 문서와
focused tests뿐이다. 비공개 현황판 본문이나 경로는 package에 복사하지 않는다.

## 안전 경계

- GET은 Admin 인증보다 먼저 query나 storage를 읽지 않으며, 모든 분기에서
  `private, no-store, max-age=0`을 반환한다.
- 조회는 canonical private-workboard import 계약의 고정 `sourceSystem`과 exact
  `sourceKey` composite에 결속한다. 다른 source system의 동명 카드는 대상이 아니다.
- 응답은 원문 목표를 포함하지 않는다. 스키마에 원문이 없으므로 `remainingGoal`은
  `not_stored/detail_digest_only`로만 표현하고 내용을 만들지 않는다.
- accepted revision은 work item ownership을 검증하지만 parent relation은 같은 work
  item 소유를 별도로 증명하지 않으므로 공개 select/response에서 제외한다.
- dependency는 최대 256개이고 257번째 sentinel, malformed identity 또는 provenance
  불일치가 있으면 전체를 fail-closed한다.
- route/service는 audit, rate bucket, transaction, preview, writer, provider 또는
  외부 mutation 권한을 갖지 않는다.

## 독립 검토 실행 경계

사용자는 이 작업의 `--skip-preflight` 예외를 승인했다. 저장소 cross-review control
program으로 exact diff와 검사 결과를 package한 뒤 Cursor CLI 구독 로그인을 사용한다.
Cursor는 `grok-4.7-xhigh`, `--mode=plan`, Windows `--sandbox=disabled`로 실행하고
외부 API key 환경을 제거한다. Cursor의 Windows plan-mode limitation은 verdict
provenance에 기록하되 write mode나 `--force`로 대체하지 않는다.

Cursor는 requirement, diff, control-program test/guard 결과와 작성자 설명을 구분해
읽고 package digest에 JSON verdict를 결속한다. 실제 provider API call, paid execution,
database write, Railway/staging/production 접근, flag/traffic 변경, source edit, commit,
push, PR, merge 및 deploy는 승인 범위 밖이다. 공식 exchange의 수정 상한은 기존
contract대로 2이며, 이를 임의로 높이거나 concluded exchange를 재개하지 않는다.
