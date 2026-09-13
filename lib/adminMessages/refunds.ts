import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the refund review queue on `/admin/refunds`. */
export const adminRefundsMessages = defineAdminMessages({
  en: {
    eyebrow: "Refunds",
    title: "Cancellation and refund requests",
    description:
      "Review customer refund requests, cancel Stripe subscriptions, reset paid membership to Free, and send transactional email updates.",
    rowLimit: (limit: number) =>
      ` Showing the ${limit} most recent requests; the status counts describe those requests only.`,
    pendingBadge: (count: number) => `${count} pending`,
    exportCsv: "Export CSV",
    filters: {
      pending: (count: number) => `Pending ${count}`,
      approved: (count: number) => `Approved ${count}`,
      rejected: (count: number) => `Rejected ${count}`,
      all: (count: number) => `All ${count}`,
    },
    counters: {
      pending: "Pending",
      approved: "Approved",
      rejected: "Rejected",
    },
    empty: "No refund requests match the current filter.",
    unknownPlan: "Unknown plan",
    requested: (date: string) => `Requested ${date}`,
    noEmail: "No email",
    noReason: "No reason provided.",
    details: {
      stripeCustomer: (value: string) => `Stripe customer: ${value}`,
      subscription: (value: string) => `Subscription: ${value}`,
      status: (value: string) => `Status: ${value}`,
      billing: (value: string) => `Billing: ${value}`,
      periodEnd: (value: string) => `Period end: ${value}`,
      stripeRefund: (value: string) => `Stripe refund: ${value}`,
      refundStatus: (value: string) => `Refund status: ${value}`,
      refundAmount: (value: string) => `Refund amount: ${value}`,
      reviewed: (value: string) => `Reviewed: ${value}`,
    },
    adminNote: (note: string) => `Admin note: ${note}`,
    creditRisk: {
      title: "Credit balance and cost review required",
      purchases: (count: number) => `${count} credit-pack purchases`,
      remaining: (credits: string, usd: string) =>
        `Remaining: ${credits} credits / $${usd}`,
      estimatedConsumed: (credits: string, usd: string) =>
        `Estimated consumed: ${credits} credits / $${usd}`,
      unrecovered: (credits: string, usd: string) =>
        `Unrecovered: ${credits} credits / $${usd}`,
      billingRisk: (status: string) =>
        `Billing risk: ${status}. Verify the refundable balance and consumed AI cost before approving.`,
      confirm:
        "I reviewed purchased credit balance, used credits, and funded AI cost.",
    },
    timeline: "Timeline",
    timelineMeta: (date: string, actor: string | null) =>
      `${date} UTC / ${actor || "system"}`,
    notePlaceholder: "Optional note for the customer email",
    approve: "Approve",
    reject: "Reject",
    toasts: {
      notUpdated: "The refund request was not updated.",
      rejected:
        "Refund request rejected. The subscription and plan were left unchanged.",
      connectionFailed:
        "The refund request was not updated. Check the connection and retry.",
    },
  },
  ko: {
    eyebrow: "환불",
    title: "해지 및 환불 요청",
    description:
      "고객 환불 요청을 검토하고, Stripe 구독을 해지하고, 유료 멤버십을 Free로 되돌리고, 거래 알림 이메일을 발송합니다.",
    rowLimit: (limit: number) =>
      ` 최근 요청 ${limit}건만 표시하며, 상태별 개수도 이 요청들에 대한 값입니다.`,
    pendingBadge: (count: number) => `대기 ${count}건`,
    exportCsv: "CSV 내보내기",
    filters: {
      pending: (count: number) => `대기 ${count}`,
      approved: (count: number) => `승인 ${count}`,
      rejected: (count: number) => `거절 ${count}`,
      all: (count: number) => `전체 ${count}`,
    },
    counters: {
      pending: "대기",
      approved: "승인",
      rejected: "거절",
    },
    empty: "현재 필터에 맞는 환불 요청이 없습니다.",
    unknownPlan: "알 수 없는 플랜",
    requested: (date: string) => `요청 ${date}`,
    noEmail: "이메일 없음",
    noReason: "사유가 입력되지 않았습니다.",
    details: {
      stripeCustomer: (value: string) => `Stripe 고객: ${value}`,
      subscription: (value: string) => `구독: ${value}`,
      status: (value: string) => `상태: ${value}`,
      billing: (value: string) => `결제 주기: ${value}`,
      periodEnd: (value: string) => `기간 종료: ${value}`,
      stripeRefund: (value: string) => `Stripe 환불: ${value}`,
      refundStatus: (value: string) => `환불 상태: ${value}`,
      refundAmount: (value: string) => `환불 금액: ${value}`,
      reviewed: (value: string) => `검토: ${value}`,
    },
    adminNote: (note: string) => `관리자 메모: ${note}`,
    creditRisk: {
      title: "크레딧 잔액 및 비용 검토 필요",
      purchases: (count: number) => `크레딧 팩 구매 ${count}건`,
      remaining: (credits: string, usd: string) =>
        `남은 잔액: ${credits} 크레딧 / $${usd}`,
      estimatedConsumed: (credits: string, usd: string) =>
        `추정 사용량: ${credits} 크레딧 / $${usd}`,
      unrecovered: (credits: string, usd: string) =>
        `미회수: ${credits} 크레딧 / $${usd}`,
      billingRisk: (status: string) =>
        `결제 위험: ${status}. 승인하기 전에 환불 가능 잔액과 소비된 AI 비용을 확인하세요.`,
      confirm:
        "구매한 크레딧 잔액, 사용한 크레딧, 충당된 AI 비용을 검토했습니다.",
    },
    timeline: "타임라인",
    timelineMeta: (date: string, actor: string | null) =>
      `${date} UTC / ${actor || "시스템"}`,
    notePlaceholder: "고객 이메일에 넣을 메모(선택)",
    approve: "승인",
    reject: "거절",
    toasts: {
      notUpdated: "환불 요청을 업데이트하지 못했습니다.",
      rejected: "환불 요청을 거절했습니다. 구독과 플랜은 변경되지 않았습니다.",
      connectionFailed:
        "환불 요청을 업데이트하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.",
    },
  },
});
