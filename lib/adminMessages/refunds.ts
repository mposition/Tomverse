import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the refund review queue on `/admin/refunds`. */
export const adminRefundsMessages = defineAdminMessages({
  en: {
    exportCsv: "Export CSV",
    rowLimit: (limit: number) =>
      `Showing the ${limit} most recent requests. The numbers on the tabs and on the right count only these requests.`,
    filtersLabel: "Filter requests by status",
    filters: {
      pending: (count: number) => `Pending ${count}`,
      approved: (count: number) => `Approved ${count}`,
      rejected: (count: number) => `Rejected ${count}`,
      all: (count: number) => `All ${count}`,
    },
    empty: {
      title: "No refund requests on this tab",
      detail: "Requests that match the tab show up here.",
    },
    readFailed: {
      title: "Could not read the refund requests",
      detail:
        "Nothing is shown because the read failed, not because the queue is empty. Reload the page to try again.",
    },
    unknownPlan: "Unknown plan",
    noEmail: "No email",
    noReason: "The customer did not give a reason.",
    interval: { monthly: "Monthly", yearly: "Yearly" },
    requested: (date: string) => `Requested ${date}`,
    status: {
      pending: "Waiting",
      processing: "Processing",
      approved: "Approved",
      rejected: "Rejected",
    },
    waiting: (days: number) =>
      days === 0 ? "Requested today" : days === 1 ? "Waiting 1 day" : `Waiting ${days} days`,
    stats: {
      amountPending: "Amount to refund",
      amountDone: "Amount refunded",
      amountPendingDetail: "Set from the latest Stripe payment when you approve.",
      creditsUsed: "Credits used since purchase",
      creditsUsedDetail: (used: string, purchased: string) =>
        `${used} of ${purchased} credit-pack credits`,
      noPurchases: "No credit-pack purchases",
      creditsLeft: "Unspent pack credits",
      creditsLeftDetail: (usd: string) => `Funded cost $${usd}`,
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
    requestedEvent: "Refund requested",
    timelineMeta: (date: string, actor: string | null) =>
      `${date} / ${actor || "system"}`,
    technical: {
      summary: "Stripe and subscription IDs",
      stripeCustomer: (value: string) => `Stripe customer: ${value}`,
      subscription: (value: string) => `Subscription: ${value}`,
      subscriptionStatus: (value: string) => `Status: ${value}`,
      periodEnd: (value: string) => `Period end: ${value}`,
      stripeRefund: (value: string) => `Stripe refund: ${value}`,
      stripeCharge: (value: string) => `Stripe charge: ${value}`,
      requestId: (value: string) => `Request: ${value}`,
    },
    refundStatus: (value: string) => `Refund status: ${value}`,
    reviewed: (value: string) => `Reviewed: ${value}`,
    notePlaceholder: "Optional note for the customer email",
    approve: "Approve",
    reject: "Reject",
    confirmApprove: {
      title: "Approve this refund?",
      customer: (email: string) => `Customer: ${email}`,
      amount: "Amount: what is left of the latest Stripe payment.",
      creditsLeft: (credits: string) => `Unspent credit-pack credits: ${credits}`,
      effects: {
        refund: "Stripe refunds what is left of the customer's latest payment.",
        cancel: "The Stripe subscription is cancelled.",
        free: "The account goes back to Free.",
        email: "The customer gets an email, with your note if you wrote one.",
        second: "A large refund waits for a second administrator to approve it.",
      },
    },
    aside: {
      thisMonth: "Approved this month",
      thisMonthCount: (count: number) => `${count} approved`,
      thisMonthNone: "No approved refund this month",
      thisMonthBasis: (count: number) =>
        `Counted from the ${count} requests read on this screen, not from every refund.`,
      unknownAmounts: (count: number) => `${count} approved without an amount on record`,
      monthlyTitle: "Approved refunds per month",
      monthlyBasis: (count: number) =>
        `Requests read only: the ${count} most recent, so older months can be incomplete.`,
      monthlyLabel: (months: number) => `Approved refunds in each of the last ${months} months`,
    },
    toasts: {
      notUpdated: "The refund request was not updated.",
      rejected:
        "Refund request rejected. The subscription and plan were left unchanged.",
      connectionFailed:
        "The refund request was not updated. Check the connection and retry.",
    },
  },
  ko: {
    exportCsv: "CSV 내보내기",
    rowLimit: (limit: number) =>
      `최근 요청 ${limit}건만 보여요. 탭의 숫자와 오른쪽 숫자도 이 요청들만 센 값이에요.`,
    filtersLabel: "상태로 요청 걸러 보기",
    filters: {
      pending: (count: number) => `대기 ${count}`,
      approved: (count: number) => `승인 ${count}`,
      rejected: (count: number) => `거절 ${count}`,
      all: (count: number) => `전체 ${count}`,
    },
    empty: {
      title: "이 탭에 환불 요청이 없어요",
      detail: "탭에 맞는 요청이 생기면 여기에 보여요.",
    },
    readFailed: {
      title: "환불 요청을 읽지 못했어요",
      detail:
        "요청이 없는 게 아니라 읽기에 실패해서 아무것도 보여 주지 못해요. 페이지를 새로 고쳐 다시 시도해 주세요.",
    },
    unknownPlan: "알 수 없는 플랜",
    noEmail: "이메일 없음",
    noReason: "고객이 사유를 적지 않았어요.",
    interval: { monthly: "월간", yearly: "연간" },
    requested: (date: string) => `요청 ${date}`,
    status: {
      pending: "대기 중",
      processing: "처리 중",
      approved: "승인함",
      rejected: "거절함",
    },
    waiting: (days: number) =>
      days === 0 ? "오늘 요청했어요" : `${days}일째 기다리는 중`,
    stats: {
      amountPending: "돌려줄 금액",
      amountDone: "돌려준 금액",
      amountPendingDetail: "승인할 때 Stripe의 가장 최근 결제를 기준으로 정해져요.",
      creditsUsed: "구매 후 쓴 크레딧",
      creditsUsedDetail: (used: string, purchased: string) =>
        `크레딧 팩 ${purchased} 중 ${used}`,
      noPurchases: "크레딧 팩 구매 없음",
      creditsLeft: "안 쓰고 남은 팩 크레딧",
      creditsLeftDetail: (usd: string) => `충당 비용 $${usd}`,
    },
    adminNote: (note: string) => `관리자 메모: ${note}`,
    creditRisk: {
      title: "크레딧 잔액·비용 검토 필요",
      purchases: (count: number) => `크레딧 팩 구매 ${count}건`,
      remaining: (credits: string, usd: string) =>
        `남은 잔액: ${credits} 크레딧 / $${usd}`,
      estimatedConsumed: (credits: string, usd: string) =>
        `추정 사용량: ${credits} 크레딧 / $${usd}`,
      unrecovered: (credits: string, usd: string) =>
        `못 거둔 크레딧: ${credits} 크레딧 / $${usd}`,
      billingRisk: (status: string) =>
        `결제 위험: ${status}. 승인하기 전에 환불할 수 있는 잔액과 쓴 AI 비용을 확인해 주세요.`,
      confirm: "산 크레딧 잔액, 쓴 크레딧, 충당된 AI 비용을 확인했어요.",
    },
    timeline: "타임라인",
    requestedEvent: "환불 요청",
    timelineMeta: (date: string, actor: string | null) =>
      `${date} / ${actor || "시스템"}`,
    technical: {
      summary: "Stripe·구독 ID",
      stripeCustomer: (value: string) => `Stripe 고객: ${value}`,
      subscription: (value: string) => `구독: ${value}`,
      subscriptionStatus: (value: string) => `상태: ${value}`,
      periodEnd: (value: string) => `기간 종료: ${value}`,
      stripeRefund: (value: string) => `Stripe 환불: ${value}`,
      stripeCharge: (value: string) => `Stripe 결제: ${value}`,
      requestId: (value: string) => `요청: ${value}`,
    },
    refundStatus: (value: string) => `환불 상태: ${value}`,
    reviewed: (value: string) => `검토: ${value}`,
    notePlaceholder: "고객 이메일에 넣을 메모(선택)",
    approve: "승인",
    reject: "거절",
    confirmApprove: {
      title: "이 환불을 승인할까요?",
      customer: (email: string) => `고객: ${email}`,
      amount: "금액: Stripe의 가장 최근 결제에서 남은 만큼이에요.",
      creditsLeft: (credits: string) => `안 쓰고 남은 팩 크레딧: ${credits}`,
      effects: {
        refund: "Stripe가 고객의 가장 최근 결제에서 남은 금액을 돌려줘요.",
        cancel: "Stripe 구독이 해지돼요.",
        free: "계정이 Free로 돌아가요.",
        email: "고객에게 안내 메일이 가요. 메모를 적었다면 함께 들어가요.",
        second: "큰 금액이면 다른 관리자의 승인을 한 번 더 기다려요.",
      },
    },
    aside: {
      thisMonth: "이번 달 승인한 환불",
      thisMonthCount: (count: number) => `${count}건 승인`,
      thisMonthNone: "이번 달 승인한 환불이 없어요",
      thisMonthBasis: (count: number) =>
        `이 화면에서 읽은 요청 ${count}건 기준이고, 모든 환불의 합계는 아니에요.`,
      unknownAmounts: (count: number) => `승인했지만 금액 기록이 없는 요청 ${count}건`,
      monthlyTitle: "월별 승인한 환불",
      monthlyBasis: (count: number) =>
        `읽은 요청 기준이에요. 최근 ${count}건뿐이라 오래된 달은 덜 잡힐 수 있어요.`,
      monthlyLabel: (months: number) => `최근 ${months}개월 동안 달마다 승인한 환불`,
    },
    toasts: {
      notUpdated: "환불 요청을 업데이트하지 못했어요.",
      rejected: "환불 요청을 거절했어요. 구독과 플랜은 그대로예요.",
      connectionFailed:
        "환불 요청을 업데이트하지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
    },
  },
});
