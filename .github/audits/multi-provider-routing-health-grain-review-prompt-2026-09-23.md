# 독립 검토 요청 — health 표본의 grain 컬럼

- 대상 commit: `13af0bcfe` `feat(routing): the grain columns on the tables health is sampled from`
- 검토 worktree: `H:\Project\tv-routing-review-20260922`
- 직전 라운드: allocation 축과 router-core package,
  `.github/audits/multi-provider-routing-allocation-and-package-review-prompt-2026-09-23.md`.
  그 라운드의 major(세 갈래 CHECK가 `NULL`로 평가돼 통과하던 것)와 minor 다섯 건은
  `48f64adca`에서 닫았습니다. 같은 부류를 다른 dark migration에서도 하나 더
  찾아 고쳤습니다(cache evidence의 `NULL ~ regex`).

## 무엇을 했는가

설계 §8.1의 cutover 선행조건 5개 중 **1번**입니다. router의 후보 필터는
`ProviderProbeResult`를 읽고 dispatch 신호는 `RoutingAttempt`에서 오는데, 두
테이블 어디에도 **어느 deployment의 표본인지** 적을 곳이 없습니다.

- 두 live table에 nullable `providerEndpointId`·`modelDeploymentId` 추가
- `AvailabilityObservation`이 가졌어야 할 FK 둘도 여기서 추가
- FK 여섯 개 전부 `ON DELETE RESTRICT`
- `ProviderHealthState`는 건드리지 않음

## 검토해 주셨으면 하는 것

### 1. live table에 컬럼을 더하는 것이 안전한가

앞선 항목들은 전부 새 테이블이었고 이번은 **운영 중인 두 테이블**입니다.

- `ALTER TABLE ... ADD COLUMN` 두 개와 부분 인덱스 두 개가 이 크기의 테이블에서
  무엇을 잠급니까? PostgreSQL 버전별로 답이 다릅니까?
- 기존 writer(`lib/routingDispatchInstrumentation.ts`,
  `lib/providerProbe.ts`)가 컬럼을 이름 대지 않고 계속 동작합니까?
- Prisma client 재생성 없이 배포되는 순서가 문제를 만듭니까?

### 2. RESTRICT가 옳은가

주석의 논거: "표본은 이력 기록이고, 배치를 지운다고 그 기록이나 귀속이
사라져서는 안 된다. 라우팅을 멈추는 방법은 비활성화이지 삭제가 아니다."

- 이 논거가 틀리는 경우가 있습니까? 예를 들어 잘못 만든 deployment 행을 지우려
  할 때 RESTRICT가 무엇을 막습니까?
- `AvailabilityObservation`은 append-only trigger가 걸려 있습니다. RESTRICT와
  그 trigger가 서로 모순되는 상황이 있습니까?
- `RoutingAttempt`는 `RoutingRun`에 Cascade로 달려 있고, `RoutingRun`은 `User`에
  Cascade입니다. 계정 삭제 → run 삭제 → attempt 삭제인데, attempt가 deployment를
  RESTRICT로 잡고 있으면 **계정 삭제가 막힙니까?** (RESTRICT는 참조되는 쪽을
  지울 때만 작동하므로 막지 않아야 하지만, 확인해 주십시오. 막힌다면 이것은
  blocker입니다 — 개인정보 삭제 경로입니다.)

### 3. 다시, 3치 논리

두 `*_deployment_has_endpoint_check`는 `IS NULL`/`IS NOT NULL`만 씁니다. 테스트가
그 constraint 본문에서 `NULL`을 낼 수 있는 연산자를 거절합니다.

- 이 테스트가 실제로 무엇이든 막습니까, 아니면 문자열 검사입니까?
- 이 migration의 다른 문장 중 `NULL`로 평가될 수 있는 것이 있습니까?

### 4. `check:dark-tables`의 두 수정

- 필드 정규식이 `Type?`를 읽지 못했습니다. 이것이 지난 라운드 minor 3에서
  지적된 것이고, 고치지 않았다면 이번 관계 필드가 목록에서 빠졌을 것입니다.
  지금 정규식이 놓치는 Prisma 필드 선언 형태가 더 있습니까?
- 첫 이름 `servingDeployment`가 `lib/feedbackAutoFixDeploymentObservation.ts`의
  함수와 충돌했습니다. 지금 이름 여섯 개(`probedEndpoint` 등)가 저장소 어디와도
  충돌하지 않습니까? 앞으로 충돌할 가능성이 있는 이름입니까?
- 관계 필드를 **dark가 아닌 host에서만** 모으는 규칙이 이번 변경으로
  깨집니까? `QuotaScope`의 `endpoint`·`deployment`가 계속 빠지는 것이 맞습니까?

### 5. 주장이 코드보다 큰 곳

이 작업에서 반복된 결함입니다. 특히:

- commit message가 "closes that in the schema and closes nothing else"라고
  적습니다. 이 커밋이 실제로 그 이상을 하는 부분이 있습니까?
- 테스트 이름 7개가 각각 테스트하는 것을 정확히 말합니까?
- migration 주석의 "prerequisite 2는 identity config writer 뒤에 있다"가
  설계 문서와 일치합니까?

## 판정 형식

`approve` / `approve_with_changes` / `reject`, 발견마다
`blocker` / `major` / `minor`. 사실 주장에는 **파일과 줄**을 대 주십시오.
2번 셋째 항목(계정 삭제가 막히는가)은 답이 "막힌다"면 blocker입니다.
