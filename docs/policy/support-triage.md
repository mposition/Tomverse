# 고객지원 1차 분류 Agent 정책

상태: **승인됨(버전 2).** 최초 작성 2026-10-03, 버전 1 승인 2026-10-03, 버전 2 승인 2026-10-03.
owner: mposition · approvedBy: mposition · approvedAt: 2026-10-03 · 정책 버전: 2
allowlistGenesisCommit: 8e3dbf64452ab75e3c6f080c8f5f531c02ace387

| 버전 | 승인 | 변경 |
|---|---|---|
| 1 | 2026-10-03 mposition | 최초 승인 |
| 2 | 2026-10-03 mposition | 1절의 갈래를 lane 여섯 개로 확정: 계정·개인정보 신고는 별도 갈래가 아니라 `trust_safety_human`(안전·보안과 같은 사람 전용 lane) |

운영자 `mposition`이 2026-10-03 대화 세션에서 이 문서를 승인했다. 이 문서는 이 Agent(`agentKey = support-triage`)
구현의 규범 근거다. 다만 **아래 승인 판정이 통과하기 전에는(이 승인 기록이 `develop`에 병합되기 전을 포함해)
P0b의 어떤 코드도 작성·병합하지 않는다.**

이 문서는 Claude가 설계하고 교차 vendor 독립 검토에서 `accept` 판정을 받은 비공개 설계서(revision 19)를 공개
계약으로 옮긴 것이다. 설계서가 이름 대는 미해결 위험 경로는 이 공개 문서에 옮기지 않는다. 내용 변경은 운영자
승인과 정책 버전 증가가 필요하다. 승인은 단계별 착수 조건을 없애지 않으며, 어떤 workflow·secret·Railway 서비스·
IaC 항목·feature flag 변경도 그 자체로 허가하지 않는다.

## 0. 승인 판정

승인은 아래 단계를 **모두** 통과해야 인정한다. P0b 착수 전에 판정하고, 결과는 그 착수 PR 본문에 적는다. 판정은
기록(git·GitHub)만으로 재현할 수 있어야 하며, script(`npm run report:support-triage -- --policy-approval`)로
자동화해도 게이트가 아니라 보고다.

| # | 판정 |
|---|---|
| 0 | `approvedBy`의 계정이, 이 정책 파일을 바꾼 PR의 **base에 있던** `docs/policy/agent-operator-allowlist.md` 목록에 있다. 그 목록 파일의 최초 commit이 위 `allowlistGenesisCommit`과 같고, 그 commit부터 base까지 그 목록 파일의 모든 변경이 그 파일 3절의 규칙(version 증가, 그 파일만 바꾼 PR, 이전 목록에 있는 계정이 승인하고 병합, `to-develop` 브랜치 아님)을 따랐다. 목록 파일 자신의 변경도 아래 1~7번과 같은 절차(PR 하나, 병합자 = 승인자, 승인일 = 병합 UTC 날짜, 작성자가 사람)로 판정한다 |
| 0a | 이 정책 파일의 `approvedBy`·`approvedAt`·정책 버전이 채워져 있고, 정책 버전이 직전 승인 버전보다 크다 |
| 1 | 이 정책 파일을 마지막으로 바꾼 commit을 찾는다 |
| 2 | 그 commit을 `develop`에 넣은 PR이 **정확히 하나**다 |
| 3 | 그 PR의 브랜치 이름에 `to-develop` 경로 조각이 없다 |
| 4 | 그 PR의 병합자가 `approvedBy`와 같은 계정이다. 병합자가 사람인지는 기록만으로 가릴 수 없으므로, 운영자가 대화에서 승인한 날짜와 정책 버전을 그 PR 본문에 적고 운영자가 직접 병합한다 |
| 5 | `approvedAt`이 그 병합의 UTC 날짜와 같다 |
| 6 | 그 PR이 이 정책 파일 하나만 바꾸고, 모든 commit의 작성자가 `approvedBy`이며 bot이 아니다 |
| 7 | 그 뒤 이 정책 파일이 다시 바뀌면 1번부터 다시 판정한다 |

이 판정이 증명하는 것은 절차이지 authorship이 아니다. 이 저장소의 Agent 세션은 운영자와 같은 git 신원으로
commit하므로, 이 판정은 실수와 우회를 잡지만 자격증명 도용은 잡지 않는다.

운영자가 2026-10-03 대화에서 내린 결정을 담는다.

- 보존 회차는 전용 caller가 `*/30 * * * *`로 부른다(설계 Q19 (c)). 회차 예산 100초, 회차당 8배치.
- `SupportTriageRun`의 UTC 날짜당 회차 상한은 worker 52 · retention 52다(Q21).
- 그룹 모델은 `(groupId, kind)` 한 행 저장과 `primaryKind` 동치류 하나, kind 우선순위, 멤버 상한 50,
  pass당 상향 이동 예산 50이며, 상향 수렴이 덮지 못하는 세 경우를 표시 손실로 수용한다(Q20, 6절).
- 감사량은 유도 상한 연 455,520행·기대값 연 286,160행을 수용한다(X3, 8절).
- 물려받은 양수 `transaction_timeout`이 그 lane의 `C_guarded` 이하이면 쓰기 전에 거절하고, 그보다 크면
  점유 상한의 숫자가 이 정책의 값이 아니며 더 늦을 수 있다는 잔여를 수용한다(Q22, 4절).
- `SupportTriageDecisionRecord`는 결정 뒤 12개월 보존하고, link된 신고가 계정 삭제되면 즉시 지운다(X2, 5절).
- 7팀 합산 owner-bound 상한(Q15)과 침묵 감시의 감시자 감시(Q16)는 **P1 착수 조건으로 미결**이다(9절).
- PostgreSQL 버전(Q18)은 요구하지 않는다. production 버전 기록이 점유 상한 한 층의 유무만 정한다(4절).
- (버전 2) 계정·개인정보 신고는 별도 lane이 아니라 `trust_safety_human`으로 간다. 설계서 5.6절의 결정이며, 1절의 갈래
  일곱이 lane 여섯이 된다.

## 1. 무엇을 하는가

1. 들어온 신고마다 **사람이 먼저 봐야 할 순서와 담당 lane**을 결정적 규칙으로 제안한다. lane은 여섯이다 —
   `bug_verified`(bug-검증됨) / `bug_unverified`(bug-미검증) / `billing_human`(과금·환불) /
   `trust_safety_human`(계정·개인정보와 안전·보안·법적·자해 위협) / `feature_request`(기능 요청) / `other`(기타).
   `money` flag나 `type = billing`이면 `billing_human`, `account_privacy`·`security`·`legal`·
   `self_harm_threat` flag면 `trust_safety_human`이고, 둘이 함께 걸리면 `trust_safety_human`이 우선한다.
2. 서버가 이미 판정한 trace 사실을 **다시 판정하지 않고** 신고 옆에 요약한다.
3. 같은 문제의 신고를 묶는 **그룹 후보**를 서버 사실(`server_evidence_match` > `same_account` >
   `autofix_fingerprint`)로 제안한다. `traceId`는 쓰지 않는다.
4. 사실을 약속하지 않는 **답변 초안**을 결정적 템플릿으로 만든다. 보내는 것은 사람이다.
5. 소유자에게는 공통 Agent digest 영역의 일일 digest 하나와, 상한·만료·자동 해소가 있는 대기열만 남긴다.

**LLM을 쓰지 않는다.** 신고 본문과 파생 데이터는 앱 밖의 어떤 제3자에게도 가지 않는다. 본문이 만들 수 있는
값은 고정 키워드 목록 일치의 enum flag뿐이고, flag는 우선순위를 올리거나 사람 전용 lane으로 보내기만 한다.
LLM 도입은 새 설계 revision, 새 독립 검토, 이 정책의 새 버전 없이는 불가하다.

## 2. 하지 않는 것 (절대 조건)

위반은 즉시 정지(모든 triage flag 제거) 사유이며, 코드 변경으로 위반하면 release blocker다.

1. 메일 발송, 알림 enqueue, `Feedback.status`·`type`·`closureOutcome`·`userReply`·lifecycle event 쓰기.
2. `FeedbackAutoFixCase` 생성·전이. triage 출력은 auto-fix 적격성의 입력이 아니고, `triageLane`은 관리자
   PATCH schema에 없다.
3. `errorReportVerification`·`errorClassificationSource`·`evidenceAvailability`의 재판정. client 분류를 server
   사실로 표시하지 않는다. 원시 `errorReportToken`을 보지 않는다.
4. `traceId`를 그룹 identity·upsert key·신호로 쓰기.
5. 종료 결과 코드를 채우거나 제안하기. 크레딧·환불·보상·금액·기한·배포 완료·제품 결정의 약속, URL·연락처·
   기술 식별자를 초안에 담기. goodwill 금액·지급 제안을 어디에든 쓰기.
6. 신고 본문·`feedbackId`·그룹 id를 GitHub·CI·외부 채널·새 운영자 메일로 내보내기. GitHub에 대한 모든 쓰기
   (status·check·issue·label·comment·artifact·branch·PR).
7. release-gate registry·가격·크레딧 값·이메일 정책 status 등 사람이 결정하는 필드 쓰기.
8. 일괄 종료 endpoint, 관리자 PATCH를 순회하는 코드. 그룹 확정·기각과 suggestion 수락·기각·표본 판정 route는
   triage 테이블과 닫힌 schema 감사 로그 외에 쓰지 않는다.
9. 이 Agent가 자기 게이트(이 정책, 그 테스트, workflow, 권한, 삭제 manifest의 분류 규칙)를 고치기.
10. 설정 누락을 "꺼짐"으로 취급하기. 설정 누락은 구성 오류이고 실패는 실패로 기록한다.
11. 결과를 모르는 실행의 재시도. 결과를 모르면 멈추고 heartbeat가 사람에게 넘긴다.

## 3. 실행 위치와 자격증명

| 능력 | 위치 |
|---|---|
| triage pass(후보 읽기·claim·신호·그룹 후보·템플릿 id·P1 표본·run 기록) | Railway cron 서비스 `Support Triage`(`*/30 * * * *`) → 본 앱 `POST /api/internal/support-triage/run`. 계산과 DB 쓰기는 본 앱 route |
| 보존 회차 | Railway cron 서비스 `Support Triage Retention`(`*/30 * * * *`) → 본 앱 `POST /api/internal/support-triage/retention`. triage flag와 무관하게 돈다 |
| 계정 삭제 시 triage 행 삭제 | 사용자의 계정 삭제 transaction 안 |
| 사람 결정(수락·기각·확정·표본 판정) | 공통 Agent digest 영역의 본 앱 관리자 route(`support:write` + 최근 인증) |
| heartbeat `{ stale }` | 본 앱 route. 부르는 쪽은 팀 3(sre-ops) 감시자 |

- 두 서비스는 각자 route secret(`SUPPORT_TRIAGE_RUN_SECRET`·`SUPPORT_TRIAGE_RETENTION_SECRET`, 32자 이상)과 URL
  외의 변수를 갖지 않는다. 제품 DB 자격증명·GitHub 토큰·LLM/SaaS 키·`MAINTENANCE_SECRET`·heartbeat secret 모두 없다.
  요청 본문이 없고 응답은 건수뿐이다.
- 서비스 진입점은 supervisor + child다. worker는 supervisor 10분·child 요청 9분, retention은 supervisor 5분·child
  요청 4분이며, supervisor가 상한에 child를 `SIGKILL`하고 exit 1로 끝난다. 재시도는 없다.
- GitHub Actions는 쓰지 않는다. 상태·결정·digest는 본 앱 DB와 Admin Console에만 있다.

## 4. 시간 상한

본 앱 route는 hard timeout을 주장하지 않는다. 층마다 강제 주체가 다르다.

| 층 | worker | retention | admin | 강제 주체 |
|---|---|---|---|---|
| 서버 deadline `deadlineAt`(DB 시계) | 5분 | 회차 시작 + **100초** | 없음 | 예산(다음 transaction을 시작할지 정함) |
| `statement_timeout` | 5,000ms | 400ms | 5,000ms | DB |
| `idle_in_transaction_session_timeout` | 2,000ms | 150ms | 2,000ms | DB |
| `transaction_timeout`(PostgreSQL 17에서만) | 150,000ms | 20,000ms | 120,000ms | DB |
| Prisma interactive transaction `timeout` | 180초 | 30초 | 150초 | 클라이언트 backstop |
| transaction당 guarded 예산 `C_guarded` | 최대 138초 | `T_retention_batch` 10.3초 | `T_admin_decision` 110초 | 애플리케이션 유도값 |

- lane마다 `Prisma timeout > transaction_timeout > C_guarded 최대 > statement_timeout > idle`이어야 한다. 뒤집히면
  뒤의 두 timeout이 오류 없이 꺼진다. 상수 단언 테스트가 이 순서를 고정한다.
- 세 timeout은 transaction의 첫 라운드트립 하나가 `support_triage_arm_timeouts()`로 함께 건다. 그 함수는
  `SECURITY INVOKER`이고 `SET` 절도 `EXCEPTION` 절도 없다. 앱에 PostgreSQL 버전 분기는 없다.
- `C_guarded = A상한 × statement_timeout + (A상한 − 1) × idle`이고, 라운드트립 수 상한은 wrapper가 센다.
  PostgreSQL에는 문장 수를 세는 기구가 없으므로 이것을 DB 계약이라고 부르지 않는다.
- 배치는 남은 예산이 그 종류의 `C_guarded`보다 클 때만 시작한다(`T_run_finish`만 예외). retention은 거기에
  **회차당 배치 계수기** `RETENTION_BATCHES_PER_RUN_MAX = 8`이 함께 걸린다.
- **늦게 끝난 실행은 성공으로 기록되지 않는다.** 각 mutation 경로의 마지막 라운드트립이 DB 시계 마감 검사
  `support_triage_assert_deadline()`이고, 실패하면 transaction 전체가 행·감사 행과 함께 rollback된다.
  `T_run_finish`는 감사가 먼저이고 종료 `UPDATE`가 DB 시계로 `deadline_exceeded`를 판정한다.
  `SupportTriageRun`의 CHECK가 `success`·`partial`에 `finishedAt <= deadlineAt`을 요구하고, trigger가 `deadlineAt`과
  종결 outcome을 불변으로 만든다.
- **물려받은 양수 `transaction_timeout`(Q22).** 세션이 양수 값 `I`를 들고 있으면 타이머는 transaction 시작
  시점에 `I`로 무장되고 이 정책의 값으로 재무장되지 않는다. (1) `I`가 그 lane의 `C_guarded` 이하이면 **어떤
  쓰기보다 먼저 거절한다.** (2) `I`가 더 크면 진행하고, **그때 점유 상한의 숫자는 이 정책의 값이 아니며 더 늦게
  올 수 있다는 것을 수용한다.** `I = 0`이면 위 표의 값이 무장된다.
- **PostgreSQL 버전(Q18).** 이 Agent는 버전을 요구하지 않는다. 정확성 보장, 수치, `C_guarded`, 라운드트립 수는
  16과 17이 같고, 다른 것은 점유 상한 한 층(17의 `transaction_timeout`)뿐이다. production 버전 기록이 그 층의
  유무를 정한다. CI는 16 job과 17 job을 각각 둔다.
- `COMMIT`의 durable 구간은 어느 버전에서도 묶이지 않으므로 transaction 하나의 벽시계 최대를 숫자로 적지 않는다.
- 계정 삭제 transaction과 admin 결정 transaction은 마감 계약 밖이다. 계정 삭제에는 이 Agent가 더하는 문장
  `DELETION_STATEMENT_MAX = 5`(라운드트립 최대 9)만 세고 transaction 범위 timeout을 걸지 않는다.

## 5. 삭제와 보존

- triage가 쓰는 모델은 **삭제 manifest에 등록된 것뿐**이다. 모든 컬럼이 분류(`report_derived`·`evidence_snapshot`·
  `signal_snapshot`·`lifecycle`·`identifier` 등)를 가져야 하며, 분류 없는 컬럼이나 manifest 밖 모델이 생기면
  누락 검사가 실패한다. 보존·계정 삭제 fixture는 이 분류에서 파생한다.
- 계정 삭제 transaction은 manifest의 triage 파생 데이터 전체를 지운다. 그 뒤 어떤 worker pass도 계정 삭제
  marker가 있는 신고에서 triage 행을 만들지 않는다(적격성 조건을 선택 query와 생성 쓰기의 잠금 확인에 함께 적용).
- 파생 데이터는 아래 보존 기한을 넘기지 않고, 로그·Sentry·analytics에 남지 않는다.

| 데이터 | 보존 |
|---|---|
| terminal suggestion | 신고 종료 뒤 또는 suggestion이 terminal이 된 뒤 30일 중 이른 쪽 |
| 그룹 멤버십 | 그 신고가 열려 있는 동안만 |
| 그룹 신호 행 | 그룹이 비종결인 동안. `snapshotExpiresAt`이 지나면 삭제하고, `primaryKind` 행이면 그룹을 종결 |
| 종결 그룹(`dismissed`·`expired`·`invalidated`) | 종결 뒤 30일 |
| `not_queued` suggestion·그룹 | `createdAt` + 7일이면 승격 대상에서 빠지고 `expired`. WIP가 7일 동안 비지 않으면 사람이 한 번도 보지 못한 채 소멸할 수 있다는 것을 수용한다 |
| 종결 그룹 key tombstone | 7일(cooldown). 이 기간에는 진짜 새 사건도 같은 key로 억제된다는 trade-off를 수용한다. key는 멤버 신고 집합에서 만들어지므로, 종결 전이는 멤버십을 지우면서 멤버 신고 id 목록 `retiredMemberIds`(최대 50, 분류 `identifier`)를 그룹 행에 남기고, cooldown이 끝나면 key와 함께 null로 지운다. **계정 삭제는 cooldown과 무관하게, 삭제된 신고가 멤버이거나 `retiredMemberIds`에 있는 그룹 행을 상태와 무관하게 지운다**(멤버십·신호는 cascade). 그래서 삭제된 신고의 id는 어떤 key·목록·멤버십·신호 행에도 남지 않는다 |
| `SupportTriageRun` | 30일(content-free) |
| `SupportTriageDecisionRecord`·`SupportTriageDecisionRecordLink` | **결정 뒤 12개월**(X2). link된 신고 중 하나라도 계정 삭제 대상이면 record와 모든 link를 즉시 삭제. 링크만 끊고 행을 남기는 상태는 없다. 목적은 결정의 결과 digest를 본문 삭제 뒤에도 남기는 것이다 |
| 공통 `AgentDigestItem`(이 Agent 몫) | 본문 `payloadRetentionDays = 90`, 메타 행 `metaRetentionDays = 365`(팀 3 공통값) |

- **보존 회차의 처리 능력.** 한 배치 transaction은 manifest의 모든 부류를 **부류마다 문장 하나**로, 문장마다 그 부류에서 최대 500행(바닥 125행)을 지운다. 그래서 하루 필요한 배치 수는 부류의 합계가 아니라 **가장 큰 부류**가 정하고, 그 부류는 그룹 신호 행(하루 31,200, 8절)이다 — 정상 크기 63배치, 바닥 크기 250배치. suggestion·멤버십·그룹·tombstone·run·결정 record와 link는 같은 배치 안의 자기 문장이 지운다. 앞의 다섯은 8절의 유도 상한이 신호보다 작다. **결정 record와 link에는 상한이 없다**(사람 결정 수는 DB가 막지 않고, 결정당 link ≤ 50). 그래서 이 처리 능력 주장은 **결정 link의 하루 생성량이 31,200 이하**라는 전제 위에 있고, 일일 digest가 그날 생성한 link 수를 보이며, 그 수가 31,200을 넘는 날이 생기면 이 주장은 성립하지 않으므로 이 정책의 새 버전으로 다시 유도한다.
  하루 능력 48회 × 8배치 = 384배치는 **성공 배치 수가 아니라 시작할 수 있는 배치 수**이고, abort된 배치도 이 수를 쓴다. 바닥 요구 250을 빼고 남는 134배치가 abort 여유다. 이 산수는 부류별 DELETE 문장이 `statement_timeout`(400ms) 안에, 배치 하나가 `C_guarded`(10.3초) 안에 끝난다는 **측정되지 않은 전제** 위에 있다. 그래서 "삭제 기한을 맞춘다"는 두 번 확인한다. **(1) P1 착수 전, staging 부하 시험** — P1 전에는 triage flag가 꺼져 production에 지울 행이 없으므로, staging에 8절의 하루 유도 상한만큼(신호 31,200행과 다른 부류의 상한) **보존 기한이 이미 지난 행**을 seed하고 예정 회차를 24시간 돌려 (a) `batchesCompleted = 0 AND overdueRemaining > 0`으로 끝난 회차 0회, (b) 24시간 뒤 `overdueRemaining = 0`, (c) `oldestOverdueAgeSeconds` 최대 86,400초 미만, (d) abort된 배치 수 ≤ 134를 기록한다. 밀린 행을 다 비운 뒤의 배치 0 회차는 실패가 아니다. **(2) P1d 착수 전, production 7일 관측** — 같은 (a)~(c)를 실제 부하로 다시 보고, (d)는 **UTC 하루 단위**로 그 7일 각각에서 abort된 배치 수 ≤ 134를 본다. 어느 쪽이든 실패하면 원인이 처리량인지 독성 행인지 먼저 가르고, 처리량이면 배치 크기와 `C_guarded`를 다시 측정해 이 정책의 새 버전으로 고친다.
- 한 배치가 `statement_timeout`으로 abort되면 다음 배치 크기를 500 → 250 → 125로 줄인다. 바닥에서 같은 회차에
  두 번 abort되면 커서를 그 창 너머로 전진시키고 `blocked`를 센다. 건너뛴 행은 다음 회차가 다시 시도한다.
- **지워지지 않는 행은 수용 대상이 아니라 경보다.** 어떤 행이 자기 삭제 기한을 24시간 넘기면
  (`RETENTION_OVERDUE_GRACE = 86,400초`, `oldestOverdueAgeSeconds > 86,400`) heartbeat가 연다(7절).
- 회차가 `batchesCompleted = 0 AND overdueRemaining > 0`으로 끝나거나 위 기한 조건에 걸리면 retention route가
  비2xx(`SUPPORT_TRIAGE_RETENTION_NOT_PROGRESSING`)로 답하고, child가 exit 1로 끝나 Railway cron 실행이 실패로 남는다.

## 6. 대기열과 그룹

- **owner-bound 상한**: P1 동안 표본 판정 7일당 최대 10건, P1d 동안 표시된 결정 대기(WIP) 최대 10건, 각 7일 만료.
  상한에 닿으면 사람에게 보이는 자리로의 승격을 멈추고(P1 표본은 추출 자체를 멈춤) 만료된 항목은 `expired`로
  기록한다. 상한 계수와 승격·추출은 같은 Serializable transaction에서만 한다. 상한은 어떤 경우에도 넘지 않는다.
- **배치 크기**: worker claim 배치 10건, pass 50건(배치 5개). lease 5분, 갱신 없음. 실행은 single-flight가 아니다 — 예정 회차와 수동 재실행이 겹칠 수 있고, lease가 만료되면 다른 회차가 그 행을 다시 claim한다. 정확성은 단일 실행이 아니라 **fencing**이 진다: result transaction의 첫 쓰기는 `(id, state = claimed, claimToken)` 조건부 갱신이고, **그 갱신이 RETURNING한 신고만** 같은 transaction의 멤버십·그룹·신호 문장의 입력 집합이 된다. 그래서 claim을 잃은 옛 회차는 deadline이 남아 있어도 그 신고에 대해 어떤 triage 행도 쓰지 못하고(`stale_claim` — 쓰기가 없는 구조화 로그 event이며 상태 전이가 아니므로 감사 대상도 아니다. 그 수는 일일 digest가 센다), 옛 회차가 자기 `deadlineAt`을 넘긴 transaction은 마지막 라운드트립의 마감 검사로 전체 rollback된다(4절). 겹친 두 pass에서도 owner-bound 상한과 그룹 key unique는 유지된다(통합 테스트가 두 연결로 고정).
- **그룹 모델(Q20).** 그룹은 `primaryKind` 하나의 동치류이고, 그룹 행과 멤버 행이 같은 `primarySnapshotDigest`를
  들며 복합 FK가 이를 강제한다. 신호는 `(groupId, kind)` 한 행이다. 멤버 상한 50. 부차 kind의 신호 행은 그 값을
  멤버 전원이 공유할 때만 쓴다.
- **상향 규칙.** 한 pass의 그룹 형성은 배치 순서에 의존하며, 엄격히 높은 우선순위로의 상향(신고당 최대 2회)이
  여러 pass의 결과를 수렴시킨다. 상향 이동은 원자적이다 — 새 그룹 상한 초과, key 충돌, 예산 초과면 이동 전체를
  취소하고, 옛 그룹 정리가 실패하면 transaction 전체가 rollback된다. 사람이 보던 후보가 옮겨 가면 결정 route는
  `group_moved`로 거절하고 새 그룹을 가리킨다.
- **pass당 상향 이동 예산 `PROMOTION_MOVES_PER_PASS_MAX = 50`.** 배치 안 후보를 (kind 우선순위 내림차순,
  `groupCandidateKey` 오름차순)으로 정렬해 누적 이동 수가 남은 예산 이하인 접두사만 받아들인다. 실제 이동 행 수를
  다음 배치의 남은 예산에서 뺀다.
- **수용하는 표시 손실 세 경우**: (1) 같은 우선순위끼리의 순서 의존, (2) 멤버 상한에 막힌 후보, (3) 이동 예산
  초과로 취소된 상향. 셋 다 그룹 표시만 잃으며 신고 자체·메일·상태에는 효과가 없다. 각각 digest에서 센다.
- 그룹 key 재검사의 연속 평가 연기는 **3회**에 닿으면 그룹을 자동 무효화한다("연속 실행"이 아니라 "연속 평가").
- 결정은 입력 digest와 멤버 집합에 결속되고 조건부 갱신으로 한 번만 기록된다. 결정마다
  `SupportTriageDecisionRecord` 한 행과 참여한 모든 신고의 link 행이 같은 transaction에서 생기며, 그 digest는 서버
  keyring의 current 키로 만든 HMAC이다. 원시 `inputDigest`나 본문 유도 SHA를 보존 기록에 남기지 않는다.

## 7. 감사와 침묵 감지

- triage 테이블에 쓰는 모든 것이 전이 enum에 있고 감사된다. 감사 제외 목록은 비어 있다. mutation은 recorder를
  통해서만 도달하고 recorder는 셋뿐이다 — 시스템 transaction(`writeSystemAuditLog` 1행), admin transaction
  (`writeAdminAuditLog({ tx })` 1행), 계정 삭제 recorder(그 transaction의 마지막 문장). 세 mode의 전이 집합은
  서로소다. 감사 테이블에 직접 쓰지 않는다. 감사 행에는 불투명 id와 결정 enum만 들어간다.
- digest는 팀 3의 공통 `AgentDigestItem` 하나에만 들어가고 단일 writer는 팀 3 공통 계약이 정한 digest store 하나다(아직 구현되지 않았고, 그 배포가 P1 착수 조건이다).
  `kind = daily_digest`, 멱등 키 접두사 `support-triage:`, UTC 날짜당 한 항목. payload는 정수·enum·boolean과
  `date` 문자열 하나뿐이고 팀 3 공통 계약의 bounded schema 규칙을 따른다. 시점값을 넣지 않는다.
- **heartbeat retention 세 조건**: (1) liveness — 기대 주기 30분, 임계 80분, (2) progress 단발 — 최근 종료 행이
  `batchesCompleted = 0 AND overdueRemaining > 0`, (3) progress 기한 — `oldestOverdueAgeSeconds > 86,400`.
  worker에도 liveness 조건이 있다.
- 실패한 구성요소가 자기 침묵을 보고하지 않도록, heartbeat를 부르는 것은 팀 3 감시자이고 이 Agent는 자체
  checker·자체 경보를 만들지 않는다.

## 8. 수치 상한과 감사량

| 항목 | 값 | 무엇이 지는가 |
|---|---|---|
| `SupportTriageRun` UTC 날짜당 회차 | worker 52 · retention 52(예정 48 + 수동 여유 4) | **DB**: BEFORE INSERT trigger가 `(kind, UTC 날짜)` advisory 잠금 뒤 센다. 날짜와 `createdAt`은 한 timestamp에서 유도 |
| suggestion 생성 | 하루 2,600 | 회차 DB × pass당 50 앱 |
| 그룹 멤버십 | 하루 5,200 | 회차 DB × pass당 100(pass 몫 50 + 이동 예산 50) 앱 |
| 그룹 | 하루 2,600 | 멤버 2 이상 |
| 그룹 신호 행 | 하루 **31,200** | pass당 건드리는 그룹 ≤ 200 × 그룹당 ≤ 3(`(groupId, kind)` unique DB) × 52 |
| 회차당 retention 배치 | 8 | 앱 계수기, 종료 행 CHECK는 증인 |
| 감사(시스템) | **유도 상한 연 455,520행** = worker `13 × 52 × 365`(246,740) + retention `11 × 52 × 365`(208,780). 회차당 감사는 worker 13, retention 최대 11(시작 1 + digest 1 + 배치 8 + 종료 1). **기대값 연 286,160행** = worker `13 × 48 × 365`(227,760) + retention `(48 × 2 + 1 + 63) × 365`(58,400). retention 기대값은 회차 수 × 11이 아니라, 예정 48회의 시작·종료 감사 96 + digest 1(같은 날 두 번째부터는 `replayed`라 감사 없음) + 그날 실제로 필요한 배치 수(정상 크기 63)다 | 회차 수 DB × 회차당 감사 수 앱 |
| 감사(사람 결정·계정 삭제) | 상한 없음, 합산하지 않음 | 운영 추정 사람 결정 20/일 |

일부가 애플리케이션 값이므로 위 수치는 "강제 상한"이 아니라 "유도 상한"이다. `AdminAuditLog`는 지울 수
없으므로 이 영구 증가량을 운영자가 수용했다(X3).

## 9. 단계와 착수 조건

| 단계 | 내용 | 착수 조건 |
|---|---|---|
| P0a | 이 정책의 승인·병합 | — |
| P0b | 구조 경계: adapter·정적 검사·삭제 manifest와 파생 테스트·감사 content-negative 테스트·timeout wrapper와 그 16/17 테스트·회차 상한 trigger·보존 회차·heartbeat 판정. flag는 모두 꺼진 상태 | 0절 판정 통과. 이 단계의 migration·삭제 계약은 `contract` 역할로 한다 |
| P0c | 두 Railway 서비스 IaC apply(운영자), heartbeat·run·retention route 배포, 독립 감시 drill | P0b. P0b가 측정한 값이 수용 기준 이하임을 기록하고 운영자가 수용 |
| P1 | `SUPPORT_TRIAGE_ENABLED`: 저장만, 인박스에 숨김. 표본 판정 목록만 표시 | P0c와 retention staging 부하 시험 통과(5절 (1)), 팀 3 공통 digest store·제출 경로·공통 Agent digest 영역의 배포, **Q15(7팀 합산 owner-bound 상한과 계수 방식)와 Q16(팀 3이 감시자 감시·heartbeat page 키·caller actor 계약을 제공)의 운영자 결정** — 지금은 미결이며 결정 전에는 P1을 시작하지 않는다 |
| P1.5 | synthetic suggestion만으로 "보기 → 적용 → confirm" E2E | P0b, 템플릿 문구 승인 |
| P1d | `SUPPORT_TRIAGE_DISPLAY_ENABLED`: 제안 표시 | P1의 30일·표본 30건 이상·lane 일치율 80% 이상·사람 lane 누락 0, retention production 7일 관측 통과(5절 (2)), P1.5 |

- 발송 자동화 단계와 LLM 단계는 없다. 각 단계는 flag 제거로 즉시 이전 단계로 돌아가며, 외부로 나간 데이터가
  없으므로 되돌릴 수 없는 단계가 없다.
- 7절의 독립 감시가 동작하지 않는 동안에는 `SUPPORT_TRIAGE_ENABLED`를 켜지 않는다.
- 다음 단계 조건의 충족 판정과 flag 전환은 사람이 한다.
