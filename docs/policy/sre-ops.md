# 운영·SRE 모니터링 Agent 정책

상태: **초안. 미승인.** 최초 작성 2026-10-03.
approvedBy: (미승인) · approvedAt: (미승인) · 정책 버전: (미부여)
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| (미부여) | (미승인) | 최초 초안. 비공개 설계서(revision 18, 교차 vendor 독립 검토 `accept`)의 공개 가능한 계약만 옮김 |

이 문서는 Claude가 설계하고 교차 vendor 독립 검토를 받은 비공개 설계서를 공개 계약으로 옮긴 것입니다. 내용 변경은 운영자
승인과 정책 버전 증가가 필요합니다. 승인은 단계별 착수 조건(7절)을 없애지 않으며, 어떤 Railway 서비스·secret·webhook·
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
   기존 경보 경로가 구조적으로 침묵하는 신호만 page합니다. S2의 page 키는 8개입니다.

   | 신호 | 키 | 조건 |
   |---|---|---|
   | readiness 핵심 | `database`, `securityEnvironment` | 해당 검사가 연속 3회 false |
   | readiness 채팅 예산 구성 | `providerBudgets` | 연속 3회 false |
   | readiness 이메일 유실 | `emailSnapshotKeyring`, `emailSendingIdentity` | 연속 3회 false |
   | readiness 판정 불가 | 단일 | `/api/health`는 응답하는데 상태 집계가 연속 3회 실패 |
   | 15분 cron 침묵 | 단일 | `credit_reservation_reconciliation`이 `delayed`, `stuck`이면 악화 |
   | 이메일 drain 실패 | 단일 | `standard_email_drain`의 연속 실패 구간 3+ |

   S3 후보(provider 예산 95%·소진, HTTP 5xx 급증, 기존 운영 알림 전달 실패)는 정책 버전을 올려 따로 승인합니다.
2. **침묵 감시.** 감시자 자신이 멈추거나 앱·DB가 통째로 응답하지 않으면, 감시자와 독립된 외부 dead-man 서비스가 heartbeat
   공백으로 알립니다(P8). 탐지 지연은 마지막 성공 heartbeat부터 허용치(30분)입니다(결정 D2).
3. **digest.** 하루 한 번, 항목 20개 상한의 폐쇄 schema 요약을 본 앱에 제출합니다. 소유자는 Admin Console에서 읽습니다.
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
5. **금지 변수가 있으면 시작하지 않습니다.** 서비스 진입점은 DB·Prisma·Postgres 계열, GitHub, maintenance secret, 감사 무결성 키,
   `NEXTAUTH_SECRET`, 상대 서비스의 변수 이름이 환경에 있으면 자식 프로세스를 띄우기 전에 구성 오류로 멈춥니다.
6. **빌드 단계에는 runtime 비밀값이 없습니다.** 전용 Dockerfile은 `ARG`를 선언하지 않는 단일 stage이고, 첫 실행 명령이 빌드 환경
   검사입니다.
7. **결과를 모르면 멈춥니다.** 본 앱 요청은 재시도하지 않고, 상태를 신뢰할 수 없으면 아무것도 보내지 않고 heartbeat도
   보내지 않습니다. 그 침묵은 P8이 알립니다.
8. **감시 상태 전이는 같은 트랜잭션에서 기존 해시 체인 감사에 시스템 actor로 남습니다.** 감사 테이블에 직접 쓰지 않고
   `lib/adminAudit.ts`의 append 경로를 지납니다.
9. **Agent는 자기 gate를 고치지 않습니다.** 이 정책, 판정 상수, workflow, 권한 목록의 변경은 사람이 합니다.

## 4. 고정 문장

| 용도 | 문장 | 링크 |
|---|---|---|
| page | `Tomverse 운영 감시: 확인이 필요한 장애 신호가 있습니다.` | Admin 항목 링크 하나 |
| digest 알림 | `Tomverse 운영 감시: 오늘의 운영 요약이 준비됐습니다.` | Admin 항목 링크 하나 |
| 채널 점검 | `Tomverse 주간 page 채널 점검: 휴대폰 푸시로 받았다면 점검 check-in을 여세요.` | 없음 |

page와 채널 점검이 같은 실행에서 생기면 page 문장·링크 뒤에 점검 문장을 붙여 한 메시지로 보냅니다.

## 5. 알림 상한

- 실행당 page 메시지 최대 1개. 주기적 재알림 없음.
- 사건당 종류별(신규 열림·악화·재열림·회복) 1회. 회복 뒤 24시간 안의 다시 열림은 재열림입니다.
- 재열림·회복(그리고 재열림으로 시작한 사건의 악화)은 소유자 날짜당 6개. **신규 열림과 그 사건의 악화는 이 상한으로
  막지 않습니다.**
- 계산 최대값(S2): 하루 15, 점검 요일 16, genesis한 날 31. 직전 genesis 뒤 7일 안의 genesis는 전송 대신 침묵을 만듭니다
  (결정 D5b). S2 시작일은 activation genesis 날이므로 그날 최대 31입니다.
- 채널 점검은 소유자 날짜당 1회. check-in monitor는 주기 7일 + 유예 2일이며, 채널이 죽은 뒤 최대 9일 안에 탐지합니다.
- dead-man monitor 셋(page heartbeat, digest heartbeat, 점검 check-in)의 알림 대상은 **page 채널이 아닌 경로**여야 합니다.

## 6. 자격증명

| 서비스 | 가진 것 |
|---|---|
| `Ops Observer`(page) | `OPS_OBSERVER_SECRET`(32자 이상, 본 앱 route Bearer), `OPS_OBSERVER_HEARTBEAT_URL`, `OPS_OBSERVER_PAGE_WEBHOOK_URL`(**S2부터만**), `OPS_OBSERVER_ENABLED`, `OPS_OBSERVER_APP_URL`, `RAILWAY_DOCKERFILE_PATH` |
| `Ops Observer Digest` | `OPS_OBSERVER_DIGEST_SECRET`(32자 이상, advance·confirm은 거절), `OPS_OBSERVER_DIGEST_WEBHOOK_URL`, `OPS_OBSERVER_DIGEST_HEARTBEAT_URL`, `OPS_OBSERVER_ENABLED`, `OPS_OBSERVER_APP_URL`, `RAILWAY_DOCKERFILE_PATH` |

- 두 서비스 모두 제품 DB 자격증명·GitHub 토큰·admin session·LLM 키·Railway 쓰기 토큰·maintenance secret·감사 무결성 키를
  갖지 않습니다. 체크인 URL은 어떤 서비스에도 넣지 않습니다.
- Railway 읽기 토큰(S3 후보)은 읽기 전용 scope가 확인되지 않으면 발급하지 않습니다.
- 소유자가 로컬에서 돌리는 전체 감사 재검증 보고는 서비스 작업이 아니며, 그 실행에 필요한 읽기 자격증명은 소유자만 다룹니다.

## 7. 단계와 착수 조건

| 단계 | 내용 | 착수 조건 |
|---|---|---|
| S0b | 저장소 안 작업만: 순수 core(구간화, 분류, 알림 예산, 내용 검사, 단일 schema 모듈, 신뢰 검사 판정)와 단위 테스트, 감시 store의 DB 통합 테스트(PostgreSQL 16 job과 17 전용 job) | 이 정책의 승인 판정 통과 |
| S1a | 본 앱에 dark 배포: 상태 집계 route, 감시 테이블과 route(genesis 행 없음), Admin genesis 동작과 digest 영역 | S0b 병합. 소유자가 production의 `server_version_num`과 `SHOW transaction_timeout`을 한 번 읽어 기록 |
| S1b shadow | 두 Railway 서비스 가동, page webhook 없음, 예약은 `shadowed`로 종결 | 소유자가 실행 비용 상한·소유자 시간대를 정하고 정책 버전 증가. 두 heartbeat monitor 등록과 그 알림 대상 기록 |
| S2 page | 위 8개 키를 실제로 page | shadow 관측 기간 충족, readiness 비핵심 일곱 검사 영향표에 대한 소유자 결정, page 채널이 소유자 전용이고 휴대폰 푸시가 확인됨, 점검 요일·시간 창 결정, Railway의 주 프로세스 종료 인식 관측 통과(결정 D5c), activation genesis |
| S3 page 확대 | provider 예산 키, 그리고 읽기 전용 토큰이 확인되면 5xx·기존 알림 전달 실패 | 정책 버전 증가 |

되돌림: 어느 단계든 실행 서비스의 `OPS_OBSERVER_ENABLED`를 지우면 다음 회차부터 멈추고, route secret을 지우면 본 앱 route가
404를 돌려줍니다. 해제(정지)는 아무 조건도 요구하지 않습니다. 다시 켜는 것은 소유자만 합니다.

## 8. 운영자 결정(2026-10-03 대화)

| 번호 | 결정 |
|---|---|
| D2 | 앱·DB 전체 부재는 P8만으로 탐지하고 약 30분 지연을 수락 |
| D3 | 알림은 링크만(공통 기반이 이미 정함) |
| D5a | page 자식 프로세스 하나가 state route secret과 page webhook을 함께 갖는 것을 수락 |
| D5b | genesis 7일 규칙 유지 |
| D5c | Railway가 주 프로세스 종료를 실행 종료로 인식하는지 관측해 통과해야 S2 |
| N-2 | 트랜잭션 종류별 상한 아홉 줄을 설계값 그대로 수락. advance의 상한이 호출자 timeout 15초보다 길다는 사실 포함 |
| N-3a | 감사 재검증 buffer 예산 40 |
| N-3b | **보류.** S1a 실측 전에는 정할 수 없음 |
| N-4 | digest 항목 크기 상한 16 KiB, 메타 행 보존 365일을 Agent 공통 불변값으로 확정 |
| N-5 | PostgreSQL 16에서는 트랜잭션 점유에 DB 상한이 없다는 것을 수락. 17이면 문장 단위 시간 상한 아래에서 점유가 실행 마감 이하로 묶임 |
| N-6 | genesis 은퇴는 90일 전체 재검증에 묶음 |
| N-7 | 물려받은 `transaction_timeout`을 이 Agent의 트랜잭션 안에서 덮어쓰고, 이전 값을 구조화 로그에 남김 |
| Y-5 | 감사 전체 재검증 주기 90일 |

## 9. 보존

- digest 본문 90일, 그 뒤 해시·크기·종류·멱등 키·시각만 남김. 메타 행은 생성 후 365일.
- 닫힌 전송 기록 90일. `reserved` 행은 지우지 않음.
- 감시 상태 전이 원장은 관리 감사 7년 보존을 따르며, 이 원장이 공유 감사 테이블의 보존 삭제를 막지 않습니다.
