# 재인증 안내에 갈 곳이 없는 admin 패널 (2026-08-23)

428 `ADMIN_REAUTHENTICATION_REQUIRED`는 **관리자 본인의 로그인이 오래됐다**는
뜻이고, 고치는 방법은 재시도가 아니라 다시 로그인하는 것입니다. 대부분의
패널이 그 사실을 화면에 말한 뒤 **갈 곳을 주지 않습니다.**

`227be331` 회차의 production 후속 확인에서 retention 패널을 밟으며 발견했고,
그 패널은 이 기록과 같은 변경으로 고쳤습니다. 남은 목록을 남기는 이유는,
"모든 admin 경로가 같다"는 문장만으로는 다음 사람이 다시 세어야 하기
때문입니다.

## 이미 있는 것

부품은 전부 있습니다. 없던 것은 **채택**뿐입니다.

- `lib/adminApiOutcome.ts` — `describeAdminApiFailure()`가 428을 분류하고
  `requiresReauthentication: true`를 돌려줍니다
- `lib/adminReauthenticationCore.ts` — `adminRecentAuthenticationHref()`가
  step-up URL을 만듭니다. console session은 아직 유효하므로 세션 만료 URL이
  아니라 이쪽이며, 끝나면 원래 화면으로 되돌아옵니다
- `components/admin/AdminUserSecurityControls.tsx` — 링크를 실제로 그리는
  선례

## 조사 (2026-08-23)

`/api/admin/**`에 POST·PATCH·PUT·DELETE를 보내는 client 패널 28개.

| 상태 | 수 | 패널 |
|---|---|---|
| 링크 있음 | 3 | `AdminUserSecurityControls`, `PlatformSettingsPanel`, `AdminRetentionPanel`(이 변경) |
| 분류만, 링크 없음 | 3 | `AdminNotesBox`, `AdminUsersPanel`, `RefundRequestsPanel` |
| 아무것도 없음 | 22 | `AdminAlertPolicyPanel`, `AdminApprovalsPanel`, `AdminEmailPolicyPanel`, `AdminInfrastructurePanel`, `AdminMemoryRevocationPanel`, `AdminModelDiscoveryPanel`, `AdminModelRegistryPanel`, `AdminNotificationsPanel`, `AdminOperationalReadinessPanel`, `AdminOperatorAlertProbePanel`, `AdminPrivacyRequestsPanel`, `AdminProviderHealthPanel`, `AdminProviderOpsPanel`, `AdminProviderUsageSyncPanel`, `AdminReportsPanel`, `AdminSlackTemplatesPanel`, `AdminSnapshotActions`, `AdminUserDeleteButton`, `AdminWebhookPanel`, `BillingAdminPanel`, `FeedbackInboxPanel`, `PromotionDiagnosticsPanel` |

**`AdminUserDeleteButton`이 목록에 있는 것이 이 문제의 크기를 말합니다** —
되돌릴 수 없는 작업이고, 재인증을 가장 확실히 요구하는 경로입니다.

## 왜 나머지를 한꺼번에 고치지 않았는가

**분류만 하는 3개는 한 줄이면 됩니다** — 이미 `AdminApiFailure`를 들고 있으니
링크를 그리기만 하면 됩니다.

**나머지 22개는 한 줄이 아닙니다.** 대부분 `catch`에서 평범한 `Error`를
받으므로 **status와 code를 이미 버린 뒤**입니다. 428인지 알 수 없는 자리에서
428을 다룰 수 없고, 고치려면 각 패널의 오류 경로를 다시 짜야 합니다. 읽어 본
적 없는 패널 22개의 오류 처리를 한 번에 바꾸는 것은 이 결함이 만드는 위험보다
큽니다.

## 두 가지 방향, 그리고 그것이 왜 사람의 결정인가

**A. 패널마다 채택.** 22개의 오류 경로를 손보고 링크를 그립니다. 정확하지만
작업량이 크고, 각 패널의 회귀 위험을 개별로 집니다.

**B. shell이 먼저 말한다.** `app/(site)/(application)/admin/layout.tsx`가
세션의 `authenticatedAt`을 이미 볼 수 있으므로, step-up 창이 만료됐으면
console 전체에 배너를 띄울 수 있습니다. **한 파일이고, 누르기 전에 보이며,
28개 패널을 전부 덮습니다.**

B가 기술적으로 우월해 보이지만 **제품 결정입니다** — step-up 창은 짧고(최대
240분, 기본은 그보다 훨씬 짧습니다), 읽기 전용 화면만 보는 운영자에게도
배너가 상시로 뜹니다. 모든 admin 화면의 생김새가 바뀌는 변경을 결함 수정으로
슬쩍 끼워 넣지 않습니다.

정해지기 전까지 남은 25개는 이 상태로 있습니다. 이 기록이 그 목록입니다.
