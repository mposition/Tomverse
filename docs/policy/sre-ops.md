# 운영·SRE 모니터링 Agent 정책

상태: **승인됨(버전 3).** 최초 작성 2026-10-03, 버전 1 승인 2026-10-03, 버전 2 승인 2026-10-07, 버전 3 승인 2026-10-07.
approvedBy: mposition · approvedAt: 2026-10-07 · 정책 버전: 3
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| (미부여) | (미승인) | 최초 초안. 비공개 설계서(revision 18, 교차 vendor 독립 검토 `accept`)의 공개 가능한 계약만 옮김 |
| (미부여) | (미승인) | 두 번째 초안 — 독립 검토 반영: 트랜잭션 상한 표와 버전별 무장 규칙, 늦은 advance와 재시작, 판정 가능한 단계 전환 조건, readiness 검사 이름, 상한 최대값의 유도, 서비스별 금지 변수 |
| (미부여) | (미승인) | 세 번째 초안 — 독립 검토 반영: cron이 곧바로 `stuck`이어도 열림, 신규 열림의 날짜당 1회 강제, `abandoned` 뒤 heartbeat 보류, readiness 검사 17개 전부, 마감 판정의 시계, 무력화의 근거와 시험, 전환 조건의 근거 기록, 금지 변수 보강 |
| (미부여) | (미승인) | 네 번째 초안 — 독립 검토 반영: 악화도 키당 날짜당 1회만 상한 밖, 환경변수는 allowlist로 판정, statement timer가 문장마다 다시 판정됨과 그 시험, `timestamptz` 비교, S3 조건을 커밋된 기록으로 |
| (미부여) | (미승인) | 다섯 번째 초안 — 독립 검토 반영: 닫힌 runtime 이름 목록과 실행 서비스가 혼자 판정하는 모양 규칙, 악화 규칙 하나로 정리, idle timer 시험 |
| 1 | 2026-10-03 mposition | 최초 승인(여섯 번째 초안). 여섯 번째 초안 — 독립 검토 반영: 17 단언 개수 표기, 모양 규칙에 `DIRECT_URL` |
| 2 | 2026-10-07 mposition | 9절 결정 T-1: 소유자 시간대 `Australia/Brisbane`. 실행 비용 상한은 미정으로 남음 |
| 3 | 2026-10-07 mposition | 9절 결정 C-1: 실행 비용 상한 월 USD 20(두 실행 서비스의 Railway 사용량), 초과는 cadence 완화 |

운영자 `mposition`이 2026-10-03 대화 세션에서 이 문서를 승인했고(버전 1), 2026-10-07 대화 세션에서 9절 결정 T-1을
승인했으며(버전 2), 같은 날 이어진 대화 세션에서 9절 결정 C-1을 승인했다(버전 3). **아래 승인 판정이 통과하기 전에는(이 승인 기록이
`develop`에 병합되기 전을 포함해) S0b의 어떤 코드도 작성·병합하지 않는다.**

이 문서는 Claude가 설계하고 교차 vendor 독립 검토를 받은 비공개 설계서를 공개 계약으로 옮긴 것입니다. 내용 변경은 운영자
승인과 정책 버전 증가가 필요합니다. 승인은 단계별 착수 조건(8절)을 없애지 않으며, 어떤 Railway 서비스·secret·webhook·
dead-man monitor·스위치·migration 변경도 그 자체로 허가하지 않습니다.

승인은 아래 단계를 **모두** 통과해야 인정합니다. S0b 착수 전에 판정하고, 결과는 그 착수 PR 본문에 적습니다. 판정은
git·GitHub 기록만으로 재현할 수 있어야 하며, script로 자동화해도 게이트가 아니라 보고입니다.

| # | 판정 |
|---|---|
| 0 | `approvedBy`의 계정이, 이 정책 파일을 바꾼 PR의 **base에 있던** `docs/policy/agent-operator-allowlist.md` 목록에 있다. 그 목록 파일의 최초 commit이 위 `allowlistGenesisCommit`과 같고, 그 commit부터 base까지 그 목록 파일의 모든 변경이 그 파일 3절의 규칙을 따랐다 |
| 0a | 이 정책 파일의 `approvedBy`·`approvedAt`·정책 버전이 채워져 있고, 정책 버전이 직전 승인 버전보다 크다 |
| 1 | 이 정책 파일을 마지막으로 바꾼 commit을 찾는다 |
| 2 | 그 commit을 `develop`에 넣은 PR이 **정확히 하나**다 |
| 3 | 그 PR의 브랜치 이름에 `to-develop` 경로 조각이 없다 |
| 4 | 그 PR의 병합자가 `approvedBy`와 같은 계정이다. 병합자가 사람인지는 기록만으로 가릴 수 없으므로, 운영자가 대화에서 승인한 날짜와 정책 버전을 그 PR 본문에 적고 운영자가 직접 병합한다 |
| 5 | `approvedAt`이 그 병합의 UTC 날짜와 같다 |
| 6 | 그 PR이 이 정책 파일 하나만 바꾸고, 모든 commit의 작성자가 `approvedBy`이며 bot이 아니다 |
| 7 | 그 뒤 이 정책 파일이 다시 바뀌면 1번부터 다시 판정한다 |

## 1. 무엇을 하는가

production이 조용히 망가지고 있는지 감시하고, **급한 것은 소유자를 깨우고(page) 나머지는 하루 한 번 모아(digest)**
보여 줍니다. 고치지 않고 알리기만 합니다.

1. **page.** 10분마다 production의 상태를 집계해, 틀렸을 때 소유자가 일어날 때까지 기다리면 되돌릴 수 없는 피해가 쌓이거나
   기존 경보 경로가 구조적으로 침묵하는 신호만 page합니다. S2의 page 키는 아래 8개이고, S3 키는 8절에 있습니다.

   | 신호 | 키 | 열림 조건 | 악화 구간 |
   |---|---|---|---|
   | readiness 핵심 | `database`, `securityEnvironment` | 해당 검사가 연속 3회 false | 없음 |
   | readiness 채팅 예산 구성 | `providerBudgets` | 연속 3회 false | 없음 |
   | readiness 이메일 유실 | `emailSnapshotKeyring`, `emailSendingIdentity` | 연속 3회 false | 없음 |
   | readiness 판정 불가 | 단일 | `/api/health`는 응답하는데 상태 집계가 연속 3회 실패 | 없음 |
   | 15분 cron 침묵 | 단일 | `credit_reservation_reconciliation`이 `delayed` 또는 `stuck`(처음 관측한 구간이 `stuck`이면 그 구간으로 열림) | `delayed` → `stuck` |
   | 이메일 drain 실패 | 단일 | `standard_email_drain`의 연속 실패 구간 3+ | 없음 |

   회복은 조건이 연속 2회 해소된 것입니다.
2. **침묵 감시.** 감시자 자신이 멈추거나 앱·DB가 통째로 응답하지 않으면, 감시자와 독립된 외부 dead-man 서비스가 heartbeat
   공백으로 알립니다(P8). 탐지 지연은 마지막 성공 heartbeat부터 허용치(30분)입니다(결정 D2).
3. **digest.** 하루 한 번, 항목 20개 상한의 폐쇄 schema 요약을 본 앱에 제출합니다. 소유자는 Admin Console에서 읽습니다.
   `/api/ready`가 계산하는 검사 중 page 키가 아닌 것은 **ready 판정에 들어가는지와 무관하게** 모두 digest입니다. 오늘은 17개 중
   `imageProviderBudget`, `voiceProviderBudget`, `voiceModelPrice`, `searchProviderBudget`, `emailUnsubscribeKeyring`,
   `emailUnsubscribeKeyRetention`, `emailConsentKeyring`, `emailBusinessIdentity`, `emailSubjectLabels`,
   `emailFooterDisclosures`, `amuxReviewApproval`, `emailBiennialConsentNotice`(ready 판정에 들어가지 않음)의 12개이며, 뒤에
   더해지는 검사도 같은 규칙을 따릅니다. 상태 집계는 검사 이름 목록을 코드가 아니라 readiness 계산에서 얻고, 모르는 검사가
   있으면 digest에 그 이름을 적습니다.
4. **주간 page 채널 점검.** S2부터 주 1회 낮 시간 창에 고정 점검 문장을 page 채널로 보냅니다. 소유자가 휴대폰 푸시로
   받았을 때만 별도 check-in URL을 엽니다(5절).

**LLM을 쓰지 않습니다.** 모든 판정은 결정적 코드입니다. 로그·오류 문자열·사용자 텍스트는 판정의 입력도 알림 내용도
아닙니다.

## 2. 하지 않는 것

- 자동 복구: production 재시작·재배포, 환경변수, provider 예산, feature flag, kill switch, incident 등록.
- 기존 maintenance cron의 수동 실행. 그 secret은 삭제를 수행하는 cleanup도 인증합니다.
- 코드 수정. 원인이 코드면 엔지니어링 Agent나 소유자에게 넘깁니다.
- 기존 `reportOperationalIncident` 경로의 동작 변경. 개선안은 digest의 고정 한 줄로만 알립니다.
- 가격·크레딧·예산 **값**의 판단, release gate registry 쓰기, `AdminAuditLog`에 대한 사람 명의 쓰기.
- 배포 drift 알림. 기존 drift notifier가 소유합니다.
- GitHub 쓰기 전부(issue·label·댓글·PR·branch·artifact·commit status·check). GitHub 토큰을 갖지 않습니다.
- 공개 `/api/ready`의 외부 polling.

## 3. 절대 조건

1. **알림은 고정 문장과 Admin 링크 하나뿐입니다.** 신호 이름·키·구간·시각·개수·commit SHA·URL 매개변수를 싣지 않습니다.
   링크는 코드에 고정된 production origin, 고정 경로, 서버가 발급한 item id(UUID 정규형)로만 만들고, 그 밖의 문자가 있으면
   전송 전 내용 검사가 막습니다. 채널 점검 문장에는 링크도 없습니다.
2. **새 문장은 재승인입니다.** 자율 전송은 4절의 문장 안에서만 허용되고, 문장을 바꾸거나 더하는 것은 정책 버전 증가입니다.
3. **상한은 전송이 아니라 예약에서 DB가 셉니다.** 본 앱이 예약을 commit한 요청에만 전송 허가가 나고, 예약당 전송은 최대
   한 번이며 재시도하지 않습니다. 결과를 모르는 예약은 다음 실행이 `abandoned`로 닫고 다시 보내지 않습니다.
4. **실행 서비스는 제품 DB 자격증명을 갖지 않습니다.** 상태는 본 앱 내부 route로만 읽고 쓰며, 감시 테이블과 이 Agent의 digest
   테이블에 쓰는 것은 본 앱의 store 모듈 하나뿐입니다.
5. **허용되지 않은 변수가 있으면 시작하지 않습니다.** 서비스 진입점은 환경의 이름을 두 번 검사하고, 어느 하나라도 걸리면 자식
   프로세스를 띄우기 전에 구성 오류로 멈춥니다. 두 검사 모두 실행 서비스가 자기 환경만 보고 판정합니다.
   - **(a) allowlist.** 모든 이름이 아래 셋 중 하나여야 합니다. 그 밖의 이름이 **하나라도** 있으면 거절합니다.
     1. 7절의 자기 서비스 변수.
     2. base image·Node의 이름: `PATH`, `HOME`, `HOSTNAME`, `PWD`, `SHLVL`, `TERM`, `LANG`, `NODE_VERSION`,
        `YARN_VERSION`, `NODE_ENV`, `PORT`.
     3. Railway가 넣는 비밀 아닌 이름: `RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_ENVIRONMENT_NAME`,
        `RAILWAY_PROJECT_ID`, `RAILWAY_PROJECT_NAME`, `RAILWAY_SERVICE_ID`, `RAILWAY_SERVICE_NAME`, `RAILWAY_DEPLOYMENT_ID`,
        `RAILWAY_REPLICA_ID`, `RAILWAY_REPLICA_REGION`, `RAILWAY_SNAPSHOT_ID`, `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_PRIVATE_DOMAIN`,
        `RAILWAY_STATIC_URL`, `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_GIT_AUTHOR`, `RAILWAY_GIT_BRANCH`, `RAILWAY_GIT_REPO_NAME`,
        `RAILWAY_GIT_REPO_OWNER`, `RAILWAY_GIT_COMMIT_MESSAGE`.

     이 목록은 코드 상수이고, 테스트가 이 절과 같음을 고정합니다. Railway가 목록에 없는 이름을 넣어 서비스가 멈추면 그 이름을
     더하는 것은 정책 버전 증가이고, (b)에 걸리는 이름은 더할 수 없습니다.
   - **(b) 모양 규칙.** 자기 서비스 변수(7절)를 **제외한** 모든 이름 중 아래에 걸리는 것이 있으면 거절합니다. (a)에 실수로 들어간
     자격증명도 이 검사가 막습니다.
     - 대소문자를 무시하고 `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `API_KEY`, `ACCESS_KEY`, `PRIVATE_KEY`,
       `ENCRYPTION_KEY`, `SIGNING_KEY`, `CREDENTIAL`, `DATABASE_URL`, `DIRECT_URL`, `DSN`을 포함하는 이름
     - `POSTGRES`·`PG`·`PRISMA_`·`GH_`·`ADMIN_AUDIT_INTEGRITY_`로 시작하는 이름
     - 상대 서비스의 변수 이름. page 서비스에서는 `OPS_OBSERVER_DIGEST_SECRET`, `OPS_OBSERVER_DIGEST_WEBHOOK_URL`,
       `OPS_OBSERVER_DIGEST_HEARTBEAT_URL`이고, digest 서비스에서는 `OPS_OBSERVER_SECRET`, `OPS_OBSERVER_PAGE_WEBHOOK_URL`,
       `OPS_OBSERVER_HEARTBEAT_URL`입니다.
   - 자식은 자기 서비스 변수 중 필요한 것만 받습니다.
6. **빌드 단계에는 runtime 비밀값이 없습니다.** 전용 Dockerfile은 `ARG`를 선언하지 않는 단일 stage이고, 첫 실행 명령이 빌드 환경
   검사입니다.
7. **결과를 모르면 멈춥니다.** 본 앱 요청은 재시도하지 않고, 상태를 신뢰할 수 없으면 아무것도 보내지 않고 heartbeat도
   보내지 않습니다. 그 침묵은 P8이 알립니다.
8. **늦은 실행은 성공으로 기록되지 않습니다.** 6절의 규칙이 이것을 DB로 강제합니다.
9. **재시작과 겹침이 두 번째 전송을 만들지 않습니다.** 두 서비스는 `restartPolicyType: NEVER`이고, Railway cron은 이전 회차가
   끝나지 않으면 다음 회차를 건너뜁니다. 그래도 수동 실행·재배포로 두 advance가 겹치면, advance는 읽은 generation에 대한 조건부
   갱신이라 같은 generation에서 하나만 commit합니다. 전송 허가는 예약 행을 실제로 넣은 요청의 **응답**으로만 전달되므로,
   응답을 받지 못하고 끝난 호출자의 예약은 아무도 보내지 않고 다음 실행이 `abandoned`로 닫습니다. 그 사건의 종류 슬롯은
   소진되지만 page가 조용히 빠지지 않습니다 — `abandoned`를 쓴 advance가 같은 트랜잭션에서 DB 시계로 계산한 40분(dead-man 허용치
   30분 + 주기 10분) 동안 heartbeat를 보류시키므로 P8이 반드시 한 번 울리고, `abandoned` 예약은 digest와 Admin 영역에 남습니다.
10. **감시 상태 전이는 같은 트랜잭션에서 기존 해시 체인 감사에 시스템 actor로 남습니다.** 감사 테이블에 직접 쓰지 않고
    `lib/adminAudit.ts`의 append 경로를 지납니다.
11. **Agent는 자기 gate를 고치지 않습니다.** 이 정책, 판정 상수, workflow, 권한 목록의 변경은 사람이 합니다.

## 4. 고정 문장

| 용도 | 문장 | 링크 |
|---|---|---|
| page | `Tomverse 운영 감시: 확인이 필요한 장애 신호가 있습니다.` | Admin 항목 링크 하나 |
| digest 알림 | `Tomverse 운영 감시: 오늘의 운영 요약이 준비됐습니다.` | Admin 항목 링크 하나 |
| 채널 점검 | `Tomverse 주간 page 채널 점검: 휴대폰 푸시로 받았다면 점검 check-in을 여세요.` | 없음 |

page와 채널 점검이 같은 실행에서 생기면 page 문장·링크 뒤에 점검 문장을 붙여 한 메시지로 보냅니다.

## 5. 알림 상한

- 실행당 page 메시지 최대 1개. 주기적 재알림 없음.
- 메시지 종류는 넷입니다. 사건마다 각 종류는 1회입니다.
  - **신규 열림:** 키가 열림. 회복 뒤 24시간 안에 다시 열리면 재열림입니다.
  - **악화:** 열린 키의 구간이 나빠짐. S2에서는 cron 침묵 키 하나만 악화 구간을 가집니다.
  - **재열림**
  - **회복**
- 신규 열림은 키당 소유자 날짜당 1회입니다. 같은 날짜의 두 번째 열림은 경과 시간과 무관하게 재열림으로 셉니다(일광절약시간이
  끝나 25시간인 날에도 성립하도록 시간이 아니라 날짜로 셉니다).
- 악화는 사건의 시작이 신규 열림이든 재열림이든, 전날부터 이어진 것이든 상관없이 **키당 소유자 날짜당 첫 1회만** 하루 상한
  밖입니다. 같은 키의 같은 날짜 두 번째 이후 악화는 아래 상한에 들어갑니다.
- 하루 상한 6개에 들어가는 것은 재열림, 회복, 그리고 키당 날짜당 두 번째 이후의 악화입니다. **신규 열림과 키당 날짜당 첫
  악화는 이 상한으로 막지 않습니다.**
- **하루 최대값의 유도(S2):** 키는 8개입니다.
  - 신규 열림은 키당 소유자 날짜당 1회이므로 최대 8입니다.
  - 상한 밖 악화는 키당 날짜당 1회이고 악화 구간을 가진 키가 하나뿐이라 최대 1입니다. cron 침묵의 `delayed` → `stuck`은 그 job의
    침묵 예산과 회복 규칙 때문에 드물게만 일어나지만, 상한은 일어난다고 가정하고 셉니다.
  - 나머지 종류는 합쳐서 6입니다.
  - 그러므로 하루 15이고, 채널 점검 요일에는 점검 1이 더해져 16입니다. 점검이 다른 page와 한 메시지로 묶이면 더해지는 것은 0입니다.
- **genesis한 날의 최대값:** genesis는 키 상태와 genesis별 카운트를 새로 시작하므로 그날은 15가 한 번 더 가능해 최대 31입니다.
  직전 genesis 뒤 7일 안의 genesis는 전송 대신 침묵을 만들므로, 한 달력일에 전송이 가능한 genesis는 최대 하나입니다(결정 D5b).
  S2 시작일은 activation genesis 날이므로 그날 최대 31입니다.
- 본 앱 store가 예약 트랜잭션 안에서 사건·종류 unique와 날짜별 개수를 다시 세고, 넘으면 advance 전체를 거절합니다.
  S3에서 키가 늘면 최대값을 다시 계산해 정책 버전을 올립니다.
- 채널 점검은 소유자 날짜당 1회. check-in monitor는 주기 7일 + 유예 2일이며, 채널이 죽은 뒤 최대 9일 안에 탐지합니다.
- dead-man monitor 셋(page heartbeat, digest heartbeat, 점검 check-in)의 알림 대상은 **page 채널이 아닌 경로**여야 합니다.

## 6. 트랜잭션 시간 상한

감시 store의 모든 트랜잭션은 하나의 wrapper를 지나고, 그 첫 문장은 migration이 만든 무장 함수 호출 하나입니다. 함수는
`SET` 절이 없고 `SECURITY INVOKER`이며 `EXCEPTION` 절이 없습니다.

**종류별 상수(결정 N-2).** A는 트랜잭션 안의 문장 상한이고, `C_guarded = A × (statement + idle)`입니다.

| 종류 | A 상한 | `statement_timeout` | `idle_in_transaction_session_timeout` | `C_guarded` | `transaction_timeout` 상수 | Prisma `timeout` |
|---|---|---|---|---|---|---|
| `advance` | 28 | 2,000 ms | 1,000 ms | 84초 | 90,000 ms | 120,000 ms |
| `confirm` | 17 | 2,000 ms | 1,000 ms | 51초 | 55,000 ms | 75,000 ms |
| Admin `genesis` | 17 | 2,000 ms | 1,000 ms | 51초 | 55,000 ms | 75,000 ms |
| Admin `verify-result` | 13 | 2,000 ms | 1,000 ms | 39초 | 45,000 ms | 60,000 ms |
| Admin `genesis-retirement` | 20 | 2,000 ms | 1,000 ms | 60초 | 66,000 ms | 85,000 ms |
| `digest` 제출 | 11 | 2,000 ms | 1,000 ms | 33초 | 36,000 ms | 55,000 ms |
| `state` 읽기 | 11 | 2,000 ms | 1,000 ms | 33초 | 36,000 ms | 55,000 ms |
| 보존 배치 | 11 | 1,000 ms | 500 ms | 16.5초 | 18,000 ms | 30,000 ms |
| `assert`(마감 확인) | 3 | 1,000 ms | 500 ms | 4.5초 | 6,000 ms | 10,000 ms |

모든 줄에서 `Prisma timeout > transaction_timeout 상수 >= C_guarded > statement_timeout > idle`입니다. 문장 수 상한은 DB가
아니라 애플리케이션이 셉니다(닫힌 allowlist).

**실행 마감.** 모든 요청은 `runDeadline`을 싣습니다. 값은 실행 시작 시각 + supervisor 기한(180초)입니다. `runDeadline`은 `timestamptz`로 받고 저장하며,
이 절의 "지금"과 모든 마감 판정은 `timestamptz`인 `clock_timestamp()`와의 비교입니다. 세션 `TimeZone`은 결과를 바꾸지 않습니다. `now()`·`transaction_timestamp()`는 트랜잭션 시작 시각에 멈춰 있어 마감을 넘긴 것을 보지
못하므로 쓰지 않습니다. 함수는 이렇게 동작합니다.

1. `statement_timeout`과 idle을 위 값으로 겁니다.
2. 자기 DB 시계로 `remaining = runDeadline − 지금`을 구하고, `remaining < C_guarded + 250 ms`이면 아무것도 쓰지 않고 롤백합니다.
3. `server_version_num`이 170000 미만이면 `transaction_timeout`을 읽지도 쓰지도 않습니다. 이름은 text 인자로만 전달하고 그 분기는
   실행되지 않습니다. PostgreSQL 16에서는 트랜잭션 점유에 DB 상한이 없고, 이것을 수락합니다(결정 N-5).
4. 17 이상이면 다음 순서로 진행합니다.
   - 이전 값을 읽어 구조화 로그에 남깁니다.
   - 값을 0으로 무력화합니다.
   - `ttArmedMs = min(종류별 상수, runDeadline − 지금 − 250 ms)`를 다시 겁니다(결정 N-7). `ttArmedMs < C_guarded`이면 롤백합니다.
   - 건 직후 시계를 다시 읽어 `지금 + ttArmedMs > runDeadline`이면 롤백합니다.

   양수인 timer에 양수를 다시 거는 것은 timer를 바꾸지 않고(설정 값만 바뀜), 0을 거친 뒤 거는 것은 실제로 다시 무장한다는
   것은 PostgreSQL 17.10에서 실행으로 측정한 사실입니다. S0b의 17 전용 job이 물려받은 값 200 ms와 600 s 두 경우를 매번 다시 실행해
   이것을 고정합니다(물려받은 값이 너무 작아 무장 전에 세션이 끝나면 쓰기 0으로 끝나는 fail-closed입니다). 그래서 17에서는
   점유의 만료 시각이 실행 마감 이하이고, `ttArmedMs >= C_guarded > statement_timeout`이 언제나 참이라
   함수 다음 문장부터는 statement timer가 조용히 꺼지는 조합이 생기지 않습니다. PostgreSQL은 statement timer를 **문장마다 시작할
   때** 그 시점의 `statement_timeout`과 `transaction_timeout` 값으로 다시 판정하므로, 물려받은 값이 작아 무장 함수 문장 자신의
   statement timer가 꺼졌더라도 다음 문장은 `ttArmedMs > statement_timeout` 아래에서 다시 무장됩니다. 무장 함수 문장 자신은
   아래 6항의 "DB 상한이 없는 구간"에 속합니다. 17 전용 job은 물려받은 값 200 ms에서 다음 넷을 **모두** 단언합니다.
   - 함수 뒤 `pg_sleep(1)`에서 세션이 살아 있습니다(우리 값으로 다시 무장됨).
   - 그다음 2초를 넘는 문장이 statement timeout으로 취소됩니다(statement timer가 무장돼 있음).
   - statement 상한 아래의 짧은 문장을 반복하면 `ttArmedMs`에서 세션이 끝납니다(우리 timer가 실제로 돔).

   - 문장 사이를 `idle_in_transaction_session_timeout`보다 길게 비우면 세션이 idle timeout으로 끝납니다(idle timer도 다시 판정돼
     무장돼 있음).

   물려받은 값 600 s에서도 셋째와 넷째 단언을 합니다. `current_setting`만 보는 단언은 합격 근거가 아닙니다.
5. **어느 버전이든**, 마감을 넘긴 트랜잭션은 commit의 deferred constraint trigger 평가 시점에 DB 시계로 abort됩니다. 성공 응답·
   전송 허가·heartbeat 전에는 별도의 짧은 트랜잭션으로 마감을 다시 확인합니다. 그 확인을 통과하지 못하면 성공을 내보내지 않습니다.
6. 이 장치들이 덮지 못하는 구간이 있습니다.
   - `BEGIN`부터 무장 문장 끝까지
   - trigger 평가 뒤 commit 단계의 잔여
   - durable commit 자체

   이 구간들은 DB 상한이 없다고 적고, 상한이라고 부르지 않습니다.
7. advance의 `C_guarded` 84초는 실행 서비스의 HTTP 요청 timeout 15초보다 깁니다. 호출자가 먼저 포기해도 트랜잭션은 더 돌 수 있지만,
   그 결과는 3절 9항대로 언제나 **허가 없음**입니다.

## 7. 자격증명

| 서비스 | 가진 것 |
|---|---|
| `Ops Observer`(page) | `OPS_OBSERVER_SECRET`(32자 이상, 본 앱 route Bearer), `OPS_OBSERVER_HEARTBEAT_URL`, `OPS_OBSERVER_PAGE_WEBHOOK_URL`(**S2부터만**), `OPS_OBSERVER_ENABLED`, `OPS_OBSERVER_APP_URL`, `RAILWAY_DOCKERFILE_PATH` |
| `Ops Observer Digest` | `OPS_OBSERVER_DIGEST_SECRET`(32자 이상, advance·confirm은 거절), `OPS_OBSERVER_DIGEST_WEBHOOK_URL`, `OPS_OBSERVER_DIGEST_HEARTBEAT_URL`, `OPS_OBSERVER_ENABLED`, `OPS_OBSERVER_APP_URL`, `RAILWAY_DOCKERFILE_PATH` |

- 두 서비스 모두 제품 DB 자격증명·GitHub 토큰·admin session·LLM 키·Railway 쓰기 토큰·maintenance secret·감사 무결성 키를
  갖지 않습니다. check-in URL은 어떤 서비스에도 넣지 않습니다.
- Railway 읽기 토큰(S3)은 읽기 전용 scope가 확인되지 않으면 발급하지 않습니다. 그 변수 이름, page 서비스 금지 목록에서의 예외,
  scope 확인 방법은 S3의 정책 버전에서 정하며 그 전에는 어떤 Railway 토큰도 두 서비스에 없습니다.
- 소유자가 로컬에서 돌리는 전체 감사 재검증 보고는 서비스 작업이 아니며, 그 실행에 필요한 읽기 자격증명은 소유자만 다룹니다.

## 8. 단계와 착수·전환 조건

관측 기간의 근거는 아래 괄호 안에 이름 댄 기록뿐입니다. 그 기록이 기간 전체를 덮지 못하면 조건은 **미충족**이고, 기억·서비스
로그·다른 조건으로 대신하지 않습니다. 미충족이거나 조건이 깨지면 전환하지 않고, 관측 기간을 근거가 있는 날부터 다시 셉니다.
확인한 값은 단계 전환 기록에 적습니다.

| 단계 | 내용 | 착수 조건 | 다음 단계로의 전환 조건 |
|---|---|---|---|
| S0b | 저장소 안 작업만: 순수 core(구간화, 분류, 알림 예산, 내용 검사, 단일 schema 모듈, 신뢰 검사 판정)와 단위 테스트, 감시 store의 DB 통합 테스트(PostgreSQL 16 job과 17 전용 job, 어느 쪽에도 skip 없음) | 이 정책의 승인 판정 통과 | S0b PR 병합 |
| S1a | 본 앱에 dark 배포: 상태 집계 route, 감시 테이블과 route(genesis 행 없음), Admin genesis 동작과 digest 영역. 배포 뒤 소유자가 최초 genesis(`shadow`)를 승인 | S0b 병합. production이 전용 감사 무결성 키를 쓰고 있음을 확인. 소유자가 production의 `server_version_num`을 한 번 읽어 기록하고, 170000 이상일 때만 `SHOW transaction_timeout`도 읽어 기록(16이면 "해당 없음") | 7일 동안 응답 p95와 DB 부하가 소유자 승인 범위 안(Railway 서비스 지표). 상태 집계·감사 조회 비용 측정을 기록하고 N-3b를 결정 |
| S1b shadow | 두 Railway 서비스 가동, page webhook 없음, 예약은 `shadowed`로 종결. digest에 would-have-paged 목록과 종류별 예상 메시지 수 | 소유자가 실행 비용 상한과 소유자 시간대를 정하고 정책 버전 증가. 두 서비스의 IaC 선언 병합과 운영자 apply. 첫 빌드 로그에 빌드 환경 검사 통과 줄. 두 heartbeat monitor를 "사건당 1회"로 등록하고 알림 대상 기록 | **14일 연속**(S1b 시작 시각부터): P8 알림 0회(P8 monitor의 알림 이력 또는 그 알림 대상의 수신 기록), 최초 genesis 뒤 추가 genesis 0건(genesis 행과 그 사람 감사 행), `shadowed`에 이르지 않은 예약 0건(전송 기록 테이블) |
| S2 page | 1절의 8개 키를 실제로 page | S1b 전환 조건 충족. page 키가 아닌 readiness 검사 **전부**(1절 3항의 이름, 그때 추가된 것 포함)의 영향표에 대한 소유자 결정 기록. page 채널이 소유자 전용이고 휴대폰 푸시로 도달함을 확인. 점검 요일·시간 창 결정과 정책 버전 증가. check-in monitor 생성, monitor 셋의 알림 대상이 page 채널이 아님. Railway의 주 프로세스 종료 인식 관측 통과(결정 D5c). activation genesis(`live`) | **14일**: 오탐 page 주 1회 이하(전송 기록 테이블의 키·종류·열림 시각을 소유자가 보고 판정하고, 기록으로 조치 필요 여부를 판정할 수 없는 page는 오탐으로 셈), P8 알림 0회(P8 monitor의 알림 이력 또는 그 알림 대상의 수신 기록), `confirmed`에 이르지 않은 예약 0건(전송 기록 테이블) |
| S3 page 확대 | provider 예산 키(provider × 일·월, `>=95`로 열림, `exhausted`로 악화). 그리고 Railway 읽기 전용 토큰이 확인된 뒤에만 HTTP 5xx 급증과 기존 운영 알림 전달 실패 | S2 전환 조건 충족. 키 수와 5절 최대값을 다시 계산해 정책 버전 증가 | **30일**: 커밋된 소유자 날짜별 예약 수가 재계산한 최대값 이하(전송 기록 테이블. 거절된 advance는 롤백되어 행을 남기지 않으므로 이 조건은 거절 횟수를 주장하지 않음), `confirmed`에 이르지 않은 예약 0건(전송 기록 테이블), P8 알림 0회(P8 monitor의 알림 이력 또는 그 알림 대상의 수신 기록) |

되돌림: 어느 단계든 실행 서비스의 `OPS_OBSERVER_ENABLED`를 지우면 다음 회차부터 멈추고, route secret을 지우면 본 앱 route가
404를 돌려줍니다. 해제(정지)는 아무 조건도 요구하지 않습니다. 다시 켜는 것은 소유자만 합니다.

## 9. 운영자 결정(2026-10-03 대화)

| 번호 | 결정 |
|---|---|
| D2 | 앱·DB 전체 부재는 P8만으로 탐지하고 약 30분 지연을 수락 |
| D3 | 알림은 링크만(공통 기반이 이미 정함) |
| D5a | page 자식 프로세스 하나가 state route secret과 page webhook을 함께 갖는 것을 수락 |
| D5b | genesis 7일 규칙 유지 |
| D5c | Railway가 주 프로세스 종료를 실행 종료로 인식하는지 관측해 통과해야 S2 |
| N-2 | 6절의 종류별 상수 아홉 줄을 수락. advance의 `C_guarded`가 호출자 timeout 15초보다 길다는 사실 포함 |
| N-3a | 감사 재검증 buffer 예산 40 |
| N-3b | **보류.** S1a 측정 뒤 결정 |
| N-4 | digest 항목 크기 상한 16 KiB, 메타 행 보존 365일을 Agent 공통 불변값으로 확정 |
| N-5 | PostgreSQL 16에서는 트랜잭션 점유에 DB 상한이 없다는 것을 수락 |
| N-6 | genesis 은퇴는 90일 전체 재검증에 묶음 |
| N-7 | 17 이상에서 물려받은 `transaction_timeout`을 0으로 무력화한 뒤 6절의 값으로 다시 걸고, 이전 값을 구조화 로그에 남김 |
| Y-5 | 감사 전체 재검증 주기 90일 |
| T-1 | (2026-10-07 대화) 소유자 시간대는 `Australia/Brisbane`(UTC+10, 일광절약시간 없음)입니다. 5절의 "소유자 날짜"는 이 시간대의 달력 날짜이며, 실행 서비스가 실행 시작 시각으로 정해 state·advance 요청에 싣습니다. 8절 S1b 착수 조건 중 **실행 비용 상한은 여전히 미정**이므로 이 결정만으로 S1b는 착수할 수 없습니다 |
| C-1 | (2026-10-07 대화) 8절 S1b의 실행 비용 상한은 **달력 월당 USD 20**이며, 대상은 두 실행 서비스(`Ops Observer`, `Ops Observer Digest`)의 Railway 사용량 합계입니다. 본 앱 route·테이블 부하는 이 금액에 넣지 않고 S1a 측정(N-3b)으로 따로 봅니다. 상한을 넘거나 넘을 것으로 보이면 감시를 멈추지 않고 cadence를 늘려 줄이며, 그 경우 P8 탐지 시간과 dead-man 허용치가 함께 늘어난다는 것을 digest에 적고 늘린 값은 정책 버전 증가로 다시 승인합니다. 이 결정과 T-1로 8절 S1b 착수 조건의 소유자 결정 항목은 채워졌고, 나머지 착수 조건(IaC 선언 병합과 운영자 apply, 첫 빌드 로그의 빌드 환경 검사 통과, heartbeat monitor 등록)은 그대로입니다 |

## 10. 보존

- digest 본문 90일, 그 뒤 해시·크기·종류·멱등 키·시각만 남김. 메타 행은 생성 후 365일.
- 닫힌 전송 기록 90일. `reserved` 행은 지우지 않음.
- 감시 상태 전이 원장은 관리 감사 7년 보존을 따르며, 이 원장이 공유 감사 테이블의 보존 삭제를 막지 않습니다.
