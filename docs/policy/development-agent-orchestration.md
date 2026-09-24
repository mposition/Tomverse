# Development Agent Orchestration

상태: **승인됨.** 운영자 `mposition`이 2026-09-22에 버전 2 본문을 승인했다. 같은 운영자가 2026-09-24에 버전 3의 수동 promotion pilot 절을 승인했다. 같은 운영자가 2026-09-24에 버전 4의 소스 reconciliation 적용 경로를 승인했다. 그 경로의 코드 래치는 꺼진 채로 출고했다. 같은 운영자가 2026-09-24에 버전 5로 그 코드 래치를 켰다. 그 승인은 운영 revision을 쓰지 않고, `amux_authority`로 넘어가지 않는다. 같은 운영자가 2026-09-24에 버전 6으로 promotion pilot의 코드 래치를 켰다. 그 승인은 카드를 승격하지 않고, 환경 변수를 켜지 않으며, worker 실행과 `amux_authority`를 열지 않는다. 공개 저장소에 버전 2 본문이 기록되기 전에는 공개 v1이 저장소상의 승인 정책으로 남는다.
approvedBy: mposition · approvedAt: 2026-09-22 · 정책 버전: 2
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 3
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 4
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 5
approvedBy: mposition · approvedAt: 2026-09-24 · 정책 버전: 6

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-09-21 mposition | 최초 승인. 병합 당시 본문에 두 가지를 더한 상태를 승인한다 — Agent 승인은 2인 승인(`AdminActionApproval`)이 아니라는 공통 기반 §0 결정(PR #1583)과, 개별 Agent 정책과의 경계(PR #1586) |
| 2 | 2026-09-22 mposition | Phase A selection-only 경계와 stage-C 비실행 catalog import 계약을 추가한다. 같은 운영자의 prepared row self-approval을 1인 조직 예외로 승인한다. v1의 2인 승인과 sole-approver 경계를 유지한다. |
| 3 | 2026-09-24 mposition | 사람이 고른 1~3개 backlog 카드의 수동 promotion pilot. 코드 래치는 끈 채로 둔다. 자동 승격, worker 실행, 유료 호출, 사용자 크레딧, 현황판 cutover는 열지 않는다. |
| 4 | 2026-09-24 mposition | 카드별 accept 또는 reject만 받는 append-only source reconciliation 적용 경로. 코드 래치는 끈 채로 둔다. source 컬럼 overwrite, revision delete, lifecycle 변경, 현황판 cutover는 열지 않는다. |
| 5 | 2026-09-24 mposition | #1662 배포 `4265e173422915516eee0e4b9dda3bc519ca47c3` 뒤, J의 운영 read-back을 위해 reconciliation 코드 래치를 켠다. 환경 값이 정확히 `enabled`일 때만 apply가 열린다. 이 버전은 revision을 쓰지 않고 `amux_authority`와 현황판 동결을 열지 않는다. |
| 6 | 2026-09-24 mposition | 운영자가 2026-09-24에 적은 E pilot 세 카드(`OPS-JOBS-DELAYED-01`, `MOBILE-HEADER-NARROW-01`, `STARTER-LAYOUT-01`)를 위해 promotion 코드 래치를 켠다. 환경 변수 `TOMVERSE_AMUX_BOARD_PROMOTE`가 정확히 `enabled`일 때만 apply가 열린다. 이 버전은 카드를 승격하지 않고, 환경 변수를 설정하지 않으며, worker 실행과 `amux_authority`를 열지 않는다. |

v1 행은 역사적 승인 기록으로 남는다. v2는 이 표의 행과 상태 줄이 공개 저장소 파일에 함께 기록되어야 저장소상 효력을 가진다. 개별 Agent의 승인 정책을 이 문서의 승인으로 간주하지 않는다.

공통 Agent 기반 원칙 1은 승인된 정책 버전과 `approvedBy`·`approvedAt`이 기록되기 전에 구현을 시작하지 못한다고 정한다. 이 후보가 공개 저장소에 병합되더라도 그 셋이 기록되기 전에는 구현 권한이 생기지 않는다.

## Scope

Tomverse의 개발 Agent 팀은 `tomverse-orchestrator`를 통해 실행한다.

이 문서는 **모든** 개발 Agent worker의 실행 제어를 정한다. 우선순위, 소유권,
선택과 실행의 분리, 실행 권한, 승인과 감사의 경계가 여기 있다.

**개별 Agent의 권한은 여기 적지 않는다.** 어떤 입력을 작업으로 인정하는지,
그 결과물이 공개 저장소와 쓰기 가능 자격증명에 어디까지 닿는지는 그 Agent의
정책 문서가 정한다. engineering Agent는 `docs/policy/engineering-agent.md`다.
intake Agent의 승인된 v1 설계는 `docs/policy/amux-intake.md`다.
한 Agent의 규칙을 여기 올리면 다른 팀의 worker가 그 규칙에 묶인다.

두 문서가 충돌하면 적용 범위가 좁은 쪽이 이긴다.

## Authority

Tomverse 애플리케이션이 작업 상태의 최종 authority다.

Agent worker는 production 데이터베이스를 직접 수정하지 않는다.
모든 작업 claim, 상태 전환, 승인, 감사 기록은
`/api/internal/amux/*` 경계를 통한다.

## Scheduling

Global Priority Scheduler는 opt-in 방식으로 운용한다.

Priority ordering은 최소 다음 원칙을 보존한다.

- explicit priority
- starvation prevention through task age
- deterministic tie breaking
- dependency-aware critical-path prioritisation
- human overrides where available

Worker-local pickup 정책과 global scheduling 정책은 별도로 유지한다.

## Concurrency

Task ownership 변경은 compare-and-set 형태여야 한다.

이미 다른 actor가 task ownership 또는 lifecycle state를 변경했다면
router는 해당 변경을 덮어쓰지 않는다.

## Execution boundary

Scheduler의 task 선택은 실행 시작과 분리한다.

선택 자체가 다음 동작을 자동으로 의미하지 않는다.

- task status transition
- lease creation
- attempt creation
- irreversible operation
- external delivery

## Approval

외부 시스템 변경, 배포, 이메일 발송 등 irreversible/high-risk action은
사람의 승인을 통과해야 한다.

Agent 승인은 2인 승인(`AdminActionApproval`)을 쓰지 않는다.
2인 승인은 "관리자 두 사람이 한 action에 동의한다"를 표현하며,
"사람 한 명이 시스템이 만든 초안을 승인한다"를 표현하지 못한다.
Agent 승인은 별도 계약이고, sole-approver 예외 목록은 건드리지 않는다.

v1은 그 별도 계약이 아직 없다고 정했다. 이 v2 후보는 Phase A와 stage-C catalog
import에 한정해 아래 두 절에서 그 공백을 구체화한다. 이것은 기존 2인 승인의
우회도, 새 sole-approver 예외도 아니다. `AdminActionApproval`의 예외 목록과
`docs/policy/admin-sole-approver.md`는 변경하지 않는다.

계약이 승인되고 구현되기 전까지 AMUX의 어떤 경로도 승인을 받았다고 기록하지
않으며, 승인이 필요한 action을 수행하지 않는다. 승인 전 코드가 존재하거나
테스트가 통과해도 그 사실만으로 승인과 활성화를 대체하지 않는다.

## Audit

Scheduler, claim, refusal, approval 결과는 measured/verdict를 포함한
구조화된 audit event로 남긴다.

사람 감사와 시스템 감사는 같은 canonical `AdminAuditLog` chain에 남긴다.
현재 `writeAdminAuditLog`와 `writeSystemAuditLog`는
`adminAuditIntegrityKeys(process.env)[0]`가 없으면 `entryHash=null`로 행을
만들 수 있다. 따라서 Phase A 또는 stage C의 상태 변경은 그 일반 동작에 맡기지
않는다. 구현은 두 기존 함수만 사용하고 감사 테이블에 직접 쓰지 않는다. 서명
키가 하나도 없으면 함수 호출과 트랜잭션 시작 전에 실패한다. 호출 뒤에도 반환된
audit ID의 actor·action·target·비어 있지 않은 `entryHash`와 직전 hash 연결이
검증되지 않으면 전체 변경을 rollback한다.

그 함수는 canonical chain advisory lock을 잡고, 서명 키가 있을 때 `createdAt`을
chain head보다 뒤로 조정할 수 있다. 현재 AMUX boundary의 200ms statement
timeout과 100ms idle timeout 아래에서 이 잠금과 카드 쓰기가 함께 완료된다는
증거는 없다. stage C는 그 DB 통합 증거가 생기기 전에 현재 AMUX boundary를
import transaction에 재사용한다고 가정하지 않는다. 필요한 timeout boundary는
구현 시 측정해 정책 개정 또는 코드 계약으로 확정한다.

이 정책은 매 쓰기마다 전체 과거 chain을 검증한다고 주장하지 않는다. 트랜잭션
안의 검사는 linked row와 직전 연결에 한정한다. 전체 chain 검증은 별도의
verifier가 수행한다. 결속된 행이 없어도 `entryHash`가 비어 있어도 성공으로
기록하지 않는다.

## Phase A selection-only boundary

Phase A에서 검증 가능한 AMUX 능력은 queue read와 routing snapshot의 결정적
선택 판단뿐이다. Tomverse 앱은 task ownership, lifecycle, execution, audit의
최종 authority다. 선택은 작업 소유권 변경, lease·attempt·delivery 생성, Agent
실행, 외부 시스템 변경을 뜻하지 않는다.

`claim`과 그 뒤의 worker 등록·heartbeat, owned queue, execution, delivery,
settlement은 Phase A production에서 비활성이다. local process executor는
production에서 실행할 수 없으며 환경변수만으로 그 금지를 해제하지 못한다.
이후 실행 허용은 Agent별 승인 정책, 격리된 실행 서비스, 비용·보존·감사 계약과
별도 검증·활성화 결정을 요구한다. 선택 전용 route의 production 활성화도 별도
승인이며, 이 정책 문안만으로 활성화되지 않는다.

DB timeout은 실제 PostgreSQL 버전과 세션에서 읽은 설정값으로만 말한다.
2026-09-22 `develop`의 AMUX DB boundary는 트랜잭션 첫 SQL에서 `set_config(...,
true)`로 다음만 설정한다.

- `statement_timeout`: 200 milliseconds
- `idle_in_transaction_session_timeout`: 100 milliseconds
- session-local deadline marker: `tomverse.amux_deadline`

같은 코드는 `transaction_timeout`을 설정하지 않는다. 마지막 SQL은
`clock_timestamp()`를 deadline과 비교하는 commit fence다. 이것은 COMMIT 완료
시각의 증명이 아니다. 앱의 Prisma timeout, pool 대기, Prisma 호출 수에서 유도한
예산도 PostgreSQL이 강제하는 end-to-end 트랜잭션 상한이 아니다. Prisma 호출
수를 SQL 문장 수로 부르지 않는다.

PostgreSQL 17의 `transaction_timeout` 기본값은 0이고, 0은 비활성이다. 설정값이
`statement_timeout` 또는 `idle_in_transaction_session_timeout`보다 짧으면 더
긴 설정이 무시된다. 같은 값이면 그 비활성 규칙이 적용된다고 말하지 않는다.
PostgreSQL 16에는 이 설정이 없다. 현재 코드가
이 설정을 추가하기 전에는 전체 트랜잭션 점유 상한을 제공한다고 말하지 않는다.
`SET`/`SET LOCAL`의 timer 시작점, SAVEPOINT, pool checkout 대기, durable
`COMMIT`, prepared transaction의 예외를 해당 구현과 같은 DB 버전에서 측정하기
전에도 같은 제한이 적용된다.

응답 유실, timeout, 또는 `COMMIT` 결과가 불명확하면 `outcome_unknown`이다.
앱은 새 claim·실행·재시도를 만들지 않는다. 식별 가능한 request, task, attempt와
canonical audit를 권위 있는 앱 DB에서 다시 읽고 사람에게 판정을 넘긴다.
timeout만으로 미기록을 단정하거나 blind retry하지 않는다. 현재 코드의 fence는
COMMIT 전의 DB-clock 검사이므로, 그 fence만으로 late-success 방지가 증명됐다고
말하지 않는다. 실행 경로 활성화 전에는 같은 DB 통합 테스트가 late COMMIT의
성공 기록 방지와 read-back 식별·멱등을 증명해야 한다.

heartbeat의 필수 계약은 실행 경로를 활성화하는 승인이 아니다. 실행 attempt의
lease를 연장하는 heartbeat는 상태 변경이며 canonical system audit와 같은
트랜잭션에서 처리한다. `AmuxWorkerRuntime`의 고빈도 lease refresh는 worker
status와 dispatch readiness가 모두 변하지 않을 때만 telemetry 예외다. worker
등록과 status·readiness 변경은 예외가 아니다.

이 절은 Agent 결과물 승인, 외부 PR 게시·병합, 배포, 이메일 발송, 유료 provider
호출, 사용자 크레딧 사용, 자동 승격·삭제를 승인하지 않는다.

## Workboard catalog import

Catalog import는 Agent 실행 권한을 부여하지 않는 별도 Admin 동작이다. source
board가 제품 작업의 Outstanding 여부와 투자·배정 우선순위의 정본이다. AMUX
카드는 그 현황판의 실행 projection이며 제품 우선순위의 정본이 아니다. 정본을
AMUX로 옮기는 cutover는 이 정책의 범위가 아니다.

### Initial population

최초 적용은 적용 시각에 다시 계산한 source의 활성 고유 ID 전부만 대상으로 한다.
추천 순서 참조는 카드가 아니다. 2026-09-22의 65건과 6건은 측정값이며 앞으로
고정하는 승인 개수가 아니다. source가 바뀌면 그 측정값과 digest를 재사용하지
않는다.

최초 이관의 모든 신규 카드는 다음 현재 DB 상태를 만족해야 한다.

- `status=backlog`
- owner와 `claimedAt`이 null
- attempt, delivery, route decision이 없음
- `sourceSystem`, `sourceKey`, `sourceVersion`, `sourceDigest`,
  `sourceSnapshot`이 현재 provenance CHECK의 다섯 필드를 함께 만족함
- `sourceSystem`과 `sourceKey`만 현재 unique pair다. 기존 pair는 재사용하지
  않는다
- `sourceVersion`과 `sourceDigest`는 provenance이며 unique identity의 일부가
  아니다
- `description`은 null

현재 `AmuxWorkItem`에는 `mode`, `executionBrief`, `catalog_only`,
`dispatch_candidate`, `exclude` 컬럼이 없다. 최초 이관은 이 다섯 값을 다른
기존 컬럼의 의미로 저장하지 않는다. 여기에는 `classification`, `kind`,
`priority`, `description`, `sourceSnapshot`이 포함된다. 이 값들은 제출
manifest의 분류일 뿐이며, 최초 제출은 catalog-only 분류, null brief,
exclude 0건, dispatch-candidate 0건이 아니면 쓰기 전에 거절한다. 해당 컬럼이
나중에 필요하면 이 정책의 개정과 migration이 먼저다.

queue read, routing snapshot, claim, priority scoring은 `backlog`를 실행
후보로 읽지 않는다. 현재 scheduler·routing·claim은 literal `todo`와 owner null,
archive null, dependency-ready 조건만 읽는다. 이 기존 조건에 의존해도 되지만,
구현은 DB constraint와 API 회귀로 backlog 제외를 계속 증명해야 한다. 최초
이관은 `todo` 승격, claim, worker 시작, execution flag 활성화, provider 호출,
사용자 크레딧 사용을 만들지 않는다.

현재 schema는 카드 `title`을 nullable이 아닌 `String`으로 요구한다. 그러나 최초
이관은 자유 텍스트 title, status summary, detail Markdown, local path, URL,
credential을 복제하지 않는다. 구현은 안정적인 source key에서 결정적으로 만든
비식별 placeholder title만 저장한다. `sourceSnapshot`도 자유 텍스트를 담지
않고 source key, section code, detail digest, manifest digest, policy version만
담는다. placeholder가 원문 단어나 순번에서 내용을 재구성할 수 있으면 거절한다.
자유 텍스트 저장이 필요하면 data-domain validator의 명시적 예외, 보존·삭제
계약, 정책 테스트가 먼저 승인돼야 하며 가짜 `User` FK는 추가하지 않는다.

### Preview, prepare, and approval

Preview, prepare, approval, apply는 서로 다른 동작이다.

- Preview는 계산과 표시만 한다. 앱 DB domain state, approval row, card, audit
  row를 만들지 않는다. 비공개 manifest를 받으므로 외부에 열지 않는다. 현재
  public permission에는 `amux:import:read`가 없다. 따라서 최초 구현의 preview
  권한은 기존 `owner` Admin role이다. 세션은 `resolveAdminSessionAccessState`
  기준 authorized이고, `isRecentAdminAuthentication` 기준의 최근 step-up을
  통과해야 한다. 전용 permission 이름이 필요하면 `AdminPermission`과 role map,
  route test에 함께 추가하는 별도 정책 개정 뒤에만 사용한다.
- 무쓰기는 앱 DB에 상태 행이 없다는 뜻이다. reverse proxy, APM, access log,
  PostgreSQL error log, browser memory, backup에 본문 흔적이 없다는 뜻이 아니다.
  payload와 거절 원문이 그 경로에 남지 않는다는 증거 없이는 활성화하지 않는다.
- Preview는 계정당 분당 10회를 넘지 않는다. 이 제한은 replay oracle을 줄이기
  위한 제품 제한이며 DoS 방어의 완전한 증명은 아니다. 초과와 scan 거절은 서로
  구별되는 오류 코드만 반환한다.
- Prepare는 명시적 쓰기다. 같은 `owner`, authorized session, 최근 step-up을
  요구한다. prepared row와 canonical human audit는 같은 트랜잭션에 생성한다.
  전용 `amux:import:approve` permission이 role map에 추가되기 전에는 그 이름만
  권한 부여의 근거로 사용하지 않는다.
- Approval은 같은 `owner`가 자신이 만든 prepared row를 승인할 수 있다. 이
  예외는 운영자 `mposition`이 2026-09-22에 이 정확한 v2 본문과 함께 승인했다.
  승인 세션은 authorized이고 최근 step-up을 통과해야 한다. 이것은 v1이 이미
  정한 규칙이 아니라, 1인 운영자 조직에 대한 새 Agent 승인 예외다. 기존 2인
  `AdminActionApproval` 규칙과 sole-approver 목록은 변경하지 않는다.
- Reject, expire, apply, approval consumption도 각각 상태 변경과 canonical
  audit를 같은 트랜잭션에 기록한다. 사람의 전이는 human actor, 자동 expire만
  등록된 system actor를 사용한다.

승인 모델의 제안명은 `AmuxBoardImportApproval`다. 구현 전 이름 변경은 정책
개정 없이는 하지 않지만, 이 문장만으로 schema 이름이 승인된 것은 아니다. 행은
`actorUserId`와 unique `authorizationAuditLogId`를 가진다. `actorUserId`에는
`User` FK를 만들지 않는다. 계정 삭제가 승인 증거를 다시 쓰거나 null로 바꾸면
안 되기 때문이다. 현재 registry 검사는 `userId` 또는 `approvedBy` 형태의 식별
컬럼을 사용자 데이터로 본다. 따라서 이 모델은 registry에 actor row로 등록하고
`subjectReference.kind=none`을 명시한다. 고객에 관한 행이 아니기 때문이다.

account-data export domain에도 등록하되 state는 `excluded`이고 exclusion
reason은 "operator approval evidence, not customer data"다. `included` 또는
`included_filtered`로 등록해 고객 export fetcher를 요구하지 않는다. 운영자의
접근·정정·삭제 요청은 수동 PrivacyRequest 경로로 다루고 legal hold가 purge보다
우선한다.

현재 registry의 관리 감사 `retentionPeriod`와 `retentionPolicyRef`는 `TBD`다.
`legalBasis` 문장은 이미 적혀 있으므로 근거 자체가 비어 있다고 말하지 않는다. 따라서 24시간, 30일,
7년, archive 후 특정 기간 삭제 중 어느 것도 법률상 보존 기간이라고 부르지 않는다.
카드·승인 행·snapshot·log·backup·staging copy의 목록과 security-privacy 및 필요한
법률 검토가 production apply 전에 끝나야 한다. 그 전에는 production apply를
활성화하지 않는다.

### Approval binding and transitions

승인 snapshot은 다음 필드를 한 목록으로 결속한다. 정책, schema, UI, audit는
서로 다른 목록을 사용하지 않는다.

- canonical manifest SHA-256과 canonicalizer version
- source commit SHA와 board digest
- source verification mode와 DB-clock confirmation time
- active item count와 section count
- recommendation-reference count
- create, no-op, conflict, exclude의 source-key list와 count
- 각 execution-brief digest. 최초 이관은 모두 null
- planner, validator, scanner version과 scanner ruleset digest
- policy version
- approver actor ID와 approval row ID
- raw request-body SHA-256. 원문은 감사에 넣지 않는다.

감사 metadata에는 digest, count, version, verification mode, DB timestamp만
남긴다. 제목, 상태 한 줄, brief, secret, URL, local path, scan finding은 감사
summary와 metadata에 넣지 않는다. 현재 `safeSummary`는 500자만 자르므로 구현은
그것만으로 최소화를 대체하지 않는다. audit `targetId`는 approval row ID다.

최초 이관의 source verification mode 값은 `operator_attested`다. 이 v2 본문이
승인되기 전에는 그 필드명도 승인된 구현 계약이 아니다. 서버가 비공개 Git 원격
tip 또는 운영자 PC의 fetch를 독립 검증했다고 기록하지 않는다.

상태 전이는 다음이 전부다.

- `prepared -> approved`
- `prepared -> rejected`
- `prepared -> expired`
- `approved -> consumed`
- `approved -> rejected`
- `approved -> expired`

모든 전이는 compare-and-set이며 같은 트랜잭션의 audit 없이는 완료하지 않는다.
consume는 apply transaction이 카드를 만들거나 정확히 no-op임을 확인한 뒤에만
일어난다. 다른 전이는 없다. 자동 expire는 prepared 또는 approved 시각부터 15분
뒤 DB clock 기준이다. step-up 신선도는 별도이며, 기본 `ADMIN_RECENT_AUTH_MINUTES`
값이나 운영 환경의 실제 값을 expire 기간으로 재사용하지 않는다.

결정적 검증 실패에는 `rejected`를 사용한다. conflict, exclude, schema mismatch,
digest mismatch, scanner mismatch는 카드 쓰기 전에 같은 트랜잭션에서 approval을
`rejected`로 바꾸고 human 또는 system audit를 남긴다. reject된 approval ID는
재실행할 수 없다. 원인을 고친 뒤에는 새 preview와 새 approval이 필요하다.
timeout, connection loss, 또는 commit 결과가 불명확하면 reject도 retry도 하지
않고 `outcome_unknown`으로 유지한다. 이 상태가 지속되는 동안 15분 자동 expire는
적용하지 않는다. DB read-back으로 결과가 확정된 뒤에만 consume, reject,
expire 중 하나를 기록한다.

Prepare 이후 source commit, board digest, manifest digest, item count, scanner
version, ruleset digest 중 하나라도 바뀌면 기존 approval row를 폐기하고 새
preview부터 시작한다. 폐기 전 행으로 apply하지 않는다.

Apply 직전 서버는 현재 DB를 다시 읽어 create, no-op, conflict를 계산한다.
현재 durable identity는 `(sourceSystem, sourceKey)`다. `sourceDigest`는 그
unique key의 일부가 아니다. 같은 pair가 이미 있고 backlog이며 owner와
`claimedAt`이 null이고 digest, version, snapshot digest가 승인 snapshot과
같으면 no-op이다. pair가 같지만 digest, lifecycle, owner, attempt, delivery가
다르면 update가 아니라 conflict다. pair가 없으면 create다. 최초 이관에서
conflict 또는 exclude가 하나라도 있으면 카드를 쓰지 않고 approval을 `rejected`로
마친다. timeout이나 응답 유실은 성공·실패로 추정하지 않는다. approval ID와
body digest로 DB를 다시 읽고, 불명확하면 `outcome_unknown`으로 사람에게 넘기며
blind retry하지 않는다.

### Source attestation

최초 이관의 확인 주체와 시점은 다음으로 고정한다.

1. Preview 뒤, prepare 전에 운영자는 source `main`의 fetch를 성공시킨다.
2. 운영자는 planner가 코드에 명시적으로 검사하는 8개 경로만 clean한지 확인한다.
   공개 정책은 그 비공개 경로를 열거하지 않는다. planner 출력의 clean 결과가
   전체 worktree cleanliness를 뜻하지 않는다.
3. 같은 운영자는 최근 step-up을 통과한 Admin 세션에서 source SHA, board digest,
   manifest digest, item count, scanner version, ruleset digest를 명시적으로
   확인한다.
4. Prepare transaction은 그 값을 `operator_attested`와 DB-clock
   `sourceAttestedAt`으로 승인 snapshot에 결속한다.
5. 서버는 비공개 Git 원격을 조회하지 않는다. fetch 실패, remote mismatch,
   planner mismatch는 확인을 거부하고 새 preview를 요구한다.
6. 확인 이후의 remote move 또는 force-push는 서버가 탐지하지 못할 수 있다.
   따라서 이 snapshot은 최초 비실행 backlog 이관에만 유효하다. 후속 import,
   reconciliation, promotion은 새 preview와 새 승인이 필요하다.

`server_verified` mode는 이 정책에 없다. 저장소 한정 read-only credential,
보관 위치, 접근 감사, 외부 전송 검토를 별도로 승인하기 전에는 추가하지 않는다.

### Input and scanner contract

모든 import 요청은 `application/json`, UTF-8, 알려진 schema만 받는다. 디코드
전에 원시 body가 1,048,576 UTF-8 bytes를 넘으면 거절한다. JSON 이후의 제한은
다음과 같다.

- 활성 항목: 최대 256개
- source system: 현재 DB CHECK의 lowercase pattern. 공개 정책은 비공개 저장소
  이름을 값으로 적지 않는다
- source key: 현재 DB CHECK의 uppercase pattern을 먼저 만족해야 한다. 첫 글자는
  대문자 또는 숫자이고, 이후에는 대문자·숫자·점·밑줄·콜론·하이픈만 허용된다.
  최초 제출은 여기에 더해 점·밑줄·콜론 없이 대문자·숫자·하이픈만 사용하고
  전체 1~64 bytes여야 한다. 이 제품 제한은 DB CHECK의 상위 집합이 아니다.
  중복은 거절한다
- source version: 현재 DB CHECK의 printable non-whitespace pattern. 최초
  이관 값은 정확한 source commit SHA다. unique identity에는 들어가지 않는다
- placeholder title: 64 UTF-8 bytes 이하이며 원문 title에서 생성하지 않음
- section code: 닫힌 ASCII 목록
- detail digest와 manifest digest: lowercase hex SHA-256
- execution brief: 최초 catalog import에서 null. 후속 정책에서만 최대 8,192 UTF-8 bytes
- 알 수 없는 필드, NUL, 잘못된 UTF-8, 지원하지 않는 version: 거절

숫자 제한은 JavaScript UTF-16 string length가 아니라 검증된 UTF-8 byte 수다.
현재 planner의 20,000 string-unit brief 검사는 이 서버 제한과 다르며 서버
scanner를 대체하지 않는다.

Scanner 이름 `amux-board-content-scan-v1`는 구현과 불변 ruleset digest,
고정 양성·음성·오탐 fixture가 함께 있을 때만 유효하다. 검사 대상은 known-token
pattern, private/local path, raw URL, high-entropy secret pattern이다. 40-hex
Git commit SHA와 64-hex digest는 지정 필드에서 오탐으로 거절하지 않는다. 다른
위치의 같은 형태는 맥락 없이 허용하지 않는다.

검사는 preview 표시 전, prepare 저장 전, apply 시작 전 각각 수행한다. apply는
승인 snapshot의 raw-body digest, scanner version, ruleset digest가 모두 같을
때만 계속한다. scanner 부재, 실행 실패, version mismatch, ruleset mismatch,
탐지는 fail-closed다. 거절 원문과 탐지 문자열은 DB, HTTP response, audit,
structured application log에 남기지 않고 허용된 오류 코드와 count만 남긴다.
proxy, APM, PostgreSQL error log, backup, staging sample에 raw payload가 남지
않는다는 설정을 검증하기 전에는 활성화하지 않는다. scanner 통과는 개인정보
부재나 공개 안전의 보증이 아니다.

### Apply gate

Apply는 기본 비활성인 별도 server-side gate 아래에서만 동작한다. 환경변수 하나만
존재한다고 활성으로 해석하지 않는다. 최초 production apply는 이 정책 승인,
구현, 작성자와 다른 독립 검토, staging 증거, 그리고 별도 운영자 승인이 모두
필요하다.

단일 writer는 card insert, explicit dependency insert, approval consumption,
canonical human audit를 한 트랜잭션에 기록한다. 최초 이관은 dependency를 만들지
않는다. Markdown link를 dependency로 추론하지 않으며 투자 순위를 p0~p3으로
산술 변환하지 않는다. source row removal, digest drift, operator edit, active
attempt는 overwrite나 delete가 아니라 conflict다.

Apply 성공 후 staging 또는 production에서 증명해야 하는 불변식은 다음과 같다.

- 신규 카드 status는 모두 backlog
- owner, claimedAt, attempt, delivery, route decision 증가량은 0
- worker execution과 provider call은 0
- user credit 사용량은 0
- approval consume count는 적용한 approval 1건
- 같은 body digest의 재실행은 추가 카드 0건

## Out of scope

이 v2 후보는 다음을 승인하거나 구현하지 않는다.

- staging 또는 production 배포
- import/apply flag의 실제 활성화
- 운영 DB card 생성
- backlog에서 todo로의 promotion
- worker 실행, 유료 provider 호출, 사용자 credit 사용
- 자동 promotion
- Markdown 현황판 정본의 AMUX cutover
- 후속 reconciliation의 overwrite 또는 delete
- `server_verified` private-Git integration
- legal retention period의 확정

각 항목은 해당 단계의 별도 정책·독립 검토·운영자 승인이 필요하다.
버전 3은 그중 수동 1~3개 promotion pilot만 연다. 나머지 항목은 그대로다.

## Manual promotion pilot

버전 3은 catalog import가 만든 `backlog` 카드 가운데 운영자가 한 요청에 적은 1~3개만 `todo`로 바꾸는 별도 Admin 동작이다. 이 절은 그 카드를 고르지 않고, 실행 brief를 쓰지 않으며, apply 래치를 켜지 않는다. 래치가 꺼진 구현이 병합돼도 카드 status는 바뀌지 않는다.

요청은 `amux-json-v1`로 정규화한다. 항목은 1개 이상 3개 이하다. 각 항목은 기존 카드 id, 기대 revision, 저장된 `sourceDigest`, 명시적 `kind`, 명시적 `priority`, routing `classification`, execution brief를 함께 가진다. `kind`는 현재 `AmuxWorkItem_kind_check`의 값 가운데 `unknown`을 뺀 것이다. `priority`는 `p0`~`p3` 중 요청에 적힌 값이다. classification은 `task_kind`, `complexity`, `risk`, `files_expected`만 가진다. `task_kind`는 현재 worker router가 이름을 가진 값만 허용한다. brief는 1~8,192 UTF-8 byte다.

Brief와 요청 전체는 catalog scanner(`amux-board-content-scan-v1`)를 통과해야 한다. 그 scanner는 URL, path separator, 토큰, 비공개 문서 경로를 거절하므로 brief는 저장소 경로를 담지 못한다. 목표, 포함과 제외, 완료 증거는 경로 없이 적는다.

대상 카드는 `backlog`이고 owner와 `claimedAt`과 `archivedAt`이 null이며, attempt, delivery, route decision이 0이고, 의존성이 있으면 그 의존성은 `done`이며 archive되지 않았다. source identity가 없거나 digest가 다르면 거절한다. 하나라도 거절이면 배치 전체를 쓰지 않는다.

Apply는 환경 변수 `TOMVERSE_AMUX_BOARD_PROMOTE`가 정확히 `enabled`이고 코드 래치가 true일 때만 열린다. 버전 3이 출고한 코드 래치는 false였다. 버전 6이 출고하는 코드 래치는 true다. 요청 스키마의 `policyVersion`은 3으로 남는다. HTTP route는 래치를 인자로 받지 않는다. 승인 계약은 catalog import와 같다. 준비한 운영자가 최근 step-up 후 같은 행을 승인하고, 창은 15분이며, 소비는 한 번이다. 감사 metadata에는 brief 원문, 제목, source key를 넣지 않는다. 환경 값이 `enabled`가 아니면 코드 래치가 켜져 있어도 트랜잭션을 열지 않는다.

성공한 apply는 그 카드의 status를 `todo`로 바꾸고, 요청의 kind, priority, classification, brief, brief digest를 기록하고, revision을 1 올린다. owner를 세팅하지 않고 attempt, delivery, route decision을 만들지 않는다. `TOMVERSE_AMUX_EXECUTE`를 바꾸지 않는다. queue는 계속 literal `todo`와 owner null만 읽는다. 승격된 카드는 그 조건에 들어가 선택 대상이 될 수 있으나, 선택은 실행이 아니다.

버전 3의 승인만으로는 운영 DB의 카드를 승격하지 않았다. 카드를 적은 별도 요청은 그 뒤에 있었고, 버전 6은 래치를 켜는 승인이다. 버전 6은 그 요청을 실행하지 않고 환경 변수를 설정하지 않는다. 환경 값이 정확히 `enabled`인 배포에서 최근 step-up을 가진 운영자가 apply하기 전에는 status가 바뀌지 않는다. 적용 순서는 한 장, 그 결과의 read-back, 이어서 두 장이다. 이 순서는 운영 절차이고 코드가 강제하지 않는다.

## Source reconciliation apply

버전 4는 이미 가져온 카드의 source revision을 카드마다 한 결정으로 추가하는 별도 Admin 동작이다. 버전 4는 운영 DB에 revision을 쓰지 않고 코드 래치를 끈 채로 출고했다. 버전 5는 그 코드 래치만 켠다. 이 절은 운영 DB에 revision을 쓰지 않고, 현황판 정본을 AMUX로 바꾸지 않는다. 래치를 켜는 것은 현황판 cutover가 아니다.

요청은 `amux-json-v1`이다. catalog scanner(`amux-board-content-scan-v1`)를 통과해야 한다. 항목 정체성은 source key, section code, detail digest다. manifest digest는 run의 속성이고 카드 drift를 만들지 않는다. source version은 catalog scanner가 commit으로 읽는 40자리 hex다.

item drift인 source key마다 `accept_new_source_revision` 또는 `reject`가 정확히 하나 필요하다. 두 카드를 한 결정으로 묶지 않는다. no-op, missing, extra에는 revision을 만들지 않는다. 결정이 빠지거나 drift가 아닌 키를 결정하면 preview는 거절하고 writes는 0이다.

Preview는 아무것도 쓰지 않는다. `applyPermitted`는 환경 변수 `TOMVERSE_AMUX_RECONCILIATION_APPLY`가 정확히 `enabled`이고 코드 래치가 true일 때만 true다. 버전 5가 출고하는 코드 래치는 true다. HTTP route는 래치를 인자로 받지 않는다. Apply는 그 판정이 false이면 트랜잭션을 열기 전에 `apply_disabled`로 거절한다. 환경 값이 `enabled`가 아니면 코드 래치가 켜져 있어도 트랜잭션을 열지 않는다.

래치가 열린 뒤의 한 트랜잭션은 consumed run, 사람 감사, revision insert, accept인 카드의 pointer 갱신만 한다. revision은 append-only다. accept는 새 accepted revision을 넣은 뒤에 pointer만 옮긴다. reject는 rejected revision만 추가하고 pointer를 유지한다. 어느 쪽도 `sourceVersion`, `sourceDigest`, `sourceSnapshot`, status, kind, priority, owner, `claimedAt`을 바꾸지 않는다. attempt, delivery, route decision, provider cost, 사용자 크레딧을 만들지 않는다. 감사 metadata에는 제목과 source key를 넣지 않고 digest와 개수만 남긴다.

overwrite와 delete는 여전히 없다. 코드 래치를 켜는 것은 현황판 cutover가 아니다.
