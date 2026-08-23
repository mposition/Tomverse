# 단독 관리자 실행 — production 첫 관측 (2026-08-23)

`retention.cleanup.execute`의 단독 관리자 경로가 production에서 실제로 열리는
것을 처음 확인했습니다. **다른 어디에서도 관측할 수 없는 한 가지**를 남기려고
쓰는 기록입니다.

## 왜 이 기록이 따로 필요한가

메커니즘은 CI가 증명합니다 — 순수 판정 19건(`tests/adminSoleApprover.test.mjs`)과
실제 PostgreSQL 배선 4건(`tests/integration/admin-security.db.test.ts`). **CI가
증명할 수 없는 것은 하나뿐입니다: 실제 production 설정에서 경로가 열리는가.**

그리고 그것은 staging에서도 관측할 수 없습니다. staging의
`ADMIN_OWNER_EMAILS`는 주소 둘을 담고 있어 조건 1(적격 관리자 정확히 1명)이
성립하지 않으며, 그래서 경로가 **정상적으로** 닫혀 있습니다. production은
하나입니다. 두 환경의 admin 설정이 다른 것이지 결함이 아니고, 그 차이가
이 관측을 production에서만 가능하게 만듭니다.

체크리스트를 새로 만들지 않은 이유는 저장소 규칙 그대로입니다 — 항목을 늘리기
전에 "이것을 CI가 증명하지 못하는 이유가 무엇인가"를 먼저 묻습니다. 답이
한 문장이면 그 한 문장이 있을 자리는 감사 기록이지 template이 아닙니다.

## 실행 환경

| 항목 | 값 |
|---|---|
| 환경 | production |
| 배포 SHA | `ea5bf48565a52e00010a6fe8aa9ac3a2153367ad` |
| 배포 완료 (UTC) | 2026-08-23T09:34:44Z |
| Railway deployment id | `36869b7d-3f47-4a85-9dc2-fd0a21f17935` |
| 이 경로를 담은 PR | #814 (#788·#786·#797·#798·#810·#812 cherry-pick) |
| 적격 관리자 (`ops:write`, 활성) | **1** — `/admin/admin-access`에서 확인 |
| 실행자 | mposition |

## 관측

| 단계 | 결과 | 무엇이 확정되는가 |
|---|---|---|
| 1. `Dry run` | pass | 결과가 **화면에 표시**된다(이전에는 toast만 떴다). `assistantKnowledge` 7개 필드가 설계대로 나온다 |
| 2. `Execute cleanup` | pass | **승인 요구 없이 실행됐다.** 조건 1(적격자 1명)·2(digest 결속)·3(15분 이내)이 모두 통과했다는 뜻이다 — 하나라도 어긋나면 거절되거나 승인 요구로 간다 |
| 3. preview 없이 재실행 | pass | **거절**: `Run a dry run before executing.` preview digest가 두 번째 검토자를 실제로 대신한다 |
| audit `admin_sole_approver.execution_started` | pass | 존재하고, 최신순 목록에서 `executed` **아래**에 있다 — 즉 **먼저** 쓰였다. 삭제 전에 durable intent가 남는다는 조건 5의 순서가 관측됐다 |
| audit `admin_sole_approver.executed` | pass | 요약이 `Executed retention.cleanup.execute as the sole eligible administrator.` |
| `eligibleApproverCount: 1` metadata | 미기록 | 행은 확인했으나 metadata 본문을 열어 보지 않았다. 나중에 채우지 않는다 |

**3단계가 이 회차의 이유입니다.** 2단계는 경로가 열린다는 것만 말하고, 3단계가
결속이 작동한다는 것을 말합니다. 그것이 없으면 이 기능은 self-approval입니다.

### dry-run이 보고한 것 (09:40Z)

```
scheduledJobRuns   41
providerErrorEvents 1
assistantKnowledge  pendingTombstones 0 / retryable 0 / exhausted 0 /
                    oldestPendingAt null / executionLimit 200 /
                    truncated false / orphanScan not_run
그 밖 전부          0
```

knowledge가 0인 것은 정상입니다 — production은 `assistantKnowledgeEnabled`가
꺼져 있고 tombstone이 만들어진 적이 없습니다. **이 항목은 flag와 무관하게 큐를
세므로**, 0이라는 사실 자체가 관측입니다.

`storageCleanupQueues`도 나란히 0인 것이 이 필드를 추가한 이유를 그대로
보여줍니다. 예전에는 저 숫자 하나가 knowledge에 대해 말하는 전부였고, 저것은
**R2에서 지울 바이트 수가 아니라 이미 지워진 뒤 GC되는 행의 수**입니다.

## 계획에 없던 관측

**실행이 두 번 있었습니다.** `AdminRetentionRun` id가 다릅니다 —
09:42Z `cmt5mco19000y02pi4m4kgn4u`, 09:44Z `cmt5mek7t001402pid0okgfzt`.
두 번째는 대상이 이미 비어 있었을 것이므로 무해하며, 단독 경로가 **재현된다**는
증거이기도 합니다. 있는 그대로 적습니다.

**production cron은 15분 주기로 살아 있습니다.** 09:31:31Z에
`Credit Reconciliation` 컨테이너가 떴습니다(09:30 트리거 + 부팅 ~90초).
다만 **이것으로 knowledge drain이 돌았다고 말할 수는 없습니다** — flag가 꺼져
있어 결과가 0이고, runner가 `result.result`만 로그하므로 knowledge 숫자는
애초에 보이지 않습니다(#797 회차 발견 사항 1). 15분 경로에 실렸다는 증명은
`tests/knowledgeSweepCadence.test.mjs`의 소스 단언과 staging `227be331`
회차의 R2 관측이 담당합니다.

## 미해결

**재인증이 필요할 때 로그인으로 가는 수단이 없습니다.** 이 회차에서 처음
밟았습니다 — `Sign in again before performing this high-risk administrator
action.` toast만 뜨고 아무 데도 보내지 않습니다.

이 변경들 이전부터 있던 것이고 `runWithAdminApproval`을 쓰는 **모든** admin
경로가 같은 상태입니다(계정 삭제·환불·플랜 조정 등). 그래서 고칠 자리는 이
패널 하나가 아니라 **428 `ADMIN_REAUTHENTICATION_REQUIRED`를 공통으로 처리하는
지점**입니다.
