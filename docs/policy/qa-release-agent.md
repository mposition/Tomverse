# QA·릴리스 Agent 정책

상태: **승인됨(버전 7).** 최초 작성 2026-10-02, 버전 1 승인 2026-10-02, 버전 2 승인 2026-10-02, 버전 3 승인 2026-10-03, 버전 4 승인 2026-10-03, 버전 5 기록 2026-10-05, 버전 6 기록 2026-10-05, 버전 7 승인 2026-10-07.
approvedBy: mposition · approvedAt: 2026-10-07 · 정책 버전: 7
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| (미부여) | (미승인) | 최초 초안 |
| (미부여) | (미승인) | 두 번째 초안 — 독립 검토 반영: main은 사람이 병합하고 레인은 표시만, develop 제외 목록 보강, latch 전용 알림 |
| 1 | 2026-10-02 mposition | 최초 승인(세 번째 초안). 세 번째 초안 — 독립 검토 반영: App의 main 병합을 ruleset으로 막음(bypass는 저장소 관리자 역할만), 게이트 범위를 `package.json`과 `scripts/**`로, 제외는 후보 선정에서 건너뜀, 승인 판정 단계를 본문에, 모든 secret·키 회전 기록, staging migration 복구, 스위치 off, 단일 점유 |
| 2 | 2026-10-02 mposition | 버전 1의 독립 검토 반영 — 저장소 루트 파일 전체와 이 Agent의 테이블을 바꾸는 migration을 게이트로, develop 직접 push를 GitHub 설정으로 막고 그 관측을 S-M1 진입 조건으로, main ruleset은 시험 브랜치 관측 뒤에, 지시는 현재 revision·스위치·latch에 결속해 GitHub 호출 직전에 본 앱이 소비, 세 서비스 모두 revision 번호, kill switch는 "값이 있으면 정지", staging 복구 runbook을 S-M2 진입 조건으로, timeout의 문장 수와 Prisma 값, 승인 판정 0·4번 보강, glob 의미 |
| 3 | 2026-10-03 mposition | 버전 2의 독립 검토 반영 — 승인 판정 0번에서 genesis PR을 순환 밖으로, 4번을 기록으로 판정 가능한 조건으로, 지시 소비가 PR 번호·head SHA·base를 다시 확인하고 병합 호출은 head SHA로 고정, 본 앱은 자기가 읽을 수 있는 스위치만 판정하고 서비스 변수는 서비스가 스스로 판정, 시험 브랜치는 실제 보호 설정을 그대로 복제, App 갱신 제한을 develop 밖 모든 브랜치로 넓혀 base 변경 경쟁을 막고 병합 뒤 base를 확인, 모든 경로의 `package.json`·lockfile·`.npmrc`를 게이트로, 어느 문장이 규범인지 헤더에 명시, staging 복구 runbook의 내용 정정, kill switch 판정을 문장으로 고정, 시험용 App 자격증명과 실제 키 설정의 순서, timeout 식의 유휴 칸. S0 구현에서 확정된 값(경로, 문장 수, Monitor cron) 반영 |
| 4 | 2026-10-03 mposition | S-M0 구현 전에 확정할 병합 레인 값 — cron 10분, 서비스 hard timeout 10분, 본 앱 트랜잭션을 둘이 아니라 서비스가 부르는 셋(지시 발급, 지시 소비, 결과 보고)과 사람의 latch 해제로 바로잡고 각 문장 수와 유도 최대, 시도는 배포 결과(merge train의 deploymentOutcome 판정)까지 열어 두고 latch는 시도를 닫지 않으며 불명이거나 결과 보고가 오지 않은 시도는 순서 있는 PR 재조회(조상 판정은 비교 API의 관계로만)로 정하고, 규칙으로 끝나지 않는 시도는 사람이 latch 해제에서 확인한 사실(상태마다 두 가지)을 골라 조건부로 끝내며 0행이면 되돌림(A = 9), 비교 API는 `{merge commit}...develop` 방향, 4항의 SKIPPED 판정을 deploymentOutcome(연속 3건)으로 맞춤, unknown·대기 상한(15분·120분)에서 latch하고 열어 둠, 시도를 닫거나 옮긴 회차는 다른 일을 하지 않음, 결과 보고는 revision이 달라도 거절하지 않고 latch, 마감 검사는 서비스가 부르는 route의 것임을 명시, S-M2 7일. develop classic protection의 필수 승인 0건 유지(8절 10항의 운영자 결정, 2026-10-03 관측 기록) |
| 5 | 2026-10-05 mposition | 부록 A에 `components/admin/QaRelease*`를 더함 — S-M0에서 만든 병합 레인 Admin 화면(`components/admin/QaReleaseMergeLaneSection.tsx`, latch 표시와 사람의 latch 해제 양식)이 기존 패턴(`components/admin/AdminAgentDigests*`) 밖에 있어, 이 Agent의 판정 표시를 바꾸는 PR이 무인 병합 제외에서 빠지던 것을 바로잡음. 그 밖의 본문 변경 없음 |
| 6 | 2026-10-05 mposition | 버전 5의 재기록, 본문 변경 없음 — 버전 5 승인 기록(#2093)이 2026-10-04 23:53 UTC에 병합되어 승인 판정 5번(`approvedAt`과 병합의 UTC 날짜)을 통과하지 못했으므로, 같은 내용을 새 버전으로 다시 기록함 |
| 7 | 2026-10-07 mposition | 버전 5·6의 재기록, 본문 변경 없음 — 버전 6 승인 기록(#2102)이 2026-10-06 22:18 UTC에 병합되어 승인 판정 5번(`approvedAt`과 병합의 UTC 날짜)을 통과하지 못했으므로, 같은 내용을 병합할 UTC 날짜로 다시 기록함 |

**규범은 이 파일의 `develop` 현재 내용 하나입니다.** 이전 버전의 본문은 그 버전을 병합한 PR(버전 1 #1946, 버전 2 #1950,
버전 3 #1986, 버전 4 #2042, 버전 5 #2093, 버전 6 #2102)의 git 기록에 있으며, 효력이 없습니다. 이 버전의 승인 기록이 `develop`에 병합되는 순간 이 파일 전체가
버전 7로 효력을 갖고, 그 전까지는 버전 4가 효력입니다(버전 5와 버전 6의 기록은 승인 판정 5번을 통과하지 못해 효력을 갖지 않았습니다).

운영자 `mposition`이 2026-10-02 대화 세션에서 버전 1과 버전 2를, 2026-10-03 대화 세션에서 버전 3과 버전 4를, 2026-10-05 대화 세션에서 버전 5와 버전 6을, 2026-10-07 대화 세션에서 버전 7을 승인했다. 이 문서는 이 Agent 구현의 규범 근거다. 다만
**아래 승인 판정이 통과하기 전에는(이 승인 기록이 `develop`에 병합되기 전을 포함해) 그 버전이 처음 허용하는 단계의 어떤 코드도
작성·병합하지 않는다.** 이 문서는 Claude가 설계하고 독립 검토(교차 vendor)로 `accept` 판정을 받은 비공개 설계서를 공개 계약으로
옮긴 것이다. 내용 변경은 운영자 승인과 정책 버전 증가가 필요하다. 승인은 단계별 착수 조건을 없애지 않으며, 어떤
workflow·secret·branch protection·ruleset·GitHub App·Railway 변경도 그 자체로 허가하지 않습니다.

승인은 아래 단계를 **모두** 통과해야 인정합니다. 판정은 기록(git·GitHub)만으로 재현할 수 있어야 하며, script
(`npm run report:agent-policy-approval -- --policy docs/policy/qa-release-agent.md`)로 자동화해도 게이트가 아니라 보고입니다.

| # | 판정 |
|---|---|
| 0 | `approvedBy`의 계정이, 이 정책 파일을 바꾼 PR의 **base에 있던** `docs/policy/agent-operator-allowlist.md` 목록에 있다. 그 목록 파일의 최초 commit이 위 `allowlistGenesisCommit`과 같다. **최초 commit을 넣은 PR(genesis PR)의 commit은 그 파일 4절의 genesis이며 이전 목록이 없으므로 3절의 판정 대상이 아니다.** genesis PR 뒤로 base까지 그 목록 파일의 모든 변경은 그 파일 3절의 규칙(version 증가, 그 파일만 바꾼 PR, 이전 목록에 있는 계정의 병합, `to-develop` 브랜치 아님)을 따랐다 |
| 0a | 이 정책 파일의 `approvedBy`·`approvedAt`·정책 버전이 채워져 있고, 정책 버전이 직전 승인 버전보다 크다 |
| 1 | 이 정책 파일을 마지막으로 바꾼 commit을 찾는다 |
| 2 | 그 commit을 `develop`에 넣은 PR이 **정확히 하나**다 |
| 3 | 그 PR의 브랜치 이름에 `to-develop` 경로 조각이 없다 |
| 4 | 그 PR의 GitHub 병합자 계정이 `approvedBy`와 같다 |
| 5 | `approvedAt`이 그 병합의 UTC 날짜와 같다 |
| 6 | 그 PR이 이 정책 파일 하나만 바꾸고, 모든 commit의 작성자가 `approvedBy`이며 bot이 아니다 |
| 7 | 그 뒤 이 정책 파일이 다시 바뀌면 1번부터 다시 판정한다 |

**이 판정이 증명하는 것은 절차이지 사람이 아닙니다.** 이 저장소의 Agent 세션은 운영자 명의로 commit하고 그 계정의 토큰을 쓰므로
(승인자 목록 5절), 병합자가 사람인지는 기록으로 가릴 수 없습니다. 그래서 판정 4는 계정만 봅니다. 사람이 병합했다는 것은 운영
규칙으로 지킵니다: **정책 PR은 운영자가 GitHub 화면에서 직접 병합하고, Agent 세션은 정책 PR을 병합하지 않습니다.** 이 규칙은 판정이
아니며, 판정이 통과했다는 사실이 이 규칙이 지켜졌다는 증거도 아닙니다.

운영자가 내린 결정을 담습니다.

- 공통 기반은 모든 Agent가 따르는 **공유 정책**이고, 인프라는 Agent마다 따로 만들어도 된다(2026-10-02).
- 침묵 감시의 두 번째 실행 지점은 **전용 QA Release Monitor**로 둔다(2026-10-02).
- 알림은 기존 운영자 알림 queue를 쓰고, 그 queue에서 생기는 잔여를 7절대로 수용한다(2026-10-02).
- 운영자 제어(활성화·secret·IaC)의 감사는 이 Agent가 **자기 기록**으로 갖는다(6절, 2026-10-02).
- PR **병합 레인**을 이 Agent에 둔다. **develop만 무인으로 병합하고, main은 사람이 GitHub에서 병합한다**(8절, 2026-10-02).
- Monitor cron은 30분이다(10절, 2026-10-03).

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
| `QA Release Digest` (Railway cron) | digest 생성·제출 | 본 앱 제출 secret, **읽기 전용** GitHub token, 운영자 제어 revision 번호, 활성화 변수 | 제품 DB, GitHub 쓰기, 알림·LLM 키 |
| `QA Release Monitor` (Railway cron) | 침묵 감지 호출 | Monitor 전용 secret, 운영자 제어 revision 번호 | 그 밖의 모든 것 |
| `QA Release Merge Lane` (Railway cron) | 병합 레인의 사실 수집·develop 병합 실행 | GitHub App key(Contents·Pull requests write, Checks·Commit statuses·Metadata read), Railway 조회 토큰, 전용 secret, 운영자 제어 revision 번호, 활성화 변수, kill switch 변수 | 제품 DB, Workflows·Administration 권한 |

- 세 서비스는 변수를 공유하지 않습니다. 각 서비스는 자기 목록과 런타임·Railway의 정확한 이름 목록 밖의 변수가 하나라도 있으면
  시작하지 않습니다(이름 접두사로 허용하지 않음). 그래서 서비스는 `npm run`이 아니라 `node`로 직접 시작합니다 — npm은
  `npm_*`·`INIT_CWD`·`NODE`를 환경에 더합니다. IaC 선언의 변수 집합과 시작 검사의 목록은 test가 같은 목록으로 고정합니다.
- 판정은 본 앱 내부 route에서 합니다(LLM 없음, 외부 텍스트 실행 없음). 본 앱에는 GitHub 쓰기 토큰이 없습니다.
- **병합 레인 서비스는 스스로 고른 PR을 병합하지 않습니다.** 본 앱이 발급한 지시(attempt id, PR 번호, head SHA, base `develop`,
  발급 당시 운영자 제어 revision, 만료 시각 — 발급 뒤 2분)를 받습니다. 순서는 다음과 같습니다.
  1. 서비스가 PR을 다시 읽어 PR 번호·head SHA·base·mergeable·check 결과가 지시와 같은지 보고, **자기 활성화 변수와 kill switch를
     스스로 판정**합니다(8절 6항). 하나라도 어긋나면 소비를 요청하지 않습니다.
  2. 서비스가 본 앱에 소비를 요청하며 PR 번호·head SHA·base를 함께 보냅니다. 본 앱은 **자기가 읽을 수 있는 것만** 다시
     확인합니다: attempt가 아직 소비되지 않았음, 보낸 PR 번호·head SHA·base가 지시와 같음, 최신 revision이 지시의 revision과
     같음, develop 레인 스위치(운영자 제어 기록)가 켜짐, latch 없음, 만료 전. 소비는 조건부 갱신으로 **한 번만** 성공합니다.
  3. 소비에 성공한 지시만 병합하며, 병합 호출은 GitHub 병합 API의 `sha` 인자에 **지시의 head SHA**를 넣어 head를
     compare-and-swap으로 고정합니다(기존 merge train의 `--match-head-commit`과 같은 역할). head가 그 사이 바뀌었으면 GitHub가
     병합을 거절하고, 레인은 그 시도를 실패로 보고합니다. head 고정은 base 변경을 막지 못하므로(소비 뒤 PR의 base가 다른
     브랜치로 바뀌어도 head SHA는 그대로입니다), **base는 GitHub 설정이 막습니다**: 8절 7항의 갱신 제한 ruleset을 main만이 아니라
     **develop을 뺀 모든 브랜치**에 걸어, App은 develop 밖의 어떤 브랜치도 병합·갱신하지 못합니다.
  4. 결과는 그 attempt id로 보고합니다. 병합에 성공하면 서비스는 그 PR을 다시 읽어 **병합된 base가 `develop`이고 merge commit이
     develop의 이력에 있는지** 확인하고, 아니면(위 ruleset이 동작하지 않은 경우) 레인을 latch하고 결과 불명으로 보고합니다. 그 뒤의
     처리는 8절 5항의 순서 있는 재조회가 정합니다(버전 4).
  서비스 코드는 base가 `develop`이 아닌 병합 호출, `sha` 인자가 없는 병합 호출, 병합 API 밖의 쓰기(직접 push, ref 갱신)를
  하지 않으며, 정적 test가 이를 고정합니다.
- **App 키의 쓰기 권한은 저장소 전체입니다.** 그래서 코드가 하지 않는 쓰기를 GitHub 설정으로도 막습니다 — develop 밖의 모든 브랜치는 8절 7항,
  develop의 직접 push는 8절 9항.
- 서비스는 hard timeout에 강제 종료됩니다. **서비스가 부르는** 본 앱 route의 트랜잭션은 DB가 강제하는 문장·유휴 timeout과 마지막 문장의
  DB 시계 마감 검사로 묶이고, 늦은 실행은 성공으로 기록되지 않습니다. 마감은 DB 시계로 잡습니다(그 회차에서 DB가 읽은 시각에,
  그 읽기가 끝난 뒤 남은 예산을 더함). 트랜잭션당 최대 시간은 그 둘에서 **유도한 애플리케이션 값**이고 DB 상한이 아닙니다. 사람이 Admin에서 하는 쓰기(운영자 제어 기록,
  latch 해제)에는 회차가 없으므로 마감 검사가 없고, 문장·유휴 timeout으로만 묶입니다(버전 4에서 범위를 명시).
- **Monitor의 한계:** Monitor도 Railway cron이므로 Railway의 cron 실행 자체가 멈추면 digest와 함께 멈추고, 그 침묵은
  이 Agent가 보지 못합니다. 그 층은 운영·SRE Agent의 영역입니다.

## 4. 저장과 표시

- 결과는 공유 `AgentDigestItem` 계약(운영자 결정, 다섯 팀 공통)을 따릅니다: `agentKey = qa-release`, payload 직렬화
  16 KiB 이하, 닫힌 schema, 단일 writer, 본문 보존 **90일**, 그 뒤 meta 행은 공통 규칙.
- Admin은 공통 Agent digest 영역(`/admin/agent-digests`) 하나를 씁니다. 이 Agent의 쓰기 행위는 둘입니다: 운영자 제어
  revision 기록, 병합 레인 latch 해제. 둘 다 owner·ops 권한(`ops:write`)과 최근 로그인(step-up)을 요구합니다.
  **승인 버튼은 없습니다.**

## 5. 감사

사람 행위는 `writeAdminAuditLog`, 시스템 행위는 `writeSystemAuditLog`로 같은 해시 체인에, **상태 변경과 같은 트랜잭션**에
남깁니다. 감사 테이블에 직접 쓰지 않습니다. 새 system actor는 `qa-release-intake`, `qa-release-merge-lane`입니다(닫힌 목록
추가는 리뷰 대상). digest 기록과 침묵 알림 기록은 본 앱 쪽 행위이므로 `qa-release-intake`가 남깁니다.

## 6. 운영자 제어 기록

- 운영자가 정하는 상태(활성화 여부, **이 Agent의 모든 secret과 키** — digest 제출 secret, Monitor secret, 병합 레인 secret,
  GitHub App key, Railway 조회 토큰, 읽기 전용 GitHub token — 의 **회전 시각**(값 아님), 적용할 IaC commit, develop 병합 레인
  스위치)를 append-only 기록으로 둡니다. 기록은 Admin 행위이고 같은 트랜잭션에 감사됩니다. revision 번호는 1부터 빠짐없이
  늘고, 각 행은 같은 트랜잭션에서 사람이 남긴 감사 행을 가리키며, 이 둘은 DB가 강제합니다.
- 운영자는 Railway 변경과 같은 변경에서 **세 서비스 모두에** 그 revision 번호를 설정합니다. 본 앱은 세 서비스의 모든 호출
  (digest 제출, Monitor 호출, 병합 레인의 지시 발급·지시 소비)에서 번호가 최신 revision과 다르면 그 호출을 거절하고 알립니다.
  병합 레인의 **결과 보고는 거절하지 않습니다** — 거절하면 이미 일어난 병합의 기록이 사라지기 때문입니다. 결과는 기록하고, 번호가
  최신 revision과 다르면 같은 트랜잭션에서 레인을 latch하고 알리며, 그 보고로는 시도를 **성공으로 닫지 않습니다**(버전 4).
  digest 제출은 이 확인을 저장 트랜잭션 안에서 다시 하여, 본문이 오는 동안 기록된 새 revision도 놓치지 않습니다.
  결과를 모르면 진행하지 않고 사람이 확인합니다.
- 기록되지 않은 외부 변경(같은 commit의 재배포)과, 알림이 멎는 회복은 감사 행에 남고, 설명할 revision이 없으면
  알립니다. 활성 상태로 기록된 동안 본 앱 secret이 없어지거나 32자보다 짧아지면 조용해지지 않고 알립니다.

## 7. 알림

- 알림 kind는 다섯이고 모두 **고정 제목 + 고정 문장 + Admin 링크**만 싣습니다: digest 기록, digest 침묵, 감시 실패,
  확인 필요(제출 충돌·운영자 제어 불일치), **병합 레인 latch**. 각 kind는 UTC 날짜당 1건이므로 이 Agent의 알림은 하루
  최대 5건입니다. 날짜는 DB 시계의 UTC 날짜입니다.
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
     있습니다), **저장소 루트의 모든 파일**(`eslint.config.mjs`, `tsconfig*.json`, `.gitleaks.toml`, `next.config.*`,
     `playwright*.config.ts` 등 검사의 실행과 설정을 정하는 파일), **경로와 관계없이 모든 `package.json`·`package-lock.json`·
     `npm-shrinkwrap.json`·`.npmrc`**(workspaces의 `packages/*`·`apps/*` 아래 것을 포함합니다 — 그 `postinstall`은 `npm ci`에서
     실행됩니다), 정책 테스트(PR base의 `docs/policy/**`·`AGENTS.md`·`CLAUDE.md`가 경로로 이름 댄 `tests/**` 파일), `AGENTS.md`,
     `CLAUDE.md`, `docs/policy/**`, `docs/ui-contracts/**`, `docs/release-gates/**`, `lib/adminAuth*`,
     `lib/adminAuditSystemActors.ts`, `lib/agentAuthorityFiles.ts`.
   - 변경 경로에 이 Agent 자신의 파일(부록 A, 판정은 PR base의 목록으로).
   - 이 Agent의 테이블(`AgentDigestItem`, `QaRelease`로 시작하는 테이블)을 이름 대는 migration. 판정은 변경된
     `prisma/migrations/**/migration.sql` 본문에 그 테이블 이름이 나오는지로 하고, 본문을 읽지 못하면 제외합니다.
   - head 브랜치 `agent/**`, `marketing-agent/**`, `feedback-autofix/**`, `feedback-autofix-main/**`, `autofix/**`,
     `visual-baseline/**`, `dependabot/**`.
   - 변경 파일 목록(전체 페이지, rename은 이전·이후 경로 둘 다)을 끝까지 읽지 못한 PR.
   **migration을 포함한 PR도 무인 병합 대상입니다**(staging의 preDeploy가 적용합니다). git revert는 적용된 migration과 실패한
   migration 기록을 되돌리지 않습니다. 그래서 staging 배포가 실패하면 레인은 latch하고, 운영자가 staging DB를 복구한 뒤에만
   latch를 풉니다. **복구 절차는 S-M2 진입 전에 runbook으로 있어야 합니다.** runbook은 다음을 새로 적습니다(기존 문서의 절을
   빌려 쓰지 않습니다): 대상 환경이 staging임을 확인하는 단계, staging DB를 재생성하거나 백업에서 복원해 migration 이력을
   병합 직전 상태로 되돌리는 절차, **적용되지 않고 실패로 남은** migration 행에만 `prisma migrate resolve --rolled-back`을
   쓰는 조건(이미 적용된 migration은 resolve로 되돌릴 수 없으므로 DB 복원이 답입니다), 복구 뒤 schema 비교(drift 0) 확인. 그
   runbook이 없으면 S-M2에 들어가지 않습니다.
4. **hold와 추적.** staging 환경의 모든 Railway 서비스 중 하나라도 `WAITING`·`NEEDS_APPROVAL`·`QUEUED`·`INITIALIZING`·
   `BUILDING`·`DEPLOYING`이면 병합하지 않습니다. 병합 직전에 다시 읽고 head를 고정해 병합합니다(3절의 `sha` 인자). develop을
   배포하는 서비스 **전부**가 merge commit을 배포해야 완료이고, `FAILED`·`CRASHED`·`SKIPPED`는 실패입니다. **(버전 4) 완료와 실패는
   merge train과 같은 `deploymentOutcome`의 `succeeded`·`failed`이고, 그 밖의 상태는 5항이 다룹니다.** 이 판정에 대해서는 앞 문장이
   아니라 그 함수가 규범입니다.
5. **결과 불명.** 병합 전에 "시도 중"을 기록하고, 결과를 모르거나 배포가 실패하면 레인을 latch합니다. latch는 사람이 Admin에서
   풉니다(10절의 "사람의 latch 해제" 트랜잭션, Admin 행위로 같은 트랜잭션에 사람 감사). **레인당 시도는 하나입니다** — "시도 중" 행은 레인당 하나만 존재할 수 있게 DB가 강제하고(조건부 단일 점유), 두 회차가
   겹쳐 둘 다 유휴를 읽어도 두 번째는 점유에 실패해 병합하지 않습니다. **(버전 4) 시도는 배포 결과가 나올 때까지 열려 있습니다.**
   "레인당 하나"는 닫히지 않은 시도 전체(지시 발급됨, 소비됨, 병합됨·배포 대기)에 대한 DB 제약입니다. 시도는 다음처럼만 닫히거나 옮깁니다.
   - **병합 결과 성공**이면 GitHub가 돌려준 **merge commit SHA를 시도에 기록하고** "병합됨, 배포 대기"로 옮깁니다. 레인은 다음 PR을
     고르지 않습니다.
   - **배포 대기**인 시도는 다음 회차들이 merge train과 같은 방법으로 판정합니다: 그 merge commit, 그것을 담은 뒤의 develop
     commit 목록(`containing`), check run이 취소된 commit 목록(`cancelled`)을 `scripts/merge-train-core.mjs`의
     `deploymentOutcome`에 넣습니다. `succeeded`면 성공으로 닫고, `failed`면 닫으면서 latch합니다. `unknown`(알 수 없는 상태, rollback,
     자리를 찾지 못한 교체)이면 latch하고 열어 둡니다. `not_seen`은 병합 뒤 15분, `in_progress`·`partial`은 120분까지 대기이고(merge
     train의 기본값과 같음), 그 시간이 지나면 latch하고 열어 둡니다. 두 목록이나 Railway를 읽지 못하면 latch하고 열어 둡니다.
   - **병합 결과 실패**(GitHub가 병합을 거절)이면 닫습니다.
   - **병합 결과가 불명**이거나 **결과 보고가 오지 않은 시도**(지시 발급·소비 상태로 지시 만료와 hard timeout을 합한 12분이 지난
     것)는 latch하고, 다음 회차부터 PR을 다시 읽어 **아래 순서대로, 처음 답이 나는 단계에서** 정합니다. (1) PR을 읽지 못하면 열어 둔 채 다음 회차에 다시 읽습니다.
     (2) 병합되지 않았으면(열려 있든 닫혀 있든) 닫습니다. (3) 병합되었고 base가 develop이 아니면 닫으면서 latch하고 알립니다.
     (4) 병합되었고 base가 develop이면 PR이 이름 댄 merge commit이 develop의 조상인지 GitHub의 비교 API로 묻습니다 — 목록을 읽어
     없음을 판정하지 않습니다. 호출은 **`compare/{merge commit}...develop`**(base가 merge commit, head가 develop)이고, 돌려준 `status`가
     `ahead`나 `identical`일 때만 조상입니다(`behind`·`diverged`는 조상이 아님). 조상이면 **그 merge commit SHA를
     기록하고** "병합됨, 배포 대기"로 옮깁니다. 조상이 아니거나, merge commit이 없거나, 비교 API가 답하지 않으면 latch하고 **열어
     둡니다**(3절의 결과 불명과 같은 처리). 열린 채 latch된 시도는 다음 회차들이 같은 순서로 다시 읽고, 끝내 정해지지 않으면 사람이
     닫습니다(아래).
   - **latch는 시도를 닫지 않습니다.** 사람이 latch를 풀어도 열린 시도가 있으면 레인은 새 지시를 발급하지 않고, 위 규칙으로 그
     시도를 먼저 끝냅니다. 위 규칙으로 끝나지 않는 시도는 **사람이 latch 해제에서, 자기가 GitHub와 Railway에서 확인한 사실을 고르는 것으로**
     끝냅니다. 고를 수 있는 것은 상태마다 둘뿐입니다.
     - 지시 발급·소비 상태: "PR이 develop에 병합되지 않았음"(닫음), 또는 "develop에 병합되었음"과 그 merge commit SHA(배포 대기로
       옮김 — 배포 추적은 위 규칙대로 계속됩니다).
     - 배포 대기 상태: "develop을 배포하는 staging 서비스 전부가 이 merge commit이나 그것을 담은 뒤의 commit을 서비스 중"(성공으로
       닫음), 또는 "3항의 runbook으로 staging을 병합 직전 상태로 복구했음"(실패로 닫음).
     Admin은 그 시도의 attempt id·상태·PR·merge commit(있으면)·staging 배포 목록을 보여 주고, 시도를 바꾸는 갱신은 **보여 준
     attempt id와 상태가 그대로일 때만** 한 행을 바꿉니다. **0행이면 트랜잭션 전체를 되돌리고**(latch도 풀리지 않음) 화면을 다시
     읽게 합니다. 고른 사실과 입력한 SHA는 같은 트랜잭션의 사람 감사에 남습니다. 확인은 사람의 판정이고 이 Agent는 그것을
     검증하지 않습니다. 그래서 배포가 남아 있는 동안 다음 병합이 쌓이지 않습니다. 위 규칙들은 latch가 걸린 동안에도 시도를
     판정하고 기록하며(병합 호출은 하지 않음), 다시 latch가 필요하면 알립니다.
   **시도를 닫거나 옮긴 회차는 다른 일을 하지 않습니다** — 다음 PR은 그다음 회차가 고릅니다.
6. **스위치.** 병합은 다음이 **모두** 성립할 때만 합니다. 각 스위치는 **그것을 읽을 수 있는 쪽이 판정**합니다.
   - 서비스 활성화 변수가 `true` — 병합 레인 서비스가 판정합니다.
   - kill switch 변수가 **선언되어 있고 비어 있음** — 병합 레인 서비스가 판정합니다. 공백을 포함해 어떤 문자든 들어 있으면
     정지이고, 선언되지 않은 것은 읽지 못한 것으로 보아 정지입니다.
   - develop 레인 스위치(운영자 제어 기록)가 켜져 있음 — 본 앱이 판정합니다.
   서비스는 자기 변수의 판정을 지시 소비를 요청하기 전과 병합 호출 직전에 하고, 본 앱은 자기 스위치의 판정을 지시 발급과
   지시 소비에서 합니다. 본 앱은 서비스 변수의 값을 받아 판정하지 않습니다(자기 보고가 되기 때문입니다). **운영자가 본 앱
   쪽에서 레인을 멈추는 수단은 develop 레인 스위치를 끄는 revision 기록이며**, 이것은 다음 소비부터 모든 병합을 거절합니다.
   kill switch 변수는 서비스를 그 자리에서 멈추는 별개의 수단입니다.
7. **App은 develop 밖의 어떤 브랜치도 갱신하지 못하게 둡니다.** 필수 리뷰는 App도 지켜야 할 규칙일 뿐이라, 사람이 리뷰를 남긴
   main PR은 App도 병합 API로 병합할 수 있습니다. 그리고 지시를 소비한 뒤 PR의 base가 다른 브랜치로 바뀌면 head 고정만으로는 그
   병합을 막지 못합니다(3절). 그래서 **develop을 뺀 모든 브랜치**(main 포함)에 **갱신 제한 ruleset**(`update`)을 두고 **bypass는
   저장소 관리자 역할과 관측으로 확인한 필수 자동화만**(아래), **이 App은 넣지 않습니다**. App이 브랜치를 만들 일은 없으므로 생성 제한(`creation`)도 함께 둡니다. **순서는
   시험 먼저입니다.** S-M0에서 시험 브랜치로 먼저 관측합니다(아래 10항). 관측 항목: 리뷰가 없는 PR의 App 병합 거절, **리뷰가 끝난
   PR의 App 병합 거절**, App의 직접 push 거절, **base가 develop도 main도 아닌 PR의 App 병합 거절**, **운영자의 병합 성공**. 다섯이
   모두 기대대로일 때만 실제 저장소에 같은 ruleset을 겁니다. 하나라도 다르면(예: 개인 계정 저장소에서 관리자 역할 bypass가 동작하지
   않으면) ruleset을 걸지 않고, **S-M1에도 들어가지 않으며**, 운영자가 다음을 정합니다. 이 보호를 바꾸는 것은 이 정책의 개정입니다.
   ruleset은 bypass 목록 밖의 **모든** actor에게 걸리므로, 브랜치를 갱신해야 하는 기존 자동화(Dependabot, 저장소 workflow의
   GitHub Actions 등)는 bypass에 넣고 **이 App만 넣지 않습니다**. 관측에는 그 자동화의 브랜치 갱신 성공도 포함하며, 거는 날과
   bypass 목록은 운영자가 관측 결과를 보고 정합니다.
8. **병합 주체의 전환.** develop 레인을 켜는 변경에서 로컬 `scripts/merge-train.mjs`의 develop 레인을 삭제하고, AGENTS.md의
   "workflow는 PR을 열기만 하고 auto-merge를 켜지 않습니다" 절이 develop 병합 주체를 이 레인으로 고쳐 적습니다. 둘 다 게이트
   파일이므로 사람이 병합합니다.
9. **develop의 직접 push도 막습니다.** 필수 check는 이미 check를 통과한 commit의 직접 push를 막지 못합니다. 그래서 develop에
   **PR 필수 ruleset**(`pull_request` 규칙, 필수 승인 0건)을 두고 bypass는 저장소 관리자 역할만 둡니다. App은 PR 병합만 할 수
   있고 직접 push는 거절됩니다. S-M0의 시험 브랜치에서 **check를 통과한 commit의 App 직접 push 거절**과 App의 PR 병합 성공,
   운영자의 직접 push 성공을 관측하고, 기대대로일 때만 실제 develop에 겁니다. 관측이 다르면 S-M1에 들어가지 않습니다.
   다른 세션의 브랜치가 develop에 직접 push하던 경로가 있다면 이 규칙이 그것도 막으므로, 거는 날을 운영자가 정합니다.
10. **시험 브랜치는 실제 보호를 그대로 복제합니다.** 관측 전에 대상 브랜치(main 또는 develop)의 **현재 유효한 보호 전부** —
    classic branch protection(필수 승인 수, strict, 필수 check, `enforce_admins`)과 이미 걸린 ruleset — 를 GitHub API로 읽어
    기록하고, 시험 브랜치에 같은 설정과 이번에 더할 ruleset을 함께 겁니다. 관측 결과는 그 기록과 함께 남기며, 대상 브랜치의
    보호가 관측 뒤에 바뀌면 그 관측은 효력을 잃습니다. develop에 classic protection의 필수 승인이 1건 이상 남아 있으면 App의 PR
    병합이 거절되므로, 그 값을 무엇으로 둘지는 S-M0 관측 전에 운영자가 정하고 이 정책의 개정으로 적습니다. **(버전 4) 필수 승인은
    0건을 유지합니다.** 2026-10-03 GitHub API 읽기로 관측한 develop의 classic protection: PR 필수(필수 승인 0건,
    `dismiss_stale_reviews`·`require_code_owner_reviews`·`require_last_push_approval` 꺼짐), 필수 check 3개(`Security, unit, build,
    and Chromium smoke tests`, `Admin Console E2E (PostgreSQL)`, `Build and test the Rust workspace`), `strict` 꺼짐,
    `enforce_admins` 꺼짐, 걸린 ruleset 없음. 이 관측은 시험 브랜치 관측(7항·9항) 직전에 다시 읽어 같을 때만 쓰며, 다르면 그 관측이
    효력을 잃는 것과 같은 규칙을 따릅니다.
11. **App 자격증명의 순서.** S-M0의 관측에는 App 인증이 필요합니다. 그래서 S-M0에서는 운영자가 **관측용 App 설치와 키**를
    로컬에서만 쓰고, 그 키를 Railway 서비스나 저장소 secret에 넣지 않습니다. main·develop ruleset이 모두 걸린 뒤(S-M1 진입
    조건) 실제 서비스용 키를 발급해 병합 레인 서비스에만 설정하고, 관측용 키는 폐기합니다. 어느 단계에서도 ruleset이 걸리기
    전에 App 키가 Railway에 있지 않습니다.

## 9. 단계

| 단계 | 내용 | 진입 조건 |
|---|---|---|
| S0 | digest·Monitor·운영자 제어 기록 구현, 전부 dark | 이 정책 승인, 승인자 목록 절차 통과 |
| S1 | staging에서 digest 활성 | S0 test 통과, 운영자 제어 revision 1 기록, IaC apply·secret 설정(운영자) |
| S2 | production 활성 | S1 30일, 침묵 오탐 0 |
| S-M0 | 병합 레인 구현(dark), 시험 브랜치 관측(8절 7항·9항·10항, 관측용 App 키는 로컬만 — 11항) 뒤 develop 밖 모든 브랜치·develop ruleset 설정 | 이 정책 버전 3 승인, 공통 기반의 병합 레인 예외 반영 |
| S-M1 | develop shadow(판정만, 병합 안 함) | S-M0 test 통과, **8절 7항·9항의 관측이 모두 기대대로이고 ruleset이 걸림**, 그 뒤에 실제 App 키·Railway 토큰 설정(8절 11항) |
| S-M2 | develop 무인 병합 | S-M1 7일 이상 판정과 실제가 어긋난 건 0, 8절 8항의 변경 병합, 8절 3항의 staging 복구 runbook |
| S-M3 | main 후보·production 상태 표시 | S-M2 운영 중. 병합 호출 없음 |

되돌림: develop 레인 스위치를 끄는 revision을 기록하거나(본 앱이 다음 소비부터 거절), 서비스 활성화 변수를 끄거나, kill switch
변수에 값을 넣습니다(서비스가 그 자리에서 멈춤). 진행 중인 병합 시도는 GitHub 기록으로 확인될 때까지 latch로 남습니다. 이미
병합된 commit은 사람이 revert PR로 되돌립니다.

## 10. 값

"승인"은 이 문서의 승인으로 확정된 값이고, "제안값"은 적힌 기한 전에 이 문서의 개정으로 확정합니다.

| 값 | 내용 | 상태 |
|---|---|---|
| timeout | 문장 2,000 ms, 유휴 1,000 ms(DB가 강제, 문장마다·유휴 구간마다 다시 걸림). 트랜잭션당 최대는 그 트랜잭션의 **문장 수 A의 상한**으로 유도한 애플리케이션 값 `3A + 5`초입니다. 문장마다 2초, 유휴 구간마다 1초(실제 유휴 구간은 A − 1개이므로 이 식은 1초 여유를 더 둡니다), 시작·끝 왕복과 여유 5초. digest 제출 저장 A = 9 → 32초, 침묵 판단 읽기 A = 2 → 11초, 침묵 알림 기록 A ≤ 9 → 32초, 감시 실패 기록 A = 7 → 26초, **운영자 제어 기록 A = 8 → 29초**. 문장 수에는 감사 기록의 네 문장(잠금, 시각, 직전 항목, 삽입)을 넣으며, 무결성 키가 없으면 직전 항목을 읽지 않아 한 문장 적습니다. 침묵 감지 한 회차의 최악은 읽기·알림·감시 실패의 합 69초(11 + 32 + 26)이고, 제출 저장은 다른 route입니다. **Prisma interactive transaction의 timeout은 각 트랜잭션의 최대보다 5초 길게 명시하고**(기본 5초를 쓰지 않음), 상수 순서 `Prisma > transaction > statement > idle`을 test가 고정합니다. 감사 체인 잠금은 timeout을 거는 문장과 **별도의 다음 문장**으로 잡습니다(같은 문장 안의 `set_config`는 그 문장에 timeout을 걸지 못합니다). 문장 수가 바뀌면 이 값도 이 문서의 개정으로 바뀝니다. PostgreSQL 17에서만 있는 `transaction_timeout`은 그 서버가 지원할 때만 걸고, 16에서는 걸지 않습니다 | 승인 |
| digest | cron `0 21 * * *` UTC, hard timeout 15분, 침묵 기준 28시간, 본문 보존 90일, 재실행 권고 상한 2건·7일, issues 배열 40 / 30 / 30, CI 행은 job마다 창 안의 최신 실행 하나(상한 16) | 승인 |
| CI | PostgreSQL 17 전용 job 하나(17 경로의 시험용) | 승인 |
| Monitor | cron `*/30 * * * *`, 호출자 timeout 120초(route의 한 회차 예산 110초보다 김) | 승인(2026-10-03) |
| 병합 레인 | cron `*/10 * * * *` UTC, 서비스 hard timeout 10분, S-M2 진입에 필요한 S-M1 기간 7일. **서비스가 부르는** 본 앱 트랜잭션은 셋이며 위 timeout 행의 식을 따릅니다. **지시 발급** A = 9 → 32초: timeout 설정, 감사 체인 잠금, 최신 revision·스위치·latch·열린 시도를 한 문장으로 읽기, 시도 행 삽입(레인당 하나는 DB 제약), 감사 네 문장, 마감 검사. **지시 소비** A = 9 → 32초: timeout 설정, 감사 체인 잠금, 지시 행을 잠그고 최신 revision·스위치·latch와 함께 한 문장으로 읽기, 소비하지 않은 행만 바꾸는 조건부 갱신, 감사 네 문장, 마감 검사. **결과 보고** A = 10 → 35초: timeout 설정, 감사 체인 잠금, 열린 시도만 바꾸는 조건부 갱신(최신 revision을 같은 문장에서 읽음), latch 기록, latch 알림 큐 행(한 문장), 감사 네 문장, 마감 검사. latch가 없는 경로는 문장이 더 적지만 **한도는 항상 A = 10으로 겁니다** — 같은 호출이 revision 불일치로 latch 경로가 될 수 있기 때문입니다. 결과 보고는 병합 결과, 배포 판정, 불명·미보고 시도의 PR 재조회 판정 세 종류이고 구성이 같습니다(8절 5항). merge commit SHA는 시도를 바꾸는 같은 조건부 갱신에서 기록합니다. **사람의 latch 해제**(Admin 행위) A = 9 → 32초: timeout 설정, 감사 체인 잠금, latch 행과 열린 시도를 한 문장으로 읽기, 사람이 고른 경우 보여 준 attempt id와 상태에 묶인 조건부 갱신으로 시도를 닫거나 옮기기(0행이면 트랜잭션을 되돌림), 사람 감사 네 문장, 그 감사 행을 가리키는 latch 해제 갱신(8절 5항). 시도를 건드리지 않는 경로는 문장이 하나 적지만 한도는 A = 9로 겁니다. 마감 검사는 없습니다(3절). 서비스 한 회차의 본 앱 호출은 **발급·소비·병합 결과 보고 셋(최악 99초 = 32 + 32 + 35)이거나, 열린 시도에 대한 결과 보고 하나(35초)**이고, 둘을 한 회차에서 함께 하지 않습니다(8절 5항). 어느 쪽도 hard timeout 안에 있습니다 | 승인(버전 4) |

## 11. 사람에게 남는 일

정책 승인과 병합, IaC apply, secret 설정과 회전 기록, GitHub App 발급(관측용과 실제용), 시험 브랜치 관측, ruleset 설정, latch 해제,
**main 병합**, 제외된 develop PR의 처리, 병합된 commit의 revert, staging 복구, 판정과 서명. 그 밖에 이 Agent가 사람에게 일을
만들지 않습니다.

## 부록 A. 이 Agent의 파일 (병합 레인의 제외 판정에 쓰는 경로 목록)

병합 레인은 아래 경로를 바꾸는 PR을 무인 병합하지 않습니다(8절 3항). 판정은 그 PR의 base에 있던 이 목록으로 합니다.
패턴에서 `**`는 디렉터리를 넘고, `*`는 한 경로 조각 안에서 맞추되 **패턴 끝의 `*`는 그 이름으로 시작하는 더 깊은 경로까지**
맞춥니다(`lib/qaRelease*`는 `lib/qaRelease` 디렉터리 아래 파일도 맞춤). 8절 3항의 `lib/adminAuth*`도 같습니다.
목록을 바꾸는 것은 이 정책 문서를 바꾸는 것이고, 정책 문서는 게이트 파일입니다. 이 Agent의 script(`scripts/**` 아래)는 8절
3항의 `scripts/**` 제외에 이미 들어가므로 여기 다시 적지 않습니다. 공유 `AgentDigestItem` 계약의 파일과 Admin의 공통 Agent digest
영역도 이 Agent가 쓰는 판정과 표시를 정하므로 함께 적습니다.

```
lib/qaRelease*
lib/agentDigest*
lib/agentPolicyApproval*
lib/adminMessages/agentDigests*
app/api/internal/agents/qa-release/**
app/api/admin/agent-digests/**
app/(site)/(application)/admin/agent-digests/**
components/admin/AdminAgentDigests*
components/admin/QaRelease*
tests/qaRelease*
tests/agentDigest*
tests/agentPolicyApproval*
tests/integration/qa-release-*
tests/integration/agent-digest-*
tests/mergeTrainCore.test.mjs
tests/mainPrSourcePolicy.test.mjs
.railway/**
```
