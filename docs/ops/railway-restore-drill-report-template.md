# Railway 복원 drill 결과 보고서 — <YYYY-MM-DD>

> `docs/ops/railway-restore-drill.md`의 절차를 수행한 결과를 적습니다.
> 완료 후 `.github/audits/railway-restore-drill-<YYYY-MM-DD>.md`로 저장합니다.
> **비밀정보(연결 문자열, 토큰, 개인정보)는 넣지 않습니다.** host와 database
> 이름, ID, 집계 수치만 적습니다.

## 1. 승인과 범위

| 항목 | 값 |
|---|---|
| drill owner | |
| 승인 ticket | |
| 보안 승인 (실제 사용자 데이터 사용) | |
| 사용한 backup ID | |
| backup 시각 (UTC) | |
| 목표 RPO / RTO | |
| 허용 비용 | |
| 유지 시간 (파기 예정 시각) | |
| 삭제 승인자 | |
| source commit SHA | |

## 2. 격리

| 항목 | production | restore target |
|---|---|---|
| project ID | | |
| environment ID | | |
| service ID | | |
| DB host | | |
| DB 이름 | | |

- [ ] 별도 project를 사용했습니다 (아니라면 사유와 확인한 상속 변수 목록:)
- [ ] 모든 ID를 명시적으로 전달했고 `railway link`·현재 디렉터리에 의존하지
      않았습니다
- [ ] production `DATABASE_URL` / `DIRECT_DATABASE_URL`을 쓰지 않았습니다
- [ ] production private networking endpoint를 쓰지 않았습니다
- [ ] target DB 이름에 `restore-drill`과 날짜가 들어 있습니다

preflight 결과: `PASS` / `FAIL` — artifact:

## 3. 외부 부작용 차단

| 변수 | 설정값 | 로그로 확인 |
|---|---|---|
| `STRIPE_MUTATIONS_DISABLED` | | |
| `EMAIL_DELIVERY_DISABLED` | | |
| `ADMIN_NOTIFICATIONS_DISABLED` | | |
| `OAUTH_PROVIDERS_DISABLED` | | |
| `SCHEDULED_JOBS_DISABLED` | | |
| `AI_PROVIDER_CALLS_DISABLED` | | |
| `ANALYTICS_DELIVERY_DISABLED` | | |
| `OBJECT_STORAGE_WRITES_DISABLED` | | |

- [ ] production secret을 환경 전체로 복사하지 않고 allowlist 변수만
      설정했습니다

## 4. 복원과 검증

| 항목 | 값 |
|---|---|
| backup checksum 또는 ID | |
| restore 시작 (UTC) | |
| restore 종료 (UTC) | |
| **RPO (분)** | |
| **RTO (분)** | |
| 목표 대비 | |

### 4.1 스키마

| 항목 | 결과 |
|---|---|
| migration 적용 수 / 미완료 / 롤백 | |
| 테이블 수 | |
| CHECK 제약 수 | |
| partial index 수 | |
| foreign key 수 | |
| Prisma schema validation | |

`npm run db:compare-schema` — **세 분류를 모두** 적습니다.

| 분류 | 건수 | 내용 |
|---|---|---|
| `only_in_source` | | |
| `only_in_database` | | |
| `definition_mismatch` | | |

### 4.2 데이터

row count는 **count만** 적습니다. 행 내용은 넣지 않습니다.

| 테이블 | production 기준(있으면) | 복원본 | 차이 | 집계 hash (앞 12자) |
|---|---|---|---|---|
| User | | | | |
| Conversation | | | | |
| Message | | | | |
| CreditLedgerEntry | | | | |
| ChatCreditReservation | | | | |
| ModelRegistryEntry | | | | |

### 4.3 읽기 전용 smoke test

| 항목 | 결과 |
|---|---|
| 로그인 화면 렌더 | |
| 공개 모델 카탈로그 | |
| `/api/ready` | |
| 결제 호출이 차단됐는지 (로그) | |
| 메일 발송이 차단됐는지 (로그) | |
| 외부 알림이 차단됐는지 (로그) | |
| AI provider 호출이 차단됐는지 (로그) | |

### 4.4 예상보다 누락된 데이터 · 실패한 단계

> 발견한 것을 **고치지 말고** 그대로 적습니다. 고친 drill은 복구를 측정한 것이
> 아닙니다.

-

## 5. Cleanup

- [ ] 결과 artifact 보존 (비밀정보 제거 후 티켓 첨부):
- [ ] 임시 dump·로컬 사본 안전 삭제
- [ ] drill용 secret·토큰 폐기
- [ ] 삭제 승인자 확인:
- [ ] restore DB·서비스·environment 삭제 실행 시각:
- [ ] 삭제 후 Railway read-back으로 부재 확인:
- [ ] 비용 종료 시각과 총 사용량:
- [ ] **production에 어떤 write도 없었음** 확인 근거 (배포 이력 / DB write 지표
      / Stripe·메일·알림 로그):

## 6. 결론과 후속 조치

- 복구 가능 여부:
- 관리형 서비스 특유의 차이(확장, 역할, 연결 제한, private networking)에서
  발견한 것:
- runbook에 반영할 수정:
- 다음 drill 시점:
