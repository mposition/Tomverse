import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the billing lifecycle counters on `/admin/billing` and `/admin/refunds`. */
export const adminBillingLifecycleMessages = defineAdminMessages({
  en: {
    eyebrow: "Billing lifecycle",
    title: "Refunds and cancellations split",
    description:
      "Separate paid subscribers, refund workflow, and subscriptions scheduled to end so finance and support do not treat them as the same state.",
    paidUsers: "Paid users",
    paidUsersDetail: (activeSubscriptions: number) =>
      `${activeSubscriptions} active subscriptions currently synced from Stripe.`,
    canceling: "Canceling",
    cancelingDetail: "Users remain paid until the current Stripe period ends.",
    refundQueue: "Refund queue",
    refundQueueDetail: (approved: number, rejected: number) =>
      `${approved} approved and ${rejected} rejected requests recorded.`,
    paymentState: "Payment state",
    paymentStateLive: "Live",
    paymentStateWatch: "Watch",
    paymentStateDetail:
      "Use Stripe webhooks and billing resync before manual plan changes.",
  },
  ko: {
    eyebrow: "결제 수명주기",
    title: "환불과 해지 구분",
    description:
      "유료 구독자, 환불 처리, 종료 예정 구독을 나눠 보여 주어 재무와 고객 지원이 이들을 같은 상태로 다루지 않게 합니다.",
    paidUsers: "유료 사용자",
    paidUsersDetail: (activeSubscriptions: number) =>
      `현재 Stripe에서 동기화된 활성 구독 ${activeSubscriptions}건입니다.`,
    canceling: "해지 예정",
    cancelingDetail: "현재 Stripe 결제 기간이 끝날 때까지 유료 상태가 유지됩니다.",
    refundQueue: "환불 대기열",
    refundQueueDetail: (approved: number, rejected: number) =>
      `승인 ${approved}건, 거절 ${rejected}건이 기록되어 있습니다.`,
    paymentState: "결제 상태",
    paymentStateLive: "운영 중",
    paymentStateWatch: "주시",
    paymentStateDetail:
      "플랜을 수동으로 변경하기 전에 Stripe webhook과 결제 재동기화를 먼저 사용하세요.",
  },
});
