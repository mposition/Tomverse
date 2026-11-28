import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for Plans & pricing > Plan changes (`/admin/billing?tab=plan-changes`):
 * the customer-initiated Pro <-> Max changes that are in flight, and the ones
 * settled recently (`AdminPlanChangesPanel`).
 */
export const adminPlanChangesMessages = defineAdminMessages({
  en: {
    pendingTitle: "In flight",
    pendingDetail:
      "Scheduled downgrades apply at the period end; upgrades apply once their invoice is paid. Customers cancel a scheduled downgrade from Settings > Plan.",
    recentTitle: "Settled in the last 30 days",
    emptyPending: "No plan change is in flight.",
    emptyRecent: "No plan change settled in the last 30 days.",
    readFailedTitle: "Plan changes could not be read",
    readFailedDetail: "Nothing was changed. Reload the page to try again.",
    caption: "Plan changes",
    columns: {
      account: "Account",
      change: "Change",
      interval: "Billing",
      status: "Status",
      appliesAt: "Applies",
      confirmedAt: "Confirmed",
      settledAt: "Settled",
    },
    execution: {
      immediate_upgrade: "Upgrade (on payment)",
      scheduled_downgrade: "Downgrade (at period end)",
    },
    interval: { monthly: "Monthly", annual: "Annual" },
    status: {
      pending: "Pending",
      applied: "Applied",
      cancelled: "Cancelled",
      failed: "Failed",
    },
    renewalResumed: "Renewal resumed with consent",
    truncated: (limit: number) => `Showing the first ${limit} rows only.`,
    notSet: "—",
  },
  ko: {
    pendingTitle: "진행 중",
    pendingDetail:
      "예약된 다운그레이드는 결제기간 끝에, 업그레이드는 청구서가 결제되면 적용돼요. 예약 취소는 고객이 설정 > 플랜에서 해요.",
    recentTitle: "최근 30일 처리",
    emptyPending: "진행 중인 플랜 변경이 없어요.",
    emptyRecent: "최근 30일 동안 처리된 플랜 변경이 없어요.",
    readFailedTitle: "플랜 변경을 읽지 못했어요",
    readFailedDetail: "바뀐 건 없어요. 페이지를 새로 고쳐서 다시 시도해 주세요.",
    caption: "플랜 변경",
    columns: {
      account: "계정",
      change: "변경",
      interval: "결제 주기",
      status: "상태",
      appliesAt: "적용 시점",
      confirmedAt: "확정",
      settledAt: "처리",
    },
    execution: {
      immediate_upgrade: "업그레이드(결제 시)",
      scheduled_downgrade: "다운그레이드(기간 말)",
    },
    interval: { monthly: "월간", annual: "연간" },
    status: {
      pending: "대기",
      applied: "적용됨",
      cancelled: "취소됨",
      failed: "실패",
    },
    renewalResumed: "동의 후 갱신 재개",
    truncated: (limit: number) => `앞의 ${limit}건만 보여요.`,
    notSet: "—",
  },
});
