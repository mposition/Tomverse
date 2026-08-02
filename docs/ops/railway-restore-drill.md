# Railway 격리 복원 drill

production 백업을 **완전히 격리된** Railway 리소스에 복원해서, 복구가 실제로
가능한지와 RPO·RTO가 얼마인지를 측정하는 절차입니다.
`docs/ops/migration-baseline.md`의 "남은 작업" 중 **실제 인프라에서의 drill**이
이 문서입니다. 로컬 PostgreSQL 16에서는 이미 수행했고, 관리형 서비스 특유의
차이(확장, 역할, 연결 제한, private networking)는 아직 확인되지 않았습니다.

이 문서를 읽지 않고 리소스를 만들지 마세요. drill이 잘못되는 방식은 둘 다
조용합니다.

1. **복원 대상이 production이었다.** URL 하나를 복사했거나, 변수 하나가 비어
   있어 배포 자신의 값으로 떨어졌거나, `railway link`가 아직 다른 project를
   가리키고 있었던 경우입니다. 복구를 연습하려던 대상 위에 복원합니다.
2. **복원본이 바깥세상에 도달했다.** 진짜 계정·결제 이력·대화가 든 DB 위에서
   앱이 돌면, Stripe 호출은 진짜 customer id로 나가고, 비밀번호 재설정과
   영수증 메일은 진짜 수신함으로 가며, OAuth callback은 production client로
   가고, cron·provider usage sync·credit reconciliation·계정 삭제 maintenance가
   전부 진짜처럼 보이는 데이터 위에서 돕니다.

그래서 preflight의 모든 검사는 **없으면 실패**합니다. 값이 비어 있는 것은
기본값이 아니라 실패입니다. "production인지 아닌지 알 수 없다"와 "production
이다"는 같은 답을 받습니다.

## 이 저장소가 준비한 것

| 파일 | 무엇 |
|---|---|
| `scripts/railway-restore-preflight.mjs` (`npm run drill:railway-restore-preflight`) | 리소스를 만들기 전과 복원본을 켜기 전에 돌리는 fail-closed 검사 |
| `lib/railwayRestorePreflightCore.mjs` | 그 판정의 순수 함수. `tests/railwayRestorePreflightCore.test.mjs`가 전체 matrix를 검증 |
| `scripts/railway-restore-verify.mjs` (`npm run drill:railway-restore-verify`) | 복원 후 읽기 전용 검증. migration 상태, CHECK·partial index, row count, 집계 hash, RPO/RTO |
| `docs/ops/railway-restore-drill-report-template.md` | 결과 보고서 template |
| 이 문서의 F절 | cleanup checklist |

**아직 실행하지 않았습니다.** 이 작업에서는 Railway 리소스를 만들지 않았고,
백업을 복원하지 않았으며, production을 읽지도 쓰지도 않았습니다.

---

## A. 승인과 범위

리소스를 만들기 전에 아래를 사람이 정해 문서에 적습니다. 전부 preflight의
입력이며, 비어 있으면 preflight가 거부합니다.

| 항목 | 환경변수 | 비고 |
|---|---|---|
| drill owner | `DRILL_OWNER` | 끝나고 복사본을 파기할 책임자 |
| 승인 ticket | `DRILL_APPROVAL_TICKET` | 실제 고객 데이터를 새 장소로 복사하는 결정 |
| 사용할 backup | `DRILL_BACKUP_ID` | 어떤 백업을 복원했는지 이름을 댈 수 없는 drill은 복구를 증명하지 못합니다 |
| backup 시각 | `DRILL_BACKUP_TAKEN_AT` | RPO가 여기서 계산됩니다 |
| 목표 RPO / RTO | 보고서에 기재 | 측정 전에 목표를 적어야 결과가 판정이 됩니다 |
| 허용 비용 | 보고서에 기재 | Railway 사용량 상한과 예상 시간 |
| 유지 시간 | 보고서에 기재 | 이 시각 이후에는 파기 |
| 삭제 승인자 | 보고서에 기재 | F절의 파기를 승인하는 사람 |
| 사용할 source commit | 보고서에 기재 | migration 이력이 commit에 매여 있으므로 정확한 SHA |

**보안 승인이 별도로 필요합니다.** 복원본에는 실제 사용자 데이터가 들어 있고,
그 접근 범위와 보존 기간은 이 문서가 정할 수 있는 것이 아닙니다.

## B. 완전한 격리

- **production과 별도 Railway project**를 씁니다. 같은 project 안의 다른
  environment는 변수 상속과 private networking을 공유하므로 차선입니다.
  불가피하면 명확히 격리된 environment를 쓰되, 상속된 변수를 전부 확인합니다.
- **project · environment · service · database ID를 명시적으로 전달**합니다.
  `railway link`나 현재 디렉터리의 implicit context에 의존하지 않습니다. 그
  두 가지는 세션을 넘겨 살아남는 ambient state라서, `cd` 한 번이면 대상이
  바뀝니다.
- production DB의 **host·이름·연결 지문이 restore target과 다름**을 확인합니다.
  같은 서버의 다른 database는 격리가 아닙니다.
- **production `DATABASE_URL` / `DIRECT_DATABASE_URL`을 쓰지 않습니다.**
- **production private networking endpoint(`*.railway.internal`)를 쓰지
  않습니다.**
- **target database 이름에 `restore-drill`과 날짜를 넣습니다.** 예:
  `tomverse-restore-drill-2026-08-02`. 나중에 누가 우연히 발견해도 이것이
  무엇이고 버려도 되는 것인지 이름만으로 알 수 있어야 합니다.

preflight가 위를 전부 강제합니다.

```bash
DRILL_OWNER=... DRILL_APPROVAL_TICKET=... \
DRILL_BACKUP_ID=... DRILL_BACKUP_TAKEN_AT=... \
DRILL_CLEANUP_TARGETS=prj_...,svc_... \
DRILL_TARGET_PROJECT_ID=... DRILL_TARGET_ENVIRONMENT_ID=... DRILL_TARGET_SERVICE_ID=... \
DRILL_TARGET_DATABASE_URL=... \
PRODUCTION_PROJECT_ID=... PRODUCTION_ENVIRONMENT_ID=... PRODUCTION_SERVICE_ID=... \
PRODUCTION_DATABASE_URL=... PRODUCTION_DIRECT_DATABASE_URL=... \
STRIPE_MUTATIONS_DISABLED=1 EMAIL_DELIVERY_DISABLED=1 ADMIN_NOTIFICATIONS_DISABLED=1 \
OAUTH_PROVIDERS_DISABLED=1 SCHEDULED_JOBS_DISABLED=1 AI_PROVIDER_CALLS_DISABLED=1 \
ANALYTICS_DELIVERY_DISABLED=1 OBJECT_STORAGE_WRITES_DISABLED=1 \
npm run drill:railway-restore-preflight
```

connection string은 출력에 남지 않습니다. host와 database 이름만 evidence로
찍힙니다.

## C. 외부 부작용 차단

복원 환경에서 아래를 **전부** 비활성화하거나 sink로 교체합니다. preflight가
각각을 개별 변수로 요구하며, 하나라도 없으면 거부합니다.

| 변수 | 막는 것 |
|---|---|
| `STRIPE_MUTATIONS_DISABLED` | Stripe write와 webhook 처리 (진짜 customer id) |
| `EMAIL_DELIVERY_DISABLED` | 영수증·비밀번호 재설정·환영 메일 (진짜 수신함) |
| `ADMIN_NOTIFICATIONS_DISABLED` | Slack·관리자 알림 (production 채널) |
| `OAUTH_PROVIDERS_DISABLED` | production client로 가는 OAuth callback |
| `SCHEDULED_JOBS_DISABLED` | cron 전부 — maintenance cleanup, credit reconciliation, provider usage sync, 계정 삭제 |
| `AI_PROVIDER_CALLS_DISABLED` | 모든 AI provider 과금 호출 |
| `ANALYTICS_DELIVERY_DISABLED` | GA4·product analytics (production property) |
| `OBJECT_STORAGE_WRITES_DISABLED` | production attachment bucket write |

**production secret을 환경 전체로 복사하지 않습니다.** 필요한 변수만
allowlist로 하나씩 설정합니다. 전체 복사는 위 목록 전부를 다시 켜는 가장 빠른
방법입니다.

## D. 복원 검증

복원 후 아래를 순서대로 수행하고 결과를 보고서에 그대로 옮깁니다.

1. **preflight 재실행.** 변수는 그 사이에 바뀔 수 있습니다.
2. **backup checksum 또는 backup ID**를 기록합니다.
3. **restore 시작·종료 시각**을 기록합니다(`DRILL_RESTORE_STARTED_AT`,
   `DRILL_RESTORE_FINISHED_AT`).
4. **읽기 전용 검증**을 돌립니다.

   ```bash
   npm run drill:railway-restore-verify -- --json > artifacts/restore-drill-verify.json
   ```

   확인하는 것: migration 이력이 전부 적용됐고 실패 행이 없는지, 주요 테이블이
   존재하는지, CHECK 제약과 partial index가 살아 있는지, FK 수, 테이블별 row
   count, 주요 데이터의 집계 hash, 그리고 RPO·RTO.

   **row는 한 건도 읽지 않습니다.** count와 정렬된 id 목록의 md5만 봅니다 —
   행이 빠지거나 늘면 hash가 바뀌고, 누가 그 행인지는 나오지 않습니다.

5. **schema 대조.** `schema.prisma`가 표현하지 못하는 CHECK 제약과
   partial·expression index는 `prisma migrate diff`가 보지 못하므로 별도로
   돌립니다.

   ```bash
   COMPARE_SOURCE_DATABASE_URL="$DRILL_TARGET_DATABASE_URL" \
   COMPARE_SCRATCH_DATABASE_URL="postgresql://.../tomverse_compare_scratch" \
   npm run db:compare-schema
   ```

   `only_in_source` · `only_in_database` · `definition_mismatch` **세 분류를
   모두** 보고서에 적습니다.

6. **Prisma schema validation** — `npx prisma validate`.
7. **읽기 전용 application smoke test.** 로그인 화면, 공개 모델 카탈로그,
   `/api/ready`. 결제·메일·외부 호출이 실제로 차단됐는지 로그로 확인합니다.
8. **예상보다 누락된 데이터와 실패한 단계**를 그대로 적습니다. **여기서 고치지
   않습니다.** 발견한 것을 고치는 drill은 복구를 측정한 것이 아닙니다.

## E. 안전 검사 (preflight가 거부하는 조건)

| code | 조건 |
|---|---|
| `missing_approval_ticket` · `missing_drill_owner` | 승인 ticket 또는 owner 없음 |
| `missing_backup_id` · `missing_backup_timestamp` | backup ID 또는 시각 없음 |
| `missing_cleanup_targets` | 파기 대상이 명시되지 않음 |
| `missing_target_project_id` 외 | project·environment·service ID가 명시적으로 전달되지 않음 |
| `target_is_production_project` 외 | target ID가 production ID와 같음 |
| `target_url_is_production_url` | target URL이 production URL과 같음 |
| `target_host_is_production_host` | production DB host를 가리킴 |
| `target_uses_production_private_network` | `*.railway.internal` 등 production private network |
| `target_name_looks_like_production` | host나 DB 이름에 `prod`·`production`·`live`·`primary` 등이 있음 |
| `target_name_missing_drill_marker` · `target_name_missing_date` | DB 이름에 `restore-drill`이나 날짜가 없음 |
| `side_effect_not_disabled` | C절의 변수 중 하나라도 없거나 비활성값이 아님 |

## F. Cleanup checklist

- [ ] 결과 artifact를 보존합니다 — preflight `--json`, verify `--json`,
      `db:compare-schema` 출력, 보고서. **비밀정보를 제거한 뒤** 운영 티켓에
      첨부합니다.
- [ ] 임시 dump 파일과 로컬 사본을 안전하게 삭제합니다.
- [ ] drill용으로 발급한 secret과 토큰을 폐기합니다.
- [ ] **restore DB·서비스·environment 삭제는 별도의 명시적 승인 후**에
      실행합니다(A절의 삭제 승인자).
- [ ] 삭제 후 Railway에서 리소스가 **실제로 없어졌는지 read-back**으로
      확인합니다. 삭제 명령이 성공을 반환한 것과 리소스가 사라진 것은 다릅니다.
- [ ] 비용 종료 시각과 총 사용량을 기록합니다.
- [ ] **production에는 어떤 write도 없었다**는 사실을 확인하고 기록합니다 —
      배포 이력, DB write 지표, Stripe·메일·알림 로그.

## G. 실제 drill을 수행할 때 (Codex 등 자동화 포함)

승인과 Railway 접근 권한이 주어진 뒤에 지킬 것들입니다.

- Railway URL에서 **project·service·environment ID를 추출**하고, 이후에는
  **명시적 ID만** 사용합니다. 이름이나 현재 컨텍스트로 지칭하지 않습니다.
- 리소스를 변경하기 전에 **현재 대상이 무엇인지 다시 확인**합니다.
- 배포는 **terminal SUCCESS까지 확인**합니다.
- `FAILED` · `CRASHED` · `NEEDS_APPROVAL` 상태를 성공으로 보고하지 않습니다.
- **production 리소스는 삭제하지도 변경하지도 않습니다.** 이 drill에서
  production에 필요한 접근은 백업 목록을 읽는 것뿐입니다.
