# AMUX 실행 루프 활성화 순서

정책: `docs/policy/development-agent-orchestration.md` 버전 15. 이 문서는 환경 변수를 설정하지 않는다. 각 단계는 운영자가 하고, 단계마다 결과를 읽은 뒤 다음으로 간다.

이 절차의 WSL 명령은 기존 호스트 기록이다. 전용 Ubuntu 서버로 옮긴 bridge는 승인된 정책 v23과 `docs/ops/amux/wsl-execution-bridge.md`의 Ubuntu 이전 절에 적힌 운영 게이트를 통과한 뒤에만 활성화한다. 현재 새 서버의 제품 bridge는 비활성이다.

## 무엇이 이어지는가

| 단계 | 주체 | 결과 |
|---|---|---|
| 승격 | owner가 Admin에서 | `backlog` → `todo`, owner 없음, 승인된 brief |
| claim | Railway orchestrator (claim 전용 모드) | owner 지정, status는 `todo` |
| 시작과 전달 | WSL bridge | `todo` → `doing`, 로컬 세션에 brief 전송, 로컬 카드 발급 |
| 작업 | 로컬 AMUX worker | develop PR, 로컬 카드 종료 |
| 정산 | WSL bridge | `review` 또는 `blocked`, review PR 번호 |
| Review | owner가 `/admin/amux-execution?tab=assignment`에서 | `review` → `done`, 또는 retry → `todo` |

카드의 현재 상태는 `/admin/amux-execution?tab=cards`에서 본다. 로컬 AMUX Board는 로컬 영수증 카드만 보여 준다.

## 선행 조건

1. 버전 15 코드가 main에 병합되고 production `Tomverse`와 `AMUX Orchestrator`가 그 커밋으로 배포됐다.
2. production `Tomverse`에 `TOMVERSE_AMUX_EXECUTION_API_ENABLED=1`과 worker catalog가 있다.
3. `/admin/amux-execution?tab=cards`에서 실행할 카드가 `todo`, owner 없음, brief `승인됨`이다.

## 1. Review를 먼저 연다

결과가 돌아오기 전에 사람이 받을 곳이 있어야 한다. production `Tomverse`에 두 값을 둔다.

- `AMUX_REVIEW_GITHUB_READ_TOKEN`: `mposition/Tomverse`의 pull request 읽기만 가진 fine-grained token. 쓰기 권한을 주지 않는다.
- `TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED=true`

확인: `/admin/amux-execution?tab=assignment`의 escalation 목록이 열리고 오류가 없다.

## 2. WSL bridge를 상시 실행으로 바꾼다

`wsl-execution-bridge.md`의 "상시 실행" 절대로 release 빌드와 systemd user unit을 둔다. 대화형 셸에서 돌던 runner는 먼저 멈춘다.

확인: `journalctl --user -u tomverse-wsl-bridge`에 시작 줄이 있고, Railway `Tomverse` 로그에 worker heartbeat 오류가 없다.

## 3. claim을 한 장만 연다

1. claim은 owner 없는 `todo` 가운데 우선순위가 가장 높은 카드부터 dispatch-ready worker에 간다. 한 번에 한 attempt만 보려면 bridge의 환경 파일에 `TOMVERSE_AMUX_WSL_SESSIONS`로 세션 하나만 적고 다시 시작한다. 그 세션만 runtime으로 등록되고, attempt가 진행 중인 동안 그 세션은 dispatch-ready가 아니므로 두 번째 claim이 생기지 않는다. 어느 카드가 먼저 갈지는 `/admin/amux-execution?tab=cards`의 우선순위와 orchestrator 로그의 `selected task`로 미리 본다.
2. production `AMUX Orchestrator`에 `TOMVERSE_AMUX_CLAIM=1`을 둔다. `TOMVERSE_AMUX_EXECUTE`는 두지 않는다. 둘을 함께 두면 orchestrator가 시작하지 않는다.
3. orchestrator 로그에서 `Tomverse task claim result`와 `claimed = true`를 확인한다.
4. `/admin/amux-execution?tab=cards`에서 그 카드의 owner와 `doing`, 실행 1을 확인한다.
5. 로컬 AMUX Board에 그 attempt의 영수증 카드가 생기고, 해당 세션이 brief를 받았는지 확인한다.

## 4. 결과를 받는다

worker가 PR을 열고 로컬 카드를 끝내면 bridge가 다음 tick에 정산한다.

- 로컬 카드 `done`·`verified` → Tomverse `review`, escalation 하나, PR 번호가 있으면 기록.
- 로컬 카드 `discarded`·`cancelled`·`quarantined` → `blocked`.
- 30분 안에 영수증 카드를 찾지 못하면 → `blocked`(`local_card_unlinked`).

`/admin/amux-execution?tab=assignment`에서 PR diff를 보고 approve(→ `done`), retry(→ `todo`), block 중 하나를 고른다. approve는 병합이 아니다. 병합은 GitHub에서 따로 한다.

## 5. 나머지 카드

한 장의 전 과정을 확인한 뒤에만 `TOMVERSE_AMUX_WSL_SESSIONS`를 넓히거나 지운다.

## 되돌리기

| 멈출 것 | 방법 | 남는 상태 |
|---|---|---|
| 새 claim | `AMUX Orchestrator`에서 `TOMVERSE_AMUX_CLAIM` 제거 | claim된 카드는 180초 뒤 owner가 풀린다 |
| 새 배정과 정산 | `systemctl --user stop tomverse-wsl-bridge` | 진행 중 attempt는 heartbeat가 끊겨 90초 뒤 `todo`로 돌아간다 |
| 실행 API 전체 | `Tomverse`에서 `TOMVERSE_AMUX_EXECUTION_API_ENABLED` 제거 | claim, 시작, 정산이 모두 409 |
| Review | `TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED` 제거 | `review` 카드는 그대로 남는다 |

halt한 bridge는 종료 코드 3으로 끝나고 다시 시작하지 않는다. 로그와 `/admin/amux-execution?tab=cards`를 확인한 뒤 사람이 다시 시작한다.
