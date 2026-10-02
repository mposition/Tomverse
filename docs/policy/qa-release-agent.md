# QA·릴리스 Agent 정책

상태: **초안 — 승인되지 않음, 구현 없음.** 최초 작성 2026-10-02, 세 번째 초안 2026-10-02.
approvedBy: (미승인) · approvedAt: (미승인) · 정책 버전: (미부여)
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| (미부여) | (미승인) | 최초 초안 |
| (미부여) | (미승인) | 두 번째 초안 — 독립 검토 반영: main은 사람이 병합하고 레인은 표시만, develop 제외 목록 보강, latch 전용 알림 |
| (미부여) | (미승인) | 세 번째 초안 — 독립 검토 반영: App의 main 병합을 ruleset으로 막음(bypass는 저장소 관리자 역할만), 게이트 범위를 `package.json`과 `scripts/**`로, 제외는 후보 선정에서 건너뜀, 승인 판정 단계를 본문에, 모든 secret·키 회전 기록, staging migration 복구, 스위치 off, 단일 점유 |

이 문서는 Claude가 설계하고 독립 검토(교차 vendor)로 `accept` 판정을 받은 비공개 설계서를 공개 계약으로 옮긴
초안입니다. **운영자가 이 문서에 `approvedBy`·`approvedAt`·정책 버전을 기록하고 병합하기 전에는 이 문서의 어떤 조항도
효력이 없고, 아래 어떤 구현도 작성·병합하지 않습니다.** 승인은 단계별 착수 조건을 없애지 않으며, 어떤
workflow·secret·branch protection·ruleset·GitHub App·Railway 변경도 그 자체로 허가하지 않습니다.

승인은 아래 단계를 **모두** 통과해야 인정합니다. S0 착수 전에 판정하고, 결과는 그 착수 PR 본문에 적습니다. 판정은
기록(git·GitHub)만으로 재현할 수 있어야 하며, script로 자동화해도 게이트가 아니라 보고입니다.

| # | 판정 |
|---|---|
| 0 | `approvedBy`의 계정이, 이 정책 파일을 바꾼 PR의 **base에 있던** `docs/policy/agent-operator-allowlist.md` 목록에 있다. 그 목록 파일의 최초 commit이 위 `allowlistGenesisCommit`과 같다 |
| 1 | 이 정책 파일을 마지막으로 바꾼 commit을 찾는다 |
| 2 | 그 commit을 `develop`에 넣은 PR이 **정확히 하나**다 |
| 3 | 그 PR의 브랜치 이름에 `to-develop` 경로 조각이 없다 |
| 4 | 그 PR의 병합자가 사람이고 `approvedBy`와 같은 계정이다 |
| 5 | `approvedAt`이 그 병합의 UTC 날짜와 같다 |
| 6 | 그 PR이 이 정책 파일 하나만 바꾸고, 모든 commit의 작성자가 `approvedBy`이며 bot이 아니다 |
| 7 | 그 뒤 이 정책 파일이 다시 바뀌면 1번부터 다시 판정한다 |

운영자가 2026-10-02 대화에서 밝힌 의사를 담습니다. 이 문서가 승인될 때 효력이 생깁니다.

- 공통 기반은 모든 Agent가 따르는 **공유 정책**이고, 인프라는 Agent마다 따로 만들어도 된다.
- 침묵 감시의 두 번째 실행 지점은 **전용 QA Release Monitor**로 둔다.
- 알림은 기존 운영자 알림 queue를 쓰고, 그 queue에서 생기는 잔여를 7절대로 수용한다.
- 운영자 제어(활성화·secret·IaC)의 감사는 이 Agent가 **자기 기록**으로 갖는다(6절).
- PR **병합 레인**을 이 Agent에 둔다. **develop만 무인으로 병합하고, main은 사람이 GitHub에서 병합한다**(8절).

## 1. 무엇을 하는가

1. **일일 릴리스 준비 digest.** 하루 한 번, 저장소의 보고 script(`report:release-gate-evidence`,
   `report:issue-backlog`)와 무자격증명 정적 검사, GitHub Actions job 결론을 읽어, 서로 다른 상황을 구분한 digest
   하나를 본 앱에 제출합니다. 소유자는 Admin의 공통 Agent digest 영역에서 읽고, 알림에는 링크만 실립니다.
2. **CI 실패 분류.** `infra` · `undetermined` · `flaky_suspected` · `consecutive_repro`. digest 안의 열거값이며 GitHub
   label이 아닙니다. 결정적 규칙이고 판정이 아닙니다. 근거가 없으면 `undetermined`이며 소유자 할 일을 만들지 않습니다.
3. **재실행 권고.** 최대 2건, 7일 만료. 실행은 사람이 합니다.
4. **병합 레인.** 8절.

**LLM을 쓰지 않습니다.** 모든 판정은 결정적 코드입니다. 외부 텍스트(CI 로그, issue·PR 문장)는 판정의 입력일 뿐
명령이 아니며, **digest에 들어가지 않습니다.** digest schema는 닫혀 있고 숫자·열거값·이슈 번호·SHA만 담습니다. CI 로그,
issue·PR 제목·본문, test 제목, 오류 문장을 담을 필드가 없고, 저장 전에 secret scan을 거칩니다.

## 2. 하지 않는 것

- 통과·조건부·실패의 판정, 서명, 동결, "release ready"라고 말하기.
- release-gate registry(`docs/release-gates/**`)의 어떤 쓰기도.
- 유료 turn 실행, 크레딧 소비 결정.
- auto-merge 켜기, workflow rerun·dispatch, golden 재기록, back-merge 충돌 해결.
- **main 병합.** develop 밖의 어떤 병합도 하지 않고, develop에서도 8절 3항의 제외 대상은 병합하지 않습니다.
- 이미 병합된 commit 되돌리기(되돌림은 사람의 revert PR).
- 테스트 코드·앱 코드 수정, 운영 DB 읽기.
- GitHub issue·label·comment·artifact·status·check 쓰기. 결과·대기열은 본 앱 DB와 Admin에만 둡니다.

## 3. 실행 위치와 자격증명

| 서비스 | 하는 일 | 가진 자격증명 | 없는 것 |
|---|---|---|---|
| `QA Release Digest` (Railway cron) | digest 생성·제출 | 본 앱 제출 secret, **읽기 전용** GitHub token, 운영자 제어 revision 번호 | 제품 DB, GitHub 쓰기, 알림·LLM 키 |
| `QA Release Monitor` (Railway cron) | 침묵 감지 호출 | Monitor 전용 secret | 그 밖의 모든 것 |
| `QA Release Merge Lane` (Railway cron) | 병합 레인의 사실 수집·develop 병합 실행 | GitHub App key(Contents·Pull requests write, Checks·Commit statuses·Metadata read), Railway 조회 토큰, 전용 secret | 제품 DB, Workflows·Administration 권한 |

- 세 서비스는 변수를 공유하지 않습니다. IaC 선언의 변수 집합은 test가 정확히 고정합니다.
- 판정은 본 앱 내부 route에서 합니다(LLM 없음, 외부 텍스트 실행 없음). 본 앱에는 GitHub 쓰기 토큰이 없습니다.
- **병합 레인 서비스는 스스로 고른 PR을 병합하지 않습니다.** 본 앱이 발급한 지시(attempt id, PR 번호, head SHA, base `develop`)를
  받아, 다시 읽은 상태가 그 지시와 같을 때만 그 PR 하나를 병합하고 결과를 그 attempt id로 보고합니다. 지시는 한 번만
  유효합니다. 서비스 코드는 base가 `develop`이 아닌 병합 호출과 병합 API 밖의 쓰기(직접 push, ref 갱신)를 하지 않으며,
  정적 test가 이를 고정합니다.
- **App 키의 쓰기 권한은 저장소 전체입니다.** 그래서 코드가 하지 않는 쓰기를 GitHub 설정으로도 막습니다(8절 7항).
- 서비스는 hard timeout에 강제 종료됩니다. 본 앱 route의 트랜잭션은 DB가 강제하는 문장·유휴 timeout과 마지막 문장의
  DB 시계 마감 검사로 묶이고, 늦은 실행은 성공으로 기록되지 않습니다. 트랜잭션당 최대 시간은 그 둘에서 **유도한
  애플리케이션 값**이고 DB 상한이 아닙니다.
- **Monitor의 한계:** Monitor도 Railway cron이므로 Railway의 cron 실행 자체가 멈추면 digest와 함께 멈추고, 그 침묵은
  이 Agent가 보지 못합니다. 그 층은 운영·SRE Agent의 영역입니다.

## 4. 저장과 표시

- 결과는 공유 `AgentDigestItem` 계약(운영자 결정, 다섯 팀 공통)을 따릅니다: `agentKey = qa-release`, payload 직렬화
  16 KiB 이하, 닫힌 schema, 단일 writer, 본문 보존 **90일**, 그 뒤 meta 행은 공통 규칙.
- Admin은 공통 Agent digest 영역 하나를 씁니다. 이 Agent의 쓰기 행위는 둘입니다: 운영자 제어 revision 기록, 병합 레인
  latch 해제. 둘 다 owner·ops 권한과 step-up을 요구합니다. **승인 버튼은 없습니다.**

## 5. 감사

사람 행위는 `writeAdminAuditLog`, 시스템 행위는 `writeSystemAuditLog`로 같은 해시 체인에, **상태 변경과 같은 트랜잭션**에
남깁니다. 감사 테이블에 직접 쓰지 않습니다. 새 system actor는 `qa-release-intake`, `qa-release-merge-lane`입니다(닫힌 목록
추가는 리뷰 대상).

## 6. 운영자 제어 기록

- 운영자가 정하는 상태(활성화 여부, **이 Agent의 모든 secret과 키** — digest 제출 secret, Monitor secret, 병합 레인 secret,
  GitHub App key, Railway 조회 토큰, 읽기 전용 GitHub token — 의 **회전 시각**(값 아님), 적용할 IaC commit, develop 병합 레인
  스위치)를
  append-only 기록으로 둡니다. 기록은 Admin 행위이고 같은 트랜잭션에 감사됩니다.
- 운영자는 Railway 변경과 같은 변경에서 서비스에 그 revision 번호를 설정합니다. 본 앱은 제출된 번호가 최신 revision과
  다르면 그 제출을 거절하고 알립니다. 결과를 모르면 진행하지 않고 사람이 확인합니다.
- 기록되지 않은 외부 변경(같은 commit의 재배포)과, 알림이 멎는 회복은 감사 행에 남고, 설명할 revision이 없으면
  알립니다. 활성 상태로 기록된 동안 본 앱 secret이 없어지면 조용해지지 않고 알립니다.

## 7. 알림

- 알림 kind는 다섯이고 모두 **고정 제목 + 고정 문장 + Admin 링크**만 싣습니다: digest 기록, digest 침묵, 감시 실패,
  확인 필요(제출 충돌·운영자 제어 불일치), **병합 레인 latch**. 각 kind는 UTC 날짜당 1건이므로 이 Agent의 알림은 하루
  최대 5건입니다.
- 알림은 기존 운영자 알림 queue를 씁니다. **이 문서가 승인되면 다음 잔여를 수용한 것으로 기록합니다.** 그 queue의 기존
  포기 incident(`NOTIFICATION_DELIVERY_ABANDONED`)는 이 Agent의 행이 포기될 때도 올라가며, 그 내용은 본 앱 코드가 조립하는
  닫힌 이름과 정수뿐입니다(이 Agent가 만든 문장·외부 텍스트 없음). 이 Agent의 행은 공용 깊이 수치에 하루 최대 5행 들어가
  이 Agent 행만으로 깊이 경보 100에 닿으려면 20일이 걸립니다. 전송이 매우 느리면 공용 backlog 신호가 켜질 수 있습니다.
  이 잔여가 받아들여지지 않으면 답은 공용 queue 수정이 아니라 이 Agent의 알림을 queue 밖으로 옮기는 새 설계입니다.

## 8. 병합 레인

1. **범위.** develop(→ Railway `staging`)만 병합합니다. 한 번에 하나씩 병합하고, staging에 배포가 둘 이상 쌓이지 않게
   합니다. **main(→ `production`)은 사람이 GitHub에서 병합합니다**(`.github/RELEASE_CHECKLIST.md`의 7.9절, `docs/policy/trace-feedback-automation.md`
   §9.3, `docs/policy/engineering-agent.md`의 승인 증거와 같음). 레인은 "main으로 향하는 열린 PR"(`mainPullRequestDecision()`이
   허용한 head)과 production 상태를 Admin에 표시만 합니다. **이 목록은 병합 준비 판정이 아닙니다** — hotfix의 7.9.2 항목이나
   각 자동화의 자기 게이트는 사람이 봅니다. 이 Agent는 auto-merge를 켜지 않습니다.
2. **후보.** base가 develop, draft 아님, check가 모두 끝났고 실패 없음, PR Fast Gate 성공 run이 하나 이상, mergeable인 PR 중
   가장 오래된 것. 판정 코드는 `scripts/merge-train-core.mjs`(`refusalReason`·`pickNextPullRequest`·`inFlightDeployments`·
   `deploymentOutcome`)를 재사용하고, **3항의 제외 판정을 후보 선정 안에 넣습니다** — 제외 대상은 실패 PR과 똑같이 이유와 함께
   건너뛰고 다음으로 오래된 PR을 봅니다. 그래서 제외 대상이든 실패 PR이든 **뒤의 PR을 막지 않습니다.**
3. **제외.** 아래 PR은 레인이 **병합하지 않고** Admin에 "사람 처리 대상"으로 표시만 합니다. 사람이 GitHub에서 각자의 계약대로
   처리합니다.
   - 변경 경로에 게이트 파일: `.github/**`, **`scripts/**` 전체**(PR Fast Gate와 다른 workflow가 실행하는 검사 script가 여기에
     있습니다), **`package.json`·`package-lock.json`**(검사를 실행하는 npm script와 그 의존성), 정책 테스트(PR base의
     `docs/policy/**`·`AGENTS.md`·`CLAUDE.md`가 경로로 이름 댄 `tests/**` 파일), `AGENTS.md`, `CLAUDE.md`, `docs/policy/**`,
     `docs/ui-contracts/**`, `docs/release-gates/**`, `lib/adminAuth*`, `lib/adminAuditSystemActors.ts`, `lib/agentAuthorityFiles.ts`.
   - 변경 경로에 이 Agent 자신의 파일(부록 A, 판정은 PR base의 목록으로).
   - head 브랜치 `agent/**`, `marketing-agent/**`, `feedback-autofix/**`, `feedback-autofix-main/**`, `autofix/**`,
     `visual-baseline/**`, `dependabot/**`.
   - 변경 파일 목록(전체 페이지, rename은 이전·이후 경로 둘 다)을 끝까지 읽지 못한 PR.
   **migration을 포함한 PR도 무인 병합 대상입니다**(staging의 preDeploy가 적용합니다). git revert는 적용된 migration과 실패한
   migration 기록을 되돌리지 않습니다. 그래서 staging 배포가 실패하면 레인은 latch하고, staging DB의 복구는 운영자가
   `docs/ops/railway-restore-drill.md`의 절차(또는 staging 재생성)로 합니다. 복구가 끝나기 전에는 latch를 풀지 않습니다.
4. **hold와 추적.** staging 환경의 모든 Railway 서비스 중 하나라도 `WAITING`·`NEEDS_APPROVAL`·`QUEUED`·`INITIALIZING`·
   `BUILDING`·`DEPLOYING`이면 병합하지 않습니다. 병합 직전에 다시 읽고 head를 고정해 병합합니다. develop을 배포하는 서비스
   **전부**가 merge commit을 배포해야 완료이고, `FAILED`·`CRASHED`·`SKIPPED`는 실패입니다.
5. **결과 불명.** 병합 전에 "시도 중"을 기록하고, 결과를 모르거나 배포가 실패하면 레인을 latch합니다. latch는 사람이 Admin에서
   풉니다. **레인당 시도는 하나입니다** — "시도 중" 행은 레인당 하나만 존재할 수 있게 DB가 강제하고(조건부 단일 점유), 두 회차가
   겹쳐 둘 다 유휴를 읽어도 두 번째는 점유에 실패해 병합하지 않습니다.
6. **스위치.** 병합은 세 입력이 **모두 켜져 있을 때만** 합니다: 서비스 활성화 변수, develop 레인 스위치(운영자 제어 기록),
   kill switch 변수. 하나라도 꺼져 있거나 읽지 못하면 병합하지 않습니다.
7. **App은 main을 갱신하지 못하게 둡니다.** 필수 리뷰는 App도 지켜야 할 규칙일 뿐이라, 사람이 리뷰를 남긴 main PR은 App도 병합
   API로 병합할 수 있습니다. 그래서 S-M0 전에 main에 **갱신 제한 ruleset**(`update`)을 두고 **bypass는 저장소 관리자 역할만**,
   App은 넣지 않습니다. 운영자의 release·hotfix·feedback 승격 병합은 그대로 되고, App의 main 병합·push는 GitHub가 거절합니다.
   S-M0에서 main과 같은 보호를 건 배포되지 않는 시험 브랜치로 **세 가지를 관측**합니다: 리뷰가 없는 PR의 App 병합 거절, **리뷰가
   끝난 PR의 App 병합 거절**, App의 직접 push 거절. 그리고 운영자의 병합은 성공합니다. 이 관측이 **모두 기대대로일 때만** S-M1에
   들어가고, 하나라도 다르면(예: 개인 계정 저장소에서 관리자 역할 bypass가 동작하지 않으면) 운영자가 결정합니다. develop에도 같은
   방식으로 App의 직접 push를 관측합니다(필수 check가 그 push를 거절하는지). 이 보호를 바꾸는 것은 이 정책의 개정입니다.
8. **병합 주체의 전환.** develop 레인을 켜는 변경에서 로컬 `scripts/merge-train.mjs`의 develop 레인을 삭제하고, AGENTS.md의
   "workflow는 PR을 열기만 하고 auto-merge를 켜지 않습니다" 절이 develop 병합 주체를 이 레인으로 고쳐 적습니다. 둘 다 게이트
   파일이므로 사람이 병합합니다.

## 9. 단계

| 단계 | 내용 | 진입 조건 |
|---|---|---|
| S0 | digest·Monitor·운영자 제어 기록 구현, 전부 dark | 이 정책 승인, 승인자 목록 절차 통과 |
| S1 | staging에서 digest 활성 | S0 test 통과, 운영자 제어 revision 1 기록, IaC apply·secret 설정(운영자) |
| S2 | production 활성 | S1 30일, 침묵 오탐 0 |
| S-M0 | 병합 레인 구현(dark), main 갱신 제한 ruleset 설정, 시험 브랜치 관측(8절 7항) | 이 정책 승인, 공통 기반의 병합 레인 예외 반영 |
| S-M1 | develop shadow(판정만, 병합 안 함) | S-M0 test 통과, **8절 7항의 관측이 모두 기대대로**, App·Railway 토큰 설정 |
| S-M2 | develop 무인 병합 | S-M1 7일 이상 판정과 실제가 어긋난 건 0, 8절 8항의 변경 병합 |
| S-M3 | main 후보·production 상태 표시 | S-M2 운영 중. 병합 호출 없음 |

되돌림: 서비스 활성화 변수, develop 레인 스위치, kill switch를 끕니다. 진행 중인 병합 시도는 GitHub 기록으로 확인될 때까지
latch로 남습니다. 이미 병합된 commit은 사람이 revert PR로 되돌립니다.

## 10. 값

이 표의 값은 이 문서가 승인될 때 확정됩니다. "운영자 의사"는 운영자가 2026-10-02 대화에서 승인 의사를 밝힌 값입니다.

| 값 | 내용 | 상태 |
|---|---|---|
| timeout | 문장 2,000 ms, 유휴 1,000 ms(DB가 강제). 그 둘에서 유도한 트랜잭션당 최대(애플리케이션 값): digest 제출 저장 32초, 침묵 판단 읽기 11초, 침묵 알림 기록 32초, 감시 실패
  기록 26초. 침묵 감지 한 회차의 최악은 읽기·알림·감시 실패의 합 69초(11 + 32 + 26)이고, 제출 저장은 다른 route입니다. 상수 순서 `Prisma > transaction > statement > idle`. PostgreSQL 17에서만 있는 `transaction_timeout`은 그 서버가 지원할 때만 걸고, 16에서는 걸지 않습니다 | 운영자 의사 |
| digest | cron `0 21 * * *` UTC, hard timeout 15분, 침묵 기준 28시간, 본문 보존 90일, 재실행 권고 상한 2건·7일, issues 배열 40 / 30 / 30 | 운영자 의사 |
| CI | PostgreSQL 17 전용 job 하나(17 경로의 시험용) | 운영자 의사 |
| Monitor | cron `*/30 * * * *`, 호출자 timeout 120초 | 제안값(S0 전에 확정) |
| 병합 레인 | cron 주기, 서비스 hard timeout 10분, 본 앱 트랜잭션 둘의 문장 수와 유도 최대, S-M2 7일 | 제안값(S-M0 전에 확정) |

## 11. 사람에게 남는 일

정책 승인과 병합, IaC apply, secret 설정과 회전 기록, GitHub App 발급, latch 해제, **main 병합**, 제외된 develop PR의 처리,
병합된 commit의 revert, 판정과 서명. 그 밖에 이 Agent가 사람에게 일을 만들지 않습니다.

## 부록 A. 이 Agent의 파일 (병합 레인의 제외 판정에 쓰는 경로 목록)

병합 레인은 아래 경로를 바꾸는 PR을 무인 병합하지 않습니다(8절 3항). 판정은 그 PR의 base에 있던 이 목록으로 합니다.
목록을 바꾸는 것은 이 정책 문서를 바꾸는 것이고, 정책 문서는 게이트 파일입니다. 이 Agent의 script(`scripts/**` 아래)는 8절 3항의 `scripts/**` 제외에 이미 들어가므로 여기 다시 적지 않습니다.

```
lib/qaRelease*
app/api/internal/agents/qa-release/**
app/api/admin/agents/qa-release/**
tests/qaRelease*
tests/mergeTrainCore.test.mjs
tests/mainPrSourcePolicy.test.mjs
.railway/**
```
