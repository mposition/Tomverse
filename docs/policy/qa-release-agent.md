# QA·릴리스 Agent 정책

상태: **초안 — 승인되지 않음, 구현 없음.** 최초 작성 2026-10-02.
approvedBy: (미승인) · approvedAt: (미승인) · 정책 버전: (미부여)
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| (미부여) | (미승인) | 최초 초안 |

이 문서는 Claude가 설계하고 독립 검토(교차 vendor)로 `accept` 판정을 받은 비공개 설계서를 공개
계약으로 옮긴 초안입니다. **운영자가 이 문서에 `approvedBy`·`approvedAt`·정책 버전을 기록하고
병합하기 전에는 아래 어떤 구현도 작성·병합하지 않습니다.** 승인은 단계별 착수 조건을 없애지
않으며, 어떤 workflow·secret·branch protection·ruleset·GitHub App·Railway 변경도 그 자체로
허가하지 않습니다.

운영자가 2026-10-02 대화에서 내린 결정을 담습니다. 그 결정들은 **이 문서가 승인될 때 효력이
생깁니다.**

- 공통 기반은 모든 Agent가 따르는 **공유 정책**이고, 인프라는 Agent마다 따로 만들어도 된다.
- 침묵 감시의 두 번째 실행 지점은 **전용 QA Release Monitor**로 둔다.
- 알림은 기존 운영자 알림 queue를 쓰고, 그 queue에서 생기는 잔여 셋을 수용한다(§7).
- 운영자 제어(활성화·secret·IaC)의 감사는 이 Agent가 **자기 기록**으로 갖는다(§6).
- PR **병합 레인**을 이 Agent에 둔다. develop은 무인, main은 Admin 사람 승인(§8).

## 1. 무엇을 하는가

1. **일일 릴리스 준비 digest.** 하루 한 번, 저장소의 보고 script(`report:release-gate-evidence`,
   `report:issue-backlog`)와 무자격증명 정적 검사, GitHub Actions job 결론을 읽어, 서로 다른 상황을
   구분한 digest 하나를 본 앱에 제출합니다. 소유자는 Admin의 공통 Agent digest 영역에서 읽고,
   알림에는 링크만 실립니다.
2. **CI 실패 라벨.** `infra` · `undetermined` · `flaky_suspected` · `consecutive_repro`. 라벨은
   결정적 규칙이고 판정이 아닙니다. 근거가 없으면 `undetermined`이며 소유자 할 일을 만들지 않습니다.
3. **재실행 권고.** 최대 2건, 7일 만료. 실행은 사람이 합니다.
4. **병합 레인.** §8.

**LLM을 쓰지 않습니다.** 모든 판정은 결정적 코드입니다. 외부 텍스트(CI 로그, issue·PR 문장)는
데이터이고 명령이 아닙니다.

## 2. 하지 않는 것

- 통과·조건부·실패의 판정, 서명, 동결, "release ready"라고 말하기.
- release-gate registry(`docs/release-gates/**`)의 어떤 쓰기도.
- 유료 turn 실행, 크레딧 소비 결정.
- auto-merge 켜기, workflow rerun·dispatch, golden 재기록, back-merge 충돌 해결.
- §8 병합 레인 밖의 PR 병합. 병합 레인도 아래 8절 3항의 제외 대상은 병합하지 않습니다.
- 테스트 코드·앱 코드 수정, 운영 DB 읽기.
- GitHub issue·label·comment·artifact·status·check 쓰기. 결과·대기열·승인은 본 앱 DB와 Admin에만 둡니다.

## 3. 실행 위치와 자격증명

| 서비스 | 하는 일 | 가진 자격증명 | 없는 것 |
|---|---|---|---|
| `QA Release Digest` (Railway cron) | digest 생성·제출 | 본 앱 제출 secret, **읽기 전용** GitHub token, 운영자 제어 revision 번호 | 제품 DB, GitHub 쓰기, 알림·LLM 키 |
| `QA Release Monitor` (Railway cron) | 침묵 감지 호출 | Monitor 전용 secret | 그 밖의 모든 것 |
| `QA Release Merge Lane` (Railway cron) | 병합 레인의 사실 수집·병합 실행 | GitHub App key(Contents·Pull requests write, Checks·Commit statuses·Metadata read), Railway 조회 토큰, 전용 secret | 제품 DB, Workflows·Administration 권한 |

- 세 서비스는 변수를 공유하지 않습니다. IaC 선언의 변수 집합은 test가 정확히 고정합니다.
- 판정은 본 앱 내부 route에서 합니다(LLM 없음, 외부 텍스트 실행 없음). 본 앱에는 GitHub 쓰기 토큰이 없습니다.
- 서비스는 hard timeout에 강제 종료됩니다. 본 앱 route의 트랜잭션은 문장·유휴 timeout과 마지막 문장의
  DB 시계 마감 검사로 묶이고, 늦은 실행은 성공으로 기록되지 않습니다.

## 4. 저장과 표시

- 결과는 공유 `AgentDigestItem` 계약(운영자 결정, 다섯 팀 공통)을 따릅니다: `agentKey = qa-release`,
  payload 직렬화 16 KiB 이하, 닫힌 schema, 단일 writer, 본문 보존 **90일**, 그 뒤 meta 행은 공통 규칙.
- Admin은 공통 Agent digest 영역 하나를 씁니다. 이 Agent의 쓰기 행위는 셋입니다: 운영자 제어 revision
  기록, main 병합 승인, 병합 레인 latch 해제. 셋 다 owner·ops 권한과 step-up을 요구합니다.

## 5. 감사

사람 행위는 `writeAdminAuditLog`, 시스템 행위는 `writeSystemAuditLog`로 같은 해시 체인에, **상태
변경과 같은 트랜잭션**에 남깁니다. 감사 테이블에 직접 쓰지 않습니다. 새 system actor는
`qa-release-intake`, `qa-release-merge-lane`입니다(닫힌 목록 추가는 리뷰 대상).

## 6. 운영자 제어 기록

- 운영자가 정하는 상태(활성화 여부, 양쪽 secret의 **회전 시각**(값 아님), 적용할 IaC commit, 병합
  레인의 레인별 스위치)를 append-only 기록으로 둡니다. 기록은 Admin 행위이고 같은 트랜잭션에 감사됩니다.
- 운영자는 Railway 변경과 같은 변경에서 서비스에 그 revision 번호를 설정합니다. 본 앱은 제출된 번호가
  최신 revision과 다르면 그 제출을 거절하고 알립니다. 결과를 모르면 진행하지 않고 사람이 확인합니다.
- 기록되지 않은 외부 변경(같은 commit의 재배포)과, 알림이 멎는 회복은 감사 행에 남고, 설명할 revision이
  없으면 알립니다. 활성 상태로 기록된 동안 본 앱 secret이 없어지면 조용해지지 않고 알립니다.

## 7. 알림

- 알림 kind는 넷이고 모두 **고정 제목 + 고정 문장 + Admin 링크**만 싣습니다: digest 기록, digest 침묵,
  감시 실패, 확인 필요(제출 충돌·운영자 제어 불일치·병합 레인 latch가 공유). 각 kind는 UTC 날짜당 1건입니다.
- 알림은 기존 운영자 알림 queue를 씁니다. 수용한 잔여: 이 kind의 행이 포기되면 기존 공용 incident가
  닫힌 이름과 정수를 싣고 나갈 수 있고, 공용 깊이 수치에 하루 최대 4행이 들어가며, 전송이 매우 느리면
  공용 backlog 신호가 켜질 수 있습니다.

## 8. 병합 레인

1. **범위.** develop(→ staging)과 main(→ production) 두 레인. 한 번에 하나씩 병합하고, Railway에 배포가
   둘 이상 쌓이지 않게 합니다. 이 Agent는 auto-merge를 켜지 않습니다.
2. **후보.** base가 레인 브랜치, draft 아님, check가 모두 끝났고 실패 없음, PR Fast Gate 성공 run이 하나
   이상, mergeable인 PR 중 가장 오래된 것. 판정 코드는 `scripts/merge-train-core.mjs`를 재사용합니다.
3. **develop 무인 병합과 제외.** 아래를 바꾸는 PR은 레인이 **병합하지 않고** Admin에 "사람 처리 대상"으로
   표시만 합니다. 사람이 GitHub에서 각자의 계약대로 처리합니다: 게이트 파일(`.github/**`, `scripts/check-*`,
   정책 테스트, `AGENTS.md`, `docs/policy/**`), `docs/release-gates/**`, 이 Agent 자신의 파일(이 정책의 부록이
   경로 목록을 고정, 판정은 PR base의 목록으로), head가 `agent/**`·`feedback-autofix/**`·`feedback-autofix-main/**`·
   `autofix/**`·`visual-baseline/**`인 PR. 변경 파일 목록을 끝까지 읽지 못하면 후보에서 빠집니다.
   **migration을 포함한 PR도 develop 무인 병합 대상입니다**(staging의 preDeploy가 적용).
4. **main은 사람 승인.** 후보는 `mainPullRequestDecision()`이 허용한 head뿐입니다. Admin 승인은 PR 번호·head
   SHA·base SHA·변경 파일 digest·판정기 버전·정책 버전에 결속되고 한 번만 소비되며, head나 base가 움직이면
   무효입니다. 이 레인에서는 그 Admin 승인 기록이 승인 증거입니다.
5. **hold와 추적.** 환경의 모든 Railway 서비스 중 하나라도 진행 중 배포가 있으면 병합하지 않습니다. 병합
   직전에 다시 읽고 head를 고정해 병합합니다. 그 브랜치를 배포하는 서비스 **전부**가 merge commit을 배포해야
   완료이고, 실패·건너뜀은 실패입니다.
6. **main의 base 고정.** 병합 직전 main tip이 승인 base와 같을 때만 병합합니다. main은 ruleset 둘로
   보호합니다 — 갱신 제한(bypass 대상은 이 App 하나)과, bypass 대상 없는 force-push 금지·삭제 금지·필수
   check·strict. classic 필수 리뷰는 해제합니다. 그래서 App 말고는 누구도 main을 갱신하지 못합니다. 이
   ruleset을 바꾸는 것은 main 레인을 끈 뒤에만 합니다. 병합 뒤 부모와 tree가 승인과 다르면 latch합니다.
7. **결과 불명.** 병합 전에 "시도 중"을 기록하고, 결과를 모르거나 배포가 실패하면 그 레인을 latch합니다.
   latch는 사람이 Admin에서 풉니다. 레인당 시도는 하나입니다.
8. **스위치.** 레인별 스위치 둘(운영자 제어 기록)과 kill switch 변수 하나. 입력을 하나라도 읽지 못하면
   병합하지 않습니다.
9. **임시 도구 퇴역.** develop 레인을 켜는 변경에서 로컬 `scripts/merge-train.mjs`의 develop 레인을 삭제합니다.

## 9. 단계

| 단계 | 내용 | 진입 조건 |
|---|---|---|
| S0 | digest·Monitor·운영자 제어 기록 구현, 전부 dark | 이 정책 승인, 정책 승인 증명 절차 통과 |
| S1 | staging에서 digest 활성 | S0 test 통과, 운영자 제어 revision 1 기록, IaC apply·secret 설정(운영자) |
| S2 | production 활성 | S1 30일, 침묵 오탐 0 |
| S-M0 | 병합 레인 구현(dark), 배포되지 않는 시험 브랜치에서 보호 설정 관측 | 이 정책 승인 |
| S-M1 | develop shadow(판정만, 병합 안 함) | S-M0 test 통과, App·Railway 토큰 설정 |
| S-M2 | develop 무인 병합 | S-M1 7일 이상 판정과 실제가 어긋난 건 0, 로컬 train의 develop 레인 삭제 |
| S-M3 | main 승인 레인 | S-M2 30일 무사고, main ruleset 설정, 시험 브랜치에서 사람의 병합·push는 거절되고 App 병합은 성공한 기록 |

되돌림: 서비스 활성화 변수 또는 레인별 스위치를 끕니다. 진행 중인 병합 시도는 GitHub 기록으로 확인될 때까지
latch로 남습니다. 시험 브랜치에서 App 병합이 성공하지 않으면(개인 계정 저장소에서 ruleset의 App bypass가
동작하지 않으면) S-M3에 들어가지 않고 운영자가 결정합니다.

## 10. 값 (승인 대상)

| 값 | 내용 | 상태 |
|---|---|---|
| timeout | 문장 2,000 ms, 유휴 1,000 ms, 트랜잭션 유도 최대 32 / 11 / 32 / 26초(단계 최악 69초), 순서 `Prisma > transaction > statement > idle`, BEGIN 시점 물려받는 `transaction_timeout`은 0 | 운영자 승인(대화, 2026-10-02) |
| digest | cron `0 21 * * *` UTC, hard timeout 15분, 침묵 기준 28시간, 본문 보존 90일, 재실행 권고 상한 2건·7일, issues 배열 40 / 30 / 30 | 운영자 승인(대화, 2026-10-02) |
| CI | PostgreSQL 17 전용 job 하나 | 운영자 승인(대화, 2026-10-02) |
| Monitor | cron `*/30 * * * *`, 호출자 timeout 120초 | 제안값 |
| 병합 레인 | cron 주기, 서비스 hard timeout 10분, 본 앱 트랜잭션 셋의 문장 수와 유도 최대, S-M2 7일, S-M3 30일 | 제안값(S-M0 전에 확정) |

## 11. 사람에게 남는 일

정책 승인과 병합, IaC apply, secret 설정과 회전 기록, GitHub App 발급과 ruleset 설정, main 병합 승인, latch
해제, 판정과 서명. 그 밖에 이 Agent가 사람에게 일을 만들지 않습니다.

## 부록 A. 이 Agent의 파일 (병합 레인의 제외 판정에 쓰는 경로 목록)

병합 레인은 아래 경로를 바꾸는 PR을 무인 병합하지 않습니다(8절 3항). 판정은 그 PR의 base에 있던 이 목록으로
합니다. 목록을 바꾸는 것은 이 정책 문서를 바꾸는 것이고, 정책 문서는 게이트 파일입니다.

```
scripts/qa-release-*
scripts/run-qa-release-monitor.mjs
scripts/classify-ci-failure-core.mjs
scripts/merge-train-core.mjs
scripts/merge-train.mjs
scripts/main-pr-source-policy.mjs
lib/qaRelease*
app/api/internal/agents/qa-release/**
app/api/admin/agents/qa-release/**
tests/qaRelease*
tests/mergeTrainCore.test.mjs
tests/mainPrSourcePolicy.test.mjs
.railway/**
```
