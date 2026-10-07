# 엔지니어링 Agent 정책

상태: **승인됨 — 단계별 구현 중.** 최초 작성 2026-09-21, 두 번째 초안 2026-09-27, 최초 승인 2026-09-28.
approvedBy: mposition · approvedAt: 2026-10-07 · 정책 버전: 4

| 버전 | 승인 | 변경 |
|---|---|---|
| (미부여) | (미승인) | 최초 초안 |
| 4 | 2026-10-07 mposition | 배포 이미지에 실제로 없는 비런타임 파일만 통제 평면 slice에서 제외할 수 있는 좁은 예외. 동일 base commit·tree·운영자가 확인한 이미지 digest와 전체 파일 목록, 앱의 목록 SHA 재계산, 런타임 source SHA·deployment ID 대조, 동적 파일 접근 분석과 배포 후 실측이 모두 필요하다. 앱이 OCI digest를 독립 조회한다고 주장하지 않는다. v22 게시 경로는 Task 실행·기존 Publisher 스위치와 별도인 기본 꺼짐 코드 latch를 둔다. 게시 산출물이 없는 성공에는 `private_result`를 기록한다. 하나라도 없으면 기존 T2 유지 |
| 3 | 2026-10-07 mposition | v22 경로에서 전체 결과 tree 목록 대신 변경 파일 경로·mode·새 blob 바이트만 제출하는 동등 검증 방식을 승인. 앱은 GitHub 기준 tree로 결과 tree를 재구성하지만 patch는 적용·실행하지 않으며 Publisher가 실제 적용 결과 hash를 다시 대조한다 |
| 2 | 2026-10-06 mposition | v22 로컬 Ubuntu 구현 Task의 검증된 패치를 별도 Engineering Publisher의 기존 T1 경계로 전달하는 좁은 원천 예외. `develop` PR 게시까지만 허용하고 자동 병합·배포와 `main` 행위는 허용하지 않는다. 기존 auto-merge 없는 규칙을 명시한다 |
| 1 | 2026-09-28 mposition | 최초 승인(두 번째 초안). 작업 원천을 승격된 AMUX 카드로 바꾸고 issue 작업 승인을 없앰, 카드 자기 등록, 외부 행위 유형 `engineering.publish_pr`, AMUX 부착 방식과 교차 잠금, tree 목록 검증과 capability, 병합 관측 일곱 조건, 본 앱의 시간 상한 |

운영자 `mposition`이 2026-09-28 대화 세션에서 버전 1을, 2026-10-06 대화 세션에서
v22 구현 Task의 좁은 Publisher 연결을 승인했고(버전 2), 2026-10-07에는
변경 파일 제출 방식의 결과 tree 대조를 승인했고(버전 3), 같은 날 이미지 증거 방식과
좁은 비런타임 제외 계약을 최종 승인했다(버전 4). 이제 이 문서는
engineering Agent 구현의 규범 근거다. **승인은 단계별 착수 조건을 없애지 않는다** — §14의
순서와 각 단계의 종료 증거, §8의 AMUX 쪽 선행 개정, §2.2의 등록 원천 선행 조건, 각 단계의
독립 검토는 그대로 적용된다. 이 승인은 어떤 workflow·secret·branch protection·GitHub App·
ruleset 변경도 그 자체로 허가하지 않는다. 내용 변경은 운영자 승인과 정책 버전 증가가
필요하다.

이 문서는 Claude가 설계하고 Codex가 독립 검토해 승인 판정을 낸 비공개 설계서를 공개
계약으로 옮긴 것이다. 두 번째 초안은 운영자가 2026-09-27에 내린 세 결정을 담는다 —
작업은 승격된 AMUX 카드로만 받는다, 에이전트의 PR은 AMUX 승인 계약이 외부 행위를 제외한
규칙의 예외로 허용한다, 에이전트가 우리 backlog를 분석해 AMUX backlog에 자기 카드를
등록한다.

## 0. 이 문서와 AMUX 문서의 관계

개발 Agent에 관한 공개 정책은 넷이고 적용 대상이 다르다.

| 문서 | 적용 대상 | 담는 것 |
|---|---|---|
| `docs/policy/development-agent-orchestration.md` | **모든** 개발 Agent worker | 실행 제어 — 우선순위, 소유권(compare-and-set), 선택과 실행의 분리, 실행 권한 fence, 전달, 작업 검토 |
| `docs/policy/amux-intake.md` | AMUX backlog에 들어오는 **모든** 카드 | 카드 등록의 형식·검사·중복 |
| `docs/policy/amux-agent-approval-contract.md` | AMUX의 사람 승인 | 승격·검토 승인과 그 결속, 외부 행위 제외 규칙 |
| 이 문서 | engineering Agent **하나** | 권한 — 무엇을 등록할 수 있는가, 결과물이 공개 저장소와 쓰기 가능 자격증명에 어디까지 닿는가, 공개된 PR의 승인 증거 |

**AMUX 규칙은 이 문서에 옮겨 적지 않고 지목한다.** 같은 규칙이 두 곳에 있으면 한쪽만
고쳐질 때 어느 쪽이 계약인지 알 수 없게 된다. 반대로 tier·push 금지·게시·등록 원천
규칙은 이 에이전트의 것이며 다른 팀의 worker에 적용되지 않는다.

두 문서가 충돌하면 **적용 범위가 좁은 쪽**이 이긴다. 실행 제어와 카드 형식에 대해서는
AMUX 문서가, engineering의 권한에 대해서는 이 문서가 좁은 쪽이다. 유일한 명시적 예외는
§7-2의 외부 행위 유형이며, 그것은 운영자가 AMUX 승인 계약의 외부 행위 제외 규칙에
대해 준 예외다.

## 1. 하는 것과 하지 않는 것

### 하는 것

1. 소유자의 검토 시간을 **판단에만** 쓰게 한다. 에이전트는 재현·수정·검증·PR 본문
   까지 준비하고, 소유자는 병합 여부만 판단한다. 이 정책의 범위에서 **병합은 전부
   사람이 한다.**
2. 무엇을 할지, 어디까지 올릴 수 있는지, 무엇을 공개 저장소에 쓸 수 있는지를
   **LLM이 아니라 결정적 코드**가 정한다.
3. LLM이 쓴 코드는, 사람이 병합하기 전까지, 쓰기 가능 자격증명과 같은 job·
   파일시스템·cache에 닿지 않는다. 이는 에이전트 자신의 실행뿐 아니라 에이전트가
   연 PR이 trigger하는 저장소의 기존 workflow에도 적용된다.
4. 우리 backlog에서 한 카드로 검증할 수 있는 작업을 찾아 AMUX backlog에 **등록**한다.
   등록은 실행이 아니며, 실행은 사람이 승격한 카드에서만 시작한다.
5. 소유자에게 가는 산출은 상한과 만료가 있는 대기열 안에서만 생긴다.
6. 기존 계약(branch 이름 권한, auto-merge를 켜지 않는 규칙, feedback-autofix 정책, release
   checklist)을 재사용하고 약화하지 않는다.

### 하지 않는 것

- **무인 병합.** 이 정책은 부여하지 않는다.
- **카드 승격과 PR 승인.** 에이전트는 자기가 등록한 카드를 승격하지 않고, 어떤 PR도
  승인하지 않는다.
- 자동 revert, Dependabot PR auto-merge. 각각 독립 결정이다.
- `main` 병합, production 배포, release PR 생성.
- 가격·크레딧·프로모션 값, release-gate status, feature flag, secret의 결정.
- feedback-autofix case와 cron-auto-fix incident 처리. 둘은 비공개 서버 데이터를
  입력으로 하므로 이 에이전트의 원천이 아니다.
- staging·production 오류율 감시와 incident 소유. 운영·SRE 팀의 것이다.

## 2. 작업 원천과 등록 원천

### 2.1 작업 원천

**v22 구현 Task 예외(버전 2).** `admin-idea-v4`의 승인된 구현 Task가 로컬 Ubuntu
단발 worker에서 만든 변경은, AMUX의 해당 attempt·카드·승인된 brief에 결속된
패치를 본 앱이 base SHA와 실제 변경 파일 목록으로 다시 검증한 경우에만 §3의
T1 후보가 될 수 있다. 카드 승인 화면의 별도 공개 PR 확인 항목은 기본 꺼짐이며,
운영자가 해당 구현 Task의 패치·PR 제목·본문 공개에 명시적으로 동의한 경우에만
T1 후보가 된다. 동의는 카드 확인 digest와 canonical audit에 결속한다. 비공개
아이디어 원문과 실행 brief 자체는 게시하지 않는다. 동의가 없거나 증명할 수
없으면 패치는 비공개 결과로만 남는다. 로컬 worker와 AMUX 앱은 GitHub 쓰기 자격증명을 받지 않는다.
별도 Engineering Publisher만 기존 §4·§5·§7·§9·§10·§11의 결정적 검사와
단회 capability를 거쳐 `develop` PR을 게시한다. 모델의 결과 본문, 사람이 한
AMUX 작업 검토 또는 카드의 우선순위는 capability가 아니다. patch·base·tree
중 하나라도 검증 불가이거나 통제 평면에 닿으면 공개 게시 없이 비공개 결과로
남긴다. `main` PR·병합·production 배포는 운영자 전용이며, `develop` 자동 병합과
staging 자동 배포도 이 예외에 포함하지 않는다. 새 경로의 코드·운영 스위치는
독립 검토와 합성 검증 전에는 열지 않는다.

**작업 원천은 승격된 AMUX 카드 하나다.** 버전 1의 Railway runner 경로와 위 버전 2의
로컬 Ubuntu v22 구현 Task 경로는 같은 AMUX 카드의 서로 다른, 혼용하지 않는 실행 경로다. 카드가
실행 가능해지는 것은 AMUX의 승격 승인이며 이 문서는 그 승인을 정의하지 않는다.
에이전트가 받는 것은 카드의 최소 실행 계약(execution brief)과 종류·우선순위·분류·명시적
의존성이고, 비공개 상세 원문은 받지 않는다.

- **선정 순서는 AMUX가 정한다.** 에이전트는 순서를 바꾸지 않는다.
- **claim 전에 건너뛴다.** 같은 test·파일을 건드리는 다른 열린 PR이 있거나, 이
  에이전트의 대기열이 가득 찼거나, 정지·동결·mode `off`면 카드를 claim하지 않고 사유만
  기록한다. claim 뒤에 거절하면 AMUX의 시도 상한을 소비하므로 건너뜀은 claim 전이어야
  한다.
- **GitHub issue는 작업 원천이 아니다.** 첫 초안의 issue 작업 승인, 승인 후보 대기열,
  issue digest 결속은 없어졌다.

### 2.2 등록 원천

에이전트는 아래 원천을 분석해 AMUX `backlog`에 카드를 등록한다. **표가 계약이며 목록
밖은 읽지 않는다.** 원천을 더하거나 바꾸는 것은 이 문서의 개정이다.

| 원천 | 식별 | 읽는 방법 |
|---|---|---|
| S1 공유 제품 backlog | branch `codex/product-idea-backlog-2026-09-15`에만 있는 backlog 문서(그 branch의 `.github/audits/` 아래 `tomverse-product-idea-backlog.md`, `develop`에는 없음)와 그 안의 항목 key | 회차 시작 시 그 branch의 commit SHA를 **고정**하고 그 commit의 blob만 읽는다. 결정적 parser가 항목을 나눈다 |
| S2 `develop`의 빨간 CI | develop head SHA와 check-run | check-run 결론 |
| S3 dependabot PR 실패 | PR 번호와 head SHA | 그 PR의 check-run. **그 PR은 건드리지 않는다** |

**흐름**

1. **결정적 사전 거름**(본 앱, LLM 없음) — 완료·보류·blocked·운영자 전용으로 표시된
   항목, 같은 source identity를 가진 AMUX 카드가 이미 있는 항목, 이 에이전트가 이미
   제안해 대기 중인 항목을 뺀다.
2. **분석**(초안 서비스) — 남은 항목의 잘린 본문을 모델에 넣어 "한 카드로 검증 가능한
   완료 단위"인지 판단하고 제목·범위·완료 조건의 짧은 제안을 만든다. 여러 단위가 섞였으면
   등록하지 않는다. **모델 출력은 신호이지 결정이 아니다.**
3. **결정적 Guard**(본 앱) — schema, 길이, 제어 문자, 경로 구분자, secret 패턴, AMUX
   intake의 내용 스캐너, source identity가 고정 commit에 실제로 있는지, 항목 digest를
   그 commit에서 다시 계산해 제안과 같은지, 중복을 다시 계산한다. 하나라도 어긋나면
   등록하지 않는다.
4. **등록**(본 앱) — Guard를 통과한 제안만 AMUX의 intake writer를 **같은 프로세스에서**
   불러 `backlog` 카드 한 장을 만든다. 카드·등록 기록·감사는 한 트랜잭션이다. 결과가
   불명확하면 AMUX intake의 read-back 규칙을 따르고 자동 재시도하지 않는다.

**등록이 정하지 않는 것.** 우선순위는 모델이 정하지 않는다 — 원천 항목에 결정적으로
읽히는 우선순위가 있으면 그 값, 없으면 가장 낮은 우선순위다. 소유자·실행 시도·전달·
경로 배정·claim은 만들지 않는다.

**상한**(바꾸는 것은 이 문서의 개정): 회차당 등록 3건, UTC 하루 10건, **이 에이전트가
등록했고 아직 승격되지 않은 카드 20장.** 상한은 본 앱 DB가 강제하고 모델 출력이 닿지
않는다. 사람이 추천 목록에서 보는 카드를 에이전트가 채우는 것이 이 상한이 막으려는
것이다.

**선행 조건.** AMUX intake는 지금 운영자가 명시적으로 고른 요청만 받는다. 이 능력은
**AMUX intake에 에이전트 등록 원천이 추가되고 승인된 뒤**에만 만들고 켠다. 기존 intake
경로로 등록하는 우회는 없다.

**원천에서 뺀 것과 이유**

- cron-auto-fix incident: 읽는 순간 claim되고 내용이 production 서버의 비공개
  데이터이므로 LLM provider에 보낼 수 없다.
- feedback-autofix case: `docs/policy/trace-feedback-automation.md`가 지배하고 자기
  workflow가 있다. 이 에이전트는 dispatch도 하지 않는다.

## 3. 권한 등급

등급은 **변경된 파일 목록**에서 결정적으로 계산한다. 원천의 종류, 모델의 자기 신고,
branch 이름은 등급을 정하지 못한다.

| 등급 | 에이전트가 하는 것 | 되돌릴 수 있는 근거 |
|---|---|---|
| **T2 초안** | branch를 push하지 않는다. patch와 제안을 **본 앱 테이블**에 제출하고 결정 항목 하나를 만든다 | 저장소 상태가 변하지 않는다. patch는 비공개 DB에만, 크기 상한과 두 번의 secret 검사 뒤에 저장된다 |
| **T1 PR** | 전용 branch를 push하고 `develop` 대상 PR을 연다. auto-merge 없음 | 병합은 사람이 한다. push와 PR은 공개되어 회수되지 않으므로, 공개 입력에서만 파생된 변경 또는 §2.1의 별도 공개 동의를 받은 v22 구현 Task의 검증된 패치에 한해 §13의 조건을 통과해야 한다. 동의가 있어도 아이디어 원문·실행 brief는 공개하지 않는다 |
| 무인 병합 | **이 정책에서 부여하지 않는다** | — |

## 4. push 금지 집합

변경 파일 중 하나라도 아래에 속하면 push하지 않는다(= T2로 끝난다). **판정은 파일
경로 목록이며 내용 패턴이 아니다.** 내용 패턴은 이 목록 밖의 파일에서 걸리면 추가로
등급을 올리는 경보일 뿐, 목록을 좁히는 근거가 되지 못한다.

1. **권한이 사람에게 있는 결정값 파일** — 모델 가격·카탈로그·크레딧 가중치, 청구
   가격 카탈로그, 앱 기본값, 제품 식별자, release gate registry, Prisma schema와
   migration. 목록은 코드 상수 한 곳에 있고, 그 테스트가 `AGENTS.md`가 사람 결정으로
   예약한 상수를 찾아 정의 파일이 목록 안에 있는지 확인한다.
2. **실행 환경을 바꾸는 파일** — `.github/**`, `scripts/**`, 패키지 manifest와
   lockfile, 저장소 루트의 모든 dotfile·dot-directory와 config 파일.
   `scripts/**` 전체인 이유: secret을 가진 step이 그 아래 파일을 실행하고, `npm run`을
   거친 간접 실행을 경로만으로 추적할 수 없어 부분 허용을 증명할 방법이 없다.
3. **쓰기 가능 자격증명 도달 경로**(§5).
4. **정책·계약 문서와 에이전트 자신** — `docs/policy/**`, `AGENTS.md`, `CLAUDE.md`,
   이 에이전트의 게이트·실행·상태·인증·게시·등록 구현 전부와 **AMUX 실행 제어 평면
   전부**(`lib/amux/**`, `crates/**`, `apps/**`, `app/api/internal/**`,
   `docs/ops/amux/**`). 에이전트는 자기를 실행시키거나 자기 게이트를 정하는 코드를
   공개 저장소에 올리는 변경을 만들지 않는다.
5. **텍스트가 아닌 것** — binary, symlink, submodule, 실행 비트 변경, `.git` 경로
   조각, 절대경로나 상위 경로 참조, 저장소 밖으로의 rename.

4번 목록은 **소유권 manifest** 하나로 관리한다. 추적 파일 전부가 제품·통제 평면·
미분류 중 하나로 분류되고, 미분류는 통제 평면으로 취급한다(= push 금지). 완전성
테스트가 (a) 설계가 이름 댄 모든 구현 경로, (b) 경로에 `agent`·`engineeringAgent`·
`engineering-agent`·`amux`·`orchestrator`가 든 모든 추적 파일, (c) AMUX 경로 전부가
통제 평면으로 분류됐는지 확인한다. 이름 패턴만으로는 새 구현의 작명을 예측하지 못하므로
manifest가 판정 근거이고 이름 패턴은 보조다.

**통제 평면에 닿는 제품 파일.** 제품 파일이라도 통제 평면이 읽는 설정·등록부·라우트·
기본값 기호에 닿으면 그 파일 전체가 T2이며, 분석하지 못한 파일이 하나라도 있으면 patch
전체가 T2다. 런타임 탐색, framework 관례에 따른 자동 등록, 환경변수·AppSetting·
registry로 통제 평면의 동작을 바꾸는 경로도 같다.

**승인된 좁은 예외 — 배포 이미지에 없는 비런타임 파일.** 2026-10-07 읽기 전용 실측에서
staging과 production의 앱 이미지 모두 `/app/tests`, `/app/docs`, `/app/lib`와 대표 파일을
포함했다. 따라서 현재 이미지에는 제외할 수 있는 확인된 경로가 없고 T1 판정은 바뀌지
않는다. 후속 빌드에서 `tests/`의 원본을 제외하더라도, 동일 `develop` base commit·tree 및
배포 이미지 digest에 운영자가 결속해 확인한 완전한 이미지 파일 목록, 앱의 목록 SHA
재계산, 런타임 source SHA·deployment ID 대조, 동적 파일 접근 분석, 배포 후 실측과
독립 검토가 없으면 제외 목록은 비어 있고 T2다. 앱은 OCI 이미지 digest를 독립적으로
조회하지 않으며 그 결속은 운영자 확인 기록의 책임이다. Task 실행과 공개 게시의 별도
코드·운영 스위치는 이 정책 승인만으로 열리지 않는다. `docs/` 전체는 제외 대상이 아니다. 앱이 `docs/ops`의 웹훅 검증 기록을 런타임에
읽으므로, 문서는 실제 접근을 파일 단위로 검증한 경우에만 별도 제안할 수 있다. 이미지에
없는 것이 증명되어도 runtime code·import·경로 참조·설정 이름을 통한 기존 T2 판정은
그대로 유지한다. 측정 대상 commit 또는 이미지가 달라지면 이전 증거를 재사용하지 않는다.

## 5. 쓰기 가능 자격증명 도달 분석

"쓰기 가능 자격증명"은 repository secret만이 아니라 workflow·job이 부여한 토큰 쓰기
scope, OIDC, environment secret, 재사용 workflow로 넘어가는 secret을 모두 포함한다.

판정은 결정적 코드가 **base commit의 workflow 전부**를 읽어서 한다. 출발점은
"secret을 참조하는 workflow"가 아니라 **모든 workflow**다.

- **도달 판정**: 에이전트가 일으키는 이벤트에 걸리는 workflow. branch·type filter를
  해석하지 못하면 도달한 것으로 본다.
- **자격증명 판정**: 도달한 workflow의 job이 토큰 외 secret을 참조하거나, 병합된
  권한에 쓰기 scope가 하나라도 있거나, workflow와 job 모두 권한 선언을 생략했거나,
  environment를 쓰거나, 재사용 workflow를 호출하거나, 해석하지 못한 표현식이 권한·
  secret·환경 자리에 있으면 그 job은 자격증명을 가진 것으로 본다.
- **cache 경로**: 자격증명을 가진 job이 Actions cache를 복원하면, 그 job은 trigger·
  path filter와 무관하게 도달한 것으로 보고 **모든 변경이 push 금지**다. 이 가정을
  푸는 방법은 job별 제외가 아니라, cache의 ref 간 공유 범위에 대한 날짜 있는 확인
  기록 하나를 분석기 설정에 고정하는 것뿐이다.
  **그 설정은 `lib/agentCacheIsolationRecord.ts`이고, 기록은 초안 상태로 거기 있다**
  — 세 방향과 각 근거는 채워져 있고 `approvedBy`·`approvedAt`가 비어 있다. 두 칸을
  채우는 것이 이 규칙을 푸는 행위이며 **소유자만 한다**(§7). 비어 있는 동안 기록은
  아무것도 풀지 않는다.
  분석기는 복원하는 cache의 **종류**도 함께 보고하지만(§5.1), 그것이 이 규칙을
  좁히지는 않는다 — 어떤 종류든 복원하면 금지다.
- **그 기록이 담아야 하는 것**(§5.1): 기록은 **방향을 구분해서** 써야 하고, 아래
  세 문장을 각각 근거와 함께 담지 않은 기록은 이 규칙을 풀지 못한다.
  1. **PR run → 다른 ref: 닫혀 있다.** 근거는 GitHub의 cache scope 규칙이다 —
     PR run의 cache는 merge ref scope에 만들어지고 그 PR의 re-run만 복원한다.
     에이전트가 심을 수 있는 cache는 자기 PR의 것뿐이므로, 이 한 문장이 "에이전트가
     심은 cache가 자격증명 job에 도달하는가"에 답한다.
  2. **기본 branch·base → PR: 열려 있다.** 기본 branch의 항목은 모든 run이, base의
     항목은 그 base를 향한 모든 PR이 복원할 수 있다. 이 방향은 주체가 에이전트가
     아니므로 이 규칙이 다루는 위협이 아니고, 근거를 격리에서 가져올 수 없다.
     **"Actions cache는 ref 간에 격리된다"고 쓰면 거짓이다.**
  3. **같은 PR 안: 열려 있다.** 위 규칙의 같은 문장이 "re-runs of the pull request"는
     복원할 수 있다고 말한다. 그러므로 기록은 "에이전트의 PR에서 실제로 도는 자격증명
     cache 복원 job이 없다"를 따로 확인해야 하고, 그 확인은 workflow의 trigger만이
     아니라 **job의 조건식까지** 읽어야 성립한다 — trigger만 보고 판정하면 틀린다.

     **이 조건을 유지하는 장치는 `npm run check:agent-pr-cache-isolation`이다**
     (§5.2). §5.1의 검사는 이 조건을 유지하지 못한다 — 그것은 자격증명 job의
     `unverified`·`unreadable` 복원만 거절하고 `verified_package_manager` 복원은
     허용하므로, 에이전트 PR에서 자격증명 job이 npm cache를 복원하는 상태를 막지
     못한다. 그 상태는 이 조건을 깨뜨린다 — 에이전트는 자기 PR에서
     `package-lock.json`을 바꿀 수 있고, 그러면 lockfile integrity 대조는
     에이전트가 넣은 값과 맞아떨어진다. 초안은 §5.1의 검사가 이 조건을 책임진다고
     적었고, 그것은 거짓이었다(독립 검토 지적).

     **그 검사가 실패하는 동안에는 이 기록을 쓸 수 없다.** 검사가 통과한다는 것은
     이 조건이 오늘 참이라는 뜻이고, 기록이 근거로 쓸 수 있는 것은 그것뿐이다.
- **결과**: 자격증명을 가진 job이 있는 도달 workflow마다 그 workflow의 path filter에
  걸리는 파일이 push 금지다. filter가 없거나 해석되지 않으면 모든 변경이 금지다.
- **사람이 검토한 제외**: 결과를 좁히는 유일한 방법은 `{workflow 경로, job id, blob
  sha, 사유, 검토자}`를 분석기에 고정하는 것이다. blob sha가 다르면 제외는 **무효**다.
  job의 조건식을 분석기가 해석해서 제외하지 않는다. 제외 목록은 에이전트가 바꿀 수
  없는 경로에 있고, 추가는 소유자가 병합하는 PR이다.
- **fail closed**: 해석하지 못한 workflow·표현식·호출 대상이 하나라도 있으면 모든
  변경이 push 금지다.

**아직 해소되지 않은 도달 경로의 구체 목록은 이 문서에 싣지 않는다**(§16).

### 5.1 cache 종류와 그것을 유지하는 검사

이 분석은 저장소 전체 CI의 cache 위생 감사에서 나온 결과를 함께 쓴다
(`.github/audits/actions-cache-poisoning-audit-2026-10-03.md`).

- **분석기는 복원하는 cache의 종류를 보고한다.** `verified_package_manager`는
  package manager 자신의 cache이고, `npm ci`가 lockfile의 integrity와 대조하므로
  조작된 항목은 실패하거나 다시 내려받는다. `unverified`는 build 산출물과 browser
  binary처럼 **아무것도 검증하지 않는** 것이고, job이 그것을 그대로 실행한다.
  `unreadable`은 읽을 수 없는 것이며 둘 중 나쁜 쪽으로 취급한다.
- **종류는 §5의 cache 규칙을 좁히지 않는다.** 어떤 종류든 복원하면 모든 변경이
  push 금지다. 종류를 보고하는 이유는 하나다 — 자격증명 job이 verified에서
  unverified로 옮겨 가는 것이 **같은 reason의 반복이 아니라 다른 사실**이 되게
  하는 것. 그 전환은 `tests/agentCredentialReachability.test.mjs`의 posture digest가
  본다.
- **`npm run check:credential-cache-separation`이 그 전환을 막는다.** 자격증명을
  가진 job은 `unverified`·`unreadable` cache를 복원할 수 없고, 이 검사는 PR Fast
  Gate의 static 단계에서 돈다. 판정은 같은 모듈(`lib/agentCredentialReachability.ts`)
  이 하므로 "어느 job이 자격증명을 가졌는가"에 답이 둘로 갈라지지 않는다.
- **이 검사는 §5의 기록 3번을 유지하지 않는다.** 그것이 거절하는 것은
  `unverified`·`unreadable`뿐이고, 자격증명 job이 `verified_package_manager`를
  복원하는 것은 통과시킨다. 3번이 요구하는 것은 **에이전트 PR에서 도는 자격증명
  cache 복원 job이 하나도 없다**는 더 강한 조건이므로, 이 검사를 그 근거로 쓰면
  안 된다. 3번을 위한 장치는 "에이전트가 일으키는 이벤트에 걸리는 workflow의
  자격증명 job은 **어떤** cache도 복원하지 않는다"를 묻는 별개 검사이고, 그것이
  §5.2다.
- 검사와 보고는 **이름을 출력하지 않는다**. 저장소가 공개이므로 §16이 미해소 대상의
  목록을 여기에 두지 못하게 한다. 수치만 남기고, 목록은 운영자가 로컬에서
  `npm run report:engineering-agent-tiers`로 본다.

### 5.2 에이전트 PR의 cache 격리를 유지하는 검사

`npm run check:agent-pr-cache-isolation`이 §5 기록 3번의 조건을 유지한다.
**에이전트가 일으키는 이벤트에 걸리는 workflow의 자격증명 job은 어떤 cache도
복원하지 않는다** — `verified_package_manager`도 포함한다. PR Fast Gate의 static
단계에서 돈다.

- **§5.1의 검사와 묻는 것이 다르다.** §5.1은 모든 workflow를 보면서 종류 둘만
  거절하고, 이 검사는 도달하는 workflow만 보면서 종류 전부를 거절한다. 어느
  쪽도 다른 쪽을 포함하지 않으므로 둘 다 필요하다.
- **lockfile 대조는 이 주체에 대한 방어가 아니다.** 에이전트는 자기 PR에서
  `package-lock.json`을 바꿀 수 있고, 그러면 `npm ci`의 integrity 대조는
  에이전트가 넣은 값과 맞아떨어진다. 그래서 여기서는 package manager 자신의
  cache도 거절한다.
- **판정은 `lib/agentCredentialReachability.ts`가 한다.** 도달 여부·자격증명
  여부·cache 종류를 다시 계산하지 않고 그 모듈이 보고한 `reachedWorkflows`와
  cache 이유를 교차한다. 판정기를 둘로 만들면 숫자가 어긋난다(감사 P3).
- **분석기는 여전히 job의 조건식을 해석하지 않는다.** §5의 "사람이 검토한 제외"
  규칙은 그대로이고, 이 검사는 제외 목록을 하나도 쓰지 않는다. 조건식으로
  통과하는 길을 만들지 않은 이유는 F5가 두 번 틀린 지점이 바로 trigger만 읽고
  조건식을 읽지 않은 것이기 때문이다. **그래서 조건이 면제가 아니라 사실로
  유지된다** — 2026-10-03에 도달 workflow 안에서 npm cache를 복원하던 자격증명
  job 하나는 조건식으로 제외하지 않고 그 job에서 cache를 뗐다(소유자 결정).
- **검사는 기록을 읽지 않는다.** 분석을 `cacheIsolationRecorded: false`로 받는다.
  `true`로 받으면 분석기가 cache 이유를 보고하지 않으므로, 기록을 쓰는 순간 그
  기록을 참으로 유지하는 장치가 꺼진다. `tests/agentPrCacheIsolation.test.mjs`가
  이것을 고정한다.
- 이 검사도 **이름을 출력하지 않는다**(§16). 수치만 남긴다.
- **기록을 적용하는 쪽은 먼저 기록을 무시한 분석으로 판정한다.** 기록을 적용한
  분석은 cache 이유를 아예 보고하지 않으므로, 그 분석으로 이 조건을 물으면 조건이
  참이어서가 아니라 **증거가 가려져서** 충족으로 보인다. 그래서 소비자
  (`scripts/report-engineering-agent-tiers.mjs`)는 `cacheIsolationRecorded: false`로
  한 번 판정하고, 서명과 그 판정이 **둘 다** 성립할 때만 기록을 적용한다.
  `tests/agentCacheIsolationRecord.test.mjs`가 이 순서를 고정한다.
- **서명이 조건보다 오래 살지 않는다.** 같은 테스트가 "기록이 서명됐는데 이 조건이
  깨진" 상태를 실패로 만든다. 서명은 한 파일의 두 칸이지만, 그 칸이 참이 아닌 상태를
  만들 수는 없다.

## 6. 신뢰 경계와 외부 텍스트

| 입력 | 취급 |
|---|---|
| 승인된 이 문서, `AGENTS.md`, base commit에 고정된 system prompt | 지시 |
| 승격된 AMUX 카드의 execution brief(claim 시점에 받고 digest를 대조) | 조건부 지시(작업 내용). 경로·등급·대상을 정하지 못한다 |
| 등록 원천 항목(§2.2) | **데이터.** 등록 제안의 재료일 뿐 작업 지시가 아니다 |
| issue comment, 다른 사람의 편집, CI 로그, test 출력, dependabot 본문, 보고서 출력, 모델 응답 | **데이터** |

LLM이 읽는 자유 텍스트에서 나온 LLM 출력은 **소유자가 읽는 초안**(T1 PR, T2 제안,
등록 제안)으로만 끝난다. 대상 항목·branch 이름·경로 허용 여부·카드 우선순위는 LLM
출력으로 정해지지 않는다.

모델 입력에 들어가는 외부 텍스트는 입력원마다 상한을 두고 **결정적으로 자른 뒤**
넣는다. 원문 전체는 로그에도 본 앱에도 저장하지 않는다. UTF-8로 디코드되지 않거나
NUL이 있으면 그 입력원은 거절하고, 개행·탭 외 제어문자는 제거하며, 정규화는
결정적이어서 같은 원문이 같은 입력을 만든다. 잘린 입력원이 있으면 입력원 종류와
원문 byte 수만 기록한다. 카드 brief와 등록 원천 항목의 digest는 **자르기 전 원문**의
것이다.

## 7. 승인

**작업 착수의 승인은 AMUX의 카드 승격이며 이 문서가 정의하지 않는다.** 이 에이전트가
소유하는 승인은 셋뿐이다.

1. **T2 결정** — T2 초안을 사람이 직접 적용하겠다는 기록이다. 초안의 patch digest와
   base commit에 묶이고, 한 번만 쓰이며, 소비되지 않는다. 본 앱은 아무것도 적용하지
   않는다 — 적용은 사람이 한다.
2. **외부 행위 유형 `engineering.publish_pr`** — AMUX 승인 계약은 외부 행위를 제외하고
   유형마다 별도 계약을 요구한다. 운영자는 이 에이전트의 PR을 그 예외로 허용했고, 이
   유형의 계약은 이렇다.

   | 계약 필드 | 이 유형 |
   |---|---|
   | 행위 | 공개 저장소에 branch를 push하고 `develop` 대상 PR을 연다 |
   | 대상 | 이 저장소, 에이전트 branch namespace의 run별 branch, base `develop` |
   | 정확한 변경 digest | patch digest와 **기대 tree hash**(§11) |
   | 허용 범위 | §3의 결정적 계산이 T1인 변경만, §9 게시 규칙 안 |
   | 만료 | capability의 만료(소비 전까지만 의미가 있다) |
   | 실행자 | 게시 서비스 하나 |
   | 결과 조회·중복 방지 | §10의 결정적 표식과 쓰기별 조회, 기대 old OID |

   **유형의 승인은 이 문서의 운영자 승인**이고, **인스턴스마다의 허가는 본 앱이
   결정적으로 발급하는 single-use capability**(§11)다. 사람은 인스턴스마다 push를
   승인하지 않는다. PR이 초안이고 최초 push 전 검사가 모두 통과해야 한다는 조건이 그
   자리를 대신한다.
3. **공개된 PR의 승인 증거** — **권한 있는 사람의 required review**다. 판정은 §9-10
   하나에 있다. **에이전트는 PR을 승인하지 않고, 병합하지 않으며, auto-merge를 켜지
   않는다.**

**AMUX 작업 검토와의 순서.** engineering 카드도 AMUX 카드이므로 카드 결과의 수락
(`review → done`)은 AMUX 작업 검토다. 그것은 위 셋 중 어느 것도 대신하지 않고 위 셋도
그것을 대신하지 않는다. 같은 PR 위의 두 사람 판단은 이 순서로 일어난다 — 게시 서비스가
PR을 열고 결속 snapshot을 기록한다 → 사람이 GitHub에서 review하고 본 앱이 승인을
관측한다 → 사람이 AMUX 작업 검토를 승인한다(AMUX가 결속한 base·head·diff digest가
snapshot과 같아야 한다) → 사람이 병합하고 본 앱이 병합을 관측한다. AMUX의 `done`은
"결과를 받아들였다"이고 "병합됐다"가 아니다.

- **2인 승인(`AdminActionApproval`)을 쓰지 않는다.** 2인 승인은 "관리자 두 사람이 한
  action에 동의한다"를 표현하며, "사람 한 명이 시스템이 만든 초안을 판단한다"를
  표현하지 못한다. sole-approver 예외 목록을 건드리지 않는다.
- **GitHub label·comment는 승인 입력이 아니다.** label은 triage 권한자가 붙이고 뗄 수
  있어 변조를 증명하지 못한다.

## 8. 서비스와 자격증명

에이전트는 GitHub Actions에서 실행되지 않는다. **초안과 게시는 서로 다른 서비스**이며
자격증명이 겹치지 않는다.

| 서비스 | 갖는 것 | 갖지 **않는** 것 |
|---|---|---|
| 초안을 만드는 서비스 | 이 에이전트 전용 LLM provider key(공급자 측 지출 한도 포함), 이 저장소 하나에 대한 **읽기 전용** GitHub 토큰, 본 앱 제출 secret, dead-man monitor URL | GitHub 쓰기 자격증명, 게시 App key, 제품 DB 자격증명, **AMUX 내부 route secret** |
| 게시하는 서비스 | Publisher GitHub App(Contents write, Pull requests write, Metadata read), 본 앱 제출 secret, 별도 dead-man monitor URL | **LLM key**, 제품 DB 자격증명, **AMUX 내부 route secret** |
| 본 앱 | 위 두 secret, 이 저장소 하나에 대한 읽기 전용 토큰(tree 읽기와 병합 관측용) | GitHub 쓰기·LLM 자격증명 |

- 두 서비스 모두 제품 DB, 결제·메일·저장소·배포 자격증명을 갖지 않는다. 선언 목록
  테스트와 보안 회귀 검사가 이 표 밖의 이름을 거부한다.
- 두 서비스의 secret은 **서로의 내부 route를 통과하지 못한다.**
- 내부 route 인증은 32자 이상 secret, `Authorization: Bearer`, SHA-256 후
  constant-time 비교, POST, `no-store`, 요청 timeout, 상한 있는 엄격한 본문 schema다.
  실패는 구조화 incident 로그로 남는다.
- **AMUX에는 본 앱 안의 engineering adapter가 붙는다.** 두 서비스는 AMUX 자격증명을
  갖지 않고 engineering route만 부른다. adapter가 worker identity를 **서버에서 결속**하고
  AMUX의 단일 writer를 같은 프로세스·같은 트랜잭션에서 부른다. 다른 부착 방식은 이
  문서의 새 버전 승인과 독립 검토가 필요하다.
- **이 부착은 AMUX 쪽 개정이 먼저다.** `docs/policy/development-agent-orchestration.md`의
  Authority 절은 모든 claim·전이·승인·감사가 AMUX 내부 route 경계를 지난다고 정한다. 그
  절이 본 앱 안의 engineering route와 adapter를 같은 앱 경계로 인정하도록 AMUX 정책
  소유자가 개정·승인하고 AMUX writer가 그 부착을 지원하기 전에는 본 앱 구현에 들어가지
  않는다. §0의 "좁은 쪽이 이긴다"로 그 절을 덮지 않는다.
- **clone한 트리의 의존성을 설치하거나 실행하지 않는다.** 두 서비스는 clone한 저장소의
  npm 의존성을 설치하지 않고 그 lifecycle script와 코드를 실행하지 않는다. 진입 코드는
  런타임 내장 모듈과 의존성 없는 core만 import한다.
- **모델이 지시한 명령·코드는 실행되지 않는다.** 모델에게 주는 도구는 새로 clone한
  트리의 추적 파일을 읽는 것 하나이며, 요청 경로는 추적 목록에 정확히 있고 clone
  루트 안이며 경로의 어느 구성 요소도 symlink가 아니고 일반 파일이며 자격증명 성격의
  파일 이름 목록에 걸리지 않을 때만 통한다. 모델 호출 모듈은 하위 프로세스 실행·
  동적 평가·동적 import를 쓰지 않으며, 이는 구문 회귀 검사와 그 모듈에 결속된 구현
  독립 검토로 강제한다.
- 실행 이미지는 에이전트 전용 최소 이미지이고, **배포 플랫폼에서 빌드하지 않는다.**
  `main` 전용 build workflow(secret·cache 없음)가 만든 이미지를 **digest로 고정**해
  선언하며, 그 값을 바꾸는 것은 사람이 병합하는 PR과 운영자의 적용뿐이다. 게시 App
  key는 build 단계에 존재하지 않는다.

## 9. 게시 규칙

1. **GitHub App이며 개인 토큰이 아니다.** 설치 범위는 이 저장소 하나, 토큰은 집은
   작업 하나를 처리하는 동안만 발급한다.
2. **Workflows 권한을 주지 않는다.** GitHub가 workflow 파일 변경 push를 거부한다
   (§4-2의 코드 검사와 이중).
3. **branch 이름에 `to-develop` 경로 조각을 넣지 않는다.** 그래서 자동 PR 생성
   workflow가 PR을 열거나 auto-merge를 켜지 않는다. 같은 이름의 원격 branch가 있으면
   실패한다.
4. **PR은 게시 서비스가 열고 auto-merge·draft 플래그를 쓰지 않는다. 병합은 사람이
   한다.**
5. **허용 경로 목록**은 base commit 기준의 결정적 코드다. 이 안에 있어도 §4의 push
   금지 집합에 속하면 T2다(**push 금지가 허용 목록을 이긴다**). 다음은 허용 목록에
   들어갈 수 없다 — `.github/**`, `scripts/**`, `AGENTS.md`, `CLAUDE.md`,
   `docs/policy/**`, `docs/release-gates/**`, `docs/ui-contracts/**`, 그리고 계약
   문서가 경로로 이름 댄 test 파일과 이름에 `Policy`·`Contract`·`Invariant`가 든 test
   파일. 파일 유형과 변경 크기에도 상한이 있다.
6. **ruleset**으로 게시 App의 push를 에이전트 branch namespace로 제한하고 force push를
   막는다. 삭제는 정리를 위해 허용한다.
7. **허용 판정의 authority는 본 앱 하나다.** 게시 서비스는 새 clone에 patch를 실제로
   적용하고, 구문과 secret을 검사하며, 결과 tree hash를 capability의 기대 tree hash와
   대조한다. 이 검사들은 **거절만 할 수 있고** 성공은 아무것도 허용하지 않는다. 게시
   자격증명을 가진 프로세스가 판정의 입력을 통제하지 못하게 하는 것이 이 분리의
   목적이다. lint와 테스트는 실행하지 않는다 — PR의 필수 검사가 병합 전에 돈다.
8. **공개 표면에 쓰는 것은** T1 branch·commit·PR 제목과 본문, 만료된 자기 PR의 close와
   고정 문구 comment, 자기 branch 삭제뿐이다. 자유 텍스트를 담는 쓰기는 **최초 공개
   전에** 고정 secret 검사를 두 번 통과한다. 그 밖의 필드는 지정된 원천에서 계산하고
   쓰기 직전 다시 조회해 일치할 때만 쓴다.
9. **`main`에 쓰지 않는다.** develop 변경은 일반 release train으로만 main에 간다.
10. **승인 증거는 권한 있는 사람의 required review다. 병합 주체가 아니다.**
    권한도 ruleset도 "사람이 병합 버튼을 눌렀다"를 강제하지 못한다 — Pull requests
    write에는 병합 API가 들어 있고, ruleset은 규칙을 충족한 뒤의 병합을 막지 않는다.
    그래서 판정은 review이고, 병합 주체는 **관측 값으로만 기록한다.**

    본 앱이 대상 저장소 한정 읽기 전용 토큰(Metadata·Contents·Pull requests·Checks·
    Commit statuses read)으로 직접 관측해 **일곱 조건이 모두 참일 때만** 승인이다.

    1. base가 보호 branch `develop`이다.
    2. 병합 직전 head가 본 앱에 기록된 검증 통과 commit과 같다.
    3. 그 commit의 required check가 모두 통과했다. 읽기 실패·목록 불완전은 비승인이
       아니라 **미확정**이고 다음 회차에 다시 본다.
    4. required review가 1건 이상 있고, 그 계정이 아래 **PR 승인 권한자 목록**에 있다.
       대조는 login이 아니라 GitHub의 숫자 user id로 한다.
    5. 그 review가 유효하다 — 보호 branch에 stale-approval dismissal이 **실제로 걸려
       있음을 확인**한 뒤에만 센다. 걸 수 없는 동안에는 결속 snapshot 기록 시각 이후
       제출된 review만 인정한다.
    6. **현재 base SHA와 현재 diff digest를 관측 시각에 다시 계산해** snapshot과 같다.
       다르면 비승인이고 새 snapshot에 대한 재검증과 새 review가 필요하다.
       `review.commit_id`도 dismissal도 base만 움직인 경우를 잡지 못한다.
    7. review 제출 시각이 snapshot 기록 시각보다 뒤다. snapshot을 다시 기록하는
       트랜잭션은 그 시점의 승인 review를 무효 목록에 넣고, 무효가 된 review는 다시
       세지 않는다.

    **PR 승인 권한자 목록**(바꾸는 것은 이 문서의 개정): `mposition`. 이 목록은
    `docs/policy/agent-operator-allowlist.md`와 별개다 — 그 파일은 정책 `approvedBy`의
    대조 목록이며 권한을 주지 않는다. 숫자 user id: `mposition` = `60078951`.

    **조건 4의 계정 일치만으로는 사람이 직접 승인했음을 증명하지 않는다.** 이 에이전트는
    사용자 토큰을 갖지 않고 게시 App은 review를 남길 주체가 아니므로 자기 승인은 할 수
    없다. 사람 전용으로 검증된 승인 증거와 그 운영자 기록이 마련되기 전에는 `t1`에
    진입하지 않는다(§14).

    **승인 판정은 병합 전에 확정한다.** 병합 전에 승인이 기록되지 않은 PR의 병합과
    review 없이 병합된 PR은 비승인이고 정지 대상이다. 관측은 PR 번호 기준 멱등이고
    확정 뒤 불변이다. 초안 서비스의 자기 보고는 승인 증거가 아니다 — 초안을 만든 쪽이
    승인을 보고하는 것이고, 그 secret이 새면 위조된다.

## 10. 결과를 모를 때

회수되지 않는 쓰기에서 "결과 모름"(timeout·연결 종료·5xx·응답 파싱 실패)은 실패와
다르게 다룬다. 4xx는 확정된 실패다.

- 모든 쓰기는 **결정적 표식**을 갖는다(run id가 든 branch 이름, 본문 첫 줄의 표식
  주석).
- 결과를 모르면 **조회부터 한다.** 조회 전에 재시도하지 않고, 정리(branch 삭제
  포함)도 하지 않는다.
- 조회로도 알 수 없으면 그 작업만 멈추고 사람에게 넘긴다. **소비된 capability는 소비된
  채로 두고 새 capability를 발급하지 않으며**, 아무것도 삭제하지 않는다.
- 게시 서비스가 작업을 집은 뒤 결과를 남기지 못하고 끝나면, 다음 회차는 **조회만** 한다.
  조회가 "이전 쓰기 없음"을 확정할 때만 그 작업은 대기로 돌아가고, 다음에 집힐 때
  결정적 판정과 새 capability를 처음부터 다시 만든다(그 사이 base가 움직였을 수 있다).
- branch를 지우는 경로는 **PR이 없음을 끝까지 읽은 목록으로 확인한 뒤**의 정리뿐이다.
  "PR은 생겼는데 head만 사라진" 상태를 만들지 않는다.
- **본 앱 내부 route의 결과 불명은 GitHub 조회로 풀지 않는다.** 모든 내부 요청은
  idempotency key를 싣고, 상태는 `accepted → in_progress → committed | aborted`다. 결과를
  모르는 호출자는 재시도하지 않고 읽기 전용 상태 route로 묻는다. `in_progress`는
  무기한 보일 수 있고, 그동안 새 전이·재시도·결과 확정을 하지 않는다.

## 11. 판정·상태 기록의 위치

**본 앱은 patch를 적용하거나 실행하지 않는다.** 본 앱이 다루는 것은 Git tree 목록뿐이다
— base tree 목록은 GitHub에서 직접 읽고, 결과 tree 목록은 초안 서비스가 제출하며, 본
앱은 그 목록에서 tree hash를 다시 계산해 주장된 값과 같은지 확인하고 두 목록을 비교해
변경 파일 집합을 얻는다. patch를 실제로 base에 적용하는 것은 초안 서비스(초안)와 게시
서비스(게시 직전)이고, 게시 서비스의 결과 tree hash가 본 앱이 판정한 tree hash와 다르면
게시하지 않는다.

**v22 구현 Task의 전송 예외(버전 3).** 전체 결과 목록이 sidecar 응답 한도를 넘으므로,
로컬 worker는 변경 파일의 정규 경로·Git mode·새 blob의 원본 바이트(삭제에는 바이트 없음)만
상한 안에서 제출한다. 앱은 고정된 `develop` base commit의 전체 tree를 GitHub에서 직접
읽고 제출된 변경 파일을 그 tree에 대응시켜 결과 tree 목록과 hash를 계산한다. 앱은
patch 본문을 파싱·적용·실행하지 않는다. 제출에 빠진 변경이나 거짓 내용이 있더라도
별도 Publisher가 실제 patch를 적용해 얻은 tree hash가 기대값과 다르면 원격 push 전에
거절한다. 결과가 불완전하거나 바이트·mode·경로·base를 검증할 수 없으면 T1은 거절한다.
**v4 구현 현황:** 현재 v22
구현은 기존 `100644` 일반 파일의 본문 수정만 완전한 변경 바이트로
제출한다. 추가·삭제·mode 변경은 전송 계약의 가능 형태라도 아직 구현되지 않았으므로
게시 후보가 되지 않고 비공개 결과로만 남는다. 삭제의 무바이트 표현을 지원한다고
간주하거나 T1로 분류하지 않는다.

- 제출된 blob의 hash가 목록의 object id와 같아야 하고, 바뀌지 않은 항목은 base 목록과
  같아야 한다. 변경 파일 집합은 blob만이 아니라 mode·type까지 비교해 얻으므로 mode 변경·
  symlink·submodule이 판정에서 사라지지 않는다.
- **지원하지 않는 것은 T2다** — `.gitattributes`가 적용되는 경로의 변경, submodule의
  변경, 잘린 tree 응답, 목록 크기 상한 초과.
- **capability**는 base commit·patch digest·기대 tree hash·검증기와 정책 버전·만료·
  fencing 값을 묶는다. **소비는 취소할 수 없는 단일 게시 예약**이며, 게시 작업을 집는
  트랜잭션에서 한 번 일어난다. 만료는 소비 전까지만 의미가 있다. 게시 서비스는 push
  직전에 본 앱에 한 번 더 묻고(last-look), 본 앱은 mode·동결·킬 스위치·incident·
  fencing 값의 현재값으로 **거절만** 할 수 있다. push는 같은 이름의 branch가 없을 때만
  성공하도록 조건을 건다 — 이는 이름 경합을 막을 뿐 capability가 신선하다는 증거가
  아니다. push 뒤 대조에서 어긋남이 보이면 막은 것이 아니라 사고다.

**상태 기록**

- engineering 상태는 **본 앱의 전용 테이블 일곱 개**에만 있다. 사용자 콘텐츠 컬럼이
  없고, 쓰기는 단일 store 모듈만 하며, 상태 전이는 허용 목록 trigger가 강제한다.

  | 테이블 | 책임 |
  |---|---|
  | `EngineeringAgentRun` | 작업 회차. AMUX 실행 시도 하나와 1:1이고 그 시작과 같은 트랜잭션에서 생긴다 |
  | `EngineeringAgentWorkItem` | T2 초안·게시·만료 close·정리·결정·불일치 항목. patch digest와 base commit은 불변 |
  | `EngineeringAgentApproval` | **T2 결정만.** 게시 승인에 쓰지 않는다 |
  | `EngineeringAgentCapability` | 게시 인스턴스 허가. 소비는 한 번이고 소비 뒤 불변 |
  | `EngineeringAgentBinding` | T1 PR 결속, 결속 snapshot, review·병합 관측 |
  | `EngineeringAgentRegistration` | 등록 제안의 원천·digest·Guard 결과·AMUX 카드 id. 제안 본문은 저장하지 않는다 |
  | `EngineeringAgentRequest` | 내부 요청 idempotency |

  카드·실행 시도·전달·작업 검토는 **AMUX가 소유**하고 이 에이전트는 AMUX의 writer를
  통해서만 그 행에 닿는다.
- **v4의 v22 결과:** Task가 성공했지만 게시 가능한 산출물이 없으면 run의
  `outcome`을 `private_result`로 끝낸다. 이는 비공개 Task 결과만 있고
  `EngineeringAgentWorkItem` 초안이나 공개 PR은 없다는 뜻이다. AMUX 쪽은 사람 검토
  상태로 이동하며, `t2_draft`나 T1 게시로 집계하지 않는다.
- engineering run은 AMUX 실행 시도 하나와 1:1이고 AMUX 실행 시작과 같은 트랜잭션에서
  만들어진다. 두 쪽 상태가 어긋나면 한쪽을 다른 쪽에 맞춰 고치지 않고 **불일치 항목**을
  만들어 사람에게 넘긴다. 사람의 조치는 양쪽을 한 트랜잭션에서 잠그고 다시 읽은 뒤에만
  실행되며, 잠금 순서는 AMUX가 쓰는 순서(실행 시도 → 카드 → 전달)를 따르고 engineering
  행을 그 뒤에 둔다. AMUX가 자기 잠금 순서를 바꾸면 이 순서도 함께 바뀌어야 한다.
- patch 본문은 크기 상한과 **두 번의 secret 검사**(초안 측 1회, 본 앱 저장 전 1회)를
  통과해야 저장된다. 탐지되면 저장하지 않는다. 본 앱은 patch를 텍스트로만 저장·표시한다.
  결정 후 보존 기간이 지나면 **본문만 지우고 digest와 결정 기록은 남긴다.** 등록 제안은
  본문을 저장하지 않고 digest만 둔다.
- 에이전트의 외부 텍스트·patch 본문을 AMUX의 자유 텍스트 컬럼에 넣지 않는다. AMUX
  컬럼에 들어가는 텍스트는 AMUX intake의 길이·스캐너 규칙을 통과한 등록 제안뿐이다.
- **GitHub issue·label·comment·artifact는 상태 저장소도 승인 증거도 아니다.** 공개된
  PR의 승인 증거는 §9-10의 required review이고, 그 관측 결과는 본 앱에 기록된다.
- 사람 행위와 시스템 행위는 **같은 트랜잭션에서** 기존 해시 체인 감사에 남는다. 감사
  metadata에는 id·enum·digest만 두고 patch 본문을 넣지 않는다.
- 화면은 공통 Agent digest 영역의 engineering 항목이다. 에이전트마다 별도 화면을
  만들지 않는다. 외부 텍스트는 잘라서 escape해 표시한다.
- 모드(`off`·`shadow`·`t1`), 동결, 등록만 끄는 스위치, 킬 스위치가 있다. **미설정이거나
  읽지 못하면 `off`다.**

**본 앱의 시간 상한**

- 본 앱 route는 hard timeout을 주장하지 않는다. handler는 자기 자신을 강제로 끝낼 수
  없고 이미 보낸 `COMMIT`을 취소할 수 없다.
- DB가 강제하는 것은 문장 단위의 `statement_timeout`과 유휴 트랜잭션 timeout뿐이다.
  트랜잭션당 최대 시간은 앱이 유도한 값이며 DB 상한이라고 부르지 않는다.
- **production이 PostgreSQL 16이라고 전제한다.** 16에는 트랜잭션 전체 timeout이 없다.
  17로 확인되면 그 설정은 트랜잭션 안에서 설정한 시점부터만 점유를 묶으며, 그때 문장·
  유휴 timeout은 그 값보다 짧을 때만 효력이 있으므로 아래 축소 규칙은 그 조건을 지키는
  동안에만 쓴다.
- **문장마다 남은 예산으로 줄인다.** 각 문장 전에 `statement_timeout`을 기본값과 남은
  예산 중 작은 값으로 다시 설정한다. 고정값을 문장 수만큼 허용하면 앞 문장이 예산을 다
  써도 뒤 문장이 기본값을 다시 받기 때문이다.
- **트랜잭션은 보수적 pre-COMMIT 예산이 남아 있을 때만 시작한다.** 그 예산은 문장 수와
  문장·유휴 timeout에서 유도하며 트랜잭션 최대 시간이 아니다.
- **DB 밖의 계산은 종료 가능한 worker thread에서 한다.** tree 목록 검증과 도달 분석처럼
  CPU를 쓰는 판정은 worker에서 돌고, 부모는 cooperative budget이 끝나면 그 worker를
  종료한다. 서비스 쪽 watchdog과 함께 둔다.
- 묶이지 않는 구간을 이름 대어 둔다 — 트랜잭션 시작과 첫 설정 사이, 그리고 `COMMIT`의
  durable 단계. 둘 다 예산 뒤에 끝날 수 있다.
- **DB가 반드시 강제하는 것은 하나다 — 늦은 실행이 성공으로 기록되지 않는 것.** 성공
  전이는 lease 만료 시각을 DB 시계와 비교하는 조건과 trigger로 막는다.

## 12. 대기열·정지·알림·비용

- **대기열에는 상한과 만료가 있다.** 열린 PR과 남은 branch가 있는 결속, 미결정 결정
  항목(T2 초안·불일치·반복 실패·관측 실패·등록 결과 불명)이 셈 대상이고, 이 에이전트의
  소유자 대기 항목은 합계 **5**다. 상한은 본 앱 DB의 unique·조건부 갱신이 강제한다
  (에이전트의 판정에만 기대지 않는다). 상한에 닿으면 카드를 claim하지 않는다. 등록은
  소유자 대기 항목이 아니지만 §2.2의 상한을 따른다.
- **정지**는 세 가지다 — 결속과 맞지 않는 게시 App 명의의 열린 PR, 결속과 맞지 않는
  에이전트 namespace의 원격 ref, 그리고 반복 실패로 열린 차단기. 정지 중에는 claim과
  등록이 없고, 만료 정리와 관측만 계속한다. **해제는 Admin 화면의 확인 행위뿐이다**
  (권한 + step-up + 감사).
- **정지 복구 도구**는 운영자가 로컬에서 돌린다. 읽기 전용 계획을 먼저 내고, 항목이
  소수를 넘으면 사고로 처리한다. 사고 종결은 게시 App key 폐기 또는 설치 해제, 모드
  `off`, 기록이며, 재진입은 새 전용성 기록과 **이 정책의 새 버전 승인** 뒤다.
- **heartbeat가 없으면 실패다.** 두 서비스 각각 외부 dead-man monitor를 갖고, 그
  monitor는 본 앱·배포 플랫폼·GitHub와 일정·코드·자격증명·상태를 공유하지 않는다.
  **정지 중에는 성공 신호를 보내지 않는다.** 모드가 `off`·동결·킬 스위치여도 회차가
  끝까지 돌았다면 liveness 신호는 보낸다 — monitor는 서비스가 살아 있는지를 본다.
- 모드를 `off`에서 켜는 action은 **armed gate**를 지난다. 두 서비스의 마지막 회차가
  최근이어야 하고(서비스 자기 보고이므로 지표일 뿐이다), 운영자가 두 monitor가
  활성이고 알림 채널이 연결됐음을 monitor 화면에서 확인한 기록이 최근이어야 한다.
- **알림에는 링크와 enum만 싣는다.** patch·로그·탐지된 문자열을 싣지 않는다.
- **비용은 별개 namespace다.** LLM 비용은 사용자 크레딧·플랜·Chat 공급자 예산과
  섞이지 않고 전용 key의 공급자 측 지출 한도로 묶는다. 일일 회차 수는 본 앱이 DB에서
  강제한다. AMUX 비용 원장을 admission에 쓰는 것은 별도 운영자 결정이다.

## 13. 절대 조건

위반은 즉시 모드 `off` 사유이며, 이 조건을 약화하는 변경은 **이 문서의 새 버전
승인과 독립 검토**를 요구한다.

1. `main`에 쓰지 않는다.
2. 어떤 PR도 병합하지 않고, auto-merge를 켜지 않으며, 관리자 권한·force push·branch
   protection 우회를 쓰지 않는다. 게시 App은 어떤 bypass 목록에도 없다.
3. 등급과 push 가능 여부는 **본 앱**의 결정적 코드가 base commit에서 **변경 파일
   목록**으로 계산한다. LLM·branch 이름·원천 종류가 낮추지 못하며, 게시 서비스의 검사는
   거절만 할 수 있다.
4. 사람이 끈 auto-merge를 다시 켜지 않는다.
5. 어느 서비스에도 제품 DB 자격증명, 결제·메일·저장소·배포 토큰, AMUX 내부 route
   secret이 없다.
6. **격리는 서비스 단위다.** 모델을 호출하는 서비스는 GitHub 쓰기 자격증명을 갖지
   않고, 게시하는 서비스는 LLM key를 갖지 않는다. 둘은 자격증명·파일시스템·프로세스를
   공유하지 않고 본 앱 route로만 이어진다.

   **환경변수를 비우는 것은 이 조건을 충족하지 않는다.** 한 오케스트레이터
   프로세스가 두 역할을 자식 프로세스로 띄우면, 환경 상속을 끊어도 같은 uid·같은
   PID namespace·같은 파일시스템·같은 네트워크 위치가 남는다. 자식은 부모의
   `/proc/<ppid>/environ`을 읽을 수 있다. 두 역할을 한 프로세스의 하위로 합치려면
   lane별 container·uid·PID namespace·파일시스템·네트워크 정책과 **부모 환경
   비가시성의 실측 기록**이 먼저 있어야 하고, 그 전까지 둘은 별개 서비스로 남는다.
7. §4 push 금지 집합과 §9-5 허용 목록 밖을 바꾸는 변경을 push하지 않는다. 허용 목록은
   push 금지 집합을 뺀 뒤에만 적용된다.
8. **모델 실패는 "변경 없음"이 아니다.** 실패를 삼키는 fallback을 두지 않는다.
9. release-gate registry, 가격·크레딧·프로모션 값, feature flag, secret에 쓰지 않는다.
10. 일일 회차 상한은 본 앱이 DB에서 강제한다. 비용 한도는 공급자 측 지출 한도가
    강제하고, 그 거절은 실패로 기록한다.
11. feedback-autofix·cron-auto-fix의 case·incident를 입력으로 쓰지 않고 그 정책을
    완화하지 않는다.
12. 작업 착수의 승인은 AMUX 승격이다. 이 에이전트가 소유하는 승인은 T2 결정,
    `engineering.publish_pr` 인스턴스 capability, required review 판정뿐이다(§7).
    **에이전트는 PR을 승인하지 않는다.**
13. 에이전트 코드는 GitHub Actions에서 실행되지 않는다. Actions workflow를 추가·
    dispatch하지 않으며 Actions cache·artifact에 쓰지 않는다.
14. **도달 경로를 계산하지 못하면 어떤 변경도 push하지 않는다.** job 조건식 해석으로
    좁히지 않으며, 좁히는 것은 blob에 결속된 사람 검토 제외뿐이다.
15. LLM provider에 보내는 것은 공개 저장소 파일·공개 CI 로그·공개 PR·등록 원천의 고정
    commit blob·카드 execution brief뿐이다. 사용자 데이터·비공개 상세 원문·secret은
    보내지 않는다.
16. **공개 표면 쓰기는 §9-8의 목록뿐이다.**
17. heartbeat가 없으면 실패다. 정지 중에는 성공 신호를 보내지 않는다.
18. T1은, PR·push 코드를 실행하는 기존 workflow job에 쓰기 가능 자격증명이 없음을
    base commit에서 분석기와 독립 검토로 확인한 뒤에만 켠다.
19. LLM key를 가진 서비스에서 **모델이 지시한 명령·코드가 실행되지 않는다.**
20. 두 서비스는 hard timeout 뒤 반드시 끝난다. watchdog 부모가 작업 프로세스 그룹을
    강제 종료한다.
21. 결과를 모르는 쓰기를 조회 전에 재시도하거나 정리하지 않는다(§10).
22. 모델 입력의 외부 텍스트는 상한으로 결정적으로 자르며 원문 전체를 저장하지 않는다.
23. 실행 이미지는 배포 플랫폼에서 빌드하지 않고 digest로 고정해 배포한다. 게시 App
    key는 build 단계에 존재하지 않는다.
24. **본 앱은 patch를 적용하거나 실행하지 않는다**(§11).
25. 내부 route는 §8의 인증 규율을 따르고, 두 서비스의 secret은 서로의 route를
    통과하지 못한다.
26. 에이전트의 외부 텍스트·patch 본문을 AMUX의 자유 텍스트 컬럼에 넣지 않는다(§11).
27. AMUX 실행 제어 평면 전부가 push 금지 집합이다(§4-4).
28. 어떤 승인에도 2인 승인을 쓰지 않는다(§7).
29. 허용 판정은 본 앱만 만들고, capability 소비는 취소할 수 없는 단일 게시 예약이며,
    push 뒤 대조는 탐지 장치다(§11).
30. 공개된 PR의 승인 증거는 권한 있는 사람의 required review이고 병합 주체는 관측
    값이다. 승인 판정은 병합 전에 확정한다(§9-10).
31. **등록과 승격을 한 에이전트가 함께 하지 않는다.** 이 에이전트의 등록은 `backlog`만
    만들고, 우선순위를 모델이 정하지 않으며, §2.2의 원천과 상한 안에서만 한다.
32. AMUX 작업 검토를 대신하지 않고, AMUX 작업 검토로 게시·병합 권한을 얻지 않는다(§7).
33. 본 앱 route는 hard timeout을 주장하지 않으며, DB가 반드시 강제하는 것은 늦은 실행이
    성공으로 기록되지 않는 것이다(§11).

## 14. 단계와 전환 조건

| 단계 | 내용 |
|---|---|
| 구현 (모드 `off`) | 결정적 판정 코드 → 본 앱(테이블·route·adapter·화면) → 서비스 순으로 만든다. 아무것도 실행하지 않는다. 본 앱 단계는 AMUX가 adapter 부착을 지원한 뒤에, 등록 경로는 AMUX intake에 에이전트 등록 원천이 생긴 뒤에만 만든다 |
| `shadow` | 초안만. 카드를 claim하되 T1도 T2 초안으로만 끝난다. **GitHub 쓰기 없음.** 등록은 별도 스위치로 켠다 |
| `t1` | 게시 활성. PR을 열되 병합은 사람이 한다 |
| 무인 병합 | 이 정책이 부여하지 않는다 |

각 구현 단계는 아래 증거가 모두 있어야 끝난다. 이 증거는 품질 권고가 아니라 권한
판정이 보수적이고 우회되지 않음을 `shadow` 전에 보이는 조건이다.

- **결정적 판정 코드**: (1) 모든 상태 전이표가 코드 상수 하나이고 trigger와 테스트가 그
  상수에서 생성·대조된다. (2) tree 목록 검증 fixture — 초안 서비스가 실제 적용과 다른
  **거짓 목록**을 내면 게시 서비스의 대조에서 반드시 거절되고, 목록 hash 재계산·blob
  hash·base 대조가 rename·copy·binary·mode·symlink·CRLF·`.gitattributes`·헤더와 hunk가
  다른 patch에서 결정적으로 동작하며, 지원하지 않는 것은 T2다. (3) 대표 corpus에서의
  T1/T2 비율 보고(push 금지 규칙의 보수성이 치르는 비용). (4) 등록 Guard fixture — 중복,
  digest 불일치, 스캐너 거절, 상한. (5) 구현 독립 검토.
- **본 앱**: 교차 잠금 순서를 AMUX의 settle·전달 확인·만료 정리와 동시에 돌려 교착이
  없음을 보이는 DB 통합 테스트, capability 단일 소비, idempotency, 늦은 실행 거절, 구현
  독립 검토.
- **서비스**: watchdog 진입, 이미지 digest 고정 배포, 보안 회귀 고정, 구현 독립 검토,
  모든 스위치 `off`.

`shadow` 진입은 구현 병합과 배포, **이 문서의 운영자 승인**, 모델 호출 모듈의 구현
독립 검토 통과, 게시 App 등록, 그리고 dead-man monitor 두 개가 실제로 알린다는 **탐지
실험 기록**을 요구한다. 플랫폼 동작에 대한 미확인 항목은 실측 기록이 있어야 하고,
확인되지 않은 항목은 그 능력을 활성 범위에서 뺀다(추측하지 않는다).

`t1` 진입은 shadow 기간과 판정된 항목 수의 하한, 소유자가 "PR로 받을 만했다"고 판정한
비율의 하한, **판정 과소 0건**(표본 크기와 무관하게 하나라도 있으면 전환하지 않는다),
그리고 §13-18의 확인, 도달 분석 결과 기록, 게시 App 설치와 ruleset의 실제 저장소
검증 기록, stale-approval dismissal 설정 확인, 병합 관측 일곱 조건이 승인·비승인을 맞게
내는지의 관측, AMUX 작업 검토와의 순서 관측, last-look과 기대 old OID의 관측, **게시 App
자격증명 전용성 기록**(날짜 있음, key·설치 범위·이미지 digest를 바꿀 때마다), 그리고
§9-10 조건 4를 보완하는 사람 전용 승인 증거와 그 운영자 기록을 요구한다.

## 15. 이 문서를 고치는 법

- 운영자가 `approvedBy`·`approvedAt`·버전을 기록해야 효력이 있다. 버전 표에 무엇이
  바뀌었는지 한 줄로 남긴다.
- §13의 조건을 약화하는 변경은 **새 버전 승인과 독립 검토**를 요구한다. 조건을 좁히는
  변경(더 막는 쪽)은 일반 개정이다. §2.2의 원천과 상한을 바꾸는 것은 개정이다.
- 실행 제어·카드 형식·AMUX 승인에 대한 변경은 이 문서가 아니라 §0의 AMUX 문서에서 한다.
- **에이전트는 이 문서를 고치는 변경을 만들지 않는다**(§4-4).

## 16. 이 문서가 담지 않는 것

- **아직 해소되지 않은 자격증명 도달 경로의 구체 목록.** 이 저장소는 공개이므로,
  고쳐지지 않은 경로를 이름과 줄 번호로 적는 것은 그 자체가 공개다. 목록은 비공개
  설계서에 있고, 해소된 것만 이 문서와 저장소 기록에 남는다. §5는 **판정 규칙**을
  담으며, 규칙은 공개해도 안전하다 — 안전하지 않은 것은 현재 실패하고 있는 대상의
  이름이다.
- 제안 단계의 수치(주기, 보존 기간, 개별 대기열 상한). 버전 1 승인은 이 수치를 고정하지
  않았다. 각 수치는 그것을 강제하는 코드가 `shadow`에 들어가기 전에 이 문서의 개정으로
  고정한다.
  §2.2의 등록 상한과 §12의 대기 항목 합계는 이미 이 문서의 값이다.
- 구현 파일의 경로. 구현이 병합될 때 이 문서가 그것을 지목하도록 갱신한다.
