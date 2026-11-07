import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the billing lifecycle counters on `/admin/billing` and `/admin/refunds`. */
export const adminBillingLifecycleMessages = defineAdminMessages({
  en: {
    title: "Subscribers, cancellations and refunds",
    description:
      "Paid subscribers, subscriptions set to end, and the refund queue are kept apart so finance and support don't treat them as the same thing.",
    paidUsers: "Paid subscribers",
    paidUsersDetail: (activeSubscriptions: number | null) =>
      activeSubscriptions === null
        ? "The Stripe subscription count could not be read."
        : `${activeSubscriptions} active subscriptions synced from Stripe.`,
    canceling: "Ending soon",
    cancelingDetail: "They stay paid until the current Stripe period ends.",
    refundQueue: "Refunds waiting",
    refundQueueDetail: (approved: number | null, rejected: number | null) =>
      approved === null || rejected === null
        ? "Approved and rejected counts could not be read."
        : `${approved} approved and ${rejected} rejected so far.`,
    paymentState: "Payments",
    paymentStateLive: "Live",
    paymentStateWatch: "Watch",
    paymentStateDetail:
      "Check Stripe webhooks and the billing resync before changing a plan by hand.",
  },
  ko: {
    title: "구독자·해지·환불",
    description:
      "유료 구독자, 종료 예정 구독, 환불 대기를 따로 보여 줘서 재무와 지원이 같은 상태로 헷갈리지 않게 해요.",
    paidUsers: "유료 구독자",
    paidUsersDetail: (activeSubscriptions: number | null) =>
      activeSubscriptions === null
        ? "Stripe 구독 수를 읽지 못했어요."
        : `Stripe에서 동기화된 활성 구독이 ${activeSubscriptions}건이에요.`,
    canceling: "곧 종료",
    cancelingDetail: "지금 Stripe 결제 기간이 끝날 때까지는 유료로 남아 있어요.",
    refundQueue: "대기 중인 환불",
    refundQueueDetail: (approved: number | null, rejected: number | null) =>
      approved === null || rejected === null
        ? "승인·거절 건수를 읽지 못했어요."
        : `지금까지 승인 ${approved}건, 거절 ${rejected}건이에요.`,
    paymentState: "결제 상태",
    paymentStateLive: "운영 중",
    paymentStateWatch: "지켜보기",
    paymentStateDetail:
      "플랜을 손으로 바꾸기 전에 Stripe webhook과 결제 재동기화부터 확인해요.",
  },
});
