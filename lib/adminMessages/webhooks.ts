import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Stripe webhook panel under Automation. */
export const adminWebhooksMessages = defineAdminMessages({
  en: {
    loadFailed: "Could not load webhook logs.",
    reprocessFailed: "Could not reprocess webhook.",
    reprocessed: "Stripe webhook was reprocessed.",
    eyebrow: "Stripe webhooks",
    title: "Billing event monitor",
    description:
      "Track recent Stripe webhook delivery and processing failures before they become plan sync issues.",
    refresh: "Refresh",
    recentEvents: "Recent webhook events",
    failedCount: (count: number) => `${count} failed`,
    replayed: "replayed",
    reprocess: "Reprocess",
    empty: "No Stripe webhook events recorded yet.",
  },
  ko: {
    loadFailed: "webhook 로그를 불러오지 못했습니다.",
    reprocessFailed: "webhook을 재처리하지 못했습니다.",
    reprocessed: "Stripe webhook을 재처리했습니다.",
    eyebrow: "Stripe webhook",
    title: "결제 이벤트 모니터",
    description:
      "최근 Stripe webhook 전송과 처리 실패를 플랜 동기화 문제로 번지기 전에 추적합니다.",
    refresh: "새로고침",
    recentEvents: "최근 webhook 이벤트",
    failedCount: (count: number) => `실패 ${count}건`,
    replayed: "재생됨",
    reprocess: "재처리",
    empty: "아직 기록된 Stripe webhook 이벤트가 없습니다.",
  },
});
