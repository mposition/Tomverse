# Migration baseline

이 문서는 `prisma/migrations/00000000000000_baseline`이 왜 존재하는지, 배포·복구
때 무엇을 해야 하는지 적습니다. migration을 추가하거나 새 환경을 만들기 전에
읽습니다.

## 왜 baseline이 필요했는가

`prisma migrate deploy`로는 **빈 데이터베이스에서 이 스키마를 만들 수 없었습니다.**

- `20260704131220_init`이 만드는 테이블은 `Conversation`, `Message` 둘뿐입니다.
- 나머지 테이블은 migration 도입 이전에 `prisma db push`로 생겼고, migration
  이력에는 그 `CREATE TABLE`이 존재하지 않습니다.
- 그래서 빈 DB에서는 `20260709120000_align_model_defaults`가
  `relation "UserSettings" does not exist`로 실패합니다.

staging·production 배포가 통과한 것은 안전의 증거가 아니라 **이미 테이블이
있었기 때문**입니다. 그 상태로는 다음이 전부 불가능했습니다.

- 신규 staging/production 환경 생성
- 백업 복원 후 schema rebuild
- 지역 이전
- CI용 빈 PostgreSQL 생성
- 신규 개발자의 로컬 환경 구성

## baseline은 무엇으로 만들어졌는가

기존 78개 migration은 `prisma/migrations-archive/`로 옮겼습니다. Prisma는
`prisma.config.ts`의 `migrations.path`만 읽으므로 archive는 배포에 영향을 주지
않습니다. 기록으로 남기는 이유는 CHECK 제약이 거기에서 복원됐기 때문입니다.

baseline은 두 부분입니다.

1. **구조** — `prisma migrate diff --from-empty --to-schema prisma/schema.prisma
   --script`. 테이블·컬럼·기본값·인덱스·외래키에 대해 권위가 있고, 적용 후
   `migrate diff --from-schema ... --exit-code`가 0이면 검증됩니다.
2. **CHECK 제약 10개** — `schema.prisma`가 표현하지 못해 generator가 아예
   생략합니다. archive의 ADD/DROP 순서를 재생해 최종 집합을 복원했고,
   **원본 파일에서 만든 DB의 `pg_get_constraintdef()` 출력과 10건 모두
   일치함을 대조로 확인**했습니다.

데이터는 옮기지 않았습니다. archive에는 컬럼 backfill, `BillingPromotion` 2건
seed, `AdminAuditLog` 1건이 있지만 — backfill은 빈 DB에서 대상이 없고, 요금제
기본값은 `syncBillingDefaultsToDatabase()`가 코드에서 seed하며, 프로모션 코드나
과거 보안 발견 기록은 새 환경이 스스로 만들어낼 것이 아닙니다.

## 기존 데이터베이스는 어떻게 되는가

**자동으로 처리됩니다.** `npm run db:migrate`가 `prisma migrate deploy` 앞에
`scripts/baseline-existing-database.mjs`를 실행합니다.

baseline 이전에 만들어진 DB는 테이블은 다 있지만 `_prisma_migrations`에 baseline
행이 없습니다. 그대로 배포하면 `migrate deploy`가 baseline을 적용하려다
`relation "User" already exists` (P3018)로 실패하고, **실패 행이 남아 이후 배포도
전부 막힙니다.** 이 상황은 실제로 재현해서 확인했습니다.

guard의 판단 규칙:

| DB 상태 | 동작 |
|---|---|
| `_prisma_migrations` 없음 | 신규 DB. 아무것도 하지 않음 (deploy가 baseline 적용) |
| 완료된 migration이 0건 | 신규 DB로 간주. 아무것도 하지 않음 |
| baseline이 완료로 기록됨 | 아무것도 하지 않음 |
| `User` 테이블 없음 | 판단 거부하고 실패 — 사람이 확인해야 하는 상태 |
| 그 외 (완료 이력 있음 + baseline 없음 + 스키마 있음) | `migrate resolve --applied` |

마지막 규칙은 **이미 한 번 배포가 실패한 DB도 복구합니다** (실패 행은 완료 행이
아니므로 같은 경로로 처리). `migrate resolve --applied`는 `_prisma_migrations`에
행 하나를 쓸 뿐 DDL을 실행하지 않으므로 스키마를 손상시킬 수 없습니다.

## production 스키마와 대조하기

`npm run db:compare-schema` 한 줄입니다. 대상 DB는 **읽기만** 합니다.

```bash
COMPARE_SOURCE_DATABASE_URL="$PRODUCTION_DIRECT_URL" \
COMPARE_SCRATCH_DATABASE_URL="postgresql://.../tomverse_compare_scratch" \
npm run db:compare-schema
```

scratch DB는 비어 있어야 하고 이름에 `test`·`scratch`·`tmp`·`ci`·`compare` 중
하나가 들어가야 합니다. 소스와 같으면 실행을 거부합니다.

무엇이 다른지는 `pg_dump` 텍스트 비교가 아니라 **카탈로그에서 직접** 읽습니다 —
컬럼, 인덱스(`pg_indexes.indexdef`), 제약(`pg_get_constraintdef`), enum, 함수,
트리거. 서버가 정규화한 문자열이라 서버 버전이나 문장 순서 차이에 흔들리지
않습니다. 차이가 있으면 exit 1이라 릴리스 게이트로 쓸 수 있습니다.

**왜 `prisma migrate diff`로는 안 되는가.** 실제로 확인했습니다. 손으로 CHECK
제약과 partial unique index를 하나씩 넣은 DB에 대해:

| 도구 | 결과 |
|---|---|
| `prisma migrate diff --exit-code` | `No difference detected.` (exit 0) — **둘 다 놓침** |
| `npm run db:compare-schema` | 둘 다 이름과 정의까지 보고, exit 1 |

`schema.prisma`가 표현하지 못하는 것은 `migrate diff`도 보지 못합니다. 그것이
이 스크립트가 존재하는 이유입니다.

> **아직 production 대조는 실행되지 않았습니다.** 이 저장소 안에서는 접속 정보를
> 얻을 수 없습니다(Railway MCP는 변수 이름만 반환합니다). 권한이 있는 분이 위
> 명령을 한 번 실행해 주십시오. `only in the source`로 나오는 항목은 migration
> 이력에 없는 SQL이며, **새로 만드는 모든 환경에 빠져 있게 됩니다.**

## 새 migration을 추가할 때

평소와 같습니다. baseline은 `00000000000000_`으로 시작해 항상 사전순 최초이므로
이후 migration은 자연스럽게 그 뒤에 옵니다.

`schema.prisma`를 바꾸고 migration을 쓰지 않으면 **DB 통합 테스트가 실패합니다** —
`npm run test:db:integration`이 migration으로 스키마를 만든 뒤 drift를 검사하기
때문입니다. 아직 migration을 쓰지 않은 상태로 로컬에서 돌려야 한다면
`DB_INTEGRATION_SCHEMA_SOURCE=push`를 쓸 수 있지만, 그 실행은 migration 이력을
검증하지 않습니다.

## `schema.prisma`가 표현하지 못하는 것

두 종류가 있고 **둘 다 `migrate diff`가 drift로 보지 못합니다.** 새로 추가할 때는
migration에 직접 씁니다.

1. **CHECK 제약** — 현재 10건이 baseline에 있습니다.
2. **partial·expression index** — 예: `PlanChangeRequest_userId_active_key`
   (`UNIQUE (userId) WHERE status = 'pending'`). 동시에 들어온 두 플랜 변경
   확정이 둘 다 예약되는 것을 막는 유일한 장치입니다.

두 번째는 실제로 사고가 났습니다. `test:db:integration`이 `db push`로 스키마를
만들던 시절, 이 인덱스는 생성되지 않았고 **그것을 검증하는 테스트가 develop에서
실패**했습니다. `db push`는 `schema.prisma`만 읽기 때문입니다. 지금은 migration으로
만들므로 통과합니다.

`tests/migrationBaseline.test.mjs`가 baseline의 CHECK 10건이 사라지지 않았는지,
그리고 통합 테스트가 계속 migration으로 스키마를 만드는지 지킵니다. 후자를
`push`로 되돌리면 partial index와 CHECK 제약이 조용히 전부 사라집니다.

## 복원·신규 환경 drill (수행 완료)

로컬 PostgreSQL 16에서 실제로 수행한 결과입니다. guard의 결함 두 가지가 여기서
드러났고, 고친 뒤 다시 돌렸습니다.

| 상황 | 기대 | 결과 |
|---|---|---|
| 빈 DB에 `npm run db:migrate` | baseline 포함 전체 적용 | 54 테이블, CHECK 10건, drift 0 |
| 현재 백업을 새 DB에 복원 후 배포 | 아무것도 적용하지 않음 | `No pending migrations to apply` |
| 복원된 DB를 migration 산출물과 대조 | 완전 일치 | 컬럼 770 · 인덱스 222 · 제약 93 전부 동일 |
| baseline 이전 production 형태 (스키마 구버전 + 78건 기록) | baseline 기록 후 나머지 적용 | 3건 정상 적용 |
| 스키마는 최신인데 이력이 구버전인 복원 | **거부**, DB 무변경 | 거부됨, 실패 행 0건 |

drill이 찾아낸 것:

1. **`db push`로 만든 DB를 "신규"로 오판했습니다.** guard가 이력을 먼저 읽어
   "완료된 migration 0건 → 신규"로 판단했는데, `db push` DB는 스키마가 완전하고
   이력이 비어 있습니다. 그대로 배포하면 `relation "User" already exists`로
   실패하고 실패 행이 남습니다. 이제 **이력이 아니라 스키마로 판단**합니다.
2. **스키마는 최신인데 이력이 구버전인 복원**에서 `migrate deploy`가 이미 있는
   컬럼을 다시 추가하려다 P3018로 죽고, 역시 실패 행을 남겼습니다. 이 상태는
   pending migration이 정말 필요한 것인지 이미 반영된 것인지 알 수 없으므로
   **추측하지 않고 거부**하며, 해결 명령을 함께 출력합니다. 거부는 DB를 건드리지
   않지만 진행은 건드립니다.

## 남은 작업

- **production 스키마 대조 실행.** 도구는 준비됐고 위 명령 한 줄이지만, 이
  저장소에서는 접속 정보를 얻을 수 없어 아직 실행되지 않았습니다.
- **실제 인프라에서의 drill.** 위 표는 로컬 PostgreSQL 16 기준입니다. Railway
  백업 복원과 신규 환경 생성은 해당 인프라에서 한 번 밟아봐야 관리형 서비스
  특유의 차이(확장, 역할, 연결 제한)까지 확인됩니다.
- **CI에서 빈 PostgreSQL로 `migrate deploy`를 돌리는 job.** DB 통합 워크플로가
  이제 그 경로를 쓰므로 사실상 확보돼 있지만, migration 전용 job으로 분리하면
  실패 원인이 더 분명해집니다. `db:compare-schema`를 릴리스 게이트로 붙이는 것도
  같은 자리에서 하면 좋습니다.
