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

## 병합 전에 사람이 해야 할 확인

여기까지는 저장소 안에서 검증했지만, **production의 실제 스키마와는 대조하지
못했습니다.** 접근 권한이 있는 사람이 병합 전에 한 번 확인해 주십시오.

```bash
# 1. production의 schema-only dump를 받는다
pg_dump --schema-only --no-owner --no-privileges "$PRODUCTION_DIRECT_URL" > prod-schema.sql

# 2. baseline만으로 만든 빈 DB를 만든다
createdb baseline_check
DIRECT_DATABASE_URL=postgresql://.../baseline_check npm run db:migrate
pg_dump --schema-only --no-owner --no-privileges "postgresql://.../baseline_check" > baseline-schema.sql

# 3. 대조한다. 차이가 있다면 그것은 손으로 넣은 SQL이거나 schema.prisma에 없는 것이다
diff <(sort prod-schema.sql) <(sort baseline-schema.sql)
```

`migrate diff`는 CHECK 제약을 보지 못하므로 이 dump 대조가 유일한 확인 수단입니다.
차이가 나오면 baseline에 반영한 뒤 다시 대조합니다.

## 새 migration을 추가할 때

평소와 같습니다. baseline은 `00000000000000_`으로 시작해 항상 사전순 최초이므로
이후 migration은 자연스럽게 그 뒤에 옵니다.

`schema.prisma`를 바꾸고 migration을 쓰지 않으면 **DB 통합 테스트가 실패합니다** —
`npm run test:db:integration`이 migration으로 스키마를 만든 뒤 drift를 검사하기
때문입니다. 아직 migration을 쓰지 않은 상태로 로컬에서 돌려야 한다면
`DB_INTEGRATION_SCHEMA_SOURCE=push`를 쓸 수 있지만, 그 실행은 migration 이력을
검증하지 않습니다.

CHECK 제약을 추가한다면 새 migration에 직접 씁니다. `schema.prisma`에는 표현할
수 없고, `migrate diff`도 그 drift를 보지 못합니다. `tests/migrationBaseline.test.mjs`가
baseline의 10건이 사라지지 않았는지 지킵니다.

## 남은 작업

- **백업 복원 및 신규 환경 생성 drill.** baseline으로 빈 DB를 만드는 것은
  검증했지만, 실제 백업 복원과 신규 Railway 환경 생성은 해당 인프라에서 한 번
  실행해 봐야 합니다.
- **CI에서 빈 PostgreSQL로 `migrate deploy`를 돌리는 job.** DB 통합 워크플로가
  이제 그 경로를 쓰므로 사실상 확보돼 있지만, migration 전용 job으로 분리하면
  실패 원인이 더 분명해집니다.
