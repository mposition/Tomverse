# Admin Console 1인 단독 승인

Status: active (2026-09-15 결정). 구현은 `lib/adminApproval.ts`의
`runWithAdminApproval()`, 판정은 `lib/adminSoleApproverCore.ts`, 실행과 감사
기록은 `lib/adminSoleApproverExecution.ts`입니다. 테스트는
`tests/adminSoleApprover.test.mjs`(판정)와
`tests/integration/admin-security.db.test.ts`(DB 배선)입니다.

## 1. 결정

**권한 있는 관리자가 한 명뿐인 동안, 그 관리자는 2인 승인 대상 작업을 혼자
실행할 수 있습니다.** 두 번째 검토자가 하던 통제는 감사 로그가 대신합니다.

이전 규칙은 `requestedById !== reviewerId`를 무조건 요구했습니다. Tomverse는
1인 조직이므로 이 규칙은 엄격한 것이 아니라 **충족 불가능**했고, 수동 플랜
조정·기준액 이상 환불·계정 삭제 같은 요청은 존재하지 않는 검토자를 기다리며
만료됐습니다(예: `docs/ops/staging-verification-records/2026-08-16__62987e9891c55f641cb89e1266550018b82e1c50.md`
발견-17의 `user.delete`). 문제가 생겼을 때 사후에 추적하는 수단은 감사 로그이며,
이 결정은 1인 조직에서 그것을 충분한 통제로 받아들입니다.

같은 판단이 이미 두 곳에 기록돼 있습니다 — 릴리스 게이트 registry의
`approvalPolicy.soleApproverAllowed`(`docs/release-gates/tomverse-chat-v1.yaml`)와
이메일 승인 규칙의 1인 조직 예외(`docs/policy/email-notifications.md` §12.3).
이 문서는 그 판단을 Admin Console의 모든 2인 승인 작업으로 넓힙니다.

## 2. 적용 대상

`runWithAdminApproval()`을 거치는 모든 action입니다. 2026-09-15 기준:

| action | 화면 | 판정 권한 |
|---|---|---|
| `user.plan_adjust` | 사용자 관리 · 수동 플랜 조정 | `billing:write` |
| `billing_risk.release_hold` | 사용자 관리 · 결제 위험 보류 해제 | `billing:write` |
| `refund.approve` | 환불 요청 · 기준액 이상 승인 | `billing:write` |
| `credit_purchase.refund` | 크레딧 구매 · 기준액 이상 환불 | `billing:write` |
| `user.delete` | 사용자 관리 · 영구 삭제 | `user:delete` |
| `user.unlink_oauth` | 사용자 보안 · OAuth 연결 해제 | `ops:write` |
| `model.disable` | 모델 레지스트리 · 비활성화 | `ops:write` |
| `model.archive` | 모델 레지스트리 · 카탈로그에서 제거 | `ops:write` |
| `email_suppression.remove` | 이메일 억제 목록 · hard bounce/complaint 해제 | `ops:write` |
| `email_policy.activate` | 관할권 정책 활성화 | `ops:write` |
| `retention.cleanup.execute` | 데이터 보존 · 정리 실행 | `ops:write` (§4 결속) |
| `email_campaign.approve` | 이메일 캠페인 승인 | `ops:write` (§4 결속) |

새 action이 `runWithAdminApproval()`을 쓰면 별도 등록 없이 같은 규칙을 따릅니다.

## 3. 조건

1. **정확히 한 명.** 설정(`ADMIN_EMAILS`, `ADMIN_<ROLE>_EMAILS`,
   `ADMIN_ACCESS_EXPIRY_JSON`)에서 활성·미만료이고 **그 action이 요구하는 권한**
   (`approvalPermissionForAction()`)을 가진 관리자를 셉니다. 검토자가 가져야 하는
   권한과 같은 권한입니다.
   **`ADMIN_USER_IDS`로 허용된 관리자는 역할과 관계없이 셉니다.** ID 관리자는
   세션 이메일이 역할 목록에 있을 때 그 역할을 얻는데, 설정만으로는 그 이메일을
   알 수 없어 행이 `readonly`로 보입니다. 빼면 두 명을 한 명으로 셀 수 있으므로
   fail-closed로 셉니다. 요청자 자신의 ID는 요청자와 같은 사람으로 합칩니다.
2. **요청자가 그 한 명.** 다른 관리자의 세션으로는 열리지 않습니다.
3. **최근 재인증.** 기존과 같이 `assertRecentAdminAuthentication()`이 먼저
   통과해야 합니다.
4. **두 번째 관리자가 생기면 자동으로 2인 승인으로 돌아갑니다.** 판정은 매
   요청마다 설정에서 다시 계산하며, 저장된 "1인 모드" 플래그가 없습니다. 끄는
   것을 기억할 필요가 없고, 되돌리는 방법은 관리자를 한 명 더 설정하는 것입니다.
   두 명 이상이면 409 응답의 `soleApproverUnavailable`이 이유를 말합니다.
5. **감사 로그가 먼저입니다.** `admin_sole_approver.execution_started`를 쓰지
   못하면 작업을 실행하지 않습니다. 성공은 `admin_sole_approver.executed`, 실패는
   `admin_sole_approver.execution_failed`로 남습니다.

## 4. 결속이 있는 두 작업은 그대로입니다

`retention.cleanup.execute`와 `email_campaign.approve`(`SOLE_APPROVER_ACTIONS`)는
2026-08-23과 D5 결정에서 이미 1인 경로가 있었고, 그 경로는 **관리자가 본 것에
결속**돼 있습니다 — dry run의 digest, 읽은 카피의 digest. 일반 경로는 그 증명이
없으므로 이 둘을 대신하지 않습니다(`decideGeneralSoleApproval()`의
`action_has_bound_path`). 결속 없이 들어온 요청은 기존처럼 대기열로 갑니다.

## 5. 감사 기록에 남는 것

`admin_sole_approver.*` 행의 metadata:

- `action`, `rule: "general_sole_administrator"`, `eligibleApproverCount: 1`
- `payloadHash` — 2인 승인이었다면 승인이 결속됐을 바로 그 요청 본문의 hash
- `reason` — 관리자가 쓴 사유
- 실패 시 `error`

**payload 자체는 복사하지 않습니다.** 변경 전후 값은 각 route의 감사 행
(`user.plan_adjusted`의 before/after, `user.deleted`, `credit_purchase.refunded`
등)에 이미 있고, 두 번째 사본은 거기 담긴 개인정보를 반복할 뿐입니다. 같은
요청의 두 행은 actor·target·시각으로 대응됩니다.

**`AdminActionApproval` 행을 만들지 않습니다.** 아무도 승인하지 않았으므로,
행이 있으면 누군가 승인한 것처럼 읽힙니다. 승인 대기열에는 2인 승인 경로의
요청만 나타납니다.

## 6. 바뀌지 않는 것

- 승인 API(`PATCH /api/admin/approvals`)는 여전히 자기 요청을 승인할 수 없습니다.
  1인 경로는 승인이 아니라 실행이며, 두 경로를 섞지 않습니다.
- 권한 검사, rate limit, 확인 문구(`ADJUST PLAN` 등), 사유 필수, 환불 기준액
  (`ADMIN_REFUND_APPROVAL_THRESHOLD_CENTS`)은 그대로입니다.
- 자기 요청을 자기 승인으로 처리하는 경로는 여전히 없습니다.
- **1인 실행은 같은 요청의 열린 2인 승인 행을 닫습니다.** 요청자가 같고 action ·
  대상이 같으며(일반 경로는 payload hash까지 같은) `pending`·`approved` 행은
  `execution_started` 감사 행과 **같은 transaction**에서 `expired`로 바뀌고, 그
  id가 `supersededApprovalIds`에 남습니다. 소비가 아니라 만료인 것은 그 승인으로
  실행된 것이 없기 때문이며, 닫지 않으면 두 번째 관리자가 돌아온 뒤 같은 승인으로
  한 번 더 실행될 수 있습니다. 결속된 두 경로(§4)도 같은 정리를 합니다.
  이 정리와 일반 경로의 승인 claim은 요청자·action·대상 단위 advisory lock을
  함께 잡으므로 서로 끼어들지 않습니다. 같은 변경의 승인이 이미 `executing`이면
  1인 실행은 `approval_executing`으로 거절됩니다.

## 6.1 알려진 한계

1인 경로에는 승인 행의 단일 소비 claim이 없습니다. **완전히 같은 요청이 동시에
두 번** 들어오면 둘 다 실행될 수 있습니다(예: 플랜 조정 DB 갱신과 안내 메일
두 번). 성공 후 마지막 감사 쓰기만 실패해 500이 난 뒤 재시도한 경우도
같습니다. 이 한계를 받아들인 근거는 다음과 같습니다.

- 모든 route가 관리자별 rate limit과 확인 입력을 거칩니다.
- 되돌릴 수 없는 작업은 이미 멱등입니다 — 환불은 Stripe idempotency key를
  쓰고, 계정 삭제의 두 번째 실행은 대상이 없어 실패합니다.
- 두 실행 모두 감사 로그에 남으므로 사후에 발견됩니다.

실행 receipt(스키마 추가)로 막을 수 있으며, 필요해지면 별도 변경으로 합니다.

## 7. 되돌리는 법

두 번째 책임자가 생기면 설정에 추가하는 것으로 충분합니다(§3-4). 1인 조직에서도
이 예외를 없애야 한다면 `runWithAdminApproval()`의 일반 경로 분기를 제거하고 이
문서의 Status를 바꿉니다.
